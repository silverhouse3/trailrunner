// ════════════════════════════════════════════════════════════════════════════
// Treadmill — HTTP/WebSocket control via TrailRunner Bridge + BLE HR + BLE FTMS
// ════════════════════════════════════════════════════════════════════════════

// Connection priority:
//   1. HTTP REST to TrailRunner Bridge (port 4510) — most reliable from HTTPS
//   2. WebSocket to TrailRunner Bridge (port 4510) — real-time updates
//   3. WebSocket to uthttpd (port 80, 8080) — legacy Wolf firmware
//   4. BLE FTMS — read-only, connect HR separately

var TM = {
  ws: null,
  connected: false,
  _useHTTP: false,
  _connecting: false,
  _lastSpeed: -1,
  _lastIncline: -9999,
  _lastFan: -1,
  _lastSpeedT: 0,
  _lastInclineT: 0,
  _ports: [4510, 80, 8080],
  _portIdx: 0,
  _pollTimer: null,
  _reconnectTimer: null,
  _bridgeBase: 'http://127.0.0.1:4510',

  // Callbacks (set by app)
  onConnect: null,      // (port) =>
  onDisconnect: null,   // () =>
  onData: null,         // (parsed) =>  — { speed, incline, hr, calories }
  onStatus: null,       // (state, name) =>  — state: idle|connecting|connected
  onWorkout: null,      // (workout) =>  — { state, id, grpc }
  onWorkoutResult: null, // (result) =>  — { ok, action, error?, workoutId? }

  // Workout state
  workoutState: 'IDLE',
  workoutId: null,
  grpcConnected: false,

  connect: function(customPort) {
    if (this.connected || this._connecting) {
      this.disconnect();
      return;
    }
    this._connecting = true;
    if (customPort) this._ports = [customPort];
    this._portIdx = 0;
    // Try HTTP first — works reliably from HTTPS pages (no mixed content issues)
    this._tryHTTPFirst();
  },

  /** HTTP connection attempt — most reliable from HTTPS-served PWA */
  _tryHTTPFirst: function() {
    if (this.onStatus) this.onStatus('connecting', 'HTTP');
    console.log('[TM] Trying HTTP connection to bridge...');
    var self = this;
    fetch(this._bridgeBase + '/health')
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(data) {
        console.log('[TM] Bridge HTTP connected:', JSON.stringify(data));
        self._useHTTP = true;
        self.connected = true;
        self._connecting = false;
        if (data.grpc) self.grpcConnected = true;
        if (data.workoutState) self.workoutState = data.workoutState;
        if (data.workoutId) self.workoutId = data.workoutId;
        if (self.onConnect) self.onConnect(4510);
        if (self.onStatus) self.onStatus('connected', 'Bridge HTTP');
        self._startPolling();
      })
      .catch(function(err) {
        console.log('[TM] HTTP failed (' + err.message + '), trying WebSocket...');
        self._tryConnect();
      });
  },

  disconnect: function() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch(e) {} }
    this.ws = null;
    this.connected = false;
    this._useHTTP = false;
    this._connecting = false;
    if (this.onDisconnect) this.onDisconnect();
    if (this.onStatus) this.onStatus('idle');
  },

  _tryConnect: function() {
    if (this.onStatus) this.onStatus('connecting');
    var port = this._ports[this._portIdx];
    var self = this;

    try {
      this.ws = new WebSocket('ws://127.0.0.1:' + port);

      this.ws.onopen = function() {
        self.connected = true;
        self._connecting = false;
        self._useHTTP = false;
        self._send({ values: {}, type: 'get' });
        console.log('[TM] WebSocket connected on port ' + port);
        var name = port === 4510 ? 'Bridge' : 'X32i';
        if (self.onConnect) self.onConnect(port);
        if (self.onStatus) self.onStatus('connected', name + ' :' + port);
      };

      this.ws.onmessage = function(e) {
        try { self._handleMessage(JSON.parse(e.data)); } catch(err) {}
      };

      this.ws.onerror = function() {
        if (!self.connected) {
          self._portIdx++;
          if (self._portIdx < self._ports.length) {
            setTimeout(function() { self._tryConnect(); }, 400);
          } else {
            // All WebSocket ports failed — fall back to HTTP polling
            console.log('[TM] All WebSocket ports failed — starting HTTP polling');
            self._connecting = false;
            self._startPolling();
          }
        }
      };

      this.ws.onclose = function() {
        if (self.connected) {
          self.connected = false;
          self.ws = null;
          if (self.onDisconnect) self.onDisconnect();
          if (self.onStatus) self.onStatus('idle');
          // Auto-reconnect after 4s
          self._reconnectTimer = setTimeout(function() {
            if (!self.connected) self.connect();
          }, 4000);
        }
      };
    } catch(e) {
      this._portIdx++;
      if (this._portIdx < this._ports.length) {
        setTimeout(function() { self._tryConnect(); }, 400);
      } else {
        this._connecting = false;
        this._startPolling();
      }
    }
  },

  // ── HTTP polling ────────────────────────────────────────────────────────

  _startPolling: function() {
    if (this._pollTimer) return;
    console.log('[TM] Starting HTTP poll on port 4510');
    if (this.onStatus) this.onStatus('connecting', 'HTTP poll');
    var self = this;
    var needFirstSuccess = !this.connected;

    this._pollTimer = setInterval(function() {
      fetch(self._bridgeBase + '/state')
        .then(function(resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function(msg) {
          self._handleMessage(msg);
          if (needFirstSuccess) {
            needFirstSuccess = false;
            self._useHTTP = true;
            self.connected = true;
            self._connecting = false;
            if (self.onConnect) self.onConnect(4510);
            if (self.onStatus) self.onStatus('connected', 'Bridge HTTP');
          }
        })
        .catch(function() {
          // Bridge not reachable — stop polling and try reconnect later
          if (self._pollTimer) {
            clearInterval(self._pollTimer);
            self._pollTimer = null;
          }
          if (self.connected) {
            self.connected = false;
            self._useHTTP = false;
            if (self.onDisconnect) self.onDisconnect();
          }
          if (self.onStatus) self.onStatus('idle');
          self._reconnectTimer = setTimeout(function() {
            if (!self.connected) self.connect();
          }, 10000);
        });
    }, 1000);
  },

  // ── Command dispatch ──────────────────────────────────────────────────

  _send: function(obj) {
    if (this._useHTTP || this._pollTimer) {
      this._httpDispatch(obj);
    } else if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  },

  /** Route commands to dedicated REST endpoints — avoids the string/float
   *  type mismatch that the generic /command endpoint has */
  _httpDispatch: function(obj) {
    var base = this._bridgeBase;
    var self = this;

    if (obj.type === 'set' && obj.values) {
      // Speed — use dedicated /speed endpoint
      if (obj.values.KPH !== undefined) {
        fetch(base + '/speed', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({kph: parseFloat(obj.values.KPH)})
        }).catch(function(){});
      }
      if (obj.values.MPH !== undefined) {
        fetch(base + '/speed', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({mph: parseFloat(obj.values.MPH)})
        }).catch(function(){});
      }
      // Incline — use dedicated /incline endpoint
      if (obj.values.Incline !== undefined) {
        fetch(base + '/incline', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({percent: parseFloat(obj.values.Incline)})
        }).catch(function(){});
      }
      // Fan — no dedicated endpoint, use /command
      if (obj.values['Fan Speed'] !== undefined) {
        fetch(base + '/command', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(obj)
        }).catch(function(){});
      }

    } else if (obj.type === 'workout') {
      fetch(base + '/workout/' + obj.action, {method: 'POST'})
        .then(function(resp) { return resp.json(); })
        .then(function(data) {
          if (data) {
            data.type = 'workout_result';
            data.action = obj.action;
            if (self.onWorkoutResult) self.onWorkoutResult(data);
            // Update local state on success
            if (data.ok) {
              if (obj.action === 'start') {
                self.workoutState = 'RUNNING';
                self.workoutId = data.workoutId || null;
              } else if (obj.action === 'stop') {
                self.workoutState = 'IDLE';
              } else if (obj.action === 'pause') {
                self.workoutState = 'PAUSED';
              } else if (obj.action === 'resume') {
                self.workoutState = 'RUNNING';
              }
            }
          }
        })
        .catch(function(){});

    } else if (obj.type === 'get') {
      // State is fetched by polling — no action needed
    }
  },

  // ── Message handler ───────────────────────────────────────────────────

  _handleMessage: function(msg) {
    if (!msg) return;

    // Workout result (response to start/stop/pause/resume)
    if (msg.type === 'workout_result') {
      console.log('[TM] Workout result:', JSON.stringify(msg));
      if (this.onWorkoutResult) this.onWorkoutResult(msg);
      return;
    }

    // Workout state updates (from stats broadcast)
    if (msg.workout) {
      this.workoutState = msg.workout.state || 'IDLE';
      this.workoutId = msg.workout.id || null;
      this.grpcConnected = msg.workout.grpc || false;
      if (this.onWorkout) this.onWorkout(msg.workout);
    }

    if (!msg.values) return;
    var v = msg.values;
    var data = {};

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
      var hr = parseInt(v['Heart Rate']);
      if (hr > 0) data.hr = hr;
    }

    // Calories
    if (v.Calories !== undefined) data.calories = parseInt(v.Calories);

    // Watts
    if (v.Watts !== undefined) {
      var w = parseInt(v.Watts);
      if (w > 0) data.watts = w;
    }

    if (this.onData) this.onData(data);
  },

  // ── Rate-limited control commands ───────────────────────────────────────

  /** Set belt speed (km/h). Rate-limited unless force=true (safety stops). */
  setSpeed: function(kmh, force) {
    if (!this.connected) return;
    var kph = +(+kmh).toFixed(1);
    if (!force) {
      if (Math.abs(kph - this._lastSpeed) < 0.15) return;
      var now = Date.now();
      if (now - this._lastSpeedT < 1200) return;
    }
    this._lastSpeed = kph;
    this._lastSpeedT = Date.now();
    // Send as NUMBER not string — Go bridge expects float64
    this._send({ values: { KPH: kph }, type: 'set' });
  },

  /** Set ramp incline (%). Rate-limited unless force=true (safety returns). */
  setIncline: function(pct, force) {
    if (!this.connected) return;
    var clamped = Math.max(-6, Math.min(40, pct));
    var rounded = Math.round(clamped * 2) / 2;
    if (!force) {
      if (Math.abs(rounded - this._lastIncline) < 0.4) return;
      var now = Date.now();
      if (now - this._lastInclineT < 2500) return;
    }
    this._lastIncline = rounded;
    this._lastInclineT = Date.now();
    // Send as NUMBER not string — Go bridge expects float64
    this._send({ values: { Incline: rounded }, type: 'set' });
  },

  /** Set fan speed (0–100%). Quantised to 10% steps. */
  setFan: function(pct) {
    if (!this.connected) return;
    var r = Math.round(Math.max(0, Math.min(100, pct)) / 10) * 10;
    if (r === this._lastFan) return;
    this._lastFan = r;
    this._send({ values: { 'Fan Speed': r }, type: 'set' });
  },

  /** Emergency stop — bypass rate limiter, immediately set speed to 0. */
  emergencyStop: function() {
    this._lastSpeed = 0;
    this._lastSpeedT = 0;
    this._send({ values: { KPH: 0 }, type: 'set' });
    // Also flatten incline for safety
    this._lastIncline = 0;
    this._lastInclineT = 0;
    this._send({ values: { Incline: 0 }, type: 'set' });
    console.warn('[TM] EMERGENCY STOP');
  },

  // ── Workout lifecycle (gRPC via bridge) ────────────────────────────────

  /** Start a new manual workout — spins up the belt motor. */
  startWorkout: function() {
    console.log('[TM] Starting workout...');
    this._send({ type: 'workout', action: 'start' });
  },

  /** Stop the current workout — belt stops. */
  stopWorkout: function() {
    console.log('[TM] Stopping workout...');
    this._send({ type: 'workout', action: 'stop' });
  },

  /** Pause the current workout. */
  pauseWorkout: function() {
    console.log('[TM] Pausing workout...');
    this._send({ type: 'workout', action: 'pause' });
  },

  /** Resume a paused workout. */
  resumeWorkout: function() {
    console.log('[TM] Resuming workout...');
    this._send({ type: 'workout', action: 'resume' });
  },
};

