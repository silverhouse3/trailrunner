// ============================================================================
// RunAgain — replay a saved run (or a Strava activity) as a programmed workout,
// optionally X% HARDER. Plain JS (Chrome 83 / Android 7.1.2 WebView), no deps.
//
//   src  = RunAgain.fromRun(savedRun)                 // local run (trackPoints every ~5 s)
//   src  = RunAgain.fromStrava(streams, {id, name})   // Strava activity streams (derived, flagged)
//   w    = RunAgain.build(src, { pct: 5, basis: 'time' | 'distance' })
//   RunAgain.preview(w, src)  → numbers for the PREVIEW card
//   RunAgain.save(w)          → workout library ('Run again +5%')
//   RunAgain.open(src, opts)  → in-page card: % selector, basis, preview, ARM / SAVE
//
// SAFETY: a built workout is only ARMED (App.armWorkout); the belt starts when the user taps
// START. Every speed goes through TM.setSpeed's rate limiter and maximum-speed clamp; every
// incline through TM.setIncline. Nothing here talks to the bridge.
// ============================================================================
(function (root) {
  'use strict';

  function r1(x) { return Math.round(x * 10) / 10; }
  function r05(x) { return Math.round(x * 2) / 2; }
  function ceil05(x) { return Math.ceil(x * 2 - 1e-9) / 2; }
  function fmtT(s) { s = Math.round(s); var m = Math.floor(s / 60), ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; }
  // top-level `const UI/App/Store/Engine` are global lexical bindings, NOT window properties → resolve by name
  function G(name) { try { return new Function('return typeof ' + name + " !== 'undefined' ? " + name + ' : undefined')(); } catch (e) { return undefined; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var RunAgain = {
    PCTS: [2.5, 5, 10],
    DEFAULT_PCT: 5,
    MAX_PCT: 20,
    KEY_PCT: 'tr_runagain_pct',
    KEY_PENDING: 'tr_runagain_pending',
    MIN_STAGE_S: 10,
    MAX_STAGE_S: 30,
    MIN_RUN_KPH: 0.8,        // slower = a pause → dropped from the plan (the belt must never be commanded to crawl/stop mid-plan)
    SPEED_TOL: 0.3,          // adjacent stages within this (and INC_TOL) are merged up to MAX_STAGE_S
    INC_TOL: 0.5,

    // ── remembered % ────────────────────────────────────────────────────────
    lastPct: function () {
      try { var v = parseFloat(root.localStorage.getItem(this.KEY_PCT)); if (v >= 0 && v <= this.MAX_PCT) return v; } catch (e) {}
      return this.DEFAULT_PCT;
    },
    rememberPct: function (p) { try { root.localStorage.setItem(this.KEY_PCT, String(p)); } catch (e) {} },

    // ── limits (machine + user; all optional) ───────────────────────────────
    limits: function () {
      var TM = G('TM'), S = G('Store'), s = null;
      try { s = S && S.getSettings ? S.getSettings() : null; } catch (e) {}
      var maxKph = TM && TM.maxKph ? TM.maxKph() : 19.3;
      var maxInc = TM && TM.machineMaxIncline > 0 ? TM.machineMaxIncline : 15;
      if (s && s.safetyMaxIncline > 0) maxInc = Math.min(maxInc, s.safetyMaxIncline);
      var minInc = TM && typeof TM.machineMinIncline === 'number' ? TM.machineMinIncline : -3;
      return { maxKph: maxKph, maxInc: maxInc, minInc: minInc };
    },

    // ── sources ─────────────────────────────────────────────────────────────
    /** Saved local run → timeline. trackPoints: {elapsed, dist, speed, hr, ele, incline?} every ~5 s. */
    fromRun: function (run) {
      if (!run) return null;
      var pts = run.trackPoints || [];
      var points = [], hasInc = false;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (p == null || typeof p.elapsed !== 'number') continue;
        var inc = (typeof p.incline === 'number' && !isNaN(p.incline)) ? p.incline : null;
        if (inc != null) hasInc = true;
        points.push({ t: p.elapsed, d: p.dist || 0, speed: +p.speed || 0, incline: inc });
      }
      if (points.length < 2) return { kind: 'run', error: 'This run has no speed timeline recorded (runs shorter than ~10 s, or saved by an older version).', name: run.routeName || 'Run' };
      var distM = run.distanceM != null ? run.distanceM : (run.distanceKm || 0) * 1000;
      return { kind: 'run', id: run.id || null, name: run.routeName || 'Free Run', routeId: run.routeId || null,
        elapsed: run.elapsed || points[points.length - 1].t, distM: distM || points[points.length - 1].d, points: points, hasIncline: hasInc, derived: false };
    },

    /** Strava activity streams → timeline (derived: velocity_smooth m/s, grade_smooth %). */
    fromStrava: function (streams, meta) {
      meta = meta || {};
      if (!streams || !streams.time || !streams.velocity_smooth) return { kind: 'strava', error: 'This Strava activity has no speed stream.', name: meta.name || 'Strava activity' };
      var t = streams.time, v = streams.velocity_smooth, d = streams.distance || null, g = streams.grade_smooth || null;
      var lim = this.limits(), points = [];
      for (var i = 0; i < t.length; i++) {
        var inc = g && typeof g[i] === 'number' ? Math.max(lim.minInc, Math.min(lim.maxInc, r05(g[i]))) : null;
        points.push({ t: t[i], d: d ? d[i] : 0, speed: r1((v[i] || 0) * 3.6), incline: inc });
      }
      if (points.length < 2) return { kind: 'strava', error: 'Not enough samples in this activity.', name: meta.name || 'Strava activity' };
      return { kind: 'strava', id: meta.id != null ? 'strava_' + meta.id : null, name: meta.name || 'Strava activity', routeId: meta.routeId || null,
        elapsed: t[t.length - 1], distM: d ? d[d.length - 1] : 0, points: points, hasIncline: !!g, derived: true };
    },

    // ── stages ──────────────────────────────────────────────────────────────
    /** Smooth the timeline into 10–30 s (or distance) stages. Returns [{duration|distance, speed, incline, label}]. */
    stages: function (src, basis) {
      if (!src || src.error || !src.points || src.points.length < 2) return [];
      basis = basis === 'distance' && src.distM > 0 ? 'distance' : 'time';
      var pts = src.points, buckets = [], i;
      if (basis === 'time') {
        var w = this.MIN_STAGE_S, t0 = pts[0].t, tEnd = pts[pts.length - 1].t;
        for (var ts = t0; ts < tEnd; ts += w) {
          var te = Math.min(tEnd, ts + w);
          buckets.push(this._avgBucket(pts, 't', ts, te, { duration: te - ts }));
        }
      } else {
        var avgKph = src.elapsed > 0 ? (src.distM / src.elapsed) * 3.6 : 8;
        var wm = Math.max(100, Math.round(avgKph / 3.6 * this.MIN_STAGE_S)), dEnd = src.distM;
        for (var ds = 0; ds < dEnd; ds += wm) {
          var de = Math.min(dEnd, ds + wm);
          buckets.push(this._avgBucket(pts, 'd', ds, de, { distanceM: de - ds }));
        }
      }
      // drop pauses (belt at ~0) and empty buckets
      var kept = [];
      for (i = 0; i < buckets.length; i++) { var b = buckets[i]; if (b && b.n > 0 && b.speed >= this.MIN_RUN_KPH) kept.push(b); }
      // merge neighbours: identical (after rounding) merge freely; near-identical up to MAX_STAGE_S (or 3 distance windows)
      var out = [];
      for (i = 0; i < kept.length; i++) {
        var k = kept[i], last = out[out.length - 1];
        if (last) {
          var same = last.speed === k.speed && last.incline === k.incline;
          var close = Math.abs(last.speed - k.speed) <= this.SPEED_TOL && Math.abs((last.incline || 0) - (k.incline || 0)) <= this.INC_TOL;
          var sizeOk = basis === 'time' ? (last.duration + k.duration) <= this.MAX_STAGE_S : last.nWin < 3;
          if (same || (close && sizeOk)) {
            var wA = basis === 'time' ? last.duration : last.distanceM, wB = basis === 'time' ? k.duration : k.distanceM;
            last.speed = r1((last.speed * wA + k.speed * wB) / (wA + wB));
            last.incline = (last.incline == null && k.incline == null) ? null : r05(((last.incline || 0) * wA + (k.incline || 0) * wB) / (wA + wB));
            if (basis === 'time') last.duration += k.duration; else last.distanceM += k.distanceM;
            last.nWin++;
            continue;
          }
        }
        out.push({ duration: k.duration, distanceM: k.distanceM, speed: k.speed, incline: k.incline, nWin: 1 });
      }
      return out.map(function (s, idx) {
        var st = { speed: s.speed, incline: s.incline == null ? 0 : s.incline, label: 'Stage ' + (idx + 1) };
        if (basis === 'time') st.duration = Math.max(1, Math.round(s.duration)); else st.distance = Math.round(s.distanceM) / 1000;
        return st;
      });
    },
    _avgBucket: function (pts, key, a, b, base) {
      var sum = 0, n = 0, isum = 0, inn = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], x = p[key];
        if (x < a || x >= b) { if (x >= b) break; continue; }
        sum += p.speed; n++;
        if (p.incline != null) { isum += p.incline; inn++; }
      }
      if (!n) {
        // no sample inside: interpolate from the nearest sample before the window
        for (var j = pts.length - 1; j >= 0; j--) if (pts[j][key] < a) { sum = pts[j].speed; n = 1; if (pts[j].incline != null) { isum = pts[j].incline; inn = 1; } break; }
      }
      base.n = n; base.speed = n ? r1(sum / n) : 0; base.incline = inn ? r05(isum / inn) : null; base.nWin = 1;
      return base;
    },

    // ── harder ──────────────────────────────────────────────────────────────
    /** X% harder: speed ×(1+0.4p), incline ×(1+0.6p) (min +0.25 pp where incline > 0), +0.5 kph min nudge if p ≥ 5%.
     *  Caps: machine/user max speed, +1.5 kph over the original, incline ≤ bridge max and ≤ original +3 pp, descents never below the min. */
    harder: function (stages, pct, lim) {
      lim = lim || this.limits();
      var p = (pct || 0) / 100, clipped = 0;
      return { stages: stages.map(function (s) {
        var sp = s.speed * (1 + 0.4 * p);
        if (p >= 0.05) sp = Math.max(sp, s.speed + 0.5);
        var spCap = Math.min(lim.maxKph, s.speed + 1.5);
        if (sp > spCap + 1e-9) { sp = spCap; clipped++; }
        sp = r1(Math.max(0, sp));
        if (sp > lim.maxKph) { sp = r1(lim.maxKph); }
        var inc = s.incline || 0;
        if (inc > 0 && p > 0) {
          var ni = Math.max(inc * (1 + 0.6 * p), inc + 0.25);
          var incCap = Math.min(lim.maxInc, inc + 3);
          if (ni > incCap + 1e-9) { ni = incCap; clipped++; }
          inc = ceil05(ni);
          if (inc > lim.maxInc) inc = r05(lim.maxInc);
        } else if (inc < 0) {
          inc = Math.max(lim.minInc, inc);   // descents are never made steeper, never below the machine minimum
        }
        return { duration: s.duration, distance: s.distance, speed: sp, incline: inc, label: s.label };
      }), clipped: clipped };
    },

    // ── build ───────────────────────────────────────────────────────────────
    build: function (src, opts) {
      opts = opts || {};
      var pct = typeof opts.pct === 'number' ? Math.max(0, Math.min(this.MAX_PCT, opts.pct)) : this.lastPct();
      var basis = opts.basis === 'distance' && src && src.routeId && src.distM > 0 ? 'distance' : 'time';
      var base = this.stages(src, basis);
      if (!base.length) return null;
      var lim = this.limits();
      var h = this.harder(base, pct, lim);
      var name = pct > 0 ? 'Run again +' + (pct % 1 ? pct.toFixed(1) : pct) + '%' : 'Run again';
      var w = {
        id: 'wk_ra_' + Date.now(), name: name, icon: '↻',
        desc: (src.name || 'Run') + (pct > 0 ? ' · ' + pct + '% harder' : ' · same effort') + (src.derived ? ' · from Strava (derived)' : ''),
        type: basis === 'distance' ? 'programmed' : 'interval-time',
        speedUnit: 'kph', distanceUnit: 'km', rounds: 1,
        warmUp: { enabled: false, duration: 0, speed: 0, incline: 0 },
        coolDown: { enabled: false, duration: 0, speed: 0, incline: 0 },
        tags: ['run again'],
        runAgain: { sourceKind: src.kind, sourceId: src.id, sourceName: src.name, routeId: src.routeId || null, pct: pct, basis: basis,
          inclineRecorded: !!src.hasIncline, derived: !!src.derived, originalElapsed: src.elapsed, originalDistM: src.distM, clipped: h.clipped },
      };
      if (basis === 'distance') w.segments = h.stages.map(function (s) { return { distance: s.distance, speed: s.speed, incline: s.incline, label: s.label }; });
      else w.intervals = h.stages.map(function (s) { return { duration: s.duration, speed: s.speed, incline: s.incline, label: s.label }; });
      w._base = base; // original (0 %) stages, for the preview; stripped on save
      return w;
    },

    preview: function (w, src) {
      if (!w) return null;
      var st = w.segments || w.intervals || [], n = st.length;
      var totalSec = 0, totalM = 0, maxK = 0, maxI = 0, spdSum = 0, wSum = 0;
      for (var i = 0; i < n; i++) {
        var s = st[i], wt = s.duration != null ? s.duration : (s.distance * 1000) / Math.max(0.5, s.speed / 3.6);
        var dm = s.distance != null ? s.distance * 1000 : s.speed / 3.6 * s.duration;
        totalSec += wt; totalM += dm; spdSum += s.speed * wt; wSum += wt;
        if (s.speed > maxK) maxK = s.speed; if (s.incline > maxI) maxI = s.incline;
      }
      var baseAvg = 0, bw = 0;
      (w._base || []).forEach(function (b) { var t = b.duration != null ? b.duration : (b.distance * 1000) / Math.max(0.5, b.speed / 3.6); baseAvg += b.speed * t; bw += t; });
      return { stages: n, totalSec: Math.round(totalSec), totalKm: r1(totalM / 1000) , avgKph: wSum ? r1(spdSum / wSum) : 0, maxKph: maxK, maxInc: maxI,
        origAvgKph: bw ? r1(baseAvg / bw) : 0, origElapsed: src ? Math.round(src.elapsed || 0) : 0, origDistM: src ? Math.round(src.distM || 0) : 0,
        clipped: w.runAgain ? w.runAgain.clipped : 0, inclineRecorded: w.runAgain ? w.runAgain.inclineRecorded : false, derived: w.runAgain ? w.runAgain.derived : false, basis: w.runAgain ? w.runAgain.basis : 'time' };
    },

    /** Save to the workout library (tr_workouts, same shape as the builder). Returns the stored copy. */
    save: function (w) {
      var copy = JSON.parse(JSON.stringify(w)); delete copy._base;
      copy.created = copy.created || Date.now(); copy.timesCompleted = copy.timesCompleted || 0;
      var lib = [];
      try { lib = JSON.parse(root.localStorage.getItem('tr_workouts') || '[]'); } catch (e) { lib = []; }
      var idx = -1; for (var i = 0; i < lib.length; i++) if (lib[i].id === copy.id) idx = i;
      if (idx >= 0) lib[idx] = copy; else lib.push(copy);
      try { root.localStorage.setItem('tr_workouts', JSON.stringify(lib)); } catch (e) {}
      return copy;
    },
    /** The runnable copy (no preview-only fields). */
    runnable: function (w) { var c = JSON.parse(JSON.stringify(w)); delete c._base; return c; },

    // ── pending hand-over from stats.html ───────────────────────────────────
    setPending: function (runId) { try { root.localStorage.setItem(this.KEY_PENDING, runId); } catch (e) {} },
    takePending: function () { try { var v = root.localStorage.getItem(this.KEY_PENDING); if (v) root.localStorage.removeItem(this.KEY_PENDING); return v || null; } catch (e) { return null; } },

    // ── in-page card ────────────────────────────────────────────────────────
    _card: null, _src: null, _opts: null, _pct: 5, _basis: 'time', _custom: false,
    open: function (src, opts) {
      this.close();
      this._src = src; this._opts = opts || {}; this._pct = this.lastPct(); this._custom = this.PCTS.indexOf(this._pct) < 0 && this._pct !== 0;
      this._basis = (src && src.routeId && src.distM > 0) ? 'distance' : 'time';
      var host = root.document.getElementById('rootApp') || root.document.body;
      var d = root.document.createElement('div'); d.className = 'ui-dlg-backdrop ra-backdrop'; d.id = 'runAgainCard';
      host.appendChild(d); this._card = d;
      this._render();
      return d;
    },
    close: function () { if (this._card && this._card.parentNode) this._card.parentNode.removeChild(this._card); this._card = null; },
    setPct: function (p) { p = Math.max(0, Math.min(this.MAX_PCT, +p || 0)); this._pct = p; this._custom = this.PCTS.indexOf(p) < 0 && p !== 0; this.rememberPct(p); this._render(); },
    setBasis: function (b) { this._basis = b === 'distance' ? 'distance' : 'time'; this._render(); },
    _render: function () {
      var d = this._card, src = this._src, self = this; if (!d) return;
      if (!src || src.error) {
        d.innerHTML = '<div class="ui-dlg ra-card"><div class="ra-title">↻ RUN AGAIN</div><div class="ui-dlg-msg">' + esc(src ? src.error : 'Nothing to replay.') + '</div><div class="ui-dlg-btns"><button class="btn-ghost ra-cancel" onclick="RunAgain.close()">CLOSE</button></div></div>';
        return;
      }
      var w = this.build(src, { pct: this._pct, basis: this._basis }), pv = this.preview(w, src);
      var chips = [0].concat(this.PCTS).map(function (p) {
        return '<button class="ra-chip' + (self._pct === p && !self._custom ? ' on' : '') + '" onclick="RunAgain.setPct(' + p + ')">' + (p === 0 ? 'SAME' : '+' + p + '%') + '</button>';
      }).join('') + '<button class="ra-chip' + (this._custom ? ' on' : '') + '" onclick="RunAgain.askCustom()">' + (this._custom ? '+' + this._pct + '% ✎' : 'CUSTOM…') + '</button>';
      var basis = src.routeId && src.distM > 0
        ? '<div class="ra-row"><span class="ra-lab">BASIS</span><button class="ra-chip' + (this._basis === 'distance' ? ' on' : '') + '" onclick="RunAgain.setBasis(\'distance\')">DISTANCE (route)</button><button class="ra-chip' + (this._basis === 'time' ? ' on' : '') + '" onclick="RunAgain.setBasis(\'time\')">TIME</button></div>'
        : '<div class="ra-row"><span class="ra-lab">BASIS</span><span class="ra-val">TIME (no route on this run)</span></div>';
      var notes = [];
      if (!pv.inclineRecorded) notes.push('incline not recorded on this ' + (src.kind === 'strava' ? 'activity' : 'run') + ' — stays as it was (0%)');
      if (pv.derived) notes.push('from Strava: speed/grade derived from GPS streams, flagged in the plan');
      if (pv.clipped) notes.push(pv.clipped + ' stage' + (pv.clipped > 1 ? 's' : '') + ' clipped by the speed / incline caps');
      d.innerHTML = '<div class="ui-dlg ra-card">' +
        '<div class="ra-title">↻ RUN AGAIN <small>' + esc(src.name) + ' · ' + fmtT(src.elapsed || 0) + ' · ' + Units.distU(src.distM || 0) + '</small></div>' +
        '<div class="ra-row" id="raPctLine" data-pct="' + this._pct + '"><span class="ra-lab">HARDER</span>' + chips + '</div>' + basis +
        '<div class="ra-notes" id="raPctText">' + (this._pct > 0 ? this._pct + '% harder than the original run' : 'Same effort as the original run') + '</div>' +
        '<div class="ra-preview" id="raPreview">' +
          '<div class="ra-pv"><b>' + (w ? pv.stages : 0) + '</b><span>STAGES</span></div>' +
          '<div class="ra-pv"><b>' + fmtT(pv.totalSec) + '</b><span>TIME</span></div>' +
          '<div class="ra-pv"><b>' + Units.distKm(pv.totalKm, 1) + '</b><span>' + Units.distLabel().toUpperCase() + '</span></div>' +
          '<div class="ra-pv"><b>' + Units.speed(pv.avgKph) + '</b><span>AVG ' + Units.speedLabel().toUpperCase() + (pv.origAvgKph ? ' (was ' + Units.speed(pv.origAvgKph) + ')' : '') + '</span></div>' +
          '<div class="ra-pv"><b>' + Units.speed(pv.maxKph) + '</b><span>MAX ' + Units.speedLabel().toUpperCase() + '</span></div>' +
          '<div class="ra-pv"><b>' + pv.maxInc.toFixed(1) + '%</b><span>MAX INCLINE</span></div>' +
        '</div>' +
        (notes.length ? '<div class="ra-notes">' + notes.map(esc).join(' · ') + '</div>' : '') +
        '<div class="ra-stages">' + this._stageBar(w) + '</div>' +
        '<div class="ui-dlg-btns">' +
          '<button class="btn-ghost ra-cancel" onclick="RunAgain.close()">CANCEL</button>' +
          '<button class="btn-outline ra-save" onclick="RunAgain.saveFromCard()">💾 SAVE TO LIBRARY</button>' +
          '<button class="fc-btn fc-start ra-arm" onclick="RunAgain.armFromCard()">▶ ARM — START ON THE LIVE SCREEN</button>' +
        '</div></div>';
    },
    _stageBar: function (w) {
      if (!w) return '';
      var st = w.segments || w.intervals || [], max = 0.1, tot = 0, i;
      for (i = 0; i < st.length; i++) { var s = st[i]; max = Math.max(max, s.speed); tot += s.duration != null ? s.duration : s.distance; }
      var html = '';
      for (i = 0; i < st.length; i++) { var x = st[i], wgt = (x.duration != null ? x.duration : x.distance) / tot * 100; html += '<i style="width:' + wgt.toFixed(2) + '%;height:' + Math.round(x.speed / max * 100) + '%" title="' + esc(x.label) + ' ' + x.speed + ' km/h ' + x.incline + '%"></i>'; }
      return html;
    },
    askCustom: function () {
      var self = this;
      var UI = G('UI'); var ask = UI && UI.prompt ? UI.prompt('How much harder? (0–' + this.MAX_PCT + ' %)', String(this._pct)) : Promise.resolve(root.prompt('How much harder? (0–' + this.MAX_PCT + ' %)', String(this._pct)));
      ask.then(function (v) { if (v == null || v === '') return; var p = parseFloat(v); if (isNaN(p)) return; self.setPct(p); });
    },
    saveFromCard: function () {
      var w = this.build(this._src, { pct: this._pct, basis: this._basis }); if (!w) return;
      var saved = this.save(w);
      var App = G('App'); if (App && App._toast) App._toast('Saved "' + saved.name + '" to your workouts', 'var(--green)');
      if (this._opts.onSave) this._opts.onSave(saved);
      this.close();
      return saved;
    },
    armFromCard: function () {
      var w = this.build(this._src, { pct: this._pct, basis: this._basis }); if (!w) return;
      var saved = this.save(w);
      this.close();
      if (this._opts.onArm) this._opts.onArm(saved);
      else { var App = G('App'); if (App && App.armWorkout) App.armWorkout(saved); }
      return saved;
    },
  };

  root.RunAgain = RunAgain;
  if (typeof module !== 'undefined' && module.exports) module.exports = RunAgain;
})(typeof window !== 'undefined' ? window : globalThis);
