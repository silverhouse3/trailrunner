#!/usr/bin/env node
// Settings > Bluetooth > ADD HEADPHONES against a fake window.AndroidBridge (btAudio*).
//   flock /tmp/trsuite.lock node mock/headphones-pairing-test.js   (needs static server :8099; spawns its own mock bridge on :4516)
'use strict';
var path = require('path'), cp = require('child_process');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.env.BASE || 'http://localhost:8099/', PORT = 4516;
var fails = 0;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ok(c, n, d) { if (!c) fails++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); }
var CMD = /\/(workout\/(start|resume|pause|stop)|speed|incline)$|\/command$/;

// Fake Android app bridge. Like the real one it only ever reports audio devices (the strap is NOT in its lists).
var STUB = function () {
  var S = { calls: [], enabled: true, discovering: false, scanAt: 0, bonded: [], bondedAt: 0, pairAt: 0, connected: false, lastError: '', failPair: false };
  window.__bt = S;
  function st() {
    var now = Date.now(), found = [];
    if (S.discovering && now - S.scanAt > 300) found = [{ name: 'Weak Buds', address: '22:22:22:22:22:22', rssi: -82 }, { name: 'Sony WH-1000XM4', address: 'AA:BB:CC:00:11:22', rssi: -48 }];
    if (S.pairAt && now - S.pairAt > 800 && !S.failPair) { S.pairAt = 0; S.bonded = [{ name: 'Sony WH-1000XM4', address: 'AA:BB:CC:00:11:22', connected: false }]; S.bondedAt = now; }
    if (S.bondedAt && now - S.bondedAt > 800) { S.bondedAt = 0; S.bonded[0].connected = true; }
    if (S.pairAt && S.failPair && now - S.pairAt > 800) { S.pairAt = 0; S.lastError = 'The headphones refused the pairing. Put them back in pairing mode and try again.'; }
    return JSON.stringify({ enabled: S.enabled, discovering: S.discovering, bonded: S.bonded, found: found, connected: null, lastError: S.lastError });
  }
  window.AndroidBridge = {
    btAudioState: function () { return st(); },
    btAudioScan: function (on) { S.calls.push('scan:' + on); S.lastError = ''; S.discovering = !!on; S.scanAt = Date.now(); return st(); },
    btAudioPair: function (a) { S.calls.push('pair:' + a); S.lastError = ''; S.pairAt = Date.now(); S.discovering = false; return st(); },
    btAudioConnect: function (a) { S.calls.push('connect:' + a); return st(); },
    btAudioDisconnect: function (a) { S.calls.push('disconnect:' + a); if (S.bonded[0]) S.bonded[0].connected = false; return st(); },
    btAudioForget: function (a) { S.calls.push('forget:' + a); S.bonded = []; return st(); }
  };
};

