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
  _watchdogTimer: null,
  _bridgeBase: 'http://127.0.0.1:4510',
  _consecutiveFails: 0,
  _maxReconnectDelay: 30000,
  _lastHealthy: 0,

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
      // SAFETY: Don't disconnect if a workout is running — prevents accidental
      // disconnection from double-tap or race condition mid-run
      if (this._expectRunning || this.workoutState === 'RUNNING') {
        console.warn('[TM] Ignoring disconnect — workout is running');
        return;
      }
      this.disconnect();
      return;
    }
    this._connecting = true;
    this._httpRetries = 0;
    if (customPort) this._ports = [customPort];
    this._portIdx = 0;
    // Try HTTP first — works reliably from HTTPS pages (no mixed content issues)
    this._tryHTTPFirst();
  },

  /** HTTP connection attempt — retries up to 3 times before falling back to WS.
   *  Handles bridge startup delay (APK starts bridge, may take a few seconds). */
  _tryHTTPFirst: function() {
    // Guard: if disconnect was called during retry, abort
    if (!this._connecting) return;
    if (this.onStatus) this.onStatus('connecting', 'HTTP');
    console.log('[TM] Trying HTTP connection to bridge (attempt ' + (this._httpRetries + 1) + '/3)...');
    var self = this;
    fetch(this._bridgeBase + '/health')
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(data) {
        if (!self._connecting) return; // aborted by disconnect
        console.log('[TM] Bridge HTTP connected:', JSON.stringify(data));
        self._useHTTP = true;
        self.connected = true;
        self._connecting = false;
        self._consecutiveFails = 0;
        self._lastHealthy = Date.now();
        if (data.grpc) self.grpcConnected = true;
        if (data.workoutState) self.workoutState = data.workoutState;
        if (data.workoutId) self.workoutId = data.workoutId;
        if (self.onConnect) self.onConnect(4510);
        if (self.onStatus) self.onStatus('connected', 'Bridge HTTP');
        self._startPolling();
        self._startWatchdog();
      })
      .catch(function(err) {
        self._httpRetries = (self._httpRetries || 0) + 1;
        if (self._httpRetries < 3) {
          // Bridge might still be starting — wait 2s and retry HTTP
          console.log('[TM] HTTP attempt ' + self._httpRetries + ' failed (' + err.message + '), retrying in 2s...');
          if (self.onStatus) self.onStatus('connecting', 'Bridge starting...');
          setTimeout(function() { self._tryHTTPFirst(); }, 2000);
        } else {
          console.log('[TM] HTTP failed after 3 attempts, trying WebSocket...');
          self._tryConnect();
        }
      });
  },

  disconnect: function(keepWatchdog) {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (!keepWatchdog && this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
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
        self._consecutiveFails = 0;
        self._lastHealthy = Date.now();
        self._send({ values: {}, type: 'get' });
        console.log('[TM] WebSocket connected on port ' + port);
        var name = port === 4510 ? 'Bridge' : 'X32i';
        if (self.onConnect) self.onConnect(port);
        if (self.onStatus) self.onStatus('connected', name + ' :' + port);
        if (port === 4510) self._startWatchdog();
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
          self._scheduleReconnect();
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
    var inFlight = false;
    var pollFails = 0;

    this._pollTimer = setInterval(function() {
      if (inFlight) return; // prevent overlapping fetches
      inFlight = true;
      fetch(self._bridgeBase + '/state')
        .then(function(resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function(msg) {
          inFlight = false;
          pollFails = 0; // reset on success
          self._consecutiveFails = 0;
          self._lastHealthy = Date.now();
          self._handleMessage(msg);
          if (needFirstSuccess) {
            needFirstSuccess = false;
            self._useHTTP = true;
            self.connected = true;
            self._connecting = false;
            if (self.onConnect) self.onConnect(4510);
            if (self.onStatus) self.onStatus('connected', 'Bridge HTTP');
            self._startWatchdog();
          }
        })
        .catch(function() {
          inFlight = false;
          pollFails++;
          // Tolerate up to 3 consecutive failures before disconnecting
          // (handles brief network hiccups)
          if (pollFails < 3) {
            console.log('[TM] Poll fail ' + pollFails + '/3 — retrying...');
            return;
          }
          // Too many failures — stop polling and schedule reconnect
          console.warn('[TM] Poll failed ' + pollFails + ' times — reconnecting');
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
          self._scheduleReconnect();
        });
    }, 1000);
  },

  /** Exponential backoff reconnect: 2s, 4s, 8s, 16s, 30s cap */
  _scheduleReconnect: function() {
    if (this._reconnectTimer) return;
    this._consecutiveFails++;
    var delay = Math.min(this._maxReconnectDelay, 2000 * Math.pow(2, this._consecutiveFails - 1));
    console.log('[TM] Reconnect in ' + (delay / 1000) + 's (attempt ' + this._consecutiveFails + ')');
    var self = this;
    if (this.onStatus) this.onStatus('connecting', 'Retry in ' + Math.round(delay / 1000) + 's');
    this._reconnectTimer = setTimeout(function() {
      self._reconnectTimer = null;
      if (!self.connected) self.connect();
    }, delay);
  },

  /** Health watchdog — runs every 15s when connected, auto-recovers on failure */
  _startWatchdog: function() {
    if (this._watchdogTimer) return;
    var self = this;
    console.log('[TM] Watchdog started');

    this._watchdogTimer = setInterval(function() {
      if (!self.connected) return;

      // Chrome 83 doesn't have AbortSignal.timeout — use AbortController with manual timeout
      var ctrl, sig;
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        sig = ctrl.signal;
        setTimeout(function() { ctrl.abort(); }, 5000);
      }
      fetch(self._bridgeBase + '/health', { signal: sig })
        .then(function(resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function(data) {
          self._lastHealthy = Date.now();
          // Check gRPC connection health
          if (!data.grpc) {
            console.warn('[TM] Watchdog: gRPC disconnected — bridge may need restart');
          }
          // Workout state recovery: if app thinks workout should be running
          // but bridge says IDLE, WARN but do NOT auto-restart.
          // SAFETY: auto-restart could spin the belt if user fell off.
          if (self._expectRunning && data.workoutState === 'IDLE') {
            console.warn('[TM] Watchdog: workout dropped to IDLE — flagging for user');
            self._expectRunning = false;
            if (self.onWorkoutDropped) self.onWorkoutDropped();
          }
        })
        .catch(function() {
          var downFor = Date.now() - self._lastHealthy;
          console.warn('[TM] Watchdog: bridge unreachable (down ' + Math.round(downFor / 1000) + 's)');
          // If bridge has been down for more than 10s, force reconnect cycle
          if (downFor > 10000) {
            console.warn('[TM] Watchdog: forcing reconnect cycle');
            self.disconnect(true); // keep watchdog running
            self.connect();
          }
        });
    }, 15000);
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
      this.consoleState = msg.workout.consoleState || '';
      // Safety key detection — show/hide urgent warning
      if (msg.workout.safetyKeyOut && !this._safetyKeyWarning) {
        this._showSafetyKeyWarning();
      } else if (!msg.workout.safetyKeyOut && this._safetyKeyWarning) {
        this._hideSafetyKeyWarning();
      }
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

    // Distance (from glassos_service gRPC — more accurate than JS estimate)
    if (v.Distance !== undefined) {
      var dist = parseFloat(v.Distance);
      if (dist > 0) data.distanceKm = dist;
    }

    // Elapsed time (from glassos_service gRPC)
    if (v.Elapsed !== undefined) {
      var elapsed = parseInt(v.Elapsed);
      if (elapsed > 0) data.elapsedSec = elapsed;
    }

    // Elevation gain (from glassos_service gRPC)
    if (v.Elevation !== undefined) {
      var elev = parseFloat(v.Elevation);
      if (elev > 0) data.elevationGain = elev;
    }

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
    if (this._estopActive) return; // SAFETY: e-stop blocks all speed commands
    if (!this.connected) return;
    var kph = +(+kmh).toFixed(1);
    if (isNaN(kph)) return;
    // SAFETY: hard clamp to machine maximum (X32i: 0–22 kph)
    kph = Math.max(0, Math.min(22, kph));
    // DEDUP: never send the same rounded value twice (prevents beeping)
    if (kph === this._lastSpeed) return;
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
    if (this._estopActive) return; // SAFETY: e-stop blocks all incline commands
    if (!this.connected) return;
    if (isNaN(pct)) return;
    var clamped = Math.max(-6, Math.min(40, pct));
    var rounded = Math.round(clamped * 2) / 2;
    // DEDUP: never send the same rounded value twice (prevents beeping)
    if (rounded === this._lastIncline) return;
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

  /** Emergency stop — immediately set speed to 0, block further motor commands.
   *  SAFETY: Speed goes to 0 FIRST (immediate danger), then incline after 500ms.
   *  The _estopActive flag prevents any other code from sending speed/incline
   *  commands until the user explicitly resumes or starts a new workout. */
  _estopActive: false,
  emergencyStop: function() {
    this._estopActive = true;
    this._expectRunning = false;
    // PRIORITY 1: Stop the belt immediately
    this._lastSpeed = 0;
    this._lastSpeedT = 0;
    this._send({ values: { KPH: 0 }, type: 'set' });
    // Send speed=0 again for redundancy
    this._send({ values: { KPH: 0 }, type: 'set' });
    console.warn('[TM] EMERGENCY STOP — belt speed zeroed');
    // PRIORITY 2: Flatten incline after a short delay (belt stop is more urgent)
    var self = this;
    setTimeout(function() {
      self._lastIncline = 0;
      self._lastInclineT = 0;
      self._send({ values: { Incline: 0 }, type: 'set' });
      console.warn('[TM] EMERGENCY STOP — incline zeroed');
    }, 500);
    // Also send the workout stop command
    this._send({ type: 'workout', action: 'stop' });
  },
  /** Clear e-stop flag — called when user explicitly starts a new workout */
  clearEstop: function() {
    this._estopActive = false;
  },

  // ── Workout lifecycle (gRPC via bridge) ────────────────────────────────

  // Watchdog flag: set when the app expects a workout to be running
  _expectRunning: false,

  /** Start a new manual workout — spins up the belt motor. */
  startWorkout: function() {
    console.log('[TM] Starting workout...');
    this._expectRunning = true;
    this._send({ type: 'workout', action: 'start' });
  },

  /** Stop the current workout — belt stops. */
  stopWorkout: function() {
    console.log('[TM] Stopping workout...');
    this._expectRunning = false;
    this._send({ type: 'workout', action: 'stop' });
  },

  /** Pause the current workout. */
  pauseWorkout: function() {
    console.log('[TM] Pausing workout...');
    // Keep _expectRunning true — paused is still "should be active"
    this._send({ type: 'workout', action: 'pause' });
  },

  /** Resume a paused workout. */
  resumeWorkout: function() {
    console.log('[TM] Resuming workout...');
    this._expectRunning = true;
    this._send({ type: 'workout', action: 'resume' });
  },

  // ── Safety key warning ───────────────────────────────────────────────

  _safetyKeyWarning: false,

  _showSafetyKeyWarning: function() {
    this._safetyKeyWarning = true;
    var el = document.getElementById('safetyKeyBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'safetyKeyBanner';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;' +
        'background:rgba(255,30,30,.95);color:#fff;text-align:center;' +
        'padding:16px;font-size:20px;font-weight:900;font-family:Rajdhani,sans-serif;' +
        'letter-spacing:.1em;text-transform:uppercase;animation:safetyblink 1s infinite;';
      el.textContent = '⚠ SAFETY KEY REMOVED ⚠';
      document.body.appendChild(el);
      // Add blink animation
      if (!document.getElementById('safetyKeyStyle')) {
        var style = document.createElement('style');
        style.id = 'safetyKeyStyle';
        style.textContent = '@keyframes safetyblink{0%,100%{opacity:1}50%{opacity:.5}}';
        document.head.appendChild(style);
      }
    }
    el.style.display = '';
    console.warn('[TM] SAFETY KEY REMOVED — belt will stop');
  },

  _hideSafetyKeyWarning: function() {
    this._safetyKeyWarning = false;
    var el = document.getElementById('safetyKeyBanner');
    if (el) el.style.display = 'none';
    console.log('[TM] Safety key restored');
  },

  /** Fetch console hardware info from bridge */
  getConsoleInfo: function(callback) {
    fetch(this._bridgeBase + '/api/console')
      .then(function(r) { return r.json(); })
      .then(function(data) { if (callback) callback(data); })
      .catch(function(err) { console.warn('[TM] Console info fetch failed:', err); });
  },
};

// ── BLE Heart Rate Monitor ──────────────────────────────────────────────────

var BLEHR = {
  device: null,
  connected: false,
  onHR: null,       // (hr) =>
  onStatus: null,   // (state, name) =>
  _disconnectHandler: null,
  _hrHandler: null,
  _char: null,

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
      // Remove stale listener from previous connection to same device
      if (self._disconnectHandler) {
        device.removeEventListener('gattserverdisconnected', self._disconnectHandler);
      }
      self._disconnectHandler = function() {
        self.connected = false;
        if (self.onStatus) self.onStatus('idle');
      };
      device.addEventListener('gattserverdisconnected', self._disconnectHandler);
      return device.gatt.connect();
    }).then(function(server) {
      return server.getPrimaryService('heart_rate');
    }).then(function(svc) {
      return svc.getCharacteristic('heart_rate_measurement');
    }).then(function(char) {
      self._char = char;
      self._hrHandler = function(e) {
        var flags = e.target.value.getUint8(0);
        var hr = (flags & 1)
          ? e.target.value.getUint16(1, true)
          : e.target.value.getUint8(1);
        if (hr > 30 && hr < 220 && self.onHR) self.onHR(hr);
      };
      char.addEventListener('characteristicvaluechanged', self._hrHandler);
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
    // Remove characteristic listener to prevent accumulation on reconnect
    if (this._char && this._hrHandler) {
      try { this._char.removeEventListener('characteristicvaluechanged', this._hrHandler); } catch(e) {}
      this._char = null;
      this._hrHandler = null;
    }
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
  _disconnectHandler: null,
  _dataHandler: null,
  _char: null,

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
      if (self._disconnectHandler) {
        device.removeEventListener('gattserverdisconnected', self._disconnectHandler);
      }
      self._disconnectHandler = function() {
        self.connected = false;
        if (self.onStatus) self.onStatus('idle');
      };
      device.addEventListener('gattserverdisconnected', self._disconnectHandler);
      return device.gatt.connect();
    }).then(function(server) {
      return server.getPrimaryService(SVC);
    }).then(function(svc) {
      return svc.getCharacteristic(CHAR);
    }).then(function(char) {
      self._char = char;
      self._dataHandler = function(e) {
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
      };
      char.addEventListener('characteristicvaluechanged', self._dataHandler);
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

  disconnect: function() {
    if (this._char && this._dataHandler) {
      try { this._char.removeEventListener('characteristicvaluechanged', this._dataHandler); } catch(e) {}
      this._char = null;
      this._dataHandler = null;
    }
    if (this.device && this.device.gatt.connected) {
      try { this.device.gatt.disconnect(); } catch(e) {}
    }
    this.connected = false;
    if (this.onStatus) this.onStatus('idle');
  },
};
