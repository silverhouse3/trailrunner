// ════════════════════════════════════════════════════════════════════════════
// BTPair — Bluetooth devices pairing screen (Settings > Bluetooth).
// Talks to the bridge's /bluetooth/* endpoints (bridge v5+). Pairing only:
// never sends speed/incline/workout commands, never touches STOP.
// Feature-detects: an older bridge (404) keeps the old hint text.
// ════════════════════════════════════════════════════════════════════════════
var BTPair = {
  supported: null,        // null = unknown, true/false after first probe
  data: null,
  busy: {},               // address -> 'connecting' | 'disconnecting'
  scanReq: false,
  error: '',
  _timer: null,
  _hrSeenAt: {},          // address -> first time connected strap had no pulse

  _base() { return (typeof TM !== 'undefined' && TM._bridgeBase) || ''; },
  _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },

  _get() {
    var self = this;
    return fetch(this._base() + '/bluetooth/devices').then(function (r) {
      if (r.status === 404 || r.status === 405) { self.supported = false; return null; }
      self.supported = true;
      return r.json();
    }).catch(function () { return undefined; });
  },
  _post(path, body) {
    return fetch(this._base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad reply' }; }); })
      .catch(function () { return { ok: false, error: 'bridge unreachable' }; });
  },

  // Called by the old HR pill: true when the new screen handled it.
  openFromPill() {
    if (this.supported === false) return false;
    if (typeof SettingsPanel === 'undefined') return false;
    SettingsPanel._openSections.add('bluetooth');
    SettingsPanel.open();
    return true;
  },

  html() {
    return '<div id="btPairBox" class="btp-box">' + this._inner() + '</div>';
  },

  // Called after the settings panel renders: start polling while the box exists.
  mount() {
    var self = this;
    this.refresh();
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(function () {
      if (!document.getElementById('btPairBox')) { clearInterval(self._timer); self._timer = null; return; }
      self.refresh();
    }, 1500);
  },

  refresh() {
    var self = this;
    return this._get().then(function (d) {
      if (d === undefined) { self.error = 'Bluetooth unavailable'; self.data = null; }
      else if (d === null) { self.data = null; }
      else { self.data = d; self.error = d.available === false ? 'Bluetooth unavailable' : ''; if (d.available !== false) { var a; for (a in self.busy) { var st = self._stateOf(a); if ((self.busy[a] === 'connecting' && st === 'connected') || (self.busy[a] === 'disconnecting' && st !== 'connected')) delete self.busy[a]; } } }
      self._draw();
    });
  },

  _stateOf(addr) {
    var d = this.data; if (!d) return 'disconnected';
    var c = (d.connected || []).concat(d.discovered || []);
    for (var i = 0; i < c.length; i++) if (c[i].address === addr) return c[i].state;
    return 'disconnected';
  },

  _draw() {
    var el = document.getElementById('btPairBox');
    if (el) el.innerHTML = this._inner();
  },

  _icon(t) { return { heart_rate: '❤', headphones: '🎧', watch: '⌚', ring: '💍', phone: '📱', console: '🏃' }[t] || '📶'; },
  _bars(n) { var s = ''; for (var i = 1; i <= 4; i++) s += '<i class="btp-bar' + (i <= n ? ' on' : '') + '"></i>'; return '<span class="btp-sig" title="signal">' + s + '</span>'; },

  _row(dv, connected) {
    var a = this._esc(dv.address), busy = this.busy[dv.address], state = busy || dv.state;
    var label, cls, act;
    if (connected && !busy) { label = 'Connected'; cls = 'ok'; act = '<button class="btp-btn off" onclick="BTPair.disconnect(\'' + a + '\')">Disconnect</button>'; }
    else if (busy === 'disconnecting') { label = 'Disconnecting…'; cls = ''; act = '<button class="btp-btn" disabled>Disconnecting…</button>'; }
    else if (state === 'connecting' || busy === 'connecting') { label = 'Connecting…'; cls = 'wait'; act = '<button class="btp-btn" onclick="BTPair.disconnect(\'' + a + '\')">Cancel</button>'; }
    else { label = ''; cls = ''; act = '<button class="btp-btn on" onclick="BTPair.connect(\'' + a + '\')">Connect</button>'; }
    var reading = '';
    if (connected && dv.type === 'heart_rate') {
      if (dv.reading) reading = '<div class="btp-hr">❤ <b>' + dv.reading + '</b> bpm</div>';
      else reading = '<div class="btp-hint">Strap connected but no pulse yet – wear it snug</div>';
    }
    return '<div class="btp-row"><div class="btp-ic">' + this._icon(dv.type) + '</div>' +
      '<div class="btp-main"><div class="btp-name">' + this._esc(dv.name) + '</div>' +
      '<div class="btp-sub">' + (label ? '<span class="btp-st ' + cls + '">' + label + '</span> ' : '') + this._bars(dv.signal) +
      (dv.battery > 0 ? ' <span class="btp-bat">' + dv.battery + '%</span>' : '') + '</div>' + reading + '</div>' + act + '</div>';
  },

  _inner() {
    if (this.supported === false) {
      return '<div class="btp-hint">Pair your heart-rate strap in iFIT (Workout settings &gt; Devices); TrailRunner reads it from the treadmill.</div>';
    }
    var d = this.data, h = '';
    if (this.supported === null || (!d && !this.error)) return '<div class="btp-hint">Checking Bluetooth…</div>';
    if (this.error || !d) return '<div class="btp-hint warn">Bluetooth unavailable</div>';
    var scanning = !!d.scanning;
    h += '<div class="btp-head"><div class="btp-title">Bluetooth devices</div>' +
      '<button class="btp-btn scan" onclick="BTPair.scan(' + (scanning ? 'false' : 'true') + ')">' + (scanning ? 'Stop' : 'Scan') + '</button></div>';
    var conn = d.connected || [], disc = d.discovered || [];
    if (conn.length) { h += '<div class="btp-sec">CONNECTED</div>'; conn.forEach(function (x) { h += BTPair._row(x, true); }); }
    h += '<div class="btp-sec">NEARBY' + (scanning ? ' <span class="btp-st wait">Searching…</span>' : '') + '</div>';
    if (disc.length) disc.forEach(function (x) { h += BTPair._row(x, false); });
    else h += '<div class="btp-hint">' + (scanning ? 'Searching…' : 'Nothing found yet – tap Scan with the strap on.') + '</div>';
    if (this.actionError) h += '<div class="btp-hint warn">' + this._esc(this.actionError) + '</div>';
    return h;
  },

  scan(start) {
    var self = this; this.actionError = '';
    if (this.data) this.data.scanning = !!start;   // optimistic: shows Searching… at once
    this._draw();
    return this._post('/bluetooth/scan', { action: start ? 'start' : 'stop' }).then(function (r) {
      if (!r.ok) self.actionError = r.error || 'Scan failed';
      return self.refresh();
    });
  },
  connect(addr) {
    var self = this; this.actionError = ''; this.busy[addr] = 'connecting'; this._draw();
    return this._post('/bluetooth/connect', { address: addr }).then(function (r) {
      if (!r.ok) { delete self.busy[addr]; self.actionError = r.error || 'Connect failed'; }
      return self.refresh();
    });
  },
  disconnect(addr) {
    var self = this; this.actionError = ''; this.busy[addr] = 'disconnecting'; this._draw();
    return this._post('/bluetooth/disconnect', { address: addr }).then(function (r) {
      if (!r.ok) { delete self.busy[addr]; self.actionError = r.error || 'Disconnect failed'; }
      return self.refresh();
    });
  }
};
setTimeout(function () { try { BTPair._get(); } catch (e) {} }, 3000);  // feature-detect early so the HR pill knows

