// ════════════════════════════════════════════════════════════════════════════
// PastRunSplits — pool of past runs' per-km split arrays, used by the run-end
// summary and by stats.html to compare THIS run against FASTEST / SLOWEST /
// MEDIAN per km index (and LOWEST / HIGHEST / MEDIAN average HR per km).
//
// Works in both index.html (Store available) and stats.html (reads localStorage
// directly). No dependency on Engine/TM — pure data.
//
// ── Adding a second data source (e.g. Strava efforts) ───────────────────────
//   PastRunSplits.sources.push(function (routeIdOrNull, distanceKm) {
//     // return an array of PastRun objects (see shape below), or []
//   });
//   PastRun shape: { id, date (ISO), name, source: 'strava',
//                    distanceKm, splits: [{ km: 1, timeSec: 312, avgHR: 148 }, …] }
//   Splits are consecutive full kilometres starting at km 1. A source may also
//   set finalSplit: { distKm, timeSec, avgHR, partial: true } for the last bit.
//   Everything that pushes into `sources` is merged into get() automatically; the
//   local runs below are just the first source. (Strava integration is NOT done
//   here — the Strava agent will supply efforts into this pool.)
// ════════════════════════════════════════════════════════════════════════════

var PastRunSplits = {
  MIN_RUNS: 2,                 // comparison columns need at least this many past runs on the same route

  sources: [],

  /** Read stored runs (newest first). Store when available, else raw localStorage. */
  _localRuns: function () {
    if (typeof Store !== 'undefined' && Store.getRuns) return Store.getRuns();
    try { return JSON.parse(localStorage.getItem('tr_runs') || '[]'); } catch (e) { return []; }
  },

  /** Normalise a stored run into the PastRun shape; returns null if it has no usable splits. */
  normalise: function (r) {
    if (!r) return null;
    var splits = [];
    if (r.splits && r.splits.length) {
      for (var i = 0; i < r.splits.length; i++) {
        var s = r.splits[i];
        if (!s || s.partial) continue;
        splits.push({ km: s.km || (i + 1), timeSec: +s.timeSec || 0, avgHR: +s.avgHR || 0 });
      }
    }
    if (!splits.length && !(r.finalSplit && r.finalSplit.timeSec)) return null;
    return {
      id: r.id || r.startedAt || r.savedAt,
      date: r.savedAt || r.startedAt || r.date || null,
      name: r.routeName || 'Free Run',
      routeId: r.routeId || null,
      source: r.source || (r.demo ? 'demo' : 'local'),
      distanceKm: r.distanceKm || (r.distanceM ? r.distanceM / 1000 : 0),
      splits: splits,
      finalSplit: r.finalSplit || null,
      trackPoints: r.trackPoints || null,
    };
  },

  /** True when splits should be shown per mile (Units imperial). */
  perMile: function () { return typeof Units !== 'undefined' && Units.imp && Units.imp(); },
  /** Split word for labels: 'Mile' / 'Km'. */
  unitWord: function () { return this.perMile() ? 'Mile' : 'Km'; },

  /**
   * Regroup a run's splits for DISPLAY in the current unit system. Stored data stays per-km.
   * Metric: returned as-is (non-partial km splits + finalSplit). Imperial: cumulative time is
   * interpolated by distance across the stored km splits (or trackPoints when a run has none)
   * and cut at 1609.344 m boundaries. Result: { unit:'mi'|'km', splits:[{km:n,timeSec,avgHR}],
   * finalSplit:{distKm:<dist in display unit>, timeSec, avgHR, paceSecPerKm (per km), partial:true}|null }
   * (`km` is the split index in the display unit). Idempotent via _u flag.
   */
  regroup: function (run) {
    var imp = this.perMile();
    if (!run) return run;
    if (run._u === (imp ? 'mi' : 'km')) return run;
    var out = { splits: [], finalSplit: run.finalSplit || null };
    for (var k in run) if (!(k in out) && k !== 'trackPoints') out[k] = run[k];
    out._u = imp ? 'mi' : 'km';
    out.unit = out._u;
    if (!imp) {
      out.splits = (run.splits || []).filter(function (s) { return s && !s.partial; })
        .map(function (s, i) { return { km: s.km || (i + 1), timeSec: +s.timeSec || 0, avgHR: +s.avgHR || 0 }; });
      return out;
    }
    // Segments: {d0,d1 (m), t0,t1 (s), hr}
    var segs = [], d = 0, t = 0, i;
    var ss = (run.splits || []).filter(function (s) { return s && !s.partial && +s.timeSec > 0; });
    if (ss.length) {
      for (i = 0; i < ss.length; i++) { segs.push({ d0: d, d1: d + 1000, t0: t, t1: t + +ss[i].timeSec, hr: +ss[i].avgHR || 0 }); d += 1000; t += +ss[i].timeSec; }
      var fs = run.finalSplit;
      if (fs && +fs.timeSec > 0 && +fs.distKm > 0) { segs.push({ d0: d, d1: d + fs.distKm * 1000, t0: t, t1: t + +fs.timeSec, hr: +fs.avgHR || 0 }); }
    } else if (run.trackPoints && run.trackPoints.length > 1) {
      var tp = run.trackPoints, pd = 0, pt = 0;
      for (i = 0; i < tp.length; i++) {
        var dd = +tp[i].dist, tt = +tp[i].elapsed;
        if (!(dd > pd) || !(tt > pt)) continue;
        segs.push({ d0: pd, d1: dd, t0: pt, t1: tt, hr: +tp[i].hr || 0 }); pd = dd; pt = tt;
      }
    } else if (run.finalSplit && +run.finalSplit.timeSec > 0) {
      segs.push({ d0: 0, d1: run.finalSplit.distKm * 1000, t0: 0, t1: +run.finalSplit.timeSec, hr: +run.finalSplit.avgHR || 0 });
    }
    if (!segs.length) return out;
    var total = segs[segs.length - 1].d1, M = 1609.344;
    function tAt(x) {
      for (var j = 0; j < segs.length; j++) if (x <= segs[j].d1 + 1e-6) { var g = segs[j]; return g.t0 + (g.t1 - g.t0) * ((x - g.d0) / (g.d1 - g.d0)); }
      return segs[segs.length - 1].t1;
    }
    function hrIn(a, b) {
      var sum = 0, w = 0;
      for (var j = 0; j < segs.length; j++) {
        var g = segs[j], lo = Math.max(a, g.d0), hi = Math.min(b, g.d1);
        if (hi > lo && g.hr > 0) { var tw = (g.t1 - g.t0) * (hi - lo) / (g.d1 - g.d0); sum += g.hr * tw; w += tw; }
      }
      return w > 0 ? Math.round(sum / w) : 0;
    }
    var n = Math.floor(total / M + 1e-6);
    for (i = 0; i < n; i++) out.splits.push({ km: i + 1, timeSec: tAt((i + 1) * M) - tAt(i * M), avgHR: hrIn(i * M, (i + 1) * M) });
    var rem = total - n * M;
    out.finalSplit = null;
    if (rem > 16) { // ignore slivers under ~0.01 mi
      var ft = tAt(total) - tAt(n * M);
      out.finalSplit = { distKm: +(rem / M).toFixed(2), timeSec: ft, avgHR: hrIn(n * M, total), paceSecPerKm: Math.round(ft / (rem / 1000)), partial: true };
    }
    return out;
  },

  /**
   * Past runs to compare against.
   *   routeIdOrNull  — compare with previous runs on this SAME ROUTE only (owner's
   *                    rule). null (free run, no route loaded) → no comparison at all:
   *                    runs = [], basis 'none'. There is deliberately no fallback to
   *                    "similar-distance free runs".
   *   distanceKm     — this run's distance (passed through to extra sources)
   *   excludeId      — this run's id (so a just-saved run is not compared with itself)
   * Returns { runs: [PastRun…], basis: 'route'|'none', label: '…' }
   */
  get: function (routeIdOrNull, distanceKm, excludeId) {
    var all = this._localRuns().map(this.normalise).filter(function (x) { return !!x; });
    for (var i = 0; i < this.sources.length; i++) {
      try {
        var extra = this.sources[i](routeIdOrNull, distanceKm) || [];
        for (var j = 0; j < extra.length; j++) if (extra[j] && extra[j].splits) all.push(extra[j]);
      } catch (e) { /* a broken source must never break the summary */ }
    }
    all = all.map(function (r) { return PastRunSplits.regroup(r); });
    if (excludeId) all = all.filter(function (r) { return r.id !== excludeId; });

    var runs, basis, label;
    if (routeIdOrNull) {
      runs = all.filter(function (r) { return r.routeId === routeIdOrNull; });
      basis = 'route';
      label = runs.length + ' past run' + (runs.length === 1 ? '' : 's') + ' on this route';
    } else {
      runs = [];
      basis = 'none';
      label = 'No route loaded: pick a route to compare with past runs';
    }
    return { runs: runs, basis: basis, label: label };
  },

  /** Median of a numeric array (middle value; mean of the two middle values when even). */
  median: function (arr) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  },

  /**
   * Per-km comparison stats for km index `kmIdx` (1-based) across `runs`.
   * Returns { n, fastest, slowest, medianTime, hrN, lowestHR, highestHR, medianHR }
   * (null fields when fewer than MIN_RUNS values exist).
   */
  statsForKm: function (runs, kmIdx) {
    var times = [], hrs = [];
    for (var i = 0; i < runs.length; i++) {
      var s = runs[i].splits[kmIdx - 1];
      if (s && s.timeSec > 0) {
        times.push(s.timeSec);
        if (s.avgHR > 0) hrs.push(s.avgHR);
      }
    }
    var enoughT = times.length >= this.MIN_RUNS, enoughH = hrs.length >= this.MIN_RUNS;
    return {
      n: times.length,
      fastest: enoughT ? Math.min.apply(null, times) : null,
      slowest: enoughT ? Math.max.apply(null, times) : null,
      medianTime: enoughT ? this.median(times) : null,
      hrN: hrs.length,
      lowestHR: enoughH ? Math.min.apply(null, hrs) : null,
      highestHR: enoughH ? Math.max.apply(null, hrs) : null,
      medianHR: enoughH ? this.median(hrs) : null,
    };
  },
};
