// ════════════════════════════════════════════════════════════════════════════
// Treadmill — WebSocket control (uthttpd) + BLE HR + BLE FTMS fallback
// ════════════════════════════════════════════════════════════════════════════

// ── WebSocket connection to X32i uthttpd ────────────────────────────────────
// Protocol:
//   Read:  {"values":{"MPH":"6.2","Incline":"4.5","Heart Rate":"152"},"type":"stats"}
//   Write: {"values":{"MPH":"6.2"},"type":"set"}
//   Write: {"values":{"Incline":"8.0"},"type":"set"}
//   Write: {"values":{"Fan Speed":"70"},"type":"set"}

const TM = {
  ws: null,
  connected: false,
  _lastSpeed: -1,
  _lastIncline: -9999,
  _lastFan: -1,
  _lastSpeedT: 0,
  _lastInclineT: 0,
  _ports: [80, 8080],
  _portIdx: 0,

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
    if (this.ws) { try { this.ws.close(); } catch {} }
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
        console.log('[TM] WebSocket connected on port ' + port);
        if (this.onConnect) this.onConnect(port);
        if (this.onStatus) this.onStatus('connected', 'X32i :' + port);
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
            console.log('[TM] WebSocket unavailable — try BLE FTMS');
            if (this.onStatus) this.onStatus('idle');
            // App can call FTMS.connect() as fallback
          }
        }
      };

      this.ws.onclose = () => {
        if (this.connected) {
          this.connected = false;
          if (this.onDisconnect) this.onDisconnect();
          if (this.onStatus) this.onStatus('idle');
          // Auto-reconnect after 4s
          setTimeout(() => {
            if (!this.connected) { this._portIdx = 0; this._tryConnect(); }
          }, 4000);
        }
      };
    } catch {
      if (this.onStatus) this.onStatus('idle');
    }
  },

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
    if (v['Heart Rate'] !== undefined) data.hr = parseInt(v['Heart Rate']);

    // Calories
    if (v.Calories !== undefined) data.calories = parseInt(v.Calories);

    if (this.onData) this.onData(data);
  },

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  },

  // ── Rate-limited control commands ─────────────────────────────────────────

  /** Set belt speed (km/h). Rate-limited: max 1 cmd per 1.2s, ignores <0.15 mph changes. */
  setSpeed(kmh) {
    if (!this.connected) return;
    const mph = +(kmh / 1.60934).toFixed(1);
    if (Math.abs(mph - this._lastSpeed) < 0.15) return;
    const now = Date.now();
    if (now - this._lastSpeedT < 1200) return;
    this._lastSpeed = mph;
    this._lastSpeedT = now;
    this._send({ values: { MPH: mph.toString() }, type: 'set' });
  },

  /** Set ramp incline (%). Rate-limited: max 1 cmd per 2.5s, quantised to 0.5% steps. */
  setIncline(pct) {
    if (!this.connected) return;
    const clamped = Math.max(-6, Math.min(40, pct));
    const rounded = Math.round(clamped * 2) / 2;
    if (Math.abs(rounded - this._lastIncline) < 0.4) return;
    const now = Date.now();
    if (now - this._lastInclineT < 2500) return;
    this._lastIncline = rounded;
    this._lastInclineT = now;
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
    this._send({ values: { MPH: '0' }, type: 'set' });
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
