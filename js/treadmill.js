// ════════════════════════════════════════════════════════════════════════════
// Treadmill — WebSocket control via TrailRunner Bridge + BLE HR + BLE FTMS
// ════════════════════════════════════════════════════════════════════════════

// Connection priority:
//   1. WebSocket to TrailRunner Bridge (port 4510) — reads logs + swipe control
//   2. WebSocket to uthttpd (port 80, 8080) — legacy Wolf firmware
//   3. HTTP polling fallback (port 4510/state) — if WS fails
//   4. BLE FTMS — read-only, connect HR separately

const TM = {
  ws: null,
  connected: false,
  _lastSpeed: -1,
  _lastIncline: -9999,
  _lastFan: -1,
  _lastSpeedT: 0,
  _lastInclineT: 0,
  _ports: [4510, 80, 8080],
  _portIdx: 0,
  _pollTimer: null,
  _reconnectTimer: null,

  // Callbacks (set by app)
  onConnect: null,      // (port) =>
  onDisconnect: null,   // () =>
  onData: null,         // (parsed) =>  — { speed, incline, hr, calories }
  onStatus: null,       // (state, name) =>  — state: idle|connecting|connected

  connect(customPort) {
    if (this.connected || (this.ws && this.ws.readyState === 0)) {
      this.disconnect();
      return;
    }
    if (customPort) this._ports = [customPort];
    this._portIdx = 0;
    this._tryConnect();
  },

  disconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
    this.connected = false;
    if (this.onDisconnect) this.onDisconnect();
    if (this.onStatus) this.onStatus('idle');
  },

  _tryConnect() {
    if (this.onStatus) this.onStatus('connecting');
    const port = this._ports[this._portIdx];

    try {
      this.ws = new WebSocket('ws://localhost:' + port);

      this.ws.onopen = () => {
        this.connected = true;
        this._send({ values: {}, type: 'get' });
        console.log('[TM] Connected on port ' + port);
        const name = port === 4510 ? 'Bridge' : 'X32i';
        if (this.onConnect) this.onConnect(port);
        if (this.onStatus) this.onStatus('connected', name + ' :' + port);
      };

      this.ws.onmessage = (e) => {
        try { this._handleMessage(JSON.parse(e.data)); } catch {}
      };

      this.ws.onerror = () => {
        if (!this.connected) {
          this._portIdx++;
          if (this._portIdx < this._ports.length) {
            setTimeout(() => this._tryConnect(), 400);
          } else {
            // All WebSocket ports failed — try HTTP polling on bridge
            console.log('[TM] WebSocket unavailable — trying HTTP polling');
            this._startPolling();
          }
        }
      };

      this.ws.onclose = () => {
        if (this.connected) {
          this.connected = false;
          this.ws = null;
          if (this.onDisconnect) this.onDisconnect();
          if (this.onStatus) this.onStatus('idle');
          // Auto-reconnect after 4s
          this._reconnectTimer = setTimeout(() => {
            if (!this.connected) { this._portIdx = 0; this._tryConnect(); }
          }, 4000);
        }
      };
    } catch {
      this._portIdx++;
      if (this._portIdx < this._ports.length) {
        setTimeout(() => this._tryConnect(), 400);
      } else {
        this._startPolling();
      }
    }
  },

  // ── HTTP polling fallback ───────────────────────────────────────────────

  _startPolling() {
    if (this._pollTimer) return;
    console.log('[TM] Starting HTTP poll on port 4510');
    if (this.onStatus) this.onStatus('connecting', 'HTTP poll');

    let firstSuccess = false;
    this._pollTimer = setInterval(async () => {
      try {
        const resp = await fetch('http://localhost:4510/state');
        if (resp.ok) {
          const msg = await resp.json();
          this._handleMessage(msg);
          if (!firstSuccess) {
            firstSuccess = true;
            this.connected = true;
            if (this.onConnect) this.onConnect(4510);
            if (this.onStatus) this.onStatus('connected', 'Bridge HTTP');
          }
        }
      } catch {
        // Bridge not running — try WebSocket again in 10s
        if (this._pollTimer) {
          clearInterval(this._pollTimer);
          this._pollTimer = null;
        }
        if (this.onStatus) this.onStatus('idle');
        this._reconnectTimer = setTimeout(() => {
          if (!this.connected) { this._portIdx = 0; this._tryConnect(); }
        }, 10000);
      }
    }, 1000);
  },

  // ── HTTP command sender (for poll mode) ─────────────────────────────────

  async _httpSend(obj) {
    try {
      await fetch('http://localhost:4510/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj),
      });
    } catch {}
  },

  // ── Message handler ─────────────────────────────────────────────────────

  _handleMessage(msg) {
    if (!msg || !msg.values) return;
    const v = msg.values;
    const data = {};

    // Speed (may arrive as MPH, KPH, or km/h)
    if (v.MPH !== undefined) {
      data.speed = parseFloat(v.MPH) * 1.60934;
    } else if (v.KPH !== undefined) {
      data.speed = parseFloat(v.KPH);
    } else if (v['km/h'] !== undefined) {
      data.speed = parseFloat(v['km/h']);
    }

    // Incline
    if (v.Incline !== undefined) data.incline = parseFloat(v.Incline);
    else if (v.Grade !== undefined) data.incline = parseFloat(v.Grade);

    // Heart Rate
    if (v['Heart Rate'] !== undefined) {
      const hr = parseInt(v['Heart Rate']);
      if (hr > 0) data.hr = hr;
    }

    // Calories
    if (v.Calories !== undefined) data.calories = parseInt(v.Calories);

    // Watts
    if (v.Watts !== undefined) {
      const w = parseInt(v.Watts);
      if (w > 0) data.watts = w;
    }

    if (this.onData) this.onData(data);
  },

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    } else if (this._pollTimer) {
      this._httpSend(obj);
    }
  },

  // ── Rate-limited control commands ─────────────────────────────────────────

  /** Set belt speed (km/h). Rate-limited unless force=true (safety stops). */
  setSpeed(kmh, force) {
    if (!this.connected) return;
    const kph = +kmh.toFixed(1);
    if (!force) {
      if (Math.abs(kph - this._lastSpeed) < 0.15) return;
      const now = Date.now();
      if (now - this._lastSpeedT < 1200) return;
    }
    this._lastSpeed = kph;
    this._lastSpeedT = Date.now();
    this._send({ values: { KPH: kph.toString() }, type: 'set' });
  },

  /** Set ramp incline (%). Rate-limited unless force=true (safety returns). */
  setIncline(pct, force) {
    if (!this.connected) return;
    const clamped = Math.max(-6, Math.min(40, pct));
    const rounded = Math.round(clamped * 2) / 2;
    if (!force) {
      if (Math.abs(rounded - this._lastIncline) < 0.4) return;
      const now = Date.now();
      if (now - this._lastInclineT < 2500) return;
    }
    this._lastIncline = rounded;
    this._lastInclineT = Date.now();
    this._send({ values: { Incline: rounded.toFixed(1) }, type: 'set' });
  },

  /** Set fan speed (0–100%). Quantised to 10% steps. */
  setFan(pct) {
    if (!this.connected) return;
    const r = Math.round(Math.max(0, Math.min(100, pct)) / 10) * 10;
    if (r === this._lastFan) return;
    this._lastFan = r;
    this._send({ values: { 'Fan Speed': r.toString() }, type: 'set' });
  },

  /** Emergency stop — bypass rate limiter, immediately set speed to 0. */
  emergencyStop() {
    this._lastSpeed = 0;
    this._lastSpeedT = 0;
    this._send({ values: { KPH: '0' }, type: 'set' });
    // Also flatten incline for safety
    this._lastIncline = 0;
    this._lastInclineT = 0;
    this._send({ values: { Incline: '0' }, type: 'set' });
    console.warn('[TM] EMERGENCY STOP');
  },
};

