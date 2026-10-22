#!/usr/bin/env node
// Audit: the two ways a FIRST real Strava connection can be started, against the mock OAuth (own ports 8199/4610/8198).
//   A) Settings > Integrations: type Client Secret, tap Connect (writes tr_strava_app first)
//   B) Settings: type Client Secret, tap SAVE (settings blob only), then Home STRAVA > CONNECT WITH STRAVA (StravaApi.connect())
// Reports where the callback page ends up and whether tokens were stored.
'use strict';
var path = require('path');
var pw = require(path.resolve(__dirname, '../../node_modules/playwright'));
var UI = 'http://localhost:8199/', TM = 'localhost:4610', SV = 'localhost:8198';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function jpost(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
(async function () {
  var b = await pw.chromium.launch();
  for (var flow of ['A', 'B']) {
    var ctx = await b.newContext({ viewport: { width: 1920, height: 1000 } });
    await ctx.route(/tile|openstreetmap|arcgis|opentopomap|googleapis|youtube|cartocdn/, function (r) { r.abort(); });
    await ctx.route('**/oauth/authorize*', function (route) { route.fetch({ maxRedirects: 0 }).then(function (resp) { var loc = resp.headers()['location'] || ''; console.log('   authorize redirect_uri -> ' + loc.split('?')[0]); route.fulfill({ status: 302, headers: { Location: loc.replace(/^https:\/\/silverhouse3\.github\.io\/trailrunner\/(ui-v4\/)?/, UI) } }); }); });
    var page = await ctx.newPage(); page.setDefaultTimeout(8000);
    var Q = '?bridge=' + TM + '&strava=' + SV;
    await jpost('http://' + SV + '/mock/reset').catch(function () {});
    await page.goto(UI + Q); await page.evaluate(function () { localStorage.clear(); sessionStorage.clear(); }); await page.goto(UI + Q); await sleep(1800);
    await page.click('.icon-btn:has(.ib-label:text("SETTINGS"))'); await page.waitForSelector('#spInner');
    var info = await page.evaluate(function () { return { cfgClientId: window.TR_STRAVA_CONFIG && TR_STRAVA_CONFIG.clientId, appGetter: StravaApi.app(), idFieldValue: document.getElementById('spStravaId').value }; });
    console.log('FLOW ' + flow + ' start: ' + JSON.stringify(info));
    await page.evaluate(function () { document.getElementById('spStravaSecret').value = 'sekret'; });
    if (flow === 'A') {
      await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(function () {}), page.evaluate(function () { App.connectStrava(); })]);
    } else {
      await page.evaluate(function () { SettingsPanel._save && SettingsPanel._save(); });
      var st = await page.evaluate(function () { return { tr_strava_app: localStorage.getItem('tr_strava_app'), settingsHasSecret: /stravaClientSecret/.test(localStorage.getItem('tr_settings') || '') }; });
      console.log('   after SAVE: ' + JSON.stringify(st));
      await page.evaluate(function () { SettingsPanel.close && SettingsPanel.close(); }); await sleep(300);
      await page.click('#homeStravaBtn').catch(function () {}); await sleep(1200);
      var hasBtn = await page.evaluate(function () { return !!document.querySelector('.sv-btn-strava, .sv-btn-img'); });
      console.log('   picker shows CONNECT button: ' + hasBtn);
      if (hasBtn) await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(function () {}), page.click('.sv-btn-strava, .sv-btn-img')]);
    }
    await sleep(3500);
    var res = await page.evaluate(function () { return { url: location.href.split('?')[0], tokens: !!localStorage.getItem('tr_strava'), err: (document.getElementById('errorMsg') || {}).textContent || null }; }).catch(function (e) { return 'eval failed: ' + e.message; });
    console.log('FLOW ' + flow + ' result: ' + JSON.stringify(res));
    var pg = page.url(); console.log('   final URL: ' + pg.split('?')[0]);
    await ctx.close();
  }
  await b.close();
})().catch(function (e) { console.error('FATAL', e); process.exit(2); });
