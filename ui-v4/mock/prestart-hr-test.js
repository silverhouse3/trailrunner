#!/usr/bin/env node
// Live heart rate from the treadmill's own Bluetooth shows on the run screen BEFORE START (belt never started).
'use strict';
var path = require('path'), cp = require('child_process');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.env.BASE || 'http://localhost:8099/', PORT = 4518, B = 'http://localhost:' + PORT;
var fails = 0;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function ok(c, n, d) { if (!c) fails++; console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); }
function post(p, o) { return fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) }).then(function (r) { return r.json(); }); }
(async function () {
  var mock = cp.spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  var browser = await pw.chromium.launch(), cmds = [];
  try {
    await sleep(1200);
    var page = await (await browser.newContext({ viewport: { width: 1920, height: 1000 } })).newPage();
    page.on('request', function (r) { if (r.method() === 'POST' && /\/(workout\/(start|resume)|speed|command)/.test(r.url())) cmds.push(r.url()); });
    await page.goto(BASE + '?bridge=localhost:' + PORT); await sleep(3500);
    await post('/mock/hr', { bpm: 118 }); await sleep(3500);
    var st = await page.evaluate(function () { return { status: Engine.run && Engine.run.status, hr: document.getElementById('hrVal') && document.getElementById('hrVal').textContent }; });
    ok(st.status === 'ready', 'run has not started', JSON.stringify(st));
    ok(st.hr === '118', 'HR shown before START', JSON.stringify(st));
    await post('/mock/hr', { bpm: 0 }); await sleep(3500);
    var h2 = await page.evaluate(function () { return document.getElementById('hrVal').textContent; });
    ok(h2 !== '118', 'HR clears when the strap drops', h2);
    ok(cmds.length === 0, 'no belt commands sent', JSON.stringify(cmds));
  } finally { await browser.close(); mock.kill(); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
