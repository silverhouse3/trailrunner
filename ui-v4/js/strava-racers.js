// ════════════════════════════════════════════════════════════════════════════
// StravaRacers - multi-racer ghost race for ANY loaded route.
//
//   Pool  = Soph's previous TREADMILL runs on this route (Store + IDBStore)
//         + her recent STRAVA runs that cover the same course.
//   Racers (all move along the route by DISTANCE using their own time-at-distance profile):
//     FASTEST (F, green)  lowest total time
//     SLOWEST (S, red)    highest total time
//     AVERAGE (A, yellow) synthetic: mean elapsed time of ALL pooled runs at each distance
//     YOU     (blue)      the live runner - dot is drawn by the app; only colour constants here
//   1 pooled run  -> a single yellow 'YOUR RUN' ghost.   0 -> nothing.
//   >1 runs but fastest == slowest (tie) -> single yellow ghost.
//
// Matching a Strava run to the route (documented thresholds, see MATCH below):
//   cheap pre-filter on the list call (distance +-5 %, start <= 150 m, coarse summary_polyline
//   within 80 m mean / 250 m max), then streams are fetched ONLY for survivors (max 6 per
//   build, cached, evaluated ids remembered so a rebuild costs 0 requests) and the full
//   course must agree: mean cross-track deviation <= 30 m and 95th percentile <= 50 m,
//   sampled every 50 m, with direction/progress enforced (nearest point must lie within +-8 %
//   of the expected position along the candidate).
//
// Depends on strava-api.js + strava-routes.js. Conservative ES5.
// Nothing here talks to the treadmill (no TM.*) - purely read/draw.
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

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function r1(x) { return Math.round(x * 10) / 10; }
  function SR() { return root.StravaRoutes; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(x);
  }
  function fmtShortDate(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var d = new Date(t);
    return pad2(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()];
  }
  function fmtGap(s) { var a = Math.abs(Math.round(s)); return (s >= 0 ? '+' : '-') + Math.floor(a / 60) + ':' + pad2(a % 60); }
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) {} }

  var StravaRacers = {

    COLOURS: { fastest: '#3ee89f', slowest: '#ff4d4d', average: '#ffd54a', you: '#37d0ff' },
    LETTERS: { fastest: 'F', slowest: 'S', average: 'A', you: 'YOU', single: 'R' },

    MATCH: {
      distTolerance: 0.05,        // total distance within +-5 %
      preStartM: 150,             // list-level start proximity (summary polyline is coarse)
      preMeanM: 80, preMaxM: 250, // list-level coarse polyline deviation
      startM: 100, endM: 150,     // stream-level start / end proximity
      meanM: 30, p95M: 50,        // stream-level course deviation (cross-track, sampled every stepM)
      stepM: 50, windowFrac: 0.08,
      maxFetch: 6,                // max stream downloads per build (rate-limit guard)
      minTreadmillFrac: 0.95,     // treadmill run must have covered >= 95 % of the route
      dupStartS: 120, dupDistFrac: 0.03   // same run stored locally AND on Strava
    },

    active: null,          // {routeId, route, pool[], racers[], status}
    _listeners: [],
    on: function (fn) { this._listeners.push(fn); },
    _emit: function () { for (var i = 0; i < this._listeners.length; i++) { try { this._listeners[i](this.active); } catch (e) {} } },

    // ════════════════════════════════════════════════════════════════════════
    // Geometry / matching (pure)
    // ════════════════════════════════════════════════════════════════════════

    _cum: function (pts) {
      var c = [0], i, h = SR().haversine;
      for (i = 1; i < pts.length; i++) c.push(c[i - 1] + h(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
      return c;
    },

    /**
     * Cross-track deviation of candidate path from the base path.
     * base: [{lat,lon,dist}] (route.resampled)  cand: {pts:[[lat,lon]], cum:[m]}
     * -> {mean,p95,max,n}.  Samples base every stepM; for each, nearest candidate vertex within
     * +-windowFrac of the expected progress (this also rejects reversed / different-order courses).
     */
    deviation: function (base, cand, stepM, windowFrac) {
      var h = SR().haversine, Db = base[base.length - 1].dist, Dc = cand.cum[cand.cum.length - 1];
      var devs = [], x, bi = 0, ci0 = 0, i;
      var n = Math.max(2, Math.round(Db / stepM)) + 1;
      for (var s = 0; s < n; s++) {
        x = s / (n - 1) * Db;
        while (bi < base.length - 2 && base[bi + 1].dist < x) bi++;
        var span = base[bi + 1].dist - base[bi].dist, t = span > 0 ? (x - base[bi].dist) / span : 0;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        var la = base[bi].lat + t * (base[bi + 1].lat - base[bi].lat), lo = base[bi].lon + t * (base[bi + 1].lon - base[bi].lon);
        var f = x / Db, lowD = (f - windowFrac) * Dc, highD = (f + windowFrac) * Dc, best = 1e12;
        // binary search first vertex >= lowD
        var lo2 = 0, hi2 = cand.cum.length - 1;
        while (lo2 < hi2) { var mid = (lo2 + hi2) >> 1; if (cand.cum[mid] < lowD) lo2 = mid + 1; else hi2 = mid; }
        for (i = lo2; i < cand.cum.length && cand.cum[i] <= highD; i++) {
          var d = h(la, lo, cand.pts[i][0], cand.pts[i][1]);
          if (d < best) best = d;
        }
        devs.push(best);
      }
      var sum = 0, mx = 0;
      for (i = 0; i < devs.length; i++) { sum += devs[i]; if (devs[i] > mx) mx = devs[i]; }
      var sorted = devs.slice().sort(function (a, b) { return a - b; });
      return { mean: sum / devs.length, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: mx, n: devs.length };
    },

    /** List-level pre-filter using only summary data (0 extra requests). */
    preMatch: function (route, item) {
      var M = this.MATCH, D = route.totalDistM;
      if (!item.distance || Math.abs(item.distance - D) / D > M.distTolerance) return { ok: false, why: 'distance' };
      if (!item.polyline) return { ok: false, why: 'no-polyline' };
      var pts = root.StravaApi.decodePolyline(item.polyline);
      if (pts.length < 4) return { ok: false, why: 'no-polyline' };
      var p0 = route.resampled[0], h = SR().haversine;
      if (h(p0.lat, p0.lon, pts[0][0], pts[0][1]) > M.preStartM) return { ok: false, why: 'start' };
      var dev = this.deviation(route.resampled, { pts: pts, cum: this._cum(pts) }, 200, 0.12);
      if (dev.mean > M.preMeanM || dev.max > M.preMaxM) return { ok: false, why: 'shape', dev: dev };
      return { ok: true, dev: dev };
    },

    /** Stream-level check. streams = normalised {latlng,distance,...} */
    streamMatch: function (route, streams) {
      var M = this.MATCH, ll = streams.latlng || [], h = SR().haversine;
      if (ll.length < 10) return { ok: false, why: 'no-gps' };
      var cum = streams.distance && streams.distance.length === ll.length ? streams.distance : this._cum(ll);
      var Dc = cum[cum.length - 1], D = route.totalDistM;
      if (Math.abs(Dc - D) / D > M.distTolerance) return { ok: false, why: 'distance' };
      var p0 = route.resampled[0], pn = route.resampled[route.resampled.length - 1];
      if (h(p0.lat, p0.lon, ll[0][0], ll[0][1]) > M.startM) return { ok: false, why: 'start' };
      if (h(pn.lat, pn.lon, ll[ll.length - 1][0], ll[ll.length - 1][1]) > M.endM) return { ok: false, why: 'end' };
      var dev = this.deviation(route.resampled, { pts: ll, cum: cum }, M.stepM, M.windowFrac);
      if (dev.mean > M.meanM || dev.p95 > M.p95M) return { ok: false, why: 'shape', dev: dev };
      return { ok: true, dev: dev };
    },

    // ════════════════════════════════════════════════════════════════════════
    // Profiles (time-at-distance on the BASE route's distance scale)
    // ════════════════════════════════════════════════════════════════════════

    /** Treadmill run (saved summary with trackPoints [{elapsed,dist}]) -> profile or null. */
    profileFromRun: function (run, route) {
      var tp = run.trackPoints || [], D = route.totalDistM, d = [0], t = [0], i;
      for (i = 0; i < tp.length; i++) {
        var pd = tp[i].dist, pt = tp[i].elapsed;
        if (pd == null || pt == null) continue;
        if (pd < d[d.length - 1] || pt < t[t.length - 1]) continue;       // keep monotonic
        if (pd === d[d.length - 1] && pt === t[t.length - 1]) continue;
        d.push(pd); t.push(pt);
      }
      var endD = run.distanceM != null ? run.distanceM : d[d.length - 1], endT = run.elapsed != null ? run.elapsed : t[t.length - 1];
      if (endD >= d[d.length - 1] && endT >= t[t.length - 1]) { d.push(endD); t.push(endT); }
      if (d.length < 3) return null;
      if (d[d.length - 1] < this.MATCH.minTreadmillFrac * D) return null;   // partial run: not comparable
      // Within 5 % short of the end: extend at her average speed so the profile reaches the route end
      var dl = d[d.length - 1], tl = t[t.length - 1];
      if (dl < D) { d.push(D); t.push(tl + (D - dl) / Math.max(0.5, dl / Math.max(1, tl))); }
      return {
        id: 'tm_' + (run.id || run.startedAt), source: 'treadmill', sourceId: run.id || null,
        date: run.startedAt || run.savedAt || null, totalS: r1(t[t.length - 1]), d: d, t: t
      };
    },

    /** Strava activity streams -> profile scaled onto the base route distance. */
    profileFromStreams: function (item, streams, route) {
      var conv = SR().convert(streams, { limits: { min: -50, max: 50 } });
      if (!conv.ghost) return null;
      var k = route.totalDistM / conv.totalDistM, d = [], i;
      for (i = 0; i < conv.ghost.d.length; i++) d.push(r1(conv.ghost.d[i] * k));
      return {
        id: 'sv_' + item.id, source: 'strava', sourceId: item.id,
        date: item.start_date || item.start_date_local || null,
        totalS: r1(conv.ghost.movingTimeS), d: d, t: conv.ghost.t.slice(),
        hrKm: this.hrPerKm(streams, k)   // average HR per km from the same stream call (no extra request)
      };
    },

    /** Average heart rate per km (index 0 = km 1) from raw streams, distances scaled by k; [] if the run has no HR. */
    hrPerKm: function (streams, k) {
      var hr = streams && streams.heartrate, dist = streams && streams.distance, out = [];
      if (!hr || !dist || hr.length !== dist.length || !hr.length) return out;
      var sums = [], cnts = [], i, j;
      for (i = 0; i < hr.length; i++) {
        if (!(hr[i] > 30 && hr[i] < 250)) continue;
        j = Math.floor(dist[i] * k / 1000 - 1e-9); if (j < 0) j = 0;
        sums[j] = (sums[j] || 0) + hr[i]; cnts[j] = (cnts[j] || 0) + 1;
      }
      for (i = 0; i < sums.length; i++) out.push(cnts[i] ? Math.round(sums[i] / cnts[i]) : 0);
      return out;
    },

    profileFromMeta: function (routeId, meta, route) {
      if (!meta || !meta.ghost) return null;
      var k = route.totalDistM / meta.ghost.d[meta.ghost.d.length - 1];
      var d = [], i;
      for (i = 0; i < meta.ghost.d.length; i++) d.push(r1(meta.ghost.d[i] * k));
      return { id: 'sv_' + meta.stravaId, source: 'strava', sourceId: meta.stravaId, date: meta.startDate || meta.date, totalS: meta.ghost.movingTimeS, d: d, t: meta.ghost.t.slice() };
    },

    /** Same effort stored locally AND on Strava? */
    isDuplicate: function (item, localRuns) {
      var M = this.MATCH, st = Date.parse(item.start_date || item.start_date_local), up = this.uploadedMap(), i;
      for (var rid in up) if (String(up[rid]) === String(item.id)) return true;
      for (i = 0; i < localRuns.length; i++) {
        var r = localRuns[i], rs = Date.parse(r.startedAt);
        if (isNaN(rs) || isNaN(st)) continue;
        if (Math.abs(rs - st) / 1000 <= M.dupStartS && (!item.distance || !r.distanceM || Math.abs(item.distance - r.distanceM) / r.distanceM <= M.dupDistFrac)) return true;
        if (r.synced && r.synced.strava && String(r.synced.strava.activityId) === String(item.id)) return true;
      }
      return false;
    },
    uploadedMap: function () { try { return JSON.parse(lsGet('tr_strava_uploaded') || '{}') || {}; } catch (e) { return {}; } },
    noteUploaded: function (runId, activityId) { var m = this.uploadedMap(); m[runId] = activityId; lsSet('tr_strava_uploaded', JSON.stringify(m)); },

    // ════════════════════════════════════════════════════════════════════════
    // Racers from a pool (pure)
    // ════════════════════════════════════════════════════════════════════════

    /** pool: profiles. route: for the sampling grid. -> racers[] */
    computeRacers: function (pool, route) {
      var C = this.COLOURS, L = this.LETTERS, out = [], I = SR()._interp;
      if (!pool || !pool.length) return out;
      var sorted = pool.slice().sort(function (a, b) { return a.totalS - b.totalS; });
      var fast = sorted[0], slow = sorted[sorted.length - 1];
      function describe(p) { return (p.source === 'strava' ? 'Strava ' : 'Treadmill ') + fmtShortDate(p.date); }
      // synthetic average on the route's own distance grid
      var grid = [], i, j;
      for (i = 0; i < route.resampled.length; i++) grid.push(route.resampled[i].dist);
      var at = [];
      for (i = 0; i < grid.length; i++) {
        var sum = 0;
        for (j = 0; j < pool.length; j++) sum += I(pool[j].d, pool[j].t, grid[i]);
        at.push(r1(sum / pool.length));
      }
      for (i = 1; i < at.length; i++) if (at[i] < at[i - 1]) at[i] = at[i - 1];
      var avg = { d: grid, t: at, totalS: at[at.length - 1] };

      if (pool.length === 1) {
        out.push({ id: 'single', kind: 'single', label: 'YOUR RUN', letter: L.single, colour: C.average, source: fast.source, date: fast.date,
                   totalS: fast.totalS, legend: describe(fast), d: fast.d, t: fast.t });
        return out;
      }
      if (Math.abs(fast.totalS - slow.totalS) < 0.5) {
        out.push({ id: 'single', kind: 'single', label: 'YOUR RUNS (AVG)', letter: L.single, colour: C.average, source: 'mixed', date: fast.date,
                   totalS: avg.totalS, legend: pool.length + ' runs, same time', d: avg.d, t: avg.t });
        return out;
      }
      out.push({ id: 'fastest', kind: 'fastest', label: 'FASTEST', letter: L.fastest, colour: C.fastest, source: fast.source, date: fast.date, totalS: fast.totalS, legend: describe(fast), d: fast.d, t: fast.t });
      out.push({ id: 'average', kind: 'average', label: 'AVERAGE', letter: L.average, colour: C.average, source: 'mixed', date: null, totalS: avg.totalS, legend: 'Mean of ' + pool.length + ' runs', d: avg.d, t: avg.t });
      out.push({ id: 'slowest', kind: 'slowest', label: 'SLOWEST', letter: L.slowest, colour: C.slowest, source: slow.source, date: slow.date, totalS: slow.totalS, legend: describe(slow), d: slow.d, t: slow.t });
      return out;
    },

    // ════════════════════════════════════════════════════════════════════════
    // Pool assembly
    // ════════════════════════════════════════════════════════════════════════

    /** All locally stored runs (localStorage + IndexedDB, de-duplicated by id). */
    localRuns: function () {
      var self = this;
      return new Promise(function (resolve) {
        var all = [], seen = {};
        function add(arr) { (arr || []).forEach(function (r) { if (r && !seen[r.id || r.startedAt]) { seen[r.id || r.startedAt] = 1; all.push(r); } }); }
        try { if (env('Store')) add(env('Store').getRuns()); } catch (e) {}
        try {
          if (env('IDBStore') && env('IDBStore')._db && env('IDBStore').getRuns) {
            var done = false;
            setTimeout(function () { if (!done) { done = true; resolve(all); } }, 1500);
            env('IDBStore').getRuns(function (runs) { if (done) return; done = true; add(runs); resolve(all); });
            return;
          }
        } catch (e) {}
        resolve(all);
      });
    },

    treadmillProfiles: function (route, runs) {
      var out = [], i, self = this;
      (runs || []).forEach(function (r) {
        if (r.routeId !== route.id) return;
        var p = self.profileFromRun(r, route);
        if (p) out.push(p);
      });
      return out;
    },

    /**
     * Build the pool for a route. opts {runs (inject), noStrava, maxFetch}
     * Resolves {pool, rejected[], fetched, partial, error}. Calls opts.onPartial(pool) after the
     * instant (treadmill-only) stage.
     */
    buildPool: function (route, opts) {
      opts = opts || {};
      var self = this, M = this.MATCH, A = root.StravaApi;
      var rejected = [];
      return (opts.runs ? Promise.resolve(opts.runs) : this.localRuns()).then(function (runs) {
        var pool = self.treadmillProfiles(route, runs);
        var res = { pool: pool, rejected: rejected, fetched: 0, partial: false, error: null };
        if (opts.onPartial) opts.onPartial(pool.slice());
        if (opts.noStrava || !A || !A.isConnected()) return res;

        var meta = SR().meta(route.id);
        var key = 'pool:' + route.id;
        return A.kv.get(key).then(function (saved) {
          saved = saved || { accepted: [], seen: {} };
          var haveAcc = {};
          saved.accepted.forEach(function (p) { haveAcc[p.sourceId] = p; });
          // the activity the route came from is always in the pool (no request needed)
          if (meta && meta.source === 'strava-activity' && !haveAcc[meta.stravaId]) {
            var pm = self.profileFromMeta(route.id, meta, route);
            if (pm && !self.isDuplicate({ id: meta.stravaId, start_date: meta.startDate || meta.date, distance: route.totalDistM }, runs)) { saved.accepted.push(pm); haveAcc[meta.stravaId] = pm; }
          }
          return A.listRecentRuns({ want: 30 }).then(function (lst) {
            var cands = [];
            lst.items.forEach(function (it) {
              if (haveAcc[it.id] || saved.seen[it.id]) return;
              if (meta && meta.stravaId === it.id) return;
              if (self.isDuplicate(it, runs)) { saved.seen[it.id] = 'dup'; rejected.push({ id: it.id, why: 'duplicate-of-treadmill-run' }); return; }
              var pre = self.preMatch(route, it);
              if (!pre.ok) { saved.seen[it.id] = pre.why; rejected.push({ id: it.id, why: 'pre:' + pre.why }); return; }
              cands.push(it);
            });
            cands = cands.slice(0, opts.maxFetch != null ? opts.maxFetch : M.maxFetch);
            var chain = Promise.resolve();
            cands.forEach(function (it) {
              chain = chain.then(function () {
                return A.getActivityStreams(it.id).then(function (st) {
                  res.fetched++;
                  var m = self.streamMatch(route, st);
                  if (!m.ok) { saved.seen[it.id] = m.why; rejected.push({ id: it.id, why: 'stream:' + m.why, dev: m.dev }); return; }
                  var prof = self.profileFromStreams(it, st, route);
                  if (prof) { saved.accepted.push(prof); haveAcc[it.id] = prof; } else saved.seen[it.id] = 'no-time';
                });
              });
            });
            return chain.then(function () { return lst; });
          }).then(null, function (err) { res.partial = true; res.error = err; }).then(function () {
            A.kv.set(key, saved);
            // accepted Strava profiles also must not duplicate a treadmill run
            saved.accepted.forEach(function (p) {
              if (!self.isDuplicate({ id: p.sourceId, start_date: p.date, distance: route.totalDistM }, runs)) res.pool.push(p);
            });
            return res;
          });
        });
      });
    },

    // ════════════════════════════════════════════════════════════════════════
    // Per-km split source for PastRunSplits (js/past-run-splits.js)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * PastRunSplits.sources entry: per-km splits of the Strava runs that the race pool matched to the loaded route.
     * Same route only (pool.routeId must equal routeId); treadmill copies win on duplicates (a Strava run that is also
     * stored locally, or that this app uploaded, is dropped again here, in case it was saved after the pool was built).
     * Splits are cut from the run's time-at-distance profile (moving time) on the route's distance scale.
     * avgHR per km comes from the run's heartrate stream (same call as the route data); 0 when the run had no HR (ignored by the comparison).
     */
    splitsSource: function (routeId, distanceKm) {
      var a = StravaRacers.active, out = [];
      if (!routeId || !a || a.routeId !== routeId) return out;
      var I = SR()._interp, D = a.route.totalDistM, localRuns = [];
      try { if (env('Store')) localRuns = env('Store').getRuns() || []; } catch (e) {}
      a.pool.forEach(function (p) {
        if (p.source !== 'strava') return;
        if (StravaRacers.isDuplicate({ id: p.sourceId, start_date: p.date, distance: D }, localRuns)) return;
        var n = Math.floor(D / 1000 + 1e-9), splits = [], prev = 0, k;
        for (k = 1; k <= n; k++) {
          var t = I(p.d, p.t, k * 1000);
          splits.push({ km: k, timeSec: Math.max(1, Math.round(t - prev)), avgHR: (p.hrKm && p.hrKm[k - 1]) || 0 });
          prev = t;
        }
        if (!splits.length) return;
        out.push({ id: p.id, date: p.date, name: 'Strava run', routeId: routeId, source: 'strava',
                   distanceKm: D / 1000, splits: splits, finalSplit: null });
      });
      return out;
    },

    // ════════════════════════════════════════════════════════════════════════
    // Activation + live API
    // ════════════════════════════════════════════════════════════════════════

    setPool: function (route, pool, status) {
      this.active = { routeId: route.id, route: route, pool: pool, racers: this.computeRacers(pool, route), status: status || {} };
      this._emit();
      return this.active;
    },

    /** Call after Engine.loadRoute for ANY route. Instant for treadmill runs; Strava part follows. */
    onRouteLoaded: function (route, opts) {
      opts = opts || {};
      var self = this;
      this.clear();
      if (!route || !route.resampled) return Promise.resolve(null);
      var token = route.id;
      return this.buildPool(route, {
        runs: opts.runs, noStrava: opts.noStrava,
        onPartial: function (p) { if (self.active === null || self.active.routeId === token) self.setPool(route, p, { stage: 'treadmill' }); }
      }).then(function (res) {
        if (self.active && self.active.routeId !== token) return null;     // route changed meanwhile
        var a = self.setPool(route, res.pool, { stage: 'done', fetched: res.fetched, partial: res.partial, error: res.error ? res.error.message : null, rejected: res.rejected });
        self._afterChange();
        return a;
      });
    },
    clear: function () {
      this.active = null;
      this.mapLayer.detach(); this.legend.hide();
      this._emit();
    },
    _afterChange: function () {
      var a = this.active;
      if (!a) return;
      this.legend.render();
      if (env('MapView') && env('MapView').map && this.mapLayer._on !== false) this.mapLayer.attach(env('MapView').map);
      if (this._engineGhost !== 'none') this.armEngineGhost(this._engineGhost || 'fastest');
    },

    list: function () { return this.active ? this.active.racers : []; },
    _racer: function (id) { var r = this.list(); for (var i = 0; i < r.length; i++) if (r[i].id === id) return r[i]; return null; },

    /** [{id,label,letter,colour,source,date,totalS,legend}] (profiles omitted) */
    racers: function () {
      return this.list().map(function (r) { return { id: r.id, label: r.label, letter: r.letter, colour: r.colour, source: r.source, date: r.date, totalS: r.totalS, legend: r.legend }; });
    },
    /** Each racer's position at a route DISTANCE and the time it got there: [{id,lat,lng,elapsedS}] */
    racerPositionsAt: function (distanceM) {
      var a = this.active; if (!a) return [];
      var I = SR()._interp, route = a.route, ll = SR()._latlonAt(route, distanceM);
      return a.racers.map(function (r) { return { id: r.id, lat: ll[0], lng: ll[1], elapsedS: r1(I(r.d, r.t, distanceM)) }; });
    },
    /** Where each racer is NOW, `elapsedS` into the race (what the dots on the map use). [{id,lat,lng,distanceM}] */
    racerPositionsAtTime: function (elapsedS) {
      var a = this.active; if (!a) return [];
      var I = SR()._interp, route = a.route;
      return a.racers.map(function (r) {
        var d = I(r.t, r.d, elapsedS), ll = SR()._latlonAt(route, d);
        return { id: r.id, lat: ll[0], lng: ll[1], distanceM: r1(d) };
      });
    },
    /** Seconds Soph is AHEAD(+)/BEHIND(-) each racer at her current distance: [{id,label,letter,colour,gapS}] */
    gapsAt: function (distanceM, currentElapsedS) {
      var a = this.active; if (!a) return [];
      var I = SR()._interp;
      return a.racers.map(function (r) {
        return { id: r.id, label: r.label, letter: r.letter, colour: r.colour, gapS: r1(I(r.d, r.t, distanceM) - currentElapsedS) };
      });
    },
    /** 'Fastest +0:42, Average -0:10, Slowest -1:30' */
    gapsText: function (distanceM, currentElapsedS) {
      return this.gapsAt(distanceM, currentElapsedS).map(function (g) {
        return g.label.charAt(0) + g.label.slice(1).toLowerCase() + ' ' + fmtGap(g.gapS);
      }).join(', ');
    },

    // ── Engine ghost (kept for summary delta / Ghost Buster badge) ─────────
    _engineGhost: 'fastest',
    armEngineGhost: function (which) {
      var a = this.active;
      if (!a || !a.racers.length || !env('Engine') || !env('Engine').loadGhost) return false;
      var r = this._racer(which) || a.racers[0], tp = [], t, I = SR()._interp;
      for (t = 0; t < r.totalS; t += 2) tp.push({ elapsed: t, dist: r1(I(r.t, r.d, t)) });
      tp.push({ elapsed: r.totalS, dist: r.d[r.d.length - 1] });
      env('Engine').loadGhost({ id: 'ghost_' + r.id, source: 'racers', ghostSource: r.source === 'strava' ? 'strava-activity' : 'treadmill-run',
        routeId: a.routeId, routeName: r.label, elapsed: r.totalS, distanceM: r.d[r.d.length - 1], trackPoints: tp });
      this._suppressEngineMarker();
      return true;
    },
    _suppressEngineMarker: function () {
      var MV = env('MapView');
      if (!MV || MV._svWrapped) return;
      var orig = MV.updateGhost;
      MV.updateGhost = function (ll, vis) {
        if (StravaRacers.active && StravaRacers.active.racers.length) return orig.call(MV, null, false);
        return orig.call(MV, ll, vis);
      };
      MV._svWrapped = true;
    },

    // ── per-tick driver ────────────────────────────────────────────────────
    onTick: function (run) {
      if (!this.active || !run) return;
      this.mapLayer.update(run.elapsed || 0);
      this.legend.update(run);
    },

    // ════════════════════════════════════════════════════════════════════════
    // Drawing helpers
    // ════════════════════════════════════════════════════════════════════════

    /** Leaflet dots with a letter inside (colour AND letter, never colour alone). */
    mapLayer: {
      _map: null, _group: null, _markers: {}, _pane: 'stravaRacers', _on: true,
      attach: function (map) {
        var L = root.L, a = StravaRacers.active;
        this.detach();
        if (!L || !map || !a) return false;
        if (!map.getPane(this._pane)) { var pn = map.createPane(this._pane); pn.style.zIndex = 398; pn.style.pointerEvents = 'none'; }
        this._map = map; this._group = L.layerGroup().addTo(map); this._markers = {};
        var pos = StravaRacers.racerPositionsAtTime(0), self = this;
        a.racers.forEach(function (r, i) {
          var m = L.marker([pos[i].lat, pos[i].lng], {
            pane: self._pane, interactive: false, keyboard: false,
            icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17],
              html: '<div class="sv-dot sv-dot-' + r.kind + '" style="background:' + r.colour + '">' + r.letter + '</div>' })
          }).addTo(self._group);
          self._markers[r.id] = m;
        });
        return true;
      },
      update: function (elapsedS) {
        if (!this._group) return;
        var pos = StravaRacers.racerPositionsAtTime(elapsedS);
        for (var i = 0; i < pos.length; i++) if (this._markers[pos[i].id]) this._markers[pos[i].id].setLatLng([pos[i].lat, pos[i].lng]);
      },
      detach: function () { if (this._group && this._map) this._map.removeLayer(this._group); this._group = null; this._markers = {}; }
    },

    /**
     * Generic canvas drawing: ctx + fracToXY(frac 0..1) -> {x,y}. Draws a lettered disc per racer.
     * Used by ovalTrack.install() and usable on any other canvas.
     */
    drawOnCanvas: function (ctx, fracToXY, elapsedS, radius) {
      var a = this.active; if (!a || !ctx) return;
      var D = a.route.totalDistM, pos = this.racerPositionsAtTime(elapsedS || 0), rr = radius || 15;
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold ' + Math.round(rr * 1.05) + 'px sans-serif';
      for (var i = 0; i < pos.length; i++) {
        var xy = fracToXY(Math.max(0, Math.min(1, pos[i].distanceM / D)));
        ctx.beginPath(); ctx.arc(xy.x, xy.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = a.racers[i].colour; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        ctx.fillStyle = '#05080c'; ctx.fillText(a.racers[i].letter, xy.x, xy.y + 1);
      }
      ctx.restore();
    },

    /** Draw racers inside the existing oval-track render loop by wrapping OvalTrack._drawPacMan (no file edit). */
    ovalTrack: {
      _installed: false,
      install: function () {
        var O = env('OvalTrack');
        if (!O || this._installed || !O._drawPacMan) return false;
        var orig = O._drawPacMan;
        O._drawPacMan = function (c, now) {
          try {
            if (StravaRacers.active && StravaRacers.active.racers.length) {
              var el = (env('Engine') && env('Engine').run) ? env('Engine').run.elapsed : 0;
              StravaRacers.drawOnCanvas(c, function (f) { return O._fracToPoint(f); }, el, Math.max(12, O.canvas ? O.canvas.height * 0.018 : 14));
            }
          } catch (e) {}
          return orig.call(O, c, now);
        };
        this._installed = true;
        return true;
      }
    },

    /**
     * Legend / live-gap panel.
     *  * Integrated app (ui-v4 index.html has #raceBar): COMPACT single-row bar in normal layout flow between the
     *    metric strip and the view zone, e.g. "F +0:42   A -0:10   S -1:30   YOU". Because it is in flow (it shrinks the
     *    view zone instead of floating over it) it cannot cover the video window (js/video.js clamps to the zone),
     *    STOP/PAUSE, the edge controls or the metric strip.  Full details (source/date/total time) are in each chip's title.
     *  * Otherwise (demo harness): the original floating detailed panel.
     */
    legend: {
      el: null, _last: 0, visible: true, compact: false,
      _host: function () { return root.document && (root.document.getElementById('rootApp') || root.document.body); },
      _bar: function () { return root.document && root.document.getElementById('raceBar'); },
      /** The view zone changed height: let the map / video window / oval re-measure. */
      _relayout: function () {
        try {
          var VW = env('VideoWin');
          if (VW && VW.el && VW._pos) { VW._clamp(); VW._apply(); }
          var MV = env('MapView');
          if (MV && MV.map && MV.map.invalidateSize) MV.map.invalidateSize();
          var ev = root.document.createEvent('Event'); ev.initEvent('resize', true, true);
          root.dispatchEvent(ev);
        } catch (e) {}
      },
      hide: function () {
        if (this.el) this.el.style.display = 'none';
        var b = this._bar();
        this._racing(false);
        if (b && b.className.indexOf(' on') >= 0) { b.className = 'race-bar'; b.innerHTML = ''; this._relayout(); }
      },
      /** While a race is on, the race bar replaces the engine's centre-top ghost chip (it sat on top of the view buttons). */
      _racing: function (on) {
        var r = root.document && root.document.getElementById('rootApp');
        if (!r) return;
        var has = (' ' + r.className + ' ').indexOf(' racing ') >= 0;
        if (on && !has) r.className += ' racing';
        if (!on && has) r.className = (' ' + r.className + ' ').replace(' racing ', ' ').replace(/^\s+|\s+$/g, '');
      },
      render: function () {
        var a = StravaRacers.active, doc = root.document;
        if (!doc || !a || !a.racers.length) { this.hide(); return; }
        var bar = this._bar(), html = '';
        if (bar) {
          this.compact = true; this.el = bar;
          var was = bar.className.indexOf(' on') >= 0;
          a.racers.forEach(function (r) {
            html += '<span class="sv-cr" data-id="' + r.id + '" title="' + r.label + ' - ' + r.legend + ' - ' + fmtDur(r.totalS) + '">' +
              '<span class="sv-chip" style="background:' + r.colour + '">' + r.letter + '</span>' +
              '<span class="sv-cr-gap" id="svgap_' + r.id + '">+0:00</span></span>';
          });
          html += '<span class="sv-cr sv-cr-you" title="You (blue dot)"><span class="sv-chip" style="background:' + StravaRacers.COLOURS.you + '">YOU</span></span>';
          html += '<span class="sv-cr-hint">+ = ahead of them</span>';
          bar.innerHTML = html;
          bar.className = 'race-bar on';
          this._racing(true);
          bar.style.display = this.visible ? '' : 'none';
          if (!was) this._relayout();
          return;
        }
        var host = this._host(); if (!host) return;
        if (!this.el) { this.el = doc.createElement('div'); this.el.className = 'sv-legend'; host.appendChild(this.el); }
        this.el.style.display = this.visible ? '' : 'none';
        html = '<div class="sv-legend-title">RACE</div>';
        a.racers.forEach(function (r) {
          html += '<div class="sv-legend-row" data-id="' + r.id + '"><span class="sv-chip" style="background:' + r.colour + '">' + r.letter + '</span>' +
            '<span class="sv-lg-main"><b>' + r.label + '</b><i>' + r.legend + '</i></span>' +
            '<span class="sv-lg-time">' + fmtDur(r.totalS) + '</span><span class="sv-lg-gap" id="svgap_' + r.id + '">--</span></div>';
        });
        html += '<div class="sv-legend-row sv-you"><span class="sv-chip" style="background:' + StravaRacers.COLOURS.you + '">YOU</span><span class="sv-lg-main"><b>YOU</b></span></div>';
        this.el.innerHTML = html;
      },
      update: function (run) {
        if (!this.el || !StravaRacers.active || Date.now() - this._last < 900) return;
        this._last = Date.now();
        var gaps = StravaRacers.gapsAt(run.distanceM || 0, run.elapsed || 0);
        for (var i = 0; i < gaps.length; i++) {
          var e = root.document.getElementById('svgap_' + gaps[i].id);
          if (e) {
            e.textContent = fmtGap(gaps[i].gapS);
            e.className = (this.compact ? 'sv-cr-gap ' : 'sv-lg-gap ') + (gaps[i].gapS >= 0 ? 'sv-ahead' : 'sv-behind');
          }
        }
      }
    },

    fmtDur: fmtDur, fmtGap: fmtGap, fmtShortDate: fmtShortDate
  };

  root.StravaRacers = StravaRacers;
  // expose the requested API on StravaRoutes as well (routeId is implicit: the active route)
  if (root.StravaRoutes) {
    root.StravaRoutes.racers = function () { return StravaRacers.racers(); };
    root.StravaRoutes.racerPositionsAt = function (d) { return StravaRacers.racerPositionsAt(d); };
    root.StravaRoutes.racerPositionsAtTime = function (t) { return StravaRacers.racerPositionsAtTime(t); };
    root.StravaRoutes.gapsAt = function (d, t) { return StravaRacers.gapsAt(d, t); };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = StravaRacers;
})(typeof window !== 'undefined' ? window : globalThis);
