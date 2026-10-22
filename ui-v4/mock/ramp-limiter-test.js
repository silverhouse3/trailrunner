#!/usr/bin/env node
// Speed rate limiter: every TM.setSpeed caller path (button nudges, presets, workout stage, HR autopilot,
// engine graceful ramp, resume) must never command more than the chosen rate per second. Fake clock:
// Date.now and setTimeout are replaced so the test is deterministic and fast. Rates 0.5 / 1 / 2 / 3.
//   node mock/ramp-limiter-test.js
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }

// ── fake clock ──
var NOW = 1000000, timers = [], tid = 0;
function fakeSetTimeout(fn, ms) { var id = ++tid; timers.push({ id: id, at: NOW + (ms || 0), fn: fn }); return id; }
function fakeClearTimeout(id) { timers = timers.filter(function (t) { return t.id !== id; }); }
function advance(ms) { var end = NOW + ms; while (true) { timers.sort(function (a, b) { return a.at - b.at; }); var t = timers[0]; if (!t || t.at > end) break; NOW = t.at; timers.shift(); t.fn(); } NOW = end; }

var settings = { speedRateKph: 1, maxSpeedKph: 0 };
var RealDate = Date; function FakeDate(a) { return a === undefined ? new RealDate(NOW) : new RealDate(a); } FakeDate.now = function () { return NOW; };
var ctx = { console: console, Math: Math, JSON: JSON, Date: FakeDate, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, setInterval: function () { return 0; }, clearInterval: function () {}, fetch: function () { return Promise.reject(new Error('no net')); }, document: { getElementById: function () { return null; } }, navigator: {}, window: null,
  Store: { getSettings: function () { return settings; } } };
ctx.window = ctx; ctx.location = { hostname: '127.0.0.1', port: '', search: '' };
vm.createContext(ctx);
// treadmill.js reads window.location at load
vm.runInContext(fs.readFileSync(path.join(UI, 'js/treadmill.js'), 'utf8') + '\n;this.TM = TM;', ctx, { filename: 'treadmill.js' });
var TM = ctx.TM;
var sent = [];
TM._send = function (o) { if (o && o.values && o.values.KPH !== undefined) sent.push({ t: NOW, k: o.values.KPH }); };
TM.connected = true;
function reset(belt) { TM._cancelRamp(); TM._sentSpeed = -1; TM._beltKph = belt || 0; TM._lastSpeed = -1; TM._estopActive = false; TM._hist = []; TM._lastSendT = 0; TM.cmdLog.length = 0; sent.length = 0; timers = []; }
/** worst change of commanded speed over any sliding 1000 ms window (also vs the pre-existing belt speed) */
function maxPerSecond(startKph) {
  var pts = [{ t: sent.length ? sent[0].t - 1000 : NOW, k: startKph }].concat(sent);
  var worst = 0;
  for (var i = 0; i < pts.length; i++) for (var j = i; j < pts.length; j++) { if (pts[j].t - pts[i].t <= 1000) worst = Math.max(worst, Math.abs(pts[j].k - pts[i].k)); }
  // also the step between consecutive commands
  for (var q = 1; q < pts.length; q++) worst = Math.max(worst, Math.abs(pts[q].k - pts[q - 1].k) * (pts[q].t - pts[q - 1].t < 1000 ? 1 : 0));
  return worst;
}
var TOL = 1e-6;

