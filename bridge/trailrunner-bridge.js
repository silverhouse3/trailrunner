#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// TrailRunner Bridge v3.0 — gRPC + WebSocket bridge for NordicTrack X32i
//
// Runs on a PC connected via ADB to the treadmill.
// Controls speed/incline directly via glassos_service gRPC API (port 54321).
// Reads telemetry via gRPC streaming subscriptions + log file fallback.
//
// Architecture:
//   TrailRunner PWA (browser) ← WebSocket :4510 → this bridge
//     ↓ ADB port-forward (localhost:54321 → treadmill:54321)
//     ↓ gRPC with mTLS (testca CA, com.ifit.eriador client cert)
//   glassos_service on treadmill
//     ↓ FitPro USB → motor controller
//   Treadmill belt + incline motor
//
// Usage:
//   node trailrunner-bridge.js --adb --ip 192.168.100.54
//
// TrailRunner PWA connects to ws://localhost:4510
// ═══════════════════════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// ── Configuration ────────────────────────────────────────────────────────────

const PORT = 4510;
const APK_PORT = 4511;           // TrailRunnerBridge APK HTTP port (still used for UI automation)
const GRPC_PORT = 54321;         // glassos gRPC port (forwarded via ADB)
const LOG_POLL_MS = 500;         // Log poll interval (backup, gRPC streaming is primary)
const CONTROL_COOLDOWN_MS = 200; // Min delay between gRPC control commands

// glassos_service log paths (fallback telemetry)
const LOG_PATHS = [
  '/sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt',
  '/sdcard/Android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt',
  '/sdcard/.wolflogs/',
  '/sdcard/eru/',
];

// mTLS certificate paths
const KEYS_DIR = path.join(__dirname, 'keys');
const CA_CERT = path.join(KEYS_DIR, 'ca_cert.txt');
const CLIENT_CERT = path.join(KEYS_DIR, 'cert.txt');
const CLIENT_KEY = path.join(KEYS_DIR, 'key.txt');

// Proto files root
const PROTOS_DIR = path.join(__dirname, 'protos');

// ── State ────────────────────────────────────────────────────────────────────

let currentSpeed = 0;        // km/h
let currentIncline = 0;      // %
let currentHR = 0;
let currentWatts = 0;
let currentRPM = 0;
let workoutState = 'IDLE';   // IDLE, DMK, RUNNING, PAUSED, RESULTS
let workoutId = null;
let lastControlTime = 0;
let logPath = null;
let logFileSize = 0;
let adbMode = false;
let adbIP = '192.168.100.54';
let wsClients = new Set();

// gRPC state
let grpcConnected = false;
let speedClient = null;
let inclineClient = null;
let workoutClient = null;
let speedStream = null;
let inclineStream = null;
let workoutStateStream = null;
let grpcReconnectTimer = null;

// APK state (still used for navigation/UI automation)
let apkAvailable = false;

// WebSocket implementation
let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch {
  WebSocketServer = null;
}

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--adb')) adbMode = true;
const ipIdx = args.indexOf('--ip');
if (ipIdx !== -1 && args[ipIdx + 1]) adbIP = args[ipIdx + 1];
const portIdx = args.indexOf('--port');
const listenPort = (portIdx !== -1 && args[portIdx + 1]) ? parseInt(args[portIdx + 1]) : PORT;

// ── Shell command helper ────────────────────────────────────────────────────

function shell(cmd) {
  return new Promise((resolve, reject) => {
    const prefix = adbMode ? `adb -s ${adbIP}:5555 shell ` : '';
    exec(prefix + cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout || '').trim());
    });
  });
}

