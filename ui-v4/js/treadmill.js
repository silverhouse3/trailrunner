// ════════════════════════════════════════════════════════════════════════════
// Treadmill — HTTP/WebSocket control via TrailRunner Bridge + BLE HR + BLE FTMS
// ════════════════════════════════════════════════════════════════════════════

// Connection priority:
//   1. HTTP REST to TrailRunner Bridge (port 4510) — most reliable from HTTPS
//   2. WebSocket to TrailRunner Bridge (port 4510) — real-time updates
//   3. WebSocket to uthttpd (port 80, 8080) — legacy Wolf firmware
//   4. BLE FTMS — read-only, connect HR separately

// ui-v4: pick the bridge host automatically.
//   ?bridge=host:port              → explicit override
//   served from :8099 (local dev)  → same host as the page, port 4510 (mock)
//   served from a LAN IP           → that IP:4510 (phone/tablet opening the PC)
//   anything else (GitHub Pages on the treadmill) → 127.0.0.1:4510 (real bridge)
var TR_BRIDGE_HOST = (function () {
  try {
    var q = /[?&]bridge=([^&]+)/.exec(window.location.search);
    if (q) return decodeURIComponent(q[1]);
    var h = window.location.hostname;
    if (window.location.port === '8099') return h + ':4510';
    if (/^(\d+\.){3}\d+$/.test(h) && h !== '127.0.0.1') return h + ':4510';
  } catch (e) {}
  return '127.0.0.1:4510';
})();

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
  _bridgeBase: 'http://' + TR_BRIDGE_HOST,
  _bridgeHost: TR_BRIDGE_HOST.split(':')[0],
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
  onWorkoutStarted: null,  // () => — called when workout transitions to RUNNING

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
        self._learnLimits();
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
    this._cancelRamp();
    this._sentSpeed = -1;
    this._beltKph = -1;
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
      this.ws = new WebSocket('ws://' + this._bridgeHost + ':' + port + (port === 4510 ? '/ws' : ''));

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
    // ui-v4 fix: don't flip the pill back to "connecting" when we are already connected
    if (this.onStatus && !this.connected) this.onStatus('connecting', 'HTTP poll');
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
          if (self._expectRunning && data.workoutState === 'IDLE' && self._pauseConfirmed()) {
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
    // The real bridge ignores 'Fan Speed': never send it unless a bridge declares support
    if (obj && obj.values && obj.values['Fan Speed'] !== undefined && !this.fanSupported) return;
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
        }).then(function(r) { return r.json(); }).then(function(d) { self._afterCommand('speed', d); }).catch(function(){});
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
        }).then(function(r) { return r.json(); }).then(function(d) { self._afterCommand('incline', d); }).catch(function(){});
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
                // Notify app so it can re-send target speed/incline
                if (self.onWorkoutStarted) self.onWorkoutStarted();
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

  /** A rejected /speed or /incline reply ({ok:false}: safety key, ramp cap, not running…): clear the dedup so the
   *  next engine tick re-sends, and tell the app so it can show the reason + the REAL belt values. (audit P1-e) */
  onCommandRejected: null,   // (what, reason) =>
  _afterCommand: function(what, d) {
    if (!d || d.ok !== false) return;
    if (what === 'speed') { this._lastSpeed = -1; this._sentSpeed = -1; this._cancelRamp(); }
    else { this._lastIncline = -9999; }
    if (this.onCommandRejected) this.onCommandRejected(what, d.error || 'rejected');
  },

  /** Fan: the real bridge ignores "Fan Speed" (/command only handles KPH/MPH/Incline/Grade) — off unless a bridge says otherwise. */
  fanSupported: false,

  // ── Message handler ───────────────────────────────────────────────────

  _handleMessage: function(msg) {
    if (!msg) return;

    var dm = msg.type === 'message' ? msg : (msg.display && msg.display.message);
    if (dm && dm.id !== this._lastMsgId && typeof ScreenMessage !== 'undefined') {
      this._lastMsgId = dm.id;
      ScreenMessage.show(dm.text, dm.leftSeconds != null ? dm.leftSeconds : dm.seconds);
    }
    if (msg.type === 'message') return;

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

    if (!msg.values) { this._evalPause(); return; }
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
    if (data.speed !== undefined && !isNaN(data.speed)) this._beltKph = data.speed;
    this._evalPause();

    // Incline
    if (v.Incline !== undefined) data.incline = parseFloat(v.Incline);
    else if (v.Grade !== undefined) data.incline = parseFloat(v.Grade);

    // Heart Rate
    if (v['Heart Rate'] !== undefined) {
      var hr = parseInt(v['Heart Rate']);
      data.hr = isNaN(hr) ? 0 : hr;          // 0 = no sensor: the engine must see it (P0-1)
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

  /** Set belt speed (km/h).
   *  Bridge handles rate limiting (4 kph/s, 100ms min interval).
   *  PWA only dedup-filters to avoid redundant network traffic. */
  setSpeed: function(kmh, force, source) {
    var kph = +(+kmh).toFixed(1);
    // SAFETY: e-stop blocks speed commands > 0 only; a speed-0 request is NEVER refused by any guard
    if (this._estopActive && !(kph === 0)) return;
    if (!this.connected) return;
    if (isNaN(kph)) return;
    if (kph > 0 && !this._sessionStarted) { console.warn('[TM] setSpeed(' + kph + ') REFUSED — no user START this session'); return; }
    source = source || 'app';
    // SAFETY: clamp to the machine maximum (bridge /api/console max_kph, else X32i 19.3) AND the user's
    // configured 'Maximum speed' (Settings). A clipped request is reported so the UI can say so.
    var requested = kph;
    var cap = this.maxKph();
    kph = Math.max(0, Math.min(cap, kph));
    if (kph < requested - 1e-9) { this._lastClip = { requested: requested, sent: kph, at: Date.now(), cap: cap }; if (this.onClipped) this.onClipped(requested, kph, cap); }
    // STOP (0) always goes out AT ONCE and cancels any ramp
    if (kph === 0) {
      this._cancelRamp();
      this._lastSpeed = 0; this._lastSpeedT = Date.now(); this._target = 0;
      this._sendSpeedNow(0, source === 'app' ? 'stop' : source, requested);
      return;
    }
    // DEDUP: skip if the target is unchanged and either already sent or a ramp towards it is still running
    if (kph === this._lastSpeed && !force && (this._rampTimer || this._sentSpeed === kph)) return;
    this._lastSpeed = kph;
    this._lastSpeedT = Date.now();
    this._target = kph; this._targetSrc = source; this._targetReq = requested;
    this._cancelRamp();
    this._rampTick();
  },

  // ── Speed rate limiter ───────────────────────────────────────────────────
  // Real-device evidence (22 Oct): one big command let the belt go 1.6 -> 16 kph in ~5 s. So EVERY speed
  // request from ANY path (buttons, presets, workouts, HR autopilot, engine ramps) passes through here:
  // in any sliding window of _stepMs (1 s) the commanded speed may change by at most stepKph()
  // (Settings 'Speed change rate': 0.5 / 1 (default) / 2 / 3 kph per second). A move within that budget goes
  // out at once; a bigger one is stepped. 0 (stop) is never limited. Downward moves are stepped too.
  _stepMs: 1000,
  _rampTimer: null,
  _target: 0, _targetSrc: 'app', _targetReq: 0,
  _sentSpeed: -1,     // last speed this app sent (-1 = unknown)
  _lastSendT: 0,
  _beltKph: -1,       // last real belt speed reported by the bridge (-1 = unknown)
  _hist: [],          // recent sends [{t, k}] for the sliding window
  machineMaxKph: 19.3,
  machineMaxIncline: 15,   // X32i: -6 .. +40 % on paper; the bridge reports the real limits in /api/console
  machineMinIncline: -3,
  cmdLog: [],         // ring buffer of the last 200 outgoing commands (Settings > About > Command log)

  /** kph per step (= per _stepMs) from Settings; default 1.0 */
  stepKph: function() {
    var v = 1.0;
    try { if (typeof Store !== 'undefined') { var s = Store.getSettings(); if (s && s.speedRateKph > 0) v = +s.speedRateKph; } } catch (e) {}
    if (this._stepOverride > 0) v = this._stepOverride;
    return Math.max(0.1, Math.min(4, v));
  },
  /** effective maximum: min(machine max, user's 'Maximum speed') */
  maxKph: function() {
    var m = this.machineMaxKph > 0 ? this.machineMaxKph : 19.3;
    try { if (typeof Store !== 'undefined') { var s = Store.getSettings(); if (s && s.maxSpeedKph > 0) m = Math.min(m, +s.maxSpeedKph); } } catch (e) {}
    return Math.max(1, m);
  },

  _sendSpeedNow: function(kph, source, requested) {
    var now = Date.now();
    var base = this._rampBase();
    this._sentSpeed = kph;
    this._lastSendT = now;
    this._hist.push({ t: now, k: kph, base: base });
    if (this._hist.length > 60) this._hist.shift();
    this._log('speed', source || this._targetSrc || 'app', requested != null ? requested : (this._targetReq || kph), kph, base);
    this._send({ values: { KPH: kph }, type: 'set' });
  },
  /** Where a new move starts from: what we just sent if recent (a ramp is in flight), else the measured belt. */
  _rampBase: function() {
    if (this._sentSpeed >= 0 && Date.now() - this._lastSendT < 3000) return this._sentSpeed;
    if (this._beltKph >= 0) return this._beltKph;
    return this._sentSpeed >= 0 ? this._sentSpeed : 0;
  },
  /** The speed that was in force one window ago: the reference for the sliding-window budget. */
  _refKph: function(now) {
    // forget sends older than three windows, and anything that is not from this app's current state
    if (this._sentSpeed < 0) this._hist = [];
    var keep = [], i;
    for (i = 0; i < this._hist.length; i++) { var h = this._hist[i]; if (h.t <= now && now - h.t <= this._stepMs * 3 && h.t <= this._lastSendT) keep.push(h); }
    this._hist = keep;
    // quiet for a whole window: the full budget is available from the last sent speed
    if (this._sentSpeed >= 0 && this._lastSendT > 0 && now - this._lastSendT >= this._stepMs) return this._sentSpeed;
    // the latest send that is at least one window old
    for (i = this._hist.length - 1; i >= 0; i--) if (now - this._hist[i].t >= this._stepMs) return this._hist[i].k;
    // only recent sends: the budget counts from the speed before the burst started
    if (this._hist.length) return this._hist[0].base;
    return this._rampBase();
  },
  _rampTick: function() {
    this._rampTimer = null;
    if (this._estopActive || !this.connected) { this._cancelRamp(); return; }
    var now = Date.now(), target = this._target, step = this.stepKph();
    var ref = this._refKph(now);
    var next = +Math.min(ref + step, Math.max(ref - step, target)).toFixed(1);
    if (next !== this._sentSpeed) this._sendSpeedNow(next);
    if (next !== target) {
      // try again when the oldest send inside the window ages out
      var oldest = now; for (var i = 0; i < this._hist.length; i++) if (now - this._hist[i].t < this._stepMs) { oldest = this._hist[i].t; break; }
      var wait = Math.max(20, this._stepMs - (now - oldest) + 5);
      var self = this;
      this._rampTimer = setTimeout(function() { self._rampTick(); }, wait);
    }
  },
  /** The hardware stopped the belt behind our back (safety key, console STOP): forget what we last sent so the
   *  next move starts from the measured belt speed, not from the stale command. */
  resetSentState: function() {
    this._cancelRamp();
    this._sentSpeed = -1; this._lastSpeed = -1; this._target = 0; this._hist = [];
  },
  _cancelRamp: function() {
    if (this._rampTimer) { clearTimeout(this._rampTimer); this._rampTimer = null; }
  },

  /** Command log: ISO time, source, requested, sent, base (last 200; also console.log). The real bridge's
   *  /command only understands KPH/MPH/Incline/Grade (main.go v3.2 processMessage), so nothing is sent to it. */
  _log: function(what, source, requested, sent, base) {
    var line = { t: new Date().toISOString(), what: what, src: source, req: +(+requested).toFixed(1), sent: +(+sent).toFixed(1), base: +(+base).toFixed(1) };
    this.cmdLog.push(line); if (this.cmdLog.length > 200) this.cmdLog.shift();
    try { console.log('[CMD] ' + line.t + ' ' + what + ' src=' + source + ' req=' + line.req + ' sent=' + line.sent + ' base=' + line.base); } catch (e) {}
  },
  cmdLogText: function() {
    return this.cmdLog.map(function(l) { return l.t.slice(11, 19) + ' ' + l.what.toUpperCase() + ' ' + l.src + ' req ' + l.req + ' → sent ' + l.sent + ' (base ' + l.base + ')'; }).reverse().join('\n');
  },

  /** Set ramp incline (%).
   *  Bridge handles rate limiting. PWA only dedup-filters. */
  setIncline: function(pct, force) {
    if (this._estopActive) return; // SAFETY: e-stop blocks all incline commands
    if (!this.connected) return;
    if (isNaN(pct)) return;
    if (!this._sessionStarted) { console.warn('[TM] setIncline(' + pct + ') REFUSED — no user START this session'); return; }
    // SAFETY: clamp to the machine's own incline limits (defaults 15 / -3 until the bridge reports real ones)
    var clamped = Math.max(this.machineMinIncline, Math.min(this.machineMaxIncline, pct));
    var rounded = Math.round(clamped * 2) / 2;
    // DEDUP: skip if value unchanged
    if (rounded === this._lastIncline && !force) return;
    this._lastIncline = rounded;
    this._lastInclineT = Date.now();
    this._log('incline', 'app', pct, rounded, this._lastIncline);
    this._send({ values: { Incline: rounded }, type: 'set' });
  },

  /** Set fan speed (0–100%). Quantised to 10% steps. */
  setFan: function(pct) {
    if (!this.connected || !this.fanSupported) return;
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
    this._cancelRamp();
    this._sentSpeed = 0;
    this._lastSendT = Date.now();
    this._expectRunning = false;
    // PRIORITY 1: Stop the belt immediately (never limited)
    this._cancelRamp();
    this._lastSpeed = 0;
    this._lastSpeedT = 0;
    this._target = 0;
    this._sendSpeedNow(0, 'estop', 0);
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
  /** SAFETY: the belt only starts from a direct user tap. App.userStart()/togglePause set _userTapAt. */
  _userTapAt: 0,
  _userStartedAt: 0,
  _sessionStarted: false,
  _lastStopAt: 0,
  _blockedStarts: 0,
  markUserTap: function() { this._userTapAt = Date.now(); this._userStartedAt = this._userTapAt; },
  _tapFresh: function() { return this._userTapAt > 0 && (Date.now() - this._userTapAt) < 5000; },
  /** True when the bridge reports a moving/open workout this page session did not start. */
  beltActiveElsewhere: function() {
    if (!this.connected || this._sessionStarted) return false;
    // a page session that sent a user START owns the belt (incl. deceleration after STOP/finish)
    if (this._userStartedAt > 0) return false;
    if (this._lastStopAt && Date.now() - this._lastStopAt < 30000) return false;
    return this.workoutState === 'RUNNING' || this._beltKph > 0.5;
  },
  startWorkout: function() {
    if (!this._tapFresh()) {
      this._blockedStarts++;
      console.warn('[TM] startWorkout REFUSED — no START/RESUME tap in the last 5 s');
      return;
    }
    console.log('[TM] Starting workout...');
    this._graceUntil = Date.now() + this._graceMs;
    this._sessionStarted = true;
    this._expectRunning = true;
    this._send({ type: 'workout', action: 'start' });
  },

  /** Stop the current workout — belt stops. */
  stopWorkout: function() {
    console.log('[TM] Stopping workout...');
    this._expectRunning = false;
    this._sessionStarted = false;
    this._lastStopAt = Date.now();
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
    if (!this._tapFresh() && !this._sessionStarted) {
      this._blockedStarts++;
      console.warn('[TM] resumeWorkout REFUSED — no RESUME tap and no session start');
      return;
    }
    console.log('[TM] Resuming workout...');
    this._graceUntil = Date.now() + this._graceMs;
    this._sessionStarted = true;
    this._expectRunning = true;
    this._send({ type: 'workout', action: 'resume' });
  },

  // ── Transient PAUSED/IDLE after StartNewWorkout (console WARM_UP) must not look like a real pause ──
  // A real pause = workout PAUSED (or IDLE while we expect a run) AND measured belt < 0.5 kph for >= 2 s, outside the
  // 4 s grace after our own START/RESUME. Safety key is handled separately and is immediate. Never sends a command.
  _graceMs: 4000, _graceUntil: 0, _slowSince: 0, _dropFired: false, syncing: false,
  _pauseConfirmed: function() {
    return Date.now() >= this._graceUntil && !(this._beltKph > 0.5) && this._slowSince > 0 && (Date.now() - this._slowSince) >= 2000;
  },
  _evalPause: function() {
    var was = this.syncing, now = Date.now();
    if (this.workoutState === 'RUNNING') { this._slowSince = 0; this._dropFired = false; this.syncing = false; }
    else if (this._safetyKeyWarning || !(this.workoutState === 'PAUSED' || (this.workoutState === 'IDLE' && this._expectRunning))) { this._slowSince = 0; this.syncing = false; }
    else if (this._beltKph > 0.5) { this._slowSince = 0; this.syncing = true; }
    else if (now < this._graceUntil) { this._slowSince = 0; this.syncing = true; }
    else {
      if (!this._slowSince) this._slowSince = now;
      this.syncing = false;
      if (!this._dropFired && this._pauseConfirmed()) {
        this._dropFired = true; this._expectRunning = false;
        if (this.onWorkoutDropped) this.onWorkoutDropped();
      }
    }
    if (was !== this.syncing && this.onWorkout) { try { this.onWorkout({}); } catch (e) {} }
  },

  // ── Safety key warning ───────────────────────────────────────────────

  _safetyKeyWarning: false,

  _showSafetyKeyWarning: function() {
    this._safetyKeyWarning = true;
    if (typeof App !== 'undefined' && App.pauseForSafetyKey) { try { App.pauseForSafetyKey(); } catch (e) {} }
    var el = document.getElementById('safetyKeyBanner');
    if (el && el.classList.contains('safety-banner')) {
      // ui-v4: designed in-DOM banner
      el.classList.add('show');
      if (typeof App !== 'undefined' && App._updateStateBanner) App._updateStateBanner();
      console.warn('[TM] SAFETY KEY REMOVED — belt will stop');
      return;
    }
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
    if (el && el.classList.contains('safety-banner')) el.classList.remove('show');
    else if (el) el.style.display = 'none';
    if (typeof App !== 'undefined' && App._updateStateBanner) App._updateStateBanner();
    console.log('[TM] Safety key restored');
  },

  /** Machine limits from the bridge (/api/console max_kph); fallback 19.3 */
  _learnLimits: function() {
    var self = this;
    this.getConsoleInfo(function(info) {
      var m = info && (info.max_kph || info.max_speed_kph || info.maxKph);
      if (m > 5 && m < 40) { self.machineMaxKph = +m; console.log('[TM] machine max ' + m + ' kph'); }
      var mi = info && (info.max_incline_pct != null ? info.max_incline_pct : info.maxIncline);
      if (mi > 0 && mi <= 40) self.machineMaxIncline = +mi;
      var mn = info && (info.min_incline_pct != null ? info.min_incline_pct : info.minIncline);
      if (typeof mn === 'number' && mn <= 0 && mn >= -10) self.machineMinIncline = +mn;
    });
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
      console.warn('[BLEHR] Web Bluetooth not available on this device');
      if (this.onStatus) this.onStatus('idle', 'No Bluetooth');
      // Show a visible message
      var el = document.getElementById('mediaToast') || document.createElement('div');
      if (!el.id) {
        el.id = 'mediaToast';
        el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
          'background:rgba(255,159,67,0.9);color:#fff;padding:10px 24px;border-radius:8px;' +
          'font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;z-index:9999;' +
          'transition:opacity 0.5s;pointer-events:none;';
        document.body.appendChild(el);
      }
      el.textContent = 'Pair your heart-rate strap in iFIT (Workout settings > Devices); TrailRunner reads it from the treadmill.';
      el.style.opacity = '1';
      setTimeout(function() { el.style.opacity = '0'; }, 5000);
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