// ── BLE Heart Rate Monitor ──────────────────────────────────────────────────

var BLEHR = {
  device: null,
  connected: false,
  onHR: null,       // (hr) =>
  onStatus: null,   // (state, name) =>

  connect: function() {
    if (!navigator.bluetooth) {
      console.warn('[BLEHR] Web Bluetooth not available');
      return Promise.resolve(false);
    }
    if (this.connected) { this.disconnect(); return Promise.resolve(false); }
    var self = this;

    if (this.onStatus) this.onStatus('connecting');
    return navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['heart_rate'],
    }).then(function(device) {
      self.device = device;
      device.addEventListener('gattserverdisconnected', function() {
        self.connected = false;
        if (self.onStatus) self.onStatus('idle');
      });
      return device.gatt.connect();
    }).then(function(server) {
      return server.getPrimaryService('heart_rate');
    }).then(function(svc) {
      return svc.getCharacteristic('heart_rate_measurement');
    }).then(function(char) {
      char.addEventListener('characteristicvaluechanged', function(e) {
        var flags = e.target.value.getUint8(0);
        var hr = (flags & 1)
          ? e.target.value.getUint16(1, true)
          : e.target.value.getUint8(1);
        if (hr > 30 && hr < 220 && self.onHR) self.onHR(hr);
      });
      return char.startNotifications();
    }).then(function() {
      self.connected = true;
      if (self.onStatus) self.onStatus('connected', self.device.name || 'HR Strap');
      return true;
    }).catch(function(e) {
      console.warn('[BLEHR] Error:', e);
      if (self.onStatus) self.onStatus('idle');
      return false;
    });
  },

  disconnect: function() {
    if (this.device && this.device.gatt.connected) {
      try { this.device.gatt.disconnect(); } catch(e) {}
    }
    this.connected = false;
    if (this.onStatus) this.onStatus('idle');
  },
};