(async function () {
  var mock = cp.spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  var browser = await pw.chromium.launch();
  try {
    await sleep(1200);
    var ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
    // 1) no bridge: hidden
    var p0 = await ctx.newPage();
    await p0.goto(BASE + '?demo=route&bridge=localhost:' + PORT);
    await sleep(3500);
    await p0.evaluate(function () { SettingsPanel._openSections.add('bluetooth'); App.openSettings(); });
    await sleep(1500);
    var hid = await p0.evaluate(function () { return { box: !!document.getElementById('btAudioBox'), txt: document.body.innerText.indexOf('ADD HEADPHONES') } });
    ok(!hid.box && hid.txt < 0, 'hidden without AndroidBridge');
    await p0.close();

    // 2) old app bridge without btAudio*: one-line hint
    var p1 = await ctx.newPage();
    await p1.addInitScript(function () { window.AndroidBridge = { version: function () { return 4; } }; });
    await p1.goto(BASE + '?demo=route&bridge=localhost:' + PORT);
    await sleep(3500);
    await p1.evaluate(function () { SettingsPanel._openSections.add('bluetooth'); App.openSettings(); });
    await sleep(1500);
    var t1 = await p1.evaluate(function () { return document.body.innerText; });
    ok(/needs the TrailRunner app update/.test(t1) && !/ADD HEADPHONES/.test(t1), 'old app: update hint, no button');
    await p1.close();

    // 3) full flow
    var page = await ctx.newPage(), cmds = [], other = [];
    await page.addInitScript(STUB);
    page.on('request', function (r) { if (r.method() === 'POST' && r.url().indexOf(':' + PORT) > -1) { if (CMD.test(r.url().split('?')[0])) cmds.push(r.url()); else other.push(r.url()); } });
    await page.goto(BASE + '?demo=route&bridge=localhost:' + PORT);
    await sleep(3500);
    await page.evaluate(function () { SettingsPanel._openSections.add('bluetooth'); App.openSettings(); });
    await page.waitForSelector('#btAudioBox', { timeout: 5000 });
    await sleep(1800);
    var txt = function () { return page.evaluate(function () { var e = document.getElementById('btAudioBox'); return e ? e.innerText : ''; }); };
    var t = await txt();
    ok(/ADD HEADPHONES/.test(t), 'ADD HEADPHONES shown with bridge');
    await page.click('#btAudioBox .bta-add');
    await sleep(400);
    ok(/Searching/i.test(await txt()), 'scanning state');
    await sleep(2200);
    t = await txt();
    ok(/Sony WH-1000XM4/.test(t) && /Weak Buds/.test(t), 'found list shown');
    ok(t.indexOf('Sony') < t.indexOf('Weak Buds'), 'sorted by signal');
    ok(!/Polar|Garmin|Galaxy Watch/.test(t), 'non-audio (HR strap) devices never shown in headphones box');
    var h = await page.evaluate(function () { return Array.prototype.map.call(document.querySelectorAll('#btAudioBox .btp-btn'), function (b) { return b.getBoundingClientRect().height; }); });
    ok(h.length >= 3 && h.every(function (x) { return x >= 76; }), 'all headphone buttons >= 76px', h.join(','));
    await page.click('#btAudioBox .btp-row .btp-btn.on');
    await sleep(300);
    ok(/Pairing/i.test(await txt()), 'pairing… state');
    await sleep(4500);
    t = await txt();
    ok(/Sony WH-1000XM4/.test(t) && /Connected/.test(t) && /Audio output/.test(t), 'connected shows name + Audio output', t.replace(/\n/g, '|').slice(0, 120));
    var calls = await page.evaluate(function () { return window.__bt.calls; });
    ok(calls.join(',') === 'scan:true,pair:AA:BB:CC:00:11:22', 'only expected bridge calls', calls.join(','));
    // disconnect + forget
    await page.click('#btAudioBox .btp-btn.off');
    await sleep(300);
    ok(/Not connected/.test(await txt()), 'disconnected state');
    await page.click('#btAudioBox .bta-forget');
    await sleep(300);
    ok(!/Sony/.test(await txt()), 'forget removes the headphones');

    // error display
    await page.evaluate(function () { window.__bt.failPair = true; });
    await page.click('#btAudioBox .bta-add');
    await sleep(2300);
    await page.click('#btAudioBox .btp-row .btp-btn.on');
    await sleep(3200);
    t = await txt();
    ok(/refused the pairing/.test(t), 'error shown in plain English', t.replace(/\n/g, '|').slice(-120));
    await page.evaluate(function () { window.__bt.enabled = false; window.__bt.lastError = 'Bluetooth is switched off.'; });
    await sleep(2200);
    ok(/switched off/i.test(await txt()), 'bluetooth-off message');

    ok(cmds.length === 0, 'no motor/workout commands sent', cmds.join(','));
    ok(other.length === 0, 'headphone flow made no POSTs to the treadmill bridge', other.join(','));
  } catch (e) { fails++; console.log('FAIL  exception ' + e.message); }
  await browser.close(); mock.kill();
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
