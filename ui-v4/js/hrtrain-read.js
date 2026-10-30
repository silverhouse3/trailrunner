// ════════════════════════════════════════════════════════════════════════════
// HrTrainRead — READ-ONLY reader for the deep-import store (IndexedDB 'trailrunner_hrtrain', written by strava-deep.js).
//   HrTrainRead.list()   -> Promise<[run]>   runs that carry a stored stream (t[]), newest first; [] when the database does not
//                                            exist / has no 'runs' store / is empty / anything fails
//   HrTrainRead.build(run) -> tr_runs-shaped object WITH trackPoints + per-km splits (built on demand, for the selected runs only)
//
// Guarantees: never creates, upgrades, deletes or writes any database.  The database is opened only when
// indexedDB.databases() says it already exists; if the open would create/upgrade (onupgradeneeded) the version-change
// transaction is aborted, so nothing is left behind.  Readonly transactions only.  No network, no treadmill code.
// Record layout (see strava-deep.js): {id, summary:{name,start_date,distance,moving_time,elapsed_time,average_speed,average_heartrate,
//   max_heartrate,total_elevation_gain,...}, skip, t[] (s), hr[] bpm|null, v[] m/s, g[] percent grade, d[] metres, alt[], cad[]}
// ES5 + Promise only (WebView 83).
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';
  var DB_NAME = 'trailrunner_hrtrain', STORE = 'runs';

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function arr(a, n) { return (Array.isArray(a) && a.length === n) ? a : null; }

  // ── pure: stored record -> comparison-ready run ──────────────────────────────
  function hasStream(rec) { return !!(rec && !rec.skip && Array.isArray(rec.t) && rec.t.length > 0); }

  /** light object for the pickers: no trackPoints yet (cheap for 200 runs) */
  function summaryRun(rec) {
    var s = rec.summary || {}, n = rec.t.length, hr = arr(rec.hr, n), anyHR = false, i, sum = 0, cnt = 0, mx = 0;
    if (hr) for (i = 0; i < n; i++) { var h = num(hr[i]); if (h != null && h > 0) { anyHR = true; sum += h; cnt++; if (h > mx) mx = h; } }
    var last = num(rec.t[n - 1]) || 0, dEnd = arr(rec.d, n) ? num(rec.d[n - 1]) : null;
    var dist = num(s.distance) > 0 ? s.distance : dEnd;
    var el = num(s.moving_time) > 0 ? s.moving_time : (num(s.elapsed_time) > 0 ? s.elapsed_time : last);
    var start = s.start_date || s.start_date_local || null;
    return {
      id: 'hr_' + rec.id, stravaId: String(rec.id), source: 'strava', imported: true, deepTrace: true, hasHR: anyHR,
      routeName: (typeof s.name === 'string' || typeof s.name === 'number') && String(s.name) !== '' ? String(s.name) : 'Strava run', startedAt: start,
      elapsed: el, elapsedSec: el, distanceM: dist, distanceKm: dist != null ? dist / 1000 : null,
      avgSpeed: num(s.average_speed) > 0 ? s.average_speed * 3.6 : null,
      avgHR: num(s.average_heartrate) > 0 ? s.average_heartrate : (cnt ? sum / cnt : null),
      maxHR: num(s.max_heartrate) > 0 ? s.max_heartrate : (mx || null),
      elevGained: num(s.total_elevation_gain), _rec: rec
    };
  }

  /** per-km splits by interpolating elapsed time over the distance stream; avgHR = mean of the samples inside each km */
  function splitsFrom(t, d, hr) {
    var n = t.length, out = { splits: [], finalSplit: null };
    if (!d || n < 2) return out;
    var total = 0, i;
    for (i = 0; i < n; i++) if (num(d[i]) != null && d[i] > total) total = d[i];
    function tAt(x) {
      var pd = null, pt = null;
      for (var j = 0; j < n; j++) {
        var dj = num(d[j]), tj = num(t[j]); if (dj == null || tj == null) continue;
        if (dj >= x) { if (pd == null || dj === pd) return tj; return pt + (tj - pt) * ((x - pd) / (dj - pd)); }
        if (pd == null || dj > pd) { pd = dj; pt = tj; }
      }
      return pt;
    }
    function hrIn(a, b) {
      if (!hr) return 0;
      var s = 0, c = 0;
      for (var j = 0; j < n; j++) { var dj = num(d[j]), hj = num(hr[j]); if (dj != null && hj != null && hj > 0 && dj > a && dj <= b) { s += hj; c++; } }
      return c ? Math.round(s / c) : 0;
    }
    var whole = Math.floor(total / 1000 + 1e-9), k;
    for (k = 0; k < whole; k++) {
      var t0 = tAt(k * 1000), t1 = tAt((k + 1) * 1000);
      if (t0 == null || t1 == null || !(t1 > t0)) continue;
      out.splits.push({ km: k + 1, timeSec: t1 - t0, avgHR: hrIn(k * 1000, (k + 1) * 1000), elapsed: t1 });
    }
    var rem = total - whole * 1000;
    if (rem > 50) {
      var ta = tAt(whole * 1000), tb = tAt(total);
      if (ta != null && tb != null && tb > ta) out.finalSplit = { distKm: +(rem / 1000).toFixed(2), timeSec: tb - ta, avgHR: hrIn(whole * 1000, total), paceSecPerKm: Math.round((tb - ta) / (rem / 1000)), partial: true };
    }
    return out;
  }

  /** full tr_runs-shaped run: trackPoints {elapsed, hr, speed (km/h), incline (percent grade), dist (m)} + splits */
  function build(run) {
    var rec = run && run._rec; if (!hasStream(rec)) return run;
    var n = rec.t.length, hr = arr(rec.hr, n), v = arr(rec.v, n), g = arr(rec.g, n), d = arr(rec.d, n), tp = [], i;
    var t0 = run.startedAt && isFinite(Date.parse(run.startedAt)) ? Date.parse(run.startedAt) : null;
    for (i = 0; i < n; i++) {
      var t = num(rec.t[i]); if (t == null) continue;
      var p = { elapsed: t, hr: hr && num(hr[i]) > 0 ? hr[i] : null, speed: v && num(v[i]) != null ? v[i] * 3.6 : null, incline: g ? num(g[i]) : null, dist: d ? num(d[i]) : null };
      if (t0 != null) p.time = new Date(t0 + t * 1000).toISOString();
      tp.push(p);
    }
    var sp = splitsFrom(rec.t, d, hr), out = {};
    for (var k in run) if (k !== '_rec') out[k] = run[k];
    out.trackPoints = tp; out.splits = sp.splits; out.finalSplit = sp.finalSplit;
    return out;
  }

  // ── IndexedDB (read only) ──────────────────────────────────────────────────────
  function exists() {
    var idb = root.indexedDB;
    if (!idb || typeof idb.databases !== 'function') return Promise.resolve(false);     // cannot check without creating -> do not open
    return idb.databases().then(function (l) {
      for (var i = 0; i < (l || []).length; i++) if (l[i] && l[i].name === DB_NAME) return true;
      return false;
    }, function () { return false; });
  }
  function readAll(ctl) {
    return new Promise(function (resolve) {
      var done = false, rq;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      ctl.cancel = function () { done = true; };     // timed out: a late open/read result is ignored and its connection closed
      try { rq = root.indexedDB.open(DB_NAME); } catch (e) { return fin([]); }          // no version argument: opens what exists, never upgrades
      rq.onupgradeneeded = function (e) { try { e.target.transaction.abort(); } catch (x) {} fin([]); };   // would create it: undo, leave nothing behind
      rq.onerror = function (e) { try { e.preventDefault(); } catch (x) {} fin([]); };
      rq.onblocked = function () { fin([]); };
      rq.onsuccess = function (e) {
        var db = e.target.result;
        if (done) { try { db.close(); } catch (x) {} return; }
        try {
          if (!db.objectStoreNames.contains(STORE)) { db.close(); return fin([]); }
          var tx = db.transaction([STORE], 'readonly'), q = tx.objectStore(STORE).getAll();
          q.onsuccess = function () { var r = q.result || []; try { db.close(); } catch (x) {} fin(r); };
          q.onerror = function () { try { db.close(); } catch (x) {} fin([]); };
          tx.onabort = function () { try { db.close(); } catch (x) {} fin([]); };
        } catch (x) { try { db.close(); } catch (y) {} fin([]); }
      };
    });
  }
  function listNow(ctl) {
    return exists().then(function (yes) {
      if (!yes || ctl.timedOut) return [];
      return readAll(ctl).then(function (recs) {
        var out = [];
        for (var i = 0; i < recs.length; i++) { if (hasStream(recs[i])) { try { out.push(summaryRun(recs[i])); } catch (e) {} } }
        out.sort(function (a, b) { return (Date.parse(b.startedAt || '') || 0) - (Date.parse(a.startedAt || '') || 0); });
        return out;
      });
    }, function () { return []; });
  }
  /** Never waits longer than HrTrainRead.timeoutMs (4 s): a databases()/open() that never answers resolves to [] and later results are ignored. */
  function list() {
    var ctl = { timedOut: false, cancel: null };
    return new Promise(function (resolve) {
      var fin = false, to = setTimeout(function () { if (fin) return; fin = true; ctl.timedOut = true; if (ctl.cancel) ctl.cancel(); resolve([]); }, HrTrainRead.timeoutMs);
      function done(v) { if (fin) return; fin = true; clearTimeout(to); resolve(v); }
      try { listNow(ctl).then(done, function () { done([]); }); } catch (e) { done([]); }
    });
  }

  var HrTrainRead = root.HrTrainRead = { timeoutMs: 4000, DB_NAME: DB_NAME, list: list, build: build, _splitsFrom: splitsFrom, _summaryRun: summaryRun };
})(typeof window !== 'undefined' ? window : globalThis);