// ── BLE FTMS Treadmill (read-only fallback via QZ Companion) ────────────────

var FTMS = {
  device: null,
  connected: false,
  onData: null,      // ({ speed, incline, hr }) =>
  onStatus: null,    // (state, name) =>

  connect: function() {
    if (!navigator.bluetooth) return Promise.resolve(false);
    var SVC = '00001826-0000-1000-8000-00805f9b34fb';
    var CHAR = '00002acd-0000-1000-8000-00805f9b34fb';
    var self = this;

    if (this.onStatus) this.onStatus('connecting');
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [SVC] }],
      optionalServices: [SVC],
    }).then(function(device) {
      self.device = device;
      device.addEventListener('gattserverdisconnected', function() {
        self.connected = false;
        if (self.onStatus) self.onStatus('idle');
      });
      return device.gatt.connect();
    }).then(function(server) {
      return server.getPrimaryService(SVC);
    }).then(function(svc) {
      return svc.getCharacteristic(CHAR);
    }).then(function(char) {
      char.addEventListener('characteristicvaluechanged', function(e) {
        var d = e.target.value;
        var flags = d.getUint16(0, true);
        var offset = 2;
        var data = {};
        if (!(flags & 0x0001)) { data.speed = d.getUint16(offset, true) / 100; offset += 2; }
        if (flags & 0x0002) offset += 2;
        if (flags & 0x0004) offset += 3;
        if (flags & 0x0008) { data.incline = d.getInt16(offset, true) / 10; offset += 4; }
        if (flags & 0x0010) offset += 4;
        if (flags & 0x0100) { data.hr = d.getUint8(offset); }
        if (self.onData) self.onData(data);
      });
      return char.startNotifications();
    }).then(function() {
      self.connected = true;
      if (self.onStatus) self.onStatus('connected', self.device.name || 'QZ FTMS');
      return true;
    }).catch(function(e) {
      console.warn('[FTMS] Error:', e);
      if (self.onStatus) self.onStatus('idle');
      return false;
    });
  },
};
