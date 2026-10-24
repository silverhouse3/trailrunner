#!/usr/bin/env node
// Settings > Bluetooth pairing screen against the mock bridge.
//   node mock/bluetooth-pairing-test.js   (needs the static server on :8099; spawns its own mock bridge on :4515)
'use strict';
var path = require('path'), cp = require('child_process');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.env.BASE || 'http://localhost:8099/', PORT = 4515, B = 'http://localhost:' + PORT;
var fails = 0;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ok(c, n, d) { if (!c) fails++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); }
function post(p, o) { return fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) }).then(function (r) { return r.json(); }); }
var CMD = /\/(workout\/(start|resume|pause|stop)|speed|incline)$|\/command$/;

(async function () {
  var mock = cp.spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  var browser = await pw.chromium.launch();
  try {
    await sleep(1200);
    var ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
    var page = await ctx.newPage(), cmds = [];
    page.on('request', function (r) { if (r.method() === 'POST' && r.url().indexOf(':' + PORT) > -1 && CMD.test(r.url().split('?')[0])) cmds.push(r.url()); });
    await page.goto(BASE + '?demo=route&bridge=localhost:' + PORT);
    await sleep(3500);
    await page.evaluate(function () { SettingsPanel._openSections.add('bluetooth'); App.openSettings(); });
    await page.waitForSelector('#btPairBox', { timeout: 5000 });
    await sleep(2000);
    var txt = function () { return page.evaluate(function () { var e = document.getElementById('btPairBox'); return e ? e.innerText : ''; }); };
    var t = await txt();
    ok(/Bluetooth devices/i.test(t), 'screen title shown');
    ok(/Nothing found yet/i.test(t), 'idle: nothing found hint', t.slice(0, 80).replace(/\n/g, '|'));

    await page.click('.btp-btn.scan');
    await sleep(400);
    ok(/Searching/i.test(await txt()), 'Searching… state after Scan');
    await sleep(2000);
    t = await txt();
    ok(/Polar H10/.test(t) && /Garmin HRM/.test(t), 'nearby devices listed');
    ok(t.indexOf('Polar H10') < t.indexOf('Galaxy Watch'), 'strongest signal first');

    var h = await page.evaluate(function () { return Array.prototype.map.call(document.querySelectorAll('#btPairBox .btp-btn'), function (b) { return b.getBoundingClientRect().height; }); });
    ok(h.length >= 3 && h.every(function (x) { return x >= 72; }), 'all buttons >= 72px', h.join(','));

    await page.click('#btPairBox .btp-row:first-of-type .btp-btn.on, #btPairBox .btp-btn.on');
    await sleep(300);
    ok(/Connecting/i.test(await txt()), 'Connecting… state');
    await sleep(3200);
    t = await txt();
    ok(/CONNECTED/.test(t) && /Connected/.test(t), 'Connected state, device moved to top');
    ok(/no pulse yet/i.test(t), 'connected strap with no pulse shows snug hint');
    await post('/mock/bt', { hrReading: 71 });
    await sleep(2000);
    ok(/71\s*bpm/.test(await txt()), 'live HR reading shown', (await txt()).replace(/\n/g, '|').slice(0, 120));

    await page.click('#btPairBox .btp-btn.off');
    await sleep(2500);
    t = await txt();
    ok(!/CONNECTED/.test(t), 'disconnected: connected section gone');

    await post('/mock/bt', { available: false });
    await sleep(2200);
    ok(/Bluetooth unavailable/i.test(await txt()), 'Bluetooth unavailable state');
    await post('/mock/bt', { available: true });
    ok(cmds.length === 0, 'no motor/workout commands sent by pairing screen', cmds.join(','));

    // old bridge: endpoints 404 -> hint text fallback
    var p2 = await ctx.newPage();
    await p2.route('**/bluetooth/**', function (r) { r.fulfill({ status: 404, body: 'not found' }); });
    await p2.goto(BASE + '?demo=route&bridge=localhost:' + PORT);
    await sleep(4500);
    await p2.evaluate(function () { SettingsPanel._openSections.add('bluetooth'); App.openSettings(); });
    await sleep(800);
    var t2 = await p2.evaluate(function () { var e = document.querySelector('.sp-acc-item:nth-child(3) .sp-acc-body'); return e ? e.innerText : ''; });
    var box = await p2.evaluate(function () { return !!document.getElementById('btPairBox'); });
    ok(/HR Monitor/.test(t2) && !box, 'old bridge keeps the original HR Monitor row (Scan shows the iFIT hint)', t2.slice(0, 40).replace(/\n/g, '|'));
  } catch (e) { fails++; console.log('FAIL  exception ' + e.message); }
  await browser.close(); mock.kill();
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
