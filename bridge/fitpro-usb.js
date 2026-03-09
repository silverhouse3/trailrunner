#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// FitPro USB Bridge — Direct motor controller communication (Phase 2)
//
// Talks directly to the ICON Fitness motor controller via USB CDC ACM,
// bypassing iFIT entirely. No subscription needed.
//
// Status: EXPERIMENTAL — needs USB packet capture to confirm command bytes
//
// Usage (on treadmill via Termux with root):
//   node fitpro-usb.js
//
// Usage (on PC with USB passthrough, for development):
//   node fitpro-usb.js --dev
//
// ═══════════════════════════════════════════════════════════════════════════════

const http = require('http');
const { exec } = require('child_process');

// ── FitPro Protocol Constants ────────────────────────────────────────────────

const FITPRO = {
  VID: 0x213C,        // ICON Fitness
  PID: 0x0002,        // Generic HID (actually CDC ACM)
  MAX_PACKET: 64,     // Max packet size
  MIN_PACKET: 3,      // Min valid packet

  // BitField IDs (from decompiled glassos_service)
  FIELDS: {
    // System
    SOFTWARE_MAJOR_VERSION: 1,
    SOFTWARE_MINOR_VERSION: 2,
    SYSTEM_MODE: 102,
    TABLET_CONNECTION_STATUS: 122,
    FAN_LEVEL_PERCENT: 126,
    DISPLAY_UNITS: 140,

    // Heart Rate
    PULSE: 222,
    PULSE_SOURCE: 223,
    HEART_BEAT_INTERVAL: 161,

    // Speed (CRITICAL)
    TARGET_KPH: 301,         // R/W — SET desired speed
    CURRENT_KPH: 302,        // R   — READ actual speed
    MIN_KPH: 303,
    MAX_KPH: 304,

    // Incline (CRITICAL)
    TARGET_GRADE_PERCENT: 401, // R/W — SET desired incline
    CURRENT_GRADE_PERCENT: 402, // R  — READ actual incline
    MIN_GRADE_PERCENT: 403,
    MAX_GRADE_PERCENT: 404,
    CALIBRATE_GRADE: 415,

    // Resistance / Power
    WATTS: 522,
    RPM: 322,

    // Workout Control
    WORKOUT_STATE: 602,       // R/W
    START_REQUESTED: 612,     // R/W
    EXIT_WORKOUT_REQUESTED: 613, // R/W

    // Direct Motor Control (low-level)
    DRIVE_MOTOR_TARGET_SPEED: 2301,
    DRIVE_MOTOR_CURRENT_SPEED: 2302,
    INCLINE_MOTOR_TARGET: 2401,
    INCLINE_MOTOR_CURRENT: 2402,
  },

  // Value encoding
  SPEED_SCALE: 100,   // 0.01 km/h units (1931 = 19.31 km/h)
  GRADE_SCALE: 100,   // 0.01% units (-600 = -6%, 4000 = +40%)

  // X32i limits
  MAX_SPEED_RAW: 1931,    // 19.31 km/h = 12 mph
  MIN_GRADE_RAW: -600,    // -6%
  MAX_GRADE_RAW: 4000,    // +40%
};

// ── Packet Construction ─────────────────────────────────────────────────────
//
// PACKET FORMAT (from decompiled glassos_service):
//   Byte 0:     Command ID (non-zero)
//   Byte 1:     Length (total bytes including this, 3-64)
//   Byte 2+:    Payload (BitField ID + optional value)
//   Byte N-1:   Checksum (at position bytes[bytes[1]-1])
//
// CHECKSUM: sum of bytes[0] through bytes[length-2], masked to byte
//
// NOTE: The exact command IDs for read vs write are not yet confirmed.
// These are educated guesses based on the decompiled code structure.
// USB traffic capture will confirm the actual values.

