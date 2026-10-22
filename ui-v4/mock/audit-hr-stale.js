#!/usr/bin/env node
// Audit: what happens in HR->SPEED / HR->INCLINE control when the HR source drops out (real bridge sends "Heart Rate":"0").
// Mocks only. Own ports: static :8199, mock bridge :4611.   node mock/audit-hr-stale.js
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UI = 'http://localhost:8199/', TM = 'http://localhost:4611';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
(async function () {
  var b = await pw.chromium.launch(); var ctx = await b.newContext({ viewport: { width: 1920, height: 1000 } });
  await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  var page = await ctx.newPage(); page.setDefaultTimeout(8000);
  var Q = '?bridge=localhost:4611';
  await jpost(TM + '/mock/reset'); await page.goto(UI + Q); await page.evaluate(function () { localStorage.clear(); }); await page.goto(UI + Q); await sleep(1800);
  await page.click('.tile-free'); await sleep(400); await page.click('#fcStart'); await sleep(1500);
  await page.evaluate(function () { App.setControlMode('hr-speed'); App.setTargetZone(3); Engine.ctrl.targetSpeed = 8; });
  await jpost(TM + '/mock/hr', { bpm: 95 }); await sleep(5000);   // below zone 3 floor -> control wants to speed up (by design)
  var s0 = await page.evaluate(function () { return { hr: Engine.run.hr, tgt: Engine.ctrl.targetSpeed }; });
  await jpost(TM + '/mock/hr', { bpm: 0 });                          // strap lost: real bridge reports 0
  await sleep(15000);
  var s1 = await page.evaluate(function () { return { hr: Engine.run.hr, src: Engine.run.hrSource, tgt: Engine.ctrl.targetSpeed, hrCell: document.getElementById('hrVal').textContent }; });
  console.log('HR 95 (below zone) before dropout:', JSON.stringify(s0));
  console.log('15 s after HR source reports 0   :', JSON.stringify(s1));
  console.log(s1.tgt > s0.tgt ? 'RESULT: FAIL - target speed kept rising on a FROZEN heart-rate value after the HR source dropped out (' + s0.tgt + ' -> ' + s1.tgt + ' kph)' : 'RESULT: PASS - control held when HR dropped out');
  await page.evaluate(function () { App.emergencyStop(); }); await b.close();
})().catch(function (e) { console.error('FATAL', e); process.exit(2); });
