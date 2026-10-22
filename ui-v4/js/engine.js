// ════════════════════════════════════════════════════════════════════════════
// Run Engine — state machine, distance tracking, HR zones, auto-control,
//              splits, calories, ghost racing, workout programmes
// ════════════════════════════════════════════════════════════════════════════

const Engine = {

  // ── Tick interval ──────────────────────────────────────────────────────────
  TICK_MS: 250,
  RESAMPLE_N: 200,

  // ── Run state ──────────────────────────────────────────────────────────────
  run: null,   // populated by newRun()

  // ── Route data (set by loadRoute) ──────────────────────────────────────────
  route: null,       // stored route metadata
  resampled: null,   // [{lat,lon,ele,dist}] — N evenly-spaced points
  elevation: null,   // [ele, ele, ...] — just the numbers
  latlngs: null,     // [[lat,lon], ...] — for Leaflet

  // ── Control ────────────────────────────────────────────────────────────────
  ctrl: {
    mode: 'route',        // manual | route | hr-incline | hr-speed
    targetZone: 2,
    targetSpeed: 0,       // km/h — starts at 0, user sets before run
    targetIncline: 0,     // % — starts at 0, user sets before run
  },

  // ── HR zones (standard 5-zone model) ───────────────────────────────────────
  HR_ZONES: [
    { z: 1, min: 0.50, max: 0.60, label: 'Recovery',  color: '#4fc3f7' },
    { z: 2, min: 0.60, max: 0.70, label: 'Aerobic',   color: '#69f0ae' },
    { z: 3, min: 0.70, max: 0.80, label: 'Tempo',     color: '#ffe066' },
    { z: 4, min: 0.80, max: 0.90, label: 'Threshold', color: '#ffb74d' },
    { z: 5, min: 0.90, max: 1.00, label: 'VO₂max',   color: '#ff5f5f' },
  ],

  // ── Ghost ──────────────────────────────────────────────────────────────────
  ghost: null,        // { run, distanceM, routeIdx }
  ghostEnabled: false,

  // ── Active workout programme ───────────────────────────────────────────────
  workout: null,      // { programme, stageIdx, stageElapsed, totalElapsed }

  // ── Fan auto-control ───────────────────────────────────────────────────────
  _lastFanUpdate: 0,

  // ── Timer handle ───────────────────────────────────────────────────────────
  _tickHandle: null,
  _lastTickTime: 0,

  // ════════════════════════════════════════════════════════════════════════════
  // ROUTE
  // ════════════════════════════════════════════════════════════════════════════

  loadRoute(storedRoute) {
    this.route = storedRoute;
    this.resampled = storedRoute.resampled;
    this.elevation = this.resampled.map(p => p.ele);
    this.latlngs = this.resampled.map(p => [p.lat, p.lon]);
  },

  clearRoute() {
    this.route = null;
    this.resampled = null;
    this.elevation = null;
    this.latlngs = null;
  },

  hasRoute() { return this.route !== null && this.resampled !== null; },

  // ════════════════════════════════════════════════════════════════════════════
  // RUN LIFECYCLE
  // ════════════════════════════════════════════════════════════════════════════

  newRun() {
    const settings = Store.getSettings();
    this.run = {
      status: 'ready',       // ready | running | paused | finished
      startedAt: null,
      finishedAt: null,

      // Core metrics
      distanceM: 0,
      elapsed: 0,            // seconds of actual running (excludes pauses)
      speed: 0,              // km/h (from treadmill or manual)
      hr: 0,                 // bpm
      incline: 0,            // current incline %
      calories: 0,
      cadence: 0,
      strideLength: 0,     // metres per stride
      gct: 0,              // ground contact time (ms)
      vertOsc: 0,          // vertical oscillation (cm)

      // Route tracking
      routeProgress: 0,      // 0 → 1
      routeIdx: 0,           // index into resampled array
      currentGrade: 0,       // % gradient at current position
      currentEle: this.elevation ? this.elevation[0] : 0,
      elevGained: 0,

      // Data sources
      speedSource: 'none',   // none | treadmill | ftms | simulation
      hrSource: 'none',      // none | treadmill | ble | simulation

      // Splits
      splits: [],
      _lastSplitKm: 0,
      _lastSplitElapsed: 0,
      _splitHRSum: 0,
      _splitHRSamples: 0,

      // Averages
      _hrSum: 0,
      _hrSamples: 0,
      _speedSum: 0,
      _speedSamples: 0,
      _speedMax: 0,

      // Track points for GPX export (sampled every ~5s)
      trackPoints: [],
      _lastTrackPointTime: 0,

      // Route reference
      routeId: this.route ? this.route.id : null,
      routeName: this.route ? this.route.name : 'Free Run',

      // Resume ramp-up tracking
      _resumeElapsed: null, // elapsed time at last resume (for gentle ramp-up)

      // Running power (watts) — mechanical power model
      power: 0,             // instantaneous watts
      _powerSum: 0,
      _powerSamples: 0,
      _powerMax: 0,
      _strideSum: 0,
      _strideSamples: 0,

      // Negative split tracking
      _consecutiveNegSplits: 0,

      // Effort score (Banister TRIMP — Training Impulse)
      // Accumulates HR-weighted training load throughout the workout.
      // Result: 0-50 easy, 50-100 moderate, 100-200 hard, 200+ very hard
      _trimp: 0,
      _hrZoneMinutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },

      // Auto-pause detection
      _zeroSpeedSince: 0,  // timestamp when speed first dropped to 0
      _autoPaused: false,   // currently auto-paused?

      // Cardiac drift detection — tracks HR:pace ratio over time
      // Drift >5% = dehydration/fatigue indicator
      _driftSamples: [],       // [{elapsed, hrPaceRatio}] sampled every 30s
      _driftBaseline: 0,       // avg HR:pace ratio in first 10 min
      _driftBaselineLocked: false,
      _driftPct: 0,            // current drift percentage
      _driftWarned: false,     // whether drift warning has been announced
      _lastDriftSample: 0,     // elapsed at last sample

      // Efficiency Factor (EF) = speed / HR — tracks aerobic efficiency
      _efSamples: [],          // [{elapsed, ef}]

      // Settings snapshot
      maxHR: settings.maxHR,
      weight: settings.weight,
    };
  },

  startRun() {
    if (!this.run) this.newRun();
    this.run.status = 'running';
    this.run.startedAt = new Date().toISOString();
    this._lastTickTime = Date.now();
    this._startTicker();
  },

  pauseRun(hardwareStopped) {
    if (!this.run || this.run.status !== 'running') return;
    var speed = this.run.speed;

    // Set status immediately (UI shows pause overlay)
    this.run.status = 'paused';
    this._stopTicker();

    // Safety key out: the console has already stopped the belt and dropped the workout. Nothing is sent;
    // RESUME (user tap) starts a new treadmill workout and re-sends the target through the limiter.
    if (hardwareStopped) {
      if (this._decelTimer) { clearInterval(this._decelTimer); this._decelTimer = null; }
      this._ramp = null;
      if (TM.resetSentState) TM.resetSentState(); else { if (TM._cancelRamp) TM._cancelRamp(); TM._lastSpeed = -1; }
      this.run._keyPaused = true;
      return;
    }

    if (speed < 0.5) {
      TM.setSpeed(0, true);
      TM.pauseWorkout();
    } else {
      // Graceful deceleration — proportional to current speed, max 10s
      // Incline stays where it is during pause
      var dur = Math.max(3, Math.min(10, speed * 1.2));
      this._gracefulRamp(speed, 0, 0, 0, dur, function() {
        TM.pauseWorkout();
      });
    }
  },

  resumeRun() {
    if (!this.run || this.run.status !== 'paused') return;
    // ui-v4 fix: a resume during the pause ramp-down must cancel that ramp (it would otherwise keep
    // lowering the speed and finally send TM.pauseWorkout() under a running app)
    if (this._decelTimer) { clearInterval(this._decelTimer); this._decelTimer = null; }
    this._ramp = null;
    this.run.status = 'running';
    // bring the belt back to the target through the rate limiter (the pause ramp sent 0)
    if (this.ctrl.targetSpeed > 0) TM.setSpeed(this.ctrl.targetSpeed, true, 'resume');
    this.run._resumeElapsed = this.run.elapsed; // mark for gentle ramp-up
    this._lastTickTime = Date.now();
    this._startTicker();
    // The bridge drops the workout to IDLE when the safety key comes out (and the real console does the
    // same): a resume then has to START a new treadmill workout; TM.onWorkoutStarted re-sends the target.
    if (TM.workoutState === 'IDLE' && TM.startWorkout) TM.startWorkout(); else TM.resumeWorkout();
  },

  finishRun(immediate) {
    if (!this.run) return;
    if (this.run.status === 'finished') return; // prevent double-call
    var speed = this.run.speed;
    var incline = Math.max(this.run.incline, 0);
    if (immediate) {
      // STOP button rule: zero the belt AT ONCE (never rate-limited), cancel any ramp, then finish normally
      if (this._decelTimer) { clearInterval(this._decelTimer); this._decelTimer = null; }
      this._ramp = null;
      if (TM._cancelRamp) TM._cancelRamp();
      this.ctrl.targetSpeed = 0;
      TM.setSpeed(0, true);
      speed = 0; incline = 0;
    }

    // Finalize run state immediately (UI shows summary, save works)
    this.run.status = 'finished';
    this.run.finishedAt = new Date().toISOString();
    this._stopTicker();
    if (this.workout) this.workout = null;

    // ui-v4: final partial km split (labelled with its real distance), persisted with the run
    var partialM = this.run.distanceM - this.run.splits.length * 1000;
    if (partialM > 25) {
      var pTime = Math.max(0, this.run.elapsed - (this.run._lastSplitElapsed || 0));
      this.run.finalSplit = {
        km: this.run.splits.length + 1,
        distKm: +(partialM / 1000).toFixed(2),
        timeSec: Math.round(pTime),
        paceSecPerKm: partialM > 0 ? Math.round(pTime / (partialM / 1000)) : 0,
        avgHR: this.run._splitHRSamples > 0 ? Math.round(this.run._splitHRSum / this.run._splitHRSamples) : 0,
        partial: true,
      };
    } else {
      this.run.finalSplit = null;
    }

    // Start HR recovery tracking (measures HR drop over 60 seconds post-finish)
    if (this.run.hr > 30) {
      this.run._hrAtFinish = this.run.hr;
      this.run._recoveryStart = Date.now();
      this._startRecoveryTimer();
    }

    if (speed < 0.5 && incline < 0.5) {
      // Already stopped — just zero everything
      TM.setSpeed(0, true);
      TM.setIncline(0, true);
      TM.stopWorkout();
    } else {
      // Graceful 15-second ramp-down (belt decelerates while user sees summary)
      this._gracefulRamp(speed, 0, incline, 0, 15, function() {
        TM.stopWorkout();
      });
    }
  },

  discardRun() {
    this._stopTicker();
    if (this._decelTimer) { clearInterval(this._decelTimer); this._decelTimer = null; }
    if (this._hrRecoveryTimer) { clearInterval(this._hrRecoveryTimer); this._hrRecoveryTimer = null; }

    // SAFETY: always return to zero on discard too
    TM.setSpeed(0, true);
    TM.setIncline(0, true);
    // ui-v4 fix: if discard interrupted the graceful ramp-down, the bridge workout
    // would otherwise be left RUNNING (belt at 0). Always end it.
    if (TM.workoutState !== 'IDLE' || TM._expectRunning) TM.stopWorkout();
    this.ctrl.targetSpeed = 0;
    this.ctrl.targetIncline = 0;

    this.run = null;
    this.ghost = null;
    this.workout = null;
  },

  /** Save the completed run to localStorage and update route stats. */
  saveRun() {
    if (!this.run || this.run.status !== 'finished') return null;
    const r = this.run;
    const summary = {
      routeId: r.routeId,
      routeName: r.routeName,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      distanceM: Math.round(r.distanceM),
      distanceKm: +(r.distanceM / 1000).toFixed(2),
      elapsed: Math.round(r.elapsed),
      avgSpeed: r._speedSamples > 0 ? +(r._speedSum / r._speedSamples).toFixed(1) : 0,
      maxSpeed: +(r._speedMax || 0).toFixed(1),
      avgHR: r._hrSamples > 0 ? Math.round(r._hrSum / r._hrSamples) : 0,
      maxHR: r.maxHR,
      calories: Math.round(r.calories),
      elevGained: Math.round(r.elevGained),
      inclineMax: 0,
      splits: r.splits,
      finalSplit: r.finalSplit || null,   // ui-v4: partial last km {distKm, timeSec, avgHR, partial:true}; absent on old runs
      splitsVersion: 2,
      trackPoints: r.trackPoints,
      effortScore: Math.round(r._trimp || 0),
      hrZoneMinutes: r._hrZoneMinutes || null,
      hrRecovery: r._hrRecovery || null,
      avgPower: r._powerSamples > 0 ? Math.round(r._powerSum / r._powerSamples) : 0,
      maxPower: Math.round(r._powerMax || 0),
      negativeSplits: r.splits.filter(function(s) { return s.negativeSplit; }).length,
      cardiacDrift: r._driftBaselineLocked ? +r._driftPct.toFixed(1) : null,
      efficiencyFactor: r._efSamples.length > 0
        ? +(r._efSamples.reduce(function(a, b) { return a + b.ef; }, 0) / r._efSamples.length).toFixed(4)
        : null,
      avgStride: r._strideSamples > 0 ? +(r._strideSum / r._strideSamples).toFixed(3) : null,
    };

    const saved = Store.saveRun(summary);

    // Also save to IndexedDB (unlimited storage, async)
    if (typeof IDBStore !== 'undefined' && IDBStore._ready) {
      IDBStore.saveRun(summary);
    }

    // Update route stats
    if (r.routeId) {
      const updates = {
        lastRunDate: r.startedAt,
        runCount: (this.route.runCount || 0) + 1,
      };
      if (!this.route.bestTime || r.elapsed < this.route.bestTime) {
        updates.bestTime = Math.round(r.elapsed);
      }
      Store.updateRouteStats(r.routeId, updates);
    }

    return saved;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GHOST RACING
  // ════════════════════════════════════════════════════════════════════════════

  loadGhost(savedRun) {
    if (!savedRun || !savedRun.trackPoints || !savedRun.trackPoints.length) return;
    this.ghost = {
      run: savedRun,
      distanceM: 0,
      routeIdx: 0,
      elapsed: 0,
      _ptIdx: 0,
    };
    this.ghostEnabled = true;
  },

  clearGhost() {
    this.ghost = null;
    this.ghostEnabled = false;
  },

  _tickGhost(dt) {
    if (!this.ghost || !this.ghostEnabled) return;
    this.ghost.elapsed += dt;

    // Advance ghost based on track point timestamps
    const pts = this.ghost.run.trackPoints;
    while (this.ghost._ptIdx < pts.length - 1) {
      const nextPt = pts[this.ghost._ptIdx + 1];
      if ((nextPt.elapsed || 0) <= this.ghost.elapsed) {
        this.ghost._ptIdx++;
        this.ghost.distanceM = nextPt.dist || 0;
      } else break;
    }

    // Update route index
    if (this.hasRoute()) {
      const totalM = this.route.totalDistM;
      const progress = Math.min(1, this.ghost.distanceM / totalM);
      this.ghost.routeIdx = Math.min(this.resampled.length - 1,
        Math.floor(progress * (this.resampled.length - 1)));
    }
  },

  /** Returns seconds ahead (+) or behind (-) the ghost. */
  ghostDelta() {
    if (!this.ghost || !this.run) return 0;
    const distDiff = this.run.distanceM - this.ghost.distanceM;
    // Convert distance delta to time delta using current speed
    if (this.run.speed > 0.5) {
      return distDiff / (this.run.speed / 3.6);
    }
    return distDiff > 0 ? 999 : -999;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // WORKOUT PROGRAMMES
  // ════════════════════════════════════════════════════════════════════════════

  startWorkout(programme) {
    this.workout = {
      programme,
      stageIdx: 0,
      stageElapsed: 0,
      totalElapsed: 0,
    };
    this._applyWorkoutStage();
  },

  _tickWorkout(dt) {
    if (!this.workout) return;
    const w = this.workout;
    w.stageElapsed += dt;
    w.totalElapsed += dt;

    const stage = w.programme.stages[w.stageIdx];
    if (!stage) { this.workout = null; return; }

    // Check if stage is complete
    if (w.stageElapsed >= stage.duration) {
      w.stageIdx++;
      w.stageElapsed = 0;
      if (w.stageIdx >= w.programme.stages.length) {
        // Programme complete
        this.workout = null;
        return;
      }
      this._applyWorkoutStage();
    }
  },

  _applyWorkoutStage() {
    if (!this.workout) return;
    const stage = this.workout.programme.stages[this.workout.stageIdx];
    if (!stage) return;

    // Set treadmill to stage targets
    if (stage.speed) {
      this.ctrl.targetSpeed = stage.speed;
      TM.setSpeed(stage.speed, false, 'workout');
    }
    if (stage.incline != null) {
      this.ctrl.targetIncline = stage.incline;
      TM.setIncline(stage.incline);
    }
    if (stage.zone) {
      this.ctrl.targetZone = stage.zone;
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // INCOMING DATA HANDLERS
  // ════════════════════════════════════════════════════════════════════════════

  /** Called when treadmill WebSocket sends data. */
  onTreadmillData(data) {
    if (!this.run) return;
    if (data.speed != null && data.speed >= 0 && data.speed < 40) {
      // Smooth speed readings — 70/30 blend with previous to reduce jitter
      // during belt ramp-up/down (the treadmill motor takes time to reach target)
      if (this.run.speedSource === 'treadmill' && this.run.speed > 0) {
        this.run.speed = +(this.run.speed * 0.3 + data.speed * 0.7).toFixed(1);
      } else {
        this.run.speed = data.speed;
      }
      this.run.speedSource = 'treadmill';
    }
    if (data.incline != null) {
      this.run.incline = data.incline;
    }
    if (data.hr != null && data.hr > 30 && data.hr < 220 && this.run.hrSource !== 'ble') {
      this._hrValid(data.hr, 'treadmill');
    } else if (data.hr != null && data.hr <= 30 && this.run.hrSource === 'treadmill') {
      // real bridge reports "Heart Rate":"0" when the sensor drops out → HR is LOST, never reuse the frozen value
      this._hrLost();
    }
    if (data.calories != null && data.calories > 0) {
      this.run.calories = data.calories;
    }

    // Auto-resume: if auto-paused and belt starts moving again, resume
    if (this.run._autoPaused && data.speed != null && data.speed > 0.5) {
      this.run._autoPaused = false;
      this.run._zeroSpeedSince = 0;
      this.run._resumeElapsed = this.run.elapsed;
      this.run.status = 'running';
      this._lastTickTime = Date.now();
      this._startTicker();
      if (this.onAutoResume) this.onAutoResume();
    }
  },

  /** Called when FTMS BLE sends data (read-only fallback). */
  onFTMSData(data) {
    if (!this.run) return;
    if (data.speed != null && this.run.speedSource !== 'treadmill') {
      this.run.speed = data.speed;
      this.run.speedSource = 'ftms';
    }
    if (data.incline != null) {
      this.run.incline = data.incline;
    }
    if (data.hr != null && data.hr > 30 && data.hr < 220 && this.run.hrSource !== 'ble') {
      this._hrValid(data.hr, 'ftms');
    } else if (data.hr != null && data.hr <= 30 && this.run.hrSource === 'ftms') {
      this._hrLost();
    }

    // Auto-resume for FTMS source
    if (this.run._autoPaused && data.speed != null && data.speed > 0.5) {
      this.run._autoPaused = false;
      this.run._zeroSpeedSince = 0;
      this.run._resumeElapsed = this.run.elapsed;
      this.run.status = 'running';
      this._lastTickTime = Date.now();
      this._startTicker();
      if (this.onAutoResume) this.onAutoResume();
    }
  },

  /** Called when BLE HR strap sends data (highest priority for HR). */
  onBLEHR(hr) {
    if (!this.run) return;
    this._hrValid(hr, 'ble');
  },

  // ── HR validity (P0-1): a lost / stale heart rate must never drive the belt ─────────────────
  HR_STALE_MS: 8000,      // no fresh sample for this long → LOST
  HR_REVALID_MS: 5000,    // after a loss HR must be back for this long before autopilot may raise anything

  _hrValid(hr, source) {
    var r = this.run, now = Date.now();
    r.hr = hr; r.hrSource = source; r._hrAt = now;
    if (r._hrLostAt) {                       // recovering from a loss: start the re-validation clock
      if (!r._hrBackAt) r._hrBackAt = now;
      if (now - r._hrBackAt >= this.HR_REVALID_MS) { r._hrLostAt = 0; r._hrBackAt = 0; r._hrLostNotified = false; }
    }
  },

  _hrLost() {
    var r = this.run; if (!r) return;
    var had = r.hr > 0 || r.hrSource !== 'none';
    r.hr = 0; r.hrSource = 'none'; r._hrAt = 0; r._hrBackAt = 0;
    if (!r._hrLostAt) r._hrLostAt = Date.now();
    if (had && !r._hrLostNotified) {
      r._hrLostNotified = true;
      try { if (typeof VoiceCmd !== 'undefined' && VoiceCmd._playTone) { VoiceCmd._playTone(330, 180); setTimeout(function () { VoiceCmd._playTone(330, 180); }, 250); } } catch (e) {}
      try { if (typeof App !== 'undefined' && App._toast) App._toast('HR LOST — heart-rate control is holding speed and incline', 'var(--orange)'); } catch (e) {}
      if (this.onHRLost) this.onHRLost();
    }
  },

  /** True when HR may drive autopilot: fresh sample AND (no loss, or back for >= HR_REVALID_MS). */
  hrUsable() {
    var r = this.run; if (!r || !(r.hr > 0)) return false;
    if (Date.now() - (r._hrAt || 0) > this.HR_STALE_MS) return false;
    if (r._hrLostAt && !(r._hrBackAt && Date.now() - r._hrBackAt >= this.HR_REVALID_MS)) return false;
    return true;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TICK — called every TICK_MS while running
  // ════════════════════════════════════════════════════════════════════════════

  tick() {
    if (!this.run || this.run.status !== 'running') return;

    const now = Date.now();
    const dt = (now - this._lastTickTime) / 1000; // seconds since last tick
    this._lastTickTime = now;

    // Guard against huge dt (tab was backgrounded, etc.) and against the wall
    // clock stepping backwards (NTP/WSL adjustments made elapsed go negative).
    const cappedDt = Math.max(0, Math.min(dt, 2));

    // ── Elapsed time ─────────────────────────────────────────────────────
    this.run.elapsed += cappedDt;

    // ── Distance from speed × time ───────────────────────────────────────
    const speedMs = this.run.speed / 3.6; // km/h → m/s
    const distDelta = speedMs * cappedDt;
    this.run.distanceM += distDelta;

    // ── Route position ───────────────────────────────────────────────────
    if (this.hasRoute()) {
      const totalM = this.route.totalDistM;
      this.run.routeProgress = Math.min(1, this.run.distanceM / totalM);
      const exactIdx = this.run.routeProgress * (this.resampled.length - 1);
      this.run.routeIdx = Math.min(this.resampled.length - 1, Math.floor(exactIdx));

      // Elevation at current position (interpolated)
      const idx = this.run.routeIdx;
      const frac = exactIdx - idx;
      const ele0 = this.elevation[idx];
      const ele1 = idx < this.elevation.length - 1 ? this.elevation[idx + 1] : ele0;
      const newEle = ele0 + frac * (ele1 - ele0);

      // Track elevation gain
      if (newEle > this.run.currentEle) {
        this.run.elevGained += (newEle - this.run.currentEle);
      }
      this.run.currentEle = newEle;

      // Grade calculation (look ahead a few points for smoothing)
      this.run.currentGrade = this._calcGrade(this.run.routeIdx);

      // Check if run complete (reached end of route)
      if (this.run.routeProgress >= 1) {
        this.finishRun();
        if (this.onRunComplete) this.onRunComplete();
        return;
      }
    }

    // ── Cool-down or Auto-control ────────────────────────────────────────
    if (this.run._cooldown) {
      this._tickCooldown(cappedDt);
    } else {
      this._applyAutoControl();
    }

    // ── Software speed ramp (when not receiving live treadmill data) ──
    // Gentle ramp: 0.7 km/h/s for first 15s of run or after resume
    // Normal running: 2 km/h/s after ramp period
    if (this.run.speedSource !== 'treadmill' && this.run.speedSource !== 'ftms') {
      var timeSinceResume = (this.run._resumeElapsed != null)
        ? this.run.elapsed - this.run._resumeElapsed : Infinity;
      var baseRate = (this.run.elapsed < 15 || timeSinceResume < 15) ? 0.7 : 2.0;
      var rampRate = baseRate * cappedDt;
      var diff = this.ctrl.targetSpeed - this.run.speed;
      if (Math.abs(diff) > 0.05) {
        if (diff > 0) this.run.speed = Math.min(this.ctrl.targetSpeed, this.run.speed + rampRate);
        else this.run.speed = Math.max(this.ctrl.targetSpeed, this.run.speed - rampRate);
      } else {
        this.run.speed = this.ctrl.targetSpeed;
      }
      if (this.run.speed < 0) this.run.speed = 0;
    }

    // ── HR stats ─────────────────────────────────────────────────────────
    if (this.run.hr > 0) {
      this.run._hrSum += this.run.hr;
      this.run._hrSamples++;
      this.run._splitHRSum += this.run.hr;
      this.run._splitHRSamples++;

      // ── TRIMP accumulation (Banister method) ────────────────────────
      // TRIMP = duration(min) * HRr * 0.64 * e^(1.92 * HRr)
      // where HRr = (HR - HRrest) / (HRmax - HRrest)
      // Sampled every tick (0.25s) → convert to minutes
      var maxHR = this.run.maxHR || 185;
      var restHR = Math.round(maxHR * 0.42); // ~65 bpm for 155 maxHR
      var hrr = Math.max(0, (this.run.hr - restHR) / (maxHR - restHR));
      var tickMin = this.TICK_MS / 60000;
      this.run._trimp += tickMin * hrr * 0.64 * Math.exp(1.92 * hrr);

      // HR zone time tracking
      var hrPct = this.run.hr / maxHR;
      var zone = hrPct < 0.6 ? 'z1' : hrPct < 0.7 ? 'z2' : hrPct < 0.8 ? 'z3' : hrPct < 0.9 ? 'z4' : 'z5';
      this.run._hrZoneMinutes[zone] += tickMin;
    }

    // ── Speed stats ──────────────────────────────────────────────────────
    if (this.run.speed > 0.5) {
      this.run._speedSum += this.run.speed;
      this.run._speedSamples++;
      if (this.run.speed > this.run._speedMax) this.run._speedMax = this.run.speed;
    }

    // ── Running power (watts) ──────────────────────────────────────────
    // Mechanical model: P = mass × velocity × (Ecr + g × grade)
    // Ecr (energy cost of running) ≈ 0.98 J/(kg·m) on flat treadmill belt
    // grade as fraction (10% → 0.10), downhill clamped to -3%
    if (this.run.speed > 0.5) {
      var grade = Math.max(-0.03, (this.run.incline || 0) / 100);
      this.run.power = Math.round(
        this.run.weight * speedMs * (0.98 + 9.81 * grade)
      );
      if (this.run.power < 0) this.run.power = 0;
      this.run._powerSum += this.run.power;
      this.run._powerSamples++;
      if (this.run.power > this.run._powerMax) this.run._powerMax = this.run.power;
    } else {
      this.run.power = 0;
    }

    // ── Cardiac drift detection (sampled every 30s) ──────────────────────
    // HR:pace ratio = HR / speed. Rising ratio at constant pace = drift.
    // Drift >5% indicates dehydration or fatigue.
    if (this.run.hr > 50 && this.run.speed > 3 &&
        this.run.elapsed - this.run._lastDriftSample >= 30) {
      this.run._lastDriftSample = this.run.elapsed;
      var hrPaceRatio = this.run.hr / this.run.speed;
      var ef = this.run.speed / this.run.hr; // efficiency factor
      this.run._driftSamples.push({ elapsed: this.run.elapsed, hrPaceRatio: hrPaceRatio });
      this.run._efSamples.push({ elapsed: this.run.elapsed, ef: ef });

      // Lock baseline after 10 minutes (need stable data)
      if (!this.run._driftBaselineLocked && this.run.elapsed >= 600 && this.run._driftSamples.length >= 10) {
        // Average of first 10 min of samples
        var baselineSum = 0;
        var baselineCount = 0;
        for (var di = 0; di < this.run._driftSamples.length; di++) {
          if (this.run._driftSamples[di].elapsed <= 600) {
            baselineSum += this.run._driftSamples[di].hrPaceRatio;
            baselineCount++;
          }
        }
        if (baselineCount > 0) {
          this.run._driftBaseline = baselineSum / baselineCount;
          this.run._driftBaselineLocked = true;
        }
      }

      // Calculate current drift (rolling 5-min average vs baseline)
      if (this.run._driftBaselineLocked && this.run._driftBaseline > 0) {
        var recentSum = 0;
        var recentCount = 0;
        for (var dj = this.run._driftSamples.length - 1; dj >= 0; dj--) {
          if (this.run.elapsed - this.run._driftSamples[dj].elapsed > 300) break;
          recentSum += this.run._driftSamples[dj].hrPaceRatio;
          recentCount++;
        }
        if (recentCount >= 3) {
          var recentAvg = recentSum / recentCount;
          this.run._driftPct = ((recentAvg - this.run._driftBaseline) / this.run._driftBaseline) * 100;
        }
      }

      // Drift warning (once at 5% threshold)
      if (this.run._driftPct >= 5 && !this.run._driftWarned) {
        this.run._driftWarned = true;
        if (this.onDriftWarning) this.onDriftWarning(this.run._driftPct);
      }
    }

    // ── Auto-pause: pause timer when treadmill belt stops ────────────────
    // Only when receiving real treadmill data (not simulation/free run)
    if (this.run.speedSource === 'treadmill' || this.run.speedSource === 'ftms') {
      if (this.run.speed < 0.3) {
        if (this.run._zeroSpeedSince === 0) {
          this.run._zeroSpeedSince = Date.now();
        } else if (!this.run._autoPaused && Date.now() - this.run._zeroSpeedSince > 3000) {
          // Belt stopped for 3+ seconds — auto-pause timer
          this.run._autoPaused = true;
          this._stopTicker();
          this.run.status = 'paused';
          if (this.onAutoPause) this.onAutoPause();
          return; // skip the rest of tick
        }
      } else {
        this.run._zeroSpeedSince = 0;
        // Auto-resume handled in onTreadmillData() since ticker is stopped during auto-pause
      }
    }

    // ── Cadence: prefer mic-detected, fall back to speed estimate ────────
    var micCadence = (typeof Cadence !== 'undefined' && Cadence.isActive()) ? Cadence.getCadence() : 0;
    if (micCadence > 0) {
      this.run.cadence = micCadence;
      this.run.cadenceSource = 'mic';
    } else if (this.run.speed > 1) {
      // Rough model: 155 spm at 6 km/h → 190 spm at 16 km/h
      this.run.cadence = Math.round(Math.max(150, Math.min(200,
        155 + (this.run.speed - 6) * 3.5)));
      this.run.cadenceSource = 'estimate';
    } else {
      this.run.cadence = 0;
      this.run.cadenceSource = null;
    }

    // ── Stride length (m) from speed and cadence ───────────────────────
    if (this.run.cadence > 0 && this.run.speed > 0) {
      // stride_m = (speed_kmh * 1000/60) / cadence_spm
      this.run.strideLength = (this.run.speed * 1000 / 60) / this.run.cadence;
      this.run._strideSum += this.run.strideLength;
      this.run._strideSamples++;
    } else {
      this.run.strideLength = 0;
    }

    // ── Ground Contact Time estimate (ms) ────────────────────────────
    // Based on cadence/speed research: GCT ≈ step_period - flight_time
    // step_period = 60000/cadence (ms per step)
    // Flight ratio increases with speed: ~0.35 at 6 kph → ~0.55 at 16 kph
    if (this.run.cadence > 0 && this.run.speed > 1) {
      var stepPeriod = 60000 / this.run.cadence; // ms per step
      var flightRatio = Math.min(0.55, Math.max(0.25, 0.25 + (this.run.speed - 4) * 0.025));
      this.run.gct = Math.round(stepPeriod * (1 - flightRatio));
      // Vertical oscillation (cm) — estimated from GCT
      // Elite ~6-8cm, recreational ~8-12cm
      this.run.vertOsc = Math.max(4, +(6 + (this.run.gct - 200) * 0.04).toFixed(1));
    } else {
      this.run.gct = 0;
      this.run.vertOsc = 0;
    }

    // ── Calorie estimate (if treadmill doesn't send calories) ────────────
    if (this.run.speedSource !== 'treadmill' || this.run.calories === 0) {
      // MET-based estimate: MET ≈ 1.0 + 0.17 × speed(km/h) + 0.1 × incline(%)
      const met = 1.0 + 0.17 * this.run.speed + 0.1 * Math.max(0, this.run.incline);
      // Calories/min = MET × 3.5 × weight(kg) / 200
      this.run.calories += (met * 3.5 * this.run.weight / 200) / 60 * cappedDt;
    }

    // ── Km splits ────────────────────────────────────────────────────────
    this._checkSplits();

    // ── Track point recording (every 5s for GPX export) ──────────────────
    this._recordTrackPoint();

    // ── Ghost tick ───────────────────────────────────────────────────────
    this._tickGhost(cappedDt);

    // ── Workout programme tick ───────────────────────────────────────────
    this._tickWorkout(cappedDt);

    // ── Fan auto-control (every 30s) ─────────────────────────────────────
    this._autoFan();

    // ── Notify UI ────────────────────────────────────────────────────────
    if (this.onTick) this.onTick();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════════════════════════

  _startTicker() {
    this._stopTicker();
    this._tickHandle = setInterval(() => this.tick(), this.TICK_MS);
  },

  _stopTicker() {
    if (this._tickHandle) { clearInterval(this._tickHandle); this._tickHandle = null; }
  },

  /** Calculate gradient at a point in the route (%). Looks ahead 5 points for smoothing. */
  _calcGrade(idx) {
    if (!this.elevation || idx >= this.elevation.length - 1) return 0;
    const lookAhead = 5;
    const i1 = Math.max(0, idx - 1);
    const i2 = Math.min(this.elevation.length - 1, idx + lookAhead);
    if (i2 <= i1) return 0;

    const elevChange = this.elevation[i2] - this.elevation[i1];
    const totalM = this.route.totalDistM;
    const distChange = (i2 - i1) * (totalM / this.resampled.length);
    if (distChange === 0) return 0;

    const grade = (elevChange / distChange) * 100;
    return Math.max(-6, Math.min(40, grade)); // clamp to X32i range
  },

  /** Apply auto-control based on current mode.
   *  TM.setSpeed/setIncline have built-in dedup so redundant calls are cheap,
   *  but we still gate on meaningful changes to avoid unnecessary function overhead. */
  AP_MIN_INTERVAL_MS: 5000,   // autopilot may change speed/incline at most once every 5 s (and never above the user's max)
  _apLastAdjust: 0,

  _applyAutoControl() {
    const maxHR = this.run.maxHR;
    // P0-1: a stale sample (no fresh HR for HR_STALE_MS) counts as LOST
    if (this.run.hr > 0 && Date.now() - (this.run._hrAt || 0) > this.HR_STALE_MS) this._hrLost();
    const hrMode = (this.ctrl.mode === 'hr-incline' || this.ctrl.mode === 'hr-speed');
    if (hrMode && !this.hrUsable()) {
      // HOLD: re-send the current targets unchanged, never raise anything until HR is valid again
      TM.setSpeed(this.ctrl.targetSpeed, false, 'hr-hold');
      TM.setIncline(this.ctrl.targetIncline);
      return;
    }
    const apMayAdjust = Date.now() - this._apLastAdjust >= this.AP_MIN_INTERVAL_MS;

    if (this.ctrl.mode === 'route') {
      // Auto-incline to match route gradient
      if (this.hasRoute()) {
        this.ctrl.targetIncline = this.run.currentGrade;
        // Set run.incline directly so it displays even without treadmill
        this.run.incline = this.run.currentGrade;
        // TM.setIncline has dedup — safe to call every tick, won't spam bridge
        TM.setIncline(this.run.currentGrade);
      }

    } else if (this.ctrl.mode === 'hr-incline') {
      // Speed fixed, incline adjusts to hold HR in target zone
      const zone = this.HR_ZONES[this.ctrl.targetZone - 1];
      const zMin = Math.round(maxHR * zone.min);
      const zMax = Math.round(maxHR * zone.max);
      const hr = this.run.hr;

      if (hr > 0 && apMayAdjust) {
        const maxInc = Math.min(15, (Store.getSettings().safetyMaxIncline || 15));
        if (hr > zMax + 3) {
          this.ctrl.targetIncline = Math.max(-3, this.ctrl.targetIncline - 0.5); this._apLastAdjust = Date.now();
        } else if (hr < zMin - 3) {
          this.ctrl.targetIncline = Math.min(maxInc, this.ctrl.targetIncline + 0.5); this._apLastAdjust = Date.now();
        }
      }
      // Dedup in TM.setSpeed/setIncline prevents redundant gRPC calls
      TM.setSpeed(this.ctrl.targetSpeed, false, 'hr');
      TM.setIncline(this.ctrl.targetIncline);

    } else if (this.ctrl.mode === 'hr-speed') {
      // Incline fixed, speed adjusts to hold HR in target zone
      const zone = this.HR_ZONES[this.ctrl.targetZone - 1];
      const zMin = Math.round(maxHR * zone.min);
      const zMax = Math.round(maxHR * zone.max);
      const hr = this.run.hr;

      if (hr > 0 && apMayAdjust) {
        if (hr > zMax + 3) {
          this.ctrl.targetSpeed = Math.max(3, this.ctrl.targetSpeed - 0.5); this._apLastAdjust = Date.now();
        } else if (hr < zMin - 3) {
          const settings = Store.getSettings();
          this.ctrl.targetSpeed = Math.min(settings.safetyMaxSpeed || 20, (typeof TM !== 'undefined' && TM.maxKph) ? TM.maxKph() : 19.3, this.ctrl.targetSpeed + 0.5); this._apLastAdjust = Date.now();
        }
      }
      // Dedup in TM.setSpeed/setIncline prevents redundant gRPC calls
      TM.setSpeed(this.ctrl.targetSpeed, false, 'hr');
      TM.setIncline(this.ctrl.targetIncline);
    }
    // mode === 'manual' — no auto-control, user controls treadmill directly
  },

  /** Check for km splits. */
  _checkSplits() {
    const distKm = this.run.distanceM / 1000;
    const currentKm = Math.floor(distKm);

    if (currentKm > this.run._lastSplitKm && currentKm > 0) {
      for (let k = this.run._lastSplitKm + 1; k <= currentKm; k++) {
        const splitElapsed = this.run.elapsed - this.run._lastSplitElapsed;
        // Use per-split HR average (not cumulative run average)
        const avgHR = this.run._splitHRSamples > 0
          ? Math.round(this.run._splitHRSum / this.run._splitHRSamples)
          : 0;
        const paceSecPerKm = Math.round(splitElapsed);

        // Detect negative split (current km faster than previous km)
        var isNegativeSplit = false;
        if (this.run.splits.length > 0) {
          var prevSplit = this.run.splits[this.run.splits.length - 1];
          if (splitElapsed < prevSplit.timeSec) {
            isNegativeSplit = true;
            this.run._consecutiveNegSplits++;
          } else {
            this.run._consecutiveNegSplits = 0;
          }
        }

        // Average power for this split
        var splitAvgPower = this.run._powerSamples > 0
          ? Math.round(this.run._powerSum / this.run._powerSamples) : 0;
        // Average stride for this split
        var splitAvgStride = this.run._strideSamples > 0
          ? +(this.run._strideSum / this.run._strideSamples).toFixed(2) : 0;

        this.run.splits.push({
          km: k,
          timeSec: Math.round(splitElapsed),
          paceSecPerKm,
          avgHR,
          avgPower: splitAvgPower,
          avgStride: splitAvgStride,
          elapsed: Math.round(this.run.elapsed),
          negativeSplit: isNegativeSplit,
        });

        this.run._lastSplitElapsed = this.run.elapsed;
        // Reset per-split HR counters for next split
        this.run._splitHRSum = 0;
        this.run._splitHRSamples = 0;

        // Notify UI (pass negative split flag)
        if (this.onSplit) this.onSplit(k, splitElapsed, paceSecPerKm, avgHR, isNegativeSplit);
      }
      this.run._lastSplitKm = currentKm;
    }
  },

  /** Record a track point for GPX export (every 5 seconds). */
  _recordTrackPoint() {
    if (this.run.elapsed - this.run._lastTrackPointTime < 5) return;
    this.run._lastTrackPointTime = this.run.elapsed;

    const pt = {
      time: new Date().toISOString(),
      dist: Math.round(this.run.distanceM),
      speed: +this.run.speed.toFixed(1),
      hr: this.run.hr,
      ele: this.run.currentEle,
      elapsed: Math.round(this.run.elapsed),
      incline: +((this.run.incline || 0).toFixed(1)),
    };

    // Add lat/lon if on a route
    if (this.hasRoute() && this.run.routeIdx < this.resampled.length) {
      const rp = this.resampled[this.run.routeIdx];
      pt.lat = rp.lat;
      pt.lon = rp.lon;
    }

    this.run.trackPoints.push(pt);
  },

  /** Auto-scale fan to effort level (every 30s). */
  _autoFan() {
    const now = Date.now();
    if (now - this._lastFanUpdate < 30000) return;
    this._lastFanUpdate = now;

    const settings = Store.getSettings();
    if (!settings.fanAuto) return;

    if (!TM.fanSupported) return;            // the real bridge ignores "Fan Speed" (audit P1-f)
    const zone = this.getCurrentZone();
    const fanLevels = [0, 20, 30, 50, 70, 100];
    TM.setFan(fanLevels[zone] || 30);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // NEXT CHANGE / REMAINING (strip + workout HUD)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * What the belt will do next. → { kind, inSec, inM, speed (kph|null), incline (%|null), label } or null.
   *   kind: 'ramp' (graceful ramp in progress) | 'workout' (PWA-managed segment/interval) | 'stage' (legacy stage
   *   programme) | 'route' (auto-incline: next point ahead where the commanded incline step changes >= 0.5 pp) | 'end'
   *   Free run without a plan → null.
   */
  nextChange() {
    var r = this.run; if (!r) return null;
    var now = Date.now(), spd = r.speed || 0;
    var secFor = function (m) { return spd > 0.3 ? m / (spd / 3.6) : null; };
    if (this._ramp && this._ramp.endsAt > now) {
      return { kind: 'ramp', inSec: (this._ramp.endsAt - now) / 1000, inM: null, speed: this._ramp.endSpeed, incline: this._ramp.endIncline, label: 'ramp' };
    }
    if (typeof WorkoutSegments !== 'undefined' && WorkoutSegments.active) {
      var s = WorkoutSegments.active, w = s.workout, seg = WorkoutSegments.getCurrentSegment();
      if (seg) {
        var toKph = function (v) { return (typeof SpeedUnits !== 'undefined') ? SpeedUnits.toKph(v, w.speedUnit) : v; };
        var nxt = null, lbl = '';
        var cd = (w.coolDown && w.coolDown.enabled !== false) ? { speed: w.coolDown.speed, incline: w.coolDown.incline || 0, label: 'Cool down' } : null;
        if (s.phase === 'warmup') {
          var first = w.type === 'programmed' ? (w.segments || [])[0] : (w.intervals || [])[0];
          nxt = first ? { speed: first.speed, incline: first.incline || 0, label: first.label || 'Segment 1' } : cd;
        } else if (s.phase === 'segment') {
          if (w.type === 'programmed') {
            var ns = (w.segments || [])[s.segmentIndex + 1];
            nxt = ns ? { speed: ns.speed, incline: ns.incline || 0, label: ns.label || 'Segment ' + (s.segmentIndex + 2) } : cd;
          } else {
            var ivs = w.intervals || [], ni = (s.intervalIndex + 1) % Math.max(1, ivs.length);
            var lastRound = (s.round + 1) >= (w.rounds || 1) && s.intervalIndex + 1 >= ivs.length;
            nxt = lastRound ? cd : (ivs[ni] ? { speed: ivs[ni].speed, incline: ivs[ni].incline || 0, label: ivs[ni].label || 'Interval ' + (ni + 1) } : cd);
          }
        } else if (s.phase === 'cooldown') { nxt = null; }
        var inSec = seg.remainingType === 'time' ? seg.remaining : secFor(seg.remaining);
        var inM = seg.remainingType === 'distance' ? seg.remaining : (spd > 0.3 && inSec != null ? inSec * spd / 3.6 : null);
        if (!nxt) return { kind: 'end', inSec: inSec, inM: inM, speed: 0, incline: null, label: 'finish' };
        return { kind: 'workout', inSec: inSec, inM: inM, speed: toKph(nxt.speed), incline: nxt.incline, label: nxt.label };
      }
    }
    if (this.workout && this.workout.programme) {
      var w2 = this.workout, st = w2.programme.stages[w2.stageIdx], n2 = w2.programme.stages[w2.stageIdx + 1];
      if (st) {
        var left = Math.max(0, (st.duration || 0) - (w2.stageElapsed || 0));
        if (!n2) return { kind: 'end', inSec: left, inM: spd > 0.3 ? left * spd / 3.6 : null, speed: 0, incline: null, label: 'finish' };
        return { kind: 'stage', inSec: left, inM: spd > 0.3 ? left * spd / 3.6 : null, speed: n2.speed != null ? n2.speed : null, incline: n2.incline != null ? n2.incline : null, label: n2.name || 'Stage ' + (w2.stageIdx + 2) };
      }
    }
    if (this.ctrl.mode === 'route' && this.hasRoute()) {
      var N = this.resampled.length, totalM = this.route.totalDistM || 0, idx = r.routeIdx || 0;
      var cur = Math.round(this._calcGrade(idx) * 2) / 2;
      for (var i = idx + 1; i < N; i++) {
        var g = Math.round(this._calcGrade(i) * 2) / 2;
        if (Math.abs(g - cur) >= 0.5) {
          var inM2 = Math.max(0, (i / (N - 1)) * totalM - (r.distanceM || 0));
          return { kind: 'route', inSec: secFor(inM2), inM: inM2, speed: null, incline: g, label: 'hill' };
        }
      }
      var leftM = Math.max(0, totalM - (r.distanceM || 0));
      return { kind: 'end', inSec: secFor(leftM), inM: leftM, speed: 0, incline: null, label: 'finish' };
    }
    return null;
  },

  /** Distance / time remaining to the plan's end. → { distM: number|null, timeSec: number|null } */
  remaining() {
    var r = this.run; if (!r) return { distM: null, timeSec: null };
    var out = { distM: null, timeSec: null };
    if (this.hasRoute()) out.distM = Math.max(0, (this.route.totalDistM || 0) - (r.distanceM || 0));
    if (typeof WorkoutSegments !== 'undefined' && WorkoutSegments.active) {
      var s = WorkoutSegments.active, w = s.workout;
      if (w.type === 'programmed' && WorkoutSegments._getTotalDistanceM) {
        out.distM = Math.max(0, WorkoutSegments._getTotalDistanceM(s) - (s.totalCoveredM || 0));
      } else if (w.type === 'interval-time') {
        var per = 0; (w.intervals || []).forEach(function (iv) { per += iv.duration || 0; });
        var total = per * (w.rounds || 1) + ((w.warmUp && w.warmUp.enabled !== false) ? (w.warmUp.duration || 0) : 0) + ((w.coolDown && w.coolDown.enabled !== false) ? (w.coolDown.duration || 0) : 0);
        out.timeSec = Math.max(0, total - (s.elapsed || 0));
      }
    } else if (this.workout && this.workout.programme) {
      var tot = 0; this.workout.programme.stages.forEach(function (st) { tot += st.duration || 0; });
      out.timeSec = Math.max(0, tot - (this.workout.totalElapsed || 0));
    }
    return out;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GETTERS
  // ════════════════════════════════════════════════════════════════════════════

  getCurrentZone() {
    if (!this.run || this.run.hr <= 0) return 0;
    const pct = this.run.hr / this.run.maxHR;
    if (pct < 0.60) return 1;
    if (pct < 0.70) return 2;
    if (pct < 0.80) return 3;
    if (pct < 0.90) return 4;
    return 5;
  },

  getZoneHR(zone, which) {
    const z = this.HR_ZONES[zone - 1];
    if (!z) return 0;
    const maxHR = this.run ? this.run.maxHR : Store.getSettings().maxHR;
    return Math.round(maxHR * (which === 'min' ? z.min : z.max));
  },

  getAvgPace() {
    if (!this.run || this.run.distanceM < 100) return '—';
    const secPerKm = this.run.elapsed / (this.run.distanceM / 1000);
    return (typeof Units !== 'undefined') ? Units.pace(secPerKm) : this._fmtPace(secPerKm);
  },

  getAvgHR() {
    if (!this.run || this.run._hrSamples === 0) return 0;
    return Math.round(this.run._hrSum / this.run._hrSamples);
  },

  getAvgSpeed() {
    if (!this.run || this.run._speedSamples === 0) return 0;
    return +(this.run._speedSum / this.run._speedSamples).toFixed(1);
  },

  /** Get effort score (TRIMP) for the current run. */
  getEffortScore() {
    if (!this.run) return 0;
    return Math.round(this.run._trimp || 0);
  },

  /** Get effort level label from TRIMP score. */
  getEffortLabel(score) {
    if (score === undefined) score = this.getEffortScore();
    if (score < 25) return 'Recovery';
    if (score < 75) return 'Easy';
    if (score < 150) return 'Moderate';
    if (score < 250) return 'Hard';
    if (score < 400) return 'Very Hard';
    return 'Extreme';
  },

  /** Get current running power in watts. */
  getPower() {
    if (!this.run) return 0;
    return this.run.power || 0;
  },

  /** Get average power for the run so far. */
  getAvgPower() {
    if (!this.run || this.run._powerSamples === 0) return 0;
    return Math.round(this.run._powerSum / this.run._powerSamples);
  },

  /** Get average stride length for the run so far (metres). */
  getAvgStride() {
    if (!this.run || this.run._strideSamples === 0) return 0;
    return +(this.run._strideSum / this.run._strideSamples).toFixed(2);
  },

  /** Get effort color for display. */
  getEffortColor(score) {
    if (score === undefined) score = this.getEffortScore();
    if (score < 25) return '#6b7280';
    if (score < 75) return '#22c55e';
    if (score < 150) return '#3ecfff';
    if (score < 250) return '#ffab00';
    if (score < 400) return '#f97316';
    return '#ff3d57';
  },

  /** Get interpolated lat/lon at current route position. */
  getCurrentLatLon() {
    if (!this.hasRoute() || !this.run) return null;
    const idx = this.run.routeIdx;
    const exactIdx = this.run.routeProgress * (this.resampled.length - 1);
    const frac = exactIdx - idx;
    const a = this.resampled[idx];
    const b = idx < this.resampled.length - 1 ? this.resampled[idx + 1] : a;
    return [a.lat + frac * (b.lat - a.lat), a.lon + frac * (b.lon - a.lon)];
  },

  /** Get ghost lat/lon. */
  getGhostLatLon() {
    if (!this.ghost || !this.hasRoute()) return null;
    const idx = this.ghost.routeIdx;
    if (idx < this.resampled.length) {
      return [this.resampled[idx].lat, this.resampled[idx].lon];
    }
    return null;
  },

  // ── Formatters ─────────────────────────────────────────────────────────────

  _fmtPace(secPerKm) {
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60);
    return m + ':' + String(s).padStart(2, '0');
  },

  fmtTime(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GRACEFUL RAMP (standalone timer — independent of run ticker)
  // ════════════════════════════════════════════════════════════════════════════

  _decelTimer: null,

  // ── HR Recovery Timer ──────────────────────────────────────────────────────

  _hrRecoveryTimer: null,

  /**
   * After finishing a run, monitor HR for 60 seconds to compute HRR1
   * (heart rate recovery in 1 minute). A strong recovery indicator:
   *   Excellent: >= 40 bpm drop
   *   Good:      >= 25 bpm drop
   *   Average:   >= 12 bpm drop
   *   Below avg: < 12 bpm drop
   */
  _startRecoveryTimer: function() {
    if (this._hrRecoveryTimer) clearInterval(this._hrRecoveryTimer);
    var self = this;
    this._hrRecoveryTimer = setInterval(function() {
      if (!self.run || !self.run._recoveryStart) {
        clearInterval(self._hrRecoveryTimer);
        self._hrRecoveryTimer = null;
        return;
      }
      var elapsed = (Date.now() - self.run._recoveryStart) / 1000;
      if (elapsed >= 60 && self.run.hr > 0) {
        self.run._hrRecovery = {
          hrAtFinish: self.run._hrAtFinish,
          hrAfter60s: self.run.hr,
          drop: self.run._hrAtFinish - self.run.hr,
        };
        clearInterval(self._hrRecoveryTimer);
        self._hrRecoveryTimer = null;
        console.log('[Engine] HR Recovery (1min): ' + self.run._hrRecovery.drop + ' bpm drop');
        if (self.onHRRecovery) self.onHRRecovery(self.run._hrRecovery);
      }
      // Timeout after 2 minutes if HR data stops
      if (elapsed > 120) {
        clearInterval(self._hrRecoveryTimer);
        self._hrRecoveryTimer = null;
      }
    }, 2000);
  },

  /**
   * Smoothly ramp speed and incline from start to end values over `duration` seconds.
   * Uses ease-out curve for natural feel. Calls `onComplete` when done.
   * Runs independently of the run ticker so status can change immediately.
   */
  _gracefulRamp(startSpeed, endSpeed, startIncline, endIncline, duration, onComplete) {
    if (this._decelTimer) { clearInterval(this._decelTimer); this._decelTimer = null; }
    var started = Date.now();
    var self = this;
    var rampIncline = (startIncline !== endIncline);
    this._ramp = { endSpeed: endSpeed, endIncline: rampIncline ? endIncline : null, endsAt: started + duration * 1000 };

    // 250ms interval — bridge rate-limits to 4 kph/s, handles beep prevention
    this._decelTimer = setInterval(function() {
      var elapsed = (Date.now() - started) / 1000;
      var progress = Math.min(1, elapsed / duration);
      // Ease-out: smooth deceleration (no sudden jerk)
      var eased = 1 - (1 - progress) * (1 - progress);

      var newSpeed = startSpeed + (endSpeed - startSpeed) * eased;
      TM.setSpeed(Math.max(0, +(newSpeed.toFixed(1))), true, 'ramp');

      if (rampIncline) {
        var newIncline = startIncline + (endIncline - startIncline) * eased;
        TM.setIncline(+(newIncline.toFixed(1)), true);
      }

      if (progress >= 1) {
        clearInterval(self._decelTimer);
        self._decelTimer = null;
        self._ramp = null;
        TM.setSpeed(Math.max(0, endSpeed), true);
        if (rampIncline) TM.setIncline(endIncline, true);
        if (onComplete) onComplete();
      }
    }, 250);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COOL-DOWN
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Start a cool-down phase. Duration is based on:
   *   - Base: 3 minutes
   *   - +1 min per 5km run
   *   - +1 min if avg HR > 80% maxHR
   *   - +30s per 5% current incline
   * Speed ramps linearly from current speed → 3.0 km/h
   * Incline ramps linearly from current incline → 0%
   */
  startCooldown() {
    if (!this.run || this.run.status !== 'running') return;

    const distKm = this.run.distanceM / 1000;
    const avgHR = this.getAvgHR();
    const maxHR = this.run.maxHR;
    const currentSpeed = Math.max(this.run.speed, 3.5);
    const currentIncline = Math.max(this.run.incline, 0);

    // Calculate duration (seconds)
    let duration = 180; // 3 min base
    duration += Math.floor(distKm / 5) * 60;           // +1 min per 5km
    if (avgHR > 0 && avgHR > maxHR * 0.8) duration += 60; // +1 min if hard effort
    duration += Math.floor(currentIncline / 5) * 30;    // +30s per 5% incline
    duration = Math.max(120, Math.min(600, duration));  // clamp 2-10 min

    this.run._cooldown = {
      startSpeed: currentSpeed,
      startIncline: currentIncline,
      endSpeed: 3.0,
      endIncline: 0,
      totalDuration: duration,
      elapsed: 0,
    };
  },

  skipCooldown() {
    if (!this.run) return;
    this.run._cooldown = null;
    // Set to walking pace before finishing
    this.run.speed = 0;
    this.ctrl.targetSpeed = 0;
    this.ctrl.targetIncline = 0;
    TM.setSpeed(0, true);
    setTimeout(() => TM.setIncline(0, true), 1000);
  },

  _tickCooldown(dt) {
    const cd = this.run._cooldown;
    if (!cd) return;

    cd.elapsed += dt;
    const progress = Math.min(1, cd.elapsed / cd.totalDuration);

    // Linear ramp down
    const newSpeed = cd.startSpeed + (cd.endSpeed - cd.startSpeed) * progress;
    const newIncline = cd.startIncline + (cd.endIncline - cd.startIncline) * progress;

    this.run.speed = Math.max(0, +newSpeed.toFixed(1));
    this.run.incline = Math.max(0, +newIncline.toFixed(1));
    this.ctrl.targetSpeed = this.run.speed;
    this.ctrl.targetIncline = this.run.incline;

    // Send to treadmill (force = bypass rate limiter during cool-down)
    TM.setSpeed(this.run.speed, true);
    TM.setIncline(this.run.incline, true);

    // Cool-down complete
    if (progress >= 1) {
      this.run._cooldown = null;
      TM.setSpeed(0, true);
      setTimeout(() => TM.setIncline(0, true), 1000);
      if (this.onCooldownComplete) this.onCooldownComplete();
    }
  },

  /** Get current cardiac drift percentage. Positive = HR rising at same pace. */
  getDriftPct() {
    if (!this.run) return 0;
    return this.run._driftPct || 0;
  },

  /** Get current Efficiency Factor (speed/HR). Higher = more aerobically efficient. */
  getEF() {
    if (!this.run || this.run.hr <= 0 || this.run.speed < 1) return 0;
    return +(this.run.speed / this.run.hr).toFixed(4);
  },

  /** Get drift status label. */
  getDriftLabel(pct) {
    if (pct === undefined) pct = this.getDriftPct();
    if (pct < 2) return 'Stable';
    if (pct < 5) return 'Minor drift';
    if (pct < 10) return 'Moderate drift';
    return 'Significant drift';
  },

  // ── Callbacks (set by app.js) ──────────────────────────────────────────────
  onTick: null,
  onSplit: null,
  onRunComplete: null,
  onCooldownComplete: null,
  onAutoPause: null,
  onAutoResume: null,
  onDriftWarning: null,
};
