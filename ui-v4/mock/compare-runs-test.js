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

// ── deep-import records (same layout strava-deep.js writes: runs{id, summary, skip, t,hr,v,g,d,alt,cad}) ─────────
// run: constant speed v (m/s) for dur s on a 5 s grid; hrF(t) bpm or null; gF(t) grade percent
function deepRec(id, startMs, name, o) {
  var n = Math.floor(o.dur / 5) + 1, t = [], hr = [], v = [], g = [], d = [], alt = [], cad = [], i;
  for (i = 0; i < n; i++) { var tt = i * 5; t.push(tt); v.push(o.v); d.push(Math.round(o.v * tt * 10) / 10); g.push(o.gF ? o.gF(tt) : 0); alt.push(100); cad.push(85); hr.push(o.hrF ? Math.round(o.hrF(tt)) : null); }
  var dist = o.v * (n - 1) * 5, sum = { id: id, name: name, type: 'Run', sport_type: 'Run', start_date: new Date(startMs).toISOString(), start_date_local: new Date(startMs).toISOString().replace('Z', ''),
    distance: dist, moving_time: (n - 1) * 5, elapsed_time: (n - 1) * 5, average_speed: o.v, total_elevation_gain: o.elev || 0, has_heartrate: !!o.hrF };
  if (o.hrF) { sum.average_heartrate = o.avgHR; sum.max_heartrate = o.maxHR; }
  return { id: id, summary: sum, skip: null, fetchedAt: startMs, t: t, hr: o.hrF ? hr : null, v: v, g: g, d: d, alt: alt, cad: cad };
}
function d1rec() { return deepRec(7001, NOW - 3 * DAY, 'Strava Thursday 6k', { v: 6000 / 2100, dur: 2100, hrF: function (t) { return 120 + 0.5 * t / 60; }, avgHR: 140, maxHR: 162, gF: function (t) { return t < 1050 ? 2 : 1; }, elev: 40 }); }
function d2rec() { return deepRec(7002, NOW - 5 * DAY + 20000, 'Strava dup of Alpha', { v: 4000 / 1500, dur: 1500, hrF: function () { return 150; }, avgHR: 150, maxHR: 160 }); }
function d3rec() { return deepRec(7003, NOW - 8 * DAY, 'Strava no strap', { v: 3000 / 1200, dur: 1200, hrF: null }); }

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
  // seed tr_runs (+ optional 'trailrunner_hrtrain' with the strava-deep layout); the deep DB is deleted first so every case starts clean
  async function seedFull(runs, settings, deepRecs, opt) {
    await page.goto(APP, { waitUntil: 'load' });
    await page.evaluate(function (a) {
      localStorage.clear(); localStorage.setItem('tr_runs', JSON.stringify(a.runs)); if (a.s) localStorage.setItem('tr_settings', JSON.stringify(a.s));
      return new Promise(function (resolve, reject) {
        var del = indexedDB.deleteDatabase('trailrunner_hrtrain');
        del.onsuccess = del.onerror = function () {
          if (!a.deep && !a.opt) return resolve();
          var r = indexedDB.open('trailrunner_hrtrain', 1);
          r.onupgradeneeded = function () {
            var db = r.result;
            if (a.opt === 'nostore') { db.createObjectStore('meta'); return; }
            db.createObjectStore('runs', { keyPath: 'id' }); db.createObjectStore('meta');
          };
          r.onsuccess = function () {
            var db = r.result;
            if (!a.deep || !a.deep.length || a.opt === 'nostore') { db.close(); return resolve(); }
            var t = db.transaction('runs', 'readwrite'); a.deep.forEach(function (x) { t.objectStore('runs').put(x); });
            t.oncomplete = function () { db.close(); resolve(); }; t.onerror = function () { reject(new Error('seed failed')); };
          };
          r.onerror = function () { reject(new Error('open failed')); };
        };
      });
    }, { runs: runs, s: settings || null, deep: deepRecs || null, opt: opt || null });
    await page.goto(APP, { waitUntil: 'load' }); await sleep(400);
  }
  function dbList() { return page.evaluate(function () { return indexedDB.databases().then(function (l) { return l.map(function (d) { return d.name + '@' + d.version; }).sort(); }); }); }
  function dumpDb(name) {
    return page.evaluate(function (n) {
      return indexedDB.databases().then(function (l) {
        if (!l.some(function (d) { return d.name === n; })) return null;
        return new Promise(function (resolve) {
          var r = indexedDB.open(n); r.onsuccess = function () {
            var db = r.result, out = { version: db.version, stores: Array.prototype.slice.call(db.objectStoreNames), rows: {} }, left = out.stores.length;
            if (!left) { db.close(); return resolve(JSON.stringify(out)); }
            out.stores.forEach(function (sn) { var q = db.transaction(sn).objectStore(sn).getAll(); q.onsuccess = function () { out.rows[sn] = q.result; if (--left === 0) { db.close(); resolve(JSON.stringify(out)); } }; });
          };
        });
      });
    }, name);
  }
  function opts(id) { return page.evaluate(function (i) { var s = document.getElementById(i); return [].map.call(s.options, function (o) { return o.textContent; }); }, id); }
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
  var dbsNone = await dbList();
  ok(!dbsNone.some(function (x) { return /trailrunner_hrtrain/.test(x); }), 'absent deep-import DB: opening the panel does NOT create it (indexedDB.databases() has no trailrunner_hrtrain)', dbsNone.join(' ') || '(none)');
  ok(!(await page.$('#crLoading')) && !(await page.$('#crFilter')), 'absent deep-import DB: no loading note left, no filter row for 3 runs');
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

  // ═══ PART 2: imported Strava runs WITH a trace (read-only from 'trailrunner_hrtrain') ═══════════════════════════
  say('--- deep-import runs in the compare view ---');
  var LIVE_ROW = { id: 'keep1', v: 'SOPH' };
  async function makeLive() {
    await page.evaluate(function (row) {
      return new Promise(function (resolve) {
        var r = indexedDB.open('trailrunner', 7);
        r.onupgradeneeded = function () { var db = r.result; if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' }); if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
        r.onsuccess = function () { var db = r.result, t = db.transaction('runs', 'readwrite'); t.objectStore('runs').put(row); t.oncomplete = function () { db.close(); resolve(); }; };
      });
    }, LIVE_ROW);
  }
  // sv_7001 = summary-only import of D1 (same stravaId + start) ; alpha = own treadmill run with a trace, D2 is the same run seen from Strava (start +20 s)
  var runsP2 = [carol(), bravo(), alpha(), strava(7001, 3, 'Strava Thursday 6k (summary only)', 6, 2100)];
  runsP2[3].startedAt = new Date(NOW - 3 * DAY).toISOString();
  await seedFull(runsP2, null, [d1rec(), d2rec(), d3rec()]);
  await makeLive();
  var liveBefore = await dumpDb('trailrunner'), deepBefore = await dumpDb('trailrunner_hrtrain'), dbsBefore = await dbList(), trBefore = await page.evaluate(function () { return localStorage.getItem('tr_runs'); });
  await openPanel(); await sleep(300);
  var oA = await opts('crSelA');
  ok(oA.length === 5, 'merged pickers: 5 runs = bravo, D1 (replaces its summary-only import), alpha (own trace wins over D2), D3, carol', oA.length + ' | ' + oA.map(function (x) { return x.slice(-26); }).join(' | '));
  ok(oA.filter(function (x) { return /Strava Thursday 6k/.test(x); }).length === 1 && !/summary only/.test(oA.join('|')), 'dedupe by stravaId + start time: the summary-only import and the traced copy appear ONCE (the traced one)');
  ok(oA.filter(function (x) { return /Alpha loop/.test(x); }).length === 1 && !/dup of Alpha/.test(oA.join('|')), 'dedupe: the own treadmill run (has a trace) and its Strava copy appear once, own preferred');
  ok(/Strava \+ HR trace/.test(oA.join('|')) && /Strava \+ trace/.test(oA.join('|')), 'tags: "Strava + HR trace" for D1, "Strava + trace" for the run without a strap');
  sa = await selVal('crSelA'); sb = await selVal('crSelB');
  ok(/Strava Thursday 6k/.test(sa) && /Strava \+ HR trace/.test(sa) && /Bravo hills/.test(sb), 'defaults = two latest: A = D1 (3 days ago, Strava + HR trace), B = Bravo', sa.slice(-50) + ' | ' + sb.slice(-20));
  r = await row('Duration'); ok(r && r.a === '35:00' && r.b === '40:00' && r.d === '+5:00', 'D1 duration 35:00 vs Bravo 40:00 (+5:00)', JSON.stringify(r));
  r = await row('Distance (mi)'); ok(r && r.a === '3.73' && r.b === '4.41' && r.d === '+0.68', 'D1 distance 3.73 mi vs 4.41 (+0.68)', JSON.stringify(r));
  r = await row('Avg pace (/mi)'); ok(r && r.a === '9:23' && r.b === '9:04', 'D1 avg pace 9:23 /mi (350 s/km)', JSON.stringify(r));
  r = await row('Avg HR (bpm)'); ok(r && r.a === '140' && r.b === '150' && r.d === '+10', 'D1 avg HR 140 from the Strava summary', JSON.stringify(r));
  r = await row('Avg incline (%)'); ok(r && r.a === '1.5' && r.b === '0.5', 'D1 avg incline 1.5 % from the grade stream', JSON.stringify(r));
  r = await row('HR drift (bpm/min)'); ok(r && r.a === '+0.50' && r.b === '0.00', 'D1 HR drift +0.50 bpm/min from the stored HR stream', JSON.stringify(r));
  r = await row('Elevation gained (ft)'); ok(r && r.a === '131', 'D1 elevation 40 m = 131 ft', JSON.stringify(r));
  var chd = await page.evaluate(function () { return { svgs: document.querySelectorAll('#crPanel svg.cr-svg').length, la: document.querySelectorAll('.cr-line-a').length, lb: document.querySelectorAll('.cr-line-b').length, note: !!document.getElementById('crNoTrace'), tag: [].map.call(document.querySelectorAll('.cr-name .cr-sv'), function (e) { return e.textContent; }) }; });
  ok(chd.svgs === 3 && chd.la === 3 && chd.lb === 3 && !chd.note, 'D1 (Strava + HR trace) vs Bravo (own run): HR + speed + incline charts, both runs plotted', JSON.stringify(chd));
  ok(chd.tag.join() === 'Strava + HR trace', 'name header carries the "Strava + HR trace" tag', chd.tag.join());
  var tpCheck = await page.evaluate(function () {
    return new Promise(function (resolve) {
      var r = indexedDB.open('trailrunner_hrtrain'); r.onsuccess = function () {
        var q = r.result.transaction('runs').objectStore('runs').get(7001); q.onsuccess = function () {
          var rec = q.result; r.result.close();
          var light = HrTrainRead._summaryRun(rec), full = HrTrainRead.build(light), p = full.trackPoints[100], i = 100;
          resolve({ n: full.trackPoints.length, nrec: rec.t.length, el: p.elapsed === rec.t[i], hr: p.hr === rec.hr[i], spd: Math.abs(p.speed - rec.v[i] * 3.6) < 1e-9, inc: p.incline === rec.g[i], dist: p.dist === rec.d[i], spl: full.splits.map(function (s) { return Math.round(s.timeSec); }), splHR: full.splits[0].avgHR, fin: full.finalSplit && full.finalSplit.partial, noRec: !('_rec' in full) });
        };
      };
    });
  });
  ok(tpCheck.n === tpCheck.nrec && tpCheck.el && tpCheck.hr && tpCheck.spd && tpCheck.inc && tpCheck.dist && tpCheck.noRec, 'trace built from the streams: {elapsed, hr, speed km/h = v x 3.6, incline = grade %, dist = d} point for point', JSON.stringify(tpCheck));
  ok(tpCheck.spl.join() === '350,350,350,350,350,350' && tpCheck.splHR === 122 && !tpCheck.fin, 'per-km splits from the d[]/t[] streams: 6 x 350 s, km 1 avg HR 122 (mean of the 70 samples 5..350 s = 121.5, hand-computed)', tpCheck.spl.join() + ' hr ' + tpCheck.splHR);
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-6-strava-trace-vs-own.png') });
  var litter = await dbList();
  ok(JSON.stringify(litter) === JSON.stringify(dbsBefore), 'opening the panel changes no database list', litter.join(' '));
  ok((await dumpDb('trailrunner_hrtrain')) === deepBefore, "the deep-import database is byte-identical after use (read-only: same version, stores and rows)");
  ok((await dumpDb('trailrunner')) === liveBefore && JSON.parse(liveBefore).rows.runs[0].v === 'SOPH', "the live 'trailrunner' database is untouched");
  ok((await page.evaluate(function () { return localStorage.getItem('tr_runs'); })) === trBefore, 'localStorage tr_runs is byte-identical after opening/selecting');
  // pick the strapless run as A against own Bravo: no HR trace for A, but speed/incline still plotted
  var idxD3 = await page.evaluate(function () { var s = document.getElementById('crSelA'); for (var i = 0; i < s.options.length; i++) if (/no strap/.test(s.options[i].textContent)) return s.options[i].value; });
  await page.selectOption('#crSelA', idxD3); await sleep(250);
  note = await txt('#crNoTrace');
  ok(/No heart-rate trace stored for run A/.test(note), 'run without HR: clear "No heart-rate trace" note for that run', note);
  r = await row('Avg HR (bpm)'); ok(r && r.a === '-' && r.b === '150' && r.d === '-', 'run without HR shows - for HR numbers', JSON.stringify(r));
  r = await row('Duration'); ok(r && r.a === '20:00', 'strapless run duration 20:00', JSON.stringify(r));
  ok(await page.evaluate(function () { return document.querySelectorAll('.cr-line-a').length === 2 && document.querySelectorAll('#crPanel svg.cr-svg')[0].querySelectorAll('.cr-line-a').length === 0; }), 'strapless run: no line in the HR chart, but its speed and incline lines are still plotted (2 lines)');
  r = await row('Z2 60-70%'); ok(r && r.a === '-' && r.b !== '-', 'strapless run: zone times are - (no HR), the other run keeps its zones', JSON.stringify(r));
  // metric splits for D1 (km)
  await seedFull(runsP2, { unitSystem: 'metric', maxHR: 185 }, [d1rec(), d2rec(), d3rec()]); await openPanel(); await sleep(300);
  spl = await page.evaluate(function () { return [].map.call(document.querySelectorAll('#crSplitTable tbody tr'), function (tr) { return [].map.call(tr.children, function (c) { return c.textContent; }); }); });
  ok(spl.length === 7 && spl[0].slice(0, 5).join('|') === '1|5:50|122|5:40|150' && spl[5][1] === '5:50' && spl[6][1] === '-', 'metric per-km split table: D1 6 x 5:50 (km1 HR 122) vs Bravo 7 x 5:40', spl[0].join('|'));
  await page.click('#crClose');

  // XSS in a Strava run name
  var xr = d1rec(); xr.summary.name = '<img src=x onerror="window.__xss=7">Evil <script>window.__xss=8<\/script>';
  await seedFull([bravo(), alpha()], null, [xr]); await openPanel(); await sleep(300);
  var xs2 = await page.evaluate(function () { return { x: window.__xss || null, imgs: document.querySelectorAll('#crPanel img, #crPanel script').length, names: document.querySelector('.cr-names').textContent, opt: [].map.call(document.getElementById('crSelA').options, function (o) { return o.textContent; }).join('|') }; });
  ok(xs2.x === null && xs2.imgs === 0 && /<img src=x onerror/.test(xs2.names + xs2.opt), 'XSS in a Strava run name from the deep store: inert, shown literally', JSON.stringify(xs2.x));
  await page.click('#crClose');

  // missing / empty store, and DB missing the 'runs' store: nothing created or changed
  await seedFull([bravo(), alpha()], null, null, 'nostore');
  var nsBefore = await dumpDb('trailrunner_hrtrain');
  await openPanel(); await sleep(300);
  ok((await opts('crSelA')).length === 2 && (await dumpDb('trailrunner_hrtrain')) === nsBefore && JSON.parse(nsBefore).stores.join() === 'meta', "DB without a 'runs' store: ignored, not upgraded (still version 1, only 'meta')");
  await page.click('#crClose');
  await seedFull([bravo(), alpha()], null, [], 'empty');
  var emBefore = await dumpDb('trailrunner_hrtrain');
  await openPanel(); await sleep(300);
  ok((await opts('crSelA')).length === 2 && (await dumpDb('trailrunner_hrtrain')) === emBefore, 'empty runs store: nothing added, database unchanged');
  await page.click('#crClose');
  // a stored record that is only a skip marker / has no stream is not offered
  var skipRec = { id: 7100, summary: { id: 7100, name: 'skipped', start_date: new Date(NOW - 2 * DAY).toISOString(), distance: 5000, moving_time: 1500 }, skip: 'forbidden', t: null };
  var pendRec = { id: 7101, summary: { id: 7101, name: 'pending', start_date: new Date(NOW - 2 * DAY).toISOString(), distance: 5000, moving_time: 1500 }, skip: null, t: null, fetchedAt: 0 };
  await seedFull([bravo(), alpha()], null, [skipRec, pendRec]); await openPanel(); await sleep(300);
  ok((await opts('crSelA')).length === 2, 'skip markers and not-yet-loaded runs (no stream) are not offered');
  await page.click('#crClose');

  // loading is async: the panel opens at once with "Loading past runs...", then the list grows
  await seedFull(runsP2, null, [d1rec(), d2rec(), d3rec()]);
  await page.evaluate(function () { var orig = indexedDB.databases.bind(indexedDB); indexedDB.databases = function () { return new Promise(function (res) { setTimeout(function () { res(orig()); }, 900); }); }; });
  await page.click('#crOpenBtn'); await sleep(150);
  var ld = await page.evaluate(function () { return { vis: document.getElementById('crPanel').classList.contains('show'), load: (document.getElementById('crLoading') || {}).textContent || null, n: document.getElementById('crSelA').options.length, close: !!document.getElementById('crClose') }; });
  ok(ld.vis && ld.load === 'Loading past runs...' && ld.n === 4 && ld.close, 'async load: the panel opens at once with the own runs (4) and "Loading past runs..."', JSON.stringify(ld));
  await sleep(1300);
  ld = await page.evaluate(function () { return { load: !!document.getElementById('crLoading'), n: document.getElementById('crSelA').options.length }; });
  ok(!ld.load && ld.n === 5, 'async load: note disappears and the pickers now list 5 merged runs', JSON.stringify(ld));
  await page.click('#crClose');

  // 220 imported runs: last 20 / all (grouped by month) / search
  var many = [], q9;
  for (q9 = 0; q9 < 220; q9++) many.push(deepRec(9000 + q9, NOW - (q9 + 6) * DAY - 3600000, 'Strava run ' + q9, { v: 2.8, dur: 60, hrF: function () { return 140; }, avgHR: 140, maxHR: 150 }));
  await seedFull([bravo(), alpha(), carol()], null, many);
  await openPanel(); await sleep(600);
  var m1 = await page.evaluate(function () { return { n: document.getElementById('crSelA').options.length, cnt: document.getElementById('crCount').textContent, groups: document.querySelectorAll('#crSelA optgroup').length, h: document.getElementById('crSearch').getBoundingClientRect().height, on: document.getElementById('crLast20').className }; });
  ok(m1.n === 20 && /Showing 20 of 223 runs/.test(m1.cnt) && /on/.test(m1.on), '223 runs: dropdowns open on "LAST 20" (20 options, "Showing 20 of 223 runs")', JSON.stringify(m1));
  ok(m1.h >= 64, 'search box is >= 64 px tall', Math.round(m1.h));
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-7-picker-223-last20.png') });
  await page.click('#crAllRuns'); await sleep(200);
  var m2 = await page.evaluate(function () { return { n: document.getElementById('crSelA').options.length, groups: document.querySelectorAll('#crSelA optgroup').length, cnt: document.getElementById('crCount').textContent, lab: [].map.call(document.querySelectorAll('#crSelA optgroup'), function (g) { return g.label; }).slice(0, 2) }; });
  ok(m2.n === 223 && m2.groups >= 7 && /Showing 223 of 223/.test(m2.cnt), 'ALL RUNS: 223 options grouped by month (' + m2.groups + ' month groups)', JSON.stringify(m2));
  await page.fill('#crSearch', 'run 150'); await sleep(250);
  var m3 = await page.evaluate(function () { return { opts: [].map.call(document.getElementById('crSelB').options, function (o) { return o.textContent; }), cnt: document.getElementById('crCount').textContent }; });
  ok(m3.opts.filter(function (x) { return /Strava run 150/.test(x); }).length === 1 && m3.opts.length <= 3 && /of 223/.test(m3.cnt), 'search "run 150": the matching run (+ the two currently picked) only', m3.cnt + ' | ' + m3.opts.length);
  var v150 = await page.evaluate(function () { var s = document.getElementById('crSelA'); for (var i = 0; i < s.options.length; i++) if (/Strava run 150/.test(s.options[i].textContent)) return s.options[i].value; });
  await page.selectOption('#crSelA', v150); await sleep(300);
  ok(/Strava run 150/.test(await selVal('crSelA')) && /Strava run 150/.test(await txt('.cr-names')), 'picking the searched run compares it (name shown)', (await txt('.cr-names')).slice(0, 40));
  r = await row('Duration'); ok(r && r.a === '1:00', 'and its summary numbers appear (duration 1:00)', JSON.stringify(r));
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-8-picker-search.png') });
  await page.fill('#crSearch', 'zzz-no-such-run'); await sleep(200);
  ok((await opts('crSelA')).length >= 1 && (await opts('crSelA')).length <= 2 && /of 223/.test(await txt('#crCount')), 'search with no match: no crash, picked runs stay visible');
  await page.fill('#crSearch', ''); await page.click('#crLast20'); await sleep(200);
  await layout('223 runs');
  await page.click('#crClose');

  // R3-1: a databases() / open() that never answers must not leave "Loading past runs..." for ever
  async function stubCase(label, ownRuns, stub, tmo, waitMs) {
    await seedFull(ownRuns, null, [d1rec(), d2rec(), d3rec()]);
    await page.evaluate(function (a) { if (a.tmo) HrTrainRead.timeoutMs = a.tmo; eval(a.stub); }, { stub: stub, tmo: tmo });
    await page.click('#crOpenBtn'); await sleep(300);
    var early = await page.evaluate(function () { return { load: !!document.getElementById('crLoading'), vis: document.getElementById('crPanel').classList.contains('show') }; });
    await sleep(waitMs);
    var late = await page.evaluate(function () { var e = document.getElementById('crEmpty'); return { load: !!document.getElementById('crLoading'), empty: e ? e.textContent : null, sel: !!document.getElementById('crSelA'), n: document.getElementById('crSelA') ? document.getElementById('crSelA').options.length : 0 }; });
    await page.click('#crClose');
    return { early: early, late: late };
  }
  var NEVER_DB = "indexedDB.databases = function () { return new Promise(function () {}); };";
  var NEVER_OPEN = "indexedDB.open = function () { return {}; };";
  var c0 = await stubCase('0 own', [], NEVER_DB, 0, 4400);
  ok(c0.early.load && c0.early.vis && !c0.late.load && /No runs saved yet/.test(c0.late.empty || ''), 'R3-1 databases() never resolves, 0 own runs (default 4 s timeout): Loading at first, then gone and "No runs saved yet" shows', JSON.stringify(c0));
  var c1 = await stubCase('1 own', [bravo()], NEVER_DB, 700, 1200);
  ok(c1.early.load && !c1.late.load && /at least two saved runs/.test(c1.late.empty || ''), 'R3-1 databases() never resolves, 1 own run: the "need two runs" message appears', JSON.stringify(c1.late));
  var c2 = await stubCase('2 own', [bravo(), alpha()], NEVER_DB, 700, 1200);
  ok(c2.early.load && !c2.late.load && c2.late.sel && c2.late.n === 2, 'R3-1 databases() never resolves, 2 own runs: Loading note clears, the 2 own runs stay comparable', JSON.stringify(c2.late));
  var c3 = await stubCase('open never', [bravo()], NEVER_OPEN, 700, 1200);
  ok(c3.early.load && !c3.late.load && /at least two saved runs/.test(c3.late.empty || ''), 'R3-1 open() never fires, 1 own run: times out, message appears', JSON.stringify(c3.late));
  var c4 = await stubCase('open never 0', [], NEVER_OPEN, 700, 1200);
  ok(!c4.late.load && /No runs saved yet/.test(c4.late.empty || ''), 'R3-1 open() never fires, 0 own runs: "No runs saved yet"', JSON.stringify(c4.late));
  // a result that arrives AFTER the timeout is ignored
  var c5 = await stubCase('late', [bravo(), alpha()], "var o = indexedDB.databases.bind(indexedDB); indexedDB.databases = function () { return new Promise(function (r) { setTimeout(function () { r(o()); }, 1500); }); };", 700, 2600);
  ok(!c5.late.load && c5.late.n === 2, 'R3-1 a late answer after the timeout is ignored (still the 2 own runs, not 5 merged)', JSON.stringify(c5.late));

  // R3-4: a non-string run name never shows "[object Object]"
  var wn = d1rec(); wn.summary.name = { a: 1 }; var wn2 = d3rec(); wn2.summary.name = null;
  await seedFull([bravo()], null, [wn, wn2]); await openPanel(); await sleep(300);
  var wo = (await opts('crSelA')).join('|');
  ok(!/object Object/.test(wo) && /Strava run/.test(wo), 'R3-4 object / null names fall back to "Strava run", never "[object Object]"', wo.slice(0, 120));
  await page.click('#crClose');

  // R3-5 / R3-6: search debounce (150 ms), label order
  var many2 = [], q8;
  for (q8 = 0; q8 < 30; q8++) many2.push(deepRec(9500 + q8, NOW - (q8 + 6) * DAY - 7200000, 'Strava run ' + q8, { v: 2.8, dur: 60, hrF: function () { return 140; }, avgHR: 140, maxHR: 150 }));
  await seedFull([bravo(), alpha()], null, many2); await openPanel(); await sleep(500);
  await page.click('#crAllRuns'); await sleep(150);
  var db1 = await page.evaluate(function () {
    var inp = document.getElementById('crSearch'), n0 = document.getElementById('crSelA').options.length, w = ['r', 'ru', 'run', 'run 2', 'run 25'];
    w.forEach(function (v) { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); });
    return { n0: n0, nNow: document.getElementById('crSelA').options.length };
  });
  await sleep(450);
  var db2 = await page.evaluate(function () { return { n: document.getElementById('crSelA').options.length, cnt: document.getElementById('crCount').textContent }; });
  ok(db1.nNow === db1.n0 && db2.n < db1.n0 && /Showing \d+ of 32 runs/.test(db2.cnt), 'R3-5 search is debounced: 5 keystrokes change nothing synchronously, then ONE filter pass; count stays right', JSON.stringify({ before: db1, after: db2 }));
  var vis25 = await page.evaluate(function () { return [].map.call(document.getElementById('crSelA').options, function (o) { return o.textContent; }).filter(function (x) { return /Strava run 25/.test(x); }).length; });
  ok(vis25 === 1, 'R3-5 the final search text ("run 25") is the one applied', vis25);
  await page.fill('#crSearch', ''); await sleep(300);
  var lab = await page.evaluate(function () {
    var s = document.getElementById('crSelB'), o = s.options[s.selectedIndex].textContent, a = document.getElementById('crSelA'), oa = a.options[a.selectedIndex].textContent;
    var cv = document.createElement('canvas').getContext('2d'), cs = getComputedStyle(s); cv.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return { a: oa, b: o, w: s.clientWidth - 44, text: cv.measureText(o.split(' · ').slice(0, 4).join(' · ')).width };
  });
  ok(lab.a.split(' · ')[0] === 'Strava + HR trace' || /^\d/.test(lab.a), 'R3-6 label order: tag first (traced Strava runs), then date, distance, duration, name last', lab.a);
  ok(lab.text <= lab.w, 'R3-6 the useful part (date, distance, duration) of the B label fits at 1920 wide', Math.round(lab.text) + ' <= ' + Math.round(lab.w));
  await page.click('#crClose');
  await seedFull(runsP2, null, [d1rec(), d2rec(), d3rec()]); await openPanel(); await sleep(400);
  var d1opt = (await opts('crSelA'))[1] || '';
  var optsAll = (await opts('crSelA'));
  ok(optsAll.some(function (x) { return /^Strava \+ HR trace · \d/.test(x); }) && optsAll.some(function (x) { return /^Strava \+ trace · \d/.test(x); }) && optsAll.some(function (x) { return /^\d+ \w+ \d{4} · /.test(x); }), 'R3-6 options read "Strava + HR trace · date · distance · duration · name" (tag first), own runs "date · distance · ..."', optsAll[0] + ' | ' + optsAll[1]);
  await page.screenshot({ path: path.join(SHOTS, 'compare-runs-9-label-order.png'), clip: { x: 0, y: 0, width: 1920, height: 330 } });
  await page.click('#crClose');

  // #compare opens the panel on load (shortcut from insights.html); closing drops the hash
  await seedFull([bravo(), alpha(), carol()], null, null);
  await page.goto(APP + '#compare', { waitUntil: 'load' }); await sleep(500);
  ok(await page.isVisible('#crPanel') && (await opts('crSelA')).length === 3, 'stats.html#compare opens the COMPARE panel on load');
  await page.click('#crClose'); await sleep(100);
  ok(!(await page.evaluate(function () { return location.hash; })), 'closing the panel clears #compare');

  // stats page: PAST RUNS & INSIGHTS button
  await page.goto(APP, { waitUntil: 'load' }); await sleep(400);
  var ib = await page.evaluate(function () { var b = document.getElementById('crInsightsBtn'), c = document.getElementById('crOpenBtn'), r = b.getBoundingClientRect(), r2 = c.getBoundingClientRect(); return { h: r.height, w: r.width, x: r.left, y: r.top, bot: r.bottom, href: b.getAttribute('href'), col: getComputedStyle(b).color, bc: getComputedStyle(b).borderTopColor, cx: r2.right, cy: r2.top, txt: b.textContent }; });
  ok(ib.h >= 64 && ib.w >= 64 && ib.href === 'insights.html' && ib.txt === 'PAST RUNS & INSIGHTS', 'stats.html: big PAST RUNS & INSIGHTS button (>= 64 px) linking to insights.html', Math.round(ib.w) + 'x' + Math.round(ib.h));
  ok(/252, 82, 0/.test(ib.col) && /252, 82, 0/.test(ib.bc), 'button is Strava orange like the other Strava buttons', ib.col);
  ok(!(ib.x < 110 && ib.y < 110) && ib.bot < 1000 - 80 && ib.x >= ib.cx && Math.abs(ib.y - ib.cy) < 40, 'button sits next to COMPARE RUNS, outside the forbidden zones', Math.round(ib.x) + ',' + Math.round(ib.y) + ' bottom ' + Math.round(ib.bot));
  await page.screenshot({ path: path.join(SHOTS, 'stats-both-buttons.png'), clip: { x: 0, y: 0, width: 1920, height: 520 } });
  await page.screenshot({ path: path.join(SHOTS, 'stats-full-1920.png') });

  // ── 11. read-only / offline guarantees ────────────────────────────────────
  var js = fs.readFileSync(path.join(UI, 'js/compare-runs.js'), 'utf8');
  ok(!/\bTM\b|treadmill|setSpeed|setIncline|AndroidBridge|WebSocket|fetch\(|XMLHttpRequest|adb|innerHTML/i.test(js.replace(/\/\/.*$/mg, '')), 'compare-runs.js has no treadmill/network/innerHTML calls');
  var hrj = fs.readFileSync(path.join(UI, 'js/hrtrain-read.js'), 'utf8').replace(/\/\/.*$/mg, '');
  ok(!/readwrite|createObjectStore|deleteDatabase|deleteObjectStore|\.put\(|\.add\(|\.delete\(|\.clear\(|localStorage|sessionStorage|\bTM\b|treadmill|AndroidBridge|WebSocket|fetch\(|XMLHttpRequest|innerHTML|indexedDB\.open\([^)]*,/i.test(hrj), 'hrtrain-read.js: no write transaction, no create/delete/put/add, no version argument to open(), no storage/network/treadmill calls');
  ok(!reqs.some(function (u) { return /treadmill\.js/.test(u); }), 'treadmill.js is not loaded on stats.html');
  ok(!reqs.some(function (u) { return !/^(http:\/\/localhost:8099|data:)/.test(u) && !/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/.test(u); }), 'no requests leave localhost:8099', reqs.filter(function (u) { return !/^http:\/\/localhost:8099/.test(u); }).slice(0, 3).join(','));
  ok(errors.length === 0, 'no console / page errors', errors.slice(0, 3).join(' ; '));

  await browser.close();
  children.forEach(function (c) { try { c.kill(); } catch (e) {} });
  say('\n' + (total - fails) + '/' + total + ' passed' + (fails ? ', ' + fails + ' FAILED' : ''));
  try { fs.writeFileSync(LOG, lines.join('\n') + '\n'); } catch (e) {}
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error('TEST CRASH', e); process.exit(2); });
