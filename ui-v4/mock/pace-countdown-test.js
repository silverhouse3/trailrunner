#!/usr/bin/env node
// Pace-target blocks + 3-2-1 start countdown tests (plain Node + vm, fake timers; no bridge, no belt).
//   node mock/pace-countdown-test.js
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
var sent = [], beeps = [], settings = { safetyMaxSpeed: 20 };
var ctx = { console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, setInterval: setInterval, clearInterval: clearInterval, setTimeout: setTimeout, clearTimeout: clearTimeout,
  Store: { getSettings: function () { return settings; } },
  TM: { setSpeed: function (k) { sent.push(['speed', k]); }, setIncline: function (p) { sent.push(['inc', p]); }, maxKph: function () { return 19.3; }, _cancelRamp: function () {}, startWorkout: function () { sent.push(['START']); } },
  VoiceCmd: { _playTone: function (f) { beeps.push(f); } }, document: { getElementById: function () { return null; } } };
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(UI, 'js/workout-segments.js'), 'utf8') + '\n;this.WorkoutSegments = WorkoutSegments;this.StartCountdown = StartCountdown;', ctx, { filename: 'ws.js' });
var W = ctx.WorkoutSegments, SC = ctx.StartCountdown;

// ── pace parsing + conversion ──
ok(W.parsePace('5:00') === 300 && W.parsePace('8:30 /mi') === 510 && W.parsePace('5.5') === 330 && W.parsePace('4:5') === 245, 'parsePace: m:ss, with unit suffix, decimal minutes');
ok(W.parsePace('abc') === null && W.parsePace('') === null && W.parsePace('0:10') === null && W.parsePace('99:00') === null, 'parsePace rejects junk / absurd values');
var m = W.paceToKph(300, 'metric'), i = W.paceToKph(480, 'imperial');
ok(m.kph === 12 && m.clipped === null, '5:00 /km = 12.0 km/h', JSON.stringify(m));
ok(i.kph === 12.1 && i.clipped === null, '8:00 /mi = 12.1 km/h (7.5 mph)', JSON.stringify(i));
var fast = W.paceToKph(150, 'metric'), slow = W.paceToKph(4000, 'metric');
ok(fast.clipped === 'max' && fast.kph === 19.3 && fast.requestedKph === 24, '2:30 /km (24 km/h) clipped to the machine max 19.3', JSON.stringify(fast));
ok(slow.clipped === 'min' && slow.kph === 1 , '66:40 /km raised to the 1 km/h floor (flagged)', JSON.stringify(slow));
settings.safetyMaxSpeed = 12;
ok(W.paceToKph(300, 'metric').kph === 12 && W.paceToKph(270, 'metric').clipped === 'max' && W.paceToKph(270, 'metric').kph === 12, 'user max-speed setting (12) also clips', JSON.stringify(W.paceToKph(270, 'metric')));
settings.safetyMaxSpeed = 20;
var seg = {}; W.applyPaceToBlock(seg, 480, 'imperial', 'mph');
ok(seg.speed === 7.5 && seg.paceKph === 12.1 && seg.paceSecPerKm === 298 && seg.paceClip === null, 'block stored in the workout unit (7.5 mph) + canonical sec/km', JSON.stringify(seg));
var seg2 = {}; W.applyPaceToBlock(seg2, 150, 'metric', 'kph');
ok(seg2.speed === 19.3 && seg2.paceClip === 'max', 'clipped block carries the clip flag for the warning chip', JSON.stringify(seg2));

// ── pace blocks run through the normal path (time block + distance block) ──
function runPlan(wk) { sent.length = 0; var t = 0; W.start(wk); while (W.active && t < 3000) { W.tick(wk.type === 'programmed' ? 3.3 * 0.25 : 0, 0.25, 0, 185); t += 0.25; } return t; }
var b1 = {}, b2 = {}; W.applyPaceToBlock(b1, 300, 'metric', 'kph'); W.applyPaceToBlock(b2, 150, 'metric', 'kph');
var tEnd = runPlan({ id: 'p', name: 'P', type: 'interval-time', speedUnit: 'kph', rounds: 1, intervals: [{ duration: 20, speed: b1.speed, incline: 0 }, { duration: 20, speed: b2.speed, incline: 0 }] });
var sp = sent.filter(function (s) { return s[0] === 'speed'; }).map(function (s) { return s[1]; });
ok(sp[0] === 12 && sp[1] === 19.3 && Math.max.apply(null, sp) <= 19.3 && Math.abs(tEnd - 40) < 0.6, 'time blocks by pace: 12.0 then clipped 19.3, all via TM.setSpeed', sp.join(' '));
runPlan({ id: 'q', name: 'Q', type: 'programmed', speedUnit: 'kph', distanceUnit: 'km', segments: [{ distance: 0.1, speed: b1.speed, incline: 0 }] });
ok(sent.filter(function (s) { return s[0] === 'speed'; })[0][1] === 12 && !sent.some(function (s) { return s[0] === 'START'; }), 'distance block by pace sends 12.0 km/h, and never calls startWorkout');
var bs = fs.readFileSync(path.join(UI, 'js/workout-builder.js'), 'utf8');
ok((bs.match(/\$\{this\._paceCell\(seg, i\)\}/g) || []).length === 3 && /Too fast: limited to/.test(bs) && /applyPaceToBlock/.test(bs), 'builder: pace cell in all 3 row types, shows converted speed + clip warning chip');