[0.5, 1, 2, 3].forEach(function (rate) {
  settings.speedRateKph = rate;
  console.log('\n== rate ' + rate + ' kph per second');
  // 1. preset tap 0 -> 16: must ramp, never jump
  reset(0); TM.setSpeed(16, false, 'preset'); advance(40000);
  ok(sent.length > 1 && sent[sent.length - 1].k === 16 && maxPerSecond(0) <= rate + TOL, 'preset 0→16 ramps at <= ' + rate + ' kph/s and reaches 16', 'cmds=' + sent.length + ' worst/s=' + maxPerSecond(0).toFixed(2) + ' took ' + ((sent[sent.length - 1].t - sent[0].t) / 1000).toFixed(1) + ' s');
  ok(sent[0].k <= rate + TOL, 'first command is only one step', 'first=' + sent[0].k);
  // 2. rapid +0.5 button taps (10 taps in 300 ms) from a moving belt
  reset(8); TM._sentSpeed = 8; TM._lastSendT = NOW; TM._hist = [{ t: NOW - 2000, k: 8 }];
  for (var i = 0; i < 10; i++) { TM.setSpeed(8 + (i + 1) * 0.5, false, 'button'); advance(30); }
  advance(15000);
  ok(sent[sent.length - 1].k === 13 && maxPerSecond(8) <= rate + TOL, '10 rapid +0.5 nudges 8→13 are limited to ' + rate + ' kph/s', 'worst/s=' + maxPerSecond(8).toFixed(2) + ' cmds=' + sent.length);
  // 3. workout stage change 12 -> 4 (downward, non-zero) is stepped too
  reset(12); TM._sentSpeed = 12; TM._lastSendT = NOW; TM._hist = [{ t: NOW - 2000, k: 12 }];
  TM.setSpeed(4, false, 'workout'); advance(20000);
  ok(sent[sent.length - 1].k === 4 && maxPerSecond(12) <= rate + TOL && sent.every(function (s, i) { return i === 0 || s.k <= sent[i - 1].k; }), 'workout stage 12→4 steps DOWN at <= ' + rate + ' kph/s', 'worst/s=' + maxPerSecond(12).toFixed(2));
  // 4. HR autopilot +0.5 every 250 ms (a runaway loop) still cannot exceed the rate
  reset(8); TM._sentSpeed = 8; TM._lastSendT = NOW; TM._hist = [{ t: NOW - 2000, k: 8 }];
  var tgt = 8; for (var k = 0; k < 40; k++) { tgt += 0.5; TM.setSpeed(tgt, false, 'hr'); advance(250); }
  ok(maxPerSecond(8) <= rate + TOL, 'HR autopilot asking +0.5 every 250 ms is limited to ' + rate + ' kph/s', 'worst/s=' + maxPerSecond(8).toFixed(2) + ' last=' + sent[sent.length - 1].k);
  // 5. engine graceful ramp 16 -> 0 over 15 s with eased values every 250 ms, then stop
  reset(16); TM._sentSpeed = 16; TM._lastSendT = NOW; TM._hist = [{ t: NOW - 2000, k: 16 }];
  var started = NOW; for (var r = 0; r < 60; r++) { var pr = Math.min(1, (NOW - started) / 15000), eased = 1 - (1 - pr) * (1 - pr); TM.setSpeed(Math.max(0, +(16 - 16 * eased).toFixed(1)), true, 'ramp'); advance(250); }
  TM.setSpeed(0, true, 'ramp'); advance(2000);
  var nonZero = sent.filter(function (s) { return s.k > 0; });
  var worstNZ = 0; for (var a = 0; a < nonZero.length; a++) for (var b2 = a; b2 < nonZero.length; b2++) if (nonZero[b2].t - nonZero[a].t <= 1000) worstNZ = Math.max(worstNZ, Math.abs(nonZero[b2].k - nonZero[a].k));
  ok(worstNZ <= rate + TOL && sent[sent.length - 1].k === 0, 'engine graceful ramp is limited to ' + rate + ' kph/s (stop itself immediate)', 'worst/s=' + worstNZ.toFixed(2));
  // 6. stop is immediate even mid-ramp
  reset(0); TM.setSpeed(12, false, 'preset'); advance(300); var n = sent.length; TM.setSpeed(0, true, 'stop');
  ok(sent.length === n + 1 && sent[n].k === 0 && sent[n].t === NOW && !TM._rampTimer, 'STOP mid-ramp goes out at once and cancels the ramp');
  // 7. cap: user maximum
  settings.maxSpeedKph = 10; reset(0); TM.setSpeed(16, false, 'preset'); advance(30000);
  ok(sent[sent.length - 1].k === 10 && TM._lastClip && TM._lastClip.requested === 16, 'user maximum 10: request 16 is clipped to 10 and reported', JSON.stringify(TM._lastClip));
  settings.maxSpeedKph = 0;
  // 8. machine max from the bridge
  TM.machineMaxKph = 12; reset(0); TM.setSpeed(19, false, 'preset'); advance(30000);
  ok(sent[sent.length - 1].k === 12, 'machine max 12 (from /api/console) caps every request', 'last=' + sent[sent.length - 1].k);
  TM.machineMaxKph = 19.3;
});

// 9. command log
reset(0); settings.speedRateKph = 1; TM.setSpeed(3, false, 'preset'); advance(5000);
var log = TM.cmdLog;
ok(log.length >= 3 && log.every(function (l) { return /^\d{4}-\d{2}-\d{2}T/.test(l.t) && l.what === 'speed' && l.src === 'preset' && l.req === 3; }) && /SPEED preset/.test(TM.cmdLogText()), 'command log records ISO time, source, requested, sent, base for every command', JSON.stringify(log[0]));

console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
