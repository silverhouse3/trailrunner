#!/usr/bin/env node
// Unit tests for js/run-recap.js (post-run recap). Plain Node + vm, demo-style data, both unit systems.
//   node mock/recap-test.js
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var UI = path.resolve(__dirname, '..');
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function load(sys) {
  var store = { tr_settings: JSON.stringify({ unitSystem: sys }) };
  var ctx = { console: console, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, String: String, isNaN: isNaN, parseFloat: parseFloat,
    localStorage: { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(UI, 'js/units.js'), 'utf8') + '\n;this.Units = Units;', ctx, { filename: 'units.js' });
  vm.runInContext(fs.readFileSync(path.join(UI, 'js/run-recap.js'), 'utf8') + '\n;this.RunRecap = RunRecap;', ctx, { filename: 'run-recap.js' });
  return ctx;
}
var DAY = 86400000, NOW = Date.parse('2026-10-24T09:00:00Z');
function mkRun(id, daysAgo, routeId, paces, extra) { // paces: sec/km per km
  var t = 0, splits = paces.map(function (p, i) { t += p; return { km: i + 1, timeSec: p, avgHR: 140 + i }; });
  var when = new Date(NOW - daysAgo * DAY).toISOString();
  var r = { id: id, routeId: routeId, routeName: routeId ? 'Park loop' : 'Free Run', savedAt: when, finishedAt: when, distanceKm: paces.length, distanceM: paces.length * 1000, elapsed: t,
    avgSpeed: +(3600 / (t / paces.length)).toFixed(1), maxSpeed: 14.2, avgHR: 150, elevGained: 40, splits: splits, hrZoneMinutes: { z1: 1, z2: 6, z3: 8, z4: 4, z5: 1 },
    trackPoints: [{ elapsed: 10, dist: 30, speed: 10, hr: 120 }, { elapsed: 600, dist: 1700, speed: 16.1, hr: 171 }] };
  for (var k in (extra || {})) r[k] = extra[k];
  return r;
}
var hist = [mkRun('h1', 3, 'R1', [330, 330, 330, 330, 330]), mkRun('h2', 9, 'R1', [340, 340, 340, 340, 340]), mkRun('h3', 20, null, [350, 350, 350]), mkRun('h4', 40, 'R1', [300, 300, 300, 300, 300])];

// ── metric ──
var c = load('metric'), RR = c.RunRecap;
var run = mkRun('now', 0, 'R1', [320, 310, 335, 325, 330, 300], { elevGained: 95 });
var rc = RR.build(run, hist, { now: NOW });
ok(rc.bestKm && rc.bestKm.n === 6 && rc.bestKm.timeSec === 300, 'best km found with position (km 6, 5:00)', JSON.stringify(rc.bestKm));
ok(rc.bestMile && rc.bestMile.timeSec > 480 && rc.bestMile.timeSec < 540, 'best mile also stored (approx 8:xx)', JSON.stringify(rc.bestMile));
ok(rc.climbM === 95 && rc.peakSpeedKph === 16.1 && rc.avgHR === 150 && rc.peakHR === 171, 'climb, peak speed (track max), avg + peak HR', rc.climbM + '/' + rc.peakSpeedKph + '/' + rc.peakHR);
ok(rc.zones && rc.zones.length === 5 && rc.zones.reduce(function (a, z) { return a + z.pct; }, 0) >= 99 && rc.zones[2].sec === 480, 'HR zone split sums to ~100%, zone 3 = 8 min');
ok(rc.sameRoute.kind === 'faster' && rc.sameRoute.prevId === 'h1', 'same-route compare uses latest run on SAME route (h1), faster', JSON.stringify(rc.sameRoute));
ok(rc.sameRoute.deltaSec >= 1 && rc.sameRoute.deltaSec <= 60, 'delta is whole-run time, not another route', rc.sameRoute.deltaSec);
var L = RR.lines(rc);
ok(/Faster than your last run on this route by \d+:\d\d/.test(L.route), 'route line plain English', L.route);
ok(L.highlights.indexOf('Fastest km of the month') >= 0 && L.highlights.length <= 3 && L.highlights.length >= 1, 'highlight: fastest km of the month', JSON.stringify(L.highlights));
ok(L.highlights.indexOf('Longest run this week') >= 0, 'highlight: longest run this week (6 km > 5 km)');
ok(rc.recent && rc.recent.n === 4 && L.recent.indexOf('Faster than your last 4 runs') === 0, 'recent-average compare', L.recent);
var free = RR.build(mkRun('f', 0, null, [320, 320]), hist, { now: NOW });
ok(free.sameRoute.kind === 'first' && RR.lines(free).route === 'First run on this route', 'free run never compares with other runs');
var newRoute = RR.build(mkRun('n', 0, 'NEW', [320, 320]), hist, { now: NOW });
ok(newRoute.sameRoute.kind === 'first', 'unseen route -> first run on this route');
var empty = RR.build(mkRun('e', 0, 'R1', [330, 330]), [], { now: NOW });
ok(empty.recent === null && RR.lines(empty).recent.indexOf('No earlier runs') === 0 && empty.highlights[0].id === 'steady', 'no history: no comparison, steady highlight');
ok(RR.build(run, hist, { now: NOW }).highlights.length <= 3 && JSON.parse(JSON.stringify(rc)).bestKm.n === 6, 'recap is JSON-safe (persists with the run)');
var el = { innerHTML: '' }; RR.render(el, rc);
ok(/RUN RECAP/.test(el.innerHTML) && /rc-zones/.test(el.innerHTML) && /Best km/.test(el.innerHTML), 'render card html');
var noHR = RR.build(mkRun('z', 0, 'R1', [320, 320], { avgHR: 0, hrZoneMinutes: null, splits: [{ km: 1, timeSec: 320, avgHR: 0 }, { km: 2, timeSec: 320, avgHR: 0 }], trackPoints: [] }), hist, { now: NOW });
ok(noHR.zones === null && RR.lines(noHR).hr === null, 'no HR: no zone split, no HR line');

// ── imperial: same stored recap reads in miles ──
var ci = load('imperial'), RI = ci.RunRecap;
var rci = JSON.parse(JSON.stringify(rc));
var Li = RI.lines(rci);
ok(/^Best mile: mile \d in \d+:\d\d \(\d\.\d to \d\.\d mi\)/.test(Li.best), 'imperial: best mile line', Li.best);
ok(/mph/.test(Li.speed) && /ft/.test(Li.climb) && /\/mi/.test(RI.lines(RI.build(run, hist, { now: NOW })).recent), 'imperial: mph, ft, /mi everywhere', Li.speed + ' | ' + Li.climb);
ok(RI.lines(RI.build(run, hist, { now: NOW })).highlights.some(function (t) { return /mile of the month/.test(t); }), 'imperial highlight says mile');
console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
