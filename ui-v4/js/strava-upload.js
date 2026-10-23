// ════════════════════════════════════════════════════════════════════════════
// StravaUpload - record a finished run back to Strava, ONLY after an explicit
//                SAVE TO STRAVA tap on a confirm screen.
//
//  Two upload modes (setting StravaApi.prefs().uploadMode):
//   'trainer'  (DEFAULT) TCX with time/distance/HR and NO GPS, sport_type=Run, trainer=1.
//              Shows on Strava as an indoor/treadmill run, named after the route.
//   'virtual'  TCX whose positions are the route's lat/lng interpolated by distance,
//              sport_type=VirtualRun (no trainer flag): gets a map of the route.
//   Why trainer is the default: a treadmill run has no GPS; faking a track makes Strava
//   treat it as an outdoor run (segment efforts / "local legend" / heatmap contamination,
//   pace/elevation re-derived from fake geometry) and misrepresents the activity to her
//   followers. The route + climb are put in the name/description instead. 'virtual' is
//   there for people who want the map.
//
// Offline / failure: confirmed uploads are queued (IDB/localStorage, max 5) and retried on
// the next 'online' event or StravaUpload.flushQueue(). A queued item is something she
// already said SAVE to - nothing is ever queued on SKIP and nothing is uploaded unconfirmed.
//
// No TM.* calls: this module never touches the belt.
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

  function api() { return root.StravaApi; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) {} }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDur(s) { s = Math.round(s || 0); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s % 60); }
  function el(tag, cls, text) { var e = root.document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, fn) { var b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; }

  var StravaUpload = {

    QUEUE_KEY: 'uploadQueue',
    MAX_QUEUE: 5,
    MIN_ELAPSED_S: 30,
    MIN_DISTANCE_M: 100,

    // ════════════════════════════════════════════════════════════════════════
    // TCX
    // ════════════════════════════════════════════════════════════════════════

    /**
     * run: summary from Engine.saveRun() {id, routeName, startedAt, finishedAt, elapsed, distanceM,
     *      calories, avgHR, maxHR, trackPoints[{time,dist,hr,ele,lat,lon,elapsed,speed}]}
     * opts: {mode:'trainer'|'virtual', route (stored route w/ resampled), includeElevation}
     * Cadence deliberately omitted (the treadmill's cadence is an estimate).
     */
    buildTcx: function (run, opts) {
      opts = opts || {};
      var mode = opts.mode === 'virtual' && opts.route ? 'virtual' : 'trainer';
      var start = run.startedAt || new Date().toISOString();
      var startMs = Date.parse(start);
      var pts = (run.trackPoints || []).slice(), out = [], i, lastMs = -1, lastDist = 0;

      // guarantee a first (t=0,d=0) and last point so even a short run has a track
      if (!pts.length || Date.parse(pts[0].time) > startMs + 1500) pts.unshift({ time: start, dist: 0, hr: pts.length ? pts[0].hr : 0, ele: pts.length ? pts[0].ele : null });
      var endMs = run.finishedAt ? Date.parse(run.finishedAt) : startMs + (run.elapsed || 0) * 1000;
      var lastP = pts[pts.length - 1];
      if (Date.parse(lastP.time) < endMs - 1500) pts.push({ time: new Date(endMs).toISOString(), dist: Math.round(run.distanceM || lastP.dist || 0), hr: lastP.hr, ele: lastP.ele });

      var SRt = root.StravaRoutes;
      for (i = 0; i < pts.length; i++) {
        var p = pts[i], ms = Date.parse(p.time);
        if (isNaN(ms) || ms <= lastMs) continue;                 // strictly increasing time
        var d = Math.max(lastDist, p.dist || 0);                 // non-decreasing distance
        lastMs = ms; lastDist = d;
        var o = { time: new Date(ms).toISOString(), dist: d, hr: p.hr || 0, ele: p.ele };
        if (mode === 'virtual' && SRt) { var ll = SRt._latlonAt(opts.route, Math.min(d, opts.route.totalDistM)); o.lat = ll[0]; o.lon = ll[1]; }
        out.push(o);
      }
      var x = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">\n  <Activities>\n' +
        '    <Activity Sport="Running">\n      <Id>' + esc(start) + '</Id>\n' +
        '      <Lap StartTime="' + esc(start) + '">\n' +
        '        <TotalTimeSeconds>' + Math.round(run.elapsed || (endMs - startMs) / 1000) + '</TotalTimeSeconds>\n' +
        '        <DistanceMeters>' + Math.round(run.distanceM || lastDist) + '</DistanceMeters>\n' +
        '        <Calories>' + Math.round(run.calories || 0) + '</Calories>\n';
      if (run.avgHR) x += '        <AverageHeartRateBpm><Value>' + Math.round(run.avgHR) + '</Value></AverageHeartRateBpm>\n';
      if (run.maxHR) x += '        <MaximumHeartRateBpm><Value>' + Math.round(run.maxHR) + '</Value></MaximumHeartRateBpm>\n';
      x += '        <Intensity>Active</Intensity>\n        <TriggerMethod>Manual</TriggerMethod>\n        <Track>\n';
      for (i = 0; i < out.length; i++) {
        var q = out[i];
        x += '          <Trackpoint>\n            <Time>' + q.time + '</Time>\n';
        if (q.lat != null) x += '            <Position><LatitudeDegrees>' + q.lat.toFixed(6) + '</LatitudeDegrees><LongitudeDegrees>' + q.lon.toFixed(6) + '</LongitudeDegrees></Position>\n';
        if (opts.includeElevation !== false && q.ele != null && !isNaN(q.ele)) x += '            <AltitudeMeters>' + (+q.ele).toFixed(1) + '</AltitudeMeters>\n';
        x += '            <DistanceMeters>' + q.dist + '</DistanceMeters>\n';
        if (q.hr > 30 && q.hr < 250) x += '            <HeartRateBpm><Value>' + Math.round(q.hr) + '</Value></HeartRateBpm>\n';
        x += '          </Trackpoint>\n';
      }
      x += '        </Track>\n      </Lap>\n      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>TrailRunner</Name></Creator>\n    </Activity>\n  </Activities>\n</TrainingCenterDatabase>\n';
      return { tcx: x, mode: mode, points: out.length };
    },

    /** Name + description + API fields for a run. */
    buildFields: function (run, opts) {
      opts = opts || {};
      var t = this.buildTcx(run, opts), route = opts.route, meta = opts.meta, name, desc = [];
      var rn = run.routeName && run.routeName !== 'Free Run' ? run.routeName : null;
      if (t.mode === 'virtual') name = 'Virtual run: ' + (rn || 'TrailRunner');
      else name = rn ? rn + ' (treadmill)' : 'Treadmill run';
      desc.push('Treadmill run recorded with TrailRunner on a NordicTrack X32i.');
      if (rn) desc.push('Route followed (incline auto-matched): ' + rn + (meta && meta.source === 'strava-activity' ? ' - from my own Strava run' : '') + '.');
      if (route && route.totalAscent) desc.push('Route climb on the belt: +' + Math.round(run.elevGained || 0) + ' m' + (meta && meta.ascentReal ? ' (real route: +' + meta.ascentReal + ' m, incline limited to ' + meta.limits.min + '%..' + meta.limits.max + '%)' : '') + '.');
      if (run.avgSpeed) desc.push('Avg speed ' + (+run.avgSpeed).toFixed(1) + ' km/h.');
      if (t.mode === 'virtual') desc.push('Map shows the route position by distance; this was done indoors.');
      var f = {
        file: t.tcx, filename: 'trailrunner-' + (run.id || Date.now()) + '.tcx', data_type: 'tcx',
        name: name, description: desc.join('\n'),
        external_id: 'trailrunner-' + (run.id || run.startedAt)
      };
      if (t.mode === 'virtual') f.sport_type = 'VirtualRun';
      else { f.sport_type = 'Run'; f.trainer = 1; }
      return { fields: f, mode: t.mode, points: t.points };
    },

    // ════════════════════════════════════════════════════════════════════════
    // Submit / queue
    // ════════════════════════════════════════════════════════════════════════

    /** Upload now and poll. Resolves {state:'done'|'duplicate'|'failed'|'queued', activityId, error}. */
    submit: function (item, cb) {
      var self = this, A = api();
      cb = cb || function () {};
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { return this.enqueue(item).then(function () { return { state: 'queued', error: 'Offline' }; }); }
      cb('uploading');
      return A.postUpload(item.fields).then(function (u) {
        cb('processing');
        return A.pollUpload(u.id, { onTick: function () { cb('processing'); } });
      }).then(function (r) {
        if (r.ok) { self._done(item, r.activityId); return { state: 'done', activityId: r.activityId }; }
        if (r.duplicate) { self._done(item, r.activityId); return { state: 'duplicate', activityId: r.activityId, error: r.error }; }
        return { state: 'failed', error: r.error || 'Strava could not process the file' };
      }).then(null, function (e) {
        if (e && e.code === 'timeout') { return self.enqueue(item).then(function () { return { state: 'queued', error: e.message }; }); }
        if (e && (e.code === 'offline' || e.code === 'rate_limited' || (e.status >= 500))) {
          return self.enqueue(item).then(function () { return { state: 'queued', error: e.message }; });
        }
        return { state: 'failed', error: (e && e.message) || 'Upload failed', code: e && e.code };
      });
    },
    _done: function (item, activityId) {
      if (root.StravaRacers && item.runId) root.StravaRacers.noteUploaded(item.runId, activityId);
      this.dequeue(item.runId);
    },

    queue: function () { return api().kv.get(this.QUEUE_KEY).then(function (q) { return q || []; }); },
    enqueue: function (item) {
      var self = this;
      return this.queue().then(function (q) {
        q = q.filter(function (x) { return x.runId !== item.runId; });
        q.push({ runId: item.runId, fields: item.fields, mode: item.mode, queuedAt: new Date().toISOString(), attempts: 0 });
        while (q.length > self.MAX_QUEUE) q.shift();
        return api().kv.set(self.QUEUE_KEY, q);
      });
    },
    dequeue: function (runId) {
      var self = this;
      return this.queue().then(function (q) { return api().kv.set(self.QUEUE_KEY, q.filter(function (x) { return x.runId !== runId; })); });
    },
    queueLength: function () { return this.queue().then(function (q) { return q.length; }); },

    _flushing: false,
    /** Retry confirmed uploads. Safe to call any time (single-flight). Resolves [{runId,state}]. */
    flushQueue: function () {
      var self = this;
      if (this._flushing || !api().isConnected()) return Promise.resolve([]);
      this._flushing = true;
      return this.queue().then(function (q) {
        var results = [], chain = Promise.resolve();
        q.forEach(function (it) {
          chain = chain.then(function () {
            return self.submit({ runId: it.runId, fields: it.fields, mode: it.mode }).then(function (r) {
              results.push({ runId: it.runId, state: r.state, activityId: r.activityId });
              if (r.state === 'failed') { return self.dequeue(it.runId); }    // permanent failure: do not retry forever
            });
          });
        });
        return chain.then(function () { return results; });
      }).then(function (r) { self._flushing = false; return r; }, function (e) { self._flushing = false; throw e; });
    },
    autoFlushOnOnline: function () {
      var self = this;
      if (this._wired || !root.addEventListener) return;
      this._wired = true;
      root.addEventListener('online', function () { if (api().prefs().autoRetryQueued) self.flushQueue(); });
    },

    // ════════════════════════════════════════════════════════════════════════
    // Confirm screen
    // ════════════════════════════════════════════════════════════════════════

    skippedMap: function () { try { return JSON.parse(lsGet('tr_strava_skipped') || '{}') || {}; } catch (e) { return {}; } },
    /** 'ok' | 'off' (not connected / no run) | 'short' (below Strava minimum) | 'skipped' | 'uploaded' */
    reason: function (run) {
      if (!run || !api() || !api().isConnected()) return 'off';
      var id = run.id;
      if (id && root.StravaRacers && root.StravaRacers.uploadedMap()[id]) return 'uploaded';
      if ((run.elapsed || 0) < this.MIN_ELAPSED_S || (run.distanceM || 0) < this.MIN_DISTANCE_M) return 'short';
      if (id && this.skippedMap()[id]) return 'skipped';
      return 'ok';
    },
    eligible: function (run) { return this.reason(run) === 'ok'; },
    /** Normalise a stored run (stats/history shape) to the shape buildFields expects. */
    normaliseStored: function (r) {
      var o = {}; for (var k in r) o[k] = r[k];
      o.elapsed = r.elapsed || r.elapsedSec || 0;
      o.distanceM = r.distanceM || Math.round((r.distanceKm || 0) * 1000);
      o.startedAt = r.startedAt || r.savedAt || r.date || new Date(Date.now() - o.elapsed * 1000).toISOString();
      return o;
    },
    isUploaded: function (runId) { return !!(runId && root.StravaRacers && root.StravaRacers.uploadedMap()[runId]); },
    activityUrlFor: function (runId) { var m = root.StravaRacers ? root.StravaRacers.uploadedMap() : {}; return m[runId] && api() ? api().activityUrl(m[runId]) : null; },
    /** Stored-run entry (SEND TO STRAVA button): same confirm card, even if earlier SKIPPED / too short (with notice). */
    promptStored: function (stored) {
      this.autoFlushOnOnline();
      var run = this.normaliseStored(stored);
      if (this.isUploaded(run.id)) return Promise.resolve({ action: 'none', state: 'uploaded' });
      return this.promptAfterSave(run, { force: true });
    },
    _shortCard: function (run, host) {
      var self = this;
      return new Promise(function (resolve) {
        var ov = el('div', 'sv-overlay sv-up sv-short'), card = el('div', 'sv-card');
        ov.appendChild(card);
        card.appendChild(el('div', 'sv-up-title', 'TOO SHORT TO UPLOAD'));
        card.appendChild(el('div', 'sv-up-note', 'Too short to upload: Strava needs at least ' + self.MIN_ELAPSED_S + ' s and ' + Units.distU(self.MIN_DISTANCE_M, 2) + '. This run: ' + fmtDur(run.elapsed) + ' and ' + Units.distU(run.distanceM || 0, 2) + '.'));
        var row = el('div', 'sv-up-btns'); card.appendChild(row);
        function close(r) { if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(r); }
        row.appendChild(btn('sv-btn sv-btn-main', 'UPLOAD ANYWAY', function () { close('anyway'); }));
        row.appendChild(btn('sv-btn sv-btn-alt', 'CLOSE', function () { close('close'); }));
        host.appendChild(ov);
      });
    },

    /**
     * Entry point for App.saveAndNewRun(): shows the SAVE TO STRAVA / SKIP screen.
     * Resolves {action:'skip'|'save'|'none', state, activityId}. Never uploads unless SAVE tapped.
     */
    promptAfterSave: function (run, opts) {
      var self = this;
      opts = opts || {};
      var why = this.reason(run);
      if (why === 'off' || why === 'uploaded' || (why === 'skipped' && !opts.force)) return Promise.resolve({ action: 'none' });
      if (why === 'short' && !opts.forceShort) {
        var h0 = root.document && (root.document.getElementById('rootApp') || root.document.body);
        if (!h0) return Promise.resolve({ action: 'none' });
        return this._shortCard(run, h0).then(function (c) {
          if (c === 'anyway') return self.promptAfterSave(run, { force: true, forceShort: true });
          return { action: 'none', state: 'short' };
        });
      }
      var route = null, meta = null;
      try {
        if (run.routeId && env('Store')) route = env('Store').getRoute(run.routeId);
        if (run.routeId && root.StravaRoutes) meta = root.StravaRoutes.meta(run.routeId);
      } catch (e) {}
      var prefs = api().prefs();
      var mode = (prefs.uploadMode === 'virtual' && route) ? 'virtual' : 'trainer';
      var host = root.document && (root.document.getElementById('rootApp') || root.document.body);
      if (!host) return Promise.resolve({ action: 'none' });

      return new Promise(function (resolve) {
        var ov = el('div', 'sv-overlay sv-up'), card = el('div', 'sv-card');
        ov.appendChild(card);
        card.appendChild(el('div', 'sv-up-title', 'SAVE TO STRAVA?'));
        var stats = el('div', 'sv-up-stats');
        function stat(label, val) { var s = el('div', 'sv-up-stat'); s.appendChild(el('div', 'sv-up-val', val)); s.appendChild(el('div', 'sv-up-lab', label)); stats.appendChild(s); }
        stat('TIME', fmtDur(run.elapsed)); stat('DISTANCE', Units.distU(run.distanceM));
        stat('CLIMB', '+' + Math.round(run.elevGained || 0) + ' m'); stat('AVG HR', run.avgHR ? String(run.avgHR) : '--');
        card.appendChild(stats);
        var routeLine = el('div', 'sv-up-route', (run.routeName && run.routeName !== 'Free Run') ? run.routeName : 'Free run');
        card.appendChild(routeLine);

        var modeRow = el('div', 'sv-seg');
        var bT = btn('sv-seg-btn', 'TREADMILL RUN (no map)', function () { setMode('trainer'); });
        var bV = btn('sv-seg-btn', 'VIRTUAL RUN ON ROUTE (map)', function () { setMode('virtual'); });
        modeRow.appendChild(bT); modeRow.appendChild(bV);
        if (route) card.appendChild(modeRow);
        var note = el('div', 'sv-up-note');
        card.appendChild(note);
        function setMode(m) {
          mode = (m === 'virtual' && route) ? 'virtual' : 'trainer';
          bT.className = 'sv-seg-btn' + (mode === 'trainer' ? ' on' : ''); bV.className = 'sv-seg-btn' + (mode === 'virtual' ? ' on' : '');
          note.textContent = mode === 'trainer'
            ? 'Recommended. Appears as an indoor run with time, distance, heart rate and climb. No fake GPS track.'
            : 'Adds the route map, using the route position by distance. Strava will show it as a Virtual Run.';
        }
        setMode(mode);

        var status = el('div', 'sv-up-status');
        card.appendChild(status);
        var row = el('div', 'sv-up-btns');
        card.appendChild(row);
        card.appendChild(el('div', 'sv-powered', 'Powered by Strava'));

        function close(res) { if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(res); }
        function show(buttons) { row.innerHTML = ''; buttons.forEach(function (b) { row.appendChild(b); }); }
        function setStatus(txt, cls) { status.textContent = txt; status.className = 'sv-up-status ' + (cls || ''); }

        function doSkip() {
          var m = self.skippedMap(); if (run.id) m[run.id] = Date.now(); lsSet('tr_strava_skipped', JSON.stringify(m));
          close({ action: 'skip' });
        }
        function doSave() {
          modeRow.style.display = 'none';
          var built = self.buildFields(run, { mode: mode, route: route, meta: meta, includeElevation: prefs.includeElevation });
          var item = { runId: run.id, fields: built.fields, mode: built.mode };
          show([]);
          setStatus('Uploading to Strava...', 'busy');
          self.submit(item, function (st) { setStatus(st === 'uploading' ? 'Uploading to Strava...' : 'Strava is processing your run...', 'busy'); }).then(function (r) {
            if (r.state === 'done' || r.state === 'duplicate') {
              setStatus(r.state === 'done' ? 'Saved to Strava' : 'Already on Strava', 'ok');
              var link = el('a', 'sv-link', 'View on Strava'); link.href = api().activityUrl(r.activityId); link.target = '_blank';
              status.appendChild(el('br')); status.appendChild(link);
              show([btn('sv-btn sv-btn-main', 'DONE', function () { close({ action: 'save', state: r.state, activityId: r.activityId }); })]);
            } else if (r.state === 'queued') {
              setStatus('Queued - will send when online.', 'warn');
              show([btn('sv-btn sv-btn-main', 'OK', function () { close({ action: 'save', state: 'queued' }); }),
                    btn('sv-btn sv-btn-alt', 'RETRY NOW', function () { self.dequeue(run.id).then(doSave); })]);
            } else {
              setStatus('Could not save to Strava: ' + (r.error || 'unknown error'), 'err');
              show([btn('sv-btn sv-btn-main', 'TRY AGAIN', doSave),
                    btn('sv-btn sv-btn-alt', 'SAVE FOR LATER', function () { self.enqueue(item).then(function () { close({ action: 'save', state: 'queued' }); }); }),
                    btn('sv-btn sv-btn-alt', 'CLOSE', function () { close({ action: 'skip', state: 'failed' }); })]);
            }
          });
        }
        show([btn('sv-btn sv-btn-main', 'SAVE TO STRAVA', doSave), btn('sv-btn sv-btn-alt', 'SKIP', doSkip)]);
        host.appendChild(ov);
      });
    },

    /** Drop-in replacement for the Sync.autoSync(saved) block in App.saveAndNewRun(). */
    onRunSaved: function (saved) {
      var self = this;
      this.autoFlushOnOnline();
      return this.promptAfterSave(saved).then(function (r) {
        if (api().prefs().autoRetryQueued) self.flushQueue().then(null, function () {});
        return r;
      });
    }
  };

  root.StravaUpload = StravaUpload;
  if (typeof module !== 'undefined' && module.exports) module.exports = StravaUpload;
})(typeof window !== 'undefined' ? window : globalThis);
