#!/usr/bin/env node
// Warm-up / cool-down wrapper tests (plain Node + vm; no bridge, no belt).
//   node mock/warmcool-test.js
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function mk(st) {
  var sent = [], settings = Object.assign({ maxHR: 185, safetyMaxSpeed: 20 }, st || {});
  var ctx = { console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, setInterval: setInterval, clearInterval: clearInterval, setTimeout: setTimeout, clearTimeout: clearTimeout,
    Store: { getSettings: function () { return settings; } },
    TM: { setSpeed: function (k) { sent.push(['speed', k]); }, setIncline: function (p) { sent.push(['inc', p]); }, maxKph: function () { return 19.3; }, _cancelRamp: function () {} },
    document: { getElementById: function () { return null; } } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(UI, 'js/workout-segments.js'), 'utf8') + '\n;this.WorkoutSegments = WorkoutSegments;this.SpeedUnits=SpeedUnits;', ctx, { filename: 'ws.js' });
  ctx.sent = sent; ctx.settings = settings; return ctx;
}
function plan(first, last, unit) {
  return { id: 'w', name: 'T', type: 'interval-time', speedUnit: unit || 'kph', distanceUnit: 'km', rounds: 1,
    intervals: [{ duration: 120, speed: first, incline: 0, label: 'A' }, { duration: 120, speed: last, incline: 1, label: 'B' }] };
}
var c = mk({ warmUpEnabled: true, coolDownEnabled: true, warmUpDuration: 240, coolDownDuration: 180, warmUpSpeed: 4.8 }), W = c.WorkoutSegments;

// 1. disabled -> exactly the same plan
var p0 = plan(10, 12);
ok(W.wrapPlan(p0, W.wrapOptions({})) === p0, 'settings OFF (default): same object back, plan unchanged');
ok(W.wrapOptions({}).warmUp === false && W.wrapOptions({ warmUpEnabled: false }).coolDown === false, 'wrapper is OFF unless a setting is explicitly true (free runs never wrapped)');
var before = JSON.stringify(W.expandPlan(p0));
ok(JSON.stringify(W.expandPlan(W.wrapPlan(p0, W.wrapOptions({})))) === before && !W.addedText(p0), 'expanded stage list identical, no added minutes');

// 2. warm-up prefix
var w = W.wrapPlan(p0, W.wrapOptions(c.settings)), ex = W.expandPlan(w);
ok(w !== p0 && p0.warmUp === undefined, 'original workout object not mutated (copy returned)');
var wu = ex.filter(function (e) { return e.phase === 'warmup'; });
ok(ex.slice(0, wu.length).every(function (e) { return e.phase === 'warmup'; }) && wu.length === 8, 'plan starts with the warm-up prefix (8 x 30 s = 4:00)', wu.length);
ok(wu.every(function (e, i) { return i === 0 || e.speedKph >= wu[i - 1].speedKph; }) && wu[0].speedKph >= 4.8 && wu[0].speedKph < 6, 'warm-up climbs from walking pace (~4.8 km/h)', wu[0].speedKph + ' -> ' + wu[wu.length - 1].speedKph);
ok(wu.every(function (e) { return e.speedKph <= 10 + 1e-9; }), 'warm-up never exceeds the first-stage speed (10)', Math.max.apply(null, wu.map(function (e) { return e.speedKph; })));
ok(w.warmUp.duration === 240 && w.wrapAdded.warmSec === 240 && w.wrapAdded.coolSec === 180 && W.addedText(w) === '+4:00 warm-up + 3:00 cool-down', 'preview text shows the added minutes', W.addedText(w));

// 3. clamps
var slow = W.wrapPlan(plan(4, 4), W.wrapOptions(c.settings)); var wus = W.expandPlan(slow).filter(function (e) { return e.phase === 'warmup'; });
ok(wus.every(function (e) { return e.speedKph <= 4 + 1e-9; }), 'first stage slower than walking pace: warm-up stays at/below it (4)');
var fast = W.wrapPlan(plan(30, 30), W.wrapOptions(c.settings)); var wuf = W.expandPlan(fast).filter(function (e) { return e.phase === 'warmup'; });
ok(wuf.every(function (e) { return e.speedKph <= W.limits().maxKph + 1e-9; }) && W.limits().maxKph <= 19.3, 'over-limit first stage: warm-up clamped to machine/user max', Math.max.apply(null, wuf.map(function (e) { return e.speedKph; })));
var mph = W.wrapPlan(plan(6, 6, 'mph'), W.wrapOptions(c.settings)); var wum = W.expandPlan(mph).filter(function (e) { return e.phase === 'warmup'; });
ok(wum.every(function (e) { return e.speedKph <= 6 * 1.60934 + 1e-6; }) && mph.warmUp.speed < 6, 'mph workout: warm-up stored in mph, never above 6 mph');
var own = plan(10, 12); own.warmUp = { enabled: true, duration: 300, speed: 6, incline: 0 };
var ow = W.wrapPlan(own, W.wrapOptions(c.settings));
ok(ow.warmUp.duration === 300 && !ow.warmUp.auto && ow.coolDown && ow.coolDown.auto, 'a workout\'s own warm-up is never doubled; cool-down still added');
var nw = plan(10, 12); nw.noWrap = true; ok(W.wrapPlan(nw, W.wrapOptions(c.settings)) === nw, 'per-workout opt-out (noWrap) respected');

