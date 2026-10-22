#!/usr/bin/env node
// Strava end-to-end test of the INTEGRATED ui-v4 app (Playwright, repo node_modules) against the local mocks:
//   mock treadmill bridge :4510, static UI :8099, mock Strava :8098.  Starts any of them that is not up.
//   node mock/strava-e2e.js          -> writes docs/audit-strava-e2e-output.txt and screens/strava-*.png
// It never touches the real treadmill or adb. The "belt" here is the mock bridge's simulation.
'use strict';
var path = require('path'), fs = require('fs'), cp = require('child_process');
var UI = path.resolve(__dirname, '..');
var pw = require(path.resolve(UI, '../node_modules/playwright'));
var mockStrava = require('./strava-mock.js');
var APP = 'http://localhost:8199/?bridge=localhost:4610&strava=localhost:8198';
var TM_MOCK = 'http://localhost:4610', SV_MOCK = 'http://localhost:8198';
var OUT = process.env.AUDIT_SHOTS || '/tmp/claude-1000/aud/shots', LOG = process.env.AUDIT_STRAVA_LOG || '/tmp/claude-1000/aud/audit-strava-e2e-output.txt';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
var lines = [], fails = 0, total = 0, children = [], strvSrv = null;
function say(s) { console.log(s); lines.push(s); }
function ok(c, n, d) { total++; if (!c) fails++; say((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jget(u) { return fetch(u).then(function (r) { return r.json(); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function up(u) { return fetch(u).then(function () { return true; }, function () { return false; }); }
function uploads() { return jget(SV_MOCK + '/mock/uploads'); }

async function ensureServers() {
  if (!(await up(TM_MOCK + '/health'))) { children.push(cp.spawn('node', [path.join(__dirname, 'server.js')], { stdio: 'ignore' })); }
  if (!(await up('http://localhost:8199/'))) { children.push(cp.spawn('node', [path.join(__dirname, 'static.js')], { stdio: 'ignore' })); }
  if (await up(SV_MOCK + '/mock/info')) await jpost(SV_MOCK + '/mock/reset'); else strvSrv = await mockStrava.start(8098);
  await sleep(800);
  await jpost(TM_MOCK + '/mock/reset');
}

(async function () {
  await ensureServers();
  say('Strava e2e ' + new Date().toISOString() + ' (viewport 1920x1080, app ' + APP + ')');
  var browser = await pw.chromium.launch();
  var ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  var page = await ctx.newPage();
  var errors = [];
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && !/tile|ERR_|Failed to load resource|ERR_INTERNET|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  async function shot(name) { await sleep(300); await page.screenshot({ path: path.join(OUT, 'audit-strava-' + name + '.png') }); }
  function R(sel) { return page.evaluate(function (s) { var e = document.querySelector(s); if (!e) return null; var r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, vis: !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).display !== 'none' }; }, sel); }
  function hit(a, b) { return a && b && a.vis && b.vis && a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y; }

  // The mock's /oauth/authorize answers 302 -> the public callback URL (silverhouse3.github.io/trailrunner/strava-callback.html).
  // Rewrite only the host so the callback page is the local copy, same origin as the app (like production, where both live on github.io).
  await ctx.route('**/oauth/authorize*', function (route) {
    route.fetch({ maxRedirects: 0 }).then(function (resp) {
      var loc = resp.headers()['location'] || '';
      route.fulfill({ status: 302, headers: { Location: loc.replace(/^https:\/\/silverhouse3\.github\.io\/trailrunner\/(ui-v4\/)?/, 'http://localhost:8199/') } });
    });
  });
  // Block the real internet (map tiles etc.) quickly
  await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });

  // ───────────────────────── 0. fresh start: no route => route options hidden
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(function () { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(APP, { waitUntil: 'load' });
  await sleep(1500);
  await shot('01-home-not-connected');
  async function routelessChecks(label) {
    await page.waitForFunction(function () { return document.getElementById('rootApp').classList.contains('routeless'); }, null, { timeout: 5000 }).catch(function () {});
    var st = await page.evaluate(function () {
      var hidden = [].slice.call(document.querySelectorAll('[data-needs-route]')).map(function (e) { return getComputedStyle(e).display === 'none'; });
      var bar = document.getElementById('raceBar');
      return { routeless: document.getElementById('rootApp').classList.contains('routeless'), n: hidden.length, allHidden: hidden.every(function (x) { return x; }),
        barVisible: !!(bar && bar.offsetHeight), dots: document.querySelectorAll('.sv-dot').length, legend: document.querySelectorAll('.sv-legend').length,
        racers: window.StravaRacers && StravaRacers.active ? StravaRacers.active.racers.length : 0, hasRoute: Engine.hasRoute(),
        gradeLine: document.querySelectorAll('#mapDiv .leaflet-stravaGrade-pane path').length };
    });
    ok(st.routeless && st.n >= 5 && st.allHidden, label + ': #rootApp.routeless and every [data-needs-route] element hidden', st.n + ' elements');
    ok(!st.barVisible && st.dots === 0 && st.legend === 0 && st.racers === 0 && st.gradeLine === 0 && !st.hasRoute, label + ': no race bar, no racer dots, no Strava line when no route', JSON.stringify({ bar: st.barVisible, dots: st.dots, racers: st.racers, line: st.gradeLine }));
  }
  await routelessChecks('start (no route)');
  ok(await page.evaluate(function () { return typeof StravaApi !== 'undefined' && StravaApi.isMock() && !StravaApi.isConnected(); }), 'mock override active (?strava=localhost:8098) and not yet connected');

  // ───────────────────────── 1. connect through Settings (mock OAuth)
  await page.click('.icon-btn:has(.ib-label:text("SETTINGS"))');
  await page.waitForSelector('#spInner');
  await page.evaluate(function () { SettingsPanel._openSections.add('integrations'); SettingsPanel._render(); });
  await page.waitForSelector('#spStravaConnectBtn');
  var legacyAuto = await page.evaluate(function () { return !!document.getElementById('spStravaAuto'); });
  ok(!legacyAuto, 'old "Auto-Upload" toggle is gone from Settings');
  await page.fill('#spStravaId', '12345');
  await page.fill('#spStravaSecret', 'mock-secret-not-real');
  await shot('02-settings-integrations');
  await Promise.all([page.waitForURL(/strava-callback\.html/, { timeout: 15000 }), page.click('#spStravaConnectBtn')]);
  var cbUrl = page.url();
  ok(/[?&]state=tr/.test(cbUrl) && /scope=/.test(cbUrl) && decodeURIComponent(cbUrl).indexOf('activity:write') >= 0 && decodeURIComponent(cbUrl).indexOf('activity:read_all') >= 0 && decodeURIComponent(cbUrl).indexOf('read_all') >= 0,
     'authorize request carried state + scopes incl. activity:read_all, activity:write, read_all', decodeURIComponent(cbUrl).replace(/^.*\?/, '').slice(0, 150));
  await page.waitForURL(/localhost:8199\/(index\.html)?(\?.*)?$/, { timeout: 15000 });
  await page.waitForFunction(function () { return window.StravaApi && StravaApi.isConnected(); }, null, { timeout: 8000 });
  var tok = await page.evaluate(function () { var t = StravaApi.tokens(); return { scope: t.scope, hasRefresh: !!t.refresh_token, name: t.athlete && t.athlete.firstname, state: localStorage.getItem('tr_strava_oauth_state'), app: StravaApi.app() }; });
  ok(tok.hasRefresh && /activity:write/.test(tok.scope) && /activity:read_all/.test(tok.scope), 'callback stored tokens with the granted scope', tok.scope + ' / ' + tok.name);
  ok(tok.state === null, 'callback checked the state and cleared it');
  await sleep(500);
  await shot('03-home-connected');
  ok(await page.evaluate(function () { var p = document.getElementById('pillSync'); return p && p.offsetWidth > 0 && /Soph|Strava|Mock|\w+/.test(p.textContent); }), 'Strava pill shows on Home when connected');

  // ───────────────────────── 2. picker from the Home STRAVA button, pick the hilly activity
  var hs = await R('#homeStravaBtn');
  ok(hs && hs.vis && hs.h >= 72, 'Home has a STRAVA button (>= 72 px)', hs && Math.round(hs.h) + ' px');
  // local treadmill history on the same course (the race pool mixes treadmill + Strava; treadmill copy wins on duplicates)
  await page.evaluate(function () {
    var t0 = Date.parse('2026-10-20T06:30:00Z'), tp = [], D = 14255, T = 6100;
    for (var e = 0; e <= T; e += 10) tp.push({ time: new Date(t0 + e * 1000).toISOString(), dist: Math.round(D * e / T), hr: 150, elapsed: e });
    var sp = []; for (var k = 1; k <= 14; k++) sp.push({ km: k, timeSec: 435 + (k % 3) * 6, avgHR: 150 });
    var runs = JSON.parse(localStorage.getItem('tr_runs') || '[]');
    runs.unshift({ id: 'tm_hist_1', routeId: 'strava_a_9000000001', routeName: 'Cleeve Hill Loop', startedAt: '2026-10-20T06:30:00.000Z', savedAt: '2026-10-20T08:12:00.000Z', elapsed: T, distanceM: D, distanceKm: D / 1000, trackPoints: tp, splits: sp });
    localStorage.setItem('tr_runs', JSON.stringify(runs));
  });
  await page.click('#homeStravaBtn');
  await page.waitForSelector('.sv-row', { timeout: 10000 });
  var rowCount = await page.$$eval('.sv-row', function (r) { return r.length; });
  ok(rowCount === 12, 'picker lists the 12 recent runs (ride + walk filtered out)', rowCount);
  await shot('04-picker');
  await page.click('.sv-row:has-text("Cleeve Hill Loop") >> nth=0');
  await page.waitForSelector('.sv-use', { timeout: 10000 });
  await shot('05-picker-detail');
  await page.click('.sv-use');
  await page.waitForFunction(function () { return StravaRacers.active && StravaRacers.active.status && StravaRacers.active.status.stage === 'done'; }, null, { timeout: 20000 });
  await sleep(1200);

  // ───────────────────────── 3. route + incline-coloured line + racer dots + legend
  var live = await page.evaluate(function () {
    var cols = {}; var paths = document.querySelectorAll('#mapDiv .leaflet-stravaGrade-pane path');
    for (var i = 0; i < paths.length; i++) cols[paths[i].getAttribute('stroke')] = 1;
    var bar = document.getElementById('raceBar');
    return { routeName: document.getElementById('routeName').textContent, isStrava: StravaRoutes.isStravaRoute(Engine.route.id), segs: paths.length, colours: Object.keys(cols).length,
      dots: [].slice.call(document.querySelectorAll('.sv-dot')).map(function (d) { return d.textContent; }).join(''),
      bar: bar ? bar.innerText.replace(/\s+/g, ' ') : '', barOn: !!(bar && bar.offsetHeight), routeless: document.getElementById('rootApp').classList.contains('routeless'),
      posDot: !!document.querySelector('#mapDiv .tr-pos-dot'), maxInc: Math.max.apply(null, Engine.resampled.map(function (_, i) { return Engine._calcGrade ? Engine._calcGrade(i) : 0; })),
      racers: StravaRacers.racers().map(function (r) { return r.letter + ':' + r.colour + ':' + r.source; }), status: StravaRacers.active.status.stage, runStatus: Engine.run && Engine.run.status,
      poolSources: StravaRacers.active.pool.map(function (p) { return p.source; }).join(',') };
  });
  ok(/CLEEVE HILL LOOP/.test(live.routeName) && live.isStrava && !live.routeless, 'Strava route loaded as the active route; route-only options visible again', live.routeName);
  ok(live.segs > 100 && live.colours >= 3, 'incline-coloured route line (own pane, several grade colours)', live.segs + ' segments, ' + live.colours + ' colours');
  ok(live.dots === 'FAS', 'racer dots F, A, S on the map', live.dots);
  ok(/F\s*\+?-?\d+:\d\d/.test(live.bar) && /A\s*\+?-?\d+:\d\d/.test(live.bar) && /S\s*\+?-?\d+:\d\d/.test(live.bar) && /YOU/.test(live.bar) && live.barOn, 'compact legend bar shows F / A / S gaps and YOU', live.bar);
  ok(live.racers.length === 3 && live.racers[0].indexOf('#3ee89f') > 0 && live.racers[1].indexOf('#ffd54a') > 0 && live.racers[2].indexOf('#ff4d4d') > 0, 'colours: Fastest green, Average yellow, Slowest red', live.racers.join(' '));
  ok(/treadmill/.test(live.poolSources) && /strava/.test(live.poolSources), 'pool mixes the treadmill run and Strava runs', live.poolSources);
  ok(live.posDot, 'live position dot (blue) is on the map alongside the racers');
  var chipCols = await page.evaluate(function () { return [].slice.call(document.querySelectorAll('#raceBar .sv-chip')).map(function (c) { return c.textContent + ':' + c.style.background; }).join(' '); });
  say('INFO  legend chips: ' + chipCols);
  await shot('06-ready-route-racers');

  // layout: the race bar overlaps nothing, even with the video window dragged into every corner of its zone
  await page.evaluate(function () { VideoWin.open(); });
  await sleep(300);
  var boxes = {};
  for (var sel of ['#raceBar', '.metric-strip', '.edge-left', '.edge-right', '.run-controls', '#videoWin', '.map-tl', '#mapZoom']) boxes[sel] = await R(sel);
  var bad = [];
  ['.metric-strip', '.edge-left', '.edge-right', '.run-controls', '#videoWin'].forEach(function (s) { if (hit(boxes['#raceBar'], boxes[s])) bad.push('raceBar x ' + s); });
  ok(boxes['#raceBar'].vis && bad.length === 0, 'race bar does not overlap metric strip, edge controls, run controls or the video window (default position)', bad.join(', '));
  for (var corner of [[0, 0], [99999, 0], [0, 99999], [99999, 99999]]) {
    await page.evaluate(function (c) { VideoWin._pos.x = c[0]; VideoWin._pos.y = c[1]; VideoWin._clamp(); VideoWin._apply(); }, corner);
    var vb = await R('#videoWin'), rb = await R('#raceBar'), mz = await R('.map-zone'), rc = await R('.run-controls'), ms = await R('.metric-strip');
    ok(!hit(rb, vb) && !hit(vb, rc) && !hit(vb, ms) && vb.y >= mz.y - 1 && vb.b <= mz.b + 1, 'video window clamped inside the view zone at corner ' + corner.map(function (v) { return v > 9999 ? 'max' : v; }).join('/') + ' (clear of race bar, STOP/PAUSE row, metric strip)',
       'video y ' + Math.round(vb.y) + '-' + Math.round(vb.b) + ', zone ' + Math.round(mz.y) + '-' + Math.round(mz.b) + ', bar ' + Math.round(rb.y) + '-' + Math.round(rb.b));
  }
  await page.evaluate(function () { VideoWin._pos.x = 99999; VideoWin._pos.y = 0; VideoWin._clamp(); VideoWin._apply(); });
  await shot('07-race-bar-video-window');
  await page.evaluate(function () { VideoWin.close(); });

  // old autosync really is gone
  var legacy = await page.evaluate(function () { return Sync.autoSync({ id: 'x' }).then(function (r) { return r; }); });
  ok(legacy === false, 'legacy Sync.autoSync is a no-op (returns false, uploads nothing)');
  ok((await uploads()).length === 0, 'mock Strava has received 0 uploads so far');

  // ───────────────────────── 4. go live (route modal path), START via the real UI, mock belt runs
  await page.waitForSelector('#fcStart', { state: 'visible' });
  var before = await page.evaluate(function () { return { dot: MapView.runnerMarker.getLatLng(), racers: StravaRacers.racerPositionsAtTime(Engine.run.elapsed), gap: document.getElementById('svgap_fastest').textContent }; });
  await page.click('#fcStart');
  await page.waitForFunction(function () { return Engine.run && Engine.run.status === 'running'; }, null, { timeout: 10000 });
  for (var i = 0; i < 24; i++) { await page.click('.edge-right .edge-btn.up'); await sleep(50); }   // 12 km/h
  var samples = [];
  async function sample() {
    return page.evaluate(function () {
      var m = MapView.runnerMarker.getLatLng(), p = StravaRacers.racerPositionsAtTime(Engine.run.elapsed);
      return { t: Engine.run.elapsed, d: Engine.run.distanceM, spd: Engine.run.speed, dot: [m.lat, m.lng], F: p[0] && [p[0].lat, p[0].lng], gaps: ['fastest', 'average', 'slowest'].map(function (k) { return document.getElementById('svgap_' + k).textContent; }),
        bridge: null, inc: Engine.run.incline, tgt: Engine.ctrl.targetSpeed, cd: !!Engine.run._cooldown, st: Engine.run.status, hr: Engine.run.hr };
    });
  }
  await sleep(6000); samples.push(await sample());
  await shot('08-running-route');
  await page.waitForFunction(function () { return Engine.run.elapsed >= 32 && Engine.run.distanceM >= 115; }, null, { timeout: 120000 });
  samples.push(await sample());
  var bridge = await jget(TM_MOCK + '/mock/state');
  say('INFO  samples ' + JSON.stringify(samples.map(function (s) { return { t: Math.round(s.t), d: Math.round(s.d), spd: s.spd, gaps: s.gaps.join('/'), inc: s.inc, tgt: s.tgt, cooldown: s.cd, status: s.st, hr: s.hr }; })) + ' bridge ' + JSON.stringify(bridge.sim || bridge).slice(0, 160));
  ok(samples[1].d > samples[0].d && samples[0].d > 0, 'the mock belt ran: distance advances', Math.round(samples[0].d) + ' m -> ' + Math.round(samples[1].d) + ' m');
  var moved = Math.abs(samples[1].dot[0] - before.dot.lat) + Math.abs(samples[1].dot[1] - before.dot.lng);
  var moved2 = Math.abs(samples[1].dot[0] - samples[0].dot[0]) + Math.abs(samples[1].dot[1] - samples[0].dot[1]);
  ok(moved > 1e-5 && moved2 > 1e-6, 'blue live dot moved along the route', moved.toExponential(2) + ' / ' + moved2.toExponential(2));
  ok(samples[1].F && (Math.abs(samples[1].F[0] - samples[0].F[0]) + Math.abs(samples[1].F[1] - samples[0].F[1])) > 1e-6, 'racer dots move by clock time too');
  ok(samples[1].gaps.every(function (g) { return /^[+-]\d+:\d\d$/.test(g); }) && samples[1].gaps.join() !== samples[0].gaps.join(), 'gaps update live (F/A/S)', samples[0].gaps.join(' ') + ' -> ' + samples[1].gaps.join(' '));
  var inc = await page.evaluate(function () { return { max: Engine.route ? Math.max.apply(null, Engine.route.resampled.map(function (p, i, a) { return i ? (p.ele - a[i - 1].ele) / Math.max(0.001, p.dist - a[i - 1].dist) * 100 : 0; })) : 0, tgt: Engine.ctrl.targetIncline }; });
  ok(inc.max <= 12.05 && inc.tgt <= 12.05, 'route incline stays inside the -3..+12 clamp (profile max ' + inc.max.toFixed(2) + '%, target ' + inc.tgt + '%)');
  var midOverlap = [];
  var bm = await R('#raceBar'), b2 = { c: await R('.run-controls'), m: await R('.metric-strip'), l: await R('.edge-left'), r: await R('.edge-right') };
  for (var k2 in b2) if (hit(bm, b2[k2])) midOverlap.push(k2);
  ok(midOverlap.length === 0, 'while running: race bar clear of STOP/PAUSE row, metric strip and edge controls');
  await shot('09-running-route-after-30s');

  // oval track view: racer discs drawn through the wrapped OvalTrack._drawPacMan
  await page.click('.map-mode-btn[data-style="oval"]');
  await sleep(1500);
  var ovalWrapped = await page.evaluate(function () { return StravaRacers.ovalTrack._installed; });
  ok(ovalWrapped, 'oval-track wrapper installed (race shown on the oval as well as the map)');
  await shot('10-oval-with-racers');
  await page.click('.map-mode-btn[data-style="terrain"]');
  await sleep(600);

  // ───────────────────────── 5. STOP, km-split comparison includes Strava runs
  // A 30-40 s mock run only covers ~150 m, so two km splits are injected into the live run (same approach as screens-splits.js);
  // the PAST-run side (local + Strava) is real data.
  await page.evaluate(function () {
    var r = Engine.run; r.splits = [{ km: 1, timeSec: 395, paceSecPerKm: 395, avgHR: 150, elapsed: 395 }, { km: 2, timeSec: 401, paceSecPerKm: 401, avgHR: 152, elapsed: 796 }];
    r._lastSplitElapsed = 796; r._lastSplitKm = 2;
  });
  await page.click('#fcStop');
  await page.waitForSelector('.sc-table', { timeout: 10000 });
  await sleep(500);
  var cmp = await page.evaluate(function () {
    var m = SplitCompare.model(Engine.run), runs = m.pool.runs;
    return { basis: m.pool.basis, n: runs.length, sources: runs.map(function (r) { return r.source; }), sameRoute: runs.every(function (r) { return r.routeId === Engine.run.routeId; }),
      enough: m.enough, label: m.pool.label, cols: document.querySelectorAll('.sc-table th').length, basisText: (document.querySelector('.sc-basis') || {}).textContent,
      row1: m.rows[0] && m.rows[0].stats, other: PastRunSplits.get('some_other_route', 5, null), none: PastRunSplits.get(null, 5, null),
      stravaSplits: runs.filter(function (r) { return r.source === 'strava'; }).map(function (r) { return r.splits.length + ' km, km1 ' + r.splits[0].timeSec + 's'; }),
      dupIds: runs.map(function (r) { return r.id; }).filter(function (x, i, a) { return a.indexOf(x) !== i; }).length };
  });
  say('INFO  comparison pool: ' + cmp.label + ' sources=' + cmp.sources.join(',') + ' strava splits: ' + cmp.stravaSplits.join(' | '));
  ok(cmp.basis === 'route' && cmp.sameRoute && cmp.n >= 3 && cmp.sources.filter(function (s) { return s === 'strava'; }).length >= 2, 'per-km comparison pool = this route only, includes >= 2 Strava past runs plus the treadmill run', cmp.n + ' runs: ' + cmp.sources.join(','));
  ok(cmp.dupIds === 0, 'no duplicate runs in the pool (treadmill copy wins over its Strava twin)');
  ok(cmp.enough && cmp.row1 && cmp.row1.n >= 3 && cmp.row1.fastest != null && cmp.row1.slowest != null && cmp.row1.medianTime != null && cmp.cols >= 7, 'comparison columns rendered (fastest / slowest / median per km)', 'km1 n=' + (cmp.row1 && cmp.row1.n) + ' cols=' + cmp.cols);
  ok(cmp.other.runs.length === 0 && cmp.none.runs.length === 0 && cmp.none.basis === 'none', 'other route / free run: no comparison pool (same-route-only rule kept)');
  ok(/past runs on this route/.test(cmp.basisText || ''), 'summary says how many past runs on this route', cmp.basisText);
  await shot('11-summary-km-compare');
  ok((await uploads()).length === 0, 'STOP / summary did not upload anything');

  // ───────────────────────── 6. SAVE RUN -> confirm screen -> SAVE TO STRAVA
  await page.click('button:has-text("SAVE RUN")');
  await page.waitForSelector('.sv-up .sv-btn-main', { timeout: 10000 });
  await sleep(2500);
  ok((await uploads()).length === 0, 'confirm screen is up and NOTHING was uploaded before the confirm tap (waited 2.5 s)');
  var card = await page.evaluate(function () { var c = document.querySelector('.sv-up'); return { text: c.innerText.replace(/\s+/g, ' '), btns: [].slice.call(c.querySelectorAll('.sv-btn')).map(function (b) { return b.textContent.trim() + ':' + Math.round(b.getBoundingClientRect().height); }) }; });
  ok(card.btns.length === 2 && /SAVE TO STRAVA/.test(card.btns[0]) && /SKIP/.test(card.btns[1]), 'confirm screen has SAVE TO STRAVA and SKIP', card.btns.join(' '));
  ok(/TREADMILL RUN/.test(card.text) && /VIRTUAL RUN ON ROUTE/.test(card.text), 'default mode treadmill (no GPS) with the virtual-run-on-route option', card.text.slice(0, 160));
  await shot('12-confirm-save-to-strava');
  await page.click('.sv-up .sv-btn-main');
  await page.waitForSelector('.sv-up-status.ok', { timeout: 30000 });
  await shot('13-saved-on-strava');
  var ups = await uploads();
  var f = ups[0] && ups[0].fields || {};
  ok(ups.length === 1, 'mock received exactly ONE upload after SAVE', ups.length);
  ok(f.trainer === '1' && f.data_type === 'tcx' && f.sport_type === 'Run' && /^trailrunner-/.test(f.external_id || ''), 'upload fields: trainer=1, tcx, sport_type=Run, external_id trailrunner-<run id>', JSON.stringify({ trainer: f.trainer, type: f.data_type, sport: f.sport_type, ext: f.external_id, name: f.name }));
  ok(/<Trackpoint>/.test(ups[0].file) && !/<LatitudeDegrees>/.test(ups[0].file), 'TCX has trackpoints and NO GPS positions (treadmill run)');
  var link = await page.evaluate(function () { var a = document.querySelector('.sv-up a.sv-link'); return a ? a.textContent + ' ' + a.href : ''; });
  ok(/View on Strava/.test(link), 'success shows "View on Strava"', link);
  var sm = await page.evaluate(function () { return document.querySelector('.sv-up-status').innerText.replace(/\n/g, ' '); });
  ok(/Saved to Strava/.test(sm), 'status: ' + sm);
  await page.waitForFunction(function () { return !document.querySelector('.sv-up .sv-btn-main'); }, null, { timeout: 3000 }).catch(function () {});
  var closeBtn = await page.$('.sv-up .sv-btn');
  if (closeBtn) await closeBtn.click();
  await page.waitForFunction(function () { return !document.querySelector('.sv-up'); }, null, { timeout: 8000 }).catch(function () {});
  await sleep(500);
  var upMap = await page.evaluate(function () { return JSON.parse(localStorage.getItem('tr_strava_uploaded') || '{}'); });
  ok(Object.keys(upMap).length === 1, 'upload remembered locally (never offered again, never raced twice)', JSON.stringify(upMap));
  ok((await page.evaluate(function () { return !!document.getElementById('setupOverlay') && getComputedStyle(document.getElementById('setupOverlay')).display !== 'none'; })), 'back on Home after save');

  // ───────────────────────── 7. SKIP path: second real run, tap SKIP => nothing uploaded
  await jpost(TM_MOCK + '/mock/reset');
  await page.click('.tile-route');
  await sleep(500);
  await page.click('#runRouteBtn');
  await page.waitForSelector('#fcStart', { state: 'visible' });
  await page.click('#fcStart');
  await page.waitForFunction(function () { return Engine.run && Engine.run.status === 'running'; }, null, { timeout: 10000 });
  for (var j = 0; j < 24; j++) { await page.click('.edge-right .edge-btn.up'); await sleep(50); }
  await page.waitForFunction(function () { return Engine.run.elapsed >= 32 && Engine.run.distanceM >= 115; }, null, { timeout: 120000 });
  var sk = await page.evaluate(function () { return { id: Engine.run.id, d: Engine.run.distanceM, t: Engine.run.elapsed, racers: StravaRacers.active ? StravaRacers.active.racers.length : 0, pool: StravaRacers.active ? StravaRacers.active.pool.length : 0 }; });
  ok(sk.racers === 3, 'second run: race still built (' + sk.pool + ' pooled runs; the just-uploaded run is not raced twice)', JSON.stringify(sk));
  await page.click('#fcStop');
  await page.waitForSelector('button:has-text("SAVE RUN")');
  await page.click('button:has-text("SAVE RUN")');
  await page.waitForSelector('.sv-up .sv-btn-alt', { timeout: 10000 });
  await shot('14-confirm-before-skip');
  await sleep(1500);
  ok((await uploads()).length === 1, 'SKIP path: confirm screen shown, still only the first upload on the mock');
  await page.click('.sv-up .sv-btn-alt');
  await page.waitForFunction(function () { return !document.querySelector('.sv-up'); }, null, { timeout: 8000 });
  await sleep(2500);
  var afterSkip = await uploads();
  var skipped = await page.evaluate(function () { return Object.keys(JSON.parse(localStorage.getItem('tr_strava_skipped') || '{}')).length; });
  ok(afterSkip.length === 1 && skipped === 1, 'SKIP uploaded nothing and was remembered for that run', 'uploads=' + afterSkip.length + ', skipped=' + skipped);
  var queued = await page.evaluate(function () { return StravaUpload.queueLength(); });
  ok(queued === 0, 'SKIP did not queue anything for later');

  // ───────────────────────── 8. free run (no route): route options hidden again
  await page.click('.tile-free');
  await sleep(1000);
  await routelessChecks('free run');
  await shot('15-free-run-no-route');
  // also after re-selecting a route and then deleting it
  await page.evaluate(function () { App.goHome(); });
  await sleep(400);
  await page.evaluate(function () { App.selectRoute('strava_a_9000000001'); });
  await page.waitForFunction(function () { return StravaRacers.active && StravaRacers.active.status.stage === 'done'; }, null, { timeout: 15000 });
  ok(await page.evaluate(function () { return document.querySelectorAll('.sv-dot').length === 3 && document.getElementById('raceBar').offsetHeight > 0; }), 're-selecting the route brings the racers + bar back');
  await page.evaluate(function () { App.deleteRoute('strava_a_9000000001'); });
  await sleep(600);
  await routelessChecks('route deleted');

  // ───────────────────────── 9. Disconnect deletes the Strava-derived data
  await page.evaluate(function () { window.confirm = function () { return true; }; });
  await page.evaluate(function () { App.connectStrava(); });
  await sleep(800);
  var dis = await page.evaluate(function () { return { connected: StravaApi.isConnected(), meta: Object.keys(StravaRoutes.allMeta()).length, routes: Store.getRoutes().filter(function (r) { return /^strava_/.test(r.id); }).length, sk: Object.keys(localStorage).filter(function (k) { return k.indexOf('tr_sk_') === 0; }).length }; });
  ok(!dis.connected && dis.meta === 0 && dis.routes === 0 && dis.sk === 0, 'Disconnect: tokens, Strava route registry, Strava-derived routes and cached streams all deleted', JSON.stringify(dis));

  ok(errors.length === 0, 'no page errors / console errors in the whole run', errors.join(' | '));
  await browser.close();
  say('');
  say(total + ' checks, ' + (total - fails) + ' passed, ' + fails + ' failed');
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  children.forEach(function (c) { try { c.kill(); } catch (e) {} });
  if (strvSrv) strvSrv.close();
  process.exit(fails ? 1 : 0);
})().catch(function (e) {
  say('FATAL ' + (e.stack || e));
  try { fs.writeFileSync(LOG, lines.join('\n') + '\n'); } catch (x) {}
  children.forEach(function (c) { try { c.kill(); } catch (x) {} });
  process.exit(2);
});
