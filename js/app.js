// ════════════════════════════════════════════════════════════════════════════
// App — initialisation, event binding, glue between modules
// ════════════════════════════════════════════════════════════════════════════

const App = {

  // ════════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════════

  init() {
    UI.init();

    // ── Wire treadmill callbacks ─────────────────────────────────────────
    TM.onConnect = () => {
      UI.updateConnectionPill('tm', 'connected', 'X32i');
    };
    TM.onDisconnect = () => {
      UI.updateConnectionPill('tm', 'idle');
      if (Engine.run) Engine.run.speedSource = 'none';
    };
    TM.onData = (data) => Engine.onTreadmillData(data);
    TM.onStatus = (state, name) => UI.updateConnectionPill('tm', state, name);

    // ── Wire BLE HR callbacks ────────────────────────────────────────────
    BLEHR.onHR = (hr) => Engine.onBLEHR(hr);
    BLEHR.onStatus = (state, name) => UI.updateConnectionPill('hr', state, name);

    // ── Wire FTMS callbacks ──────────────────────────────────────────────
    FTMS.onData = (data) => Engine.onFTMSData(data);
    FTMS.onStatus = (state, name) => UI.updateConnectionPill('tm', state, name);

    // ── Wire engine callbacks ────────────────────────────────────────────
    Engine.onTick = () => {
      UI.update();
      UI.drawElevation();
      // Keep big displays in sync with actual run values (in user's chosen unit)
      const bs = document.getElementById('bigSpeedVal');
      const bi = document.getElementById('bigIncVal');
      const bsu = document.getElementById('bigSpeedUnit');
      if (bs && Engine.run) {
        var _s = Store.getSettings();
        var _unit = _s.speedButtonUnit || 'kph';
        var _disp = SpeedUnits.fromKph(Engine.run.speed, _unit);
        bs.textContent = SpeedUnits.format(_disp, _unit);
        if (bsu) bsu.textContent = _unit;
      }
      if (bi && Engine.run) bi.textContent = Engine.run.incline.toFixed(1);
      if (Engine.hasRoute()) {
        MapView.updateRunner(Engine.getCurrentLatLon());
        MapView.updateGhost(Engine.getGhostLatLon(), Engine.ghostEnabled);
        // Update Street View if active
        if (this._streetViewReady && document.getElementById('streetViewPanel').style.display !== 'none') {
          this._updateStreetViewPosition();
        }
      }
      // Feed track view with current run data
      if (TrackView.active && Engine.run) {
        TrackView.update({
          distKm: (Engine.run.distanceM || 0) / 1000,
          speedKmh: Engine.run.speed || 0,
          incline: Engine.run.incline || 0,
          hr: Engine.run.hr || 0,
          elevProfile: Engine.resampled,
        });
        // Sync ghost position
        if (Engine.ghostEnabled && Engine.ghost) {
          TrackView.setGhosts([{
            name: Engine.ghost.routeName || 'GHOST',
            distKm: (Engine.ghost.distanceM || 0) / 1000,
            color: '#a78bfa',
            pace: '',
            source: 'ghost',
          }]);
        } else {
          TrackView.setGhosts([]);
        }
      }

      // ── Update focus mode badges ────────────────────────────────────
      this._updateFocusBadges();

      // ── Feed MilestoneTracker ────────────────────────────────────────
      if (Engine.run && Engine.run.status === 'running') {
        var mSettings = Store.getSettings();
        MilestoneTracker.tick(
          Engine.run.speed || 0,
          Engine.run.incline || 0,
          Engine.run.hr || 0,
          mSettings.maxHR || 185,
          Engine.run.elapsed || 0,
          (Engine.run.distanceM || 0) / 1000
        );
      }

      // ── Feed WorkoutSegments with distance delta ────────────────────
      if (WorkoutSegments.active && Engine.run && Engine.run.status === 'running') {
        var dt = 0.25; // Engine ticks at 250ms
        var speedMs = (Engine.run.speed || 0) / 3.6;
        var distDelta = speedMs * dt;
        var settings = Store.getSettings();
        WorkoutSegments.tick(distDelta, dt, Engine.run.hr || 0, settings.maxHR || 185);

        // Feed OvalTrack with workout progress
        if (OvalTrack.active) {
          var progress = WorkoutSegments.getTotalProgress();
          if (progress) {
            OvalTrack.setProgress(progress.fraction);
            OvalTrack.setTotalDistance(progress.covered, progress.total, progress.unit);
          }
          OvalTrack.setSpeedKph(Engine.run.speed || 0);
          OvalTrack.setHR(Engine.run.hr || 0, settings.maxHR || 185);

          // Segment info
          var seg = WorkoutSegments.getCurrentSegment();
          if (seg && seg.index >= 0) {
            var remainDist = seg.remainingType === 'distance'
              ? SpeedUnits.metresTo(seg.remaining, WorkoutSegments.active.workout.distanceUnit)
              : seg.remaining;
            OvalTrack.setSegmentInfo(
              seg.index + 1,
              seg.total,
              SpeedUnits.format(seg.speed, seg.speedUnit) + ' ' + seg.speedUnit,
              remainDist,
              seg.remainingType === 'distance' ? WorkoutSegments.active.workout.distanceUnit : 's'
            );
          }

          // Ghost on oval track
          if (Engine.ghostEnabled && Engine.ghost) {
            var ghostDistM = Engine.ghost.distanceM || 0;
            var totalDistM = progress.total > 0 ? SpeedUnits.distToMetres(progress.total, progress.unit) : 1;
            OvalTrack.setGhostProgress(totalDistM > 0 ? ghostDistM / totalDistM : 0);
            var deltaS = Engine.run.elapsed > 0 && Engine.ghost.elapsed > 0
              ? Engine.ghost.elapsed - Engine.run.elapsed : 0;
            OvalTrack.setGhostDelta(deltaS);
          }

          // HR zone colour for consumed trail
          if (Engine.run.hr > 0 && settings.maxHR > 0) {
            var hrPct = Engine.run.hr / settings.maxHR;
            var zoneCol = hrPct < 0.6 ? '#6b7280' : hrPct < 0.7 ? '#22c55e' : hrPct < 0.8 ? '#fbbf24' : hrPct < 0.9 ? '#f97316' : '#ef4444';
            OvalTrack.setHRZoneColour(zoneCol);
          }
        }
      }

      // ── Feed OvalTrack without WorkoutSegments (route or free run) ──
      if (!WorkoutSegments.active && OvalTrack.active && Engine.run && Engine.run.status === 'running') {
        var oSettings = Store.getSettings();
        var distKm = (Engine.run.distanceM || 0) / 1000;
        if (Engine.hasRoute()) {
          // Route-based progress
          OvalTrack.setProgress(Engine.run.routeProgress || 0);
          var totalKm = (Engine.route.totalDistM || 1) / 1000;
          OvalTrack.setTotalDistance(distKm, totalKm, 'km');
        } else {
          // Free run — loop the track every 1km
          var loopKm = 1;
          OvalTrack.setProgress((distKm % loopKm) / loopKm);
          OvalTrack.setTotalDistance(distKm, distKm, 'km');
        }
        OvalTrack.setSpeedKph(Engine.run.speed || 0);
        OvalTrack.setHR(Engine.run.hr || 0, oSettings.maxHR || 185);

        // Ghost on oval track
        if (Engine.ghostEnabled && Engine.ghost && Engine.hasRoute()) {
          var gDistM = Engine.ghost.distanceM || 0;
          var tDistM = Engine.route.totalDistM || 1;
          OvalTrack.setGhostProgress(gDistM / tDistM);
          OvalTrack.setGhostDelta(Engine.ghostDelta());
        }

        // HR zone colour
        if (Engine.run.hr > 0 && oSettings.maxHR > 0) {
          var hrP = Engine.run.hr / oSettings.maxHR;
          var zCol = hrP < 0.6 ? '#6b7280' : hrP < 0.7 ? '#22c55e' : hrP < 0.8 ? '#fbbf24' : hrP < 0.9 ? '#f97316' : '#ef4444';
          OvalTrack.setHRZoneColour(zCol);
        }
      }
    };

    Engine.onSplit = (km, timeSec, pace, hr) => {
      UI.showSplitToast(km, timeSec, pace, hr);
      if (UI.splitsOpen) UI.renderSplits();
      // Feed milestone tracker with split data
      var settings = Store.getSettings();
      MilestoneTracker.onSplit(km, settings.distUnit || 'km', timeSec, hr, settings.maxHR || 185);
    };

    Engine.onRunComplete = () => {
      UI.showRunComplete();
    };

    Engine.onCooldownComplete = () => {
      this._endCooldownUI();
      this.finishRun();
    };

    // ── Wire WorkoutSegments callbacks ──────────────────────────────────
    WorkoutSegments.onSegmentChange = (newSeg, oldSeg) => {
      console.log('[App] Segment change:', newSeg);
      if (newSeg && newSeg.label) {
        VoiceCoach.announceSegmentChange({ name: newSeg.label, speed: newSeg.speed, incline: newSeg.incline });
      }
      // Update workout HUD
      var whName = document.getElementById('whStageName');
      if (whName && newSeg) whName.textContent = newSeg.label || 'Segment ' + (newSeg.index + 1);
    };

    WorkoutSegments.onPhaseChange = (phase) => {
      console.log('[App] Phase:', phase);
      if (phase === 'warmup') VoiceCoach.say('Warm up starting. Take it easy.', 'high');
      if (phase === 'cooldown') VoiceCoach.announceCooldownStart();
      if (phase === 'complete') {
        VoiceCoach.announceWorkoutComplete();
        this.finishRun();
      }
    };

    WorkoutSegments.onCountdownTick = (seconds) => {
      VoiceCoach.announceCountdown(seconds);
    };

    WorkoutSegments.onSpeedChange = (kph) => {
      var oldSpeed = Engine.run ? Engine.run.speed : 0;
      if (Engine.run) Engine.ctrl.targetSpeed = kph;
      MilestoneTracker.onSpeedChange(kph, oldSpeed);
    };

    WorkoutSegments.onInclineChange = (pct) => {
      var oldIncline = Engine.run ? Engine.run.incline : 0;
      if (Engine.run) Engine.ctrl.targetIncline = pct;
      MilestoneTracker.onInclineChange(pct, oldIncline);
    };

    WorkoutSegments.onComplete = () => {
      // Already handled by onPhaseChange('complete')
    };

    // ── Wire VoiceCmd callbacks ──────────────────────────────────────────
    VoiceCmd.onCommand = (action, args) => {
      this._handleVoiceCommand(action, args);
    };
    VoiceCmd.onStatus = (status) => {
      var pill = document.getElementById('pillVoice');
      if (pill) {
        pill.style.color = status === 'listening' ? 'var(--green)' : status === 'processing' ? 'var(--yellow)' : 'var(--dim)';
      }
    };

    // ── Wire Streaks badge callback ──────────────────────────────────────
    Streaks.onBadgeEarned = (badge) => {
      this._showBadgeToast(badge);
    };

    // ── Init modules ────────────────────────────────────────────────────
    MapView.init('mapDiv');
    TrackView.init('trackCanvas');
    OvalTrack.init('ovalTrackCanvas');
    Media.init();
    VoiceCmd.init();
    VoiceCoach.init();
    Streaks.init();
    WorkoutBuilder.seedDefaults();

    // ── Load voice settings ────────────────────────────────────────────
    var settings = Store.getSettings();
    VoiceCmd.config.enabled = settings.voiceEnabled || false;
    VoiceCmd.config.sensitivity = settings.voiceSensitivity || 'medium';
    VoiceCoach.config.enabled = settings.ttsEnabled || false;
    VoiceCoach.config.verbosity = settings.ttsVerbosity || 'normal';
    VoiceCoach.config.volume = settings.ttsVolume || 0.8;
    if (settings.ttsVoiceName) VoiceCoach.setVoiceByName(settings.ttsVoiceName);

    // ── Load milestone settings ─────────────────────────────────────
    MilestoneTracker.config.speedChanges = settings.msSpeedChanges !== false;
    MilestoneTracker.config.inclineChanges = settings.msInclineChanges !== false;
    MilestoneTracker.config.hrZoneChanges = settings.msHRZoneChanges !== false;
    MilestoneTracker.config.avgHREnabled = settings.msAvgHR !== false;
    MilestoneTracker.config.avgHRInterval = settings.msAvgHRInterval || 300;
    MilestoneTracker.config.splitSummary = settings.msSplitSummary !== false;
    MilestoneTracker.config.distMilestones = settings.msDistMilestones !== false;
    MilestoneTracker.config.showPopup = settings.msShowPopup !== false;
    MilestoneTracker.config.popupDuration = settings.msPopupDuration || 20;

    // ── Load last active route ───────────────────────────────────────────
    const activeId = Store.getActiveRouteId();
    if (activeId) {
      const route = Store.getRoute(activeId);
      if (route) this._loadRouteData(route);
    }

    // ── Prepare a fresh run ──────────────────────────────────────────────
    Engine.newRun();
    UI.update();
    if (Engine.hasRoute()) UI.drawElevation();

    // ── Viewport scaling (fixed 1280×720 → fit screen) ──────────────────
    this._scaleViewport();
    window.addEventListener('resize', () => this._scaleViewport());

    // ── Wake Lock ────────────────────────────────────────────────────────
    this._requestWakeLock();

    // ── Android back button ──────────────────────────────────────────────
    history.pushState(null, '', '');
    window.addEventListener('popstate', () => {
      this._closeTopPanel();
      history.pushState(null, '', '');
    });

    // ── GPX file import handler ──────────────────────────────────────────
    const fileInput = document.getElementById('gpxFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => this._handleGPXImport(e));
    }

    // ── Keyboard shortcuts ───────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeTopPanel();
      if (e.key === ' ' && Engine.run) {
        e.preventDefault();
        this.togglePause();
      }
    });

    // ── Update sync status indicator ─────────────────────────────────────
    this._updateSyncPill();

    // ── Auto-connect to treadmill bridge on boot ──────────────────────────
    this._autoConnectBridge();

    console.log('[TrailRunner] Initialised (all modules)');
  },

  _updateSyncPill() {
    const pill = document.getElementById('pillSync');
    if (!pill) return;
    if (Sync.isStravaConnected()) {
      const s = Sync.getStatus();
      const name = s.strava.athlete ? s.strava.athlete.firstname : 'Strava';
      pill.textContent = name;
      pill.style.color = '#fc4c02';
      pill.style.borderColor = '#4a2010';
      pill.title = 'Connected to Strava — runs auto-sync';
      if (s.queuedRuns) pill.textContent += ' (' + s.queuedRuns + ')';
    } else {
      pill.textContent = '';
      pill.style.display = 'none';
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RUN LIFECYCLE
  // ════════════════════════════════════════════════════════════════════════════

  startRun() {
    document.getElementById('setupOverlay').style.display = 'none';
    // Auto-connect to treadmill bridge if not already connected
    this._autoConnectBridge();
    Engine.startRun();
    MilestoneTracker.reset();
    this._updateRunButton();
    this._updateFloatingControls();
    this._enterFocusMode();
    if (VoiceCmd.config.enabled) VoiceCmd.startListening();
    // If no route loaded, switch to oval track (map dot needs a route to follow)
    if (!Engine.hasRoute()) {
      this.setMapStyle('oval');
    }
  },

  freeRun() {
    Engine.clearRoute();
    Engine.newRun();
    this.setControlMode('manual');
    document.getElementById('setupOverlay').style.display = 'none';
    // Auto-connect to treadmill bridge if not already connected
    this._autoConnectBridge();
    const rname = document.getElementById('routeName');
    if (rname) rname.textContent = 'FREE RUN';
    // Don't start engine yet — let user set speed and tap START
    MilestoneTracker.reset();
    this._updateRunButton();
    this._updateFloatingControls();
    this._enterFocusMode();
    if (VoiceCmd.config.enabled) VoiceCmd.startListening();
    // Switch to oval track for free run (no map route to show)
    this.setMapStyle('oval');
    // Auto-open speed quick-select so user can pick their running speed
    setTimeout(() => this.toggleQS('speed'), 500);
  },

  /** Auto-connect to bridge and start a workout so the belt can be controlled */
  _autoConnectBridge() {
    if (TM.connected) return;
    // Save a callback so we start the workout once connected
    var origOnConnect = TM.onConnect;
    TM.onConnect = function(port) {
      if (origOnConnect) origOnConnect(port);
      // Auto-start a workout on the bridge (enables belt motor control)
      if (TM.workoutState === 'IDLE') {
        console.log('[App] Auto-starting workout on bridge');
        TM.startWorkout();
      }
    };
    var settings = Store.getSettings();
    TM.connect(settings.wsPort);
  },

  togglePause() {
    if (!Engine.run) return;
    if (Engine.run.status === 'running') {
      Engine.pauseRun();
      // Show a funny pause message
      var jokes = [
        'Gone to find a bush... 🌳',
        'BRB, shoelace emergency 👟',
        'Contemplating life choices...',
        'Water break! Stay hydrated 💧',
        'Gone to pet a dog 🐕',
        'Stretching... or pretending to 🧘',
        'Is it too late to take up swimming?',
        'Quick selfie for the gram 📸',
        'Pretending to check the route map...',
        'Catching breath. Dignity already lost.',
      ];
      var jokeEl = document.getElementById('pauseJoke');
      if (jokeEl) jokeEl.textContent = jokes[Math.floor(Math.random() * jokes.length)];
      document.getElementById('pauseOverlay').classList.add('show');
    } else if (Engine.run.status === 'paused') {
      Engine.resumeRun();
      document.getElementById('pauseOverlay').classList.remove('show');
    }
    this._updateRunButton();
    this._updateFloatingControls();
  },

  finishRun() {
    Engine.finishRun();
    UI.showRunComplete();
    this._updateRunButton();
    this._updateFloatingControls();
    this._exitFocusMode();
    VoiceCmd.stopListening();
    if (WorkoutSegments.active) WorkoutSegments.abort();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COOL-DOWN
  // ════════════════════════════════════════════════════════════════════════════

  startCooldown() {
    if (!Engine.run || Engine.run.status !== 'running') return;
    Engine.startCooldown();
    document.getElementById('cooldownOverlay').classList.add('show');
    this._updateFloatingControls();

    // Tick the cooldown UI every 500ms
    this._cooldownUIHandle = setInterval(() => {
      const cd = Engine.run ? Engine.run._cooldown : null;
      if (!cd) {
        this._endCooldownUI();
        return;
      }
      const remaining = Math.max(0, cd.totalDuration - cd.elapsed);
      const mins = Math.floor(remaining / 60);
      const secs = Math.floor(remaining % 60);
      const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
      el('cdSpeed', Engine.run.speed.toFixed(1));
      el('cdTimer', mins + ':' + String(secs).padStart(2, '0'));
      el('cdHR', Engine.run.hr > 0 ? Engine.run.hr : '—');
      const fill = document.getElementById('cdFill');
      if (fill) fill.style.width = (remaining / cd.totalDuration * 100).toFixed(1) + '%';
    }, 500);
  },

  skipCooldown() {
    Engine.skipCooldown();
    this._endCooldownUI();
  },

  _endCooldownUI() {
    if (this._cooldownUIHandle) {
      clearInterval(this._cooldownUIHandle);
      this._cooldownUIHandle = null;
    }
    const overlay = document.getElementById('cooldownOverlay');
    if (overlay) overlay.classList.remove('show');
    this._updateFloatingControls();
  },

  saveAndNewRun() {
    const saved = Engine.saveRun();
    UI.hideRunComplete();

    // Record workout in Streaks
    if (saved) {
      var summary = {
        distanceKm: (saved.distanceM || 0) / 1000,
        elapsed: saved.elapsed || 0,
        elevGained: saved.elevGain || 0,
        avgHR: Engine.getAvgHR() || 0,
        maxHR: saved.maxHR || 0,
        avgSpeed: saved.avgSpeed || 0,
        calories: saved.calories || 0,
        ghostDelta: Engine.ghostEnabled && Engine.ghost ? (Engine.ghost.elapsed - saved.elapsed) : 0,
      };
      var newBadges = Streaks.recordWorkout(summary);
      if (newBadges && newBadges.length > 0) {
        console.log('[App] New badges:', newBadges.map(b => b.name).join(', '));
      }
    }

    Engine.discardRun();
    Engine.newRun();
    UI.update();
    this._updateRunButton();
    this._updateFloatingControls();
    if (saved) {
      console.log('[App] Run saved:', saved.id);
      // Auto-sync to Strava (fire and forget)
      Sync.autoSync(saved).then(ok => {
        if (ok) console.log('[App] Run synced to Strava');
        this._updateSyncPill();
      }).catch(() => {});
    }
  },

  discardRun() {
    UI.hideRunComplete();
    Engine.discardRun();
    Engine.newRun();
    UI.update();
    this._updateRunButton();
    this._updateFloatingControls();
  },

  exportGPX() {
    if (!Engine.run) return;
    const xml = GPX.exportGPX({
      name: Engine.run.routeName + ' — ' + new Date().toLocaleDateString(),
      startedAt: Engine.run.startedAt,
      trackPoints: Engine.run.trackPoints,
    });
    this._downloadFile(xml, 'trailrunner-' + Date.now() + '.gpx', 'application/gpx+xml');
  },

  exportTCX() {
    if (!Engine.run) return;
    const xml = GPX.exportTCX({
      name: Engine.run.routeName,
      startedAt: Engine.run.startedAt,
      elapsed: Engine.run.elapsed,
      distanceM: Engine.run.distanceM,
      calories: Engine.run.calories,
      avgHR: Engine.getAvgHR(),
      trackPoints: Engine.run.trackPoints,
    });
    this._downloadFile(xml, 'trailrunner-' + Date.now() + '.tcx', 'application/vnd.garmin.tcx+xml');
  },

  _updateRunButton() {
    const btn = document.getElementById('runBtn');
    if (!btn || !Engine.run) return;
    const s = Engine.run.status;
    btn.textContent = s === 'ready' ? '▶ START RUN' : s === 'running' ? '⏸ PAUSE' : s === 'paused' ? '▶ RESUME' : '⏹ FINISHED';
    btn.className = 'run-btn ' + s;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTIONS
  // ════════════════════════════════════════════════════════════════════════════

  connectTreadmill() {
    const settings = Store.getSettings();
    TM.connect(settings.wsPort);
  },

  connectHR() {
    BLEHR.connect();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // EMERGENCY STOP
  // ════════════════════════════════════════════════════════════════════════════

  emergencyStop() {
    TM.emergencyStop();
    if (Engine.run && Engine.run.status === 'running') {
      Engine.pauseRun();
      document.getElementById('pauseOverlay').classList.add('show');
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // WORKOUTS
  // ════════════════════════════════════════════════════════════════════════════

  openWorkouts() {
    WorkoutBuilder.open();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ROUTE MANAGEMENT
  // ════════════════════════════════════════════════════════════════════════════

  openRoutes() { UI.openRouteModal(); },
  closeRoutes() { UI.closeRouteModal(); },

  triggerGPXImport() {
    document.getElementById('gpxFileInput').click();
  },

  _handleGPXImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = GPX.parse(ev.target.result);
        const resampled = GPX.resample(parsed, Engine.RESAMPLE_N);

        const route = Store.saveRoute({
          name: parsed.name,
          totalDistKm: parsed.totalDistKm,
          totalDistM: parsed.totalDistM,
          totalAscent: parsed.totalAscent,
          totalDescent: parsed.totalDescent,
          bounds: parsed.bounds,
          resampled: resampled,
        });

        this.selectRoute(route.id);
        UI.renderRouteList();
        console.log('[App] Route imported:', route.name, route.totalDistKm.toFixed(1) + 'km');
      } catch (err) {
        alert('Failed to parse GPX file: ' + err.message);
        console.error('[App] GPX parse error:', err);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // reset so same file can be re-imported
  },

  selectRoute(id) {
    const route = Store.getRoute(id);
    if (!route) return;
    this._loadRouteData(route);
    Store.setActiveRouteId(id);

    // Reset run with new route
    if (Engine.run && Engine.run.status === 'ready') {
      Engine.newRun();
      UI.update();
    }

    UI.renderRouteList();

    // Update route name in topbar
    const rname = document.getElementById('routeName');
    if (rname) rname.textContent = route.name.toUpperCase();
  },

  _loadRouteData(route) {
    Engine.loadRoute(route);
    MapView.loadRoute(Engine.latlngs);
    UI.drawElevation();

    // Hide "no route" message, show map
    const msg = document.getElementById('noRouteMsg');
    if (msg) msg.style.display = 'none';
  },

  deleteRoute(id) {
    Store.deleteRoute(id);
    if (Store.getActiveRouteId() === id) {
      Store.setActiveRouteId(null);
      Engine.clearRoute();
      MapView.clearRoute();
    }
    UI.renderRouteList();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GHOST RACING
  // ════════════════════════════════════════════════════════════════════════════

  openHistory() { UI.openHistoryPanel(); },
  closeHistory() { UI.closeHistoryPanel(); },

  loadGhost(runId) {
    const runs = Store.getRuns();
    const run = runs.find(r => r.id === runId);
    if (run) {
      Engine.loadGhost(run);
      UI.closeHistoryPanel();
    }
  },

  clearGhost() {
    Engine.clearGhost();
    const panel = document.getElementById('ghostPanel');
    if (panel) panel.style.display = 'none';
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONTROL MODES
  // ════════════════════════════════════════════════════════════════════════════

  setControlMode(mode) {
    Engine.ctrl.mode = mode;
    // Update mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  },

  setTargetZone(z) {
    Engine.ctrl.targetZone = Math.max(1, Math.min(5, z));
  },

  adjustSpeed(delta) {
    Engine.ctrl.targetSpeed = Math.max(0, Math.min(20, +(Engine.ctrl.targetSpeed + delta).toFixed(1)));
    if (TM.connected) {
      TM.setSpeed(Engine.ctrl.targetSpeed);
    }
    // Speed ramps gradually via Engine.tick() — don't set run.speed directly
    this._updateNudgeDisplays();
  },

  adjustIncline(delta) {
    Engine.ctrl.targetIncline = Math.max(-6, Math.min(40, +(Engine.ctrl.targetIncline + delta).toFixed(1)));
    if (TM.connected) {
      TM.setIncline(Engine.ctrl.targetIncline);
    }
    // Always set run incline directly in manual/disconnected mode
    if (Engine.run && (Engine.ctrl.mode === 'manual' || !TM.connected)) {
      Engine.run.incline = Engine.ctrl.targetIncline;
    }
    this._updateNudgeDisplays();
  },

  _updateNudgeDisplays() {
    var _s = Store.getSettings();
    var _unit = _s.speedButtonUnit || 'kph';
    var _disp = SpeedUnits.fromKph(Engine.ctrl.targetSpeed, _unit);
    var _formatted = SpeedUnits.format(_disp, _unit);

    const sv = document.getElementById('fcSpeedVal');
    const iv = document.getElementById('fcIncVal');
    if (sv) sv.textContent = _formatted;
    if (iv) iv.textContent = Engine.ctrl.targetIncline.toFixed(1);
    // Also update bottom-strip big displays
    const bs = document.getElementById('bigSpeedVal');
    const bi = document.getElementById('bigIncVal');
    const bsu = document.getElementById('bigSpeedUnit');
    if (bs) bs.textContent = _formatted;
    if (bsu) bsu.textContent = _unit;
    if (bi) bi.textContent = Engine.ctrl.targetIncline.toFixed(1);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // MAP CONTROLS
  // ════════════════════════════════════════════════════════════════════════════

  setMapStyle(style) {
    const mapDiv = document.getElementById('mapDiv');
    const mediaPanel = document.getElementById('mediaPanel');
    const streetPanel = document.getElementById('streetViewPanel');

    // Hide all panels first
    TrackView.hide();
    OvalTrack.hide();
    mapDiv.style.display = 'none';
    if (mediaPanel) mediaPanel.style.display = 'none';
    if (streetPanel) streetPanel.style.display = 'none';

    if (style === 'track') {
      TrackView.show();
    } else if (style === 'oval') {
      OvalTrack.show();
      // Load segments if a workout is active
      if (WorkoutSegments.active) {
        var segs = WorkoutSegments.getSegmentsWithColours();
        OvalTrack.setSegments(segs.map(function(s) {
          return {
            distance: s.distance || (s.duration || 30),
            speed: SpeedUnits.toKph(s.speed, s.speedUnit),
            incline: s.incline || 0,
            colour: s.colour
          };
        }));
      }
    } else if (style === 'media') {
      if (mediaPanel) mediaPanel.style.display = 'flex';
    } else if (style === 'street') {
      if (streetPanel) streetPanel.style.display = '';
      this._initStreetView();
    } else {
      // Map views: terrain, sat, dark
      mapDiv.style.display = '';
      MapView.setStyle(style);
      MapView.invalidateSize();
    }

    document.querySelectorAll('.map-mode-btn').forEach(btn => {
      btn.classList.toggle('act', btn.dataset.style === style);
    });
  },

  mapZoom(delta) {
    if (typeof MapView !== 'undefined' && MapView.map) {
      MapView.map.setZoom(MapView.map.getZoom() + delta);
    }
  },

  _streetViewReady: false,
  _streetViewPanorama: null,

  _initStreetView() {
    const settings = Store.getSettings();
    const apiKey = settings.googleApiKey;
    const noKeyMsg = document.getElementById('svNoKey');
    const svDiv = document.getElementById('streetViewDiv');

    if (!apiKey) {
      if (noKeyMsg) noKeyMsg.style.display = 'flex';
      if (svDiv) svDiv.style.display = 'none';
      return;
    }

    if (noKeyMsg) noKeyMsg.style.display = 'none';
    if (svDiv) svDiv.style.display = '';

    // Load Google Maps API if not already loaded
    if (!window.google || !window.google.maps) {
      const script = document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' + apiKey;
      script.onload = () => this._createStreetViewPanorama();
      document.head.appendChild(script);
    } else if (!this._streetViewReady) {
      this._createStreetViewPanorama();
    } else {
      this._updateStreetViewPosition();
    }
  },

  _createStreetViewPanorama() {
    const svDiv = document.getElementById('streetViewDiv');
    if (!svDiv || !window.google) return;

    // Default to route start or UK center
    let pos = { lat: 52.04, lng: -1.85 };
    if (Engine.hasRoute() && Engine.resampled.length > 0) {
      const p = Engine.resampled[0];
      pos = { lat: p.lat, lng: p.lon };
    }

    this._streetViewPanorama = new google.maps.StreetViewPanorama(svDiv, {
      position: pos,
      pov: { heading: 0, pitch: 0 },
      zoom: 1,
      disableDefaultUI: true,
      showRoadLabels: false,
    });
    this._streetViewReady = true;
  },

  _updateStreetViewPosition() {
    if (!this._streetViewPanorama || !Engine.hasRoute() || !Engine.run) return;
    const latlon = Engine.getCurrentLatLon();
    if (!latlon) return;

    // Calculate heading from route direction
    const idx = Engine.run.routeIdx;
    const pts = Engine.resampled;
    let heading = 0;
    if (pts && idx < pts.length - 1) {
      const a = pts[idx];
      const b = pts[Math.min(idx + 5, pts.length - 1)];
      const dLon = (b.lon - a.lon) * Math.PI / 180;
      const lat1 = a.lat * Math.PI / 180;
      const lat2 = b.lat * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      heading = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    this._streetViewPanorama.setPosition({ lat: latlon[0], lng: latlon[1] });
    this._streetViewPanorama.setPov({ heading, pitch: 0 });
  },

  zoomIn() {
    MapView.zoomIn();
    const el = document.getElementById('zoomLbl');
    if (el) setTimeout(() => el.textContent = MapView.getZoom() + '×', 150);
  },

  zoomOut() {
    MapView.zoomOut();
    const el = document.getElementById('zoomLbl');
    if (el) setTimeout(() => el.textContent = MapView.getZoom() + '×', 150);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // SETTINGS — now uses SettingsPanel
  // ════════════════════════════════════════════════════════════════════════════

  openSettings() {
    SettingsPanel.open();
  },
  closeSettings() { SettingsPanel.close(); },
  saveSettings() { /* SettingsPanel handles its own save */ },

  connectStrava() {
    // Save app credentials first
    const clientId = document.getElementById('setStravaClientId')?.value?.trim() ||
                     document.getElementById('spStravaId')?.value?.trim();
    const secret = document.getElementById('setStravaSecret')?.value?.trim() ||
                   document.getElementById('spStravaSecret')?.value?.trim();
    if (clientId && secret) {
      Sync.stravaApp = { clientId, clientSecret: secret };
    }
    if (Sync.isStravaConnected()) {
      if (confirm('Disconnect from Strava?')) {
        Sync.disconnectStrava();
      }
    } else {
      Sync.connectStrava();
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // VOICE COMMAND DISPATCH
  // ════════════════════════════════════════════════════════════════════════════

  _handleVoiceCommand(action, args) {
    switch (action) {
      case 'speed_up':
        this.adjustSpeed(0.5);
        VoiceCoach.announceSpeed(Engine.ctrl.targetSpeed, 'kph');
        break;
      case 'speed_down':
        this.adjustSpeed(-0.5);
        VoiceCoach.announceSpeed(Engine.ctrl.targetSpeed, 'kph');
        break;
      case 'speed_set':
        if (args !== null) {
          Engine.ctrl.targetSpeed = Math.max(0, Math.min(20, args));
          if (TM.connected) TM.setSpeed(Engine.ctrl.targetSpeed);
          this._updateNudgeDisplays();
          VoiceCoach.announceSpeed(args, 'kph');
        }
        break;
      case 'incline_up':
        this.adjustIncline(1);
        VoiceCoach.say('Incline ' + Engine.ctrl.targetIncline.toFixed(0) + ' percent.', 'medium');
        break;
      case 'incline_down':
        this.adjustIncline(-1);
        VoiceCoach.say('Incline ' + Engine.ctrl.targetIncline.toFixed(0) + ' percent.', 'medium');
        break;
      case 'incline_set':
        if (args !== null) {
          Engine.ctrl.targetIncline = Math.max(-6, Math.min(40, args));
          if (TM.connected) TM.setIncline(Engine.ctrl.targetIncline);
          this._updateNudgeDisplays();
          VoiceCoach.say('Incline set to ' + args + ' percent.', 'medium');
        }
        break;
      case 'pause':
        if (Engine.run && Engine.run.status === 'running') this.togglePause();
        break;
      case 'resume':
        if (Engine.run && Engine.run.status === 'paused') this.togglePause();
        break;
      case 'stop':
        this.finishRun();
        break;
      case 'skip_segment':
        if (WorkoutSegments.active) WorkoutSegments.skipToNextSegment();
        VoiceCoach.say('Skipping to next segment.', 'high');
        break;
      case 'query_distance':
        if (Engine.run) {
          VoiceCoach.announceDistance((Engine.run.distanceM || 0) / 1000, 'covered');
        }
        break;
      case 'query_speed':
        if (Engine.run) {
          VoiceCoach.announceSpeed(Engine.run.speed || 0, 'kph');
        }
        break;
      case 'query_hr':
        if (Engine.run) {
          var zone = Engine.run.hr > 0 && Store.getSettings().maxHR > 0
            ? Math.ceil((Engine.run.hr / Store.getSettings().maxHR) * 5) : 0;
          VoiceCoach.announceHR(Engine.run.hr || 0, zone);
        }
        break;
      case 'query_time':
        if (Engine.run) {
          VoiceCoach.announceTime(Engine.run.elapsed || 0);
        }
        break;
      case 'query_ghost':
        if (Engine.ghostEnabled && Engine.ghost) {
          var delta = (Engine.ghost.elapsed || 0) - (Engine.run ? Engine.run.elapsed : 0);
          VoiceCoach.announceGhostDelta(delta);
        } else {
          VoiceCoach.say('No ghost loaded.', 'medium');
        }
        break;
      case 'volume_up':
        VoiceCoach.config.volume = Math.min(1, VoiceCoach.config.volume + 0.2);
        break;
      case 'volume_down':
        VoiceCoach.config.volume = Math.max(0.1, VoiceCoach.config.volume - 0.2);
        break;
      case 'mute':
        VoiceCoach.config.enabled = false;
        break;
      case 'unmute':
        VoiceCoach.config.enabled = true;
        VoiceCoach.say('Voice coaching enabled.', 'high');
        break;
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BADGE TOAST
  // ════════════════════════════════════════════════════════════════════════════

  _showBadgeToast(badge) {
    var toast = document.createElement('div');
    toast.className = 'badge-toast';
    toast.innerHTML = '<span class="badge-toast-icon">' + badge.icon + '</span>' +
      '<span class="badge-toast-text">BADGE EARNED: ' + badge.name + '</span>';
    document.getElementById('rootApp').appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 50);
    setTimeout(function() {
      toast.classList.remove('show');
      setTimeout(function() { toast.remove(); }, 500);
    }, 4000);
    VoiceCoach.say('Badge earned! ' + badge.name + '!', 'high');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // FOCUS MODE — simplified running UI
  // ════════════════════════════════════════════════════════════════════════════

  _focusMode: false,

  _enterFocusMode() {
    this._focusMode = true;
    var layout = document.querySelector('.layout');
    var topbar = document.querySelector('.topbar');
    if (layout) layout.classList.add('focus');
    if (topbar) topbar.classList.add('focus');
    // Build quick-select panels from settings
    this._buildQSPanels();
    // Invalidate map size after transition
    setTimeout(function() { MapView.invalidateSize(); }, 400);
  },

  _exitFocusMode() {
    this._focusMode = false;
    var layout = document.querySelector('.layout');
    var topbar = document.querySelector('.topbar');
    if (layout) layout.classList.remove('focus');
    if (topbar) topbar.classList.remove('focus');
    // Close QS panels
    var qsS = document.getElementById('qsSpeed');
    var qsI = document.getElementById('qsIncline');
    if (qsS) qsS.classList.remove('open');
    if (qsI) qsI.classList.remove('open');
    this.closeFocusMenu();
    setTimeout(function() { MapView.invalidateSize(); }, 400);
  },

  toggleFocusMode() {
    if (this._focusMode) this._exitFocusMode();
    else this._enterFocusMode();
  },

  // ── Focus badges update (called from onTick when in focus mode) ────────

  _updateFocusBadges() {
    if (!this._focusMode || !Engine.run) return;
    var el = function(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    el('fbHR', Engine.run.hr > 0 ? Engine.run.hr : '—');
    // HR zone detail
    var hrZoneEl = document.getElementById('fbHRZone');
    if (hrZoneEl) {
      var maxHR = Engine.run.maxHR || 185;
      var hr = Engine.run.hr || 0;
      if (hr > 0 && maxHR > 0) {
        var pct = hr / maxHR;
        var zName = '', zCol = '';
        for (var z = 0; z < Engine.HR_ZONES.length; z++) {
          if (pct >= Engine.HR_ZONES[z].min && pct < Engine.HR_ZONES[z].max) {
            zName = 'Z' + Engine.HR_ZONES[z].z; zCol = Engine.HR_ZONES[z].color; break;
          }
        }
        if (pct >= 1.0) { zName = 'Z5'; zCol = Engine.HR_ZONES[4].color; }
        hrZoneEl.textContent = zName;
        hrZoneEl.style.color = zCol;
      } else {
        hrZoneEl.textContent = '';
      }
    }
    var _s = Store.getSettings();
    var _unit = _s.speedButtonUnit || 'kph';
    var _disp = SpeedUnits.fromKph(Engine.run.speed || 0, _unit);
    el('fbSpeed', SpeedUnits.format(_disp, _unit));
    el('fbSpeedUnit', _unit);
    el('fbInc', (Engine.run.incline || 0).toFixed(1));
    el('fbDist', ((Engine.run.distanceM || 0) / 1000).toFixed(2));
    el('fbCal', Math.round(Engine.run.calories || 0));
  },

  // ── Quick-select panels ────────────────────────────────────────────────

  _buildQSPanels() {
    var s = Store.getSettings();

    // Speed panel (right)
    var speeds = s.customSpeeds || [4, 5, 6, 7, 8, 10];
    var speedUnit = s.speedButtonUnit || 'mph';
    var unitLabel = speedUnit.toUpperCase();
    var qsS = document.getElementById('qsSpeed');
    if (qsS) {
      var html = '<div class="qs-title" onclick="App._cycleQSSpeedUnit()">SPEED ' + unitLabel + ' ⇅</div>';
      for (var i = 0; i < speeds.length && i < 10; i++) {
        html += '<button class="qs-btn speed" onclick="App._qsSetSpeed(' + speeds[i] + ')" data-val="' + speeds[i] + '">' + speeds[i] + '</button>';
      }
      qsS.innerHTML = html;
    }

    // Incline panel (left)
    var inclines = s.customInclines || [30, 25, 20, 15, 10, 5, 0, -6];
    var qsI = document.getElementById('qsIncline');
    if (qsI) {
      var html2 = '<div class="qs-title">INCLINE %</div>';
      for (var j = 0; j < inclines.length && j < 10; j++) {
        html2 += '<button class="qs-btn incline" onclick="App._qsSetIncline(' + inclines[j] + ')" data-val="' + inclines[j] + '">' + inclines[j] + '</button>';
      }
      qsI.innerHTML = html2;
    }
  },

  toggleQS(type) {
    var panel = document.getElementById(type === 'speed' ? 'qsSpeed' : 'qsIncline');
    var other = document.getElementById(type === 'speed' ? 'qsIncline' : 'qsSpeed');
    if (!panel) return;
    if (other) other.classList.remove('open');
    panel.classList.toggle('open');
    // Rebuild in case settings changed
    if (panel.classList.contains('open')) this._buildQSPanels();
  },

  _qsSetSpeed(val) {
    var s = Store.getSettings();
    var unit = s.speedButtonUnit || 'mph';
    // Convert to kph for the engine
    var kph = val;
    if (unit === 'mph') kph = val * 1.60934;
    else if (unit === 'min/mi') kph = val > 0 ? (60 / val) * 1.60934 : 0;
    else if (unit === 'min/km') kph = val > 0 ? 60 / val : 0;
    kph = Math.max(0, Math.min(19.3, kph));
    Engine.ctrl.targetSpeed = kph;
    if (TM.connected) TM.setSpeed(kph);
    // Speed ramps gradually via Engine.tick() — don't set run.speed directly
    this._updateNudgeDisplays();
    // Highlight active button
    var btns = document.querySelectorAll('#qsSpeed .qs-btn');
    btns.forEach(function(b) { b.classList.toggle('active', parseFloat(b.dataset.val) === val); });
  },

  _qsSetIncline(val) {
    Engine.ctrl.targetIncline = val;
    if (TM.connected) TM.setIncline(val);
    if (Engine.run) Engine.run.incline = val;
    this._updateNudgeDisplays();
    var btns = document.querySelectorAll('#qsIncline .qs-btn');
    btns.forEach(function(b) { b.classList.toggle('active', parseFloat(b.dataset.val) === val); });
  },

  _cycleQSSpeedUnit() {
    var s = Store.getSettings();
    var units = ['mph', 'kph', 'min/mi', 'min/km'];
    var idx = units.indexOf(s.speedButtonUnit || 'mph');
    s.speedButtonUnit = units[(idx + 1) % units.length];
    Store.saveSettings(s);
    this._buildQSPanels();
    this._updateNudgeDisplays();
  },

  // ── Focus menu (hamburger) ─────────────────────────────────────────────

  toggleFocusMenu() {
    var overlay = document.getElementById('focusMenuOverlay');
    if (overlay) overlay.classList.toggle('show');
  },

  closeFocusMenu() {
    var overlay = document.getElementById('focusMenuOverlay');
    if (overlay) overlay.classList.remove('show');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // SPLITS
  // ════════════════════════════════════════════════════════════════════════════

  toggleSplits() { UI.toggleSplits(); },

  // ════════════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════════════════════════

  _updateFloatingControls() {
    const start = document.getElementById('fcStart');
    const pause = document.getElementById('fcPause');
    const resume = document.getElementById('fcResume');
    const stop = document.getElementById('fcStop');
    const cooldown = document.getElementById('fcCooldown');
    if (!start) return;

    const status = Engine.run ? Engine.run.status : 'ready';
    const isCooling = Engine.run && Engine.run._cooldown;

    start.style.display = status === 'ready' ? '' : 'none';
    pause.style.display = (status === 'running' && !isCooling) ? '' : 'none';
    resume.style.display = status === 'paused' ? '' : 'none';
    if (cooldown) cooldown.style.display = (status === 'running' && !isCooling) ? '' : 'none';
    stop.style.display = (status === 'running' || status === 'paused') ? '' : 'none';

    this._updateNudgeDisplays();
  },

  _scaleViewport() {
    const root = document.getElementById('rootApp');
    if (!root) return;
    const sx = window.innerWidth / 1280;
    const sy = window.innerHeight / 720;
    const scale = Math.min(sx, sy);
    root.style.transform = 'scale(' + scale + ')';
  },

  async _requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        await navigator.wakeLock.request('screen');
        console.log('[App] Wake lock acquired');
      }
    } catch {}
  },

  _closeTopPanel() {
    // Close whichever panel is open (priority order)
    var focusMenu = document.getElementById('focusMenuOverlay');
    if (focusMenu && focusMenu.classList.contains('show')) { this.closeFocusMenu(); return; }
    // Close QS panels
    var qsS = document.getElementById('qsSpeed');
    var qsI = document.getElementById('qsIncline');
    if (qsS && qsS.classList.contains('open')) { qsS.classList.remove('open'); return; }
    if (qsI && qsI.classList.contains('open')) { qsI.classList.remove('open'); return; }
    if (WorkoutBuilder._overlayEl && WorkoutBuilder._overlayEl.classList.contains('show')) {
      WorkoutBuilder.close(); return;
    }
    if (SettingsPanel._el && SettingsPanel._el.classList.contains('show')) {
      SettingsPanel.close(); return;
    }
    const routeModal = document.getElementById('routeModal');
    if (routeModal && routeModal.classList.contains('show')) { UI.closeRouteModal(); return; }
    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal && settingsModal.classList.contains('show')) { UI.closeSettings(); return; }
    const cdOverlay = document.getElementById('cooldownOverlay');
    if (cdOverlay && cdOverlay.classList.contains('show')) { this.skipCooldown(); return; }
    const pauseOverlay = document.getElementById('pauseOverlay');
    if (pauseOverlay && pauseOverlay.classList.contains('show')) { this.togglePause(); return; }
    const finishOverlay = document.getElementById('finishOverlay');
    if (finishOverlay && finishOverlay.classList.contains('show')) { this.discardRun(); return; }
    if (UI.splitsOpen) { UI.toggleSplits(); return; }
  },

  _downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
