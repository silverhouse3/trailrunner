#!/usr/bin/env node
// Unit tests for Engine.nextChange() / Engine.remaining() and the HR-loss guards (plain Node, loads js/engine.js in a vm).
//   node mock/next-change-test.js
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var passed = 0, failed = 0;
function ok(c, name, detail) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : '')); }

// minimal stubs for what engine.js touches at load / in these paths
var sent = [];
var ctx = {
  console: console, Date: Date, Math: Math, JSON: JSON, setInterval: setInterval, clearInterval: clearInterval, setTimeout: setTimeout, clearTimeout: clearTimeout,
  Store: { getSettings: function () { return { maxHR: 185, weight: 72, safetyMaxSpeed: 20, safetyMaxIncline: 15 }; } },
  TM: { setSpeed: function (k) { sent.push(['speed', k]); }, setIncline: function (p) { sent.push(['inc', p]); }, setFan: function () {}, stopWorkout: function () {}, pauseWorkout: function () {}, resumeWorkout: function () {}, _cancelRamp: function () {}, workoutState: 'RUNNING', fanSupported: false },
  SpeedUnits: { toKph: function (v, u) { return u === 'mph' ? v * 1.60934 : v; } },
  document: { getElementById: function () { return null; } },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(UI, 'js/engine.js'), 'utf8') + '\n;this.Engine = Engine;', ctx, { filename: 'engine.js' });
var Engine = ctx.Engine;

// ── 1. free run without a plan → null ──
Engine.newRun(); Engine.run.status = 'running'; Engine.ctrl.mode = 'manual';
ok(Engine.nextChange() === null, 'free run (manual, no plan) → nextChange() is null');
var rem = Engine.remaining();
ok(rem.distM === null && rem.timeSec === null, 'free run → no distance / time remaining', JSON.stringify(rem));

// ── 2. route with a known grade profile: flat 0% for 1 km, then 6% ──
var N = 200, totalM = 4000, pts = [];
for (var i = 0; i < N; i++) { var d = i / (N - 1) * totalM; pts.push({ lat: 51 + i * 1e-5, lon: -2, ele: d < 1000 ? 50 : 50 + (d - 1000) * 0.06, dist: d }); }
Engine.loadRoute({ id: 'r1', name: 'Test', totalDistM: totalM, totalDistKm: 4, resampled: pts });
Engine.newRun(); Engine.run.status = 'running'; Engine.ctrl.mode = 'route';
Engine.run.distanceM = 400; Engine.run.routeIdx = Math.floor(400 / totalM * (N - 1)); Engine.run.speed = 10;
var nc = Engine.nextChange();
ok(nc && nc.kind === 'route' && nc.incline >= 0.5 && nc.incline <= 6.5 && nc.speed === null, 'route: next change is the first commanded incline step of the hill ahead (>= 0.5 pp)', JSON.stringify(nc));
ok(nc && nc.inM > 450 && nc.inM < 700 && nc.inSec > 150 && nc.inSec < 260, 'route: distance to the change ~600 m at 10 km/h → ~3.5 min', JSON.stringify(nc && { inM: Math.round(nc.inM), inSec: Math.round(nc.inSec) }));
rem = Engine.remaining();
ok(rem.distM === 3600, 'route: 3600 m remaining', JSON.stringify(rem));
Engine.run.speed = 0;
nc = Engine.nextChange();
ok(nc && nc.inSec === null && nc.inM > 0, 'route at 0 km/h: distance known, time unknown', JSON.stringify(nc));
Engine.run.distanceM = 3900; Engine.run.routeIdx = N - 6; Engine.run.speed = 10;
nc = Engine.nextChange();
ok(nc && (nc.kind === 'end' || (nc.kind === 'route' && nc.inM <= 150)), 'route near the finish → finish (or the last smoothing step within 150 m)', JSON.stringify(nc));
Engine.clearRoute();

