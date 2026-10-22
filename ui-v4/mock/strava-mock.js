#!/usr/bin/env node
// Mock of the Strava v3 endpoints TrailRunner uses. Node built-ins only.
//   node mock/strava-mock.js            -> http://localhost:8098   (PORT=… to change)
// Client override:  open the app with  ?strava=localhost:8098
//
// Endpoints (same shapes as Strava):
//   POST /oauth/token                    authorization_code + refresh_token (rotating refresh tokens)
//   GET  /oauth/authorize                302 back to redirect_uri?code=mockcode (manual dev)
//   GET  /api/v3/athlete
//   GET  /api/v3/athlete/activities      ?page&per_page  (newest first; Run/TrailRun/Ride/Walk mix)
//   GET  /api/v3/activities/:id/streams  ?keys&key_by_type=true
//   GET  /api/v3/athletes/:id/routes
//   GET  /api/v3/routes/:id/streams      (array form, as Strava returns for routes)
//   POST /api/v3/uploads  (multipart)    GET /api/v3/uploads/:id  (processing for ~2.5 s, then activity_id)
// Mock control (not Strava):
//   POST /mock/fault {kind:'429'|'401'|'upload500'|'upload_error', count:n}
//   POST /mock/config {processingMs, tokenTtl}     POST /mock/expire     POST /mock/reset
//   GET  /mock/uploads   GET /mock/stats
// Data is deterministic (seeded PRNG). Course "Cleeve Hill Loop" (14.2 km, ~700 m gain, pitches >20 %)
// has 4 matching activities with different pace profiles + 2 decoys (diverging variation, reversed).
'use strict';
var http = require('http');
var crypto = require('crypto');

// ── seeded PRNG ────────────────────────────────────────────────────────────
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(rnd) { return (rnd() + rnd() + rnd() + rnd() - 2) * 1.7; }   // ~N(0,1)

// ── geometry: closed loop courses in local metres → lat/lon ────────────────
var LAT0 = 51.9300, LON0 = -2.0000, M_LAT = 111320;
function toLL(x, y, lat0, lon0) { return [lat0 + y / M_LAT, lon0 + x / (M_LAT * Math.cos(lat0 * Math.PI / 180))]; }

/** Loop through the origin. opts {len, a1,a2,p1,p2, bulge:[th0,th1,amp]} -> {xy[], cum[], L} sampled by theta */
function makeLoop(opts) {
  var n = 3000, xy = [], cum = [0], i, R = 1000, best = null;
  function build(Rv) {
    var pts = [];
    for (i = 0; i <= n; i++) {
      var th = i / n * 2 * Math.PI;
      var r = Rv * (1 + opts.a1 * Math.sin(3 * th + opts.p1) + opts.a2 * Math.sin(5 * th + opts.p2));
      if (opts.bulge && th > opts.bulge[0] && th < opts.bulge[1]) {
        var u = (th - opts.bulge[0]) / (opts.bulge[1] - opts.bulge[0]); r *= 1 + opts.bulge[2] * Math.sin(Math.PI * u);
      }
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    var off = pts[0].slice();
    return pts.map(function (p) { return [p[0] - off[0], p[1] - off[1]]; });
  }
  function length(p) { var L = 0; for (var k = 1; k < p.length; k++) L += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]); return L; }
  if (opts.fixedR) { R = opts.fixedR; xy = build(R); } else {
    var L1 = length(build(1000)); R = 1000 * opts.len / L1; xy = build(R);
  }
  for (i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { xy: xy, cum: cum, L: cum[cum.length - 1], R: R };
}
function posAt(loop, s) {
  s = Math.max(0, Math.min(loop.L, s));
  var lo = 0, hi = loop.cum.length - 1;
  while (hi - lo > 1) { var m = (lo + hi) >> 1; if (loop.cum[m] <= s) lo = m; else hi = m; }
  var sp = loop.cum[hi] - loop.cum[lo], t = sp > 0 ? (s - loop.cum[lo]) / sp : 0;
  return [loop.xy[lo][0] + t * (loop.xy[hi][0] - loop.xy[lo][0]), loop.xy[lo][1] + t * (loop.xy[hi][1] - loop.xy[lo][1])];
}
function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }

