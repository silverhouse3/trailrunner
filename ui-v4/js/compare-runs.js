// ════════════════════════════════════════════════════════════════════════════
// CompareRuns — stats-page "COMPARE RUNS" panel (ui-v4). READ-ONLY.
// Reads saved runs from localStorage 'tr_runs' + settings 'tr_settings', compares run A vs run B
// (summary + deltas, HR overlay, speed/incline, per-unit splits, plain-English "what changed").
// Never touches the treadmill / TM / bridge; does not need treadmill.js or Engine. Works offline.
// All user/Strava text is rendered via textContent; SVG is built with DOM calls (no innerHTML).
// ════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var DASH = '-', MINUS = '−';
  var COL_A = '#37d0ff', COL_B = '#ffb020';
  var DT_CAP = 15; // seconds: longest gap one track point may account for (trackPoints are every ~5 s)
  var BANDS = [   // same as Engine.HR_ZONES (50-60-70-80-90-100 % of max HR); copied because Engine is not loaded here
    { z: 1, min: 0.50, max: 0.60, color: '#4fc3f7', label: 'Z1' },
    { z: 2, min: 0.60, max: 0.70, color: '#69f0ae', label: 'Z2' },
    { z: 3, min: 0.70, max: 0.80, color: '#ffe066', label: 'Z3' },
    { z: 4, min: 0.80, max: 0.90, color: '#ffb74d', label: 'Z4' },
    { z: 5, min: 0.90, max: 1.00, color: '#ff5f5f', label: 'Z5' }
  ];

  // ── pure helpers ──────────────────────────────────────────────────────────
  function fin(v) { v = (typeof v === 'string' && v.trim() !== '') ? +v : v; return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function pos(v) { v = fin(v); return v != null && v > 0 ? v : null; }
  function sgn(x, dec) {
    if (x == null || !isFinite(x)) return DASH;
    var s = Math.abs(x).toFixed(dec);
    if (parseFloat(s) === 0) return (0).toFixed(dec);
    return (x > 0 ? '+' : MINUS) + s;
  }
  function dur(sec) {
    sec = fin(sec); if (sec == null || sec < 0) return DASH;
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s : m + ':' + (s < 10 ? '0' : '') + s;
  }
  function sdur(sec) {
    sec = fin(sec); if (sec == null) return DASH;
    var r = Math.round(Math.abs(sec)); if (r === 0) return '0:00';
    return (sec > 0 ? '+' : MINUS) + dur(r);
  }
  function maxHRSetting() {
    try { var s = JSON.parse(localStorage.getItem('tr_settings') || '{}') || {}; return pos(s.maxHR) || 185; } catch (e) { return 185; }
  }
  function readRuns() {
    var raw; try { raw = JSON.parse(localStorage.getItem('tr_runs') || '[]'); } catch (e) { raw = []; }
    if (!Array.isArray(raw)) raw = [];
    var out = [];
    raw.forEach(function (r) { if (r && typeof r === 'object') out.push(norm(r)); });
    out.sort(function (a, b) { return (b.when || 0) - (a.when || 0); });
    return out;
  }

  // ── run normalisation ─────────────────────────────────────────────────────
  function trace(tps) {
    if (!Array.isArray(tps) || !tps.length) return [];
    var t0 = null, i, p;
    for (i = 0; i < tps.length; i++) { p = tps[i]; if (p && p.time && isFinite(Date.parse(p.time))) { t0 = Date.parse(p.time); break; } }
    var out = [];
    for (i = 0; i < tps.length; i++) {
      p = tps[i]; if (!p || typeof p !== 'object') continue;
      var t = fin(p.elapsed);
      if (t == null && t0 != null && p.time && isFinite(Date.parse(p.time))) t = (Date.parse(p.time) - t0) / 1000;
      if (t == null) continue;
      out.push({ t: t, hr: pos(p.hr), spd: fin(p.speed), inc: fin(p.incline), d: fin(p.dist) });
    }
    return out;
  }
  function norm(r) {
    var when = Date.parse(r.startedAt || r.savedAt || r.date || '');
    var el = pos(r.elapsedSec) || pos(r.elapsed);
    var km = pos(r.distanceKm) || (pos(r.distanceM) ? r.distanceM / 1000 : null);
    var tr = trace(r.trackPoints);
    var hrPts = tr.filter(function (p) { return p.hr != null; });
    var incs = tr.filter(function (p) { return p.inc != null; });
    var maxHR = pos(r.maxHR) || (hrPts.length ? Math.max.apply(null, hrPts.map(function (p) { return p.hr; })) : null);
    return {
      raw: r, when: isFinite(when) ? when : null, name: String(r.routeName || 'Free Run'),
      strava: r.source === 'strava' || !!r.imported,
      elapsed: el, km: km,
      pace: (km && el) ? el / km : null,                                       // sec per km
      avgSpeed: pos(r.avgSpeed) || ((km && el) ? km / (el / 3600) : null),   // km/h
      avgHR: pos(r.avgHR), maxHR: maxHR, calories: pos(r.calories), elev: fin(r.elevGained != null ? r.elevGained : r.elevGain),
      trace: tr, hrTrace: hrPts,
      avgIncline: incs.length ? incs.reduce(function (s, p) { return s + p.inc; }, 0) / incs.length : null
    };
  }

  // HR drift: least-squares slope of HR vs time (bpm per minute) after the first 10 minutes
  function hrDrift(tr, afterSec) {
    afterSec = afterSec == null ? 600 : afterSec;
    var pts = (tr || []).filter(function (p) { return p.hr != null && p.t >= afterSec; });
    if (pts.length < 6) return null;
    var n = pts.length, sx = 0, sy = 0, i;
    for (i = 0; i < n; i++) { sx += pts[i].t; sy += pts[i].hr; }
    var mx = sx / n, my = sy / n, sxx = 0, sxy = 0;
    for (i = 0; i < n; i++) { sxx += (pts[i].t - mx) * (pts[i].t - mx); sxy += (pts[i].t - mx) * (pts[i].hr - my); }
    if (sxx < 120 * 120) return null;      // less than ~2 minutes of spread: slope is meaningless
    return sxy / sxx * 60;
  }
  // Seconds in each HR zone. below + z[0..4] === total by construction. null when there is no HR trace.
  function zoneTimes(tr, maxHR) {
    var pts = (tr || []).filter(function (p) { return p.hr != null; });
    if (!pts.length || !(maxHR > 0)) return null;
    var out = { below: 0, z: [0, 0, 0, 0, 0], total: 0 }, lastDt = 5;
    for (var i = 0; i < pts.length; i++) {
      var dt = i < pts.length - 1 ? pts[i + 1].t - pts[i].t : lastDt;
      dt = Math.max(0, Math.min(DT_CAP, dt)); lastDt = dt || lastDt;
      var pct = pts[i].hr / maxHR;
      if (pct < BANDS[0].min) out.below += dt;
      else { var zi = 4; for (var k = 0; k < 5; k++) if (pct < BANDS[k].max) { zi = k; break; } out.z[zi] += dt; }
      out.total += dt;
    }
    return out;
  }
  function splitsOf(run) {
    var word = (typeof Units !== 'undefined' && Units.imp && Units.imp()) ? 'Mile' : 'Km';
    var rows = [];
    try {
      var src = { splits: run.raw.splits, finalSplit: run.raw.finalSplit, trackPoints: run.raw.trackPoints };
      var g = (typeof PastRunSplits !== 'undefined' && PastRunSplits.regroup) ? PastRunSplits.regroup(src) : null;
      var list = g ? g.splits : (run.raw.splits || []).filter(function (s) { return s && !s.partial; });
      (list || []).forEach(function (s, i) { var t = pos(s.timeSec); if (t) rows.push({ n: s.km || (i + 1), sec: t, hr: pos(s.avgHR) }); });
    } catch (e) { rows = []; }
    return { word: word, rows: rows };
  }

  // ── comparison model (also used by tests) ────────────────────────────────
  function unitsOK() { return typeof Units !== 'undefined'; }
  function d1(v) { return v.toFixed(1); }
  function buildRows(a, b, maxHR) {
    var za = zoneTimes(a.trace, maxHR), zb = zoneTimes(b.trace, maxHR);
    var da = hrDrift(a.trace), db = hrDrift(b.trace);
    var rows = [];
    function num(label, va, vb, f, df) {
      var has = va != null && vb != null;
      rows.push({ label: label, a: va != null ? f(va) : DASH, b: vb != null ? f(vb) : DASH, d: has ? df(vb - va, va, vb) : DASH });
    }
    rows.push({ label: 'Date', a: whenText(a), b: whenText(b),
      d: (a.when != null && b.when != null) ? (function (days) { return days === 0 ? 'same day' : (days > 0 ? '+' : MINUS) + Math.abs(days) + ' d'; })(Math.round((b.when - a.when) / 86400000)) : DASH });
    num('Duration', a.elapsed, b.elapsed, dur, function (x) { return sdur(x); });
    num('Distance (' + Units.distLabel() + ')', a.km, b.km, function (v) { return Units.distKm(v, 2); }, function (x) { return sgn(Units.distNum(x * 1000), 2); });
    num('Avg pace (' + Units.paceSlash() + ')', a.pace, b.pace, function (v) { return Units.pace(v); }, function (x, va, vb) { return sdur(Units.paceSecPerUnit(vb) - Units.paceSecPerUnit(va)); });
    num('Avg speed (' + Units.speedLabel() + ')', a.avgSpeed, b.avgSpeed, function (v) { return Units.speed(v, 1); }, function (x) { return sgn(Units.speedNum(x), 1); });
    num('Avg HR (bpm)', a.avgHR, b.avgHR, function (v) { return String(Math.round(v)); }, function (x) { return sgn(x, 0); });
    num('Max HR (bpm)', a.maxHR, b.maxHR, function (v) { return String(Math.round(v)); }, function (x) { return sgn(x, 0); });
    num('Calories (kcal)', a.calories, b.calories, function (v) { return String(Math.round(v)); }, function (x) { return sgn(x, 0); });
    num('Elevation gained (' + Units.elevLabel() + ')', a.elev, b.elev, function (v) { return Units.elev(v); }, function (x) { return sgn(Units.elevNum(x), 0); });
    num('Avg incline (%)', a.avgIncline, b.avgIncline, function (v) { return d1(v); }, function (x) { return sgn(x, 1); });
    num('HR drift (bpm/min)', da, db, function (v) { return sgn(v, 2); }, function (x) { return sgn(x, 2); });
    rows.push({ section: 'TIME IN HR ZONE' });
    var zl = ['Below Z1 (<50%)', 'Z1 50-60%', 'Z2 60-70%', 'Z3 70-80%', 'Z4 80-90%', 'Z5 90-100%'];
    for (var i = 0; i < 6; i++) {
      num(zl[i], za ? (i === 0 ? za.below : za.z[i - 1]) : null, zb ? (i === 0 ? zb.below : zb.z[i - 1]) : null, dur, function (x) { return sdur(x); });
    }
    return { rows: rows, drift: [da, db], zones: [za, zb] };
  }
  function whenText(r) {
    if (r.when == null) return DASH;
    try { return new Date(r.when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return DASH; }
  }
  function whatChanged(a, b, model) {
    var parts = [], dk = (a.km != null && b.km != null) ? Units.distNum((b.km - a.km) * 1000) : null;
    if (dk != null && Math.abs(dk) >= 0.05) parts.push('B was ' + Math.abs(dk).toFixed(1) + ' ' + Units.distLabel() + (dk > 0 ? ' longer' : ' shorter'));
    else if (dk != null) parts.push('B covered about the same distance');
    if (a.pace != null && b.pace != null) {
      var dp = Math.round(Units.paceSecPerUnit(b.pace) - Units.paceSecPerUnit(a.pace));
      if (Math.abs(dp) >= 3) parts.push('average pace was ' + dur(Math.abs(dp)) + Units.paceSlash() + (dp < 0 ? ' faster' : ' slower'));
    }
    if (a.avgHR != null && b.avgHR != null) {
      var dh = Math.round(b.avgHR - a.avgHR);
      if (dh !== 0) parts.push('avg HR ' + Math.abs(dh) + ' bpm ' + (dh > 0 ? 'higher' : 'lower'));
      else parts.push('avg HR was the same');
    }
    if (model.drift[0] != null && model.drift[1] != null) {
      var dd = Math.round((model.drift[1] - model.drift[0]) * 10) / 10;
      if (dd !== 0) parts.push('heart-rate drift ' + Math.abs(dd).toFixed(1) + ' bpm/min ' + (dd > 0 ? 'steeper' : 'flatter') + ' (A ' + sgn(model.drift[0], 1) + ', B ' + sgn(model.drift[1], 1) + ')');
      else parts.push('heart-rate drift was the same');
    }
    if (a.elev != null && b.elev != null) {
      var de = Units.elevNum(b.elev - a.elev);
      if (Math.abs(de) >= 1) parts.push(Math.abs(Math.round(de)) + ' ' + Units.elevLabel() + (de > 0 ? ' more' : ' less') + ' climbing');
    }
    if (!parts.length) return 'Not enough overlapping numbers to say what changed.';
    var s = parts.join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
  }

  // ── tiny DOM helpers (textContent only) ───────────────────────────────────
  var NS_SVG = 'http://www.w3.org/2000/svg';
  function h(tag, cls, text, attrs) {
    var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text;
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function s(tag, attrs, text, parent) {
    var e = document.createElementNS(NS_SVG, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceStep(range, target) {
    var raw = range / target, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  // ── chart ────────────────────────────────────────────────────────────────
  // series: [{ color, step, pts:[{x,y}] }]; opts: { yLabel, xLabel, bands, maxHR, yMin, yMax, ySuffix }
  function chart(series, o) {
    var W = 680, H = o.height || 250, L = 62, R = 14, T = 12, B = 46;
    var all = []; series.forEach(function (se) { all = all.concat(se.pts); });
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'cr-svg', role: 'img', 'aria-label': o.aria || 'chart', preserveAspectRatio: 'xMidYMid meet' });
    var xmax = Math.max.apply(null, all.map(function (p) { return p.x; })); if (!(xmax > 0)) xmax = 1;
    var ymin = Math.min.apply(null, all.map(function (p) { return p.y; })), ymax = Math.max.apply(null, all.map(function (p) { return p.y; }));
    if (o.bands && o.maxHR) { ymin = Math.min(ymin, o.maxHR * 0.5); ymax = Math.max(ymax, o.maxHR * 0.6); }
    if (o.yMin != null) ymin = Math.min(ymin, o.yMin);
    if (o.yFloor != null) ymin = Math.min(ymin, o.yFloor);
    var ystep = niceStep(Math.max(ymax - ymin, 1), 5);
    ymin = Math.floor((ymin - (o.bands ? 2 : 0)) / ystep) * ystep; ymax = Math.ceil((ymax + (o.bands ? 2 : 0)) / ystep) * ystep;
    if (ymax - ymin < ystep) ymax = ymin + ystep;
    var xstep = niceStep(xmax, 8);
    var xend = Math.ceil(xmax / xstep) * xstep;
    function X(v) { return L + (v / xend) * (W - L - R); }
    function Y(v) { return T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B); }
    var i, v;
    if (o.bands && o.maxHR) {
      BANDS.forEach(function (bd) {
        var lo = Math.max(bd.min * o.maxHR, ymin), hi = Math.min(bd.max * o.maxHR, ymax);
        if (hi > lo) s('rect', { x: L, y: Y(hi), width: W - L - R, height: Y(lo) - Y(hi), fill: bd.color, 'fill-opacity': 0.1, 'class': 'cr-band' }, null, svg);
      });
      BANDS.forEach(function (bd) {
        var mid = (bd.min + bd.max) / 2 * o.maxHR;
        if (mid > ymin && mid < ymax) s('text', { x: W - R - 4, y: Y(mid) + 4, 'text-anchor': 'end', 'class': 'cr-bandlbl', style: 'fill:' + bd.color }, bd.label, svg);
      });
    }
    for (v = ymin; v <= ymax + 1e-9; v += ystep) {
      s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: '#2a3345', 'stroke-width': 1 }, null, svg);
      s('text', { x: L - 8, y: Y(v) + 5, 'text-anchor': 'end', 'class': 'cr-tick' }, String(Math.round(v * 10) / 10), svg);
    }
    for (v = 0; v <= xend + 1e-9; v += xstep) {
      s('line', { x1: X(v), x2: X(v), y1: T, y2: H - B, stroke: '#1f2736', 'stroke-width': 1 }, null, svg);
      s('text', { x: X(v), y: H - B + 20, 'text-anchor': 'middle', 'class': 'cr-tick' }, String(Math.round(v * 10) / 10), svg);
    }
    s('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle', 'class': 'cr-axis' }, o.xLabel, svg);
    s('text', { x: 14, y: (T + H - B) / 2, 'text-anchor': 'middle', 'class': 'cr-axis', transform: 'rotate(-90 14 ' + ((T + H - B) / 2) + ')' }, o.yLabel, svg);
    series.forEach(function (se) {
      var pts = se.pts.slice().sort(function (p, q) { return p.x - q.x; }), d = '';
      for (i = 0; i < pts.length; i++) {
        var x = X(pts[i].x).toFixed(1), y = Y(pts[i].y).toFixed(1);
        if (i === 0) d += 'M' + x + ' ' + y;
        else if (se.step) d += 'H' + x + 'V' + y;
        else d += 'L' + x + ' ' + y;
      }
      s('path', { d: d, fill: 'none', stroke: se.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'class': 'cr-line cr-line-' + se.id }, null, svg);
    });
    return svg;
  }

  // ── panel ────────────────────────────────────────────────────────────────
  var st = { runs: [], ia: 0, ib: 1, xmode: 'time', panel: null, result: null, selA: null, selB: null, bound: false };

  function runLabel(r, which) { return which + ' · ' + (r.when != null ? new Date(r.when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '?') + ' · ' + (r.km != null ? Units.distKm(r.km, 1) + ' ' + Units.distLabel() : DASH); }
  function optionText(r) {
    return whenText(r) + '  ·  ' + (r.km != null ? Units.distKm(r.km, 2) + ' ' + Units.distLabel() : DASH) + '  ·  ' + dur(r.elapsed) +
      (r.strava ? '  ·  Strava' : '') + '  ·  ' + r.name.slice(0, 40);
  }
  function fillSelect(sel, idx) {
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    st.runs.forEach(function (r, i) { var o = h('option', null, optionText(r)); o.value = String(i); sel.appendChild(o); });
    sel.value = String(idx);
  }

  function buildPanel() {
    var p = document.getElementById('crPanel');
    if (p) p.parentNode.removeChild(p);
    p = h('div', 'cr-panel', null, { id: 'crPanel', role: 'dialog', 'aria-label': 'Compare runs' });
    var top = h('div', 'cr-top');
    top.appendChild(h('div', 'cr-title', 'COMPARE RUNS'));
    var close = h('button', 'cr-btn cr-close', 'CLOSE ✕', { id: 'crClose', type: 'button' });
    close.addEventListener('click', closePanel);
    top.appendChild(close);
    p.appendChild(top);
    st.result = h('div', 'cr-result', null, { id: 'crResult' });
    if (st.runs.length < 2) {
      p.appendChild(h('div', 'cr-empty', st.runs.length === 0
        ? 'No runs saved yet. Complete a run (or import from Strava) and come back to compare two runs.'
        : 'You need at least two saved runs to compare. Complete another run (or import from Strava) and come back.', { id: 'crEmpty' }));
      document.body.appendChild(p); st.panel = p; return;
    }
    var pick = h('div', 'cr-pick');
    function box(letter, color) {
      var b = h('label', 'cr-picker'); b.style.borderColor = color;
      var tag = h('span', 'cr-pk', letter); tag.style.background = color; b.appendChild(tag);
      var sel = h('select', 'cr-select', null, { id: 'crSel' + letter, 'aria-label': 'Run ' + letter }); b.appendChild(sel);
      return { box: b, sel: sel };
    }
    var A = box('A', COL_A), B = box('B', COL_B);
    st.selA = A.sel; st.selB = B.sel;
    fillSelect(A.sel, st.ia); fillSelect(B.sel, st.ib);
    A.sel.addEventListener('change', function () { st.ia = +A.sel.value; render(); });
    B.sel.addEventListener('change', function () { st.ib = +B.sel.value; render(); });
    var swap = h('button', 'cr-btn cr-swap', '⇄ SWAP', { id: 'crSwap', type: 'button' });
    swap.addEventListener('click', function () { var t = st.ia; st.ia = st.ib; st.ib = t; A.sel.value = String(st.ia); B.sel.value = String(st.ib); render(); });
    pick.appendChild(A.box); pick.appendChild(swap); pick.appendChild(B.box);
    p.appendChild(pick);
    p.appendChild(st.result);
    document.body.appendChild(p); st.panel = p;
  }

  function table(model, a, b) {
    var t = h('table', 'cr-table', null, { id: 'crSummary' });
    var hd = h('tr'); ['', 'A', 'B', 'B − A'].forEach(function (x, i) {
      var th = h('th', i === 1 ? 'cr-ca' : i === 2 ? 'cr-cb' : '', x); hd.appendChild(th);
    });
    var thead = h('thead'); thead.appendChild(hd); t.appendChild(thead);
    var tb = h('tbody');
    model.rows.forEach(function (r) {
      if (r.section) { var sr = h('tr', 'cr-secrow'); var sh = h('th', null, r.section, { colspan: '4' }); sr.appendChild(sh); tb.appendChild(sr); return; }
      var tr = h('tr'); tr.setAttribute('data-row', r.label);
      tr.appendChild(h('th', 'cr-rl', r.label)); tr.appendChild(h('td', 'cr-va', r.a)); tr.appendChild(h('td', 'cr-vb', r.b)); tr.appendChild(h('td', 'cr-vd', r.d));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return t;
  }

  function legend(a, b, showA, showB) {
    var l = h('div', 'cr-legend');
    [[a, 'A', COL_A, showA], [b, 'B', COL_B, showB]].forEach(function (x) {
      var it = h('span', 'cr-leg' + (x[3] ? '' : ' off'));
      var sw = h('i'); sw.style.background = x[2]; it.appendChild(sw);
      it.appendChild(h('span', null, runLabel(x[0], x[1]) + (x[3] ? '' : ' (no trace)')));
      l.appendChild(it);
    });
    return l;
  }

  function charts(a, b, maxHR) {
    var box = h('div', 'cr-charts');
    var hasA = a.hrTrace.length > 0, hasB = b.hrTrace.length > 0;
    var head = h('div', 'cr-chart-head');
    head.appendChild(h('div', 'cr-sec', 'HEART RATE'));
    var tog = h('div', 'cr-toggle');
    ['time', 'dist'].forEach(function (m) {
      var bt = h('button', 'cr-btn cr-tg' + (st.xmode === m ? ' on' : ''), m === 'time' ? 'vs TIME' : 'vs DISTANCE', { type: 'button', 'data-x': m });
      bt.addEventListener('click', function () { st.xmode = m; render(); });
      tog.appendChild(bt);
    });
    head.appendChild(tog); box.appendChild(head);
    var notes = [];
    if (!hasA && !hasB) notes.push('No heart-rate trace stored for this run (A or B). Only the summary numbers are available.');
    else if (!hasA) notes.push('No heart-rate trace stored for run A — showing run B only.');
    else if (!hasB) notes.push('No heart-rate trace stored for run B — showing run A only.');
    if (notes.length) { var n = h('div', 'cr-note', notes[0], { id: 'crNoTrace' }); box.appendChild(n); }
    if (!hasA && !hasB) return box;
    box.appendChild(legend(a, b, hasA, hasB));
    var dist = st.xmode === 'dist';
    function xv(p) { return dist ? (p.d != null ? Units.distNum(p.d) : null) : p.t / 60; }
    function ser(r, color, id, key, conv, step) {
      var pts = [];
      r.trace.forEach(function (p) { var x = xv(p), y = p[key]; if (x != null && y != null) pts.push({ x: x, y: conv ? conv(y) : y }); });
      return { id: id, color: color, pts: pts, step: step };
    }
    var xl = dist ? 'Distance (' + Units.distLabel() + ')' : 'Elapsed time (minutes)';
    var hrS = [ser(a, COL_A, 'a', 'hr'), ser(b, COL_B, 'b', 'hr')].filter(function (x, i) { return x.pts.length && (i === 0 ? hasA : hasB); });
    if (!hrS.length) box.appendChild(h('div', 'cr-note', 'No distance values stored in the trace, so heart rate cannot be plotted against distance. Switch to TIME.'));
    else box.appendChild(chart(hrS, { xLabel: xl, yLabel: 'Heart rate (bpm)', bands: true, maxHR: maxHR, aria: 'Heart rate overlay chart', height: 270 }));
    // second chart(s): speed and incline steps
    var spS = [ser(a, COL_A, 'a', 'spd', Units.speedNum.bind(Units)), ser(b, COL_B, 'b', 'spd', Units.speedNum.bind(Units))].filter(function (x) { return x.pts.length; });
    if (spS.length) {
      box.appendChild(h('div', 'cr-sec', 'SPEED'));
      box.appendChild(chart(spS, { xLabel: xl, yLabel: 'Speed (' + Units.speedLabel() + ')', yFloor: 0, aria: 'Speed chart', height: 210 }));
    }
    var inS = [ser(a, COL_A, 'a', 'inc', null, true), ser(b, COL_B, 'b', 'inc', null, true)].filter(function (x) { return x.pts.length; });
    if (inS.length) {
      box.appendChild(h('div', 'cr-sec', 'INCLINE'));
      box.appendChild(chart(inS, { xLabel: xl, yLabel: 'Incline (%)', yFloor: 0, aria: 'Incline chart', height: 210 }));
    }
    return box;
  }

  function splitTable(a, b) {
    var sa = splitsOf(a), sb = splitsOf(b), sec = h('div', 'cr-splits');
    sec.appendChild(h('div', 'cr-sec', sa.word.toUpperCase() + ' SPLITS'));
    var n = Math.max(sa.rows.length, sb.rows.length);
    if (!n) { sec.appendChild(h('div', 'cr-note', 'No split data stored for either run.', { id: 'crNoSplits' })); return sec; }
    var t = h('table', 'cr-table cr-split-table', null, { id: 'crSplitTable' });
    var hd = h('tr');
    ['' + sa.word, 'A pace', 'A HR', 'B pace', 'B HR', 'Pace B−A', 'HR B−A'].forEach(function (x, i) { hd.appendChild(h('th', i === 1 || i === 2 ? 'cr-ca' : i === 3 || i === 4 ? 'cr-cb' : '', x)); });
    var thead = h('thead'); thead.appendChild(hd); t.appendChild(thead);
    var tb = h('tbody');
    for (var i = 0; i < n; i++) {
      var x = sa.rows[i], y = sb.rows[i], tr = h('tr');
      tr.appendChild(h('th', 'cr-rl', String(i + 1)));
      tr.appendChild(h('td', null, x ? dur(x.sec) : DASH)); tr.appendChild(h('td', null, x && x.hr ? String(Math.round(x.hr)) : DASH));
      tr.appendChild(h('td', null, y ? dur(y.sec) : DASH)); tr.appendChild(h('td', null, y && y.hr ? String(Math.round(y.hr)) : DASH));
      tr.appendChild(h('td', 'cr-vd', x && y ? sdur(y.sec - x.sec) : DASH));
      tr.appendChild(h('td', 'cr-vd', x && y && x.hr && y.hr ? sgn(y.hr - x.hr, 0) : DASH));
      tb.appendChild(tr);
    }
    t.appendChild(tb); sec.appendChild(t);
    sec.appendChild(h('div', 'cr-hint', 'Pace is time per ' + sa.word.toLowerCase() + '. A positive pace delta means B was slower.'));
    return sec;
  }

  function render() {
    var res = st.result; if (!res) return;
    while (res.firstChild) res.removeChild(res.firstChild);
    var a = st.runs[st.ia], b = st.runs[st.ib];
    if (!a || !b) return;
    var maxHR = maxHRSetting();
    var model = buildRows(a, b, maxHR);
    var wc = h('div', 'cr-what', null, { id: 'crWhat' });
    wc.appendChild(h('b', null, 'WHAT CHANGED  '));
    wc.appendChild(h('span', null, whatChanged(a, b, model), { id: 'crWhatText' }));
    res.appendChild(wc);
    var names = h('div', 'cr-names');
    [[a, 'A', COL_A], [b, 'B', COL_B]].forEach(function (x) {
      var d = h('div', 'cr-name'); d.style.borderColor = x[2];
      d.appendChild(h('b', null, x[1] + '  '));
      d.appendChild(h('span', null, x[0].name));
      if (x[0].strava) d.appendChild(h('em', 'cr-sv', 'Strava'));
      names.appendChild(d);
    });
    res.appendChild(names);
    var grid = h('div', 'cr-grid');
    var left = h('div', 'cr-left');
    left.appendChild(h('div', 'cr-sec', 'SUMMARY'));
    left.appendChild(table(model, a, b));
    left.appendChild(h('div', 'cr-hint', 'Zone times use max HR ' + Math.round(maxHR) + ' bpm. Drift = HR slope after the first 10 minutes.'));
    grid.appendChild(left);
    grid.appendChild(charts(a, b, maxHR));
    res.appendChild(grid);
    res.appendChild(splitTable(a, b));
  }

  function openPanel() {
    st.runs = readRuns();
    st.ia = 0; st.ib = Math.min(1, Math.max(0, st.runs.length - 1));
    // "A" = older of the two latest runs, "B" = newest, so deltas read as "newer minus older"
    if (st.runs.length >= 2) { st.ia = 1; st.ib = 0; }
    st.xmode = 'time';
    buildPanel();
    st.panel.classList.add('show');
    st.panel.scrollTop = 0;
    document.body.classList.add('cr-open');
    if (st.runs.length >= 2) render();
    var c = document.getElementById('crClose'); if (c) try { c.focus({ preventScroll: true }); } catch (e) {}
  }
  function closePanel() {
    if (st.panel) st.panel.classList.remove('show');
    document.body.classList.remove('cr-open');
  }

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && st.panel && st.panel.classList.contains('show')) closePanel(); });
  var btn = document.getElementById('crOpenBtn');
  if (btn) btn.addEventListener('click', openPanel);

  window.CompareRuns = {
    open: openPanel, close: closePanel,
    _t: { norm: norm, hrDrift: hrDrift, zoneTimes: zoneTimes, buildRows: buildRows, whatChanged: whatChanged, readRuns: readRuns, bands: BANDS }
  };
})();
