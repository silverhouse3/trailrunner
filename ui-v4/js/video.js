// ════════════════════════════════════════════════════════════════════════════
// VideoWin — floating YouTube window for the live-run screen (ui-v4)
//
//  * youtube-nocookie.com iframe embed, no API key, no CDN script
//  * never auto-plays on page load: an iframe is only created when the user
//    taps PLAY / a favourite slot
//  * movable (drag the title bar) + resizable (drag the corner), touch + mouse
//  * clamped inside the view zone, so it can never cover STOP/PAUSE or the
//    speed/incline edge controls, and the metric strip stays visible
//  * fallback: 'Video unavailable here' + a big button that opens the YouTube
//    app via an Android intent: URL
//  * has NOTHING to do with the treadmill: no TM / Engine calls in here
// ════════════════════════════════════════════════════════════════════════════

var VideoWin = {
  FAV_KEY: 'tr_video_favs',
  SLOTS: 4,
  LOAD_TIMEOUT_MS: 12000,

  el: null, bar: null, body: null, setup: null, fallback: null, titleEl: null, input: null,
  _pos: null,            // {x, y, w, h} in #rootApp px, relative to .center
  _currentId: null,
  _loadTimer: null,
  _drag: null,

  init: function() {
    this.el = document.getElementById('videoWin');
    if (!this.el) return;
    this.bar = this.el.querySelector('.video-bar');
    this.body = this.el.querySelector('.video-body');
    this.setup = this.el.querySelector('.video-setup');
    this.fallback = this.el.querySelector('.video-fallback');
    this.titleEl = this.el.querySelector('.vb-title');
    this.input = document.getElementById('videoUrlInput');
    var self = this;

    // Drag (title bar) and resize (corner) — touch + mouse, old-WebView safe
    this._bindDrag(this.bar, 'move');
    this._bindDrag(this.el.querySelector('.video-resize'), 'resize');
    window.addEventListener('resize', function() { self._clamp(); self._apply(); });
    if (this.input) {
      this.input.addEventListener('keydown', function(e) { if (e.key === 'Enter') self.playFromInput(); });
    }
    this.renderFavs();
  },

  // ── Open / close / minimise ─────────────────────────────────────────────

  open: function() {
    if (!this.el) return;
    if (!this._pos) this._defaultPos();
    this.el.classList.add('show');
    this.el.classList.remove('min');
    this._clamp(); this._apply();
    this._setTitle(this._currentId ? 'YOUTUBE' : 'VIDEO');
  },

  toggle: function() {
    if (!this.el) return;
    if (this.el.classList.contains('show') && !this.el.classList.contains('min')) this.minimise();
    else this.open();
  },

  minimise: function() {
    if (!this.el) return;
    this.el.classList.add('min');
    this._clamp(); this._apply();
  },

  restore: function() { this.open(); },

  close: function() {
    if (!this.el) return;
    this.stop();
    this.el.classList.remove('show');
    this.el.classList.remove('min');
  },

  /** Remove the iframe (stops playback + audio). */
  stop: function() {
    var f = this.body ? this.body.querySelector('iframe') : null;
    if (f) { try { f.src = 'about:blank'; } catch (e) {} f.parentNode.removeChild(f); }
    if (this._loadTimer) { clearTimeout(this._loadTimer); this._loadTimer = null; }
    if (this.fallback) this.fallback.classList.remove('show');
    if (this.setup) this.setup.style.display = '';
    this._currentId = null;
    this._setTitle('VIDEO');
  },

  // ── Playback ────────────────────────────────────────────────────────────

  /** Accepts a full YouTube URL (watch, youtu.be, shorts, embed) or a bare 11-char ID. */
  parseId: function(text) {
    if (!text) return null;
    text = String(text).trim();
    var m = /^[A-Za-z0-9_-]{11}$/.exec(text);
    if (m) return text;
    m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(text); if (m) return m[1];
    m = /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(text); if (m) return m[1];
    m = /\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/.exec(text); if (m) return m[1];
    return null;
  },

  playFromInput: function() {
    var id = this.parseId(this.input ? this.input.value : '');
    if (!id) { this._hint('Paste a YouTube link or an 11-character video ID'); return; }
    this.play(id);
  },

  play: function(id) {
    if (!this.el || !id) return;
    this.open();
    this.stop();
    this._currentId = id;
    this._setTitle('YOUTUBE · ' + id);
    // Feature detection: offline, or no iframe support → fallback straight away
    if (navigator.onLine === false || typeof HTMLIFrameElement === 'undefined') { this.showFallback(id); return; }
    var f = document.createElement('iframe');
    f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('title', 'YouTube');
    // playsinline keeps it in the window; NO autoplay parameter — the user presses the embed's play button
    f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?rel=0&playsinline=1&modestbranding=1&iv_load_policy=3';
    var self = this;
    var loaded = false;
    f.addEventListener('load', function() { loaded = true; if (self._loadTimer) { clearTimeout(self._loadTimer); self._loadTimer = null; } });
    f.addEventListener('error', function() { self.showFallback(id); });
    this._loadTimer = setTimeout(function() { if (!loaded) self.showFallback(id); }, this.LOAD_TIMEOUT_MS);
    if (this.setup) this.setup.style.display = 'none';
    this.body.appendChild(f);
  },

  /** 'Video unavailable here' + big button → YouTube app via Android intent URL (plain https fallback elsewhere). */
  showFallback: function(id) {
    if (!this.fallback) return;
    var f = this.body ? this.body.querySelector('iframe') : null;
    if (f) { try { f.src = 'about:blank'; } catch (e) {} f.parentNode.removeChild(f); }
    if (this.setup) this.setup.style.display = 'none';
    var isAndroid = /Android/i.test(navigator.userAgent || '');
    var href = isAndroid
      ? 'intent://www.youtube.com/watch?v=' + id + '#Intent;scheme=https;package=com.google.android.youtube;end'
      : 'https://www.youtube.com/watch?v=' + id;
    var a = this.fallback.querySelector('.vf-open');
    if (a) { a.href = href; a.target = isAndroid ? '_self' : '_blank'; }
    this.fallback.classList.add('show');
    this._setTitle('VIDEO UNAVAILABLE');
  },

  backToSetup: function() {
    this.stop();
    this.open();
  },

  // ── Favourites (localStorage, 4 big slots) ──────────────────────────────

  getFavs: function() {
    var favs = [];
    try { favs = JSON.parse(localStorage.getItem(this.FAV_KEY) || '[]'); } catch (e) { favs = []; }
    if (!Array.isArray(favs)) favs = [];
    while (favs.length < this.SLOTS) favs.push(null);
    return favs.slice(0, this.SLOTS);
  },

  _saveFavs: function(favs) { try { localStorage.setItem(this.FAV_KEY, JSON.stringify(favs)); } catch (e) {} },

  renderFavs: function() {
    var grid = document.getElementById('videoFavs');
    if (!grid) return;
    var favs = this.getFavs();
    var html = '';
    for (var i = 0; i < favs.length; i++) {
      var f = favs[i];
      if (f && f.id) {
        html += '<button class="vs-fav" onclick="VideoWin.play(\'' + f.id + '\')">' +
          '<span class="vf-t">★ ' + this._esc(f.title || f.id) + '</span>' +
          '<span class="vf-x" onclick="event.stopPropagation();VideoWin.removeFav(' + i + ')">✕</span></button>';
      } else {
        html += '<button class="vs-fav empty" onclick="VideoWin.saveFav(' + i + ')">＋ save link here</button>';
      }
    }
    grid.innerHTML = html;
  },

  /** Save the link in the box (or the video now playing) into slot i. */
  saveFav: function(i) {
    var id = this.parseId(this.input ? this.input.value : '') || this._currentId;
    if (!id) { this._hint('Paste a link first, then tap a slot to save it'); return; }
    var title = '';
    try { title = window.prompt('Name this favourite', 'Video ' + (i + 1)) || ''; } catch (e) {}
    if (!title) title = 'Video ' + (i + 1);
    var favs = this.getFavs();
    favs[i] = { id: id, title: title.slice(0, 40) };
    this._saveFavs(favs);
    this.renderFavs();
  },

  removeFav: function(i) {
    var favs = this.getFavs();
    favs[i] = null;
    this._saveFavs(favs);
    this.renderFavs();
  },

  // ── Geometry ────────────────────────────────────────────────────────────

  _zoneRect: function() {
    // Bounds = the view zone (between the metric strip and the run controls), in #rootApp px
    var zone = document.querySelector('.map-zone');
    if (!zone) return { x: 0, y: 0, w: 1400, h: 600 };
    return { x: zone.offsetLeft, y: zone.offsetTop, w: zone.offsetWidth, h: zone.offsetHeight };
  },

  _defaultPos: function() {
    // Bottom-right corner of the view zone: clear of the view/zoom buttons (top-right)
    var z = this._zoneRect();
    var w = Math.min(640, z.w - 32), h = Math.min(432, z.h - 32);
    this._pos = { x: z.x + z.w - w - 16, y: z.y + z.h - h - 16, w: w, h: h };
  },

  _clamp: function() {
    if (!this._pos) this._defaultPos();
    var z = this._zoneRect(), p = this._pos;
    var minW = this.el.classList.contains('min') ? 300 : 400;
    var minH = this.el.classList.contains('min') ? 72 : 300;
    p.w = Math.max(minW, Math.min(p.w, z.w));
    p.h = Math.max(minH, Math.min(p.h, z.h));
    var hNow = this.el.classList.contains('min') ? 72 : p.h;
    var wNow = this.el.classList.contains('min') ? 300 : p.w;
    p.x = Math.max(z.x, Math.min(p.x, z.x + z.w - wNow));
    p.y = Math.max(z.y, Math.min(p.y, z.y + z.h - hNow));
  },

  _apply: function() {
    if (!this.el || !this._pos) return;
    this.el.style.left = Math.round(this._pos.x) + 'px';
    this.el.style.top = Math.round(this._pos.y) + 'px';
    this.el.style.width = Math.round(this._pos.w) + 'px';
    this.el.style.height = Math.round(this._pos.h) + 'px';
  },

  _scale: function() {
    // #rootApp is scaled with CSS zoom (or transform) — convert viewport px to root px
    return (typeof App !== 'undefined' && App._scale) ? App._scale : 1;
  },

  _bindDrag: function(handle, mode) {
    if (!handle) return;
    var self = this;
    function point(e) {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
      return { x: t.clientX, y: t.clientY };
    }
    function start(e) {
      if (e.target && /^(BUTTON|INPUT|A)$/.test(e.target.tagName)) return; // let the bar buttons work
      if (!self._pos) self._defaultPos();
      var pt = point(e);
      self._drag = { mode: mode, sx: pt.x, sy: pt.y, ox: self._pos.x, oy: self._pos.y, ow: self._pos.w, oh: self._pos.h };
      // iframes swallow pointer events during a drag — cover the body while dragging
      if (self.body) self.body.style.pointerEvents = 'none';
      e.preventDefault();
    }
    function move(e) {
      if (!self._drag || self._drag.mode !== mode) return;
      var pt = point(e), s = self._scale();
      var dx = (pt.x - self._drag.sx) / s, dy = (pt.y - self._drag.sy) / s;
      if (mode === 'move') { self._pos.x = self._drag.ox + dx; self._pos.y = self._drag.oy + dy; }
      else { self._pos.w = self._drag.ow + dx; self._pos.h = self._drag.oh + dy; }
      self._clamp(); self._apply();
      e.preventDefault();
    }
    function end() {
      if (self._drag && self._drag.mode === mode) self._drag = null;
      if (self.body) self.body.style.pointerEvents = '';
    }
    handle.addEventListener('touchstart', start, { passive: false });
    handle.addEventListener('mousedown', start);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
    document.addEventListener('mouseup', end);
  },

  // ── Helpers ─────────────────────────────────────────────────────────────

  _setTitle: function(t) { if (this.titleEl) this.titleEl.textContent = t; },
  _hint: function(msg) { var h = document.getElementById('videoHint'); if (h) { h.textContent = msg; } },
  _esc: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
};
