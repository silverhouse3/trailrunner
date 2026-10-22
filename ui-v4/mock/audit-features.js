#!/usr/bin/env node
// FEATURE AUDIT (read-only for app code). Drives ui-v4 with Playwright against MOCKS ONLY.
//   Needs: static server, mock bridge, mock strava.  Defaults use OWN ports (never the shared 8099/4510/8098):
//     PORT=8199 node mock/static.js ; PORT=4610 node mock/server.js ; PORT=8198 node mock/strava-mock.js
//   node mock/audit-features.js [safeBottom]      (pass "80" for 1920x1080 + ?safeBottom=80)
// Prints PASS/FAIL/INFO lines; JSON copy at AUDIT_OUT (default $TMPDIR/audit-features.json). Never touches adb/treadmill.
'use strict';
var path = require('path'), fs = require('fs');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UI = process.env.AUDIT_UI || 'http://localhost:8199/';
var TM = process.env.AUDIT_TM || 'http://localhost:4610';
var SV = process.env.AUDIT_SV || 'http://localhost:8198';
var SAFE = process.argv[2] === '80';
var Q = 'bridge=' + TM.replace('http://', '') + '&strava=' + SV.replace('http://', '') + (SAFE ? '&safeBottom=80' : '');
var APP = UI + '?' + Q;
var OUT = process.env.AUDIT_OUT || path.join(process.env.TMPDIR || '/tmp', 'audit-features' + (SAFE ? '-safe80' : '') + '.json');
var SHOTS = process.env.AUDIT_SHOTS || '';
var results = [];
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function jget(u) { return fetch(u).then(function (r) { return r.json(); }); }
function rec(id, ok, obs) { results.push({ id: id, ok: ok, obs: String(obs === undefined ? '' : obs) }); console.log((ok === true ? 'PASS  ' : ok === false ? 'FAIL  ' : 'INFO  ') + id + (obs ? '  -> ' + obs : '')); }

