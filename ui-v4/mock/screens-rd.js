#!/usr/bin/env node
// Real-device layout test: viewport 1920x1000 (the X32i's in-app WebView; the ROM's 80 px nav bar is
// below the window) with a 110x110 px top-left zone that the ROM's back-arrow covers.
// For every screen it saves screens/rd-*.png and asserts that no VISIBLE interactive element
//   (a) extends beyond the viewport bottom/right, or
//   (b) intersects the top-left 110x110 zone (the brand text is checked too).
// Also takes one shot at 1920x1080 and one at a phone viewport to prove those still fit.
//   node mock/screens-rd.js         (both servers must be running: ./start.sh)
'use strict';
var path = require('path'), fs = require('fs');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.argv[2] || 'http://localhost:8099/';
var MOCK = 'http://localhost:4510';
var OUT = path.resolve(__dirname, '../screens');
var VW = 1920, VH = 1000, SAFE = 110;
var fails = [], checks = 0;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function post(p, body) { return fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); }); }
function ok(cond, name, detail) { checks++; console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : '')); if (!cond) fails.push(name + (detail ? ' ' + detail : '')); }

// Bounding boxes of visible interactive elements (+ brand), in viewport px (CSS zoom already applied).
var COLLECT = function () {
  var sel = 'button, a[href], input, select, [onclick], .fm-item, .hrow, .route-card, .wb-card, .vs-fav, .brand, .sp-acc-header, .sv-row';
  var out = [], seen = [];
  var els = document.querySelectorAll(sel);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (seen.indexOf(el) >= 0) continue; seen.push(el);
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Inside a scrollable container (settings/workouts/stats lists)? Then content below the fold is reachable by
    // scrolling and is not "cut off" — only the container itself must fit, and it is checked separately.
    if (r.width >= 700 && r.height >= 700) continue;                         // full-screen backdrops (tap-to-close overlays), not controls
    var scrollable = document.documentElement.scrollHeight > innerHeight + 2;  // a scrolling page (stats.html) is reachable by scrolling
    var p = el.parentElement;
    while (p && p !== document.body) {
      var pcs = getComputedStyle(p);
      if ((/auto|scroll/.test(pcs.overflowY) || /auto|scroll/.test(pcs.overflow)) && p.scrollHeight > p.clientHeight + 2) { scrollable = true; break; }
      p = p.parentElement;
    }
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth) continue;        // parked off-screen (closed slide-out panels)
    if (r.top >= innerHeight) { if (!scrollable) out.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 40), text: (el.textContent || '').trim().slice(0, 24), l: r.left, t: r.top, r: r.right, b: r.bottom, offscreen: true }); continue; }
    var cx = r.left + r.width / 2, cy = Math.min(innerHeight - 1, r.top + r.height / 2);
    var hit = document.elementFromPoint(cx, cy);
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) continue; // covered by an overlay → not interactive now
    out.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 40), text: (el.textContent || '').trim().slice(0, 24), l: r.left, t: r.top, r: r.right, b: r.bottom, scrollable: scrollable });
  }
  return out;
};

async function check(page, name) {
  await sleep(250);
  await page.screenshot({ path: path.join(OUT, 'rd-' + name + '.png') });
  var boxes = await page.evaluate(COLLECT);
  var vp = page.viewportSize();
  // cut off = sticks out of the viewport while not being inside a scrollable list (a list row crossing the fold is fine)
  var cut = boxes.filter(function (b) { return b.offscreen || ((b.b > vp.height + 1 || b.r > vp.width + 1) && !b.scrollable); });
  var zone = boxes.filter(function (b) { return b.l < SAFE && b.t < SAFE; });
  var desc = function (b) { return (b.tag + (b.id ? '#' + b.id : '') + (b.cls ? '.' + b.cls.split(' ')[0] : '') + ' "' + b.text + '" ' + Math.round(b.l) + ',' + Math.round(b.t) + '-' + Math.round(b.r) + ',' + Math.round(b.b)); };
  ok(cut.length === 0, name + ': no interactive element cut off at ' + vp.width + 'x' + vp.height, cut.map(desc).join(' | '));
  ok(zone.length === 0, name + ': top-left ' + SAFE + 'x' + SAFE + ' zone free of controls/text', zone.map(desc).join(' | '));
  console.log('shot rd-' + name + ' (' + boxes.length + ' interactive elements checked)');
}

