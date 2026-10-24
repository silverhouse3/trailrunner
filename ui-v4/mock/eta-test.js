#!/usr/bin/env node
// Engine.etaPlan: planned speeds for programmed runs (slow finish is NOT priced at current pace), pace only for routes.
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.env.BASE || 'http://localhost:8099/';
var fails = 0;
function ok(c, n, d) { if (!c) fails++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); }
(async function () {
  var browser = await pw.chromium.launch();
  try {
    var page = await (await browser.newContext()).newPage();
    await page.goto(BASE + '?demo=route'); await page.waitForTimeout(3000);
    var r = await page.evaluate(function () {
      Engine.run = Engine.run || { speed: 12, distanceM: 0 }; Engine.run.speed = 12;
      WorkoutSegments.active = { workout: { type: 'programmed', distanceUnit: 'km', speedUnit: 'kph', segments: [
        { distance: 8, speed: 12 }, { distance: 2, speed: 6 } ] }, segmentIndex: 0, segmentCoveredM: 4000, totalCoveredM: 4000 };
      var a = Engine.etaPlan();
      WorkoutSegments.active.segmentIndex = 1; WorkoutSegments.active.segmentCoveredM = 1000;
      var b = Engine.etaPlan();
      WorkoutSegments.active.workout.segments[1].speed = 0;
      var c = Engine.etaPlan();
      WorkoutSegments.active = null;
      return { a: a, b: b, c: c };
    });
    // 4 km left at 12 kph = 1200 s, then 2 km at 6 kph = 1200 s
    ok(r.a && Math.abs(r.a.timeSec - 2400) < 1 && r.a.basis === 'planned', 'planned speeds used incl. slow last 2 km (not current pace)', JSON.stringify(r.a));
    ok(r.b && Math.abs(r.b.timeSec - 600) < 1, '1 km left in the slow segment = 600 s at its planned 6 kph', JSON.stringify(r.b));
    ok(r.c === null, 'a zero-speed planned segment gives no ETA instead of nonsense', JSON.stringify(r.c));
  } finally { await browser.close(); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