// ── 3. legacy stage programme ──
Engine.newRun(); Engine.run.status = 'running'; Engine.ctrl.mode = 'manual'; Engine.run.speed = 8;
Engine.workout = { programme: { name: 'P', stages: [{ name: 'Easy', duration: 60, speed: 8, incline: 1 }, { name: 'Hard', duration: 90, speed: 12, incline: 4 }] }, stageIdx: 0, stageElapsed: 20, totalElapsed: 20 };
nc = Engine.nextChange();
ok(nc && nc.kind === 'stage' && nc.inSec === 40 && nc.speed === 12 && nc.incline === 4 && nc.label === 'Hard', 'stage programme: next stage in 40 s → 12 km/h, 4%', JSON.stringify(nc));
rem = Engine.remaining();
ok(rem.timeSec === 130, 'stage programme: 130 s remaining', JSON.stringify(rem));
Engine.workout.stageIdx = 1; Engine.workout.stageElapsed = 10;
nc = Engine.nextChange();
ok(nc && nc.kind === 'end' && nc.inSec === 80, 'last stage → kind end in 80 s', JSON.stringify(nc));
Engine.workout = null;

// ── 4. PWA-managed workout (WorkoutSegments stub): programmed segments, distance based ──
ctx.WorkoutSegments = {
  active: { phase: 'segment', segmentIndex: 0, intervalIndex: 0, round: 0, totalCoveredM: 300, elapsed: 100,
    workout: { type: 'programmed', speedUnit: 'kph', distanceUnit: 'km', segments: [{ distance: 1, speed: 6, incline: 0, label: 'Walk' }, { distance: 1, speed: 11, incline: 3, label: 'Run' }], coolDown: { enabled: true, speed: 4, incline: 0, duration: 120 } } },
  getCurrentSegment: function () { return { index: 0, total: 2, label: 'Walk', speed: 6, speedUnit: 'kph', incline: 0, remaining: 700, remainingType: 'distance' }; },
  _getTotalDistanceM: function () { return 2000; },
};
Engine.newRun(); Engine.run.status = 'running'; Engine.run.speed = 6; Engine.ctrl.mode = 'manual';
nc = Engine.nextChange();
ok(nc && nc.kind === 'workout' && nc.speed === 11 && nc.incline === 3 && nc.inM === 700 && Math.round(nc.inSec) === 420 && nc.label === 'Run', 'builder workout: next segment Run 11 km/h 3% in 700 m / 7 min', JSON.stringify(nc));
rem = Engine.remaining();
ok(rem.distM === 1700, 'builder workout: 1700 m remaining of 2000', JSON.stringify(rem));
ctx.WorkoutSegments.active.segmentIndex = 1; ctx.WorkoutSegments.getCurrentSegment = function () { return { index: 1, total: 2, label: 'Run', speed: 11, speedUnit: 'kph', incline: 3, remaining: 200, remainingType: 'distance' }; };
nc = Engine.nextChange();
ok(nc && nc.kind === 'workout' && nc.speed === 4 && nc.label === 'Cool down', 'last segment → next is the cool-down (4 km/h)', JSON.stringify(nc));
ctx.WorkoutSegments.active = { phase: 'warmup', workout: { type: 'interval-time', speedUnit: 'mph', rounds: 2, warmUp: { enabled: true, duration: 60 }, intervals: [{ duration: 30, speed: 7, incline: 2, label: 'Sprint' }, { duration: 60, speed: 3, incline: 0, label: 'Rest' }], coolDown: { enabled: false } }, intervalIndex: 0, round: 0, elapsed: 20 };
ctx.WorkoutSegments.getCurrentSegment = function () { return { index: -1, total: 4, label: 'Warm Up', remaining: 40, remainingType: 'time' }; };
nc = Engine.nextChange();
ok(nc && nc.kind === 'workout' && nc.inSec === 40 && Math.abs(nc.speed - 7 * 1.60934) < 0.01 && nc.label === 'Sprint', 'interval workout in warm-up: next = Sprint 7 mph (converted to kph) in 40 s', JSON.stringify(nc));
rem = Engine.remaining();
ok(rem.timeSec === 60 + 2 * 90 - 20, 'timed interval workout: time remaining = warm-up + rounds − elapsed', JSON.stringify(rem));
delete ctx.WorkoutSegments;

