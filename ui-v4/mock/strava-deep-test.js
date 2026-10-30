#!/usr/bin/env node
// Deep import + HR INSIGHTS page - Playwright against the MOCK Strava only (never real Strava, never the treadmill/adb).
//   flock /tmp/trsuite.lock node mock/strava-deep-test.js     -> writes docs/strava-deep-output.txt + docs/insights-*.png
// Starts the static UI (:8099) and the mock Strava (:8098) if they are not already up.
'use strict';
var path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
var UI = path.resolve(__dirname, '..');
var pw = require(path.resolve(UI, '../node_modules/playwright'));
var mockStrava = require('./strava-mock.js');
var HRA = require(path.join(UI, 'js/hr-analysis.js'));
var Deep = require(path.join(UI, 'js/strava-deep.js'));
var APP = 'http://localhost:8099/insights.html?strava=localhost:8098&rom=1';
var ORIGIN = 'http://localhost:8099';
var SV = 'http://localhost:8098';
var LOG = path.join(UI, 'docs/strava-deep-output.txt');
var lines = [], fails = 0, total = 0, children = [], srv = null;
function say(s) { console.log(s); lines.push(s); }
function ok(c, n, d) { total++; if (!c) fails++; say((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function near(a, b, tol) { return a != null && Math.abs(a - b) <= tol; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jget(u) { return fetch(u).then(function (r) { return r.json(); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function apiCalls(st) { var n = 0; for (var k in st) if (k.indexOf('GET /api/v3/') === 0) n += st[k]; return n; }
function up(u) { return fetch(u).then(function () { return true; }, function () { return false; }); }

// ════════════════════════════════════════════════════════════════════════════
// Part 1 - pure functions (Node): downsample + HRAnalysis vs hand-computed values
// ════════════════════════════════════════════════════════════════════════════
function series(n, step, f) { var t = []; for (var i = 0; i < n; i++) t.push(i * step); return t.map(f); }
function mkRun(id, start, o) {
  var step = o.step || 5, n = Math.round(o.dur / step), t = [], hr = [], v = [], d = [], alt = [], g = [], cad = [], dist = 0;
  for (var i = 0; i < n; i++) {
    var tt = i * step, sp = typeof o.v === 'function' ? o.v(tt) : o.v;
    t.push(tt); v.push(sp); d.push(dist); dist += sp * step;
    hr.push(typeof o.hr === 'function' ? o.hr(tt) : o.hr); alt.push(100); g.push(0); cad.push(o.cad || 85);
  }
  var rec = { id: id, summary: { id: id, start_date: start, start_date_local: start.replace('Z', ''), distance: dist, moving_time: n * step, elapsed_time: n * step, average_speed: dist / (n * step), total_elevation_gain: 0 },
    t: t, hr: o.noHR ? null : hr, v: v, g: g, d: d, alt: alt, cad: cad };
  if (o.max) rec.summary.max_heartrate = o.max;
  return rec;
}

function part1() {
  say('--- part 1: Deep.downsample + HRAnalysis (Node, hand-computed) ---');
  // downsample: 1 Hz, 62 s -> 5 s buckets
  var n = 62, time = series(n, 1, function (_, i) { return i; });
  var st = { time: time, heartrate: time.map(function (t) { return 100 + t; }), velocity_smooth: time.map(function () { return 2.5; }), distance: time.map(function (t) { return t * 2.5; }), cadence: time.map(function () { return 80; }) };
  var ds = Deep.downsample(st, 5);
  ok(ds.t.length === 13 && ds.t[1] === 5 && ds.t[12] === 60, 'downsample: 62 s at 1 Hz -> 13 points on a 5 s grid', ds.t.length);
  ok(ds.hr[0] === 102 && ds.hr[1] === 107, 'downsample: HR is the bucket mean (100..104 -> 102)', ds.hr[0] + ',' + ds.hr[1]);
  ok(ds.d[0] === 10 && ds.d[1] === 22.5, 'downsample: distance is the last value of the bucket', ds.d[0] + ',' + ds.d[1]);
  ok(ds.g === null && ds.alt === null, 'downsample: absent streams become null');
  var s2 = { time: [0, 1, 2, 3, 4, 5, 6], heartrate: [0, 0, 0, 0, 0, 0, 0], velocity_smooth: [1, 1, 1, 1, 1, 1, 1] };
  ok(Deep.downsample(s2, 5).hr === null, 'downsample: all-zero HR stream (strap dropped out) -> null');
  ok(Deep.downsample({}, 5).t.length === 0, 'downsample: no streams -> empty');
  var s3 = { time: [0, 10, 20, 30], heartrate: [100, 110, 120, 130] };   // already coarser than 5 s
  ok(Deep.downsample(s3, 5).t.join() === '0,10,20,30', 'downsample: coarse input is kept as is');

  // drift: constant 3 m/s, HR 130 until minute 10 then +0.2 bpm/min
  var r1 = mkRun(1, '2026-03-02T08:00:00Z', { dur: 2400, v: 3, hr: function (t) { return t < 600 ? 130 : 130 + 0.2 * (t - 600) / 60; } });
  var m1 = HRA.runMetrics(r1, { maxHR: 200 });
  ok(near(m1.driftBpmPerMin, 0.2, 0.002), 'drift: synthetic ramp 0.2 bpm/min recovered', m1.driftBpmPerMin);
  ok(m1.longestSteadySec >= 2300, 'longest steady section covers the whole run', m1.longestSteadySec);
  // avg HR by hand: mean over samples
  var sum = 0, cnt = 0; r1.hr.forEach(function (h) { sum += h; cnt++; });
  ok(near(m1.avgHR, sum / cnt, 0.01), 'avg HR equals hand-computed time-weighted mean', m1.avgHR.toFixed(3) + ' vs ' + (sum / cnt).toFixed(3));
  ok(near(m1.paceSecPerKm, 2400 / (3 * 2400 / 1000), 0.01), 'pace from distance/moving time = 333.3 s/km', m1.paceSecPerKm);
  ok(near(m1.cadenceSpm, 170, 0.01), 'cadence: one-foot 85 -> 170 spm', m1.cadenceSpm);
  // flat HR: drift zero
  var r0 = mkRun(2, '2026-03-04T08:00:00Z', { dur: 2400, v: 3, hr: 140 });
  ok(near(HRA.runMetrics(r0, {}).driftBpmPerMin, 0, 1e-9), 'drift: flat HR -> 0');
  // negative drift
  var rn = mkRun(3, '2026-03-05T08:00:00Z', { dur: 2400, v: 3, hr: function (t) { return t < 600 ? 140 : 140 - 0.1 * (t - 600) / 60; } });
  ok(near(HRA.runMetrics(rn, {}).driftBpmPerMin, -0.1, 0.002), 'drift: falling HR -> -0.1 bpm/min');
  // too short for drift
  ok(HRA.runMetrics(mkRun(4, '2026-03-06T08:00:00Z', { dur: 700, v: 3, hr: 140 }), {}).driftBpmPerMin === null, 'drift: not reported for a 11 min run (needs 5 min of steady data after minute 10)');
  // varying speed (intervals) -> no steady drift
  var ri = mkRun(5, '2026-03-07T08:00:00Z', { dur: 2400, v: function (t) { return Math.floor(t / 60) % 2 ? 4.2 : 2.2; }, hr: 150 });
  ok(HRA.runMetrics(ri, {}).driftBpmPerMin === null, 'drift: alternating-pace intervals are not steady -> null');

  // zones: 300 s@110, 600@130, 600@150, 600@170, 300@190 with max 200 -> 12.5/25/25/25/12.5
  var zr = mkRun(6, '2026-03-08T08:00:00Z', { dur: 2400, v: 3, hr: function (t) { return t < 300 ? 110 : t < 900 ? 130 : t < 1500 ? 150 : t < 2100 ? 170 : 190; } });
  var zm = HRA.runMetrics(zr, { maxHR: 200 });
  ok(zm.zonePct.join() === '12.5,25,25,25,12.5', 'zones: hand-computed 12.5/25/25/25/12.5 %', zm.zonePct.join());
  ok(near(zm.zonePct.reduce(function (a, b) { return a + b; }, 0), 100, 0.05), 'zones: percentages sum to 100');
  ok(zm.zoneSec.join() === '300,600,600,600,300', 'zones: seconds per zone', zm.zoneSec.join());
  ok(HRA.zoneIndex(160, 200) === 3 && HRA.zoneIndex(179.9, 200) === 3 && HRA.zoneIndex(180, 200) === 4, 'zone edges: 80 % of max = start of zone 4', HRA.zoneIndex(160, 200));

  // efficiency at 10 km/h (2.7778 m/s), HR 145, +- noise on speed
  var er = mkRun(7, '2026-04-02T08:00:00Z', { dur: 1800, v: function (t) { return 10 / 3.6 * (1 + 0.01 * Math.sin(t)); }, hr: 145 });
  var a1 = HRA.analyse([er], {});
  ok(a1.runs[0].efficiency === 145 && a1.refKmh === 10, 'efficiency: HR 145 at 10 km/h', a1.runs[0].efficiency + ' ref ' + a1.refKmh);

  // spike filter + max HR
  var sp = mkRun(8, '2026-04-03T08:00:00Z', { dur: 1200, v: 3, hr: function (t) { return t === 600 ? 200 : t === 800 ? 255 : 140; } });
  var sm = HRA.runMetrics(sp, {});
  ok(sm.hrSpikes >= 1 && sm.maxHR === 140, 'HR spikes (200 amid 140, 255 out of range) are removed from max HR', 'spikes ' + sm.hrSpikes + ' max ' + sm.maxHR);

  // best efforts: 2.5 m/s for 800 s (2000 m), 4 m/s for 250 s (1000 m), 2.5 m/s after
  var be = mkRun(9, '2026-04-04T08:00:00Z', { dur: 2000, step: 1, v: function (t) { return t < 800 ? 2.5 : t < 1050 ? 4 : 2.5; }, hr: 150 });
  ok(near(HRA.bestEffortSec(be, 1000), 250, 0.5), 'best 1 km = 250 s inside a faster kilometre', HRA.bestEffortSec(be, 1000));
  var bs = HRA.analyse([be], {}).bestEfforts;
  ok(bs['1km'] && near(bs['1km'].seconds, 250, 0.5), 'analyse(): bestEfforts 1km', bs['1km'] && bs['1km'].seconds);
  // GPS spike run excluded from best efforts
  var gj = mkRun(10, '2026-04-05T08:00:00Z', { dur: 600, step: 1, v: 3, hr: 150 }); for (var q = 300; q < gj.d.length; q++) gj.d[q] += 500;
  ok(HRA.analyse([gj], {}).bestEfforts['1km'] === null && HRA.runMetrics(gj, {}).flags.indexOf('gpsSpike') >= 0, 'GPS jump: flagged and excluded from best efforts');

  // max HR estimate from summary-only runs: [170..188 step 2] p95 = 187.1 -> 187; 250 excluded; short run excluded
  var recs = [], i;
  for (i = 0; i < 10; i++) recs.push({ id: 100 + i, summary: { id: 100 + i, start_date: '2026-05-0' + (i % 9 + 1) + 'T08:00:00Z', distance: 5000, moving_time: 1800, max_heartrate: 170 + 2 * i, average_heartrate: 150 } });
  recs.push({ id: 200, summary: { id: 200, start_date: '2026-05-10T08:00:00Z', distance: 5000, moving_time: 1800, max_heartrate: 250 } });
  recs.push({ id: 201, summary: { id: 201, start_date: '2026-05-11T08:00:00Z', distance: 800, moving_time: 300, max_heartrate: 214 } });
  var an = HRA.analyse(recs, {});
  ok(an.maxHR.est === 187 && an.maxHR.estimate.n === 10 && an.maxHR.estimate.top === 188, 'max-HR estimate: p95 of 10 valid runs = 187 (250 bpm and the 5 min run ignored)', JSON.stringify(an.maxHR.estimate));
  ok(an.quality.noStreams === 12 && an.runs.every(function (r) { return r.flags.indexOf('noStream') >= 0; }), 'summary-only runs are flagged noStream');

  // weekly volume + consistency: Mon 2026-03-02 (2 runs), none Mar 9, Mon Mar 16 (1 run)
  var wk = HRA.analyse([
    { id: 1, summary: { id: 1, start_date_local: '2026-03-03T07:00:00', distance: 5000, moving_time: 1800 } },
    { id: 2, summary: { id: 2, start_date_local: '2026-03-08T07:00:00', distance: 10000, moving_time: 3600 } },
    { id: 3, summary: { id: 3, start_date_local: '2026-03-17T07:00:00', distance: 8000, moving_time: 2700 } }], {});
  ok(wk.weekly.length === 3 && wk.weekly[0].week === '2026-03-02' && wk.weekly[0].runs === 2 && wk.weekly[0].distance === 15000 && wk.weekly[1].runs === 0 && wk.weekly[2].week === '2026-03-16',
     'weekly volume: Sunday 8 Mar belongs to week of 2 Mar, empty week filled', JSON.stringify(wk.weekly.map(function (w) { return w.week + ':' + w.runs; })));
  ok(wk.consistency.activeWeeks === 2 && wk.consistency.spanWeeks === 3 && wk.consistency.longestGapDays === 9 && wk.consistency.longestStreakWeeks === 1 && wk.consistency.activePct === 66.7,
     'consistency: 2 of 3 weeks, longest gap 9 days', JSON.stringify(wk.consistency));
  var L = wk.lengths.map(function (b) { return b.n; });
  ok(L.join() === '0,0,1,1,1,0,0' || L.join() === '0,1,0,1,0,0,0' || (L[1] === 1 && L[2] === 1 && L[3] === 1), 'run-length distribution buckets (5 km, 8 km, 10 km)', L.join());

  // fitness trend: three months at 150, 148, 146 bpm at 10 km/h -> slope -2 bpm/month
  var tr = [];
  ['2026-01', '2026-02', '2026-03'].forEach(function (mo, k) {
    for (var j = 0; j < 2; j++) tr.push(mkRun(300 + k * 10 + j, mo + '-1' + j + 'T08:00:00Z', { dur: 1800, v: 10 / 3.6, hr: 150 - 2 * k }));
  });
  var at = HRA.analyse(tr, {});
  ok(at.fitnessTrend.length === 3 && at.fitnessTrend[0].hr === 150 && at.fitnessTrend[2].hr === 146 && near(at.fitnessSlopePerMonth, -2, 1e-9), 'fitness trend: 150 -> 146 bpm, -2 bpm/month', at.fitnessTrend.map(function (x) { return x.hr; }).join() + ' slope ' + at.fitnessSlopePerMonth);
  ok(at.paceHrCurve.length >= 1 && at.paceHrCurve[0].kmh === 10, 'pace-HR curve has the 10 km/h bin', JSON.stringify(at.paceHrCurve[0]));
  var f = HRA.findings(at, null);
  ok(f.length >= 3 && f.some(function (x) { return /improving/.test(x); }), 'findings text: states fitness improving', f.length + ' lines');
  ok(HRA.findings({ runCount: 0 }, null)[0].indexOf('No runs') === 0, 'findings text: empty state');

  // grade effect: windows with grade +4 are 8 bpm higher than flat at the same speed
  var gr = [];
  for (i = 0; i < 6; i++) (function (i) { var vi = 2.8 + 0.1 * i; var rr = mkRun(400 + i, '2026-06-0' + (i + 1) + 'T08:00:00Z', { dur: 2400, v: vi, hr: function (t) { return 100 + 15 * vi + (t < 1200 ? 0 : 8); } }); rr.g = rr.t.map(function (t) { return t < 1200 ? 0 : 4; }); gr.push(rr); })(i);
  var ge = HRA.analyse(gr, {}).gradeEffect;
  ok(ge.slopeBpmPerPct != null && near(ge.slopeBpmPerPct, 2, 0.25), 'grade effect: +4 % adds 8 bpm -> about 2 bpm per 1 %', ge.slopeBpmPerPct);

  // ── review fixes: fitness slope per CALENDAR month ──
  function trendRuns(spec, base) { var out = []; spec.forEach(function (x, k) { for (var j = 0; j < 2; j++) out.push(mkRun(base + k * 10 + j, x[0] + '-1' + j + 'T08:00:00Z', { dur: 1800, v: 10 / 3.6, hr: x[1] })); }); return out; }
  // Jan 150, Mar 148, Jun 145 -> month index 0,2,5: mean x 7/3, Sxx 12.667, Sxy -12.667 -> slope exactly -1 bpm/month (index-based would say -2.5)
  var gap = HRA.analyse(trendRuns([['2026-01', 150], ['2026-03', 148], ['2026-06', 145]], 500), {});
  ok(gap.fitnessTrend.length === 3 && near(gap.fitnessSlopePerMonth, -1, 1e-9), 'fitness slope: Jan 150 / Mar 148 / Jun 145 = -1 bpm per CALENDAR month (not -2.5 per point)', gap.fitnessSlopePerMonth);
  // across a year end: Nov 152, Dec 150, Feb 146 -> x 0,1,3 -> slope -2
  var yr = HRA.analyse(trendRuns([['2025-11', 152], ['2025-12', 150], ['2026-02', 146]], 600), {});
  ok(near(yr.fitnessSlopePerMonth, -2, 1e-9), 'fitness slope: spacing across a year boundary (Nov/Dec/Feb) = -2 bpm per month', yr.fitnessSlopePerMonth);
  ok(near(yr.fitnessSlopePerMonth * 12, -24, 1e-6), 'per-year figure = slope x 12 from the real month spacing', yr.fitnessSlopePerMonth * 12);
  var two = HRA.analyse(trendRuns([['2026-01', 150], ['2026-03', 148]], 700), {});
  ok(two.fitnessSlopePerMonth === null, 'fitness slope: only 2 distinct months -> null');
  var same = HRA.analyse(trendRuns([['2026-01', 150], ['2026-01', 148], ['2026-01', 147]], 710), {});
  ok(same.fitnessSlopePerMonth === null, 'fitness slope: all runs in one month -> null');
  ok(HRA.findings(gap, null).some(function (x) { return /improving/.test(x); }), 'findings still say improving for the uneven spacing');

  // ── max HR: not from a single value, ignores implausible summary maxima when streams exist ──
  function sumRun(id, mx) { return { id: id, summary: { id: id, start_date: '2026-05-0' + (id % 9 + 1) + 'T08:00:00Z', distance: 5000, moving_time: 1800, max_heartrate: mx, average_heartrate: 150 } }; }
  var m1 = HRA.analyse([sumRun(1, 190)], {}).maxHR;
  ok(m1.est === null && m1.estimate.notEnough === true && m1.estimate.n === 1, 'max HR: 1 run -> no estimate (not the single top value 190)', JSON.stringify(m1.estimate));
  var m2 = HRA.analyse([sumRun(1, 190), sumRun(2, 180)], {}).maxHR;
  ok(m2.est === null, 'max HR: 2 runs -> still no estimate');
  var m4 = HRA.analyse([sumRun(1, 170), sumRun(2, 172), sumRun(3, 176), sumRun(4, 200)], {}).maxHR;
  ok(m4.est === 174 && m4.estimate.lowConfidence === true && m4.estimate.top === 200, 'max HR: 4 runs -> MEDIAN 174 (not the top 200), flagged low confidence', JSON.stringify(m4.estimate));
  ok(HRA.findings(HRA.analyse([sumRun(1, 170), sumRun(2, 172), sumRun(3, 176), sumRun(4, 200)], {}), null).some(function (x) { return /Low confidence/.test(x); }), 'findings text says low confidence');
  // streams at a steady 150 bpm (stream p99.5 = 150): summary maxima 158,160,161 are within 15 bpm; 190 and 200 are not and are ignored
  var sr = [], q;
  for (q = 0; q < 6; q++) sr.push(mkRun(800 + q, '2026-06-0' + (q + 1) + 'T08:00:00Z', { dur: 1200, v: 3, hr: 150 }));
  [158, 160, 161, 190, 200].forEach(function (mx, ix) { sr.push(sumRun(900 + ix, mx)); });
  var me = HRA.analyse(sr, {}).maxHR.estimate;
  ok(me.streamP995 === 150 && me.ignoredHigh === 2 && me.n === 9 && me.top === 161, 'max HR: summary 190 and 200 (> stream p99.5 150 + 15) ignored, 158/160/161 kept', JSON.stringify(me));
  // p95 of [150 x6, 158, 160, 161]: rank 0.95*8 = 7.6 -> 160 + 0.6*(161-160) = 160.6 -> 161
  ok(me.est === 161 && me.p95 === 161 && me.lowConfidence === false, 'max HR: p95 of the 9 kept values = 160.6 -> 161 (hand-computed)', me.est);
  // consecutive-day gap wording
  var fw = HRA.findings(HRA.analyse([{ id: 1, summary: { id: 1, start_date_local: '2026-03-02T07:00:00', distance: 5000, moving_time: 1800 } }, { id: 2, summary: { id: 2, start_date_local: '2026-03-03T07:00:00', distance: 5000, moving_time: 1800 } }], {}), null).join(' | ');
  ok(/longest break \d+ days?\./.test(fw) && !/ 1 days/.test(fw), 'copy: no "1 days" in the findings', (/longest break[^|]*/.exec(fw) || [''])[0]);
  ok(/1 run loaded/.test(HRA.findings(HRA.analyse([sumRun(1, 190)], {}), null)[0]), 'copy: "1 run loaded" singular', HRA.findings(HRA.analyse([sumRun(1, 190)], {}), null)[0]);

  // ── StravaDeep.mergeInto: another writer's records are never overwritten; counters only go up ──
  var M = Deep._mergeInto;
  var loc = { ids: [1, 2, 3], status: { 1: 'p', 2: 'f', 3: 'p' }, attempts: { 1: 1 }, listRev: 1, day: '2026-10-28', dayCount: 5, win: { start: 1000, n: 3 } };
  M(loc, { ids: [1, 2, 3], status: { 1: 'f', 2: 'p', 3: 's:forbidden' }, attempts: { 1: 2 }, listRev: 1, day: '2026-10-28', dayCount: 9, win: { start: 1000, n: 7 } });
  ok(loc.status[1] === 'f' && loc.status[2] === 'f' && loc.status[3] === 's:forbidden', 'merge: terminal status from either writer wins over pending', JSON.stringify(loc.status));
  ok(loc.dayCount === 9 && loc.win.n === 7 && loc.win.start === 1000, 'merge: same day/window -> counters take max()', loc.dayCount + '/' + loc.win.n);
  M(loc, { ids: [1, 2, 3], status: {}, listRev: 1, day: '2026-10-27', dayCount: 99, win: { start: 500, n: 99 } });
  ok(loc.dayCount === 9 && loc.win.n === 7, 'merge: an OLDER stored day/window never lowers or replaces ours');
  M(loc, { ids: [1, 2, 3], status: {}, listRev: 1, day: '2026-10-29', dayCount: 2, win: { start: 2000, n: 1 } });
  ok(loc.day === '2026-10-29' && loc.dayCount === 2 && loc.win.start === 2000 && loc.win.n === 1, 'merge: a LATER stored day/window (clock went backwards here) is adopted with its count');
  var loc2 = { ids: [5], status: { 5: 'p' }, attempts: {}, listRev: 1, day: 'd', dayCount: 0, win: { start: 0, n: 0 } };
  M(loc2, { ids: [7, 8], status: { 7: 'f', 8: 'p' }, listRev: 3, listDone: true, listedAt: 5, day: 'd', dayCount: 0, win: { start: 0, n: 0 } });
  ok(loc2.ids.join() === '7,8' && loc2.status[7] === 'f' && loc2.listRev === 3, 'merge: higher listRev brings the other writer\'s list and statuses');
}

// ════════════════════════════════════════════════════════════════════════════
// Part 2 - the page against the mock
// ════════════════════════════════════════════════════════════════════════════
(async function () {
  part1();
  if (!(await up('http://localhost:8099/'))) children.push(cp.spawn('node', [path.join(__dirname, 'static.js')], { stdio: 'ignore' }));
  if (await up(SV + '/mock/info')) await jpost(SV + '/mock/reset'); else srv = await mockStrava.start(8098);
  await sleep(700);
  say('--- part 2: page + mock Strava ' + new Date().toISOString() + ' ---');

  var browser = await pw.chromium.launch();
  var ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
  var page = await ctx.newPage();
  var errors = [], reqLog = [], extHosts = {};
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && !/Failed to load resource|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('request', function (r) {
    var u = new URL(r.url());
    if (u.port === '8098') reqLog.push(r.method() + ' ' + u.pathname);
    else if (u.hostname !== 'localhost') extHosts[u.hostname] = 1;
  });
  // skewable clock: Date.now() + sessionStorage.__skew (so a 15 minute Strava window can be "waited" in milliseconds)
  await ctx.addInitScript(function () {
    var real = Date.now.bind(Date), cur = 0;
    function rd() { try { return +sessionStorage.getItem('__skew') || 0; } catch (e) { return 0; } }
    cur = rd();
    Date.now = function () { return real() + (window.__skewNow != null ? window.__skewNow : cur); };
    window.__setSkew = function (v) { window.__skewNow = v; try { sessionStorage.setItem('__skew', String(v)); } catch (e) {} };
  });

  async function st() { return page.evaluate(function () { return StravaDeep.status(); }); }
  async function waitFor(pred, ms, what) {
    var t0 = Date.now(), s;
    while (Date.now() - t0 < (ms || 20000)) { s = await st(); if (pred(s)) return s; await sleep(150); }
    say('   (timeout waiting for ' + what + '; last: ' + JSON.stringify(s) + ')'); return s;
  }
  var skew = 0;
  async function setSkew(v) { skew = v; await page.evaluate(function (v) { window.__setSkew(v); }, v); await jpost(SV + '/mock/config', { skewMs: v }); }
  async function load() { await page.goto(APP, { waitUntil: 'load' }); await sleep(400); }
  function storeRecs() {
    return page.evaluate(function () {
      return new Promise(function (resolve) {
        var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () {
          var db = r.result, q = db.transaction('runs').objectStore('runs').getAll(); q.onsuccess = function () { resolve(q.result); db.close(); };
        };
      });
    });
  }
  async function dbInfo() {
    return page.evaluate(function () {
      return indexedDB.databases().then(function (l) { return l.map(function (d) { return d.name + '@' + d.version; }).sort(); });
    });
  }

  // ── own 'trailrunner' database + tr_runs that must never change ─────────────
  await page.goto(ORIGIN + '/manifest.json', { waitUntil: 'load' });
  await page.evaluate(function () {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('tr_runs', JSON.stringify([{ id: 'run_keep', routeName: 'Soph run', distanceKm: 5, elapsed: 1800 }]));
    return new Promise(function (resolve) {
      var r = indexedDB.open('trailrunner', 7);
      r.onupgradeneeded = function () { var db = r.result; db.createObjectStore('runs', { keyPath: 'id' }); db.createObjectStore('kv'); };
      r.onsuccess = function () { var db = r.result, t = db.transaction('runs', 'readwrite'); t.objectStore('runs').put({ id: 'keep1', v: 'SOPH' }); t.oncomplete = function () { db.close(); resolve(); }; };
    });
  });
  var trRunsBefore = await page.evaluate(function () { return localStorage.getItem('tr_runs'); });

  // ── 1. not connected ────────────────────────────────────────────────────────
  await load();
  var hintShown = await page.evaluate(function () { return document.getElementById('connectHint').className; });
  ok(/show/.test(hintShown), 'not connected: Connect hint is shown');
  ok(await page.evaluate(function () { return document.getElementById('btnStart').disabled; }), 'not connected: START is disabled');
  await page.screenshot({ path: path.join(UI, 'docs/insights-1-not-connected.png') });
  var hl = await page.evaluate(function () { var r = document.querySelector('.hint-box a').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  ok(hl.h >= 64 && hl.w >= 64, 'not connected: the Open TrailRunner link is a >= 64 px touch target', Math.round(hl.w) + 'x' + Math.round(hl.h));

  // connect with MOCK tokens (never real ones)
  var tok = await jpost(SV + '/oauth/token', { grant_type: 'authorization_code', code: 'mockcode' });
  await page.evaluate(function (a) {
    localStorage.setItem('tr_strava', JSON.stringify({ access_token: a.access_token, refresh_token: a.refresh_token, expires_at: a.expires_at, scope: a.scope, athlete: { id: 4242, firstname: 'Soph', lastname: 'Mock' } }));
    localStorage.setItem('tr_strava_app', JSON.stringify({ clientId: '1', clientSecret: 'mock-secret-xyz' }));
  }, tok);
  var XSS = '<img src=x onerror="window.__xss=1">';
  var LONGNAME = 'Sunday long run along the canal towpath and back through the park with Soph and the dog, last one before the race';
  var dres = await jpost(SV + '/mock/deep', { count: 200, names: { 3: XSS, 4: '"><script>window.__xss2=1</script>', 5: LONGNAME }, forbid: [10], missing: [20] });
  ok(dres.ok && dres.activities > 200, 'mock: 200 deep runs (+ interleaved rides)', dres.activities);

  // align both clocks to 2 minutes after a Strava window boundary, 13 min of room
  var real = Date.now(), dayMs0 = Math.floor(real / 86400000) * 86400000, base = dayMs0 + 6 * 3600000 + 120000;   // fake clock = 06:02 UTC (today, or yesterday if that is still ahead): the whole test stays inside ONE UTC day, so the daily counter can never roll at midnight
  if (base > real) base -= 86400000;
  await setSkew(base - real);
  await load();
  ok(await page.evaluate(function () { return document.getElementById('connectHint').className.indexOf('show') < 0; }), 'connected: hint hidden');
  ok(await page.evaluate(function () { return !document.getElementById('btnStart').disabled; }), 'connected: START enabled');
  ok((await st()).state === 'idle', 'fresh: nothing loaded');

  // ── 2. first window: 80 requests then wait ──────────────────────────────────
  await page.click('#btnStart');
  var s1 = await waitFor(function (s) { return s.state === 'waiting'; }, 40000, 'first window to fill');
  var stats1 = await jget(SV + '/mock/stats');
  var calls1 = apiCalls(stats1);
  ok(s1.state === 'waiting' && s1.loaded + s1.skipped === 78, 'window 1: list (2 pages) + 78 runs = 80 requests, then waits', 'loaded ' + s1.loaded + ' skipped ' + s1.skipped);
  ok(calls1 === 80 && stats1['GET /api/v3/athlete/activities'] === 2, 'mock saw at most 80 requests in the window, 2 of them list pages', calls1 + ' list ' + stats1['GET /api/v3/athlete/activities']);
  var txt = await page.evaluate(function () { return document.getElementById('deepLine').textContent; });
  ok(/^Loaded \d+ of 200 runs, next batch in \d+ min/.test(txt), 'status text: "Loaded N of 200 runs, next batch in M min"', txt);
  ok(s1.nextInS > 600 && s1.nextInS < 780, 'next batch countdown is the time to the next :15 boundary (~11 min)', s1.nextInS + ' s');
  ok(s1.skippedBy.forbidden === 1 && s1.skippedBy.notfound === 1 || s1.skippedBy.forbidden + s1.skippedBy.notfound === 2, '403 and 404 runs recorded and skipped', JSON.stringify(s1.skippedBy));
  await sleep(3500);   // let the debounced analysis render while waiting
  await page.screenshot({ path: path.join(UI, 'docs/insights-2-waiting.png') });
  var pausedBtns = await page.evaluate(function () { return { pause: !document.getElementById('btnPause').disabled, cancel: !document.getElementById('btnCancel').disabled, start: document.getElementById('btnStart').disabled }; });
  ok(pausedBtns.pause && pausedBtns.cancel && pausedBtns.start, 'while waiting: PAUSE and CANCEL usable, START disabled');
  await sleep(2500);
  ok(apiCalls(await jget(SV + '/mock/stats')) === calls1, 'no request is made while waiting for the next window');

  // ── 3. reload mid-wait resumes, never re-fetches ────────────────────────────
  await load();
  var s2 = await st();
  ok(s2.loaded === s1.loaded && s2.skipped === s1.skipped, 'reload: progress persisted (same loaded/skipped)', s2.loaded + '/' + s2.skipped);
  var s2b = await waitFor(function (s) { return s.state === 'waiting' || s.state === 'running'; }, 30000, 'reload resume');   // lease of the previous page load: released on pagehide or expires after 20 s
  ok(s2b.state === 'waiting' || s2b.state === 'running', 'reload: auto-resumes in the waiting state (own tab, once the previous load\'s lease is gone; was "' + s2.state + '" at first look)', s2b.state);
  await sleep(2000);
  ok(apiCalls(await jget(SV + '/mock/stats')) === calls1, 'reload inside the same window: no new requests');
  ok(s2.windowUsed === 80, 'reload: this window\'s request count survived (80 of 80)', s2.windowUsed);

  // ── 4. next window ──────────────────────────────────────────────────────────
  await setSkew(skew + 900000);
  var s3 = await waitFor(function (s) { return s.state === 'waiting' && s.loaded + s.skipped > 78; }, 40000, 'second window to fill');
  var calls2 = apiCalls(await jget(SV + '/mock/stats'));
  ok(s3.loaded + s3.skipped === 78 + 80 && calls2 - calls1 === 80, 'window 2: exactly 80 more requests', (s3.loaded + s3.skipped) + ' runs, +' + (calls2 - calls1) + ' calls');
  await setSkew(skew + 900000);
  var s4 = await waitFor(function (s) { return s.state === 'done'; }, 40000, 'all done');
  var stats3 = await jget(SV + '/mock/stats'), hits = await jget(SV + '/mock/deephits');
  ok(s4.state === 'done' && s4.loaded === 198 && s4.skipped === 2 && s4.total === 200, 'done: 198 loaded + 2 skipped = 200', JSON.stringify({ l: s4.loaded, s: s4.skipped, t: s4.total }));
  var ids = Object.keys(hits);
  ok(ids.length === 200 && ids.every(function (k) { return hits[k] === 1; }), 'every run\'s streams were requested exactly once across reload and 3 windows', ids.length + ' ids, max hits ' + Math.max.apply(null, ids.map(function (k) { return hits[k]; })));
  ok(apiCalls(stats3) === 202 && s4.reqToday === 202, 'total requests 202 (2 list + 200 streams), under the 250/day cap', apiCalls(stats3) + ' / counter ' + s4.reqToday);
  ok(s4.message.indexOf('All done') === 0, 'done message', s4.message);
  ok(/198 runs loaded, 2 skipped \(.*1 not found on Strava.*1 private \/ no access|1 private \/ no access.*1 not found on Strava/.test(s4.message), 'R3-2 final screen lists the skipped count WITH reasons', s4.message);
  ok(reqLog.every(function (r) { return /^GET /.test(r) || r === 'POST /oauth/token'; }), 'only GET requests to Strava (read-only), plus the mock OAuth token call', reqLog.filter(function (r) { return !/^GET /.test(r); }).join(','));
  ok(Object.keys(extHosts).length === 0, 'no request left localhost (no real Strava)', Object.keys(extHosts).join());

  // ── 5. stored data ──────────────────────────────────────────────────────────
  var recs = await storeRecs();
  ok(recs.length === 200, 'IndexedDB trailrunner_hrtrain holds 200 records', recs.length);
  var full = recs.filter(function (r) { return r.t && r.t.length; });
  var r0 = full[0];
  ok(full.length === 198, '198 records carry streams, 2 are skip markers', full.length);
  var shapeOk = full.every(function (r) {
    var n = r.t.length;
    return [r.hr, r.v, r.g, r.d, r.alt, r.cad].every(function (a) { return a === null || a.length === n; }) && r.v && r.d && r.g && r.alt && r.cad;
  });
  ok(shapeOk, 'every stream array is aligned with t[] (or null)');
  var stepOk = full.every(function (r) { for (var i = 1; i < r.t.length; i++) if (r.t[i] - r.t[i - 1] > 5 || r.t[i] <= r.t[i - 1]) return false; return true; });
  ok(stepOk, 'resolution: time grid never coarser than 5 s');
  ok(r0.t.length < 800 && r0.t.length > 250, 'downsampled: ~25-55 min runs have 300-660 points instead of 1500-3300', r0.t.length);
  var noHr = full.filter(function (r) { return r.hr === null; });
  ok(noHr.length >= 15 && noHr.every(function (r) { return r.summary.has_heartrate === false; }), 'runs without HR keep hr = null (' + noHr.length + ' runs)');
  var skipRecs = recs.filter(function (r) { return r.skip; }).map(function (r) { return r.skip; }).sort();
  ok(skipRecs.join() === 'forbidden,notfound', 'skip markers: forbidden + notfound', skipRecs.join());
  ok(recs.every(function (r) { var j = JSON.stringify(r); return !/access_token|refresh_token|client_secret|mock_access|mock_refresh|mock-secret/.test(j) && !r.summary.athlete && !r.summary.map; }), 'stored records contain no tokens, secrets, athlete object or map polyline');
  ok(recs.filter(function (r) { return /Ride/.test(r.summary.type || ''); }).length === 0, 'rides in the activity list were ignored');
  ok(recs.filter(function (r) { return r.summary.sport_type === 'TrailRun'; }).length > 5 && recs.some(function (r) { return r.summary.sport_type === 'VirtualRun'; }), 'TrailRun and VirtualRun included');

  // ── 6. analysis page content ────────────────────────────────────────────────
  await sleep(800);
  await page.evaluate(function () { return InsightsPage.render(); });
  var A = await page.evaluate(function () { var a = InsightsPage.analysis(); return { n: a.runCount, ws: a.quality.withStreams, trendN: a.fitnessTrend.length, slope: a.fitnessSlopePerMonth, curve: a.paceHrCurve.length, drift: a.drift, max: a.maxHR.est, ref: a.refKmh, zones: a.zones.pct, noHR: a.quality.noHR, gps: a.quality.gpsSpike, stops: a.quality.stops, best5: a.bestEfforts['5km'], weeks: a.weekly.length }; });
  ok(A.n === 200 && A.ws === 198, 'page analysed 200 runs (198 with streams)', A.n + '/' + A.ws);
  ok(A.trendN >= 8 && A.slope < -0.1, 'fitness trend: improving (older mock runs have higher HR), ' + A.trendN + ' months, slope ' + (A.slope && A.slope.toFixed(2)) + ' bpm/month');
  ok(A.drift.n > 100 && near(A.drift.median, 0.25, 0.08), 'drift distribution: mock runs drift 0.25 bpm/min after minute 10', A.drift.n + ' runs, median ' + (A.drift.median && A.drift.median.toFixed(3)));
  ok(A.curve >= 3, 'pace-HR curve has >= 3 speed bins', A.curve);
  ok(A.max >= 150 && A.max <= 215, 'max HR estimate in range', A.max);
  ok(Math.abs(A.zones.reduce(function (a, b) { return a + b; }, 0) - 100) < 0.5, 'zone distribution sums to 100 %', A.zones.join('/'));
  ok(A.noHR >= 15 && A.gps >= 6 && A.stops >= 20, 'quality report: runs without HR, GPS jumps (every 25th) and stops (every 6th) detected', 'noHR ' + A.noHR + ' gps ' + A.gps + ' stops ' + A.stops);
  ok(A.best5 && A.best5.seconds > 900 && A.best5.seconds < 2200, 'best 5 km found', A.best5 && A.best5.seconds);
  var pg = await page.evaluate(function () {
    return { find: document.querySelectorAll('#findList li').length, svgs: document.querySelectorAll('svg.chart').length, rows: document.querySelectorAll('#runsBox tr').length, runsText: document.getElementById('runsBox').textContent, hint: document.getElementById('runsHint').textContent,
      xss: window.__xss, xss2: window.__xss2, imgs: document.querySelectorAll('#runsBox img, #runsBox script').length, bodyW: document.documentElement.scrollWidth };
  });
  ok(pg.find >= 6, 'plain-English findings list has lines', pg.find);
  ok(pg.svgs >= 6, 'charts rendered (trend, curve, drift, zones, weekly, lengths)', pg.svgs);
  ok(pg.rows === 31, 'recent runs table: header + 30 rows', pg.rows);
  ok(pg.xss === undefined && pg.xss2 === undefined && pg.imgs === 0, 'XSS in run names: not executed and no injected elements');
  ok(pg.runsText.indexOf('<img src=x onerror=') >= 0 && pg.runsText.indexOf('<script>') >= 0, 'XSS names are shown as literal text (escaped)');
  ok(/no HR/.test(pg.runsText) || /no HR/.test(await page.evaluate(function () { return document.getElementById('runsBox').innerHTML; })), 'quality flags shown in the runs table');
  var nmi = await page.evaluate(function (LN) {
    var tds = Array.prototype.slice.call(document.querySelectorAll('#runsBox td.nm')), t = tds.filter(function (x) { return x.getAttribute('title') === LN; })[0];
    var xs = tds.filter(function (x) { return /onerror/.test(x.getAttribute('title') || ''); })[0];
    return { found: !!t, w: t ? t.getBoundingClientRect().width : 0, text: t ? t.textContent : '', ell: t ? getComputedStyle(t).textOverflow : '', xsTitle: xs ? xs.getAttribute('title') : null, imgs: document.querySelectorAll('#runsBox td.nm *').length };
  }, LONGNAME);
  ok(nmi.found && nmi.text === LONGNAME && nmi.ell === 'ellipsis' && nmi.w >= 240, 'runs table: long name has the FULL name as title, ellipsis, name column >= 240 px wide', Math.round(nmi.w) + ' px');
  ok(nmi.xsTitle === XSS && nmi.imgs === 0, 'runs table: HTML in a name is only ever text / title attribute (no child elements)');
  ok(pg.bodyW <= 1920, 'no horizontal overflow at 1920 px', pg.bodyW);
  await page.screenshot({ path: path.join(UI, 'docs/insights-3-done-top.png') });
  await page.screenshot({ path: path.join(UI, 'docs/insights-4-full.png'), fullPage: true });

  // ── 7. layout rules (1920x1000, rom bottom strip) ───────────────────────────
  await page.evaluate(function () { window.scrollTo(0, 0); });
  var lay = await page.evaluate(function () {
    var out = { btns: [], vh: innerHeight, links: [] };
    Array.prototype.forEach.call(document.querySelectorAll('.btn, .in-back'), function (b) { var r = b.getBoundingClientRect(); out.btns.push({ id: b.id || b.className, x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom }); });
    return out;
  });
  ok(lay.btns.every(function (b) { return b.h >= 64 && b.w >= 64; }), 'every button is at least 64x64 px', lay.btns.map(function (b) { return Math.round(b.h); }).join(','));
  ok(lay.btns.every(function (b) { return !(b.x < 110 && b.y < 110); }), 'nothing interactive in the top-left 110x110');
  ok(lay.btns.every(function (b) { return b.b <= lay.vh - 80; }), 'import controls end above the bottom 80 px strip', Math.max.apply(null, lay.btns.map(function (b) { return Math.round(b.b); })) + ' of ' + lay.vh);
  var back = lay.btns[0];
  ok(back.x >= 110, 'back link starts at x >= 110', Math.round(back.x));
  var padB = await page.evaluate(function () { return parseFloat(getComputedStyle(document.body).paddingBottom); });
  ok(padB >= 160, 'rom-bottom: last content scrollable above the 80 px strip', padB);
  ok(await page.evaluate(function () { return document.getElementById('backLink').getAttribute('href'); }) === 'stats.html', 'back link goes to stats.html');
  ok(await page.evaluate(function () { return typeof TM === 'undefined' && !document.querySelector('script[src*="treadmill"]'); }), 'treadmill.js is not loaded (no TM global)');

  // ── 8. export ───────────────────────────────────────────────────────────────
  var tokens = await page.evaluate(function () { var t = JSON.parse(localStorage.getItem('tr_strava')); return [t.access_token, t.refresh_token]; });
  var dl = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  var tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trdeep-')), 'export.json');
  await dl[0].saveAs(tmp);
  var raw = fs.readFileSync(tmp, 'utf8'), ex = JSON.parse(raw);
  ok(/^trailrunner-hr-deep-\d{4}-\d{2}-\d{2}\.json$/.test(dl[0].suggestedFilename()), 'export file name', dl[0].suggestedFilename());
  ok(ex.format === 'trailrunner-hr-deep' && ex.version === 1 && ex.runCount === 198 && ex.runs.length === 198 && ex.skipped.length === 2 && ex.resolutionSec === 5, 'export shape: format/version/198 runs/2 skipped/5 s', ex.runCount + ' runs');
  var er0 = ex.runs[0];
  ok(er0.streams && Array.isArray(er0.streams.t) && Array.isArray(er0.streams.hr || []) && er0.distance > 0 && er0.start_date && er0.moving_time > 0 && er0.average_speed > 0, 'export run: summary fields + streams {t,hr,v,g,d,alt,cad}');
  ok(tokens.every(function (t) { return raw.indexOf(t) < 0; }) && !/access_token|refresh_token|client_secret|mock-secret|Soph|Mock|athlete|firstname|email/i.test(raw), 'export contains no tokens, secret, athlete name/id or e-mail');
  ok(!/Deep run|<img|<script|"name"/.test(raw), 'export carries no run names (and so no XSS payloads)');
  ok(!/latlng|summary_polyline|start_latlng/.test(raw), 'export carries no location data');
  ok(raw.length < 15 * 1024 * 1024, 'export size sane for the AndroidBridge limit', Math.round(raw.length / 1024) + ' KB');
  ok(/Download requested - check the Downloads folder.*KB/.test(await page.evaluate(function () { return document.getElementById('toast').textContent; })) && !/Export started/.test(await page.evaluate(function () { return document.getElementById('toast').textContent; })), 'export toast: download REQUESTED (not claimed) + on-screen file size');

  // ── 9. dedupe: a second run fetches nothing ─────────────────────────────────
  var btnTxt = await page.evaluate(function () { return document.getElementById('btnStart').textContent; });
  ok(btnTxt === 'CHECK FOR NEW RUNS', 'after completion the button offers CHECK FOR NEW RUNS', btnTxt);
  await page.click('#btnStart');
  var s5 = await waitFor(function (s) { return s.state === 'done'; }, 20000, 'second pass');
  await sleep(500);
  var stats4 = await jget(SV + '/mock/stats'), hits2 = await jget(SV + '/mock/deephits');
  ok(stats4['GET /api/v3/athlete/activities'] === 4 && apiCalls(stats4) === 204, 'second pass: only the list was re-read (+2 requests)', apiCalls(stats4));
  ok(Object.keys(hits2).every(function (k) { return hits2[k] === 1; }), 'second pass: no stored run fetched again');
  ok(s5.loaded === 198 && s5.skipped === 2, 'second pass: still 198 + 2');
  var recs2 = await storeRecs();
  ok(recs2.length === 200, 'second pass: still 200 records (no duplicates)');

  // ── 10. the app's own storage was never touched ─────────────────────────────
  var dbs = await dbInfo();
  ok(dbs.indexOf('trailrunner@7') >= 0 && dbs.indexOf('trailrunner_hrtrain@1') >= 0, 'databases: trailrunner still at version 7, hrtrain separate', dbs.join(' '));
  var own = await page.evaluate(function () {
    return new Promise(function (resolve) {
      var r = indexedDB.open('trailrunner'); r.onsuccess = function () { var db = r.result, q = db.transaction('runs').objectStore('runs').getAll(); q.onsuccess = function () { resolve({ ver: db.version, stores: Array.prototype.slice.call(db.objectStoreNames), rows: q.result }); db.close(); }; };
    });
  });
  ok(own.ver === 7 && own.stores.join() === 'kv,runs' && own.rows.length === 1 && own.rows[0].v === 'SOPH', "'trailrunner' IndexedDB: version 7, same stores, Soph's record intact");
  ok(await page.evaluate(function () { return localStorage.getItem('tr_runs'); }) === trRunsBefore, "localStorage tr_runs is byte-identical (stats runs untouched)");
  ok(!await page.evaluate(function () { var l = []; for (var i = 0; i < localStorage.length; i++) l.push(localStorage.key(i)); return l.some(function (k) { return /hrtrain|deep/i.test(k); }); }), 'no deep-import data in localStorage');

  // ── 11. fault scenarios on fresh data ───────────────────────────────────────
  say('--- fault scenarios ---');
  async function fresh(count, o) {
    await page.evaluate(function () { return StravaDeep.wipe(); });
    var body = { count: count }; for (var k in (o || {})) body[k] = o[k];
    await jpost(SV + '/mock/deep', body);
    await setSkew(skew + 900000);      // a clean Strava window for every scenario
    await load();
  }
  // 401: two 401s in a row (the first triggers StravaApi's one refresh+retry, the second is final)
  await fresh(30, {});
  await jpost(SV + '/mock/fault', { kind: '401', count: 2 });
  await page.click('#btnStart');
  var s6 = await waitFor(function (s) { return s.state === 'stopped'; }, 15000, '401 stop');
  ok(s6.state === 'stopped' && /login expired.*reconnect Strava/i.test(s6.message), '401: stops with a clear reconnect message', s6.message);
  ok(s6.loaded === 0, '401: nothing marked as loaded');
  ok(await page.evaluate(function () { var e = document.getElementById('deepLine'); return /warn/.test(e.className); }), '401: message highlighted');
  await page.screenshot({ path: path.join(UI, 'docs/insights-5-401.png') });
  ok(await page.evaluate(function () { return !document.getElementById('btnStart').disabled; }), '401: START usable again after reconnect');
  await page.click('#btnStart');
  var s7 = await waitFor(function (s) { return s.state === 'done'; }, 20000, 'resume after 401');
  ok(s7.state === 'done' && s7.loaded === 30, '401: pressing START again completes all 30 runs', s7.loaded);

  // 429: server says "slow down" -> cool-down until the next window, then carries on
  await fresh(12, {});
  var skew429 = skew + 0;
  await jpost(SV + '/mock/fault', { kind: '429', count: 1 });
  await page.click('#btnStart');
  var s8 = await waitFor(function (s) { return s.state === 'waiting'; }, 15000, '429 wait');
  ok(s8.state === 'waiting' && s8.nextInS > 60 && /trying again in \d+ min/.test(s8.message), '429: waits for the next window with a countdown', s8.message);
  await setSkew(skew + 900000);
  var s9 = await waitFor(function (s) { return s.state === 'done'; }, 20000, 'after 429');
  ok(s9.state === 'done' && s9.loaded === 12, '429: carries on by itself in the next window and finishes', s9.loaded);

  // permission errors on every run -> stops after 3 with a permission message
  await fresh(10, { scope403: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  await page.click('#btnStart');
  var s10 = await waitFor(function (s) { return s.state === 'stopped'; }, 15000, 'scope stop');
  ok(s10.state === 'stopped' && /permission/i.test(s10.message) && s10.skipped === 2, 'missing permission: stops after 3 failures with a permission message', s10.message + ' skipped ' + s10.skipped);

  // pause / cancel
  await fresh(60, {});
  await page.click('#btnStart');
  await waitFor(function (s) { return s.loaded >= 3; }, 15000, 'a few loaded');
  await page.click('#btnPause');
  var s11 = await waitFor(function (s) { return s.state === 'paused'; }, 5000, 'paused');
  await sleep(700);
  var c1 = (await st()).loaded;
  await sleep(1200);
  var c2 = (await st()).loaded;
  ok(s11.state === 'paused' && c1 === c2 && c2 < 60, 'PAUSE stops fetching and keeps progress', c1 + ' -> ' + c2);
  await load();
  var s12 = await st();
  ok(s12.state === 'paused' && s12.loaded === c2, 'reload after PAUSE stays paused (does not auto-start)', s12.state);
  await page.click('#btnStart');
  await waitFor(function (s) { return s.loaded >= c2 + 2; }, 10000, 'resumed');
  await page.click('#btnCancel');
  await page.click('#dlgYes');
  var s13 = await waitFor(function (s) { return s.state !== 'running' && s.state !== 'waiting'; }, 8000, 'cancelled');
  ok(s13.pending === 0 && s13.loaded >= c2 + 2 && s13.state === 'paused', 'CANCEL drops the unfinished queue, keeps loaded runs', JSON.stringify({ p: s13.pending, l: s13.loaded, st: s13.state }));

  // daily cap: pretend 249 requests were made today
  await fresh(10, {});
  await page.evaluate(function () { return new Promise(function (res) {
    var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () { var db = r.result, t = db.transaction('meta', 'readwrite'), g = t.objectStore('meta').get('state'); g.onsuccess = function () { var s = g.result || { v: 1, ids: [], status: {}, attempts: {}, win: { start: 0, n: 0 } }; var d = new Date(Date.now()); s.day = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); s.dayCount = 249; t.objectStore('meta').put(s, 'state'); }; t.oncomplete = function () { db.close(); res(); }; };
  }); });
  await load();
  await page.click('#btnStart');
  var s14 = await waitFor(function (s) { return s.state === 'stopped'; }, 10000, 'daily cap');
    ok(s14.state === 'stopped' && /Daily limit/.test(s14.message) && s14.reqToday === 250, 'daily cap: stops at 250 requests/day with a clear message', s14.reqToday + ' / ' + s14.message);


  // ════════════════════════════════════════════════════════════════════════
  // review fixes (1-6): hang, empty list, two windows, clock, export
  // ════════════════════════════════════════════════════════════════════════
  say('--- review fixes ---');
  async function tune(cfg) { await page.evaluate(function (c) { for (var k in c) StravaDeep.CFG[k] = c[k]; }, cfg); }
  async function listCalls() { return (await jget(SV + '/mock/stats'))['GET /api/v3/athlete/activities'] || 0; }

  // 1a. a stream request that NEVER answers: timeout -> retry cap -> skipped 'timeout', the rest carries on, nothing wedged
  await fresh(20, { hang: [3] });
  await tune({ reqTimeoutMs: 1200, offlineWaitMs: 400, busyExtraMs: 500, busyGraceMs: 500, hungStop: 99 });
  await page.click('#btnStart');
  var h1 = await waitFor(function (s) { return s.state === 'done' || s.state === 'stopped'; }, 25000, 'hung request recovery');
  var hh = await jget(SV + '/mock/deephits');
  ok(h1.state === 'done' && h1.loaded === 19 && h1.skipped === 1 && h1.skippedBy.timeout === 1, 'hang: a never-answered request times out, is retried, then skipped; the other 19 runs load and the import finishes', JSON.stringify({ s: h1.state, l: h1.loaded, k: h1.skipped, by: h1.skippedBy }));
  ok(hh[8000000004] === 3 && Object.keys(hh).filter(function (k) { return hh[k] !== 1 && +k !== 8000000004; }).length === 0, 'hang: the hung run was tried exactly 3 times (retry cap), every other run once', JSON.stringify(hh[8000000004]));

  // 1b. PAUSE then START always recovers even while the hung request is still open (timeout set very long on purpose)
  await fresh(10, { hang: [2] });
  await tune({ reqTimeoutMs: 600000, busyExtraMs: 600000, busyGraceMs: 700, offlineWaitMs: 400 });
  await page.click('#btnStart');
  var t0h = Date.now(), hh2 = {};
  while (Date.now() - t0h < 10000) { hh2 = await jget(SV + '/mock/deephits'); if (hh2[8000000003]) break; await sleep(100); }
  ok(hh2[8000000003] === 1 && (await st()).loaded === 2, 'wedge set-up: run 3 requested and never answered, runs 1-2 loaded', JSON.stringify(hh2[8000000003]));
  await sleep(500);
  await page.click('#btnPause');
  ok((await st()).state === 'paused', 'wedge: PAUSE works while a request is hanging');
  await jpost(SV + '/mock/deep', { count: 10 });            // the server is "fixed"; the old socket stays open for ever
  await sleep(900);
  await page.click('#btnStart');
  var h2 = await waitFor(function (s) { return s.state === 'done'; }, 15000, 'recover after PAUSE+START');
  if (h2.state !== 'done') say('   debug runtime: ' + JSON.stringify(await page.evaluate(function () { return StravaDeep._rt(); })) + ' hits ' + JSON.stringify(await jget(SV + '/mock/deephits')));
  ok(h2.state === 'done' && h2.loaded === 10, 'wedge: PAUSE then START recovers and loads all 10 runs (no waiting for the 10-minute timeout)', JSON.stringify({ s: h2.state, l: h2.loaded }));

  // 1c. a LATE answer after the timeout is ignored: no double store, counters unchanged
  await fresh(6, { hang: [1], hangMs: 3200 });
  await tune({ reqTimeoutMs: 1000, offlineWaitMs: 300 });
  await page.click('#btnStart');
  var h3 = await waitFor(function (s) { return s.state === 'done'; }, 15000, 'late-response scenario');
  var used3 = h3.windowUsed, today3 = h3.reqToday;
  await sleep(3600);
  var late = (await jget(SV + '/mock/deeplate')).late, h3b = await st(), recs3 = await storeRecs();
  ok(late === 1, 'late: the server really did send its answer after the timeout', late);
  ok(h3.loaded === 6 && h3b.loaded === 6 && h3b.windowUsed === used3 && h3b.reqToday === today3 && recs3.length === 6, 'late: late answer ignored - still 6 runs, 6 records, counters unchanged', JSON.stringify({ u: used3, u2: h3b.windowUsed, r: recs3.length }));
  ok(used3 === 8, 'late: 1 list + 6 runs + 1 retry = 8 counted requests', used3);

  // 2. empty list: exactly ONE list request, state done with a clear message, then silence
  var l0 = await listCalls();
  await fresh(0, {});
  await page.click('#btnStart');
  var e1 = await waitFor(function (s) { return s.state === 'done'; }, 8000, 'empty list done');
  await sleep(2500);
  var l1 = await listCalls(), e2 = await st();
  ok(e1.state === 'done' && /No runs found/.test(e1.message) && e1.total === 0, 'empty list: state done with "No runs found" message', e1.message);
  ok(l1 - l0 === 1 && e2.state === 'done', 'empty list: exactly ONE list request, none in the following 2.5 s', 'delta ' + (l1 - l0));
  ok(await page.evaluate(function () { return /No runs found/.test(document.getElementById('deepLine').textContent) && document.getElementById('btnStart').textContent === 'CHECK FOR NEW RUNS'; }), 'empty list: page shows the message and offers CHECK FOR NEW RUNS');
  await load();
  var e3 = await st(); await sleep(1500);
  ok(e3.state === 'done' && (await listCalls()) - l0 === 1, 'empty list: a reload does not list again either');
  // failed list: normal retry cap (offline -> stops after offlineStop), no storm
  await fresh(5, {});
  await tune({ offlineWaitMs: 150 });
  var listTries = 0;
  await page.route('**/athlete/activities*', function (route) { listTries++; route.abort(); });
  await page.click('#btnStart');
  var f1 = await waitFor(function (s) { return s.state === 'stopped'; }, 15000, 'failed list stops');
  await sleep(800);
  await page.unroute('**/athlete/activities*');
  ok(f1.state === 'stopped' && listTries === 6 && /No connection/.test(f1.message), 'failed list: retried with the normal offline cap (6 tries) and then stops with a message', listTries + ' tries / ' + f1.message);

  // 4. clock changes never reset the persisted budget
  var sk0 = skew;
  await fresh(12, {});
  sk0 = skew;
  await page.click('#btnStart');
  var c1 = await waitFor(function (s) { return s.state === 'done'; }, 15000, 'clock scenario import');
  ok(c1.windowUsed === 13 && c1.reqToday === 13, 'clock: 13 requests counted (1 list + 12 runs)', c1.windowUsed + '/' + c1.reqToday);
  await setSkew(sk0 - 1800000); await load();                     // clock 30 min EARLIER
  var c2 = await st();
  ok(c2.windowUsed === 13 && c2.reqToday === 13, 'clock: 30 min backwards + reload keeps window and day counts (13/13)', c2.windowUsed + '/' + c2.reqToday);
  await setSkew(sk0 - 2 * 86400000); await load();                // clock 2 days EARLIER
  var c3 = await st();
  ok(c3.reqToday === 13 && c3.windowUsed === 13, 'clock: 2 days backwards + reload keeps the day count (13)', c3.windowUsed + '/' + c3.reqToday);
  await setSkew(sk0 + 2 * 86400000); await load();               // 2 days LATER: strictly newer day -> reset
  var c4 = await st();
  ok(c4.reqToday === 0 && c4.windowUsed === 0, 'clock: 2 days forwards resets day and window counts (0/0)', c4.windowUsed + '/' + c4.reqToday);
  await setSkew(sk0); await load();

  // ════════════════════════════════════════════════════════════════════════
  // round-2 review fixes
  // ════════════════════════════════════════════════════════════════════════
  say('--- round-2 review fixes ---');
  function putState(over) {
    return page.evaluate(function (over) {
      return new Promise(function (res) {
        var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () {
          var db = r.result, t = db.transaction('meta', 'readwrite'), s = { v: 2, ids: [], status: {}, attempts: {}, listedAt: 0, listDone: false, listEmpty: false, listRev: 0, wantRun: false, day: '2000-01-01', dayCount: 0, win: { start: 0, n: 0 } };
          for (var k in over) s[k] = over[k];
          t.objectStore('meta').put(s, 'state'); t.oncomplete = function () { db.close(); res(); };
        };
      });
    }, over);
  }
  function dayStr(msAhead) { return page.evaluate(function (a) { var d = new Date(Date.now() + a); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }, msAhead); }

  // R2-1. clock forward (+2 days), budget used up, clock back, reload: waits at most one window, budget still respected
  await fresh(12, {});
  var fwdDay = await dayStr(2 * 86400000), fwdWs = await page.evaluate(function () { return Math.floor(Date.now() / 900000) * 900000 + 2 * 86400000; });
  await putState({ day: fwdDay, dayCount: 80, win: { start: fwdWs, n: 80 } });
  await load();
  var cb0 = apiCalls(await jget(SV + '/mock/stats'));
  await page.click('#btnStart');
  var k1 = await waitFor(function (s) { return s.state === 'waiting'; }, 8000, 'skew wait');
  ok(k1.state === 'waiting' && k1.nextInS > 0 && k1.nextInS <= 901, 'R2-1 clock forward then back: the wait is at most one window (' + k1.nextInS + ' s), not 2 days', k1.nextInS + ' s: ' + k1.message);
  ok(k1.windowUsed === 80 && k1.reqToday >= 80, 'R2-1 the used-up budget is kept (80 in this window, >= 80 today)', k1.windowUsed + '/' + k1.reqToday);
  await sleep(1500);
  ok(apiCalls(await jget(SV + '/mock/stats')) === cb0, 'R2-1 no request goes out while the (re-keyed) window is used up');
  await setSkew(skew + 900000);
  var k2 = await waitFor(function (s) { return s.state === 'done'; }, 20000, 'carry on after one window');
  ok(k2.state === 'done' && k2.loaded === 12 && apiCalls(await jget(SV + '/mock/stats')) - cb0 === 13, 'R2-1 after one window it carries on by itself and loads all 12 (13 requests)', k2.loaded + ' loaded');
  ok(k2.reqToday >= 93, 'R2-1 the daily count kept the larger value (80 + 13)', k2.reqToday);

  // R2-5. status() is pure: a clock step between two calls does not change the stored day
  await fresh(3, {});
  await page.click('#btnStart'); await waitFor(function (s) { return s.state === 'done'; }, 10000, 'r2-5 import');
  var d0 = await page.evaluate(function () { return StravaDeep._debugState().day; });
  await setSkew(skew + 3 * 86400000);
  var sp = await st();
  var d1 = await page.evaluate(function () { return StravaDeep._debugState().day; });
  ok(d1 === d0 && sp.reqToday === 0, 'R2-5 status() has no side effect: stored day unchanged after a clock step, shown count 0 for a new day', d0 + ' -> ' + d1 + ' / ' + sp.reqToday);
  await setSkew(skew - 3 * 86400000);

  // R2-2. two pages with the SAME sessionStorage owner id (duplicated tab): still exactly one importer
  await fresh(120, {});
  var tabId = await page.evaluate(function () { return sessionStorage.getItem('tr_deep_owner'); });
  var p3 = await ctx.newPage();
  p3.on('pageerror', function (e) { errors.push('p3 pageerror: ' + e.message); });
  await p3.goto(ORIGIN + '/manifest.json', { waitUntil: 'load' });
  await p3.evaluate(function (id) { sessionStorage.setItem('tr_deep_owner', id); window.__setSkew && 0; }, tabId);
  await p3.evaluate(function (v) { window.__setSkew && window.__setSkew(v); }, skew);
  await p3.goto(APP, { waitUntil: 'load' }); await sleep(500);
  ok(await p3.evaluate(function () { return sessionStorage.getItem('tr_deep_owner'); }) === tabId, 'R2-2 set-up: both pages carry the same sessionStorage tab id');
  var owners = await Promise.all([page.evaluate(function () { return StravaDeep.OWNER; }), p3.evaluate(function () { return StravaDeep.OWNER; })]);
  ok(owners[0] !== owners[1], 'R2-2 lease owners differ although the tab id is the same', owners.join(' / '));
  var dupBase = apiCalls(await jget(SV + '/mock/stats'));
  await Promise.all([page.click('#btnStart'), p3.click('#btnStart')]);
  await sleep(1000);
  var dw = await (async function () { var t = Date.now(), a, b; while (Date.now() - t < 40000) { a = await st(); b = await p3.evaluate(function () { return StravaDeep.status(); }); if ((a.state === 'waiting' && b.state === 'other') || (b.state === 'waiting' && a.state === 'other')) return [a, b]; await sleep(250); } return [a, b]; })();
  await sleep(1500);
  var dstats = await jget(SV + '/mock/stats'), dh = await jget(SV + '/mock/deephits'), dk = Object.keys(dh);
  ok(apiCalls(dstats) - dupBase === 80, 'R2-2 same tab id on two pages: 80 requests in the window in total (not 91)', String(apiCalls(dstats) - dupBase));
  ok(dk.length === 79 && dk.every(function (k) { return dh[k] === 1; }), 'R2-2 zero duplicate fetches (79 runs, each once)', dk.length + ' ids');
  ok(((dw[0].state === 'waiting') !== (dw[1].state === 'waiting')), 'R2-2 exactly one page is the importer, the other says another window', dw[0].state + ' / ' + dw[1].state);
  var ownerPg = dw[0].state === 'waiting' ? page : p3;
  await ownerPg.evaluate(function () { return StravaDeep.pause(); });       // releases the lease
  await p3.close();
  await load();

  // R2-3. a slow old owner whose lease was taken over stops BEFORE its next counted request (heartbeat made very slow on purpose)
  await fresh(60, {});
  await tune({ leaseBeatMs: 600000 });
  await page.click('#btnStart');
  await waitFor(function (s) { return s.loaded >= 3; }, 15000, 'r3 a few loaded');
  var cLease0 = apiCalls(await jget(SV + '/mock/stats'));
  await page.evaluate(function () {
    return new Promise(function (res) {
      var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () { var db = r.result, t = db.transaction('meta', 'readwrite'); t.objectStore('meta').put({ owner: 'intruder-xyz', beat: Date.now(), since: Date.now() }, 'lease'); t.oncomplete = function () { db.close(); res(); }; };
    });
  });
  await sleep(2500);
  var r3 = await st(), cLease1 = apiCalls(await jget(SV + '/mock/stats'));
  var leaseNow = await page.evaluate(function () { return new Promise(function (res) { var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () { var q = r.result.transaction('meta').objectStore('meta').get('lease'); q.onsuccess = function () { res(q.result); r.result.close(); }; }; }); });
  ok(cLease1 - cLease0 <= 1 && r3.state === 'other', 'R2-3 lease taken over: at most the in-flight request completes, then the old owner stops (state other)', 'calls +' + (cLease1 - cLease0) + ' state ' + r3.state);
  ok(leaseNow && leaseNow.owner === 'intruder-xyz', 'R2-3 the old owner did not take the lease back', leaseNow && leaseNow.owner);
  await page.evaluate(function () { return new Promise(function (res) { var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () { var t = r.result.transaction('meta', 'readwrite'); t.objectStore('meta')['delete']('lease'); t.oncomplete = function () { r.result.close(); res(); }; }; }); });
  await load();

  // R2-4a. three abandoned (never answered) sockets stop the import with a clear message
  await fresh(20, { hang: [3] });
  await tune({ reqTimeoutMs: 1200, offlineWaitMs: 400, busyExtraMs: 500, busyGraceMs: 500 });
  await page.click('#btnStart');
  var hg = await waitFor(function (s) { return s.state === 'stopped' || s.state === 'done'; }, 25000, 'hung sockets stop');
  var hgh = await jget(SV + '/mock/deephits');
  ok(hg.state === 'stopped' && /Connection problem.*close this page and open it again/i.test(hg.message), 'R2-4 after 3 abandoned requests the import stops: "connection problem, close and reopen"', hg.state + ': ' + hg.message);
  ok(hgh[8000000004] === 3 && !hg.skippedBy.timeout && hg.skipped === 0 && hg.pending >= 1, 'R3-2 the hung run was tried 3 times, is still PENDING (not skipped), and no further request was made', JSON.stringify({ h: hgh[8000000004], by: hg.skippedBy, pend: hg.pending }));
  // the network recovers (mock no longer hangs), the page is reopened: the run is retried and loaded
  await jpost(SV + '/mock/deep', { count: 20 });
  await load();
  var hr2 = await waitFor(function (s) { return s.state === 'done'; }, 40000, 'recovery after hung stop');
  var hrh = await jget(SV + '/mock/deephits');
  ok(hr2.state === 'done' && hr2.loaded === 20 && hr2.skipped === 0 && hrh[8000000004] === 1, 'R3-2 after the stall the run is loaded on the next start (20 of 20, 0 skipped)', JSON.stringify({ l: hr2.loaded, k: hr2.skipped, hits: hrh[8000000004] }));
  // R2-4b. the offline counter respects offlineStop on the timeout-skip path (no request one run late)
  await fresh(8, { hang: [0, 1, 2, 3, 4, 5, 6, 7] });
  await tune({ reqTimeoutMs: 700, offlineWaitMs: 150, offlineStop: 3, hungStop: 99, busyExtraMs: 500, busyGraceMs: 500 });
  await page.click('#btnStart');
  var osr = await waitFor(function (s) { return s.state === 'stopped' || s.state === 'done'; }, 25000, 'offlineStop on skip path');
  await sleep(1200);
  var osh = await jget(SV + '/mock/deephits'), osum = 0; Object.keys(osh).forEach(function (k) { osum += osh[k]; });
  ok(osr.state === 'stopped' && /No connection/.test(osr.message) && osr.skipped === 1 && osum === 3, 'R2-4 offlineStop=3 is respected on the timeout-skip path: stops after the 3rd timeout (3 stream requests, not 4)', JSON.stringify({ st: osr.state, sk: osr.skipped, requests: osum }));

  // R2-6. a 200 with a non-array list body is a transient list error, never "No runs found"; stored status survives
  await fresh(5, {});
  await page.click('#btnStart');
  var n1 = await waitFor(function (s) { return s.state === 'done'; }, 15000, 'r6 first import');
  await tune({ retryBaseMs: 100 });
  await page.route('**/athlete/activities*', function (route) { route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"Bad gateway page"}' }); });
  await page.click('#btnStart');
  var n2 = await waitFor(function (s) { return s.state === 'stopped'; }, 15000, 'r6 list error stops');
  await page.unroute('**/athlete/activities*');
  ok(n1.loaded === 5 && n2.state === 'stopped' && /Could not read your run list/.test(n2.message) && n2.total === 5 && n2.loaded === 5, 'R2-6 non-array list body: retried, then stops with a list error; the 5 stored runs keep their status (not wiped, not "No runs found")', JSON.stringify({ st: n2.state, t: n2.total, l: n2.loaded, m: n2.message.slice(0, 60) }));

  // R2-7. copy / layout
  await fresh(5, {});
  await page.route('**/athlete/activities*', function () { /* never answered */ });
  await page.click('#btnStart');
  var cp1 = await waitFor(function (s) { return s.state === 'running'; }, 8000, 'r7 running');
  await sleep(600);
  var cpi = await page.evaluate(function () { return { btn: document.getElementById('btnStart').textContent, dis: document.getElementById('btnStart').disabled, find: document.getElementById('findList').textContent, th: parseFloat(getComputedStyle(document.querySelector('table.t th') || document.getElementById('btnStart')).fontSize) }; });
  ok(cpi.dis && !/RESUME/.test(cpi.btn), 'R2-7 disabled START button does not read RESUME while the first import is running', cpi.btn);
  ok(!/Press START/.test(cpi.find) && /Loading your runs/.test(cpi.find), '"What the numbers say" shows a loading line (no "Press START") during an import', cpi.find);
  await page.screenshot({ path: path.join(UI, 'docs/insights-7-mid-import-empty.png') });
  await page.unroute('**/athlete/activities*');
  await page.evaluate(function () { return StravaDeep.pause(); });
  await fresh(0, {});
  await page.click('#btnStart');
  var cp2 = await waitFor(function (s) { return s.state === 'done'; }, 8000, 'r7 empty done');
  await sleep(800);
  var cpe = await page.evaluate(function () { return { find: document.getElementById('findList').textContent, line: document.getElementById('deepLine').textContent }; });
  ok(/No runs found/.test(cpe.line) && !/Press START|No runs loaded yet/.test(cpe.find), 'R2-7 "No runs found" screen: "What the numbers say" does not tell her to press START', cpe.find);
  await page.screenshot({ path: path.join(UI, 'docs/insights-8-empty.png') });
  // 401 text never points at an 'orange button'
  await fresh(10, {});
  await jpost(SV + '/mock/fault', { kind: '401', count: 2 });
  await page.click('#btnStart');
  var cp3 = await waitFor(function (s) { return s.state === 'stopped'; }, 15000, 'r7 401');
  ok(!/orange/i.test(cp3.message) && /login expired/i.test(cp3.message), 'R2-7 401 text does not mention the orange button', cp3.message);
  await fresh(4, {});
  await page.click('#btnStart'); await waitFor(function (s) { return s.state === 'done'; }, 10000, 'r7 done');
  await sleep(500);
  var thpx = await page.evaluate(function () { var t = document.querySelectorAll('table.t th'), m = 99; for (var i = 0; i < t.length; i++) m = Math.min(m, parseFloat(getComputedStyle(t[i]).fontSize)); return { m: m, n: t.length }; });
  ok(thpx.n > 0 && thpx.m >= 16, 'R2-7 table header text is >= 16 px', thpx.m + ' px in ' + thpx.n + ' headers');
  // pagehide releases the lease, pageshow (persisted) takes it again when an import was wanted
  await fresh(60, {});
  await page.click('#btnStart');
  await waitFor(function (s) { return s.loaded >= 2; }, 10000, 'r7 some loaded');
  var leaseHeld = function () { return page.evaluate(function () { return StravaDeep._rt().lease; }); };
  ok(await leaseHeld(), 'R2-7 set-up: lease held while importing');
  await page.evaluate(function () { window.dispatchEvent(new Event('pagehide')); });
  await sleep(300);
  var rt1 = await page.evaluate(function () { return StravaDeep._rt(); });
  ok(!rt1.lease && !rt1.running, 'R2-7 pagehide releases the lease and stops', JSON.stringify({ l: rt1.lease, r: rt1.running }));
  var lc0 = (await st()).loaded;
  await page.evaluate(function () { var e = new Event('pageshow'); e.persisted = true; window.dispatchEvent(e); });
  var rt2 = await waitFor(function (s) { return s.loaded >= lc0 + 3; }, 10000, 'r7 resumed after pageshow');
  ok(rt2.loaded >= lc0 + 3 && (await leaseHeld()), 'R2-7 pageshow (bfcache restore) re-acquires the lease and carries on while wantRun is set', lc0 + ' -> ' + rt2.loaded);
  await page.evaluate(function () { return StravaDeep.pause(); });
  await load();

  // ── round-3 ──
  say('--- round-3 review fixes ---');
  // R3-3: in-page confirm dialog; native confirm / alert / prompt are dead on the console WebView
  await fresh(40, {});
  await page.evaluate(function () { window.__native = 0; window.confirm = function () { window.__native++; return undefined; }; window.alert = function () { window.__native++; }; window.prompt = function () { window.__native++; return null; }; });
  await page.click('#btnStart');
  await waitFor(function (s) { return s.loaded >= 3; }, 15000, 'r3 some loaded');
  await page.click('#btnCancel'); await sleep(200);
  var dg = await page.evaluate(function () {
    var y = document.getElementById('dlgYes'), n = document.getElementById('dlgNo'); if (!y) return null;
    var ry = y.getBoundingClientRect(), rn = n.getBoundingClientRect(), tx = document.getElementById('dlgText');
    return { h: Math.min(ry.height, rn.height), w: Math.min(ry.width, rn.width), tl: [ry, rn].some(function (r) { return r.left < 110 && r.top < 110; }), bot: Math.max(ry.bottom, rn.bottom) <= innerHeight - 80, focus: document.activeElement && document.activeElement.id, text: tx.textContent, kids: tx.children.length, native: window.__native };
  });
  ok(dg && dg.h >= 64 && dg.w >= 64 && !dg.tl && dg.bot, 'R3-3 CANCEL opens an in-page dialog: buttons >= 64 px, outside the top-left 110x110 and the bottom 80 px strip', JSON.stringify(dg));
  ok(dg && dg.focus === 'dlgNo' && /Stop and forget/.test(dg.text) && dg.kids === 0 && dg.native === 0, 'R3-3 focus starts on the safe NO button, text set via textContent, no native confirm/alert/prompt called', JSON.stringify(dg));
  await page.screenshot({ path: path.join(UI, 'docs/insights-9-confirm-dialog.png') });
  await page.keyboard.press('Escape'); await sleep(200);
  ok(!(await page.$('#dlgYes')) && (await st()).state !== 'paused' && (await st()).pending > 0, 'R3-3 Escape closes the dialog and changes nothing (import keeps running)');
  await page.click('#btnCancel'); await page.click('#dlgNo'); await sleep(200);
  ok(!(await page.$('#dlgYes')) && (await st()).pending > 0, 'R3-3 NO closes the dialog and changes nothing');
  await page.click('#btnCancel'); await page.click('#dlgYes');
  var cx = await waitFor(function (s) { return s.state === 'paused' && s.pending === 0; }, 8000, 'cancel via dialog');
  ok(cx.state === 'paused' && cx.pending === 0 && cx.loaded >= 3, 'R3-3 YES in the dialog cancels the queue and keeps the loaded runs', JSON.stringify({ s: cx.state, p: cx.pending, l: cx.loaded }));
  var nrec = (await storeRecs()).length;
  await sleep(300);
  await page.click('#btnWipe'); await sleep(150);
  ok(!!(await page.$('#dlgYes')) && /Delete ALL stored/.test(await page.evaluate(function () { return document.getElementById('dlgText').textContent; })), 'R3-3 CLEAR STORED DATA opens the in-page dialog too');
  await page.click('#dlgYes'); await sleep(600);
  ok(nrec > 0 && (await storeRecs()).length === 0 && await page.evaluate(function () { return window.__native; }) === 0, 'R3-3 YES wipes the stored runs; the stubbed native confirm/alert/prompt were never called', nrec + ' -> ' + (await storeRecs()).length);
  var srcScan = ['insights.html', 'js/strava-deep.js', 'js/compare-runs.js', 'js/hrtrain-read.js', 'js/hr-analysis.js'].filter(function (f) { return /\b(window\.)?(confirm|alert|prompt)\s*\(/.test(fs.readFileSync(path.join(UI, f), 'utf8')); });
  ok(srcScan.length === 0, 'R3-3 no confirm()/alert()/prompt() anywhere in the page and its scripts', srcScan.join());

  // R3-4: the findings block follows the stored count during an import (throttle, not a debounce that never fires)
  await fresh(60, {});
  await page.click('#btnStart');
  await waitFor(function (s) { return s.loaded >= 20; }, 30000, 'r3 20 loaded');
  await sleep(2600);
  var fl = await page.evaluate(function () { var li = document.querySelector('#findList li'); return li ? li.textContent : ''; });
  var nl = await st(), mm = /(\d+) have second-by-second/.exec(fl);
  ok(mm && +mm[1] >= 15 && +mm[1] <= nl.loaded, 'R3-4 mid-import findings show the stored count (' + (mm ? mm[1] : '?') + ' with streams, ' + nl.loaded + ' loaded), not 0', fl);
  await page.evaluate(function () { return StravaDeep.pause(); });

  // 3. two windows on the same origin and the same mock
  await fresh(120, {});
  await st();
  var page2 = await ctx.newPage();
  page2.on('pageerror', function (e) { errors.push('page2 pageerror: ' + e.message); });
  page2.on('console', function (m) { if (m.type() === 'error' && !/Failed to load resource|net::/.test(m.text())) errors.push('page2 console: ' + m.text()); });
  async function st2() { return page2.evaluate(function () { return StravaDeep.status(); }); }
  async function setSkewOn(pg, v) { await pg.evaluate(function (v) { window.__setSkew(v); }, v); }
  async function setSkew2(v) { await setSkewOn(page2, v); }
  await page2.goto(ORIGIN + '/manifest.json', { waitUntil: 'load' });
  await setSkew2(skew);
  await page2.goto(APP, { waitUntil: 'load' }); await sleep(500);
  var base2 = apiCalls(await jget(SV + '/mock/stats')), lbase = await listCalls();
  await Promise.all([page.click('#btnStart'), page2.click('#btnStart')]);          // both press START at the same moment
  var w1 = await waitFor(function (s) { return s.state === 'waiting' || s.state === 'other'; }, 30000, 'window 1 (page 1)');
  var w2 = await (async function () { var t = Date.now(), s; while (Date.now() - t < 30000) { s = await st2(); if (s.state === 'waiting' || s.state === 'other') return s; await sleep(150); } return s; })();
  var owner = w1.state === 'waiting' ? page : page2, other = owner === page ? page2 : page, ownerSt = owner === page ? w1 : w2, otherSt = owner === page ? w2 : w1;
  async function stOf(pg) { return pg.evaluate(function () { return StravaDeep.status(); }); }
  var wf = await (async function () { var t = Date.now(), s; while (Date.now() - t < 40000) { s = await stOf(owner); if (s.state === 'waiting') return s; await sleep(200); } return s; })();
  await sleep(1500);
  ownerSt = await stOf(owner); otherSt = await stOf(other);
  var stats6 = await jget(SV + '/mock/stats'), hits6 = await jget(SV + '/mock/deephits'), nHit = Object.keys(hits6);
  ok(ownerSt.state === 'waiting' && otherSt.state === 'other', 'two windows: exactly one runs (waiting for the next batch), the other says it is in another window', ownerSt.state + ' / ' + otherSt.state);
  ok(/another window/.test(otherSt.message) && /another window/.test(await other.evaluate(function () { return document.getElementById('deepLine').textContent; })), 'two windows: the second page says "Import is running in another window"', otherSt.message);
  ok(apiCalls(stats6) - base2 === 80 && (stats6['GET /api/v3/athlete/activities'] || 0) - lbase === 1, 'two windows: 80 requests in the 15-minute window in total (1 list + 79 runs) - not 2 x 80', (apiCalls(stats6) - base2) + ', lists ' + ((stats6['GET /api/v3/athlete/activities'] || 0) - lbase));
  ok(nHit.length === 79 && nHit.every(function (k) { return hits6[k] === 1; }), 'two windows: zero duplicate run fetches (79 runs, each once)', nHit.length + ' ids');
  ok(await other.evaluate(function () { var b = document.getElementById('btnStart'); return b.disabled; }), 'two windows: START is disabled in the second window while the lease is alive');
  ok(!/RESUME/.test(await other.evaluate(function () { return document.getElementById('btnStart').textContent; })), 'two windows: the disabled button in the other window does not read RESUME', await other.evaluate(function () { return document.getElementById('btnStart').textContent; }));
  await sleep(5500);                                                             // the second page polls the shared state every 5 s
  otherSt = await stOf(other); ownerSt = await stOf(owner);
  ok(otherSt.reqToday === ownerSt.reqToday && otherSt.reqToday === 80 && otherSt.loaded + otherSt.skipped === ownerSt.loaded + ownerSt.skipped, 'two windows: daily count and progress are shared (both show 80 today)', otherSt.reqToday + ' vs ' + ownerSt.reqToday);
  await other.screenshot({ path: path.join(UI, 'docs/insights-6-other-window.png') });
  // owner window closes: after the lease expires (20 s) the other window may TAKE OVER, without refetching anything
  await owner.close();
  await setSkewOn(other, skew + 25000);
  var to = await (async function () { var t = Date.now(), s; while (Date.now() - t < 20000) { s = await stOf(other); if (s.takeOver) return s; await sleep(300); } return s; })();
  ok(to.takeOver === true && to.state !== 'other' && /TAKE OVER/.test(await other.evaluate(function () { return document.getElementById('btnStart').textContent; })) && await other.evaluate(function () { return !document.getElementById('btnStart').disabled; }), 'two windows: after the lease expires the other window offers TAKE OVER', JSON.stringify({ t: to.takeOver, s: to.state }));
  await other.click('#btnStart');
  var cb = apiCalls(await jget(SV + '/mock/stats'));
  await sleep(2000);
  ok(apiCalls(await jget(SV + '/mock/stats')) === cb, 'take over: the 80-per-window budget carried over - no request while the window is used up', 'calls ' + cb);
  await jpost(SV + '/mock/config', { skewMs: skew + 925000 }); await setSkewOn(other, skew + 925000);
  var td = await (async function () { var t = Date.now(), s; while (Date.now() - t < 40000) { s = await stOf(other); if (s.state === 'done') return s; await sleep(300); } return s; })();
  var statsE = await jget(SV + '/mock/stats'), hitsE = await jget(SV + '/mock/deephits'), nE = Object.keys(hitsE);
  ok(td.state === 'done' && td.loaded === 120, 'take over: the second window finishes all 120 runs', JSON.stringify({ s: td.state, l: td.loaded, k: td.skipped }));
  ok(nE.length === 120 && nE.every(function (k) { return hitsE[k] === 1; }) && (statsE['GET /api/v3/athlete/activities'] || 0) - lbase === 1, 'two windows overall: 120 runs each fetched exactly once, one list request', nE.length + ' ids');
  ok(td.reqToday === 121, 'two windows overall: shared daily count = 1 list + 120 runs = 121', td.reqToday);
  var recsE = await other.evaluate(function () { return new Promise(function (resolve) { var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () { var q = r.result.transaction('runs').objectStore('runs').getAll(); q.onsuccess = function () { resolve(q.result.length); r.result.close(); }; }; }); });
  ok(recsE === 120, 'two windows overall: 120 stored records, no duplicates', recsE);

  // 6. export honesty (page 2 has the data)
  async function exportToast(bridge) {
    await other.evaluate(function (b) { window.AndroidBridge = b === 'err' ? { saveFile: function () { return 'ERROR: disk full'; } } : b === 'throw' ? { saveFile: function () { throw new Error('bridge crashed'); } } : { saveFile: function () { return '/sdcard/Download/trailrunner-hr-deep.json'; } }; document.getElementById('toast').textContent = ''; }, bridge);
    var dlp = bridge === 'ok' ? null : other.waitForEvent('download', { timeout: 5000 }).catch(function () { return null; });
    await other.click('#btnExport');
    var dlv = dlp ? await dlp : null;
    await sleep(600);
    return { text: await other.evaluate(function () { return document.getElementById('toast').textContent; }), cls: await other.evaluate(function () { return document.getElementById('toast').className; }), dl: !!dlv };
  }
  var x1 = await exportToast('err');
  ok(/disk full/.test(x1.text) && /Download requested - check the Downloads folder/.test(x1.text) && /size \d+ KB/.test(x1.text) && !/Export started|Saved to/.test(x1.text) && /err/.test(x1.cls) && x1.dl, 'export: bridge ERROR -> exact error shown, fallback says "Download requested - check the Downloads folder" with the file size, never "Export started"', x1.text.slice(0, 160));
  var x2 = await exportToast('throw');
  ok(/bridge crashed/.test(x2.text) && !/Export started/.test(x2.text) && /Download requested/.test(x2.text), 'export: bridge exception -> its message is shown', x2.text.slice(0, 120));
  var x3 = await exportToast('ok');
  ok(/^Saved to \/sdcard\/Download\/trailrunner-hr-deep\.json/.test(x3.text) && !/err/.test(x3.cls), 'export: bridge success -> "Saved to <path>"', x3.text);
  await other.close();
  page = await ctx.newPage();                                                   // the first page was closed above
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  await page.goto(ORIGIN + '/manifest.json', { waitUntil: 'load' });

  // storage still intact afterwards and console clean
  ok(errors.length === 0, 'no console / page errors', errors.slice(0, 3).join(' | '));
  var dbs2 = await dbInfo();
  ok(dbs2.indexOf('trailrunner@7') >= 0, "'trailrunner' DB still version 7 at the end", dbs2.join(' '));

  await browser.close();
  if (srv) srv.close();
  children.forEach(function (c) { try { c.kill(); } catch (e) {} });
  say('');
  say('TOTAL ' + total + ' checks, ' + fails + ' failed');
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error('TEST CRASH', e); process.exit(2); });