// altitude models: f(s, L) -> metres
var ALT = {
  hilly: function (s, L) {
    var u = s / L, a = 300 + 112 * Math.sin(2 * Math.PI * 2 * u + 0.5) + 54 * Math.sin(2 * Math.PI * 4 * u) + 9 * Math.sin(2 * Math.PI * 11 * u);
    a += 35 * smooth((s - 0.15 * L) / 140) + 30 * smooth((s - 0.55 * L) / 120) - 30 * smooth((s - 0.70 * L) / 120) - 35 * smooth((s - 0.85 * L) / 150);
    return a;
  },
  flat: function (s, L) { return 60 + 3 * Math.sin(2 * Math.PI * 3 * s / L); },
  rolling: function (s, L) { var u = s / L; return 120 + 25 * Math.sin(2 * Math.PI * 3 * u) + 8 * Math.sin(2 * Math.PI * 9 * u); },
  reps: function (s, L) { var u = s / L; return 100 + 40 * Math.abs(Math.sin(Math.PI * 6 * u)); }
};

var BULGE = -0.13;
var CLEEVE = { len: 14200, a1: 0.22, a2: 0.10, p1: 0.4, p2: 1.1 };
var BASE_LOOP = makeLoop(CLEEVE);
// decoy 1: same start + similar length, but a big detour through the middle
var DECOY_LOOP = makeLoop({ fixedR: BASE_LOOP.R, a1: CLEEVE.a1, a2: CLEEVE.a2, p1: CLEEVE.p1, p2: CLEEVE.p2, bulge: [1.3, 3.4, BULGE] });

function reverseLoop(loop) {
  var xy = loop.xy.slice().reverse(), cum = [0];
  for (var i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { xy: xy, cum: cum, L: cum[cum.length - 1] };
}
var REV_LOOP = reverseLoop(BASE_LOOP);

// ── polyline encode ────────────────────────────────────────────────────────
function encodePolyline(pts) {
  var out = '', pl = 0, pg = 0;
  function enc(v) { v = v < 0 ? ~(v << 1) : (v << 1); var s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); }
  pts.forEach(function (p) { var la = Math.round(p[0] * 1e5), lo = Math.round(p[1] * 1e5); out += enc(la - pl) + enc(lo - pg); pl = la; pg = lo; });
  return out;
}

/**
 * Simulate one activity along a loop.
 * spec: {id,name,type,sport_type,date, loop, alt, v0, wob (speed wobble), stop:[s,seconds], seed, noiseM, distErr, lat0, lon0, trainer}
 */
