// ════════════════════════════════════════════════════════════════════════════
// Storage — localStorage persistence for routes, runs, programmes, settings
// ════════════════════════════════════════════════════════════════════════════

const Store = {

  _get(key, fallback) {
    try {
      const raw = localStorage.getItem('tr_' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },

  _set(key, value) {
    try { localStorage.setItem('tr_' + key, JSON.stringify(value)); }
    catch (e) { console.warn('[Store] Write failed:', e); }
  },

  _del(key) {
    try { localStorage.removeItem('tr_' + key); } catch {}
  },

  // ── Routes ────────────────────────────────────────────────────────────────

  getRoutes() { return this._get('routes', []); },

  saveRoute(route) {
    const routes = this.getRoutes();
    route.id = route.id || 'r_' + Date.now();
    route.savedAt = new Date().toISOString();
    // Don't store full waypoints array — store the resampled version + metadata
    const toStore = {
      id: route.id,
      name: route.name,
      totalDistKm: route.totalDistKm,
      totalDistM: route.totalDistM,
      totalAscent: route.totalAscent,
      totalDescent: route.totalDescent,
      bounds: route.bounds,
      savedAt: route.savedAt,
      favourite: route.favourite || false,
      lastRunDate: route.lastRunDate || null,
      runCount: route.runCount || 0,
      bestTime: route.bestTime || null,
      // Store resampled points (compact: ~200 points)
      resampled: route.resampled,
    };
    const idx = routes.findIndex(r => r.id === route.id);
    if (idx >= 0) routes[idx] = toStore;
    else routes.push(toStore);
    this._set('routes', routes);
    return toStore;
  },

  getRoute(id) {
    return this.getRoutes().find(r => r.id === id) || null;
  },

  deleteRoute(id) {
    this._set('routes', this.getRoutes().filter(r => r.id !== id));
  },

  updateRouteStats(id, updates) {
    const routes = this.getRoutes();
    const route = routes.find(r => r.id === id);
    if (route) {
      Object.assign(route, updates);
      this._set('routes', routes);
    }
  },

  // ── Completed runs ────────────────────────────────────────────────────────

  getRuns() { return this._get('runs', []); },

  saveRun(run) {
    const runs = this.getRuns();
    run.id = run.id || 'run_' + Date.now();
    run.savedAt = new Date().toISOString();
    runs.unshift(run); // newest first
    // Cap storage (track points can be large)
    while (runs.length > 50) runs.pop();
    this._set('runs', runs);
    return run;
  },

  getRunsForRoute(routeId) {
    return this.getRuns().filter(r => r.routeId === routeId);
  },

  deleteRun(id) {
    this._set('runs', this.getRuns().filter(r => r.id !== id));
  },

  // ── Programmes ────────────────────────────────────────────────────────────

  getProgrammes() { return this._get('programmes', []); },

  saveProgramme(prog) {
    const progs = this.getProgrammes();
    prog.id = prog.id || 'prog_' + Date.now();
    const idx = progs.findIndex(p => p.id === prog.id);
    if (idx >= 0) progs[idx] = prog;
    else progs.push(prog);
    this._set('programmes', progs);
    return prog;
  },

  deleteProgramme(id) {
    this._set('programmes', this.getProgrammes().filter(p => p.id !== id));
  },

  // ── Settings ──────────────────────────────────────────────────────────────

  getSettings() {
    return this._get('settings', {
      maxHR: 185,
      restHR: 60,
      weight: 72,
      speedUnit: 'kmh',   // kmh | mph | minperkm | minpermi
      distUnit: 'km',     // km | mi
      elevUnit: 'm',      // m | ft
      fanAuto: true,
      safetyMaxSpeed: 20,  // km/h
      safetyMaxIncline: 15, // %
      wsPort: null,        // custom WebSocket port (null = auto-detect)
    });
  },

  saveSettings(s) { this._set('settings', s); },

  // ── Active route (last loaded) ────────────────────────────────────────────

  getActiveRouteId() { return this._get('activeRouteId', null); },
  setActiveRouteId(id) { this._set('activeRouteId', id); },
};
