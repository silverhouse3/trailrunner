// ════════════════════════════════════════════════════════════════════════════
// StravaImport — fill the stats page from the athlete's Strava run history.
//
//   StravaImport.run({days:90, cap:200, onProgress:fn}) -> Promise<{found, imported, skipped, truncated}>
//   StravaImport.fetchDetail(runId)  -> Promise<run>   (ONE activity, on demand: splits + calories)
//   StravaImport.isImported(run)
//
// Budget: uses the LIST endpoint only (GET /athlete/activities, 100 per page, `after` = cutoff), at most
// MAX_PAGES calls per import, all through StravaApi.request (which enforces the 100/15 min + 1000/day read
// budget, refreshes the token once on 401 and maps errors).  NO streams are ever fetched here.
//
// Atomic: every page is fetched first; tr_runs is written ONCE at the end (one setItem).  Any error before
// that leaves local storage untouched.  Imported runs are stored in the same shape stats.html reads
// (savedAt/startedAt/distanceKm/distanceM/elapsed/avgSpeed/maxSpeed/avgHR/maxHR/elevGained/calories/routeName),
// canonical metric (km, m, km/h, seconds) like every other run, plus source:'strava', stravaId, imported:true and
// synced.strava (so SEND TO STRAVA is never offered).  They carry no trackPoints, no routeId and no splits, so
// they can't be used as Run Again / ghost / route-comparison sources.
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var KEY = 'tr_runs';
  var CFG = {
    days: 90, cap: 200, perPage: 100, maxPages: 6,
    dupStartS: 120,        // same start within 2 min ...
    dupDistFrac: 0.05,     // ... and distance within 5 %
    maxImportedKept: 300   // total imported runs kept in localStorage (see Store.saveRun)
  };

  function api() { return root.StravaApi; }
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function readRuns() { try { var r = JSON.parse(lsGet(KEY) || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
  function num(v) { v = +v; return isFinite(v) ? v : 0; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function isRun(a) { var A = api(); return !!(A && A.isRun ? A.isRun(a) : (a.sport_type || a.type) === 'Run'); }

  function uploadedMap() {
    try { if (root.StravaRacers && root.StravaRacers.uploadedMap) return root.StravaRacers.uploadedMap() || {}; } catch (e) {}
    try { return JSON.parse(lsGet('tr_strava_uploaded') || '{}') || {}; } catch (e2) { return {}; }
  }

  /** Strava list-summary activity -> run record in the stats.html shape. */
  function activityToRun(a) {
    var startMs = Date.parse(a.start_date || a.start_date_local);
    var moving = Math.round(num(a.moving_time) || num(a.elapsed_time));
    var distM = Math.round(num(a.distance));
    var km = distM / 1000;
    var finishMs = startMs + moving * 1000;
    var avgKph = a.average_speed ? num(a.average_speed) * 3.6 : (moving > 0 ? km / (moving / 3600) : 0);
    var run = {
      id: 'sv_' + a.id,
      source: 'strava', imported: true, stravaId: String(a.id),
      synced: { strava: { activityId: String(a.id), syncedAt: new Date().toISOString(), imported: true } },
      routeId: null,
      routeName: a.name || 'Strava run',
      startedAt: new Date(startMs).toISOString(),
      finishedAt: new Date(finishMs).toISOString(),
      savedAt: new Date(finishMs).toISOString(),
      distanceM: distM,
      distanceKm: Math.round(km * 1000) / 1000,
      elapsed: moving,
      elapsedSec: moving,
      avgSpeed: r1(avgKph),
      maxSpeed: a.max_speed ? r1(num(a.max_speed) * 3.6) : 0,
      avgHR: a.average_heartrate ? Math.round(num(a.average_heartrate)) : 0,
      maxHR: a.max_heartrate ? Math.round(num(a.max_heartrate)) : 0,
      elevGained: Math.round(num(a.total_elevation_gain)),
      calories: a.calories ? Math.round(num(a.calories)) : 0,
      stravaType: a.sport_type || a.type || 'Run',
      trainer: !!a.trainer
    };
    if (a.elapsed_time) run.elapsedTotalSec = Math.round(num(a.elapsed_time));
    return run;
  }

  /** run record's start time (ms): startedAt, else savedAt - elapsed. */
  function runStartMs(r) {
    var s = Date.parse(r.startedAt);
    if (!isNaN(s)) return s;
    var f = Date.parse(r.savedAt || r.date);
    return isNaN(f) ? NaN : f - 1000 * (r.elapsed || r.elapsedSec || 0);
  }

  /** Is this Strava activity already here (imported before, uploaded by TrailRunner, or the same effort recorded locally)? */
  function isDuplicate(a, runs, up) {
    var id = String(a.id), st = Date.parse(a.start_date || a.start_date_local), dist = num(a.distance), rid, i;
    for (rid in up) if (String(up[rid]) === id) return true;
    for (i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (!r) continue;
      if (r.stravaId != null && String(r.stravaId) === id) return true;
      if (r.synced && r.synced.strava && r.synced.strava.activityId != null && String(r.synced.strava.activityId) === id) return true;
      var rs = runStartMs(r);
      if (isNaN(rs) || isNaN(st)) continue;
      if (Math.abs(rs - st) / 1000 > CFG.dupStartS) continue;
      var rd = num(r.distanceM) || num(r.distanceKm) * 1000;
      if (!dist || !rd || Math.abs(dist - rd) / rd <= CFG.dupDistFrac) return true;
    }
    return false;
  }

  function friendly(e) {
    var c = e && e.code;
    if (c === 'rate_limited') return (e.message || 'Strava is busy') + '. Nothing was imported - try again later.';
    if (c === 'auth') return 'Strava login expired - reconnect Strava in Settings. Nothing was imported.';
    if (c === 'scope') return 'Strava permission missing - reconnect Strava in Settings and tick all boxes. Nothing was imported.';
    if (c === 'offline') return 'No connection to Strava. Nothing was imported.';
    if (c === 'storage') return e.message;
    return 'Strava import failed (' + ((e && e.message) || 'unknown error') + '). Nothing was imported.';
  }
  function mkErr(code, msg) { var e = new Error(msg); e.code = code; e.isStravaError = true; return e; }

  var StravaImport = {
    CFG: CFG,
    activityToRun: activityToRun,
    isDuplicate: isDuplicate,
    friendly: friendly,
    isImported: function (r) { return !!(r && (r.imported || r.source === 'strava')); },
    busy: false,

    /**
     * opts: {days, cap, onProgress(msg)}.  Resolves {found, imported, skipped, truncated}; rejects with an Error whose
     * .userMessage is ready to show.  Local storage is only touched on success.
     */
    run: function (opts) {
      opts = opts || {};
      var A = api(), self = this;
      var days = opts.days > 0 ? opts.days : CFG.days, cap = opts.cap > 0 ? Math.min(opts.cap, CFG.cap) : CFG.cap;
      var say = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
      function fail(e) { e.userMessage = friendly(e); self.busy = false; throw e; }
      if (!A || !A.isConnected()) { var ne = mkErr('auth', 'Not connected to Strava'); ne.userMessage = 'Connect Strava in Settings first.'; return Promise.reject(ne); }
      if (this.busy) { var be = mkErr('busy', 'Import already running'); be.userMessage = 'An import is already running.'; return Promise.reject(be); }
      this.busy = true;

      var after = Math.floor(Date.now() / 1000) - days * 86400;
      var found = [], pages = 0, pageLimit = false;
      function page(n) {
        say('Asking Strava for your runs (page ' + n + ')...');
        return A.request('/athlete/activities', { query: { after: after, page: n, per_page: CFG.perPage } }).then(function (arr) {
          pages++;
          arr = Array.isArray(arr) ? arr : [];
          for (var i = 0; i < arr.length; i++) if (isRun(arr[i]) && arr[i].id != null && !isNaN(Date.parse(arr[i].start_date || arr[i].start_date_local))) found.push(arr[i]);   // rows without a valid start are skipped
          if (arr.length >= CFG.perPage && n >= CFG.maxPages) pageLimit = true;
          say('Read ' + found.length + ' runs from Strava...');
          if (arr.length >= CFG.perPage && n < CFG.maxPages) return page(n + 1);
        });
      }
      return page(1).then(function () {
        // newest first; drop repeats of the same id; cap
        found.sort(function (a, b) { return Date.parse(b.start_date || b.start_date_local) - Date.parse(a.start_date || a.start_date_local); });
        var seen = {}, uniq = [];
        found.forEach(function (a) { if (!seen[a.id]) { seen[a.id] = 1; uniq.push(a); } });
        var truncated = uniq.length > cap || pageLimit;
        uniq = uniq.slice(0, cap);

        say('Checking ' + uniq.length + ' runs against your history...');
        var runs = readRuns(), up = uploadedMap(), fresh = [], skipped = 0;
        uniq.forEach(function (a) {
          if (isDuplicate(a, runs.concat(fresh), up)) skipped++;
          else fresh.push(activityToRun(a));
        });
        if (fresh.length) {
          // re-read right before the single write (another tab may have saved a run meanwhile)
          var cur = readRuns(), merged = cur.concat(fresh);
          merged.sort(function (a, b) { return Date.parse(b.savedAt || b.date) - Date.parse(a.savedAt || a.date); });
          // keep our own runs and the newest imported ones
          var keptImp = 0;
          merged = merged.filter(function (r) { if (!r.imported) return true; return ++keptImp <= CFG.maxImportedKept; });
          try { root.localStorage.setItem(KEY, JSON.stringify(merged)); }
          catch (e) { var se = mkErr('storage', 'Not enough storage space to save the imported runs. Nothing was imported.'); throw se; }
        }
        self.busy = false;
        return { found: uniq.length, imported: fresh.length, skipped: skipped, truncated: truncated, pages: pages };
      }).then(null, fail);
    },

    /** Summary line for the UI. */
    summary: function (res) {
      if (!res.found) return 'No Strava runs found in the last ' + CFG.days + ' days.';
      return 'Imported ' + res.imported + ' run' + (res.imported === 1 ? '' : 's') + ', skipped ' + res.skipped + ' already here' +
        (res.truncated ? ' (newest ' + Math.min(CFG.cap, res.found) + ' only; run it again later for older ones)' : '') + '.';
    },

    /**
     * On demand, ONE activity: GET /activities/:id -> km splits + calories saved into that stored run.
     * Resolves the updated run.
     */
    fetchDetail: function (runId) {
      var A = api(), runs = readRuns(), idx = -1, i;
      for (i = 0; i < runs.length; i++) if (String(runs[i].id) === String(runId)) { idx = i; break; }
      if (idx < 0 || !runs[idx].stravaId) { var e0 = mkErr('notfound', 'Run not found'); e0.userMessage = 'Run not found.'; return Promise.reject(e0); }
      if (!A || !A.isConnected()) { var e1 = mkErr('auth', 'Not connected'); e1.userMessage = 'Connect Strava in Settings first.'; return Promise.reject(e1); }
      return A.request('/activities/' + runs[idx].stravaId).then(function (d) {
        var fresh = readRuns(), j = -1;
        for (i = 0; i < fresh.length; i++) if (String(fresh[i].id) === String(runId)) { j = i; break; }
        if (j < 0) return null;
        var r = fresh[j];
        if (d.calories) r.calories = Math.round(num(d.calories));
        if (d.max_heartrate && !r.maxHR) r.maxHR = Math.round(num(d.max_heartrate));
        var sm = d.splits_metric;
        if (sm && sm.length) {
          var el = 0;
          r.splits = [];
          sm.forEach(function (s, k) {
            var full = num(s.distance) >= 950, t = Math.round(num(s.moving_time) || num(s.elapsed_time));
            el += t;
            if (full) r.splits.push({ km: s.split || (k + 1), timeSec: t, paceSecPerKm: t, avgHR: s.average_heartrate ? Math.round(num(s.average_heartrate)) : 0, elapsed: el });
            else if (num(s.distance) > 50) r.finalSplit = { km: (s.split || (k + 1)), distKm: Math.round(num(s.distance)) / 1000, timeSec: t, paceSecPerKm: Math.round(t / (num(s.distance) / 1000)), avgHR: s.average_heartrate ? Math.round(num(s.average_heartrate)) : 0, partial: true };
          });
        }
        r.detailFetchedAt = new Date().toISOString();
        try { root.localStorage.setItem(KEY, JSON.stringify(fresh)); } catch (e) { throw mkErr('storage', 'Not enough storage space'); }
        return r;
      }).then(null, function (e) { e.userMessage = friendly(e).replace(' Nothing was imported.', ''); throw e; });
    }
  };

  root.StravaImport = StravaImport;
  if (typeof module !== 'undefined' && module.exports) module.exports = StravaImport;
})(typeof window !== 'undefined' ? window : globalThis);
