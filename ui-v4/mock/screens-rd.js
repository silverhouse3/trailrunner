#!/usr/bin/env node
// Real-device layout test. Runs the whole screen tour twice:
//   A) viewport 1920x1080 with ?safeBottom=80 — what the X32i's in-app WebView REALLY is: innerHeight 1080,
//      but the ROM paints its 80px nav bar over y=1000..1080, so nothing may end below y=1000;
//   B) viewport 1920x1000 (a window that is genuinely 1000 px tall).
// Both have a 110x110 px top-left zone that the ROM's back-arrow covers.
// For every screen it saves screens/rd-*.png (tour A) / rd1000-*.png (tour B) and asserts that no VISIBLE
// interactive element and no visible text box
//   (a) ends below the usable bottom (1000) or beyond the right edge, or
//   (b) intersects the top-left 110x110 zone.
// Plus a 1920x1080 PC shot (no strip) and a phone shot.
//   node mock/screens-rd.js         (both servers must be running: ./start.sh)
'use strict';
var path = require('path'), fs = require('fs');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.argv[2] || 'http://localhost:8099/';
var MOCK = 'http://localhost:4510';
var OUT = path.resolve(__dirname, '../screens');
var VW = 1920, SAFE = 110;
var fails = [], checks = 0;
var TOUR = { name: '', vh: 1000, usable: 1000, q: '', prefix: 'rd-' }; // set per tour below

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function post(p, body) { return fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); }); }
function ok(cond, name, detail) { checks++; console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : '')); if (!cond) fails.push(name + (detail ? ' ' + detail : '')); }

// Bounding boxes of visible interactive elements (+ brand) AND of every element that carries its own text,
// in viewport px (CSS zoom already applied).
var COLLECT = function () {
  var sel = 'button, a[href], input, select, [onclick], .fm-item, .hrow, .route-card, .wb-card, .vs-fav, .brand, .sp-acc-header, .sv-row';
  var out = [], seen = [];
  var els = Array.prototype.slice.call(document.querySelectorAll(sel));
  // text boxes: elements with a non-empty direct text node (labels, values, notes)
  var all = document.querySelectorAll('body *');
  for (var a = 0; a < all.length; a++) {
    var e = all[a];
    if (/^(SCRIPT|STYLE|CANVAS|SVG|IFRAME)$/.test(e.tagName)) continue;
    var own = '';
    for (var c = 0; c < e.childNodes.length; c++) if (e.childNodes[c].nodeType === 3) own += e.childNodes[c].nodeValue;
    if (own.trim()) els.push(e);
  }
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
  await page.screenshot({ path: path.join(OUT, TOUR.prefix + name + '.png') });
  var boxes = await page.evaluate(COLLECT);
  var vp = page.viewportSize();
  var usable = TOUR.usable;
  // cut off = ends below the usable bottom (ROM bar!) or beyond the right edge, unless inside a scrollable list
  // (a list row crossing the fold is reachable by scrolling)
  var cut = boxes.filter(function (b) { return b.offscreen || ((b.b > usable + 1 || b.r > vp.width + 1) && !b.scrollable); });
  var zone = boxes.filter(function (b) { return b.l < SAFE && b.t < SAFE; });
  var desc = function (b) { return (b.tag + (b.id ? '#' + b.id : '') + (b.cls ? '.' + b.cls.split(' ')[0] : '') + ' "' + b.text + '" ' + Math.round(b.l) + ',' + Math.round(b.t) + '-' + Math.round(b.r) + ',' + Math.round(b.b)); };
  ok(cut.length === 0, TOUR.name + ' ' + name + ': no control/text ends below y=' + usable + ' (viewport ' + vp.width + 'x' + vp.height + ')', cut.map(desc).join(' | '));
  ok(zone.length === 0, TOUR.name + ' ' + name + ': top-left ' + SAFE + 'x' + SAFE + ' zone free of controls/text', zone.map(desc).join(' | '));
  console.log('shot ' + TOUR.prefix + name + ' (' + boxes.length + ' boxes checked)');
}

async function tour(browser, errors) {
  await post('/mock/reset');
  var page = await browser.newPage({ viewport: { width: VW, height: TOUR.vh } });
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && m.text().indexOf('ERR_CONNECTION_REFUSED') < 0) errors.push('console: ' + m.text()); });
  var Q = TOUR.q; // extra query (e.g. &safeBottom=80), remembered per session by App.safeBottom()
  var BASE_Q = function (q) { return BASE + q + Q; };

  await page.goto(BASE_Q('?demo=route'), { waitUntil: 'load' });
  await page.evaluate(function () { localStorage.removeItem('tr_video_favs'); });
  await sleep(1500);
  var rootH = await page.evaluate(function () { return { h: document.getElementById('rootApp').offsetHeight, scale: App._scale, inner: innerHeight, safe: App.safeBottom() }; });
  ok(rootH.h === 1000 && Math.abs(rootH.scale - 1) < 0.001, TOUR.name + ' root ends at y=1000 (innerHeight ' + rootH.inner + ', strip ' + rootH.safe + ')', JSON.stringify(rootH));
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
  // speed nudges via the app API (a click can be intercepted if the belt auto-paused while the mock was still at 0)
  await page.evaluate(function () { if (Engine.run && Engine.run.status === 'paused') App.togglePause(); for (var i = 0; i < 20; i++) App.adjustSpeed(0.5); });
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
  ok(boxes.stop && boxes.stop.b <= TOUR.usable && boxes.ctl.b <= TOUR.usable + 1, 'STOP / run controls end above y=1000', JSON.stringify(boxes.stop));
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
  await page.goto(BASE_Q('stats.html?demo=1'), { waitUntil: 'load' }); await sleep(800);
  await page.goto(BASE_Q('?demo=route'), { waitUntil: 'load' }); await sleep(1200);
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
  await page.goto(BASE_Q('stats.html?demo=1'), { waitUntil: 'load' }); await sleep(1000); await check(page, '15-stats');
  await page.evaluate(function () { openRunDetail(0); }); await sleep(600); await check(page, '16-stats-run-detail');

  await page.close();
}

(async function () {
  var browser = await pw.chromium.launch();
  var errors = [];

  // Tour A: the real X32i — 1920x1080 window, ROM bar painted over y=1000..1080 → ?safeBottom=80
  TOUR = { name: '[1080+strip]', vh: 1080, usable: 1000, q: '&safeBottom=80', prefix: 'rd-' };
  await tour(browser, errors);
  // Tour B: a window that is genuinely 1920x1000 (no strip)
  TOUR = { name: '[1000]', vh: 1000, usable: 1000, q: '&safeBottom=0', prefix: 'rd1000-' };
  await tour(browser, errors);

  // Other viewports still fit: 1920x1080 PC (no strip) and a phone
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
