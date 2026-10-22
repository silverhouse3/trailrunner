// ════════════════════════════════════════════════════════════════════════════
// DemoSeed — generates clearly-labelled FAKE past runs so stats.html and the
// run-end split comparison can be judged visually with no real history.
// Every seeded run carries { demo: true, routeName: '… (demo)' } and the pages
// show a DEMO DATA banner while any such run exists. Never used automatically:
// only via stats.html?demo=1, the SEED DEMO DATA button, or DemoSeed.seed().
// ════════════════════════════════════════════════════════════════════════════

var DemoSeed = {
  KEY: 'tr_runs',

  _runs: function () { try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch (e) { return []; } },
  _save: function (runs) { localStorage.setItem(this.KEY, JSON.stringify(runs)); },
  hasDemo: function () { return this._runs().some(function (r) { return r.demo; }); },
  count: function () { return this._runs().filter(function (r) { return r.demo; }).length; },

  /** Seed `n` fake runs (default 18) spread over ~9 weeks. Idempotent: skips if demo runs exist. */
  seed: function (n) {
    if (this.hasDemo()) return 0;
    n = n || 18;
    var runs = this._runs();
    var activeRouteId = null, routeName = 'Demo trail';
    try {
      activeRouteId = JSON.parse(localStorage.getItem('tr_activeRouteId') || 'null');
      var routes = JSON.parse(localStorage.getItem('tr_routes') || '[]');
      for (var ri = 0; ri < routes.length; ri++) if (routes[ri].id === activeRouteId) routeName = routes[ri].name;
    } catch (e) {}

    // deterministic pseudo-random so screenshots are repeatable
    var seedState = 42;
    function rnd() { seedState = (seedState * 1103515245 + 12345) & 0x7fffffff; return seedState / 0x7fffffff; }

    var now = Date.now();
    for (var i = 0; i < n; i++) {
      var daysAgo = Math.round(1 + i * 3.4 + rnd() * 2);
      var started = new Date(now - daysAgo * 86400000);
      started.setHours(6 + Math.floor(rnd() * 13), Math.floor(rnd() * 60), 0, 0);
      var onRoute = !!activeRouteId && (i % 2 === 0);          // half on the active route, half free runs
      var distKm = onRoute ? 5 + rnd() * 0.4 : (3 + Math.floor(rnd() * 5)) + rnd() * 0.9;
      var fitness = 1 - i * 0.012;                               // older runs slightly slower
      var basePace = (onRoute ? 330 : 300 + rnd() * 60) / fitness; // sec per km
      var fullKm = Math.floor(distKm), partial = +(distKm - fullKm).toFixed(2);
      var splits = [], elapsed = 0, hrSum = 0, hrN = 0, maxHR = 0, trackPoints = [], distM = 0;
      var hr = 118 + rnd() * 10;
      for (var k = 1; k <= fullKm; k++) {
        var hilly = onRoute ? Math.sin(k * 1.3) * 25 : (rnd() - 0.5) * 30;
        var t = Math.round(basePace + hilly + (k === fullKm ? -12 : 0) + (rnd() - 0.5) * 20);
        hr = Math.min(185, hr + 6 + rnd() * 5 + (hilly > 10 ? 4 : 0));
        var avgHR = Math.round(hr);
        elapsed += t; hrSum += avgHR; hrN++; if (avgHR > maxHR) maxHR = avgHR;
        splits.push({ km: k, timeSec: t, paceSecPerKm: t, avgHR: avgHR, avgPower: 180 + Math.round(rnd() * 60), elapsed: elapsed, negativeSplit: k > 1 && t < splits[k - 2].timeSec });
        for (var tp = 0; tp < 4; tp++) { distM += 250; trackPoints.push({ time: new Date(started.getTime() + (elapsed - t + tp * t / 4) * 1000).toISOString(), dist: distM, speed: +(3600 / t).toFixed(1), hr: avgHR, ele: 60 + hilly, elapsed: Math.round(elapsed - t + tp * t / 4) }); }
      }
      var finalSplit = null;
      if (partial >= 0.05) {
        var pt = Math.round(basePace * partial);
        elapsed += pt;
        finalSplit = { km: fullKm + 1, distKm: partial, timeSec: pt, paceSecPerKm: Math.round(basePace), avgHR: Math.round(hr), partial: true };
      }
      var avgSpeed = elapsed > 0 ? +(distKm / (elapsed / 3600)).toFixed(1) : 0;
      var zoneTotal = elapsed / 60;
      var z = [0.1, 0.35, 0.35, 0.15, 0.05].map(function (f) { return +(zoneTotal * f * (0.8 + rnd() * 0.4)).toFixed(1); });
      var finished = new Date(started.getTime() + elapsed * 1000);
      runs.push({
        id: 'demo_' + i + '_' + started.getTime(),
        demo: true,
        routeId: onRoute ? activeRouteId : null,
        routeName: (onRoute ? routeName : 'Free Run') + ' (demo)',
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        savedAt: finished.toISOString(),
        distanceM: Math.round(distKm * 1000),
        distanceKm: +distKm.toFixed(2),
        elapsed: elapsed,
        avgSpeed: avgSpeed,
        maxSpeed: +(avgSpeed + 1.5 + rnd()).toFixed(1),
        avgHR: hrN ? Math.round(hrSum / hrN) : 0,
        maxHR: 185,
        calories: Math.round(distKm * 62),
        elevGained: onRoute ? 180 + Math.round(rnd() * 40) : Math.round(rnd() * 40),
        inclineMax: onRoute ? 9 : 2,
        splits: splits,
        finalSplit: finalSplit,
        splitsVersion: 2,
        trackPoints: trackPoints,
        effortScore: Math.round(elapsed / 60 * 1.6),
        hrZoneMinutes: { z1: z[0], z2: z[1], z3: z[2], z4: z[3], z5: z[4] },
        hrRecovery: { hrAtFinish: maxHR, hrAfter60s: maxHR - 20 - Math.round(rnd() * 20), drop: 20 + Math.round(rnd() * 20) },
        avgPower: 190 + Math.round(rnd() * 40),
        maxPower: 290 + Math.round(rnd() * 60),
        negativeSplits: splits.filter(function (s) { return s.negativeSplit; }).length,
        cardiacDrift: +(2 + rnd() * 5).toFixed(1),
        efficiencyFactor: +(1.3 + rnd() * 0.5).toFixed(4),
        avgStride: +(1.05 + rnd() * 0.2).toFixed(3),
      });
    }
    runs.sort(function (a, b) { return new Date(b.savedAt) - new Date(a.savedAt); });
    this._save(runs);
    return n;
  },

  /** Remove every seeded run (real runs untouched). */
  clear: function () {
    var runs = this._runs();
    var kept = runs.filter(function (r) { return !r.demo; });
    this._save(kept);
    return runs.length - kept.length;
  },
};
