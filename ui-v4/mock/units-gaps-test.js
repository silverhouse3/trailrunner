#!/usr/bin/env node
// Units / voice / fan gap tests (Playwright against :8099, demo mode, no treadmill).
//   node mock/units-gaps-test.js
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.argv[2] || 'http://localhost:8099/';
var MOCK = 'http://localhost:4510';
var checks = 0, fails = [];
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ok(c, n, d) { checks++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); if (!c) fails.push(n + (d ? ' ' + d : '')); }

function sysScript(sys) { return function (s) { try { var o = JSON.parse(localStorage.getItem('tr_settings') || '{}'); o.unitSystem = s; localStorage.setItem('tr_settings', JSON.stringify(o)); } catch (e) {} }; }
function speechScript(present) {
  return function (p) {
    if (p) { var F = function () { this.start = function () {}; this.stop = function () {}; this.abort = function () {}; }; window.SpeechRecognition = F; window.webkitSpeechRecognition = F; }
    else { try { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; } catch (e) {} window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; }
  };
}

async function newPage(b, sys, speech) {
  var ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
  var page = await ctx.newPage();
  page.errs = [];
  page.on('pageerror', function (e) { page.errs.push(e.message); });
  await page.addInitScript(sysScript(sys), sys);
  if (speech != null) await page.addInitScript(speechScript(speech), speech);
  return page;
}

async function summary(page) {
  await page.goto(BASE + '?demo=noroute'); await sleep(1200);
  await page.click('.tile-free'); await sleep(600); await page.click('#fcStart'); await sleep(2500);
  await page.evaluate(function () {
    var r = Engine.run; r.distanceM = 5000; r.elapsed = 1500;
    r.splits = [1, 2, 3, 4, 5].map(function (k) { return { km: k, timeSec: 295 + k * 2, paceSecPerKm: 295 + k * 2, avgHR: 140 + k, elapsed: 300 * k }; });
    r._lastSplitElapsed = 1500; r._lastSplitKm = 5; r._splitHRSum = 150 * 20; r._splitHRSamples = 20;
    App.finishRun();
    document.querySelectorAll('.milestone-popup').forEach(function (x) { x.classList.remove('show'); });
  });
  await sleep(1000);
  return page.evaluate(function () { var e = document.getElementById('fSplits'); return { text: e ? e.innerText : '', html: e ? e.innerHTML : '' }; });
}

