// ════════════════════════════════════════════════════════════════════════════
// UI — DOM updates, panels, modals, unit formatting, elevation canvas
// ════════════════════════════════════════════════════════════════════════════

function _esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const UI = {

  // ── Unit state ─────────────────────────────────────────────────────────────
  units: { speed: 'kmh', dist: 'km', elev: 'm' },

  // ── Panels ─────────────────────────────────────────────────────────────────
  splitsOpen: false,
  settingsOpen: false,

  // ════════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════════

  init() {
    const settings = Store.getSettings();
    this.units.speed = settings.speedUnit || 'kmh';
    this.units.dist = settings.distUnit || 'km';
    this.units.elev = settings.elevUnit || 'm';
  },

  // ════════════════════════════════════════════════════════════════════════════
  // UNIT CONVERSION
  // ════════════════════════════════════════════════════════════════════════════

  convSpeed(kmh) {
    if (kmh <= 0) return '0.0';
    if (this.units.speed === 'mph') return (kmh * 0.621371).toFixed(1);
    if (this.units.speed === 'minperkm') {
      const t = 60 / kmh;
      return Math.floor(t) + ':' + String(Math.round((t % 1) * 60)).padStart(2, '0');
    }
    if (this.units.speed === 'minpermi') {
      const t = 60 / (kmh * 0.621371);
      return Math.floor(t) + ':' + String(Math.round((t % 1) * 60)).padStart(2, '0');
    }
    return kmh.toFixed(1);
  },

  speedLabel() {
    const map = { kmh: 'km/h', mph: 'mph', minperkm: '/km', minpermi: '/mi' };
    return map[this.units.speed] || 'km/h';
  },

  convDist(km) {
    return this.units.dist === 'mi' ? (km * 0.621371).toFixed(2) : km.toFixed(2);
  },
  distLabel() { return this.units.dist === 'mi' ? 'mi' : 'km'; },

  convElev(m) { return this.units.elev === 'ft' ? Math.round(m * 3.28084) : Math.round(m); },
  elevLabel() { return this.units.elev; },

  cycleSpeed() {
    const order = ['kmh', 'mph', 'minperkm', 'minpermi'];
    this.units.speed = order[(order.indexOf(this.units.speed) + 1) % order.length];
    this._saveUnits();
  },
  cycleDist() {
    this.units.dist = this.units.dist === 'km' ? 'mi' : 'km';
    this._saveUnits();
  },
  cycleElev() {
    this.units.elev = this.units.elev === 'm' ? 'ft' : 'm';
    this._saveUnits();
  },
  _saveUnits() {
    const s = Store.getSettings();
    s.speedUnit = this.units.speed;
    s.distUnit = this.units.dist;
    s.elevUnit = this.units.elev;
    Store.saveSettings(s);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN DISPLAY UPDATE (called every tick)
  // ════════════════════════════════════════════════════════════════════════════

  update() {
    const r = Engine.run;
    if (!r) return;

    const $ = (id) => document.getElementById(id);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const css = (id, prop, v) => { const el = $(id); if (el) el.style[prop] = v; };

    // ── Timer ────────────────────────────────────────────────────────────
    set('timerEl', Engine.fmtTime(r.elapsed));

    // ── Speed ────────────────────────────────────────────────────────────
    set('spVal', this.convSpeed(r.speed));
    set('spUnit', this.speedLabel());
    // Live badge
    const spBadge = $('speedLive');
    if (spBadge) spBadge.style.display = (r.speedSource !== 'none') ? 'inline-block' : 'none';

    // Pace sub-line
    if (r.speed > 0.5) {
      const secPerKm = 3600 / r.speed;
      const pm = Math.floor(secPerKm / 60);
      const ps = Math.round(secPerKm % 60);
      set('paceVal', pm + ':' + String(ps).padStart(2, '0') + ' /km');
    } else {
      set('paceVal', '—');
    }

    // ── Heart Rate ───────────────────────────────────────────────────────
    set('hrVal', r.hr > 0 ? r.hr : '—');
    const hrBadge = $('hrLive');
    if (hrBadge) hrBadge.style.display = (r.hrSource !== 'none') ? 'inline-block' : 'none';

    // Zone indicator
    const zone = Engine.getCurrentZone();
    if (zone > 0) {
      const z = Engine.HR_ZONES[zone - 1];
      set('hrZone', 'Z' + zone + ' · ' + z.label.toUpperCase());
      css('hrZone', 'color', z.color);
      // Zone cursor on gradient bar
      const pct = r.hr > 0 ? Math.max(0, Math.min(100, ((r.hr / r.maxHR) - 0.5) / 0.5 * 100)) : 0;
      css('zCur', 'left', pct.toFixed(1) + '%');

      // Ambient HR zone glow — subtle colored border on root during workout
      var rootEl = document.getElementById('rootApp');
      if (rootEl && r.status === 'running') {
        rootEl.style.boxShadow = 'inset 0 0 60px -20px ' + z.color + '33';
      }
    } else {
      var rootEl2 = document.getElementById('rootApp');
      if (rootEl2) rootEl2.style.boxShadow = 'none';
    }

    // ── Incline ──────────────────────────────────────────────────────────
    const inc = r.currentGrade != null ? r.currentGrade : r.incline;
    set('incVal', (inc >= 0 ? '+' : '') + inc.toFixed(1));
    const modeSuffix = Engine.ctrl.mode === 'route' ? ' ROUTE'
                     : Engine.ctrl.mode === 'hr-incline' ? ' AUTO'
                     : Engine.ctrl.mode === 'hr-speed' ? ' FIX' : '';
    set('incLabel', 'INCLINE' + modeSuffix);

    // Incline bar fill
    const iFill = $('iFill');
    if (iFill) {
      iFill.style.width = Math.max(0, (inc + 6) / 46 * 100) + '%';
      iFill.style.background = inc > 8 ? '#ff5f5f' : inc > 3 ? '#ff9f43' : '#3ecfff';
    }

    // ── Distance ─────────────────────────────────────────────────────────
    const distKm = r.distanceM / 1000;
    set('distVal', this.convDist(distKm));
    set('distUnit', this.distLabel());

    // Remaining (if on route)
    if (Engine.hasRoute()) {
      const remKm = Math.max(0, Engine.route.totalDistKm - distKm);
      set('distRem', this.convDist(remKm) + ' ' + this.distLabel() + ' left');
    } else {
      set('distRem', '');
    }

    // ── Elevation ────────────────────────────────────────────────────────
    set('eleVal', this.convElev(r.currentEle));
    set('eleUnit', this.elevLabel());
    set('eleGain', '+' + this.convElev(r.elevGained) + this.elevLabel());

    // ── Cadence ──────────────────────────────────────────────────────────
    set('cadVal', r.cadence > 0 ? r.cadence : '—');

    // ── Calories ─────────────────────────────────────────────────────────
    set('calVal', Math.round(r.calories));

    // ── Avg Pace ─────────────────────────────────────────────────────────
    set('avgPace', Engine.getAvgPace());
    set('avgHR', Engine.getAvgHR() > 0 ? ('Avg ❤ ' + Engine.getAvgHR()) : '');

    // ── Route progress bar ───────────────────────────────────────────────
    if (Engine.hasRoute()) {
      const pct = (r.routeProgress * 100).toFixed(1);
      css('routeProgress', 'width', pct + '%');
    }

    // ── Ghost delta ──────────────────────────────────────────────────────
    if (Engine.ghostEnabled && Engine.ghost) {
      const delta = Engine.ghostDelta();
      const abs = Math.abs(delta);
      const m = Math.floor(abs / 60);
      const s = Math.round(abs % 60);
      const str = (delta >= 0 ? '+' : '-') + m + ':' + String(s).padStart(2, '0');
      set('ghostDelta', str);
      const gdEl = $('ghostDelta');
      if (gdEl) gdEl.className = 'gc-delta ' + (delta >= 0 ? 'ahead' : 'behind');
      const ghostPanel = $('ghostPanel');
      if (ghostPanel) ghostPanel.style.display = 'flex';
    }

    // ── Target zone display ─────────────────────────────────────────────
    const tzEl = document.getElementById('targetZoneDisplay');
    if (tzEl) tzEl.textContent = 'Z' + Engine.ctrl.targetZone;

    // ── Workout HUD ──────────────────────────────────────────────────────
    this._updateWorkoutHUD();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ELEVATION CANVAS
  // ════════════════════════════════════════════════════════════════════════════

  drawElevation() {
    const ec = document.getElementById('elevC');
    if (!ec || !Engine.elevation) return;
    const ctx = ec.getContext('2d');
    const W = ec.parentElement.clientWidth;
    const H = ec.parentElement.clientHeight;
    ec.width = W; ec.height = H;

    const el = Engine.elevation;
    const n = el.length;
    const mn = Math.min(...el);
    const mx = Math.max(...el);
    const range = mx - mn || 1;
    const pad = 3;

    const xs = (i) => pad + (i / (n - 1)) * (W - pad * 2);
    const ys = (e) => H - pad - ((e - mn) / range) * (H - pad * 2 - 6);

    // Background fill
    ctx.beginPath(); ctx.moveTo(xs(0), H);
    el.forEach((e, i) => ctx.lineTo(xs(i), ys(e)));
    ctx.lineTo(xs(n - 1), H); ctx.closePath();
    const fg = ctx.createLinearGradient(0, 0, 0, H);
    fg.addColorStop(0, 'rgba(62,207,255,.12)');
    fg.addColorStop(1, 'rgba(62,207,255,.01)');
    ctx.fillStyle = fg; ctx.fill();

    // Grade-coloured line
    const idx = Engine.run ? Engine.run.routeIdx : 0;
    for (let i = 1; i < n; i++) {
      const g = ((el[i] - el[i - 1]) / (Engine.route.totalDistM / n)) * 100;
      const ahead = i > idx;
      ctx.beginPath();
      ctx.moveTo(xs(i - 1), ys(el[i - 1]));
      ctx.lineTo(xs(i), ys(el[i]));
      ctx.strokeStyle = this._gradeColor(g, ahead);
      ctx.lineWidth = ahead ? 2 : 2.5;
      ctx.stroke();
    }

    // Ghost position
    if (Engine.ghostEnabled && Engine.ghost) {
      const gi = Engine.ghost.routeIdx;
      const gx = xs(gi);
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H);
      ctx.strokeStyle = 'rgba(255,224,102,0.4)'; ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(gx, ys(el[gi]), 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,224,102,0.7)'; ctx.fill();
    }

    // Runner position
    ctx.beginPath(); ctx.moveTo(xs(idx), 0); ctx.lineTo(xs(idx), H);
    ctx.strokeStyle = 'rgba(62,207,255,0.6)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(xs(idx), ys(el[idx]), 5, 0, Math.PI * 2);
    ctx.fillStyle = '#3ecfff'; ctx.fill();
    ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke();
  },

  _gradeColor(g, ahead) {
    const a = ahead ? 0.5 : 0.9;
    if (g > 10) return 'rgba(255,95,95,' + a + ')';
    if (g > 6)  return 'rgba(255,159,67,' + a + ')';
    if (g > 2)  return 'rgba(255,224,102,' + a + ')';
    if (g > -1) return 'rgba(62,207,255,' + a + ')';
    return 'rgba(61,220,132,' + a + ')';
  },

  // ════════════════════════════════════════════════════════════════════════════
  // KM SPLIT TOAST
  // ════════════════════════════════════════════════════════════════════════════

  showSplitToast(km, timeSec, paceSecPerKm, hr) {
    const existing = document.getElementById('kmToast');
    if (existing) existing.remove();

    const pm = Math.floor(paceSecPerKm / 60);
    const ps = Math.round(paceSecPerKm % 60);
    const paceStr = pm + ':' + String(ps).padStart(2, '0');

    const toast = document.createElement('div');
    toast.id = 'kmToast';
    toast.className = 'km-toast show';
    toast.innerHTML =
      '<div class="kmt-km">' + km + ' KM</div>' +
      '<div class="kmt-pace">' + paceStr + ' /km</div>' +
      (hr > 0 ? '<div class="kmt-hr">❤ ' + hr + '</div>' : '');

    const mapZone = document.querySelector('.map-zone');
    if (mapZone) mapZone.appendChild(toast);

    setTimeout(() => toast.classList.remove('show'), 3000);
    setTimeout(() => toast.remove(), 3500);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // SPLITS PANEL
  // ════════════════════════════════════════════════════════════════════════════

  toggleSplits() {
    this.splitsOpen = !this.splitsOpen;
    const panel = document.getElementById('splitsPanel');
    if (panel) panel.classList.toggle('open', this.splitsOpen);
    if (this.splitsOpen) this.renderSplits();
  },

  renderSplits() {
    const el = document.getElementById('splitsList');
    if (!el || !Engine.run) return;
    const splits = Engine.run.splits;
    if (!splits.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--dim);padding:20px;font-size:11px">No splits yet — keep running!</div>';
      return;
    }
    el.innerHTML = splits.map(s => {
      const pm = Math.floor(s.paceSecPerKm / 60);
      const ps = Math.round(s.paceSecPerKm % 60);
      return '<div class="split-row">' +
        '<div class="split-km">' + s.km + '</div>' +
        '<div class="split-pace">' + pm + ':' + String(ps).padStart(2, '0') + '</div>' +
        '<div class="split-hr">' + (s.avgHR > 0 ? '❤ ' + s.avgHR : '') + '</div>' +
        '<div class="split-time">' + Engine.fmtTime(s.elapsed) + '</div>' +
      '</div>';
    }).join('');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ROUTE IMPORT MODAL
  // ════════════════════════════════════════════════════════════════════════════

  openRouteModal() {
    const modal = document.getElementById('routeModal');
    if (modal) modal.classList.add('show');
    this.renderRouteList();
  },

  closeRouteModal() {
    const modal = document.getElementById('routeModal');
    if (modal) modal.classList.remove('show');
  },

  renderRouteList() {
    const el = document.getElementById('routeList');
    if (!el) return;
    const routes = Store.getRoutes();

    if (!routes.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--dim);padding:40px;font-size:11px;font-family:\'JetBrains Mono\',monospace">' +
        'No routes imported yet.<br>Tap IMPORT GPX to add your first route.' +
        '</div>';
      return;
    }

    el.innerHTML = routes.map(r => {
      const distStr = r.totalDistKm.toFixed(1);
      const activeId = Store.getActiveRouteId();
      const isActive = r.id === activeId;
      const bestStr = r.bestTime ? Engine.fmtTime(r.bestTime) : '—';
      const safeId = _esc(r.id);
      return '<div class="route-card' + (isActive ? ' active' : '') + '" data-id="' + safeId + '" onclick="App.selectRoute(\'' + safeId + '\')">' +
        '<div class="rc-top">' +
          '<div class="rc-name">' + _esc(r.name) + '</div>' +
          (r.favourite ? '<span class="rc-fav">⭐</span>' : '') +
          '<button class="rc-del" onclick="event.stopPropagation();App.deleteRoute(\'' + safeId + '\')" title="Delete route">✕</button>' +
        '</div>' +
        '<div class="rc-stats">' +
          '<span>' + distStr + ' km</span>' +
          '<span>+' + (r.totalAscent || 0) + ' m</span>' +
          '<span>' + (r.runCount || 0) + ' runs</span>' +
          '<span>Best: ' + bestStr + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RUN COMPLETE OVERLAY
  // ════════════════════════════════════════════════════════════════════════════

  showRunComplete() {
    const r = Engine.run;
    if (!r) return;

    const $ = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    $('fRoute', r.routeName);
    $('fTime', Engine.fmtTime(r.elapsed));
    $('fDist', this.convDist(r.distanceM / 1000) + ' ' + this.distLabel());
    $('fPace', Engine.getAvgPace() + ' /km');
    $('fHR', Engine.getAvgHR() > 0 ? Engine.getAvgHR() : '—');
    $('fCal', Math.round(r.calories));
    $('fElev', '+' + this.convElev(r.elevGained) + ' ' + this.elevLabel());

    // Effort score (TRIMP)
    var effortScore = Engine.getEffortScore();
    var effortEl = document.getElementById('fEffort');
    var effortLabelEl = document.getElementById('fEffortLabel');
    if (effortEl) {
      effortEl.textContent = effortScore > 0 ? effortScore : '—';
      effortEl.style.color = Engine.getEffortColor(effortScore);
    }
    if (effortLabelEl && effortScore > 0) {
      effortLabelEl.textContent = Engine.getEffortLabel(effortScore);
    }

    // Personal best indicator
    var pbEl = document.getElementById('fPB');
    if (pbEl) {
      var route = Engine.route;
      if (route && route.bestTime && r.elapsed <= route.bestTime) {
        pbEl.textContent = '🏆 PERSONAL BEST!';
        pbEl.style.display = '';
      } else if (route && route.bestTime) {
        var diff = r.elapsed - route.bestTime;
        pbEl.textContent = '+' + Engine.fmtTime(diff) + ' from PB (' + Engine.fmtTime(route.bestTime) + ')';
        pbEl.style.display = '';
        pbEl.style.color = 'var(--dim)';
      } else {
        pbEl.style.display = 'none';
      }
    }

    document.getElementById('finishOverlay').classList.add('show');
  },

  hideRunComplete() {
    document.getElementById('finishOverlay').classList.remove('show');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // SETTINGS MODAL
  // ════════════════════════════════════════════════════════════════════════════

  openSettings() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.add('show');
    const s = Store.getSettings();
    const v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    v('setMaxHR', s.maxHR);
    v('setWeight', s.weight);
    v('setMaxSpeed', s.safetyMaxSpeed);
    v('setMaxIncline', s.safetyMaxIncline);
    v('setGoogleApiKey', s.googleApiKey || '');
    v('setWebhookUrl', Sync.webhookUrl || '');
  },

  closeSettings() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.remove('show');
  },

  saveSettings() {
    const v = (id) => parseFloat(document.getElementById(id).value) || 0;
    const s = Store.getSettings();
    s.maxHR = Math.max(120, Math.min(220, v('setMaxHR')));
    s.weight = Math.max(30, Math.min(200, v('setWeight')));
    s.safetyMaxSpeed = Math.max(5, Math.min(25, v('setMaxSpeed')));
    s.safetyMaxIncline = Math.max(0, Math.min(40, v('setMaxIncline')));
    // Save Google API key
    var gkEl = document.getElementById('setGoogleApiKey');
    const googleKey = (gkEl ? gkEl.value : '').trim();
    if (googleKey) s.googleApiKey = googleKey;
    else delete s.googleApiKey;

    Store.saveSettings(s);

    // Save webhook URL
    var whEl = document.getElementById('setWebhookUrl');
    const webhookUrl = (whEl ? whEl.value : '').trim();
    Sync.webhookUrl = webhookUrl;

    // Save Strava app credentials
    var ciEl = document.getElementById('setStravaClientId');
    var scEl = document.getElementById('setStravaSecret');
    const clientId = (ciEl ? ciEl.value : '').trim();
    const secret = (scEl ? scEl.value : '').trim();
    if (clientId && secret) {
      Sync.stravaApp = { clientId, clientSecret: secret };
    }

    this.closeSettings();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // WORKOUT HUD
  // ════════════════════════════════════════════════════════════════════════════

  _updateWorkoutHUD() {
    const hud = document.getElementById('workoutHud');
    if (!hud) return;

    if (!Engine.workout) {
      hud.style.display = 'none';
      return;
    }

    hud.style.display = 'block';
    const w = Engine.workout;
    const stage = w.programme.stages[w.stageIdx];
    if (!stage) return;

    const $ = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    $('whProgName', w.programme.name);
    $('whStageName', stage.name || ('Stage ' + (w.stageIdx + 1)));
    $('whStageTimer', Engine.fmtTime(Math.max(0, stage.duration - w.stageElapsed)));

    const progress = document.getElementById('whProgFill');
    if (progress && stage.duration > 0) {
      progress.style.width = Math.min(100, (w.stageElapsed / stage.duration * 100)) + '%';
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTION STATUS PILLS
  // ════════════════════════════════════════════════════════════════════════════

  updateConnectionPill(type, state, name) {
    const pill = document.getElementById(type === 'hr' ? 'pillHR' : 'pillTM');
    if (!pill) return;
    const icons = { hr: '❤', tm: '🏃' };
    const labels = { hr: 'HR', tm: 'TREADMILL' };
    pill.className = 'bt-pill' + (state === 'connecting' ? ' connecting' : state === 'connected' ? ' connected' : '');
    pill.textContent = icons[type] + ' ' + (state === 'connected' ? (name || 'LIVE') : state === 'connecting' ? 'CONNECTING…' : labels[type]);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RUN HISTORY PANEL (for ghost selection)
  // ════════════════════════════════════════════════════════════════════════════

  openHistoryPanel() {
    const panel = document.getElementById('historyPanel');
    if (!panel) return;
    panel.classList.add('open');
    this.renderHistory();
  },

  closeHistoryPanel() {
    const panel = document.getElementById('historyPanel');
    if (panel) panel.classList.remove('open');
  },

  renderHistory() {
    const el = document.getElementById('historyList');
    if (!el) return;
    const routeId = Engine.route ? Engine.route.id : null;
    const runs = routeId ? Store.getRunsForRoute(routeId) : Store.getRuns();

    if (!runs.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--dim);padding:20px;font-size:11px">No saved runs yet.</div>';
      return;
    }

    el.innerHTML = runs.slice(0, 20).map(r => {
      const date = r.startedAt ? new Date(r.startedAt).toLocaleDateString() : '—';
      const safeId = _esc(r.id);
      return '<div class="history-row" onclick="App.loadGhost(\'' + safeId + '\')">' +
        '<div class="hr-date">' + date + '</div>' +
        '<div class="hr-name">' + _esc(r.routeName || 'Free Run') + '</div>' +
        '<div class="hr-time">' + Engine.fmtTime(r.elapsed) + '</div>' +
        '<div class="hr-dist">' + (r.distanceKm || 0).toFixed(1) + ' km</div>' +
        '<div class="hr-btn">👻 RACE</div>' +
      '</div>';
    }).join('');
  },
};
