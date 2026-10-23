#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// TrailRunner MOCK BRIDGE — simulates the X32i bridge REST + WebSocket API
// on port 4510 so the UI can be exercised with no treadmill attached.
//
// Node built-ins only (http, crypto, url). No npm install.
//
//   node mock/server.js            → listens on 0.0.0.0:4510
//   PORT=4511 node mock/server.js  → other port
//
// Implements (same shapes as bridge/grpc-bridge/main.go):
//   GET  /health                → {status, version, speed, incline, hr, workoutState, workoutId, grpc, mqtt, clients}
//   GET  /state                 → {type:'stats', values:{KPH,Incline,'Heart Rate',Distance,Calories,Elapsed,Elevation,Watts}, workout:{state,id,grpc,safetyKeyOut,consoleState}}
//   POST /workout/start|stop|pause|resume → {ok, workoutId?, error?}
//   POST /speed   {kph|mph}     → rejected unless RUNNING (like the real bridge)
//   POST /incline {percent}
//   POST /command {values:{'Fan Speed':n}}
//   POST /tts {text}            → logged
//   WS   /ws                    → broadcasts the /state message every 500ms
//
// Mock-only controls (also a tiny control page at GET /mock):
//   GET  /mock/state
//   POST /mock/safety-key {out:true|false}   → pull/replace the safety key
//   POST /mock/hr {bpm:n|null}               → force HR (null = simulated again)
//   POST /mock/reset
// ════════════════════════════════════════════════════════════════════════════

'use strict';
var http = require('http');
var crypto = require('crypto');
var url = require('url');

var PORT = parseInt(process.env.PORT || '4510', 10);
var HOST = process.env.HOST || '0.0.0.0';

// ── Simulated machine state ─────────────────────────────────────────────────
var sim = {
  workoutState: 'IDLE',   // IDLE | RUNNING | PAUSED
  workoutId: null,
  safetyKeyOut: false,
  consoleState: 'CONSOLE_STATE_IDLE',
  targetKph: 0,
  kph: 0,
  targetIncline: 0,
  incline: 0,
  hr: 68,
  hrOverride: null,
  distanceKm: 0,
  elapsedSec: 0,
  elevGainM: 0,
  calories: 0,
  watts: 0,
  fan: 0,
  lastTickMs: Date.now(),
  log: [],
  force: null,   // {state, consoleState, kph} reported-state override (mock/force), null = off
};

var MAX_KPH = 19.3;
var SPEED_RATE = 1.0;     // kph per second belt ramp (real bridge caps at 4 kph/s)
var INCLINE_RATE = 1.0;   // % per second ramp
var WEIGHT_KG = 72;

function log(msg) {
  var line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  console.log('[mock] ' + line);
  sim.log.push(line);
  if (sim.log.length > 50) sim.log.shift();
}

