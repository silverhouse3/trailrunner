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
      if (Engine.hasRoute()) {
        MapView.updateRunner(Engine.getCurrentLatLon());
        MapView.updateGhost(Engine.getGhostLatLon(), Engine.ghostEnabled);
      }
    };

    Engine.onSplit = (km, timeSec, pace, hr) => {
      UI.showSplitToast(km, timeSec, pace, hr);
      if (UI.splitsOpen) UI.renderSplits();
    };

    Engine.onRunComplete = () => {
      UI.showRunComplete();
    };

    // ── Init map ─────────────────────────────────────────────────────────
    MapView.init('mapDiv');

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

    console.log('[TrailRunner] Initialised');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RUN LIFECYCLE
  // ════════════════════════════════════════════════════════════════════════════

  startRun() {
    document.getElementById('setupOverlay').style.display = 'none';
    Engine.startRun();
    this._updateRunButton();
  },

  togglePause() {
    if (!Engine.run) return;
    if (Engine.run.status === 'running') {
      Engine.pauseRun();
      document.getElementById('pauseOverlay').classList.add('show');
    } else if (Engine.run.status === 'paused') {
      Engine.resumeRun();
      document.getElementById('pauseOverlay').classList.remove('show');
    }
    this._updateRunButton();
  },

  finishRun() {
    Engine.finishRun();
    UI.showRunComplete();
    this._updateRunButton();
  },

  saveAndNewRun() {
    const saved = Engine.saveRun();
    UI.hideRunComplete();
    Engine.discardRun();
    Engine.newRun();
    UI.update();
    this._updateRunButton();
    if (saved) console.log('[App] Run saved:', saved.id);
  },

  discardRun() {
    UI.hideRunComplete();
    Engine.discardRun();
    Engine.newRun();
    UI.update();
    this._updateRunButton();
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
    Engine.ctrl.targetSpeed = Math.max(3, Math.min(20, Engine.ctrl.targetSpeed + delta));
    TM.setSpeed(Engine.ctrl.targetSpeed);
  },

  adjustIncline(delta) {
    Engine.ctrl.targetIncline = Math.max(-6, Math.min(15, Engine.ctrl.targetIncline + delta));
    TM.setIncline(Engine.ctrl.targetIncline);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // MAP CONTROLS
  // ════════════════════════════════════════════════════════════════════════════

  setMapStyle(style) {
    MapView.setStyle(style);
    document.querySelectorAll('.map-mode-btn').forEach(btn => {
      btn.classList.toggle('act', btn.dataset.style === style);
    });
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
  // SETTINGS
  // ════════════════════════════════════════════════════════════════════════════

  openSettings() { UI.openSettings(); },
  closeSettings() { UI.closeSettings(); },
  saveSettings() { UI.saveSettings(); },

  // ════════════════════════════════════════════════════════════════════════════
  // SPLITS
  // ════════════════════════════════════════════════════════════════════════════

  toggleSplits() { UI.toggleSplits(); },

  // ════════════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ════════════════════════════════════════════════════════════════════════════

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
    const routeModal = document.getElementById('routeModal');
    if (routeModal && routeModal.classList.contains('show')) { UI.closeRouteModal(); return; }
    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal && settingsModal.classList.contains('show')) { UI.closeSettings(); return; }
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
