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
    targetSpeed: 9.0,     // km/h (fixed in hr-incline mode)
    targetIncline: 1.0,   // % (fixed in hr-speed mode)
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

      // Averages
      _hrSum: 0,
      _hrSamples: 0,
      _speedSum: 0,
      _speedSamples: 0,

      // Track points for GPX export (sampled every ~5s)
      trackPoints: [],
      _lastTrackPointTime: 0,

      // Route reference
      routeId: this.route ? this.route.id : null,
      routeName: this.route ? this.route.name : 'Free Run',

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
    this.run.status = 'paused';
    this._stopTicker();

    // SAFETY: stop the belt immediately, but keep incline where it is
    TM.setSpeed(0, true);
  },

  resumeRun() {
    if (!this.run || this.run.status !== 'paused') return;
    this.run.status = 'running';
    this._lastTickTime = Date.now();
    this._startTicker();
  },

  finishRun() {
    if (!this.run) return;
    this.run.status = 'finished';
    this.run.finishedAt = new Date().toISOString();
    this._stopTicker();

    // SAFETY: stop the belt AND return to 0% grade
    TM.setSpeed(0, true);
    // Brief delay so the motor controller processes the speed-stop first,
    // then bring the ramp down — avoids the user stepping off a moving,
    // tilted belt
    setTimeout(() => TM.setIncline(0, true), 2000);

    // Finalize workout if active
    if (this.workout) this.workout = null;
  },

  discardRun() {
    this._stopTicker();

    // SAFETY: always return to zero on discard too
    TM.setSpeed(0, true);
    setTimeout(() => TM.setIncline(0, true), 2000);

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
      avgHR: r._hrSamples > 0 ? Math.round(r._hrSum / r._hrSamples) : 0,
      maxHR: r.maxHR,
      calories: Math.round(r.calories),
      elevGained: Math.round(r.elevGained),
      inclineMax: 0,
      splits: r.splits,
      trackPoints: r.trackPoints,
    };

    const saved = Store.saveRun(summary);

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
      this.run.speed = data.speed;
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
    // Ramps at max 2 km/h per second to prevent instant acceleration
    // Applies in ANY mode when no treadmill/FTMS is feeding speed data
    if (this.run.speedSource !== 'treadmill' && this.run.speedSource !== 'ftms') {
      var rampRate = 2.0 * cappedDt; // 2 km/h per second
      var diff = this.ctrl.targetSpeed - this.run.speed;
      if (Math.abs(diff) > 0.05) {
        if (diff > 0) this.run.speed = Math.min(this.ctrl.targetSpeed, this.run.speed + rampRate);
        else this.run.speed = Math.max(this.ctrl.targetSpeed, this.run.speed - rampRate);
      } else {
        this.run.speed = this.ctrl.targetSpeed;
      }
      // Safety floor: speed can never go below 0
      if (this.run.speed < 0) this.run.speed = 0;
    }

    // ── HR stats ─────────────────────────────────────────────────────────
    if (this.run.hr > 0) {
      this.run._hrSum += this.run.hr;
      this.run._hrSamples++;
    }

    // ── Speed stats ──────────────────────────────────────────────────────
    if (this.run.speed > 0.5) {
      this.run._speedSum += this.run.speed;
      this.run._speedSamples++;
    }

    // ── Cadence estimate (from speed) ────────────────────────────────────
    // Rough model: 155 spm at 6 km/h → 190 spm at 16 km/h
    if (this.run.speed > 1) {
      this.run.cadence = Math.round(Math.max(150, Math.min(200,
        155 + (this.run.speed - 6) * 3.5)));
    } else {
      this.run.cadence = 0;
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

  /** Apply auto-control based on current mode. */
  _applyAutoControl() {
    const maxHR = this.run.maxHR;

    if (this.ctrl.mode === 'route') {
      // Auto-incline to match route gradient
      if (this.hasRoute()) {
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
        const avgHR = this.run._hrSamples > 0
          ? Math.round(this.run._hrSum / this.run._hrSamples)
          : 0;
        const paceSecPerKm = Math.round(splitElapsed);

        this.run.splits.push({
          km: k,
          timeSec: Math.round(splitElapsed),
          paceSecPerKm,
          avgHR,
          elapsed: Math.round(this.run.elapsed),
        });

        this.run._lastSplitElapsed = this.run.elapsed;

        // Notify UI
        if (this.onSplit) this.onSplit(k, splitElapsed, paceSecPerKm, avgHR);
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

    // Send to treadmill
    TM.setSpeed(this.run.speed);
    TM.setIncline(this.run.incline);

    // Cool-down complete
    if (progress >= 1) {
      this.run._cooldown = null;
      TM.setSpeed(0, true);
      setTimeout(() => TM.setIncline(0, true), 1000);
      if (this.onCooldownComplete) this.onCooldownComplete();
    }
  },

  // ── Callbacks (set by app.js) ──────────────────────────────────────────────
  onTick: null,
  onSplit: null,
  onRunComplete: null,
  onCooldownComplete: null,
};
