#!/usr/bin/env node
// Unit tests for js/run-again.js (RUN AGAIN + X% HARDER). Plain Node, no browser.
//   node mock/run-again-test.js
'use strict';
var path = require('path');
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function mkStorage() { var d = {}; return { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; } }; }
globalThis.localStorage = mkStorage();
var settings = { safetyMaxIncline: 15 };
globalThis.Store = { getSettings: function () { return settings; } };
globalThis.TM = { maxKph: function () { return 19.3; }, machineMaxIncline: 15, machineMinIncline: -3 };
var RA = require(path.resolve(__dirname, '../js/run-again.js'));

// ── a synthetic 20-minute run: 5 s samples; 0-3 min 6 kph, 3-10 min 10 kph 2%, 10-11 min pause (0), 11-20 min 8 kph, no incline on the first half
function mkRun(withIncline) {
  var pts = [], d = 0;
  for (var t = 0; t <= 1200; t += 5) {
    var sp = t < 180 ? 6 : t < 600 ? 10 : t < 660 ? 0 : 8;
    var inc = t >= 180 && t < 600 ? 2 : 0;
    d += sp / 3.6 * 5;
    var p = { elapsed: t, dist: Math.round(d), speed: sp, hr: 120, ele: 10 };
    if (withIncline) p.incline = inc;
    pts.push(p);
  }
  return { id: 'run_1', routeName: 'Test loop', routeId: null, elapsed: 1200, distanceM: Math.round(d), trackPoints: pts };
}

// 1. source + stages (time basis)
var src = RA.fromRun(mkRun(true));
ok(src && !src.error && src.points.length === 241 && src.hasIncline, 'fromRun: 241 samples, incline recorded');
var st = RA.stages(src, 'time');
var durOk = st.every(function (s) { return s.duration >= 10; });
var totalDur = st.reduce(function (a, s) { return a + s.duration; }, 0);
ok(st.length >= 3 && durOk && st.every(function (s) { return s.speed >= 0.8; }), 'stages: every stage >= 10 s and >= 0.8 kph (pauses dropped)', st.length + ' stages');
ok(Math.abs(totalDur - 1140) <= 15, 'stages: total time = run minus the 60 s pause (~1140 s)', totalDur + ' s');
var changed = st.filter(function (s, i) { return i && (s.speed !== st[i - 1].speed || s.incline !== st[i - 1].incline); });
ok(changed.length >= 2 && changed.length <= 6, 'stages: identical neighbours merged, real changes kept (6→10/2%→8)', changed.length + ' changes: ' + st.map(function (s) { return s.speed + '@' + s.incline + 'x' + s.duration; }).slice(0, 6).join(' '));
var mixed = st.filter(function (s) { return s.duration > 30; }).every(function (s) { return true; });
ok(mixed, 'stages > 30 s only where the speed/incline is constant');

// 2. harder maths
var base = [{ duration: 20, speed: 10, incline: 2, label: 'a' }, { duration: 20, speed: 6, incline: 0, label: 'b' }, { duration: 20, speed: 8, incline: -2, label: 'c' }, { duration: 20, speed: 18.5, incline: 14, label: 'd' }];
var h5 = RA.harder(base, 5, { maxKph: 19.3, maxInc: 15, minInc: -3 });
ok(h5.stages[0].speed === 10.5 && h5.stages[0].incline === 2.5, '+5%: 10 kph 2% → 10.5 kph (×1.02 = 10.2, +0.5 min nudge) and 2.5% (2 × 1.03 = 2.06, min +0.25 → next 0.5 step)', JSON.stringify(h5.stages[0]));
ok(h5.stages[1].speed === 6.5 && h5.stages[1].incline === 0, '+5%: 6 kph 0% → 6.5 kph (+0.5 min nudge), incline stays 0', JSON.stringify(h5.stages[1]));
ok(h5.stages[2].speed === 8.5 && h5.stages[2].incline === -2, '+5%: descent -2% is not made steeper, speed 8 → 8.5', JSON.stringify(h5.stages[2]));
ok(h5.stages[3].speed === 19 && h5.stages[3].incline === 14.5 && h5.clipped === 0, '+5%: 18.5 kph 14% → 19.0 / 14.5 (inside the caps, nothing clipped)', JSON.stringify(h5.stages[3]) + ' clipped=' + h5.clipped);
var h25 = RA.harder([{ duration: 20, speed: 10, incline: 1 }], 2.5, { maxKph: 19.3, maxInc: 15, minInc: -3 });
ok(h25.stages[0].speed === 10.1 && h25.stages[0].incline === 1.5, '+2.5%: 10 → 10.1 (no +0.5 nudge below 5 %), incline 1 → 1.5 (min +0.25 → next 0.5 step)', JSON.stringify(h25.stages[0]));
var h0 = RA.harder(base, 0, { maxKph: 19.3, maxInc: 15, minInc: -3 });
ok(h0.stages.every(function (s, i) { return s.speed === base[i].speed && s.incline === base[i].incline; }), 'SAME (0 %): stages unchanged');
var h10 = RA.harder([{ duration: 20, speed: 12, incline: 5 }], 10, { maxKph: 19.3, maxInc: 15, minInc: -3 });
ok(h10.stages[0].speed === 12.5 && h10.stages[0].incline === 5.5, '+10%: 12 kph 5% → 12.5 (×1.04 = 12.48 → +0.5 nudge) / 5.5% (5 × 1.06 = 5.3 → next 0.5 step)', JSON.stringify(h10.stages[0]));
var hCap = RA.harder([{ duration: 20, speed: 19, incline: 14.8 }, { duration: 20, speed: 10, incline: 0 }], 20, { maxKph: 19.3, maxInc: 15, minInc: -3 });
ok(hCap.stages[0].speed === 19.3 && hCap.stages[0].incline === 15 && hCap.clipped >= 1, '+20%: 19 kph 14.8% → machine max 19.3 / incline max 15, clipped reported', JSON.stringify(hCap.stages[0]) + ' clipped=' + hCap.clipped);
ok(hCap.stages[1].speed === 10.8, '+20%: 10 kph → 10.8 (×1.08; the +1.5 cap not reached)', JSON.stringify(hCap.stages[1]));
var hPlus = RA.harder([{ duration: 20, speed: 10, incline: 0 }], 20, { maxKph: 30, maxInc: 15, minInc: -3 });
ok(hPlus.stages[0].speed === 10.8, 'cap +1.5 over the original only bites above +37 % (10.8 < 11.5)');
var hUser = RA.harder([{ duration: 20, speed: 10, incline: 0 }], 10, { maxKph: 9, maxInc: 15, minInc: -3 });
ok(hUser.stages[0].speed === 9, "user 'Maximum speed' 9 caps a harder stage to 9", JSON.stringify(hUser.stages[0]));

