#!/usr/bin/env node
// SAFETY test: the belt never starts without a user tap on START/RESUME.
//   node mock/no-autostart-test.js     (needs the static server on :8099; spawns its own mock bridges on :4511/:4512/:4513)
'use strict';
var path = require('path'), cp = require('child_process');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = 'http://localhost:8099/';
var fails = 0;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ok(c, n, d) { if (!c) fails++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); }
function spawnMock(port) { return cp.spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port) }), stdio: 'ignore' }); }
function bridgePost(port, p) { return fetch('http://localhost:' + port + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (r) { return r.json(); }); }
var CMD = /\/(workout\/(start|resume)|speed|incline)$|\/command$/;

async function open(browser, port, pre) {
  var ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  var page = await ctx.newPage();
  var cmds = [];
  page.on('request', function (r) { if (r.method() === 'POST' && r.url().indexOf(':' + port) > -1 && CMD.test(r.url().split('?')[0])) cmds.push(r.url().replace(/^.*:\d+/, '')); });
  page.on('websocket', function (ws) { ws.on('framesent', function (f) { if (/"(KPH|Incline)"|"action":"(start|resume)"|StartNewWorkout/i.test(String(f.payload))) cmds.push('ws:' + f.payload); }); });
  if (pre) await page.addInitScript(pre);
  return { ctx: ctx, page: page, cmds: cmds };
}
var PRE_SAVED = function () {
  try {
    if (sessionStorage.getItem('pre_done')) return; sessionStorage.setItem('pre_done', '1');
    localStorage.setItem('tr_active_run', JSON.stringify({ status: 'running', elapsed: 1234, routeName: 'Strava route', targetSpeed: 1.6, targetIncline: 9.5 }));
    localStorage.setItem('tr_run', JSON.stringify({ status: 'running' }));
  } catch (e) {}
};

(async function () {
  var browser = await pw.chromium.launch();
  var kids = [];
  try {
    // (a) saved running run + route, bridge IDLE and connected
    var m1 = spawnMock(4511); kids.push(m1); await sleep(1200);
    var A = await open(browser, 4511, PRE_SAVED);
    await A.page.goto(BASE + '?demo=route&bridge=localhost:4511');
    await sleep(15000);
    var st = await (await fetch('http://localhost:4511/mock/state')).json();
    ok(A.cmds.length === 0, '(a) page load with saved running run sent ZERO start/speed/incline', JSON.stringify(A.cmds));
    ok(st.sim.workoutState === 'IDLE' && st.sim.targetKph === 0, '(a) bridge still IDLE, target 0', st.sim.workoutState + '/' + st.sim.targetKph);
    var shown = await A.page.evaluate(function () { var e = document.getElementById('restoredBanner'); return !!e && getComputedStyle(e).display !== 'none' && /Run restored - tap START/.test(e.textContent); });
    ok(shown, '(a) "Run restored - tap START to continue" banner visible');
    await A.ctx.close();

    // (b) route loaded, bridge connects late
    var B = await open(browser, 4512, PRE_SAVED);
    await B.page.goto(BASE + '?demo=route&bridge=localhost:4512');
    await sleep(3000);
    var m2 = spawnMock(4512); kids.push(m2);
    await sleep(20000);
    var st2 = await (await fetch('http://localhost:4512/mock/state')).json();
    var conn = await B.page.evaluate(function () { return TM.connected; });
    ok(conn, '(b) page did connect late to the bridge');
    ok(B.cmds.length === 0 && st2.sim.workoutState === 'IDLE', '(b) late connect sent ZERO commands, bridge IDLE', JSON.stringify(B.cmds));
    await B.ctx.close();

    // (c) bridge RUNNING at 2 kph started elsewhere
    var m3 = spawnMock(4513); kids.push(m3); await sleep(1200);
    await bridgePost(4513, '/workout/start'); await bridgePost(4513, '/speed').catch(function () {});
    await fetch('http://localhost:4513/speed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kph: 2 }) });
    var C = await open(browser, 4513, PRE_SAVED);
    C.cmds.length = 0;
    await C.page.goto(BASE + '?demo=route&bridge=localhost:4513');
    await sleep(12000);
    var banner = await C.page.evaluate(function () { var e = document.getElementById('beltElsewhereBanner'); return !!e && getComputedStyle(e).display !== 'none' && /BELT ACTIVE - started elsewhere/.test(e.textContent) && !!document.getElementById('beltElsewhereStop'); });
    ok(banner, '(c) red BELT ACTIVE - started elsewhere banner with STOP button');
    ok(C.cmds.length === 0, '(c) no commands sent by the page', JSON.stringify(C.cmds));

    // (d) START tap still works (on the idle mock 4511 again, via a fresh page)
    await C.ctx.close();
    var D = await open(browser, 4511, null);
    await D.page.goto(BASE + '?demo=route&bridge=localhost:4511');
    await sleep(4000);
    await D.page.evaluate(function () { App.freeRun(); });
    await sleep(500);
    await D.page.click('#fcStart');
    await sleep(3000);
    var st4 = await (await fetch('http://localhost:4511/mock/state')).json();
    ok(D.cmds.some(function (c) { return /workout\/start/.test(c); }) && st4.sim.workoutState === 'RUNNING', '(d) START tap sends start, bridge RUNNING', JSON.stringify(D.cmds));

    // (e) pause then RESUME works
    D.cmds.length = 0;
    await D.page.evaluate(function () { App.togglePause(); });
    await sleep(8000);
    D.cmds.length = 0;
    await D.page.evaluate(function () { App.togglePause(); });
    await sleep(3000);
    ok(D.cmds.some(function (c) { return /workout\/resume|workout\/start/.test(c); }), '(e) RESUME after pause sends resume', JSON.stringify(D.cmds));
    // direct, un-tapped TM.startWorkout must be refused
    D.cmds.length = 0;
    await D.page.evaluate(function () { TM._userTapAt = 0; TM._sessionStarted = false; TM.startWorkout(); });
    await sleep(1000);
    ok(D.cmds.length === 0, '(f) TM.startWorkout without a tap is refused');
    await D.ctx.close();
  } catch (e) { fails++; console.log('ERROR ' + e.stack); }
  await browser.close();
  kids.forEach(function (k) { try { k.kill(); } catch (e) {} });
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