(async function () {
  await post('/mock/reset');
  var browser = await pw.chromium.launch();
  var page = await browser.newPage({ viewport: { width: VW, height: VH } });
  var errors = [];
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && m.text().indexOf('ERR_CONNECTION_REFUSED') < 0) errors.push('console: ' + m.text()); });

  await page.goto(BASE + '?demo=route', { waitUntil: 'load' });
  await page.evaluate(function () { localStorage.removeItem('tr_video_favs'); });
  await sleep(1500);
  var rootH = await page.evaluate(function () { return { h: document.getElementById('rootApp').offsetHeight, scale: App._scale, inner: innerHeight }; });
  ok(rootH.h === 1000 && Math.abs(rootH.scale - 1) < 0.001, 'root height follows the 1000 px window (no fixed 1080)', JSON.stringify(rootH));
  await check(page, '01-home');

  // Routes picker + workouts + settings from Home
  await page.click('.tile-route'); await sleep(500); await check(page, '02-routes');
  await page.click('#runRouteBtn'); await sleep(1500); await check(page, '03-live-ready-route');
  await page.evaluate(function () { App.goHome(); }); await sleep(400);
  await page.click('.tile-workout'); await sleep(600); await check(page, '04-workouts');
  await page.evaluate(function () { WorkoutBuilder.close(); App.openSettings(); }); await sleep(600); await check(page, '05-settings');
  await page.evaluate(function () { SettingsPanel.close(); });

  // Live run on the route with a synthetic 4-racer race bar
  await page.click('.tile-route'); await sleep(400); await page.click('#runRouteBtn'); await sleep(1200);
  await page.click('#fcStart'); await sleep(1200);
  for (var i = 0; i < 20; i++) { await page.click('.edge-right .edge-btn.up'); await sleep(40); }
  await sleep(4000);
  var raceOk = await page.evaluate(function () {
    if (typeof StravaRacers === 'undefined' || !Engine.route) return 'no StravaRacers';
    var mk = function (id, label, letter, colour, total) { return { id: id, label: label, letter: letter, colour: colour, legend: 'synthetic ' + label, totalS: total, source: 'test', d: [0, Engine.route.totalDistM || 9000], t: [0, total] }; };
    StravaRacers.active = { routeId: Engine.route.id, route: Engine.route, pool: [], status: { stage: 'done' },
      racers: [mk('fastest', 'FASTEST', 'F', '#3ee89f', 2400), mk('average', 'AVERAGE', 'A', '#ffd54a', 3000), mk('slowest', 'SLOWEST', 'S', '#ff8a8a', 3600), mk('last', 'LAST', 'L', '#b58cff', 3200)] };
    StravaRacers.legend.render();
    return document.querySelectorAll('#raceBar .sv-chip').length;
  });
  ok(raceOk === 5, 'race bar rendered with 4 racers + YOU', String(raceOk));
  await sleep(600);
  await page.evaluate(function () { document.querySelectorAll('.milestone-popup').forEach(function (p) { p.classList.remove('show'); }); });
  await check(page, '06-running-race-bar-4-racers');
  var boxes = await page.evaluate(function () {
    var R = function (s) { var e = document.querySelector(s); if (!e) return null; var r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, h: r.height }; };
    return { bar: R('#raceBar'), strip: R('.metric-strip'), ctl: R('.run-controls'), zone: R('.map-zone'), elev: R('#elevStrip'), stop: R('#fcStop') };
  });
  ok(boxes.bar && boxes.bar.h > 0 && boxes.bar.t >= boxes.strip.b - 1 && boxes.bar.b <= boxes.zone.t + 1, 'race bar sits between metric strip and view zone (no overlap)', JSON.stringify(boxes.bar));
  ok(boxes.stop && boxes.stop.b <= VH && boxes.ctl.b <= VH + 1, 'STOP / run controls fully inside 1000 px', JSON.stringify(boxes.stop));
  ok(boxes.zone && boxes.zone.h >= 300, 'view zone keeps >= 300 px with race bar + elevation strip', 'zone h=' + Math.round(boxes.zone.h));

  // Video window open (default position) + presets + more stats
  await page.evaluate(function () { VideoWin.open(); }); await sleep(500); await check(page, '07-running-video-window');
  await page.evaluate(function () { VideoWin.close(); App.toggleMoreStats(); App.toggleQS('speed'); }); await sleep(500); await check(page, '08-running-more-stats-presets');
  await page.evaluate(function () { App.toggleMoreStats(); App.toggleQS('speed'); App.toggleFocusMenu(); }); await sleep(500); await check(page, '09-menu');
  await page.evaluate(function () { App.closeFocusMenu(); App.openHistory(); }); await sleep(400); await check(page, '10-ghost-history');
  await page.evaluate(function () { App.closeHistory(); App.toggleSplits(); }); await sleep(400); await check(page, '11-splits-panel');
  await page.evaluate(function () { App.toggleSplits(); App.togglePause(); }); await sleep(1200); await check(page, '12-paused');
  await page.evaluate(function () { App.togglePause(); }); await sleep(1500);
  await page.evaluate(function () { App.startCooldown(); }); await sleep(1200); await check(page, '13-cooldown');
  await page.evaluate(function () { App.skipCooldown(); }); await sleep(800);

  // Summary with km splits (fast-forwarded) + comparison vs demo runs
  await page.evaluate(function () { StravaRacers.legend.hide(); StravaRacers.active = null; });
  await page.goto(BASE + 'stats.html?demo=1', { waitUntil: 'load' }); await sleep(800);
  await page.goto(BASE + '?demo=route', { waitUntil: 'load' }); await sleep(1200);
  await page.click('.tile-route'); await sleep(400); await page.click('#runRouteBtn'); await sleep(1200);
  await page.click('#fcStart'); await sleep(2500);
  await page.evaluate(function () {
    var r = Engine.run; r.distanceM = 3420; r.elapsed = 1085;
    r.splits = [{ km: 1, timeSec: 322, avgHR: 139, elapsed: 322 }, { km: 2, timeSec: 305, avgHR: 151, elapsed: 627 }, { km: 3, timeSec: 338, avgHR: 158, elapsed: 965 }];
    r._lastSplitElapsed = 965; r._lastSplitKm = 3; r._splitHRSum = 6400; r._splitHRSamples = 40;
    App.finishRun(); document.querySelectorAll('.milestone-popup').forEach(function (p) { p.classList.remove('show'); });
  });
  await sleep(1200);
  await check(page, '14-summary-km-splits');
  await page.evaluate(function () { App.discardRun(); }); await sleep(600);

  // Stats page (zoomed body) + run detail
  await page.goto(BASE + 'stats.html?demo=1', { waitUntil: 'load' }); await sleep(1000); await check(page, '15-stats');
  await page.evaluate(function () { openRunDetail(0); }); await sleep(600); await check(page, '16-stats-run-detail');

  // Other viewports still fit: 1920x1080 (PC) and a phone
  var pc = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await pc.goto(BASE, { waitUntil: 'load' }); await sleep(1200);
  var pcH = await pc.evaluate(function () { return document.getElementById('rootApp').offsetHeight; });
  ok(pcH === 1080, '1920x1080 window: root fills 1080 px', String(pcH));
  await pc.screenshot({ path: path.join(OUT, 'rd-17-home-1920x1080.png') }); console.log('shot rd-17-home-1920x1080');
  await pc.close();
  var phone = await browser.newPage({ viewport: { width: 412, height: 915 } });
  await phone.goto(BASE, { waitUntil: 'load' }); await sleep(1200);
  var ph = await phone.evaluate(function () { var r = document.getElementById('rootApp').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), scale: App._scale }; });
  ok(ph.w <= 412 && ph.h <= 915, 'phone 412x915: whole UI fits (letterboxed)', JSON.stringify(ph));
  await phone.screenshot({ path: path.join(OUT, 'rd-18-home-phone.png') }); console.log('shot rd-18-home-phone');
  await phone.close();

  await browser.close();
  await post('/mock/reset');
  ok(errors.length === 0, 'no page errors / console errors', errors.join(' | '));
  console.log('\n' + checks + ' checks, ' + (checks - fails.length) + ' passed, ' + fails.length + ' failed');
  if (fails.length) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch(function (e) { console.error(e); process.exit(1); });
