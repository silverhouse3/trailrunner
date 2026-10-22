// ════════════════════════════════════════════════════════════════════════════
// VideoView — the split VIDEO view (replaces Trail Cam): YouTube on the left
// half of the view zone, live running tiles on the right.
//
//  * youtube-nocookie.com embeds only: single videos and PLAYLISTS
//    (embed/videoseries?list=…). No API key, no external script.
//  * Big PLAY/PAUSE, MUTE, VOL −/+, PREV/NEXT buttons drive the player through
//    the IFrame postMessage protocol (enablejsapi=1 + "listening"/"command"
//    messages). If the channel never answers (onReady/infoDelivery) within
//    READY_TIMEOUT_MS the iframe is reloaded with YouTube's own controls.
//  * 10 s load timeout, onError 2/5/100/101/150 → large "cannot be played here"
//    message + favourites. Never a blank pane.
//  * 6 favourite slots (label editable), recent list, one-tap RESUME —
//    localStorage tr_yt_favs / tr_yt_recent / tr_yt_last.
//  * Never auto-plays on app load; the first PLAY is always a user tap.
//  * Nothing here touches TM / Engine / the belt. Tiles are read-only.
//  * ?ytStub=1 (or sessionStorage tr_yt_stub) swaps the embed for
//    mock/yt-stub.html, a local page that speaks the same postMessage protocol,
//    so tests need no internet.
// ════════════════════════════════════════════════════════════════════════════

