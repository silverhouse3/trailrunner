// ════════════════════════════════════════════════════════════════════════════
// OvalTrack — Pac-Man oval track renderer
//
// Renders a colour-coded oval racetrack with:
//   - Pac-Man runner with animated chomp
//   - Ghost runner with delta display
//   - Segment progress and tick marks
//   - HR zone gauge widget
//   - Distance info overlay (segment / total modes)
//
// Target: 1920x1080 NordicTrack X32i, Chrome on Android 7.1.2
// ════════════════════════════════════════════════════════════════════════════

var OvalTrack = {

  // ── State ──────────────────────────────────────────────────────────────────
  canvas: null,
  ctx: null,
  active: false,
  _anim: null,

  // ── Colour constants ───────────────────────────────────────────────────────
  COLORS: {
    bg:            '#0a1628',
    trackBase:     'rgba(30,48,80,0.3)',
    trackConsumed: 'rgba(30,48,80,0.15)',
    pacman:        '#fbbf24',
    ghost:         'rgba(255,255,255,0.3)',
    text:          '#e8f0ff',
    textDim:       '#5a7899',
    textMid:       '#8094ab',
    cyan:          '#00d4ff',
    green:         '#00d4aa',
    orange:        '#f59e0b',
    red:           '#ef4444',
    easy:          '#22c55e',
    moderate:      '#00d4aa',
    steady:        '#f59e0b',
    tempo:         '#f97316',
    hard:          '#ef4444',
    z1: '#6b7280', z2: '#22c55e', z3: '#fbbf24', z4: '#f97316', z5: '#ef4444',
  },

  // ── Track geometry cache ───────────────────────────────────────────────────
  _geo: null,  // { cx, cy, rx, ry, perimeter, straightLen, semiCirc }

  // ── Segments ───────────────────────────────────────────────────────────────
  _segments: [],       // [{distance, speed, incline, colour}]
  _totalDistance: 0,

  // ── Bookends ───────────────────────────────────────────────────────────────
  _warmFrac: 0,
  _coolFrac: 0,

  // ── Runner state ───────────────────────────────────────────────────────────
  _progress: 0,        // 0-1 fraction around track
  _speedKph: 0,

  // ── Ghost state ────────────────────────────────────────────────────────────
  _ghostProgress: 0,
  _ghostDelta: 0,      // seconds, positive = ahead

  // ── HR state ───────────────────────────────────────────────────────────────
  _hrBpm: 0,
  _hrMax: 190,
  _hrZoneColour: null,

  // ── Distance display state ─────────────────────────────────────────────────
  _distMode: 'segment',  // 'segment' or 'total'
  _distFadeTime: 0,      // timestamp when display was last updated
  _segInfo: null,         // {idx, total, label, remaining, unit}
  _totalDistInfo: null,   // {covered, total, unit}

  // ── Pac-Man game elements ─────────────────────────────────────────────────
  _dots: [],              // [{frac, eaten}] — pellets on the track
  _powerDots: [],         // [{frac, eaten}] — large power pellets (4 per lap)
  _eatenGhosts: [],       // [{frac, time, points}] — ghost eat score popups
  _dotsInitialized: false,
  _powerMode: false,      // flashing ghosts mode
  _powerModeEnd: 0,
  _score: 0,
  _arcadeGhosts: [],      // [{frac, color, name, scared}] — roaming ghosts

  // ── Config ─────────────────────────────────────────────────────────────────
  config: {
    showPacMan:      true,
    showGhost:       true,
    showHRGauge:     true,
    showDistanceInfo: true,
    showDots:        true,
    showArcadeGhosts: true,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════════

  init: function(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
  },

  show: function() {
    if (!this.canvas) return;
    this.active = true;
    this.canvas.style.display = 'block';
    this._resize();
    this._computeGeometry();
    this._initDots();
    this._initArcadeGhosts();
    this._startLoop();
  },

  hide: function() {
    this.active = false;
    if (this.canvas) this.canvas.style.display = 'none';
    if (this._anim) {
      cancelAnimationFrame(this._anim);
      this._anim = null;
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DATA API
  // ════════════════════════════════════════════════════════════════════════════

  setSegments: function(segments) {
    this._segments = segments || [];
    this._totalDistance = 0;
    for (var i = 0; i < this._segments.length; i++) {
      this._totalDistance += this._segments[i].distance || 0;
    }
  },

  setBookends: function(warmFrac, coolFrac) {
    this._warmFrac = Math.max(0, Math.min(1, warmFrac || 0));
    this._coolFrac = Math.max(0, Math.min(1, coolFrac || 0));
  },

  setProgress: function(fraction) {
    this._progress = Math.max(0, Math.min(1, fraction || 0));
    this._distFadeTime = Date.now();
  },

  setSpeedKph: function(kph) {
    this._speedKph = kph || 0;
  },

  setGhostProgress: function(fraction) {
    this._ghostProgress = Math.max(0, Math.min(1, fraction || 0));
  },

  setGhostDelta: function(seconds) {
    this._ghostDelta = seconds || 0;
  },

  setHR: function(bpm, maxHR) {
    this._hrBpm = bpm || 0;
    if (maxHR) this._hrMax = maxHR;
  },

  setHRZoneColour: function(colour) {
    this._hrZoneColour = colour || null;
  },

  // ── Distance display API ───────────────────────────────────────────────────

  setSegmentInfo: function(idx, total, label, remaining, unit) {
    this._segInfo = { idx: idx, total: total, label: label, remaining: remaining, unit: unit || 'mi' };
    this._distFadeTime = Date.now();
  },

  setTotalDistance: function(covered, total, unit) {
    this._totalDistInfo = { covered: covered, total: total, unit: unit || 'mi' };
    this._distFadeTime = Date.now();
  },

  toggleDistanceMode: function() {
    this._distMode = (this._distMode === 'segment') ? 'total' : 'segment';
    this._distFadeTime = Date.now();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RESIZE + GEOMETRY
  // ════════════════════════════════════════════════════════════════════════════

  _resize: function() {
    if (!this.canvas) return;
    // Use offsetWidth/Height to get pre-transform logical size
    // (getBoundingClientRect returns post-transform scaled size which is wrong
    // when rootApp uses CSS transform: scale())
    var parent = this.canvas.parentElement;
    var w = parent.offsetWidth || parent.clientWidth || 1280;
    var h = parent.offsetHeight || parent.clientHeight || 534;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this._computeGeometry();
  },

  _computeGeometry: function() {
    if (!this.canvas) return;
    var W = this.canvas.width;
    var H = this.canvas.height;

    // Track fills most of the canvas, leaving room for score/gauge at bottom
    var padX = W * 0.06;
    var padY = H * 0.05;
    var trackH = H * 0.78;

    var cx = W / 2;
    var cy = padY + trackH / 2;

    // Semi-axis lengths: rx is half the straight + semicircle radius,
    // ry is the semicircle radius
    var ry = trackH / 2 - 12;  // slight inset for stroke
    var rx = (W - padX * 2) / 2 - 12;

    // Perimeter of the oval (stadium shape):
    // two straights of length 2*(rx - ry) plus two semicircles of radius ry
    var straightLen = Math.max(0, (rx - ry) * 2);
    var semiCirc = Math.PI * ry;
    var perimeter = straightLen * 2 + semiCirc * 2;

    this._geo = {
      cx: cx,
      cy: cy,
      rx: rx,
      ry: ry,
      straightLen: straightLen,
      semiCirc: semiCirc,
      perimeter: perimeter,
      halfStraight: straightLen / 2,
    };
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TRACK PARAMETRIC — Map fraction [0,1] to (x,y) on the oval
  //
  // Clockwise from top-center:
  //   Segment 1: Top straight  (left to right)   — length = straightLen
  //   Segment 2: Right semicircle (top to bottom) — length = semiCirc
  //   Segment 3: Bottom straight (right to left)  — length = straightLen
  //   Segment 4: Left semicircle (bottom to top)  — length = semiCirc
  // ════════════════════════════════════════════════════════════════════════════

  _fracToPoint: function(frac) {
    var g = this._geo;
    if (!g) return { x: 0, y: 0, angle: 0 };

    // Normalise
    frac = ((frac % 1) + 1) % 1;
    var dist = frac * g.perimeter;

    var x, y, angle;
    var hs = g.halfStraight;

    if (dist < g.straightLen) {
      // Top straight: left to right
      // Starts at (cx - hs, cy - ry), ends at (cx + hs, cy - ry)
      var t = dist / g.straightLen;
      x = g.cx - hs + t * g.straightLen;
      y = g.cy - g.ry;
      angle = 0; // moving right
    } else if (dist < g.straightLen + g.semiCirc) {
      // Right semicircle: clockwise from top to bottom
      var arcDist = dist - g.straightLen;
      var theta = (arcDist / g.semiCirc) * Math.PI; // 0 to PI
      x = g.cx + hs + Math.sin(theta) * g.ry;
      y = g.cy - Math.cos(theta) * g.ry;
      angle = theta; // tangent direction
    } else if (dist < g.straightLen * 2 + g.semiCirc) {
      // Bottom straight: right to left
      var lineDist = dist - g.straightLen - g.semiCirc;
      var t2 = lineDist / g.straightLen;
      x = g.cx + hs - t2 * g.straightLen;
      y = g.cy + g.ry;
      angle = Math.PI; // moving left
    } else {
      // Left semicircle: clockwise from bottom to top
      var arcDist2 = dist - g.straightLen * 2 - g.semiCirc;
      var theta2 = (arcDist2 / g.semiCirc) * Math.PI; // 0 to PI
      x = g.cx - hs - Math.sin(theta2) * g.ry;
      y = g.cy + Math.cos(theta2) * g.ry;
      angle = Math.PI + theta2; // tangent direction
    }

    return { x: x, y: y, angle: angle };
  },

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER LOOP
  // ════════════════════════════════════════════════════════════════════════════

  _startLoop: function() {
    var self = this;
    var draw = function() {
      if (!self.active) return;
      self._render();
      self._anim = requestAnimationFrame(draw);
    };
    draw();
  },

  _render: function() {
    var c = this.ctx;
    var W = this.canvas.width;
    var H = this.canvas.height;
    if (!W || !H || !this._geo) return;

    var now = Date.now();

    // ── Clear ────────────────────────────────────────────────────────
    c.fillStyle = this.COLORS.bg;
    c.fillRect(0, 0, W, H);

    // ── Draw track layers ────────────────────────────────────────────
    this._drawTrackBase(c);
    this._drawBookends(c);
    this._drawSegments(c, now);
    this._drawConsumedTrail(c);
    this._drawTickMarks(c);

    // ── Pac-Man dot eating logic ──────────────────────────────────────
    this._checkDotEating();

    // ── Dots (behind characters) ───────────────────────────────────
    this._drawDots(c);

    // ── Ghost runner ─────────────────────────────────────────────────
    if (this.config.showGhost) {
      this._drawGhost(c);
    }

    // ── Arcade ghosts (Blinky, Pinky, Inky, Clyde) ─────────────────
    this._drawArcadeGhosts(c, now);

    // ── Pac-Man runner ───────────────────────────────────────────────
    this._drawPacMan(c, now);

    // ── Ghost eaten score popups ────────────────────────────────────
    this._drawEatenGhostScores(c, now);

    // ── Ghost delta text ─────────────────────────────────────────────
    if (this.config.showGhost && this._ghostDelta !== 0) {
      this._drawGhostDelta(c);
    }

    // ── Distance info (centre of track) ──────────────────────────────
    if (this.config.showDistanceInfo) {
      this._drawDistanceInfo(c, now);
    }

    // ── HR zone gauge ────────────────────────────────────────────────
    if (this.config.showHRGauge && this._hrBpm > 0) {
      this._drawHRGauge(c, W, H);
    }

    // ── Score display ──────────────────────────────────────────────
    this._drawScore(c, W, H);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TRACK BASE — dark grey oval stroke
  // ════════════════════════════════════════════════════════════════════════════

  _drawTrackBase: function(c) {
    c.strokeStyle = this.COLORS.trackBase;
    c.lineWidth = 24;
    c.lineCap = 'butt';
    this._strokeTrackArc(c, 0, 1);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOOKENDS — warm-up and cool-down arcs
  // ════════════════════════════════════════════════════════════════════════════

  _drawBookends: function(c) {
    if (this._warmFrac > 0) {
      c.strokeStyle = 'rgba(120,120,130,0.25)';
      c.lineWidth = 24;
      this._strokeTrackArc(c, 0, this._warmFrac);
    }
    if (this._coolFrac > 0) {
      c.strokeStyle = 'rgba(120,120,130,0.25)';
      c.lineWidth = 24;
      this._strokeTrackArc(c, 1 - this._coolFrac, 1);
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COLOUR-CODED SEGMENTS
  // ════════════════════════════════════════════════════════════════════════════

  _drawSegments: function(c, now) {
    if (!this._segments.length || this._totalDistance <= 0) return;

    var fracSoFar = 0;
    var currentSegIdx = this._getCurrentSegmentIndex();

    for (var i = 0; i < this._segments.length; i++) {
      var seg = this._segments[i];
      var segFrac = seg.distance / this._totalDistance;
      var startFrac = fracSoFar;
      var endFrac = fracSoFar + segFrac;

      // Subtle pulse on current segment
      var alpha = 1.0;
      if (i === currentSegIdx) {
        var pulse = 0.7 + 0.3 * Math.sin(now / 400);
        alpha = pulse;
      }

      c.save();
      c.globalAlpha = alpha;
      c.strokeStyle = seg.colour || this.COLORS.trackBase;
      c.lineWidth = 24;
      this._strokeTrackArc(c, startFrac, endFrac);
      c.restore();

      // Glow on current segment
      if (i === currentSegIdx) {
        var glowAlpha = 0.15 + 0.1 * Math.sin(now / 400);
        c.save();
        c.globalAlpha = glowAlpha;
        c.strokeStyle = seg.colour || this.COLORS.cyan;
        c.lineWidth = 36;
        this._strokeTrackArc(c, startFrac, endFrac);
        c.restore();
      }

      fracSoFar = endFrac;
    }
  },

  _getCurrentSegmentIndex: function() {
    if (!this._segments.length || this._totalDistance <= 0) return -1;
    var fracSoFar = 0;
    for (var i = 0; i < this._segments.length; i++) {
      var segFrac = this._segments[i].distance / this._totalDistance;
      if (this._progress >= fracSoFar && this._progress < fracSoFar + segFrac) {
        return i;
      }
      fracSoFar += segFrac;
    }
    return this._segments.length - 1;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONSUMED TRAIL — darkened track behind Pac-Man
  // ════════════════════════════════════════════════════════════════════════════

  _drawConsumedTrail: function(c) {
    if (this._progress <= 0) return;

    var colour = this._hrZoneColour || this.COLORS.trackConsumed;
    c.strokeStyle = colour;
    c.lineWidth = 24;

    if (this._hrZoneColour) {
      c.save();
      c.globalAlpha = 0.4;
      this._strokeTrackArc(c, 0, this._progress);
      c.restore();
    } else {
      this._strokeTrackArc(c, 0, this._progress);
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TICK MARKS — white ticks at segment boundaries
  // ════════════════════════════════════════════════════════════════════════════

  _drawTickMarks: function(c) {
    if (!this._segments.length || this._totalDistance <= 0) return;

    var fracSoFar = 0;
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 2;

    for (var i = 0; i < this._segments.length - 1; i++) {
      fracSoFar += this._segments[i].distance / this._totalDistance;
      var pt = this._fracToPoint(fracSoFar);

      // Draw a short perpendicular tick
      var perpAngle = pt.angle + Math.PI / 2;
      var tickLen = 16;
      c.beginPath();
      c.moveTo(pt.x - Math.cos(perpAngle) * tickLen,
               pt.y - Math.sin(perpAngle) * tickLen);
      c.lineTo(pt.x + Math.cos(perpAngle) * tickLen,
               pt.y + Math.sin(perpAngle) * tickLen);
      c.stroke();
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // PAC-MAN RUNNER
  // ════════════════════════════════════════════════════════════════════════════

  _drawPacMan: function(c, now) {
    var pt = this._fracToPoint(this._progress);
    var radius = 16; // 32px diameter

    if (!this.config.showPacMan) {
      // Simple dot fallback
      c.beginPath();
      c.arc(pt.x, pt.y, radius * 0.6, 0, Math.PI * 2);
      c.fillStyle = this.COLORS.pacman;
      c.fill();
      return;
    }

    // Chomp animation speed tied to pace (mph)
    // 4 mph -> 600ms, 6 -> 400, 8 -> 300, 10+ -> 200
    var mph = this._speedKph * 0.621371;
    var cycleMs;
    if (mph <= 4)      cycleMs = 600;
    else if (mph <= 6) cycleMs = 600 - (mph - 4) * 100; // 600 -> 400
    else if (mph <= 8) cycleMs = 400 - (mph - 6) * 50;  // 400 -> 300
    else if (mph <= 10) cycleMs = 300 - (mph - 8) * 50; // 300 -> 200
    else               cycleMs = 200;
    cycleMs = Math.max(150, cycleMs);

    // Mouth angle: oscillate 0 to 45 degrees using sin wave
    var mouthAngle = (Math.PI / 4) * Math.abs(Math.sin(now / cycleMs * Math.PI));

    // Direction of travel (clockwise)
    var facing = pt.angle;

    c.save();
    c.fillStyle = this.COLORS.pacman;
    c.beginPath();
    // Draw Pac-Man as a circle with a wedge cut out
    c.arc(pt.x, pt.y, radius, facing + mouthAngle, facing + Math.PI * 2 - mouthAngle);
    c.lineTo(pt.x, pt.y);
    c.closePath();
    c.fill();

    // Eye
    var eyeX = pt.x + Math.cos(facing - 0.5) * radius * 0.45;
    var eyeY = pt.y + Math.sin(facing - 0.5) * radius * 0.45;
    c.beginPath();
    c.arc(eyeX, eyeY, 2.5, 0, Math.PI * 2);
    c.fillStyle = '#000';
    c.fill();
    c.restore();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GHOST RUNNER
  // ════════════════════════════════════════════════════════════════════════════

  _drawGhost: function(c) {
    var pt = this._fracToPoint(this._ghostProgress);

    c.save();
    c.globalAlpha = 0.3;
    c.beginPath();
    c.arc(pt.x, pt.y, 10, 0, Math.PI * 2); // 20px diameter
    c.fillStyle = '#ffffff';
    c.fill();
    c.restore();
  },

  _drawGhostDelta: function(c) {
    var pacPt = this._fracToPoint(this._progress);
    var secs = this._ghostDelta;
    var absSecs = Math.abs(secs);
    var mins = Math.floor(absSecs / 60);
    var s = Math.floor(absSecs % 60);
    var label;
    if (mins > 0) {
      label = (secs >= 0 ? '+' : '-') + mins + ':' + (s < 10 ? '0' : '') + s;
    } else {
      label = (secs >= 0 ? '+' : '-') + '0:' + (s < 10 ? '0' : '') + s;
    }

    var fontSize = 18;
    c.font = 'bold ' + fontSize + 'px "JetBrains Mono", monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = secs >= 0 ? this.COLORS.green : this.COLORS.red;
    c.fillText(label, pacPt.x, pacPt.y - 30);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DISTANCE INFO — centre of track
  // ════════════════════════════════════════════════════════════════════════════

  _drawDistanceInfo: function(c, now) {
    var g = this._geo;
    if (!g) return;

    // Auto-fade after 5 seconds
    var elapsed = now - this._distFadeTime;
    var alpha = 1.0;
    if (elapsed > 4000) {
      alpha = Math.max(0, 1.0 - (elapsed - 4000) / 1000);
    }
    if (alpha <= 0) return;

    c.save();
    c.globalAlpha = alpha;

    var cx = g.cx;
    var cy = g.cy;

    // Semi-transparent background
    var bgW = 280;
    var bgH = 100;
    c.fillStyle = 'rgba(10,22,40,0.75)';
    this._roundRect(c, cx - bgW / 2, cy - bgH / 2, bgW, bgH, 10);
    c.fill();

    if (this._distMode === 'segment' && this._segInfo) {
      var info = this._segInfo;

      // "SEG 2/5 . 7.0 MPH"
      c.font = 'bold 16px "JetBrains Mono", monospace';
      c.fillStyle = this.COLORS.cyan;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('SEG ' + info.idx + '/' + info.total + '  \u2022  ' + info.label, cx, cy - 28);

      // "0.3 mi remaining"
      c.font = '14px "Rajdhani", sans-serif';
      c.fillStyle = this.COLORS.textMid;
      c.fillText(info.remaining.toFixed(1) + ' ' + info.unit + ' remaining', cx, cy - 6);

      // Progress bar
      var barW = bgW - 40;
      var barH = 8;
      var barX = cx - barW / 2;
      var barY = cy + 16;
      var segProgress = 0;
      if (info.total > 0 && this._segments.length >= info.total) {
        var segStart = 0;
        for (var i = 0; i < info.idx - 1; i++) {
          segStart += this._segments[i].distance / this._totalDistance;
        }
        var segEnd = segStart + this._segments[info.idx - 1].distance / this._totalDistance;
        var segWidth = segEnd - segStart;
        segProgress = segWidth > 0 ? (this._progress - segStart) / segWidth : 0;
        segProgress = Math.max(0, Math.min(1, segProgress));
      }

      c.fillStyle = 'rgba(30,48,80,0.5)';
      this._roundRect(c, barX, barY, barW, barH, 4);
      c.fill();

      c.fillStyle = this.COLORS.cyan;
      this._roundRect(c, barX, barY, barW * segProgress, barH, 4);
      c.fill();

    } else if (this._distMode === 'total' && this._totalDistInfo) {
      var td = this._totalDistInfo;

      // "TOTAL DISTANCE"
      c.font = 'bold 13px "JetBrains Mono", monospace';
      c.fillStyle = this.COLORS.textDim;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('TOTAL DISTANCE', cx, cy - 30);

      // "3.4 / 5.0 mi"
      c.font = 'bold 22px "Orbitron", sans-serif';
      c.fillStyle = this.COLORS.text;
      c.fillText(td.covered.toFixed(1) + ' / ' + td.total.toFixed(1) + ' ' + td.unit, cx, cy - 4);

      // Progress bar
      var barW2 = bgW - 40;
      var barH2 = 8;
      var barX2 = cx - barW2 / 2;
      var barY2 = cy + 18;
      var totalProg = td.total > 0 ? td.covered / td.total : 0;
      totalProg = Math.max(0, Math.min(1, totalProg));

      c.fillStyle = 'rgba(30,48,80,0.5)';
      this._roundRect(c, barX2, barY2, barW2, barH2, 4);
      c.fill();

      c.fillStyle = this.COLORS.green;
      this._roundRect(c, barX2, barY2, barW2 * totalProg, barH2, 4);
      c.fill();
    }

    c.restore();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // HR ZONE GAUGE — bottom-right widget
  // ════════════════════════════════════════════════════════════════════════════

  _drawHRGauge: function(c, W, H) {
    var gaugeW = 200;
    var gaugeH = 12;
    var gaugeX = W - gaugeW - 30;
    var gaugeY = H - 60;

    var zones = [
      { name: 'Z1', color: this.COLORS.z1, min: 0.50, max: 0.60 },
      { name: 'Z2', color: this.COLORS.z2, min: 0.60, max: 0.70 },
      { name: 'Z3', color: this.COLORS.z3, min: 0.70, max: 0.80 },
      { name: 'Z4', color: this.COLORS.z4, min: 0.80, max: 0.90 },
      { name: 'Z5', color: this.COLORS.z5, min: 0.90, max: 1.00 },
    ];

    // 5-zone horizontal bar
    var zoneWidth = gaugeW / zones.length;
    for (var i = 0; i < zones.length; i++) {
      c.fillStyle = zones[i].color;
      var zx = gaugeX + i * zoneWidth;
      if (i === 0) {
        this._roundRectSide(c, zx, gaugeY, zoneWidth, gaugeH, 4, 'left');
      } else if (i === zones.length - 1) {
        this._roundRectSide(c, zx, gaugeY, zoneWidth, gaugeH, 4, 'right');
      } else {
        c.fillRect(zx, gaugeY, zoneWidth, gaugeH);
      }
    }

    // Triangle marker at current HR position
    var hrFrac = this._hrMax > 0 ? this._hrBpm / this._hrMax : 0;
    // Map HR fraction to gauge position (gauge starts at 50% max HR)
    var gaugeFrac = (hrFrac - 0.50) / 0.50; // 0 = 50% maxHR, 1 = 100% maxHR
    gaugeFrac = Math.max(0, Math.min(1, gaugeFrac));
    var markerX = gaugeX + gaugeFrac * gaugeW;

    c.fillStyle = '#ffffff';
    c.beginPath();
    c.moveTo(markerX, gaugeY - 2);
    c.lineTo(markerX - 5, gaugeY - 9);
    c.lineTo(markerX + 5, gaugeY - 9);
    c.closePath();
    c.fill();

    // Determine current zone
    var zoneName = '';
    var zoneColor = this.COLORS.text;
    for (var j = 0; j < zones.length; j++) {
      if (hrFrac >= zones[j].min && hrFrac < zones[j].max) {
        zoneName = zones[j].name;
        zoneColor = zones[j].color;
        break;
      }
    }
    if (hrFrac >= 1.0) {
      zoneName = 'Z5';
      zoneColor = this.COLORS.z5;
    }

    // BPM text
    c.font = 'bold 20px "Orbitron", sans-serif';
    c.fillStyle = zoneColor;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    c.fillText(this._hrBpm + ' BPM', gaugeX - 10, gaugeY + gaugeH / 2);

    // Zone name text
    c.font = 'bold 14px "JetBrains Mono", monospace';
    c.fillStyle = zoneColor;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText(zoneName, gaugeX + gaugeW + 10, gaugeY + gaugeH / 2);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // PAC-MAN DOTS & ARCADE GHOSTS
  // ════════════════════════════════════════════════════════════════════════════

  _initDots: function() {
    this._dots = [];
    this._powerDots = [];
    this._score = 0;
    this._powerMode = false;
    this._eatenGhosts = [];
    // Place 40 regular dots evenly around the track
    for (var i = 0; i < 40; i++) {
      this._dots.push({ frac: i / 40, eaten: false });
    }
    // Place 4 power dots at quarters
    for (var j = 0; j < 4; j++) {
      this._powerDots.push({ frac: j / 4 + 0.02, eaten: false });
    }
    this._dotsInitialized = true;
  },

  _initArcadeGhosts: function() {
    // Classic Pac-Man ghost names and colors
    this._arcadeGhosts = [
      { frac: 0.25, color: '#ff0000', name: 'Blinky', speed: 0.0003, scared: false },
      { frac: 0.50, color: '#ffb8ff', name: 'Pinky',  speed: 0.00025, scared: false },
      { frac: 0.75, color: '#00ffff', name: 'Inky',   speed: 0.0002, scared: false },
      { frac: 0.95, color: '#ffb852', name: 'Clyde',  speed: 0.00015, scared: false },
    ];
  },

  _drawDots: function(c) {
    if (!this.config.showDots || !this._dotsInitialized) return;

    // Regular dots (small white pellets)
    for (var i = 0; i < this._dots.length; i++) {
      var dot = this._dots[i];
      if (dot.eaten) continue;
      var pt = this._fracToPoint(dot.frac);
      c.beginPath();
      c.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      c.fillStyle = '#ffcc00';
      c.fill();
    }

    // Power dots (large flashing pellets)
    var now = Date.now();
    var flash = Math.sin(now / 200) > 0;
    for (var j = 0; j < this._powerDots.length; j++) {
      var pd = this._powerDots[j];
      if (pd.eaten) continue;
      var ppt = this._fracToPoint(pd.frac);
      c.beginPath();
      c.arc(ppt.x, ppt.y, flash ? 7 : 5, 0, Math.PI * 2);
      c.fillStyle = flash ? '#ffffff' : '#ffcc00';
      c.fill();
    }
  },

  _drawArcadeGhosts: function(c, now) {
    if (!this.config.showArcadeGhosts) return;

    for (var i = 0; i < this._arcadeGhosts.length; i++) {
      var g = this._arcadeGhosts[i];

      // Move ghost along track
      g.frac = (g.frac + g.speed) % 1;

      var pt = this._fracToPoint(g.frac);
      var size = 14;
      var scared = this._powerMode && now < this._powerModeEnd;
      g.scared = scared;

      // Flash when power mode is about to end
      var scaredFlash = scared && (this._powerModeEnd - now < 2000) && (Math.floor(now / 200) % 2 === 0);

      c.save();

      if (scared && !scaredFlash) {
        // Scared ghost (blue, can be eaten)
        c.fillStyle = '#2121de';
      } else if (scaredFlash) {
        // Flashing white/blue
        c.fillStyle = '#ffffff';
      } else {
        c.fillStyle = g.color;
      }

      // Draw ghost body (rounded top, wavy bottom)
      c.beginPath();
      c.arc(pt.x, pt.y - 3, size * 0.7, Math.PI, 0); // Rounded head
      c.lineTo(pt.x + size * 0.7, pt.y + size * 0.5);
      // Wavy bottom
      var wave = Math.sin(now / 150 + i) * 2;
      c.lineTo(pt.x + size * 0.35, pt.y + size * 0.3 + wave);
      c.lineTo(pt.x, pt.y + size * 0.5 - wave);
      c.lineTo(pt.x - size * 0.35, pt.y + size * 0.3 + wave);
      c.lineTo(pt.x - size * 0.7, pt.y + size * 0.5);
      c.closePath();
      c.fill();

      // Eyes
      if (!scared || scaredFlash) {
        // White eyes
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(pt.x - 4, pt.y - 5, 3.5, 0, Math.PI * 2);
        c.arc(pt.x + 4, pt.y - 5, 3.5, 0, Math.PI * 2);
        c.fill();
        // Pupils (look toward Pac-Man)
        var pacPt = this._fracToPoint(this._progress);
        var dx = pacPt.x - pt.x;
        var dy = pacPt.y - pt.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var px = (dx / dist) * 1.5;
        var py = (dy / dist) * 1.5;
        c.fillStyle = '#000080';
        c.beginPath();
        c.arc(pt.x - 4 + px, pt.y - 5 + py, 1.8, 0, Math.PI * 2);
        c.arc(pt.x + 4 + px, pt.y - 5 + py, 1.8, 0, Math.PI * 2);
        c.fill();
      } else {
        // Scared face (squiggly mouth)
        c.strokeStyle = '#ffffff';
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(pt.x - 5, pt.y);
        for (var s = -4; s <= 5; s += 2) {
          c.lineTo(pt.x + s, pt.y + (s % 4 === 0 ? -2 : 2));
        }
        c.stroke();
        // Dot eyes
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(pt.x - 3, pt.y - 5, 1.5, 0, Math.PI * 2);
        c.arc(pt.x + 3, pt.y - 5, 1.5, 0, Math.PI * 2);
        c.fill();
      }

      c.restore();

      // Check if Pac-Man eats a scared ghost
      if (scared) {
        var pacP = this._fracToPoint(this._progress);
        var gdx = pacP.x - pt.x;
        var gdy = pacP.y - pt.y;
        var gDist = Math.sqrt(gdx * gdx + gdy * gdy);
        if (gDist < 20) {
          // Pac-Man eats the ghost!
          this._score += 200;
          this._eatenGhosts.push({ frac: g.frac, time: now, points: 200 });
          // Reset ghost to center
          g.frac = 0.5;
          g.scared = false;
        }
      }
    }
  },

  _drawEatenGhostScores: function(c, now) {
    // Show floating score text where ghosts were eaten
    for (var i = this._eatenGhosts.length - 1; i >= 0; i--) {
      var eg = this._eatenGhosts[i];
      var age = now - eg.time;
      if (age > 1500) {
        this._eatenGhosts.splice(i, 1);
        continue;
      }
      var pt = this._fracToPoint(eg.frac);
      var alpha = Math.max(0, 1 - age / 1500);
      var rise = age / 30; // float upward
      c.save();
      c.globalAlpha = alpha;
      c.font = 'bold 16px "Orbitron", sans-serif';
      c.fillStyle = '#00ffff';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(eg.points.toString(), pt.x, pt.y - 20 - rise);
      c.restore();
    }
  },

  _checkDotEating: function() {
    if (!this._dotsInitialized) return;
    var eatRadius = 0.02; // How close Pac-Man needs to be to eat a dot

    // Eat regular dots
    for (var i = 0; i < this._dots.length; i++) {
      var d = this._dots[i];
      if (d.eaten) continue;
      var diff = Math.abs(this._progress - d.frac);
      if (diff > 0.5) diff = 1 - diff; // Wrap around
      if (diff < eatRadius) {
        d.eaten = true;
        this._score += 10;
      }
    }

    // Eat power dots
    var now = Date.now();
    for (var j = 0; j < this._powerDots.length; j++) {
      var pd = this._powerDots[j];
      if (pd.eaten) continue;
      var pdiff = Math.abs(this._progress - pd.frac);
      if (pdiff > 0.5) pdiff = 1 - pdiff;
      if (pdiff < eatRadius) {
        pd.eaten = true;
        this._score += 50;
        // Enter power mode for 8 seconds
        this._powerMode = true;
        this._powerModeEnd = now + 8000;
      }
    }

    // Check if power mode expired
    if (this._powerMode && now >= this._powerModeEnd) {
      this._powerMode = false;
    }

    // Respawn dots when all eaten (new lap)
    var allEaten = true;
    for (var k = 0; k < this._dots.length; k++) {
      if (!this._dots[k].eaten) { allEaten = false; break; }
    }
    if (allEaten) {
      this._initDots(); // Fresh set of dots
    }
  },

  _drawScore: function(c, W, H) {
    if (!this._dotsInitialized || this._score <= 0) return;
    c.font = 'bold 14px "JetBrains Mono", monospace';
    c.fillStyle = '#ffcc00';
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('SCORE: ' + this._score, 20, H - 40);
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TRACK ARC STROKING — draw a segment of the oval track
  // ════════════════════════════════════════════════════════════════════════════

  _strokeTrackArc: function(c, fracStart, fracEnd) {
    var g = this._geo;
    if (!g || fracEnd <= fracStart) return;

    // Discretise the arc into small line segments for smooth rendering
    var steps = Math.max(8, Math.ceil((fracEnd - fracStart) * 200));
    c.beginPath();
    var p0 = this._fracToPoint(fracStart);
    c.moveTo(p0.x, p0.y);

    for (var i = 1; i <= steps; i++) {
      var f = fracStart + (fracEnd - fracStart) * (i / steps);
      var p = this._fracToPoint(f);
      c.lineTo(p.x, p.y);
    }
    c.stroke();
  },

  // ════════════════════════════════════════════════════════════════════════════
  // UTILITY — rounded rectangle (Canvas 2D polyfill for older Chrome)
  // ════════════════════════════════════════════════════════════════════════════

  _roundRect: function(c, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
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

  _roundRectSide: function(c, x, y, w, h, r, side) {
    // Rounded on one side only (for gauge bar ends)
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    if (side === 'left') {
      c.moveTo(x + r, y);
      c.lineTo(x + w, y);
      c.lineTo(x + w, y + h);
      c.lineTo(x + r, y + h);
      c.arcTo(x, y + h, x, y + h - r, r);
      c.lineTo(x, y + r);
      c.arcTo(x, y, x + r, y, r);
    } else {
      c.moveTo(x, y);
      c.lineTo(x + w - r, y);
      c.arcTo(x + w, y, x + w, y + r, r);
      c.lineTo(x + w, y + h - r);
      c.arcTo(x + w, y + h, x + w - r, y + h, r);
      c.lineTo(x, y + h);
    }
    c.closePath();
    c.fill();
  },
};
