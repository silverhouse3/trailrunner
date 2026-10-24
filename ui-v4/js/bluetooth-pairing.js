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
