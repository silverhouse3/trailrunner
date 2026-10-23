#!/usr/bin/env node
// Playwright check: RUN AGAIN + % harder controls on stats.html -> app preview card. Never starts the belt.
//   node mock/stats-run-again-test.js   (needs :8099 static UI and :4510 mock bridge; neither is touched otherwise)
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var passed = 0, failed = 0;
function ok(c, n, d) { (c ? passed++ : failed++); console.log((c ? 'PASS  ' : 'FAIL  ') + n + (d !== undefined ? '  [' + d + ']' : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
(async function () {
  var browser = await pw.chromium.launch();
  for (var vp of [[1920, 1000], [960, 1080]]) {
    var ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] } });
    await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
    var page = await ctx.newPage(), errs = [], cmds = [];
    page.on('pageerror', function (e) { errs.push(e.message); });
    page.on('request', function (rq) { if (/:4510\/(speed|incline|start|cmd|api\/(speed|incline|start))/.test(rq.url()) && rq.method() !== 'GET') cmds.push(rq.method() + ' ' + rq.url()); });
    var tag = vp.join('x') + ': ';
    await page.goto('http://localhost:8099/stats.html?demo=1&safeBottom=80', { waitUntil: 'load' });
    await page.evaluate(function () { localStorage.removeItem('tr_runagain_pct'); localStorage.removeItem('tr_runagain_pending'); });
    await page.waitForSelector('.hrow');
    var n = await page.$$eval('.hrow', function (r) { return r.length; });
    var again = await page.$$eval('.hrow .sa-again', function (b) { return b.map(function (x) { var r = x.getBoundingClientRect(); return [r.width, r.height, r.left + r.width <= innerWidth]; }); });
    ok(n > 0 && again.length === n && again.every(function (a) { return a[1] >= 56 && a[0] >= 80 && a[2]; }), tag + 'AGAIN button on every history row, big and on-screen', n + ' rows');
    ok(await page.$$eval('.rb-card .sa-again', function (b) { return b.length > 0 && /Run again \+\d/.test(b[0].textContent); }), tag + 'route breakdown cards have "Run again +X%"');
    await page.click('.hrow >> nth=0');
    await page.waitForSelector('#runDetail.show .sa-chip');
    var chips = await page.$$eval('#runDetail .sa-pcts .sa-chip', function (c) { return c.map(function (x) { return x.textContent; }); });
    ok(chips.join('|') === 'SAME|+2.5%|+5%|+10%|CUSTOM' && !!(await page.$('#runDetail .sa-box .ra-entry')), tag + 'detail has RUN AGAIN + SAME/+2.5/+5/+10/custom chips', chips.join(' '));
    var tl = await page.evaluate(function () { return [].slice.call(document.querySelectorAll('#runDetail button, #runDetail .sa-custom')).every(function (b) { var r = b.getBoundingClientRect(); return !(r.left < 110 && r.top < 110 && r.width) || true; }); });
    await page.click('#runDetail .sa-chip[data-pct="5"]');
    ok(await page.evaluate(function () { return localStorage.getItem('tr_runagain_pct') === '5'; }), tag + '+5% chip stores the choice');
    await page.click('#runDetail .sa-box .ra-entry');
    await page.waitForURL(/index\.html/, { timeout: 10000 });
    ok(/demo=1/.test(page.url()) && /safeBottom=80/.test(page.url()), tag + 'handoff keeps units/safeBottom query', page.url());
    await page.waitForSelector('.ra-card', { timeout: 15000 });
    var card = await page.evaluate(function () { return { t: document.querySelector('.ra-card').innerText.replace(/\s+/g, ' '), on: (document.querySelector('.ra-chip.on') || {}).textContent, pct: (document.getElementById('raPctText') || {}).textContent, pend: localStorage.getItem('tr_runagain_pending'), run: Engine.run && Engine.run.status }; });
    ok(/5% harder/.test(card.pct || '') && /\+5%/.test(card.on || '') && /AVG/.test(card.t) && /MAX INCLINE/.test(card.t), tag + 'preview card opens with 5% preselected ("5% harder", avg/max speed, incline)', card.pct + ' / ' + card.on);
    ok(card.pend === null, tag + 'pending hand-off consumed');
    await sleep(1500);
    ok(cmds.length === 0 && card.run !== 'running', tag + 'no speed/start command sent to the bridge before START', cmds.join(',') || 'none');
    // list-row AGAIN with a different remembered %
    await page.goto('http://localhost:8099/stats.html?demo=1', { waitUntil: 'load' });
    await page.evaluate(function () { localStorage.setItem('tr_runagain_pct', '10'); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.hrow .sa-again');
    await page.click('.hrow .sa-again >> nth=0');
    await page.waitForSelector('.ra-card', { timeout: 15000 });
    ok(/10% harder/.test(await page.textContent('#raPctText')), tag + 'row AGAIN uses the remembered % (10)');
    ok(errs.length === 0, tag + 'no page errors', errs.join('|'));
    await ctx.close();
  }
  await browser.close();
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.log('FATAL ' + e.stack); process.exit(2); });
