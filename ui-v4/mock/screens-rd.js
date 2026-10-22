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


// ── STOP RULE + ribbon: a visible, un-overlapped STOP must exist in every live layout/overlay; a tap sends speed 0 ──
var STOP_PROBE = function () {
  var cands = ['#fcStop', '#topStop', '#liveRibbon .rb-stop', '#vvStrip .rb-stop', '.pause-overlay.show .fc-stop', '.cooldown-overlay.show .fc-stop'];
  var found = [];
  cands.forEach(function (sel) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var e = els[i], r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') continue;
      var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (h && (h === e || e.contains(h))) found.push({ sel: sel, t: r.top, b: r.bottom, l: r.left, r: r.right, h: r.height });
    }
  });
  return found;
};
var RIBBON_PROBE = function () {
  // speed / distance / time must be visible somewhere, un-overlapped (metric strip, big numbers, video tiles or the ribbon)
  var groups = [['#spVal', '#distVal', '#timerEl'], ['#bnSpeed', '#bnDist', '#bnTime'], ['#vvSpeed', '#vvDist', '#vvTime'], ['#liveRibbon [data-rb=speed]', '#liveRibbon [data-rb=dist]', '#liveRibbon [data-rb=time]'], ['#vvStrip [data-rb=speed]', '#vvStrip [data-rb=dist]', '#vvStrip [data-rb=time]'], ['.edge-right #bigSpeedVal', '#distVal', '#timerEl']];
  var vis = function (sel) { var e = document.querySelector(sel); if (!e) return false; var r = e.getBoundingClientRect(); if (!r.width || !r.height || r.bottom > innerHeight || r.top < 0) return false; var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(h && (h === e || e.contains(h) || h.contains(e))); };
  for (var g = 0; g < groups.length; g++) if (groups[g].every(vis)) return groups[g].join(',');
  return null;
};
async function stopCheck(page, name, usable) {
  var found = await page.evaluate(STOP_PROBE);
  var okB = found.length > 0 && found.every(function (f) { return f.b <= usable + 1 && f.r <= 1921; });
  ok(okB, TOUR.name + ' ' + name + ': a visible un-overlapped STOP exists (' + found.map(function (f) { return f.sel + ' h=' + Math.round(f.h); }).join(' | ') + ')', found.length ? '' : 'none found');
  var rib = await page.evaluate(RIBBON_PROBE);
  ok(!!rib, TOUR.name + ' ' + name + ': SPEED / DISTANCE / TIME visible and un-overlapped', rib || 'not visible');
}
async function stopTap(page, name) {
  // tap the first visible STOP and verify the mock bridge received speed 0 at once
  var before = await fetch(MOCK + '/mock/state').then(function (r) { return r.json(); });
  var n0 = before.log.filter(function (l) { return /speed → 0\.0/.test(l); }).length;
  var tapped = await page.evaluate(function () { var sels = ['#liveRibbon .rb-stop', '#vvStrip .rb-stop', '.pause-overlay.show .fc-stop', '#topStop', '#fcStop']; for (var i = 0; i < sels.length; i++) { var e = document.querySelector(sels[i]); if (e && e.offsetWidth) { var r = e.getBoundingClientRect(); var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (h && (h === e || e.contains(h))) { e.click(); return sels[i]; } } } return null; });
  await sleep(700);
  var after = await fetch(MOCK + '/mock/state').then(function (r) { return r.json(); });
  var n1 = after.log.filter(function (l) { return /speed → 0\.0/.test(l); }).length;
  ok(!!tapped && n1 > n0 && after.sim.targetKph === 0, TOUR.name + ' ' + name + ': tapping ' + tapped + ' sent speed 0 to the bridge immediately', 'targetKph=' + after.sim.targetKph + ' speed0 log ' + n0 + '→' + n1);
}

