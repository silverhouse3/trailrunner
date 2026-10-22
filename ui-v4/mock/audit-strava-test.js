#!/usr/bin/env node
// Headless test (plain Node >= 18, built-ins only) for the Strava integration against mock/strava-mock.js.
//   node mock/strava-test.js | tee docs/strava-test-output.txt
// Loads the REAL storage.js and engine.js (for Store/Engine behaviour) and the new strava-*.js files.
// Covers: auth/refresh/401/429/offline-cache, list -> pick -> streams -> conversion (grade clamps via the
// engine's own _calcGrade, ghost monotonic), bridge-limit re-bake, upload -> status polling, queue/retry,
// multi-racer pool (matching accept/reject, fastest/slowest/average, 0/1/2/tie, gaps signs, dedupe).
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var results = [], failed = 0;
function ok(cond, name, detail) {
  results.push(cond); if (!cond) failed++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
function info(s) { console.log('      ' + s); }
function head(s) { console.log('\n== ' + s); }
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// ── environment shims ───────────────────────────────────────────────────────
function mkStorage() {
  var d = {};
  return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); },
    removeItem: function (k) { delete d[k]; }, key: function (i) { return Object.keys(d)[i] || null; }, get length() { return Object.keys(d).length; }, _d: d };
}
globalThis.localStorage = mkStorage(); globalThis.sessionStorage = mkStorage();
globalThis.location = { search: '?strava=localhost:8196', href: 'http://localhost:8199/?strava=localhost:8196' };
var tmCalls = [];
globalThis.TM = {
  connected: true, _info: { ok: true, min_incline_pct: -6, max_incline_pct: 40 },
  getConsoleInfo: function (cb) { cb(globalThis.TM._info); },
  // any of these being called by Strava code would be a safety bug
  setSpeed: function () { tmCalls.push('setSpeed'); }, setIncline: function () { tmCalls.push('setIncline'); },
  startWorkout: function () { tmCalls.push('startWorkout'); }, stopWorkout: function () { tmCalls.push('stopWorkout'); }
};
vm.runInThisContext(fs.readFileSync(path.join(UI, 'js/storage.js'), 'utf8'), { filename: 'storage.js' });
globalThis.Store = vm.runInThisContext('Store');
vm.runInThisContext(fs.readFileSync(path.join(UI, 'js/engine.js'), 'utf8'), { filename: 'engine.js' });
globalThis.Engine = vm.runInThisContext('Engine');

var A = require(path.join(UI, 'js/strava-api.js'));
var R = require(path.join(UI, 'js/strava-routes.js'));
var RC = require(path.join(UI, 'js/strava-racers.js'));
var U = require(path.join(UI, 'js/strava-upload.js'));
var mock = require('./strava-mock.js');