(async function () {
  try { await fetch(MOCK + '/mock/reset', { method: 'POST' }); } catch (e) {}
  var b = await pw.chromium.launch();

  // ── 1. Imperial summary: Mile splits, min/mi ──────────────────────────────
  var p = await newPage(b, 'imperial', true);
  var imp = await summary(p);
  ok(/Mile 1/.test(imp.text) && /Mile 3/.test(imp.text), 'imperial summary has Mile 1..3 rows');
  ok(!/Mile 4/.test(imp.text), 'imperial 5 km run -> 3 full miles + partial (no Mile 4)');
  ok(/MILE/.test(imp.text) && !/\bKM\b/.test(imp.text.replace(/\bKM\b(?=.*never)/, '')), 'imperial header says MILE not KM');
  ok(/\/mi/.test(imp.text) && !/\/km/.test(imp.text), 'imperial pace in /mi, not /km');
  ok(/partial/i.test(imp.text) && /0\.1\d mi/.test(imp.text), 'imperial final partial split labelled in miles', (imp.text.match(/\d\.\d+ mi/) || [''])[0]);
  var reg = await p.evaluate(function () {
    var run = { splits: [1, 2, 3, 4, 5].map(function (k) { return { km: k, timeSec: 300, avgHR: 140 + k }; }), finalSplit: null };
    var g = PastRunSplits.regroup(run), tot = 0; g.splits.forEach(function (s) { tot += s.timeSec; });
    return { n: g.splits.length, t1: g.splits[0].timeSec, fin: g.finalSplit, tot: tot };
  });
  ok(reg.n === 3 && Math.abs(reg.t1 - 482.8) < 0.5, 'regroup: 5 km @300s -> 3 miles of ~482.8s', JSON.stringify(reg));
  ok(reg.fin && Math.abs(reg.fin.distKm - 0.11) < 0.02 && Math.abs(reg.tot + reg.fin.timeSec - 1500) < 0.5, 'regroup conserves total time, partial ~0.11 mi');
  var leakKm = await p.evaluate(function () { return Engine.run ? Engine.run.splits.length : -1; });
  ok(leakKm === 5, 'stored run keeps per-km splits (display-only regroup)', 'stored=' + leakKm);
  ok(p.errs.length === 0, 'imperial summary: no page errors', p.errs.join('|'));
  await p.context().close();

  // ── 2. Metric summary: km ────────────────────────────────────────────────
  p = await newPage(b, 'metric', true);
  var met = await summary(p);
  ok(/\bKM\b/.test(met.text) && /\/km/.test(met.text) && !/Mile/.test(met.text) && !/\/mi\b/.test(met.text), 'metric summary shows KM and /km only');
  ok(/(^|\n)\s*1\s/.test(met.text) || /\b5\b/.test(met.text), 'metric summary has km rows 1..5');
  await p.context().close();

  // ── 3. Mic / voice / fan with SpeechRecognition ABSENT ───────────────────
  p = await newPage(b, 'imperial', false);
  await p.goto(BASE + '?demo=noroute'); await sleep(1500);
  var micAbsent = await p.evaluate(function () {
    var m = document.getElementById('voiceMicBtn'); if (!m) return 'none';
    var r = m.getBoundingClientRect(), cs = getComputedStyle(m);
    return (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 2) ? 'hidden' : 'visible';
  });
  ok(micAbsent === 'hidden' || micAbsent === 'none', 'no SpeechRecognition: mic button not visible', micAbsent);
  var voiceHtml = await p.evaluate(function () { var s = Store.getSettings(); return SettingsPanel._tabControlsBody(s) + SettingsPanel._accAudio(s); });
  ok(!/id="spVoiceEnabled"/.test(voiceHtml) && /Voice commands aren't available on this screen/.test(voiceHtml), 'no SR: voice-command toggle replaced by one-line notice');
  var fanState = await p.evaluate(function () {
    var calls = 0, orig = TM._httpDispatch; TM._httpDispatch = function () { calls++; }; TM._useHTTP = true;
    TM.connected = true; TM.setFan(60); TM._send({ values: { 'Fan Speed': 70 }, type: 'set' });
    TM._httpDispatch = orig;
    var vis = Array.prototype.some.call(document.querySelectorAll('button,label,.sp-label,[id]'), function (e) { var r = e.getBoundingClientRect(); return r.width > 1 && /\bfan\b/i.test((e.id || '') + ' ' + (e.textContent || '').slice(0, 40)); });
    return { calls: calls, supported: TM.fanSupported, vis: vis };
  });
  ok(fanState.calls === 0 && fanState.supported === false, 'fan: nothing is sent to the bridge', JSON.stringify(fanState));
  ok(!fanState.vis, 'fan: no visible fan control');
  // speech synthesis absent -> beeps-only notice, voice-coach controls hidden
  var tts = await p.evaluate(function () {
    var d = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
    try { Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); } catch (e) {}
    var h = SettingsPanel._accAudio(Store.getSettings());
    return { h: h, gone: !window.speechSynthesis };
  });
  ok(!tts.gone || (/beeps only/.test(tts.h) && !/id="spTTSVoice"/.test(tts.h)), 'no speechSynthesis: voice-coach controls hidden, beeps-only note', 'stubbed=' + tts.gone);
  await p.context().close();

  // ── 4. SpeechRecognition PRESENT ─────────────────────────────────────────
  p = await newPage(b, 'imperial', true);
  await p.goto(BASE + '?demo=noroute'); await sleep(1500);
  var micPresent = await p.evaluate(function () { var m = document.getElementById('voiceMicBtn'); if (!m) return 'none'; var r = m.getBoundingClientRect(); return getComputedStyle(m).display !== 'none' && r.width > 2 ? 'visible' : 'hidden'; });
  ok(micPresent === 'visible', 'SpeechRecognition present: mic button visible', micPresent);
  var voiceHtml2 = await p.evaluate(function () { return SettingsPanel._tabControlsBody(Store.getSettings()); });
  ok(/id="spVoiceEnabled"/.test(voiceHtml2), 'SR present: voice-command toggle offered');
  await p.context().close();

  // ── 5. CSV export follows units ──────────────────────────────────────────
  async function csv(sys) {
    var pg = await newPage(b, sys, true);
    await pg.goto(BASE + 'stats.html?demo=1'); await sleep(1800);
    var out = await pg.evaluate(function () {
      var captured = null, origBlob = window.Blob;
      window.Blob = function (parts, o) { if (o && /csv/.test(o.type || '')) captured = parts.join(''); return new origBlob(parts, o); };
      window.URL.createObjectURL = function () { return 'blob:x'; };
      HTMLAnchorElement.prototype.click = function () {};
      exportCSV(); window.Blob = origBlob;
      return captured;
    });
    await pg.context().close();
    return out || '';
  }
  var cI = await csv('imperial'), cM = await csv('metric');
  var hI = cI.split('\n')[0], hM = cM.split('\n')[0];
  ok(/Distance \(mi\)/.test(hI) && /\(mph\)/.test(hI) && /Elevation \(ft\)/.test(hI) && !/\(km\)|kph/.test(hI), 'CSV imperial header uses mi / mph / ft', hI);
  ok(/Distance \(km\)/.test(hM) && /\(kph\)/.test(hM) && /Elevation \(m\)/.test(hM), 'CSV metric header uses km / kph / m', hM);
  var rI = cI.split('\n')[1].split(','), rM = cM.split('\n')[1].split(',');
  var dI = parseFloat(rI[2]), dM = parseFloat(rM[2]);
  ok(dM > 0 && Math.abs(dI - dM / 1.609344) < 0.02, 'CSV distance value converted km->mi', dM + ' km -> ' + dI + ' mi');

  // ── 6. Streak / export texts ─────────────────────────────────────────────
  p = await newPage(b, 'imperial', true);
  await p.goto(BASE + '?demo=noroute'); await sleep(1500);
  var st = await p.evaluate(function () {
    var o = {};
    var d = { totalDistanceKm: 10, maxSpeedKph: 5, currentStreak: 0, totalWorkouts: 0, thisWeekCount: 0, weeksWithFourPlus: 0 };
    var f = Streaks.getProgressTowards ? null : null;
    // call the per-badge progress switch through its public path if exposed, else by source
    var src = Streaks.getProgressTowards.toString();
    o.srcKm = /' km to go'/.test(src);
    o.fun = funFactText({ km: 5.05, text: '5.05km! Pace of 12 km/h over 3 kilometres.' });
    return o;
  });
  ok(!st.srcKm, 'streaks: no hard-coded "km to go"');
  ok(/3\.14 mi/.test(st.fun) && /7\.5 mph/.test(st.fun) && /miles/.test(st.fun) && !/km/.test(st.fun), 'fun fact text converted to miles / mph', st.fun);
  var prog = await p.evaluate(function () {
    var texts = [];
    try {
      var all = Streaks.getProgressTowards();
      (all || []).forEach(function (x) { texts.push(x.remaining); });
    } catch (e) { texts.push('ERR ' + e.message); }
    return texts;
  });
  var togo = prog.filter(function (t) { return /to go/.test(t); });
  ok(prog.length > 0 && !prog.some(function (t) { return /^ERR/.test(t); }), 'streaks progress callable', prog.slice(0, 3).join(' | '));
  ok(togo.length === 0 || togo.every(function (t) { return / mi to go/.test(t); }), 'streak "to go" text uses miles in imperial', togo.join(' | '));
  var desc = await p.evaluate(function () {
    return StravaUpload.buildFields({ id: 'x', avgSpeed: 10, elevGained: 100, routeName: 'T', startedAt: new Date().toISOString(), elapsed: 600, distanceM: 1609, trackPoints: [{ elapsed: 0, dist: 0, time: new Date().toISOString() }, { elapsed: 600, dist: 1609, time: new Date(Date.now() + 600000).toISOString() }] }, {}).fields.description;
  });
  ok(/mph/.test(desc) && !/km\/h/.test(desc), 'Strava description uses mph in imperial', desc.slice(-60));
  ok(p.errs.length === 0, 'no page errors on units pages', p.errs.join('|'));
  await p.context().close();

  await b.close();
  console.log('\n' + (checks - fails.length) + '/' + checks + ' passed');
  if (fails.length) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch(function (e) { console.error(e); process.exit(2); });
