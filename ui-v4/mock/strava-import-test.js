#!/usr/bin/env node
// "Import from Strava" on stats.html - Playwright against the MOCK Strava (never real Strava, never the treadmill/adb).
//   node mock/strava-import-test.js      -> writes docs/strava-import-output.txt
// Starts the static UI (:8099) and the mock Strava (:8098) if they are not already up.
'use strict';
var path = require('path'), fs = require('fs'), cp = require('child_process');
var UI = path.resolve(__dirname, '..');
var pw = require(path.resolve(UI, '../node_modules/playwright'));
var mockStrava = require('./strava-mock.js');
var APP = 'http://localhost:8099/stats.html?strava=localhost:8098';
var SV = 'http://localhost:8098';
var LOG = path.join(UI, 'docs/strava-import-output.txt');
var lines = [], fails = 0, total = 0, children = [], srv = null;
function say(s) { console.log(s); lines.push(s); }
function ok(c, n, d) { total++; if (!c) fails++; say((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jget(u) { return fetch(u).then(function (r) { return r.json(); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function up(u) { return fetch(u).then(function () { return true; }, function () { return false; }); }

var NOW = Date.now(), DAY = 86400000;
function act(id, daysAgo, o) {
  o = o || {};
  var start = new Date(NOW - daysAgo * DAY - 3600000), mv = o.moving || 1800, dist = o.distance || 5000;
  return { id: id, name: o.name || ('Run ' + id), type: o.type || 'Run', sport_type: o.sport_type || o.type || 'Run',
    start_date: start.toISOString(), start_date_local: start.toISOString().replace('Z', ''), distance: dist,
    moving_time: mv, elapsed_time: mv + 20, total_elevation_gain: o.elev != null ? o.elev : 42, average_speed: +(dist / mv).toFixed(3), max_speed: +(dist / mv * 1.4).toFixed(2),
    average_heartrate: o.hr || 150, max_heartrate: 178, trainer: false, manual: false, map: { summary_polyline: '' }, athlete: { id: 4242 } };
}

(async function () {
  if (!(await up('http://localhost:8099/'))) children.push(cp.spawn('node', [path.join(__dirname, 'static.js')], { stdio: 'ignore' }));
  if (await up(SV + '/mock/info')) await jpost(SV + '/mock/reset'); else srv = await mockStrava.start(8098);
  await sleep(700);

  say('Strava import test ' + new Date().toISOString() + ' (mock Strava only)');
  var browser = await pw.chromium.launch();
  var ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  var page = await ctx.newPage();
  var errors = [];
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && !/tile|ERR_|Failed to load resource|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });

  function ls(k) { return page.evaluate(function (k) { return localStorage.getItem(k); }, k); }
  function runs() { return page.evaluate(function () { return JSON.parse(localStorage.getItem('tr_runs') || '[]'); }); }
  function line() { return page.evaluate(function () { return document.getElementById('svImportLine').textContent; }); }
  function periodAll() { return page.evaluate(function () { var p = document.querySelectorAll('#periodGrid .period'); return p.length ? p[p.length - 1].textContent : ''; }); }
  function mockStats() { return jget(SV + '/mock/stats'); }
  async function load() { await page.goto(APP, { waitUntil: 'load' }); await sleep(500); }
  async function clickImport(waitReload) {
    if (waitReload) { await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }), page.click('#svImportBtn')]); await sleep(400); }
    else { await page.click('#svImportBtn'); await page.waitForFunction(function () { return !document.getElementById('svImportBtn').disabled; }, null, { timeout: 15000 }); await sleep(150); }
  }

  // ── activities served by the mock (relative to now so the 90-day window is stable)
  var acts = [];
  for (var i = 1; i <= 12; i++) acts.push(act(7100000 + i, i * 2, { name: 'Imp run ' + i, type: i === 12 ? 'VirtualRun' : 'Run', distance: 4000 + i * 500, moving: 1500 + i * 60, elev: i * 3 }));
  acts.push(act(7100100, 3, { name: 'Bike', type: 'Ride' }));
  acts.push(act(7100101, 4, { name: 'Stroll', type: 'Walk' }));
  acts.push(act(7100102, 120, { name: 'Too old run' }));                    // outside the 90-day window
  await jpost(SV + '/mock/activities', { items: acts, replace: true, only: true });

  // ── 1. not connected
  await load();
  await page.evaluate(function () { localStorage.clear(); });
  await load();
  var hint = await line();
  ok(/connect strava/i.test(hint), 'not connected: hint to connect Strava in Settings', hint);
  var before = await mockStats();
  await page.click('#svImportBtn');
  await sleep(300);
  var hint2 = await line(), after0 = await mockStats();
  ok(/connect strava in settings/i.test(hint2), 'not connected: clicking IMPORT shows the Settings hint', hint2);
  ok(!after0['GET /api/v3/athlete/activities'], 'not connected: no Strava request made');

  // ── connect using the MOCK oauth (tokens are mock tokens only), seed 3 own runs
  var tok = await jpost(SV + '/oauth/token', { grant_type: 'authorization_code', code: 'mockcode' });
  var b = acts[4];   // activity to time-match
  var bStart = Date.parse(b.start_date);
  var own = [
    { id: 'run_up', routeName: 'Free Run', startedAt: new Date(NOW - 30 * DAY).toISOString(), savedAt: new Date(NOW - 30 * DAY + 1800000).toISOString(), distanceM: 5000, distanceKm: 5, elapsed: 1800, avgSpeed: 10, avgHR: 140 },
    { id: 'run_timematch', routeName: 'Free Run', startedAt: new Date(bStart + 60000).toISOString(), savedAt: new Date(bStart + 60000 + 1900000).toISOString(), distanceM: Math.round(b.distance * 1.03), distanceKm: b.distance * 1.03 / 1000, elapsed: 1900, avgSpeed: 9.5, avgHR: 138 },
    { id: 'run_samestart_farlen', routeName: 'Free Run', startedAt: new Date(Date.parse(acts[7].start_date) + 30000).toISOString(), savedAt: new Date(Date.parse(acts[7].start_date) + 2000000).toISOString(), distanceM: 1500, distanceKm: 1.5, elapsed: 600, avgSpeed: 9, avgHR: 130 }
  ];
  var upMap = { run_up: String(acts[1].id) };   // TrailRunner uploaded run_up to Strava as activity 7100002
  await page.evaluate(function (a) {
    localStorage.setItem('tr_strava', JSON.stringify({ access_token: a.tok.access_token, refresh_token: a.tok.refresh_token, expires_at: a.tok.expires_at, scope: a.tok.scope, athlete: { id: 4242 } }));
    localStorage.setItem('tr_strava_app', JSON.stringify({ clientId: '1', clientSecret: 'mock' }));
    localStorage.setItem('tr_runs', JSON.stringify(a.own));
    localStorage.setItem('tr_strava_uploaded', JSON.stringify(a.upMap));
  }, { tok: tok, own: own, upMap: upMap });
  await load();
  ok(/last 90 days/i.test(await line()), 'connected: info line instead of the hint', await line());
  ok((await periodAll()).indexOf('3 runs') >= 0, 'before: all-time shows 3 runs', (await periodAll()).slice(0, 60));
  var distBefore = (await runs()).reduce(function (s, r) { return s + (r.distanceKm || 0); }, 0);
  var btn = await page.evaluate(function () { var r = document.getElementById('svImportBtn').getBoundingClientRect(), cs = getComputedStyle(document.getElementById('svImportBtn')); return { h: r.height, w: r.width, x: r.left, y: r.top, b: r.bottom, color: cs.color, border: cs.borderTopColor, vh: innerHeight, page: document.documentElement.scrollHeight }; });
  ok(btn.h >= 64, 'IMPORT button touch target >= 64px', btn.h);
  ok(/252, 82, 0/.test(btn.border) && /252, 82, 0/.test(btn.color), 'button is Strava orange #FC5200', btn.border);
  ok(!(btn.x < 110 && btn.y < 110), 'button not in the top-left 110x110', btn.x + ',' + btn.y);
  ok(btn.b < btn.vh - 80, 'button not in the bottom 80px strip', btn.b + ' of ' + btn.vh);

  // ── 2. first import
  await clickImport(true);
  var msg = await line();
  ok(/^Imported 10 runs, skipped 2 already here/.test(msg), 'result line: imported 10, skipped 2 (uploaded + time-match)', msg);
  var rs = await runs(), imp = rs.filter(function (r) { return r.source === 'strava'; });
  ok(rs.length === 13 && imp.length === 10, 'tr_runs: 3 own + 10 imported', rs.length + '/' + imp.length);
  ok(imp.every(function (r) { return r.stravaId && r.synced && r.synced.strava && r.imported && r.id === 'sv_' + r.stravaId; }), 'imported runs carry source/stravaId/synced.strava/imported');
  var s1 = imp.filter(function (r) { return r.stravaId === '7100003'; })[0];
  ok(s1 && s1.distanceKm === 5.5 && s1.distanceM === 5500 && s1.elapsed === 1680 && s1.avgHR === 150 && s1.maxHR === 178 && s1.elevGained === 9 && s1.routeName === 'Imp run 3' && s1.avgSpeed > 11 && s1.avgSpeed < 12.5,
     'record shape: metric km/m/s/km-h, HR, elevation, name', s1 && JSON.stringify({ km: s1.distanceKm, el: s1.elapsed, sp: s1.avgSpeed, hr: s1.avgHR, ev: s1.elevGained }));
  ok(!imp.some(function (r) { return ['7100002', '7100005', '7100100', '7100101', '7100102'].indexOf(r.stravaId) >= 0; }), 'skipped: uploaded, time-match, Ride, Walk and >90-day run not imported');
  ok(imp.some(function (r) { return r.stravaId === '7100008'; }), 'same start but very different distance is imported (not a duplicate)');
  ok(imp.some(function (r) { return r.stravaId === '7100012' && r.stravaType === 'VirtualRun'; }), 'VirtualRun imported');
  ok((await periodAll()).indexOf('13 runs') >= 0, 'stats totals: all-time now 13 runs', (await periodAll()).slice(0, 60));
  var distAfter = rs.reduce(function (s, r) { return s + (r.distanceKm || 0); }, 0);
  ok(distAfter > distBefore + 40, 'total distance increased', distBefore.toFixed(1) + ' -> ' + distAfter.toFixed(1));
  var cardRuns = await page.evaluate(function () { return document.getElementById('summaryCards').textContent; });
  ok(/13/.test(cardRuns), 'ALL-TIME DETAILS TOTAL RUNS includes imports', cardRuns.slice(0, 40));
  var tags = await page.evaluate(function () { return document.querySelectorAll('#historyList .sv-tag').length; });
  ok(tags === 10, 'history rows show a "Strava" tag on the 10 imported runs', tags);
  var againOnImp = await page.evaluate(function () { return [].slice.call(document.querySelectorAll('#historyList .hrow')).filter(function (r) { return r.querySelector('.sv-tag') && r.querySelector('.sa-again'); }).length; });
  ok(againOnImp === 0, 'no AGAIN button on imported rows');
  var wk = await page.evaluate(function () { var c = document.querySelectorAll('#weeklyChart *').length, f = document.querySelectorAll('#heatmap .heatmap-cell').length; return c + f; });
  ok(wk > 20, 'charts rendered with imported data', wk);
  var st = await mockStats();
  ok(!Object.keys(st).some(function (k) { return /streams/.test(k); }), 'no streams requested');
  ok(st['GET /api/v3/athlete/activities'] === 1, 'one list call for 12 runs (<= 100 per page)', st['GET /api/v3/athlete/activities']);

  // ── 3. second import changes nothing
  var raw1 = await ls('tr_runs');
  await clickImport(false);
  var msg2 = await line(), raw2 = await ls('tr_runs');
  ok(/^Imported 0 runs, skipped 12 already here/.test(msg2), 'second import: imported 0, skipped 12', msg2);
  ok(raw1 === raw2, 'second import leaves tr_runs byte-identical');

  // ── 4. no SEND TO STRAVA / Run Again / ghost for imported runs
  var idx = await page.evaluate(function () { return window.__statsRuns.findIndex(function (r) { return r.stravaId === '7100003'; }); });
  await page.evaluate(function (i) { openRunDetail(i); }, idx);
  await sleep(300);
  var det = await page.evaluate(function () { var d = document.getElementById('rdDetail'); return { txt: d.textContent, runAgain: !!d.querySelector('.ra-entry'), send: /SEND TO STRAVA/.test(d.textContent), view: !!d.querySelector('a[href*="strava.com/activities/7100003"]'), title: document.getElementById('rdTitle').innerHTML }; });
  ok(!det.runAgain && !det.send, 'detail: no RUN AGAIN and no SEND TO STRAVA for an imported run');
  ok(det.view && /From Strava/.test(det.txt) && /sv-tag/.test(det.title), 'detail: "From Strava" + View on Strava link + tag');
  var el = await page.evaluate(function () {
    var r = window.__statsRuns.filter(function (x) { return x.stravaId === '7100003'; })[0], own = window.__statsRuns.filter(function (x) { return x.id === 'run_timematch'; })[0];
    return { eligible: StravaUpload.eligible(StravaUpload.normaliseStored(r)), reason: StravaUpload.reason(StravaUpload.normaliseStored(r)), norm: PastRunSplits.normalise(r), ownReason: StravaUpload.reason(StravaUpload.normaliseStored(own)) };
  });
  ok(!el.eligible && el.reason === 'uploaded', 'StravaUpload never offers an imported run', el.reason);
  ok(el.norm === null, 'PastRunSplits ignores imported runs');

  // history panel in the main app (index.html): imported rows have no AGAIN / SEND / RACE
  var app = await ctx.newPage();
  await app.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  await app.goto('http://localhost:8099/?strava=localhost:8098', { waitUntil: 'load' });
  await sleep(1500);
  var hist = await app.evaluate(function () {
    try { UI.renderHistory(); } catch (e) { return { err: String(e) }; }
    var rows = [].slice.call(document.querySelectorAll('#historyList .history-row'));
    return { rows: rows.length, imp: rows.filter(function (r) { return /Strava<\/span>|Imp run/.test(r.innerHTML); }).length };
  });
  ok(!hist.err && hist.rows === 3 && hist.imp === 0, 'app history panel: only the 3 own runs listed (imported runs not shown, cannot push own runs out)', JSON.stringify(hist));
  var voice = await app.evaluate(function () { return Store.getRuns().filter(function (r) { return !r.imported; }).length; });
  ok(voice === 3, 'own runs still 3 in Store');
  var guard = await app.evaluate(function () { var id = Store.getRuns().filter(function (r) { return r.imported; })[0].id; var before = typeof Engine.ghost; App.loadGhost(id); return { ghost: Engine.ghost ? 'set' : 'none' }; });
  ok(guard.ghost === 'none', 'App.loadGhost(imported) does nothing', JSON.stringify(guard));
  await app.close();

  // ── 5. on-demand detail for ONE run
  var stBefore = await mockStats();
  await page.evaluate(function (i) { openRunDetail(i); }, idx);
  await sleep(200);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }), page.click('#svDetailBox button')]);
  await sleep(600);
  var stAfter = await mockStats();
  var r3 = (await runs()).filter(function (r) { return r.stravaId === '7100003'; })[0];
  ok(r3 && r3.splits && r3.splits.length === 5 && r3.calories > 0, 'LOAD SPLITS: 5 km splits + calories stored for that one run', r3 && (r3.splits || []).length + ' splits, ' + r3.calories + ' kcal');
  ok((stAfter['GET /api/v3/activities/:id'] || 0) - (stBefore['GET /api/v3/activities/:id'] || 0) === 1, 'exactly one detail request');
  ok((await page.evaluate(function () { return document.getElementById('runDetail').classList.contains('show'); })), 'detail page reopens after loading');

  // ── 5b. racer discovery after an import: imported runs must NOT make the athlete's own activities 'duplicates'
  var app3 = await ctx.newPage();
  await app3.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  await app3.goto('http://localhost:8099/?strava=localhost:8098', { waitUntil: 'load' });
  await sleep(1200);
  var rac = await app3.evaluate(async function () {
    var out = { dupAny: [], rejectedDup: [], healed: null };
    var runsNow = Store.getRuns();
    var acts = runsNow.filter(function (r) { return r.imported; });
    acts.forEach(function (r) { var it = { id: r.stravaId, start_date: r.startedAt, distance: r.distanceM }; if (StravaRacers.isDuplicate(it, runsNow.filter(function (x) { return x.id !== 'run_up' && x.id !== 'run_timematch'; }))) out.dupAny.push(r.stravaId); });
    var lr = await StravaRacers.localRuns(); out.localImported = lr.filter(function (r) { return r.imported; }).length;
    // old persisted 'dup' (caused by imported runs in earlier builds) must not stick
    await StravaApi.kv.set('pool:rx', { accepted: [], seen: { '7100003': 'dup', '7100004': 'dup' } });
    var res = await StravaRacers.buildPool({ id: 'rx', name: 'rx', totalDistM: 5500, resampled: [] }, { runs: runsNow });
    out.rejectedDup = res.rejected.filter(function (x) { return x.why === 'duplicate-of-treadmill-run' && (x.id == 7100003 || x.id == 7100004); }).map(function (x) { return x.id; });
    out.rejected = res.rejected.length;
    var saved = await StravaApi.kv.get('pool:rx'); out.healed = saved && saved.seen ? [saved.seen['7100003'], saved.seen['7100004']] : null;
    return out;
  });
  ok(rac.dupAny.length === 0 && rac.localImported === 0, 'racers: imported activities are not duplicates of local runs; localRuns() excludes imported', JSON.stringify(rac.dupAny) + ' li=' + rac.localImported);
  ok(rac.rejectedDup.length === 0 && rac.healed && rac.healed[0] !== 'dup' && rac.healed[1] !== 'dup', 'racers: stale seen[id]="dup" is re-evaluated, activities stay eligible', JSON.stringify({ rej: rac.rejected, healed: rac.healed }));
  var dupReal = await app3.evaluate(function () { var r = Store.getRuns().filter(function (x) { return x.id === 'run_timematch'; })[0]; return StravaRacers.isDuplicate({ id: 7100005, start_date: r.startedAt, distance: r.distanceM }, Store.getRuns()); });
  ok(dupReal === true, 'racers: a genuinely local (treadmill) run is still a duplicate');

  await app3.close();

  // ── 5c. XSS: hostile activity name is escaped everywhere
  var evil = act(7100300, 1, { name: '<img src=x onerror="window.__xss=1">"\'&<script>window.__xss=2</script>', distance: 6100, moving: 1900 });
  await jpost(SV + '/mock/activities', { items: [evil] });
  await load();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }), page.click('#svImportBtn')]);
  await sleep(600);
  var xs = await page.evaluate(function () {
    var i = window.__statsRuns.findIndex(function (r) { return r.stravaId === '7100300'; });
    var list = document.getElementById('historyList').innerHTML, rb = document.getElementById('routeBreakdown').innerHTML;
    openRunDetail(i);
    var title = document.getElementById('rdTitle');
    return { xss: window.__xss, imgs: document.querySelectorAll('#historyList img, #routeBreakdown img, #rdTitle img, script:not([src])[data-x]').length,
      listEsc: /&lt;img/.test(list), titleText: title.textContent.indexOf('<img') >= 0, titleImg: title.querySelectorAll('img,script').length,
      cards: [].slice.call(document.querySelectorAll('#routeBreakdown .rb-name')).map(function (e) { return e.textContent; }), i: i };
  });
  ok(xs.i >= 0 && !xs.xss && xs.imgs === 0 && xs.listEsc && xs.titleText && xs.titleImg === 0, 'XSS: hostile name rendered as text in history row and run title, nothing executed', JSON.stringify({ xss: xs.xss, imgs: xs.imgs }));
  ok(xs.cards.indexOf('Strava runs') >= 0 && xs.cards.every(function (c) { return !/Imp run|Fresh|<img/.test(c); }), 'route breakdown: imported runs grouped as one "Strava runs" card', JSON.stringify(xs.cards));
  var hl = await page.evaluate(function () {
    var own = window.__statsRuns.filter(function (r) { return !r.imported; })[0] || {};
    var rc = RunRecap.build({ id: 'new', distanceKm: 3, distanceM: 3000, elapsed: 900, elapsedSec: 900, routeName: 'Free Run', startedAt: new Date().toISOString(), savedAt: new Date().toISOString(), elevGained: 1 }, window.__statsRuns);
    return { recent: rc.recent ? rc.recent.n || rc.recent.count || 'present' : null, hl: rc.highlights.map(function (h) { return h.id; }) };
  });
  ok(hl.recent === 3, 'recap: recent-5 average built from own runs only', JSON.stringify(hl));

  // ── 6. errors: nothing is written
  await page.evaluate(function () { sessionStorage.clear(); });
  async function errCase(name, setup, re, teardown) {
    await load();
    var snap = await ls('tr_runs');
    // make a NEW activity available so a successful import would change tr_runs
    await jpost(SV + '/mock/activities', { items: [act(7100200 + Math.floor(Math.random() * 90), 1, { name: 'Fresh ' + name })] });
    await setup();
    await clickImport(false);
    var m = await line();
    ok(re.test(m), name + ': clear message', m);
    ok((await ls('tr_runs')) === snap, name + ': tr_runs untouched');
    ok(await page.evaluate(function () { return !document.getElementById('svImportBtn').disabled; }), name + ': button re-enabled');
    if (teardown) await teardown();
  }
  await errCase('429 rate limit', function () { return jpost(SV + '/mock/fault', { kind: '429', count: 1 }); }, /busy|try again/i);
  // the 429 sets a client cooldown; clear it so the next cases reach the network
  await errCase('401 expired login', async function () { await page.evaluate(function () { StravaApi._cooldownUntil = 0; }); await jpost(SV + '/mock/fault', { kind: '401', count: 3 }); }, /login expired|reconnect/i);
  await errCase('network down', async function () { await page.evaluate(function () { StravaApi._cooldownUntil = 0; }); await page.route('**/api/v3/athlete/activities*', function (r) { r.abort(); }); }, /No connection/i, function () { return page.unroute('**/api/v3/athlete/activities*'); });
  await jpost(SV + '/mock/reset');
  // reset wiped mock tokens: reconnect + restore activity set for the cap test
  var tok2 = await jpost(SV + '/oauth/token', { grant_type: 'authorization_code', code: 'mockcode' });
  var big = [];
  for (var k = 0; k < 250; k++) big.push(act(7200000 + k, 1 + (k % 80), { name: 'Big ' + k, distance: 3000 + k, moving: 1200 + k }));
  // make start times unique so none collide
  big.forEach(function (a, n) { var t = new Date(NOW - (1 + (n % 80)) * DAY - n * 600000); a.start_date = t.toISOString(); a.start_date_local = t.toISOString().replace('Z', ''); });
  await jpost(SV + '/mock/activities', { items: big, replace: true, only: true });
  await page.evaluate(function (t) {
    localStorage.setItem('tr_strava', JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at, scope: t.scope, athlete: { id: 4242 } }));
    localStorage.setItem('tr_runs', '[]'); localStorage.removeItem('tr_strava_uploaded'); StravaApi._cooldownUntil = 0;
  }, tok2);

  // page 2 of 3 fails -> no partial import
  await load();
  var n = 0;
  await page.route('**/api/v3/athlete/activities*', function (r) { n++; if (n === 2) r.abort(); else r.continue(); });
  await clickImport(false);
  var mm = await line();
  ok(/No connection/i.test(mm) && (await runs()).length === 0, 'failure on page 2 of 3: nothing imported (no partial corruption)', mm + ' / runs=' + (await runs()).length);
  await page.unroute('**/api/v3/athlete/activities*');

  // cap of 200 per import
  await clickImport(true);
  var mc = await line(), capRuns = await runs();
  ok(capRuns.length === 200 && /Imported 200 runs, skipped 0/.test(mc) && /newest 200/.test(mc), 'cap: 250 available -> 200 imported (newest), says so', mc);
  var newestKept = capRuns.every(function (r) { return Date.parse(r.startedAt) > NOW - 81 * DAY; });
  var sortedDesc = capRuns.every(function (r, i2) { return i2 === 0 || Date.parse(capRuns[i2 - 1].savedAt) >= Date.parse(r.savedAt); });
  ok(newestKept && sortedDesc, 'imported runs are within 90 days and stored newest first');
  var st3 = await mockStats();
  ok(st3['GET /api/v3/athlete/activities'] <= 6, 'list calls stay small (2 failed attempt + 3 pages)', st3['GET /api/v3/athlete/activities']);

  // a new own run saved via Store does not push imported runs out, and 50 own runs are still kept
  var app2 = await ctx.newPage();
  await app2.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  await app2.goto('http://localhost:8099/?strava=localhost:8098', { waitUntil: 'load' });
  await sleep(800);
  var capped = await app2.evaluate(function () {
    for (var i = 0; i < 55; i++) Store.saveRun({ id: 'own_' + i, routeName: 'Free Run', distanceKm: 1, elapsed: 300, startedAt: new Date().toISOString() });
    var r = Store.getRuns(); return { own: r.filter(function (x) { return !x.imported; }).length, imp: r.filter(function (x) { return x.imported; }).length };
  });
  await app2.close();
  ok(capped.own === 50 && capped.imp === 200, 'Store cap: 50 own runs kept, 200 imported untouched', JSON.stringify(capped));

  ok(errors.length === 0, 'no page / console errors', errors.slice(0, 3).join(' | '));
  await browser.close();
  say('\nResult: ' + (total - fails) + '/' + total + ' passed' + (fails ? ', ' + fails + ' FAILED' : ''));
  try { fs.writeFileSync(LOG, lines.join('\n') + '\n'); } catch (e) {}
  if (srv) srv.close();
  children.forEach(function (c) { try { c.kill(); } catch (e) {} });
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error('TEST CRASH', e); children.forEach(function (c) { try { c.kill(); } catch (e2) {} }); process.exit(2); });
