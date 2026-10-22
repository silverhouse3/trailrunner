// ════════════════════════════════════════════════════════════════════════════
// StravaRoutes — turn Strava activities / saved routes into TrailRunner routes,
//                keep her original pace as a GHOST, draw grade-coloured
//                overlays, and offer the big-touch "pick a run" screen.
//
// Depends on: js/strava-api.js (StravaApi).  Optional globals used when
// present: Store (storage.js), Engine, MapView, App, TM (read-only: only
// TM.getConsoleInfo is ever called), L (Leaflet).
//
// SAFETY: nothing in this file starts the belt, sets speed or sets incline.
// Incline only ever comes from Engine._applyAutoControl() in 'route' mode,
// which reads the (already clamped) elevation profile stored in the route.
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';
  // App globals declared with top-level `const` (Store, Engine, MapView...) are NOT properties of window, so look them up lexically.
  function env(n) {
    switch (n) {
      case 'Store': return typeof Store !== 'undefined' ? Store : root.Store;
      case 'Engine': return typeof Engine !== 'undefined' ? Engine : root.Engine;
      case 'MapView': return typeof MapView !== 'undefined' ? MapView : root.MapView;
      case 'App': return typeof App !== 'undefined' ? App : root.App;
      case 'OvalTrack': return typeof OvalTrack !== 'undefined' ? OvalTrack : root.OvalTrack;
      case 'IDBStore': return typeof IDBStore !== 'undefined' ? IDBStore : root.IDBStore;
      case 'TM': return typeof TM !== 'undefined' ? TM : root.TM;
    }
    return root[n];
  }

  var META_KEY = 'tr_strava_routes';
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function api() { return root.StravaApi; }

  var StravaRoutes = {

    SOURCE_ACTIVITY: 'strava-activity',
    SOURCE_ROUTE: 'strava-route',
    DEFAULT_LIMITS: { min: -3, max: 12 },     // C1750 reference; X32i bridge reports -6..40
    SMOOTH_WINDOW_M: 40,                      // altitude smoothing window
    GRADE_MARGIN: 0.03,                       // % kept inside the limits (rounding safety)
    STOP_SPEED_MS: 0.4,                       // below this an interval counts as "stopped"
    STOP_KEEP_S: 2,                           // seconds of each stopped interval kept in ghost time

    // ════════════════════════════════════════════════════════════════════════
    // 1. CONVERSION  (pure functions - unit tested in mock/strava-test.js)
    // ════════════════════════════════════════════════════════════════════════

    /** Choose N output points: ~1 per 25 m, 200..600. */
    pointCountFor: function (distM) { return Math.max(200, Math.min(600, Math.round(distM / 25))); },

    haversine: function (a1, o1, a2, o2) {
      var R = 6371000, t = Math.PI / 180, dA = (a2 - a1) * t, dO = (o2 - o1) * t;
      var s = Math.sin(dA / 2) * Math.sin(dA / 2) + Math.cos(a1 * t) * Math.cos(a2 * t) * Math.sin(dO / 2) * Math.sin(dO / 2);
      return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    },

    /**
     * streams: {latlng:[[lat,lng]..], altitude:[], distance:[], time:[], velocity_smooth:[]}
     * opts: {limits:{min,max}, points:N, smoothWindowM}
     * -> {points[{lat,lon,ele,eleReal,dist}], totalDistM, ascentReal, descentReal, ascent, descent,
     *     limits, stats{clampedFrac,maxGradeRaw,minGradeRaw}, ghost|null, bounds}
     * `ele` is the TREADMILL profile (grades clamped, re-integrated); `eleReal` is the smoothed real altitude.
     */
    convert: function (streams, opts) {
      opts = opts || {};
      var ll = streams.latlng || [], n0 = ll.length;
      if (n0 < 2) throw new Error('Not enough GPS points in this activity');
      var alt = streams.altitude || [], dist = streams.distance || [], time = streams.time || null;
      var limits = opts.limits || this.DEFAULT_LIMITS;
      var i;

      // 1. clean: strictly increasing distance (drop GPS dupes), monotonic time
      var cd = [], cLat = [], cLon = [], cAlt = [], cT = time ? [] : null, acc = 0, haveDist = dist.length === n0;
      for (i = 0; i < n0; i++) {
        var d;
        if (haveDist) d = dist[i];
        else { acc += i ? this.haversine(ll[i - 1][0], ll[i - 1][1], ll[i][0], ll[i][1]) : 0; d = acc; }
        if (cd.length && d < cd[cd.length - 1] + 0.5) continue;
        cd.push(d); cLat.push(ll[i][0]); cLon.push(ll[i][1]);
        cAlt.push(alt.length === n0 && alt[i] != null ? alt[i] : (cAlt.length ? cAlt[cAlt.length - 1] : 0));
        if (cT) cT.push(Math.max(time[i], cT.length ? cT[cT.length - 1] : 0));
      }
      if (cd.length < 2) throw new Error('Activity has no usable distance');
      var D = cd[cd.length - 1] - cd[0];
      if (D < 100) throw new Error('Activity is too short to use as a route');
      var base = cd[0];
      for (i = 0; i < cd.length; i++) cd[i] -= base;

      // moving-time clock (stopped intervals compressed to STOP_KEEP_S)
      var cM = null;
      if (cT) {
        cM = [0];
        for (i = 1; i < cd.length; i++) {
          var dt = cT[i] - cT[i - 1], dd = cd[i] - cd[i - 1];
          var add = dt <= 0 ? 0 : (dd / dt >= this.STOP_SPEED_MS ? dt : Math.min(dt, this.STOP_KEEP_S));
          cM.push(cM[i - 1] + add);
        }
      }

      // 2. fine uniform grid in distance
      var N = opts.points || this.pointCountFor(D);
      var M = Math.min(4000, Math.max(N * 4, Math.ceil(D / 10)));
      var step = D / (M - 1);
      var fLat = [], fLon = [], fAlt = [], j = 0, t;
      for (i = 0; i < M; i++) {
        var td = i * step;
        while (j < cd.length - 2 && cd[j + 1] < td) j++;
        t = (cd[j + 1] - cd[j]) > 0 ? (td - cd[j]) / (cd[j + 1] - cd[j]) : 0;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        fLat.push(cLat[j] + t * (cLat[j + 1] - cLat[j]));
        fLon.push(cLon[j] + t * (cLon[j + 1] - cLon[j]));
        fAlt.push(cAlt[j] + t * (cAlt[j + 1] - cAlt[j]));
      }
      // 3. altitude: median-5 (kills GPS spikes) then 2-pass box filter
      fAlt = this._median5(fAlt);
      var half = Math.max(1, Math.round((opts.smoothWindowM || this.SMOOTH_WINDOW_M) / step / 2));
      fAlt = this._box(this._box(fAlt, half), half);

      // 4. N output points evenly spaced by distance
      var pts = [], tt, k = 0, dOut = [], eReal = [];
      for (i = 0; i < N; i++) {
        var q = i / (N - 1) * (M - 1), q0 = Math.floor(q), q1 = Math.min(M - 1, q0 + 1), f = q - q0;
        pts.push({
          lat: Math.round((fLat[q0] + f * (fLat[q1] - fLat[q0])) * 1e6) / 1e6,
          lon: Math.round((fLon[q0] + f * (fLon[q1] - fLon[q0])) * 1e6) / 1e6
        });
        dOut.push(i / (N - 1) * D);
        eReal.push(fAlt[q0] + f * (fAlt[q1] - fAlt[q0]));
      }
      var ascentReal = 0, descentReal = 0;
      for (i = 1; i < N; i++) { var de = eReal[i] - eReal[i - 1]; if (de > 0) ascentReal += de; else descentReal -= de; }

      // 5. bake treadmill profile
      var baked = this.bakeProfile(eReal, dOut, limits);
      for (i = 0; i < N; i++) {
        pts[i].ele = r3(baked.ele[i]); pts[i].eleReal = r3(eReal[i]); pts[i].dist = r1(dOut[i]);
      }
      var lo = 1e9, hi = -1e9, loL = 1e9, hiL = -1e9;
      for (i = 0; i < N; i++) {
        lo = Math.min(lo, pts[i].lat); hi = Math.max(hi, pts[i].lat);
        loL = Math.min(loL, pts[i].lon); hiL = Math.max(hiL, pts[i].lon);
      }

      // 6. ghost (time-by-distance) - only when the source had a time stream
      var ghost = null;
      if (cM) {
        var gd = [], gt = [], ge = [];
        j = 0;
        for (i = 0; i < N; i++) {
          while (j < cd.length - 2 && cd[j + 1] < dOut[i]) j++;
          t = (cd[j + 1] - cd[j]) > 0 ? (dOut[i] - cd[j]) / (cd[j + 1] - cd[j]) : 0;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          var m = cM[j] + t * (cM[j + 1] - cM[j]);
          if (gt.length && m < gt[gt.length - 1]) m = gt[gt.length - 1];
          gd.push(r1(dOut[i])); gt.push(r1(m));
          ge.push(r1(cT[j] + t * (cT[j + 1] - cT[j])));
        }
        ghost = { d: gd, t: gt, movingTimeS: gt[gt.length - 1], elapsedS: cT[cT.length - 1] - cT[0] };
      }
      return {
        points: pts, totalDistM: r1(D),
        ascentReal: Math.round(ascentReal), descentReal: Math.round(descentReal),
        ascent: Math.round(baked.ascent), descent: Math.round(baked.descent),
        limits: { min: limits.min, max: limits.max },
        stats: { clampedFrac: baked.clampedFrac, maxGradeRaw: baked.maxRaw, minGradeRaw: baked.minRaw },
        ghost: ghost,
        bounds: { minLat: lo, maxLat: hi, minLon: loL, maxLon: hiL }
      };
    },

    /**
     * Grade per segment from `eleReal`, clamp to limits (steeper descents are FLATTENED to
     * limits.min, steeper climbs capped at limits.max), re-integrate so the engine - which derives
     * incline from consecutive `ele` values - can never ask for more than the limits.
     */
    bakeProfile: function (eReal, d, limits) {
      var n = eReal.length, ele = [eReal[0]], clamped = 0, maxRaw = -1e9, minRaw = 1e9, asc = 0, desc = 0;
      for (var i = 0; i < n - 1; i++) {
        var seg = d[i + 1] - d[i];
        var g = seg > 0 ? (eReal[i + 1] - eReal[i]) / seg * 100 : 0;
        if (g > maxRaw) maxRaw = g;
        if (g < minRaw) minRaw = g;
        // clamp slightly INSIDE the limits (GRADE_MARGIN) so rounding of stored elevations can never push the engine's incline target over a limit
        var lo = limits.min + this.GRADE_MARGIN, hi = limits.max - this.GRADE_MARGIN;
        var gc = g > hi ? hi : (g < lo ? lo : g);
        if (g > limits.max || g < limits.min) clamped++;
        var de = gc * seg / 100;
        ele.push(ele[i] + de);
        if (de > 0) asc += de; else desc -= de;
      }
      return { ele: ele, ascent: asc, descent: desc, clampedFrac: n > 1 ? clamped / (n - 1) : 0, maxRaw: r1(maxRaw), minRaw: r1(minRaw) };
    },

    _median5: function (a) {
      var out = a.slice(), n = a.length;
      for (var i = 2; i < n - 2; i++) {
        var w = [a[i - 2], a[i - 1], a[i], a[i + 1], a[i + 2]].sort(function (x, y) { return x - y; });
        out[i] = w[2];
      }
      return out;
    },
    _box: function (a, half) {
      var n = a.length, out = new Array(n), pre = [0], i;
      for (i = 0; i < n; i++) pre.push(pre[i] + a[i]);
      for (i = 0; i < n; i++) {
        var lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
        out[i] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
      }
      return out;
    },

    /** Re-clamp an already stored route (uses eleReal) - for when the bridge reports narrower limits. */
    rebake: function (route, limits) {
      var p = route.resampled, eReal = [], d = [], i;
      for (i = 0; i < p.length; i++) { eReal.push(p[i].eleReal != null ? p[i].eleReal : p[i].ele); d.push(p[i].dist); }
      var b = this.bakeProfile(eReal, d, limits);
      var out = [];
      for (i = 0; i < p.length; i++) out.push({ lat: p[i].lat, lon: p[i].lon, ele: r3(b.ele[i]), eleReal: p[i].eleReal, dist: p[i].dist });
      var copy = {};
      for (var k in route) copy[k] = route[k];
      copy.resampled = out; copy.totalAscent = Math.round(b.ascent); copy.totalDescent = Math.round(b.descent);
      return { route: copy, stats: { clampedFrac: b.clampedFrac, maxGradeRaw: b.maxRaw, minGradeRaw: b.minRaw } };
    },

    /** Segment grades (%) of the stored/treadmill profile, as the engine will see them. */
    gradesOf: function (points) {
      var g = [];
      for (var i = 0; i < points.length - 1; i++) {
        var s = points[i + 1].dist - points[i].dist;
        g.push(s > 0 ? (points[i + 1].ele - points[i].ele) / s * 100 : 0);
      }
      return g;
    },

    // ════════════════════════════════════════════════════════════════════════
    // 2. LIMITS (bridge-aware)
    // ════════════════════════════════════════════════════════════════════════

    /** Effective clamp = intersection of comfort prefs and what the bridge reports. Always resolves. */
    getLimits: function () {
      var p = api() ? api().prefs() : { comfortMinIncline: -3, comfortMaxIncline: 12 };
      var lim = { min: p.comfortMinIncline, max: p.comfortMaxIncline, source: 'comfort' };
      return new Promise(function (resolve) {
        var done = false;
        function fin() { if (!done) { done = true; resolve(lim); } }
        try {
          if (env('TM') && typeof env('TM').getConsoleInfo === 'function' && env('TM').connected) {
            setTimeout(fin, 1500);
            env('TM').getConsoleInfo(function (info) {
              if (info && info.ok !== false) {
                if (typeof info.min_incline_pct === 'number' && info.min_incline_pct > lim.min) lim.min = info.min_incline_pct;
                if (typeof info.max_incline_pct === 'number' && info.max_incline_pct > 0 && info.max_incline_pct < lim.max) lim.max = info.max_incline_pct;
                lim.source = 'bridge+comfort';
              }
              fin();
            });
          } else fin();
        } catch (e) { fin(); }
      });
    },

    // ════════════════════════════════════════════════════════════════════════
    // 3. REGISTRY (meta that Store.saveRoute would drop) + import
    // ════════════════════════════════════════════════════════════════════════

    allMeta: function () { try { return JSON.parse(lsGet(META_KEY) || '{}') || {}; } catch (e) { return {}; } },
    meta: function (routeId) { return this.allMeta()[routeId] || null; },
    isStravaRoute: function (routeId) { return !!this.meta(routeId); },
    _putMeta: function (routeId, m) { var all = this.allMeta(); all[routeId] = m; lsSet(META_KEY, JSON.stringify(all)); },
    /** Drop meta for routes that were deleted from Store. */
    gc: function (store) {
      store = store || env('Store');
      if (!store) return 0;
      var all = this.allMeta(), n = 0;
      for (var id in all) if (!store.getRoute(id)) { delete all[id]; n++; }
      lsSet(META_KEY, JSON.stringify(all));
      return n;
    },

    /**
     * Fetch streams, convert, store as a TrailRunner route + meta.
     * item: slim activity or route from StravaApi.list*; kind 'activity' | 'route'.
     * opts: {limits, save:false (preview only), store}
     */
    prepare: function (item, kind, opts) {
      var self = this;
      opts = opts || {};
      var getStreams = kind === 'route' ? api().getRouteStreams(item.id) : api().getActivityStreams(item.id);
      return Promise.all([getStreams, opts.limits ? Promise.resolve(opts.limits) : this.getLimits()]).then(function (res) {
        var conv = self.convert(res[0], { limits: res[1] });
        var id = (kind === 'route' ? 'strava_r_' : 'strava_a_') + item.id;
        var route = {
          id: id, name: item.name, totalDistM: conv.totalDistM, totalDistKm: conv.totalDistM / 1000,
          totalAscent: conv.ascent, totalDescent: conv.descent, bounds: conv.bounds, resampled: conv.points
        };
        var meta = {
          source: kind === 'route' ? self.SOURCE_ROUTE : self.SOURCE_ACTIVITY,
          stravaId: item.id, name: item.name, date: item.start_date_local || null, startDate: item.start_date || item.start_date_local || null,
          ascentReal: conv.ascentReal, descentReal: conv.descentReal, limits: conv.limits,
          clampedFrac: conv.stats.clampedFrac, maxGradeRaw: conv.stats.maxGradeRaw, minGradeRaw: conv.stats.minGradeRaw,
          ghost: conv.ghost, importedAt: new Date().toISOString()
        };
        return { route: route, meta: meta, conv: conv };
      });
    },

    /** Persist a prepared route (Store + meta). Returns the stored route. */
    commit: function (prep, opts) {
      var store = (opts && opts.store) || env('Store');
      if (!store) throw new Error('Store not available');
      var stored = store.saveRoute(prep.route);
      this._putMeta(stored.id, prep.meta);
      return stored;
    },

    // ════════════════════════════════════════════════════════════════════════
    // 4. GHOST
    // ════════════════════════════════════════════════════════════════════════

    _interp: function (xs, ys, x) {
      var n = xs.length;
      if (!n) return 0;
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
      var span = xs[hi] - xs[lo];
      return span > 0 ? ys[lo] + (x - xs[lo]) / span * (ys[hi] - ys[lo]) : ys[lo];
    },
    _routeFor: function (routeId) {
      var id = routeId || (env('Engine') && env('Engine').route ? env('Engine').route.id : null);
      if (!id) return null;
      if (env('Engine') && env('Engine').route && env('Engine').route.id === id) return env('Engine').route;
      return env('Store') ? env('Store').getRoute(id) : null;
    },
    _latlonAt: function (route, distM) {
      var p = route.resampled, ds = [], i;
      if (!route._ds) { for (i = 0; i < p.length; i++) ds.push(p[i].dist); try { Object.defineProperty(route, '_ds', { value: ds, enumerable: false }); } catch (e) {} }
      ds = route._ds || ds;
      var lat = [], lon = [];
      if (!route._la) { for (i = 0; i < p.length; i++) { lat.push(p[i].lat); lon.push(p[i].lon); } try { Object.defineProperty(route, '_la', { value: lat, enumerable: false }); Object.defineProperty(route, '_lo', { value: lon, enumerable: false }); } catch (e) {} }
      return [this._interp(ds, route._la || lat, distM), this._interp(ds, route._lo || lon, distM)];
    },

    /** Where was she, and how long had she been going, at `distanceM` along the route? {lat,lng,elapsedS} or null */
    ghostPositionAt: function (distanceM, routeId) {
      var route = this._routeFor(routeId), m = route ? this.meta(route.id) : null;
      if (!route || !m || !m.ghost) return null;
      var ll = this._latlonAt(route, distanceM);
      return { lat: ll[0], lng: ll[1], elapsedS: r1(this._interp(m.ghost.d, m.ghost.t, distanceM)) };
    },
    /** Where was she `elapsedS` seconds into her activity (moving time)? {lat,lng,distanceM} or null */
    ghostPositionAtTime: function (elapsedS, routeId) {
      var route = this._routeFor(routeId), m = route ? this.meta(route.id) : null;
      if (!route || !m || !m.ghost) return null;
      var d = this._interp(m.ghost.t, m.ghost.d, elapsedS), ll = this._latlonAt(route, d);
      return { lat: ll[0], lng: ll[1], distanceM: r1(d) };
    },
    /** Seconds AHEAD (+) / behind (-) her ghost at the runner's current distance. */
    ghostDeltaS: function (runDistM, runElapsedS, routeId) {
      var p = this.ghostPositionAt(runDistM, routeId);
      return p ? p.elapsedS - runElapsedS : null;
    },

    /** Pseudo-run in the shape Engine.loadGhost() already understands (trackPoints[{elapsed,dist}]). */
    toEngineGhostRun: function (routeId, stepS) {
      var m = this.meta(routeId);
      if (!m || !m.ghost) return null;
      stepS = stepS || 2;
      var g = m.ghost, tp = [], t;
      for (t = 0; t < g.movingTimeS; t += stepS) tp.push({ elapsed: t, dist: r1(this._interp(g.t, g.d, t)) });
      tp.push({ elapsed: g.movingTimeS, dist: g.d[g.d.length - 1] });
      return {
        id: 'ghost_' + routeId, source: this.SOURCE_ACTIVITY, ghostSource: 'strava-activity',
        routeId: routeId, routeName: m.name, startedAt: m.date, elapsed: g.movingTimeS,
        distanceM: g.d[g.d.length - 1], trackPoints: tp
      };
    },
    /** Arm the engine's existing ghost mechanism with her Strava pace. */
    armGhost: function (routeId) {
      var run = this.toEngineGhostRun(routeId);
      if (!run || !env('Engine') || !env('Engine').loadGhost) return false;
      env('Engine').loadGhost(run);
      return true;
    },

    // ════════════════════════════════════════════════════════════════════════
    // 5. OVERLAYS
    // ════════════════════════════════════════════════════════════════════════

    gradeColor: function (g) {
      if (g > 10) return '#ff5f5f';
      if (g > 6) return '#ff9f43';
      if (g > 2) return '#ffe066';
      if (g > -1) return '#3ecfff';
      if (g > -3) return '#7ee8a0';
      return '#9b8cff';
    },

    /** Elevation profile strip, grade coloured. opts {runnerM, ghostM, doneColor} */
    drawProfile: function (canvas, points, opts) {
      opts = opts || {};
      if (!canvas || !points || points.length < 2) return;
      var W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d'), n = points.length, i;
      ctx.clearRect(0, 0, W, H);
      var mn = 1e9, mx = -1e9;
      for (i = 0; i < n; i++) { mn = Math.min(mn, points[i].ele); mx = Math.max(mx, points[i].ele); }
      var range = Math.max(10, mx - mn), pad = 6, D = points[n - 1].dist || 1;
      function xs(d) { return pad + d / D * (W - 2 * pad); }
      function ys(e) { return H - pad - (e - mn) / range * (H - 2 * pad - 8); }
      ctx.beginPath(); ctx.moveTo(xs(0), H);
      for (i = 0; i < n; i++) ctx.lineTo(xs(points[i].dist), ys(points[i].ele));
      ctx.lineTo(xs(D), H); ctx.closePath();
      ctx.fillStyle = 'rgba(62,207,255,.10)'; ctx.fill();
      ctx.lineCap = 'round';
      var g = this.gradesOf(points);
      for (i = 1; i < n; i++) {
        var done = opts.runnerM != null && points[i].dist <= opts.runnerM;
        ctx.beginPath(); ctx.moveTo(xs(points[i - 1].dist), ys(points[i - 1].ele)); ctx.lineTo(xs(points[i].dist), ys(points[i].ele));
        ctx.strokeStyle = done ? (opts.doneColor || 'rgba(62,232,159,.95)') : this.gradeColor(g[i - 1]);
        ctx.lineWidth = done ? 7 : 4; ctx.stroke();
      }
      if (opts.ghostM != null) {
        var gx = xs(Math.min(D, opts.ghostM)), ge = this._interp(this._ds(points), this._es(points), opts.ghostM);
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.strokeStyle = 'rgba(255,224,102,.45)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(gx, ys(ge), 7, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,224,102,.9)'; ctx.fill();
      }
    },
    _ds: function (p) { var a = []; for (var i = 0; i < p.length; i++) a.push(p[i].dist); return a; },
    _es: function (p) { var a = []; for (var i = 0; i < p.length; i++) a.push(p[i].ele); return a; },

    /** Small thumbnail of a summary_polyline (no tiles needed - works offline). */
    drawThumb: function (canvas, encoded, color) {
      if (!canvas || !encoded) return;
      var pts = api().decodePolyline(encoded), W = canvas.width, H = canvas.height;
      if (pts.length < 2) return;
      var ctx = canvas.getContext('2d'), i, la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
      for (i = 0; i < pts.length; i++) { la0 = Math.min(la0, pts[i][0]); la1 = Math.max(la1, pts[i][0]); lo0 = Math.min(lo0, pts[i][1]); lo1 = Math.max(lo1, pts[i][1]); }
      var cosL = Math.cos((la0 + la1) / 2 * Math.PI / 180), w = (lo1 - lo0) * cosL || 1e-6, h = (la1 - la0) || 1e-6, pad = 8;
      var sc = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h), ox = (W - w * sc) / 2, oy = (H - h * sc) / 2;
      ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      for (i = 0; i < pts.length; i++) {
        var x = ox + (pts[i][1] - lo0) * cosL * sc, y = H - oy - (pts[i][0] - la0) * sc;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.strokeStyle = color || '#fc5200'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    },

    /** Leaflet grade-coloured route line. Own pane so it sits under the runner/current-position dot. */
    overlay: {
      _map: null, _segs: [], _group: null, _doneIdx: 0, _route: null, _pane: 'stravaGrade', _hid: [],
      attach: function (map, route, opts) {
        var L = root.L;
        this.detach();
        if (!L || !map || !route || !route.resampled || route.resampled.length < 2) return false;
        opts = opts || {};
        if (!map.getPane(this._pane)) { var pn = map.createPane(this._pane); pn.style.zIndex = 397; pn.style.pointerEvents = 'none'; }
        var p = route.resampled, g = StravaRoutes.gradesOf(p), i;
        this._map = map; this._route = route; this._segs = []; this._doneIdx = 0;
        this._group = L.layerGroup().addTo(map);
        for (i = 0; i < p.length - 1; i++) {
          var seg = L.polyline([[p[i].lat, p[i].lon], [p[i + 1].lat, p[i + 1].lon]], {
            pane: this._pane, color: StravaRoutes.gradeColor(g[i]), weight: 7, opacity: 0.95, lineCap: 'round', interactive: false
          });
          seg._col = StravaRoutes.gradeColor(g[i]);
          seg.addTo(this._group); this._segs.push(seg);
        }
        // hide the app's plain cyan/green route lines so they do not tint ours (restored by detach)
        var MV = env('MapView'); this._hid = [];
        if (MV && opts.hideBase !== false) {
          ['routeAhead', 'routeDone'].forEach(function (k) {
            if (MV[k] && MV[k].setStyle) { MV[k].setStyle({ opacity: 0 }); StravaRoutes.overlay._hid.push(k); }
          });
        }
        return true;
      },
      /** Colour what has been run solid green (like the profile strip). Cheap: touches only changed segments. */
      setProgress: function (distM) {
        if (!this._route) return;
        var p = this._route.resampled, idx = 0;
        while (idx < p.length - 1 && p[idx + 1].dist <= distM) idx++;
        var a = Math.min(idx, this._doneIdx), b = Math.max(idx, this._doneIdx), i;
        for (i = a; i < b && i < this._segs.length; i++) {
          this._segs[i].setStyle({ color: i < idx ? '#3ee89f' : this._segs[i]._col });
        }
        this._doneIdx = idx;
      },
      detach: function () {
        if (this._group && this._map) this._map.removeLayer(this._group);
        var MV = env('MapView');
        if (MV) this._hid.forEach(function (k) { if (MV[k] && MV[k].setStyle) MV[k].setStyle({ opacity: k === 'routeAhead' ? 0.5 : 0.9 }); });
        this._group = null; this._segs = []; this._route = null; this._hid = [];
      }
    },

    /** Called after Engine.loadRoute + MapView.loadRoute for ANY route (grade overlay only for Strava ones;
     *  the multi-racer pool is built for every route when strava-racers.js is loaded). */
    onRouteLoaded: function (route, opts) {
      opts = opts || {};
      this.overlay.detach();
      this.hud.hide();
      var racersP = (root.StravaRacers && opts.racers !== false) ? root.StravaRacers.onRouteLoaded(route, opts) : null;
      if (!route || !this.isStravaRoute(route.id)) return racersP || Promise.resolve(false);
      var self = this, m = this.meta(route.id);
      if (env('MapView') && env('MapView').map) this.overlay.attach(env('MapView').map, route);
      return this.getLimits().then(function (lim) {
        // Bridge may report narrower limits than the route was baked with -> re-bake (never mid-run)
        var running = env('Engine') && env('Engine').run && (env('Engine').run.status === 'running' || env('Engine').run.status === 'paused');
        if (!running && (lim.min > m.limits.min || lim.max < m.limits.max)) {
          var rb = self.rebake(route, lim);
          var stored = env('Store') ? env('Store').saveRoute(rb.route) : rb.route;
          m.limits = { min: lim.min, max: lim.max }; m.clampedFrac = rb.stats.clampedFrac; self._putMeta(route.id, m);
          if (env('Engine') && env('Engine').route && env('Engine').route.id === route.id) env('Engine').loadRoute(stored);
          if (env('MapView') && env('MapView').map) self.overlay.attach(env('MapView').map, stored);
        }
        // Without strava-racers.js fall back to the single original-activity ghost
        if (!root.StravaRacers && m.ghost && (opts.armGhost != null ? opts.armGhost : api().prefs().ghostDefault)) {
          self.armGhost(route.id);
          self.hud.show();
        }
        return racersP || true;
      });
    },

    /** Call from the app tick (4 Hz is fine): done-colouring, racer dots, gap panel / ghost chip. */
    onTick: function (run) {
      if (!run) return;
      if (this.overlay._route) { this.overlay.setProgress(run.distanceM || 0); this.hud.update(run); }
      if (root.StravaRacers) root.StravaRacers.onTick(run);
    },

    /** Small "ghost ahead/behind" chip (own element; engine's #ghostPanel is never shown by the app). */
    hud: {
      el: null, _on: false,
      show: function () { this._on = true; },
      hide: function () { this._on = false; if (this.el) this.el.style.display = 'none'; },
      update: function (run) {
        if (!this._on || !run) return;
        if (!this.el) {
          var host = root.document && (root.document.getElementById('rootApp') || root.document.body);
          if (!host) return;
          this.el = root.document.createElement('div'); this.el.className = 'sv-hud'; host.appendChild(this.el);
        }
        var d = StravaRoutes.ghostDeltaS(run.distanceM || 0, run.elapsed || 0);
        if (d == null) { this.el.style.display = 'none'; return; }
        var ahead = d >= 0, a = Math.abs(Math.round(d));
        this.el.style.display = '';
        this.el.className = 'sv-hud ' + (ahead ? 'sv-ahead' : 'sv-behind');
        this.el.textContent = '👻 ' + (ahead ? '+' : '-') + Math.floor(a / 60) + ':' + pad2(a % 60) + (ahead ? ' AHEAD' : ' BEHIND');
      }
    }
  };

  root.StravaRoutes = StravaRoutes;
  if (typeof module !== 'undefined' && module.exports) module.exports = StravaRoutes;
})(typeof window !== 'undefined' ? window : globalThis);
