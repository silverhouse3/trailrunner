#!/usr/bin/env node
// Audit: emulate the Android WebView 83 gaps in desktop Chromium (no SpeechRecognition, no speechSynthesis voices/engine,
// no Wake Lock, no Web Bluetooth, no JS dialogs, no file chooser) and observe what the USER would see. Mocks only; own ports.
//   node mock/audit-webview-sim.js
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UI = 'http://localhost:8199/', TM = 'http://localhost:4610';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
function line(id, v, o) { console.log((v === true ? 'PASS  ' : v === false ? 'FAIL  ' : 'INFO  ') + id + '  -> ' + o); }
(async function () {
  var b = await pw.chromium.launch(); var ctx = await b.newContext({ viewport: { width: 1920, height: 1000 } });
  await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
  var page = await ctx.newPage(); page.setDefaultTimeout(8000);
  var ttsHits = 0; await ctx.route('**/tts', function (r) { ttsHits++; r.continue(); });
  await page.addInitScript(function () {
    window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
    try { Object.defineProperty(navigator, 'bluetooth', { value: undefined }); } catch (e) {}
    try { Object.defineProperty(navigator, 'wakeLock', { value: undefined }); } catch (e) {}
    window.__dlg = []; // WebView without WebChromeClient: alert() no-op, confirm() false, prompt() null
    window.alert = function (m) { window.__dlg.push('alert:' + m); }; window.confirm = function (m) { window.__dlg.push('confirm:' + m); return false; }; window.prompt = function (m) { window.__dlg.push('prompt:' + m); return null; };
    HTMLInputElement.prototype.click = (function (o) { return function () { if (this.type === 'file') { window.__dlg.push('file-input-click-ignored'); return; } return o.apply(this, arguments); }; })(HTMLInputElement.prototype.click);
    window.__dl = []; HTMLAnchorElement.prototype.click = (function (o) { return function () { if (this.download) { window.__dl.push(this.download); return; } return o.apply(this, arguments); }; })(HTMLAnchorElement.prototype.click);
  });
  await jpost(TM + '/mock/reset'); await page.goto(UI + '?bridge=localhost:4610'); await page.evaluate(function () { localStorage.clear(); }); await page.goto(UI + '?bridge=localhost:4610&demo=route'); await sleep(2500);
  var ev = function (f, a) { return page.evaluate(f, a); };
  var caps = await ev(function () { return { VoiceCommandsSupported: window.VoiceCommands && VoiceCommands.supported, VoiceCmdRecognition: !!(VoiceCmd && VoiceCmd.recognition) }; });
  line('W1 mic button when SpeechRecognition missing', undefined, JSON.stringify(caps));
  await page.click('.tile-free'); await sleep(300);
  var before = await ev(function () { return document.getElementById('voiceMicBtn').className + '|' + document.body.innerText.length; });
  await page.click('#voiceMicBtn'); await sleep(800);
  var after = await ev(function () { var t = document.getElementById('voiceFeedback') || document.querySelector('.voice-feedback, #voiceToast, .vc-toast'); return { cls: document.getElementById('voiceMicBtn').className, fb: t ? t.textContent : null, dlg: window.__dlg.slice() }; });
  line('W2 tapping mic gives user feedback?', !!(after.fb) , JSON.stringify(after) + ' (no feedback => silent no-op)');
  ttsHits = 0; await ev(function () { VoiceCoach.enabled = true; VoiceCoach.say('Test coaching line', 'high'); }); await sleep(1500);
  line('W3 TTS with no speechSynthesis -> bridge fallback', undefined, 'POST /tts hits=' + ttsHits + ' (mock answers 200; REAL bridge has no /tts route => 404, nothing is spoken)');
  await ev(function () { App.shareRunSummary && 0; });
  await page.click('#fcStart'); await sleep(2500); await ev(function () { App.finishRun(); }); await sleep(1200);
  await ev(function () { window.__dlg.length = 0; App.shareRunSummary(document.querySelector('[onclick^="App.shareRunSummary"]')); }); await sleep(600);
  line('W4 SHARE copy: clipboard then prompt() fallback', undefined, JSON.stringify(await ev(function () { return window.__dlg; })));
  await ev(function () { App.exportGPX(); }); await sleep(300);
  line('W5 GPX export (blob+anchor)', undefined, 'anchor.download clicks captured=' + JSON.stringify(await ev(function () { return window.__dl; })) + ' (plain WebView: nothing saved unless DownloadListener/AndroidBridge.saveFile)');
  await ev(function () { App.discardRun(); }); await sleep(600);
  await page.click('.tile-route'); await sleep(500); await ev(function () { window.__dlg.length = 0; App.triggerGPXImport(); });
  line('W6 GPX import button', undefined, JSON.stringify(await ev(function () { return window.__dlg; })));
  var n0 = await ev(function () { return Store.getRoutes().length; }); await page.click('.rc-del').catch(function () {}); await sleep(500);
  line('W7 delete route with confirm() returning false', (await ev(function () { return Store.getRoutes().length; })) === n0, 'routes ' + n0 + ' -> ' + (await ev(function () { return Store.getRoutes().length; })) + ' dlg=' + JSON.stringify(await ev(function () { return window.__dlg; })));
  await page.click('.rc-del', { timeout: 500 }).catch(function () {});
  await ev(function () { App.closeRoutes(); App.goHome && App.goHome(); }); await sleep(500);
  var hr = await ev(function () { return BLEHR.connect().then(function (r) { return { r: r, toast: (document.getElementById('mediaToast') || {}).textContent }; }); });
  line('W8 HR pill / BLE scan', undefined, JSON.stringify(hr));
  await ev(function () { App.emergencyStop && 0; });
  // E-STOP
  await page.click('.tile-free').catch(function () {}); await sleep(400); await page.click('#fcStart').catch(function () {}); await sleep(2500);
  var s0 = await (await fetch(TM + '/mock/state')).json(); await page.click('.estop'); await sleep(1500); var s1 = await (await fetch(TM + '/mock/state')).json();
  line('W9 E-STOP button', s1.sim.kph === 0 || s1.sim.targetKph === 0, 'before kph=' + s0.sim.kph + ' target=' + s0.sim.targetKph + ' after: target=' + s1.sim.targetKph + ' kph=' + s1.sim.kph + ' state=' + s1.sim.workoutState + ' incline target=' + s1.sim.targetIncline);
  await b.close();
})().catch(function (e) { console.error('FATAL', e); process.exit(2); });
