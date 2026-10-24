#!/usr/bin/env node
// Screen message banner: appears, escapes HTML, auto-hides, never blocks STOP, sends no belt commands.
'use strict';
var path = require('path'), cp = require('child_process');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var BASE = process.env.BASE || 'http://localhost:8099/', PORT = 4516, B = 'http://localhost:' + PORT;
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
    page.on('request', function (r) { if (r.method() === 'POST' && /\/(workout\/|speed|incline|command)/.test(r.url())) cmds.push(r.url()); });
    await page.goto(BASE + '?demo=route&bridge=localhost:' + PORT); await sleep(3500);
    var vis = function () { return page.evaluate(function () { var e = document.getElementById('screenMsg'); return e && e.classList.contains('show') ? e.textContent : null; }); };
    ok((await vis()) === null, 'no banner before a message');
    await post('/message', { text: 'Dinner in 10 mins', seconds: 3 }); await sleep(700);
    ok((await vis()) === 'Dinner in 10 mins', 'banner shows the text');
    await post('/message', { text: 'Dinner in 10 mins', seconds: 3 }); await sleep(700);
    ok(await page.evaluate(function () { return getComputedStyle(document.getElementById('screenMsg')).pointerEvents === 'none'; }), 'banner cannot intercept taps (STOP stays usable)');
    await sleep(3000);
    ok((await vis()) === null, 'banner disappears after the time');
    await post('/message', { text: '<img src=x onerror=window.__xss=1>', seconds: 3 }); await sleep(1500);
    ok(!(await page.evaluate(function () { return window.__xss; })) && (await vis()).indexOf('<img') === 0, 'HTML is shown as text, not run');
    ok(cmds.length === 0, 'no belt commands sent', JSON.stringify(cmds));
  } finally { await browser.close(); mock.kill(); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
