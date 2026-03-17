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

  pauseRun() {
    if (!this.run || this.run.status !== 'running') return;
    var speed = this.run.speed;

    // Set status immediately (UI shows pause overlay)
    this.run.status = 'paused';
    this._stopTicker();

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
    this.run.status = 'running';
    this.run._resumeElapsed = this.run.elapsed; // mark for gentle ramp-up
    this._lastTickTime = Date.now();
    this._startTicker();
    TM.resumeWorkout();
  },

  finishRun() {
    if (!this.run) return;
    if (this.run.status === 'finished') return; // prevent double-call
    var speed = this.run.speed;
    var incline = Math.max(this.run.incline, 0);

    // Finalize run state immediately (UI shows summary, save works)
    this.run.status = 'finished';
    this.run.finishedAt = new Date().toISOString();
    this._stopTicker();
    if (this.workout) this.workout = null;

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
      TM.setSpeed(stage.speed);
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
      this.run.hr = data.hr;
      this.run.hrSource = 'treadmill';
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
      this.run.hr = data.hr;
      this.run.hrSource = 'ftms';
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
    this.run.hr = hr;
    this.run.hrSource = 'ble';
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TICK — called every TICK_MS while running
  // ════════════════════════════════════════════════════════════════════════════

  tick() {
    if (!this.run || this.run.status !== 'running') return;

    const now = Date.now();
    const dt = (now - this._lastTickTime) / 1000; // seconds since last tick
    this._lastTickTime = now;

    // Guard against huge dt (tab was backgrounded, etc.)
    const cappedDt = Math.min(dt, 2);

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
  _applyAutoControl() {
    const maxHR = this.run.maxHR;

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

      if (hr > 0) {
        if (hr > zMax + 3) {
          this.ctrl.targetIncline = Math.max(-3, this.ctrl.targetIncline - 0.3);
        } else if (hr < zMin - 3) {
          this.ctrl.targetIncline = Math.min(15, this.ctrl.targetIncline + 0.3);
        }
      }
      // Dedup in TM.setSpeed/setIncline prevents redundant gRPC calls
      TM.setSpeed(this.ctrl.targetSpeed);
      TM.setIncline(this.ctrl.targetIncline);

    } else if (this.ctrl.mode === 'hr-speed') {
      // Incline fixed, speed adjusts to hold HR in target zone
      const zone = this.HR_ZONES[this.ctrl.targetZone - 1];
      const zMin = Math.round(maxHR * zone.min);
      const zMax = Math.round(maxHR * zone.max);
      const hr = this.run.hr;

      if (hr > 0) {
        if (hr > zMax + 3) {
          this.ctrl.targetSpeed = Math.max(3, this.ctrl.targetSpeed - 0.2);
        } else if (hr < zMin - 3) {
          const settings = Store.getSettings();
          this.ctrl.targetSpeed = Math.min(settings.safetyMaxSpeed, this.ctrl.targetSpeed + 0.2);
        }
      }
      // Dedup in TM.setSpeed/setIncline prevents redundant gRPC calls
      TM.setSpeed(this.ctrl.targetSpeed);
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

    const zone = this.getCurrentZone();
    const fanLevels = [0, 20, 30, 50, 70, 100];
    TM.setFan(fanLevels[zone] || 30);
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
    return this._fmtPace(secPerKm);
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

    // 250ms interval — bridge rate-limits to 4 kph/s, handles beep prevention
    this._decelTimer = setInterval(function() {
      var elapsed = (Date.now() - started) / 1000;
      var progress = Math.min(1, elapsed / duration);
      // Ease-out: smooth deceleration (no sudden jerk)
      var eased = 1 - (1 - progress) * (1 - progress);

      var newSpeed = startSpeed + (endSpeed - startSpeed) * eased;
      TM.setSpeed(Math.max(0, +(newSpeed.toFixed(1))), true);

      if (rampIncline) {
        var newIncline = startIncline + (endIncline - startIncline) * eased;
        TM.setIncline(+(newIncline.toFixed(1)), true);
      }

      if (progress >= 1) {
        clearInterval(self._decelTimer);
        self._decelTimer = null;
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