function simulate(spec) {
  var rnd = mulberry32(spec.seed || spec.id), loop = spec.loop, L = loop.L, altf = ALT[spec.alt] || ALT.flat;
  var lat0 = spec.lat0 != null ? spec.lat0 : LAT0, lon0 = spec.lon0 != null ? spec.lon0 : LON0;
  var s = 0, t = 0, latlng = [], altitude = [], distance = [], time = [], vel = [], stopDone = false, movingS = 0;
  var distScale = 1 + (spec.distErr || 0), ph = rnd() * 6.28, noise = spec.noiseM != null ? spec.noiseM : 4;
  var jx = 0, jy = 0;
  while (s < L && t < 20000) {
    var a0 = altf(s, L), a1 = altf(Math.min(L, s + 20), L), g = (a1 - a0) / 20 * 100;
    var v = spec.v0 * (1 + (spec.wob || 0.08) * Math.sin(ph + s / 900));
    v = g > 0 ? v * Math.max(0.35, 1 - 0.045 * g) : v * Math.min(1.25, 1 + 0.012 * -g);
    v = Math.max(0.9, Math.min(6, v));
    if (spec.fade) v *= 1 - spec.fade * (s / L);
    if (spec.stop && !stopDone && s >= spec.stop[0]) {
      stopDone = true;
      for (var k = 0; k < spec.stop[1]; k++) {      // standing still: GPS jitter only
        var p0 = posAt(loop, s); jx = jx * 0.8 + gauss(rnd) * noise * 0.3; jy = jy * 0.8 + gauss(rnd) * noise * 0.3;
        latlng.push(toLL(p0[0] + jx, p0[1] + jy, lat0, lon0)); altitude.push(+(a0 + gauss(rnd) * 0.4).toFixed(1));
        distance.push(+(s * distScale).toFixed(1)); time.push(t); vel.push(0); t++;
      }
    }
    var p = posAt(loop, s); jx = jx * 0.7 + gauss(rnd) * noise * 0.6; jy = jy * 0.7 + gauss(rnd) * noise * 0.6;
    latlng.push(toLL(p[0] + jx, p[1] + jy, lat0, lon0).map(function (x) { return Math.round(x * 1e6) / 1e6; }));
    altitude.push(+(a0 + gauss(rnd) * 0.5).toFixed(1)); distance.push(+(s * distScale).toFixed(1)); time.push(t); vel.push(+v.toFixed(2));
    s += v; t++; movingS++;
  }
  // total elevation gain from 5-sample smoothed altitude
  var gain = 0, sm = altitude.map(function (_, i) { var a = 0, c = 0; for (var q = Math.max(0, i - 5); q <= Math.min(altitude.length - 1, i + 5); q++) { a += altitude[q]; c++; } return a / c; });
  for (var i = 1; i < sm.length; i++) if (sm[i] > sm[i - 1]) gain += sm[i] - sm[i - 1];
  var step = Math.max(1, Math.floor(latlng.length / 160)), simp = [];
  for (i = 0; i < latlng.length; i += step) simp.push(latlng[i]);
  return {
    streams: { latlng: latlng, altitude: altitude, distance: distance, time: time, velocity_smooth: vel,
      heartrate: vel.map(function (v) { return Math.round((spec.hr || 150) - 12 + v * 4); }) },
    summary: {
      id: spec.id, name: spec.name, type: spec.type || 'Run', sport_type: spec.sport_type || spec.type || 'Run',
      start_date: spec.date, start_date_local: spec.date.replace('Z', ''), distance: +distance[distance.length - 1].toFixed(1),
      moving_time: movingS, elapsed_time: t, total_elevation_gain: Math.round(gain), average_speed: +(distance[distance.length - 1] / movingS).toFixed(2),
      average_heartrate: spec.hr || 150, trainer: !!spec.trainer, manual: false, private: !!spec.priv,
      map: spec.trainer ? { id: 'a' + spec.id, summary_polyline: '', resource_state: 2 } : { id: 'a' + spec.id, summary_polyline: encodePolyline(simp), resource_state: 2 },
      athlete: { id: 4242 }
    }
  };
}

