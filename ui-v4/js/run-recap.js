// ============================================================================
// RunRecap - post-run recap card (run-end summary + stats.html run detail).
//   var rc = RunRecap.build(run, history, {now})   // pure data, stored WITH the run as run.recap
//   RunRecap.render(el, rc)                        // HTML in the current Units system
// Numbers are stored in metric (sec per km, km/h, metres); wording follows Units at render time,
// so a recap saved in km still reads in miles when the user is on imperial. Plain JS, no deps.
// Same-route comparison only (routeId must match); otherwise "first run on this route".
// ============================================================================
(function (root) {
  'use strict';
  var M_MI = 1609.344;
  function U() { return (typeof Units !== 'undefined') ? Units : null; }
  function imp() { var u = U(); return !!(u && u.imp && u.imp()); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtT(s) { s = Math.round(Math.max(0, s || 0)); var m = Math.floor(s / 60), ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; }
  function runKm(r) { return r.distanceKm || (r.distanceM ? r.distanceM / 1000 : 0) || 0; }
  function runTime(r) { return r.elapsed || r.elapsedSec || 0; }
  function runStamp(r) { var t = Date.parse(r.finishedAt || r.savedAt || r.startedAt || r.date || ''); return isNaN(t) ? 0 : t; }

  var RunRecap = {
    VERSION: 1,

    /** Cumulative [{d (m), t (s)}] from km splits (+ final split), else from trackPoints. */
    _curve: function (run) {
      var pts = [{ d: 0, t: 0 }], d = 0, t = 0, i;
      var ss = (run.splits || []).filter(function (s) { return s && !s.partial && +s.timeSec > 0; });
      if (ss.length) {
        for (i = 0; i < ss.length; i++) { d += 1000; t += +ss[i].timeSec; pts.push({ d: d, t: t }); }
        var fs = run.finalSplit;
        if (fs && +fs.timeSec > 0 && +fs.distKm > 0) pts.push({ d: d + fs.distKm * 1000, t: t + +fs.timeSec });
        return pts;
      }
      var tp = run.trackPoints || [];
      for (i = 0; i < tp.length; i++) {
        var dd = +tp[i].dist, tt = tp[i].elapsed != null ? +tp[i].elapsed : NaN;
        if (isNaN(tt) || !(dd > pts[pts.length - 1].d) || !(tt > pts[pts.length - 1].t)) continue;
        pts.push({ d: dd, t: tt });
      }
      return pts.length > 1 ? pts : [];
    },
    _tAt: function (c, x) {
      for (var j = 1; j < c.length; j++) if (x <= c[j].d + 1e-6) { var a = c[j - 1], b = c[j]; return a.t + (b.t - a.t) * ((x - a.d) / (b.d - a.d)); }
      return c[c.length - 1].t;
    },
    /** Fastest whole split of `unitM` metres: { n, timeSec, fromM, toM } or null. */
    bestSplit: function (run, unitM) {
      var c = this._curve(run); if (!c.length) return null;
      var total = c[c.length - 1].d, n = Math.floor(total / unitM + 1e-6), best = null;
      for (var i = 0; i < n; i++) {
        var tm = this._tAt(c, (i + 1) * unitM) - this._tAt(c, i * unitM);
        if (tm > 0 && (!best || tm < best.timeSec)) best = { n: i + 1, timeSec: Math.round(tm), fromM: Math.round(i * unitM), toM: Math.round((i + 1) * unitM) };
      }
      return best;
    },

    _zones: function (run) {
      var z = run.hrZoneMinutes || run._hrZoneMinutes; if (!z) return null;
      var secs = [1, 2, 3, 4, 5].map(function (k) { return Math.round((+z['z' + k] || 0) * 60); });
      var tot = secs.reduce(function (a, b) { return a + b; }, 0);
      if (tot <= 0) return null;
      return secs.map(function (s, i) { return { z: i + 1, sec: s, pct: Math.round(s / tot * 100) }; });
    },
    _peakHR: function (run) {
      var m = 0, tp = run.trackPoints || [], i;
      for (i = 0; i < tp.length; i++) if (+tp[i].hr > m) m = +tp[i].hr;
      if (!m) { var ss = run.splits || []; for (i = 0; i < ss.length; i++) if (+ss[i].avgHR > m) m = +ss[i].avgHR; }
      return m;
    },
    _peakSpeed: function (run) {
      var m = +run.maxSpeed || +run._speedMax || 0, tp = run.trackPoints || [];
      for (var i = 0; i < tp.length; i++) if (+tp[i].speed > m) m = +tp[i].speed;
      return +m.toFixed(1);
    },

    /** Build the recap. history = stored runs (any order; the run itself, by id, is ignored). */
    build: function (run, history, opts) {
      if (!run) return null;
      opts = opts || {};
      var now = opts.now || runStamp(run) || Date.now();
      var km = runKm(run), el = runTime(run);
      var hist = (history || []).filter(function (h) { return h && !h.imported && h.source !== 'strava' && (!run.id || h.id !== run.id) && runKm(h) > 0.2 && runTime(h) > 0 && runStamp(h) <= now + 1000; });
      hist.sort(function (a, b) { return runStamp(b) - runStamp(a); });
      var paceKm = km > 0 ? el / km : 0;
      var sc = (run._speedSamples > 0) ? run._speedSum / run._speedSamples : 0;
      var rc = {
        v: this.VERSION,
        distanceKm: +km.toFixed(2), elapsed: Math.round(el), paceSecPerKm: Math.round(paceKm),
        bestKm: this.bestSplit(run, 1000), bestMile: this.bestSplit(run, M_MI),
        climbM: Math.round(run.elevGained || 0),
        avgSpeedKph: +(run.avgSpeed || sc || (el > 0 ? km / (el / 3600) : 0)).toFixed(1),
        peakSpeedKph: this._peakSpeed(run),
        avgHR: Math.round(run.avgHR || (run._hrSamples > 0 ? run._hrSum / run._hrSamples : 0)) || 0,
        peakHR: this._peakHR(run),
        zones: this._zones(run),
        sameRoute: { kind: 'first' },
        recent: null,
        highlights: [],
      };
      // same-route comparison (route id must match; free runs never compare)
      if (run.routeId) {
        var prev = null;
        for (var i = 0; i < hist.length; i++) if (hist[i].routeId === run.routeId) { prev = hist[i]; break; }
        if (prev) {
          var pk = runKm(prev), pe = runTime(prev), pPace = pe / pk;
          var comparable = km > 0 && Math.abs(pk - km) / km <= 0.05;
          var d = comparable ? el - pe : (paceKm - pPace) * km;
          rc.sameRoute = { kind: Math.abs(d) < 2 ? 'same' : d < 0 ? 'faster' : 'slower', deltaSec: Math.round(Math.abs(d)), byPace: !comparable,
            deltaPaceSecPerKm: Math.round(paceKm - pPace), prevName: prev.routeName || 'Route', prevId: prev.id || null };
        }
      }
      // user's average of recent runs (up to the last 5, any route)
      var rec = hist.slice(0, 5);
      if (rec.length && paceKm > 0) {
        var kmSum = 0, tSum = 0; rec.forEach(function (h) { kmSum += runKm(h); tSum += runTime(h); });
        var rp = tSum / kmSum;
        rc.recent = { n: rec.length, paceSecPerKm: Math.round(rp), deltaPaceSecPerKm: Math.round(paceKm - rp), avgKm: +(kmSum / rec.length).toFixed(2) };
      }
      // highlights (ids + numbers; wording at render time)
      var DAY = 86400000, month = hist.filter(function (h) { return now - runStamp(h) <= 30 * DAY; }), week = hist.filter(function (h) { return now - runStamp(h) <= 7 * DAY; });
      var self = this, hl = rc.highlights;
      var cur = imp() ? [M_MI, rc.bestMile] : [1000, rc.bestKm];
      if (cur[1] && month.length && month.every(function (h) { var b = self.bestSplit(h, cur[0]); return !b || cur[1].timeSec < b.timeSec; })) hl.push({ id: 'fastestSplitMonth' });
      if (week.length && km > 0 && week.every(function (h) { return km > runKm(h); })) hl.push({ id: 'longestWeek' });
      if (rc.sameRoute.kind === 'faster') hl.push({ id: 'fasterOnRoute', sec: rc.sameRoute.deltaSec });
      if (month.length && rc.climbM > 0 && month.every(function (h) { return rc.climbM > (h.elevGained || 0); })) hl.push({ id: 'biggestClimbMonth' });
      if (rc.recent && rc.recent.deltaPaceSecPerKm <= -5) hl.push({ id: 'fasterThanRecent' });
      if (!hl.length) hl.push({ id: 'steady' });
      rc.highlights = hl.slice(0, 3);
      return rc;
    },

    // ── wording (current Units) ─────────────────────────────────────────────
    _word: function () { return imp() ? 'mile' : 'km'; },
    _pace: function (secPerKm) { var u = U(); return u ? u.pace(secPerKm) + u.paceSlash() : fmtT(secPerKm) + '/km'; },
    _bestFor: function (rc) { return imp() ? rc.bestMile : rc.bestKm; },
    highlightText: function (h, rc) {
      var w = this._word(), W = w.charAt(0).toUpperCase() + w.slice(1);
      switch (h.id) {
        case 'fastestSplitMonth': return 'Fastest ' + w + ' of the month';
        case 'longestWeek': return 'Longest run this week';
        case 'fasterOnRoute': return 'Beat your last time on this route by ' + fmtT(h.sec);
        case 'biggestClimbMonth': return 'Biggest climb this month';
        case 'fasterThanRecent': return 'Faster than your recent runs';
        default: return 'Steady run: ' + this._pace(rc.paceSecPerKm) + ' average';
      }
    },
    _vs: function (sec, unitWord) { // per-unit pace delta text
      var u = U(), perUnit = Math.abs(u ? u.paceSecPerUnit(sec) : sec);
      return fmtT(perUnit) + ' ' + (unitWord || '/km');
    },

    /** Recap model as plain lines (what the card shows; also used by tests). */
    lines: function (rc) {
      if (!rc) return null;
      var u = U(), o = { highlights: [], rows: [] }, b = this._bestFor(rc), w = this._word();
      o.best = b ? ('Best ' + w + ': ' + w + ' ' + b.n + ' in ' + fmtT(b.timeSec) + (u ? ' (' + u.dist(b.fromM, 1) + ' to ' + u.dist(b.toM, 1) + ' ' + u.distLabel() + ')' : '')) : 'No full ' + w + ' covered';
      o.climb = 'Total climb: ' + (u ? u.elevU(rc.climbM) : rc.climbM + ' m');
      o.speed = 'Average ' + (u ? u.speedU(rc.avgSpeedKph) : rc.avgSpeedKph + ' km/h') + ' | peak ' + (u ? u.speedU(rc.peakSpeedKph) : rc.peakSpeedKph + ' km/h');
      o.hr = rc.avgHR > 0 ? 'Heart rate: average ' + rc.avgHR + ', peak ' + rc.peakHR + ' bpm' : null;
      var sr = rc.sameRoute;
      if (sr.kind === 'first') o.route = 'First run on this route';
      else if (sr.kind === 'same') o.route = 'Same as your last run on this route';
      else if (sr.byPace) o.route = (sr.kind === 'faster' ? 'Faster' : 'Slower') + ' than your last run on this route by ' + this._vs(sr.deltaPaceSecPerKm, imp() ? '/mi' : '/km');
      else o.route = (sr.kind === 'faster' ? 'Faster' : 'Slower') + ' than your last run on this route by ' + fmtT(sr.deltaSec);
      if (rc.recent) {
        var d = rc.recent.deltaPaceSecPerKm;
        o.recent = Math.abs(d) < 2 ? 'About the same pace as your last ' + rc.recent.n + ' runs'
          : (d < 0 ? 'Faster' : 'Slower') + ' than your last ' + rc.recent.n + ' runs by ' + this._vs(d, imp() ? '/mi' : '/km');
      } else o.recent = 'No earlier runs to compare with yet';
      var self = this; rc.highlights.forEach(function (h) { o.highlights.push(self.highlightText(h, rc)); });
      return o;
    },

    render: function (el, rc) {
      if (!el) return;
      var L = this.lines(rc);
      if (!L) { el.innerHTML = ''; return; }
      var zoneHtml = '';
      if (rc.zones) {
        var cols = ['#6b7280', '#3ecfff', '#22c55e', '#ffab00', '#ef4444'];
        zoneHtml = '<div class="rc-zones" aria-label="Time in heart rate zones">' + rc.zones.map(function (z) {
          return '<span class="rc-z" style="flex:' + Math.max(1, z.pct) + ';background:' + cols[z.z - 1] + '" title="Zone ' + z.z + '">Z' + z.z + ' ' + fmtT(z.sec) + '</span>';
        }).join('') + '</div>';
      }
      el.innerHTML = '<div class="rc-card" id="runRecap">' +
        '<div class="rc-title">RUN RECAP</div>' +
        '<ul class="rc-hl">' + L.highlights.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
        '<div class="rc-row rc-best">' + esc(L.best) + '</div>' +
        '<div class="rc-row">' + esc(L.climb) + '</div>' +
        '<div class="rc-row">' + esc(L.speed) + '</div>' +
        (L.hr ? '<div class="rc-row">' + esc(L.hr) + '</div>' : '') + zoneHtml +
        '<div class="rc-row rc-route">' + esc(L.route) + '</div>' +
        '<div class="rc-row rc-recent">' + esc(L.recent) + '</div></div>';
    },
  };
  root.RunRecap = RunRecap;
  if (typeof module !== 'undefined' && module.exports) module.exports = RunRecap;
})(typeof window !== 'undefined' ? window : globalThis);