function tick() {
  var now = Date.now();
  var dt = Math.min(2, (now - sim.lastTickMs) / 1000);
  sim.lastTickMs = now;

  // Safety key out → belt stops immediately and the workout is dropped to IDLE
  if (sim.safetyKeyOut) {
    sim.targetKph = 0;
    sim.kph = 0;
    if (sim.workoutState !== 'IDLE') {
      sim.workoutState = 'IDLE';
      log('safety key out → workout dropped to IDLE');
    }
  }
  if (sim.workoutState !== 'RUNNING') sim.targetKph = 0;

  // Belt speed ramps towards target
  var ds = sim.targetKph - sim.kph;
  if (Math.abs(ds) <= SPEED_RATE * dt) sim.kph = sim.targetKph;
  else sim.kph += Math.sign(ds) * SPEED_RATE * dt;
  if (sim.kph < 0) sim.kph = 0;

  // Incline ramps towards target
  var di = sim.targetIncline - sim.incline;
  if (Math.abs(di) <= INCLINE_RATE * dt) sim.incline = sim.targetIncline;
  else sim.incline += Math.sign(di) * INCLINE_RATE * dt;

  // Distance / elapsed / elevation / calories only while RUNNING
  if (sim.workoutState === 'RUNNING') {
    sim.elapsedSec += dt;
    var dKm = sim.kph * dt / 3600;
    sim.distanceKm += dKm;
    if (sim.incline > 0) sim.elevGainM += dKm * 1000 * (sim.incline / 100);
    // ACSM-ish running METs → kcal
    var mets = sim.kph > 0 ? 1 + 0.2 * sim.kph * 3.6 / 3.6 * 2.9 / 2 + sim.incline * 0.25 : 1;
    sim.calories += mets * WEIGHT_KG * dt / 3600;
  }

  // Heart rate: drifts toward a target that depends on effort (speed + incline)
  var hrTarget = 68 + sim.kph * 7.5 + Math.max(0, sim.incline) * 2.2;
  if (hrTarget > 195) hrTarget = 195;
  var tau = sim.kph > 0 ? 25 : 40; // seconds
  sim.hr += (hrTarget - sim.hr) * (1 - Math.exp(-dt / tau));
  sim.hr += (Math.random() - 0.5) * 0.6;

  // Running power estimate (W)
  sim.watts = sim.kph > 0 ? Math.round(WEIGHT_KG * (sim.kph / 3.6) * (0.98 + Math.max(0, sim.incline) * 0.09)) : 0;
}

setInterval(tick, 250);

function stateMsg() {
  var hr = sim.hrOverride != null ? sim.hrOverride : Math.round(sim.hr);
  return {
    type: 'stats',
    values: {
      'KPH': (sim.force && sim.force.kph != null ? sim.force.kph : sim.kph).toFixed(1),
      'Incline': sim.incline.toFixed(1),
      'Heart Rate': String(hr),
      'Distance': sim.distanceKm.toFixed(3),
      'Calories': String(Math.round(sim.calories)),
      'Elapsed': String(Math.round(sim.elapsedSec)),
      'Elevation': sim.elevGainM.toFixed(1),
      'Watts': String(sim.watts),
    },
    workout: {
      state: sim.force && sim.force.state ? sim.force.state : sim.workoutState,
      id: sim.workoutId,
      grpc: true,
      safetyKeyOut: sim.safetyKeyOut,
      consoleState: sim.safetyKeyOut ? 'SAFETY_KEY_REMOVED' : (sim.force && sim.force.consoleState ? sim.force.consoleState : sim.consoleState),
    },
    mock: true,
  };
}

function health() {
  return {
    status: 'ok', version: 'mock-1.0',
    speed: +sim.kph.toFixed(1), incline: +sim.incline.toFixed(1), hr: Math.round(sim.hr),
    workoutState: sim.force && sim.force.state ? sim.force.state : sim.workoutState, workoutId: sim.workoutId,
    grpc: true, mqtt: false, clients: wsClients.length, mock: true,
  };
}

// ── Workout lifecycle ───────────────────────────────────────────────────────
function workoutAction(action) {
  if (sim.safetyKeyOut) return { ok: false, error: 'safety key removed' };
  if (action === 'start') {
    if (sim.workoutState === 'RUNNING') return { ok: true, workoutId: sim.workoutId, note: 'already running' };
    sim.workoutId = 'mock-' + Date.now().toString(36);
    sim.workoutState = 'RUNNING';
    sim.consoleState = 'CONSOLE_STATE_WORKOUT';
    sim.distanceKm = 0; sim.elapsedSec = 0; sim.elevGainM = 0; sim.calories = 0;
    log('workout START ' + sim.workoutId);
    return { ok: true, workoutId: sim.workoutId };
  }
  if (action === 'stop') {
    sim.workoutState = 'IDLE';
    sim.targetKph = 0;
    sim.consoleState = 'CONSOLE_STATE_IDLE';
    log('workout STOP');
    return { ok: true };
  }
  if (action === 'pause') {
    if (sim.workoutState !== 'RUNNING') return { ok: false, error: 'not running', state: sim.workoutState };
    sim.workoutState = 'PAUSED';
    sim.targetKph = 0;
    log('workout PAUSE');
    return { ok: true };
  }
  if (action === 'resume') {
    if (sim.workoutState !== 'PAUSED') return { ok: false, error: 'not paused', state: sim.workoutState };
    sim.workoutState = 'RUNNING';
    log('workout RESUME');
    return { ok: true };
  }
  return { ok: false, error: 'unknown action ' + action };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}