// ════════════════════════════════════════════════════════════════════════════
// BTAudio — "ADD HEADPHONES" (Settings > Bluetooth). Pairs Bluetooth AUDIO devices through the Android app
// (window.AndroidBridge.btAudio*, TrailRunner chooser7+), NOT through the treadmill bridge: no HTTP calls at all,
// no speed / incline / workout / STOP commands. The app only ever lists audio-class devices.
// ════════════════════════════════════════════════════════════════════════════
var BTAudio = {
  data: null,
  pairing: null,        // address being paired/connected (local UI state)
  pairingSince: 0,
  scanReq: false,
  error: '',
  _timer: null,

  available() { try { return !!(window.AndroidBridge && typeof AndroidBridge.btAudioState === 'function'); } catch (e) { return false; } },
  _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
  _call(fn, a) {
    try {
      var r = (a === undefined) ? AndroidBridge[fn]() : AndroidBridge[fn](a);
      var d = typeof r === 'string' ? JSON.parse(r) : r;
      return d && typeof d === 'object' ? d : null;
    } catch (e) { this.error = 'Headphone pairing is not working on this screen.'; return null; }
  },

  html() {
    if (this.available()) return '<div id="btAudioBox" class="bta-box">' + this._inner() + '</div>';
    if (window.AndroidBridge) return '<div class="bta-box"><div class="btp-hint">Headphone pairing needs the TrailRunner app update.</div></div>';
    return '';
  },

  mount() {
    var self = this;
    if (!this.available()) return;
    this.refresh();
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(function () {
      if (!document.getElementById('btAudioBox')) { clearInterval(self._timer); self._timer = null; return; }
      self.refresh();
    }, 1500);
  },

  refresh() {
    var d = this._call('btAudioState');
    if (d) {
      this.data = d;
      if (this.pairing) {
        var p = this.pairing, b = this._bonded(p);
        if (b && b.connected) { this.pairing = null; this.error = ''; }
        else if (d.lastError && !d.discovering && Date.now() - this.pairingSince > 1500) { this.error = d.lastError; this.pairing = null; }
        else if (Date.now() - this.pairingSince > 45000) { this.error = 'That took too long. Put the headphones in pairing mode and try again.'; this.pairing = null; }
      } else if (d.lastError) this.error = d.lastError;
      if (!d.discovering) this.scanReq = false;
    }
    this._draw();
  },

  _bonded(addr) { var l = (this.data && this.data.bonded) || []; for (var i = 0; i < l.length; i++) if (l[i].address === addr) return l[i]; return null; },
  _draw() { var el = document.getElementById('btAudioBox'); if (el) el.innerHTML = this._inner(); },

  _bars(rssi) { var n = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -80 ? 2 : 1; return BTPair._bars(n); },

  _inner() {
    var d = this.data, h = '';
    h += '<div class="btp-head"><div class="btp-title">Headphones</div>';
    if (!d) return h + '</div><div class="btp-hint">Checking Bluetooth…</div>';
    var scanning = !!d.discovering || this.scanReq;
    if (d.enabled === false) return h + '</div><div class="btp-hint warn">' + this._esc(d.lastError || 'Bluetooth is switched off.') + '</div>';
    h += '<button class="btp-btn scan bta-add" onclick="BTAudio.scan(' + (scanning ? 'false' : 'true') + ')">' + (scanning ? 'Stop' : 'ADD HEADPHONES') + '</button></div>';
    var bonded = d.bonded || [], self = this;
    if (bonded.length) {
      h += '<div class="btp-sec">MY HEADPHONES</div>';
      bonded.forEach(function (b) {
        var a = self._esc(b.address), busy = self.pairing === b.address;
        h += '<div class="btp-row"><div class="btp-ic">🎧</div><div class="btp-main"><div class="btp-name">' + self._esc(b.name) + '</div><div class="btp-sub">' +
          (b.connected ? '<span class="btp-st ok">Connected</span> Audio output' : busy ? '<span class="btp-st wait">Connecting…</span>' : 'Not connected') + '</div></div>' +
          (b.connected ? '<button class="btp-btn off" onclick="BTAudio.disconnect(\'' + a + '\')">Disconnect</button>'
            : busy ? '<button class="btp-btn" disabled>Connecting…</button>'
            : '<button class="btp-btn on" onclick="BTAudio.connect(\'' + a + '\')">Connect</button>') +
          '<button class="btp-btn bta-forget" onclick="BTAudio.forget(\'' + a + '\')">Forget</button></div>';
      });
    }
    var found = (d.found || []).filter(function (f) { return !self._bonded(f.address); }).sort(function (x, y) { return (y.rssi || -100) - (x.rssi || -100); });
    if (scanning || found.length) {
      h += '<div class="btp-sec">NEARBY' + (scanning ? ' <span class="btp-st wait">Searching…</span>' : '') + '</div>';
      if (!found.length) h += '<div class="btp-hint">Put your headphones in pairing mode (hold the Bluetooth button until the light flashes).</div>';
      found.forEach(function (f) {
        var a = self._esc(f.address), busy = self.pairing === f.address;
        h += '<div class="btp-row"><div class="btp-ic">🎧</div><div class="btp-main"><div class="btp-name">' + self._esc(f.name) + '</div><div class="btp-sub">' +
          (busy ? '<span class="btp-st wait">Pairing…</span> ' : '') + self._bars(f.rssi) + '</div></div>' +
          (busy ? '<button class="btp-btn" disabled>Pairing…</button>' : '<button class="btp-btn on" onclick="BTAudio.pair(\'' + a + '\')">Pair</button>') + '</div>';
      });
    } else if (!bonded.length) {
      h += '<div class="btp-hint">Tap ADD HEADPHONES, then put your headphones in pairing mode.</div>';
    }
    if (this.error) h += '<div class="btp-hint warn">' + this._esc(this.error) + '</div>';
    return h;
  },

  _apply(d) { if (d) { this.data = d; if (d.lastError) this.error = d.lastError; } this._draw(); },

  scan(start) {
    this.error = ''; this.scanReq = !!start;
    var d = this._call('btAudioScan', !!start);
    if (d && d.lastError) { this.scanReq = false; }
    this._apply(d);
  },
  pair(addr) {
    this.error = ''; this.pairing = addr; this.pairingSince = Date.now(); this._draw();
    var d = this._call('btAudioPair', addr);
    if (d && d.lastError) { this.pairing = null; }
    this._apply(d);
  },
  connect(addr) {
    this.error = ''; this.pairing = addr; this.pairingSince = Date.now(); this._draw();
    var d = this._call('btAudioConnect', addr);
    if (d && d.lastError) { this.pairing = null; }
    this._apply(d);
  },
  disconnect(addr) { this.error = ''; this._apply(this._call('btAudioDisconnect', addr)); },
  forget(addr) { this.error = ''; if (this.pairing === addr) this.pairing = null; this._apply(this._call('btAudioForget', addr)); }
};