async function check(page, name) {
  await sleep(250);
  await page.screenshot({ path: path.join(OUT, TOUR.prefix + name + '.png') });
  var boxes = await page.evaluate(COLLECT);
  var vp = page.viewportSize();
  var usable = TOUR.usable;
  // cut off = ends below the usable bottom (ROM bar!) or beyond the right edge, unless inside a scrollable list
  // (a list row crossing the fold is reachable by scrolling)
  var cut = boxes.filter(function (b) { return b.offscreen || ((b.b > usable + 1 || b.r > vp.width + 1) && !b.scrollable); });
  var zone = TOUR.zone === false ? [] : boxes.filter(function (b) { return b.l < SAFE && b.t < SAFE; });
  var desc = function (b) { return (b.tag + (b.id ? '#' + b.id : '') + (b.cls ? '.' + b.cls.split(' ')[0] : '') + ' "' + b.text + '" ' + Math.round(b.l) + ',' + Math.round(b.t) + '-' + Math.round(b.r) + ',' + Math.round(b.b)); };
  ok(cut.length === 0, TOUR.name + ' ' + name + ': no control/text ends below y=' + usable + ' (viewport ' + vp.width + 'x' + vp.height + ')', cut.map(desc).join(' | '));
  ok(zone.length === 0, TOUR.name + ' ' + name + ': top-left ' + SAFE + 'x' + SAFE + ' zone free of controls/text' + (TOUR.zone === false ? ' (n/a: pane starts at x=960)' : ''), zone.map(desc).join(' | '));
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
  await stopCheck(page, '06-running', TOUR.usable);
  var boxes = await page.evaluate(function () {
    var R = function (s) { var e = document.querySelector(s); if (!e) return null; var r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, h: r.height }; };
    return { bar: R('#raceBar'), strip: R('.metric-strip'), ctl: R('.run-controls'), zone: R('.map-zone'), elev: R('#elevStrip'), stop: R('#fcStop') };
  });
  ok(boxes.bar && boxes.bar.h > 0 && boxes.bar.t >= boxes.strip.b - 1 && boxes.bar.b <= boxes.zone.t + 1, 'race bar sits between metric strip and view zone (no overlap)', JSON.stringify(boxes.bar));
  ok(boxes.stop && boxes.stop.b <= TOUR.usable && boxes.ctl.b <= TOUR.usable + 1, 'STOP / run controls end above y=1000', JSON.stringify(boxes.stop));
  ok(boxes.zone && boxes.zone.h >= 300, 'view zone keeps >= 300 px with race bar + elevation strip', 'zone h=' + Math.round(boxes.zone.h));

  // ── Split VIDEO view (YouTube left, tiles right) with the race bar present; embed = local stub (?ytStub=1) ──
  var VV_GUARD = function () {
    // STOP / PAUSE / edge controls must be the top-most element at their centre (not covered by the video pane)
    var ids = ['#fcStop', '#fcPause', '.edge-left .edge-btn.up', '.edge-left .edge-btn.down', '.edge-right .edge-btn.up', '.edge-right .edge-btn.down', '#stateBanner'];
    var bad = [];
    ids.forEach(function (sel) { var e = document.querySelector(sel); if (!e) { bad.push(sel + ' missing'); return; } var r = e.getBoundingClientRect(); var h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!h || !(h === e || e.contains(h))) bad.push(sel + ' covered by ' + (h ? h.tagName + '.' + h.className : 'nothing')); });
    var zone = document.querySelector('.map-zone').getBoundingClientRect(), left = document.querySelector('.vv-left').getBoundingClientRect();
    var fr = document.querySelector('.vv-frame').getBoundingClientRect();
    return { bad: bad, paneFrac: left.width / zone.width, frameFrac: fr.width / zone.width, frameAspect: fr.width / fr.height, mode: document.getElementById('videoSplitPanel').className };
  };
  await page.evaluate(function () { App.setMapStyle('video'); localStorage.removeItem('tr_yt_favs'); localStorage.removeItem('tr_yt_recent'); localStorage.removeItem('tr_yt_last'); VideoView.stop(false); });
  await sleep(500);
  await check(page, '06b-video-empty-race-bar');
  var g = await page.evaluate(VV_GUARD);
  ok(g.bad.length === 0, TOUR.name + ' video view: STOP/PAUSE/edge controls/state banner not covered', g.bad.join(', '));
  ok(g.paneFrac >= 0.45, TOUR.name + ' video pane is >= 45% of the view zone width', (g.paneFrac * 100).toFixed(1) + '% (16:9 frame ' + (g.frameFrac * 100).toFixed(1) + '%, aspect ' + g.frameAspect.toFixed(2) + ')');
  await page.evaluate(function () { VideoView.play({ type: 'video', id: 'dQw4w9WgXcQ' }); });
  await page.waitForFunction(function () { return VideoView.ready; }, null, { timeout: 8000 }).catch(function () {});
  var st1 = await page.evaluate(function () { return { ready: VideoView.ready, native: VideoView.native, state: VideoView.playerState, pe: VideoView.iframe && VideoView.iframe.style.pointerEvents }; });
  ok(st1.ready && !st1.native && st1.pe === 'none', TOUR.name + ' stub player answered the postMessage channel (big buttons active, iframe taps disabled)', JSON.stringify(st1));
  await page.evaluate(function () { VideoView.togglePlay(); });
  await page.waitForFunction(function () { return VideoView.playerState === 1; }, null, { timeout: 4000 }).catch(function () {});
  await page.evaluate(function () { VideoView.volumeBy(-10); VideoView.toggleMute(); }); // (changing the volume un-mutes by design, so mute last)
  await sleep(600);
  var st2 = await page.evaluate(function () { return { state: VideoView.playerState, muted: VideoView.muted, vol: VideoView.volume, play: document.getElementById('vvPlay').textContent, mute: document.getElementById('vvMute').textContent, title: document.getElementById('vvTitle').textContent, belt: TM.workoutState, tgt: Engine.ctrl.targetSpeed }; });
  ok(st2.state === 1 && /PAUSE/.test(st2.play) && st2.muted && /UNMUTE/.test(st2.mute) && st2.vol === 90, TOUR.name + ' PLAY → playing, VOL− → 90, MUTE → muted', JSON.stringify(st2));
  ok(st2.belt === 'RUNNING' && st2.tgt === 10, TOUR.name + ' video controls did not touch the belt (bridge still RUNNING, target unchanged)', st2.belt + ' ' + st2.tgt);
  await check(page, '06c-video-playing-race-bar');
  await stopCheck(page, '06c-video', TOUR.usable);
  var g2 = await page.evaluate(VV_GUARD);
  ok(g2.bad.length === 0, TOUR.name + ' video playing: STOP/PAUSE/edge controls still on top', g2.bad.join(', '));
  // playlist: PREV/NEXT appear and work
  await page.evaluate(function () { VideoView.play({ type: 'playlist', id: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' }); });
  await page.waitForFunction(function () { return VideoView.ready; }, null, { timeout: 8000 }).catch(function () {});
  await page.evaluate(function () { VideoView.next(); });
  await sleep(500);
  var pl = await page.evaluate(function () { return { next: document.getElementById('vvNext').style.display, idx: VideoView._playlistIndex, title: document.getElementById('vvTitle').textContent }; });
  ok(pl.next !== 'none' && pl.idx === 1, TOUR.name + ' playlist: NEXT/PREV shown, NEXT advanced to item 2', JSON.stringify(pl));
  // favourites + recent persisted
  await page.evaluate(function () { VideoView.saveFav(0); });
  await sleep(200);
  await page.evaluate(function () { var i = document.querySelector('.ui-dlg-input'); if (i) { i.value = 'Trail playlist'; document.querySelector('.ui-dlg-ok').click(); } });
  await sleep(200);
  var fav = await page.evaluate(function () { return { favs: VideoView.getFavs().filter(Boolean).length, label: VideoView.getFavs()[0].label, recent: VideoView.getRecent().length, last: !!VideoView.getLast() }; });
  ok(fav.favs === 1 && fav.label === 'Trail playlist' && fav.recent === 2 && fav.last, TOUR.name + ' favourite slot saved with label; recent + resume remembered', JSON.stringify(fav));
  // failed embed (uploader disabled embedding → onError 101)
  await page.evaluate(function () { VideoView.play({ type: 'video', id: 'FAIL101xxxx' }); });
  await page.waitForFunction(function () { return /mode-fail/.test(document.getElementById('videoSplitPanel').className); }, null, { timeout: 8000 }).catch(function () {});
  await sleep(300);
  var fl = await page.evaluate(function () { return { mode: document.getElementById('videoSplitPanel').className, msg: document.getElementById('vvFailMsg').textContent, favs: document.querySelectorAll('#vvFavsFail .vv-fav').length, iframe: !!VideoView.iframe }; });
  ok(/mode-fail/.test(fl.mode) && /cannot be played here/.test(fl.msg) && fl.favs === 6 && !fl.iframe, TOUR.name + ' failed embed → large message + favourites, no blank pane', JSON.stringify(fl));
  await check(page, '06d-video-failed-embed');
  await page.evaluate(function () { VideoView.stop(false); App.setMapStyle('terrain'); });

  // Video window open (default position) + presets + more stats
  await page.evaluate(function () { VideoWin.open(); }); await sleep(500); await check(page, '07-running-video-window');
  await page.evaluate(function () { VideoWin.close(); App.toggleMoreStats(); App.toggleQS('speed'); }); await sleep(500); await check(page, '08-running-more-stats-presets');
  await page.evaluate(function () { App.toggleMoreStats(); App.toggleQS('speed'); App.toggleFocusMenu(); }); await sleep(500); await check(page, '09-menu');
  await page.evaluate(function () { App.closeFocusMenu(); App.openSettings(); }); await sleep(400); await check(page, '09b-settings-while-running'); await stopCheck(page, '09b-settings-while-running', TOUR.usable);
  await page.evaluate(function () { SettingsPanel.close(); App.openHistory(); }); await sleep(400); await check(page, '10-ghost-history');
  await page.evaluate(function () { App.closeHistory(); App.toggleSplits(); }); await sleep(400); await check(page, '11-splits-panel');
  await page.evaluate(function () { App.toggleSplits(); App.togglePause(); }); await sleep(1200); await check(page, '12-paused');
  await page.evaluate(function () { App.togglePause(); }); await sleep(1500);
  await page.evaluate(function () { App.toggleFocusMenu(); }); await sleep(300);
  await stopTap(page, 'menu-open-ribbon-STOP');
  await page.evaluate(function () { App.closeFocusMenu(); App.discardRun(); }); await sleep(500);
  await page.goto(BASE_Q('?demo=route'), { waitUntil: 'load' }); await sleep(1200);
  await page.click('.tile-route'); await sleep(400); await page.click('#runRouteBtn'); await sleep(1200); await page.click('#fcStart'); await sleep(1200);
  await page.evaluate(function () { for (var i = 0; i < 16; i++) App.adjustSpeed(0.5); }); await sleep(2500);
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

  // ── No route: VIDEO view hides the route-only tile (ELEVATION → CALORIES), no race bar ──
  await page.goto(BASE_Q('?demo=noroute'), { waitUntil: 'load' }); await sleep(900);
  await page.click('.tile-free'); await sleep(600);
  await page.evaluate(function () { var q = document.getElementById('qsSpeed'); if (q) q.classList.remove('open'); App.setMapStyle('video'); });
  await sleep(500);
  await check(page, '14b-video-no-route');
  var nr = await page.evaluate(function () { var e = document.querySelector('#vvTiles [data-needs-route]'); var c = document.querySelector('#vvTiles .vv-cal'); return { routeless: document.getElementById('rootApp').classList.contains('routeless'), elevHidden: getComputedStyle(e).display === 'none', calShown: getComputedStyle(c).display !== 'none', bar: document.getElementById('raceBar').offsetHeight }; });
  ok(nr.routeless && nr.elevHidden && nr.calShown && nr.bar === 0, TOUR.name + ' no route: elevation tile hidden, calories shown, no race bar', JSON.stringify(nr));
  await page.goto(BASE_Q('?demo=route'), { waitUntil: 'load' }); await sleep(900);

  // Stats page (zoomed body) + run detail
  await page.goto(BASE_Q('stats.html?demo=1'), { waitUntil: 'load' }); await sleep(1000); await check(page, '15-stats');
  await page.evaluate(function () { openRunDetail(0); }); await sleep(600); await check(page, '16-stats-run-detail');

  await page.close();
}


async function splitTour(browser, errors) {
  await post('/mock/reset');
  var page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && m.text().indexOf('ERR_CONNECTION_REFUSED') < 0) errors.push('console: ' + m.text()); });
  var Q = '&safeBottom=80&ytStub=1&splitSim=1';
  TOUR = { name: '[split]', vh: 1080, usable: 1000, q: Q, prefix: 'rd-split-' };
  await page.goto(BASE + '?demo=route' + Q, { waitUntil: 'load' }); await sleep(1400);
  var sim = await page.evaluate(function () { return { stub: !!(window.AndroidBridge && AndroidBridge._sim), sup: App.videoSplitSupported() }; });
  ok(sim.stub && sim.sup, '[split] ?splitSim=1 installs the stub AndroidBridge and videoSplitSupported() is true', JSON.stringify(sim));
  // start a route run with a race bar
  await page.click('.tile-route'); await sleep(400); await page.click('#runRouteBtn'); await sleep(1200);
  await page.click('#fcStart'); await sleep(1200);
  await page.evaluate(function () { for (var i = 0; i < 20; i++) App.adjustSpeed(0.5); });
  await sleep(4000);
  await page.evaluate(function () {
    var mk = function (id, label, letter, colour, total) { return { id: id, label: label, letter: letter, colour: colour, legend: 'synthetic ' + label, totalS: total, source: 'test', d: [0, Engine.route.totalDistM || 9000], t: [0, total] }; };
    StravaRacers.active = { routeId: Engine.route.id, route: Engine.route, pool: [], status: { stage: 'done' }, racers: [mk('fastest', 'FASTEST', 'F', '#3ee89f', 2400), mk('average', 'AVERAGE', 'A', '#ffd54a', 3000), mk('slowest', 'SLOWEST', 'S', '#ff8a8a', 3600), mk('last', 'LAST', 'L', '#b58cff', 3200)] };
    StravaRacers.legend.render();
  });
  await page.waitForFunction(function () { return !TM._rampTimer; }, null, { timeout: 15000 }).catch(function () {});
  await sleep(1200);
  await page.evaluate(function () { window.__speedCmds = 0; window.__speedLog = []; window.__tgt0 = TM._target; var o = TM._sendSpeedNow.bind(TM); TM._sendSpeedNow = function (k) { var st = (new Error().stack || '').split('\n').slice(2, 6).join(' <- ').replace(/\s+/g, ' '); var ramp = /_rampTick/.test(st); window.__speedLog.push({ kph: k, ramp: ramp, by: st.slice(0, 160) }); /* continuing a stepped ramp toward an UNCHANGED target is not a mode-switch command; anything else is */ if (!ramp || TM._target !== window.__tgt0) window.__speedCmds++; return o.apply(null, arguments); }; });
  var s0 = await page.evaluate(function () { return { el: Engine.run.elapsed, d: Engine.run.distanceM, cmds: window.__speedCmds }; });

  // 📺 → native half: stub calls TR_onVideoSplit('half'); the harness resizes like the wrapper would
  await page.evaluate(function () { localStorage.removeItem('tr_video_mode'); });
  await page.click('#videoOpenBtn'); await sleep(200);
  await page.setViewportSize({ width: 960, height: 1080 }); await sleep(700);
  var h = await page.evaluate(function () { return { mode: AndroidBridge.isVideoSplit(), url: AndroidBridge._url, remembered: localStorage.getItem('tr_video_mode'), videoPanel: document.getElementById('videoSplitPanel').className, style: App._mapStyle, half: document.getElementById('rootApp').classList.contains('half'), w: document.getElementById('rootApp').offsetWidth, hgt: document.getElementById('rootApp').offsetHeight, calls: AndroidBridge.calls.join(','), topStop: !!document.getElementById('topStop').offsetWidth }; });
  ok(h.mode === 'half' && h.half && h.w === 960 && h.hgt === 1000 && h.topStop, '[split] 📺 → AndroidBridge.videoSplit(half) → half layout 960x1000 with top STOP', JSON.stringify(h));
  ok(h.url === '' && h.remembered === 'half' && h.style !== 'video' && !/show/.test(h.videoPanel), '[split] one tap: videoSplit(half, "") with an EMPTY url (wrapper reopens the last YouTube page), mode remembered, no paste-link/favourites UI', JSON.stringify({ url: h.url, remembered: h.remembered, style: h.style, panel: h.videoPanel }));
  TOUR = { name: '[half]', vh: 1080, usable: 1000, q: Q, prefix: 'rd-half-', zone: false };
  await page.evaluate(function () { document.querySelectorAll('.milestone-popup').forEach(function (p) { p.classList.remove('show'); }); });
  await check(page, '01-running-race-bar'); await stopCheck(page, '01-running', 1000);
  var vb = await page.evaluate(function () { var f = document.getElementById('videoFullBtn'), c = document.getElementById('videoCloseBtn'); return { full: !!f.offsetWidth, close: !!c.offsetWidth, fullTxt: f.textContent.trim(), closeTxt: c.textContent.trim() }; });
  ok(vb.full && vb.close && /FULL/.test(vb.fullTxt) && /CLOSE VIDEO/.test(vb.closeTxt), '[half] FULL and CLOSE VIDEO buttons visible in our pane', JSON.stringify(vb));
  await page.evaluate(function () { App.toggleFocusMenu(); }); await sleep(400); await check(page, '02-menu'); await stopCheck(page, '02-menu', 1000);
  await page.evaluate(function () { App.closeFocusMenu(); App.togglePause(); }); await sleep(1200); await check(page, '03-paused'); await stopCheck(page, '03-paused', 1000);
  await page.evaluate(function () { App.togglePause(); }); await sleep(1500);

  // half → full strip: wrapper makes us 1920 x 56
  await page.click('#videoFullBtn'); await sleep(200);
  await page.setViewportSize({ width: 1920, height: 56 }); await sleep(700);
  await page.evaluate(function () { if (Engine.run.status === 'paused') App.togglePause(); }); await sleep(800);
  var f = await page.evaluate(function () { var r = document.getElementById('rootApp'); var rb = document.getElementById('liveRibbon'); var st = document.querySelector('#liveRibbon .rb-stop').getBoundingClientRect(); var rs = document.querySelector('#liveRibbon .rb-btn').getBoundingClientRect(); return { mode: AndroidBridge.isVideoSplit(), strip: r.classList.contains('strip'), w: r.offsetWidth, h: r.offsetHeight, ribbonShown: getComputedStyle(rb).display !== 'none', stopW: st.width, stopH: st.height, stopR: st.right, restoreH: rs.height, restoreTxt: document.querySelector('#liveRibbon .rb-btn').textContent.trim(), stripCall: AndroidBridge.calls.indexOf('strip:56') >= 0, speed: document.querySelector('#liveRibbon [data-rb=speed]').textContent, next: document.querySelector('#liveRibbon [data-rb=next]').textContent, state: document.querySelector('#liveRibbon [data-rb=state]').textContent, fontSpeed: parseFloat(getComputedStyle(document.querySelector('#liveRibbon .rb-speed b')).fontSize), padLeft: document.querySelector('#liveRibbon .rb-speed').getBoundingClientRect().left }; });
  ok(f.mode === 'full' && f.strip && f.w === 1920 && f.h === 56 && f.ribbonShown, '[full] FULL → videoSplit(full) + setStatsStripHeight(56) → 1920x56 strip', JSON.stringify({ mode: f.mode, strip: f.strip, w: f.w, h: f.h, stripCall: f.stripCall }));
  ok(f.stopW >= 150 && f.stopH >= 54 && f.stopR >= 1915, '[full] big red STOP at the far top-right (>=150 wide, full height)', 'w=' + Math.round(f.stopW) + ' h=' + Math.round(f.stopH) + ' right=' + Math.round(f.stopR));
  ok(/RESTORE/.test(f.restoreTxt) && f.restoreH >= 56, '[full] RESTORE button (plain text label, >= 56 px) left of STOP', f.restoreTxt + ' h=' + Math.round(f.restoreH));
  ok(f.fontSpeed >= 30 && f.padLeft >= 120, '[full] strip text >= 30 px and the left 120 px stay empty', 'speed font ' + f.fontSpeed + 'px, first item at x=' + Math.round(f.padLeft));
  ok(/km\/h/.test(f.speed) && /NEXT/.test(f.next) && /RUNNING/.test(f.state), '[full] strip shows speed, NEXT change and the RUNNING pill', f.speed + ' | ' + f.next + ' | ' + f.state);
  await page.screenshot({ path: path.join(OUT, 'rd-full-strip-1920x56.png') }); console.log('shot rd-full-strip-1920x56');
  TOUR = { name: '[full]', vh: 56, usable: 56, q: Q, prefix: 'rd-full-' };
  await check(page, '01-strip'); await stopCheck(page, '01-strip', 56);
  // safety key out → whole strip red
  await post('/mock/safety-key', { out: true }); await sleep(2500);
  var al = await page.evaluate(function () { return { alarm: document.getElementById('liveRibbon').classList.contains('alarm'), state: document.querySelector('#liveRibbon [data-rb=state]').textContent }; });
  ok(al.alarm && /SAFETY/.test(al.state), '[full] safety key out → strip turns red/flashing with SAFETY KEY OUT pill', JSON.stringify(al));
  await page.screenshot({ path: path.join(OUT, 'rd-full-strip-safety-key.png') }); console.log('shot rd-full-strip-safety-key');
  await post('/mock/safety-key', { out: false }); await sleep(1500);
  await page.evaluate(function () { if (Engine.run.status === 'paused') App.togglePause(); }); await sleep(1500);
  // composite: strip over a fake YouTube box (how the real screen looks)
  var stripPng = fs.readFileSync(path.join(OUT, 'rd-full-strip-1920x56.png')).toString('base64');
  var comp = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await comp.setContent('<body style="margin:0;background:#000"><img src="data:image/png;base64,' + stripPng + '" style="display:block;width:1920px;height:56px"><div style="height:944px;background:#1b1b1b;display:flex;align-items:center;justify-content:center;color:#fff;font:bold 64px sans-serif">YOUTUBE (native WebView) 1920 x 944</div><div style="height:80px;background:#333;color:#aaa;font:28px sans-serif;display:flex;align-items:center;justify-content:center">ROM nav bar (Quick start / Workout settings / expand)</div></body>');
  await comp.screenshot({ path: path.join(OUT, 'rd-full-composite-1920x1080.png') }); console.log('shot rd-full-composite-1920x1080'); await comp.close();

  // full → half (RESTORE) → off (CLOSE VIDEO) mid-run: elapsed/distance keep counting, no speed command sent
  var c0 = await page.evaluate(function () { return window.__speedCmds; });
  await page.evaluate(function () { document.querySelector('#liveRibbon .rb-btn').click(); }); await sleep(200);
  await page.setViewportSize({ width: 960, height: 1080 }); await sleep(600);
  var back = await page.evaluate(function () { return { mode: AndroidBridge.isVideoSplit(), half: document.getElementById('rootApp').classList.contains('half'), strip: document.getElementById('rootApp').classList.contains('strip') }; });
  ok(back.mode === 'half' && back.half && !back.strip, '[full] RESTORE → back to the half layout', JSON.stringify(back));
  await page.click('#videoCloseBtn'); await sleep(200);
  await page.setViewportSize({ width: 1920, height: 1080 }); await sleep(700);
  var off = await page.evaluate(function () { return { mode: AndroidBridge.isVideoSplit(), half: document.getElementById('rootApp').classList.contains('half'), w: document.getElementById('rootApp').offsetWidth, el: Engine.run.elapsed, d: Engine.run.distanceM, status: Engine.run.status, cmds: window.__speedCmds, belt: TM.workoutState }; });
  ok(off.mode === 'off' && !off.half && off.w === 1920, '[split] CLOSE VIDEO → videoSplit(off) → full 1920 layout', JSON.stringify({ mode: off.mode, w: off.w }));
  ok(off.el > s0.el + 5 && off.d > s0.d && off.status === 'running' && off.belt === 'RUNNING', '[split] off → half → full → half → off kept the run (elapsed ' + Math.round(s0.el) + '→' + Math.round(off.el) + ' s, ' + Math.round(s0.d) + '→' + Math.round(off.d) + ' m)', JSON.stringify(off));
  ok(off.cmds === c0 && off.cmds === s0.cmds, '[split] no speed command was sent by any mode switch', 'cmds before ' + s0.cmds + ' after ' + off.cmds + ' ' + JSON.stringify(await page.evaluate(function () { return { tgt0: window.__tgt0, tgt: TM._target, log: window.__speedLog }; })));
  // owner simplification: VIDEO toggles, the mode is remembered across close/reopen, every open uses an EMPTY url
  var tg = await page.evaluate(function () {
    var out = {}; AndroidBridge.calls.length = 0;
    App.openVideo(); out.open1 = AndroidBridge.isVideoSplit(); out.url1 = AndroidBridge._url;
    App.setVideoMode('full'); out.full = AndroidBridge.isVideoSplit(); out.rememberedFull = localStorage.getItem('tr_video_mode');
    return out;
  });
  await sleep(100);
  var tg2 = await page.evaluate(function () { var out = {}; App.openVideo(); out.toggledOff = AndroidBridge.isVideoSplit(); return out; });
  await sleep(100);
  var tg3 = await page.evaluate(function () { var out = {}; App.openVideo(); out.reopened = AndroidBridge.isVideoSplit(); out.url = AndroidBridge._url; out.calls = AndroidBridge.calls.join(','); return out; });
  await sleep(100);
  await page.evaluate(function () { App.restoreVideo(); }); await sleep(100);
  var tg4 = await page.evaluate(function () { return { mode: AndroidBridge.isVideoSplit(), remembered: localStorage.getItem('tr_video_mode') }; });
  await page.evaluate(function () { App.closeVideo(); }); await sleep(300);
  ok(tg.open1 === 'half' && tg.url1 === '' && tg.full === 'full' && tg.rememberedFull === 'full', '[split] VIDEO opens with the remembered mode and an empty url; FULL remembers full', JSON.stringify(tg));
  ok(tg2.toggledOff === 'off' && tg3.reopened === 'full' && tg3.url === '' && tg4.mode === 'half' && tg4.remembered === 'half', '[split] VIDEO again closes; reopening restores the remembered mode (full) with an empty url; RESTORE remembers half', JSON.stringify({ off: tg2.toggledOff, reopened: tg3.reopened, url: tg3.url, calls: tg3.calls, after: tg4 }));
  // summary in half layout
  await page.click('#videoOpenBtn'); await sleep(200); await page.setViewportSize({ width: 960, height: 1080 }); await sleep(600);
  await page.evaluate(function () { var r = Engine.run; r.distanceM = 2300; r.elapsed = 760; r.splits = [{ km: 1, timeSec: 330, avgHR: 140, elapsed: 330 }, { km: 2, timeSec: 318, avgHR: 149, elapsed: 648 }]; r._lastSplitElapsed = 648; r._lastSplitKm = 2; App.stopNow(); document.querySelectorAll('.milestone-popup').forEach(function (p) { p.classList.remove('show'); }); });
  await sleep(1000);
  TOUR = { name: '[half]', vh: 1080, usable: 1000, q: Q, prefix: 'rd-half-', zone: false };
  await check(page, '04-summary');
  var sum = await page.evaluate(function () { var b = document.querySelector('.finish-btns .fc-start').getBoundingClientRect(); return { saveVisible: b.width > 0 && b.bottom <= 1000, belt: TM.workoutState }; });
  ok(sum.saveVisible, '[half] summary: SAVE RUN visible above y=1000 in the 960 px pane', JSON.stringify(sum));
  await page.evaluate(function () { App.discardRun(); App.closeVideo(); }); await sleep(300);
  await page.setViewportSize({ width: 1920, height: 1080 }); await sleep(500);
  TOUR = { name: '[half]', vh: 1080, usable: 1000, q: Q, prefix: 'rd-half-', zone: false };
  await page.evaluate(function () { App.openVideo(); }); await sleep(200); await page.setViewportSize({ width: 960, height: 1080 }); await sleep(600);
  await page.click('.tile-free'); await sleep(600);
  await page.evaluate(function () { var q = document.getElementById('qsSpeed'); if (q) q.classList.remove('open'); });
  await check(page, '05-ready-no-route');
  await page.close();
}