// TODO: These command IDs need to be confirmed via USB packet capture
const CMD = {
  READ_SINGLE: 0x01,      // Hypothesized: read a single BitField
  WRITE_SINGLE: 0x02,     // Hypothesized: write a single BitField
  READ_MULTI: 0x03,       // Hypothesized: read multiple BitFields
  WRITE_MULTI: 0x04,      // Hypothesized: write multiple BitFields
  RESPONSE: 0x05,         // Hypothesized: response from MCU
};

function calculateChecksum(bytes, length) {
  let sum = 0;
  for (let i = 0; i < length - 1; i++) {
    sum = ((sum & 0xFF) + (bytes[i] & 0xFF)) & 0xFF;
  }
  return sum;
}

function validatePacket(bytes) {
  if (!bytes || bytes.length < FITPRO.MIN_PACKET) return false;
  if (bytes[0] === 0) return false;
  const len = bytes[1];
  if (len < 3 || len > 64) return false;
  if (len > bytes.length) return false;
  const expected = calculateChecksum(bytes, len);
  return bytes[len - 1] === expected;
}

// Build a read request packet for a single BitField
function buildReadPacket(fieldId) {
  // Field ID encoding: 12-bit value split into high nibble + byte
  // This is a hypothesis — need USB capture to confirm
  const hiNibble = (fieldId >> 8) & 0x0F;
  const loByte = fieldId & 0xFF;

  const packet = Buffer.alloc(64, 0);
  packet[0] = CMD.READ_SINGLE;
  packet[1] = 5;           // length: cmd + len + fieldHi + fieldLo + checksum
  packet[2] = hiNibble;
  packet[3] = loByte;
  packet[4] = calculateChecksum(packet, 5);

  return packet;
}

// Build a write packet for a single BitField with a 16-bit value
function buildWritePacket(fieldId, value) {
  const hiNibble = (fieldId >> 8) & 0x0F;
  const loByte = fieldId & 0xFF;
  const valHi = (value >> 8) & 0xFF;
  const valLo = value & 0xFF;

  const packet = Buffer.alloc(64, 0);
  packet[0] = CMD.WRITE_SINGLE;
  packet[1] = 7;           // cmd + len + fieldHi + fieldLo + valHi + valLo + checksum
  packet[2] = hiNibble;
  packet[3] = loByte;
  packet[4] = valHi;
  packet[5] = valLo;
  packet[6] = calculateChecksum(packet, 7);

  return packet;
}

// Parse a response packet and extract field ID + value
function parseResponse(bytes) {
  if (!validatePacket(bytes)) return null;
  const len = bytes[1];

  // Minimum response: cmd(1) + len(1) + fieldHi(1) + fieldLo(1) + value(2) + checksum(1) = 7
  if (len < 5) return null;

  const fieldId = ((bytes[2] & 0x0F) << 8) | bytes[3];
  let value = 0;

  if (len >= 7) {
    value = (bytes[4] << 8) | bytes[5];
    // Handle signed values (incline can be negative)
    if (value > 32767) value -= 65536;
  } else if (len >= 6) {
    value = bytes[4];
  }

  return { fieldId, value };
}

// ── High-Level API ──────────────────────────────────────────────────────────

const state = {
  speed: 0,          // Current speed in km/h
  incline: 0,        // Current incline in %
  hr: 0,             // Heart rate BPM
  watts: 0,
  rpm: 0,
  workoutState: 0,
  connected: false,
};

function speedToRaw(kmh) {
  return Math.round(Math.max(0, Math.min(19.31, kmh)) * FITPRO.SPEED_SCALE);
}

function rawToSpeed(raw) {
  return raw / FITPRO.SPEED_SCALE;
}

function gradeToRaw(pct) {
  return Math.round(Math.max(-6, Math.min(40, pct)) * FITPRO.GRADE_SCALE);
}

function rawToGrade(raw) {
  return raw / FITPRO.GRADE_SCALE;
}

// ── USB Device Access ───────────────────────────────────────────────────────
//
// On Android (Termux), we need to use the Android USB Host API.
// This requires either:
//   1. A native Android app with USB_DEVICE_ATTACHED intent filter
//   2. Root access to /dev/bus/usb/XXX/YYY
//   3. A helper APK that claims USB and proxies to our Node.js script
//
// On Linux PC (for development):
//   We can use the 'usb' npm package (libusb binding)
//
// For now, this module provides the packet construction/parsing logic.
// The actual USB I/O is pluggable.

