// ════════════════════════════════════════════════════════════════════════════
// App — initialisation, event binding, glue between modules
// ════════════════════════════════════════════════════════════════════════════

const App = {

  // ════════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════════

  init() {
    // Init IndexedDB for run storage (async migration from localStorage)
    if (typeof IDBStore !== 'undefined') IDBStore.init();

    UI.init();
    this._checkRunAgainPending();

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
    // When workout starts on treadmill, re-send target speed/incline
    // (user may have adjusted before workout was ready)
    TM.onWorkoutStarted = () => {
      if (Engine.ctrl.targetSpeed > 0) {
        TM._lastSpeed = -1;  // reset dedup so command goes through
        TM.setSpeed(Engine.ctrl.targetSpeed);
      }
      if (Engine.ctrl.targetIncline !== 0) {
        TM._lastIncline = -9999;
        TM.setIncline(Engine.ctrl.targetIncline);
      }
    };

    // ── Wire BLE HR callbacks ────────────────────────────────────────────
    BLEHR.onHR = (hr) => Engine.onBLEHR(hr);
    BLEHR.onStatus = (state, name) => UI.updateConnectionPill('hr', state, name);

    // ── Wire FTMS callbacks ──────────────────────────────────────────────
    FTMS.onData = (data) => Engine.onFTMSData(data);
    FTMS.onStatus = (state, name) => UI.updateConnectionPill('tm', state, name);

    // ── Cache DOM refs and settings for hot-path performance ────────────
    this._elBigSpeed = null;
    this._elBigInc = null;
    this._elBigSpeedUnit = null;
    this._cachedSettings = null;
    this._settingsCacheTime = 0;
    this._lastMapPanTime = 0;

    // ── Wire engine callbacks ────────────────────────────────────────────
    Engine.onTick = () => {
      UI.update();
      UI.drawElevation();
      // Keep big displays in sync with actual run values (in user's chosen unit)
      // Cache element refs — avoids getElementById 4x per second
      if (!this._elBigSpeed) this._elBigSpeed = document.getElementById('bigSpeedVal');
      if (!this._elBigInc) this._elBigInc = document.getElementById('bigIncVal');
      if (!this._elBigSpeedUnit) this._elBigSpeedUnit = document.getElementById('bigSpeedUnit');
      // Cache settings (refresh every 5s, not every 250ms tick)
      var now = Date.now();
      if (!this._cachedSettings || now - this._settingsCacheTime > 5000) {
        this._cachedSettings = Store.getSettings();
        this._settingsCacheTime = now;
      }
      if (this._elBigSpeed && Engine.run) {
        var _unit = this._cachedSettings.speedButtonUnit || 'kph';
        var _disp = SpeedUnits.fromKph(Engine.run.speed, _unit);
        this._elBigSpeed.textContent = SpeedUnits.format(_disp, _unit);
        if (this._elBigSpeedUnit) this._elBigSpeedUnit.textContent = _unit;
      }
      if (this._elBigInc && Engine.run) this._elBigInc.textContent = Engine.run.incline.toFixed(1);
      // ui-v4: show "→ target" under the live number while the belt/ramp is still moving
      this._updateTargetHints();
      this._updateStateBanner();
      this._updateRibbon();
      this._updateElevStrip();
      this._updateBigNumbers();
      if (typeof VideoView !== 'undefined' && VideoView.active) VideoView.update();
      if (Engine.hasRoute()) {
        // Throttle map pan to every 500ms (halves Leaflet repaints vs every tick)
        if (now - this._lastMapPanTime >= 500) {
          this._lastMapPanTime = now;
          MapView.updateRunner(Engine.getCurrentLatLon());
        }
        MapView.updateGhost(Engine.getGhostLatLon(), Engine.ghostEnabled);
        // Strava: racer dots, greened part of the route, compact gap bar (routes only)
        if (window.StravaRoutes) StravaRoutes.onTick(Engine.run);
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
          power: Engine.run.power || 0,
          elapsed: Engine.run.elapsed || 0,
          driftPct: Engine.getDriftPct(),
          ef: Engine.getEF(),
          // ui-v4 fix: TrackView expects {dist: km, elev: m}; Engine.resampled is {dist: m, ele: m}
          elevProfile: this._elevProfileKm(),
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

      // Feed trail cam with current run data
      if (typeof TrailCam !== 'undefined' && TrailCam.active && Engine.run) {
        TrailCam.update({
          distKm: (Engine.run.distanceM || 0) / 1000,
          routeProgress: Engine.hasRoute() ? (Engine.run.routeProgress || 0) : null,
          routeKm: Engine.hasRoute() ? (Engine.route.totalDistKm || 0) : 0,
          speedKmh: Engine.run.speed || 0,
          incline: Engine.run.incline || 0,
          hr: Engine.run.hr || 0,
          power: Engine.run.power || 0,
          elapsed: Engine.run.elapsed || 0,
          driftPct: Engine.getDriftPct(),
          ef: Engine.getEF(),
        });
      }

      // ── Update focus mode badges ────────────────────────────────────
      this._updateFocusBadges();

      // ── Feed MilestoneTracker ────────────────────────────────────────
      if (Engine.run && Engine.run.status === 'running') {
        MilestoneTracker.tick(
          Engine.run.speed || 0,
          Engine.run.incline || 0,
          Engine.run.hr || 0,
          this._cachedSettings.maxHR || 185,
          Engine.run.elapsed || 0,
          (Engine.run.distanceM || 0) / 1000
        );
      }

      // ── Feed WorkoutSegments with distance delta ────────────────────
      if (WorkoutSegments.active && Engine.run && Engine.run.status === 'running') {
        var dt = 0.25; // Engine ticks at 250ms
        var speedMs = (Engine.run.speed || 0) / 3.6;
        var distDelta = speedMs * dt;
        WorkoutSegments.tick(distDelta, dt, Engine.run.hr || 0, this._cachedSettings.maxHR || 185);

        // Feed OvalTrack with workout progress
        if (OvalTrack.active) {
          var progress = WorkoutSegments.getTotalProgress();
          if (progress) {
            OvalTrack.setProgress(progress.fraction);
            OvalTrack.setTotalDistance(progress.covered, progress.total, progress.unit);
          }
          OvalTrack.setSpeedKph(Engine.run.speed || 0);
          OvalTrack.setHR(Engine.run.hr || 0, this._cachedSettings.maxHR || 185);
          OvalTrack.setPower(Engine.run.power || 0, Engine.getAvgPower());

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
          if (Engine.run.hr > 0 && this._cachedSettings.maxHR > 0) {
            var hrPct = Engine.run.hr / this._cachedSettings.maxHR;
            var zoneCol = hrPct < 0.6 ? '#6b7280' : hrPct < 0.7 ? '#22c55e' : hrPct < 0.8 ? '#fbbf24' : hrPct < 0.9 ? '#f97316' : '#ef4444';
            OvalTrack.setHRZoneColour(zoneCol);
          }
        }
      }

      // ── Feed OvalTrack without WorkoutSegments (route or free run) ──
      if (!WorkoutSegments.active && OvalTrack.active && Engine.run && Engine.run.status === 'running') {
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
        OvalTrack.setHR(Engine.run.hr || 0, this._cachedSettings.maxHR || 185);
        OvalTrack.setPower(Engine.run.power || 0, Engine.getAvgPower());

        // Ghost on oval track
        if (Engine.ghostEnabled && Engine.ghost && Engine.hasRoute()) {
          var gDistM = Engine.ghost.distanceM || 0;
          var tDistM = Engine.route.totalDistM || 1;
          OvalTrack.setGhostProgress(gDistM / tDistM);
          OvalTrack.setGhostDelta(Engine.ghostDelta());
        }

        // HR zone colour
        // ui-v4 fix: upstream referenced an undefined `oSettings` here (threw every tick on the oval track)
        if (Engine.run.hr > 0 && this._cachedSettings.maxHR > 0) {
          var hrP = Engine.run.hr / this._cachedSettings.maxHR;
          var zCol = hrP < 0.6 ? '#6b7280' : hrP < 0.7 ? '#22c55e' : hrP < 0.8 ? '#fbbf24' : hrP < 0.9 ? '#f97316' : '#ef4444';
          OvalTrack.setHRZoneColour(zCol);
        }
      }
    };

    Engine.onSplit = (km, timeSec, pace, hr, isNegativeSplit) => {
      UI.showSplitToast(km, timeSec, pace, hr);
      if (UI.splitsOpen) UI.renderSplits();
      // Feed milestone tracker with split data
      var settings = Store.getSettings();
      MilestoneTracker.onSplit(km, settings.distUnit || 'km', timeSec, hr, settings.maxHR || 185);
      // Announce negative split
      if (isNegativeSplit) {
        var prevSplit = Engine.run.splits.length >= 2 ? Engine.run.splits[Engine.run.splits.length - 2] : null;
        var diff = prevSplit ? prevSplit.timeSec - timeSec : 0;
        VoiceCoach.say('Negative split! ' + Math.round(diff) + ' seconds faster than the last K.', 'medium');
        MilestoneTracker._showPopup('NEGATIVE SPLIT! ' + Math.round(diff) + 's faster', '#22c55e');
        if (Engine.run._consecutiveNegSplits >= 3) {
          VoiceCoach.say(Engine.run._consecutiveNegSplits + ' negative splits in a row. Strong finish!', 'low');
        }
      }
    };

    Engine.onRunComplete = () => {
      UI.showRunComplete();
    };

    Engine.onCooldownComplete = () => {
      this._endCooldownUI();
      this.finishRun();
    };

    Engine.onHRRecovery = (hrr) => {
      // Update the finish overlay with HRR result
      var el = document.getElementById('fHRR');
      if (el) {
        var rating = hrr.drop >= 40 ? 'Excellent' : hrr.drop >= 25 ? 'Good' : hrr.drop >= 12 ? 'Average' : 'Below avg';
        var color = hrr.drop >= 40 ? '#69f0ae' : hrr.drop >= 25 ? '#3ecfff' : hrr.drop >= 12 ? '#ffb74d' : '#ff5f5f';
        el.innerHTML = '<span style="color:var(--dim)">HR Recovery (1 min): </span>' +
          '<span style="color:' + color + '">' + hrr.hrAtFinish + ' → ' + hrr.hrAfter60s + ' bpm ' +
          '(<strong>-' + hrr.drop + '</strong> bpm · ' + rating + ')</span>';
        el.style.display = '';
      }
      if (typeof VoiceCoach !== 'undefined') {
        var ratingText = hrr.drop >= 40 ? 'excellent' : hrr.drop >= 25 ? 'good' : hrr.drop >= 12 ? 'average' : 'below average';
        VoiceCoach.say('Heart rate recovery: ' + ratingText + '. Dropped ' + hrr.drop + ' beats.', 'medium');
      }
    };

    // ui-v4 fix: upstream called UI.showPause()/UI.hidePause(), which do not exist (threw on auto-pause)
    UI.showPause = function() {
      var pm = document.getElementById('pauseMsg');
      if (pm) pm.textContent = 'Belt stopped for 3 s — auto-paused. It resumes by itself when the belt moves.';
      var ov = document.getElementById('pauseOverlay'); if (ov) ov.classList.add('show');
    };
    UI.hidePause = function() { var ov = document.getElementById('pauseOverlay'); if (ov) ov.classList.remove('show'); };
    Engine.onAutoPause = () => {
      UI.showPause();
      this._updateRunButton();
      if (typeof VoiceCoach !== 'undefined') VoiceCoach.say('Auto paused. Belt stopped.', 'medium');
    };

    Engine.onAutoResume = () => {
      UI.hidePause();
      this._updateRunButton();
      if (typeof VoiceCoach !== 'undefined') VoiceCoach.say('Resumed.', 'low');
    };

    Engine.onDriftWarning = (driftPct) => {
      var pct = Math.round(driftPct);
      if (typeof VoiceCoach !== 'undefined') {
        VoiceCoach.say('Cardiac drift detected at ' + pct + ' percent. Your heart is working harder at the same pace. Consider hydrating.', 'high');
      }
      if (typeof MilestoneTracker !== 'undefined') {
        MilestoneTracker._showPopup('CARDIAC DRIFT ' + pct + '% — Hydrate!', '#ff8844');
      }
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
    // Strava (wired round 4): F/A/S discs on the oval track; Strava runs in the per-km comparison pool
    if (window.StravaRacers) StravaRacers.ovalTrack.install();
    if (window.StravaRacers && typeof PastRunSplits !== 'undefined') PastRunSplits.sources.push(StravaRacers.splitsSource);
    if (typeof TrailCam !== 'undefined') TrailCam.init('trailCamPanel');
    Media.init();
    VoiceCmd.init();
    VoiceCoach.init();
    if (typeof VoiceCommands !== 'undefined' && VoiceCommands.supported) VoiceCommands.init();
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
    // Strava: retry already-confirmed uploads when the connection returns (never uploads anything unconfirmed)
    if (window.StravaUpload) StravaUpload.autoFlushOnOnline();

    // ── ui-v4: bridge state → banner, dropped-workout handling ──────────
    TM.onWorkout = () => this._updateStateBanner();
    TM.onWorkoutResult = (res) => {
      if (res && res.ok === false && res.action === 'start') {
        this._toast('Treadmill refused to start: ' + (res.error || 'unknown'), 'var(--red)');
      }
      this._updateStateBanner();
    };
    TM.onWorkoutDropped = () => {
      // Bridge says IDLE while we expected RUNNING (safety key, console stop…)
      if (Engine.run && Engine.run.status === 'running') {
        Engine.pauseRun();
        var pm = document.getElementById('pauseMsg');
        if (pm) pm.textContent = 'The treadmill stopped the belt (safety key or console). Resume when ready.';
        document.getElementById('pauseOverlay').classList.add('show');
        this._updateFloatingControls();
      }
      this._updateStateBanner();
    };
    TM.onClipped = (req, sent, cap) => { this._clipNote = { req: req, sent: sent, cap: cap, at: Date.now() }; this._toast('Speed clipped to your maximum: ' + sent.toFixed(1) + ' km/h (asked ' + req.toFixed(1) + ')', 'var(--orange)'); };
    TM.onCommandRejected = (what, reason) => {
      var real = Engine.run ? (what === 'speed' ? (Engine.run.speed || 0).toFixed(1) + ' km/h' : (Engine.run.incline || 0).toFixed(1) + '%') : '';
      this._toast('Treadmill refused the ' + what + ' change: ' + reason + (real ? ' (belt is at ' + real + ')' : ''), 'var(--orange)');
    };
    Engine.onHRLost = () => { UI.update(); this._updateRibbon(true); };
    // audit P1-c: no dead mic button — hide it when SpeechRecognition is missing, say so in Settings
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      var mic = document.getElementById('voiceMicBtn');
      if (mic) {
        mic.classList.add('unavailable');
        mic.title = 'Voice commands are not available on this treadmill';
        mic.setAttribute('onclick', '');
        mic.onclick = function (e) { e.stopPropagation(); App._voiceToast('Voice commands are not available on this treadmill'); };
      }
      this.voiceUnavailable = true;
    }
    this._installSplitSim();
    window.TR_onVideoSplit = (mode) => this._onVideoSplit(mode);
    this._bannerTimer = setInterval(() => { this._updateStateBanner(); this._updateRibbon(); }, 1000);
    this._updateStateBanner();
    this._updateHomeRoute();
    this._updateElevStrip();
    this.setControlMode(Engine.ctrl.mode);
    this._applyRouteVisibility();
    if (typeof VideoWin !== 'undefined') VideoWin.init();
    if (typeof VideoView !== 'undefined') VideoView.init();

    // ── ui-v4 demo helpers for testing the route / no-route states on the mock:
    //    ?demo=route   → imports mock/sample.gpx if no routes exist, makes it active
    //    ?demo=noroute → deletes all stored routes
    var demo = /[?&]demo=(route|noroute)/.exec(window.location.search);
    if (demo && demo[1] === 'noroute') {
      Store.getRoutes().forEach((r) => this.deleteRoute(r.id));
    } else if (demo && demo[1] === 'route' && Store.getRoutes().length === 0) {
      fetch('mock/sample.gpx').then((r) => r.text()).then((xml) => {
        const parsed = GPX.parse(xml);
        const route = Store.saveRoute({
          name: parsed.name, totalDistKm: parsed.totalDistKm, totalDistM: parsed.totalDistM,
          totalAscent: parsed.totalAscent, totalDescent: parsed.totalDescent, bounds: parsed.bounds,
          resampled: GPX.resample(parsed, Engine.RESAMPLE_N),
        });
        this.selectRoute(route.id);
      }).catch(() => {});
    }

    // ── Auto-connect to treadmill bridge on boot (connect only, no workout start)
    this._autoConnectBridge(false);

    console.log('[TrailRunner ui-v4] Initialised — bridge at ' + TM._bridgeBase);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ui-v4: HOME ↔ LIVE navigation, armed workouts, state banner
  // ════════════════════════════════════════════════════════════════════════════

  _armedWorkout: null,

  _showLive() {
    document.getElementById('setupOverlay').style.display = 'none';
    this._applyRouteVisibility();
    this._updateFloatingControls();
    this._updateElevStrip();
    this._updateStateBanner();
    setTimeout(function() { MapView.invalidateSize(); }, 50);
  },

  /** Back to the home picker. Only when no run is in progress. */
  goHome() {
    if (Engine.run && (Engine.run.status === 'running' || Engine.run.status === 'paused')) {
      this._toast('Stop the run first', 'var(--orange)');
      return;
    }
    this.closeFocusMenu();
    this._armedWorkout = null;
    if (WorkoutSegments.active) WorkoutSegments.abort();
    var wc = document.getElementById('workoutChip'); if (wc) wc.textContent = '';
    Engine.ctrl.targetSpeed = 0; Engine.ctrl.targetIncline = 0;
    document.querySelectorAll('.milestone-popup').forEach(function(p) { p.classList.remove('show'); });
    var qsS = document.getElementById('qsSpeed'), qsI = document.getElementById('qsIncline');
    if (qsS) qsS.classList.remove('open');
    if (qsI) qsI.classList.remove('open');
    Engine.newRun();
    UI.update();
    this._updateHomeRoute();
    document.getElementById('setupOverlay').style.display = '';
    this._updateStateBanner();
  },

  /** Route tile → picker → RUN THIS ROUTE: go live with the active route (belt NOT started). */
  runRoute() {
    if (!Engine.hasRoute()) {
      // Route may have been cleared by a free run / workout — reload the stored active one
      var activeId = Store.getActiveRouteId();
      var stored = activeId ? Store.getRoute(activeId) : null;
      if (stored) this._loadRouteData(stored);
    }
    if (!Engine.hasRoute()) { this._toast('Pick a route first', 'var(--orange)'); return; }
    UI.closeRouteModal();
    this._armedWorkout = null;
    Engine.newRun();
    this.setControlMode('route');
    var rname = document.getElementById('routeName');
    if (rname) rname.textContent = Engine.route.name.toUpperCase();
    this._autoConnectBridge(false);
    UI.update();
    this._showLive();
    this.setMapStyle('terrain');
  },

  /** Workout picked in the builder: arm it; START runs it. */
  armWorkout(w) {
    this._armedWorkout = w;
    Engine.clearRoute();
    MapView.clearRoute();
    if (window.StravaRoutes) StravaRoutes.onRouteLoaded(null);
    var msg = document.getElementById('noRouteMsg'); if (msg) msg.style.display = 'none';
    Engine.newRun();
    if (Engine.run) Engine.run.routeName = w.name || 'Workout';
    this.setControlMode('manual');
    var rname = document.getElementById('routeName');
    if (rname) rname.textContent = (w.name || 'WORKOUT').toUpperCase();
    var wc = document.getElementById('workoutChip');
    if (wc) wc.textContent = (w.type || 'workout').toUpperCase().replace('-', ' ') + ' · ' + ((w.segments || w.intervals || []).length) + ' SEGMENTS';
    this._autoConnectBridge(false);
    UI.update();
    this._showLive();
    this.setMapStyle('oval');
  },

  toggleMoreStats() {
    var c = document.querySelector('.center');
    if (c) c.classList.toggle('more');
    setTimeout(function() { MapView.invalidateSize(); }, 50);
  },

  _updateHomeRoute() {
    var el = document.getElementById('homeRouteName');
    if (!el) return;
    var activeId = Store.getActiveRouteId();
    var r = Engine.hasRoute() ? Engine.route : (activeId ? Store.getRoute(activeId) : null);
    if (r) {
      el.textContent = r.name + ' · ' + (r.totalDistKm || 0).toFixed(1) + ' km · +' + Math.round(r.totalAscent || 0) + ' m';
    } else {
      el.textContent = 'Pick a GPX route · incline follows the hills';
    }
  },

  _updateElevStrip() {
    var s = document.getElementById('elevStrip');
    if (!s) return;
    var want = Engine.hasRoute();
    if (want !== s.classList.contains('show')) {
      s.classList.toggle('show', want);
      setTimeout(function() { MapView.invalidateSize(); if (want) UI.drawElevation(); }, 50);
    }
  },

  /** Route profile in the units TrackView wants ({dist: km, elev: m}); cached per route. */
  _elevProfileKm() {
    if (!Engine.hasRoute()) return null;
    if (this._elevProfileSrc !== Engine.resampled) {
      this._elevProfileSrc = Engine.resampled;
      this._elevProfileCache = Engine.resampled.map(function(p) { return { dist: (p.dist || 0) / 1000, elev: p.ele || 0 }; });
    }
    return this._elevProfileCache;
  },

  _updateTargetHints() {
    var sT = document.getElementById('spTarget');
    var iT = document.getElementById('incTarget');
    if (!Engine.run) return;
    var s = this._cachedSettings || Store.getSettings();
    var unit = s.speedButtonUnit || 'kph';
    if (sT) {
      var diff = Math.abs(Engine.ctrl.targetSpeed - Engine.run.speed);
      var txt = (diff > 0.15 && Engine.run.status === 'running')
        ? '→ ' + SpeedUnits.format(SpeedUnits.fromKph(Engine.ctrl.targetSpeed, unit), unit) : '';
      if (this._clipNote && Date.now() - this._clipNote.at < 15000) txt += (txt ? ' ' : '') + 'MAX ' + this._clipNote.cap.toFixed(1);
      sT.textContent = txt;
    }
    var sB = document.getElementById('spBelt');
    if (sB) {
      var belt = TM.connected && TM._beltKph >= 0 ? TM._beltKph : null;
      var stopping = belt != null && belt > 0.5 && (TM._target === 0 || TM._sentSpeed === 0) && (TM._lastSpeedT || TM._lastSendT) > 0;
      sB.textContent = belt == null ? '' : (stopping ? 'STOPPING… belt ' + belt.toFixed(1) : 'belt ' + belt.toFixed(1));
      sB.classList.toggle('stopping', !!stopping);
    }
    if (iT) {
      var idiff = Math.abs(Engine.ctrl.targetIncline - Engine.run.incline);
      iT.textContent = (idiff > 0.25 && Engine.run.status === 'running') ? '→ ' + Engine.ctrl.targetIncline.toFixed(1) + '%' : '';
    }
  },

  /** The unmistakable STOPPED / RUNNING banner — reflects the REAL bridge state. */
  _updateStateBanner() {
    var b = document.getElementById('stateBanner');
    var t = document.getElementById('stateBannerText');
    var sub = document.getElementById('stateBannerSub');
    if (!b || !t) return;
    var cls = 'offline', text = 'NO TREADMILL', subText = '';
    var engineRunning = Engine.run && Engine.run.status === 'running';
    var enginePaused = Engine.run && Engine.run.status === 'paused';
    if (TM._safetyKeyWarning) {
      cls = 'danger'; text = 'SAFETY KEY OUT'; subText = 'belt stopped';
    } else if (!TM.connected) {
      cls = 'offline'; text = TM._connecting ? 'CONNECTING…' : 'NO TREADMILL';
      subText = engineRunning ? 'app timer running · belt not controlled' : 'tap START to retry';
    } else {
      var ws = TM.workoutState || 'IDLE';
      var belt = TM._beltKph >= 0 ? TM._beltKph : (Engine.run && Engine.run.speedSource === 'treadmill' ? Engine.run.speed : null);
      var stopCmd = (TM._sentSpeed === 0 || TM._target === 0) && TM._lastSendT > 0;
      if (stopCmd && belt != null && belt > 0.5 && !enginePaused) {
        // STOP accepted, belt still slowing (hardware decel ~1.4 kph/s): say so, and hint the safety key when fast
        cls = 'paused'; text = 'STOPPING'; subText = 'belt ' + belt.toFixed(1) + ' km/h — slowing';
        if (belt > 6 && !this._keyHintAt) { this._keyHintAt = Date.now(); this._toast('Pull the safety key for a faster stop', 'var(--red)'); }
        if (belt > 6) subText += ' · pull the safety key for a faster stop';
        if (b.className !== 'state-banner ' + cls) b.className = 'state-banner ' + cls;
        t.textContent = text; if (sub) sub.textContent = subText;
        return;
      }
      if (!(stopCmd && belt != null && belt > 0.5)) this._keyHintAt = 0;
      if (ws === 'RUNNING') {
        cls = 'running'; text = 'RUNNING';
        subText = belt != null ? ('belt ' + belt.toFixed(1) + ' km/h') : '';
        if (enginePaused) {
          // Graceful ramp-down in progress (Engine.pauseRun ramps to 0 before telling the bridge)
          if (belt != null && belt > 0.3) { cls = 'paused'; text = 'STOPPING…'; subText = 'belt slowing · ' + belt.toFixed(1) + ' km/h'; }
          else { cls = 'paused'; text = 'PAUSED'; subText = 'belt stopped'; }
        }
      } else if (ws === 'PAUSED') {
        cls = 'paused'; text = 'PAUSED'; subText = 'belt stopped';
      } else {
        cls = 'stopped'; text = 'STOPPED';
        subText = engineRunning ? 'belt not running — tap STOP' : 'belt is off';
        if (engineRunning) cls = 'warn';
      }
      if (ws === 'RUNNING' && !engineRunning && !enginePaused) {
        // Bridge still has a workout open but the app has no run (e.g. console-started)
        cls = 'warn'; text = 'BELT ACTIVE';
        subText = belt != null && belt > 0.3 ? ('moving ' + belt.toFixed(1) + ' km/h — START takes over') : 'treadmill workout open — START takes over';
      }
    }
    if (b.className !== 'state-banner ' + cls) b.className = 'state-banner ' + cls;
    if (t.textContent !== text) t.textContent = text;
    if (sub && sub.textContent !== subText) sub.textContent = subText;
    // Home menu item only when no run is active
    var fh = document.getElementById('fmHome');
    if (fh) fh.classList.toggle('disabled', !!(engineRunning || enginePaused));
  },

  /** feedback in the #voiceToast element the voice module (and the audit) use */
  _voiceToast(msg) {
    var t = document.getElementById('voiceToast');
    if (!t) { t = document.createElement('div'); t.id = 'voiceToast'; t.style.cssText = 'position:absolute;top:110px;left:50%;transform:translateX(-50%);background:#3a2a05;color:#ffd54a;border:2px solid #ffd54a;border-radius:16px;padding:14px 28px;font-size:26px;font-weight:800;z-index:9700;pointer-events:none;transition:opacity .4s'; (document.getElementById('rootApp') || document.body).appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; clearTimeout(t._t); t._t = setTimeout(function () { t.style.opacity = '0'; }, 3500);
  },

  _toast(msg, color) {
    var el = document.getElementById('mediaToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mediaToast';
      el.style.cssText = 'position:absolute;bottom:200px;left:50%;transform:translateX(-50%);color:#fff;z-index:9999;' +
        'font-weight:800;transition:opacity .4s;pointer-events:none;';
      document.getElementById('rootApp').appendChild(el);
    }
    el.style.background = color || 'var(--card2)';
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(function() { el.style.opacity = '0'; }, 3500);
  },

  _updateSyncPill() {
    const pill = document.getElementById('pillSync');
    if (!pill) return;
    if (window.StravaApi && StravaApi.isConnected()) {
      const t = StravaApi.tokens();
      const name = t && t.athlete && t.athlete.firstname ? t.athlete.firstname : 'Strava';
      pill.textContent = name;
      pill.style.display = '';
      pill.style.color = '#fc4c02';
      pill.style.borderColor = '#4a2010';
      pill.title = 'Connected to Strava: asks before every upload';
      if (window.StravaUpload) StravaUpload.queueLength().then((n) => { if (n) pill.textContent = name + ' (' + n + ')'; }).catch(() => {});
    } else {
      pill.textContent = '';
      pill.style.display = 'none';
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RUN LIFECYCLE
  // ════════════════════════════════════════════════════════════════════════════

  startRun() {
    // ui-v4: this is the ONLY place the belt is started, and only from the big
    // green START tap. Everything else (home tiles, route/workout pickers) just arms.
    document.getElementById('setupOverlay').style.display = 'none';
    if (!TM.connected) {
      // audit P1-i: never silently start a belt-less "run"; the START button shows NO LINK and we retry the bridge
      this._toast('No link to treadmill — reconnecting…', 'var(--red)');
      this._autoConnectBridge(false);
      this._updateFloatingControls();
      return;
    }
    if (!Engine.run || Engine.run.status !== 'ready') Engine.newRun();
    // Clear e-stop flag — user is explicitly starting a new run
    TM.clearEstop();
    // Connect + start workout (user-initiated, safe to start belt)
    this._autoConnectBridge(true);
    var armed = this._armedWorkout;
    if (armed) {
      if (Engine.run) Engine.run.routeName = armed.name || 'Workout';
      if (typeof WorkoutSegments !== 'undefined') WorkoutSegments.start(armed);
      if (OvalTrack.active) this.setMapStyle('oval'); // reload coloured segments
    }
    Engine.startRun();
    MilestoneTracker.reset();
    // Load last run's splits for real-time comparison
    if (Engine.route && Engine.route.id) {
      var pastRuns = Store.getRunsForRoute(Engine.route.id);
      MilestoneTracker._lastRunSplits = (pastRuns.length > 0 && pastRuns[0].splits) ? pastRuns[0].splits : null;
    } else if (Engine.run && Engine.run.routeName && Engine.run.routeName !== 'Free Run') {
      // Workout-based comparison: find last run with same workout name
      var allRuns = Store.getRuns();
      var wkName = Engine.run.routeName;
      for (var wi = 0; wi < allRuns.length; wi++) {
        if (allRuns[wi].routeName === wkName && allRuns[wi].splits && allRuns[wi].splits.length > 0) {
          MilestoneTracker._lastRunSplits = allRuns[wi].splits;
          break;
        }
      }
    } else {
      MilestoneTracker._lastRunSplits = null;
    }
    this._updateRunButton();
    this._updateFloatingControls();
    this._buildQSPanels();
    if (VoiceCmd.config.enabled) VoiceCmd.startListening();
    // If no route loaded, switch to oval track (map dot needs a route to follow)
    if (!Engine.hasRoute() && /^(terrain|sat|dark|track|street)$/.test(this._mapStyle || 'terrain')) {
      this.setMapStyle('oval');
    }
    this._updateStateBanner();
    // Weekly summary on first run of the week
    this._announceWeeklySummary();
  },

  freeRun() {
    // ui-v4: go to the live screen in READY state. Belt is NOT started here.
    this._armedWorkout = null;
    Engine.clearRoute();
    MapView.clearRoute();
    if (window.StravaRoutes) StravaRoutes.onRouteLoaded(null);
    Engine.newRun();
    this.setControlMode('manual');
    var wc = document.getElementById('workoutChip'); if (wc) wc.textContent = '';
    const rname = document.getElementById('routeName');
    if (rname) rname.textContent = 'FREE RUN';
    // Connect only — no workout start until the big green START
    this._autoConnectBridge(false);
    MilestoneTracker.reset();
    UI.update();
    this._showLive();
    // Oval track for free run (no map route to show)
    this.setMapStyle('oval');
    // Open the speed presets so Soph can pick a pace before pressing START
    this._buildQSPanels();
    setTimeout(() => { var q = document.getElementById('qsSpeed'); if (q && !q.classList.contains('open')) this.toggleQS('speed'); }, 400);
  },

  /** Announce weekly summary on first run of the week */
  _announceWeeklySummary() {
    if (typeof VoiceCoach === 'undefined' || !VoiceCoach.config.enabled) return;
    try {
      var now = new Date();
      var day = now.getDay();
      var mondayOffset = day === 0 ? -6 : 1 - day;
      var thisMonday = new Date(now);
      thisMonday.setDate(now.getDate() + mondayOffset);
      thisMonday.setHours(0, 0, 0, 0);
      var thisWeekKey = thisMonday.toISOString().slice(0, 10);

      // Check if we've already announced this week
      var announced = localStorage.getItem('tr_weekly_announced');
      if (announced === thisWeekKey) return;

      // Get last week's stats
      var lastMonday = new Date(thisMonday);
      lastMonday.setDate(lastMonday.getDate() - 7);
      var lastMondayKey = lastMonday.toISOString().slice(0, 10);

      var runs = Store.getRuns();
      var lastWeekRuns = [];
      var twoWeeksAgoRuns = [];
      var twoWeeksAgoMonday = new Date(lastMonday);
      twoWeeksAgoMonday.setDate(twoWeeksAgoMonday.getDate() - 7);

      runs.forEach(function(r) {
        var d = new Date(r.savedAt || r.date);
        if (d >= lastMonday && d < thisMonday) lastWeekRuns.push(r);
        else if (d >= twoWeeksAgoMonday && d < lastMonday) twoWeeksAgoRuns.push(r);
      });

      if (lastWeekRuns.length === 0) {
        localStorage.setItem('tr_weekly_announced', thisWeekKey);
        return;
      }

      var totalDist = 0;
      var totalTime = 0;
      lastWeekRuns.forEach(function(r) {
        totalDist += (r.distanceKm || 0);
        totalTime += (r.elapsed || r.elapsedSec || 0);
      });

      var text = 'Weekly recap. Last week you ran ' + lastWeekRuns.length +
        (lastWeekRuns.length === 1 ? ' time' : ' times') +
        ' covering ' + totalDist.toFixed(1) + ' kilometres.';

      if (twoWeeksAgoRuns.length > 0) {
        var prevDist = 0;
        twoWeeksAgoRuns.forEach(function(r) { prevDist += (r.distanceKm || 0); });
        if (totalDist > prevDist) {
          text += ' That\'s ' + (totalDist - prevDist).toFixed(1) + ' K more than the week before. Nice progress!';
        } else if (totalDist < prevDist) {
          text += ' ' + (prevDist - totalDist).toFixed(1) + ' K less than the week before. Let\'s get after it!';
        } else {
          text += ' Same distance as the week before. Consistent!';
        }
      }

      // Announce after 3 seconds (let the run settle)
      setTimeout(function() {
        VoiceCoach.say(text, 'low');
      }, 3000);

      localStorage.setItem('tr_weekly_announced', thisWeekKey);
    } catch(e) {
      // Silently fail — not critical
    }
  },

  /** Auto-connect to bridge. Only starts a workout if startWorkout=true
   *  (i.e. user explicitly started a run). On page load we connect but
   *  do NOT start the workout — prevents belt spinning on boot. */
  _autoConnectBridge(startWorkout) {
    if (TM.connected) {
      // Already connected — just start workout if requested and needed
      if (startWorkout && TM.workoutState === 'IDLE') {
        console.log('[App] Starting workout (already connected)');
        TM.startWorkout();
      }
      return;
    }
    // Store the flag — onConnect handler checks it (no closure chain buildup)
    this._pendingStartWorkout = startWorkout;
    // Set onConnect only once (to the base handler + start-workout check)
    if (!this._connectHandlerSet) {
      this._connectHandlerSet = true;
      var baseOnConnect = TM.onConnect;
      var self = this;
      TM.onConnect = function(port) {
        if (baseOnConnect) baseOnConnect(port);
        if (self._pendingStartWorkout && TM.workoutState === 'IDLE') {
          console.log('[App] Auto-starting workout on bridge');
          TM.startWorkout();
        }
        self._pendingStartWorkout = false;
      };
    }
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
      var pm = document.getElementById('pauseMsg');
      if (pm) pm.textContent = 'Belt stopping · timer paused · route holding position';
      document.getElementById('pauseOverlay').classList.add('show');
    } else if (Engine.run.status === 'paused') {
      if (TM._estopActive) TM.clearEstop(); // explicit user resume after an e-stop
      Engine.resumeRun();
      document.getElementById('pauseOverlay').classList.remove('show');
    }
    this._updateRunButton();
    this._updateFloatingControls();
    this._updateStateBanner();
  },

  /** Safety key out while running: the belt is already stopped by the console → pause the run (no commands),
   *  show the pause overlay; the user puts the key back and taps RESUME (→ new treadmill workout, target re-sent). */
  pauseForSafetyKey() {
    if (!Engine.run || Engine.run.status !== 'running') return;
    Engine.pauseRun(true);
    var jokeEl = document.getElementById('pauseJoke'); if (jokeEl) jokeEl.textContent = 'Safety key out';
    var pm = document.getElementById('pauseMsg'); if (pm) pm.textContent = 'The console stopped the belt. Put the key back, then tap RESUME — the belt ramps back up gently.';
    var po = document.getElementById('pauseOverlay'); if (po) po.classList.add('show');
    this._updateRunButton(); this._updateFloatingControls(); this._updateStateBanner();
  },

  /** STOP button rule: zero the belt at once (never rate-limited), cancel any ramp, then show the summary. */
  stopNow() {
    if (!Engine.run || Engine.run.status === 'ready') { TM.setSpeed(0, true); return; }
    this.finishRun(true);
  },

  finishRun(immediate) {
    if (!Engine.run || Engine.run.status === 'finished' || Engine.run.status === 'ready') return;
    document.getElementById('pauseOverlay').classList.remove('show');
    Engine.finishRun(!!immediate);
    UI.showRunComplete();
    this._updateRunButton();
    this._updateFloatingControls();
    this._updateStateBanner();
    VoiceCmd.stopListening();
    if (WorkoutSegments.active) WorkoutSegments.abort();
    // Announce effort score and PB after a brief pause
    var effortScore = Engine.getEffortScore();
    if (effortScore > 0) {
      setTimeout(function() { VoiceCoach.announceEffortScore(effortScore); }, 3000);
    }
    // Announce power summary
    var avgPower = Engine.getAvgPower();
    if (avgPower > 0) {
      setTimeout(function() {
        VoiceCoach.say('Average power: ' + avgPower + ' watts.', 'low');
      }, 4000);
    }
    // Announce negative splits
    if (Engine.run && Engine.run.splits) {
      var negCount = Engine.run.splits.filter(function(s) { return s.negativeSplit; }).length;
      if (negCount >= 2) {
        setTimeout(function() {
          VoiceCoach.say(negCount + ' negative splits. Excellent pacing!', 'low');
        }, 6000);
      }
    }
    // Announce cardiac drift summary if tracked
    if (Engine.run && Engine.run._driftBaselineLocked) {
      var drift = Engine.getDriftPct();
      if (drift >= 3) {
        setTimeout(function() {
          var label = Engine.getDriftLabel(drift);
          VoiceCoach.say('Cardiac drift was ' + Math.round(drift) + ' percent. ' + label + '.', 'low');
        }, 8000);
      }
    }
    // Check for personal best
    var route = Engine.route;
    if (route && route.bestTime && Engine.run && Engine.run.elapsed <= route.bestTime) {
      setTimeout(function() {
        if (typeof VoiceCoach !== 'undefined') {
          VoiceCoach.say('Personal best! Great run!', 'high');
        }
      }, 5000);
    }
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
        maxSpeed: saved.maxSpeed || 0,
        calories: saved.calories || 0,
        ghostDelta: Engine.ghostEnabled && Engine.ghost ? (Engine.ghost.elapsed - saved.elapsed) : 0,
        avgPower: saved.avgPower || 0,
        negativeSplits: saved.negativeSplits || 0,
        cardiacDrift: saved.cardiacDrift,
        efficiencyFactor: saved.efficiencyFactor,
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
    this.goHome();
    if (saved) {
      console.log('[App] Run saved:', saved.id);
      // Strava: ASK first (SAVE TO STRAVA / SKIP). Nothing is uploaded unless she taps SAVE.
      // (Replaces the old Sync.autoSync(saved) automatic upload.)
      if (window.StravaUpload) StravaUpload.onRunSaved(saved).then(() => { this._updateSyncPill(); }).catch(() => {});
      // Webhook + bridge notification (fire and forget)
      Sync.notifyWebhook(saved).catch(() => {});
      Sync.notifyBridge(saved).catch(() => {});
    }
  },

  discardRun() {
    UI.hideRunComplete();
    Engine.discardRun();
    Engine.newRun();
    UI.update();
    this._updateRunButton();
    this._updateFloatingControls();
    this.goHome();
  },

  exportGPX() {
    if (!Engine.run) return;
    const xml = GPX.exportGPX({
      name: (Engine.run.routeName || 'Free Run') + ' — ' + new Date().toLocaleDateString(),
      startedAt: Engine.run.startedAt,
      trackPoints: Engine.run.trackPoints,
    });
    this._downloadFile(xml, 'trailrunner-' + Date.now() + '.gpx', 'application/gpx+xml');
  },

  exportTCX() {
    if (!Engine.run) return;
    const xml = GPX.exportTCX({
      name: Engine.run.routeName || 'Free Run',
      startedAt: Engine.run.startedAt,
      elapsed: Engine.run.elapsed,
      distanceM: Engine.run.distanceM,
      calories: Engine.run.calories,
      avgHR: Engine.getAvgHR(),
      trackPoints: Engine.run.trackPoints,
    });
    this._downloadFile(xml, 'trailrunner-' + Date.now() + '.tcx', 'application/vnd.garmin.tcx+xml');
  },

  shareRunSummary(btn) {
    if (!Engine.run) return;
    var r = Engine.run;
    var lines = [];
    lines.push((r.routeName || 'Free Run') + ' — TrailRunner');
    lines.push('Time: ' + Engine.fmtTime(r.elapsed));
    lines.push('Distance: ' + (r.distanceM / 1000).toFixed(2) + ' km');
    var avgSpd = r._speedSamples > 0 ? (r._speedSum / r._speedSamples).toFixed(1) : '0';
    lines.push('Avg Speed: ' + avgSpd + ' kph');
    var avgHR = Engine.getAvgHR();
    if (avgHR > 0) lines.push('Avg HR: ' + avgHR + ' bpm');
    lines.push('Calories: ' + Math.round(r.calories));
    if (r.elevGained > 0) lines.push('Elevation: +' + Math.round(r.elevGained) + 'm');
    var effort = Math.round(r._trimp || 0);
    if (effort > 0) lines.push('Effort: ' + effort + ' (' + Engine.getEffortLabel(effort) + ')');
    var text = lines.join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        if (btn) { var orig = btn.textContent; btn.textContent = 'COPIED!'; setTimeout(function() { btn.textContent = orig; }, 1500); }
      }).catch(function() {
        // Fallback for clipboard failures
        UI.prompt('Copy your run summary:', text);
      });
    } else {
      UI.prompt('Copy your run summary:', text);
    }
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
    if (!navigator.bluetooth) {
      // audit P1-d: this console has no Web Bluetooth; HR comes from the treadmill's own sensor link
      UI.info('Pair your heart-rate strap in iFIT (Workout settings > Devices); TrailRunner reads it from the treadmill.', 'var(--card2)');
      return;
    }
    BLEHR.connect();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // EMERGENCY STOP
  // ════════════════════════════════════════════════════════════════════════════

  emergencyStop() {
    // SAFETY: Cancel ANY in-progress ramp FIRST — prevents it from fighting the stop
    if (Engine._decelTimer) { clearInterval(Engine._decelTimer); Engine._decelTimer = null; }
    // Fire the emergency stop (sets _estopActive flag, blocks further motor commands)
    TM.emergencyStop();
    if (Engine.run && Engine.run.status === 'running') {
      Engine.pauseRun();
      var pm = document.getElementById('pauseMsg');
      if (pm) pm.textContent = 'EMERGENCY STOP — belt zeroed. Resume only when you are ready.';
      document.getElementById('pauseOverlay').classList.add('show');
    }
    this._updateFloatingControls();
    this._updateStateBanner();
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
        UI.info('Failed to parse GPX file: ' + err.message, 'var(--red)');
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
    this._updateHomeRoute();
    this._updateElevStrip();
    this._applyRouteVisibility();
  },

  _loadRouteData(route) {
    Engine.loadRoute(route);
    MapView.loadRoute(Engine.latlngs);
    // Strava: racer pool for ANY route, grade-coloured line for Strava routes (never mid-run re-bake)
    if (window.StravaRoutes) { var _sp = StravaRoutes.onRouteLoaded(route); if (_sp && _sp.then) _sp.then(null, function () {}); }
    this._updateElevStrip();
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
      if (window.StravaRoutes) StravaRoutes.onRouteLoaded(null);
      const msg = document.getElementById('noRouteMsg');
      if (msg) msg.style.display = '';
    }
    UI.renderRouteList();
    this._updateHomeRoute();
    this._updateElevStrip();
    this._applyRouteVisibility();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GHOST RACING
  // ════════════════════════════════════════════════════════════════════════════

  openHistory() { UI.openHistoryPanel(); },
  closeHistory() { UI.closeHistoryPanel(); },

  // ── RUN AGAIN / X% HARDER (js/run-again.js): armed only, START is still the user's tap ──
  runAgainFromSummary() {
    if (typeof RunAgain === 'undefined' || !Engine.run) return;
    var r = Engine.run;
    var src = RunAgain.fromRun({ id: null, routeName: r.routeName, routeId: r.routeId, elapsed: r.elapsed, distanceM: r.distanceM, trackPoints: r.trackPoints });
    var self = this;
    RunAgain.open(src, { onArm: function (w) { if (Engine.run && Engine.run.status === 'finished') self.saveAndNewRun(); self.armWorkout(w); } });
  },
  runAgainSaved(runId) {
    if (typeof RunAgain === 'undefined') return;
    var run = Store.getRuns().find(function (r) { return r.id === runId; });
    if (!run) { this._toast('Run not found', 'var(--red)'); return; }
    UI.closeHistoryPanel();
    var self = this;
    RunAgain.open(RunAgain.fromRun(run), { onArm: function (w) { self.armWorkout(w); } });
  },
  _checkRunAgainPending() {
    if (typeof RunAgain === 'undefined') return;
    var id = RunAgain.takePending();
    if (id) setTimeout(() => this.runAgainSaved(id), 300);
  },

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
    var chip = document.getElementById('modeChip');
    var names = { route: 'ROUTE INCLINE', manual: 'MANUAL', 'hr-incline': 'HR → INCLINE', 'hr-speed': 'HR → SPEED' };
    if (chip) chip.textContent = names[mode] || mode.toUpperCase();
  },

  setTargetZone(z) {
    Engine.ctrl.targetZone = Math.max(1, Math.min(5, z));
  },

  adjustSpeed(delta) {
    Engine.ctrl.targetSpeed = Math.max(0, Math.min(TM.maxKph ? TM.maxKph() : 19.3, +(Engine.ctrl.targetSpeed + delta).toFixed(1)));
    if (TM.connected) {
      TM.setSpeed(Engine.ctrl.targetSpeed, false, 'button');
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

    // ui-v4: route-only views are not available without a route
    if (!Engine.hasRoute() && /^(terrain|sat|dark|track|street)$/.test(style)) style = 'oval';
    this._mapStyle = style;

    // Hide all panels first
    TrackView.hide();
    OvalTrack.hide();
    if (typeof TrailCam !== 'undefined') TrailCam.hide();
    mapDiv.style.display = 'none';
    if (mediaPanel) mediaPanel.style.display = 'none';
    if (streetPanel) streetPanel.style.display = 'none';
    var bigNum = document.getElementById('bigNumbersPanel');
    if (bigNum) bigNum.classList.toggle('show', style === 'numbers');
    var zone = document.querySelector('.map-zone');
    if (zone) zone.classList.toggle('mapview', /^(terrain|sat|dark)$/.test(style));
    if (typeof VideoView !== 'undefined' && VideoView.active && style !== 'video') VideoView.hide();

    if (style === 'numbers') {
      this._updateBigNumbers();
    } else if (style === 'video') {
      // Split VIDEO view (replaces Trail Cam): YouTube left, live tiles right. Pure display — never touches the belt.
      if (typeof VideoView !== 'undefined') VideoView.show();
    } else if (style === 'trailcam') {
      // Trail Cam has no entry point any more (replaced by the VIDEO view); kept callable for old links
      if (typeof TrailCam !== 'undefined') TrailCam.show();
    } else if (style === 'track') {
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
      if (Engine.hasRoute() && Engine.run && Engine.run.status === 'ready') MapView.fitRoute();
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

  /** ui-v4: remove (not grey out) every route-only control while no route is loaded. */
  _applyRouteVisibility() {
    var root = document.getElementById('rootApp');
    var has = Engine.hasRoute();
    if (root) root.classList.toggle('routeless', !has);
    if (!has) {
      if (Engine.ctrl.mode === 'route') this.setControlMode('manual');
      if (/^(terrain|sat|dark|track|street)$/.test(this._mapStyle || 'terrain')) this.setMapStyle('oval');
      if (UI.splitsOpen) UI.toggleSplits();
    }
  },

  /** ui-v4: 'Big numbers' view — four 150px values, no route needed. */
  _updateBigNumbers() {
    var panel = document.getElementById('bigNumbersPanel');
    if (!panel || !panel.classList.contains('show') || !Engine.run) return;
    var r = Engine.run;
    var set = function(id, v) { var e = document.getElementById(id); if (e && e.textContent !== v) e.textContent = v; };
    set('bnSpeed', UI.convSpeed(r.speed || 0));
    set('bnSpeedUnit', UI.speedLabel());
    set('bnTime', Engine.fmtTime(r.elapsed || 0));
    set('bnDist', UI.convDist((r.distanceM || 0) / 1000));
    set('bnDistUnit', UI.distLabel());
    set('bnHR', r.hr > 0 ? String(r.hr) : '—');
    var z = Engine.getCurrentZone();
    set('bnHRZone', r.hr > 0 && z > 0 ? ('bpm · Z' + z + ' ' + Engine.HR_ZONES[z - 1].label) : 'bpm');
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
    // ui-v4 round 4: goes through StravaApi (scope read,read_all,activity:read_all,activity:write; state checked by the callback page).
    // Save app credentials first (same localStorage keys the old Sync code used, so nothing is lost)
    var _ci1 = document.getElementById('setStravaClientId');
    var _ci2 = document.getElementById('spStravaId');
    var _sc1 = document.getElementById('setStravaSecret');
    var _sc2 = document.getElementById('spStravaSecret');
    var _px = document.getElementById('spStravaProxy');
    const clientId = (_ci1 ? _ci1.value.trim() : '') || (_ci2 ? _ci2.value.trim() : '');
    const secret = (_sc1 ? _sc1.value.trim() : '') || (_sc2 ? _sc2.value.trim() : '');
    const old = StravaApi.app() || {};
    if (_px) StravaApi.setPrefs({ tokenProxyUrl: _px.value.trim() });
    if (clientId || secret) {
      Sync.stravaApp = { clientId: clientId || old.clientId || '', clientSecret: secret || old.clientSecret || '' };
    }
    if (StravaApi.isConnected()) {
      UI.ask('Disconnect from Strava? Strava routes and cached Strava data on this treadmill will be deleted.', 'DISCONNECT').then(function (y) { if (y) App.disconnectStrava(); });
    } else {
      var app = StravaApi.app();
      if (!app || !app.clientId) { UI.info('Enter your Strava Client ID in Settings first', 'var(--orange)'); return; }
      if (!StravaApi.prefs().tokenProxyUrl && !app.clientSecret && !StravaApi.isMock()) {
        UI.info('Enter the Strava Client Secret (or a token proxy URL) in Settings first', 'var(--orange)'); return;
      }
      StravaApi.connect();
    }
  },

  /** Disconnect: forget tokens + cached Strava data + routes derived from Strava (Strava API terms). */
  disconnectStrava() {
    var ids = window.StravaRoutes ? Object.keys(StravaRoutes.allMeta()) : [];
    var running = Engine.run && (Engine.run.status === 'running' || Engine.run.status === 'paused');
    StravaApi.disconnect();
    var kept = 0;
    ids.forEach((id) => {
      if (running && Engine.route && Engine.route.id === id) { kept++; return; }   // never pull the route from under a live run
      this.deleteRoute(id);
    });
    StravaApi.purgeData();
    if (window.StravaRacers) StravaRacers.clear();
    this._updateSyncPill();
    this._toast('Strava disconnected' + (kept ? ' (the route in use was kept until the run ends: delete it from Routes)' : ''), 'var(--orange)');
    if (typeof SettingsPanel !== 'undefined' && SettingsPanel._render && document.getElementById('spStravaStatus')) { try { SettingsPanel._render(); } catch (e) {} }
  },

  /** STRAVA button (Home / route modal): pick a recent run or saved route. goLive = then open the live screen (belt NOT started). */
  openStravaPicker(goLive) {
    if (!window.StravaPicker) return;
    StravaPicker.open({ thenRun: !!goLive });
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
          Engine.ctrl.targetSpeed = Math.max(0, Math.min(TM.maxKph ? TM.maxKph() : 19.3, args));
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
    // Hide the focus pill (we're already in focus mode)
    var fp = document.getElementById('pillFocus');
    if (fp) fp.style.display = 'none';
    // Update menu label
    var ml = document.getElementById('fmMetricsLabel');
    if (ml) ml.textContent = 'Show Metrics Panel';
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
    // Show focus pill if a run is active (so user can re-enter focus mode)
    var fp = document.getElementById('pillFocus');
    var runActive = Engine.run && (Engine.run.status === 'running' || Engine.run.status === 'paused');
    if (fp) fp.style.display = runActive ? '' : 'none';
    // Update menu label
    var ml = document.getElementById('fmMetricsLabel');
    if (ml) ml.textContent = 'Hide Metrics Panel';
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
    var speedUnit = s.speedButtonUnit || 'kph';
    var speeds = s.customSpeeds || (speedUnit === 'mph' ? [3, 4, 5, 6, 7, 8] : [5, 6, 8, 9, 10, 12]);
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
    var unit = s.speedButtonUnit || 'kph';
    // Convert to kph for the engine
    var kph = val;
    if (unit === 'mph') kph = val * 1.60934;
    else if (unit === 'min/mi') kph = val > 0 ? (60 / val) * 1.60934 : 0;
    else if (unit === 'min/km') kph = val > 0 ? 60 / val : 0;
    var capQ = TM.maxKph ? TM.maxKph() : 19.3;
    if (kph > capQ) { this._toast('Preset ' + val + ' clipped to your maximum ' + capQ.toFixed(1) + ' km/h', 'var(--orange)'); kph = capQ; }
    kph = Math.max(0, Math.min(capQ, kph));
    Engine.ctrl.targetSpeed = kph;
    if (TM.connected) TM.setSpeed(kph, false, 'preset');
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
    var idx = units.indexOf(s.speedButtonUnit || 'kph');
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
    var noLink = !TM.connected;
    start.classList.toggle('nolink', noLink);
    start.textContent = noLink ? '⚠ NO LINK TO TREADMILL' : '▶ START';
    pause.style.display = (status === 'running' && !isCooling) ? '' : 'none';
    resume.style.display = status === 'paused' ? '' : 'none';
    if (cooldown) cooldown.style.display = (status === 'running' && !isCooling) ? '' : 'none';
    stop.style.display = (status === 'running' || status === 'paused') ? '' : 'none';

    this._updateNudgeDisplays();
    this._updateStateBanner();
  },

  /**
   * Height (CSS px) of the bottom strip the ROM paints over our window.
   *   ?safeBottom=N  (0..200) overrides and is remembered for the session (?safeBottom=0 disables)
   *   ?rom=1         alias for 80
   *   otherwise 80 when the UA is the X32i's in-app WebView (Android 7.1.2 + "; wv)"), else 0.
   */
  safeBottom() {
    if (this._safeBottom != null) return this._safeBottom;
    var v = null;
    try {
      var m = /[?&]safeBottom=(\d+)/.exec(window.location.search);
      if (m) v = Math.max(0, Math.min(200, parseInt(m[1], 10)));
      else if (/[?&]rom=1\b/.test(window.location.search)) v = 80;
      if (v != null) sessionStorage.setItem('tr_safe_bottom', String(v));
      else if (sessionStorage.getItem('tr_safe_bottom') != null) v = parseInt(sessionStorage.getItem('tr_safe_bottom'), 10);
    } catch (e) {}
    if (v == null || isNaN(v)) {
      var ua = navigator.userAgent || '';
      v = (/Android 7\.1\.2/.test(ua) && /; wv\)/.test(ua)) ? 80 : 0;
    }
    this._safeBottom = v;
    return v;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // VIDEO SPLIT (native chooser4 contract) — half / full / off — and the live ribbon / strip
  // ════════════════════════════════════════════════════════════════════════════
  STRIP_PX: 56,
  _splitMode: 'off',
  _splitPrev: 'off',

  /** Native split available? (chooser4 AndroidBridge or the ?splitSim=1 stub) */
  videoSplitSupported() {
    try { return !!(window.AndroidBridge && typeof AndroidBridge.videoSplitSupported === 'function' && AndroidBridge.videoSplitSupported()); } catch (e) { return false; }
  },
  _normMode(m) { return m === true ? 'half' : (m === false || m == null || m === '') ? 'off' : String(m); },

  /** Ask the wrapper for a mode ('half' | 'full' | 'off'); the fallback embed view handles it in-page. */
  setVideoMode(mode, url) {
    mode = this._normMode(mode);
    if (this.videoSplitSupported()) {
      try {
        if (mode === 'full' && typeof AndroidBridge.setStatsStripHeight === 'function') AndroidBridge.setStatsStripHeight(this.STRIP_PX);
        this._rememberVideoMode(mode);
        AndroidBridge.videoSplit(mode, url || '');
      } catch (e) { this._toast('Video split failed: ' + e.message, 'var(--red)'); }
      return;
    }
    // Fallback (PC / phone / old wrapper): in-page youtube-nocookie embed view
    if (mode === 'off') { if (typeof VideoView !== 'undefined') { VideoView.setFull(false); } if (this._mapStyle === 'video') this.setMapStyle(Engine.hasRoute() ? 'terrain' : 'oval'); this._applyEmbedMode('off'); }
    else { this.setMapStyle('video'); if (typeof VideoView !== 'undefined') VideoView.setFull(mode === 'full'); this._applyEmbedMode(mode); }
  },
  /** Owner simplification (22 Oct): on the treadmill (native split) VIDEO is ONE tap: no paste-link / favourites /
   *  playlist UI. videoSplit(mode, '') with an EMPTY url → the wrapper reopens the LAST YouTube page (or
   *  m.youtube.com home) and Soph navigates inside YouTube itself. The mode is remembered (tr_video_mode: 'half'
   *  first time; FULL / RESTORE switch it). VIDEO again (or CLOSE VIDEO) closes it. The paste-link UI stays only in
   *  the PC / fallback embed view. */
  VIDEO_MODE_KEY: 'tr_video_mode',
  lastVideoMode() { try { return localStorage.getItem(this.VIDEO_MODE_KEY) === 'full' ? 'full' : 'half'; } catch (e) { return 'half'; } },
  _rememberVideoMode(m) { if (m === 'half' || m === 'full') { try { localStorage.setItem(this.VIDEO_MODE_KEY, m); } catch (e) {} } },
  openVideo() {
    if (this.videoSplitSupported()) {
      if (this._splitMode !== 'off') { this.closeVideo(); return; }   // VIDEO while open = close
      this.setVideoMode(this.lastVideoMode(), '');
      return;
    }
    this.setVideoMode('half', '');
  },
  closeVideo() { this.setVideoMode('off', ''); },
  restoreVideo() { this.setVideoMode('half', ''); },   // out of 'full' back to the split
  openNativeVideo(url) { this.setVideoMode(this.lastVideoMode(), url || ''); },
  _applyEmbedMode(mode) { this._embedMode = mode; var r = document.getElementById('rootApp'); if (r) r.classList.toggle('embed-full', mode === 'full'); this._updateRibbon(true); },

  /** native → JS: the wrapper resized us. Never reloads, never touches the belt. */
  _onVideoSplit(mode) {
    mode = this._normMode(mode);
    if (mode !== this._splitMode) this._splitPrev = this._splitMode;
    this._splitMode = mode;
    this._scaleViewport();
    this._updateRibbon(true);
    setTimeout(() => this._updateRibbon(true), 400);
    setTimeout(() => { try { MapView.invalidateSize(); } catch (e) {} try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 60);
  },

  /** ?splitSim=1 (or sessionStorage tr_split_sim): a stub AndroidBridge so the PC / tests can drive half / full / off. */
  _installSplitSim() {
    var on = false;
    try {
      if (/[?&]splitSim=1\b/.test(location.search)) { sessionStorage.setItem('tr_split_sim', '1'); on = true; }
      else if (/[?&]splitSim=0\b/.test(location.search)) sessionStorage.removeItem('tr_split_sim');
      else on = sessionStorage.getItem('tr_split_sim') === '1';
    } catch (e) {}
    if (!on || window.AndroidBridge) return;
    var self = this;
    window.AndroidBridge = {
      _sim: true, _mode: 'off', _url: '', _strip: 56, calls: [],
      videoSplitSupported: function () { return true; },
      isVideoSplit: function () { return this._mode; },
      setStatsStripHeight: function (px) { this._strip = px; this.calls.push('strip:' + px); },
      videoNavigate: function (url) { this._url = url; this.calls.push('nav:' + url); },
      videoSplit: function (mode, url) {
        mode = self._normMode(mode); this._mode = mode; this._url = url || ''; this.calls.push(mode);
        setTimeout(function () { if (window.TR_onVideoSplit) window.TR_onVideoSplit(mode); }, 0);
        return true;
      },
    };
    console.log('[App] splitSim: stub AndroidBridge installed');
  },

  /** Compact SPEED / DIST / TIME ribbon (+ STOP) that stays above every overlay; in 'full' it IS the thin strip. */
  _updateRibbon(force) {
    var rb = document.getElementById('liveRibbon');
    if (!rb) return;
    var r = Engine.run;
    var beltActive = TM.workoutState === 'RUNNING' || TM.workoutState === 'PAUSED';
    var runActive = !!(r && (r.status === 'running' || r.status === 'paused')) || (!!r && r.status === 'finished' && beltActive);
    var stripMode = this._splitMode === 'full' || this._embedMode === 'full';
    var show = false;
    if (stripMode) show = true;
    else if (runActive) {
      // covered or hidden metric strip? (menus / overlays / side panels / home)
      var t = document.getElementById('timerEl');
      var covered = true;
      if (t && t.offsetWidth) {
        var b = t.getBoundingClientRect();
        var hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        // the ribbon itself (or a toast) over the strip does not count as "covered" — it would never hide again
        covered = !(hit && (hit === t || t.contains(hit) || (hit.closest && (hit.closest('.metric-strip') || hit.closest('#liveRibbon') || hit.id === 'mediaToast'))));
      }
      show = covered;
    }
    var wasShown = rb.classList.contains('show');
    rb.classList.toggle('show', show);
    rb.classList.toggle('strip', stripMode);
    if (!show && !force) return;
    if (!r) return;
    var set = function (sel, v) { var els = document.querySelectorAll(sel); for (var i = 0; i < els.length; i++) if (els[i].textContent !== v) els[i].textContent = v; };
    var cls = function (sel, c, on) { var els = document.querySelectorAll(sel); for (var i = 0; i < els.length; i++) els[i].classList.toggle(c, !!on); };
    set('[data-rb=speed]', UI.convSpeed(r.speed || 0) + ' ' + UI.speedLabel());
    var inc = (r.currentGrade != null && Engine.hasRoute()) ? r.currentGrade : (r.incline || 0);
    set('[data-rb=inc]', (inc >= 0 ? '+' : '') + inc.toFixed(1) + '%');
    var rem = Engine.remaining ? Engine.remaining() : { distM: null, timeSec: null };
    var dist = UI.convDist((r.distanceM || 0) / 1000);
    set('[data-rb=dist]', rem.distM != null ? dist + ' / ' + UI.convDist(((r.distanceM || 0) + rem.distM) / 1000) + ' ' + UI.distLabel() : dist + ' ' + UI.distLabel());
    set('[data-rb=time]', Engine.fmtTime(r.elapsed || 0) + (rem.timeSec != null ? ' / ' + Engine.fmtTime((r.elapsed || 0) + rem.timeSec) : ''));
    var nx = Engine.nextChange ? Engine.nextChange() : null, nxt = 'NEXT --', up = null;
    if (nx) {
      var when = nx.inSec != null ? Engine.fmtTime(Math.max(0, nx.inSec)) : (nx.inM != null ? Math.round(nx.inM) + ' m' : '--');
      var what = '';
      if (nx.kind === 'end') what = 'finish';
      else {
        if (nx.speed != null) { var ds = nx.speed - (r.speed || 0); what += (ds > 0.2 ? '▲' : ds < -0.2 ? '▼' : '') + nx.speed.toFixed(1) + ' km/h '; up = ds > 0.2 ? true : ds < -0.2 ? false : up; }
        if (nx.incline != null) { var di = nx.incline - inc; what += (di > 0.2 ? '▲' : di < -0.2 ? '▼' : '') + nx.incline + '%'; if (up == null) up = di > 0.2 ? true : di < -0.2 ? false : null; }
      }
      nxt = 'NEXT ' + when + '  ' + what.trim();
    }
    set('[data-rb=next]', nxt);
    cls('[data-rb=next]', 'up', up === true); cls('[data-rb=next]', 'down', up === false);
    var z = Engine.getCurrentZone();
    var hrEls = document.querySelectorAll('[data-rb=hr]');
    for (var h = 0; h < hrEls.length; h++) { hrEls[h].textContent = r.hr > 0 ? '♥ ' + r.hr + (z > 0 ? ' Z' + z : '') : (r._hrLostAt ? '♥ LOST' : '♥ --'); hrEls[h].style.color = r.hr > 0 && z > 0 ? Engine.HR_ZONES[z - 1].color : 'var(--dim)'; }
    // state pill
    var sb = document.getElementById('stateBanner'), st = document.getElementById('stateBannerText');
    var stCls = sb ? (sb.className.replace('state-banner', '').trim() || 'offline') : 'offline';
    var stTxt = st ? st.textContent : '';
    if (!TM.connected && !TM._safetyKeyWarning) stTxt = 'NO LINK';
    set('[data-rb=state]', stTxt);
    var pills = document.querySelectorAll('[data-rb=state]');
    for (var p = 0; p < pills.length; p++) pills[p].className = 'rb-state ' + stCls + (pills[p].getAttribute('data-strip-only') ? ' strip-only' : '');
    var alarm = TM._safetyKeyWarning || (!TM.connected && runActive);
    rb.classList.toggle('alarm', !!alarm);
    var vs = document.getElementById('vvStrip'); if (vs) vs.classList.toggle('alarm', !!alarm);
    if (show && !wasShown) rb.scrollTop = 0;
  },

  _scaleViewport() {
    const root = document.getElementById('rootApp');
    if (!root) return;
    // Design width is 1920; design HEIGHT follows the real window. The X32i's in-app WebView is
    // 1920x1000 CSS px (the ROM's 80px nav bar sits below the window), the PC is 1920x1080.
    // scale = fit-to-width, limited so at least DESIGN_MIN_H design px fit vertically; the root then
    // gets the height that exactly fills the window (1000 on the treadmill, 1080 on the PC), capped
    // at DESIGN_MAX_H so a tall/portrait window (phone) letterboxes instead of stretching the layout.
    // On the real X32i the ROM's 80px nav bar (Quick start / Workout settings / expand) is DRAWN OVER
    // the bottom of our window instead of shrinking it (innerHeight stays 1080), so a bottom safe strip
    // is reserved: usable height = innerHeight - safeBottom. See App.safeBottom() for the detection.
    // Video split (chooser4): 'half' → our WebView is the RIGHT 50% (design width 960); 'full' → a thin strip
    // across the top (design 1920 x STRIP_PX, no bottom ROM strip inside it). Explicit mode from TR_onVideoSplit
    // wins; otherwise the window geometry decides (innerHeight <= 160 → full, innerWidth <= 1000 → half).
    var mode = this._splitMode && this._splitMode !== 'off' ? this._splitMode
      : (window.innerHeight <= 160 ? 'full' : (window.innerWidth <= 1000 && window.innerWidth < window.innerHeight * 1.2) ? 'half' : 'off');
    root.classList.toggle('half', mode === 'half');
    root.classList.toggle('strip', mode === 'full');
    const DESIGN_W = mode === 'half' ? 960 : 1920, DESIGN_MIN_H = 1000, DESIGN_MAX_H = 1080;
    if (root.style.width !== DESIGN_W + 'px') root.style.width = DESIGN_W + 'px';
    const safe = mode === 'full' ? 0 : this.safeBottom();
    const usableH = Math.max(mode === 'full' ? 40 : 300, window.innerHeight - safe);
    let scale, rootH;
    if (mode === 'full') {
      scale = window.innerWidth / DESIGN_W;
      rootH = Math.round(Math.max(40, Math.min(120, usableH / scale)));
    } else {
      scale = Math.min(window.innerWidth / DESIGN_W, usableH / DESIGN_MIN_H);
      rootH = Math.round(Math.max(DESIGN_MIN_H, Math.min(DESIGN_MAX_H, usableH / scale)));
    }
    document.documentElement.style.setProperty('--rom-bottom', safe + 'px');
    document.body.style.background = 'var(--bg)'; // the strip under the root shows the same dark background
    if (root.style.height !== rootH + 'px') {
      root.style.height = rootH + 'px';
      // let canvases / Leaflet / the video window re-measure after the height change
      setTimeout(function() {
        try { if (typeof MapView !== 'undefined') MapView.invalidateSize(); } catch (e) {}
        try { if (typeof VideoWin !== 'undefined' && VideoWin.el && VideoWin._pos) { VideoWin._clamp(); VideoWin._apply(); } } catch (e) {}
      }, 50);
    }
    this._rootH = rootH;
    this._scale = scale; // used by VideoWin to convert touch deltas into root px
    // Use CSS zoom instead of transform: scale() — Android 7 WebView has
    // broken touch coordinates with CSS transforms (taps miss their targets)
    if ('zoom' in root.style || navigator.userAgent.indexOf('Android') !== -1) {
      root.style.transform = 'none';
      root.style.zoom = scale;
    } else {
      root.style.transform = 'scale(' + scale + ')';
    }
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
    if (finishOverlay && finishOverlay.classList.contains('show')) { return; } // never discard a run by accident
    if (UI.splitsOpen) { UI.toggleSplits(); return; }
    const historyPanel = document.getElementById('historyPanel');
    if (historyPanel && historyPanel.classList.contains('open')) { UI.closeHistoryPanel(); return; }
    if (Engine.run && Engine.run.status === 'ready') { this.goHome(); return; }
  },

  _downloadFile(content, filename, mimeType) {
    // Android wrapper (chooser3+): AndroidBridge.saveFile(filename, mime, base64) → Download/TrailRunner (audit P1-b)
    if (window.AndroidBridge && typeof AndroidBridge.saveFile === 'function') {
      try {
        var b64 = btoa(unescape(encodeURIComponent(String(content))));
        var r = AndroidBridge.saveFile(filename, mimeType, b64);
        if (typeof r === 'string' && r.indexOf('ERROR:') !== 0) { this._toast('Saved: ' + r, 'var(--green)'); return; }
      } catch (e) { /* fall through to the browser path */ }
    }
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
