// ════════════════════════════════════════════════════════════════════════════
// WorkoutSegments — distance-based workouts, interval timers, HR intervals,
//                   warm-up / cool-down bookends, speed unit conversion
// ════════════════════════════════════════════════════════════════════════════
// Integrates with Engine (called from Engine.tick), TM, and Store.
// No external dependencies. Chrome Android 7.1.2 compatible.
// ════════════════════════════════════════════════════════════════════════════

// ── Speed Unit Conversion ──────────────────────────────────────────────────

var SpeedUnits = {
  SAFETY_CAP_KPH: 19.3,

  /** Convert any supported unit to kph. */
  toKph: function (value, unit) {
    if (value <= 0) return 0;
    var kph;
    switch (unit) {
      case 'mph':    kph = value * 1.60934; break;
      case 'min/mi': kph = (1.60934 / value) * 60; break;
      case 'min/km': kph = 60 / value; break;
      case 'kph':    kph = value; break;
      default:       kph = value;
    }
    return Math.min(kph, this.SAFETY_CAP_KPH);
  },

  /** Convert kph to any supported unit. */
  fromKph: function (kph, unit) {
    if (kph <= 0) return 0;
    switch (unit) {
      case 'mph':    return kph / 1.60934;
      case 'min/mi': return (1.60934 / kph) * 60;
      case 'min/km': return 60 / kph;
      case 'kph':    return kph;
      default:       return kph;
    }
  },

  /** Format a speed value for display. */
  format: function (value, unit) {
    if (value <= 0) return '0';
    if (unit === 'min/mi' || unit === 'min/km') {
      var mins = Math.floor(value);
      var secs = Math.round((value - mins) * 60);
      if (secs === 60) { mins++; secs = 0; }
      return mins + ':' + (secs < 10 ? '0' : '') + secs;
    }
    return value.toFixed(1);
  },

  /** Convert a distance value to metres. */
  distToMetres: function (value, distUnit) {
    if (distUnit === 'mi') return value * 1609.34;
    return value * 1000; // km
  },

  /** Convert metres to the workout's distance unit. */
  metresTo: function (metres, distUnit) {
    if (distUnit === 'mi') return metres / 1609.34;
    return metres / 1000; // km
  }
};


// ── Segment Colour Helper ──────────────────────────────────────────────────

function getSegmentColour(segmentSpeedKph, minSpeedKph, maxSpeedKph) {
  var range = maxSpeedKph - minSpeedKph;
  var intensity = range > 0 ? (segmentSpeedKph - minSpeedKph) / range : 0.5;
  if (intensity < 0.2) return '#22c55e';  // green  — easy
  if (intensity < 0.4) return '#00d4aa';  // teal   — moderate
  if (intensity < 0.6) return '#f59e0b';  // amber  — steady
  if (intensity < 0.8) return '#f97316';  // orange — tempo
  return '#ef4444';                        // red    — hard
}


// ── WorkoutSegments Module ─────────────────────────────────────────────────