function adbExec(cmd) {
  return new Promise((resolve, reject) => {
    exec(`adb ${cmd}`, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve((stdout || '').trim());
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// gRPC CLIENT — Direct motor control via glassos_service
// ═══════════════════════════════════════════════════════════════════════════════

function loadProto(protoFile) {
  const packageDefinition = protoLoader.loadSync(protoFile, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTOS_DIR],
  });
  return grpc.loadPackageDefinition(packageDefinition);
}

function createGrpcCredentials() {
  const caCert = fs.readFileSync(CA_CERT);
  const clientCert = fs.readFileSync(CLIENT_CERT);
  const clientKey = fs.readFileSync(CLIENT_KEY);

  return grpc.credentials.createSsl(caCert, clientKey, clientCert);
}

function createGrpcClient(ServiceClass, address) {
  const creds = createGrpcCredentials();

  // Add the client_id metadata to every call
  const metadataInterceptor = (options, nextCall) => {
    return new grpc.InterceptingCall(nextCall(options), {
      start: (metadata, listener, next) => {
        metadata.set('client_id', 'com.ifit.eriador');
        next(metadata, listener);
      },
    });
  };

  return new ServiceClass(address, creds, {
    interceptors: [metadataInterceptor],
    'grpc.keepalive_time_ms': 10000,
    'grpc.keepalive_timeout_ms': 5000,
    'grpc.keepalive_permit_without_calls': 1,
  });
}

async function connectGrpc() {
  console.log('[gRPC] Connecting to glassos_service at localhost:' + GRPC_PORT + '...');

  try {
    // Load proto definitions
    const speedProto = loadProto('workout/SpeedService.proto');
    const inclineProto = loadProto('workout/InclineService.proto');
    const workoutProto = loadProto('workout/WorkoutService.proto');

    const address = `localhost:${GRPC_PORT}`;

    // Create clients
    speedClient = createGrpcClient(speedProto.com.ifit.glassos.SpeedService, address);
    inclineClient = createGrpcClient(speedProto.com.ifit.glassos.InclineService || inclineProto.com.ifit.glassos.InclineService, address);
    workoutClient = createGrpcClient(workoutProto.com.ifit.glassos.WorkoutService, address);

    // Test connection with GetWorkoutState
    const state = await grpcCall(workoutClient, 'GetWorkoutState', {});
    workoutState = (state.workoutState || 'UNKNOWN').replace('WORKOUT_STATE_', '');
    console.log(`[gRPC] Connected! Workout state: ${workoutState}`);
    grpcConnected = true;

    // Start streaming subscriptions
    startSpeedSubscription();
    startInclineSubscription();
    startWorkoutStateSubscription();

    // Get initial speed/incline
    try {
      const speed = await grpcCall(speedClient, 'GetSpeed', {});
      if (speed.lastKph !== undefined) {
        currentSpeed = speed.lastKph;
        console.log(`[gRPC] Current speed: ${currentSpeed} kph`);
      }
    } catch {}

    try {
      const incline = await grpcCall(inclineClient, 'GetIncline', {});
      if (incline.lastInclinePercent !== undefined) {
        currentIncline = incline.lastInclinePercent;
        console.log(`[gRPC] Current incline: ${currentIncline}%`);
      }
    } catch {}

    broadcastState();

  } catch (e) {
    console.error(`[gRPC] Connection failed: ${e.message}`);
    grpcConnected = false;
    scheduleGrpcReconnect();
  }
}

function grpcCall(client, method, request) {
  return new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata();
    metadata.set('client_id', 'com.ifit.eriador');

    client[method](request, metadata, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function scheduleGrpcReconnect() {
  if (grpcReconnectTimer) return;
  console.log('[gRPC] Will retry connection in 5 seconds...');
  grpcReconnectTimer = setTimeout(() => {
    grpcReconnectTimer = null;
    connectGrpc();
  }, 5000);
}

// ── gRPC Streaming Subscriptions ─────────────────────────────────────────────

function startSpeedSubscription() {
  if (speedStream) {
    try { speedStream.cancel(); } catch {}
  }

  const metadata = new grpc.Metadata();
  metadata.set('client_id', 'com.ifit.eriador');

  speedStream = speedClient.SpeedSubscription({}, metadata);

  speedStream.on('data', (metric) => {
    if (metric.lastKph !== undefined) {
      const newSpeed = Math.round(metric.lastKph * 10) / 10;
      if (newSpeed !== currentSpeed) {
        currentSpeed = newSpeed;
        console.log(`[gRPC] Speed: ${currentSpeed} kph`);
        broadcastState();
      }
    }
  });

  speedStream.on('error', (err) => {
    if (err.code !== grpc.status.CANCELLED) {
      console.error(`[gRPC] Speed stream error: ${err.message}`);
      grpcConnected = false;
      scheduleGrpcReconnect();
    }
  });

  speedStream.on('end', () => {
    console.log('[gRPC] Speed stream ended');
  });

  console.log('[gRPC] Speed subscription active');
}

function startInclineSubscription() {
  if (inclineStream) {
    try { inclineStream.cancel(); } catch {}
  }

  const metadata = new grpc.Metadata();
  metadata.set('client_id', 'com.ifit.eriador');

  inclineStream = inclineClient.InclineSubscription({}, metadata);

  inclineStream.on('data', (metric) => {
    if (metric.lastInclinePercent !== undefined) {
      const newIncline = Math.round(metric.lastInclinePercent * 10) / 10;
      if (newIncline !== currentIncline) {
        currentIncline = newIncline;
        console.log(`[gRPC] Incline: ${currentIncline}%`);
        broadcastState();
      }
    }
  });

  inclineStream.on('error', (err) => {
    if (err.code !== grpc.status.CANCELLED) {
      console.error(`[gRPC] Incline stream error: ${err.message}`);
    }
  });

  inclineStream.on('end', () => {
    console.log('[gRPC] Incline stream ended');
  });

  console.log('[gRPC] Incline subscription active');
}

function startWorkoutStateSubscription() {
  if (workoutStateStream) {
    try { workoutStateStream.cancel(); } catch {}
  }

  const metadata = new grpc.Metadata();
  metadata.set('client_id', 'com.ifit.eriador');

  workoutStateStream = workoutClient.WorkoutStateChanged({}, metadata);

  workoutStateStream.on('data', (msg) => {
    if (msg.workoutState) {
      const newState = msg.workoutState.replace('WORKOUT_STATE_', '');
      if (newState !== workoutState) {
        workoutState = newState;
        console.log(`[gRPC] Workout state: ${workoutState}`);
        broadcastState();
      }
    }
  });

  workoutStateStream.on('error', (err) => {
    if (err.code !== grpc.status.CANCELLED) {
      console.error(`[gRPC] Workout state stream error: ${err.message}`);
    }
  });

  workoutStateStream.on('end', () => {
    console.log('[gRPC] Workout state stream ended');
  });

  console.log('[gRPC] Workout state subscription active');
}

// ── gRPC Motor Control Commands ──────────────────────────────────────────────

async function grpcSetSpeed(kph) {
  if (!grpcConnected || !speedClient) {
    console.warn(`[gRPC] Not connected, cannot set speed=${kph}`);
    return false;
  }

  try {
    const result = await grpcCall(speedClient, 'SetSpeed', { kph: kph });
    console.log(`[gRPC] SetSpeed(${kph} kph) → ${JSON.stringify(result)}`);
    return true;
  } catch (e) {
    console.error(`[gRPC] SetSpeed error: ${e.message}`);
    return false;
  }
}

async function grpcSetIncline(percent) {
  if (!grpcConnected || !inclineClient) {
    console.warn(`[gRPC] Not connected, cannot set incline=${percent}`);
    return false;
  }

  try {
    const result = await grpcCall(inclineClient, 'SetIncline', { percent: percent });
    console.log(`[gRPC] SetIncline(${percent}%) → ${JSON.stringify(result)}`);
    return true;
  } catch (e) {
    console.error(`[gRPC] SetIncline error: ${e.message}`);
    return false;
  }
}

async function grpcStartWorkout() {
  if (!grpcConnected || !workoutClient) {
    console.warn('[gRPC] Not connected, cannot start workout');
    return { ok: false, error: 'gRPC not connected' };
  }

  try {
    const result = await grpcCall(workoutClient, 'StartNewWorkout', {});
    workoutId = result.workoutID || null;
    console.log(`[gRPC] StartNewWorkout → id=${workoutId}, result=${JSON.stringify(result)}`);
    workoutState = 'RUNNING';
    broadcastState();
    return { ok: true, workoutId };
  } catch (e) {
    console.error(`[gRPC] StartNewWorkout error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function grpcStopWorkout() {
  if (!grpcConnected || !workoutClient) {
    return { ok: false, error: 'gRPC not connected' };
  }

  try {
    const result = await grpcCall(workoutClient, 'Stop', {});
    console.log(`[gRPC] Stop → ${JSON.stringify(result)}`);
    workoutState = 'IDLE';
    broadcastState();
    return { ok: true };
  } catch (e) {
    console.error(`[gRPC] Stop error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function grpcPauseWorkout() {
  if (!grpcConnected || !workoutClient) {
    return { ok: false, error: 'gRPC not connected' };
  }

  try {
    const result = await grpcCall(workoutClient, 'Pause', {});
    console.log(`[gRPC] Pause → ${JSON.stringify(result)}`);
    workoutState = 'PAUSED';
    broadcastState();
    return { ok: true };
  } catch (e) {
    console.error(`[gRPC] Pause error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function grpcResumeWorkout() {
  if (!grpcConnected || !workoutClient) {
    return { ok: false, error: 'gRPC not connected' };
  }

  try {
    const result = await grpcCall(workoutClient, 'Resume', {});
    console.log(`[gRPC] Resume → ${JSON.stringify(result)}`);
    workoutState = 'RUNNING';
    broadcastState();
    return { ok: true };
  } catch (e) {
    console.error(`[gRPC] Resume error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Control queue (rate-limited gRPC commands) ────────────────────────────────

let controlQueue = [];
let processingControl = false;

async function queueControl(type, value) {
  // Replace any pending command of the same type (only latest matters)
  controlQueue = controlQueue.filter(c => c.type !== type);
  controlQueue.push({ type, value, time: Date.now() });
  if (!processingControl) processControlQueue();
}

async function processControlQueue() {
  if (controlQueue.length === 0) {
    processingControl = false;
    return;
  }
  processingControl = true;

  const cmd = controlQueue.shift();
  const now = Date.now();
  const elapsed = now - lastControlTime;

  if (elapsed < CONTROL_COOLDOWN_MS) {
    await sleep(CONTROL_COOLDOWN_MS - elapsed);
  }

  try {
    if (cmd.type === 'speed') {
      await grpcSetSpeed(cmd.value);
    } else if (cmd.type === 'incline') {
      await grpcSetIncline(cmd.value);
    }
    lastControlTime = Date.now();
  } catch (e) {
    console.error(`[BRIDGE] Control error: ${e.message}`);
  }

  setTimeout(processControlQueue, 50);
}

// ═══════════════════════════════════════════════════════════════════════════════
// APK HTTP BRIDGE — Still used for UI automation (tap, back, etc.)
// ═══════════════════════════════════════════════════════════════════════════════

function apkCommand(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const options = {
      hostname: adbIP,
      port: APK_PORT,
      path: endpoint,
      method: body ? 'POST' : 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      } : {},
      timeout: 3000,
    };

    const req = http.request(options, (res) => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(result)); }
        catch { resolve({ raw: result }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function checkApk() {
  try {
    const result = await apkCommand('/ping');
    apkAvailable = result.ok && result.service;
    return apkAvailable;
  } catch {
    apkAvailable = false;
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOG FILE READER — Fallback telemetry when gRPC streaming isn't available
// ═══════════════════════════════════════════════════════════════════════════════

async function findLogPath() {
  for (const p of LOG_PATHS) {
    try {
      const result = await shell(`ls "${p}" 2>/dev/null`);
      if (result) {
        if (p.endsWith('/')) {
          const files = await shell(`ls -t "${p}" 2>/dev/null | head -1`);
          if (files) return p + files;
        } else {
          return p;
        }
      }
    } catch {}
  }
  return null;
}

async function readNewLogLines() {
  if (!logPath) return;

  try {
    const stat = await shell(`stat -c %s "${logPath}" 2>/dev/null || wc -c < "${logPath}"`);
    const size = parseInt(stat);
    if (isNaN(size)) return;

    if (size > logFileSize && logFileSize > 0) {
      const skipBytes = logFileSize;
      const newBytes = size - logFileSize;
      const maxRead = Math.min(newBytes, 8192);
      const data = await shell(
        `dd if="${logPath}" bs=1 skip=${skipBytes} count=${maxRead} 2>/dev/null`
      );
      if (data) parseLogLines(data);
    } else if (logFileSize === 0) {
      const data = await shell(`tail -20 "${logPath}" 2>/dev/null`);
      if (data) parseLogLines(data);
    }

    logFileSize = size > logFileSize ? size : (size < logFileSize ? size : logFileSize);
  } catch {}
}

function parseLogLines(text) {
  const lines = text.split('\n');
  let changed = false;

  for (const line of lines) {
    // Speed: "SDS Changed KPH from 1.6 kph to 1.93 kph"
    if (line.includes('Changed KPH')) {
      const m = line.match(/to\s+([\d.]+)\s*kph/i);
      if (m) {
        const val = parseFloat(m[1]);
        if (!isNaN(val) && val >= 0 && val <= 25) {
          // Only update from logs if gRPC isn't providing data
          if (!grpcConnected) { currentSpeed = val; changed = true; }
        }
      }
    }
    else if (line.includes('Changed INCLINE')) {
      const m = line.match(/to\s+(-?[\d.]+)\s*%/);
      if (m) {
        const val = parseFloat(m[1]);
        if (!isNaN(val) && val >= -6 && val <= 40) {
          if (!grpcConnected) { currentIncline = val; changed = true; }
        }
      }
    }
    // Heart rate (gRPC doesn't provide HR — logs are the only source)
    else if (line.includes('HeartRateDataUpdate')) {
      const parts = line.trim().split(/\s+/);
      const val = parseInt(parts[parts.length - 1]);
      if (!isNaN(val) && val > 30 && val < 250) {
        currentHR = val;
        changed = true;
      }
    }
    // Console state from logs (backup)
    else if (line.includes('Changed CONSOLE_STATE')) {
      const m = line.match(/to\s+(\w+)/);
      if (m && !grpcConnected) {
        console.log(`[LOG] Console state: ${m[1]}`);
      }
    }
    // SDS Console Basic Info (periodic full dump)
    else if (line.includes('Console Basic Info')) {
      const pulse = line.match(/Pulse:\s*([\d.]+)\s*bpm/);
      if (pulse) {
        const v = parseFloat(pulse[1]);
        if (!isNaN(v) && v > 0) { currentHR = v; changed = true; }
      }
      // Only use speed/incline from logs if gRPC not connected
      if (!grpcConnected) {
        const speed = line.match(/Speed:\s*([\d.]+)\s*kph/);
        const incline = line.match(/Incline:\s*(-?[\d.]+)\s*%/);
        if (speed) { const v = parseFloat(speed[1]); if (!isNaN(v)) { currentSpeed = v; changed = true; } }
        if (incline) { const v = parseFloat(incline[1]); if (!isNaN(v)) { currentIncline = v; changed = true; } }
      }
    }
    // Physical button presses (always log these)
    else if (line.includes('Changed KEY_OBJECT') && line.includes('code=STOP')) {
      console.log('[LOG] STOP button pressed on treadmill');
    }
  }

  if (changed) broadcastState();
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET BROADCAST + MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

function broadcastState() {
  const msg = JSON.stringify({
    type: 'stats',
    values: {
      KPH: currentSpeed.toFixed(1),
      Incline: currentIncline.toFixed(1),
      'Heart Rate': currentHR.toString(),
      Watts: currentWatts.toString(),
      RPM: currentRPM.toString(),
    },
    workout: {
      state: workoutState,
      id: workoutId,
      grpc: grpcConnected,
    },
  });

  for (const client of wsClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch {}
  }
}

async function handleClientMessage(data) {
  try {
    const msg = JSON.parse(data);
    if (!msg) return;

    // Current state request
    if (msg.type === 'get') {
      broadcastState();
      return;
    }

    // Speed/incline control
    if (msg.type === 'set' && msg.values) {
      const v = msg.values;

      if (v.MPH !== undefined) {
        const kph = parseFloat(v.MPH) * 1.60934;
        queueControl('speed', Math.max(0, Math.min(22, kph)));
      } else if (v.KPH !== undefined) {
        queueControl('speed', Math.max(0, Math.min(22, parseFloat(v.KPH))));
      }

      if (v.Incline !== undefined) {
        queueControl('incline', Math.max(-6, Math.min(40, parseFloat(v.Incline))));
      } else if (v.Grade !== undefined) {
        queueControl('incline', Math.max(-6, Math.min(40, parseFloat(v.Grade))));
      }
      return;
    }

    // Workout lifecycle commands
    if (msg.type === 'workout') {
      let result;
      switch (msg.action) {
        case 'start':
          result = await grpcStartWorkout();
          break;
        case 'stop':
          result = await grpcStopWorkout();
          break;
        case 'pause':
          result = await grpcPauseWorkout();
          break;
        case 'resume':
          result = await grpcResumeWorkout();
          break;
        default:
          result = { ok: false, error: 'Unknown workout action: ' + msg.action };
      }

      // Send result back to the client that requested it
      const response = JSON.stringify({ type: 'workout_result', action: msg.action, ...result });
      for (const client of wsClients) {
        try { if (client.readyState === 1) client.send(response); } catch {}
      }
      return;
    }

    // APK commands (UI automation — tap, swipe, back, etc.)
    if (msg.type === 'apk') {
      try {
        const result = await apkCommand(msg.endpoint, msg.body);
        const response = JSON.stringify({ type: 'apk_result', endpoint: msg.endpoint, ...result });
        for (const client of wsClients) {
          try { if (client.readyState === 1) client.send(response); } catch {}
        }
      } catch (e) {
        console.error(`[BRIDGE] APK command error: ${e.message}`);
      }
      return;
    }

  } catch (e) {
    console.error(`[BRIDGE] Message parse error: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP + WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════════════════════════════

function startServer() {
  const server = http.createServer((req, res) => {
    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({
        status: 'ok',
        version: '3.0',
        speed: currentSpeed,
        incline: currentIncline,
        hr: currentHR,
        workoutState,
        workoutId,
        grpc: grpcConnected,
        apk: apkAvailable,
        logPath,
        clients: wsClients.size,
      }));
      return;
    }

    // Current state (HTTP polling fallback)
    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({
        type: 'stats',
        values: {
          KPH: currentSpeed.toFixed(1),
          Incline: currentIncline.toFixed(1),
          'Heart Rate': currentHR.toString(),
        },
        workout: {
          state: workoutState,
          id: workoutId,
          grpc: grpcConnected,
        },
      }));
      return;
    }

    // HTTP command endpoint (POST)
    if (req.url === '/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        handleClientMessage(body);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end('{"ok":true}');
      });
      return;
    }

    // Workout control endpoints (REST-style for easy testing)
    if (req.url === '/workout/start' && req.method === 'POST') {
      grpcStartWorkout().then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(result));
      });
      return;
    }

    if (req.url === '/workout/stop' && req.method === 'POST') {
      grpcStopWorkout().then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(result));
      });
      return;
    }

    if (req.url === '/workout/pause' && req.method === 'POST') {
      grpcPauseWorkout().then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(result));
      });
      return;
    }

    if (req.url === '/workout/resume' && req.method === 'POST') {
      grpcResumeWorkout().then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(result));
      });
      return;
    }

    // Set speed (REST endpoint for testing: POST /speed {"kph": 5.0})
    if (req.url === '/speed' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { kph, mph } = JSON.parse(body);
          const targetKph = kph || (mph * 1.60934);
          await queueControl('speed', Math.max(0, Math.min(22, targetKph)));
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, kph: targetKph }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // Set incline (REST endpoint for testing: POST /incline {"percent": 5.0})
    if (req.url === '/incline' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { percent } = JSON.parse(body);
          await queueControl('incline', Math.max(-6, Math.min(40, percent)));
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: true, percent }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('TrailRunner Bridge v3.0');
  });

  // WebSocket
  if (WebSocketServer) {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      console.log('[BRIDGE] Client connected');
      wsClients.add(ws);
      broadcastState();

      ws.on('message', (data) => handleClientMessage(data.toString()));
      ws.on('close', () => {
        wsClients.delete(ws);
        console.log('[BRIDGE] Client disconnected');
      });
    });
  } else {
    // Minimal built-in WebSocket upgrade (RFC 6455)
    const crypto = require('crypto');
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }

      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-5AB5A0F6CE10')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );

      const client = new MinimalWSClient(socket);
      wsClients.add(client);
      console.log('[BRIDGE] Client connected (built-in WS)');
      broadcastState();

      socket.on('data', (buf) => {
        const msg = decodeWSFrame(buf);
        if (msg !== null) handleClientMessage(msg);
      });

      socket.on('close', () => {
        wsClients.delete(client);
        console.log('[BRIDGE] Client disconnected');
      });

      socket.on('error', () => {
        wsClients.delete(client);
      });
    });
  }

  server.listen(listenPort, '0.0.0.0', () => {
    console.log(`[BRIDGE] TrailRunner Bridge listening on port ${listenPort}`);
  });
}

// ── Minimal WebSocket helpers (no dependency) ───────────────────────────────

class MinimalWSClient {
  constructor(socket) {
    this.socket = socket;
    this.readyState = 1;
    socket.on('close', () => { this.readyState = 3; });
    socket.on('error', () => { this.readyState = 3; });
  }

  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {}
  }
}

function decodeWSFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x08) return null;
  if (opcode !== 0x01) return null;

  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + payloadLen) return null;
  const payload = buf.slice(offset, offset + payloadLen);

  if (mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i & 3];
    }
  }

  return payload.toString('utf8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║  TrailRunner Bridge v3.0                                     ║');
  console.log('  ║  Direct Motor Control via gRPC + WebSocket                   ║');
  console.log('  ║  NordicTrack X32i — glassos_service API                      ║');
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // 1. Connect ADB
  if (adbMode) {
    console.log(`[ADB] Connecting to ${adbIP}:5555 ...`);
    try {
      const result = await adbExec(`connect ${adbIP}:5555`);
      console.log(`[ADB] ${result}`);
    } catch (e) {
      console.error(`[ADB] Connection failed: ${e.message}`);
      process.exit(1);
    }

    // 2. Port-forward gRPC (treadmill:54321 → localhost:54321)
    console.log('[ADB] Setting up port forward for gRPC...');
    try {
      await adbExec(`-s ${adbIP}:5555 forward tcp:${GRPC_PORT} tcp:${GRPC_PORT}`);
      console.log(`[ADB] Port forward: localhost:${GRPC_PORT} → treadmill:${GRPC_PORT}`);
    } catch (e) {
      console.error(`[ADB] Port forward failed: ${e.message}`);
      console.error('[ADB] gRPC control will not be available');
    }
  }

  // 3. Connect gRPC
  await connectGrpc();

  // 4. Find log file (backup telemetry)
  console.log('[LOG] Searching for glassos_service logs...');
  logPath = await findLogPath();
  if (logPath) {
    console.log(`[LOG] Found: ${logPath}`);
  } else {
    console.warn('[LOG] No log file found (HR data will not be available)');
  }

  // 5. Check APK bridge (still used for UI automation)
  console.log(`[APK] Checking bridge at ${adbIP}:${APK_PORT}...`);
  const apkOk = await checkApk();
  if (apkOk) {
    console.log('[APK] Bridge: OK');
  } else {
    console.log('[APK] Bridge: not available (UI automation disabled)');
  }

  // 6. Start WebSocket server
  startServer();

  // 7. Periodic tasks
  setInterval(checkApk, 30000);           // APK health check every 30s
  if (logPath) {
    setInterval(readNewLogLines, LOG_POLL_MS); // Log polling (for HR + backup)
    await readNewLogLines();
  }
  setInterval(broadcastState, 2000);       // State broadcast every 2s

  console.log('');
  console.log('[BRIDGE] ══════════════════════════════════════════');
  console.log(`[BRIDGE] Ready! PWA: ws://localhost:${listenPort}`);
  console.log(`[BRIDGE] gRPC: ${grpcConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
  console.log(`[BRIDGE] APK:  ${apkAvailable ? 'AVAILABLE' : 'NOT AVAILABLE'}`);
  console.log(`[BRIDGE] Logs: ${logPath ? 'ACTIVE' : 'NONE'}`);
  console.log('[BRIDGE] ══════════════════════════════════════════');
  console.log('');
  console.log('[BRIDGE] REST API for testing:');
  console.log(`  POST http://localhost:${listenPort}/workout/start`);
  console.log(`  POST http://localhost:${listenPort}/workout/stop`);
  console.log(`  POST http://localhost:${listenPort}/speed    {"kph": 5.0}`);
  console.log(`  POST http://localhost:${listenPort}/incline  {"percent": 3.0}`);
  console.log(`  GET  http://localhost:${listenPort}/health`);
  console.log(`  GET  http://localhost:${listenPort}/state`);
  console.log('');
}

main().catch(e => {
  console.error('[BRIDGE] Fatal:', e);
  process.exit(1);
});
