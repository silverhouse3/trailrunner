#!/usr/bin/env node
// Audit: is workout progress (segment name / time left) visible to the runner? Own ports (static 8199, mock bridge 4611).
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UI = 'http://localhost:8199/', TM = 'http://localhost:4611';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
(async function () {
  var b = await pw.chromium.launch(); var page = await (await b.newContext({ viewport: { width: 1920, height: 1000 } })).newPage(); page.setDefaultTimeout(8000);
  await page.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  await fetch(TM + '/mock/reset', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  await page.goto(UI + '?bridge=localhost:4611'); await page.evaluate(function () { localStorage.clear(); }); await page.goto(UI + '?bridge=localhost:4611'); await sleep(1800);
  await page.click('.tile-workout'); await sleep(600); await page.evaluate(function () { document.querySelector('.wb-card').click(); }); await sleep(1200);
  await page.click('#fcStart'); await sleep(14000);
  for (var view of ['oval', 'terrain', 'numbers', 'trailcam']) {
    await page.evaluate(function (v) { App.setMapStyle(v); }, view); await sleep(900);
    var r = await page.evaluate(function () { var seg = WorkoutSegments.getCurrentSegment(); var t = document.body.innerText; return { seg: seg ? seg.label + ' rem=' + Math.round(seg.remaining) : null, hudVisible: !!document.getElementById('workoutHud').offsetWidth, canvasOrTextMentionsSeg: seg ? t.indexOf(seg.label) >= 0 : null }; });
    console.log(view + ': ' + JSON.stringify(r));
  }
  await page.evaluate(function () { App.setMapStyle('oval'); }); await sleep(800);
  if (process.env.AUDIT_SHOTS) await page.screenshot({ path: path.join(process.env.AUDIT_SHOTS, 'audit-25-workout-oval.png') });
  await page.evaluate(function () { App.emergencyStop(); }); await b.close();
})().catch(function (e) { console.error('FATAL', e); process.exit(2); });