// ── the fake athlete's history (newest first) ──────────────────────────────
var ID0 = 9000000000;
var flatLoop5 = makeLoop({ len: 5000, a1: 0.12, a2: 0.05, p1: 2, p2: 0.3 });
var loop8 = makeLoop({ len: 8000, a1: 0.18, a2: 0.07, p1: 1, p2: 2 });
var loop7 = makeLoop({ len: 7000, a1: 0.1, a2: 0.1, p1: 0.2, p2: 0.9 });
var loop21 = makeLoop({ len: 21100, a1: 0.2, a2: 0.09, p1: 3, p2: 1 });
var loop3 = makeLoop({ len: 3100, a1: 0.1, a2: 0.04, p1: 0, p2: 0 });
var HOME = { lat0: 51.5, lon0: -0.12 };
var SPECS = [
  { id: ID0 + 1, name: 'Cleeve Hill Loop', type: 'Run', sport_type: 'TrailRun', date: '2026-10-18T07:30:00Z', loop: BASE_LOOP, alt: 'hilly', v0: 2.62, wob: 0.08, seed: 11, distErr: 0.004 },
  { id: ID0 + 2, name: 'Morning 5k', type: 'Run', date: '2026-10-16T06:40:00Z', loop: flatLoop5, alt: 'flat', v0: 3.2, seed: 12, lat0: HOME.lat0, lon0: HOME.lon0 },
  { id: ID0 + 3, name: 'Sunday ride', type: 'Ride', sport_type: 'Ride', date: '2026-10-15T09:00:00Z', loop: makeLoop({ len: 32000, a1: 0.1, a2: 0.05, p1: 1, p2: 1 }), alt: 'rolling', v0: 7.5, seed: 13 },
  { id: ID0 + 4, name: 'Cleeve Loop - fast day', type: 'Run', sport_type: 'TrailRun', date: '2026-10-11T07:15:00Z', loop: BASE_LOOP, alt: 'hilly', v0: 3.05, wob: 0.12, seed: 14, distErr: -0.012 },
  { id: ID0 + 5, name: 'Hill repeats', type: 'Run', date: '2026-10-09T17:30:00Z', loop: loop7, alt: 'reps', v0: 2.9, seed: 15, lat0: HOME.lat0, lon0: HOME.lon0 },
  { id: ID0 + 6, name: 'Easy 8k', type: 'Run', date: '2026-10-07T06:50:00Z', loop: loop8, alt: 'rolling', v0: 2.9, seed: 16, lat0: HOME.lat0, lon0: HOME.lon0 },
  { id: ID0 + 7, name: 'Lunch walk', type: 'Walk', sport_type: 'Walk', date: '2026-10-05T12:10:00Z', loop: loop3, alt: 'flat', v0: 1.4, seed: 17, lat0: HOME.lat0, lon0: HOME.lon0 },
  { id: ID0 + 8, name: 'Cleeve Loop - steady, coffee stop', type: 'Run', sport_type: 'TrailRun', date: '2026-09-27T08:00:00Z', loop: BASE_LOOP, alt: 'hilly', v0: 2.55, wob: 0.15, stop: [6000, 90], seed: 18, distErr: 0.011, fade: 0.08 },
  { id: ID0 + 9, name: 'Cleeve Loop - slow recovery', type: 'Run', sport_type: 'TrailRun', date: '2026-09-14T09:10:00Z', loop: BASE_LOOP, alt: 'hilly', v0: 2.12, wob: 0.06, seed: 19, distErr: -0.006 },
  { id: ID0 + 10, name: 'Cleeve variation (detour)', type: 'Run', sport_type: 'TrailRun', date: '2026-09-10T07:40:00Z', loop: DECOY_LOOP, alt: 'hilly', v0: 2.6, seed: 20 },
  { id: ID0 + 11, name: 'Cleeve Loop backwards', type: 'Run', sport_type: 'TrailRun', date: '2026-09-06T07:40:00Z', loop: REV_LOOP, alt: 'hilly', v0: 2.5, seed: 21 },
  { id: ID0 + 12, name: 'Parkrun', type: 'Run', date: '2026-09-03T09:00:00Z', loop: flatLoop5, alt: 'flat', v0: 3.3, seed: 22, lat0: HOME.lat0, lon0: HOME.lon0 },
  { id: ID0 + 13, name: 'Long run 21k', type: 'Run', date: '2026-08-30T07:00:00Z', loop: loop21, alt: 'rolling', v0: 2.9, seed: 23, lat0: HOME.lat0, lon0: HOME.lon0 },
  { id: ID0 + 14, name: 'Treadmill 6k', type: 'Run', date: '2026-08-28T18:00:00Z', loop: makeLoop({ len: 6000, a1: 0.05, a2: 0.02, p1: 0, p2: 0 }), alt: 'flat', v0: 3.0, seed: 24, trainer: true }
];
var SIMS = {}, ACTS = [];
SPECS.forEach(function (sp) { var r = simulate(sp); SIMS[sp.id] = r; ACTS.push(r.summary); });

// saved routes (clean geometry, no GPS noise)
function routeStreams(loop, alt) {
  var ll = [], al = [], d = [];
  for (var s = 0; s <= loop.L; s += 20) { var p = posAt(loop, s); ll.push(toLL(p[0], p[1], LAT0, LON0).map(function (x) { return Math.round(x * 1e6) / 1e6; })); al.push(+(ALT[alt](s, loop.L)).toFixed(1)); d.push(+s.toFixed(1)); }
  return { latlng: ll, altitude: al, distance: d };
}
var ROUTES = [
  { id: 3300000001, id_str: '3300000001', name: 'Cleeve Hill Loop (saved)', type: 2, sub_type: 3, distance: BASE_LOOP.L, elevation_gain: 690, estimated_moving_time: 5800, loop: BASE_LOOP, alt: 'hilly' },
  { id: 3300000002, id_str: '3300000002', name: 'Riverside 10k', type: 2, sub_type: 1, distance: 10000, elevation_gain: 60, estimated_moving_time: 3300, loop: makeLoop({ len: 10000, a1: 0.1, a2: 0.04, p1: 2, p2: 1 }), alt: 'flat' },
  { id: 3300000003, id_str: '3300000003', name: 'Gran Fondo (ride)', type: 1, sub_type: 1, distance: 80000, elevation_gain: 900, estimated_moving_time: 9000, loop: makeLoop({ len: 80000, a1: 0.1, a2: 0.04, p1: 0, p2: 1 }), alt: 'rolling' }
];
ROUTES.forEach(function (r) {
  var sm = r.loop.xy.filter(function (_, i) { return i % 60 === 0; }).map(function (p) { return toLL(p[0], p[1], LAT0, LON0); });
  r.map = { id: 'r' + r.id, summary_polyline: encodePolyline(sm), resource_state: 2 };
});

