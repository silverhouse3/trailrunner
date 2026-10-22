// ════════════════════════════════════════════════════════════════════════════
// StravaApi — thin, defensive Strava v3 client for TrailRunner (ui-v4)
//
//  * Token storage is shared with js/sync.js: localStorage 'tr_strava'
//    ({access_token, refresh_token, expires_at, athlete}) and 'tr_strava_app'
//    ({clientId, clientSecret}).  Nothing in here needs sync.js to be loaded.
//  * 401  -> one automatic token refresh + one retry, else error code 'auth'.
//  * 429  -> cool-down until the next 15-minute boundary (Strava windows reset
//            at :00/:15/:30/:45), error code 'rate_limited'.  A local budget
//            counter refuses to burn the last few requests of a window.
//  * Offline-friendly: list endpoints fall back to the last cached response
//    (IndexedDB key/value store, localStorage fallback) and flag it stale.
//  * Test/dev override: ?strava=localhost:8098 points EVERYTHING (oauth + api)
//    at the local mock.  Only loopback / private-LAN hosts are accepted so a
//    crafted link cannot send tokens to a stranger.
//  * Conservative JS (ES5 + Promise + fetch). No async/await, no modules.
//  * NEVER touches the treadmill bridge (no TM.* calls anywhere in this file).
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var LS = function () { try { return root.localStorage; } catch (e) { return null; } };
  function lsGet(k) { try { var l = LS(); return l ? l.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { var l = LS(); if (l) l.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { var l = LS(); if (l) l.removeItem(k); } catch (e) {} }
  function jget(k, d) { try { var r = lsGet(k); return r ? JSON.parse(r) : d; } catch (e) { return d; } }
  function nowS() { return Math.floor(Date.now() / 1000); }

  // ── Host override (mock) ──────────────────────────────────────────────────
  function privateHost(h) {
    h = String(h || '').split(':')[0];
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ||
      /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h);
  }
  function detectOverride() {
    var q = '';
    try { q = (root.location && root.location.search) || ''; } catch (e) {}
    var m = /[?&]strava=([^&]+)/.exec(q);
    var host = m ? decodeURIComponent(m[1]) : null;
    try {
      if (host) root.sessionStorage.setItem('tr_strava_host', host);
      else host = root.sessionStorage.getItem('tr_strava_host');
    } catch (e) {}
    if (host && privateHost(host)) return host;
    return null;
  }

  var StravaApi = {

    VERSION: 1,
    // Scopes: read_all = private saved routes; activity:read_all = her own
    // activities + streams (incl. "Only Me" ones); activity:write = uploads.
    SCOPES: 'read,read_all,activity:read_all,activity:write',
    REDIRECT_URI: 'https://silverhouse3.github.io/trailrunner/ui-v4/strava-callback.html',
    CALLBACK_FALLBACK_NOTE: 'Must match the Authorization Callback Domain in the Strava API settings.',

    // Resolved lazily so tests can change location before first call.
    _override: undefined,
    base: function () {
      if (this._override === undefined) this._override = detectOverride();
      return this._override ? 'http://' + this._override : 'https://www.strava.com';
    },
    isMock: function () { this.base(); return !!this._override; },
    apiUrl: function (p) { return this.base() + '/api/v3' + p; },
    // Optional secret-less token proxy (see docs). Falls back to Strava directly.
    tokenUrl: function () {
      if (this.isMock()) return this.base() + '/oauth/token';
      var prefs = jget('tr_strava_prefs', {});
      return (prefs && prefs.tokenProxyUrl) || 'https://www.strava.com/oauth/token';
    },

    // ── Prefs ───────────────────────────────────────────────────────────────
    prefs: function () {
      var p = jget('tr_strava_prefs', {}) || {};
      return {
        tokenProxyUrl: p.tokenProxyUrl || '',
        uploadMode: p.uploadMode || 'trainer',       // 'trainer' | 'virtual'
        includeElevation: p.includeElevation !== false,
        comfortMinIncline: p.comfortMinIncline != null ? p.comfortMinIncline : -3,
        comfortMaxIncline: p.comfortMaxIncline != null ? p.comfortMaxIncline : 12,
        ghostDefault: p.ghostDefault !== false,
        autoRetryQueued: p.autoRetryQueued !== false,
        perPage: p.perPage || 100   // one list call covers ~100 activities (Strava allows up to 200 per page)
      };
    },
    setPrefs: function (patch) {
      var p = jget('tr_strava_prefs', {}) || {};
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) p[k] = patch[k];
      lsSet('tr_strava_prefs', JSON.stringify(p));
    },

    // ── Tokens ──────────────────────────────────────────────────────────────
    tokens: function () { return jget('tr_strava', null); },
    _saveTokens: function (t) { lsSet('tr_strava', JSON.stringify(t)); },
    app: function () {
      // Stored app (typed in Settings) wins; the public Client ID default from js/strava-config.js fills a missing ID.
      var a = jget('tr_strava_app', null) || {};
      var cfg = root.TR_STRAVA_CONFIG;
      if (!a.clientId && cfg && cfg.clientId) a = { clientId: String(cfg.clientId), clientSecret: a.clientSecret || '' };
      if (!a.clientSecret) { try { var st = JSON.parse(lsGet('tr_settings') || '{}') || {}; if (st.stravaClientSecret) a.clientSecret = st.stravaClientSecret; if (!a.clientId && st.stravaClientId) a.clientId = st.stravaClientId; } catch (e) {} }
      return a.clientId ? a : null;
    },
    isConnected: function () { var t = this.tokens(); return !!(t && t.access_token); },
    athleteId: function () { var t = this.tokens(); return t && t.athlete ? t.athlete.id : null; },
    disconnect: function () { lsDel('tr_strava'); },

    /** Hand-off to Strava's authorize page (same redirect approach as sync.js). */
    authorizeUrl: function () {
      var app = this.app();
      if (!app || !app.clientId) return null;
      // P0-2: the callback page reads localStorage 'tr_strava_app' directly → persist the EFFECTIVE app
      // (default public Client ID from strava-config.js + the secret typed in Settings) before leaving the page.
      try {
        var st = {}; try { st = JSON.parse(lsGet('tr_settings') || '{}') || {}; } catch (e0) {}
        var saved = jget('tr_strava_app', null) || {};
        lsSet('tr_strava_app', JSON.stringify({ clientId: app.clientId, clientSecret: app.clientSecret || saved.clientSecret || st.stravaClientSecret || '' }));
      } catch (e1) {}
      lsSet('tr_strava_scope_requested', this.SCOPES);
      var state = 'tr' + Math.random().toString(36).slice(2, 10);
      lsSet('tr_strava_oauth_state', state);
      return this.base() + '/oauth/authorize?client_id=' + encodeURIComponent(app.clientId) +
        '&response_type=code&redirect_uri=' + encodeURIComponent(this.REDIRECT_URI) +
        '&approval_prompt=auto&scope=' + encodeURIComponent(this.SCOPES) + '&state=' + state;
    },
    connect: function () {
      var u = this.authorizeUrl();
      if (!u) return false;
      root.location.href = u;
      return true;
    },

    /** Exchange an authorization code (used by the callback page patch / tests). */
    exchangeCode: function (code) {
      var self = this, app = this.app() || {};
      var body = { client_id: app.clientId, code: code, grant_type: 'authorization_code' };
      // Only send the secret if there is NO proxy (the proxy adds it server-side).
      if (!this.prefsHasProxy() && app.clientSecret) body.client_secret = app.clientSecret;
      return this._tokenPost(body).then(function (d) {
        self._saveTokens({
          access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at,
          scope: d.scope || lsGet('tr_strava_scope_requested') || '',
          athlete: d.athlete ? { id: d.athlete.id, firstname: d.athlete.firstname, lastname: d.athlete.lastname } : null
        });
        return self.tokens();
      });
    },
    prefsHasProxy: function () { return !!this.prefs().tokenProxyUrl && !this.isMock(); },

    _tokenPost: function (body) {
      return fetch(this.tokenUrl(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw mkErr('auth', 'Token request failed (' + r.status + ')', r.status);
        return r.json();
      });
    },

    _refreshing: null,
    /** Refresh if expired / within 5 min of expiry (or force). Single-flight. */
    ensureFreshToken: function (force) {
      var self = this, t = this.tokens();
      if (!t || !t.refresh_token) return Promise.reject(mkErr('auth', 'Not connected to Strava', 401));
      if (!force && t.expires_at && (t.expires_at - 300) > nowS()) return Promise.resolve(t);
      if (this._refreshing) return this._refreshing;
      var app = this.app() || {};
      var body = { client_id: app.clientId, grant_type: 'refresh_token', refresh_token: t.refresh_token };
      if (!this.prefsHasProxy() && app.clientSecret) body.client_secret = app.clientSecret;
      this._refreshing = this._tokenPost(body).then(function (d) {
        var n = {};
        for (var k in t) n[k] = t[k];
        n.access_token = d.access_token;
        n.refresh_token = d.refresh_token || t.refresh_token; // newest refresh token always wins
        n.expires_at = d.expires_at;
        self._saveTokens(n);
        self._refreshing = null;
        return n;
      }, function (e) { self._refreshing = null; throw e; });
      return this._refreshing;
    },

    // ── Rate-limit bookkeeping ──────────────────────────────────────────────
    // Strava (checked 2026-10-22): 200/15min + 2000/day overall, of which
    // 100/15min + 1000/day are "read" (everything except POST activities/uploads).
    LIMITS: { readPer15: 100, readPerDay: 1000, reserve: 10 },
    _calls: [],
    _cooldownUntil: 0,
    usage: { read15: null, readDay: null, all15: null, allDay: null },
    _noteHeaders: function (res) {
      try {
        var ru = res.headers.get('X-ReadRateLimit-Usage'), au = res.headers.get('X-RateLimit-Usage');
        if (ru) { var a = ru.split(','); this.usage.read15 = +a[0]; this.usage.readDay = +a[1]; this.usage._win = this._windowStart(); }
        if (au) { var b = au.split(','); this.usage.all15 = +b[0]; this.usage.allDay = +b[1]; }
      } catch (e) {}
    },
    _windowStart: function () { return Math.floor(Date.now() / 900000) * 900000; },
    _budgetOk: function (isRead) {
      if (!isRead) return true;
      var ws = this._windowStart(), n = 0;
      this._calls = this._calls.filter(function (t) { return t >= ws; });
      n = Math.max(this._calls.length, this.usage._win === ws ? (this.usage.read15 || 0) : 0);
      return n < (this.LIMITS.readPer15 - this.LIMITS.reserve);
    },
    cooldownSeconds: function () { return Math.max(0, Math.ceil((this._cooldownUntil - Date.now()) / 1000)); },

    /**
     * Low level call. opts: {method, body (FormData|object), query, raw (return Response)}
     * Resolves parsed JSON. Rejects StravaError {code: auth|scope|rate_limited|offline|http|notfound}.
     */
    request: function (path, opts) {
      opts = opts || {};
      var self = this, method = (opts.method || 'GET').toUpperCase();
      var isRead = !(method === 'POST' && /^\/uploads$|^\/activities$/.test(path.split('?')[0]));
      if (this.cooldownSeconds() > 0 && isRead) {
        return Promise.reject(mkErr('rate_limited', 'Strava is busy - try again in ' + Math.ceil(this.cooldownSeconds() / 60) + ' min', 429));
      }
      if (!this._budgetOk(isRead)) {
        return Promise.reject(mkErr('rate_limited', 'Strava request budget used up for this 15 minute window', 429));
      }
      var url = this.apiUrl(path);
      if (opts.query) {
        var q = [];
        for (var k in opts.query) if (opts.query[k] != null) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(opts.query[k]));
        if (q.length) url += (url.indexOf('?') < 0 ? '?' : '&') + q.join('&');
      }
      function attempt(retried) {
        return self.ensureFreshToken(false).then(function (t) {
          var init = { method: method, headers: { 'Authorization': 'Bearer ' + t.access_token } };
          if (opts.body) {
            if (typeof FormData !== 'undefined' && opts.body instanceof FormData) init.body = opts.body;
            else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
          }
          if (isRead) self._calls.push(Date.now());
          return fetch(url, init);
        }).then(function (res) {
          self._noteHeaders(res);
          if (res.status === 401 && !retried) {
            return self.ensureFreshToken(true).then(function () { return attempt(true); });
          }
          if (res.status === 401 || res.status === 403) {
            return res.text().then(function (txt) {
              var scope = /scope|permission|read_permission|write_permission/i.test(txt);
              throw mkErr(scope ? 'scope' : 'auth',
                scope ? 'Strava permission missing - reconnect Strava and tick all boxes' : 'Strava login expired - reconnect', res.status, txt);
            });
          }
          if (res.status === 429) {
            // windows reset at :00/:15/:30/:45; long-term (daily) limit resets 00:00 UTC
            var daily = self.usage.readDay != null && self.usage.readDay >= self.LIMITS.readPerDay;
            var until = daily ? Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)
                              : self._windowStart() + 900000;
            self._cooldownUntil = until + 2000;
            throw mkErr('rate_limited', daily ? 'Strava daily limit reached - try tomorrow' : 'Strava is busy - try again in a few minutes', 429);
          }
          if (res.status === 404) throw mkErr('notfound', 'Not found on Strava', 404);
          if (!res.ok) {
            return res.text().then(function (txt) { throw mkErr('http', 'Strava error ' + res.status, res.status, txt); });
          }
          if (opts.raw) return res;
          return res.json();
        }, function (e) {
          if (e && e.isStravaError) throw e;
          throw mkErr('offline', 'No connection to Strava', 0, String(e && e.message || e));
        });
      }
      return attempt(false);
    },

    // ── Cache (IDB with localStorage fallback) ──────────────────────────────
    kv: {
      _db: null, _tried: false,
      _open: function () {
        var self = this;
        if (this._db) return Promise.resolve(this._db);
        if (this._tried || !root.indexedDB) return Promise.resolve(null);
        this._tried = true;
        return new Promise(function (resolve) {
          try {
            var r = root.indexedDB.open('trailrunner-strava', 1);
            r.onupgradeneeded = function (e) { e.target.result.createObjectStore('kv'); };
            r.onsuccess = function (e) { self._db = e.target.result; resolve(self._db); };
            r.onerror = function () { resolve(null); };
            r.onblocked = function () { resolve(null); };
          } catch (e) { resolve(null); }
        });
      },
      get: function (key) {
        return this._open().then(function (db) {
          if (!db) return jget('tr_sk_' + key, null);
          return new Promise(function (resolve) {
            try {
              var rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
              rq.onsuccess = function () { resolve(rq.result === undefined ? null : rq.result); };
              rq.onerror = function () { resolve(null); };
            } catch (e) { resolve(null); }
          });
        });
      },
      set: function (key, val) {
        return this._open().then(function (db) {
          if (!db) { lsSet('tr_sk_' + key, JSON.stringify(val)); return true; }
          return new Promise(function (resolve) {
            try {
              var tx = db.transaction('kv', 'readwrite');
              tx.objectStore('kv').put(val, key);
              tx.oncomplete = function () { resolve(true); };
              tx.onerror = function () { resolve(false); };
            } catch (e) { resolve(false); }
          });
        });
      },
      del: function (key) {
        return this._open().then(function (db) {
          if (!db) { lsDel('tr_sk_' + key); return true; }
          return new Promise(function (resolve) {
            try {
              var tx = db.transaction('kv', 'readwrite');
              tx.objectStore('kv').delete(key);
              tx.oncomplete = function () { resolve(true); };
              tx.onerror = function () { resolve(false); };
            } catch (e) { resolve(false); }
          });
        });
      }
    },

    // ── Endpoints ───────────────────────────────────────────────────────────
    RUN_TYPES: { Run: 1, TrailRun: 1, VirtualRun: 1 },
    isRun: function (a) { return !!this.RUN_TYPES[a.sport_type || a.type]; },

    /**
     * Recent runs. Fetches pages until `want` runs are found (max 4 pages) -
     * the list endpoint can't filter by type server-side. Cached; on failure
     * returns the cache with stale:true.  -> {items, stale, fetchedAt, error}
     */
    listRecentRuns: function (opts) {
      opts = opts || {};
      var self = this, want = opts.want || 20, perPage = opts.perPage || this.prefs().perPage;
      var key = 'activities:' + (this.athleteId() || 'me');
      var out = [];
      function page(n) {
        return self.request('/athlete/activities', { query: { page: n, per_page: perPage } }).then(function (arr) {
          for (var i = 0; i < arr.length; i++) if (self.isRun(arr[i]) && !arr[i].manual) out.push(slimActivity(arr[i]));
          if (out.length < want && arr.length >= perPage && n < 4) return page(n + 1);
        });
      }
      return this.kv.get(key).then(function (cached) {
        var fresh = cached && !opts.force && (Date.now() - cached.fetchedAt) < (opts.maxAgeMs != null ? opts.maxAgeMs : 900000)   // 15 min: list is cached to save the call budget;
        if (fresh) return { items: cached.items, stale: false, fetchedAt: cached.fetchedAt, fromCache: true };
        return page(1).then(function () {
          var rec = { items: out.slice(0, want), fetchedAt: Date.now() };
          self.kv.set(key, rec);
          return { items: rec.items, stale: false, fetchedAt: rec.fetchedAt };
        }).then(null, function (err) {
          if (cached) return { items: cached.items, stale: true, fetchedAt: cached.fetchedAt, error: err };
          throw err;
        });
      });
    },

    /** Saved Strava routes (run routes only, type 2). */
    listRoutes: function (opts) {
      opts = opts || {};
      var self = this, id = this.athleteId();
      if (!id) return Promise.reject(mkErr('auth', 'Not connected to Strava', 401));
      var key = 'routes:' + id;
      return this.kv.get(key).then(function (cached) {
        if (cached && !opts.force && (Date.now() - cached.fetchedAt) < 300000) return { items: cached.items, stale: false, fetchedAt: cached.fetchedAt, fromCache: true };
        return self.request('/athletes/' + id + '/routes', { query: { page: 1, per_page: 30 } }).then(function (arr) {
          var items = [];
          for (var i = 0; i < arr.length; i++) if (arr[i].type === 2 || arr[i].type == null) items.push(slimRoute(arr[i]));
          var rec = { items: items, fetchedAt: Date.now() };
          self.kv.set(key, rec);
          return { items: items, stale: false, fetchedAt: rec.fetchedAt };
        }).then(null, function (err) {
          if (cached) return { items: cached.items, stale: true, fetchedAt: cached.fetchedAt, error: err };
          throw err;
        });
      });
    },

    /** Streams for an activity, keyed by type. Cached forever per id (immutable data). */
    getActivityStreams: function (id, opts) {
      var self = this, key = 'streams:a:' + id;
      return this.kv.get(key).then(function (c) {
        if (c && !(opts && opts.force)) return c;
        return self.request('/activities/' + id + '/streams', {
          // ONE call per run gets everything Strava has (HR, cadence, grade too): runs are fetched once and cached forever.
          query: { keys: 'latlng,altitude,distance,time,velocity_smooth,heartrate,cadence,grade_smooth,moving', key_by_type: 'true' }
        }).then(function (s) {
          var norm = normaliseStreams(s);
          self.kv.set(key, norm);
          return norm;
        });
      });
    },

    getRouteStreams: function (id, opts) {
      var self = this, key = 'streams:r:' + id;
      return this.kv.get(key).then(function (c) {
        if (c && !(opts && opts.force)) return c;
        return self.request('/routes/' + id + '/streams').then(function (s) {
          var norm = normaliseStreams(s);
          self.kv.set(key, norm);
          return norm;
        });
      });
    },

    // ── Upload ──────────────────────────────────────────────────────────────
    /** fields: {file: string, filename, data_type, name, description, sport_type, trainer, external_id} */
    postUpload: function (fields) {
      var fd = new FormData();
      fd.append('file', new Blob([fields.file], { type: 'application/xml' }), fields.filename || 'trailrunner.tcx');
      fd.append('data_type', fields.data_type || 'tcx');
      if (fields.name) fd.append('name', fields.name);
      if (fields.description) fd.append('description', fields.description);
      if (fields.sport_type) fd.append('sport_type', fields.sport_type);
      if (fields.trainer != null) fd.append('trainer', String(fields.trainer));
      if (fields.external_id) fd.append('external_id', fields.external_id);
      return this.request('/uploads', { method: 'POST', body: fd });
    },
    uploadStatus: function (uploadId) { return this.request('/uploads/' + uploadId); },

    /** Poll until activity_id appears or error. opts {intervalMs (>=1000), timeoutMs, onTick}. */
    pollUpload: function (uploadId, opts) {
      opts = opts || {};
      var self = this, interval = Math.max(1000, opts.intervalMs || 2000), deadline = Date.now() + (opts.timeoutMs || 90000);
      return new Promise(function (resolve, reject) {
        function tick() {
          self.uploadStatus(uploadId).then(function (u) {
            if (opts.onTick) { try { opts.onTick(u); } catch (e) {} }
            if (u.activity_id) return resolve({ ok: true, activityId: u.activity_id, upload: u });
            if (u.error) {
              var dup = /duplicate of activity (\d+)/i.exec(u.error);
              return resolve({ ok: false, duplicate: !!dup, activityId: dup ? +dup[1] : null, error: stripHtml(u.error), upload: u });
            }
            if (Date.now() > deadline) return reject(mkErr('timeout', 'Strava is still processing - it will appear soon', 0));
            setTimeout(tick, interval);
          }, function (e) {
            if (e && (e.code === 'offline' || e.code === 'http') && Date.now() < deadline) return setTimeout(tick, interval * 2);
            reject(e);
          });
        }
        setTimeout(tick, opts.firstDelayMs != null ? opts.firstDelayMs : 1000);
      });
    },

    // ── Helpers ─────────────────────────────────────────────────────────────
    decodePolyline: function (str) {
      var pts = [], i = 0, lat = 0, lng = 0, len = str ? str.length : 0;
      while (i < len) {
        var b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32 && i < len);
        lat += (res & 1) ? ~(res >> 1) : (res >> 1);
        shift = 0; res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32 && i < len);
        lng += (res & 1) ? ~(res >> 1) : (res >> 1);
        pts.push([lat / 1e5, lng / 1e5]);
      }
      return pts;
    },
    /** Forget everything cached from Strava (use on disconnect / deauthorisation). */
    purgeData: function () {
      try { if (this.kv._db) { this.kv._db.close(); this.kv._db = null; } if (root.indexedDB) root.indexedDB.deleteDatabase('trailrunner-strava'); } catch (e) {}
      this.kv._tried = false;
      try {
        var l = LS(), del = [];
        for (var i = 0; l && i < l.length; i++) { var k = l.key(i); if (k && (k.indexOf('tr_sk_') === 0 || k === 'tr_strava_routes' || k === 'tr_strava_uploaded')) del.push(k); }
        del.forEach(function (k) { l.removeItem(k); });
      } catch (e) {}
    },
    activityUrl: function (id) { return 'https://www.strava.com/activities/' + id; }
  };

  function mkErr(code, msg, status, detail) {
    var e = new Error(msg);
    e.isStravaError = true; e.code = code; e.status = status || 0; e.detail = detail || '';
    return e;
  }
  function stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); }

  // Keep cache small: only the fields the UI needs.
  function slimActivity(a) {
    return {
      id: a.id, name: a.name, type: a.type, sport_type: a.sport_type || a.type,
      start_date: a.start_date || a.start_date_local, start_date_local: a.start_date_local || a.start_date, distance: a.distance,
      moving_time: a.moving_time, elapsed_time: a.elapsed_time,
      total_elevation_gain: a.total_elevation_gain, average_speed: a.average_speed,
      average_heartrate: a.average_heartrate || null, trainer: !!a.trainer,
      polyline: a.map ? a.map.summary_polyline : null
    };
  }
  function slimRoute(r) {
    return {
      id: r.id_str || String(r.id), name: r.name, distance: r.distance,
      total_elevation_gain: r.elevation_gain, estimated_moving_time: r.estimated_moving_time,
      polyline: r.map ? r.map.summary_polyline : null, sub_type: r.sub_type
    };
  }
  /** Streams come back keyed ({latlng:{data}}) or as an array ([{type,data}]) (routes). */
  function normaliseStreams(s) {
    var out = {}, i;
    if (Object.prototype.toString.call(s) === '[object Array]') {
      for (i = 0; i < s.length; i++) out[s[i].type] = s[i].data;
    } else {
      for (var k in s) if (s[k] && s[k].data) out[k] = s[k].data;
    }
    return out;
  }

  root.StravaApi = StravaApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = StravaApi;
})(typeof window !== 'undefined' ? window : globalThis);
