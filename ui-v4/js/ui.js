// ════════════════════════════════════════════════════════════════════════════
// UI — DOM updates, panels, modals, unit formatting, elevation canvas
// ════════════════════════════════════════════════════════════════════════════

function _esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const UI = {

  // ── In-page dialogs (audit P1-a): native confirm()/alert()/prompt() are dead in the plain WebView wrapper ──
  _dlgHost() { return document.getElementById('rootApp') || document.body; },
  _dlg(html) {
    const d = document.createElement('div');
    d.className = 'ui-dlg-backdrop';
    d.innerHTML = '<div class="ui-dlg">' + html + '</div>';
    this._dlgHost().appendChild(d);
    return d;
  },
  /** Test hook: a page that REPLACED a native dialog (window.confirm/prompt = function …) wants it honoured. The real
   *  wrapper leaves the natives in place (where they are dead no-ops), so the in-page dialog is used there. */
  _stubbed(name) {
    try { const f = window[name]; return typeof f === 'function' && !/\[native code\]/.test(Function.prototype.toString.call(f)) ? f : null; } catch (e) { return null; }
  },
  /** Confirm → Promise<boolean>. Always in-page, works everywhere. */
  ask(msg, okLabel, danger) {
    const self = this;
    const stub = this._stubbed('confirm'); if (stub) return Promise.resolve(!!stub(msg));
    return new Promise(function (res) {
      const d = self._dlg('<div class="ui-dlg-msg">' + _esc(msg) + '</div><div class="ui-dlg-btns">' +
        '<button class="btn-ghost ui-dlg-no">CANCEL</button><button class="fc-btn ' + (danger === false ? 'fc-start' : 'fc-stop') + ' ui-dlg-ok">' + _esc(okLabel || 'OK') + '</button></div>');
      d.querySelector('.ui-dlg-no').onclick = function () { d.remove(); res(false); };
      d.querySelector('.ui-dlg-ok').onclick = function () { d.remove(); res(true); };
    });
  },
  /** Prompt → Promise<string|null>. */
  prompt(msg, def) {
    const self = this;
    const stub = this._stubbed('prompt'); if (stub) return Promise.resolve(stub(msg, def));
    return new Promise(function (res) {
      const d = self._dlg('<div class="ui-dlg-msg">' + _esc(msg) + '</div><input class="ui-dlg-input" type="text" value="' + _esc(def || '') + '"><div class="ui-dlg-btns">' +
        '<button class="btn-ghost ui-dlg-no">CANCEL</button><button class="fc-btn fc-start ui-dlg-ok">OK</button></div>');
      const inp = d.querySelector('.ui-dlg-input');
      d.querySelector('.ui-dlg-no').onclick = function () { d.remove(); res(null); };
      d.querySelector('.ui-dlg-ok').onclick = function () { const v = inp.value; d.remove(); res(v); };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') d.querySelector('.ui-dlg-ok').click(); });
      setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 50);
    });
  },
  /** Non-blocking notice (replaces alert()). */
  info(msg, color) { if (typeof App !== 'undefined' && App._toast) App._toast(msg, color || 'var(--card2)'); else console.log('[UI]', msg); },

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
    Units.system(); Units.syncSettings();   // single unit system -> UI.units.*
    Units.refreshDom();
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
    return Units.speedLabel();
  },

  convDist(km) {
    return this.units.dist === 'mi' ? (km * 0.621371).toFixed(2) : km.toFixed(2);
  },
  distLabel() { return this.units.dist === 'mi' ? 'mi' : 'km'; },

  convElev(m) { return this.units.elev === 'ft' ? Math.round(m * 3.28084) : Math.round(m); },
  elevLabel() { return this.units.elev; },

  // One unit system drives everything (Units.set); the per-field cyclers now flip the whole system.
  cycleSpeed() { Units.set(Units.imp() ? 'metric' : 'imperial'); },
  cycleDist() { Units.set(Units.imp() ? 'metric' : 'imperial'); },
  cycleElev() { Units.set(Units.imp() ? 'metric' : 'imperial'); },
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
      set('paceVal', Units.paceFromKmh(r.speed));
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
      set('hrZone', r.hr > 0 ? 'BELOW Z1' : 'WAITING FOR HR — WEAR STRAP SNUG (PAIR IN iFIT IF NOT LISTED)');
      css('hrZone', 'color', 'var(--dim)');
      css('zCur', 'left', '0%');
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

    // Remaining + ETA (if on route)
    if (Engine.hasRoute()) {
      const remKm = Math.max(0, Engine.route.totalDistKm - distKm);
      var remText = this.convDist(remKm) + ' ' + this.distLabel() + ' left';
      // Append ETA if we have enough progress
      if (r.routeProgress > 0.02 && r.elapsed > 10) {
        var etaSec = Math.round((r.elapsed / r.routeProgress) - r.elapsed);
        if (etaSec > 0 && etaSec < 36000) {
          var etaM = Math.floor(etaSec / 60);
          var etaS = etaSec % 60;
          remText += ' · ~' + etaM + ':' + String(etaS).padStart(2, '0') + ' to go';
        }
      }
      set('distRem', remText);
    } else {
      set('distRem', '');
    }

    // ── Elevation ────────────────────────────────────────────────────────
    set('eleVal', this.convElev(r.currentEle));
    set('eleUnit', this.elevLabel());
    set('eleGain', '+' + this.convElev(r.elevGained) + this.elevLabel());

    // ── Cadence + Running Dynamics ─────────────────────────────────────
    set('cadVal', r.cadence > 0 ? r.cadence : '—');
    var dynParts = [];
    if (r.strideLength > 0) dynParts.push(r.strideLength.toFixed(2) + 'm');
    if (r.gct > 0) dynParts.push(r.gct + 'ms');
    if (r.vertOsc > 0) dynParts.push(r.vertOsc + 'cm');
    set('strideVal', dynParts.join(' · '));

    // ── Power ───────────────────────────────────────────────────────────
    set('powerVal', r.power > 0 ? r.power : '—');
    var avgP = Engine.getAvgPower();
    set('avgPowerVal', avgP > 0 ? ('avg ' + avgP + 'W') : '');

    // ── Calories ─────────────────────────────────────────────────────────
    set('calVal', Math.round(r.calories));

    // ── Avg Pace ─────────────────────────────────────────────────────────
    set('avgPace', Engine.getAvgPace());
    set('avgPaceU', Units.paceSlash());
    set('avgHR', Engine.getAvgHR() > 0 ? ('Avg ❤ ' + Engine.getAvgHR()) : '');

    // ── Cardiac Drift / EF ─────────────────────────────────────────────
    var driftPct = Engine.getDriftPct();
    var efValue = Engine.getEF();
    if (driftPct > 0 || efValue > 0) {
      set('driftVal', driftPct > 0 ? driftPct.toFixed(1) : '—');
      var driftEl = $('driftVal');
      if (driftEl && driftPct > 0) {
        driftEl.style.color = driftPct < 3 ? '#69f0ae' : driftPct < 5 ? '#3ecfff' : driftPct < 8 ? '#ffb74d' : '#ff5f5f';
      }
      set('efVal', efValue > 0 ? ('EF ' + efValue.toFixed(2)) : '');
    }

    // ── Route progress bar ───────────────────────────────────────────────
    if (Engine.hasRoute()) {
      const pct = (r.routeProgress * 100).toFixed(1);
      css('routeProgress', 'width', pct + '%');

      // PB pace indicator — are we on track to beat the best time?
      var pbPaceEl = $('pbPace');
      if (pbPaceEl && Engine.route.bestTime && r.routeProgress > 0.02 && r.elapsed > 10) {
        var projectedTotal = r.elapsed / r.routeProgress;
        var pbDiff = projectedTotal - Engine.route.bestTime;
        var absD = Math.abs(Math.round(pbDiff));
        var mD = Math.floor(absD / 60);
        var sD = absD % 60;
        var diffStr = (mD > 0 ? mD + ':' + String(sD).padStart(2, '0') : sD + 's');
        if (pbDiff <= 0) {
          pbPaceEl.textContent = 'PB: -' + diffStr;
          pbPaceEl.style.color = 'var(--green)';
        } else {
          pbPaceEl.textContent = 'PB: +' + diffStr;
          pbPaceEl.style.color = 'var(--red, #ff5f5f)';
        }
        pbPaceEl.style.display = '';
      } else if (pbPaceEl) {
        pbPaceEl.style.display = 'none';
      }
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
      ctx.lineWidth = ahead ? 3 : 6;
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

    // Runner position — ui-v4: 28px+ pulsing ring + fill (canvas is redrawn every tick)
    const rx = xs(idx), ry = ys(el[idx]);
    ctx.beginPath(); ctx.moveTo(rx, 0); ctx.lineTo(rx, H);
    ctx.strokeStyle = 'rgba(55,208,255,0.7)'; ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    const pulse = (Date.now() % 1400) / 1400;
    ctx.beginPath(); ctx.arc(rx, ry, 14 + pulse * 12, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(55,208,255,' + (0.8 * (1 - pulse)).toFixed(2) + ')'; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(rx, ry, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#37d0ff'; ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.stroke();
  },

  _gradeColor(g, ahead) {
    // ui-v4: the part already run is a solid green trail; the part ahead keeps grade colours
    if (!ahead) return 'rgba(62,232,159,0.95)';
    const a = 0.75;
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

    const paceStr = Units.pace(paceSecPerKm);

    const toast = document.createElement('div');
    toast.id = 'kmToast';
    toast.className = 'km-toast show';
    toast.innerHTML =
      '<div class="kmt-km">' + (Units.imp() ? Units.distKm(km, 2) + ' MI' : km + ' KM') + '</div>' +
      '<div class="kmt-pace">' + paceStr + ' ' + Units.paceSlash() + '</div>' +
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
    const imp = Units.imp();
    const splits = imp ? PastRunSplits.regroup(Engine.run).splits.map(q => ({ km: q.km, paceSecPerKm: q.timeSec / Units.KM_PER_MI, avgHR: q.avgHR, elapsed: null, _t: q.timeSec })) : Engine.run.splits;
    if (imp) { let cum = 0; splits.forEach(q => { cum += q._t; q.elapsed = cum; }); }
    if (!splits.length) {
      el.innerHTML = '<div class="wb-empty">No splits yet — keep running!</div>';
      return;
    }
    el.innerHTML = splits.map(s => {
      return '<div class="split-row">' +
        '<div class="split-km">' + (imp ? 'Mile ' : '') + s.km + '</div>' +
        '<div class="split-pace">' + Units.pace(s.paceSecPerKm) + '</div>' +
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

    const activeId = Store.getActiveRouteId();
    const runBtn = document.getElementById('runRouteBtn');
    if (runBtn) runBtn.style.display = (activeId && routes.some(r => r.id === activeId)) ? '' : 'none';

    if (!routes.length) {
      el.innerHTML = '<div class="wb-empty">No routes yet.<br>Tap IMPORT GPX to add a route from Garmin, Strava or any GPS app.</div>';
      return;
    }

    el.innerHTML = routes.map(r => {
      const distStr = Units.distKm(r.totalDistKm, 1);
      const isActive = r.id === activeId;
      const bestStr = r.bestTime ? Engine.fmtTime(r.bestTime) : '—';
      const safeId = _esc(r.id);
      return '<div class="route-card' + (isActive ? ' active' : '') + '" data-id="' + safeId + '" onclick="App.selectRoute(\'' + safeId + '\')">' +
        '<div class="rc-check">' + (isActive ? '✔' : '') + '</div>' +
        '<div class="rc-top">' +
          '<div class="rc-name">' + (r.favourite ? '⭐ ' : '') + _esc(r.name) + '</div>' +
          '<div class="rc-stats">' +
            '<span>' + distStr + ' ' + Units.distLabel() + '</span>' +
            '<span>+' + Units.elev(r.totalAscent || 0) + ' ' + Units.elevLabel() + ' climb</span>' +
            '<span>' + (r.runCount || 0) + ' runs</span>' +
            '<span>Best ' + bestStr + '</span>' +
          '</div>' +
        '</div>' +
        '<button class="rc-del" onclick="event.stopPropagation();UI.ask(\'Delete this route?\',\'DELETE\').then(function(y){if(y)App.deleteRoute(\'' + safeId + '\')})" title="Delete route">🗑</button>' +
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
    $('fPace', Engine.getAvgPace() + ' ' + Units.paceSlash());
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

    // Run comparison (vs last and best on same route)
    this._renderComparison(r);

    // ui-v4: per-km split comparison (this run vs fastest / slowest / median of past runs)
    var scEl = document.getElementById('fSplits');
    if (scEl && typeof SplitCompare !== 'undefined') {
      try { SplitCompare.render(scEl, r); } catch (e) { scEl.innerHTML = ''; console.warn('[UI] split compare failed', e); }
    }

    // Power summary
    var powerEl = document.getElementById('fPower');
    if (powerEl) {
      var avgPow = Engine.getAvgPower();
      if (avgPow > 0) {
        powerEl.innerHTML = '<span style="color:var(--dim)">Power: </span><span style="color:var(--cyan)">' + avgPow + 'W avg</span>';
        if (r._powerMax > 0) powerEl.innerHTML += ' <span style="color:var(--dim)">/ ' + Math.round(r._powerMax) + 'W peak</span>';
        powerEl.style.display = '';
      } else {
        powerEl.style.display = 'none';
      }
    }

    // Negative splits
    var negSplitEl = document.getElementById('fNegSplits');
    if (negSplitEl) {
      var negCount = r.splits.filter(function(s) { return s.negativeSplit; }).length;
      if (negCount > 0) {
        negSplitEl.innerHTML = '<span style="color:var(--green)">' + negCount + ' negative split' + (negCount > 1 ? 's' : '') + ' — great pacing!</span>';
        negSplitEl.style.display = '';
      } else {
        negSplitEl.style.display = 'none';
      }
    }

    // HR Recovery indicator
    var hrrEl = document.getElementById('fHRR');
    if (hrrEl) {
      if (r._hrRecovery) {
        // Already completed (rare — only if < 60s since recovery started)
        var drop = r._hrRecovery.drop;
        var rating = drop >= 40 ? 'Excellent' : drop >= 25 ? 'Good' : drop >= 12 ? 'Average' : 'Below avg';
        var color = drop >= 40 ? '#69f0ae' : drop >= 25 ? '#3ecfff' : drop >= 12 ? '#ffb74d' : '#ff5f5f';
        hrrEl.innerHTML = '<span style="color:var(--dim)">HR Recovery (1 min): </span><span style="color:' + color + '">' + r._hrRecovery.hrAtFinish + ' → ' + r._hrRecovery.hrAfter60s + ' bpm (-' + drop + ' · ' + rating + ')</span>';
        hrrEl.style.display = '';
      } else if (r._recoveryStart && r.hr > 30) {
        hrrEl.innerHTML = '<span style="color:var(--dim)">Measuring HR Recovery... stay still for 60 seconds</span>';
        hrrEl.style.display = '';
      } else {
        hrrEl.style.display = 'none';
      }
    }

    // Cardiac drift + Efficiency Factor
    var driftEfEl = document.getElementById('fDriftEF');
    if (driftEfEl) {
      var parts = [];
      if (r._efSamples && r._efSamples.length > 0) {
        var efAvg = r._efSamples.reduce(function(a, b) { return a + b.ef; }, 0) / r._efSamples.length;
        var efColor = efAvg >= 1.8 ? '#69f0ae' : efAvg >= 1.5 ? '#3ecfff' : efAvg >= 1.2 ? '#ffb74d' : '#ff5f5f';
        var efLabel = efAvg >= 1.8 ? 'Excellent' : efAvg >= 1.5 ? 'Good' : efAvg >= 1.2 ? 'Average' : 'Developing';
        parts.push('<span style="color:var(--dim)">EF: </span><span style="color:' + efColor + '">' + efAvg.toFixed(2) + ' (' + efLabel + ')</span>');
      }
      if (r._driftBaselineLocked) {
        var drift = r._driftPct || 0;
        var driftColor = drift < 3 ? '#69f0ae' : drift < 5 ? '#3ecfff' : drift < 8 ? '#ffb74d' : '#ff5f5f';
        var driftLabel = drift < 3 ? 'Minimal' : drift < 5 ? 'Normal' : drift < 8 ? 'Moderate — hydrate more' : 'High — hydration or pacing issue';
        parts.push('<span style="color:var(--dim)">Drift: </span><span style="color:' + driftColor + '">' + drift.toFixed(1) + '% (' + driftLabel + ')</span>');
      }
      if (parts.length > 0) {
        driftEfEl.innerHTML = parts.join('&nbsp;&nbsp;·&nbsp;&nbsp;');
        driftEfEl.style.display = '';
      } else {
        driftEfEl.style.display = 'none';
      }
    }

    document.getElementById('finishOverlay').classList.add('show');
  },

  hideRunComplete() {
    document.getElementById('finishOverlay').classList.remove('show');
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RUN COMPARISON
  // ════════════════════════════════════════════════════════════════════════════

  _renderComparison(currentRun) {
    var el = document.getElementById('fComparison');
    if (!el) return;

    var pastRuns = null;
    var routeId = currentRun.routeId;
    if (routeId) {
      pastRuns = Store.getRunsForRoute(routeId);
    } else if (currentRun.routeName && currentRun.routeName !== 'Free Run') {
      // For programmed workouts: match by name
      var allRuns = Store.getRuns();
      var rName = currentRun.routeName;
      pastRuns = [];
      for (var ri = 0; ri < allRuns.length; ri++) {
        if (allRuns[ri].routeName === rName) pastRuns.push(allRuns[ri]);
      }
    }
    if (!pastRuns || pastRuns.length === 0) { el.style.display = 'none'; return; }

    // Current run values
    var curAvgSpeed = currentRun._speedSamples > 0 ? +(currentRun._speedSum / currentRun._speedSamples).toFixed(1) : 0;
    var curAvgHR = currentRun._hrSamples > 0 ? Math.round(currentRun._hrSum / currentRun._hrSamples) : 0;
    var curEffort = Math.round(currentRun._trimp || 0);
    var curElapsed = Math.round(currentRun.elapsed);
    var curCal = Math.round(currentRun.calories);

    // Find last run and best run
    var lastRun = pastRuns[0]; // newest first
    var bestRun = null;
    for (var i = 0; i < pastRuns.length; i++) {
      var prElapsed = pastRuns[i].elapsed || pastRuns[i].elapsedSec || 0;
      var brElapsed = bestRun ? (bestRun.elapsed || bestRun.elapsedSec || 0) : Infinity;
      if (!bestRun || prElapsed < brElapsed) {
        bestRun = pastRuns[i];
      }
    }

    var html = '';

    function deltaStr(cur, prev, unit, lowerIsBetter) {
      if (prev == null || prev === 0) return '<span class="cmp-delta neutral">—</span>';
      var diff = cur - prev;
      var abs = Math.abs(diff);
      var sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
      var cls = diff === 0 ? 'neutral' : (lowerIsBetter ? (diff < 0 ? 'better' : 'worse') : (diff > 0 ? 'better' : 'worse'));
      var val;
      if (unit === 'time') {
        val = Engine.fmtTime(abs);
      } else {
        val = abs.toFixed(unit === 'bpm' || unit === 'kcal' ? 0 : 1);
      }
      return '<span class="cmp-delta ' + cls + '">' + sign + val + (unit !== 'time' ? ' ' + unit : '') + '</span>';
    }

    function section(label, compareRun) {
      if (!compareRun) return '';
      var cmpElapsed = compareRun.elapsed || compareRun.elapsedSec || 0;
      var s = '<div class="cmp-section"><div class="cmp-label">' + label + '</div>';
      s += '<div class="cmp-row"><span class="cmp-metric">Time</span>' + deltaStr(curElapsed, cmpElapsed, 'time', true) + '</div>';
      s += '<div class="cmp-row"><span class="cmp-metric">Avg Speed</span>' + deltaStr(curAvgSpeed, compareRun.avgSpeed, 'kph', false) + '</div>';
      if (curAvgHR > 0 && compareRun.avgHR > 0) {
        s += '<div class="cmp-row"><span class="cmp-metric">Avg HR</span>' + deltaStr(curAvgHR, compareRun.avgHR, 'bpm', true) + '</div>';
      }
      if (curEffort > 0 && compareRun.effortScore > 0) {
        s += '<div class="cmp-row"><span class="cmp-metric">Effort</span>' + deltaStr(curEffort, compareRun.effortScore, '', true) + '</div>';
      }
      if (curCal > 0 && compareRun.calories > 0) {
        s += '<div class="cmp-row"><span class="cmp-metric">Calories</span>' + deltaStr(curCal, compareRun.calories, 'kcal', false) + '</div>';
      }
      s += '</div>';
      return s;
    }

    html += section('vs Last Run', lastRun);
    // Only show best if it's different from last
    if (bestRun && (bestRun.savedAt || bestRun.startedAt) !== (lastRun.savedAt || lastRun.startedAt)) {
      html += section('vs Best Run', bestRun);
    }

    // Split-by-split comparison vs last run
    var curSplits = PastRunSplits.regroup(currentRun).splits;
    var lastSplits = PastRunSplits.regroup(lastRun).splits;
    if (curSplits && lastSplits && curSplits.length > 0 && lastSplits.length > 0) {
      var maxKm = Math.min(curSplits.length, lastSplits.length);
      if (maxKm > 0) {
        html += '<div class="cmp-section"><div class="cmp-label">SPLITS vs Last</div>';
        for (var si = 0; si < maxKm; si++) {
          var curTime = curSplits[si].timeSec || 0;
          var lastTime = lastSplits[si].timeSec || 0;
          if (curTime > 0 && lastTime > 0) {
            var splitDiff = curTime - lastTime;
            var splitCls = splitDiff < 0 ? 'better' : splitDiff > 0 ? 'worse' : 'neutral';
            var splitSign = splitDiff > 0 ? '+' : splitDiff < 0 ? '-' : '';
            var absDiff = Math.abs(splitDiff);
            var diffMin = Math.floor(absDiff / 60);
            var diffSec = Math.floor(absDiff % 60);
            var diffStr = diffMin > 0 ? diffMin + ':' + String(diffSec).padStart(2, '0') : diffSec + 's';
            html += '<div class="cmp-row"><span class="cmp-metric">Km ' + curSplits[si].km + '</span>' +
              '<span class="cmp-delta ' + splitCls + '">' + splitSign + diffStr + '</span></div>';
          }
        }
        html += '</div>';
      }
    }

    if (html) {
      el.innerHTML = html;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
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

    // Builder workouts (WorkoutSegments): stage name, time/distance left, next stage (audit P1-g)
    var seg = (typeof WorkoutSegments !== 'undefined' && WorkoutSegments.active) ? WorkoutSegments.getCurrentSegment() : null;
    if (seg) {
      hud.style.display = 'block';
      var $$ = function (i, v) { var e = document.getElementById(i); if (e && e.textContent !== v) e.textContent = v; };
      var nx = Engine.nextChange ? Engine.nextChange() : null;
      var nxTxt = nx && nx.kind !== 'ramp' ? ('NEXT: ' + (nx.kind === 'end' ? 'finish' : (nx.label || '') + (nx.speed != null ? ' · ' + Units.speedU(nx.speed) : '') + (nx.incline != null ? ' · ' + nx.incline + '%' : ''))) : '';
      $$('whProgName', ((Engine.run && Engine.run.routeName) || 'WORKOUT').toUpperCase() + (seg.total > 0 && seg.index >= 0 ? ' · ' + (seg.index + 1) + '/' + seg.total : ''));
      $$('whStageName', seg.label || ('Segment ' + (seg.index + 1)));
      $$('whStageTimer', seg.remainingType === 'distance' ? (seg.remaining >= 1000 ? Units.distU(seg.remaining) : Math.round(Units.elevNum(seg.remaining)) + ' ' + Units.elevLabel()) + ' left' : Engine.fmtTime(Math.max(0, seg.remaining)) + ' left');
      var nxEl = document.getElementById('whNext'); if (nxEl && nxEl.textContent !== nxTxt) nxEl.textContent = nxTxt;
      var fill = document.getElementById('whProgFill');
      if (fill) { var tp = WorkoutSegments.getTotalProgress(); fill.style.width = tp ? Math.round((tp.fraction || 0) * 100) + '%' : '0'; }
      return;
    }
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
    // ui-v4: every element carrying .pill-tm / .pill-hr is updated (home + topbar)
    const pills = document.querySelectorAll(type === 'hr' ? '.pill-hr' : '.pill-tm');
    const icons = { hr: '❤', tm: '🏃' };
    const labels = { hr: 'HR STRAP', tm: 'TREADMILL' };
    const stateCls = state === 'connecting' ? ' connecting' : state === 'connected' ? ' connected' : '';
    const text = icons[type] + ' ' + (state === 'connected' ? (name || 'LIVE') : state === 'connecting' ? 'CONNECTING…' : labels[type]);
    pills.forEach(function(pill) {
      const small = pill.classList.contains('small');
      pill.className = 'pill-status' + (small ? ' small' : '') + ' ' + (type === 'hr' ? 'pill-hr' : 'pill-tm') + stateCls;
      pill.textContent = small ? (icons[type] + ' ' + (state === 'connected' ? 'OK' : state === 'connecting' ? '…' : '—')) : text;
      pill.title = text;
    });
    if (typeof App !== 'undefined' && App._updateStateBanner) App._updateStateBanner();
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
      el.innerHTML = '<div class="wb-empty">No saved runs yet.<br>Finish and save a run, then race it here.</div>';
      return;
    }

    el.innerHTML = runs.slice(0, 20).map(r => {
      const date = r.startedAt ? new Date(r.startedAt).toLocaleDateString() : '—';
      const safeId = _esc(r.id);
      var sv = '';
      if (window.StravaUpload && window.StravaApi && StravaApi.isConnected()) {
        var sUrl = StravaUpload.activityUrlFor(r.id);
        sv = sUrl ? '<a class="hr-btn hr-strava on" href="' + _esc(sUrl) + '" target="_blank" onclick="event.stopPropagation()">On Strava - View on Strava</a>'
                  : '<div class="hr-btn hr-strava" onclick="event.stopPropagation();App.sendRunToStrava(\'' + safeId + '\')">SEND TO STRAVA</div>';
      }
      return '<div class="history-row" onclick="App.loadGhost(\'' + safeId + '\')">' +
        '<div class="hr-date">' + date + '</div>' +
        '<div class="hr-name">' + _esc(r.routeName || 'Free Run') + '</div>' +
        '<div class="hr-time">' + Engine.fmtTime(r.elapsed) + '</div>' +
        '<div class="hr-dist">' + Units.distKmU(r.distanceKm || 0, 1) + '</div>' +
        sv +
        '<div class="hr-btn hr-again" onclick="event.stopPropagation();App.runAgainSaved(\'' + safeId + '\')">↻ AGAIN</div>' +
        '<div class="hr-btn">👻 RACE</div>' +
      '</div>';
    }).join('');
  },
};
