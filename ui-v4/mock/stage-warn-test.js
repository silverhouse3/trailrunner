#!/usr/bin/env node
// Stage warning tests (plain Node + vm, fake clock = the 0.25 s tick dt; no wall clock, no bridge, no belt).
//   node mock/stage-warn-test.js
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }

function mk(lead, withUnits) {
  var sent = [], beeps = [], st = { maxHR: 185, weight: 72, safetyMaxSpeed: 20, safetyMaxIncline: 15 };
  if (lead !== undefined) st.stageWarnLead = lead;
  var ctx = { console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, setInterval: setInterval, clearInterval: clearInterval, setTimeout: setTimeout, clearTimeout: clearTimeout,
    Store: { getSettings: function () { return st; } },
    TM: { setSpeed: function (k) { sent.push(['speed', k]); }, setIncline: function (p) { sent.push(['inc', p]); }, setFan: function () {}, stopWorkout: function () {}, pauseWorkout: function () {}, resumeWorkout: function () {}, _cancelRamp: function () {}, maxKph: function () { return 19.3; }, workoutState: 'RUNNING', fanSupported: false },
    document: { getElementById: function () { return null; } } };
  if (withUnits) ctx.Units = { speedU: function (k) { return (k / 1.609344).toFixed(1) + ' mph'; } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(UI, 'js/workout-segments.js'), 'utf8') + '\n;this.WorkoutSegments = WorkoutSegments;', ctx, { filename: 'workout-segments.js' });
  vm.runInContext(fs.readFileSync(path.join(UI, 'js/engine.js'), 'utf8') + '\n;this.Engine = Engine;', ctx, { filename: 'engine.js' });
  ctx.sent = sent; ctx.beeps = beeps; ctx.WorkoutSegments._beep = function (f) { beeps.push(f); };
  return ctx;
}
function plan() {
  return { id: 'w1', name: 'Test', type: 'interval-time', speedUnit: 'kph', distanceUnit: 'km', rounds: 1,
    intervals: [{ duration: 60, speed: 8, incline: 0, label: 'Easy' }, { duration: 60, speed: 12, incline: 0, label: 'Fast' }, { duration: 30, speed: 12, incline: 2, label: 'Hill' },
      { duration: 30, speed: 12, incline: 2, label: 'Hill 2' }, { duration: 20, speed: 6, incline: 0, label: 'Walk' }] };
}
// run the plan, return warnings [{at, text, inSec}]; hook(t) lets a test intervene
function drive(ctx, lead, hook) {
  var W = ctx.WorkoutSegments, E = ctx.Engine, warns = [], t = 0;
  E.newRun(); E.run.status = 'running'; E.ctrl.mode = 'manual';
  W.onWarn = function (w) { warns.push({ at: t, text: w.text, inSec: w.inSec }); };
  W.start(plan());
  while (W.active && t < 400) {
    E.run.speed = E.ctrl.targetSpeed || 0;
    W.tick(0, 0.25, 0, 185); t += 0.25;
    if (hook) hook(t, W, E);
  }
  return { warns: warns, end: t };
}

// 1. default lead 10 s, exactly once per real change
var c = mk(undefined), r = drive(c, 10);
ok(c.WorkoutSegments.warnLead() === 10, 'default lead is 10 s');
ok(r.warns.length === 3, 'one warning per real change (speed 8->12, incline 0->2, speed 12->6); identical Hill->Hill 2 and the finish are silent', r.warns.length);
ok(Math.abs(r.warns[0].at - 50) <= 0.5 && r.warns[0].inSec === 10, 'first warning fires at 10 s before the change (t=50 of a 60 s stage)', JSON.stringify(r.warns[0]));
ok(/^In 10 s: 12 km\/h$/.test(r.warns[0].text), 'chip text names the new speed', r.warns[0].text);
ok(/^In \d+ s: 2% incline$/.test(r.warns[1].text) && Math.abs(r.warns[1].at - 110) <= 0.5, 'incline-only change warned with incline text at t=110', JSON.stringify(r.warns[1]));
ok(c.beeps.length === 3, 'one short beep per warning (beep only, no speech)', c.beeps.length);
ok(c.sent.every(function (s) { return s[0] === 'speed' ? s[1] <= 19.3 : true; }), 'warnings sent nothing themselves; only stage speeds reached TM.setSpeed');

// 2. configurable lead 5 / 15 / off
[[5, 55], [15, 45]].forEach(function (p) {
  var cx = mk(p[0]), rr = drive(cx, p[0]);
  ok(rr.warns.length === 3 && Math.abs(rr.warns[0].at - p[1]) <= 0.5 && rr.warns[0].inSec === p[0], 'lead ' + p[0] + ' s: first warning at t=' + p[1], JSON.stringify(rr.warns[0]));
});
var off = mk(0), ro = drive(off, 0);
ok(ro.warns.length === 0 && off.beeps.length === 0, 'lead Off: no warnings, no beeps');
ok(mk(7).WorkoutSegments.warnLead() === 10, 'an unsupported lead value falls back to 10');

// 3. next-change data exposed while the warning shows
var c3 = mk(10), nxAt = null;
drive(c3, 10, function (t, W, E) { if (t === 52 && !nxAt) nxAt = E.nextChange(); });
ok(nxAt && nxAt.kind === 'workout' && nxAt.speed === 12 && nxAt.inSec > 7 && nxAt.inSec <= 8.5 && nxAt.label === 'Fast', 'Engine.nextChange() carries the same target/countdown the chip shows', JSON.stringify(nxAt));

// 4. cancelled by pause and by stop
var c4 = mk(10), seen = {};
var r4 = drive(c4, 10, function (t, W, E) {
  if (t === 52) { seen.before = W.getWarning(); E.pauseRun(true); seen.afterPause = W.getWarning(); }
  if (t === 54 && E.run.status === 'paused') { E.run.status = 'running'; seen.afterResume = W.getWarning(); }
});
ok(seen.before && /^In 8 s|^In 9 s/.test(seen.before.text), 'chip counts down (8-9 s at t=52)', seen.before && seen.before.text);
ok(seen.afterPause === null, 'pause cancels the chip at once');
ok(r4.warns.filter(function (w) { return /12 km\/h/.test(w.text); }).length === 1, 'after resume the same change is NOT announced a second time (exactly once)');
var c5 = mk(10), stopSeen = 'x';
drive(c5, 10, function (t, W, E) { if (t === 52) { W.abort(); stopSeen = W.getWarning(); } });
ok(stopSeen === null && c5.WorkoutSegments.active === null, 'stop (abort) cancels the chip and the plan');

// 5. units: mph display
var c6 = mk(10, true), r6 = drive(c6, 10);
ok(r6.warns[0].text === 'In 10 s: 7.5 mph', 'imperial wording: "In 10 s: 7.5 mph"', r6.warns[0].text);

// 6. wiring present in the UI files
var html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8'), app = fs.readFileSync(path.join(UI, 'js/app.js'), 'utf8'), ui = fs.readFileSync(path.join(UI, 'js/ui.js'), 'utf8');
ok(/id="whWarn"/.test(html) && (html.match(/data-rb="warn"/g) || []).length >= 2, 'chip present in the workout HUD and in BOTH full-screen strips');
ok(/getWarning/.test(app) && /getWarning/.test(ui), 'strip and HUD read WorkoutSegments.getWarning()');
console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