function sendJSON(res, obj, code) {
  cors(res);
  res.writeHead(code || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    var raw = Buffer.concat(chunks).toString('utf8');
    var obj = {};
    if (raw) { try { obj = JSON.parse(raw); } catch (e) { obj = { _parseError: e.message, _raw: raw }; } }
    cb(obj);
  });
}

var CONTROL_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock treadmill</title>' +
  '<style>body{font-family:system-ui,sans-serif;background:#0b0f17;color:#e6edf7;margin:0;padding:24px}h1{font-size:22px;margin:0 0 4px}p{color:#8a97ad;margin:0 0 20px}' +
  'button{font:inherit;font-size:18px;padding:16px 22px;margin:6px 8px 6px 0;border-radius:10px;border:2px solid #2a3450;background:#151c2b;color:#fff;cursor:pointer;min-width:160px}' +
  'button.red{border-color:#ff4d4d;background:#3a1212}button.green{border-color:#2ee6a6;background:#0f2a22}pre{background:#111826;padding:14px;border-radius:10px;font-size:15px;line-height:1.5;overflow:auto}' +
  '.row{margin-bottom:12px}</style></head><body><h1>Mock treadmill</h1><p>Port ' + PORT + ' · pretends to be the X32i bridge. Use these to poke the UI.</p>' +
  '<div class="row"><button class="red" onclick="post(\'/mock/safety-key\',{out:true})">PULL SAFETY KEY</button><button class="green" onclick="post(\'/mock/safety-key\',{out:false})">REPLACE KEY</button></div>' +
  '<div class="row"><button onclick="post(\'/mock/hr\',{bpm:95})">HR 95</button><button onclick="post(\'/mock/hr\',{bpm:140})">HR 140</button><button onclick="post(\'/mock/hr\',{bpm:172})">HR 172</button><button onclick="post(\'/mock/hr\',{bpm:null})">HR auto</button></div>' +
  '<div class="row"><button onclick="post(\'/workout/start\')">bridge START</button><button onclick="post(\'/workout/pause\')">bridge PAUSE</button><button onclick="post(\'/workout/resume\')">bridge RESUME</button><button class="red" onclick="post(\'/workout/stop\')">bridge STOP</button><button onclick="post(\'/mock/reset\')">RESET</button></div>' +
  '<pre id="s">…</pre><script>function post(p,b){fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(r=>r.json()).then(j=>console.log(p,j))}' +
  'setInterval(function(){fetch("/mock/state").then(r=>r.json()).then(j=>{document.getElementById("s").textContent=JSON.stringify(j,null,2)})},500)</script></body></html>';

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var path = u.pathname;
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (path === '/health') return sendJSON(res, health());
  if (path === '/state' || path === '/api/state') return sendJSON(res, stateMsg());
  if (path === '/mock' || path === '/mock/') { cors(res); res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(CONTROL_PAGE); }
  if (path === '/mock/state') return sendJSON(res, { sim: {
    workoutState: sim.workoutState, workoutId: sim.workoutId, safetyKeyOut: sim.safetyKeyOut,
    kph: +sim.kph.toFixed(2), targetKph: sim.targetKph, incline: +sim.incline.toFixed(2), targetIncline: sim.targetIncline,
    hr: Math.round(sim.hr), hrOverride: sim.hrOverride, distanceKm: +sim.distanceKm.toFixed(3), elapsedSec: Math.round(sim.elapsedSec),
    calories: Math.round(sim.calories), watts: sim.watts, fan: sim.fan, wsClients: wsClients.length }, log: sim.log.slice(-12) });
  if (path === '/api/console') return sendJSON(res, { console_state: sim.consoleState, safety_key_removed: sim.safetyKeyOut, model: 'MOCK X32i', max_kph: 19.3, max_incline_pct: 40, min_incline_pct: -6, mock: true }); // same keys as main.go /api/console

  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'POST only' }, 405);

  readBody(req, function (body) {
    var m = /^\/workout\/(start|stop|pause|resume)$/.exec(path);
    if (m) {
      var r = workoutAction(m[1]);
      broadcast(Object.assign({ type: 'workout_result', action: m[1] }, r));
      broadcast(stateMsg());
      return sendJSON(res, r);
    }
    if (path === '/speed') {
      var kph = parseFloat(body.kph);
      if (!(kph > 0) && body.mph > 0) kph = body.mph * 1.60934;
      if (isNaN(kph)) return sendJSON(res, { ok: false, error: 'bad kph' });
      if (kph > 0 && sim.workoutState !== 'RUNNING') return sendJSON(res, { ok: false, error: 'workout not running', state: sim.workoutState });
      if (sim.safetyKeyOut) return sendJSON(res, { ok: false, error: 'safety key removed' });
      sim.targetKph = Math.max(0, Math.min(MAX_KPH, kph));
      log('speed → ' + sim.targetKph.toFixed(1) + ' kph');
      return sendJSON(res, { ok: true, kph: sim.targetKph });
    }
    if (path === '/incline') {
      var pct = parseFloat(body.percent);
      if (isNaN(pct)) return sendJSON(res, { ok: false, error: 'bad percent' });
      sim.targetIncline = Math.max(-6, Math.min(40, Math.round(pct * 2) / 2));
      log('incline → ' + sim.targetIncline.toFixed(1) + ' %');
      return sendJSON(res, { ok: true, percent: sim.targetIncline });
    }
    if (path === '/command') {
      if (body.values && body.values['Fan Speed'] !== undefined) sim.fan = parseInt(body.values['Fan Speed'], 10) || 0;
      log('command ' + JSON.stringify(body.values || body));
      return sendJSON(res, { ok: true });
    }
    if (path === '/tts') { log('TTS: ' + (body.text || '')); return sendJSON(res, { ok: true }); }
    if (path === '/workout/program') { log('program (ignored by mock): ' + (body.title || '')); return sendJSON(res, { ok: false, error: 'mock does not run native programs' }); }
    if (path === '/webhook' || path === '/api/workout/summary') { log('summary posted'); return sendJSON(res, { ok: true }); }

    // mock controls
    if (path === '/mock/safety-key') {
      sim.safetyKeyOut = !!body.out;
      log('SAFETY KEY ' + (sim.safetyKeyOut ? 'OUT' : 'IN'));
      tick(); broadcast(stateMsg());
      return sendJSON(res, { ok: true, safetyKeyOut: sim.safetyKeyOut });
    }
    if (path === '/mock/hr') {
      sim.hrOverride = (body.bpm === null || body.bpm === undefined || body.bpm === '') ? null : parseInt(body.bpm, 10);
      if (sim.hrOverride != null) sim.hr = sim.hrOverride;
      log('HR override ' + sim.hrOverride);
      return sendJSON(res, { ok: true, hrOverride: sim.hrOverride });
    }
    if (path === '/mock/force') {   // body {state,consoleState,kph} to override what the bridge REPORTS; {} / {off:true} clears
      sim.force = (body.off || !(body.state || body.consoleState || body.kph != null)) ? null : { state: body.state || null, consoleState: body.consoleState || null, kph: body.kph != null ? +body.kph : null };
      log('FORCE ' + JSON.stringify(sim.force)); broadcast(stateMsg());
      return sendJSON(res, { ok: true, force: sim.force });
    }
    if (path === '/mock/reset') {
      sim.force = null;
      sim.workoutState = 'IDLE'; sim.workoutId = null; sim.safetyKeyOut = false; sim.targetKph = 0; sim.kph = 0;
      sim.targetIncline = 0; sim.incline = 0; sim.hr = 68; sim.hrOverride = null; sim.distanceKm = 0; sim.elapsedSec = 0;
      sim.elevGainM = 0; sim.calories = 0; log('RESET');
      return sendJSON(res, { ok: true });
    }
    sendJSON(res, { ok: false, error: 'not found ' + path }, 404);
  });
});

