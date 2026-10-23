#!/usr/bin/env node
// Transient PAUSED/WARM_UP after START must not show the blocking pause overlay; real pause and safety key still do.
//   node mock/pause-sync-test.js     (needs the static server on :8099; spawns its own mock bridge on :4514)
'use strict';
var path = require('path'), cp = require('child_process');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.env.BASE || 'http://localhost:8099/', PORT = 4514, B = 'http://localhost:' + PORT;
var fails = 0, passes = 0;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ok(c, n, d) { if (c) passes++; else fails++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); }
function post(p, o) { return fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) }).then(function (r) { return r.json(); }); }
var CMD = /\/(workout\/(start|resume|pause|stop)|speed|incline)$|\/command$/;

(async function () {
  var mock = cp.spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  var browser = await pw.chromium.launch();
  try {
    await sleep(1200);
    var ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
    var page = await ctx.newPage(), cmds = [];
    page.on('request', function (r) { if (r.method() === 'POST' && r.url().indexOf(':' + PORT) > -1 && CMD.test(r.url().split('?')[0])) cmds.push(r.url().replace(/^.*:\d+/, '')); });
    page.on('websocket', function (ws) { ws.on('framesent', function (f) { if (/"(KPH|MPH|Incline)"|"action":/i.test(String(f.payload))) cmds.push('ws:' + f.payload); }); });
    await page.goto(BASE + '?demo=route&bridge=localhost:' + PORT);
    await sleep(4000);
    await page.evaluate(function () { App.freeRun(); });
    await sleep(500);
    await page.click('#fcStart');
    await sleep(300); await post('/speed', { kph: 1.6 });   // belt moves like the real console (test-side, not an app command)
    await sleep(5700);   // past the 4 s grace
    var st = await (await fetch(B + '/mock/state')).json();
    ok(st.sim.workoutState === 'RUNNING', 'setup: run started, bridge RUNNING');
    // watcher: records whether the blocking overlay ever shows, and whether the syncing chip shows
    await page.evaluate(function () {
      window.__ovl = 0; window.__chip = 0;
      setInterval(function () {
        if (document.getElementById('pauseOverlay').classList.contains('show')) window.__ovl++;
        var t = document.getElementById('stateBannerText'); if (t && /syncing/i.test(t.textContent)) window.__chip++;
      }, 50);
    });
    var base = cmds.length;
    await page.evaluate(function () { document.getElementById('pauseOverlay').classList.remove('show'); window.__ovl = 0; });

    // (a) transient PAUSED + WARM_UP at 1.6 kph for 1.5 s, then RUNNING
    await post('/mock/force', { state: 'PAUSED', consoleState: 'CONSOLE_STATE_WARM_UP', kph: 1.6 });
    await sleep(1500);
    await post('/mock/force', { off: true });
    await sleep(3000);
    var ovl = await page.evaluate(function () { return [window.__ovl, window.__chip]; });
    ok(ovl[0] === 0, '(a) transient PAUSED+WARM_UP at 1.6 kph: overlay never shown', 'overlay samples=' + ovl[0]);
    ok(ovl[1] > 0, '(a) non-blocking "syncing..." chip shown instead', 'chip samples=' + ovl[1]);
    // (a2) even a long PAUSED while the belt measures > 0.5 never blocks
    await post('/mock/force', { state: 'PAUSED', consoleState: 'CONSOLE_STATE_WARM_UP', kph: 1.6 });
    await sleep(5000);
    await post('/mock/force', { off: true });
    var ovl2 = await page.evaluate(function () { return window.__ovl; });
    ok(ovl2 === 0, '(a2) PAUSED for 5 s while belt > 0.5 kph: still no overlay', 'samples=' + ovl2);
    ok(cmds.length === base, '(d) no belt commands sent in (a)/(a2)', JSON.stringify(cmds.slice(base)));

    // (b) real pause: PAUSED, belt 0 for 3 s
    await sleep(1500);
    await post('/mock/force', { state: 'PAUSED', consoleState: 'CONSOLE_STATE_PAUSED', kph: 0 });
    await sleep(1000);
    var early = await page.evaluate(function () { return document.getElementById('pauseOverlay').classList.contains('show'); });
    ok(!early, '(b) overlay not shown after only ~1 s of stopped belt');
    await sleep(2500);
    var shown = await page.evaluate(function () { return document.getElementById('pauseOverlay').classList.contains('show'); });
    ok(shown, '(b) real pause (PAUSED, belt 0 for 3.5 s): overlay shown');
    ok(cmds.length === base, '(d) no belt commands sent in (b)', JSON.stringify(cmds.slice(base)));

    // (c) safety key out: immediate. Fresh run first.
    await post('/mock/force', { off: true });
    await post('/mock/reset');
    await sleep(1500);
    await page.goto('about:blank'); await page.evaluate(function () { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }).catch(function () {});
    await page.goto(BASE + '?demo=route&bridge=localhost:' + PORT);
    await sleep(4000);
    await page.evaluate(function () { App.freeRun(); });
    await sleep(500);
    await page.click('#fcStart');
    await sleep(300); await post('/speed', { kph: 1.6 });
    await sleep(5700);
    await page.evaluate(function () { document.getElementById('pauseOverlay').classList.remove('show'); });
    var base2 = cmds.length;
    await post('/mock/safety-key', { out: true });
    await sleep(900);
    var shownKey = await page.evaluate(function () { return document.getElementById('pauseOverlay').classList.contains('show'); });
    ok(shownKey, '(c) safetyKeyOut true: overlay shown within ~1 s (no grace)');
    ok(cmds.length === base2, '(d) no belt commands sent in (c)', JSON.stringify(cmds.slice(base2)));
    await ctx.close();
  } catch (e) { fails++; console.log('ERROR ' + e.stack); }
  await browser.close();
  try { mock.kill(); } catch (e) {}
  console.log((fails ? 'FAILED ' + fails : 'ALL PASSED') + ' (' + passes + ' passed)');
  process.exit(fails ? 1 : 0);
})();