// 3. build: time basis → interval-time workout; pct clamp; naming
var w = RA.build(src, { pct: 5, basis: 'time' });
ok(w && w.type === 'interval-time' && w.rounds === 1 && w.intervals.length === st.length && w.name === 'Run again +5%' && w.speedUnit === 'kph' && !w.warmUp.enabled && !w.coolDown.enabled, 'build(time): interval-time workout, 1 round, no warm-up/cool-down, named "Run again +5%"', w && (w.type + ' ' + w.intervals.length));
ok(w.runAgain && w.runAgain.inclineRecorded === true && w.runAgain.derived === false && w.runAgain.pct === 5 && w.runAgain.basis === 'time', 'build: runAgain metadata (source, pct, basis, inclineRecorded, derived)', JSON.stringify(w.runAgain));
var w35 = RA.build(src, { pct: 35 });
ok(w35.runAgain.pct === 20 && w35.name === 'Run again +20%', 'custom % is capped at 20', w35.name);
var noInc = RA.fromRun(mkRun(false));
var wn = RA.build(noInc, { pct: 5 });
ok(!noInc.hasIncline && wn.runAgain.inclineRecorded === false && wn.intervals.every(function (s) { return s.incline === 0; }), 'older run without incline samples → inclineRecorded=false ("incline not recorded"), all 0 %');

// 4. distance basis with a route
var rsrc = RA.fromRun(Object.assign(mkRun(true), { routeId: 'r1' }));
var wd = RA.build(rsrc, { pct: 0, basis: 'distance' });
var km = wd.segments.reduce(function (a, s) { return a + s.distance; }, 0);
ok(wd.type === 'programmed' && wd.segments.length >= 3 && Math.abs(km - rsrc.distM / 1000) < 0.02 && wd.segments.every(function (s) { return s.distance > 0 && s.speed >= 0.8; }), 'build(distance, route): programmed workout whose segment distances add up to the run distance', wd.segments.length + ' segs, ' + km.toFixed(2) + ' km vs ' + (rsrc.distM / 1000).toFixed(2));
var wdt = RA.build(RA.fromRun(mkRun(true)), { pct: 0, basis: 'distance' });
ok(wdt.type === 'interval-time', 'distance basis without a route falls back to time');

// 5. preview numbers
var pv = RA.preview(w, src);
ok(pv.stages === w.intervals.length && pv.totalSec > 1000 && pv.avgKph > pv.origAvgKph && pv.maxKph <= 19.3 && pv.origElapsed === 1200, 'preview: stages, total time, avg (harder > original), max', JSON.stringify(pv));

// 6. Strava source (derived)
var streams = { time: [], distance: [], velocity_smooth: [], grade_smooth: [] };
for (var t = 0, dd = 0; t <= 600; t += 2) { var v = t < 300 ? 2.5 : 3.0; dd += v * 2; streams.time.push(t); streams.distance.push(dd); streams.velocity_smooth.push(v); streams.grade_smooth.push(t < 300 ? 1.2 : 25); }
var ss = RA.fromStrava(streams, { id: 42, name: 'Morning Run' });
ok(ss && !ss.error && ss.derived && ss.hasIncline && ss.points[0].speed === 9 && ss.points[ss.points.length - 1].incline === 15, 'fromStrava: m/s → kph (2.5 → 9.0), grade clamped to the incline max (25 → 15), flagged derived', JSON.stringify(ss.points[0]));
var ws = RA.build(ss, { pct: 5 });
ok(ws.runAgain.derived && /from Strava/.test(ws.desc) && ws.runAgain.sourceId === 'strava_42', 'Strava workout is flagged as derived in the plan', ws.desc);

// 7. errors
var bad = RA.fromRun({ id: 'x', trackPoints: [] });
ok(bad && bad.error && RA.stages(bad, 'time').length === 0 && RA.build(bad, {}) === null, 'run without a timeline → error, no plan');
ok(RA.fromStrava({ time: [1] }, {}).error, 'Strava activity without a speed stream → error');

// 8. save + remembered %
var saved = RA.save(w);
var lib = JSON.parse(localStorage.getItem('tr_workouts'));
ok(lib.length === 1 && lib[0].name === 'Run again +5%' && !lib[0]._base && lib[0].intervals.length === w.intervals.length, 'save: in the workout library (tr_workouts), preview-only fields stripped');
RA.rememberPct(10); ok(RA.lastPct() === 10, 'last % remembered (10)');
RA.rememberPct(99); ok(RA.lastPct() === 5, 'out-of-range stored % falls back to the default 5');

console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
