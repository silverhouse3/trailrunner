// ════════════════════════════════════════════════════════════════════════════
// SplitCompare — renders the per-km split table + compact bar chart + verdict
// for a run, compared with PastRunSplits. Used on the run-end summary and on
// the stats.html run detail page. Colour-blind safe: every highlight carries an
// arrow + label as well as a colour.
//
//   SplitCompare.render(containerEl, run)
//     run: { id, routeId, distanceKm, splits: [{km,timeSec,avgHR}], finalSplit? }
//          (a live Engine.run or a stored run record both work)
// ════════════════════════════════════════════════════════════════════════════

var SplitCompare = {
  fmtTime: function (s) {
    if (s == null || isNaN(s)) return '—';
    s = Math.round(s);
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  },
  esc: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },

  /** Build the comparison model (also usable without rendering, e.g. for tests). */
  model: function (run) {
    run = PastRunSplits.regroup(run);
    var W = PastRunSplits.unitWord(), mi = PastRunSplits.perMile();
    var splits = [];
    (run.splits || []).forEach(function (s, i) {
      if (s && !s.partial && s.timeSec > 0) splits.push({ km: s.km || (i + 1), timeSec: +s.timeSec, avgHR: +s.avgHR || 0 });
    });
    var finalSplit = run.finalSplit && run.finalSplit.timeSec > 0 ? run.finalSplit : null;
    var distKm = run.distanceKm || (run.distanceM ? run.distanceM / 1000 : 0);
    var pool = PastRunSplits.get(run.routeId || null, distKm, run.id || null);
    var enough = pool.basis === 'route' && pool.runs.length >= PastRunSplits.MIN_RUNS;
    var rows = splits.map(function (s) {
      var st = enough ? PastRunSplits.statsForKm(pool.runs, s.km) : null;
      var flag = '', hrFlag = '';
      if (st && st.fastest != null) {
        if (s.timeSec < st.fastest) flag = 'best';
        else if (s.timeSec > st.slowest) flag = 'slowest';
        else if (st.medianTime != null) flag = s.timeSec <= st.medianTime ? 'faster' : 'slower';
      }
      if (st && st.lowestHR != null && s.avgHR > 0) {
        if (s.avgHR < st.lowestHR) hrFlag = 'lowest';
        else if (s.avgHR > st.highestHR) hrFlag = 'highest';
      }
      return { km: s.km, timeSec: s.timeSec, avgHR: s.avgHR, stats: st, flag: flag, hrFlag: hrFlag };
    });
    var fastestRow = null;
    rows.forEach(function (r) { if (!fastestRow || r.timeSec < fastestRow.timeSec) fastestRow = r; });
    var bests = rows.filter(function (r) { return r.flag === 'best'; }).length;
    var slows = rows.filter(function (r) { return r.flag === 'slowest'; }).length;
    var verdict = '';
    if (fastestRow) {
      verdict = 'Fastest ' + W.toLowerCase() + ': ' + fastestRow.km + ' (' + this.fmtTime(fastestRow.timeSec) + ')';
      if (enough && bests) verdict += ' · ▲ beat your best on ' + bests + ' ' + W.toLowerCase() + (bests > 1 ? 's' : '');
      if (enough && slows) verdict += ' · ▼ slower than all past runs on ' + slows + ' ' + W.toLowerCase() + (slows > 1 ? 's' : '');
      if (enough && !bests && !slows) verdict += ' · all splits within your past range';
    } else if (finalSplit) {
      verdict = 'Under 1 ' + W.toLowerCase() + ' — ' + finalSplit.distKm + ' ' + Units.distLabel() + ' in ' + this.fmtTime(finalSplit.timeSec);
    } else {
      verdict = (mi ? 'No mile completed yet' : 'No kilometre completed yet');
    }
    return { unit: mi ? 'mi' : 'km', rows: rows, finalSplit: finalSplit, pool: pool, enough: enough, verdict: verdict, fastestRow: fastestRow };
  },

  render: function (el, run) {
    if (!el) return null;
    if (typeof PastRunSplits === 'undefined') { el.innerHTML = ''; return null; }
    var m = this.model(run), f = this.fmtTime, esc = this.esc;
    var W = PastRunSplits.unitWord(), mi = PastRunSplits.perMile(), PS = Units.paceSlash();
    var h = '';
    h += '<div class="sc-head"><div class="sc-verdict">' + esc(m.verdict) + '</div>';
    var basisText = m.pool.basis === 'none' ? m.pool.label
      : m.enough ? 'Compared with ' + m.pool.label
      : 'Not enough past runs on this route yet — need ' + PastRunSplits.MIN_RUNS + ' (' + m.pool.label + ')';
    h += '<div class="sc-basis">' + esc(basisText) + '</div></div>';
    var compare = m.enough; // comparison columns only when ≥2 past runs on the same route

    if (!m.rows.length && !m.finalSplit) { el.innerHTML = h; return m; }

    // ── Compact bar chart: this run (solid) vs median (hollow) per km ──
    var maxT = 0;
    m.rows.forEach(function (r) { maxT = Math.max(maxT, r.timeSec, (r.stats && r.stats.slowest) || 0); });
    if (m.rows.length) {
      h += '<div class="sc-chart">';
      m.rows.forEach(function (r) {
        var pct = maxT ? Math.max(4, r.timeSec / maxT * 100) : 0;
        var med = r.stats && r.stats.medianTime != null ? Math.max(4, r.stats.medianTime / maxT * 100) : 0;
        var cls = r.flag ? ' ' + r.flag : '';
        h += '<div class="sc-col"><div class="sc-bars">' +
          (med ? '<div class="sc-bar median" style="height:' + med.toFixed(1) + '%" title="median"></div>' : '') +
          '<div class="sc-bar this' + cls + '" style="height:' + pct.toFixed(1) + '%"><span>' + f(r.timeSec) + '</span></div>' +
          '</div><div class="sc-col-label">' + W.toLowerCase() + ' ' + r.km + '</div></div>';
      });
      h += '</div><div class="sc-legend"><span class="sc-sw this"></span> this run' + (compare ? ' <span class="sc-sw median"></span> median of past runs on this route' : '') + '</div>';
    }

    // ── Table ──
    // Comparison columns only exist when there are ≥2 past runs on the same route; otherwise THIS RUN only.
    h += '<table class="sc-table' + (compare ? '' : ' sc-solo') + '"><thead><tr><th>' + W.toUpperCase() + '</th><th>THIS RUN</th>' +
      (compare ? '<th>FASTEST</th><th>SLOWEST</th><th>MEDIAN</th>' : '<th>PACE</th>') +
      '<th class="sc-hr">HR THIS RUN</th>' +
      (compare ? '<th class="sc-hr">LOWEST</th><th class="sc-hr">HIGHEST</th><th class="sc-hr">MEDIAN</th>' : '') + '</tr></thead><tbody>';
    var flagText = { best: '▲ NEW BEST', slowest: '▼ SLOWEST', faster: '▲', slower: '▼', '': '' };
    var hrText = { lowest: '▼ LOWEST', highest: '▲ HIGHEST', '': '' };
    m.rows.forEach(function (r) {
      var st = r.stats;
      h += '<tr class="' + r.flag + '">' +
        '<td class="sc-km">' + (mi ? 'Mile ' : '') + r.km + '</td>' +
        '<td class="sc-this"><b>' + f(r.timeSec) + '</b><small>' + esc(flagText[r.flag] || '') + '</small></td>';
      if (compare) {
        h += '<td>' + (st && st.fastest != null ? f(st.fastest) : '—') + '</td>' +
          '<td>' + (st && st.slowest != null ? f(st.slowest) : '—') + '</td>' +
          '<td>' + (st && st.medianTime != null ? f(st.medianTime) : '—') + '</td>';
      } else {
        h += '<td>' + f(r.timeSec) + ' ' + PS + '</td>';
      }
      h += '<td class="sc-hr sc-this hr-' + r.hrFlag + '"><b>' + (r.avgHR > 0 ? r.avgHR : '—') + '</b><small>' + esc(hrText[r.hrFlag] || '') + '</small></td>';
      if (compare) {
        h += '<td class="sc-hr">' + (st && st.lowestHR != null ? st.lowestHR : '—') + '</td>' +
          '<td class="sc-hr">' + (st && st.highestHR != null ? st.highestHR : '—') + '</td>' +
          '<td class="sc-hr">' + (st && st.medianHR != null ? Math.round(st.medianHR) : '—') + '</td>';
      }
      h += '</tr>';
    });
    if (m.finalSplit) {
      var fs = m.finalSplit;
      h += '<tr class="partial"><td class="sc-km">' + fs.distKm + ' ' + Units.distLabel() + '<small>partial</small></td>' +
        '<td class="sc-this"><b>' + f(fs.timeSec) + '</b><small>' + (fs.paceSecPerKm ? Units.pace(fs.paceSecPerKm) + ' ' + PS + ' pace' : '') + '</small></td>' +
        (compare ? '<td colspan="3" class="sc-na">not compared (partial ' + W.toLowerCase() + ')</td>' : '<td>' + (fs.paceSecPerKm ? Units.pace(fs.paceSecPerKm) + ' ' + PS : '—') + '</td>') +
        '<td class="sc-hr sc-this"><b>' + (fs.avgHR > 0 ? fs.avgHR : '—') + '</b></td>' + (compare ? '<td colspan="3" class="sc-hr sc-na"></td>' : '') + '</tr>';
    }
    h += '</tbody></table>';
    h += '<div class="sc-foot">' + (compare
      ? 'Times are per 1 ' + W.toLowerCase() + ' split (mm:ss). FASTEST / SLOWEST / MEDIAN = best, worst and middle time for that ' + W.toLowerCase() + ' index across past runs on this route. ' +
        'HR columns = this run\'s average HR for that ' + W.toLowerCase() + ' vs the LOWEST, HIGHEST and MEDIAN average HR recorded for that ' + W.toLowerCase() + ' index on this route.'
      : 'Times are per 1 ' + W.toLowerCase() + ' split (mm:ss) with the average heart rate for that ' + W.toLowerCase() + '. Comparison columns (fastest / slowest / median) appear once this route has at least ' + PastRunSplits.MIN_RUNS + ' past runs.') + '</div>';
    el.innerHTML = h;
    return m;
  },
};
