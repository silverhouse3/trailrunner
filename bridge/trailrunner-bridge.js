#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// TrailRunner Bridge — WebSocket server for NordicTrack X32i hardware control
//
// Runs on the treadmill (in Termux) or on a PC connected via ADB.
// Reads speed/incline/HR from glassos_service log files.
// Writes speed/incline via `input swipe` on iFIT UI or via direct ADB.
//
// Usage (on treadmill via Termux):
//   npm install ws
//   node trailrunner-bridge.js
//
// Usage (on PC via ADB):
//   node trailrunner-bridge.js --adb --ip 192.168.100.54
//
// TrailRunner connects to ws://localhost:4510
// ═══════════════════════════════════════════════════════════════════════════════

const http = require('http');
const { exec, spawn } = require('child_process');

// ── Configuration ────────────────────────────────────────────────────────────

const PORT = 4510;
const LOG_POLL_MS = 200;       // How often to poll logs (ms)
const SWIPE_COOLDOWN_MS = 600; // Min delay between swipe commands
const ACTIVITY_SWITCH_MS = 300; // Delay after switching to iFIT

// glassos_service log paths (tried in order)
const LOG_PATHS = [
  '/sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt',
  '/sdcard/Android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt',
  '/sdcard/.wolflogs/',
  '/sdcard/eru/',
];

// X32i-specific swipe coordinates (from QZCompanion calibration data)
// Screen resolution: 2560x1440 (32" display)
const X32I = {
  speed: {
    x: 1845,
    y1: 927,           // Position at 2.0 km/h (start of slider)
    calcY: (kph) => Math.round(834.85 - (26.946 * kph)),
  },
  incline: {
    x: 76,
    y1: 881,            // Position at 0.0% (start of slider)
    calcY: (pct) => Math.round(734.07 - (12.297 * pct)),
  },
  swipeDuration: 200,   // ms
};

// ── State ────────────────────────────────────────────────────────────────────

let currentSpeed = 0;      // km/h
let currentIncline = 0;    // %
let currentHR = 0;
let currentWatts = 0;
let currentRPM = 0;
let lastSwipeTime = 0;
let logPath = null;
let logFileSize = 0;
let adbMode = false;
let adbIP = '192.168.100.54';
let wsClients = new Set();

