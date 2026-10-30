// ════════════════════════════════════════════════════════════════════════════
// HRAnalysis — pure functions over deep-imported Strava runs (see js/strava-deep.js).
// No DOM, no storage, no network: usable from Node (require) and from the page (window.HRAnalysis).
//
// A run record is  { id, summary:{...Strava summary...}, skip?:'notfound'|..., t[], hr[], v[], g[], d[], alt[], cad[] }
//   t   seconds from start (<= 5 s resolution)      hr  bpm            v  velocity_smooth m/s
//   g   grade_smooth %                              d   distance m     alt altitude m      cad  Strava cadence (steps/min of ONE foot)
// Any stream may be null (many runs have no HR).  Everything below degrades gracefully.
//
// Internal units: metres, seconds, m/s, bpm.  Display conversion is the page's job (Units).
// ES5 only (WebView 83 safe).
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var CFG = {
    hrMin: 40, hrMax: 230,          // valid HR range
    spikeBpm: 25,                   // |hr - local median(5)| above this = spike
    moveMs: 0.5,                    // m/s below this = stopped
    winSec: 60,                     // analysis window
    steadyCv: 0.08,                 // speed CV for a steady window
    steadyGrade: 3, steadyGradeSd: 2,
    sectionTol: 0.3,                // m/s: windows join a steady section while within this of its mean
    driftStartSec: 600,             // drift is measured after minute 10
    driftMinSec: 300,               // ... and needs at least 5 min of steady samples
    warmupSec: 300,                 // efficiency / pace-HR ignore the first 5 min
    effGrade: 2,                    // |grade| below this for flat-ish windows
    gpsJumpMs: 10,                  // implied speed above this (m/s) = GPS spike
    stopMinSec: 15,                 // a standing stop counts when at least this long
    maxHrRunMin: 600,               // runs shorter than this don't feed the max-HR estimate
    zonePct: [0.6, 0.7, 0.8, 0.9]   // zone upper edges as fraction of max HR (Z4 = 80-90 %, as in the HR design doc)
  };

  // ── small maths ───────────────────────────────────────────────────────────
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function mean(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function sorted(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function median(a) { if (!a.length) return null; var s = sorted(a), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function pct(a, p) {            // linear interpolation percentile, p in 0..100
    if (!a.length) return null;
    var s = sorted(a), k = (s.length - 1) * p / 100, lo = Math.floor(k), hi = Math.ceil(k);
    return s[lo] + (s[hi] - s[lo]) * (k - lo);
  }
  function sd(a) { if (a.length < 2) return 0; var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / a.length); }
  function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }
  function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  /** Least squares y = a + b x.  -> {slope, intercept, n, r2} or null */
  function lsq(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, i;
    for (i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    var mx = sx / n, my = sy / n, sxx = 0, sxy = 0, syy = 0;
    for (i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) * (ys[i] - my); }
    if (sxx === 0) return null;
    return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, n: n, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
  }
  function histogram(values, edges) {   // bins: (-inf,e0) [e0,e1) ... [eN,inf)
    var out = [], i, j;
    for (i = 0; i <= edges.length; i++) out.push({ lo: i === 0 ? null : edges[i - 1], hi: i === edges.length ? null : edges[i], n: 0 });
    for (j = 0; j < values.length; j++) {
      var k = 0; while (k < edges.length && values[j] >= edges[k]) k++;
      out[k].n++;
    }
    return out;
  }

  // ── date helpers (summary start_date_local preferred; no timezone maths) ─────
  function dayMs(s) { // 'YYYY-MM-DD...' -> UTC midnight ms
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function startStr(sum) { return (sum && (sum.start_date_local || sum.start_date)) || ''; }
  function ymd(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function weekStartMs(ms) { var d = new Date(ms), dow = (d.getUTCDay() + 6) % 7; return ms - dow * 86400000; }   // Monday

  // ── series preparation ──────────────────────────────────────────────────────
  /** Clean + derive.  Never mutates the record. */
  function prep(run) {
    var t = run.t || [], n = t.length, i;
    var P = { n: n, t: t, hr: null, v: null, g: run.g || null, d: run.d || null, alt: run.alt || null, cad: run.cad || null,
      dt: new Array(n), mv: new Array(n), hrValid: 0, hrRaw: 0, spikes: 0, gpsSpikes: 0, monotone: true };
    // dt (capped so a recording gap can't dominate)
    var gaps = [];
    for (i = 0; i < n - 1; i++) gaps.push(t[i + 1] - t[i]);
    var typ = gaps.length ? median(gaps) : 5;
    for (i = 0; i < n; i++) P.dt[i] = i < n - 1 ? Math.max(0, Math.min(10, t[i + 1] - t[i])) : Math.min(10, typ);
    // heart rate
    if (run.hr && run.hr.length === n) {
      var raw = new Array(n);
      for (i = 0; i < n; i++) { var h = run.hr[i]; raw[i] = isNum(h) && h >= CFG.hrMin && h <= CFG.hrMax ? h : null; if (isNum(h)) P.hrRaw++; }
      P.hr = new Array(n);
      for (i = 0; i < n; i++) {
        P.hr[i] = raw[i];
        if (raw[i] == null) continue;
        var nb = [];
        for (var k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) if (raw[k] != null) nb.push(raw[k]);
        if (nb.length >= 3 && Math.abs(raw[i] - median(nb)) > CFG.spikeBpm) { P.hr[i] = null; P.spikes++; }
      }
      for (i = 0; i < n; i++) if (P.hr[i] != null) P.hrValid++;
    }
    // speed (m/s): velocity_smooth, else from distance
    if (run.v && run.v.length === n) P.v = run.v.map(function (x) { return isNum(x) ? x : null; });
    else if (run.d && run.d.length === n) {
      P.v = new Array(n); P.v[0] = null;
      for (i = 1; i < n; i++) { var dtt = t[i] - t[i - 1]; P.v[i] = dtt > 0 && isNum(run.d[i]) && isNum(run.d[i - 1]) ? Math.max(0, (run.d[i] - run.d[i - 1]) / dtt) : null; }
      if (n > 1) P.v[0] = P.v[1];
    }
    // GPS spikes: implied speed from distance, or reported speed, beyond human running
    if (run.d && run.d.length === n) {
      for (i = 1; i < n; i++) {
        var dd = run.d[i] - run.d[i - 1], dtt2 = t[i] - t[i - 1];
        if (dd < -1) { P.monotone = false; P.gpsSpikes++; }
        else if (dtt2 > 0 && dd / dtt2 > CFG.gpsJumpMs) P.gpsSpikes++;
      }
    }
    if (P.v) for (i = 0; i < n; i++) if (P.v[i] != null && P.v[i] > CFG.gpsJumpMs) P.gpsSpikes++;
    for (i = 0; i < n; i++) P.mv[i] = P.v ? (P.v[i] != null && P.v[i] >= CFG.moveMs) : true;
    return P;
  }

  /** 60 s windows over the prepared series. */
  function windows(P) {
    var out = [], n = P.n, t = P.t, i = 0;
    while (i < n - 1) {
      var j = i;
      while (j + 1 < n && t[j + 1] - t[i] < CFG.winSec && t[j + 1] - t[j] <= 15) j++;
      if (j > i && t[j] - t[i] >= CFG.winSec - 10) {
        var vs = [], hs = [], gs = [], allMove = true, cnt = 0;
        for (var k = i; k <= j; k++) {
          cnt++;
          if (!P.mv[k]) allMove = false;
          if (P.v && P.v[k] != null) vs.push(P.v[k]);
          if (P.hr && P.hr[k] != null) hs.push(P.hr[k]);
          if (P.g && isNum(P.g[k])) gs.push(P.g[k]);
        }
        var mv = vs.length ? mean(vs) : null;
        out.push({ i: i, j: j, t0: t[i], t1: t[j], v: mv, cv: mv ? sd(vs) / mv : null, hr: hs.length >= 0.6 * cnt ? median(hs) : null,
          g: gs.length ? mean(gs) : null, gsd: gs.length ? sd(gs) : null, allMove: allMove });
        i = j + 1;
      } else i = j + 1;
    }
    for (var w = 0; w < out.length; w++) {
      var x = out[w];
      x.steady = !!(x.allMove && x.v != null && x.cv != null && x.cv < CFG.steadyCv &&
        (x.g == null || (Math.abs(x.g) < CFG.steadyGrade && x.gsd < CFG.steadyGradeSd)));
    }
    return out;
  }

  /** Merge adjacent steady windows of similar speed. -> [{t0,t1,v,i,j}] */
  function steadySections(W) {
    var secs = [], cur = null, w;
    for (var k = 0; k < W.length; k++) {
      w = W[k];
      if (w.steady && cur && w.t0 - cur.t1 <= 15 && Math.abs(w.v - cur.v) <= CFG.sectionTol) {
        cur.v = (cur.v * cur.n + w.v) / (cur.n + 1); cur.n++; cur.t1 = w.t1; cur.j = w.j;
      } else {
        if (cur) secs.push(cur);
        cur = w.steady ? { t0: w.t0, t1: w.t1, v: w.v, i: w.i, j: w.j, n: 1 } : null;
      }
    }
    if (cur) secs.push(cur);
    return secs;
  }

  function climbFrom(alt, fallback) {
    if (!alt || alt.length < 3) return fallback != null ? fallback : null;
    var sm = [], i, gain = 0, ref = null;
    for (i = 0; i < alt.length; i++) {
      var a = 0, c = 0;
      for (var k = Math.max(0, i - 1); k <= Math.min(alt.length - 1, i + 1); k++) if (isNum(alt[k])) { a += alt[k]; c++; }
      sm.push(c ? a / c : null);
    }
    for (i = 0; i < sm.length; i++) {
      if (sm[i] == null) continue;
      if (ref == null) { ref = sm[i]; continue; }
      if (sm[i] - ref > 1) { gain += sm[i] - ref; ref = sm[i]; }
      else if (ref - sm[i] > 1) ref = sm[i];
    }
    return gain;
  }

  /** Fastest contiguous distance D (m) inside one run, by elapsed time. -> seconds or null */
  function bestEffortSec(run, D) {
    var t = run.t, d = run.d, n = t ? t.length : 0;
    if (!d || d.length !== n || n < 3) return null;
    var best = null, i = 0;
    for (var j = 1; j < n; j++) {
      if (!isNum(d[j]) || !isNum(d[j - 1]) || d[j] < d[j - 1]) return null;   // not monotone: don't trust
      var need = d[j] - D;
      if (need < d[0]) continue;
      while (i + 1 < n && d[i + 1] <= need) i++;
      var span = d[i + 1] - d[i], frac = span > 0 ? (need - d[i]) / span : 0;
      var t0 = t[i] + (t[Math.min(n - 1, i + 1)] - t[i]) * frac, dur = t[j] - t0;
      if (dur > 0 && (best == null || dur < best)) best = dur;
    }
    return best;
  }

  // ── per run ─────────────────────────────────────────────────────────────────
  function zoneIndex(hr, maxHR) {
    var f = hr / maxHR, e = CFG.zonePct;
    return f < e[0] ? 0 : f < e[1] ? 1 : f < e[2] ? 2 : f < e[3] ? 3 : 4;
  }
  /** seconds-per-bpm histogram (moving samples) -> zone seconds (5) and percent (sums to 100). */
  function zonesFromHist(hist, maxHR) {
    var sec = [0, 0, 0, 0, 0], tot = 0, k;
    for (k in hist) if (Object.prototype.hasOwnProperty.call(hist, k)) { sec[zoneIndex(+k, maxHR)] += hist[k]; tot += hist[k]; }
    var p = sec.map(function (s) { return tot ? Math.round(s / tot * 1000) / 10 : 0; });
    return { sec: sec.map(function (s) { return Math.round(s); }), pct: p, totalSec: Math.round(tot) };
  }

  /**
   * Metrics for one run record.  opts: {maxHR (for zones)}.  Never throws on odd data.
   * Returns a plain object; internal bits are prefixed with '_' (dropped by publicMetrics()).
   */
  function runMetrics(rec, opts) {
    opts = opts || {};
    var sum = rec.summary || {}, flags = [];
    var m = {
      id: rec.id != null ? rec.id : sum.id, start: startStr(sum), distance: +sum.distance || 0,
      movingTime: +sum.moving_time || 0, elapsedTime: +sum.elapsed_time || 0, trainer: !!sum.trainer,
      paceSecPerKm: null, avgKmh: null, avgHR: null, maxHR: null, driftBpmPerMin: null, driftSeconds: 0,
      cadenceSpm: null, climb: null, efficiency: null, longestSteadySec: 0, longestSteadyKmh: null,
      stoppedSec: 0, stops: 0, hrCoverage: 0, gpsSpikes: 0, hrSpikes: 0, hasStreams: false, flags: flags,
      _effByBin: {}, _hist: {}, _startHR: null, _wins: [], _best: {}
    };
    if (m.distance > 0 && m.movingTime > 0) { m.paceSecPerKm = m.movingTime / (m.distance / 1000); m.avgKmh = m.distance / m.movingTime * 3.6; }
    else if (isNum(sum.average_speed) && sum.average_speed > 0) { m.avgKmh = sum.average_speed * 3.6; m.paceSecPerKm = 1000 / sum.average_speed; }
    var sumMax = isNum(sum.max_heartrate) && sum.max_heartrate >= 100 && sum.max_heartrate <= 215 ? sum.max_heartrate : null;
    m.avgHR = isNum(sum.average_heartrate) && sum.average_heartrate >= CFG.hrMin ? sum.average_heartrate : null;
    m.maxHR = sumMax; m._maxSrc = sumMax != null ? 'summary' : null;
    m.climb = isNum(sum.total_elevation_gain) ? sum.total_elevation_gain : null;
    if (m.trainer) flags.push('trainer');
    if (m.movingTime && m.movingTime < 600) flags.push('short');

    if (!rec.t || rec.t.length < 4) {
      flags.push(rec.skip ? 'skipped:' + rec.skip : 'noStream');
      if (m.avgHR == null) flags.push('noHR');
      return m;
    }
    m.hasStreams = true;
    var P = prep(rec), n = P.n, t = P.t, i;
    m.gpsSpikes = P.gpsSpikes; m.hrSpikes = P.spikes;
    if (P.gpsSpikes) flags.push('gpsSpike');

    // stops
    var runStart = -1;
    for (i = 0; i <= n; i++) {
      var stopped = i < n && P.v && !P.mv[i];
      if (stopped && runStart < 0) runStart = i;
      if (!stopped && runStart >= 0) {
        var len = t[i - 1] - t[runStart] + P.dt[i - 1];
        if (len >= CFG.stopMinSec && runStart > 0) { m.stoppedSec += len; m.stops++; }
        runStart = -1;
      }
    }
    if (m.stops) flags.push('stops');

    // HR
    if (P.hr) {
      m.hrCoverage = P.hrValid / n;
      var sw = 0, sh = 0, hmax = null;
      for (i = 0; i < n; i++) {
        if (P.hr[i] == null || !P.mv[i]) continue;
        sw += P.dt[i]; sh += P.hr[i] * P.dt[i];
        var key = Math.round(P.hr[i]); m._hist[key] = (m._hist[key] || 0) + P.dt[i];
      }
      if (sw > 0) m.avgHR = sh / sw;
      // spike-resistant max: highest 3-sample rolling median
      for (i = 1; i < n - 1; i++) {
        if (P.hr[i - 1] == null || P.hr[i] == null || P.hr[i + 1] == null) continue;
        var md = median([P.hr[i - 1], P.hr[i], P.hr[i + 1]]);
        if (hmax == null || md > hmax) hmax = md;
      }
      if (hmax != null) { m.maxHR = hmax; m._maxSrc = 'stream'; }
      // start HR (first 30 s) -> resting hint
      var sh0 = [];
      for (i = 0; i < n && t[i] < 30; i++) if (P.hr[i] != null) sh0.push(P.hr[i]);
      if (sh0.length >= 3) m._startHR = median(sh0);
      if (m.hrCoverage < 0.8) flags.push(m.hrCoverage < 0.05 ? 'noHR' : 'partialHR');
    } else if (m.avgHR == null) flags.push('noHR');
    else flags.push('summaryHROnly');

    // cadence
    if (P.cad) {
      var cs = [];
      for (i = 0; i < n; i++) if (isNum(P.cad[i]) && P.cad[i] > 0 && P.mv[i]) cs.push(P.cad[i]);
      if (cs.length > 10) { var cm = mean(cs); m.cadenceSpm = cm < 120 ? cm * 2 : cm; }
    }
    m.climb = climbFrom(P.alt, m.climb);

    // windows -> steady sections, drift, efficiency bins
    var W = windows(P), S = steadySections(W);
    m._wins = W;
    for (i = 0; i < S.length; i++) {
      var dur = S[i].t1 - S[i].t0;
      if (dur > m.longestSteadySec) { m.longestSteadySec = Math.round(dur); m.longestSteadyKmh = S[i].v * 3.6; }
    }
    if (P.hr) {
      // drift = duration-weighted mean of the least-squares HR slope of each steady section, using only the part
      // after minute 10 (sections shorter than 3 min there are ignored; total needs >= 5 min)
      var sw2 = 0, sd2 = 0;
      for (i = 0; i < S.length; i++) {
        var xs = [], ys = [];
        for (var k = S[i].i; k <= S[i].j; k++) if (t[k] >= CFG.driftStartSec && P.hr[k] != null) { xs.push(t[k]); ys.push(P.hr[k]); }
        if (xs.length < 12) continue;
        var span = xs[xs.length - 1] - xs[0];
        if (span < 180) continue;
        var fit = lsq(xs, ys);
        if (fit) { sw2 += span; sd2 += span * fit.slope * 60; }
      }
      if (sw2 >= CFG.driftMinSec) { m.driftBpmPerMin = sd2 / sw2; m.driftSeconds = Math.round(sw2); }
      // efficiency candidates: windows after warm-up, flat-ish, moving, with HR. bin = round(km/h)
      var bins = {};
      for (i = 0; i < W.length; i++) {
        var w = W[i];
        if (w.hr == null || !w.allMove || w.v == null || w.t0 < CFG.warmupSec) continue;
        if (w.g != null && Math.abs(w.g) > CFG.effGrade) continue;
        if (w.cv != null && w.cv > 0.15) continue;
        var bk = Math.round(w.v * 3.6);
        (bins[bk] = bins[bk] || []).push(w.hr);
      }
      for (var b in bins) if (bins[b].length >= 3) m._effByBin[b] = median(bins[b]);
    }
    // best efforts (only if the distance stream is trustworthy)
    if (!P.gpsSpikes && P.monotone && rec.d) {
      var D = { '1km': 1000, '1mi': 1609.344, '5km': 5000, '10km': 10000 };
      for (var name in D) { var bs = bestEffortSec(rec, D[name]); if (bs != null) m._best[name] = bs; }
    }
    if (opts.maxHR) { var z = zonesFromHist(m._hist, opts.maxHR); m.zonePct = z.pct; m.zoneSec = z.sec; }
    return m;
  }

  function publicMetrics(m) {
    var o = {};
    for (var k in m) if (k.charAt(0) !== '_') o[k] = m[k];
    return o;
  }

  // ── aggregates ──────────────────────────────────────────────────────────────
  /** Time-weighted 99.5th percentile of the pooled stream HR histograms (null when no stream HR). */
  function streamP995(ms) {
    var pool = {}, tot = 0, k, m;
    ms.forEach(function (r) { if (!r.hasStreams) return; for (k in r._hist) if (Object.prototype.hasOwnProperty.call(r._hist, k)) { pool[k] = (pool[k] || 0) + r._hist[k]; tot += r._hist[k]; } });
    if (!(tot > 0)) return null;
    var keys = Object.keys(pool).map(Number).sort(function (a, b) { return a - b; }), acc = 0, target = tot * 0.995;
    for (var i = 0; i < keys.length; i++) { acc += pool[keys[i]]; if (acc >= target) return keys[i]; }
    return keys[keys.length - 1];
  }
  /**
   * Max-HR estimate.  >= 5 valid runs: 95th percentile of the per-run maxima.  3-4 runs: MEDIAN of the maxima with
   * lowConfidence = true.  < 3 runs: est = null (not enough data; one value is never taken as the max).
   * Summary max_heartrate values (not stream-derived) more than 15 bpm above the stream 99.5th percentile are ignored.
   */
  function estimateMaxHR(ms) {
    var vals = [], ignored = 0, p995 = streamP995(ms);
    ms.forEach(function (m) {
      if (m.maxHR == null || !(m.movingTime >= CFG.maxHrRunMin) || m.maxHR < 100 || m.maxHR > 215) return;
      if (p995 != null && m._maxSrc !== 'stream' && m.maxHR > p995 + 15) { ignored++; return; }
      vals.push(m.maxHR);
    });
    var base = { est: null, n: vals.length, top: null, p95: null, median: null, lowConfidence: false, notEnough: true, streamP995: p995, ignoredHigh: ignored };
    if (!vals.length) return base;
    var top = Math.max.apply(null, vals), p95 = pct(vals, 95), med = median(vals);
    base.top = Math.round(top); base.p95 = Math.round(p95); base.median = Math.round(med);
    if (vals.length >= 5) { base.est = Math.round(p95); base.notEnough = false; }
    else if (vals.length >= 3) { base.est = Math.round(med); base.lowConfidence = true; base.notEnough = false; }
    return base;
  }
  function chooseRef(ms, prefer) {
    prefer = prefer || 10;
    var count = {}, k, best = null, bestN = 0;
    ms.forEach(function (m) { for (k in m._effByBin) count[k] = (count[k] || 0) + 1; });
    for (k in count) {
      var n = count[k];
      if (n > bestN || (n === bestN && Math.abs(+k - prefer) < Math.abs(best - prefer))) { best = +k; bestN = n; }
    }
    if (best == null) return { kmh: prefer, runs: 0 };
    if ((count[prefer] || 0) >= 0.5 * bestN && (count[prefer] || 0) >= 3) return { kmh: prefer, runs: count[prefer] };   // keep the standard reference when it is well covered
    return { kmh: best, runs: bestN };
  }
  function paceHrCurve(ms) {
    var bins = {};
    ms.forEach(function (m) {
      m._wins.forEach(function (w) {
        if (w.hr == null || !w.allMove || w.v == null || w.t0 < CFG.warmupSec || (w.cv != null && w.cv > 0.15)) return;
        if (w.g != null && Math.abs(w.g) > CFG.effGrade) return;
        var b = Math.round(w.v * 3.6 * 2) / 2;
        (bins[b] = bins[b] || []).push(w.hr);
      });
    });
    var out = [];
    Object.keys(bins).map(Number).sort(function (a, b) { return a - b; }).forEach(function (b) {
      if (bins[b].length >= 5) out.push({ kmh: b, hr: median(bins[b]), p25: pct(bins[b], 25), p75: pct(bins[b], 75), n: bins[b].length });
    });
    return out;
  }
  function interp(curve, kmh) {
    if (!curve.length) return null;
    if (kmh <= curve[0].kmh) return curve[0].hr;
    if (kmh >= curve[curve.length - 1].kmh) return curve[curve.length - 1].hr;
    for (var i = 1; i < curve.length; i++) if (kmh <= curve[i].kmh) {
      var a = curve[i - 1], b = curve[i];
      return a.hr + (b.hr - a.hr) * (kmh - a.kmh) / (b.kmh - a.kmh);
    }
    return null;
  }
  function gradeEffect(ms, curve) {
    if (curve.length < 2) return { bins: [], slopeBpmPerPct: null, n: 0 };
    var xs = [], ys = [], bins = {};
    ms.forEach(function (m) {
      m._wins.forEach(function (w) {
        if (w.hr == null || w.g == null || !w.allMove || w.v == null || w.t0 < CFG.warmupSec || (w.cv != null && w.cv > 0.15)) return;
        var base = interp(curve, w.v * 3.6);
        if (base == null) return;
        var res = w.hr - base;
        xs.push(w.g); ys.push(res);
        var b = Math.round(w.g / 2) * 2;
        (bins[b] = bins[b] || []).push(res);
      });
    });
    var out = [];
    Object.keys(bins).map(Number).sort(function (a, b) { return a - b; }).forEach(function (b) {
      if (bins[b].length >= 5) out.push({ grade: b, resid: mean(bins[b]), n: bins[b].length });
    });
    var fit = xs.length >= 20 ? lsq(xs, ys) : null;
    return { bins: out, slopeBpmPerPct: fit ? fit.slope : null, n: xs.length };
  }
  function monthKey(s) { return String(s).slice(0, 7); }
  function monthIndex(k) { return (+k.slice(0, 4)) * 12 + (+k.slice(5, 7)) - 1; }
  function weeklyVolume(ms) {
    var byWeek = {}, min = Infinity, max = -Infinity;
    ms.forEach(function (m) {
      var d = dayMs(m.start); if (isNaN(d)) return;
      var w = weekStartMs(d); byWeek[w] = byWeek[w] || { runs: 0, dist: 0, sec: 0 };
      byWeek[w].runs++; byWeek[w].dist += m.distance; byWeek[w].sec += m.movingTime;
      if (w < min) min = w; if (w > max) max = w;
    });
    var out = [];
    if (min === Infinity) return out;
    for (var w = min; w <= max; w += 7 * 86400000) {
      var b = byWeek[w] || { runs: 0, dist: 0, sec: 0 };
      out.push({ week: ymd(w), runs: b.runs, distance: b.dist, seconds: b.sec });
    }
    return out;
  }
  function consistency(ms, weeks) {
    var days = ms.map(function (m) { return dayMs(m.start); }).filter(function (x) { return !isNaN(x); }).sort(function (a, b) { return a - b; });
    var active = weeks.filter(function (w) { return w.runs > 0; }).length, maxGap = 0, i;
    for (i = 1; i < days.length; i++) maxGap = Math.max(maxGap, (days[i] - days[i - 1]) / 86400000);
    var streak = 0, best = 0;
    weeks.forEach(function (w) { if (w.runs > 0) { streak++; if (streak > best) best = streak; } else streak = 0; });
    var km = weeks.map(function (w) { return w.distance / 1000; }), mk = mean(km);
    return {
      spanWeeks: weeks.length, activeWeeks: active, activePct: weeks.length ? Math.round(active / weeks.length * 1000) / 10 : 0,
      runsPerWeek: weeks.length ? r2(ms.length / weeks.length) : 0, longestGapDays: Math.round(maxGap),
      longestStreakWeeks: best, weeklyKmCv: mk ? r2(sd(km) / mk) : null
    };
  }
  var LENGTH_EDGES_M = [3000, 5000, 8000, 10000, 16093, 21097];
  function lengthDistribution(ms) {
    return histogram(ms.map(function (m) { return m.distance; }), LENGTH_EDGES_M);
  }

  /**
   * Whole-history analysis.  records: array of run records (summary-only ones allowed).
   * opts: {maxHR, refKmh}
   */
  function analyse(records, opts) {
    opts = opts || {};
    records = (records || []).filter(function (r) { return r && r.summary; });
    var first = records.map(function (r) { return runMetrics(r, {}); });
    var mx = estimateMaxHR(first), maxHR = opts.maxHR || mx.est;
    var ref = opts.refKmh ? { kmh: opts.refKmh, runs: 0 } : chooseRef(first, 10);
    var ms = first.map(function (m, idx) {
      var o = m;
      if (maxHR) { var z = zonesFromHist(m._hist, maxHR); o.zonePct = z.pct; o.zoneSec = z.sec; }
      o.efficiency = m._effByBin[ref.kmh] != null ? m._effByBin[ref.kmh] : null;
      return o;
    });
    ms.sort(function (a, b) { return dayMs(b.start) - dayMs(a.start) || String(b.start).localeCompare(String(a.start)); });

    // fitness trend: median efficiency per month
    var byMonth = {};
    ms.forEach(function (m) { if (m.efficiency != null) (byMonth[monthKey(m.start)] = byMonth[monthKey(m.start)] || []).push(m.efficiency); });
    var trend = Object.keys(byMonth).sort().map(function (k) { return { month: k, hr: median(byMonth[k]), n: byMonth[k].length }; });
    var slope = null;
    // slope per CALENDAR month: x = real month index (year*12+month), so a gap of 3 months counts as 3, not 1
    if (trend.length >= 3) { var f = lsq(trend.map(function (x) { return monthIndex(x.month); }), trend.map(function (x) { return x.hr; })); slope = f && isFinite(f.slope) ? f.slope : null; }

    var curve = paceHrCurve(ms);
    var drifts = ms.filter(function (m) { return m.driftBpmPerMin != null; }).map(function (m) { return m.driftBpmPerMin; });
    var starts = ms.filter(function (m) { return m._startHR != null; }).map(function (m) { return m._startHR; });
    var weeks = weeklyVolume(ms);

    // best efforts
    var best = {};
    ['1km', '1mi', '5km', '10km'].forEach(function (k) {
      var b = null;
      ms.forEach(function (m) { if (m._best[k] != null && (b == null || m._best[k] < b.seconds)) b = { seconds: m._best[k], id: m.id, start: m.start }; });
      best[k] = b;
    });

    // totals of time in zones
    var zt = [0, 0, 0, 0, 0];
    ms.forEach(function (m) { if (m.zoneSec) for (var z = 0; z < 5; z++) zt[z] += m.zoneSec[z]; });
    var zsum = zt.reduce(function (a, b) { return a + b; }, 0);

    // data quality
    var q = { total: ms.length, withStreams: 0, noStreams: 0, skipped: {}, noHR: 0, partialHR: 0, gpsSpike: 0, stops: 0, trainer: 0, short: 0, hrSpikesTotal: 0 };
    ms.forEach(function (m) {
      if (m.hasStreams) q.withStreams++; else q.noStreams++;
      m.flags.forEach(function (f) {
        if (f.indexOf('skipped:') === 0) q.skipped[f.slice(8)] = (q.skipped[f.slice(8)] || 0) + 1;
        else if (q[f] != null && typeof q[f] === 'number') q[f]++;
      });
      q.hrSpikesTotal += m.hrSpikes || 0;
    });

    var res = {
      version: 1, runCount: ms.length, maxHR: { est: maxHR || null, estimate: mx, used: maxHR || null }, refKmh: ref.kmh, refRuns: ref.runs,
      restHint: starts.length >= 3 ? { bpm: Math.round(pct(starts, 10)), n: starts.length, note: 'lowest start-of-run HR; an upper bound for resting HR' } : null,
      fitnessTrend: trend, fitnessSlopePerMonth: slope,
      paceHrCurve: curve, gradeEffect: gradeEffect(ms, curve),
      drift: { n: drifts.length, median: drifts.length ? median(drifts) : null, p25: pct(drifts, 25), p75: pct(drifts, 75),
        hist: histogram(drifts, [-0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6, 0.9]) },
      zones: { sec: zt, pct: zt.map(function (s) { return zsum ? Math.round(s / zsum * 1000) / 10 : 0; }), totalSec: Math.round(zsum), maxHR: maxHR || null },
      lengths: lengthDistribution(ms), bestEfforts: best,
      weekly: weeks, consistency: consistency(ms, weeks),
      quality: q,
      runs: ms.map(publicMetrics)
    };
    return res;
  }

  // ── plain-English findings ──────────────────────────────────────────────────
  /** fmt: optional {pace(kmh), speed(kmh), dist(m), temp...}.  Falls back to metric. */
  function findings(a, fmt) {
    fmt = fmt || {};
    var P = fmt.pace || function (kmh) { var s = 3600 / kmh; return Math.floor(s / 60) + ':' + ('0' + Math.round(s % 60)).slice(-2) + ' /km'; };
    var S = fmt.speed || function (kmh) { return r1(kmh) + ' km/h'; };
    var D = fmt.dist || function (m) { return r1(m / 1000) + ' km'; };
    var out = [];
    if (!a || !a.runCount) return ['No runs loaded yet. Press START DEEP IMPORT to fetch your history.'];
    out.push(pl(a.runCount, 'run') + ' loaded; ' + a.quality.withStreams + ' have second-by-second data' + (a.quality.noHR ? ', ' + a.quality.noHR + ' have no heart rate.' : '.'));
    if (a.maxHR.est) out.push('Your highest sustained heart rate is about ' + a.maxHR.est + ' bpm (from ' + pl(a.maxHR.estimate.n, 'run') + ', spikes ignored).' + (a.maxHR.estimate.lowConfidence ? ' Low confidence: only ' + a.maxHR.estimate.n + ' runs, so treat this as a rough guess.' : '') + ' Zones in this page are based on that.');
    else if (a.maxHR.estimate && a.maxHR.estimate.notEnough) out.push('Not enough data to estimate your maximum heart rate yet (needs at least 3 runs of 10 minutes or more with heart rate).');
    if (a.fitnessTrend.length >= 3 && a.fitnessSlopePerMonth != null) {
      var perYear = a.fitnessSlopePerMonth * 12, first = a.fitnessTrend[0], last = a.fitnessTrend[a.fitnessTrend.length - 1];
      out.push('At ' + S(a.refKmh) + ' your heart rate went from ' + Math.round(first.hr) + ' bpm (' + first.month + ') to ' + Math.round(last.hr) + ' bpm (' + last.month + '): ' +
        (Math.abs(perYear) < 2 ? 'about level, so no clear change in fitness.' : perYear < 0 ? 'lower is fitter, so your fitness is improving.' : 'higher means harder for the same pace; fatigue, heat or lost fitness may be behind it.'));
    }
    if (a.drift.n >= 3) {
      var dm = a.drift.median;
      out.push('On steady stretches after the first 10 minutes your heart rate drifts ' + (dm >= 0 ? 'up' : 'down') + ' by about ' + r2(Math.abs(dm)) + ' bpm per minute (typical run, ' + pl(a.drift.n, 'run') + ').' +
        (dm > 0.5 ? ' That is a lot: the controller should expect to lower effort in long runs.' : dm < 0.1 ? ' That is small: she holds HR well at a steady pace.' : ''));
    }
    if (a.paceHrCurve.length >= 2) {
      var lo = a.paceHrCurve[0], hi = a.paceHrCurve[a.paceHrCurve.length - 1];
      if (hi.kmh > lo.kmh) out.push('Heart rate rises about ' + r1((hi.hr - lo.hr) / (hi.kmh - lo.kmh) * (fmt.speedStep || 1)) + ' bpm for every extra ' + (fmt.speedStepLabel || '1 km/h') + ' (from ' + S(lo.kmh) + ' to ' + S(hi.kmh) + ').');
    }
    if (a.gradeEffect.slopeBpmPerPct != null) out.push('Each 1% of uphill adds about ' + r1(a.gradeEffect.slopeBpmPerPct) + ' bpm at the same speed (' + a.gradeEffect.n + ' one-minute samples).');
    if (a.zones.totalSec) out.push('Time in zones: ' + a.zones.pct.map(function (p, i) { return 'Z' + (i + 1) + ' ' + Math.round(p) + '%'; }).join(', ') + '. ' +
      (a.zones.pct[3] + a.zones.pct[4] < 10 ? 'Very little time is spent in zone 4 or above, so zone 4 data for the model is thin.' : 'There is a useful amount of zone 4+ data.'));
    if (a.restHint) out.push('Heart rate at the very start of runs is as low as ' + a.restHint.bpm + ' bpm, so resting HR is at or below that.');
    var b5 = a.bestEfforts['5km'], b1 = a.bestEfforts['1km'];
    if (b5) out.push('Best 5 km: ' + fmtDur(b5.seconds) + ' (' + P(5000 / b5.seconds * 3.6) + ').');
    else if (b1) out.push('Best 1 km: ' + fmtDur(b1.seconds) + '.');
    var c = a.consistency;
    if (c.spanWeeks) out.push('You ran in ' + c.activePct + '% of weeks (about ' + c.runsPerWeek + ' runs a week); longest break ' + c.longestGapDays + ' ' + (c.longestGapDays === 1 ? 'day' : 'days') + '.');
    if (a.quality.gpsSpike || a.quality.stops) out.push('Data quality: ' + a.quality.gpsSpike + ' runs have GPS jumps and ' + a.quality.stops + ' have long stops; these are excluded from drift and best-effort figures where they matter.');
    return out;
  }
  function pl(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fmtDur(s) { s = Math.round(s); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2); }

  var HRAnalysis = {
    CFG: CFG, prep: prep, windows: windows, steadySections: steadySections, runMetrics: runMetrics, publicMetrics: publicMetrics,
    analyse: analyse, findings: findings, estimateMaxHR: estimateMaxHR, zonesFromHist: zonesFromHist, zoneIndex: zoneIndex,
    bestEffortSec: bestEffortSec, histogram: histogram, lsq: lsq, median: median, mean: mean, pct: pct, fmtDur: fmtDur,
    weeklyVolume: weeklyVolume, LENGTH_EDGES_M: LENGTH_EDGES_M
  };
  root.HRAnalysis = HRAnalysis;
  if (typeof module !== 'undefined' && module.exports) module.exports = HRAnalysis;
})(typeof window !== 'undefined' ? window : globalThis);