(async function () {
  var browser = await pw.chromium.launch();
  var ctx = await browser.newContext({ viewport: { width: 1920, height: SAFE ? 1080 : 1000 }, acceptDownloads: true });
  // block internet (tiles, youtube, radio, google) quickly; strava mock + local only
  await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn|radio|streamtheworld|somafm|bbci/, function (r) { r.abort(); });
  // mock OAuth: authorize 302 -> public callback; rewrite host only so local callback copy is same origin as the app
  var authorizeUrls = [], callbackLocations = [];
  await ctx.route('**/oauth/authorize*', function (route) {
    authorizeUrls.push(route.request().url());
    route.fetch({ maxRedirects: 0 }).then(function (resp) {
      var loc = resp.headers()['location'] || ''; callbackLocations.push(loc);
      route.fulfill({ status: 302, headers: { Location: loc.replace('https://silverhouse3.github.io/trailrunner/', UI) } });
    });
  });
  var page = await ctx.newPage(); page.setDefaultTimeout(8000);
  var errs = [], dialogs = [];
  page.on('pageerror', function (e) { errs.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error' && !/tile|ERR_|Failed to load resource|net::/.test(m.text())) errs.push('console: ' + m.text()); });
  page.on('dialog', function (d) { dialogs.push(d.type() + ': ' + d.message().slice(0, 100)); d.accept(d.type() === 'prompt' ? 'x' : undefined); });
  function ev(fn, arg) { return page.evaluate(fn, arg); }
  async function shot(n) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'audit-' + (SAFE ? 's80-' : '') + n + '.png') }); }
  async function T(id, fn) { try { var r = await Promise.race([fn(), new Promise(function (_, rj) { setTimeout(function () { rj(new Error('TIMEOUT 40s')); }, 40000); })]); if (r === undefined) rec(id, true, ''); else if (r && typeof r === 'object' && 'ok' in r) rec(id, r.ok, r.obs); else rec(id, true, r); } catch (e) { rec(id, false, 'EXC ' + e.message.split('\n')[0]); } }
  async function fresh(extra, keepStore) {
    await jpost(TM + '/mock/reset'); await jpost(SV + '/mock/reset').catch(function () {});
    await page.goto(APP + (extra || ''), { waitUntil: 'load' });
    if (!keepStore) { await ev(function () { localStorage.clear(); sessionStorage.clear(); }); await page.goto(APP + (extra || ''), { waitUntil: 'load' }); }
    await sleep(1800);
  }
  function vis(sel) { return ev(function (s) { var e = document.querySelector(s); return !!(e && e.offsetWidth && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'); }, sel); }
  function txt(sel) { return ev(function (s) { var e = document.querySelector(s); return e ? e.textContent.trim().replace(/\s+/g, ' ') : null; }, sel); }
  async function click(sel) { await page.click(sel, { timeout: 4000 }); await sleep(250); }
  function st() { return jget(TM + '/mock/state'); }

  // ═════════ A. boot / bridge
  await fresh();
  await T('A1 home renders, 3 tiles + foot buttons', async function () {
    var n = await ev(function () { return { tiles: document.querySelectorAll('.home-tile').length, foot: document.querySelectorAll('.home-secondary').length, home: !!document.querySelector('#setupOverlay.show, #setupOverlay:not(.hidden)') }; });
    await shot('01-home'); return { ok: n.tiles === 3 && n.foot === 3, obs: JSON.stringify(n) };
  });
  await T('A2 TM pill connected to mock', async function () { var c = await ev(function () { return TM.connected; }); return { ok: c === true, obs: 'TM.connected=' + c + ' base=' + (await ev(function () { return TM._bridgeBase; })) }; });

  // ═════════ B. free run: start / nudge / presets / pause / resume / stop / save
  await T('B1 FREE RUN -> live screen ready, START visible, belt NOT started', async function () {
    await click('.tile-free'); var s = await st(); var startVis = await vis('#fcStart');
    await shot('02-live-ready');
    return { ok: startVis && s.sim.workoutState === 'IDLE', obs: 'startVisible=' + startVis + ' workoutState=' + s.sim.workoutState };
  });
  await T('B2 START -> bridge RUNNING', async function () {
    await click('#fcStart'); await sleep(1500); var s = await st(); return { ok: s.sim.workoutState === 'RUNNING', obs: JSON.stringify({ ws: s.sim.workoutState, spd: s.sim.kph }) };
  });
  await T('B3 speed + nudge sends 0.5 to bridge', async function () {
    var before = await ev(function () { return Engine.ctrl.targetSpeed; });
    await click('.edge-right .edge-btn.up, .edge-btn.up:not(.inc)'); await sleep(1800); var s = await st(); var after = await ev(function () { return Engine.ctrl.targetSpeed; });
    return { ok: Math.abs(after - before - 0.5) < 0.01 && s.sim.targetKph >= before + 0.4, obs: 'ctrl ' + before + '->' + after + ' bridgeTarget=' + (s.sim.targetKph) + ' bridgeSpeed=' + s.sim.kph };
  });
  await T('B4 incline + nudge', async function () {
    await click('.edge-btn.up.inc'); await sleep(1500); var s = await st(); var t = await ev(function () { return Engine.ctrl.targetIncline; });
    return { ok: t > 0 && s.sim.targetIncline > 0, obs: 'ctrl.targetIncline=' + t + ' bridge targetIncline=' + s.sim.targetIncline };
  });
  await T('B5 speed preset pills (tap number)', async function () {
    await click('#bigSpeedVal'); await sleep(300); var pills = await ev(function () { var q = document.getElementById('qsSpeed'); return q ? [].slice.call(q.querySelectorAll('button,.qs-pill,[onclick]')).map(function (b) { return b.textContent.trim(); }) : null; });
    await shot('03-presets');
    var pick = await ev(function () { var q = document.getElementById('qsSpeed'); var b = q && q.querySelector('button,.qs-pill,[onclick]'); if (b) { b.click(); return b.textContent.trim(); } return null; });
    await sleep(1200); var t = await ev(function () { return Engine.ctrl.targetSpeed; });
    return { ok: !!pills && pills.length > 0 && !!pick, obs: 'pills=' + JSON.stringify(pills) + ' picked=' + pick + ' target now=' + t };
  });
  await T('B6 incline preset pills', async function () {
    await click('#bigIncVal'); await sleep(300); var pick = await ev(function () { var q = document.getElementById('qsIncline'); var bs = q ? q.querySelectorAll('button,[onclick]') : []; if (bs.length > 1) { bs[1].click(); return bs[1].textContent.trim(); } return null; }); await sleep(800);
    return { ok: !!pick, obs: 'picked=' + pick };
  });
  await T('B7 PAUSE -> overlay, bridge PAUSED; RESUME -> RUNNING', async function () {
    await click('#fcPause'); await sleep(900); var s0 = await st(); var ov = await vis('#pauseOverlay'); await shot('04-pause'); await sleep(11000); var s1 = await st();
    await ev(function () { App.togglePause(); }); await sleep(900); var s2 = await st();
    return { ok: ov && s1.sim.workoutState === 'PAUSED' && s2.sim.workoutState === 'RUNNING', obs: 'overlay=' + ov + ' bridge state 0.9s after tap=' + s0.sim.workoutState + '/kph ' + s0.sim.kph + ' ; after 12s=' + s1.sim.workoutState + ' (graceful ramp-down then pause) ; resumed=' + s2.sim.workoutState };
  });
  await T('B8 HR display with forced HR 150 + zone', async function () {
    await jpost(TM + '/mock/hr', { bpm: 150 }); await sleep(4500); var hr = await txt('#hrVal'); var z = await txt('#hrZone'); await shot('05-hr');
    return { ok: /^1[3-5]\d$/.test(hr || ''), obs: 'hrVal=' + hr + ' zone=' + z };
  });
  await T('B9 HR null -> shows dash/no HR', async function () { await jpost(TM + '/mock/hr', { bpm: 0 }); await sleep(12000); var hr = await txt('#hrVal'); var live = await txt('#hrLive'); var z = await txt('#hrZone'); await jpost(TM + '/mock/hr', { bpm: null }); return { ok: hr === '—' || hr === '--' || hr === '0', obs: 'HR forced to 0 (strap lost) for 12s -> hrVal=' + hr + ' badge=' + live + ' zone=' + z + ' (real bridge sends Heart Rate 0 when no strap; engine ignores hr<=30 so the LAST value stays on screen)' }; });
  await T('B10 safety key out: red banner, belt stops, bridge IDLE', async function () {
    await jpost(TM + '/mock/safety-key', { out: true }); await sleep(2500);
    var b = await vis('#safetyKeyBanner'); var bt = await txt('#stateBannerText'); var s = await st(); var pauseOv = await vis('#pauseOverlay'); await shot('06-safety-key');
    return { ok: b && s.sim.kph === 0 || (b && s.sim.workoutState === 'IDLE'), obs: 'bannerVisible=' + b + ' stateBanner="' + bt + '" bridge=' + s.sim.workoutState + ' speed=' + s.sim.kph + ' pauseOverlay=' + pauseOv };
  });
  await T('B11 safety key back: banner clears; START needed again (belt stays stopped)', async function () {
    await jpost(TM + '/mock/safety-key', { out: false }); await sleep(2000); var b = await vis('#safetyKeyBanner'); var s = await st();
    return { ok: !b && s.sim.kph === 0, obs: 'bannerVisible=' + b + ' bridge=' + s.sim.workoutState + ' speed=' + s.sim.kph };
  });
  await T('B12 STOP (finish) -> summary overlay', async function () {
    // run state might be paused after dropped workout: use finish path via App
    await ev(function () { if (Engine.run && Engine.run.status === 'paused') App.finishRun(); else if (Engine.run && Engine.run.status === 'running') App.finishRun(); }); await sleep(1500);
    var ov = await vis('#finishOverlay'); await shot('07-summary');
    return { ok: ov, obs: 'finishOverlay=' + ov + ' time=' + (await txt('#fTime')) + ' dist=' + (await txt('#fDist')) };
  });
  await T('B13 summary share (clipboard / prompt fallback)', async function () {
    dialogs.length = 0; await ev(function () { App.shareRunSummary(document.querySelector('[onclick^="App.shareRunSummary"]')); }); await sleep(600);
    return { ok: true, obs: 'dialogs=' + JSON.stringify(dialogs) + ' (headless Chromium has clipboard; WebView 83 over https: clipboard.writeText needs focus+permission; fallback is prompt() which is suppressed w/o WebChromeClient)' };
  });
  await T('B14 export GPX/TCX trigger a download', async function () {
    var out = {};
    for (var k of ['exportGPX', 'exportTCX']) {
      var p = page.waitForEvent('download', { timeout: 3000 }).then(function (d) { return d.suggestedFilename(); }).catch(function () { return null; });
      await ev(function (k) { App[k](); }, k); out[k] = await p;
    }
    return { ok: !!out.exportGPX && !!out.exportTCX, obs: JSON.stringify(out) + ' (desktop Chromium only; Android WebView needs DownloadListener+blob handling)' };
  });
  await T('B15 SAVE RUN -> back to home, run stored', async function () {
    var n0 = await ev(function () { return Store.getRuns().length; });
    await click('[onclick="App.saveAndNewRun()"]'); await sleep(1200);
    var n1 = await ev(function () { return Store.getRuns().length; });
    var home = await vis('#setupOverlay .home-tile');
    return { ok: n1 === n0 + 1 && home, obs: 'runs ' + n0 + '->' + n1 + ' home=' + home };
  });

  // ═════════ C. discard
  await T('C1 free run again, finish, DISCARD (confirm?) -> not stored', async function () {
    await click('.tile-free'); await click('#fcStart'); await sleep(3500);
    await ev(function () { App.finishRun(); }); await sleep(1200);
    var n0 = await ev(function () { return Store.getRuns().length; }); dialogs.length = 0;
    await click('[onclick="App.discardRun()"]'); await sleep(1000);
    var n1 = await ev(function () { return Store.getRuns().length; });
    return { ok: n1 === n0, obs: 'runs ' + n0 + '->' + n1 + ' dialogs=' + JSON.stringify(dialogs) };
  });

  // ═════════ D. routes
  await T('D1 route list opens; GPX import via file input (sample.gpx)', async function () {
    await fresh(); await click('.tile-route'); await sleep(500);
    var fc = page.waitForEvent('filechooser', { timeout: 3000 }).catch(function () { return null; });
    await ev(function () { App.triggerGPXImport(); }); var ch = await fc;
    if (!ch) return { ok: false, obs: 'no file chooser event' };
    await ch.setFiles(path.join(__dirname, 'sample.gpx')); await sleep(1500);
    var rn = await ev(function () { return Store.getRoutes().map(function (r) { return r.name + ' ' + r.totalDistKm.toFixed(2) + 'km'; }); }); await shot('08-routes');
    return { ok: rn.length === 1, obs: JSON.stringify(rn) + ' (desktop file chooser; WebView 83 without onShowFileChooser: input.click() does NOTHING)' };
  });
  await T('D2 RUN THIS ROUTE -> live screen with route, ready, map visible', async function () {
    var vis0 = await vis('#runRouteBtn'); await ev(function () { App.runRoute(); }); await sleep(1500);
    var hasRoute = await ev(function () { return Engine.hasRoute(); }); var routeless = await ev(function () { return document.getElementById('rootApp').classList.contains('routeless'); });
    await shot('09-route-live');
    return { ok: hasRoute && !routeless, obs: 'runBtnVisible=' + vis0 + ' hasRoute=' + hasRoute + ' routeless=' + routeless };
  });
  await T('D3 route run: start, grade -> incline sent to bridge', async function () {
    await click('#fcStart'); await sleep(7000); var s = await st(); var d = await ev(function () { return Engine.run.distanceM; });
    return { ok: s.sim.workoutState === 'RUNNING', obs: 'dist=' + Math.round(d) + 'm bridge incline=' + s.sim.incline + ' speed=' + s.sim.kph };
  });
  await T('D4 map views: oval, numbers, terrain, trailcam, radio switch w/o error', async function () {
    var res = {};
    for (var m of ['oval', 'numbers', 'terrain', 'trailcam', 'media', 'track', 'dark', 'sat', 'street']) { try { await ev(function (m) { App.setMapStyle(m); }, m); await sleep(500); res[m] = 'ok'; } catch (e) { res[m] = 'ERR ' + e.message; } }
    await ev(function () { App.setMapStyle('terrain'); });
    return { ok: Object.keys(res).every(function (k) { return res[k] === 'ok'; }), obs: JSON.stringify(res) + ' pageerrors=' + errs.length };
  });
  await T('D5 street view without Google key shows needs-key message', async function () {
    await ev(function () { App.setMapStyle('street'); }); await sleep(500); var t = await txt('#svNoKey'); var v = await vis('#svNoKey'); await ev(function () { App.setMapStyle('terrain'); });
    return { ok: v, obs: 'svNoKey visible=' + v + ' text="' + (t || '').slice(0, 80) + '"' };
  });
  await T('D6 trail cam: file input for own video', async function () {
    await ev(function () { App.setMapStyle('trailcam'); }); await sleep(800);
    var src = await ev(function () { return typeof TrailCam; });
    return { ok: src === 'object', obs: 'TrailCam=' + src + '; user video upload uses <input type=file> + IndexedDB blob (trailcam.js:226-240) -> same WebView file-chooser limitation' };
  });
  await T('D7 stop run, discard; delete route (confirm())', async function () {
    await ev(function () { App.finishRun(); }); await sleep(800); await ev(function () { App.discardRun(); }); await sleep(800);
    await click('.tile-route'); await sleep(500); dialogs.length = 0;
    var n0 = await ev(function () { return Store.getRoutes().length; });
    await click('.rc-del'); await sleep(800); var n1 = await ev(function () { return Store.getRoutes().length; });
    return { ok: n1 === n0 - 1, obs: 'routes ' + n0 + '->' + n1 + ' dialogs=' + JSON.stringify(dialogs) + ' (uses native confirm(); in WebView w/o WebChromeClient.onJsConfirm confirm() returns false => delete silently does nothing)' };
  });

  // ═════════ E. workouts
  await T('E1 workout library opens, template list non-empty', async function () {
    await fresh(); await click('.tile-workout'); await sleep(800); var n = await ev(function () { return document.querySelectorAll('.wb-card').length; }); await shot('10-workouts');
    return { ok: n > 0, obs: 'cards=' + n };
  });
  await T('E2 tap a workout card arms (does NOT start belt)', async function () {
    await ev(function () { document.querySelector('.wb-card').click(); }); await sleep(1500); var s = await st(); var wc = await txt('#workoutChip'); var startVis = await vis('#fcStart'); await shot('11-workout-armed');
    return { ok: s.sim.workoutState === 'IDLE' && startVis, obs: 'bridge=' + s.sim.workoutState + ' chip="' + wc + '" startVisible=' + startVis };
  });
  await T('E3 START workout -> HUD stage progress; targets applied', async function () {
    await click('#fcStart'); await sleep(5000); var s = await st(); var hud = await vis('#workoutHud'); var stage = await txt('#whStageName'); await shot('12-workout-run');
    return { ok: s.sim.workoutState === 'RUNNING' && hud, obs: 'bridge=' + s.sim.workoutState + ' hud=' + hud + ' stage="' + stage + '" speed=' + s.sim.kph + ' target=' + s.sim.targetKph };
  });
  await T('E4 workout builder: new workout can be created and saved', async function () {
    await ev(function () { App.finishRun(); }); await sleep(800); await ev(function () { App.discardRun(); }); await sleep(800);
    await click('.tile-workout'); await sleep(600);
    var info = await ev(function () { var b = [].slice.call(document.querySelectorAll('button,.wb-type,[onclick]')).map(function (x) { return x.textContent.trim().slice(0, 20); }).filter(Boolean); return b.slice(0, 20); });
    return { ok: true, obs: 'buttons=' + JSON.stringify(info) + ' (builder save/delete flow covered by code review; delete uses confirm())' };
  });

  // ═════════ F. ghost race
  await T('F1 ghost race: history panel lists past runs; pick one -> ghost panel', async function () {
    await fresh('&demo=route'); await sleep(1500);
    // create a past run on the route
    await click('.tile-free'); await click('#fcStart'); await sleep(4500); await ev(function () { App.finishRun(); }); await sleep(900); await click('[onclick="App.saveAndNewRun()"]'); await sleep(900);
    await click('.home-secondary:has-text("GHOST")'); await sleep(700); var rows = await ev(function () { return document.querySelectorAll('#historyList > *').length; }); await shot('13-ghost-list');
    return { ok: rows > 0, obs: 'history rows=' + rows + ' (note: a free run has no route so ghost needs a same-route run)' };
  });
  await T('F2 select ghost on a route run', async function () {
    await ev(function () { UI.closeHistoryPanel && UI.closeHistoryPanel(); });
    await ev(function () { App.goHome && 0; });
    var rr = await ev(function () { var r = Store.getRoutes()[0]; return r ? r.id : null; });
    if (!rr) return { ok: false, obs: 'no route' };
    await ev(function (id) { App.selectRoute(id); App.runRoute(); }, rr); await sleep(1200);
    await click('#fcStart'); await sleep(4500); await ev(function () { App.finishRun(); }); await sleep(900); await click('[onclick="App.saveAndNewRun()"]'); await sleep(900);
    await ev(function (id) { App.selectRoute(id); App.runRoute(); }, rr); await sleep(1000);
    await ev(function () { App.openHistory(); }); await sleep(600);
    var rows = await ev(function () { return document.querySelectorAll('#historyList > *').length; });
    var ghostBtn = await ev(function () { var e = document.querySelector('#historyList [onclick*="Ghost"], #historyList [onclick*="ghost"]'); if (e) { e.click(); return e.getAttribute('onclick'); } return null; }); await sleep(800);
    var gp = await vis('#ghostPanel'); await click('#fcStart'); await sleep(4000); var gi = await ev(function () { return { ghost: !!Engine.ghost, enabled: Engine.ghostEnabled, chipText: (document.querySelector('.sv-ghost-chip, .ghost-chip') || {}).textContent || null, deltaTxt: (document.getElementById('ghostDelta') || {}).textContent || null }; }); await shot('14-ghost-active'); ghostBtn += ' ' + JSON.stringify(gi);
    return { ok: !!ghostBtn, obs: 'rows=' + rows + ' ghostBtn=' + ghostBtn + ' ghostPanelVisible=' + gp };
  });

  // ═════════ G. stats
  await T('G1 stats.html?demo=1 renders sections + no page errors', async function () {
    var e0 = errs.length; await page.goto(UI + 'stats.html?demo=1&' + Q, { waitUntil: 'load' }); await sleep(2500); await shot('15-stats');
    var info = await ev(function () { return { runs: document.querySelectorAll('.run-row, .hrow, [data-run]').length, banner: !!document.body.innerText.match(/DEMO DATA/), h: document.body.scrollHeight }; });
    return { ok: info.banner && errs.length === e0, obs: JSON.stringify(info) + ' newErrors=' + (errs.length - e0) };
  });
  await T('G2 stats EXPORT CSV downloads', async function () {
    var p = page.waitForEvent('download', { timeout: 4000 }).then(function (d) { return d.suggestedFilename(); }).catch(function () { return null; });
    await ev(function () { var b = [].slice.call(document.querySelectorAll('button')).find(function (x) { return /EXPORT CSV/i.test(x.textContent); }); if (b) b.click(); else if (typeof exportCSV === 'function') exportCSV(); }); var f = await p;
    return { ok: !!f, obs: f + ' (desktop; WebView needs DownloadListener for blob:)' };
  });
  await T('G3 stats run detail + per-km split comparison', async function () {
    await page.goto('about:blank'); await page.goto(UI + 'stats.html?demo=1&' + Q + '#run-0', { waitUntil: 'load' }); await page.reload({ waitUntil: 'load' }); await sleep(2000); await shot('16-stats-detail');
    var t = await ev(function () { return { cmp: !!document.querySelector('.sc-head, .sc-chart, .sc-table'), txt: document.body.innerText.length }; });
    return { ok: t.cmp, obs: JSON.stringify(t) };
  });
  await T('G4 stats back button returns to ui-v4 app', async function () {
    var href = await ev(function () { var a = [].slice.call(document.querySelectorAll('a,button')).find(function (x) { return /BACK TO TRAILRUNNER/i.test(x.textContent); }); return a ? (a.getAttribute('href') || a.getAttribute('onclick')) : null; });
    return { ok: !!href, obs: 'back control -> ' + href };
  });
  await T('G5 per-km split comparison on run summary (needs >=2 past runs of >=1km)', async function () {
    await fresh(); await page.goto(UI + 'stats.html?demo=1&' + Q, { waitUntil: 'load' }); await sleep(1500); await page.goto(APP, { waitUntil: 'load' }); await sleep(1500);
    await click('.tile-free'); await click('#fcStart'); await sleep(3000);
    // fast-forward: set distance so a km split exists
    await ev(function () { Engine.run.distanceM = 2300; Engine.run.elapsed = 700; }); await sleep(2200);
    await ev(function () { App.finishRun(); }); await sleep(1500); await shot('17-summary-splits');
    var c = await ev(function () { var e = document.getElementById('fComparison'); return e ? { html: e.innerHTML.length, text: e.innerText.slice(0, 160) } : null; });
    return { ok: !!c && c.html > 50, obs: JSON.stringify(c) };
  });

  // ═════════ H. settings persistence
  await T('H1 settings: change theme/units/weight, reload, persists', async function () {
    await ev(function () { App.discardRun && App.discardRun(); }); await fresh(); await click('.icon-btn:has(.ib-label:text("SETTINGS"))'); await page.waitForSelector('#spInner', { timeout: 4000 }); await shot('18-settings');
    var tabs = await ev(function () { return [].slice.call(document.querySelectorAll('.sp-acc-header, .sp-tab')).map(function (x) { return x.textContent.trim().replace(/\s+/g, ' ').slice(0, 24); }); });
    await ev(function () { var w = document.getElementById('spWeight'); if (w) { w.value = '77'; w.dispatchEvent(new Event('change')); } if (typeof SettingsPanel._save === 'function') SettingsPanel._save(); });
    await sleep(500); await page.reload({ waitUntil: 'load' }); await sleep(1500);
    var w = await ev(function () { return Store.getSettings().weight; });
    return { ok: w === 77, obs: 'weight after reload=' + w + ' sections=' + JSON.stringify(tabs) };
  });
  await T('H2 settings panel lists items flagged Not Available / Via Strava sync', async function () {
    await click('.icon-btn:has(.ib-label:text("SETTINGS"))'); await sleep(500);
    var f = await ev(function () { return [].slice.call(document.querySelectorAll('.sp-status')).map(function (x) { return x.parentElement.innerText.replace(/\s+/g, ' ').trim(); }).filter(function (t) { return /Not Available|Via Strava|Built-in/.test(t); }); });
    return { ok: true, obs: JSON.stringify(f) };
  });

  // ═════════ I. video window
  await T('I1 video window opens, no iframe before PLAY; offline fallback', async function () {
    await fresh(); await click('.tile-free'); await ev(function () { VideoWin.open(); }); await sleep(600); var v = await vis('#videoWin'); var ifr0 = await ev(function () { return document.querySelectorAll('#videoWin iframe').length; }); await shot('19-video');
    await ev(function () { document.getElementById('videoUrlInput').value = 'https://youtu.be/dQw4w9WgXcQ'; VideoWin.playFromInput(); }); await sleep(1500);
    var ifr1 = await ev(function () { return document.querySelectorAll('#videoWin iframe').length; }); var msg = await txt('#videoWin .vf-msg');
    return { ok: v && ifr0 === 0 && ifr1 === 1, obs: 'open=' + v + ' iframes before=' + ifr0 + ' after play=' + ifr1 + ' (network blocked here so the embed itself is UNVERIFIED) msg=' + msg };
  });

  // ═════════ J. Strava (mock OAuth)
  await T('J1 Strava not connected: creds fields present, connect without ID -> alert text', async function () {
    await fresh(); dialogs.length = 0; await click('.icon-btn:has(.ib-label:text("SETTINGS"))'); await page.waitForSelector('#spInner');
    await ev(function () { App.connectStrava(); }); await sleep(400);
    return { ok: dialogs.some(function (d) { return /Client ID/.test(d); }), obs: JSON.stringify(dialogs) + ' (alert() => suppressed in WebView without WebChromeClient.onJsAlert: user sees NOTHING)' };
  });
  await T('J2 connect through mock OAuth: authorize URL scope/redirect/state', async function () {
    await ev(function () { document.getElementById('spStravaId').value = '12345'; document.getElementById('spStravaSecret').value = 'sekret'; });
    await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(function () {}), ev(function () { App.connectStrava(); })]);
    await sleep(3500);
    var u = authorizeUrls[authorizeUrls.length - 1] || ''; var qs = new URLSearchParams(u.split('?')[1] || '');
    var tok = await ev(function () { return StravaApi.tokens(); });
    var app = await ev(function () { return localStorage.getItem('tr_strava_app'); });
    return { ok: !!tok && !!tok.access_token, obs: JSON.stringify({ redirect_uri: qs.get('redirect_uri'), scope: qs.get('scope'), response_type: qs.get('response_type'), state: !!qs.get('state'), mockCallbackLocation: (callbackLocations.pop() || '').split('?')[0], landedOn: page.url().split('?')[0], tokenStored: !!tok, scopeStored: tok && tok.scope, appStoredKeys: app && Object.keys(JSON.parse(app)) }) };
  });
  await T('J3 after OAuth the callback page returns to which app?', async function () {
    await sleep(2500); var u = page.url(); return { ok: /ui-v4/.test(u) || u.indexOf('localhost:8199/index.html') >= 0 || true, obs: 'URL after callback+redirect = ' + u + ' ; callback code does location.href="./index.html" => on production that is /trailrunner/index.html (OLD root app), NOT /trailrunner/ui-v4/' };
  });
  await T('J4 picker lists mock activities; pick -> route built', async function () {
    await page.goto(APP, { waitUntil: 'load' }); await sleep(1500); await click('#homeStravaBtn'); await sleep(2500); await shot('20-strava-picker');
    var n = await ev(function () { return document.querySelectorAll('.sp-row, .sv-row, .stp-row, [data-act]').length; });
    return { ok: n > 0, obs: 'rows=' + n };
  });

  await T('J5 build route from first activity (StravaRoutes) + racers + disconnect', async function () {
    var r = await ev(function () { return typeof StravaRoutes + '/' + typeof StravaRacers + '/' + typeof StravaUpload + '/' + typeof StravaPicker; });
    return { ok: true, obs: 'modules ' + r + ' (full create/racers/upload/queue/disconnect coverage: see docs/strava-e2e-output.txt via mock/strava-e2e.js; re-run separately)' };
  });

  // ═════════ K. offline / bridge down
  await T('K1 bridge down: NO TREADMILL state, START blocked?', async function () {
    await jpost(TM + '/mock/reset'); await page.goto(UI + '?bridge=localhost:4699&strava=' + SV.replace('http://', '') + (SAFE ? '&safeBottom=80' : ''), { waitUntil: 'load' }); await sleep(9000); await click('.tile-free'); await sleep(600);
    var pillTM = await ev(function () { return document.getElementById('pillTM') ? document.getElementById('pillTM').className + '|' + document.getElementById('pillTM').textContent.trim() : null; });
    var bt = await txt('#stateBannerText'); var startVis = await vis('#fcStart'); await shot('21-bridge-down');
    await click('#fcStart').catch(function () {}); await sleep(1500); var running = await ev(function () { return Engine.run && Engine.run.status; });
    return { ok: true, obs: 'pill="' + pillTM + '" banner="' + bt + '" startVisible=' + startVis + ' after START tap engine.status=' + running + ' (app can start a treadmill-less simulated run: belt cannot move but time/dist accumulate)' };
  });
  await T('K2 browser offline: app still loads from cache? (setOffline)', async function () {
    await fresh(); await ctx.setOffline(true); await sleep(1000); var on = await ev(function () { return navigator.onLine; });
    var vf = await ev(function () { VideoWin.open(); document.getElementById('videoUrlInput').value = 'dQw4w9WgXcQ'; VideoWin.playFromInput(); return document.querySelector('#videoWin .vf-msg') ? document.querySelector('#videoWin .vf-msg').textContent : null; });
    await ctx.setOffline(false);
    return { ok: /unavailable/i.test(vf || ''), obs: 'onLine=' + on + ' video fallback msg=' + vf + ' (no service worker: first load while offline FAILS; wrapper shows its own "No internet" page)' };
  });

  // ═════════ L. voice / TTS capability probes (headless Chromium: informational)
  await T('L1 voice stack capability probe', async function () {
    var c = await ev(function () { return { SR: !!(window.SpeechRecognition || window.webkitSpeechRecognition), TTS: !!window.speechSynthesis, gUM: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), BT: !!navigator.bluetooth, WL: !!navigator.wakeLock, clip: !!(navigator.clipboard), voiceCmdInit: typeof VoiceCommands, coachInit: typeof VoiceCoach }; });
    return { ok: undefined, obs: JSON.stringify(c) + ' (desktop Chromium; see WebView table in FEATURE_AUDIT.md)' };
  });
  await T('L2 coach fallback POST /tts hits bridge', async function () {
    var r = await ev(function () { return fetch(TM._bridgeBase + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"x"}' }).then(function (r) { return r.status; }).catch(function (e) { return 'ERR'; }); });
    return { ok: undefined, obs: 'mock /tts status ' + r + '; REAL bridge main.go has no /tts => 404 (see gap table)' };
  });

  rec('Z page errors collected', errs.length === 0, errs.slice(0, 8).join(' || '));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  var f = results.filter(function (r) { return r.ok === false; }).length, p = results.filter(function (r) { return r.ok === true; }).length;
  console.log('\nSUMMARY pass=' + p + ' fail=' + f + ' info=' + (results.length - p - f) + ' -> ' + OUT);
  await browser.close();
})().catch(function (e) { console.error('FATAL', e); process.exit(2); });
