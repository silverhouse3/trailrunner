// ════════════════════════════════════════════════════════════════════════════
// Units — ONE unit system (imperial | metric) drives every displayed
// speed / distance / pace / elevation. Internals stay km/h, metres, sec/km.
//   imperial: mph, mi, min/mi, ft      metric: km/h, km, min/km, m
// Setting: tr_settings.unitSystem. Display-only + input parsing helpers.
// ════════════════════════════════════════════════════════════════════════════
var Units = (function () {
  var KM_PER_MI = 1.609344, M_PER_MI = 1609.344, FT_PER_M = 3.28084;
  var _sys = null;

  function rawSettings() { try { return JSON.parse(localStorage.getItem('tr_settings') || '{}') || {}; } catch (e) { return {}; } }
  function saveRaw(s) { try { localStorage.setItem('tr_settings', JSON.stringify(s)); } catch (e) {} }

  /** Decide the system from legacy flags (imperial wins on any disagreement or when nothing explicit). */
  function migrate(s) {
    if (s.unitSystem === 'imperial' || s.unitSystem === 'metric') return s.unitSystem;
    var imp = s.distUnit === 'mi' || s.speedUnit === 'mph' || s.speedUnit === 'minpermi' ||
              s.speedButtonUnit === 'mph' || s.speedButtonUnit === 'min/mi' || s.elevUnit === 'ft';
    var metricExplicit = s.speedButtonUnit === 'kph' || s.speedButtonUnit === 'min/km';
    var sys = (!imp && metricExplicit) ? 'metric' : 'imperial';
    s.unitSystem = sys;
    if (!s.speedPaceMode) s.speedPaceMode = (s.speedButtonUnit === 'min/mi' || s.speedButtonUnit === 'min/km') ? 'pace' : 'speed';
    saveRaw(s);
    return sys;
  }

  var U = {
    KM_PER_MI: KM_PER_MI, M_PER_MI: M_PER_MI, FT_PER_M: FT_PER_M,

    system: function () {
      if (!_sys) { var s = rawSettings(); _sys = migrate(s); this.syncSettings(s); }
      return _sys;
    },
    imp: function () { return this.system() === 'imperial'; },

    /** Keep every legacy flag consistent with the system (so old code paths agree). */
    syncSettings: function (s) {
      s = s || rawSettings();
      var imp = this.imp();
      var mode = s.speedPaceMode === 'pace' ? 'pace' : 'speed';
      var want = { unitSystem: _sys, speedPaceMode: mode, distUnit: imp ? 'mi' : 'km', elevUnit: imp ? 'ft' : 'm',
                   speedUnit: imp ? 'mph' : 'kmh', speedButtonUnit: this.buttonUnit(mode) };
      var changed = false;
      for (var k in want) if (s[k] !== want[k]) { s[k] = want[k]; changed = true; }
      if (changed) saveRaw(s);
      if (typeof UI !== 'undefined' && UI.units) { UI.units.speed = want.speedUnit; UI.units.dist = want.distUnit; UI.units.elev = want.elevUnit; }
      return s;
    },

    /** Set the system ('imperial'|'metric'), persist, push to UI and relabel the static DOM. */
    set: function (sys) {
      if (sys !== 'imperial' && sys !== 'metric') return;
      _sys = sys;
      var s = rawSettings(); s.unitSystem = sys;
      this.syncSettings(s);
      var cs = (typeof Store !== 'undefined' && Store.getSettings) ? Store.getSettings() : null;
      if (cs) { cs.unitSystem = sys; Store.saveSettings(Object.assign(cs, rawSettings())); }
      if (typeof App !== 'undefined') { App._cachedSettings = null; try { App._buildQSPanels(); App._updateNudgeDisplays(); } catch (e) {} }
      this.refreshDom();
    },

    // ── Speed / pace mode (the SPEED <-> PACE toggle) ──────────────────
    mode: function () { return rawSettings().speedPaceMode === 'pace' ? 'pace' : 'speed'; },
    toggleMode: function () {
      var s = rawSettings(); s.speedPaceMode = this.mode() === 'pace' ? 'speed' : 'pace';
      this.syncSettings(s);
    },
    /** SpeedUnits-style code for the live speed control: mph | kph | min/mi | min/km */
    buttonUnit: function (mode) {
      mode = mode || this.mode();
      return this.imp() ? (mode === 'pace' ? 'min/mi' : 'mph') : (mode === 'pace' ? 'min/km' : 'kph');
    },
    /** Nudge step in km/h for one +/- press (mph: 0.5 mph; km/h: 0.5). */
    nudgeKmh: function (sign) { return sign * (this.imp() ? 0.5 * KM_PER_MI : 0.5); },

    /** SpeedUnits code -> display text */
    unitText: function (u) { return u === 'mph' ? 'mph' : u === 'kph' ? 'km/h' : u; },

    // ── Labels ─────────────────────────────────────────────────────────
    speedLabel: function () { return this.imp() ? 'mph' : 'km/h'; },
    distLabel: function () { return this.imp() ? 'mi' : 'km'; },
    paceLabel: function () { return this.imp() ? 'min/mi' : 'min/km'; },
    paceSlash: function () { return this.imp() ? '/mi' : '/km'; },
    elevLabel: function () { return this.imp() ? 'ft' : 'm'; },
    splitWord: function () { return this.imp() ? 'mile' : 'km'; },
    splitUnitM: function () { return this.imp() ? M_PER_MI : 1000; },

    // ── Conversions (numbers) ──────────────────────────────────────────
    speedNum: function (kmh) { return this.imp() ? kmh / KM_PER_MI : kmh; },
    distNum: function (m) { return this.imp() ? m / M_PER_MI : m / 1000; },
    elevNum: function (m) { return this.imp() ? m * FT_PER_M : m; },
    paceSecPerUnit: function (secPerKm) { return this.imp() ? secPerKm * KM_PER_MI : secPerKm; },

    // ── Formatters (strings, no unit unless *U) ────────────────────────
    speed: function (kmh, dec) { return (+kmh > 0 ? this.speedNum(kmh) : 0).toFixed(dec == null ? 1 : dec); },
    speedU: function (kmh, dec) { return this.speed(kmh, dec) + ' ' + this.speedLabel(); },
    dist: function (m, dec) { return this.distNum(+m || 0).toFixed(dec == null ? 2 : dec); },
    distU: function (m, dec) { return this.dist(m, dec) + ' ' + this.distLabel(); },
    distKm: function (km, dec) { return this.dist((+km || 0) * 1000, dec); },
    distKmU: function (km, dec) { return this.distKm(km, dec) + ' ' + this.distLabel(); },
    elev: function (m) { return String(Math.round(this.elevNum(+m || 0))); },
    elevU: function (m) { return this.elev(m) + ' ' + this.elevLabel(); },
    /** pace from sec per km -> 'm:ss' in current unit; '—' if invalid */
    pace: function (secPerKm) {
      if (!(secPerKm > 0) || !isFinite(secPerKm)) return '—';
      var t = Math.round(this.paceSecPerUnit(secPerKm));
      return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
    },
    paceU: function (secPerKm) { return this.pace(secPerKm) + ' ' + this.paceSlash(); },
    paceFromKmh: function (kmh) { return kmh > 0.5 ? this.pace(3600 / kmh) : '—'; },

    // ── Inverse parsers (display unit -> internal) ─────────────────────
    parseSpeed: function (v) { v = parseFloat(v); return this.imp() ? v * KM_PER_MI : v; },      // -> km/h
    parseDist: function (v) { v = parseFloat(v); return this.imp() ? v * M_PER_MI : v * 1000; }, // -> metres
    parseElev: function (v) { v = parseFloat(v); return this.imp() ? v / FT_PER_M : v; },        // -> metres

    /** Relabel static markup: [data-u="speed|dist|pace|paceslash|elev|PACE|SPLITS|CURSPLIT"] */
    refreshDom: function () {
      if (typeof document === 'undefined') return;
      var map = { speed: this.speedLabel(), dist: this.distLabel(), pace: this.paceLabel(), paceslash: this.paceSlash(),
                  elev: this.elevLabel(), PACE: 'PACE ' + this.paceSlash().toUpperCase(), 'AVG PACE': 'AVG PACE',
                  SPLITS: 'KM SPLITS', CURSPLIT: 'CURRENT KM',
                  DISTU: this.distLabel().toUpperCase(), SPEEDU: this.speedLabel().toUpperCase() };
      var els = document.querySelectorAll('[data-u]');
      for (var i = 0; i < els.length; i++) { var k = els[i].getAttribute('data-u'); if (map[k] != null) els[i].textContent = map[k]; }
    }
  };
  return U;
})();
window.Units = Units;
try { Units.system(); } catch (e) {}
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', function () { Units.refreshDom(); });