// ── 5. ramp in progress ──
Engine.newRun(); Engine.run.status = 'running'; Engine.run.speed = 10;
Engine._ramp = { endSpeed: 0, endIncline: null, endsAt: Date.now() + 9000 };
nc = Engine.nextChange();
ok(nc && nc.kind === 'ramp' && nc.speed === 0 && nc.inSec > 8 && nc.inSec <= 9, 'graceful ramp → kind ramp to 0 km/h in ~9 s', JSON.stringify(nc));
Engine._ramp = null;

// ── 6. HR loss guards (P0-1) ──
Engine.newRun(); Engine.run.status = 'running'; Engine.ctrl.mode = 'hr-speed'; Engine.ctrl.targetZone = 3; Engine.ctrl.targetSpeed = 8; Engine.run.speed = 8;
Engine.onTreadmillData({ hr: 95 });
ok(Engine.run.hr === 95 && Engine.hrUsable(), 'fresh HR 95 is usable');
Engine._apLastAdjust = 0; sent = [];
Engine._applyAutoControl();
ok(Engine.ctrl.targetSpeed > 8, 'HR below zone → autopilot raises speed once', 'target ' + Engine.ctrl.targetSpeed);
var t1 = Engine.ctrl.targetSpeed;
Engine._applyAutoControl();
ok(Engine.ctrl.targetSpeed === t1, 'autopilot rate-limited: no second raise within 5 s', 'target ' + Engine.ctrl.targetSpeed);
Engine.onTreadmillData({ hr: 0 });
ok(Engine.run.hr === 0 && Engine.run.hrSource === 'none' && !Engine.hrUsable(), 'HR 0 from the bridge → HR LOST, not usable', JSON.stringify({ hr: Engine.run.hr, src: Engine.run.hrSource }));
Engine._apLastAdjust = 0;
for (var k = 0; k < 40; k++) Engine._applyAutoControl();
ok(Engine.ctrl.targetSpeed === t1, 'HR lost → autopilot HOLDS the target (40 ticks, no change)', 'target ' + Engine.ctrl.targetSpeed);
Engine.onTreadmillData({ hr: 96 });
Engine._apLastAdjust = 0;
Engine._applyAutoControl();
ok(Engine.ctrl.targetSpeed === t1 && !Engine.hrUsable(), 'HR back for < 5 s → still held (re-validation period)', 'target ' + Engine.ctrl.targetSpeed);
Engine.run._hrBackAt = Date.now() - 6000; Engine.onTreadmillData({ hr: 96 });
ok(Engine.hrUsable(), 'HR back for >= 5 s → usable again');
Engine.run._hrAt = Date.now() - 9000;
Engine._applyAutoControl();
ok(Engine.run.hr === 0 && Engine.run.hrSource === 'none', 'no fresh sample for > 8 s → treated as LOST (frozen value discarded)', JSON.stringify({ hr: Engine.run.hr }));

// ── 7. STOP = immediate ──
Engine.newRun(); Engine.run.status = 'running'; Engine.run.speed = 12; Engine.run.incline = 3; Engine.ctrl.targetSpeed = 12; sent = [];
Engine.finishRun(true);
ok(sent.length && sent[0][0] === 'speed' && sent[0][1] === 0 && Engine.run.status === 'finished' && Engine.ctrl.targetSpeed === 0, 'finishRun(immediate): first command is speed 0, run finished, target 0', JSON.stringify(sent.slice(0, 3)));

console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
