// Tests: (A) TM.setSpeed stepped ramp (bridge caps a single command at +/-4 kph), (B) Strava HR per km from the single streams call.
// Run: node mock/ramp-hr-test.js
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var failed = 0, passed = 0;
function ok(c, n, d) { if (c) passed++; else failed++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function mkStorage() { var d = {}; return { getItem: function (k) { return k in d ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; }, key: function (i) { return Object.keys(d)[i] || null; }, get length() { return Object.keys(d).length; } }; }
globalThis.localStorage = mkStorage(); globalThis.sessionStorage = mkStorage();
globalThis.location = { search: '?strava=localhost:8097', href: 'http://localhost:8099/?strava=localhost:8097', protocol: 'http:', host: 'localhost:8099', hostname: 'localhost' };
globalThis.window = globalThis; globalThis.document = { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
globalThis.navigator = { userAgent: 'node' };

(async function () {
  // ── A: stepped ramp ───────────────────────────────────────────────
  console.log('== A. TM.setSpeed stepped ramp');
  vm.runInThisContext(fs.readFileSync(path.join(UI, 'js/treadmill.js'), 'utf8'), { filename: 'treadmill.js' });
  var TM = vm.runInThisContext('TM');
  var sent = [];
  TM._send = function (o) { if (o && o.values && o.values.KPH !== undefined) sent.push(o.values.KPH); };
  TM.connected = true; TM._stepMs = 40;
  function reset() { TM._cancelRamp(); TM._sentSpeed = -1; TM._beltKph = 0; TM._lastSpeed = -1; TM._estopActive = false; sent.length = 0; }

  reset(); TM.setSpeed(10);
  ok(sent.length === 1 && sent[0] <= 3.0 + 1e-9, 'big raise 0 -> 10: first command is only one step', JSON.stringify(sent));
  await wait(40 * 6);
  ok(sent[sent.length - 1] === 10, 'ramp reaches the 10 kph target', JSON.stringify(sent));
  var maxStep = 0, prev = 0; sent.forEach(function (v) { maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v; });
  ok(maxStep <= 3.0 + 1e-9, 'no step larger than 3 kph (bridge allows 4/s)', 'max step ' + maxStep);
  ok(sent.every(function (v, i) { return i === 0 || v >= sent[i - 1]; }), 'ramp never goes backwards while raising');

  reset(); TM._sentSpeed = 8; TM._lastSendT = Date.now(); TM.setSpeed(9);
  ok(sent.length === 1 && sent[0] === 9, 'small move 8 -> 9 goes out at once, single command', JSON.stringify(sent));

  reset(); TM.setSpeed(12); await wait(50); TM.setSpeed(0);
  var n0 = sent.length; await wait(40 * 5);
  ok(sent[sent.length - 1] === 0 && sent.length === n0, 'stop (0) mid-ramp: goes out at once and cancels the ramp', JSON.stringify(sent));

  reset(); TM.setSpeed(15); await wait(10); TM.emergencyStop();
  var n1 = sent.length; await wait(40 * 5);
  ok(sent.length === n1 && sent[n1 - 1] === 0 && !TM._rampTimer, 'emergency stop cancels the ramp and sends 0', JSON.stringify(sent));
  ok((function () { var c = sent.length; TM.setSpeed(8); return sent.length === c; })(), 'after e-stop no speed command is sent');

  reset(); TM._sentSpeed = 16; TM._lastSendT = Date.now(); TM.setSpeed(6); await wait(40 * 6);
  var down = sent.slice(); var dprev = 16, dmax = 0; down.forEach(function (v) { dmax = Math.max(dmax, Math.abs(dprev - v)); dprev = v; });
  ok(down[down.length - 1] === 6 && dmax <= 3.0 + 1e-9 && down.every(function (v, i) { return i === 0 || v <= down[i - 1]; }), 'big decrease 16 -> 6 is stepped down, never up', JSON.stringify(down));

  reset(); TM.setSpeed(6); await wait(40 * 4); var before = sent.length; TM.setSpeed(6);
  ok(sent.length === before, 'repeat of the same target is not re-sent (dedup kept)');

  reset(); TM.setSpeed(12); await wait(50); TM.disconnect(); var n2 = sent.length; await wait(40 * 5);
  ok(sent.length === n2, 'disconnect cancels a running ramp');

  // ── B: Strava HR in the single stream call ─────────────────────────
  console.log('\n== B. Strava: heart rate per km from the same streams call');
  vm.runInThisContext(fs.readFileSync(path.join(UI, 'js/storage.js'), 'utf8'), { filename: 'storage.js' });
  globalThis.Store = vm.runInThisContext('Store');
  vm.runInThisContext(fs.readFileSync(path.join(UI, 'js/engine.js'), 'utf8'), { filename: 'engine.js' });
  globalThis.Engine = vm.runInThisContext('Engine');
  var A = require(path.join(UI, 'js/strava-api.js')), RC = require(path.join(UI, 'js/strava-racers.js'));
  var mock = require('./strava-mock.js'); var srv = await mock.start(8097);
  localStorage.setItem('tr_strava_app', JSON.stringify({ clientId: '12345' }));
  await A.exchangeCode('mockcode');
  var s = await A.getActivityStreams(9000000004);
  ok(Array.isArray(s.heartrate) && s.heartrate.length === s.distance.length, 'one streams call returns heartrate aligned with distance', (s.heartrate || []).length + ' samples');
  var perKm = RC.hrPerKm(s, 1);
  ok(perKm.length >= 3 && perKm.every(function (v) { return v > 80 && v < 220; }), 'per-km average HR computed', JSON.stringify(perKm.slice(0, 6)));
  ok(RC.hrPerKm({ distance: [0, 500, 1500], heartrate: [120, 130, 140] }, 1).join() === '125,140', 'per-km HR maths on a tiny sample (km1 = mean of 120,130; km2 = 140)');
  ok(RC.hrPerKm({ distance: [0, 1000], time: [0, 5] }, 1).length === 0, 'run without heartrate gives no HR (ignored, not fabricated)');
  srv.close && srv.close();
  console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error('ERROR', e); process.exit(2); });