function mockCtl(p, body) {
  return fetch('http://localhost:8196' + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); });
}
function stat(key) { return mockCtl('/mock/stats').then(function (s) { return s[key] || 0; }); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function engineGrades(route) {
  Engine.loadRoute(route);
  var g = [];
  for (var i = 0; i < route.resampled.length; i++) g.push(Engine._calcGrade(i));
  return g;
}
function mkRun(id, startedAt, totalS, route, frac) {
  var D = route.totalDistM * (frac || 1), tp = [], e, t0 = Date.parse(startedAt);
  for (e = 0; e <= totalS * (frac || 1) + 0.1; e += 5) {
    var x = e / (totalS * (frac || 1));
    tp.push({ time: new Date(t0 + e * 1000).toISOString(), dist: Math.round(D * (x + 0.03 * Math.sin(2 * Math.PI * x) / (2 * Math.PI))), speed: 8.6, hr: 130 + Math.round(30 * x), ele: 300, elapsed: e });
  }
  var el = Math.round(totalS * (frac || 1));
  return { id: id, routeId: route.id, routeName: route.name, startedAt: startedAt, finishedAt: new Date(t0 + el * 1000).toISOString(), elapsed: el, distanceM: Math.round(D),
    avgHR: 148, maxHR: 171, calories: 900, elevGained: 410, avgSpeed: 8.6, trackPoints: tp };
}

var prepared, storedRoute, items, base;

(async function main() {
  var srv = await mock.start(8196);
  console.log('TrailRunner Strava integration test  -  ' + new Date().toISOString());
  console.log('Mock Strava on :8196 (override via ?strava=localhost:8196), node ' + process.version);

  // ────────────────────────────────────────────────────────────────────────
  head('0. mock data sanity');
  var inf = await mockCtl('/mock/info');
  var hilly = inf.activities.filter(function (a) { return a.id === 9000000001; })[0];
  ok(inf.activities.length >= 8, 'mock has >= 8 activities', inf.activities.length);
  ok(hilly.gain >= 600, 'hilly trail run has 600 m+ gain', hilly.gain + ' m over ' + Math.round(hilly.distance) + ' m');
  info('decoy loop ' + inf.decoyLoopM + ' m vs base ' + inf.baseLoopM + ' m (' + ((inf.decoyLoopM / inf.baseLoopM - 1) * 100).toFixed(1) + '%): same start, passes the 5% distance test, diverges mid-course');

  // ────────────────────────────────────────────────────────────────────────
  head('1. host override safety');
  ok(A.isMock() && A.base() === 'http://localhost:8196', '?strava=localhost:8196 points the client at the mock');
  var A2 = Object.create(A); A2._override = undefined; globalThis.location = { search: '?strava=evil.example.com' }; globalThis.sessionStorage = mkStorage();
  ok(A2.base() === 'https://www.strava.com', 'public host in ?strava= is ignored (cannot redirect tokens)');
  globalThis.location = { search: '?strava=localhost:8196' }; globalThis.sessionStorage = mkStorage();

  // ────────────────────────────────────────────────────────────────────────
  head('2. auth: code exchange, scope, expiry refresh, 401 retry');
  localStorage.setItem('tr_strava_app', JSON.stringify({ clientId: '12345' }));
  ok(/scope=read%2Cread_all%2Cactivity%3Aread_all%2Cactivity%3Awrite/.test(A.authorizeUrl()), 'authorize URL requests read, read_all, activity:read_all, activity:write');
  var tk = await A.exchangeCode('mockcode');
  ok(tk.access_token && tk.athlete.id === 4242 && /activity:write/.test(tk.scope), 'authorization_code exchange stores tokens + scope', tk.athlete.firstname);
  ok(!/client_secret/.test(JSON.stringify(localStorage._d)), 'no client_secret stored by this flow');
  await mockCtl('/mock/expire');
  var n0 = await stat('POST /oauth/token');
  var l0 = await A.listRoutes({ force: true });
  var n1 = await stat('POST /oauth/token');
  ok(n1 === n0 + 1 && l0.items.length >= 1, 'expired access token -> automatic refresh, request succeeds', 'refreshes: ' + (n1 - n0));
  var rt0 = A.tokens().refresh_token;
  await mockCtl('/mock/fault', { kind: '401', count: 1 });
  var l1 = await A.listRoutes({ force: true });
  var n2 = await stat('POST /oauth/token');
  ok(l1.items.length >= 1 && n2 === n1 + 1 && A.tokens().refresh_token !== rt0, 'server 401 -> one refresh + one retry, refresh token rotated');

  // ────────────────────────────────────────────────────────────────────────
  head('3. recent runs list (type filter, cache, offline, 429)');
  var lst = await A.listRecentRuns({ force: true, want: 30 });
  items = lst.items;
  var types = {}; items.forEach(function (i) { types[i.sport_type] = 1; });
  ok(!types.Ride && !types.Walk && (types.Run || types.TrailRun), 'only Run/TrailRun listed (Ride/Walk filtered)', Object.keys(types).join(','));
  ok(items.length === 12, 'all 12 runs of the 14 activities listed', items.length);
  ok(items[0].start_date >= items[1].start_date, 'newest first');
  ok(items.every(function (i) { return i.polyline !== undefined; }) && items[0].polyline.length > 100, 'summary_polyline kept for thumbnails');
  var pts = A.decodePolyline(items[0].polyline);
  ok(pts.length > 50 && near(pts[0][0], 51.93, 0.05), 'polyline decodes', pts.length + ' pts, start ' + pts[0].join(','));
  var cacheHit = await A.listRecentRuns({});
  ok(cacheHit.fromCache === true, 'second call within 2 min served from cache (0 requests)');
  // offline
  var realOverride = A._override; A._override = 'localhost:1';
  var off = await A.listRecentRuns({ force: true, want: 30 });
  ok(off.stale === true && off.items.length === 12 && off.error && off.error.code === 'offline', 'network down -> cached list shown, flagged stale', 'error=' + off.error.code);
  A._override = realOverride;
  // 429
  await mockCtl('/mock/fault', { kind: '429', count: 1 });
  var rl = await A.listRecentRuns({ force: true, want: 30 });
  ok(rl.stale === true && rl.error.code === 'rate_limited', '429 -> cached list shown, error code rate_limited', rl.error.message);
  var before = await stat('GET /api/v3/athlete');
  var rej = await A.request('/athlete').then(function () { return null; }, function (e) { return e; });
  var after = await stat('GET /api/v3/athlete');
  ok(rej && rej.code === 'rate_limited' && A.cooldownSeconds() > 0 && before === after, 'cool-down active: further reads rejected locally without hitting Strava', A.cooldownSeconds() + ' s');
  A._cooldownUntil = 0; A.usage.read15 = null; A._calls = [];   // simulate the next 15-minute window
  var rts = await A.listRoutes({ force: true });
  ok(rts.items.length === 2 && rts.items.every(function (r) { return /Cleeve|Riverside/.test(r.name); }), 'saved routes tab: run routes only (ride route filtered)', rts.items.map(function (r) { return r.name; }).join(' | '));

  // ────────────────────────────────────────────────────────────────────────
  head('4. pick -> streams -> route conversion');
  var pick = items.filter(function (i) { return i.id === 9000000001; })[0];
  var lim = await R.getLimits();
  ok(lim.min === -3 && lim.max === 12, 'limits = comfort (-3..12) intersected with bridge (-6..40)', JSON.stringify(lim));
  prepared = await R.prepare(pick, 'activity');
  var conv = prepared.conv, route = prepared.route, P = route.resampled;
  info('route: ' + P.length + ' pts, ' + (conv.totalDistM / 1000).toFixed(2) + ' km, real climb +' + conv.ascentReal + ' m, belt climb +' + conv.ascent + ' m, steepest raw ' + conv.stats.maxGradeRaw + '%, ' + Math.round(conv.stats.clampedFrac * 100) + '% segments capped');
  ok(conv.ascentReal >= 600, 'real route climb >= 600 m', conv.ascentReal);
  ok(conv.stats.maxGradeRaw > 12, 'raw route has pitches steeper than the 12% limit', conv.stats.maxGradeRaw + '%');
  var g = R.gradesOf(P);
  ok(g.every(function (x) { return x <= 12 + 1e-6 && x >= -3 - 1e-6; }), 'every segment grade within clamps -3..+12', 'min ' + Math.min.apply(null, g).toFixed(2) + ' max ' + Math.max.apply(null, g).toFixed(2));
  var eg = engineGrades(route);
  ok(eg.every(function (x) { return x <= 12 + 1e-6 && x >= -3 - 1e-6; }), "engine's own _calcGrade (incline target) within clamps for every route position", 'min ' + Math.min.apply(null, eg).toFixed(2) + ' max ' + Math.max.apply(null, eg).toFixed(2));
  ok(eg.every(function (x) { return x >= -6 && x <= 40; }), 'also within the X32i hard range -6..40');
  var mono = true; for (var i = 1; i < P.length; i++) if (!(P[i].dist > P[i - 1].dist)) mono = false;
  ok(mono && near(P[P.length - 1].dist, conv.totalDistM, 0.2), 'route distance strictly increasing, ends at total', conv.totalDistM + ' m');
  ok(conv.ghost && conv.ghost.t.every(function (t, k) { return k === 0 || t >= conv.ghost.t[k - 1]; }), 'ghost time-by-distance is monotonic non-decreasing');
  ok(near(conv.ghost.movingTimeS, pick.moving_time, pick.moving_time * 0.03), "ghost total ~ her activity's moving time (+-3%)", conv.ghost.movingTimeS + ' vs ' + pick.moving_time);
  ok(Math.abs(conv.ghost.elapsedS - pick.elapsed_time) < 5, 'ghost keeps elapsed time too', conv.ghost.elapsedS);
  var stopped = await R.prepare(items.filter(function (i) { return i.id === 9000000008; })[0], 'activity');
  ok(stopped.conv.ghost.elapsedS - stopped.conv.ghost.movingTimeS > 80, 'a 90 s stop is compressed out of the ghost clock', 'elapsed ' + stopped.conv.ghost.elapsedS + ' moving ' + stopped.conv.ghost.movingTimeS);

  // bridge limits: narrower bridge -> re-bake
  TM._info = { ok: true, min_incline_pct: 0, max_incline_pct: 8 };
  var lim2 = await R.getLimits();
  ok(lim2.min === 0 && lim2.max === 8, 'narrower bridge limits (0..8) win at runtime', JSON.stringify(lim2));
  var rb = R.rebake(route, lim2);
  var eg2 = engineGrades(rb.route);
  ok(eg2.every(function (x) { return x <= 8 + 1e-6 && x >= -1e-6; }), 're-baked route keeps engine incline within 0..8', 'max ' + Math.max.apply(null, eg2).toFixed(2));
  TM._info = { ok: true, min_incline_pct: -6, max_incline_pct: 40 };

  // routes tab conversion
  var rItem = rts.items.filter(function (r) { return /Cleeve/.test(r.name); })[0];
  var rprep = await R.prepare(rItem, 'route');
  ok(rprep.conv.ghost === null && rprep.route.resampled.length >= 200, 'saved route converts (no time stream -> no ghost)', rprep.route.resampled.length + ' pts');

  // commit + ghost API + engine ghost
  storedRoute = R.commit(prepared);
  base = Store.getRoute(storedRoute.id);
  ok(base && R.isStravaRoute(base.id) && base.id === 'strava_a_9000000001', 'route stored via Store.saveRoute with meta', base.id);
  var gp = [0, 1000, 5000, 9000, 14000].map(function (d) { return R.ghostPositionAt(d, base.id); });
  ok(gp.every(function (p) { return p && p.lat && p.lng; }) && gp.every(function (p, k) { return k === 0 || p.elapsedS >= gp[k - 1].elapsedS; }), 'ghostPositionAt(distanceM) -> {lat,lng,elapsedS}, elapsed increases with distance', gp.map(function (p) { return p.elapsedS; }).join(' < '));
  var back = R.ghostPositionAtTime(gp[3].elapsedS, base.id);
  ok(near(back.distanceM, 9000, 5), 'ghostPositionAtTime inverts ghostPositionAt', back.distanceM);
  var egr = R.toEngineGhostRun(base.id);
  Engine.loadRoute(base); Engine.loadGhost(egr);
  var lastD = -1, mon = true; for (var s = 0; s < egr.elapsed + 10; s += 0.25) { Engine._tickGhost(0.25); if (Engine.ghost.distanceM < lastD) mon = false; lastD = Engine.ghost.distanceM; }
  ok(mon && near(Engine.ghost.distanceM, base.totalDistM, 3) && egr.ghostSource === 'strava-activity', "existing Engine ghost replays her pace via source 'strava-activity' and finishes at the route end", lastD);

  // ────────────────────────────────────────────────────────────────────────
  head('5. multi-racer: matching, pool, racers');
  var R0 = base;
  // course matching numbers for the record
  var st = {};
  for (var id of [9000000004, 9000000008, 9000000009, 9000000010, 9000000011]) {
    var sm = await A.getActivityStreams(id);
    st[id] = RC.streamMatch(R0, sm);
    var it = items.filter(function (x) { return x.id === id; })[0], pre = RC.preMatch(R0, it);
    info(id + ' ' + it.name.slice(0, 32).padEnd(32) + ' pre=' + (pre.ok ? 'ok' : 'REJECT(' + pre.why + ')') + (pre.dev ? ' ' + pre.dev.mean.toFixed(0) + '/' + pre.dev.max.toFixed(0) + 'm' : '') +
      '  stream=' + (st[id].ok ? 'ACCEPT' : 'REJECT(' + st[id].why + ')') + (st[id].dev ? ' mean ' + st[id].dev.mean.toFixed(1) + ' p95 ' + st[id].dev.p95.toFixed(1) + ' max ' + st[id].dev.max.toFixed(0) + ' m' : ''));
  }
  ok(st[9000000004].ok && st[9000000008].ok && st[9000000009].ok, 'matching activities accepted (fast, steady+stop, slow) despite GPS noise and +-1.2% distance error');
  ok(!st[9000000010].ok && st[9000000010].why === 'shape', 'decoy: same start + similar distance but diverging middle is rejected (shape)');
  ok(!st[9000000011].ok, 'decoy: same course reversed is rejected', st[9000000011].why);
  ok(!RC.preMatch(R0, items.filter(function (x) { return x.id === 9000000012; })[0]).ok, 'unrelated flat 5k rejected at the cheap list stage');

  // local treadmill history
  var t0 = Date.parse('2026-10-11T07:15:00Z');
  var fastTm = mkRun('run_tm_fast', '2026-10-20T06:30:00Z', 5900, R0);
  var dupOfA4 = mkRun('run_tm_dup', new Date(t0 + 20000).toISOString(), 6621, R0);     // same effort as Strava #4 (uploaded)
  dupOfA4.distanceM = Math.round(R0.totalDistM * 0.9843);                                 // 14028 m vs 14255 m
  var partial = mkRun('run_tm_partial', '2026-10-19T06:30:00Z', 3000, R0, 0.5);
  var otherRoute = mkRun('run_tm_other', '2026-10-17T06:30:00Z', 2000, R0); otherRoute.routeId = 'r_other';
  var runs = [fastTm, dupOfA4, partial, otherRoute];
  ok(RC.profileFromRun(partial, R0) === null, 'partial treadmill run (50% of route) excluded from the pool');

  var rec = { stravaGet: await stat('GET /api/v3/activities/:id/streams') };
  var pool1 = await RC.buildPool(R0, { runs: runs });
  var srcs = pool1.pool.map(function (p) { return p.source + ':' + p.sourceId; });
  info('pool: ' + srcs.join(', ') + ' | fetched ' + pool1.fetched + ' | rejected ' + pool1.rejected.map(function (r) { return r.id % 100 + '=' + r.why; }).join(' '));
  ok(pool1.pool.length === 5, 'pool = 2 treadmill runs (fast, and the copy of Strava #4) + 3 Strava (base, steady, slow); Strava #4 dropped as duplicate', pool1.pool.length);
  // expected: treadmill fast, strava base(1), strava a8, strava a9 ; a4 is deduped against the local copy (run_tm_dup is NOT counted either as it is the same effort -> kept as treadmill? see rule)
  var ids = pool1.pool.map(function (p) { return p.id; }).sort();
  ok(ids.indexOf('sv_9000000010') < 0 && ids.indexOf('sv_9000000011') < 0, 'decoys never enter the pool');
  ok(ids.indexOf('sv_9000000004') < 0 || ids.indexOf('tm_run_tm_dup') < 0, 'same effort stored locally AND on Strava is counted once (dedupe by start time + distance)');
  ok(pool1.fetched <= RC.MATCH.maxFetch, 'stream downloads capped per build', pool1.fetched + ' <= ' + RC.MATCH.maxFetch);
  var s1 = await stat('GET /api/v3/activities/:id/streams');
  var pool1b = await RC.buildPool(R0, { runs: runs });
  var s2 = await stat('GET /api/v3/activities/:id/streams');
  ok(s2 === s1 && pool1b.pool.length === pool1.pool.length, 'second build costs 0 stream requests (evaluated ids remembered, streams cached)', 'streams requested: ' + (s2 - s1));

  // racers from this pool (treadmill dup is part of the local list -> pool has it as treadmill, Strava #4 dropped)
  var racers = RC.computeRacers(pool1.pool, R0);
  var byKind = {}; racers.forEach(function (r) { byKind[r.kind] = r; });
  var totals = pool1.pool.map(function (p) { return p.totalS; });
  ok(racers.length === 3 && byKind.fastest && byKind.average && byKind.slowest, '>1 pooled runs -> fastest, average, slowest', racers.map(function (r) { return r.letter; }).join('/'));
  ok(byKind.fastest.totalS === Math.min.apply(null, totals) && byKind.slowest.totalS === Math.max.apply(null, totals), 'fastest = lowest total time, slowest = highest', byKind.fastest.totalS + ' / ' + byKind.slowest.totalS);
  ok(byKind.fastest.colour === '#3ee89f' && byKind.slowest.colour === '#ff4d4d' && byKind.average.colour === '#ffd54a' && RC.COLOURS.you === '#37d0ff', 'colours: F green, S red, A yellow, YOU blue');
  ok(racers.every(function (r) { return r.letter && r.legend; }) && /Treadmill|Strava/.test(byKind.fastest.legend) && /\d\d [A-Z][a-z]{2}/.test(byKind.fastest.legend), 'each racer has a letter + source/date legend (not colour only)', racers.map(function (r) { return r.letter + '=' + r.legend + ' ' + RC.fmtDur(r.totalS); }).join(' | '));
  // average = mean elapsed at each distance
  var okAvg = true, maxErr = 0, D = R0.totalDistM;
  [0.05, 0.25, 0.5, 0.75, 0.99].forEach(function (f) {
    var d = f * D, mean = pool1.pool.reduce(function (a, p) { return a + R._interp(p.d, p.t, d); }, 0) / pool1.pool.length;
    var av = R._interp(byKind.average.d, byKind.average.t, d); maxErr = Math.max(maxErr, Math.abs(av - mean)); if (Math.abs(av - mean) > 0.5) okAvg = false;
  });
  ok(okAvg, 'average racer = mean of all pooled runs\' elapsed time at each distance', 'max error ' + maxErr.toFixed(2) + ' s');
  ok(byKind.average.t.every(function (t, k) { return k === 0 || t >= byKind.average.t[k - 1]; }), 'average profile monotonic non-decreasing');
  ok(byKind.average.totalS > byKind.fastest.totalS && byKind.average.totalS < byKind.slowest.totalS, 'average total lies between fastest and slowest', RC.fmtDur(byKind.average.totalS));

  // activate + live API
  RC.setPool(R0, pool1.pool);
  ok(R.racers().length === 3 && R.racers()[0].totalS > 0, 'StravaRoutes.racers(routeId) -> [{id,label,colour,source,date,totalS}]', JSON.stringify(R.racers()[0]));
  var rp = R.racerPositionsAt(7000);
  ok(rp.length === 3 && rp.every(function (p) { return p.lat && p.lng && p.elapsedS > 0; }) && rp[0].elapsedS < rp[2].elapsedS, 'racerPositionsAt(distance) -> [{id,lat,lng,elapsedS}] (fastest reaches 7 km before slowest)', rp.map(function (p) { return p.id + '@' + p.elapsedS; }).join(' '));
  var rt = RC.racerPositionsAtTime(3000);
  ok(rt[0].distanceM > rt[1].distanceM && rt[1].distanceM > rt[2].distanceM, 'at the same clock time fastest is furthest ahead, slowest furthest behind', rt.map(function (p) { return p.id + '=' + Math.round(p.distanceM) + 'm'; }).join(' '));
  var atD = 7000, tF = rp[0].elapsedS, tS = rp[2].elapsedS;
  var gAhead = R.gapsAt(atD, tF - 100), gBehind = R.gapsAt(atD, tS + 100), gMid = R.gapsAt(atD, (tF + tS) / 2);
  ok(gAhead.every(function (x) { return x.gapS > 0; }), 'gaps: running faster than everyone -> all positive (ahead)', gAhead.map(function (x) { return x.letter + ' ' + RC.fmtGap(x.gapS); }).join(', '));
  ok(gBehind.every(function (x) { return x.gapS < 0; }), 'gaps: slower than everyone -> all negative (behind)', gBehind.map(function (x) { return x.letter + ' ' + RC.fmtGap(x.gapS); }).join(', '));
  ok(gMid[0].gapS < 0 && gMid[2].gapS > 0, 'gaps: between fastest and slowest -> behind F, ahead of S', RC.gapsText(atD, (tF + tS) / 2));
  info('panel text example: ' + RC.gapsText(atD, (tF + tS) / 2));
  // drawing helper
  var calls = []; var ctx = { save: function () {}, restore: function () {}, beginPath: function () {}, arc: function (x, y) { calls.push([x, y]); }, fill: function () {}, stroke: function () {}, fillText: function (t) { calls.push(t); } };
  RC.drawOnCanvas(ctx, function (f) { return { x: f * 100, y: 50 }; }, 3000, 12);
  ok(calls.filter(function (c) { return typeof c === 'string'; }).join('') === 'FAS', 'drawOnCanvas draws a lettered disc per racer (F, A, S) for the oval track', calls.filter(function (c) { return typeof c === 'string'; }).join(''));

  // dedupe via recorded upload id
  RC.noteUploaded('some_local_run', 9000000009);
  var pool1c = await RC.buildPool(R0, { runs: runs, noStrava: false });
  ok(RC.isDuplicate({ id: 9000000009, start_date: '2026-09-14T09:10:00Z', distance: 14114 }, []), 'a Strava activity that THIS app uploaded (recorded id) is treated as the local run, not a second racer');

  // one / zero / two / tie
  var one = RC.computeRacers([pool1.pool[0]], R0), zero = RC.computeRacers([], R0);
  ok(zero.length === 0, 'zero pooled runs -> no racers');
  ok(one.length === 1 && one[0].colour === '#ffd54a' && /YOUR RUN/.test(one[0].label), 'one pooled run -> single yellow YOUR RUN ghost', one[0].label + ' ' + one[0].letter);
  var two = RC.computeRacers([pool1.pool[0], pool1.pool[pool1.pool.length - 1]].sort(function (a, b) { return a.totalS - b.totalS; }), R0);
  var tw = {}; two.forEach(function (r) { tw[r.kind] = r; });
  ok(two.length === 3 && tw.fastest.totalS < tw.average.totalS && tw.average.totalS < tw.slowest.totalS, 'two runs -> fastest and slowest are those two, average sits between', RC.fmtDur(tw.fastest.totalS) + ' < ' + RC.fmtDur(tw.average.totalS) + ' < ' + RC.fmtDur(tw.slowest.totalS));
  var clone = JSON.parse(JSON.stringify(pool1.pool[0])); clone.id = 'clone';
  var tie = RC.computeRacers([pool1.pool[0], clone], R0);
  ok(tie.length === 1 && tie[0].colour === '#ffd54a', 'fastest == slowest (tie) -> single ghost', tie[0].label);
  // empty route start: no strava connected
  var savedTok = localStorage.getItem('tr_strava'); localStorage.removeItem('tr_strava');
  var noStrava = await RC.buildPool(R0, { runs: runs });
  ok(noStrava.pool.length === 2 && noStrava.pool.every(function (p) { return p.source === 'treadmill'; }), 'not connected -> pool is treadmill runs only (offline-safe)', noStrava.pool.map(function (p) { return p.id; }).join(','));
  localStorage.setItem('tr_strava', savedTok);

  // ────────────────────────────────────────────────────────────────────────
  head('6. upload back to Strava');
  var run = mkRun('run_up_1', '2026-10-22T07:00:00Z', 1500, base, 0.1); run.routeName = base.name;
  var tr = U.buildTcx(run, { mode: 'trainer', route: base });
  var vr = U.buildTcx(run, { mode: 'virtual', route: base });
  function tcxChecks(x) {
    var times = (x.match(/<Time>[^<]+<\/Time>/g) || []).map(function (s) { return Date.parse(s.replace(/<\/?Time>/g, '')); });
    var dists = (x.match(/<DistanceMeters>[^<]+<\/DistanceMeters>/g) || []).slice(2).map(function (s) { return +s.replace(/<[^>]+>/g, ''); });
    return { times: times, dists: dists, open: (x.match(/<Trackpoint>/g) || []).length, close: (x.match(/<\/Trackpoint>/g) || []).length };
  }
  var c1 = tcxChecks(tr.tcx), c2 = tcxChecks(vr.tcx);
  ok(c1.open === c1.close && c1.open > 20 && c1.times.every(function (t, k) { return k === 0 || t > c1.times[k - 1]; }) && c1.dists.every(function (d, k) { return k === 0 || d >= c1.dists[k - 1]; }), 'TCX trackpoints balanced, time strictly increasing, distance non-decreasing', c1.open + ' points');
  ok(!/<Position>/.test(tr.tcx) && /<HeartRateBpm>/.test(tr.tcx) && !/Cadence/i.test(tr.tcx), "trainer mode: heart rate yes, GPS position no, cadence none");
  ok(/<Position>/.test(vr.tcx) && c2.open === c1.open, 'virtual mode: route positions interpolated by distance');
  var bf = U.buildFields(run, { mode: 'trainer', route: base, meta: R.meta(base.id) });
  ok(bf.fields.trainer === 1 && bf.fields.sport_type === 'Run' && bf.fields.data_type === 'tcx' && /treadmill/.test(bf.fields.name), 'trainer fields: trainer=1, sport_type=Run, data_type=tcx', bf.fields.name);
  var bv = U.buildFields(run, { mode: 'virtual', route: base, meta: R.meta(base.id) });
  ok(bv.fields.sport_type === 'VirtualRun' && bv.fields.trainer === undefined, 'virtual fields: sport_type=VirtualRun', bv.fields.name);
  await mockCtl('/mock/config', { processingMs: 2500 });
  var pollsBefore = await stat('GET /api/v3/uploads/:id'), stages = [];
  var res = await U.submit({ runId: run.id, fields: bf.fields, mode: 'trainer' }, function (s) { if (stages[stages.length - 1] !== s) stages.push(s); });
  var polls = (await stat('GET /api/v3/uploads/:id')) - pollsBefore;
  ok(res.state === 'done' && res.activityId > 0, 'upload accepted and polled until activity id appears', 'activity ' + res.activityId + ' after ' + polls + ' polls; stages ' + stages.join('>'));
  ok(polls >= 2, 'status polling waited through the "still being processed" stage (>=1 s interval)', polls + ' polls');
  var ups = await mockCtl('/mock/uploads'), up = ups[ups.length - 1];
  ok(up.fields.trainer === '1' && up.fields.sport_type === 'Run' && up.fields.data_type === 'tcx' && up.fields.external_id === 'trailrunner-run_up_1' && /<Trackpoint>/.test(up.file), 'mock received multipart: file + data_type + sport_type + trainer + external_id');
  ok(U.eligible(run) === false, 'a run that was uploaded is not offered again (recorded)');
  var dupe = await U.submit({ runId: 'run_up_1b', fields: bf.fields, mode: 'trainer' });
  ok(dupe.state === 'duplicate' && dupe.activityId === res.activityId, 'duplicate upload -> reported as already on Strava, not an error', dupe.error);
  // failure paths
  await mockCtl('/mock/config', { processingMs: 300 });
  var run2 = mkRun('run_up_2', '2026-10-22T09:00:00Z', 1500, base, 0.1), f2 = U.buildFields(run2, { mode: 'trainer', route: base }).fields;
  await mockCtl('/mock/fault', { kind: 'upload500', count: 1 });
  var q1 = await U.submit({ runId: run2.id, fields: f2, mode: 'trainer' });
  ok(q1.state === 'queued' && (await U.queueLength()) === 1, 'Strava 500 -> confirmed upload queued for retry', q1.error);
  var fl = await U.flushQueue();
  ok(fl.length === 1 && fl[0].state === 'done' && (await U.queueLength()) === 0, 'queue flush retries and succeeds, queue empties', JSON.stringify(fl));
  var run3 = mkRun('run_up_3', '2026-10-22T11:00:00Z', 1500, base, 0.1), f3 = U.buildFields(run3, { mode: 'trainer', route: base }).fields;
  A._override = 'localhost:1';
  var q2 = await U.submit({ runId: run3.id, fields: f3, mode: 'trainer' });
  A._override = realOverride;
  ok(q2.state === 'queued', 'offline -> queued', q2.error);
  var fl2 = await U.flushQueue();
  ok(fl2[0] && fl2[0].state === 'done', 'back online -> queued run uploaded');
  var run4 = mkRun('run_up_4', '2026-10-22T13:00:00Z', 1500, base, 0.1), f4 = U.buildFields(run4, { mode: 'trainer', route: base }).fields;
  await mockCtl('/mock/fault', { kind: 'upload_error', count: 1 });
  var fe = await U.submit({ runId: run4.id, fields: f4, mode: 'trainer' });
  ok(fe.state === 'failed' && /error/i.test(fe.error), 'processing error from Strava -> clear failure message (not queued forever)', fe.error);
  ok(U.eligible({ id: 'x', elapsed: 5, distanceM: 10 }) === false, 'too-short runs are never offered');

  // ────────────────────────────────────────────────────────────────────────
  head('7. safety');
  ok(tmCalls.length === 0, 'no TM.setSpeed / setIncline / startWorkout / stopWorkout call made by any Strava code', tmCalls.length + ' calls');
  var src = ['strava-api.js', 'strava-routes.js', 'strava-racers.js', 'strava-upload.js', 'strava-picker.js'].map(function (f) { return fs.readFileSync(path.join(UI, 'js', f), 'utf8'); }).join('\n');
  ok(!/TM\.(setSpeed|setIncline|startWorkout|stopWorkout|setFan|estop|command)/.test(src.replace(/\/\/.*$/gm, '')), 'static check: Strava sources reference only TM.getConsoleInfo (read-only)');
  ok(!/client_secret\s*[:=]\s*['"][A-Za-z0-9]{8,}/.test(src), 'static check: no client secret literal in front-end code');

  srv.close();
  var passed = results.filter(Boolean).length;
  console.log('\n' + passed + '/' + results.length + ' checks passed' + (failed ? ', ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.log('FATAL ' + (e && e.stack || e)); process.exit(2); });
