#!/usr/bin/env node
// Headless walkthrough of ui-v4 against the mock bridge. Saves 1920x1080 PNGs to ui-v4/screens/.
// Requires the repo's Playwright (node_modules in /mnt/d/trailrunner). Both servers must be running (start.sh).
//   node mock/screens.js [baseUrl]
'use strict';
var path = require('path');
var fs = require('fs');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.argv[2] || 'http://localhost:8099/';
var MOCK = 'http://localhost:4510';
var OUT = path.resolve(__dirname, '../screens');
var GPX = process.env.GPX || path.resolve(__dirname, 'sample.gpx');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function post(p, body) {
  return fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
}

(async function () {
  await post('/mock/reset');
  var browser = await pw.chromium.launch();
  var VPH = parseInt(process.env.VIEWPORT_H || '1000', 10); // 1000 = the X32i in-app WebView (primary target); VIEWPORT_H=1080 for the PC
  var page = await browser.newPage({ viewport: { width: 1920, height: VPH } });
  var errors = [];
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && m.text().indexOf('ERR_CONNECTION_REFUSED') < 0 /* the bridge-down START step probes a dead port on purpose */) errors.push('console: ' + m.text() + (m.location && m.location().url ? ' @ ' + m.location().url : '')); });
  async function shot(name) { await sleep(300); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('shot', name); }

  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(function () { localStorage.clear(); });
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  await shot('01-home');

  // Free run → ready
  await page.click('.tile-free');
  await sleep(900);
  await shot('02-free-run-ready');

  // START → running, nudge speed
  await page.click('#fcStart');
  await sleep(1200);
  for (var i = 0; i < 16; i++) { await page.click('.edge-right .edge-btn.up'); await sleep(60); }
  for (var j = 0; j < 4; j++) { await page.click('.edge-left .edge-btn.up'); await sleep(60); }
  await sleep(6000);
  await shot('03-running-free');

  // More stats + presets
  await page.click('.metric-strip');
  await page.click('.edge-right .edge-val');
  await sleep(500);
  await shot('04-running-more-stats-presets');
  await page.click('.edge-right .edge-val');
  await page.click('.metric-strip');

  // Menu
  await page.evaluate(function () { App.toggleFocusMenu(); });
  await sleep(500);
  await shot('05-menu');
  await page.evaluate(function () { App.closeFocusMenu(); });

  // Pause
  await page.click('#fcPause');
  await sleep(1500);
  await shot('06-paused');
  await page.evaluate(function () { App.togglePause(); });
  await sleep(1500);

  // Safety key out
  await post('/mock/safety-key', { out: true });
  await sleep(2500);
  await shot('07-safety-key-out');
  await post('/mock/safety-key', { out: false });
  await sleep(1500);

  // Stop → summary
  await page.evaluate(function () { App.togglePause(); });
  await sleep(800);
  await page.evaluate(function () { App.finishRun(); });
  await sleep(1200);
  await shot('08-summary');
  await page.evaluate(function () { App.discardRun(); });
  await sleep(600);

  // Routes: import GPX, pick, run
  await page.click('.tile-route');
  await sleep(500);
  await shot('09-routes-empty');
  if (fs.existsSync(GPX)) {
    await page.setInputFiles('#gpxFileInput', GPX);
    await sleep(800);
    await shot('10-routes-picked');
    await page.click('#runRouteBtn');
    await sleep(1500);
    await shot('11-route-ready');
    await page.click('#fcStart');
    await sleep(1200);
    for (var k = 0; k < 18; k++) { await page.click('.edge-right .edge-btn.up'); await sleep(50); }
    await sleep(8000);
    await shot('12-route-running-map');
    await page.evaluate(function () { App.setMapStyle('track'); });
    await sleep(1200);
    await shot('13-route-running-trackview');
    await page.evaluate(function () { App.startCooldown(); });
    await sleep(1500);
    await shot('14-cooldown');
    await page.evaluate(function () { App.skipCooldown(); });
    await sleep(1500);
    await page.evaluate(function () { App.discardRun(); });
    await sleep(600);
  } else {
    await page.evaluate(function () { App.closeRoutes(); });
  }

  // Workouts
  await page.click('.tile-workout');
  await sleep(700);
  await shot('15-workouts');
  var card = await page.$('.wb-card');
  if (card) {
    await card.click();
    await sleep(1200);
    await shot('16-workout-armed');
    await page.click('#fcStart');
    await sleep(7000);
    await shot('17-workout-running-oval');
    await page.evaluate(function () { App.finishRun(); });
    await sleep(800);
    await page.evaluate(function () { App.discardRun(); });
    await sleep(600);
  }

  // Settings
  await page.evaluate(function () { App.openSettings(); });
  await sleep(700);
  await shot('18-settings');
  await page.evaluate(function () { SettingsPanel.close(); });

  // Ghost / history
  await page.evaluate(function () { App.openHistory(); });
  await sleep(500);
  await shot('19-ghost-history');
  await page.evaluate(function () { App.closeHistory(); });

  // Bridge offline state (point the page at a port where nothing listens)
  await page.goto(BASE + '?bridge=127.0.0.1:4599', { waitUntil: 'load' });
  await sleep(800);
  await page.click('.tile-free');
  await sleep(600);
  await shot('20-no-treadmill');

  // ── Round 2: no-route live screen + menu (route-only options removed) ──
  await page.goto(BASE + '?demo=noroute', { waitUntil: 'load' });
  await sleep(800);
  await page.click('.tile-free');
  await sleep(800);
  await page.evaluate(function () { var q = document.getElementById('qsSpeed'); if (q) q.classList.remove('open'); });
  await sleep(300);
  await shot('21-noroute-live-views');
  await page.evaluate(function () { App.toggleFocusMenu(); });
  await sleep(400);
  await shot('22-noroute-menu');
  await page.evaluate(function () { App.closeFocusMenu(); App.setMapStyle('numbers'); });
  await page.click('#fcStart');
  await sleep(1200);
  for (var n = 0; n < 14; n++) { await page.click('.edge-right .edge-btn.up'); await sleep(50); }
  await sleep(5000);
  await shot('23-noroute-big-numbers');

  // Video window on the live screen (no autoplay: setup panel first)
  await page.evaluate(function () { App.setMapStyle('oval'); VideoWin.open(); });
  await sleep(500);
  await shot('24-video-setup');
  await page.evaluate(function () { VideoWin.play('dQw4w9WgXcQ'); });
  await sleep(4000);
  await shot('25-video-embed');
  // move + shrink it, then show the fallback panel
  await page.evaluate(function () { VideoWin._pos.x = 240; VideoWin._pos.y = 300; VideoWin._pos.w = 480; VideoWin._pos.h = 330; VideoWin._clamp(); VideoWin._apply(); VideoWin.showFallback('dQw4w9WgXcQ'); });
  await sleep(500);
  await shot('26-video-fallback-moved');
  await page.evaluate(function () { VideoWin.minimise(); });
  await sleep(300);
  await shot('27-video-minimised');
  await page.evaluate(function () { VideoWin.close(); App.finishRun(); });
  await sleep(800);
  await page.evaluate(function () { App.discardRun(); });
  await sleep(500);

  // ── Round 2: position dot — route loaded via ?demo=route, zoomed-in map, follow toggle ──
  await page.goto(BASE + '?demo=route', { waitUntil: 'load' });
  await sleep(1500);
  await page.click('.tile-route');
  await sleep(500);
  await page.click('#runRouteBtn');
  await sleep(1500);
  await page.click('#fcStart');
  await sleep(1200);
  for (var q = 0; q < 24; q++) { await page.click('.edge-right .edge-btn.up'); await sleep(40); }
  await sleep(12000);
  await page.evaluate(function () { MapView.map.setZoom(16); });
  await sleep(1500);
  await shot('28-route-map-position-dot');
  await page.evaluate(function () { MapView.setFollow(false); });
  await sleep(300);
  await shot('29-route-map-follow-off');
  await page.evaluate(function () { MapView.setFollow(true); App.setMapStyle('track'); document.querySelectorAll('.milestone-popup').forEach(function (p) { p.classList.remove('show'); }); });
  await sleep(1200);
  await shot('30-route-trailview-dot');
  await page.evaluate(function () { App.setMapStyle('oval'); });
  await sleep(1200);
  await shot('31-route-oval-dot');
  await page.evaluate(function () { App.setMapStyle('video'); });
  await sleep(1200);
  await shot('32-route-video-view');
  await page.evaluate(function () { App.finishRun(); });
  await sleep(800);
  await page.evaluate(function () { App.discardRun(); });
  await sleep(500);

  // ── Round 3: stats.html with demo data (seeded on the active route), run detail, phone width ──
  await page.goto(BASE + 'stats.html?demo=1', { waitUntil: 'load' });
  await sleep(1200);
  await shot('33-stats-top');
  await page.screenshot({ path: path.join(OUT, '34-stats-full-page.png'), fullPage: true });
  console.log('shot 34-stats-full-page (full page)');
  await page.evaluate(function () { openRunDetail(0); });
  await sleep(600);
  await shot('35-stats-run-detail');
  var phone = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await phone.goto(BASE + 'stats.html', { waitUntil: 'load' });
  await sleep(1000);
  await phone.screenshot({ path: path.join(OUT, '36-stats-phone.png'), fullPage: false });
  console.log('shot 36-stats-phone');
  await phone.close();

  // ── Round 3: run-end km split comparison (route run vs 9 demo runs on the same route) ──
  await page.goto(BASE + '?demo=route', { waitUntil: 'load' });
  await sleep(1200);
  await page.click('.tile-route');
  await sleep(500);
  await page.click('#runRouteBtn');
  await sleep(1200);
  await page.click('#fcStart');
  await sleep(1200);
  for (var w = 0; w < 24; w++) { await page.click('.edge-right .edge-btn.up'); await sleep(40); }
  await sleep(6000);
  // Fast-forward: pretend 3.42 km were run (the real split logic needs ~10 minutes of belt time per km)
  await page.evaluate(function () {
    var r = Engine.run; r.distanceM = 3420; r.elapsed = 1085;
    r.splits = [
      { km: 1, timeSec: 322, paceSecPerKm: 322, avgHR: 139, elapsed: 322, negativeSplit: false },
      { km: 2, timeSec: 305, paceSecPerKm: 305, avgHR: 151, elapsed: 627, negativeSplit: true },
      { km: 3, timeSec: 338, paceSecPerKm: 338, avgHR: 158, elapsed: 965, negativeSplit: false },
    ];
    r._lastSplitElapsed = 965; r._lastSplitKm = 3; r._splitHRSum = 160 * 40; r._splitHRSamples = 40;
    App.finishRun();
  });
  await sleep(1200);
  await page.evaluate(function () { document.querySelectorAll('.milestone-popup').forEach(function (p) { p.classList.remove('show'); }); });
  await shot('37-summary-km-splits');
  // SAVE RUN → home, then the saved run (with finalSplit) is first in stats history
  await page.evaluate(function () { App.saveAndNewRun(); });
  await sleep(800);
  await shot('38-after-save-home');
  await page.goto(BASE + 'stats.html#run-0', { waitUntil: 'load' });
  await sleep(1000);
  await shot('39-stats-saved-run-detail');
  // DISCARD flow still works: start, finish, discard → home
  await page.goto(BASE, { waitUntil: 'load' });
  await sleep(1000);
  await page.click('.tile-free');
  await sleep(600);
  await page.click('#fcStart');
  await sleep(2500);
  await page.evaluate(function () { App.finishRun(); });
  await sleep(800);
  await page.evaluate(function () { App.discardRun(); });
  await sleep(600);
  var onHome = await page.evaluate(function () { return document.getElementById('setupOverlay').style.display !== 'none' && TM.workoutState; });
  console.log('discard → home, bridge state:', onHome);

  await browser.close();
  await post('/mock/reset');
  console.log('\nERRORS (' + errors.length + '):');
  errors.forEach(function (e) { console.log('  ' + e); });
})().catch(function (e) { console.error(e); process.exit(1); });