// 4. run the wrapped plan through the real session: speeds, order, cool-down end
var cx = mk({ warmUpEnabled: true, coolDownEnabled: true, warmUpDuration: 240, coolDownDuration: 180, warmUpSpeed: 4.8 }), W2 = cx.WorkoutSegments;
var wrapped = W2.wrapPlan(plan(10, 12), W2.wrapOptions(cx.settings)), phases = [], done = false, t = 0;
W2.onPhaseChange = function (p) { phases.push(p); if (p === 'complete') done = true; };
W2.start(wrapped);
while (W2.active && t < 2000) { W2.tick(0, 0.25, 0, 185); t += 0.25; }
ok(phases.join(',') === 'warmup,segment,cooldown,complete' && done, 'phases run warm-up -> stages -> cool-down -> complete', phases.join(','));
ok(Math.abs(t - (240 + 240 + 180)) <= 0.5, 'total length = stages + added minutes (660 s)', t);
var speeds = cx.sent.filter(function (s) { return s[0] === 'speed'; }).map(function (s) { return s[1]; });
var iA = speeds.indexOf(10), iB = speeds.indexOf(12);
ok(iA > 0 && speeds.slice(0, iA).every(function (v) { return v <= 10; }), 'every warm-up command is <= first-stage speed', speeds.slice(0, iA).join(' '));
var cool = speeds.slice(iB + 1);
ok(cool.length > 3 && cool.every(function (v, i) { return i === 0 || v <= cool[i - 1] + 1e-9; }) && cool.every(function (v) { return v <= 12 && v >= 1; }), 'cool-down speeds step down monotonically from the last stage, never below the 1 km/h floor', cool.join(' '));
ok(Math.abs(cool[cool.length - 1] - 4.8) < 0.31, 'cool-down ends at walking pace (4.8), not at 0', cool[cool.length - 1]);
ok(speeds.every(function (v) { return v > 0; }), 'the wrapper itself never commands 0 (the stop is the existing path)');
var app = fs.readFileSync(path.join(UI, 'js/app.js'), 'utf8');
ok(/phase === 'complete'\)\s*\{[\s\S]{0,160}this\.finishRun\(\)/.test(app), 'on complete App.finishRun() runs: graceful ramp to 0 via the existing stop path');
ok(/WorkoutSegments\.wrapPlan\(w,/.test(app) && /addedText/.test(app), 'App.armWorkout applies the wrapper and the arm chip shows the added minutes');

// 5. Run Again card preview
global.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
global.Store = cx.Store; global.TM = cx.TM; global.WorkoutSegments = W2; global.SpeedUnits = cx.SpeedUnits;
var RA = require(path.join(UI, 'js/run-again.js'));
var pts = []; for (var s = 0; s <= 600; s += 5) pts.push({ elapsed: s, dist: s * 3, speed: 10.8, hr: 140 });
var src = RA.fromRun({ id: 'r1', routeName: 'Loop', elapsed: 600, distanceM: 1800, trackPoints: pts });
var on = RA.build(src, { pct: 5, wrap: true }), off = RA.build(src, { pct: 5, wrap: false }), pvOn = RA.preview(on, src), pvOff = RA.preview(off, src);
ok(pvOn.addedSec === 420 && /warm-up/.test(pvOn.addedText) && on.warmUp.enabled && on.coolDown.enabled, 'Run Again preview shows the added minutes (7:00)', pvOn.addedText);
ok(pvOff.addedSec === 0 && !off.warmUp.enabled && off.noWrap === true, 'Run Again with wrapper OFF: unchanged plan, opt-out flag set so arm does not re-add');
var firstRA = on.intervals[0].speed;
ok(on.warmUp.speed <= firstRA, 'Run Again warm-up never above its first stage', on.warmUp.speed + ' <= ' + firstRA);
console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