// ── state ──────────────────────────────────────────────────────────────────
var S;
function reset() {
  S = { access: { 'mock_access_0': Date.now() / 1000 + 21600 }, currentAccess: 'mock_access_0', refresh: 'mock_refresh_0', n: 0,
    ttl: 21600, processingMs: 2500, faults: [], uploads: {}, uploadSeq: 7000000, stats: {}, readCalls: [], activitySeq: 9100000000, seenHashes: {}, seenExt: {} };
}
reset();

function newToken() {
  S.n++;
  var a = 'mock_access_' + S.n, exp = Math.floor(Date.now() / 1000) + S.ttl;
  S.access[a] = exp; S.currentAccess = a; S.refresh = 'mock_refresh_' + S.n;
  return { token_type: 'Bearer', access_token: a, refresh_token: S.refresh, expires_at: exp, expires_in: S.ttl,
    scope: 'read,read_all,activity:read_all,activity:write', athlete: { id: 4242, firstname: 'Soph', lastname: 'Mock' } };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Usage, X-ReadRateLimit-Limit, X-ReadRateLimit-Usage');
}
function send(res, code, obj, extra) {
  var body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  var h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (extra) for (var k in extra) h[k] = extra[k];
  res.writeHead(code, h); res.end(body);
}
function readBody(req) { return new Promise(function (resolve) { var c = []; req.on('data', function (d) { c.push(d); }); req.on('end', function () { resolve(Buffer.concat(c)); }); }); }

function parseMultipart(buf, ctype) {
  var m = /boundary=(.+)$/.exec(ctype || ''); if (!m) return null;
  var b = '--' + m[1].replace(/^"|"$/g, ''), text = buf.toString('latin1'), parts = text.split(b), out = { fields: {}, file: null, filename: null };
  parts.forEach(function (p) {
    var i = p.indexOf('\r\n\r\n'); if (i < 0) return;
    var head = p.slice(0, i), val = p.slice(i + 4).replace(/\r\n$/, '');
    var nm = /name="([^"]+)"/.exec(head); if (!nm) return;
    var fn = /filename="([^"]*)"/.exec(head);
    if (fn) { out.file = Buffer.from(val, 'latin1').toString('utf8'); out.filename = fn[1]; } else out.fields[nm[1]] = Buffer.from(val, 'latin1').toString('utf8');
  });
  return out;
}

function usageHeaders() {
  var now = Date.now(), win = Math.floor(now / 900000) * 900000;
  S.readCalls = S.readCalls.filter(function (t) { return t >= win; });
  return { 'X-RateLimit-Limit': '200,2000', 'X-RateLimit-Usage': S.readCalls.length + ',' + (S.stats.total || 0),
    'X-ReadRateLimit-Limit': '100,1000', 'X-ReadRateLimit-Usage': S.readCalls.length + ',' + (S.stats.total || 0) };
}