// ── BLE Heart Rate Monitor ──────────────────────────────────────────────────

const BLEHR = {
  device: null,
  connected: false,
  onHR: null,       // (hr) =>
  onStatus: null,   // (state, name) =>

  async connect() {
    if (!navigator.bluetooth) {
      console.warn('[BLEHR] Web Bluetooth not available');
      return false;
    }
    if (this.connected) { this.disconnect(); return; }

    try {
      if (this.onStatus) this.onStatus('connecting');
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['heart_rate'],
      });

      this.device.addEventListener('gattserverdisconnected', () => {
        this.connected = false;
        if (this.onStatus) this.onStatus('idle');
      });

      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService('heart_rate');
      const char = await svc.getCharacteristic('heart_rate_measurement');

      char.addEventListener('characteristicvaluechanged', (e) => {
        const flags = e.target.value.getUint8(0);
        const hr = (flags & 1)
          ? e.target.value.getUint16(1, true)
          : e.target.value.getUint8(1);
        if (hr > 30 && hr < 220 && this.onHR) this.onHR(hr);
      });

      await char.startNotifications();
      this.connected = true;
      if (this.onStatus) this.onStatus('connected', this.device.name || 'HR Strap');
      return true;

    } catch (e) {
      console.warn('[BLEHR] Error:', e);
      if (this.onStatus) this.onStatus('idle');
      return false;
    }
  },

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      try { this.device.gatt.disconnect(); } catch {}
    }
    this.connected = false;
    if (this.onStatus) this.onStatus('idle');
  },
};

// ── BLE FTMS Treadmill (read-only fallback via QZ Companion) ────────────────

const FTMS = {
  device: null,
  connected: false,
  onData: null,      // ({ speed, incline, hr }) =>
  onStatus: null,    // (state, name) =>

  async connect() {
    if (!navigator.bluetooth) return false;
    const SVC = '00001826-0000-1000-8000-00805f9b34fb';
    const CHAR = '00002acd-0000-1000-8000-00805f9b34fb';

    try {
      if (this.onStatus) this.onStatus('connecting');
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SVC] }],
        optionalServices: [SVC],
      });

      this.device.addEventListener('gattserverdisconnected', () => {
        this.connected = false;
        if (this.onStatus) this.onStatus('idle');
      });

      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(SVC);
      const char = await svc.getCharacteristic(CHAR);

      char.addEventListener('characteristicvaluechanged', (e) => {
        const d = e.target.value;
        const flags = d.getUint16(0, true);
        let offset = 2;
        const data = {};
        if (!(flags & 0x0001)) { data.speed = d.getUint16(offset, true) / 100; offset += 2; }
        if (flags & 0x0002) offset += 2;
        if (flags & 0x0004) offset += 3;
        if (flags & 0x0008) { data.incline = d.getInt16(offset, true) / 10; offset += 4; }
        if (flags & 0x0010) offset += 4;
        if (flags & 0x0100) { data.hr = d.getUint8(offset); }
        if (this.onData) this.onData(data);
      });

      await char.startNotifications();
      this.connected = true;
      if (this.onStatus) this.onStatus('connected', this.device.name || 'QZ FTMS');
      return true;

    } catch (e) {
      console.warn('[FTMS] Error:', e);
      if (this.onStatus) this.onStatus('idle');
      return false;
    }
  },
};