// ── PC/fallback embed 'full' (no AndroidBridge): embed fills the zone with the in-pane strip ──
async function embedFullTour(browser, errors) {
  await post('/mock/reset');
  var page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  var Q = '&safeBottom=80&ytStub=1&splitSim=0';
  TOUR = { name: '[embed-full]', vh: 1080, usable: 1000, q: Q, prefix: 'rd-embedfull-' };
  await page.goto(BASE + '?demo=route' + Q, { waitUntil: 'load' }); await sleep(1400);
  await page.click('.tile-route'); await sleep(400); await page.click('#runRouteBtn'); await sleep(1200);
  await page.click('#fcStart'); await sleep(1200);
  await page.evaluate(function () { for (var i = 0; i < 16; i++) App.adjustSpeed(0.5); window.__speedCmds = 0; window.__speedLog = []; window.__tgt0 = TM._target; var o = TM._sendSpeedNow.bind(TM); TM._sendSpeedNow = function (k) { var st = (new Error().stack || '').split('\n').slice(2, 6).join(' <- ').replace(/\s+/g, ' '); var ramp = /_rampTick/.test(st); window.__speedLog.push({ kph: k, ramp: ramp, by: st.slice(0, 160) }); /* continuing a stepped ramp toward an UNCHANGED target is not a mode-switch command; anything else is */ if (!ramp || TM._target !== window.__tgt0) window.__speedCmds++; return o.apply(null, arguments); }; });
  await sleep(3000);
  var e0 = await page.evaluate(function () { return { el: Engine.run.elapsed, cmds: window.__speedCmds, sup: App.videoSplitSupported() }; });
  ok(!e0.sup, '[embed] without AndroidBridge the fallback embed view is used', 'supported=' + e0.sup);
  await page.click('#videoOpenBtn'); await sleep(500);
  await page.evaluate(function () { VideoView.play({ type: 'video', id: 'dQw4w9WgXcQ' }); });
  await page.waitForFunction(function () { return VideoView.ready; }, null, { timeout: 8000 }).catch(function () {});
  await page.evaluate(function () { App.setVideoMode('full'); document.querySelectorAll('.milestone-popup').forEach(function (p) { p.classList.remove('show'); }); }); await sleep(600);
  var ef = await page.evaluate(function () { var r = document.getElementById('rootApp'); var strip = document.getElementById('vvStrip'); var fr = document.querySelector('.vv-frame').getBoundingClientRect(); var zone = document.querySelector('.map-zone').getBoundingClientRect(); return { full: r.classList.contains('embed-full'), stripShown: getComputedStyle(strip).display !== 'none', stripH: strip.getBoundingClientRect().height, frameFrac: fr.width / zone.width, restore: document.querySelector('#vvStrip .rb-btn').textContent.trim(), stop: !!document.querySelector('#vvStrip .rb-stop').offsetWidth }; });
  ok(ef.full && ef.stripShown && ef.stripH >= 56 && ef.frameFrac >= 0.9 && /RESTORE/.test(ef.restore) && ef.stop, '[embed] FULL → embed fills the view zone with the 56 px strip (RESTORE + STOP) on top', JSON.stringify(ef));
  await check(page, '01-full'); await stopCheck(page, '01-full', 1000);
  await page.evaluate(function () { document.querySelector('#vvStrip .rb-btn').click(); }); await sleep(500);
  var er = await page.evaluate(function () { return { full: document.getElementById('rootApp').classList.contains('embed-full'), style: App._mapStyle, el: Engine.run.elapsed, cmds: window.__speedCmds }; });
  ok(!er.full && er.style === 'video' && er.el > e0.el && er.cmds === e0.cmds, '[embed] RESTORE → back to the split embed view, run kept, no speed command', JSON.stringify(er));
  await page.evaluate(function () { App.closeVideo(); }); await sleep(400);
  var ec = await page.evaluate(function () { return { style: App._mapStyle, iframe: !!VideoView.iframe }; });
  ok(ec.style !== 'video', '[embed] CLOSE VIDEO → leaves the video view', JSON.stringify(ec));
  // TEST FIX: tap the real on-screen STOP (calling App.stopNow() first left only the summary, so no STOP element existed to tap)
  await stopTap(page, 'summary-after-stop');
  await page.close();
}

(async function () {
  var browser = await pw.chromium.launch();
  var errors = [];

  // Tour A: the real X32i — 1920x1080 window, ROM bar painted over y=1000..1080 → ?safeBottom=80
  TOUR = { name: '[1080+strip]', vh: 1080, usable: 1000, q: '&safeBottom=80&ytStub=1', prefix: 'rd-' };
  await tour(browser, errors);
  // Tour B: a window that is genuinely 1920x1000 (no strip)
  TOUR = { name: '[1000]', vh: 1000, usable: 1000, q: '&safeBottom=0&ytStub=1', prefix: 'rd1000-' };
  await tour(browser, errors);
  await splitTour(browser, errors);
  await embedFullTour(browser, errors);

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