// ── Hand-rolled WebSocket (RFC 6455, text frames only, no extensions) ───────
var wsClients = [];

server.on('upgrade', function (req, socket) {
  if (url.parse(req.url).pathname !== '/ws' && url.parse(req.url).pathname !== '/') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy();
  }
  var key = req.headers['sec-websocket-key'];
  if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
  var accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  var client = { socket: socket, buf: Buffer.alloc(0) };
  wsClients.push(client);
  log('ws client connected (' + wsClients.length + ')');
  wsSend(client, JSON.stringify(stateMsg()));

  socket.on('data', function (chunk) {
    client.buf = Buffer.concat([client.buf, chunk]);
    while (true) {
      var f = decodeFrame(client.buf);
      if (!f) break;
      client.buf = client.buf.slice(f.total);
      if (f.opcode === 8) { try { socket.end(); } catch (e) {} return; }
      if (f.opcode === 9) { wsSendRaw(client, 10, f.payload); continue; }
      if (f.opcode === 1) {
        var msg = null; try { msg = JSON.parse(f.payload.toString('utf8')); } catch (e) {}
        if (msg) handleWSMessage(client, msg);
      }
    }
  });
  function drop() { var i = wsClients.indexOf(client); if (i >= 0) wsClients.splice(i, 1); }
  socket.on('close', drop); socket.on('error', drop); socket.on('end', drop);
});

