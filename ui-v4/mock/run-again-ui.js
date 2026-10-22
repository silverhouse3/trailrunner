#!/usr/bin/env node
// UI test: RUN AGAIN / X% HARDER entry points (summary, history panel, stats hand-over), the card, ARM = armed only.
//   node mock/run-again-ui.js [http://localhost:8099/] [bridgeHostPort]
'use strict';
var path = require('path'), fs = require('fs');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.argv[2] || 'http://localhost:8099/';
var BRIDGE = process.argv[3] || 'localhost:4510';
var OUT = path.resolve(__dirname, '../screens'); if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function mock(p, body) { var r = await fetch('http://' + BRIDGE + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' }); return r.json().catch(function () { return {}; }); }

(async function () {
  var browser = await pw.chromium.launch(), errors = [];
  var page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', function (e) { errors.push(e.message); });
  await mock('/mock/reset');
  var Q = '?bridge=' + BRIDGE + '&safeBottom=80&demo=route';
  await page.goto(BASE + Q, { waitUntil: 'load' }); await page.evaluate(function () { localStorage.removeItem('tr_workouts'); localStorage.removeItem('tr_runagain_pct'); localStorage.removeItem('tr_runagain_pending'); }); await sleep(1200);

  // ── 1. a route run, fast-forwarded with a synthetic 12-minute timeline, then STOP → summary has ↻ RUN AGAIN
  await page.click('.tile-route'); await sleep(400); await page.click('#runRouteBtn'); await sleep(1200);
  await page.click('#fcStart'); await sleep(1500);
  await page.evaluate(function () {
    var r = Engine.run, d = 0; r.trackPoints = [];
    for (var t = 0; t <= 720; t += 5) { var sp = t < 120 ? 6 : t < 480 ? 10.5 : 8; d += sp / 3.6 * 5; r.trackPoints.push({ time: new Date().toISOString(), dist: Math.round(d), speed: sp, hr: 130, ele: 20, elapsed: t, incline: t < 480 ? 3 : 0 }); }
    r.distanceM = Math.round(d); r.elapsed = 720;
    App.stopNow();
  });
  await sleep(1200);
  var sum = await page.evaluate(function () { var b = document.querySelector('.finish-btns .ra-entry'); var r = b && b.getBoundingClientRect(); return { btn: !!(r && r.width), bottom: r && r.bottom, txt: b && b.textContent.trim(), status: Engine.run.status }; });
  ok(sum.btn && sum.bottom <= 1000 && /RUN AGAIN/.test(sum.txt) && sum.status === 'finished', 'summary: ↻ RUN AGAIN button visible above y=1000', JSON.stringify(sum));
  await page.click('.finish-btns .ra-entry'); await sleep(500);
  var card = await page.evaluate(function () {
    var c = document.getElementById('runAgainCard'); if (!c) return null;
    var on = c.querySelector('.ra-chip.on'); var pv = {}; c.querySelectorAll('.ra-pv').forEach(function (e) { pv[e.querySelector('span').textContent.split(' ')[0]] = e.querySelector('b').textContent; });
    var arm = c.querySelector('.ra-arm').getBoundingClientRect();
    return { chip: on && on.textContent.trim(), pv: pv, basis: !!c.querySelector('.ra-row:nth-child(3) .ra-chip'), armBottom: arm.bottom, armH: arm.height, notes: (c.querySelector('.ra-notes') || {}).textContent || '' };
  });
  ok(card && card.chip === '+5%' && card.pv.STAGES > 0 && card.armH >= 80 && card.armBottom <= 1000, 'card: default +5% selected, PREVIEW numbers, big ARM button above y=1000', JSON.stringify(card));
  ok(card && card.basis, 'card: route run offers DISTANCE / TIME basis');
  await page.screenshot({ path: path.join(OUT, 'rd-run-again-card.png') }); console.log('shot rd-run-again-card');
  // +10 % → preview changes, remembered
  var avg5 = card.pv.AVG;
  await page.evaluate(function () { document.querySelectorAll('#runAgainCard .ra-chip').forEach(function (b) { if (b.textContent.trim() === '+10%') b.click(); }); }); await sleep(300);
  var c10 = await page.evaluate(function () { var c = document.getElementById('runAgainCard'); var pv = {}; c.querySelectorAll('.ra-pv').forEach(function (e) { pv[e.querySelector('span').textContent.split(' ')[0]] = e.querySelector('b').textContent; }); return { chip: c.querySelector('.ra-chip.on').textContent.trim(), pv: pv, remembered: localStorage.getItem('tr_runagain_pct') }; });
  ok(c10.chip === '+10%' && parseFloat(c10.pv.AVG) >= parseFloat(avg5) && c10.remembered === '10', '+10% selected: average speed >= the +5% plan (the +0.5 nudge dominates small %), choice remembered', JSON.stringify(c10));
  // custom via the in-page prompt
  await page.evaluate(function () { document.querySelectorAll('#runAgainCard .ra-chip').forEach(function (b) { if (/CUSTOM/.test(b.textContent)) b.click(); }); }); await sleep(300);
  await page.fill('.ui-dlg-input', '7.5'); await page.click('.ui-dlg-ok'); await sleep(300);
  var cc = await page.evaluate(function () { return { chip: document.querySelector('#runAgainCard .ra-chip.on').textContent.trim(), remembered: localStorage.getItem('tr_runagain_pct') }; });
  ok(/7\.5/.test(cc.chip) && cc.remembered === '7.5', 'custom 7.5 % via the in-page prompt', JSON.stringify(cc));

  // ── 2. ARM: run saved, workout in the library, live screen armed, belt NOT started
  var s0 = await mock('/mock/state');
  await page.click('#runAgainCard .ra-arm'); await sleep(1500);
  var armed = await page.evaluate(function () {
    var lib = JSON.parse(localStorage.getItem('tr_workouts') || '[]');
    return { card: !!document.getElementById('runAgainCard'), armed: App._armedWorkout && App._armedWorkout.name, lib: lib.map(function (w) { return w.name; }), runs: Store.getRuns().length,
      routeName: document.getElementById('routeName').textContent, chip: document.getElementById('workoutChip').textContent, status: Engine.run.status, live: document.getElementById('setupOverlay') ? getComputedStyle(document.getElementById('setupOverlay')).display : 'n/a', start: !!document.getElementById('fcStart').offsetWidth };
  });
  var s1 = await mock('/mock/state');
  ok(!armed.card && armed.armed === 'Run again +7.5%' && armed.lib.indexOf('Run again +7.5%') >= 0 && armed.runs >= 1, 'ARM: run saved, "Run again +7.5%" in the workout library and armed', JSON.stringify(armed));
  ok(armed.status === 'ready' && armed.start && /RUN AGAIN/i.test(armed.routeName) && s1.sim.workoutState === 'IDLE' && s1.sim.targetKph === 0, 'ARM: live screen READY with START (belt idle, no speed command — START is still the user\'s tap)', JSON.stringify({ status: armed.status, belt: s1.sim.workoutState, tgt: s1.sim.targetKph }));
  // START runs it as a workout: first stage speed goes to the bridge through the limiter (≤ 1 kph/s)
  await page.click('#fcStart'); await sleep(2500);
  var run = await page.evaluate(function () { return { status: Engine.run.status, ws: !!(WorkoutSegments.active), seg: WorkoutSegments.getCurrentSegment && WorkoutSegments.getCurrentSegment(), sent: TM._sentSpeed, hud: !!(document.getElementById('workoutHUD') && document.getElementById('workoutHUD').offsetWidth) }; });
  var s2 = await mock('/mock/state');
  ok(run.status === 'running' && run.ws && run.seg && run.seg.speed > 6 && run.sent > 0 && run.sent <= 3.5 && s2.sim.workoutState === 'RUNNING', 'START: WorkoutSegments drives the plan; first stage ' + (run.seg && run.seg.speed) + ' kph reached through the rate limiter (sent so far ' + run.sent + ')', JSON.stringify({ seg: run.seg && run.seg.speed, sent: run.sent, belt: s2.sim.workoutState }));
  await page.evaluate(function () { App.stopNow(); }); await sleep(800); await page.evaluate(function () { App.discardRun(); }); await sleep(500);

  // ── 3. history panel row has ↻ AGAIN → card
  await page.evaluate(function () { App.goHome(); }); await sleep(300);
  await page.evaluate(function () { UI.openHistoryPanel ? UI.openHistoryPanel() : App.toggleHistory(); }).catch(function () {});
  await page.evaluate(function () { UI.renderHistory(); var p = document.getElementById('historyPanel'); p.classList.add('open'); }); await sleep(400);
  var hist = await page.evaluate(function () { var b = document.querySelector('#historyList .hr-again'); if (!b) return null; b.click(); return true; }); await sleep(500);
  var hc = await page.evaluate(function () { var c = document.getElementById('runAgainCard'); return { card: !!c, title: c && c.querySelector('.ra-title').textContent, panelOpen: document.getElementById('historyPanel').classList.contains('open') }; });
  ok(hist && hc.card && !hc.panelOpen, 'history row ↻ AGAIN opens the card for that saved run (panel closed)', JSON.stringify(hc));
  await page.evaluate(function () { RunAgain.saveFromCard(); }); await sleep(300);
  var lib2 = await page.evaluate(function () { return JSON.parse(localStorage.getItem('tr_workouts') || '[]').length; });
  ok(lib2 === 2 && !(await page.evaluate(function () { return !!document.getElementById('runAgainCard'); })), 'SAVE TO LIBRARY adds a second workout and closes the card', 'library ' + lib2);

  // ── 4. stats.html hand-over: pending id → index.html opens the card
  var runId = await page.evaluate(function () { return Store.getRuns()[0].id; });
  await page.goto(BASE + 'stats.html' + Q, { waitUntil: 'load' }); await sleep(800);
  var stBtn = await page.evaluate(function (id) { var i = (window.__statsRuns || []).findIndex(function (r) { return r.id === id; }); if (i < 0) return { idx: -1 }; openRunDetail(i); var b = document.querySelector('#rdDetail .ra-entry'); return { idx: i, btn: !!b, h: b && b.getBoundingClientRect().height }; }, runId);
  ok(stBtn.btn && stBtn.h >= 64, 'stats.html run detail shows a big RUN AGAIN button', JSON.stringify(stBtn));
  await page.click('#rdDetail .ra-entry'); await page.waitForURL(/index\.html/, { timeout: 8000 }).catch(function () {}); await sleep(1800);
  var handed = await page.evaluate(function () { var c = document.getElementById('runAgainCard'); return { url: location.pathname, card: !!c, pending: localStorage.getItem('tr_runagain_pending') }; });
  ok(/index\.html/.test(handed.url) && handed.card && !handed.pending, 'stats → app hand-over: card opens for that run, pending key cleared', JSON.stringify(handed));
  await page.evaluate(function () { RunAgain.close(); });

  // ── 5. the workout library lists it with the ↻ icon and it can be armed from there
  await page.click('.tile-workout'); await sleep(600);
  var inLib = await page.evaluate(function () { return Array.prototype.some.call(document.querySelectorAll('.wb-card, .wb-item, [class*=wb-]'), function (e) { return /Run again/.test(e.textContent); }); });
  ok(inLib, 'workout builder library lists the "Run again" workouts');

  ok(errors.length === 0, 'no page errors', errors.join(' | '));
  await browser.close();
  console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error('ERROR', e); process.exit(2); });