var WorkoutSegments = {

  // ── State ──────────────────────────────────────────────────────────────
  active: null,    // current active session (see _createSession)

  // ── Callbacks (set by app / UI layer) ──────────────────────────────────
  onSegmentChange: null,    // (newSeg, oldSeg) =>
  onPhaseChange: null,      // (phase) =>
  onComplete: null,         // () =>
  onSpeedChange: null,      // (kph) =>
  onInclineChange: null,    // (percent) =>
  onCountdownTick: null,    // (secondsLeft) =>

  // ── Storage key ────────────────────────────────────────────────────────
  _STORAGE_KEY: 'tr_workouts',

  // ════════════════════════════════════════════════════════════════════════
  // START
  // ════════════════════════════════════════════════════════════════════════

  /** Load a workout definition and start execution. */
  start: function (workout) {
    if (!workout || !workout.type) return;

    var session = this._createSession(workout);
    this.active = session;

    // Begin with warm-up if enabled, otherwise jump to first segment
    if (workout.warmUp && workout.warmUp.enabled) {
      session.phase = 'warmup';
      this._applyWarmup(session, 0);
      this._firePhaseChange('warmup');
    } else {
      session.phase = 'segment';
      this._applyCurrentSegment(session);
      this._firePhaseChange('segment');
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // TICK — called every engine tick
  // ════════════════════════════════════════════════════════════════════════

  /**
   * @param {number} distanceDeltaM  — metres covered since last tick
   * @param {number} dt              — seconds since last tick
   * @param {number} currentHR       — current heart rate (bpm)
   * @param {number} maxHR           — user's max heart rate
   */
  tick: function (distanceDeltaM, dt, currentHR, maxHR) {
    var s = this.active;
    if (!s) return;

    s.elapsed += dt;

    switch (s.phase) {
      case 'warmup':   this._tickWarmup(s, dt); break;
      case 'segment':  this._tickSegment(s, distanceDeltaM, dt, currentHR, maxHR); break;
      case 'cooldown': this._tickCooldown(s, dt); break;
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // PHASE: WARM-UP
  // ════════════════════════════════════════════════════════════════════════

  _tickWarmup: function (s, dt) {
    s.phaseElapsed += dt;

    var wu = s.workout.warmUp;
    var remaining = wu.duration - s.phaseElapsed;

    // Ramp-up: over the last 30 seconds, linearly increase speed to first segment speed
    if (wu.rampUp && remaining <= 30 && remaining > 0) {
      var firstKph = this._getFirstSegmentSpeedKph(s);
      var wuKph = SpeedUnits.toKph(wu.speed, s.workout.speedUnit);
      var rampFraction = 1 - (remaining / 30);
      var rampedKph = wuKph + (firstKph - wuKph) * rampFraction;
      this._sendSpeed(rampedKph);
    }

    // Countdown before warm-up ends
    this._updateCountdown(s, remaining);

    // Warm-up complete
    if (s.phaseElapsed >= wu.duration) {
      s.phase = 'segment';
      s.phaseElapsed = 0;
      s.countdown = 0;
      this._applyCurrentSegment(s);
      this._firePhaseChange('segment');
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // PHASE: SEGMENT (dispatches by workout type)
  // ════════════════════════════════════════════════════════════════════════

  _tickSegment: function (s, distanceDeltaM, dt, currentHR, maxHR) {
    switch (s.workout.type) {
      case 'programmed':    this._tickProgrammed(s, distanceDeltaM, dt); break;
      case 'interval-time': this._tickIntervalTime(s, dt); break;
      case 'interval-hr':   this._tickIntervalHR(s, dt, currentHR, maxHR); break;
    }
  },

  // ── Programmed (distance-based) ─────────────────────────────────────

  _tickProgrammed: function (s, distanceDeltaM, dt) {
    s.phaseElapsed += dt;
    s.segmentCoveredM += distanceDeltaM;
    s.totalCoveredM += distanceDeltaM;

    var seg = s.workout.segments[s.segmentIndex];
    if (!seg) { this._transitionToCooldownOrComplete(s); return; }

    var segLenM = SpeedUnits.distToMetres(seg.distance, s.workout.distanceUnit);
    var remainM = segLenM - s.segmentCoveredM;

    // Estimate remaining seconds from current speed for countdown
    var currentSpeedKph = SpeedUnits.toKph(seg.speed, s.workout.speedUnit);
    var speedMs = currentSpeedKph / 3.6;
    var estRemainSec = speedMs > 0.3 ? remainM / speedMs : 999;
    this._updateCountdown(s, estRemainSec);

    // Segment complete
    if (s.segmentCoveredM >= segLenM) {
      this._advanceSegment(s);
    }
  },

  // ── Interval Time ───────────────────────────────────────────────────

  _tickIntervalTime: function (s, dt) {
    s.phaseElapsed += dt;
    s.intervalElapsed += dt;

    var intervals = s.workout.intervals;
    var interval = intervals[s.intervalIndex];
    if (!interval) { this._transitionToCooldownOrComplete(s); return; }

    var remaining = interval.duration - s.intervalElapsed;
    this._updateCountdown(s, remaining);

    // Interval complete
    if (s.intervalElapsed >= interval.duration) {
      s.intervalElapsed = 0;
      s.intervalIndex++;

      // Wrapped past the last interval in this round
      if (s.intervalIndex >= intervals.length) {
        s.intervalIndex = 0;
        s.round++;

        // All rounds complete
        if (s.round >= s.workout.rounds) {
          this._transitionToCooldownOrComplete(s);
          return;
        }
      }

      this._applyCurrentSegment(s);
    }
  },

  // ── Interval HR ─────────────────────────────────────────────────────

  _tickIntervalHR: function (s, dt, currentHR, maxHR) {
    s.phaseElapsed += dt;
    s.intervalElapsed += dt;

    var intervals = s.workout.intervals;
    var interval = intervals[s.intervalIndex];
    if (!interval) { this._transitionToCooldownOrComplete(s); return; }

    var targetZone = interval.targetZone;
    var holdTime = s.workout.holdTime || 30;
    var maxDuration = s.workout.maxDuration || 180;

    // Check if HR is in target zone
    if (currentHR > 0 && maxHR > 0) {
      var zone = this._hrToZone(currentHR, maxHR);
      if (zone === targetZone) {
        s.hrHoldElapsed += dt;
      } else {
        // Reset hold timer if HR drifts out of zone
        s.hrHoldElapsed = 0;
      }
    }

    // Estimate countdown: time left to complete hold, or safety cap
    var holdRemain = Math.max(0, holdTime - s.hrHoldElapsed);
    var safetyRemain = maxDuration - s.intervalElapsed;
    var effectiveRemain = Math.min(holdRemain, safetyRemain);
    this._updateCountdown(s, effectiveRemain);

    // Interval complete: held in zone long enough OR safety cap reached
    var intervalDone = s.hrHoldElapsed >= holdTime || s.intervalElapsed >= maxDuration;
    if (intervalDone) {
      s.intervalElapsed = 0;
      s.hrHoldElapsed = 0;
      s.intervalIndex++;

      if (s.intervalIndex >= intervals.length) {
        s.intervalIndex = 0;
        s.round++;

        if (s.round >= s.workout.rounds) {
          this._transitionToCooldownOrComplete(s);
          return;
        }
      }

      this._applyCurrentSegment(s);
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // PHASE: COOL-DOWN
  // ════════════════════════════════════════════════════════════════════════

  _tickCooldown: function (s, dt) {
    s.phaseElapsed += dt;

    var cd = s.workout.coolDown;
    var progress = Math.min(1, s.phaseElapsed / cd.duration);
    var remaining = cd.duration - s.phaseElapsed;

    // Ramp-down: over the first 30 seconds, linearly decrease speed from last segment
    var cdKph = SpeedUnits.toKph(cd.speed, s.workout.speedUnit);
    if (cd.rampDown !== false && s.phaseElapsed <= 30) {
      var rampFraction = s.phaseElapsed / 30;
      var rampedKph = s.cooldownStartSpeedKph + (cdKph - s.cooldownStartSpeedKph) * rampFraction;
      this._sendSpeed(rampedKph);
    } else {
      this._sendSpeed(cdKph);
    }

    // Incline ramps linearly to cool-down incline over full duration
    var cdIncline = cd.incline || 0;
    var currentIncline = s.cooldownStartIncline + (cdIncline - s.cooldownStartIncline) * progress;
    this._sendIncline(currentIncline);

    this._updateCountdown(s, remaining);

    // Cool-down complete
    if (s.phaseElapsed >= cd.duration) {
      this._completeWorkout(s);
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // GETTERS (for UI)
  // ════════════════════════════════════════════════════════════════════════

  /** Get current phase: 'warmup' | 'segment' | 'cooldown' | 'complete' | null */
  getPhase: function () {
    if (!this.active) return null;
    return this.active.phase;
  },

  /** Get info about the current segment (for UI display). */
  getCurrentSegment: function () {
    var s = this.active;
    if (!s) return null;

    var workout = s.workout;

    if (s.phase === 'warmup') {
      return {
        index: -1,
        total: this._getTotalSegmentCount(s),
        label: 'Warm Up',
        speed: workout.warmUp.speed,
        speedUnit: workout.speedUnit,
        incline: workout.warmUp.incline || 0,
        remaining: Math.max(0, workout.warmUp.duration - s.phaseElapsed),
        remainingType: 'time',
        colour: '#4fc3f7',
        countdown: s.countdown
      };
    }

    if (s.phase === 'cooldown') {
      return {
        index: -2,
        total: this._getTotalSegmentCount(s),
        label: 'Cool Down',
        speed: workout.coolDown.speed,
        speedUnit: workout.speedUnit,
        incline: workout.coolDown.incline || 0,
        remaining: Math.max(0, workout.coolDown.duration - s.phaseElapsed),
        remainingType: 'time',
        colour: '#4fc3f7',
        countdown: s.countdown
      };
    }

    if (s.phase === 'segment') {
      return this._getCurrentSegmentInfo(s);
    }

    return null;
  },

  /** Get overall progress through the workout. */
  getTotalProgress: function () {
    var s = this.active;
    if (!s) return null;

    var workout = s.workout;

    if (workout.type === 'programmed') {
      var totalM = this._getTotalDistanceM(s);
      return {
        covered: SpeedUnits.metresTo(s.totalCoveredM, workout.distanceUnit),
        total: SpeedUnits.metresTo(totalM, workout.distanceUnit),
        unit: workout.distanceUnit,
        fraction: totalM > 0 ? Math.min(1, s.totalCoveredM / totalM) : 0
      };
    }

    // For interval workouts, progress is round-based
    var totalRounds = workout.rounds || 1;
    var intervalsPerRound = (workout.intervals || []).length;
    var completedIntervals = s.round * intervalsPerRound + s.intervalIndex;
    var totalIntervals = totalRounds * intervalsPerRound;
    return {
      covered: s.round + 1,
      total: totalRounds,
      unit: 'rounds',
      fraction: totalIntervals > 0 ? Math.min(1, completedIntervals / totalIntervals) : 0
    };
  },

  /** Get all segments with colours for a track/bar renderer. */
  getSegmentsWithColours: function () {
    var s = this.active;
    if (!s) return [];

    var workout = s.workout;
    var result = [];
    var speedRange = this._getSpeedRange(s);

    if (workout.type === 'programmed') {
      for (var i = 0; i < workout.segments.length; i++) {
        var seg = workout.segments[i];
        var kph = SpeedUnits.toKph(seg.speed, workout.speedUnit);
        result.push({
          distance: seg.distance,
          distanceUnit: workout.distanceUnit,
          speed: seg.speed,
          speedUnit: workout.speedUnit,
          incline: seg.incline || 0,
          label: seg.label || '',
          colour: getSegmentColour(kph, speedRange.min, speedRange.max),
          active: s.phase === 'segment' && s.segmentIndex === i
        });
      }
    } else {
      // Interval workouts: expand rounds × intervals
      var rounds = workout.rounds || 1;
      for (var r = 0; r < rounds; r++) {
        for (var j = 0; j < workout.intervals.length; j++) {
          var interval = workout.intervals[j];
          var iKph = SpeedUnits.toKph(interval.speed, workout.speedUnit);
          result.push({
            duration: interval.duration || null,
            speed: interval.speed,
            speedUnit: workout.speedUnit,
            incline: interval.incline || 0,
            label: interval.label || '',
            targetZone: interval.targetZone || null,
            round: r + 1,
            colour: getSegmentColour(iKph, speedRange.min, speedRange.max),
            active: s.phase === 'segment' && s.round === r && s.intervalIndex === j
          });
        }
      }
    }

    return result;
  },

  // ════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ════════════════════════════════════════════════════════════════════════

  /** Skip the warm-up and jump directly to the first segment. */
  skipWarmup: function () {
    var s = this.active;
    if (!s || s.phase !== 'warmup') return;
    s.phase = 'segment';
    s.phaseElapsed = 0;
    s.countdown = 0;
    this._applyCurrentSegment(s);
    this._firePhaseChange('segment');
  },

  /** Skip to the next segment (or next interval). */
  skipToNextSegment: function () {
    var s = this.active;
    if (!s || s.phase !== 'segment') return;

    if (s.workout.type === 'programmed') {
      s.totalCoveredM += this._getCurrentSegmentRemainingM(s);
      this._advanceSegment(s);
    } else {
      // Interval: advance interval index
      s.intervalElapsed = 0;
      s.hrHoldElapsed = 0;
      s.intervalIndex++;
      if (s.intervalIndex >= s.workout.intervals.length) {
        s.intervalIndex = 0;
        s.round++;
        if (s.round >= s.workout.rounds) {
          this._transitionToCooldownOrComplete(s);
          return;
        }
      }
      this._applyCurrentSegment(s);
    }
  },

  /** Skip the cool-down (no-op if mandatory). */
  skipCooldown: function () {
    var s = this.active;
    if (!s || s.phase !== 'cooldown') return;
    if (s.workout.coolDown && s.workout.coolDown.mandatory) return;
    this._completeWorkout(s);
  },

  /** Abort the workout entirely. */
  abort: function () {
    var s = this.active;
    if (!s) return;
    s.phase = 'complete';
    this.active = null;
    this._firePhaseChange('complete');
  },

  // ════════════════════════════════════════════════════════════════════════
  // WORKOUT LIBRARY (localStorage)
  // ════════════════════════════════════════════════════════════════════════

  /** Return all saved workouts. */
  getLibrary: function () {
    try {
      var raw = localStorage.getItem(this._STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  /** Save (create or update) a workout. */
  saveWorkout: function (workout) {
    var library = this.getLibrary();
    if (!workout.id) {
      workout.id = 'ws_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    }
    if (!workout.created) workout.created = Date.now();

    var idx = -1;
    for (var i = 0; i < library.length; i++) {
      if (library[i].id === workout.id) { idx = i; break; }
    }
    if (idx >= 0) {
      library[idx] = workout;
    } else {
      library.push(workout);
    }
    this._saveLibrary(library);
    return workout;
  },

  /** Delete a workout by ID. */
  deleteWorkout: function (id) {
    var library = this.getLibrary();
    var filtered = [];
    for (var i = 0; i < library.length; i++) {
      if (library[i].id !== id) filtered.push(library[i]);
    }
    this._saveLibrary(filtered);
  },

  /** Duplicate a workout, returning the new copy. */
  duplicateWorkout: function (id) {
    var library = this.getLibrary();
    var original = null;
    for (var i = 0; i < library.length; i++) {
      if (library[i].id === id) { original = library[i]; break; }
    }
    if (!original) return null;

    var copy = JSON.parse(JSON.stringify(original));
    copy.id = 'ws_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    copy.name = original.name + ' (Copy)';
    copy.created = Date.now();
    copy.lastUsed = null;
    copy.timesCompleted = 0;
    copy.bestTime = null;

    library.push(copy);
    this._saveLibrary(library);
    return copy;
  },

  _saveLibrary: function (library) {
    try {
      localStorage.setItem(this._STORAGE_KEY, JSON.stringify(library));
    } catch (e) {
      console.warn('[WorkoutSegments] Storage write failed:', e);
    }
  },

  // ════════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════════════════════

  /** Create a new active session from a workout definition. */
  _createSession: function (workout) {
    return {
      workout: workout,
      phase: null,           // warmup | segment | cooldown | complete
      elapsed: 0,            // total seconds since start
      phaseElapsed: 0,       // seconds in current phase

      // Programmed (distance-based)
      segmentIndex: 0,
      segmentCoveredM: 0,    // metres covered in current segment
      totalCoveredM: 0,      // metres covered across all segments

      // Interval
      round: 0,              // current round (0-based)
      intervalIndex: 0,      // current interval within the round
      intervalElapsed: 0,    // seconds elapsed in current interval

      // HR interval
      hrHoldElapsed: 0,      // seconds HR has been in target zone

      // Countdown
      countdown: 0,          // seconds until next transition (for UI/voice)
      _lastCountdown: 0,     // previous countdown value (to detect changes)

      // Cool-down transition state
      cooldownStartSpeedKph: 0,
      cooldownStartIncline: 0,

      // Timestamps
      startedAt: Date.now()
    };
  },

  // ── Segment application ─────────────────────────────────────────────

  /** Apply speed/incline for the current segment or interval. */
  _applyCurrentSegment: function (s) {
    var workout = s.workout;
    var oldSeg = null;
    var newSeg = null;

    if (workout.type === 'programmed') {
      var seg = workout.segments[s.segmentIndex];
      if (!seg) return;
      newSeg = {
        index: s.segmentIndex,
        label: seg.label,
        speed: seg.speed,
        incline: seg.incline || 0
      };
      var kph = SpeedUnits.toKph(seg.speed, workout.speedUnit);
      this._sendSpeed(kph);
      this._sendIncline(seg.incline || 0);
    } else {
      var interval = workout.intervals[s.intervalIndex];
      if (!interval) return;
      newSeg = {
        index: s.intervalIndex,
        round: s.round,
        label: interval.label,
        speed: interval.speed,
        incline: interval.incline || 0,
        targetZone: interval.targetZone || null
      };
      var iKph = SpeedUnits.toKph(interval.speed, workout.speedUnit);
      this._sendSpeed(iKph);
      this._sendIncline(interval.incline || 0);
    }

    if (this.onSegmentChange) this.onSegmentChange(newSeg, oldSeg);
  },

  /** Apply warm-up speed and incline. */
  _applyWarmup: function (s, elapsed) {
    var wu = s.workout.warmUp;
    var kph = SpeedUnits.toKph(wu.speed, s.workout.speedUnit);
    this._sendSpeed(kph);
    this._sendIncline(wu.incline || 0);
  },

  // ── Segment advancement ─────────────────────────────────────────────

  _advanceSegment: function (s) {
    var oldIdx = s.segmentIndex;
    var oldSeg = s.workout.segments[oldIdx];

    s.segmentIndex++;
    s.segmentCoveredM = 0;
    s.phaseElapsed = 0;
    s.countdown = 0;

    if (s.segmentIndex >= s.workout.segments.length) {
      this._transitionToCooldownOrComplete(s);
      return;
    }

    var newSeg = s.workout.segments[s.segmentIndex];
    this._applyCurrentSegment(s);

    if (this.onSegmentChange) {
      this.onSegmentChange(
        { index: s.segmentIndex, label: newSeg.label, speed: newSeg.speed, incline: newSeg.incline || 0 },
        { index: oldIdx, label: oldSeg ? oldSeg.label : '' }
      );
    }
  },

  // ── Phase transitions ───────────────────────────────────────────────

  _transitionToCooldownOrComplete: function (s) {
    var cd = s.workout.coolDown;
    if (cd && cd.enabled) {
      // Capture the speed/incline we're transitioning from
      s.cooldownStartSpeedKph = this._getLastSegmentSpeedKph(s);
      s.cooldownStartIncline = this._getLastSegmentIncline(s);
      s.phase = 'cooldown';
      s.phaseElapsed = 0;
      s.countdown = 0;

      // Apply initial cool-down (ramp-down handles the transition)
      var cdKph = SpeedUnits.toKph(cd.speed, s.workout.speedUnit);
      if (cd.rampDown === false) {
        this._sendSpeed(cdKph);
      }
      // else ramp-down in _tickCooldown handles speed
      this._sendIncline(cd.incline || 0);
      this._firePhaseChange('cooldown');
    } else {
      this._completeWorkout(s);
    }
  },

  _completeWorkout: function (s) {
    s.phase = 'complete';
    var totalTime = s.elapsed;

    // Update workout stats in library
    this._updateWorkoutStats(s.workout.id, totalTime);

    this.active = null;
    this._firePhaseChange('complete');
    if (this.onComplete) this.onComplete();
  },

  // ── Countdown ───────────────────────────────────────────────────────

  /** Update the 10-second countdown before transitions. */
  _updateCountdown: function (s, remainingSec) {
    if (remainingSec <= 10 && remainingSec > 0) {
      var newCountdown = Math.ceil(remainingSec);
      if (newCountdown !== s._lastCountdown) {
        s.countdown = newCountdown;
        s._lastCountdown = newCountdown;
        if (this.onCountdownTick) this.onCountdownTick(newCountdown);
      }
    } else {
      if (s.countdown !== 0) {
        s.countdown = 0;
        s._lastCountdown = 0;
      }
    }
  },

  // ── Bridge commands ─────────────────────────────────────────────────

  _sendSpeed: function (kph) {
    var capped = Math.min(kph, SpeedUnits.SAFETY_CAP_KPH);
    // Set engine target so software ramp works without treadmill
    if (typeof Engine !== 'undefined' && Engine.ctrl) {
      Engine.ctrl.targetSpeed = capped;
    }
    if (typeof TM !== 'undefined' && TM.setSpeed) {
      TM.setSpeed(capped);
    }
    if (this.onSpeedChange) this.onSpeedChange(capped);
  },

  _sendIncline: function (percent) {
    // Set engine target so incline tracks without treadmill
    if (typeof Engine !== 'undefined') {
      Engine.ctrl.targetIncline = percent;
      if (Engine.run) Engine.run.incline = percent;
    }
    if (typeof TM !== 'undefined' && TM.setIncline) {
      TM.setIncline(percent);
    }
    if (this.onInclineChange) this.onInclineChange(percent);
  },

  // ── Helpers ─────────────────────────────────────────────────────────

  _firePhaseChange: function (phase) {
    if (this.onPhaseChange) this.onPhaseChange(phase);
  },

  /** Get the first segment's speed in kph. */
  _getFirstSegmentSpeedKph: function (s) {
    var workout = s.workout;
    if (workout.type === 'programmed' && workout.segments.length > 0) {
      return SpeedUnits.toKph(workout.segments[0].speed, workout.speedUnit);
    }
    if (workout.intervals && workout.intervals.length > 0) {
      return SpeedUnits.toKph(workout.intervals[0].speed, workout.speedUnit);
    }
    return 5;
  },

  /** Get the last segment's speed in kph. */
  _getLastSegmentSpeedKph: function (s) {
    var workout = s.workout;
    if (workout.type === 'programmed' && workout.segments.length > 0) {
      var last = workout.segments[workout.segments.length - 1];
      return SpeedUnits.toKph(last.speed, workout.speedUnit);
    }
    if (workout.intervals && workout.intervals.length > 0) {
      var lastI = workout.intervals[workout.intervals.length - 1];
      return SpeedUnits.toKph(lastI.speed, workout.speedUnit);
    }
    return 5;
  },

  /** Get the last segment's incline. */
  _getLastSegmentIncline: function (s) {
    var workout = s.workout;
    if (workout.type === 'programmed' && workout.segments.length > 0) {
      return workout.segments[workout.segments.length - 1].incline || 0;
    }
    if (workout.intervals && workout.intervals.length > 0) {
      return workout.intervals[workout.intervals.length - 1].incline || 0;
    }
    return 0;
  },

  /** Total segment count (excluding warmup/cooldown). */
  _getTotalSegmentCount: function (s) {
    var workout = s.workout;
    if (workout.type === 'programmed') return workout.segments.length;
    return (workout.rounds || 1) * (workout.intervals || []).length;
  },

  /** Total distance in metres for a programmed workout. */
  _getTotalDistanceM: function (s) {
    var total = 0;
    var segs = s.workout.segments || [];
    for (var i = 0; i < segs.length; i++) {
      total += SpeedUnits.distToMetres(segs[i].distance, s.workout.distanceUnit);
    }
    return total;
  },

  /** Remaining metres in the current programmed segment. */
  _getCurrentSegmentRemainingM: function (s) {
    var seg = s.workout.segments[s.segmentIndex];
    if (!seg) return 0;
    var segLenM = SpeedUnits.distToMetres(seg.distance, s.workout.distanceUnit);
    return Math.max(0, segLenM - s.segmentCoveredM);
  },

  /** Get the min and max speed (kph) across all segments/intervals. */
  _getSpeedRange: function (s) {
    var workout = s.workout;
    var min = Infinity;
    var max = -Infinity;
    var items = workout.type === 'programmed' ? workout.segments : workout.intervals;
    if (!items || items.length === 0) return { min: 0, max: 10 };

    for (var i = 0; i < items.length; i++) {
      var kph = SpeedUnits.toKph(items[i].speed, workout.speedUnit);
      if (kph < min) min = kph;
      if (kph > max) max = kph;
    }
    return { min: min, max: max };
  },

  /** Convert HR to zone number (1-5). */
  _hrToZone: function (hr, maxHR) {
    if (hr <= 0 || maxHR <= 0) return 0;
    var pct = hr / maxHR;
    if (pct < 0.60) return 1;
    if (pct < 0.70) return 2;
    if (pct < 0.80) return 3;
    if (pct < 0.90) return 4;
    return 5;
  },

  /** Build the segment info object for programmed or interval workouts. */
  _getCurrentSegmentInfo: function (s) {
    var workout = s.workout;
    var speedRange = this._getSpeedRange(s);

    if (workout.type === 'programmed') {
      var seg = workout.segments[s.segmentIndex];
      if (!seg) return null;
      var segLenM = SpeedUnits.distToMetres(seg.distance, workout.distanceUnit);
      var kph = SpeedUnits.toKph(seg.speed, workout.speedUnit);
      return {
        index: s.segmentIndex,
        total: workout.segments.length,
        label: seg.label || ('Segment ' + (s.segmentIndex + 1)),
        speed: seg.speed,
        speedUnit: workout.speedUnit,
        incline: seg.incline || 0,
        remaining: Math.max(0, segLenM - s.segmentCoveredM),
        remainingType: 'distance',
        remainingUnit: 'm',
        colour: getSegmentColour(kph, speedRange.min, speedRange.max),
        countdown: s.countdown
      };
    }

    // Interval workouts
    var interval = workout.intervals[s.intervalIndex];
    if (!interval) return null;
    var iKph = SpeedUnits.toKph(interval.speed, workout.speedUnit);

    var remaining;
    var remainingType;
    if (workout.type === 'interval-time') {
      remaining = Math.max(0, (interval.duration || 0) - s.intervalElapsed);
      remainingType = 'time';
    } else {
      // interval-hr: show hold time remaining or safety cap
      var holdTime = workout.holdTime || 30;
      remaining = Math.max(0, holdTime - s.hrHoldElapsed);
      remainingType = 'hold';
    }

    return {
      index: s.intervalIndex,
      total: workout.intervals.length,
      round: s.round + 1,
      totalRounds: workout.rounds,
      label: interval.label || ('Interval ' + (s.intervalIndex + 1)),
      speed: interval.speed,
      speedUnit: workout.speedUnit,
      incline: interval.incline || 0,
      targetZone: interval.targetZone || null,
      remaining: remaining,
      remainingType: remainingType,
      colour: getSegmentColour(iKph, speedRange.min, speedRange.max),
      countdown: s.countdown
    };
  },

  /** Update workout stats in the library after completion. */
  _updateWorkoutStats: function (workoutId, totalTimeSec) {
    if (!workoutId) return;
    var library = this.getLibrary();
    for (var i = 0; i < library.length; i++) {
      if (library[i].id === workoutId) {
        library[i].lastUsed = Date.now();
        library[i].timesCompleted = (library[i].timesCompleted || 0) + 1;
        if (!library[i].bestTime || totalTimeSec < library[i].bestTime) {
          library[i].bestTime = Math.round(totalTimeSec);
        }
        this._saveLibrary(library);
        return;
      }
    }
  }
};