class FitProDevice {
  constructor() {
    this.readCallback = null;
    this.connected = false;
    this._readInterval = null;
  }

  // Subclass or set this to provide USB I/O
  async usbWrite(packet) {
    throw new Error('usbWrite not implemented — need USB backend');
  }

  async usbRead() {
    throw new Error('usbRead not implemented — need USB backend');
  }

  async connect() {
    console.log('[FitPro] Connecting to motor controller...');
    this.connected = true;

    // Start polling reads
    this._readInterval = setInterval(async () => {
      try {
        const data = await this.usbRead();
        if (data) this._handleResponse(data);
      } catch {}
    }, 50); // 20 reads/sec

    // Initial state query
    await this.queryState();
    return true;
  }

  disconnect() {
    if (this._readInterval) clearInterval(this._readInterval);
    this.connected = false;
    console.log('[FitPro] Disconnected');
  }

  async queryState() {
    // Read current speed, incline, HR, workout state
    await this.readField(FITPRO.FIELDS.CURRENT_KPH);
    await this.readField(FITPRO.FIELDS.CURRENT_GRADE_PERCENT);
    await this.readField(FITPRO.FIELDS.PULSE);
    await this.readField(FITPRO.FIELDS.WORKOUT_STATE);
  }

  async readField(fieldId) {
    const packet = buildReadPacket(fieldId);
    await this.usbWrite(packet);
  }

  async setSpeed(kmh) {
    const raw = speedToRaw(kmh);
    console.log(`[FitPro] Set speed: ${kmh} km/h (raw: ${raw})`);
    const packet = buildWritePacket(FITPRO.FIELDS.TARGET_KPH, raw);
    await this.usbWrite(packet);
  }

  async setIncline(pct) {
    const raw = gradeToRaw(pct);
    console.log(`[FitPro] Set incline: ${pct}% (raw: ${raw})`);
    const packet = buildWritePacket(FITPRO.FIELDS.TARGET_GRADE_PERCENT, raw);
    await this.usbWrite(packet);
  }

  async startWorkout() {
    console.log('[FitPro] Starting workout...');
    await this.usbWrite(buildWritePacket(FITPRO.FIELDS.START_REQUESTED, 1));
  }

  async stopWorkout() {
    console.log('[FitPro] Stopping workout...');
    await this.usbWrite(buildWritePacket(FITPRO.FIELDS.EXIT_WORKOUT_REQUESTED, 1));
  }

  async emergencyStop() {
    console.warn('[FitPro] EMERGENCY STOP');
    await this.usbWrite(buildWritePacket(FITPRO.FIELDS.TARGET_KPH, 0));
    await this.usbWrite(buildWritePacket(FITPRO.FIELDS.TARGET_GRADE_PERCENT, 0));
    await this.usbWrite(buildWritePacket(FITPRO.FIELDS.EXIT_WORKOUT_REQUESTED, 1));
  }

  _handleResponse(bytes) {
    const parsed = parseResponse(bytes);
    if (!parsed) return;

    const { fieldId, value } = parsed;

    switch (fieldId) {
      case FITPRO.FIELDS.CURRENT_KPH:
        state.speed = rawToSpeed(value);
        break;
      case FITPRO.FIELDS.CURRENT_GRADE_PERCENT:
        state.incline = rawToGrade(value);
        break;
      case FITPRO.FIELDS.PULSE:
        if (value > 30 && value < 250) state.hr = value;
        break;
      case FITPRO.FIELDS.WATTS:
        state.watts = value;
        break;
      case FITPRO.FIELDS.RPM:
        state.rpm = value;
        break;
      case FITPRO.FIELDS.WORKOUT_STATE:
        state.workoutState = value;
        break;
    }

    if (this.readCallback) this.readCallback(state);
  }
}

