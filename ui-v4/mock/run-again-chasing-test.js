#!/usr/bin/env node
// Run Again "CHASING" marker: stage-bar label + live gap, oval target marker, numbers-view target runner.
// Needs the static server (:8099) and mock bridge (:4510):  flock /tmp/trsuite.lock node mock/run-again-chasing-test.js
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UI = 'http://localhost:8099/', BR = 'localhost:4510';
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  var b = await pw.chromium.launch();
  var page = await (await b.newContext({ viewport: { width: 1920, height: 1000 } })).newPage(); page.setDefaultTimeout(8000);
  var errs = []; page.on('pageerror', function (e) { errs.push(String(e)); });
  await page.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  try { await fetch('http://' + BR + '/mock/reset', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {}
  await page.goto(UI + '?bridge=' + BR); await page.evaluate(function () { localStorage.clear(); }); await page.goto(UI + '?bridge=' + BR); await sleep(1800);

  // ── 1. pure maths on a known plan: 3 x 60 s at 7.2 kph (2 m/s) then 60 s at 3.6 kph (1 m/s)
  var m = await page.evaluate(function () {
    var w = { speedUnit: 'kph', distanceUnit: 'km', intervals: [{ duration: 60, speed: 7.2 }, { duration: 60, speed: 7.2 }, { duration: 60, speed: 7.2 }, { duration: 60, speed: 3.6 }] };
    var tl = RunAgain.chaseTimeline(w);
    var on = RunAgain.chaseGap(tl, 30, 60), ahead = RunAgain.chaseGap(tl, 30, 80), behind = RunAgain.chaseGap(tl, 30, 40), late = RunAgain.chaseGap(tl, 300, 500);
    return { total: [tl.totalS, tl.totalM], on: on, ahead: ahead, behind: behind, late: late,
      fAhead: RunAgain.fmtGap(ahead.gapS, ahead.gapM), fBehind: RunAgain.fmtGap(behind.gapS, behind.gapM), fOn: RunAgain.fmtGap(0.2, 0.4) };
  });
  ok(m.total[0] === 240 && m.total[1] === 420, 'timeline totals from the plan stages (240 s / 420 m)', m.total.join('/'));
  ok(Math.abs(m.on.gapM) < 1e-6 && Math.abs(m.on.gapS) < 1e-6, 'exactly on the plan -> gap 0');
  ok(Math.abs(m.ahead.gapM - 20) < 1e-6 && Math.abs(m.ahead.gapS - 10) < 1e-6, '20 m ahead at 2 m/s = +10 s', m.ahead.gapS + ' s ' + m.ahead.gapM + ' m');
  ok(Math.abs(m.behind.gapM + 20) < 1e-6 && Math.abs(m.behind.gapS + 10) < 1e-6, '20 m behind = -10 s');
  ok(/^\+0:10 AHEAD · (20 m|66 ft)$/.test(m.fAhead.text) && m.fAhead.cls === 'ahead', 'ahead text', m.fAhead.text);
  ok(/^-0:10 BEHIND · (20 m|66 ft)$/.test(m.fBehind.text) && m.fBehind.cls === 'behind', 'behind text', m.fBehind.text);
  ok(m.fOn.text === 'ON PACE', 'within 1 s = ON PACE');
  ok(m.late.targetFrac === 1 && m.late.runFrac === 1, 'past the plan end the fractions clamp to 1');

  // ── 2. arm a Run Again plan built from a saved run (hostile name, to prove textContent) and start it
  await page.evaluate(function () {
    var pts = [], d = 0;
    for (var t = 0; t <= 300; t += 5) { var sp = t < 100 ? 8 : t < 200 ? 10 : 8; d += sp / 3.6 * 5; pts.push({ elapsed: t, dist: Math.round(d), speed: sp, hr: 130, ele: 0, incline: 0 }); }
    var run = { id: 'run_chase', routeName: 'Loop <img src=x onerror="window.__xss=1">', routeId: null, startedAt: '2026-10-20T10:00:00Z', elapsed: 300, distanceM: Math.round(d), trackPoints: pts };
    var w = RunAgain.build(RunAgain.fromRun(run), { pct: 5, basis: 'time', wrap: false });
    window.__w = w; App.armWorkout(RunAgain.save(w));
  });
  await sleep(900);
  var w = await page.evaluate(function () { return { name: window.__w.name, date: window.__w.runAgain.sourceDate, type: window.__w.type }; });
  ok(w.date === '2026-10-20T10:00:00Z' && /^Run again \+5%$/.test(w.name), 'built workout carries the source run date', JSON.stringify(w));
  var hidden0 = await page.evaluate(function () { var e = document.getElementById('whChase'); return !e || e.style.display === 'none' || !e.offsetWidth; });
  ok(hidden0, 'no CHASING chip before the run starts');
  await page.click('#fcStart'); await sleep(9000);

  var s = await page.evaluate(function () {
    var q = function (id) { return document.getElementById(id); }, r = function (e) { var b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    var hud = q('workoutHud'), ch = q('whChase');
    var exp = new Date('2026-10-20T10:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    var vis = ['fcStop', 'fcPause', 'fcResume', 'fcStart'].map(function (i) { return q(i); }).filter(function (e) { return e && e.offsetWidth; }).map(r);
    return { label: q('whChaseLbl').textContent, gap: q('whChaseGap').textContent, cls: q('whChaseGap').className, exp: exp, shown: ch.offsetWidth > 0,
      chase: r(ch), hud: r(hud), ctrls: vis, imgs: ch.querySelectorAll('img,script').length, xss: window.__xss === 1, phase: WorkoutSegments.active && WorkoutSegments.active.phase,
      vh: window.innerHeight, vw: window.innerWidth, info: RunAgain.chaseInfo() && { started: RunAgain.chaseInfo().started, tf: RunAgain.chaseInfo().targetFrac } };
  });
  ok(s.shown && s.label === 'CHASING: your run of ' + s.exp + ' +5%', 'stage bar shows "CHASING: your run of <date> +5%"', s.label + ' / exp ' + s.exp);
  ok(/^(ON PACE|[+-]\d+:\d\d (AHEAD|BEHIND) · \d+ (m|ft))$/.test(s.gap), 'live gap text (ahead/behind seconds + metres)', s.gap);
  ok(s.cls === 'ahead' || s.cls === 'behind', 'gap coloured by class', s.cls);
  ok(s.info && s.info.started && s.info.tf > 0, 'target has advanced along the plan', JSON.stringify(s.info));
  ok(!s.xss && s.imgs === 0, 'hostile source name is inert text (no element injected, no script run)');
  var ov = function (a, c) { return !(a.r <= c.l || a.l >= c.r || a.b <= c.t || a.t >= c.b); };
  ok(s.ctrls.length > 0 && s.ctrls.every(function (c) { return !ov(s.chase, c); }), 'chip does not overlap STOP / PAUSE / START', s.ctrls.length + ' controls');
  ok(!(s.chase.l < 110 && s.chase.t < 110) && s.chase.b <= s.vh - 80 && s.chase.r <= s.vw && s.chase.l >= 0, 'chip clear of the top-left 110x110, the bottom 80 px strip and the edges', JSON.stringify({ l: s.chase.l | 0, t: s.chase.t | 0, r: s.chase.r | 0, b: s.chase.b | 0 }));
  ok(s.hud.w > 0 && s.hud.r <= s.vw + 1, 'HUD bar stays inside 1920 px', Math.round(s.hud.r));

  // ── 3. oval marker
  await page.evaluate(function () { App.setMapStyle('oval'); }); await sleep(1500);
  var o = await page.evaluate(function () {
    var c = OvalTrack._chase, cv = document.getElementById('ovalTrackCanvas'), pt = c ? OvalTrack._fracToPoint(c.fraction) : null, px = null;
    if (pt) { var g = cv.getContext('2d'), k = cv.width / cv.getBoundingClientRect().width, d = g.getImageData(Math.round(pt.x * k) - 2, Math.round(pt.y * k) - 2, 5, 5).data; px = [d[0], d[1], d[2], d[3]]; }
    return { chase: c, px: px, shown: cv.style.display !== 'none' };
  });
  ok(o.chase && o.chase.fraction > 0 && /AHEAD|BEHIND|ON PACE/.test(o.chase.text), 'oval track received the chase target', JSON.stringify(o.chase));
  ok(o.px && o.px[3] > 0 && o.px[2] > o.px[1] && o.px[0] > 100, 'purple target marker drawn at the target position on the oval', JSON.stringify(o.px));

  // ── 4. numbers view: the stage bar (with the chip) sits above every view; track view gets a TARGET runner
  await page.evaluate(function () { App.setMapStyle('numbers'); }); await sleep(1200);
  var nv = await page.evaluate(function () { var e = document.getElementById('whChase'); return { shown: e.offsetWidth > 0, t: document.getElementById('whChaseLbl').textContent }; });
  ok(nv.shown && /^CHASING: your run of /.test(nv.t), 'numbers view: CHASING chip + gap still shown in the stage bar', nv.t);
  var wiring = require('fs').readFileSync(path.resolve(__dirname, '../js/app.js'), 'utf8');
  ok(/source: 'chase'/.test(wiring) && /RunAgain\.chaseInfo/.test(wiring), 'track view (routes only) is fed a TARGET runner via TrackView.setGhosts (wiring check; not driven live: needs a route)');

  // ── 5. a stopped / non-Run-Again workout shows no chip
  await page.evaluate(function () { App.finishRun(true); }); await sleep(900);
  var after = await page.evaluate(function () { UI.update(); var e = document.getElementById('whChase'); return { shown: !!e.offsetWidth, seg: !!WorkoutSegments.active, st: Engine.run && Engine.run.status }; });
  after = !after.shown;
  ok(after, 'no CHASING chip once the run is stopped');

  // ── 6. layout: gap always fully visible inside the bar (date / long name, 1920 and half 960, oval + numbers)
  var shotDir = process.env.CHASE_SHOTS || '/tmp';
  var cases = [
    { tag: 'full-date', w: 1920, half: false, name: 'Loop', date: '2026-10-20T10:00:00Z' },
    { tag: 'full-longname', w: 1920, half: false, name: 'An extremely long route name that goes on and on and on forever and ever', date: null },
    { tag: 'half-date', w: 960, half: true, name: 'Loop', date: '2026-10-20T10:00:00Z' },
    { tag: 'half-longname', w: 960, half: true, name: 'An extremely long route name that goes on and on and on forever and ever', date: null }
  ];
  for (var ci = 0; ci < cases.length; ci++) {
    var cs = cases[ci];
    var pg = await (await b.newContext({ viewport: { width: cs.w, height: 1000 } })).newPage(); pg.setDefaultTimeout(8000);
    pg.on('dialog', function (d) { d.accept(); });
    await pg.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
    try { await fetch('http://' + BR + '/mock/reset', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {}
    await pg.goto(UI + '?bridge=' + BR); await pg.evaluate(function () { localStorage.clear(); }); await pg.goto(UI + '?bridge=' + BR); await sleep(1500);
    await pg.evaluate(function (c) {
      var pts = [], d = 0;
      for (var t = 0; t <= 300; t += 5) { var sp = t < 100 ? 8 : 10; d += sp / 3.6 * 5; pts.push({ elapsed: t, dist: Math.round(d), speed: sp, hr: 130, ele: 0, incline: 0 }); }
      var run = { id: 'run_l', routeName: c.name, routeId: null, startedAt: c.date, elapsed: 300, distanceM: Math.round(d), trackPoints: pts };
      App.armWorkout(RunAgain.save(RunAgain.build(RunAgain.fromRun(run), { pct: 5, basis: 'time', wrap: false })));
      if (c.half) document.getElementById('rootApp').classList.add('half');
    }, cs);
    await sleep(700); await pg.evaluate(function () { App.startRun(); }); await sleep(7000);
    for (var vi = 0; vi < 2; vi++) {
      var view = vi ? 'numbers' : 'oval';
      await pg.evaluate(function (v) { App.setMapStyle(v); }, view); await sleep(1200);
      var L = await pg.evaluate(function () {
        var r = function (e) { var b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width }; };
        var hud = document.getElementById('workoutHud'), lb = document.getElementById('whChaseLbl'), gp = document.getElementById('whChaseGap');
        return { hud: r(hud), lbl: r(lb), gap: r(gp), lt: lb.textContent, gt: gp.textContent, gapClipped: gp.scrollWidth > gp.clientWidth + 1 };
      });
      var inside = L.gap.l >= L.hud.l && L.gap.r <= L.hud.r + 0.5 && L.lbl.r <= L.hud.r + 0.5 && L.gap.w > 20;
      ok(inside && !L.gapClipped && /AHEAD|BEHIND|ON PACE/.test(L.gt), cs.tag + '/' + view + ': gap fully visible inside the bar', JSON.stringify({ hudR: Math.round(L.hud.r), gapL: Math.round(L.gap.l), gapR: Math.round(L.gap.r), lbl: L.lt }));
      if (cs.half) ok(L.lt === 'CHASING +5%', cs.tag + '/' + view + ': half layout uses the short label', L.lt);
      if (!cs.date) ok(L.lt.length <= 'CHASING: your run (' .length + 24 + ' +5%'.length + 1, cs.tag + '/' + view + ': long source name truncated in the label', L.lt);
      await pg.screenshot({ path: shotDir + '/chase-' + cs.tag + '-' + view + '.png' });
    }
    await pg.evaluate(function () { App.finishRun(true); }); await pg.context().close();
  }
  ok(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
  await b.close();
  console.log('\n' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error('FATAL', e); process.exit(2); });
