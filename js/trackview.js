// ════════════════════════════════════════════════════════════════════════════
// TrackView — Zwift-style 3D perspective runner view with ghost runners
//
// Renders a road/trail disappearing into the horizon with:
//   - Your runner avatar (center)
//   - Ghost runners (ahead, alongside, or behind)
//   - Terrain gradient based on real GPX elevation
//   - Trees/scenery along the sides
//   - Distance markers and delta overlay
// ════════════════════════════════════════════════════════════════════════════

const TrackView = {
  canvas: null,
  ctx: null,
  active: false,
  _anim: null,

  // Camera / perspective
  cam: {
    horizon: 0.32,    // horizon line (0=top, 1=bottom)
    fov: 0.7,         // field of view factor
    height: 1.8,      // camera height (meters)
    roadWidth: 4.0,   // road width (meters)
    viewDist: 500,     // max visible distance (meters)
  },

  // Scenery
  trees: [],          // pre-generated tree positions
  _treeSeed: 42,

  // Clouds (procedurally generated, drift slowly)
  _clouds: [],

  // Ghost runners
  ghosts: [],         // [{ name, distKm, color, pace }]

  // Runner position
  runner: {
    distKm: 0,
    speedKmh: 0,
    incline: 0,
    hr: 0,
    power: 0,
    elapsed: 0,
  },

  // Elevation profile cache (subset around current position)
  _elevSlice: [],     // [{ dist, elev, grade }] — 1km window
  _elevScale: 1.0,

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  init(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this._generateTrees();
    this._generateClouds();
  },

  show() {
    if (!this.canvas) return;
    this.active = true;
    this.canvas.style.display = 'block';
    this._resize();
    this._startLoop();
  },

  hide() {
    this.active = false;
    if (this.canvas) this.canvas.style.display = 'none';
    if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RESIZE
  // ═══════════════════════════════════════════════════════════════════════════

  _resize() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * (window.devicePixelRatio || 1);
    this.canvas.height = rect.height * (window.devicePixelRatio || 1);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE (called by Engine on each tick)
  // ═══════════════════════════════════════════════════════════════════════════

  update(data) {
    if (!data) return;
    this.runner.distKm = data.distKm || 0;
    this.runner.speedKmh = data.speedKmh || 0;
    this.runner.incline = data.incline || 0;
    this.runner.hr = data.hr || 0;
    this.runner.power = data.power || 0;
    this.runner.elapsed = data.elapsed || 0;
    this.runner.driftPct = data.driftPct || 0;
    this.runner.ef = data.ef || 0;

    // Update elevation slice (1km behind to 1km ahead)
    if (data.elevProfile) {
      this._updateElevSlice(data.elevProfile, data.distKm);
    }
  },

  setGhosts(ghostList) {
    // ghostList: [{ name, distKm, color, pace, source }]
    this.ghosts = ghostList || [];
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ELEVATION SLICE
  // ═══════════════════════════════════════════════════════════════════════════

  _updateElevSlice(profile, currentDist) {
    if (!profile || !profile.length) return;
    const behind = currentDist - 0.2;  // 200m behind
    const ahead = currentDist + 0.5;   // 500m ahead
    this._elevSlice = [];

    for (let i = 0; i < profile.length - 1; i++) {
      const d = profile[i].dist;
      if (d >= behind && d <= ahead) {
        const next = profile[i + 1];
        const grade = next ? ((next.elev - profile[i].elev) / ((next.dist - d) * 1000 || 1)) * 100 : 0;
        this._elevSlice.push({ dist: d, elev: profile[i].elev, grade });
      }
    }
  },

  _getGradeAtDist(distKm) {
    if (!this._elevSlice.length) return this.runner.incline;
    for (let i = this._elevSlice.length - 1; i >= 0; i--) {
      if (this._elevSlice[i].dist <= distKm) return this._elevSlice[i].grade;
    }
    return this.runner.incline;
  },

  _getElevAtDist(distKm) {
    if (!this._elevSlice.length) return 0;
    for (let i = this._elevSlice.length - 1; i >= 0; i--) {
      if (this._elevSlice[i].dist <= distKm) return this._elevSlice[i].elev;
    }
    return 0;
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TREE GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  _generateTrees() {
    this.trees = [];
    const rng = this._rng(this._treeSeed);
    for (let i = 0; i < 200; i++) {
      const side = rng() > 0.5 ? 1 : -1;
      const offset = 3 + rng() * 15;         // meters from road center
      const distAlong = rng() * 500;         // meters ahead
      const height = 3 + rng() * 8;          // tree height in meters
      const type = rng() > 0.3 ? 'pine' : 'bush';
      this.trees.push({ side, offset, distAlong, height, type });
    }
  },

  _rng(seed) {
    let s = seed;
    return () => { s = (s * 16807 + 0) % 2147483647; return s / 2147483647; };
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  _startLoop() {
    const draw = () => {
      if (!this.active) return;
      this._render();
      this._anim = requestAnimationFrame(draw);
    };
    draw();
  },

  _render() {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!W || !H) return;

    const horizonY = H * this.cam.horizon;
    const time = Date.now() / 1000;

    // ── Time-of-day sky ──────────────────────────────────────────
    var tod = this._getTimeOfDay();
    this._drawSky(c, W, horizonY, tod, time);

    // ── Ground gradient (tinted by time of day) ──────────────────
    const grade = this.runner.incline;
    var gndBase = this._lerpColor(tod.groundNear, tod.groundFar, 0.3);
    var gndFar = grade > 5 ? this._shiftColor(gndBase, 10, -10, 0) :
                 grade < -2 ? this._shiftColor(gndBase, -10, 0, 15) : gndBase;
    const gndGrad = c.createLinearGradient(0, horizonY, 0, H);
    gndGrad.addColorStop(0, tod.groundNear);
    gndGrad.addColorStop(0.3, gndFar);
    gndGrad.addColorStop(1, tod.groundFar);
    c.fillStyle = gndGrad;
    c.fillRect(0, horizonY, W, H - horizonY);

    // ── Road ─────────────────────────────────────────────────────
    this._drawRoad(c, W, H, horizonY);

    // ── Trees (tinted by time of day) ────────────────────────────
    this._drawTrees(c, W, H, horizonY, time, tod);

    // ── Clouds ─────────────────────────────────────────────────
    this._drawClouds(c, W, horizonY, time, tod);

    // ── Distance markers ─────────────────────────────────────────
    this._drawMarkers(c, W, H, horizonY);

    // ── Ghost runners ────────────────────────────────────────────
    for (const ghost of this.ghosts) {
      const delta = (ghost.distKm - this.runner.distKm) * 1000; // meters ahead
      if (delta > -50 && delta < this.cam.viewDist) {
        this._drawRunner(c, W, H, horizonY, delta, ghost.color || '#9966ff', ghost.name, true);
      }
    }

    // ── Your runner (always at center) ───────────────────────────
    this._drawRunner(c, W, H, horizonY, 0, '#00ff88', 'YOU', false);

    // ── Dust particles behind runner ─────────────────────────────
    this._drawDust(c, W, H, time);

    // ── Mini elevation profile ───────────────────────────────────
    this._drawMiniElevation(c, W, H);

    // ── HUD overlay ──────────────────────────────────────────────
    this._drawHUD(c, W, H);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ROAD RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  _drawRoad(c, W, H, horizonY) {
    const segments = 40;
    const roadHalf = this.cam.roadWidth / 2;

    for (let i = segments; i >= 0; i--) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const d0 = t0 * t0 * this.cam.viewDist;
      const d1 = t1 * t1 * this.cam.viewDist;

      const y0 = this._perspY(d0, horizonY, H);
      const y1 = this._perspY(d1, horizonY, H);
      const scale0 = this._perspScale(d0);
      const scale1 = this._perspScale(d1);

      const roadW0 = roadHalf * scale0 * W;
      const roadW1 = roadHalf * scale1 * W;
      const cx = W / 2;

      // Road surface
      const grade = this._getGradeAtDist(this.runner.distKm + d0 / 1000);
      const r = Math.min(80, Math.max(30, 40 + grade * 2));
      const g = Math.min(80, Math.max(30, 50 - Math.abs(grade)));
      const b = Math.min(80, Math.max(30, 40 - grade * 2));
      c.fillStyle = `rgb(${r},${g},${b})`;

      c.beginPath();
      c.moveTo(cx - roadW0, y0);
      c.lineTo(cx + roadW0, y0);
      c.lineTo(cx + roadW1, y1);
      c.lineTo(cx - roadW1, y1);
      c.closePath();
      c.fill();

      // Road edge lines
      c.strokeStyle = 'rgba(255,255,255,0.15)';
      c.lineWidth = Math.max(1, scale0 * 2);
      c.beginPath();
      c.moveTo(cx - roadW0, y0);
      c.lineTo(cx - roadW1, y1);
      c.stroke();
      c.beginPath();
      c.moveTo(cx + roadW0, y0);
      c.lineTo(cx + roadW1, y1);
      c.stroke();

      // Center dashes
      if (Math.floor((this.runner.distKm * 1000 + d0) / 10) % 2 === 0) {
        c.strokeStyle = 'rgba(255,200,50,0.3)';
        c.lineWidth = Math.max(1, scale0 * 1.5);
        c.beginPath();
        c.moveTo(cx, y0);
        c.lineTo(cx, y1);
        c.stroke();
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TREE RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  _drawTrees(c, W, H, horizonY, time, tod) {
    const cx = W / 2;
    const runnerDist = this.runner.distKm * 1000;
    // Time-of-day tints the trees
    var treeR = tod ? tod.treeTint[0] : 20;
    var treeG = tod ? tod.treeTint[1] : 50;
    var treeB = tod ? tod.treeTint[2] : 30;

    for (const tree of this.trees) {
      // Tree position relative to runner
      const d = ((tree.distAlong - (runnerDist % 500)) + 500) % 500;
      if (d < 5 || d > this.cam.viewDist) continue;

      const scale = this._perspScale(d);
      const y = this._perspY(d, horizonY, H);
      const x = cx + tree.side * tree.offset * scale * W * 0.08;
      const h = tree.height * scale * H * 0.15;

      var alpha = 0.8 - d / 700;
      if (alpha < 0.05) continue;

      if (tree.type === 'pine') {
        // Pine tree (triangle)
        var gr = Math.min(255, treeG + Math.floor(d / 5));
        c.fillStyle = 'rgba(' + treeR + ',' + gr + ',' + treeB + ',' + alpha + ')';
        c.beginPath();
        c.moveTo(x, y - h);
        c.lineTo(x - h * 0.3, y);
        c.lineTo(x + h * 0.3, y);
        c.closePath();
        c.fill();
        // Trunk
        c.fillStyle = 'rgba(60,40,20,' + (alpha - 0.1) + ')';
        c.fillRect(x - h * 0.04, y, h * 0.08, h * 0.15);
      } else {
        // Bush (circle)
        var bgr = Math.min(255, treeG + 10 + Math.floor(d / 5));
        c.fillStyle = 'rgba(' + (treeR + 10) + ',' + bgr + ',' + (treeB - 5) + ',' + (alpha - 0.2) + ')';
        c.beginPath();
        c.arc(x, y - h * 0.3, h * 0.4, 0, Math.PI * 2);
        c.fill();
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DISTANCE MARKERS
  // ═══════════════════════════════════════════════════════════════════════════

  _drawMarkers(c, W, H, horizonY) {
    const cx = W / 2;
    const runnerDistM = this.runner.distKm * 1000;

    // Show markers every 100m
    for (let m = 100; m <= 500; m += 100) {
      const markerDistM = Math.ceil((runnerDistM + m) / 100) * 100;
      const d = markerDistM - runnerDistM;
      if (d < 20 || d > this.cam.viewDist) continue;

      const scale = this._perspScale(d);
      const y = this._perspY(d, horizonY, H);
      const roadW = (this.cam.roadWidth / 2) * scale * W;

      // Marker post (left side)
      const postX = cx - roadW - 10 * scale * W * 0.05;
      const postH = 15 * scale * H * 0.05;

      c.fillStyle = `rgba(255,255,255,${0.5 - d / 1000})`;
      c.fillRect(postX - 1, y - postH, 2, postH);

      // Label
      const km = (markerDistM / 1000).toFixed(1);
      c.font = `${Math.max(8, 12 * scale * H / 400)}px 'JetBrains Mono', monospace`;
      c.fillStyle = `rgba(150,200,255,${0.6 - d / 800})`;
      c.textAlign = 'center';
      c.fillText(`${km}km`, postX, y - postH - 3);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RUNNER RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  _drawRunner(c, W, H, horizonY, distAhead, color, name, isGhost) {
    const d = Math.max(1, distAhead);
    const scale = distAhead === 0 ? 0.08 : this._perspScale(Math.abs(d));
    const y = distAhead === 0
      ? H * 0.85
      : this._perspY(Math.abs(d), horizonY, H);
    const x = W / 2;

    const runnerH = (distAhead === 0 ? 60 : 40 * scale * H * 0.3);
    const runnerW = runnerH * 0.4;

    // Effort-colored glow for YOUR runner (not ghosts)
    if (!isGhost && distAhead === 0 && this.runner.power > 0) {
      var p = this.runner.power;
      var glowColor = p > 300 ? '#ff4444' : p > 200 ? '#ff8800' : p > 150 ? '#ffcc00' : '#22cc88';
      var glowSize = 20 + Math.min(15, p / 20);
      var glowPulse = 0.15 + 0.1 * Math.sin(Date.now() / 300);
      c.save();
      c.globalAlpha = glowPulse;
      c.beginPath();
      c.arc(x, y - runnerH * 0.5, glowSize, 0, Math.PI * 2);
      c.fillStyle = glowColor;
      c.fill();
      c.restore();
    }

    const alpha = isGhost ? 0.7 : 1.0;

    // Shadow
    c.fillStyle = `rgba(0,0,0,${0.3 * alpha})`;
    c.beginPath();
    c.ellipse(x, y, runnerW * 0.6, runnerW * 0.15, 0, 0, Math.PI * 2);
    c.fill();

    // Body
    c.fillStyle = color;
    c.globalAlpha = alpha;

    // Legs (animated)
    const time = Date.now() / 200;
    const legSwing = Math.sin(time * (this.runner.speedKmh / 5)) * runnerW * 0.3;

    c.lineWidth = runnerW * 0.15;
    c.strokeStyle = color;
    c.lineCap = 'round';

    // Left leg
    c.beginPath();
    c.moveTo(x, y - runnerH * 0.4);
    c.lineTo(x + legSwing, y);
    c.stroke();

    // Right leg
    c.beginPath();
    c.moveTo(x, y - runnerH * 0.4);
    c.lineTo(x - legSwing, y);
    c.stroke();

    // Arms
    const armSwing = -legSwing * 0.6;
    c.lineWidth = runnerW * 0.1;

    c.beginPath();
    c.moveTo(x, y - runnerH * 0.65);
    c.lineTo(x + armSwing + runnerW * 0.3, y - runnerH * 0.4);
    c.stroke();

    c.beginPath();
    c.moveTo(x, y - runnerH * 0.65);
    c.lineTo(x - armSwing - runnerW * 0.3, y - runnerH * 0.4);
    c.stroke();

    // Torso
    c.lineWidth = runnerW * 0.2;
    c.beginPath();
    c.moveTo(x, y - runnerH * 0.4);
    c.lineTo(x, y - runnerH * 0.75);
    c.stroke();

    // Head
    c.beginPath();
    c.arc(x, y - runnerH * 0.85, runnerW * 0.2, 0, Math.PI * 2);
    c.fillStyle = color;
    c.fill();

    c.globalAlpha = 1.0;

    // Name label
    if (name && (distAhead !== 0 || !isGhost)) {
      const fontSize = distAhead === 0 ? 11 : Math.max(8, 14 * scale * H / 400);
      c.font = `bold ${fontSize}px 'Rajdhani', sans-serif`;
      c.textAlign = 'center';

      // Background pill
      const tw = c.measureText(name).width + 10;
      c.fillStyle = 'rgba(0,0,0,0.6)';
      c.beginPath();
      this._roundRect(c, x - tw / 2, y - runnerH - 18, tw, 16, 4);
      c.fill();

      c.fillStyle = color;
      c.fillText(name, x, y - runnerH - 6);
    }

    // Distance delta (for ghosts)
    if (isGhost && distAhead !== 0) {
      const deltaM = Math.round(distAhead);
      const sign = deltaM > 0 ? '+' : '';
      const label = Math.abs(deltaM) >= 1000
        ? `${sign}${(deltaM / 1000).toFixed(1)}km`
        : `${sign}${deltaM}m`;

      const fontSize = Math.max(9, 12 * scale * H / 400);
      c.font = `${fontSize}px 'JetBrains Mono', monospace`;
      c.textAlign = 'center';
      c.fillStyle = deltaM > 0 ? '#ff6666' : '#66ff66';
      c.fillText(label, x, y - runnerH - 28);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HUD OVERLAY
  // ═══════════════════════════════════════════════════════════════════════════

  _drawHUD(c, W, H) {
    const pad = 15;

    // Semi-transparent HUD background strip
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(0, H - 55, W, 55);

    // Speed (bottom left)
    c.font = 'bold 28px "Orbitron", sans-serif';
    c.fillStyle = '#00ffcc';
    c.textAlign = 'left';
    const speedStr = this.runner.speedKmh.toFixed(1);
    c.fillText(speedStr, pad, H - pad - 16);
    c.font = '11px "Rajdhani", sans-serif';
    c.fillStyle = '#6688aa';
    c.fillText('km/h', pad, H - pad - 2);

    // Incline (bottom center-left)
    const incStr = (this.runner.incline >= 0 ? '+' : '') + this.runner.incline.toFixed(1) + '%';
    c.font = 'bold 22px "Orbitron", sans-serif';
    c.fillStyle = this.runner.incline > 5 ? '#ff8844' : this.runner.incline < -2 ? '#4488ff' : '#88aa88';
    c.textAlign = 'center';
    c.fillText(incStr, W * 0.25, H - pad - 16);
    c.font = '11px "Rajdhani", sans-serif';
    c.fillStyle = '#6688aa';
    c.fillText('GRADE', W * 0.25, H - pad - 2);

    // Power (bottom center)
    var power = this.runner.power || 0;
    if (power > 0) {
      c.font = 'bold 22px "Orbitron", sans-serif';
      c.fillStyle = power > 300 ? '#ff6644' : power > 200 ? '#ffaa00' : '#00ddff';
      c.textAlign = 'center';
      c.fillText(power.toString(), W * 0.5, H - pad - 16);
      c.font = '11px "Rajdhani", sans-serif';
      c.fillStyle = '#6688aa';
      c.fillText('WATTS', W * 0.5, H - pad - 2);
    }

    // Elapsed time (bottom center-right)
    var elapsed = this.runner.elapsed || 0;
    if (elapsed > 0) {
      var eh = Math.floor(elapsed / 3600);
      var em = Math.floor((elapsed % 3600) / 60);
      var es = Math.floor(elapsed % 60);
      var timeStr = eh > 0
        ? eh + ':' + String(em).padStart(2, '0') + ':' + String(es).padStart(2, '0')
        : String(em).padStart(2, '0') + ':' + String(es).padStart(2, '0');
      c.font = 'bold 20px "Orbitron", sans-serif';
      c.fillStyle = '#aaccee';
      c.textAlign = 'center';
      c.fillText(timeStr, W * 0.75, H - pad - 16);
      c.font = '11px "Rajdhani", sans-serif';
      c.fillStyle = '#6688aa';
      c.fillText('TIME', W * 0.75, H - pad - 2);
    }

    // HR (bottom right)
    if (this.runner.hr > 0) {
      c.font = 'bold 24px "Orbitron", sans-serif';
      c.fillStyle = '#ff4466';
      c.textAlign = 'right';
      c.fillText(this.runner.hr.toString(), W - pad, H - pad - 16);
      c.font = '11px "Rajdhani", sans-serif';
      c.fillStyle = '#6688aa';
      c.fillText('BPM', W - pad, H - pad - 2);
    }

    // Distance (top right)
    c.font = 'bold 16px "Orbitron", sans-serif';
    c.fillStyle = '#aaccee';
    c.textAlign = 'right';
    c.fillText(this.runner.distKm.toFixed(2) + ' km', W - pad, pad + 20);

    // Drift / EF (below distance, top right)
    var drift = this.runner.driftPct || 0;
    var ef = this.runner.ef || 0;
    if (drift > 0 || ef > 0) {
      var topY = pad + 36;
      c.font = '11px "JetBrains Mono", monospace';
      c.textAlign = 'right';
      if (ef > 0) {
        c.fillStyle = ef >= 1.8 ? '#69f0ae' : ef >= 1.5 ? '#3ecfff' : ef >= 1.2 ? '#ffb74d' : '#ff5f5f';
        c.fillText('EF ' + ef.toFixed(2), W - pad, topY);
        topY += 14;
      }
      if (drift > 0) {
        c.fillStyle = drift < 3 ? '#69f0ae' : drift < 5 ? '#3ecfff' : drift < 8 ? '#ffb74d' : '#ff5f5f';
        c.fillText('DRIFT ' + drift.toFixed(1) + '%', W - pad, topY);
      }
    }

    // Ghost summary (top left)
    if (this.ghosts.length > 0) {
      c.textAlign = 'left';
      var ty = pad + 15;
      for (var gi = 0; gi < this.ghosts.length; gi++) {
        var ghost = this.ghosts[gi];
        var deltaM = Math.round((ghost.distKm - this.runner.distKm) * 1000);
        var sign = deltaM > 0 ? '+' : '';
        var label = Math.abs(deltaM) >= 1000
          ? sign + (deltaM / 1000).toFixed(1) + 'km'
          : sign + deltaM + 'm';

        c.font = '11px "JetBrains Mono", monospace';
        c.fillStyle = ghost.color || '#9966ff';
        c.fillText(ghost.name + ': ' + label, pad, ty);
        ty += 16;
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSPECTIVE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _perspY(dist, horizonY, H) {
    // Map distance to screen Y (horizon at top, bottom at viewer)
    const t = 1 / (1 + dist * 0.008);
    return horizonY + (H - horizonY) * (1 - t);
  },

  _perspScale(dist) {
    return 1 / (1 + dist * 0.008);
  },

  /** Rounded rectangle polyfill (Chrome 83 lacks CanvasRenderingContext2D.roundRect). */
  _roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
    c.closePath();
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DUST PARTICLES — kicked up behind the runner
  // ═══════════════════════════════════════════════════════════════════════════

  _dustParticles: [],
  _lastDustSpawn: 0,

  _drawDust: function(c, W, H, time) {
    var speed = this.runner.speedKmh;
    if (speed < 2) {
      this._dustParticles = [];
      return;
    }

    // Spawn new particles
    var now = Date.now();
    var spawnRate = Math.max(30, 150 - speed * 8); // faster = more particles
    if (now - this._lastDustSpawn > spawnRate) {
      this._lastDustSpawn = now;
      var cx = W / 2;
      var baseY = H * 0.85;
      this._dustParticles.push({
        x: cx + (Math.random() - 0.5) * 20,
        y: baseY + Math.random() * 5,
        vx: (Math.random() - 0.5) * 2,
        vy: -0.5 - Math.random() * 1.5,
        life: 1.0,
        size: 1.5 + Math.random() * 2,
      });
    }

    // Update and draw
    for (var i = this._dustParticles.length - 1; i >= 0; i--) {
      var p = this._dustParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.03; // gravity
      p.life -= 0.025;

      if (p.life <= 0) {
        this._dustParticles.splice(i, 1);
        continue;
      }

      c.globalAlpha = p.life * 0.4;
      c.fillStyle = '#aa9977';
      c.beginPath();
      c.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1.0;

    // Cap particle count
    while (this._dustParticles.length > 40) this._dustParticles.shift();
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MINI ELEVATION PROFILE — bottom-center sparkline
  // ═══════════════════════════════════════════════════════════════════════════

  _drawMiniElevation: function(c, W, H) {
    if (!this._elevSlice.length || this._elevSlice.length < 3) return;

    var profW = 120;
    var profH = 30;
    var profX = W / 2 - profW / 2;
    var profY = H - 70; // above the HUD bar

    // Find elevation range in the slice
    var minElev = Infinity;
    var maxElev = -Infinity;
    for (var i = 0; i < this._elevSlice.length; i++) {
      if (this._elevSlice[i].elev < minElev) minElev = this._elevSlice[i].elev;
      if (this._elevSlice[i].elev > maxElev) maxElev = this._elevSlice[i].elev;
    }
    var elevRange = maxElev - minElev;
    if (elevRange < 2) elevRange = 2; // minimum scale

    // Semi-transparent background
    c.save();
    c.globalAlpha = 0.3;
    c.fillStyle = '#000000';
    c.beginPath();
    this._roundRect(c, profX - 5, profY - 5, profW + 10, profH + 15, 4);
    c.fill();
    c.restore();

    // Draw elevation profile line
    c.strokeStyle = 'rgba(100,200,150,0.6)';
    c.lineWidth = 1.5;
    c.beginPath();

    var minDist = this._elevSlice[0].dist;
    var maxDist = this._elevSlice[this._elevSlice.length - 1].dist;
    var distRange = maxDist - minDist;
    if (distRange <= 0) return;

    for (var j = 0; j < this._elevSlice.length; j++) {
      var xFrac = (this._elevSlice[j].dist - minDist) / distRange;
      var yFrac = 1 - (this._elevSlice[j].elev - minElev) / elevRange;
      var px = profX + xFrac * profW;
      var py = profY + yFrac * profH;
      if (j === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();

    // Fill below the line
    c.lineTo(profX + profW, profY + profH);
    c.lineTo(profX, profY + profH);
    c.closePath();
    c.fillStyle = 'rgba(100,200,150,0.1)';
    c.fill();

    // Runner position marker (vertical line)
    var runnerFrac = (this.runner.distKm - minDist) / distRange;
    if (runnerFrac >= 0 && runnerFrac <= 1) {
      var runnerX = profX + runnerFrac * profW;
      c.strokeStyle = '#00ff88';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(runnerX, profY);
      c.lineTo(runnerX, profY + profH);
      c.stroke();
    }

    // "ELEV" label
    c.font = '8px "JetBrains Mono", monospace';
    c.fillStyle = 'rgba(150,200,180,0.5)';
    c.textAlign = 'center';
    c.fillText('ELEVATION', profX + profW / 2, profY + profH + 10);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIME-OF-DAY SKY SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  // Time-of-day presets: each defines sky colors, star visibility, ground tint
  _TOD_PRESETS: [
    // hour 0-5: Night
    { skyTop: '#050d1a', skyMid: '#0a1628', skyHorizon: '#1a2a44',
      starAlpha: 0.5, sunY: -1, sunColor: null,
      groundNear: '#1a2820', groundFar: '#0a1010', treeTint: [15, 40, 25],
      fogAlpha: 0.0, cloudTint: [30, 40, 60] },
    // hour 5-6: Pre-dawn
    { skyTop: '#0a1628', skyMid: '#1a2040', skyHorizon: '#3a2540',
      starAlpha: 0.25, sunY: 0.95, sunColor: '#ff6040',
      groundNear: '#2a2828', groundFar: '#1a1515', treeTint: [20, 35, 30],
      fogAlpha: 0.05, cloudTint: [80, 50, 60] },
    // hour 6-7: Dawn
    { skyTop: '#1a2848', skyMid: '#3a3050', skyHorizon: '#cc6644',
      starAlpha: 0.05, sunY: 0.8, sunColor: '#ff8844',
      groundNear: '#3a4030', groundFar: '#2a2018', treeTint: [30, 50, 25],
      fogAlpha: 0.08, cloudTint: [200, 120, 80] },
    // hour 7-9: Morning golden
    { skyTop: '#2a5088', skyMid: '#5a88bb', skyHorizon: '#ddaa66',
      starAlpha: 0, sunY: 0.5, sunColor: '#ffcc44',
      groundNear: '#3a5530', groundFar: '#1a2818', treeTint: [25, 60, 28],
      fogAlpha: 0.03, cloudTint: [220, 200, 160] },
    // hour 9-14: Midday
    { skyTop: '#2266aa', skyMid: '#4488cc', skyHorizon: '#88bbdd',
      starAlpha: 0, sunY: 0.15, sunColor: '#ffffcc',
      groundNear: '#4a6840', groundFar: '#2a3820', treeTint: [30, 70, 30],
      fogAlpha: 0.02, cloudTint: [240, 240, 250] },
    // hour 14-17: Afternoon
    { skyTop: '#2060a0', skyMid: '#4488bb', skyHorizon: '#ccaa77',
      starAlpha: 0, sunY: 0.4, sunColor: '#ffdd66',
      groundNear: '#4a6035', groundFar: '#2a3520', treeTint: [30, 60, 25],
      fogAlpha: 0.03, cloudTint: [230, 210, 170] },
    // hour 17-19: Sunset
    { skyTop: '#1a3060', skyMid: '#553355', skyHorizon: '#dd5533',
      starAlpha: 0.05, sunY: 0.8, sunColor: '#ff5522',
      groundNear: '#3a3528', groundFar: '#2a1818', treeTint: [35, 40, 20],
      fogAlpha: 0.06, cloudTint: [220, 100, 60] },
    // hour 19-21: Dusk
    { skyTop: '#0a1628', skyMid: '#1a2040', skyHorizon: '#332244',
      starAlpha: 0.3, sunY: 0.95, sunColor: '#cc4444',
      groundNear: '#222820', groundFar: '#101510', treeTint: [18, 35, 25],
      fogAlpha: 0.04, cloudTint: [50, 40, 70] },
    // hour 21-24: Night
    { skyTop: '#050d1a', skyMid: '#0a1628', skyHorizon: '#1a2a44',
      starAlpha: 0.5, sunY: -1, sunColor: null,
      groundNear: '#1a2820', groundFar: '#0a1010', treeTint: [15, 40, 25],
      fogAlpha: 0.0, cloudTint: [30, 40, 60] },
  ],

  // Hour boundaries for each preset
  _TOD_HOURS: [0, 5, 6, 7, 9, 14, 17, 19, 21],

  /** Get interpolated time-of-day data based on current local time. */
  _getTimeOfDay: function() {
    var now = new Date();
    var hour = now.getHours() + now.getMinutes() / 60;

    // Find which two presets to lerp between
    var presets = this._TOD_PRESETS;
    var hours = this._TOD_HOURS;
    var idx = 0;
    for (var i = hours.length - 1; i >= 0; i--) {
      if (hour >= hours[i]) { idx = i; break; }
    }
    var nextIdx = (idx + 1) % presets.length;
    var nextHour = (nextIdx < hours.length) ? hours[nextIdx] : 24;
    var rangeLen = nextHour - hours[idx];
    if (rangeLen <= 0) rangeLen = 24;
    var t = (hour - hours[idx]) / rangeLen;
    t = Math.max(0, Math.min(1, t));

    var a = presets[idx];
    var b = presets[nextIdx];

    return {
      skyTop: this._lerpColor(a.skyTop, b.skyTop, t),
      skyMid: this._lerpColor(a.skyMid, b.skyMid, t),
      skyHorizon: this._lerpColor(a.skyHorizon, b.skyHorizon, t),
      starAlpha: a.starAlpha + (b.starAlpha - a.starAlpha) * t,
      sunY: a.sunY + (b.sunY - a.sunY) * t,
      sunColor: a.sunColor || b.sunColor,
      groundNear: this._lerpColor(a.groundNear, b.groundNear, t),
      groundFar: this._lerpColor(a.groundFar, b.groundFar, t),
      treeTint: [
        Math.round(a.treeTint[0] + (b.treeTint[0] - a.treeTint[0]) * t),
        Math.round(a.treeTint[1] + (b.treeTint[1] - a.treeTint[1]) * t),
        Math.round(a.treeTint[2] + (b.treeTint[2] - a.treeTint[2]) * t),
      ],
      fogAlpha: a.fogAlpha + (b.fogAlpha - a.fogAlpha) * t,
      cloudTint: [
        Math.round(a.cloudTint[0] + (b.cloudTint[0] - a.cloudTint[0]) * t),
        Math.round(a.cloudTint[1] + (b.cloudTint[1] - a.cloudTint[1]) * t),
        Math.round(a.cloudTint[2] + (b.cloudTint[2] - a.cloudTint[2]) * t),
      ],
    };
  },

  /** Draw the sky with gradient, stars, sun/moon, and horizon glow. */
  _drawSky: function(c, W, horizonY, tod, time) {
    // Sky gradient (3-stop)
    var skyGrad = c.createLinearGradient(0, 0, 0, horizonY);
    skyGrad.addColorStop(0, tod.skyTop);
    skyGrad.addColorStop(0.5, tod.skyMid);
    skyGrad.addColorStop(1, tod.skyHorizon);
    c.fillStyle = skyGrad;
    c.fillRect(0, 0, W, horizonY);

    // Stars (visible at night/dusk/dawn)
    if (tod.starAlpha > 0.02) {
      c.fillStyle = 'rgba(255,255,255,' + tod.starAlpha + ')';
      var rng = this._rng(7);
      for (var i = 0; i < 50; i++) {
        var sx = rng() * W;
        var sy = rng() * horizonY * 0.7;
        var sr = rng() * 1.5 + 0.3;
        // Twinkle
        var twinkle = 0.6 + 0.4 * Math.sin(time * 1.5 + i * 3.7);
        c.globalAlpha = tod.starAlpha * twinkle;
        c.beginPath();
        c.arc(sx, sy, sr, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1.0;
    }

    // Sun or moon
    if (tod.sunColor && tod.sunY > 0 && tod.sunY < 1) {
      var sunCenterX = W * 0.7;
      var sunCenterY = horizonY * tod.sunY;
      var sunRadius = 20;

      // Glow around sun
      var glowGrad = c.createRadialGradient(sunCenterX, sunCenterY, sunRadius * 0.5,
                                             sunCenterX, sunCenterY, sunRadius * 4);
      glowGrad.addColorStop(0, this._hexToRgba(tod.sunColor, 0.3));
      glowGrad.addColorStop(1, this._hexToRgba(tod.sunColor, 0));
      c.fillStyle = glowGrad;
      c.fillRect(sunCenterX - sunRadius * 4, sunCenterY - sunRadius * 4,
                 sunRadius * 8, sunRadius * 8);

      // Sun disc
      c.beginPath();
      c.arc(sunCenterX, sunCenterY, sunRadius, 0, Math.PI * 2);
      c.fillStyle = tod.sunColor;
      c.fill();
    }

    // Horizon haze (fog)
    if (tod.fogAlpha > 0) {
      var hazeGrad = c.createLinearGradient(0, horizonY - 30, 0, horizonY + 10);
      hazeGrad.addColorStop(0, 'rgba(255,255,255,0)');
      hazeGrad.addColorStop(1, 'rgba(255,255,255,' + tod.fogAlpha + ')');
      c.fillStyle = hazeGrad;
      c.fillRect(0, horizonY - 30, W, 40);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CLOUD SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  _generateClouds: function() {
    this._clouds = [];
    var rng = this._rng(99);
    for (var i = 0; i < 8; i++) {
      this._clouds.push({
        x: rng() * 1.4 - 0.2,  // normalized x (-0.2 to 1.2)
        y: rng() * 0.5,         // normalized y in sky
        w: 60 + rng() * 120,    // cloud width
        h: 15 + rng() * 25,     // cloud height
        speed: 0.002 + rng() * 0.005, // drift speed (normalized/sec)
        puffs: 3 + Math.floor(rng() * 4), // number of sub-circles
      });
    }
  },

  _drawClouds: function(c, W, horizonY, time, tod) {
    if (!this._clouds.length) return;
    var ct = tod.cloudTint;
    var alpha = tod.starAlpha > 0.3 ? 0.08 : 0.2; // dimmer at night

    for (var i = 0; i < this._clouds.length; i++) {
      var cloud = this._clouds[i];

      // Drift clouds slowly
      cloud.x += cloud.speed * 0.001;
      if (cloud.x > 1.3) cloud.x = -0.3;

      var cx = cloud.x * W;
      var cy = cloud.y * horizonY;
      var cw = cloud.w;
      var ch = cloud.h;

      c.save();
      c.globalAlpha = alpha;
      c.fillStyle = 'rgb(' + ct[0] + ',' + ct[1] + ',' + ct[2] + ')';

      // Draw cloud as overlapping ellipses
      for (var p = 0; p < cloud.puffs; p++) {
        var px = cx + (p - cloud.puffs / 2) * (cw / cloud.puffs) * 0.8;
        var py = cy + Math.sin(p * 1.3) * ch * 0.2;
        var pr = ch * (0.6 + Math.sin(p * 2.1) * 0.3);
        var pw = cw / cloud.puffs * 1.2;
        c.beginPath();
        c.ellipse(px, py, pw, pr, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // COLOR UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  /** Linearly interpolate between two hex colors. */
  _lerpColor: function(a, b, t) {
    var ar = parseInt(a.slice(1, 3), 16);
    var ag = parseInt(a.slice(3, 5), 16);
    var ab = parseInt(a.slice(5, 7), 16);
    var br = parseInt(b.slice(1, 3), 16);
    var bg = parseInt(b.slice(3, 5), 16);
    var bb = parseInt(b.slice(5, 7), 16);
    var rr = Math.round(ar + (br - ar) * t);
    var rg = Math.round(ag + (bg - ag) * t);
    var rb = Math.round(ab + (bb - ab) * t);
    return '#' + ((1 << 24) + (rr << 16) + (rg << 8) + rb).toString(16).slice(1);
  },

  /** Shift a hex color by RGB deltas. */
  _shiftColor: function(hex, dr, dg, db) {
    var r = Math.max(0, Math.min(255, parseInt(hex.slice(1, 3), 16) + dr));
    var g = Math.max(0, Math.min(255, parseInt(hex.slice(3, 5), 16) + dg));
    var b = Math.max(0, Math.min(255, parseInt(hex.slice(5, 7), 16) + db));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  },

  /** Convert hex to rgba string. */
  _hexToRgba: function(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  },
};