var YT = {
  ORIGIN: 'https://www.youtube-nocookie.com',

  /** Parse a YouTube link / 11-char video id / playlist id. → {type:'video'|'playlist', id, list?} | null */
  parse: function (text) {
    if (!text) return null;
    var s = String(text).trim();
    if (!s) return null;
    var V = /^[A-Za-z0-9_-]{11}$/, L = /^(PL|UU|OL|RD|FL|LL)[A-Za-z0-9_-]{10,}$/;
    if (V.test(s)) return { type: 'video', id: s };
    if (L.test(s)) return { type: 'playlist', id: s };
    var m;
    var list = (m = /[?&#]list=([A-Za-z0-9_-]{12,})/.exec(s)) ? m[1] : null;
    var vid = (m = /[?&#]v=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(s)) ? m[1]
      : (m = /youtu\.be\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(s)) ? m[1]
      : (m = /\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(s)) ? m[1] : null;
    if (vid && vid !== 'videoseries') return list ? { type: 'video', id: vid, list: list } : { type: 'video', id: vid };
    if (list && /youtu/.test(s)) return { type: 'playlist', id: list };
    return null;
  },

  stub: function () {
    try {
      if (/[?&]ytStub=1\b/.test(window.location.search)) { sessionStorage.setItem('tr_yt_stub', '1'); return true; }
      if (/[?&]ytStub=0\b/.test(window.location.search)) { sessionStorage.removeItem('tr_yt_stub'); return false; }
      return sessionStorage.getItem('tr_yt_stub') === '1';
    } catch (e) { return false; }
  },

  /** Embed URL for an item. nativeControls=true shows YouTube's own bar (fallback). */
  embedUrl: function (item, nativeControls) {
    var q = 'enablejsapi=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&controls=' + (nativeControls ? '1' : '0');
    try { q += '&origin=' + encodeURIComponent(window.location.origin); } catch (e) {}
    if (this.stub()) {
      var base = window.location.pathname.replace(/[^\/]*$/, '') + 'mock/yt-stub.html';
      return base + '?' + (item.type === 'playlist' ? 'list=' + encodeURIComponent(item.id) : 'v=' + encodeURIComponent(item.id) + (item.list ? '&list=' + encodeURIComponent(item.list) : '')) + '&' + q;
    }
    if (item.type === 'playlist') return this.ORIGIN + '/embed/videoseries?list=' + encodeURIComponent(item.id) + '&' + q;
    return this.ORIGIN + '/embed/' + encodeURIComponent(item.id) + '?' + q + (item.list ? '&list=' + encodeURIComponent(item.list) : '');
  },

  label: function (item) {
    if (!item) return '';
    if (item.title) return item.title;
    return item.type === 'playlist' ? 'Playlist ' + item.id.slice(0, 10) + '…' : 'Video ' + item.id;
  },
};

var VideoView = {
  SLOTS: 6, RECENT_MAX: 8,
  LOAD_TIMEOUT_MS: 10000, READY_TIMEOUT_MS: 5000,
  FAV_KEY: 'tr_yt_favs', RECENT_KEY: 'tr_yt_recent', LAST_KEY: 'tr_yt_last',

  active: false, el: null, stage: null, frameBox: null, iframe: null,
  item: null, ready: false, native: false, playerState: -1, muted: false, volume: 100,
  _loadTimer: null, _readyTimer: null, _listenTimer: null, _splitCache: null,

  // ── lifecycle ───────────────────────────────────────────────────────────
  init: function () {
    this.el = document.getElementById('videoSplitPanel');
    if (!this.el) return;
    this.stage = this.el.querySelector('.vv-stage');
    this.frameBox = this.el.querySelector('.vv-frame');
    var self = this;
    window.addEventListener('message', function (e) { self._onMessage(e); });
    window.addEventListener('resize', function () { if (self.active) self._fit(); });
    var input = document.getElementById('vvInput');
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') self.playFromInput(); });
    this.renderLists();
  },

  show: function () {
    if (!this.el) return;
    this.active = true;
    this.el.classList.add('show');
    this.renderLists();
    this._fit();
    this.update();
    var self = this; setTimeout(function () { self._fit(); }, 60);
  },

  hide: function () {
    if (!this.el) return;
    this.active = false;
    this.el.classList.remove('show');
    // leaving the view pauses the video (audio comes out of the treadmill speakers)
    if (this.ready && !this.native) this.send('pauseVideo');
  },

  // ── playback ────────────────────────────────────────────────────────────
  playFromInput: function () {
    var input = document.getElementById('vvInput');
    var item = YT.parse(input ? input.value : '');
    if (!item) { this._hint('Not a YouTube link. Paste a video or playlist link, or an 11-character video ID.'); return; }
    if (input) input.value = '';
    this.play(item);
  },

  /** Load an item into the pane. Playback itself still waits for the user's PLAY tap (browser policy). */
  play: function (item, nativeControls) {
    if (!this.el || !item) return;
    this.stop(true);
    this.item = { type: item.type, id: item.id, list: item.list || null, title: item.title || null };
    this.native = !!nativeControls;
    this.ready = false; this.playerState = -1;
    this._setMode('player');
    var f = document.createElement('iframe');
    f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('title', 'YouTube');
    f.src = YT.embedUrl(this.item, this.native);
    var self = this, loaded = false;
    f.addEventListener('load', function () {
      loaded = true;
      if (self._loadTimer) { clearTimeout(self._loadTimer); self._loadTimer = null; }
      if (!self.native) self._startListening();
    });
    f.addEventListener('error', function () { self.fail('This video cannot be played here — pick another'); });
    this._loadTimer = setTimeout(function () { if (!loaded) self.fail('Could not load the video (offline?) — pick another'); }, this.LOAD_TIMEOUT_MS);
    this.frameBox.appendChild(f);
    this.iframe = f;
    this._setTitle(YT.label(this.item));
    this._remember(this.item);
    this._wake();
    this._fit();
    this._updateButtons();
  },

  stop: function (keepMode) {
    if (this.iframe) { try { this.iframe.src = 'about:blank'; } catch (e) {} if (this.iframe.parentNode) this.iframe.parentNode.removeChild(this.iframe); }
    this.iframe = null; this.ready = false; this.playerState = -1;
    if (this._loadTimer) { clearTimeout(this._loadTimer); this._loadTimer = null; }
    if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
    if (this._listenTimer) { clearInterval(this._listenTimer); this._listenTimer = null; }
    if (!keepMode) { this.item = null; this._setMode('empty'); this.renderLists(); }
    this._updateButtons();
  },

  /** Failure: plain large message + favourites, never a blank pane. */
  fail: function (msg) {
    this.stop(true);
    var m = document.getElementById('vvFailMsg'); if (m) m.textContent = msg;
    this._setMode('fail');
    this.renderLists();
  },

  // ── postMessage channel (IFrame API protocol, no script) ────────────────
  _startListening: function () {
    var self = this, tries = 0;
    if (this._listenTimer) clearInterval(this._listenTimer);
    var ping = function () { self._post({ event: 'listening', id: 'tr', channel: 'widget' }); };
    ping();
    this._listenTimer = setInterval(function () { if (self.ready || ++tries > 12) { clearInterval(self._listenTimer); self._listenTimer = null; } else ping(); }, 500);
    this._readyTimer = setTimeout(function () {
      if (!self.ready && self.item) {
        // Channel silent → fall back to YouTube's own controls (one reload, controls=1)
        self._hint('Using YouTube\'s own controls (the big buttons did not get an answer from the player).');
        self.play(self.item, true);
      }
    }, this.READY_TIMEOUT_MS);
  },

  _post: function (obj) {
    if (!this.iframe || !this.iframe.contentWindow) return;
    try { this.iframe.contentWindow.postMessage(JSON.stringify(obj), YT.stub() ? '*' : YT.ORIGIN); } catch (e) {}
  },

  send: function (func, args) {
    if (!this.ready || this.native) return false;
    this._post({ event: 'command', func: func, args: args || [], id: 'tr', channel: 'widget' });
    return true;
  },

  _onMessage: function (e) {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    var okOrigin = e.origin === YT.ORIGIN || (YT.stub() && e.origin === window.location.origin);
    if (!okOrigin) return;
    var msg = null;
    try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (!msg || !msg.event) return;
    try {
      if (msg.event === 'onReady' || msg.event === 'infoDelivery' || msg.event === 'initialDelivery') {
        if (!this.ready) {
          this.ready = true;
          if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
          this.iframe.style.pointerEvents = 'none'; // our big buttons drive it; taps on the video do nothing
          this._hint('');
          this._updateButtons();
        }
        var info = msg.info || {};
        if (info.playerState != null) this.playerState = info.playerState;
        if (info.muted != null) this.muted = !!info.muted;
        if (info.volume != null) this.volume = info.volume;
        if (info.videoData && info.videoData.title && this.item && this.item.title !== info.videoData.title) {
          this.item.title = info.videoData.title; this._setTitle(this.item.title); this._remember(this.item);
        }
        if (info.playlist && info.playlist.length) this._playlistLen = info.playlist.length;
        if (info.playlistIndex != null) this._playlistIndex = info.playlistIndex;
        this._updateButtons();
      } else if (msg.event === 'onStateChange') {
        this.playerState = typeof msg.info === 'number' ? msg.info : (msg.info && msg.info.playerState) || this.playerState;
        this._updateButtons();
      } else if (msg.event === 'onError') {
        var code = typeof msg.info === 'number' ? msg.info : (msg.info && msg.info.code) || 0;
        var why = (code === 101 || code === 150) ? 'the uploader does not allow it to be embedded' : code === 100 ? 'it is private or was removed' : code === 2 ? 'the link is not a valid video' : 'playback error ' + code;
        this.fail('This video cannot be played here — pick another (' + why + ')');
      }
    } catch (err) { /* never let a player message break the run screen */ }
  },

  // ── big buttons ─────────────────────────────────────────────────────────
  togglePlay: function () { if (this.playerState === 1 || this.playerState === 3) this.send('pauseVideo'); else this.send('playVideo'); this._wake(); },
  toggleMute: function () { if (this.muted) this.send('unMute'); else this.send('mute'); this.muted = !this.muted; this._updateButtons(); },
  volumeBy: function (d) { this.volume = Math.max(0, Math.min(100, (this.volume || 0) + d)); this.send('setVolume', [this.volume]); if (this.volume > 0 && this.muted) { this.send('unMute'); this.muted = false; } this._updateButtons(); },
  next: function () { this.send('nextVideo'); },
  prev: function () { this.send('previousVideo'); },
  backToList: function () { this.stop(false); },

  _updateButtons: function () {
    var $ = function (id) { return document.getElementById(id); };
    var ctl = $('vvCtl'); if (!ctl) return;
    var hasPlayer = !!this.iframe;
    ctl.style.display = hasPlayer && !this.native ? '' : 'none';
    var note = $('vvNativeNote'); if (note) note.style.display = hasPlayer && this.native ? '' : 'none';
    var playing = this.playerState === 1 || this.playerState === 3;
    var p = $('vvPlay'); if (p) { p.textContent = playing ? '⏸ PAUSE' : '▶ PLAY'; p.classList.toggle('on', playing); }
    var m = $('vvMute'); if (m) { m.textContent = this.muted ? '🔇 UNMUTE' : '🔊 MUTE'; m.classList.toggle('on', this.muted); }
    var v = $('vvVol'); if (v) v.textContent = this.muted ? 'muted' : (this.volume != null ? this.volume + '%' : '');
    var isList = !!(this.item && (this.item.type === 'playlist' || this.item.list));
    var pn = $('vvPrev'), nx = $('vvNext');
    if (pn) pn.style.display = isList ? '' : 'none';
    if (nx) nx.style.display = isList ? '' : 'none';
    var rd = $('vvReady'); if (rd) rd.textContent = hasPlayer ? (this.ready ? '' : 'connecting to player…') : '';
  },

  // ── favourites / recent / last ──────────────────────────────────────────
  _load: function (k, fb) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? fb : v; } catch (e) { return fb; } },
  _save: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  getFavs: function () { var f = this._load(this.FAV_KEY, []); if (!Array.isArray(f)) f = []; while (f.length < this.SLOTS) f.push(null); return f.slice(0, this.SLOTS); },
  getRecent: function () { var r = this._load(this.RECENT_KEY, []); return Array.isArray(r) ? r : []; },
  getLast: function () { var l = this._load(this.LAST_KEY, null); return l && l.id ? l : null; },

  _remember: function (item) {
    var rec = { type: item.type, id: item.id, list: item.list || null, title: item.title || null, at: Date.now() };
    this._save(this.LAST_KEY, rec);
    var recent = this.getRecent().filter(function (r) { return !(r.id === rec.id && r.type === rec.type); });
    recent.unshift(rec);
    this._save(this.RECENT_KEY, recent.slice(0, this.RECENT_MAX));
    var favs = this.getFavs(), changed = false;
    for (var i = 0; i < favs.length; i++) if (favs[i] && favs[i].id === rec.id && favs[i].type === rec.type) { favs[i].lastPlayed = rec.at; if (rec.title && !favs[i].customLabel) favs[i].label = rec.title; changed = true; }
    if (changed) this._save(this.FAV_KEY, favs);
  },

  saveFav: function (i) {
    var input = document.getElementById('vvInput');
    var item = YT.parse(input ? input.value : '') || this.item || this.getLast();
    if (!item) { this._hint('Paste a link first (or play something), then tap an empty slot to save it'); return; }
    var self = this;
    var done = function (label) {
      var favs = self.getFavs();
      favs[i] = { type: item.type, id: item.id, list: item.list || null, label: (label || YT.label(item)).slice(0, 40), customLabel: !!label, lastPlayed: null };
      self._save(self.FAV_KEY, favs);
      if (input) input.value = '';
      self.renderLists();
    };
    if (typeof UI !== 'undefined' && UI.prompt) UI.prompt('Name this favourite', item.title || YT.label(item)).then(function (t) { if (t !== null) done(t); });
    else done('');
  },
  renameFav: function (i) {
    var favs = this.getFavs(); if (!favs[i]) return;
    var self = this;
    var done = function (label) { if (label) { favs[i].label = label.slice(0, 40); favs[i].customLabel = true; self._save(self.FAV_KEY, favs); self.renderLists(); } };
    if (typeof UI !== 'undefined' && UI.prompt) UI.prompt('Rename favourite', favs[i].label).then(function (t) { if (t !== null) done(t); });
    else done('');
  },
  removeFav: function (i) { var favs = this.getFavs(); favs[i] = null; this._save(this.FAV_KEY, favs); this.renderLists(); },
  playFav: function (i) { var f = this.getFavs()[i]; if (f) this.play({ type: f.type, id: f.id, list: f.list, title: f.customLabel ? null : f.label }); },
  playRecent: function (i) { var r = this.getRecent()[i]; if (r) this.play(r); },
  resume: function () { var l = this.getLast(); if (l) this.play(l); },

  renderLists: function () {
    var esc = this._esc, self = this;
    var favs = this.getFavs();
    var favHtml = '';
    for (var i = 0; i < favs.length; i++) {
      var f = favs[i];
      if (f) {
        favHtml += '<div class="vv-fav" onclick="VideoView.playFav(' + i + ')">' +
          '<span class="vv-fav-kind">' + (f.type === 'playlist' ? '≡' : '▶') + '</span>' +
          '<span class="vv-fav-t">' + esc(f.label || YT.label(f)) + (f.lastPlayed ? '<small>' + self._ago(f.lastPlayed) + '</small>' : '') + '</span>' +
          '<button class="vv-fav-x" onclick="event.stopPropagation();VideoView.renameFav(' + i + ')" title="Rename">✎</button>' +
          '<button class="vv-fav-x" onclick="event.stopPropagation();VideoView.removeFav(' + i + ')" title="Remove">✕</button></div>';
      } else {
        favHtml += '<div class="vv-fav empty" onclick="VideoView.saveFav(' + i + ')">＋ save link here</div>';
      }
    }
    var fa = document.getElementById('vvFavs'); if (fa) fa.innerHTML = favHtml;
    var fb = document.getElementById('vvFavsFail'); if (fb) fb.innerHTML = favHtml;
    var recent = this.getRecent();
    var rh = recent.length ? recent.map(function (r, i) { return '<button class="vv-recent-item" onclick="VideoView.playRecent(' + i + ')">' + (r.type === 'playlist' ? '≡ ' : '▶ ') + esc(r.title || YT.label(r)) + '</button>'; }).join('') : '<span class="vv-dim">nothing played yet</span>';
    var re = document.getElementById('vvRecent'); if (re) re.innerHTML = rh;
    var last = this.getLast();
    var rb = document.getElementById('vvResume');
    if (rb) { rb.style.display = last ? '' : 'none'; rb.textContent = last ? '▶ RESUME: ' + (last.title || YT.label(last)).slice(0, 36) : ''; }
  },

  // ── tiles (read-only) ───────────────────────────────────────────────────
  update: function () {
    if (!this.active || typeof Engine === 'undefined' || !Engine.run) return;
    var r = Engine.run;
    var set = function (id, v) { var e = document.getElementById(id); if (e && e.textContent !== String(v)) e.textContent = v; };
    set('vvTime', Engine.fmtTime(r.elapsed || 0));
    set('vvDist', UI.convDist((r.distanceM || 0) / 1000)); set('vvDistU', UI.distLabel());
    set('vvHR', r.hr > 0 ? r.hr : '—');
    var z = Engine.getCurrentZone();
    var hrEl = document.getElementById('vvHR'), zEl = document.getElementById('vvZone');
    if (z > 0 && r.hr > 0) { var zz = Engine.HR_ZONES[z - 1]; if (hrEl) hrEl.style.color = zz.color; if (zEl) { zEl.textContent = 'Z' + z + ' · ' + zz.label.toUpperCase(); zEl.style.color = zz.color; } }
    else { if (hrEl) hrEl.style.color = 'var(--red)'; if (zEl) { zEl.textContent = r.hr > 0 ? 'below Z1' : 'no HR'; zEl.style.color = 'var(--dim)'; } }
    set('vvPace', Units.paceFromKmh(r.speed));
    set('vvSpeed', UI.convSpeed(r.speed || 0)); set('vvSpeedU', UI.speedLabel());
    var inc = r.currentGrade != null && Engine.hasRoute() ? r.currentGrade : (r.incline || 0);
    set('vvInc', (inc >= 0 ? '+' : '') + inc.toFixed(1));
    set('vvElev', '+' + UI.convElev(r.elevGained || 0)); set('vvElevU', UI.elevLabel() + ' gain');
    set('vvCal', Math.round(r.calories || 0));
    // current km split + best for that km on this route (when known)
    var kmIdx = (r.splits ? r.splits.length : 0) + 1;
    var inSplit = Math.max(0, (r.elapsed || 0) - (r._lastSplitElapsed || 0));
    var into = ((r.distanceM || 0) % 1000) / 1000;
    set('vvSplit', Engine.fmtTime(inSplit));
    var tgt = '';
    try {
      if (Engine.hasRoute() && typeof PastRunSplits !== 'undefined') {
        if (!this._splitCache || this._splitCache.run !== r.startedAt) this._splitCache = { run: r.startedAt, pool: PastRunSplits.get(r.routeId || null, (Engine.route && Engine.route.totalDistKm) || 0, null) };
        var pool = this._splitCache.pool;
        if (pool.basis === 'route' && pool.runs.length >= PastRunSplits.MIN_RUNS) {
          var st = PastRunSplits.statsForKm(pool.runs, kmIdx);
          if (st.fastest != null) tgt = ' · best ' + Engine.fmtTime(st.fastest);
        }
      }
    } catch (e) {}
    set('vvSplitU', 'km ' + kmIdx + ' · ' + Math.round(into * 1000) + ' m in' + tgt);
  },

  // ── helpers ─────────────────────────────────────────────────────────────
  /** PC/fallback 'full': the embed fills the view zone with the thin stats strip on top (#rootApp.embed-full). */
  setFull: function (on) {
    this.full = !!on;
    var r = document.getElementById('rootApp'); if (r) r.classList.toggle('embed-full', !!on);
    var self = this; setTimeout(function () { self._fit(); }, 30);
  },

  _setMode: function (mode) {
    if (!this.el) return;
    this.el.classList.toggle('mode-empty', mode === 'empty');
    this.el.classList.toggle('mode-player', mode === 'player');
    this.el.classList.toggle('mode-fail', mode === 'fail');
    if (mode !== 'player' && this.iframe) this.iframe.style.pointerEvents = 'none';
    if (mode === 'player' && this.iframe) this.iframe.style.pointerEvents = this.native ? 'auto' : 'none';
    this._updateButtons();
  },
  _fit: function () {
    // the video keeps 16:9 and is as large as the left pane allows (width-limited when the zone is tall,
    // height-limited when the race bar + elevation strip squeeze it)
    if (!this.stage || !this.frameBox) return;
    var w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    var fw = Math.min(w, Math.floor(h * 16 / 9)), fh = Math.floor(fw * 9 / 16);
    if (this.full) { fw = w; fh = h; } // PC 'full': fill the whole view zone below the strip (no 16:9 letterbox)
    this.frameBox.style.width = fw + 'px'; this.frameBox.style.height = fh + 'px';
  },
  _wake: function () { try { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(function () {}); } catch (e) {} },
  _setTitle: function (t) { var e = document.getElementById('vvTitle'); if (e) e.textContent = t || ''; },
  _hint: function (t) { var e = document.getElementById('vvHint'); if (e) e.textContent = t || 'Paste a video or playlist link — favourites are saved. (Searching YouTube inside the app is not possible without an API key.)'; },
  _ago: function (t) { var d = (Date.now() - t) / 86400000; return d < 1 ? 'today' : d < 2 ? 'yesterday' : Math.round(d) + ' days ago'; },
  _esc: function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { YT: YT, VideoView: VideoView };
