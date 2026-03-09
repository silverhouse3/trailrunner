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

  // Ghost runners
  ghosts: [],         // [{ name, distKm, color, pace }]

  // Runner position
  runner: {
    distKm: 0,
    speedKmh: 0,
    incline: 0,
    hr: 0,
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

    // ── Sky gradient ─────────────────────────────────────────────
    const skyGrad = c.createLinearGradient(0, 0, 0, horizonY);
    skyGrad.addColorStop(0, '#0a1628');
    skyGrad.addColorStop(0.5, '#162640');
    skyGrad.addColorStop(1, '#2a4a70');
    c.fillStyle = skyGrad;
    c.fillRect(0, 0, W, horizonY);

    // ── Stars (subtle) ───────────────────────────────────────────
    c.fillStyle = 'rgba(255,255,255,0.3)';
    const rng = this._rng(7);
    for (let i = 0; i < 40; i++) {
      const x = rng() * W;
      const y = rng() * horizonY * 0.7;
      const r = rng() * 1.2;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }

    // ── Ground gradient ──────────────────────────────────────────
    const grade = this.runner.incline;
    const groundColor = grade > 5 ? '#2a3020' : grade < -2 ? '#1a2535' : '#1a2820';
    const gndGrad = c.createLinearGradient(0, horizonY, 0, H);
    gndGrad.addColorStop(0, '#3a5040');
    gndGrad.addColorStop(0.3, groundColor);
    gndGrad.addColorStop(1, '#0a1010');
    c.fillStyle = gndGrad;
    c.fillRect(0, horizonY, W, H - horizonY);

    // ── Road ─────────────────────────────────────────────────────
    this._drawRoad(c, W, H, horizonY);

    // ── Trees ────────────────────────────────────────────────────
    this._drawTrees(c, W, H, horizonY, time);

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

  _drawTrees(c, W, H, horizonY, time) {
    const cx = W / 2;
    const runnerDist = this.runner.distKm * 1000;

    for (const tree of this.trees) {
      // Tree position relative to runner
      const d = ((tree.distAlong - (runnerDist % 500)) + 500) % 500;
      if (d < 5 || d > this.cam.viewDist) continue;

      const scale = this._perspScale(d);
      const y = this._perspY(d, horizonY, H);
      const x = cx + tree.side * tree.offset * scale * W * 0.08;
      const h = tree.height * scale * H * 0.15;

      if (tree.type === 'pine') {
        // Pine tree (triangle)
        c.fillStyle = `rgba(20,${50 + Math.floor(d / 5)},30,${0.8 - d / 700})`;
        c.beginPath();
        c.moveTo(x, y - h);
        c.lineTo(x - h * 0.3, y);
        c.lineTo(x + h * 0.3, y);
        c.closePath();
        c.fill();
        // Trunk
        c.fillStyle = `rgba(60,40,20,${0.7 - d / 700})`;
        c.fillRect(x - h * 0.04, y, h * 0.08, h * 0.15);
      } else {
        // Bush (circle)
        c.fillStyle = `rgba(30,${60 + Math.floor(d / 5)},25,${0.6 - d / 700})`;
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
      c.roundRect(x - tw / 2, y - runnerH - 18, tw, 16, 4);
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

    // Speed (bottom left)
    c.font = 'bold 28px "Orbitron", sans-serif';
    c.fillStyle = '#00ffcc';
    c.textAlign = 'left';
    const speedStr = this.runner.speedKmh.toFixed(1);
    c.fillText(speedStr, pad, H - pad - 20);
    c.font = '12px "Rajdhani", sans-serif';
    c.fillStyle = '#6688aa';
    c.fillText('km/h', pad, H - pad - 5);

    // Incline (bottom center-left)
    const incStr = (this.runner.incline >= 0 ? '+' : '') + this.runner.incline.toFixed(1) + '%';
    c.font = 'bold 22px "Orbitron", sans-serif';
    c.fillStyle = this.runner.incline > 5 ? '#ff8844' : this.runner.incline < -2 ? '#4488ff' : '#88aa88';
    c.textAlign = 'center';
    c.fillText(incStr, W * 0.25, H - pad - 20);
    c.font = '12px "Rajdhani", sans-serif';
    c.fillStyle = '#6688aa';
    c.fillText('GRADE', W * 0.25, H - pad - 5);

    // HR (bottom right)
    if (this.runner.hr > 0) {
      c.font = 'bold 24px "Orbitron", sans-serif';
      c.fillStyle = '#ff4466';
      c.textAlign = 'right';
      c.fillText(this.runner.hr.toString(), W - pad, H - pad - 20);
      c.font = '12px "Rajdhani", sans-serif';
      c.fillStyle = '#6688aa';
      c.fillText('BPM', W - pad, H - pad - 5);
    }

    // Distance (top right)
    c.font = 'bold 16px "Orbitron", sans-serif';
    c.fillStyle = '#aaccee';
    c.textAlign = 'right';
    c.fillText(this.runner.distKm.toFixed(2) + ' km', W - pad, pad + 20);

    // Ghost summary (top left)
    if (this.ghosts.length > 0) {
      c.textAlign = 'left';
      let ty = pad + 15;
      for (const ghost of this.ghosts) {
        const deltaM = Math.round((ghost.distKm - this.runner.distKm) * 1000);
        const sign = deltaM > 0 ? '+' : '';
        const label = Math.abs(deltaM) >= 1000
          ? `${sign}${(deltaM / 1000).toFixed(1)}km`
          : `${sign}${deltaM}m`;

        c.font = '11px "JetBrains Mono", monospace';
        c.fillStyle = ghost.color || '#9966ff';
        c.fillText(`${ghost.name}: ${label}`, pad, ty);
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
};
