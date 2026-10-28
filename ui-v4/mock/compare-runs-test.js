#!/usr/bin/env node
// COMPARE RUNS panel on stats.html - Playwright against the static server (:8099). Read-only feature: no treadmill, no Strava, no adb.
//   node mock/compare-runs-test.js [shotDir]      -> writes docs/compare-runs-output.txt
'use strict';
var path = require('path'), fs = require('fs'), cp = require('child_process');
var UI = path.resolve(__dirname, '..');
var pw = require(path.resolve(UI, '../node_modules/playwright'));
var APP = 'http://localhost:8099/stats.html';
var LOG = path.join(UI, 'docs/compare-runs-output.txt');
var SHOTS = process.argv[2] || path.join(UI, 'docs');
var lines = [], fails = 0, total = 0, children = [];
function say(s) { console.log(s); lines.push(s); }
function ok(c, n, d) { total++; if (!c) fails++; say((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function up(u) { return fetch(u).then(function () { return true; }, function () { return false; }); }
var M = '−';

var NOW = Date.now(), DAY = 86400000;
// Alpha: 5 km / 30:00, HR ramps 100 + t/60 (drift exactly +1.00 bpm/min), incline 1% then 2%.
function alpha() {
  var tp = [], t;
  for (t = 0; t <= 1800; t += 5) tp.push({ time: new Date(NOW - 5 * DAY + t * 1000).toISOString(), elapsed: t, dist: t * 5000 / 1800, speed: 10, hr: 100 + t / 60, incline: t < 900 ? 1 : 2 });
  var sp = []; for (var k = 1; k <= 5; k++) sp.push({ km: k, timeSec: 360, avgHR: 100 + k * 5, elapsed: k * 360 });
  return { id: 'run_alpha', routeName: 'Alpha loop', startedAt: new Date(NOW - 5 * DAY).toISOString(), savedAt: new Date(NOW - 5 * DAY + 1800000).toISOString(),
    elapsed: 1800, distanceKm: 5, distanceM: 5000, avgSpeed: 10, maxSpeed: 12, avgHR: 140, maxHR: 160, calories: 300, elevGained: 20, splits: sp, trackPoints: tp };
}
// Bravo: 7.1 km / 40:00, flat HR 150 (drift 0), incline 0.5%.
function bravo() {
  var tp = [], t;
  for (t = 0; t <= 2400; t += 5) tp.push({ time: new Date(NOW - 1 * DAY + t * 1000).toISOString(), elapsed: t, dist: t * 7100 / 2400, speed: 10.65, hr: 150, incline: 0.5 });
  var sp = []; for (var k = 1; k <= 7; k++) sp.push({ km: k, timeSec: 340, avgHR: 150, elapsed: k * 340 });
  return { id: 'run_bravo', routeName: 'Bravo hills', startedAt: new Date(NOW - 1 * DAY).toISOString(), savedAt: new Date(NOW - 1 * DAY + 2400000).toISOString(),
    elapsed: 2400, distanceKm: 7.1, distanceM: 7100, avgSpeed: 10.65, maxSpeed: 13, avgHR: 150, maxHR: 170, calories: 450, elevGained: 50, splits: sp, trackPoints: tp };
}
function carol() {   // older filler
  return { id: 'run_carol', routeName: 'Carol', startedAt: new Date(NOW - 20 * DAY).toISOString(), savedAt: new Date(NOW - 20 * DAY + 900000).toISOString(), elapsed: 900, distanceKm: 2, avgSpeed: 8, avgHR: 130, calories: 100 };
}
function strava(id, daysAgo, name, km, el) {
  return { id: 'sv_' + id, stravaId: String(id), source: 'strava', imported: true, routeName: name, startedAt: new Date(NOW - daysAgo * DAY).toISOString(), savedAt: new Date(NOW - daysAgo * DAY + el * 1000).toISOString(),
    elapsed: el, distanceKm: km, distanceM: km * 1000, avgSpeed: km / (el / 3600), avgHR: 155, maxHR: 175, calories: 380, elevGained: 30 };
}

(async function () {
  if (!(await up('http://localhost:8099/'))) { children.push(cp.spawn('node', [path.join(__dirname, 'static.js')], { stdio: 'ignore' })); await sleep(800); }
  say('Compare runs test ' + new Date().toISOString() + ' (static UI only)');
  var browser = await pw.chromium.launch();
  var ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  var page = await ctx.newPage();
  var errors = [], reqs = [];
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' ')); });
  page.on('console', function (m) { if (m.type() === 'error' && !/tile|ERR_|Failed to load resource|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('request', function (r) { reqs.push(r.url()); });
  await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });

  async function seed(runs, settings) {
    await page.goto(APP, { waitUntil: 'load' });
    await page.evaluate(function (a) { localStorage.clear(); localStorage.setItem('tr_runs', JSON.stringify(a.runs)); if (a.s) localStorage.setItem('tr_settings', JSON.stringify(a.s)); }, { runs: runs, s: settings || null });
    await page.goto(APP, { waitUntil: 'load' }); await sleep(400);
  }
  async function openPanel() { await page.click('#crOpenBtn'); await sleep(250); }
  function row(label) {
    return page.evaluate(function (l) {
      var tr = document.querySelector('#crSummary tr[data-row="' + l + '"]'); if (!tr) return null;
      return { a: tr.children[1].textContent, b: tr.children[2].textContent, d: tr.children[3].textContent };
    }, label);
  }
  function txt(sel) { return page.evaluate(function (s) { var e = document.querySelector(s); return e ? e.textContent : null; }, sel); }
  function selVal(id) { return page.evaluate(function (i) { var s = document.getElementById(i); return s ? s.options[s.selectedIndex].textContent : null; }, id); }

  // ── 1. defaults + summary numbers (imperial default) ─────────────────────
  await seed([carol(), bravo(), alpha()]);          // deliberately not in date order
  var entry = await page.evaluate(function () { var r = document.getElementById('crOpenBtn').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom }; });
  ok(entry.h >= 64 && entry.w >= 200, 'COMPARE RUNS entry button is large (>=64px tall)', Math.round(entry.h) + 'x' + Math.round(entry.w));
  ok(!(entry.x < 110 && entry.y < 110) && entry.b < 1000 - 80, 'entry button outside forbidden zones', Math.round(entry.x) + ',' + Math.round(entry.y) + ' b=' + Math.round(entry.b));
  await openPanel();
  ok(await page.isVisible('#crPanel'), 'panel opens');
  var sa = await selVal('crSelA'), sb = await selVal('crSelB');
  ok(/Alpha loop/.test(sa) && /Bravo hills/.test(sb), 'default = the two most recent runs (A older = Alpha, B newer = Bravo)', sa.slice(-24) + ' | ' + sb.slice(-24));
  ok(!/Carol/.test(sa + sb), 'older run not selected by default');
  var optCount = await page.evaluate(function () { return document.getElementById('crSelA').options.length; });
  ok(optCount === 3, 'dropdown lists all 3 saved runs', optCount);
  var r;
  r = await row('Duration'); ok(r && r.a === '30:00' && r.b === '40:00' && r.d === '+10:00', 'duration 30:00 / 40:00 / +10:00', JSON.stringify(r));
  r = await row('Distance (mi)'); ok(r && r.a === '3.11' && r.b === '4.41' && r.d === '+1.30', 'distance (mi) 3.11 / 4.41 / +1.30', JSON.stringify(r));
  r = await row('Avg pace (/mi)'); ok(r && r.a === '9:39' && r.b === '9:04' && r.d === M + '0:35', 'avg pace 9:39 / 9:04 / -0:35 per mi', JSON.stringify(r));
  r = await row('Avg speed (mph)'); ok(r && r.a === '6.2' && r.b === '6.6' && r.d === '+0.4', 'avg speed mph 6.2 / 6.6 / +0.4', JSON.stringify(r));
  r = await row('Avg HR (bpm)'); ok(r && r.a === '140' && r.b === '150' && r.d === '+10', 'avg HR 140 / 150 / +10', JSON.stringify(r));
  r = await row('Max HR (bpm)'); ok(r && r.a === '160' && r.b === '170' && r.d === '+10', 'max HR 160 / 170 / +10', JSON.stringify(r));
  r = await row('Calories (kcal)'); ok(r && r.a === '300' && r.b === '450' && r.d === '+150', 'calories 300 / 450 / +150', JSON.stringify(r));
  r = await row('Elevation gained (ft)'); ok(r && r.a === '66' && r.b === '164' && r.d === '+98', 'elevation ft 66 / 164 / +98', JSON.stringify(r));
  r = await row('Avg incline (%)'); ok(r && r.a === '1.5' && r.b === '0.5' && r.d === M + '1.0', 'avg incline 1.5 / 0.5 / -1.0', JSON.stringify(r));
  r = await row('HR drift (bpm/min)'); ok(r && r.a === '+1.00' && r.b === '0.00' && r.d === M + '1.00', 'HR drift +1.00 / 0.00 / -1.00 bpm/min', JSON.stringify(r));
  r = await row('Date'); ok(r && /\d{4}/.test(r.a) && r.d === '+4 d', 'date row + 4 days apart', JSON.stringify(r));
  var what = await txt('#crWhatText');
  ok(/^B was 1\.3 mi longer/.test(what) && /avg HR 10 bpm higher/.test(what) && /heart-rate drift 1\.0 bpm\/min flatter \(A .?1\.0, B .?0\.0\)/.test(what) && !/NaN|undefined/.test(what), 'what-changed line built from numbers', what);
  var bad = await page.evaluate(function () { return /NaN|undefined|Infinity/.test(document.getElementById('crPanel').textContent); });
  ok(!bad, 'no NaN/undefined/Infinity anywhere in the panel');

  // ── 2. zones sum to total, hand values ────────────────────────────────────
  // maxHR 185 (default): z bounds 92.5/111/129.5/148/166.5/185 ; hr = 100 + t/60 -> Z1 t<750? computed independently below
  var zs = await page.evaluate(function () {
    var run = JSON.parse(localStorage.getItem('tr_runs')).filter(function (x) { return x.id === 'run_alpha'; })[0];
    var T = CompareRuns._t, n = T.norm(run), z = T.zoneTimes(n.trace, 185);
    return { z: z, sum: z.below + z.z.reduce(function (s, v) { return s + v; }, 0), traceSec: n.trace.length * 5 };
  });
  ok(Math.abs(zs.sum - zs.z.total) < 1e-9 && zs.z.total === zs.traceSec, 'zone seconds sum to total traced time', zs.sum + ' = ' + zs.z.total);
  var exp = [0, 0, 0, 0, 0, 0]; for (var t = 0; t <= 1800; t += 5) { var hr = 100 + t / 60, p = hr / 185, zi = p < 0.5 ? 0 : p < 0.6 ? 1 : p < 0.7 ? 2 : p < 0.8 ? 3 : p < 0.9 ? 4 : 5; exp[zi] += 5; }
  ok(zs.z.below === exp[0] && zs.z.z.join() === exp.slice(1).join(), 'zone split matches independent hand loop', zs.z.z.join() + ' vs ' + exp.slice(1).join());
  var zrows = await page.evaluate(function () { return [].map.call(document.querySelectorAll('#crSummary tr[data-row^="Z"], #crSummary tr[data-row^="Below"]'), function (tr) { return tr.children[1].textContent; }); });
  ok(zrows.length === 6 && zrows.every(function (x) { return /^\d+:\d\d$/.test(x); }), '6 zone rows shown as m:ss', zrows.join(' '));
  var shownSec = zrows.reduce(function (s, x) { var m = x.split(':'); return s + (+m[0]) * 60 + (+m[1]); }, 0);
  ok(Math.abs(shownSec - 1805) <= 3, 'displayed zone times add up to the 1805 s trace (rounding only)', shownSec);

  // ── 3. drift on a synthetic ramp ──────────────────────────────────────────
  var dr = await page.evaluate(function () {
    var T = CompareRuns._t, mk = function (f, n, step) { var a = []; for (var i = 0; i < n; i++) a.push({ elapsed: i * step, hr: f(i * step) }); return T.norm({ trackPoints: a, elapsed: n * step, distanceKm: 5 }).trace; };
    return { ramp: T.hrDrift(mk(function (t) { return 120 + 0.5 * t / 60; }, 361, 5)), flat: T.hrDrift(mk(function () { return 150; }, 361, 5)),
      short: T.hrDrift(mk(function (t) { return 100 + t; }, 100, 5)), neg: T.hrDrift(mk(function (t) { return 170 - 2 * t / 60; }, 361, 5)),
      none: T.hrDrift([]), early: T.hrDrift(mk(function (t) { return t < 600 ? 100 + t : 150; }, 361, 5)) };
  });
  ok(Math.abs(dr.ramp - 0.5) < 1e-9, 'drift on +0.5 bpm/min ramp = 0.5', dr.ramp);
  ok(Math.abs(dr.flat) < 1e-9, 'drift on flat HR = 0', dr.flat);
  ok(Math.abs(dr.neg + 2) < 1e-9, 'drift on falling HR = -2', dr.neg);
  ok(dr.short === null && dr.none === null, 'drift null when run shorter than 10 min / no trace', dr.short + ',' + dr.none);
  ok(Math.abs(dr.early) < 1e-9, 'first 10 minutes excluded from drift (steep warm-up ignored)', dr.early);

  // ── 4. swap ───────────────────────────────────────────────────────────────
  await page.click('#crSwap'); await sleep(200);
  sa = await selVal('crSelA'); sb = await selVal('crSelB');
  ok(/Bravo hills/.test(sa) && /Alpha loop/.test(sb), 'swap exchanges A and B');
  r = await row('Duration'); ok(r.a === '40:00' && r.b === '30:00' && r.d === M + '10:00', 'after swap duration 40:00 / 30:00 / -10:00', JSON.stringify(r));
  what = await txt('#crWhatText'); ok(/^B was 1\.3 mi shorter/.test(what) && /avg HR 10 bpm lower/.test(what), 'what-changed flips after swap', what);
  await page.selectOption('#crSelA', '2'); await sleep(150);   // 3rd run (oldest = Carol, no trace)
  r = await row('Duration'); ok(r.a === '15:00', 'dropdown pick changes run A', JSON.stringify(r));
  r = await row('Avg incline (%)'); ok(r.a === '-' && r.d === '-', 'run without trace shows - for incline and delta', JSON.stringify(r));
  r = await row('HR drift (bpm/min)'); ok(r.a === '-' && r.d === '-', 'run without trace shows - for drift', JSON.stringify(r));
  r = await row('Elevation gained (ft)'); ok(r.a === '-', 'missing elevation shows -', JSON.stringify(r));

  // ── 5. charts (two real traces) + screenshot ──────────────────────────────
  await page.click('#crClose'); await seed([carol(), bravo(), alpha()]); await openPanel();
  var ch = await page.evaluate(function () {
    return { hr: document.querySelectorAll('.cr-line-a, .cr-line-b').length, svgs: document.querySelectorAll('#crPanel svg.cr-svg').length,
      bands: document.querySelectorAll('#crPanel .cr-band').length, legend: [].map.call(document.querySelectorAll('.cr-leg'), function (e) { return e.textContent; }),
      xl: [].map.call(document.querySelectorAll('#crPanel svg text.cr-axis'), function (e) { return e.textContent; }), note: !!document.getElementById('crNoTrace') };
  });
  ok(ch.svgs === 3 && ch.hr === 6, 'HR + speed + incline charts, 2 lines each', ch.svgs + ' svgs, ' + ch.hr + ' lines');
  ok(ch.bands === 4, 'zone bands shaded lightly (the 4 zones the data range reaches: Z1-Z4 for HR 100-150 at max 185)', ch.bands);
  ok(ch.legend.length === 2 && /^A/.test(ch.legend[0]) && /^B/.test(ch.legend[1]) && /Alpha|\d+ [A-Z][a-z]{2}/.test(ch.legend[0]), 'legend names both runs', ch.legend.join(' | '));
  ok(ch.xl.indexOf('Elapsed time (minutes)') >= 0 && ch.xl.indexOf('Heart rate (bpm)') >= 0, 'axis labels minutes + bpm', ch.xl.join(' | '));
  ok(!ch.note, 'no missing-trace note when both runs have traces');
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-1-two-traces.png') });
  await page.evaluate(function () { document.getElementById('crPanel').scrollTop = 700; }); await sleep(100);
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-1b-two-traces-scrolled.png') });
  await page.evaluate(function () { document.getElementById('crPanel').scrollTop = 0; });
  await page.click('[data-x="dist"]'); await sleep(200);
  var xl2 = await page.evaluate(function () { return [].map.call(document.querySelectorAll('#crPanel svg text.cr-axis'), function (e) { return e.textContent; }); });
  ok(xl2.indexOf('Distance (mi)') >= 0, 'toggle: plot against distance (mi)', xl2.join(' | '));
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-2-distance-axis.png') });
  await page.click('[data-x="time"]'); await sleep(150);

  // ── 6. splits (metric) ────────────────────────────────────────────────────
  await seed([carol(), bravo(), alpha()], { unitSystem: 'metric', maxHR: 185 }); await openPanel();
  var spl = await page.evaluate(function () { return [].map.call(document.querySelectorAll('#crSplitTable tbody tr'), function (tr) { return [].map.call(tr.children, function (c) { return c.textContent; }); }); });
  ok(spl.length === 7, 'metric split table has 7 rows (longest run)', spl.length);
  ok(spl[0].join('|') === '1|6:00|105|5:40|150|' + M + '0:20|+45', 'split 1 row: pace 6:00 vs 5:40 (' + M + '0:20), HR 105 vs 150 (+45)', spl[0].join('|'));
  ok(spl[6].slice(1, 3).join() === '-,-' && spl[6][5] === '-', 'split 7: run A has none -> dashes, no delta', spl[6].join('|'));
  r = await row('Distance (km)'); ok(r && r.a === '5.00' && r.b === '7.10' && r.d === '+2.10', 'metric distance 5.00 / 7.10 / +2.10 km', JSON.stringify(r));
  r = await row('Avg pace (/km)'); ok(r && r.a === '6:00' && r.b === '5:38' && r.d === M + '0:22', 'metric pace 6:00 / 5:38 / -0:22', JSON.stringify(r));
  what = await txt('#crWhatText'); ok(/^B was 2\.1 km longer/.test(what), 'what changed in km: B was 2.1 km longer', what);
  await page.click('#crClose');

  // ── 7. imported (Strava) runs: no traces ──────────────────────────────────
  await seed([strava(9001, 6, 'Strava easy', 8, 2700), alpha(), strava(9002, 2, 'Strava tempo', 10, 3000)]);
  await openPanel();                                            // defaults: the two latest = Strava tempo (B) + Alpha(A)? -> check
  sa = await selVal('crSelA'); sb = await selVal('crSelB');
  ok(/Alpha/.test(sa) && /Strava tempo/.test(sb) && /Strava/.test(sb), 'defaults take the two latest even when one is imported; option shows Strava tag', sb.slice(-30));
  var note = await txt('#crNoTrace');
  ok(/No heart-rate trace stored for run B/.test(note) && /showing run A only/.test(note), 'one trace only: says so and plots the one', note);
  var lines1 = await page.evaluate(function () { return { a: document.querySelectorAll('.cr-line-a').length, b: document.querySelectorAll('.cr-line-b').length, off: document.querySelectorAll('.cr-leg.off').length }; });
  ok(lines1.a === 3 && lines1.b === 0 && lines1.off === 1, 'only run A is plotted; legend greys B', JSON.stringify(lines1));
  r = await row('Duration'); ok(r && r.a === '30:00' && r.b === '50:00' && r.d === '+20:00', 'imported run summary rows still work', JSON.stringify(r));
  r = await row('Z2 60-70%'); ok(r && r.a !== '-' && r.b === '-' && r.d === '-', 'zone time: - for the imported run, no delta', JSON.stringify(r));
  r = await row('Avg HR (bpm)'); ok(r.b === '155', 'imported run keeps its summary avg HR', JSON.stringify(r));
  var tags = await page.evaluate(function () { return document.querySelectorAll('#crPanel .cr-sv').length; });
  ok(tags === 1, 'Strava tag next to imported run name', tags);
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-3-one-trace.png') });
  await page.selectOption('#crSelA', { label: undefined } && '1'); await sleep(150);   // A -> Strava easy (index 1 after sort: 9002,alpha,9001 -> idx1 = Alpha). choose idx 2
  await page.selectOption('#crSelA', '2'); await sleep(200);
  note = await txt('#crNoTrace');
  ok(/^No heart-rate trace stored for this run/.test(note), 'both imported: clear No heart-rate trace stored note', note);
  ok(await page.evaluate(function () { return document.querySelectorAll('#crPanel svg').length === 0; }), 'no empty charts drawn when neither run has a trace');
  ok(await page.isVisible('#crNoSplits'), 'no splits note for imported pair');
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-4-imported-pair.png') });
  await page.click('#crClose');

  // ── 8. XSS route names ────────────────────────────────────────────────────
  var x1 = alpha(), x2 = bravo();
  x1.routeName = '<img src=x onerror="window.__xss=1">Evil'; x2.routeName = '"><script>window.__xss=2<\/script>';
  await seed([x1, x2]); await openPanel();
  var xs = await page.evaluate(function () { return { x: window.__xss || null, imgs: document.querySelectorAll('#crPanel img, #crPanel script').length, names: document.querySelector('.cr-names').textContent, opt: document.getElementById('crSelA').options[0].textContent }; });
  ok(xs.x === null && xs.imgs === 0, 'XSS route names are inert (no script/img created, no handler fired)', JSON.stringify(xs.x));
  ok(xs.names.indexOf('<img src=x onerror') >= 0 && xs.names.indexOf('Evil') >= 0, 'route name shown literally as text', xs.names.slice(0, 50));
  await page.click('#crClose');

  // ── 9. fewer than two runs ────────────────────────────────────────────────
  await seed([]); await openPanel();
  var e0 = await txt('#crEmpty'); ok(/No runs saved yet/.test(e0) && !(await page.$('#crSelA')), 'zero runs: friendly message, no pickers', e0.slice(0, 40));
  await page.click('#crClose'); ok(!(await page.isVisible('#crPanel')), 'close button closes the panel');
  await seed([alpha()]); await openPanel();
  var e1 = await txt('#crEmpty'); ok(/at least two saved runs/.test(e1), 'one run: asks for a second', e1.slice(0, 40));
  await page.keyboard.press('Escape'); await sleep(100); ok(!(await page.isVisible('#crPanel')), 'Escape closes the panel');
  await page.evaluate(function () { localStorage.setItem('tr_runs', '{not json'); });
  await page.reload({ waitUntil: 'load' }); await sleep(300); await openPanel();
  ok(/No runs saved yet/.test(await txt('#crEmpty')), 'corrupt tr_runs handled as no runs');
  await page.click('#crClose');
  // junk run records must not break the panel
  var sv = new Date(NOW - DAY).toISOString();   // (stats.html's own history code throws on a run with NO date at all - pre-existing, not part of this feature)
  await seed([{ savedAt: sv }, { savedAt: sv, elapsed: 'abc', distanceKm: null, trackPoints: 'x' }, { id: 'z', savedAt: sv, trackPoints: [null, { elapsed: 5 }, { elapsed: 10, hr: 'x' }] }]); await openPanel();
  ok(await page.isVisible('#crSelA') && !(await page.evaluate(function () { return /NaN|undefined|Infinity/.test(document.getElementById('crPanel').textContent); })), 'junk run records: no NaN/undefined, panel still works');
  await page.click('#crClose');

  // ── 10. layout at 1920x1000 ───────────────────────────────────────────────
  async function layout(tag) {
    var res = await page.evaluate(function () {
      var panel = document.getElementById('crPanel'), pr = panel.getBoundingClientRect(), out = { zone: [], strip: [], small: [], clip: [], over: [], vw: innerWidth, vh: innerHeight };
      var ctl = panel.querySelectorAll('button, select, a, input');
      for (var i = 0; i < ctl.length; i++) {
        var r = ctl[i].getBoundingClientRect(), id = ctl[i].id || ctl[i].className;
        if (r.width === 0) continue;
        if (r.left < 110 && r.top < 110 && r.right > 0 && r.bottom > 0) out.zone.push(id);
        if (r.top < innerHeight && r.bottom > innerHeight - 80 && r.top >= 0) out.strip.push(id);
        if (r.height < 64 - 0.5 || r.width < 64) out.small.push(id + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      // any visible text node box in the top-left 110x110 (title padding)?
      var all = panel.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var e = all[j], b = e.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
        [].forEach.call(e.childNodes, function (n) {
          if (n.nodeType !== 3 || !n.textContent.trim()) return;
          var rg = document.createRange(); rg.selectNodeContents(n); var q = rg.getBoundingClientRect();
          if (q.width && q.left < 110 && q.top < 110) out.zone.push('text:' + e.className);
        });
        if (b.right > innerWidth + 1 || b.left < -1) out.over.push((e.id || e.className || e.tagName) + ':' + Math.round(b.left) + '-' + Math.round(b.right));
        if ((e.tagName === 'TD' || e.tagName === 'TH' || e.classList.contains('cr-name')) && e.scrollWidth > e.clientWidth + 1) out.clip.push(e.tagName + ':' + e.textContent.slice(0, 30));
      }
      out.panelScrollW = panel.scrollWidth; out.panelClientW = panel.clientWidth; out.docScrollW = document.documentElement.scrollWidth;
      out.pr = { l: pr.left, t: pr.top, r: pr.right, b: pr.bottom };
      return out;
    });
    ok(res.zone.length === 0, tag + ': nothing in the top-left 110x110', res.zone.join(','));
    ok(res.strip.length === 0, tag + ': no control in the bottom 80px strip', res.strip.join(','));
    ok(res.small.length === 0, tag + ': every button/select >= 64px', res.small.join(','));
    ok(res.over.length === 0, tag + ': nothing overflows the 1920px width', res.over.slice(0, 4).join(','));
    ok(res.clip.length === 0, tag + ': no clipped table cell / run name', res.clip.slice(0, 4).join(' ; '));
    ok(res.panelScrollW <= res.panelClientW && res.docScrollW <= res.vw, tag + ': no horizontal scroll', res.panelScrollW + '/' + res.panelClientW + ' doc ' + res.docScrollW);
    ok(res.pr.l === 0 && res.pr.t === 0 && Math.round(res.pr.r) === 1920 && Math.round(res.pr.b) === 1000, tag + ': panel fills 1920x1000', JSON.stringify(res.pr));
    return res;
  }
  await seed([carol(), bravo(), alpha()]); await openPanel(); await layout('two traces');
  var cb = await page.evaluate(function () { var r = document.getElementById('crClose').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right }; });
  ok(cb.l > 1000 && cb.t >= 0, 'close button is top-right', JSON.stringify(cb));
  await seed([strava(9001, 6, 'Strava easy', 8, 2700), strava(9002, 2, 'Strava tempo', 10, 3000)]); await openPanel(); await layout('imported pair');
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-5-imported-default.png') });
  await seed([carol(), bravo(), alpha()]); await openPanel(); await page.keyboard.press('Escape');
  var vis = await page.evaluate(function () { var p = document.getElementById('runDetail'); return getComputedStyle(p).display; });
  ok(vis === 'none', 'run-detail panel unaffected (still hidden)');
  // existing split compare still renders in run detail
  await page.evaluate(function () { openRunDetail(0); }); await sleep(250);
  ok((await txt('#rdSplits')).length > 20, 'existing run detail + split comparison still render');

  // ── 11. read-only / offline guarantees ────────────────────────────────────
  var js = fs.readFileSync(path.join(UI, 'js/compare-runs.js'), 'utf8');
  ok(!/\bTM\b|treadmill|setSpeed|setIncline|AndroidBridge|WebSocket|fetch\(|XMLHttpRequest|adb|innerHTML/i.test(js.replace(/\/\/.*$/mg, '')), 'compare-runs.js has no treadmill/network/innerHTML calls');
  ok(!reqs.some(function (u) { return /treadmill\.js/.test(u); }), 'treadmill.js is not loaded on stats.html');
  ok(!reqs.some(function (u) { return !/^(http:\/\/localhost:8099|data:)/.test(u) && !/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/.test(u); }), 'no requests leave localhost:8099', reqs.filter(function (u) { return !/^http:\/\/localhost:8099/.test(u); }).slice(0, 3).join(','));
  ok(errors.length === 0, 'no console / page errors', errors.slice(0, 3).join(' ; '));

  await browser.close();
  children.forEach(function (c) { try { c.kill(); } catch (e) {} });
  say('\n' + (total - fails) + '/' + total + ' passed' + (fails ? ', ' + fails + ' FAILED' : ''));
  try { fs.writeFileSync(LOG, lines.join('\n') + '\n'); } catch (e) {}
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error('TEST CRASH', e); process.exit(2); });