// ── countdown: fake timers ──
var now = 0, q = [], id = 0;
SC.timers = { set: function (f, ms) { q.push({ id: ++id, at: now + ms, f: f }); return id; }, clear: function (h) { q = q.filter(function (x) { return x.id !== h; }); } };
function advance(ms) { var end = now + ms; for (;;) { q.sort(function (a, b) { return a.at - b.at; }); var n = q[0]; if (!n || n.at > end) break; q.shift(); now = n.at; n.f(); } now = end; }
sent.length = 0; beeps.length = 0;
ok(SC.wanted(true, {}) === true && SC.wanted(false, {}) === false && SC.wanted(false, { startCountdown: 'on' }) === true && SC.wanted(true, { startCountdown: 'off' }) === false, 'default: ON for programmes, OFF for free runs; setting forces on/off');
var went = 0; SC.begin(function () { went++; sent.push(['GO-start']); });
ok(SC.active && SC.left === 3 && sent.length === 0 && went === 0, 'after the START tap: shows 3, nothing sent yet');
advance(1000); ok(SC.left === 2 && went === 0, '2 after 1 s'); advance(1000); ok(SC.left === 1 && went === 0 && sent.length === 0, '1 after 2 s, still nothing sent');
advance(999); ok(went === 0 && SC.active, 'not before the 3 s mark');
advance(2); ok(went === 1 && !SC.active && sent.length === 1 && sent[0][0] === 'GO-start', 'GO at 3 s: the start continuation runs exactly once');
ok(beeps.join(',') === '660,660,660,990', 'beeps 3-2-1 then a higher GO beep', beeps.join(','));
advance(5000); ok(went === 1, 'no second start afterwards');
// cancel mid-countdown
sent.length = 0; beeps.length = 0; went = 0; SC.begin(function () { went++; });
advance(1500); var c1 = SC.cancel('stop'); advance(10000);
ok(c1 === true && went === 0 && sent.length === 0 && !SC.active && q.length === 0, 'STOP/cancel at 1.5 s: instant, no start, no bridge commands, no timers left');
ok(SC.cancel('again') === false, 'cancel when idle is a harmless no-op');
// safety key during countdown
went = 0; SC.begin(function () { went++; }); advance(500); ctx.TM._safetyKeyWarning = true; advance(600);
ok(went === 0 && !SC.active, 'safety key out during the countdown cancels it'); ctx.TM._safetyKeyWarning = false; advance(5000); ok(went === 0, 'and it does not come back by itself');
// double START tap
went = 0; ok(SC.begin(function () { went++; }) === true && SC.begin(function () { went += 10; }) === false, 'a second START tap while counting is ignored'); SC.cancel('x');

// ── wiring in App ──
var app = fs.readFileSync(path.join(UI, 'js/app.js'), 'utf8');
var sr = app.slice(app.indexOf('  startRun() {'), app.indexOf('  cancelCountdown('));
ok(/StartCountdown\.begin\(function \(\) \{ selfA\._beginRun\(\); \}\)/.test(sr) && !/_autoConnectBridge\(true\)|WorkoutSegments\.start|Engine\.startRun|clearEstop/.test(sr), 'startRun() itself starts nothing: belt start lives only in _beginRun, reached from GO');
ok(/_beginRun\(\) \{\s*this\.userStart\(\);/.test(app), '_beginRun re-marks the START tap through App.userStart/TM.markUserTap before the bridge start');
['stopNow() {', 'finishRun(immediate) {', 'emergencyStop() {', 'pauseForSafetyKey() {'].forEach(function (f) {
  var k = app.indexOf('  ' + f); ok(k > 0 && /StartCountdown\.cancel/.test(app.slice(k, k + 200)), 'App.' + f.replace(/\(.*/, '') + ' cancels the countdown first');
});
ok(/togglePause\(\) \{\s*if \(typeof StartCountdown !== 'undefined' && StartCountdown\.cancel\('pause'\)\)/.test(app), 'pause cancels the countdown');
ok(/cd-cancel/.test(fs.readFileSync(path.join(UI, 'css/app.css'), 'utf8')) && /min-height: 84px/.test(fs.readFileSync(path.join(UI, 'css/app.css'), 'utf8')) && /left: 110px/.test(fs.readFileSync(path.join(UI, 'css/app.css'), 'utf8')), 'overlay: CANCEL button 84 px tall, keeps the top-left 110 px zone and bottom 80 px strip free');
console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
