#!/usr/bin/env node
// Headless UI smoke test (Playwright from /mnt/d/trailrunner/node_modules): picker rows, detail, route overlay,
// racer dots + legend, upload confirm screen. Screenshots -> docs/strava-ui-*.png
//   node mock/strava-ui-smoke.js
'use strict';
var path = require('path'), cp = require('child_process');
var UI = path.resolve(__dirname, '..');
var pw = require(path.resolve(UI, '../node_modules/playwright'));
var mock = require('./strava-mock.js');
var fails = 0;
function ok(c, n, d) { if (!c) fails++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
(async function () {
  var srv = await mock.start(8098);
  var st = cp.spawn('node', [path.join(__dirname, 'static.js')], { env: Object.assign({}, process.env, { PORT: '8197' }), stdio: 'ignore' });
  await new Promise(function (r) { setTimeout(r, 800); });
  var browser = await pw.chromium.launch();
  var page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  page.on('console', function (m) { if (m.type() === 'error' && !/tile|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://localhost:8197/mock/strava-demo.html?strava=localhost:8098');
  await page.evaluate(function () { return demoConnect(); });

  await page.evaluate(function () { StravaPicker.open({}); });
  await page.waitForSelector('.sv-row', { timeout: 8000 });
  var rows = await page.$$eval('.sv-row', function (r) { return r.map(function (e) { return e.getBoundingClientRect().height; }); });
  ok(rows.length === 12 && Math.min.apply(null, rows) >= 72, 'picker lists 12 runs with rows >= 72 px', rows.length + ' rows, min ' + Math.min.apply(null, rows) + ' px');
  var thumbs = await page.$$eval('.sv-thumb', function (c) { return c.filter(function (x) { var d = x.getContext('2d').getImageData(0, 0, x.width, x.height).data; for (var i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }).length; });
  ok(thumbs >= 10, 'thumbnails drawn from summary_polyline', thumbs);
  await page.screenshot({ path: path.join(UI, 'docs/strava-ui-1-picker.png') });
  await page.click('.sv-row >> nth=0');
  await page.waitForSelector('.sv-use', { timeout: 8000 });
  var useH = await page.$eval('.sv-use', function (e) { return e.getBoundingClientRect().height; });
  ok(useH >= 72, 'USE THIS ROUTE button >= 72 px', Math.round(useH));
  await page.screenshot({ path: path.join(UI, 'docs/strava-ui-2-detail.png') });
  await page.click('.sv-tab >> nth=1');
  await page.waitForSelector('.sv-row', { timeout: 8000 });
  ok((await page.$$('.sv-row')).length === 2, 'MY ROUTES tab shows the 2 run routes');
  await page.click('.sv-tab >> nth=0');
  await page.waitForSelector('.sv-row');
  await page.click('.sv-row >> nth=0');
  await page.waitForSelector('.sv-use');
  // local treadmill history so the race has several racers
  await page.evaluate(function () {
    function run(id, start, totalS, D) {
      var tp = [], t0 = Date.parse(start); for (var e = 0; e <= totalS; e += 5) tp.push({ time: new Date(t0 + e * 1000).toISOString(), dist: Math.round(D * e / totalS), hr: 140, elapsed: e });
      return { id: id, routeId: 'strava_a_9000000001', startedAt: start, elapsed: totalS, distanceM: Math.round(D), trackPoints: tp };
    }
    window.DEMO_RUNS = [run('tm1', '2026-10-20T06:30:00Z', 5900, 14255), run('tm2', '2026-10-21T06:30:00Z', 7300, 14255)];
  });
  await page.click('.sv-use');
  try { await page.waitForFunction(function () { return StravaRacers.active && StravaRacers.active.status && StravaRacers.active.status.stage === 'done'; }, null, { timeout: 15000 }); } catch (e) { console.log('DEBUG', JSON.stringify(await page.evaluate(function () { return { a: StravaRacers.active && { st: StravaRacers.active.status, n: StravaRacers.active.pool.length }, errs: window.__errs }; })), errors); throw e; }
  var rc = await page.evaluate(function () { return StravaRacers.racers().map(function (r) { return r.letter + ':' + r.colour; }); });
  ok(rc.length === 3, 'race built from treadmill + Strava runs', rc.join(' '));
  await page.evaluate(function () { StravaRoutes.onTick({ distanceM: 6000, elapsed: 3300 }); StravaRacers.mapLayer.update(3300); StravaRacers.legend.update({ distanceM: 6000, elapsed: 3300 }); StravaRoutes.overlay.setProgress(6000); });
  await page.waitForTimeout(600);
  var dots = await page.$$eval('.sv-dot', function (d) { return d.map(function (e) { return e.textContent; }).join(''); });
  ok(dots === 'FAS', 'map shows lettered dots F, A, S', dots);
  var legend = await page.$eval('.sv-legend', function (e) { return e.innerText.replace(/\n+/g, ' | '); });
  ok(/FASTEST/.test(legend) && /Treadmill/.test(legend) && /Strava/.test(legend) && /[+-]\d+:\d\d/.test(legend), 'legend shows source/date/total time and live gaps', legend);
  var segs = await page.$$eval('#mapDiv .leaflet-stravaGrade-pane path', function (p) { return p.length; });
  ok(segs > 100, 'grade-coloured route line drawn in its own pane', segs + ' segments');
  await page.screenshot({ path: path.join(UI, 'docs/strava-ui-3-map-racers.png') });

  var run = await page.evaluate(function () {
    var t0 = Date.parse('2026-10-22T07:00:00Z'), tp = []; for (var e = 0; e <= 1200; e += 5) tp.push({ time: new Date(t0 + e * 1000).toISOString(), dist: Math.round(e * 2.4), hr: 150, ele: 300, elapsed: e });
    window.__run = { id: 'ui_run_1', routeId: 'strava_a_9000000001', routeName: 'Cleeve Hill Loop', startedAt: '2026-10-22T07:00:00.000Z', finishedAt: new Date(t0 + 1200000).toISOString(), elapsed: 1200, distanceM: 2880, avgHR: 150, maxHR: 168, calories: 300, elevGained: 80, trackPoints: tp };
    window.__p = StravaUpload.promptAfterSave(window.__run); return true;
  });
  await page.waitForSelector('.sv-up .sv-btn-main');
  var bh = await page.$$eval('.sv-up .sv-btn', function (b) { return b.map(function (e) { return e.textContent + ':' + Math.round(e.getBoundingClientRect().height); }); });
  ok(bh.length === 2 && bh[0].indexOf('SAVE TO STRAVA') === 0 && bh[1].indexOf('SKIP') === 0, 'confirm screen has SAVE TO STRAVA and SKIP', bh.join(' '));
  var ups0 = (await (await fetch('http://localhost:8098/mock/uploads')).json()).length;
  ok(ups0 === 0, 'nothing uploaded before the user taps SAVE');
  await page.screenshot({ path: path.join(UI, 'docs/strava-ui-4-confirm.png') });
  await page.click('.sv-up .sv-btn-main');
  try { await page.waitForSelector('.sv-up-status.ok', { timeout: 20000 }); } catch (e) { console.log('DEBUG status:', await page.$eval('.sv-up-status', function (x) { return x.className + ' / ' + x.innerText; }), errors); throw e; }
  await page.screenshot({ path: path.join(UI, 'docs/strava-ui-5-saved.png') });
  var msg = await page.$eval('.sv-up-status', function (e) { return e.innerText.replace(/\n/g, ' '); });
  ok(/Saved to Strava/.test(msg) && /View on Strava/.test(msg), 'success message with View on Strava link', msg);
  ok((await (await fetch('http://localhost:8098/mock/uploads')).json()).length === 1, 'exactly one upload after SAVE');
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close(); st.kill(); srv.close();
  console.log(fails ? fails + ' FAILED' : 'UI smoke: all checks passed');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log('FATAL ' + (e.stack || e)); process.exit(2); });