// ── ADB Shell USB Backend (for development/testing) ─────────────────────────
//
// Uses ADB to access the USB device on the treadmill remotely.
// This is slower than native access but works for protocol development.

class AdbUsbBackend extends FitProDevice {
  constructor(ip) {
    super();
    this.ip = ip;
    this.adbPrefix = `adb -s ${ip}:5555 shell`;
  }

  async usbWrite(packet) {
    // TODO: Need a helper binary on the device that can write to USB
    // For now, log the packet for debugging
    const hex = Buffer.from(packet.slice(0, packet[1])).toString('hex');
    console.log(`[USB OUT] ${hex}`);
  }

  async usbRead() {
    // TODO: Need a helper binary on the device that can read from USB
    return null;
  }
}

// ── WebSocket Server (same interface as trailrunner-bridge.js) ──────────────

const PORT = 4510;
let wsClients = new Set();

function broadcastState() {
  const msg = JSON.stringify({
    type: 'stats',
    values: {
      KPH: state.speed.toFixed(1),
      Incline: state.incline.toFixed(1),
      'Heart Rate': state.hr.toString(),
      Watts: state.watts.toString(),
      RPM: state.rpm.toString(),
    },
  });

  for (const client of wsClients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch {}
  }
}

// ── Export for use as module ─────────────────────────────────────────────────

module.exports = {
  FITPRO,
  CMD,
  calculateChecksum,
  validatePacket,
  buildReadPacket,
  buildWritePacket,
  parseResponse,
  speedToRaw,
  rawToSpeed,
  gradeToRaw,
  rawToGrade,
  FitProDevice,
  AdbUsbBackend,
  state,
};

// ── CLI Mode ────────────────────────────────────────────────────────────────

if (require.main === module) {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  FitPro USB Bridge v0.1 (EXPERIMENTAL)      ║');
  console.log('  ║  Direct Motor Controller — No iFIT Required  ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  STATUS: Protocol packet format partially decoded.');
  console.log('  NEEDED: USB traffic capture to confirm command bytes.');
  console.log('');
  console.log('  Run CAPTURE_PROTOCOL.cmd or CAPTURE_VALINOR_LOGS.cmd');
  console.log('  on the treadmill to capture the actual packet format.');
  console.log('');
  console.log('  Known BitField IDs:');
  console.log('    Speed:   TARGET_KPH=301, CURRENT_KPH=302');
  console.log('    Incline: TARGET_GRADE=401, CURRENT_GRADE=402');
  console.log('    Control: START=612, STOP=613, STATE=602');
  console.log('');

  // Demo: show what packets WOULD look like
  console.log('  Example packets (hypothesized format):');
  console.log('');

  const readSpeed = buildReadPacket(FITPRO.FIELDS.CURRENT_KPH);
  console.log('  Read current speed (field 302):');
  console.log('    ' + Buffer.from(readSpeed.slice(0, readSpeed[1])).toString('hex'));

  const writeSpeed = buildWritePacket(FITPRO.FIELDS.TARGET_KPH, speedToRaw(8.0));
  console.log('  Set speed to 8.0 km/h (field 301, raw 800):');
  console.log('    ' + Buffer.from(writeSpeed.slice(0, writeSpeed[1])).toString('hex'));

  const writeGrade = buildWritePacket(FITPRO.FIELDS.TARGET_GRADE_PERCENT, gradeToRaw(5.0));
  console.log('  Set incline to 5.0% (field 401, raw 500):');
  console.log('    ' + Buffer.from(writeGrade.slice(0, writeGrade[1])).toString('hex'));

  const stopPacket = buildWritePacket(FITPRO.FIELDS.EXIT_WORKOUT_REQUESTED, 1);
  console.log('  Stop workout (field 613, value 1):');
  console.log('    ' + Buffer.from(stopPacket.slice(0, stopPacket[1])).toString('hex'));

  console.log('');
  console.log('  Once USB capture confirms the format, this bridge will');
  console.log('  provide full treadmill control without iFIT subscription.');
  console.log('');
}
