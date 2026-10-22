// ════════════════════════════════════════════════════════════════════════════
// StravaPicker - big-touch "choose a recent run / saved route" screen.
//   StravaPicker.open({onUse: function(result){...}})
// result = {route (stored), meta, kind, ghost:boolean}.  Default onUse selects the route in the
// app (App.selectRoute) and closes.  Rows are 96 px; works offline from the last cached list.
// Strava data shown here is Soph's own, to Soph only (API Agreement).
// ES5 + Promise only.
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';
  // App globals declared with top-level `const` (Store, Engine, MapView...) are NOT properties of window, so look them up lexically.
  function env(n) {
    switch (n) {
      case 'Store': return typeof Store !== 'undefined' ? Store : root.Store;
      case 'Engine': return typeof Engine !== 'undefined' ? Engine : root.Engine;
      case 'MapView': return typeof MapView !== 'undefined' ? MapView : root.MapView;
      case 'App': return typeof App !== 'undefined' ? App : root.App;
      case 'OvalTrack': return typeof OvalTrack !== 'undefined' ? OvalTrack : root.OvalTrack;
      case 'IDBStore': return typeof IDBStore !== 'undefined' ? IDBStore : root.IDBStore;
      case 'TM': return typeof TM !== 'undefined' ? TM : root.TM;
    }
    return root[n];
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function api() { return root.StravaApi; }
  function SR() { return root.StravaRoutes; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function el(tag, cls, text) { var e = root.document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, fn) { var b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; }
  function fmtDur(s) { s = Math.round(s || 0); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s % 60); }
  function fmtDate(iso) {
    var t = Date.parse(String(iso || '').replace(/Z$/, '')); if (isNaN(t)) return '';
    var d = new Date(t); return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }
  function pace(distM, s) { if (!distM || !s) return '--'; var p = s / (distM / 1000); return Units.pace(p) + Units.paceSlash(); }

  var StravaPicker = {

    _ov: null, _tab: 'runs', _items: { runs: null, routes: null }, _sel: null, _prep: null, _opts: null, _ghostOn: true,

    close: function () { if (this._ov && this._ov.parentNode) this._ov.parentNode.removeChild(this._ov); this._ov = null; },

    open: function (opts) {
      var self = this;
      this._opts = opts || {};
      this._ghostOn = api().prefs().ghostDefault;
      this._sel = null; this._prep = null;
      var host = root.document.getElementById('rootApp') || root.document.body;
      this.close();
      var ov = el('div', 'sv-overlay sv-picker'); this._ov = ov;

      var head = el('div', 'sv-head');
      head.appendChild(el('div', 'sv-title', 'STRAVA'));
      var tabs = el('div', 'sv-tabs');
      this._tabBtns = {
        runs: btn('sv-tab', 'RECENT RUNS', function () { self.tab('runs'); }),
        routes: btn('sv-tab', 'MY ROUTES', function () { self.tab('routes'); })
      };
      tabs.appendChild(this._tabBtns.runs); tabs.appendChild(this._tabBtns.routes);
      head.appendChild(tabs);
      head.appendChild(btn('sv-btn sv-btn-alt sv-refresh', 'REFRESH', function () { self.load(true); }));
      head.appendChild(btn('sv-btn sv-btn-alt', 'CLOSE', function () { self.close(); }));
      ov.appendChild(head);

      this._banner = el('div', 'sv-banner'); ov.appendChild(this._banner);
      var body = el('div', 'sv-body');
      this._list = el('div', 'sv-list'); this._detail = el('div', 'sv-detail');
      body.appendChild(this._list); body.appendChild(this._detail); ov.appendChild(body);
      ov.appendChild(el('div', 'sv-powered sv-powered-bar', 'Powered by Strava'));
      host.appendChild(ov);
      this.tab('runs');
    },

    tab: function (t) {
      this._tab = t;
      for (var k in this._tabBtns) this._tabBtns[k].className = 'sv-tab' + (k === t ? ' on' : '');
      this._sel = null; this._prep = null; this.renderDetail();
      this.load(false);
    },

    banner: function (txt, cls) { this._banner.textContent = txt || ''; this._banner.className = 'sv-banner' + (txt ? ' show ' + (cls || '') : ''); },

    load: function (force) {
      var self = this, A = api(), t = this._tab;
      this._list.innerHTML = '';
      if (!A.isConnected()) return this.renderConnect();
      this._list.appendChild(el('div', 'sv-msg', 'Loading from Strava...'));
      this.banner('');
      var p = t === 'runs' ? A.listRecentRuns({ force: force, want: 20 }) : A.listRoutes({ force: force });
      p.then(function (res) {
        if (self._tab !== t) return;
        self._items[t] = res.items;
        if (res.stale) {
          var when = new Date(res.fetchedAt);
          self.banner('Offline - showing the list saved at ' + pad2(when.getHours()) + ':' + pad2(when.getMinutes()) + (res.error && res.error.code === 'rate_limited' ? ' (Strava is busy)' : ''), 'warn');
        }
        self.renderList();
      }, function (e) {
        if (self._tab !== t) return;
        self._list.innerHTML = '';
        if (e.code === 'auth' || e.code === 'scope') { self.banner(e.message, 'err'); return self.renderConnect(); }
        self.banner(e.message || 'Could not reach Strava', 'err');
        self._list.appendChild(el('div', 'sv-msg', t === 'runs' ? 'No saved list yet. Connect to the internet and press REFRESH.' : 'No saved routes yet.'));
      });
    },

    renderConnect: function () {
      var self = this, A = api();
      this._list.innerHTML = '';
      var box = el('div', 'sv-connect');
      box.appendChild(el('div', 'sv-msg', 'Connect Strava to choose from your recent runs and routes, race your past self, and save runs back.'));
      var app = A.app();
      var hasProxy = false; try { hasProxy = !!(A.prefs && A.prefs().tokenProxyUrl); } catch (e) {}
      var isMock = false; try { isMock = !!(A.isMock && A.isMock()); } catch (e) {}
      if (!app || !app.clientId) {
        box.appendChild(el('div', 'sv-msg sv-small', 'First enter your Strava Client ID in Settings > Integrations.'));
      } else if (!app.clientSecret && !hasProxy && !isMock) {
        box.appendChild(el('div', 'sv-msg sv-small', 'Enter your Strava Client Secret in Settings > Integrations, then come back here to connect.'));
      } else {
        // Official asset (download from developers.strava.com/guidelines into ui-v4/img/): falls back to a text button.
        var b = btn('sv-btn sv-btn-strava', 'CONNECT WITH STRAVA', function () { A.connect(); });
        var img = new Image();
        img.onload = function () { b.className = 'sv-btn-img'; b.textContent = ''; b.appendChild(img); };
        img.alt = 'Connect with Strava'; img.src = 'img/btn_strava_connect_with_orange.svg';
        box.appendChild(b);
      }
      this._list.appendChild(box);
    },

    renderList: function () {
      var self = this, items = this._items[this._tab] || [], list = this._list;
      list.innerHTML = '';
      if (!items.length) { list.appendChild(el('div', 'sv-msg', this._tab === 'runs' ? 'No recent runs found.' : 'No saved run routes found.')); return; }
      items.forEach(function (it) {
        var row = el('button', 'sv-row' + (self._sel && self._sel.id === it.id ? ' sel' : '')); row.type = 'button';
        var cv = el('canvas', 'sv-thumb'); cv.width = 120; cv.height = 80; row.appendChild(cv);
        var main = el('div', 'sv-row-main');
        main.appendChild(el('div', 'sv-row-name', it.name));
        main.appendChild(el('div', 'sv-row-sub', self._tab === 'runs' ? fmtDate(it.start_date_local) + (it.sport_type === 'TrailRun' ? '  -  Trail run' : '') : 'Saved route'));
        row.appendChild(main);
        var st = el('div', 'sv-row-stats');
        st.appendChild(el('div', 'sv-row-big', Units.distU(it.distance, 1)));
        st.appendChild(el('div', 'sv-row-sub', '+' + Math.round(it.total_elevation_gain || 0) + ' m' + (it.moving_time ? '  -  ' + fmtDur(it.moving_time) : (it.estimated_moving_time ? '  -  ~' + fmtDur(it.estimated_moving_time) : ''))));
        row.appendChild(st);
        row.onclick = function () { self.select(it); };
        list.appendChild(row);
        try { SR().drawThumb(cv, it.polyline); } catch (e) {}
      });
    },

    select: function (it) {
      var self = this, kind = this._tab === 'routes' ? 'route' : 'activity';
      this._sel = it; this._prep = null; this.renderList(); this.renderDetail('loading');
      SR().prepare(it, kind).then(function (prep) {
        if (self._sel !== it) return;
        self._prep = prep; self._kind = kind; self.renderDetail();
      }, function (e) {
        if (self._sel !== it) return;
        self.renderDetail('error', e);
      });
    },

    renderDetail: function (state, err) {
      var self = this, d = this._detail;
      d.innerHTML = '';
      if (!this._sel) { d.appendChild(el('div', 'sv-msg', 'Tap a run to preview its hills.')); return; }
      var it = this._sel;
      d.appendChild(el('div', 'sv-d-name', it.name));
      if (state === 'loading') { d.appendChild(el('div', 'sv-msg', 'Getting elevation and pace...')); return; }
      if (state === 'error') {
        d.appendChild(el('div', 'sv-msg sv-err', (err && err.message) || 'Could not load this run'));
        if (err && (err.code === 'offline')) d.appendChild(el('div', 'sv-msg sv-small', 'This run has not been downloaded yet - connect once to use it offline.'));
        return;
      }
      var prep = this._prep, m = prep.meta, conv = prep.conv;
      var cv = el('canvas', 'sv-profile'); cv.width = 700; cv.height = 220; d.appendChild(cv);
      var legend = el('div', 'sv-grade-legend');
      [['flat', '#3ecfff'], ['3-6%', '#ffe066'], ['6-10%', '#ff9f43'], ['10%+', '#ff5f5f'], ['downhill', '#9b8cff']].forEach(function (x) {
        var s = el('span', 'sv-lg'); var sw = el('i'); sw.style.background = x[1]; s.appendChild(sw); s.appendChild(root.document.createTextNode(x[0])); legend.appendChild(s);
      });
      d.appendChild(legend);
      var stats = el('div', 'sv-d-stats');
      function stat(l, v) { var s = el('div', 'sv-d-stat'); s.appendChild(el('div', 'sv-d-val', v)); s.appendChild(el('div', 'sv-d-lab', l)); stats.appendChild(s); }
      stat('DISTANCE', Units.distU(conv.totalDistM, 1));
      stat('CLIMB ON BELT', '+' + conv.ascent + ' m');
      stat('REAL CLIMB', '+' + conv.ascentReal + ' m');
      stat('STEEPEST' + (conv.stats.maxGradeRaw > conv.limits.max ? ' (REAL ' + Math.round(conv.stats.maxGradeRaw) + '%)' : ''), Math.min(conv.limits.max, Math.max(0, conv.stats.maxGradeRaw)).toFixed(0) + '%');
      if (m.ghost) stat('HER TIME  ' + pace(conv.totalDistM, m.ghost.movingTimeS), fmtDur(m.ghost.movingTimeS));
      d.appendChild(stats);
      d.appendChild(el('div', 'sv-msg sv-small', 'Incline follows the route within ' + conv.limits.min + '% to +' + conv.limits.max + '% (' + Math.round(conv.stats.clampedFrac * 100) + '% of the route is capped). The treadmill limits and your safety settings still apply.'));
      if (m.ghost) {
        var gb = btn('sv-toggle' + (this._ghostOn ? ' on' : ''), (this._ghostOn ? 'RACE MY RUN (GHOST): ON' : 'RACE MY RUN (GHOST): OFF'), function () {
          self._ghostOn = !self._ghostOn; gb.className = 'sv-toggle' + (self._ghostOn ? ' on' : ''); gb.textContent = 'RACE MY RUN (GHOST): ' + (self._ghostOn ? 'ON' : 'OFF');
        });
        d.appendChild(gb);
      }
      if (this._kind === 'activity') {
        var a = el('a', 'sv-link', 'View on Strava'); a.href = api().activityUrl(it.id); a.target = '_blank'; d.appendChild(a);
      }
      if (this._kind === 'activity' && prep.streams && prep.streams.velocity_smooth && root.RunAgain) {
        d.appendChild(btn('sv-btn sv-again', '↻ RUN AGAIN / HARDER (as a workout)', function () {
          var src = root.RunAgain.fromStrava(prep.streams, { id: it.id, name: it.name, routeId: null });
          self.close();
          root.RunAgain.open(src, {});
        }));
      }
      d.appendChild(btn('sv-btn sv-btn-main sv-use', 'USE THIS ROUTE', function () { self.use(); }));
      try { SR().drawProfile(cv, prep.route.resampled, {}); } catch (e) {}
    },

    use: function () {
      var prep = this._prep;
      if (!prep) return;
      var stored = SR().commit(prep), ghost = this._ghostOn && !!prep.meta.ghost;
      var res = { route: stored, meta: prep.meta, kind: this._kind, ghost: ghost };
      this.close();
      if (this._opts && this._opts.onUse) return this._opts.onUse(res);
      if (env('App') && env('App').selectRoute) {
        env('App').selectRoute(stored.id);
        // App._loadRouteData has already called StravaRoutes.onRouteLoaded when hooked; make the ghost choice explicit
        if (!ghost) { if (env('Engine') && env('Engine').clearGhost) env('Engine').clearGhost(); if (root.StravaRacers) root.StravaRacers.clear(); }
        // Home button: go to the live screen in READY state (App.runRoute never starts the belt)
        if (this._opts && this._opts.thenRun && env('App').runRoute) env('App').runRoute();
      }
    }
  };

  root.StravaPicker = StravaPicker;
  if (typeof module !== 'undefined' && module.exports) module.exports = StravaPicker;
})(typeof window !== 'undefined' ? window : globalThis);