function handle(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  var u = new URL(req.url, 'http://x'), path = u.pathname, q = u.searchParams;
  var st = S.stats; st.total = (st.total || 0) + 1; st[req.method + ' ' + path.replace(/\d{6,}/g, ':id')] = (st[req.method + ' ' + path.replace(/\d{6,}/g, ':id')] || 0) + 1;

  // ── control
  if (path === '/mock/reset') { reset(); return send(res, 200, { ok: true }); }
  if (path === '/mock/stats') return send(res, 200, S.stats);
  if (path === '/mock/uploads') return send(res, 200, Object.keys(S.uploads).map(function (k) { return S.uploads[k]; }));
  if (path === '/mock/expire') { Object.keys(S.access).forEach(function (k) { S.access[k] = Math.floor(Date.now() / 1000) - 10; }); return send(res, 200, { ok: true }); }
  if (path === '/mock/info') return send(res, 200, { activities: ACTS.map(function (a) { return { id: a.id, name: a.name, sport_type: a.sport_type, distance: a.distance, gain: a.total_elevation_gain, moving: a.moving_time }; }), baseLoopM: Math.round(BASE_LOOP.L), decoyLoopM: Math.round(DECOY_LOOP.L), reverseLoopM: Math.round(REV_LOOP.L) });
  if (path === '/mock/fault' || path === '/mock/config') {
    return readBody(req).then(function (b) {
      var j = {}; try { j = JSON.parse(b.toString() || '{}'); } catch (e) {}
      if (path === '/mock/fault') S.faults.push({ kind: j.kind, count: j.count || 1 });
      else { if (j.processingMs != null) S.processingMs = j.processingMs; if (j.tokenTtl != null) S.ttl = j.tokenTtl; }
      send(res, 200, { ok: true, faults: S.faults });
    });
  }

  // ── oauth
  if (path === '/oauth/authorize') {
    var ru = q.get('redirect_uri') || '', sep = ru.indexOf('?') < 0 ? '?' : '&';
    res.writeHead(302, { Location: ru + sep + 'code=mockcode&scope=' + encodeURIComponent(q.get('scope') || '') + '&state=' + encodeURIComponent(q.get('state') || '') }); return res.end();
  }
  if (path === '/oauth/token' && req.method === 'POST') {
    return readBody(req).then(function (b) {
      var j = {}; try { j = JSON.parse(b.toString()); } catch (e) { new URLSearchParams(b.toString()).forEach(function (v, k) { j[k] = v; }); }
      if (j.grant_type === 'authorization_code' && j.code === 'mockcode') return send(res, 200, newToken());
      if (j.grant_type === 'refresh_token' && j.refresh_token === S.refresh) { var t = newToken(); delete t.athlete; return send(res, 200, t); }
      return send(res, 400, { message: 'Bad Request', errors: [{ resource: 'RefreshToken', field: 'refresh_token', code: 'invalid' }] });
    });
  }

  // ── API
  if (path.indexOf('/api/v3/') !== 0) return send(res, 404, { message: 'Not Found' });
  var tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  var exp = S.access[tok];
  if (!exp || exp < Date.now() / 1000) return send(res, 401, { message: 'Authorization Error', errors: [{ resource: 'Athlete', field: 'access_token', code: 'invalid' }] });
  // fault injection
  for (var i = 0; i < S.faults.length; i++) {
    var f = S.faults[i];
    if (f.kind === '429' || f.kind === '401') {
      if (--f.count <= 0) S.faults.splice(i, 1);
      if (f.kind === '429') return send(res, 429, { message: 'Rate Limit Exceeded', errors: [{ resource: 'Application', field: 'read rate limit', code: 'exceeded' }] }, { 'X-ReadRateLimit-Usage': '101,101', 'X-ReadRateLimit-Limit': '100,1000' });
      return send(res, 401, { message: 'Authorization Error', errors: [{ resource: 'Athlete', field: 'access_token', code: 'invalid' }] });
    }
  }
  var isUploadPost = req.method === 'POST' && path === '/api/v3/uploads';
  if (!isUploadPost) S.readCalls.push(Date.now());
  var uh = usageHeaders();
  var p = path.replace('/api/v3', ''), m;

  if (p === '/athlete') return send(res, 200, { id: 4242, firstname: 'Soph', lastname: 'Mock', resource_state: 3 }, uh);
  if (p === '/athlete/activities') {
    var page = +q.get('page') || 1, per = +q.get('per_page') || 30;
    return send(res, 200, ACTS.slice((page - 1) * per, page * per), uh);
  }
  if ((m = /^\/activities\/(\d+)\/streams$/.exec(p))) {
    var sim = SIMS[m[1]]; if (!sim) return send(res, 404, { message: 'Record Not Found' }, uh);
    var keys = (q.get('keys') || 'latlng,altitude,distance,time').split(','), keyed = q.get('key_by_type') === 'true', n = sim.streams.distance.length;
    var out = keyed ? {} : [];
    keys.forEach(function (k) {
      if (!sim.streams[k]) return;
      var o = { data: sim.streams[k], series_type: 'distance', original_size: n, resolution: 'high' };
      if (keyed) out[k] = o; else { o.type = k; out.push(o); }
    });
    return send(res, 200, out, uh);
  }
  if ((m = /^\/athletes\/(\d+)\/routes$/.exec(p))) {
    return send(res, 200, ROUTES.map(function (r) { return { id: r.id, id_str: r.id_str, name: r.name, type: r.type, sub_type: r.sub_type, distance: r.distance, elevation_gain: r.elevation_gain, estimated_moving_time: r.estimated_moving_time, map: r.map, private: true }; }), uh);
  }
  if ((m = /^\/routes\/(\d+)\/streams$/.exec(p))) {
    var rt = ROUTES.filter(function (r) { return String(r.id) === m[1]; })[0]; if (!rt) return send(res, 404, { message: 'Record Not Found' }, uh);
    var rs = routeStreams(rt.loop, rt.alt);
    return send(res, 200, [{ type: 'latlng', data: rs.latlng }, { type: 'distance', data: rs.distance }, { type: 'altitude', data: rs.altitude }], uh);
  }
  if (isUploadPost) {
    for (var j = 0; j < S.faults.length; j++) if (S.faults[j].kind === 'upload500') { if (--S.faults[j].count <= 0) S.faults.splice(j, 1); return send(res, 500, { message: 'Internal Server Error' }, uh); }
    return readBody(req).then(function (b) {
      var mp = parseMultipart(b, req.headers['content-type']);
      if (!mp || !mp.file) return send(res, 400, { message: 'Bad Request', errors: [{ resource: 'Upload', field: 'file', code: 'missing' }] }, uh);
      var id = ++S.uploadSeq, hash = crypto.createHash('sha1').update(mp.file).digest('hex'), ext = mp.fields.external_id || mp.filename;
      var up = { id: id, id_str: String(id), external_id: ext, created: Date.now(), fields: mp.fields, filename: mp.filename, file: mp.file, error: null, activity_id: null, final: null, auth: tok };
      if (/<Trackpoint>/.test(mp.file) === false) up.final = { error: 'The file is empty or malformed' };
      else if (S.seenHashes[hash] || S.seenExt[ext]) up.final = { error: mp.filename + ' duplicate of activity ' + (S.seenHashes[hash] || S.seenExt[ext]) };
      else {
        for (var k = 0; k < S.faults.length; k++) if (S.faults[k].kind === 'upload_error') { if (--S.faults[k].count <= 0) S.faults.splice(k, 1); up.final = { error: 'There was an error processing your activity.' }; }
        if (!up.final) { up.final = { activity_id: ++S.activitySeq }; S.seenHashes[hash] = S.activitySeq; S.seenExt[ext] = S.activitySeq; }
      }
      S.uploads[id] = up;
      send(res, 201, { id: id, id_str: String(id), external_id: ext, error: null, status: 'Your activity is being processed.', activity_id: null }, uh);
    });
  }
  if ((m = /^\/uploads\/(\d+)$/.exec(p))) {
    var u2 = S.uploads[m[1]]; if (!u2) return send(res, 404, { message: 'Record Not Found' }, uh);
    var done = Date.now() - u2.created >= S.processingMs;
    if (!done) return send(res, 200, { id: u2.id, id_str: String(u2.id), external_id: u2.external_id, error: null, status: 'Your activity is still being processed.', activity_id: null }, uh);
    if (u2.final.error) return send(res, 200, { id: u2.id, id_str: String(u2.id), external_id: u2.external_id, error: u2.final.error, status: 'There was an error processing your activity.', activity_id: null }, uh);
    return send(res, 200, { id: u2.id, id_str: String(u2.id), external_id: u2.external_id, error: null, status: 'Your activity is ready.', activity_id: u2.final.activity_id }, uh);
  }
  return send(res, 404, { message: 'Not Found' }, uh);
}

function start(port) {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) { try { handle(req, res); } catch (e) { res.writeHead(500); res.end(String(e)); } });
    srv.listen(port === undefined ? 8098 : port, '0.0.0.0', function () { resolve(srv); });
  });
}

module.exports = { start: start, reset: reset, ACTS: ACTS, BASE_LOOP: BASE_LOOP, DECOY_LOOP: DECOY_LOOP, REV_LOOP: REV_LOOP, SIMS: SIMS };
if (require.main === module) {
  start(parseInt(process.env.PORT || '8098', 10)).then(function (s) {
    console.log('[strava-mock] listening on :' + s.address().port + '  (open the app with ?strava=localhost:' + s.address().port + ')');
    console.log('[strava-mock] ' + ACTS.length + ' activities, base loop ' + Math.round(BASE_LOOP.L) + ' m, decoy ' + Math.round(DECOY_LOOP.L) + ' m');
  });
}
