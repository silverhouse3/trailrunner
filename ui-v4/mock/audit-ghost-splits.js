#!/usr/bin/env node
// Audit part 2 (mocks only, own ports): ghost race on a route with real trackPoints, per-km split comparison on
// a ROUTE run summary (comparison is deliberately hidden for Free Run), bridge-down banner with WebSocket fallback disabled.
//   node mock/audit-ghost-splits.js [safeBottom]
'use strict';
var path = require('path'), fs = require('fs');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UI = process.env.AUDIT_UI || 'http://localhost:8199/', TM = process.env.AUDIT_TM || 'http://localhost:4610', SV = 'localhost:8198';
var SAFE = process.argv[2] === '80';
var Q = 'bridge=' + TM.replace('http://', '') + '&strava=' + SV + (SAFE ? '&safeBottom=80' : '');
var SHOTS = process.env.AUDIT_SHOTS || '';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function rec(id, ok, obs) { console.log((ok === true ? 'PASS  ' : ok === false ? 'FAIL  ' : 'INFO  ') + id + '  -> ' + obs); }
(async function () {
  var b = await pw.chromium.launch(); var ctx = await b.newContext({ viewport: { width: 1920, height: SAFE ? 1080 : 1000 } });
  await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  var page = await ctx.newPage(); page.setDefaultTimeout(8000);
  page.on('dialog', function (d) { d.accept(); });
  var ev = function (f, a) { return page.evaluate(f, a); };
  async function shot(n) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'audit-' + (SAFE ? 's80-' : '') + n + '.png') }); }
  await jpost(TM + '/mock/reset');
  await page.goto(UI + '?demo=route&' + Q); await ev(function () { localStorage.clear(); }); await page.goto(UI + '?demo=route&' + Q); await sleep(2500);
  // seed demo runs on the active route
  await page.goto(UI + 'stats.html?demo=1&' + Q); await sleep(2000);
  var n = await ev(function () { var rs = JSON.parse(localStorage.getItem('tr_runs') || '[]'); return rs.length + '/' + rs.filter(function (r) { return r.routeId; }).length; });
  rec('S0 demo seeded (all/on-route)', true, n);
  await page.goto(UI + '?' + Q); await sleep(2000);
  var hasRoute = await ev(function () { return Engine.hasRoute(); });
  if (!hasRoute) await ev(function () { var r = Store.getRoutes()[0]; App.selectRoute(r.id); });
  await ev(function () { App.runRoute(); }); await sleep(1200);
  // --- ghost: pick a past on-route run that has trackPoints
  await ev(function () { App.openHistory(); }); await sleep(600);
  var rows = await ev(function () { return document.querySelectorAll('#historyList > *').length; });
  var ghostable = await ev(function () { return Store.getRuns().filter(function (r) { return r.trackPoints && r.trackPoints.length; }).length; });
  var gid = await ev(function () { var r = Store.getRuns().filter(function (r) { return r.trackPoints && r.trackPoints.length && r.routeId; })[0]; return r ? r.id : null; });
  rec('GH1 history rows / runs with trackPoints', true, rows + ' / ' + ghostable);
  if (gid) {
    await ev(function (id) { App.loadGhost(id); }, gid);
    await page.click('#fcStart'); await sleep(1500);
    await ev(function () { App.adjustSpeed(6); }); await sleep(9000);
    var g = await ev(function () { return { ghost: !!Engine.ghost, en: Engine.ghostEnabled, gdist: Engine.ghost ? Math.round(Engine.ghost.distanceM) : null, rundist: Math.round(Engine.run.distanceM), delta: (document.getElementById('ghostDelta') || {}).textContent, panelDisplay: (document.getElementById('ghostPanel') || {}).style ? document.getElementById('ghostPanel').style.display : null, chip: (document.querySelector('.sv-ghost, .sv-chip, .ghost-chip') || {}).textContent || null, txtAhead: /AHEAD|BEHIND|ahead|behind/.test(document.body.innerText) }; });
    await shot('22-ghost-run');
    rec('GH2 ghost loaded & ticking during run', g.ghost && g.en, JSON.stringify(g));
  } else rec('GH2 ghost', false, 'no seeded on-route run with trackPoints');
  // --- split comparison on a ROUTE run
  await ev(function () { Engine.run.distanceM = 2400; Engine.run.elapsed = 760; }); await sleep(2500);
  await ev(function () { App.finishRun(); }); await sleep(1500); await shot('23-summary-route-splits');
  var c = await ev(function () { var el = document.getElementById('fComparison'); var sp = document.getElementById('fSplits'); return { cmpLen: el ? el.innerHTML.length : -1, cmpDisp: el ? el.style.display : null, splitsLen: sp ? sp.innerHTML.length : -1, sc: !!document.querySelector('#finishOverlay .sc-head, #finishOverlay .sc-chart, #finishOverlay .sc-table'), splitsN: Engine.run.splits.length, txt: (sp ? sp.innerText : '').slice(0, 140) }; });
  rec('SP1 route-run summary shows per-km comparison (sc-* block)', c.sc, JSON.stringify(c));
  // --- bridge down with WS fallback disabled
  var p2 = await ctx.newPage(); p2.setDefaultTimeout(8000);
  await p2.addInitScript(function () { window.WebSocket = function () { throw new Error('ws blocked by audit'); }; });
  await p2.goto(UI + '?bridge=localhost:4699&strava=' + SV + (SAFE ? '&safeBottom=80' : '')); await sleep(12000);
  await p2.click('.tile-free'); await sleep(800);
  var d = await p2.evaluate(function () { return { pill: document.getElementById('pillTM') ? document.getElementById('pillTM').className + '|' + document.getElementById('pillTM').textContent.trim() : null, banner: document.getElementById('stateBannerText').textContent, startVis: !!document.getElementById('fcStart').offsetWidth, connected: TM.connected }; });
  if (SHOTS) await p2.screenshot({ path: path.join(SHOTS, 'audit-' + (SAFE ? 's80-' : '') + '24-bridge-down.png') });
  rec('BD1 bridge down: pill/banner', undefined, JSON.stringify(d));
  await p2.click('#fcStart').catch(function () {}); await sleep(2500);
  var e = await p2.evaluate(function () { return { status: Engine.run && Engine.run.status, banner: document.getElementById('stateBannerText').textContent, toasts: [].slice.call(document.querySelectorAll('.toast, #toast, [id*=oast]')).map(function (x) { return x.textContent.trim(); }).filter(Boolean) }; });
  rec('BD2 START tapped with bridge down', undefined, JSON.stringify(e));
  await b.close();
})().catch(function (e) { console.error('FATAL', e); process.exit(2); });
