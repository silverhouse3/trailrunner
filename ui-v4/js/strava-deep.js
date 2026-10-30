// ════════════════════════════════════════════════════════════════════════════
// StravaDeep — "deep import" of the athlete's last N Strava runs: summaries PLUS per-second streams
// (downsampled to <= 5 s), kept in a SEPARATE IndexedDB database 'trailrunner_hrtrain' (never the app's
// 'trailrunner' DB, never localStorage 'tr_runs') to train the HR-response model
// (docs/HR_LEARNING_CONTROLLER_DESIGN.md section 2.1).
//
//   StravaDeep.init()                 -> Promise<status>   open DB, load progress, auto-resume if it was running
//   StravaDeep.start() / pause() / cancel()
//   StravaDeep.onChange(fn(status))   status(): {state, message, total, loaded, skipped, pending, nextInS, reqToday, ...}
//   StravaDeep.getRecords()           -> Promise<[{id, summary, skip, t[], hr[], v[], g[], d[], alt[], cad[]}]>
//   StravaDeep.exportData()           -> Promise<object>   no tokens, no athlete, no names, no locations
//
// Budget / pacing (all requests go through StravaApi.request, so token refresh, the local 100/15 min + 1000/day
// read budget, cool-down after 429 and error mapping stay in ONE place):
//   * at most CFG.perWindow (80) requests per 15-minute Strava window from this feature (the rest is left for the
//     app's own Strava calls), and at most CFG.dayCap (250) per UTC day, persisted so a reload cannot reset them;
//   * when the window is used up it waits (1 s ticker, countdown in the status) and carries on by itself;
//   * progress is persisted after EVERY run (one IDB transaction: run record + state), so a reload / closing the
//     app resumes where it stopped and never re-fetches a stored run.
// Read-only: only GET /athlete/activities and GET /activities/{id}/streams.  Tokens / client secret are never
// read, logged or stored here.  ES5 + Promise only (WebView 83).  Does not touch the treadmill bridge.
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var DB_NAME = 'trailrunner_hrtrain', DB_VER = 1;
  var CFG = {
    want: 200,                 // newest runs to load
    listPerPage: 200,          // Strava max page size: 200 runs live in ~1-2 list calls
    maxListPages: 8,
    perWindow: 80,             // our share of the 100 reads / 15 min
    dayCap: 250,               // hard cap per UTC day for this feature
    stepSec: 5,                // stream resolution kept
    gapMs: 250,                // pause between requests
    keys: 'time,heartrate,velocity_smooth,grade_smooth,distance,altitude,cadence',
    scopeStop: 3,              // consecutive permission errors before stopping
    offlineStop: 6, offlineWaitMs: 20000,
    retries: 3,                // attempts per run for transient (5xx) errors
    retryBaseMs: 3000,         // backoff base for transient errors (list: x2 per failure)
    reqTimeoutMs: 30000,       // a request that has not answered by then counts as an 'offline' error
    busyExtraMs: 10000, busyGraceMs: 5000,   // busy watchdog = reqTimeoutMs + busyExtraMs; START resets a busy flag older than busyGraceMs
    leaseBeatMs: 5000, leaseTtlMs: 20000,    // cross-window lease: heartbeat every 5 s, expires after 20 s
    hungStop: 3                // abandoned (timed-out, never answered) sockets that stop the import: the browser only has ~6 per host
  };
  var KEEP = ['id', 'name', 'type', 'sport_type', 'start_date', 'start_date_local', 'distance', 'moving_time', 'elapsed_time',
    'total_elevation_gain', 'average_speed', 'max_speed', 'average_heartrate', 'max_heartrate', 'average_cadence',
    'average_watts', 'device_watts', 'trainer', 'manual', 'has_heartrate', 'workout_type', 'elev_high', 'elev_low'];

  function api() { return root.StravaApi; }
  function nowMs() { return Date.now(); }
  // monotonic clock for durations (busy age): a wall-clock step (NTP / WSL sync / user) must never make a stuck operation look young
  function monoMs() { try { return root.performance && root.performance.now ? root.performance.now() : Date.now(); } catch (e) { return Date.now(); } }
  function dayKey() { var d = new Date(nowMs()); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function mkErr(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function isRunAct(a) { var A = api(); return !!(A && A.isRun ? A.isRun(a) : (a.sport_type || a.type) === 'Run'); }

  function slim(a) {
    var o = {};
    for (var i = 0; i < KEEP.length; i++) { var k = KEEP[i]; if (a[k] !== undefined && a[k] !== null) o[k] = a[k]; }
    return o;
  }

  // ── IndexedDB (own database) ────────────────────────────────────────────────
  var _db = null;
  function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(mkErr('storage', 'This browser has no IndexedDB'));
      var r = root.indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      r.onsuccess = function (e) { _db = e.target.result; _db.onversionchange = function () { try { _db.close(); } catch (x) {} _db = null; }; resolve(_db); };
      r.onerror = function () { reject(mkErr('storage', 'Could not open the HR training database')); };
      r.onblocked = function () { reject(mkErr('storage', 'HR training database is blocked by another tab')); };
    });
  }
  function tx(stores, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(stores, mode), out;
        try { out = fn(t); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(mkErr('storage', 'Could not save to the HR training database')); };
        t.onabort = function () { reject(mkErr('storage', 'Not enough storage space for the HR training data')); };
      });
    });
  }
  function reqRes(rq) { return rq; }
  function dbGetMeta(k) { var rq; return tx(['meta'], 'readonly', function (t) { rq = t.objectStore('meta').get(k); return rq; }).then(function () { return rq.result === undefined ? null : rq.result; }); }
  function dbGetAll() { var rq; return tx(['runs'], 'readonly', function (t) { rq = t.objectStore('runs').getAll(); return rq; }).then(function () { return rq.result || []; }); }
  function dbGetRun(id) { var rq; return tx(['runs'], 'readonly', function (t) { rq = t.objectStore('runs').get(id); return rq; }).then(function () { return rq.result || null; }); }

  // ── streams: normalise + downsample ─────────────────────────────────────────
  function normalise(s) {
    var out = {}, i;
    if (Object.prototype.toString.call(s) === '[object Array]') { for (i = 0; i < s.length; i++) if (s[i] && s[i].data) out[s[i].type] = s[i].data; }
    else if (s && typeof s === 'object') { for (var k in s) if (s[k] && s[k].data) out[k] = s[k].data; }
    return out;
  }
  /**
   * Strava streams {time,heartrate,velocity_smooth,grade_smooth,distance,altitude,cadence} (1 Hz or coarser)
   * -> {t,hr,v,g,d,alt,cad} with one point per `step` seconds (mean; distance = last).  Absent / mismatched
   * streams become null.  Pure function (also used by tests).
   */
  function downsample(st, step) {
    step = step || CFG.stepSec;
    var time = st.time, n = time ? time.length : 0;
    var out = { t: [], hr: null, v: null, g: null, d: null, alt: null, cad: null };
    if (!n) return out;
    var map = { hr: 'heartrate', v: 'velocity_smooth', g: 'grade_smooth', d: 'distance', alt: 'altitude', cad: 'cadence' };
    var have = {}, name, any = {};
    for (name in map) { var a = st[map[name]]; if (a && a.length === n) have[name] = a; }
    var buckets = [], cur = null, i, b;
    for (i = 0; i < n; i++) {
      if (typeof time[i] !== 'number') continue;
      b = Math.floor(time[i] / step);
      if (!cur || cur.b !== b) {
        cur = { b: b, c: {}, s: {}, last: {} };
        buckets.push(cur);
      }
      for (name in have) {
        var x = have[name][i];
        if (typeof x === 'number' && isFinite(x)) { cur.s[name] = (cur.s[name] || 0) + x; cur.c[name] = (cur.c[name] || 0) + 1; cur.last[name] = x; }
      }
    }
    for (name in have) out[name] = [];
    for (i = 0; i < buckets.length; i++) {
      b = buckets[i];
      out.t.push(b.b * step);
      for (name in have) {
        var v = null;
        if (b.c[name]) {
          if (name === 'd') v = Math.round(b.last[name] * 10) / 10;
          else {
            var m = b.s[name] / b.c[name];
            v = name === 'hr' || name === 'cad' ? Math.round(m) : name === 'v' ? Math.round(m * 100) / 100 : Math.round(m * 10) / 10;
            if (name === 'hr' && v <= 0) v = null;
          }
        }
        out[name].push(v);
        if (v !== null) any[name] = true;
      }
    }
    for (name in have) if (!any[name]) out[name] = null;     // stream present but empty (e.g. HR strap dropped out entirely)
    return out;
  }

  // ── controller state ────────────────────────────────────────────────────────
  var S = null;                // persisted: {ids[], status{id:'p'|'f'|'s:code'}, attempts{}, listedAt, listDone, listEmpty, listRev, wantRun, day, dayCount, win{start,n}}
  // lease owner = per-tab sessionStorage id + a random nonce per PAGE LOAD.  A duplicated tab / window.open() copies sessionStorage, so the
  // tab id alone is NOT unique; the nonce is.  (A same-tab reload therefore waits for the pagehide release or the 20 s expiry.)
  var TAB = (function () {
    var k = 'tr_deep_owner', v = null;
    try { v = root.sessionStorage.getItem(k); } catch (e) {}
    if (!v) { v = 'o' + Math.random().toString(36).slice(2, 10) + nowMs().toString(36); try { root.sessionStorage.setItem(k, v); } catch (e) {} }
    return v;
  })();
  var OWNER = TAB + '-' + Math.random().toString(36).slice(2, 10) + Math.floor(Math.random() * 1e9).toString(36);
  var runtime = { state: 'idle', message: '', nextAt: 0, running: false, timer: null, busy: false, busySince: 0, gen: 0, err: null, offlineRun: 0, scopeRun: 0, listFail: 0,
    nonce: 0, hung: 0, prevTab: null, listeners: [], inited: false, leaseHeld: false, hbTimer: null, pollTimer: null, otherWindow: false, takeOver: false, starting: false };

  function blankState() {
    return { v: 2, ids: [], status: {}, attempts: {}, listedAt: 0, listDone: false, listEmpty: false, listRev: 0, wantRun: false, day: dayKey(), dayCount: 0, win: { start: 0, n: 0 } };
  }
  function noop() {}
  function rank(v) { return v === 'f' ? 3 : (v && v.charAt(0) === 's') ? 2 : v === 'p' ? 1 : 0; }

  /** Merge what ANOTHER writer stored into the local state (never lowers anything the other side learned):
   *  list-level fields follow the higher listRev; per-run status: terminal beats pending; counters: later key wins, same key -> max(). */
  function mergeInto(local, st) {
    if (!st || typeof st !== 'object') return;
    if ((st.listRev || 0) > (local.listRev || 0)) {
      local.ids = (st.ids || []).slice(); local.listDone = !!st.listDone; local.listedAt = st.listedAt || 0; local.listEmpty = !!st.listEmpty; local.listRev = st.listRev;
    }
    var ns = {}, na = {}, i, id, a, b, x;
    for (i = 0; i < local.ids.length; i++) {
      id = local.ids[i]; a = local.status[id]; b = st.status ? st.status[id] : undefined;
      ns[id] = rank(b) > rank(a) ? b : a;
      x = Math.max(local.attempts[id] || 0, (st.attempts && st.attempts[id]) || 0);
      if (x && ns[id] === 'p') na[id] = x;
    }
    local.status = ns; local.attempts = na;
    if (st.day) {
      if (st.day > local.day) { local.day = st.day; local.dayCount = st.dayCount || 0; }
      else if (st.day === local.day) local.dayCount = Math.max(local.dayCount || 0, st.dayCount || 0);
    }
    if (st.win && st.win.start) {
      if (st.win.start > local.win.start) local.win = { start: st.win.start, n: st.win.n || 0 };
      else if (st.win.start === local.win.start) local.win.n = Math.max(local.win.n || 0, st.win.n || 0);
    }
  }
  /** One IDB transaction: read the stored state, merge it into S (other writers' records are never overwritten), write S + optional run records. */
  function persist(puts) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(['runs', 'meta'], 'readwrite'), m = t.objectStore('meta'), g = m.get('state');
        g.onsuccess = function () {
          var pre = { d: S.day, dc: S.dayCount || 0, ws: S.win && S.win.start, wn: S.win ? S.win.n || 0 : 0 };
          mergeInto(S, g.result);
          // a stored day / window from the FUTURE (clock went backwards) is clock skew: re-key to now but never lower the counts
          var fx = fixSkew();
          if (fx.day && S.day === pre.d) S.dayCount = Math.max(S.dayCount || 0, pre.dc);
          if (fx.win && S.win.start === pre.ws) S.win.n = Math.max(S.win.n || 0, pre.wn);
          m.put(S, 'state');
          if (puts && puts.length) { var rs = t.objectStore('runs'); for (var k = 0; k < puts.length; k++) rs.put(puts[k]); }
        };
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { reject(mkErr('storage', 'Could not save to the HR training database')); };
        t.onabort = function () { reject(mkErr('storage', 'Not enough storage space for the HR training data')); };
      });
    });
  }
  function saveState() { return persist(); }
  function reloadFromDb() { return dbGetMeta('state').then(function (st) { mergeInto(S, st); }); }

  // clock moves: a stored key that is LATER than the current one (clock went backwards) keeps its count; reset only when the key is strictly greater
  function winNow() { var A = api(); return A && A._windowStart ? A._windowStart() : Math.floor(nowMs() / 900000) * 900000; }
  /** Clock skew: a stored day / window that is LATER than now (clock was moved forwards, then back) is re-keyed to now, counts kept (max), so the
   *  budget is still respected but the importer never waits days.  Returns which parts were re-keyed. */
  function fixSkew() {
    var fx = { day: false, win: false }, k = dayKey(), ws = winNow();
    if (S.day && S.day > k) { S.day = k; fx.day = true; }
    if (S.win && S.win.start > ws) { S.win = { start: ws, n: S.win.n || 0 }; fx.win = true; }
    return fx;
  }
  function rollDay() { fixSkew(); var k = dayKey(); if (!S.day || k > S.day) { S.day = k; S.dayCount = 0; } }
  function curWindow() {
    var ws = winNow(); fixSkew();
    if (!S.win || !(S.win.start >= ws)) S.win = { start: ws, n: 0 };
    return ws;
  }

  // ── lease: only ONE page runs the importer (IDB 'meta' row 'lease', heartbeat + expiry) ─
  // (navigator.locks is not used: it needs a secure context - the console serves plain http - and a hung page would keep it for ever.)
  function leaseTxn(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(['meta'], mode), m = t.objectStore('meta'), out = { ok: false, lease: null };
        var g = m.get('lease');
        g.onsuccess = function () { fn(m, g.result, out); };
        t.oncomplete = function () { resolve(out); };
        t.onerror = t.onabort = function () { reject(mkErr('storage', 'Could not check the import lease')); };
      });
    });
  }
  function leaseFree(l, now) { return !l || l.owner === OWNER || now - l.beat > CFG.leaseTtlMs || l.beat - now > CFG.leaseTtlMs; }
  function acquireLease() {
    return leaseTxn('readwrite', function (m, l, out) {
      var now = nowMs();
      if (leaseFree(l, now)) { m.put({ owner: OWNER, tab: TAB, beat: now, since: l && l.owner === OWNER ? l.since : now }, 'lease'); out.ok = true; } else out.lease = l;
    });
  }
  function peekLease() { return leaseTxn('readonly', function (m, l, out) { out.ok = leaseFree(l, nowMs()); out.lease = l; }); }
  function releaseLease() {
    stopHeartbeat();
    if (!runtime.leaseHeld) return Promise.resolve();
    runtime.leaseHeld = false;
    return leaseTxn('readwrite', function (m, l) { if (l && l.owner === OWNER) m['delete']('lease'); }).then(null, noop);
  }
  function stopHeartbeat() { clearInterval(runtime.hbTimer); runtime.hbTimer = null; }
  /** Atomic check-and-beat: ok when the lease row is ours (beat refreshed), missing, or its owner stopped beating (expired).  A lease another
   *  owner holds with a live heartbeat is NEVER taken: -> ok=false.  Used by the heartbeat AND before every counted request. */
  function leaseCheck() {
    return leaseTxn('readwrite', function (m, l, out) {
      var now = nowMs();
      if (leaseFree(l, now)) { m.put({ owner: OWNER, tab: TAB, beat: now, since: l && l.owner === OWNER ? l.since : now }, 'lease'); out.ok = true; } else out.lease = l;
    });
  }
  function startHeartbeat() {
    stopHeartbeat();
    runtime.hbTimer = setInterval(function () {
      leaseCheck().then(function (r) { if (!r.ok && runtime.leaseHeld) lostLease(); }, noop);
    }, CFG.leaseBeatMs);
  }
  function lostLease() {
    // another window owns the import now: stop WITHOUT writing anything (its records stay as they are)
    runtime.leaseHeld = false; stopHeartbeat();
    runtime.running = false; clearTimeout(runtime.timer); runtime.timer = null; runtime.gen++; runtime.busy = false;
    runtime.otherWindow = true; setState('other');
  }
  function pollOther() {
    if (!runtime.inited || runtime.leaseHeld || runtime.running || runtime.starting) return;
    Promise.all([peekLease(), dbGetMeta('state')]).then(function (r) {
      if (runtime.leaseHeld || runtime.running) return;
      mergeInto(S, r[1]);
      var was = runtime.otherWindow;
      runtime.otherWindow = !r[0].ok;
      if (runtime.otherWindow) { runtime.takeOver = false; runtime.state = 'other'; runtime.message = ''; runtime.prevTab = r[0].lease && r[0].lease.tab; }
      else {
        runtime.state = baseState(); runtime.message = '';
        // the holder was an earlier page load of THIS tab (a reload / back-forward): carry on by itself when an import was running
        var A = api();
        if (was && S.wantRun && runtime.prevTab === TAB && A && A.isConnected()) { runtime.otherWindow = false; emit(); StravaDeep.start(); return; }
        if (was) runtime.takeOver = true;
      }
      emit();
    }, noop);
  }
  function baseState() {
    if (!S.ids.length) return S.listDone && S.listEmpty ? 'done' : 'idle';
    return counts().pending === 0 ? 'done' : 'paused';
  }

  function counts() {
    var loaded = 0, skipped = 0, pending = 0, id;
    for (var i = 0; i < S.ids.length; i++) {
      id = S.ids[i]; var st = S.status[id];
      if (st === 'f') loaded++; else if (st && st.charAt(0) === 's') skipped++; else pending++;
    }
    return { total: S.ids.length, loaded: loaded, skipped: skipped, pending: pending };
  }
  function humanWait(s) {
    s = Math.max(0, Math.ceil(s));
    if (s <= 90) return s + ' s';
    var m = Math.ceil(s / 60);
    return m < 120 ? m + ' min' : Math.round(m / 60) + ' h';
  }
  var SKIPTXT = { notfound: 'not found on Strava', forbidden: 'private / no access', scope: 'permission missing', timeout: 'timed out' };
  function skipReasons(by) {
    var out = [];
    for (var k in by) out.push(by[k] + ' ' + (SKIPTXT[k] || (/^error/.test(k) ? 'Strava error ' + k.slice(5) : k)));
    return out.join(', ');
  }
  function status() {
    var c = S ? counts() : { total: 0, loaded: 0, skipped: 0, pending: 0 };
    var nextInS = runtime.state === 'waiting' ? Math.max(0, Math.ceil((runtime.nextAt - nowMs()) / 1000)) : 0;
    var skippedBy = {};
    if (S) for (var k in S.status) if (S.status[k].charAt(0) === 's') { var code = S.status[k].slice(2); skippedBy[code] = (skippedBy[code] || 0) + 1; }
    var msg = runtime.message, prog = 'Loaded ' + c.loaded + ' of ' + c.total + ' runs' + (c.skipped ? ' (' + c.skipped + ' skipped)' : '');
    if (!msg) {
      if (runtime.state === 'other') msg = 'Import is running in another window. ' + (c.total ? prog + '.' : 'Progress will show here.');
      else if (runtime.takeOver && runtime.state !== 'running' && runtime.state !== 'waiting') msg = 'The import in the other window has stopped. Press TAKE OVER to continue here. ' + (c.total ? prog + '.' : '');
      else if (runtime.state === 'waiting' && !c.total) msg = 'Strava needs a short break, trying again in ' + humanWait(nextInS) + '.';
      else if (runtime.state === 'waiting') msg = 'Loaded ' + c.loaded + ' of ' + c.total + ' runs, next batch in ' + humanWait(nextInS) + (c.skipped ? ' (' + c.skipped + ' skipped)' : '');
      else if (runtime.state === 'running') msg = 'Loading run ' + Math.min(c.total, c.loaded + c.skipped + 1) + ' of ' + c.total + '...';
      else if (runtime.state === 'done' && !c.total) msg = 'No runs found on Strava. Nothing to import. Press CHECK FOR NEW RUNS after your next run.';
      else if (runtime.state === 'done') msg = 'All done: ' + c.loaded + (c.loaded === 1 ? ' run' : ' runs') + ' loaded' + (c.skipped ? ', ' + c.skipped + ' skipped (' + skipReasons(skippedBy) + ')' : '') + '.';
      else if (c.total) msg = prog + '. ' + (runtime.state === 'paused' ? 'Paused.' : 'Press RESUME to continue.');
      else msg = 'Nothing loaded yet.';
    }
    var ws = winNow();
    return {
      state: runtime.state, message: msg, total: c.total, loaded: c.loaded, skipped: c.skipped, pending: c.pending, skippedBy: skippedBy,
      nextInS: nextInS, reqToday: S ? (S.day >= dayKey() ? S.dayCount : 0) : 0, dayCap: CFG.dayCap, windowUsed: S && S.win.start >= ws ? S.win.n : 0,   // pure: no rollDay() here
      perWindow: CFG.perWindow, listedAt: S ? S.listedAt : 0, otherWindow: runtime.otherWindow, takeOver: runtime.takeOver && !runtime.otherWindow
    };
  }
  function emit() { var st = status(); for (var i = 0; i < runtime.listeners.length; i++) { try { runtime.listeners[i](st); } catch (e) {} } }
  function setState(st, msg) { runtime.state = st; runtime.message = msg || ''; emit(); }

  // ── request accounting ──────────────────────────────────────────────────────
  function canRequest() {
    // -> 0 when a request may go now, else ms to wait. 'day' when the daily cap is hit.
    var A = api();
    rollDay(); curWindow();
    if (S.dayCount >= CFG.dayCap) return 'day';
    var wait = 0, now = nowMs();
    if (S.win.n >= CFG.perWindow) wait = Math.max(wait, S.win.start + 900000 - now);
    if (A._budgetOk && !A._budgetOk(true)) wait = Math.max(wait, (A._windowStart() + 900000) - now);
    if (A.cooldownSeconds && A.cooldownSeconds() > 0) wait = Math.max(wait, A.cooldownSeconds() * 1000);
    return wait > 0 ? Math.min(wait, 900000) + 1500 : 0;      // 1.5 s past the boundary so the new window is surely open; never longer than one window (clock skew)
  }
  function counted() { rollDay(); curWindow(); S.win.n++; S.dayCount++; runtime.phase = 'counted'; persist().then(null, noop); }
  /** One counted GET with a hard timeout: a request that never answers becomes an 'offline'-type error and a late answer is dropped. */
  /** Same stream keys, rotated by the abandon counter: the browser serialises identical URLs behind a hung one, a rotated list is a
   *  different URL (Strava returns the same key_by_type object whatever the order) so a retry really goes out. */
  function streamKeys() {
    var a = CFG.keys.split(','), r = runtime.nonce % a.length;
    return a.slice(r).concat(a.slice(0, r)).join(',');
  }
  function guardedRequest(path, query, gen) {
    // verify we STILL own the lease right before each counted request (a slow owner may have been taken over); stop if not
    return leaseCheck().then(function (r) {
      if (gen !== runtime.gen) throw mkErr('stale', 'stale');
      if (!r.ok) throw mkErr('lease', 'The import is running in another window');
      counted();
      var p = api().request(path, { query: query });
      return new Promise(function (resolve, reject) {
        var done = false, to = setTimeout(function () {
          if (done) return; done = true;
          runtime.nonce++; runtime.hung++;
          var e = mkErr('offline', 'Strava did not answer within ' + Math.round(CFG.reqTimeoutMs / 1000) + ' s'); e.timedOut = true; reject(e);
        }, CFG.reqTimeoutMs);
        // a late answer frees the abandoned socket again
        p.then(function (v) { if (done) { runtime.hung = Math.max(0, runtime.hung - 1); return; } done = true; clearTimeout(to); resolve(v); },
               function (e) { if (done) { runtime.hung = Math.max(0, runtime.hung - 1); return; } done = true; clearTimeout(to); reject(e); });
      });
    });
  }

  // ── error policy ────────────────────────────────────────────────────────────
  var MSG = {
    auth: 'Strava login expired - reconnect Strava in Settings, then come back to this page and start the import again. Nothing already loaded is lost.',
    scope: 'Strava permission missing - reconnect Strava and tick ALL the permission boxes (including your private activities), then come back to this page and start the import again.',
    hung: 'Connection problem: Strava is not answering and earlier requests are still stuck. Close this page and open it again, then continue the import. Nothing already loaded is lost.'
  };
  /** Returns 'skip:<code>' | 'retry' | 'wait' | 'stop' (and sets runtime.message for stop). */
  function classify(e) {
    var c = e && e.code, st = e && e.status;
    if (c === 'stale') return 'stale';
    if (c === 'lease') return 'lost';
    if (c === 'rate_limited') return 'wait';
    if (c === 'notfound' || st === 404) return 'skip:notfound';
    if (c === 'scope' && st === 403) return 'scope';
    if (c === 'auth' && st === 403) return 'skip:forbidden';
    if (st === 401 || c === 'auth' || c === 'scope') return 'stop401';
    if (c === 'offline') return 'offline';
    if (c === 'storage') return 'stopstorage';
    return 'retry';
  }

  // ── list phase ──────────────────────────────────────────────────────────────
  function listRuns(say, gen) {
    var found = [], seen = {};
    function page(n) {
      var w = canRequest();
      if (w) return Promise.reject(mkErr('rate_limited', 'wait'));
      say('Asking Strava for your runs (page ' + n + ')...');
      return guardedRequest('/athlete/activities', runtime.nonce % 2 ? { per_page: CFG.listPerPage, page: n } : { page: n, per_page: CFG.listPerPage }, gen).then(function (arr) {
        if (gen !== runtime.gen) throw mkErr('stale', 'stale');
        // anything but an array is NOT "no runs": treat as a transient list error (retry cap), never merge it as an empty list
        if (!Array.isArray(arr)) throw mkErr('badlist', 'Strava sent an unexpected answer for the run list');
        for (var i = 0; i < arr.length; i++) {
          var a = arr[i];
          if (!a || a.id == null || a.manual || !isRunAct(a) || seen[a.id]) continue;
          if (isNaN(Date.parse(a.start_date || a.start_date_local))) continue;
          seen[a.id] = 1; found.push(a);
        }
        if (found.length < CFG.want && arr.length >= CFG.listPerPage && n < CFG.maxListPages) return page(n + 1);
      });
    }
    return page(1).then(function () {
      found.sort(function (a, b) { return Date.parse(b.start_date || b.start_date_local) - Date.parse(a.start_date || a.start_date_local); });
      return found.slice(0, CFG.want);
    });
  }

  /** Merge a fresh list into the stored one: new ids -> pending, known ids untouched (dedupe).  An empty list is a valid, final answer. */
  function mergeList(acts) {
    var newOnes = [], i, a;
    return Promise.all(acts.map(function (x) { return dbGetRun(x.id); })).then(function (existing) {
      var puts = [];
      for (i = 0; i < acts.length; i++) {
        a = acts[i];
        if (existing[i]) {
          existing[i].summary = slim(a); puts.push(existing[i]);       // keep streams; refresh the summary only
          if (!S.status[a.id]) S.status[a.id] = existing[i].skip ? 's:' + existing[i].skip : existing[i].t ? 'f' : 'p';
        } else {
          puts.push({ id: a.id, summary: slim(a), skip: null, fetchedAt: 0, t: null });
          S.status[a.id] = 'p'; newOnes.push(a.id);
        }
      }
      // ordering = this list (newest first); ids no longer in the newest-N window stay stored but leave the queue
      S.ids = acts.map(function (x) { return x.id; });
      for (var id in S.status) if (S.ids.indexOf(+id) < 0 && S.ids.indexOf(id) < 0) delete S.status[id];
      S.listedAt = nowMs(); S.listDone = true; S.listEmpty = !acts.length; S.listRev = (S.listRev || 0) + 1;
      return persist(puts).then(function () { return newOnes.length; });
    });
  }

  // ── fetch one run ───────────────────────────────────────────────────────────
  function fetchOne(id, gen) {
    runtime.phase = 'dbGetRun1';
    return dbGetRun(id).then(function (have) {
      runtime.phase = 'afterGet1';
      if (have && have.t && !have.skip) { S.status[id] = 'f'; delete S.attempts[id]; return persist(); }   // already stored (e.g. by another window): never fetch twice
      runtime.phase = 'request';
      return guardedRequest('/activities/' + id + '/streams', { keys: streamKeys(), key_by_type: 'true' }, gen).then(function (raw) {
        if (gen !== runtime.gen) throw mkErr('stale', 'stale');
        var ds = downsample(normalise(raw), CFG.stepSec);
        return dbGetRun(id).then(function (rec) {
          if (gen !== runtime.gen) throw mkErr('stale', 'stale');
          rec = rec || { id: id, summary: {} };
          rec.skip = null; rec.fetchedAt = nowMs();
          rec.t = ds.t.length ? ds.t : []; rec.hr = ds.hr; rec.v = ds.v; rec.g = ds.g; rec.d = ds.d; rec.alt = ds.alt; rec.cad = ds.cad;
          if (!ds.t.length) rec.noStreams = true; else delete rec.noStreams;
          S.status[id] = 'f'; delete S.attempts[id];
          return persist([rec]);
        });
      });
    });
  }
  function markSkip(id, code) {
    return dbGetRun(id).then(function (rec) {
      rec = rec || { id: id, summary: {} };
      rec.skip = code; rec.t = null;
      S.status[id] = 's:' + code; delete S.attempts[id];
      return persist([rec]);
    });
  }

  // ── main loop ───────────────────────────────────────────────────────────────
  function schedule(ms) { clearTimeout(runtime.timer); runtime.timer = setTimeout(step, ms); }
  function stopWith(state, msg, keepWant) {
    runtime.running = false; clearTimeout(runtime.timer); runtime.timer = null;
    // issue save + release back to back (IDB runs the two transactions in this order, so a quick START cannot be undone by a late release)
    if (S && runtime.leaseHeld) { S.wantRun = !!keepWant; saveState().then(null, noop); }
    releaseLease();
    setState(state, msg);
  }
  function nextPending() {
    for (var i = 0; i < S.ids.length; i++) { var st = S.status[S.ids[i]]; if (st === 'p') return S.ids[i]; }
    return null;
  }
  function setBusy(on) { runtime.busy = on; runtime.busySince = on ? monoMs() : 0; }
  function resetBusy() { runtime.nonce++; runtime.gen++; runtime.busy = false; runtime.busySince = 0; }
  function goOther() { runtime.running = false; clearTimeout(runtime.timer); runtime.timer = null; runtime.otherWindow = true; runtime.takeOver = false; setState('other'); }

  function step() {
    if (!runtime.running) return;
    if (runtime.busy) {
      if (monoMs() - runtime.busySince > CFG.reqTimeoutMs + CFG.busyExtraMs) resetBusy();      // watchdog: a wedged operation can never block the loop for ever
      else return schedule(1000);
    }
    var A = api();
    if (!A || !A.isConnected()) return stopWith('stopped', 'Connect Strava in Settings first.', false);
    if (!runtime.leaseHeld) {                       // only ONE window runs the importer
      var g0 = runtime.gen; setBusy(true);
      return acquireLease().then(function (r) {
        if (g0 !== runtime.gen) return;
        setBusy(false);
        if (!r.ok) return goOther();
        runtime.leaseHeld = true; runtime.otherWindow = false; runtime.takeOver = false; startHeartbeat();
        return reloadFromDb().then(function () { if (runtime.running) schedule(0); });
      }, function (e) { if (g0 !== runtime.gen) return; setBusy(false); stopWith('stopped', (e && e.message) || 'Storage problem', false); });
    }
    var needList = !S.listDone;
    var id = needList ? null : nextPending();
    if (!needList && id == null) { S.wantRun = false; runtime.running = false; saveState().then(null, noop); releaseLease(); return setState('done', ''); }
    var w = canRequest();
    if (w === 'day') return stopWith('stopped', 'Daily limit for deep import reached (' + CFG.dayCap + ' requests). Open this page again tomorrow and it carries on by itself.', true);
    if (w > 0) {
      runtime.nextAt = nowMs() + w; runtime.message = '';
      setState('waiting');
      return schedule(1000);                       // ticker: countdown + re-check (also copes with a sleeping tab)
    }
    if (runtime.hung >= CFG.hungStop) return stopWith('stopped', MSG.hung, true);
    var gen = runtime.gen;
    setBusy(true); runtime.message = '';
    setState('running');
    var p = needList
      ? listRuns(function (m) { runtime.message = m; emit(); }, gen).then(function (acts) { runtime.message = acts.length ? 'Checking ' + acts.length + ' runs against what is already stored...' : ''; emit(); return mergeList(acts); })
      : fetchOne(id, gen).then(function () { runtime.offlineRun = 0; runtime.scopeRun = 0; });
    p.then(function () {
      if (gen !== runtime.gen) return;
      setBusy(false); runtime.message = ''; runtime.listFail = 0;
      if (needList && !S.ids.length) {             // a successful list that found nothing is final: no re-listing loop
        S.wantRun = false; runtime.running = false; saveState().then(null, noop); releaseLease();
        return setState('done', '');
      }
      emit(); if (runtime.running) schedule(CFG.gapMs);
    }, function (e) {
      if (gen !== runtime.gen) return;             // late result of an abandoned (timed-out / reset) operation
      setBusy(false); runtime.message = '';
      var k = classify(e);
      if (k === 'stale') return;
      if (k === 'lost') return runtime.leaseHeld || runtime.running ? lostLease() : emit();
      if (!runtime.running) { emit(); return; }
      if (k === 'wait') { S.win.n = Math.max(S.win.n, CFG.perWindow); saveState().then(null, noop); return schedule(200); }
      if (k === 'stop401') return stopWith('stopped', (e && e.code === 'scope') ? MSG.scope : MSG.auth, false);
      if (k === 'stopstorage') return stopWith('stopped', e.message || 'Out of storage space.', false);
      function offline() {
        if (++runtime.offlineRun >= CFG.offlineStop) return stopWith('stopped', 'No connection to Strava. Press RESUME when you are online.', false);
        runtime.nextAt = nowMs() + CFG.offlineWaitMs; setState('waiting', 'No connection to Strava, trying again in ' + Math.round(CFG.offlineWaitMs / 1000) + ' s...'); return schedule(CFG.offlineWaitMs);
      }
      if (needList) {                       // list failures: transient -> backoff with the normal retry cap, offline -> offline cap
        if (k === 'offline') return offline();
        if (++runtime.listFail >= CFG.retries) return stopWith('stopped', 'Could not read your run list from Strava (' + ((e && e.message) || 'error') + '). Press RESUME to try again.', false);
        return schedule(CFG.retryBaseMs * Math.pow(2, runtime.listFail - 1));
      }
      if (k === 'offline') {
        S.attempts[id] = (S.attempts[id] || 0) + 1;                  // a run that keeps timing out is skipped after the normal retry cap
        if (e.timedOut && S.attempts[id] >= CFG.retries && runtime.hung >= CFG.hungStop) {
          // a network stall (abandoned sockets), NOT a property of this run: it stays PENDING so the next START retries it; stop with the clear message
          delete S.attempts[id];
          return saveState().then(null, noop).then(function () { stopWith('stopped', MSG.hung, true); });
        }
        if (e.timedOut && S.attempts[id] >= CFG.retries) { if (++runtime.offlineRun >= CFG.offlineStop) { return markSkip(id, 'timeout').then(function () { stopWith('stopped', 'No connection to Strava. Press RESUME when you are online.', false); }); } return markSkip(id, 'timeout').then(function () { emit(); schedule(CFG.gapMs); }); }
        saveState().then(null, noop);
        return offline();
      }
      if (k === 'scope') {
        if (++runtime.scopeRun >= CFG.scopeStop) return stopWith('stopped', MSG.scope, false);
        return markSkip(id, 'scope').then(function () { emit(); schedule(CFG.gapMs); });
      }
      if (k.indexOf('skip:') === 0) { runtime.scopeRun = 0; return markSkip(id, k.slice(5)).then(function () { emit(); schedule(CFG.gapMs); }); }
      // transient error: keep pending for a few attempts, then skip
      S.attempts[id] = (S.attempts[id] || 0) + 1;
      if (S.attempts[id] >= CFG.retries) return markSkip(id, 'error' + ((e && e.status) || '')).then(function () { emit(); schedule(CFG.gapMs); });
      saveState().then(null, noop);
      return schedule(CFG.retryBaseMs);
    }).then(null, function (e2) { if (gen !== runtime.gen) return; setBusy(false); stopWith('stopped', (e2 && e2.message) || 'Unexpected error', false); });
  }

  var StravaDeep = {
    CFG: CFG, downsample: downsample, normalise: normalise, DB_NAME: DB_NAME, OWNER: OWNER,

    /** Open DB, load progress, and auto-resume when the last session was running (unless another window owns the import). */
    init: function () {
      return openDb().then(function () { return Promise.all([dbGetMeta('state'), peekLease()]); }).then(function (r) {
        var st = r[0];
        S = st || blankState();
        if (!S.status) S.status = {}; if (!S.attempts) S.attempts = {}; if (!S.win) S.win = { start: 0, n: 0 };
        if (S.listRev == null) S.listRev = 0;
        rollDay();
        runtime.inited = true;
        runtime.state = baseState();
        runtime.message = '';
        var A = api();
        if (!r[1].ok) { runtime.otherWindow = true; runtime.state = 'other'; runtime.prevTab = r[1].lease && r[1].lease.tab; if (S.wantRun && runtime.prevTab === TAB) setTimeout(pollOther, 1500); }
        else if (S.wantRun && A && A.isConnected()) { runtime.running = true; runtime.state = 'running'; schedule(50); }
        clearInterval(runtime.pollTimer); runtime.pollTimer = setInterval(pollOther, CFG.leaseBeatMs);
        try {
          root.addEventListener('pagehide', function () { if (runtime.leaseHeld) { runtime.running = false; releaseLease(); } });
          // back/forward cache: the page comes back with its old state but without the lease -> take it again when an import was wanted
          root.addEventListener('pageshow', function (ev) {
            if (ev && ev.persisted && S && S.wantRun && !runtime.running && !runtime.leaseHeld && !runtime.starting) StravaDeep.start();
          });
        } catch (x) {}
        emit();
        return status();
      }, function (e) { runtime.state = 'stopped'; runtime.message = e.message; throw e; });
    },
    status: status,
    onChange: function (fn) { runtime.listeners.push(fn); },
    /** Start / resume / take over.  Re-lists first when nothing is queued or the list is older than 6 h (dedupe: stored runs are never re-fetched). */
    start: function () {
      if (!runtime.inited) return Promise.reject(mkErr('storage', 'not initialised'));
      var A = api();
      if (!A || !A.isConnected()) { setState('stopped', 'Connect Strava in Settings first.'); return Promise.resolve(status()); }
      if (runtime.running || runtime.starting) return Promise.resolve(status());
      // a previous request that never finished must not block START (PAUSE then START always recovers)
      if (runtime.busy && monoMs() - runtime.busySince > CFG.busyGraceMs) resetBusy();
      runtime.starting = true;
      return acquireLease().then(function (r) {
        if (!r.ok) { runtime.starting = false; runtime.otherWindow = true; runtime.takeOver = false; setState('other'); return status(); }
        runtime.leaseHeld = true; runtime.otherWindow = false; runtime.takeOver = false; startHeartbeat();
        return reloadFromDb().then(function () {
          if (!S.listDone || (counts().pending === 0) || nowMs() - S.listedAt > 6 * 3600 * 1000) S.listDone = false;
          S.wantRun = true; runtime.running = true; runtime.offlineRun = 0; runtime.scopeRun = 0; runtime.listFail = 0;
          return saveState();
        }).then(function () { runtime.starting = false; setState('running'); schedule(10); return status(); });
      }).then(null, function (e) { runtime.starting = false; setState('stopped', (e && e.message) || 'Could not start'); return status(); });
    },
    pause: function () { if (!runtime.running) return Promise.resolve(status()); stopWith('paused', '', false); return Promise.resolve(status()); },
    /** Stop and forget the unfinished queue (stored runs stay). */
    cancel: function () {
      if (runtime.otherWindow) { setState('other'); return Promise.resolve(status()); }
      runtime.running = false; clearTimeout(runtime.timer);
      if (!S) return Promise.resolve(status());
      var keep = [];
      S.ids.forEach(function (id) { if (S.status[id] !== 'p') keep.push(id); else delete S.status[id]; });
      S.ids = keep; S.wantRun = false; S.listDone = false; S.listRev = (S.listRev || 0) + 1;
      var sv = saveState(); releaseLease();
      return sv.then(function () { setState(keep.length ? 'paused' : 'idle', keep.length ? '' : 'Cancelled. Nothing loaded yet.'); return status(); });
    },
    /** Delete everything stored by the deep import (not the app's own data). */
    wipe: function () {
      if (runtime.otherWindow) { setState('other'); return Promise.resolve(status()); }
      runtime.running = false; clearTimeout(runtime.timer); stopHeartbeat(); runtime.leaseHeld = false; resetBusy();
      return tx(['runs', 'meta'], 'readwrite', function (t) { t.objectStore('runs').clear(); t.objectStore('meta').clear(); }).then(function () {
        S = blankState(); runtime.otherWindow = false; runtime.takeOver = false; setState('idle', 'Cleared.'); return status();
      });
    },
    getRecords: function () {
      return dbGetAll().then(function (all) {
        all.sort(function (a, b) { return Date.parse((b.summary && (b.summary.start_date)) || 0) - Date.parse((a.summary && a.summary.start_date) || 0); });
        return all;
      });
    },
    /** Export without tokens, athlete identity, run names or locations. */
    exportData: function () {
      return dbGetAll().then(function (all) {
        var runs = [], skipped = [];
        all.forEach(function (r) {
          var s = r.summary || {}, o = {};
          KEEP.forEach(function (k) { if (k !== 'name' && s[k] !== undefined) o[k] = s[k]; });
          if (r.skip) { skipped.push({ id: r.id, reason: r.skip }); return; }
          if (!r.t) return;
          o.streams = { t: r.t, hr: r.hr, v: r.v, g: r.g, d: r.d, alt: r.alt, cad: r.cad };
          runs.push(o);
        });
        runs.sort(function (a, b) { return Date.parse(b.start_date || 0) - Date.parse(a.start_date || 0); });
        return {
          format: 'trailrunner-hr-deep', version: 1, exportedAt: new Date(nowMs()).toISOString(), source: 'strava',
          units: { t: 's from start', hr: 'bpm', v: 'm/s', g: 'percent', d: 'm', alt: 'm', cad: 'strava cadence (one foot, steps/min)', distance: 'm', moving_time: 's' },
          resolutionSec: CFG.stepSec, runCount: runs.length, runs: runs, skipped: skipped
        };
      });
    },
    _mergeInto: mergeInto, _rt: function () { return { running: runtime.running, busy: runtime.busy, busyFor: runtime.busySince ? monoMs() - runtime.busySince : 0, gen: runtime.gen, nonce: runtime.nonce, lease: runtime.leaseHeld, starting: runtime.starting, other: runtime.otherWindow, timer: !!runtime.timer, phase: runtime.phase }; },
    _debugState: function () { return JSON.parse(JSON.stringify(S)); }
  };

  root.StravaDeep = StravaDeep;
  if (typeof module !== 'undefined' && module.exports) module.exports = StravaDeep;
})(typeof window !== 'undefined' ? window : globalThis);