// WebSocket implementation (minimal, no dependency required)
// Falls back to ws module if available
let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch {
  // Built-in minimal WebSocket server (no external dependency)
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

// ── Log reader ──────────────────────────────────────────────────────────────

async function findLogPath() {
  for (const p of LOG_PATHS) {
    try {
      const result = await shell(`ls "${p}" 2>/dev/null`);
      if (result) {
        // If it's a directory, find the latest log file in it
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
    // Get current file size
    const stat = await shell(`stat -c %s "${logPath}" 2>/dev/null || wc -c < "${logPath}"`);
    const size = parseInt(stat);
    if (isNaN(size)) return;

    if (size > logFileSize && logFileSize > 0) {
      // Read only the new bytes
      const skipBytes = logFileSize;
      const newBytes = size - logFileSize;
      const maxRead = Math.min(newBytes, 8192); // Cap at 8KB per read
      const data = await shell(
        `dd if="${logPath}" bs=1 skip=${skipBytes} count=${maxRead} 2>/dev/null`
      );
      if (data) parseLogLines(data);
    } else if (logFileSize === 0) {
      // First read — just get the last few lines
      const data = await shell(`tail -20 "${logPath}" 2>/dev/null`);
      if (data) parseLogLines(data);
    }

    // File might have been rotated (size decreased)
    logFileSize = size > logFileSize ? size : (size < logFileSize ? size : logFileSize);
  } catch {}
}

function parseLogLines(text) {
  const lines = text.split('\n');
  let changed = false;

  for (const line of lines) {
    // Speed: "Changed KPH 5.0" or "Kph changed 5.0"
    if (line.includes('Changed KPH') || line.includes('Kph changed')) {
      const parts = line.trim().split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (!isNaN(val) && val >= 0 && val <= 25) {
        currentSpeed = val;
        changed = true;
      }
    }
    // Incline: "Changed Grade 5.0" or "Grade changed 5.0"
    else if (line.includes('Changed Grade') || line.includes('Grade changed')) {
      const parts = line.trim().split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (!isNaN(val) && val >= -6 && val <= 40) {
        currentIncline = val;
        changed = true;
      }
    }
    // "Changed INCLINE 5.0"
    else if (line.includes('Changed INCLINE')) {
      const parts = line.trim().split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (!isNaN(val) && val >= -6 && val <= 40) {
        currentIncline = val;
        changed = true;
      }
    }
    // Heart rate: "HeartRateDataUpdate 152"
    else if (line.includes('HeartRateDataUpdate')) {
      const parts = line.trim().split(/\s+/);
      const val = parseInt(parts[parts.length - 1]);
      if (!isNaN(val) && val > 30 && val < 250) {
        currentHR = val;
        changed = true;
      }
    }
    // Watts: "Changed Watts 150"
    else if (line.includes('Changed Watts')) {
      const parts = line.trim().split(/\s+/);
      const val = parseInt(parts[parts.length - 1]);
      if (!isNaN(val) && val > 0) {
        currentWatts = val;
        changed = true;
      }
    }
    // RPM: "Changed RPM 80"
    else if (line.includes('Changed RPM')) {
      const parts = line.trim().split(/\s+/);
      const val = parseInt(parts[parts.length - 1]);
      if (!isNaN(val) && val >= 0) {
        currentRPM = val;
        changed = true;
      }
    }
  }

  if (changed) broadcastState();
}

// ── Speed/Incline control via input swipe ───────────────────────────────────

let swipeQueue = [];
let processingSwipe = false;

async function queueSwipe(type, value) {
  swipeQueue.push({ type, value, time: Date.now() });
  if (!processingSwipe) processSwipeQueue();
}

async function processSwipeQueue() {
  if (swipeQueue.length === 0) {
    processingSwipe = false;
    return;
  }
  processingSwipe = true;

  const cmd = swipeQueue.shift();
  const now = Date.now();
  const elapsed = now - lastSwipeTime;

  if (elapsed < SWIPE_COOLDOWN_MS) {
    await sleep(SWIPE_COOLDOWN_MS - elapsed);
  }

  try {
    await executeSwipe(cmd.type, cmd.value);
    lastSwipeTime = Date.now();
  } catch (e) {
    console.error(`[BRIDGE] Swipe error: ${e.message}`);
  }

  // Process next in queue
  setTimeout(processSwipeQueue, 50);
}

async function executeSwipe(type, value) {
  let x, y1, y2;

  if (type === 'speed') {
    x = X32I.speed.x;
    y1 = X32I.speed.y1;
    y2 = X32I.speed.calcY(value);
    console.log(`[BRIDGE] Speed swipe: ${value} km/h → y=${y2}`);
  } else if (type === 'incline') {
    x = X32I.incline.x;
    y1 = X32I.incline.y1;
    y2 = X32I.incline.calcY(value);
    console.log(`[BRIDGE] Incline swipe: ${value}% → y=${y2}`);
  } else {
    return;
  }

  // Clamp Y values to screen bounds
  y1 = Math.max(0, Math.min(1440, y1));
  y2 = Math.max(0, Math.min(1440, y2));

  await shell(`input swipe ${x} ${y1} ${x} ${y2} ${X32I.swipeDuration}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── WebSocket broadcast ─────────────────────────────────────────────────────

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
  });

  for (const client of wsClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch {}
  }
}

function handleClientMessage(data) {
  try {
    const msg = JSON.parse(data);
    if (!msg || !msg.values) return;

    if (msg.type === 'get') {
      // Client requesting current state
      broadcastState();
      return;
    }

    if (msg.type === 'set') {
      const v = msg.values;

      // Speed command (accepts MPH or KPH)
      if (v.MPH !== undefined) {
        const kph = parseFloat(v.MPH) * 1.60934;
        queueSwipe('speed', Math.max(0, Math.min(22, kph)));
      } else if (v.KPH !== undefined) {
        queueSwipe('speed', Math.max(0, Math.min(22, parseFloat(v.KPH))));
      }

      // Incline command
      if (v.Incline !== undefined) {
        queueSwipe('incline', Math.max(-6, Math.min(40, parseFloat(v.Incline))));
      } else if (v.Grade !== undefined) {
        queueSwipe('incline', Math.max(-6, Math.min(40, parseFloat(v.Grade))));
      }
    }
  } catch {}
}

// ── HTTP + WebSocket server ─────────────────────────────────────────────────

function startServer() {
  const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        speed: currentSpeed,
        incline: currentIncline,
        hr: currentHR,
        logPath: logPath,
        clients: wsClients.size,
      }));
      return;
    }

    // Current state (for HTTP polling fallback)
    if (req.url === '/state') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        type: 'stats',
        values: {
          KPH: currentSpeed.toFixed(1),
          Incline: currentIncline.toFixed(1),
          'Heart Rate': currentHR.toString(),
        },
      }));
      return;
    }

    // Command endpoint (for HTTP POST fallback)
    if (req.url === '/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        handleClientMessage(body);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('{"ok":true}');
      });
      return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('TrailRunner Bridge');
  });

  if (WebSocketServer) {
    // Use ws module
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
    console.log(`[BRIDGE] Mode: ${adbMode ? 'ADB remote (' + adbIP + ')' : 'local (Termux)'}`);
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
      header[0] = 0x81; // text frame, FIN
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
  if (opcode === 0x08) return null; // close frame
  if (opcode !== 0x01) return null; // only text frames

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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  TrailRunner Bridge v1.0                     ║');
  console.log('  ║  WebSocket → NordicTrack X32i Hardware       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  // Connect ADB if in remote mode
  if (adbMode) {
    console.log(`[BRIDGE] Connecting ADB to ${adbIP}:5555 ...`);
    try {
      await new Promise((resolve, reject) => {
        exec(`adb connect ${adbIP}:5555`, { timeout: 10000 }, (err, stdout) => {
          if (err) reject(err);
          else { console.log(`[BRIDGE] ${stdout.trim()}`); resolve(); }
        });
      });
    } catch (e) {
      console.error(`[BRIDGE] ADB connection failed: ${e.message}`);
      process.exit(1);
    }
  }

  // Find log file
  console.log('[BRIDGE] Searching for glassos_service logs...');
  logPath = await findLogPath();
  if (logPath) {
    console.log(`[BRIDGE] Found log: ${logPath}`);
  } else {
    console.warn('[BRIDGE] WARNING: No glassos_service log found!');
    console.warn('[BRIDGE] Speed/incline reads will not work.');
    console.warn('[BRIDGE] Will still serve WebSocket and accept commands.');
  }

  // Start WebSocket server
  startServer();

  // Start log polling
  if (logPath) {
    console.log(`[BRIDGE] Polling logs every ${LOG_POLL_MS}ms`);
    setInterval(readNewLogLines, LOG_POLL_MS);
    // Initial read
    await readNewLogLines();
  }

  // Periodic state broadcast (even if no log changes)
  setInterval(broadcastState, 2000);

  console.log('[BRIDGE] Ready. TrailRunner can connect to ws://localhost:' + listenPort);
  console.log('');
}

main().catch(e => {
  console.error('[BRIDGE] Fatal:', e);
  process.exit(1);
});
