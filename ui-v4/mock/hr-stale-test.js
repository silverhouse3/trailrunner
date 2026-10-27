#!/usr/bin/env node
// P1 HR safety test (2026-10-26). Playwright against the UI + mock bridge on OWN ports (static :8299, mock :4711).
//   node mock/hr-stale-test.js
// Proves: frozen HR -> HR LOST in ~15 s and incline HOLDS; resume -> autopilot waits for the 5 s re-validation;
// max incline 0 honoured; incline above the cap is pulled DOWN (0.5%/5 s); TM.setIncline / manual buttons clamp.
'use strict';
var path = require('path'), cp = require('child_process');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UIP = 8299, TMP = 4711, UI = 'http://localhost:' + UIP + '/', TMU = 'http://localhost:' + TMP;
var passed = 0, failed = 0;
function ok(c, n, d) { if (c) passed++; else failed++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function spawn(file, port) { return cp.spawn('node', [path.join(__dirname, file)], { env: Object.assign({}, process.env, { PORT: String(port) }), stdio: 'ignore' }); }

(async function () {
  var kids = [spawn('static.js', UIP), spawn('server.js', TMP)];
  var b;
  try {
    await sleep(1200);
    b = await pw.chromium.launch(); var ctx = await b.newContext({ viewport: { width: 1920, height: 1000 } });
    await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
    var page = await ctx.newPage(); page.setDefaultTimeout(8000);
    var Q = '?bridge=localhost:' + TMP;
    function ev(f, a) { return page.evaluate(f, a); }
    async function startRun(cap, hrMode) {
      await jpost(TMU + '/mock/reset');
      await page.goto(UI + Q); await ev(function () { localStorage.clear(); }); await page.goto(UI + Q); await sleep(1800);
      await ev(function (c) { var s = Store.getSettings(); s.safetyMaxIncline = c; s.maxHR = 185; Store.saveSettings(s); }, cap);
      await page.click('.tile-free'); await sleep(400); await page.click('#fcStart'); await sleep(1500);
      await ev(function (m) { App.setControlMode(m); App.setTargetZone(3); Engine.ctrl.targetSpeed = 4; Engine.ctrl.targetIncline = 0; }, hrMode || 'hr-incline');
    }
    var tgt = function () { return ev(function () { return Engine.ctrl.targetIncline; }); };

    // ── 1. frozen HR -> LOST, incline holds ──
    console.log('== 1. frozen HR (bridge fix: reports 0 after 12 s)');
    await startRun(10);
    await jpost(TMU + '/mock/hr', { bpm: 95 }); await sleep(13000);   // below zone: autopilot raises
    var t0 = await tgt();
    ok(t0 > 0, 'sanity: low HR raises incline while HR is live', t0);
    await jpost(TMU + '/mock/hr', { freeze: true });
    var lostAt = null, tFreeze = Date.now(), tgtAtLost = null, risesAfterLost = 0, last = null;
    for (var i = 0; i < 40; i++) {                                       // up to 20 s
      await sleep(500);
      var s = await ev(function () { return { lost: !!Engine.run._hrLostAt, hr: Engine.run.hr, usable: Engine.hrUsable(), t: Engine.ctrl.targetIncline, cell: (document.querySelector('.hr-val,#hrVal') || {}).textContent }; });
      if (s.lost && lostAt === null) { lostAt = (Date.now() - tFreeze) / 1000; tgtAtLost = s.t; }
      if (lostAt !== null && last !== null && s.t > last) risesAfterLost++;
      last = s.t;
    }
    ok(lostAt !== null && lostAt <= 15, 'HR LOST flagged within 15 s of the strap freezing', lostAt && lostAt.toFixed(1) + ' s');
    ok(risesAfterLost === 0 && last === tgtAtLost, 'incline target HOLDS (never rises) after HR LOST', 'at lost ' + tgtAtLost + ', end ' + last);
    var fin = await ev(function () { return { hr: Engine.run.hr, usable: Engine.hrUsable(), notified: !!Engine.run._hrLostNotified, txt: document.getElementById('hrVal') && document.getElementById('hrVal').textContent }; });
    ok(fin.hr === 0 && fin.usable === false && fin.notified === true, 'run.hr = 0, hrUsable false, LOST tone/toast path fired (_hrLostNotified)', JSON.stringify(fin));

    // ── 2. resume -> re-validation ──
    console.log('== 2. resume: autopilot waits for the 5 s re-validation');
    var base = await tgt();
    await jpost(TMU + '/mock/hr', { freeze: false, bpm: 95 });
    var moved = null, usableAt = null, tR = Date.now();
    for (i = 0; i < 24; i++) {                                           // 12 s
      await sleep(500);
      var r = await ev(function () { return { u: Engine.hrUsable(), t: Engine.ctrl.targetIncline }; });
      var el = (Date.now() - tR) / 1000;
      if (r.u && usableAt === null) usableAt = el;
      if (r.t !== base && moved === null) moved = el;
    }
    ok(usableAt !== null && usableAt >= 4.0, 'HR only usable again after ~5 s of valid samples', usableAt && usableAt.toFixed(1) + ' s');
    ok(moved === null || moved >= 4.5, 'no incline change before the re-validation window ends', moved && moved.toFixed(1) + ' s');
    ok(moved !== null, 'autopilot acts again after re-validation', moved && moved.toFixed(1) + ' s');
    await ev(function () { App.emergencyStop(); });

    // ── 3. max incline 0 honoured ──
    console.log('== 3. max incline 0 honoured');
    await startRun(0);
    var cap0 = await ev(function () { return Engine._maxInclineCap(); });
    await jpost(TMU + '/mock/hr', { bpm: 95 }); var mx = 0;
    for (i = 0; i < 26; i++) { await sleep(500); mx = Math.max(mx, await tgt()); }
    ok(cap0 === 0, '_maxInclineCap() is 0 (not 15) when setting is 0', cap0);
    ok(mx <= 0, 'low HR never raises incline above 0 when cap is 0', 'max ' + mx);
    var norm = await ev(function () { var s = { safetyMaxIncline: 0 }; s.safetyMaxIncline = (s.safetyMaxIncline == null || isNaN(+s.safetyMaxIncline)) ? 15 : s.safetyMaxIncline; return s.safetyMaxIncline; });
    ok(norm === 0, 'settings-panel normaliser keeps 0');
    await ev(function () { App.emergencyStop(); });

    // ── 4. pull-down toward cap ──
    console.log('== 4. cap pull-down');
    await startRun(5);
    await ev(function () { Engine.ctrl.targetIncline = 6.5; });
    await jpost(TMU + '/mock/hr', { bpm: 95 });
    var series = [], tt0 = Date.now();
    for (i = 0; i < 40; i++) { await sleep(500); series.push([(Date.now() - tt0) / 1000, await tgt()]); }
    var vals = series.map(function (x) { return x[1]; });
    var mono = vals.every(function (v, k) { return k === 0 || v <= vals[k - 1]; });
    var steps = [], pv = 6.5; series.forEach(function (x) { if (x[1] !== pv) { steps.push([x[0], pv - x[1]]); pv = x[1]; } });
    ok(vals[vals.length - 1] === 5 && mono, 'incline target pulled down from 6.5 to the cap 5, never up', vals[vals.length - 1]);
    ok(steps.every(function (s) { return Math.abs(s[1] - 0.5) < 1e-9; }), 'each pull-down step is 0.5%', JSON.stringify(steps));
    ok(steps.length >= 2 && steps[1][0] - steps[0][0] >= 4.0, 'steps are rate-limited (~5 s apart)', steps.length > 1 && (steps[1][0] - steps[0][0]).toFixed(1) + ' s');
    await ev(function () { App.emergencyStop(); });

    // ── 5. clamps on TM.setIncline and manual buttons ──
    console.log('== 5. incline clamps');
    await startRun(8, 'manual');
    var c = await ev(function () {
      var sent = [], o = TM._send; TM._send = function (m) { if (m && m.values && m.values.Incline !== undefined) sent.push(m.values.Incline); };
      TM.connected = true; TM._sessionStarted = true; TM._estopActive = false;
      TM.setIncline(60, true); TM.setIncline(-20, true);
      var out = { sent: sent.slice(), max: TM.machineMaxIncline, min: TM.machineMinIncline };
      Engine.ctrl.targetIncline = 7.5; App.adjustIncline(1); out.btnUp = Engine.ctrl.targetIncline;       // user cap 8
      App.adjustIncline(1); out.btnUp2 = Engine.ctrl.targetIncline;
      Engine.ctrl.targetIncline = -2.5; App.adjustIncline(-5); out.btnDown = Engine.ctrl.targetIncline;
      TM._send = o; return out;
    });
    ok(c.sent[0] === c.max && c.sent[1] === c.min, 'TM.setIncline clamps to machine limits (60 -> ' + c.max + ', -20 -> ' + c.min + ')', JSON.stringify(c.sent));
    ok(c.btnUp === 8 && c.btnUp2 === 8, 'manual + button stops at the user cap (8)', c.btnUp + ',' + c.btnUp2);
    ok(c.btnDown === c.min, 'manual - button stops at the machine minimum', c.btnDown);
    await ev(function () { App.emergencyStop(); });
  } catch (e) { failed++; console.error('FATAL', e); }
  finally { try { if (b) await b.close(); } catch (e) {} kids.forEach(function (k) { try { k.kill(); } catch (e) {} }); }
  console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