function handleWSMessage(client, msg) {
  if (msg.type === 'get') return wsSend(client, JSON.stringify(stateMsg()));
  if (msg.type === 'set' && msg.values) {
    if (msg.values.KPH !== undefined) {
      var kph = parseFloat(msg.values.KPH);
      if (!(kph > 0) || (sim.workoutState === 'RUNNING' && !sim.safetyKeyOut)) sim.targetKph = Math.max(0, Math.min(MAX_KPH, kph || 0));
    }
    if (msg.values.MPH !== undefined && sim.workoutState === 'RUNNING') sim.targetKph = Math.max(0, Math.min(MAX_KPH, parseFloat(msg.values.MPH) * 1.60934));
    if (msg.values.Incline !== undefined) sim.targetIncline = Math.max(-6, Math.min(40, parseFloat(msg.values.Incline) || 0));
    if (msg.values['Fan Speed'] !== undefined) sim.fan = parseInt(msg.values['Fan Speed'], 10) || 0;
    return;
  }
  if (msg.type === 'workout' && msg.action) {
    var r = workoutAction(msg.action);
    broadcast(Object.assign({ type: 'workout_result', action: msg.action }, r));
  }
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  var b0 = buf[0], b1 = buf[1];
  var opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0, len = b1 & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  var maskKey = null;
  if (masked) { if (buf.length < off + 4) return null; maskKey = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  var payload = Buffer.from(buf.slice(off, off + len));
  if (masked) for (var i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  return { opcode: opcode, payload: payload, total: off + len };
}
function wsSendRaw(client, opcode, payload) {
  var len = payload.length, header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  try { client.socket.write(Buffer.concat([header, payload])); } catch (e) {}
}
function wsSend(client, text) { wsSendRaw(client, 1, Buffer.from(text, 'utf8')); }
function broadcast(obj) { var s = JSON.stringify(obj); for (var i = 0; i < wsClients.length; i++) wsSend(wsClients[i], s); }
setInterval(function () { if (wsClients.length) broadcast(stateMsg()); }, 500);

server.listen(PORT, HOST, function () {
  console.log('[mock] TrailRunner mock bridge listening on http://' + HOST + ':' + PORT + '  (control page: /mock)');
});
