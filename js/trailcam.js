// ════════════════════════════════════════════════════════════════════════════
// TrailCam — POV trail running video synced to treadmill speed
//
// Plays a first-person trail video at variable playback rate:
//   0 kph = paused, 5 kph = 0.5x, 10 kph = 1.0x, 20 kph = 2.0x
// HUD overlay with speed, HR, distance, incline, power, drift/EF
// Videos stored offline in IndexedDB or loaded from local files
// ════════════════════════════════════════════════════════════════════════════

var TrailCam = {
  video: null,
  canvas: null,
  ctx: null,
  active: false,
  _anim: null,
  _container: null,

  // Video library (name → objectURL or path)
  _library: [],       // [{ name, url, blob?, duration }]
  _currentIdx: 0,
  _db: null,          // IndexedDB handle

  // Runner state (fed by engine)
  runner: {
    distKm: 0,
    speedKmh: 0,
    incline: 0,
    hr: 0,
    power: 0,
    elapsed: 0,
    driftPct: 0,
    ef: 0,
  },

  // Speed mapping: treadmill kph → video playbackRate
  // 0 kph = 0 (paused), 10 kph = 1.0x, 20 kph = 2.0x
  _BASE_SPEED: 10,    // kph that maps to 1.0x playback

  // Dust particles (carried over from TrackView for continuity)
  _dust: [],
  _lastDustSpawn: 0,

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  init: function(containerId) {
    this._container = document.getElementById(containerId);
    if (!this._container) return;

    // Create video element (hidden, no controls — we drive it programmatically)
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.setAttribute('preload', 'auto');
    this.video.muted = true;  // must be muted for autoplay on Android
    this.video.loop = true;
    this.video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;' +
      'object-fit:cover;z-index:1;background:#000;';
    this._container.appendChild(this.video);

    // Create canvas overlay (transparent, for HUD + effects)
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:2;';
    this._container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Open IndexedDB for video storage
    this._openDB();

    // Load library from IDB
    this._loadLibrary();
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SHOW / HIDE
  // ═══════════════════════════════════════════════════════════════════════════

  show: function() {
    if (!this._container) return;
    this.active = true;
    this._container.style.display = '';
    this._resize();

    // If we have videos, start playing the current one
    if (this._library.length > 0) {
      this._playVideo(this._currentIdx);
    } else {
      this._showEmptyState();
    }
    this._startLoop();
  },

  hide: function() {
    this.active = false;
    if (this._container) this._container.style.display = 'none';
    if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
    if (this.video) {
      try { this.video.pause(); } catch(e) {}
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RESIZE
  // ═══════════════════════════════════════════════════════════════════════════

  _resize: function() {
    if (!this.canvas || !this._container) return;
    var rect = this._container.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE (called by Engine on each tick)
  // ═══════════════════════════════════════════════════════════════════════════

  update: function(data) {
    if (!data) return;
    this.runner.distKm = data.distKm || 0;
    this.runner.speedKmh = data.speedKmh || 0;
    this.runner.incline = data.incline || 0;
    this.runner.hr = data.hr || 0;
    this.runner.power = data.power || 0;
    this.runner.elapsed = data.elapsed || 0;
    this.runner.driftPct = data.driftPct || 0;
    this.runner.ef = data.ef || 0;

    // Sync video playback rate to treadmill speed
    this._syncPlaybackRate();
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYBACK RATE SYNC
  // ═══════════════════════════════════════════════════════════════════════════

  _syncPlaybackRate: function() {
    if (!this.video || !this.video.src) return;

    var speed = this.runner.speedKmh;
    if (speed < 0.5) {
      // Belt stopped — pause video
      if (!this.video.paused) {
        try { this.video.pause(); } catch(e) {}
      }
      return;
    }

    // Map speed to playback rate: 10 kph = 1.0x
    // Clamp to Chrome's safe range: 0.25x to 2.0x (avoids stuttering)
    var rate = speed / this._BASE_SPEED;
    rate = Math.max(0.25, Math.min(2.0, rate));

    // Only update if changed (avoid constant property writes)
    var current = this.video.playbackRate;
    if (Math.abs(current - rate) > 0.05) {
      this.video.playbackRate = rate;
    }

    // Resume if paused
    if (this.video.paused) {
      var p = this.video.play();
      if (p && p.catch) p.catch(function() {}); // suppress autoplay errors
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // VIDEO PLAYBACK
  // ═══════════════════════════════════════════════════════════════════════════

  _playVideo: function(idx) {
    if (idx < 0 || idx >= this._library.length) return;
    this._currentIdx = idx;
    var entry = this._library[idx];

    this.video.src = entry.url;
    this.video.load();

    var self = this;
    this.video.oncanplay = function() {
      self._syncPlaybackRate();
      // Auto-play if speed > 0
      if (self.runner.speedKmh > 0.5) {
        var p = self.video.play();
        if (p && p.catch) p.catch(function() {});
      }
    };
  },

  nextVideo: function() {
    if (this._library.length < 2) return;
    this._currentIdx = (this._currentIdx + 1) % this._library.length;
    this._playVideo(this._currentIdx);
  },

  prevVideo: function() {
    if (this._library.length < 2) return;
    this._currentIdx = (this._currentIdx - 1 + this._library.length) % this._library.length;
    this._playVideo(this._currentIdx);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // VIDEO IMPORT (file picker → IndexedDB)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Open file picker and import video(s) into the library */
  importVideo: function() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.multiple = true;
    var self = this;

    input.onchange = function() {
      var files = input.files;
      if (!files || !files.length) return;

      for (var i = 0; i < files.length; i++) {
        (function(file) {
          var name = file.name.replace(/\.[^.]+$/, ''); // strip extension
          var url = URL.createObjectURL(file);

          // Store blob in IndexedDB for offline persistence
          self._storeVideo(name, file, function() {
            self._library.push({ name: name, url: url, size: file.size });
            // If this is the first video, start playing it
            if (self._library.length === 1 && self.active) {
              self._playVideo(0);
            }
            self._hideEmptyState();
          });
        })(files[i]);
      }
    };
    input.click();
  },

  /** Remove a video from the library and IndexedDB */
  removeVideo: function(idx) {
    if (idx < 0 || idx >= this._library.length) return;
    var entry = this._library[idx];

    // Revoke object URL
    if (entry.url && entry.url.indexOf('blob:') === 0) {
      URL.revokeObjectURL(entry.url);
    }

    // Remove from IDB
    this._deleteVideo(entry.name);

    // Remove from library
    this._library.splice(idx, 1);

    // Adjust current index
    if (this._currentIdx >= this._library.length) {
      this._currentIdx = Math.max(0, this._library.length - 1);
    }

    // Play next or show empty
    if (this._library.length > 0) {
      this._playVideo(this._currentIdx);
    } else {
      this.video.src = '';
      this._showEmptyState();
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INDEXEDDB — persistent offline video storage
  // ═══════════════════════════════════════════════════════════════════════════

  _openDB: function() {
    var self = this;
    var req = indexedDB.open('trailcam-videos', 1);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('videos')) {
        db.createObjectStore('videos', { keyPath: 'name' });
      }
    };
    req.onsuccess = function(e) {
      self._db = e.target.result;
    };
    req.onerror = function() {
      console.warn('[TrailCam] IndexedDB open failed — videos will be session-only');
    };
  },

  _storeVideo: function(name, blob, callback) {
    if (!this._db) { if (callback) callback(); return; }
    var tx = this._db.transaction('videos', 'readwrite');
    var store = tx.objectStore('videos');
    store.put({ name: name, blob: blob, added: Date.now() });
    tx.oncomplete = function() { if (callback) callback(); };
    tx.onerror = function() {
      console.warn('[TrailCam] Failed to store video:', name);
      if (callback) callback();
    };
  },

  _deleteVideo: function(name) {
    if (!this._db) return;
    var tx = this._db.transaction('videos', 'readwrite');
    tx.objectStore('videos').delete(name);
  },

  _loadLibrary: function() {
    var self = this;
    // Wait for DB to open (may take a moment)
    var attempts = 0;
    var check = function() {
      if (!self._db) {
        attempts++;
        if (attempts < 20) { setTimeout(check, 100); return; }
        return; // give up after 2s
      }

      var tx = self._db.transaction('videos', 'readonly');
      var store = tx.objectStore('videos');
      var req = store.getAll();
      req.onsuccess = function() {
        var records = req.result || [];
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          var url = URL.createObjectURL(r.blob);
          self._library.push({ name: r.name, url: url, size: r.blob.size });
        }
        if (self._library.length > 0 && self.active) {
          self._playVideo(0);
          self._hideEmptyState();
        }
      };
    };
    setTimeout(check, 100);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPTY STATE — shown when no videos are loaded
  // ═══════════════════════════════════════════════════════════════════════════

  _showEmptyState: function() {
    if (document.getElementById('trailcamEmpty')) return;
    var div = document.createElement('div');
    div.id = 'trailcamEmpty';
    div.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:3;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.85);color:#aaccee;font-family:Rajdhani,sans-serif;';
    div.innerHTML =
      '<div style="font-size:48px;margin-bottom:12px">🎥</div>' +
      '<div style="font-size:22px;font-weight:700;letter-spacing:0.1em;margin-bottom:8px">TRAIL CAM</div>' +
      '<div style="font-size:14px;color:#6688aa;margin-bottom:20px;text-align:center;line-height:1.6;padding:0 20px">' +
        'Import trail running videos to run through them!<br>' +
        'Videos are in <b style="color:#aaccee">Download &rarr; trailrunner_videos</b><br>' +
        'Select all 3 MP4 files. They\'ll be cached for offline use.' +
      '</div>' +
      '<button onclick="TrailCam.importVideo()" style="' +
        'background:#00cc88;color:#000;border:none;padding:16px 40px;border-radius:8px;' +
        'font-size:18px;font-weight:700;font-family:Rajdhani,sans-serif;letter-spacing:0.05em;' +
        'cursor:pointer">IMPORT VIDEOS</button>' +
      '<div style="font-size:11px;color:#445566;margin-top:16px">One-time import. Videos play at your running speed.</div>';
    this._container.appendChild(div);

    // Auto-open file picker on first visit (saves a tap)
    var self = this;
    setTimeout(function() { self.importVideo(); }, 600);
  },

  _hideEmptyState: function() {
    var el = document.getElementById('trailcamEmpty');
    if (el) el.remove();
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  _startLoop: function() {
    var self = this;
    var draw = function() {
      if (!self.active) return;
      self._render();
      self._anim = requestAnimationFrame(draw);
    };
    draw();
  },

  _render: function() {
    var c = this.ctx;
    var W = this.canvas.width;
    var H = this.canvas.height;
    if (!W || !H) return;

    // Clear overlay (transparent — video shows through)
    c.clearRect(0, 0, W, H);

    // Incline tilt effect — darken top or bottom edge
    this._drawInclineTilt(c, W, H);

    // Speed lines at high speed
    this._drawSpeedLines(c, W, H);

    // Dust particles
    this._drawDust(c, W, H);

    // Rain (cardiac drift warning)
    this._drawRain(c, W, H);

    // Video info bar (current trail, controls)
    this._drawVideoBar(c, W, H);

    // HUD overlay
    this._drawHUD(c, W, H);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INCLINE TILT EFFECT
  // ═══════════════════════════════════════════════════════════════════════════

  _drawInclineTilt: function(c, W, H) {
    var incline = this.runner.incline;
    if (Math.abs(incline) < 1) return;

    if (incline > 0) {
      // Uphill — darken bottom (looking up), warm gradient
      var intensity = Math.min(0.3, incline * 0.015);
      var grad = c.createLinearGradient(0, H * 0.6, 0, H);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(40,20,0,' + intensity + ')');
      c.fillStyle = grad;
      c.fillRect(0, H * 0.6, W, H * 0.4);
    } else {
      // Downhill — darken top (looking down), cool gradient
      var intensity2 = Math.min(0.25, Math.abs(incline) * 0.015);
      var grad2 = c.createLinearGradient(0, 0, 0, H * 0.4);
      grad2.addColorStop(0, 'rgba(0,10,30,' + intensity2 + ')');
      grad2.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = grad2;
      c.fillRect(0, 0, W, H * 0.4);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SPEED LINES — peripheral motion blur effect at high speed
  // ═══════════════════════════════════════════════════════════════════════════

  _speedLines: [],

  _drawSpeedLines: function(c, W, H) {
    var speed = this.runner.speedKmh;
    if (speed < 8) {
      this._speedLines = [];
      return;
    }

    var intensity = Math.min(1, (speed - 8) / 12); // 0 at 8kph, 1 at 20kph
    var maxLines = Math.round(5 + intensity * 20);
    var now = Date.now();

    // Spawn new lines at edges
    while (this._speedLines.length < maxLines) {
      var side = Math.random() > 0.5 ? 1 : 0; // 0=left, 1=right
      this._speedLines.push({
        x: side ? W - Math.random() * W * 0.15 : Math.random() * W * 0.15,
        y: Math.random() * H,
        len: 30 + Math.random() * 60 * intensity,
        alpha: 0.1 + Math.random() * 0.15 * intensity,
        speed: 3 + Math.random() * 5,
        born: now,
      });
    }

    c.strokeStyle = '#ffffff';
    c.lineWidth = 1;

    for (var i = this._speedLines.length - 1; i >= 0; i--) {
      var l = this._speedLines[i];
      var age = (now - l.born) / 1000;

      // Fade out over 1.5s
      var fade = Math.max(0, 1 - age / 1.5);
      if (fade <= 0) {
        this._speedLines.splice(i, 1);
        continue;
      }

      c.globalAlpha = l.alpha * fade;
      c.beginPath();
      c.moveTo(l.x, l.y);
      c.lineTo(l.x, l.y + l.len);
      c.stroke();

      // Move downward (simulating forward motion)
      l.y += l.speed;
      if (l.y > H) l.y = -l.len;
    }
    c.globalAlpha = 1.0;
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DUST PARTICLES — kicked up at runner's feet
  // ═══════════════════════════════════════════════════════════════════════════

  _drawDust: function(c, W, H) {
    var speed = this.runner.speedKmh;
    if (speed < 3) {
      this._dust = [];
      return;
    }

    var now = Date.now();
    var spawnRate = Math.max(40, 180 - speed * 8);
    if (now - this._lastDustSpawn > spawnRate) {
      this._lastDustSpawn = now;
      this._dust.push({
        x: W * 0.3 + Math.random() * W * 0.4,
        y: H * 0.92 + Math.random() * H * 0.05,
        vx: (Math.random() - 0.5) * 3,
        vy: -1 - Math.random() * 2,
        life: 1.0,
        size: 2 + Math.random() * 3,
      });
    }

    for (var i = this._dust.length - 1; i >= 0; i--) {
      var p = this._dust[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04;
      p.life -= 0.02;

      if (p.life <= 0) {
        this._dust.splice(i, 1);
        continue;
      }

      c.globalAlpha = p.life * 0.35;
      c.fillStyle = '#ccbb99';
      c.beginPath();
      c.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1.0;

    while (this._dust.length > 50) this._dust.shift();
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RAIN — cardiac drift hydration warning (same as TrackView)
  // ═══════════════════════════════════════════════════════════════════════════

  _rain: [],

  _drawRain: function(c, W, H) {
    var drift = this.runner.driftPct || 0;
    if (drift < 5) {
      this._rain = [];
      return;
    }

    var intensity = Math.min(1, (drift - 5) / 5);
    var maxDrops = Math.round(30 + intensity * 70);

    while (this._rain.length < maxDrops) {
      this._rain.push({
        x: Math.random() * W,
        y: Math.random() * H * 0.3,
        speed: 4 + Math.random() * 6,
        len: 8 + Math.random() * 12,
        wind: -1 + Math.random() * 0.5,
        alpha: 0.15 + Math.random() * 0.2,
      });
    }

    c.strokeStyle = '#88bbdd';
    c.lineWidth = 1;

    for (var i = this._rain.length - 1; i >= 0; i--) {
      var d = this._rain[i];
      d.y += d.speed;
      d.x += d.wind;

      if (d.y > H || d.x < -10) {
        d.y = -d.len;
        d.x = Math.random() * (W + 20);
        continue;
      }

      c.globalAlpha = d.alpha;
      c.beginPath();
      c.moveTo(d.x, d.y);
      c.lineTo(d.x + d.wind * 2, d.y + d.len);
      c.stroke();
    }
    c.globalAlpha = 1.0;

    // Blue-grey overlay in heavy rain
    if (intensity > 0.3) {
      c.globalAlpha = intensity * 0.08;
      c.fillStyle = '#445566';
      c.fillRect(0, 0, W, H * 0.5);
      c.globalAlpha = 1.0;
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // VIDEO INFO BAR — trail name, prev/next, import button
  // ═══════════════════════════════════════════════════════════════════════════

  _drawVideoBar: function(c, W, H) {
    if (this._library.length === 0) return;

    var barH = 32;
    var barY = 4;
    var entry = this._library[this._currentIdx];

    // Semi-transparent pill background
    var name = entry ? entry.name : '';
    c.font = 'bold 12px "Rajdhani", sans-serif';
    var tw = c.measureText(name).width;
    var pillW = tw + 60; // space for arrows
    var pillX = (W - pillW) / 2;

    c.fillStyle = 'rgba(0,0,0,0.4)';
    c.beginPath();
    this._roundRect(c, pillX, barY, pillW, barH, 6);
    c.fill();

    // Trail name
    c.fillStyle = '#aaccee';
    c.textAlign = 'center';
    c.fillText(name, W / 2, barY + 21);

    // Prev/Next arrows (if multiple videos)
    if (this._library.length > 1) {
      c.font = 'bold 16px sans-serif';
      c.fillStyle = '#668899';
      c.textAlign = 'center';
      c.fillText('\u25C0', pillX + 14, barY + 22);  // ◀
      c.fillText('\u25B6', pillX + pillW - 14, barY + 22);  // ▶
    }

    // Playback rate indicator
    if (this.video && !this.video.paused) {
      var rateStr = this.video.playbackRate.toFixed(1) + 'x';
      c.font = '10px "JetBrains Mono", monospace';
      c.fillStyle = '#668899';
      c.textAlign = 'right';
      c.fillText(rateStr, W - 10, barY + 20);
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HUD OVERLAY — mirrors TrackView's HUD layout
  // ═══════════════════════════════════════════════════════════════════════════

  _drawHUD: function(c, W, H) {
    var pad = 15;

    // Semi-transparent HUD background strip
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, H - 55, W, 55);

    // Speed (bottom left)
    c.font = 'bold 28px "Orbitron", sans-serif';
    c.fillStyle = '#00ffcc';
    c.textAlign = 'left';
    c.fillText(this.runner.speedKmh.toFixed(1), pad, H - pad - 16);
    c.font = '11px "Rajdhani", sans-serif';
    c.fillStyle = '#6688aa';
    c.fillText('km/h', pad, H - pad - 2);

    // Incline (bottom center-left)
    var incStr = (this.runner.incline >= 0 ? '+' : '') + this.runner.incline.toFixed(1) + '%';
    c.font = 'bold 22px "Orbitron", sans-serif';
    c.fillStyle = this.runner.incline > 5 ? '#ff8844' : this.runner.incline < -2 ? '#4488ff' : '#88aa88';
    c.textAlign = 'center';
    c.fillText(incStr, W * 0.25, H - pad - 16);
    c.font = '11px "Rajdhani", sans-serif';
    c.fillStyle = '#6688aa';
    c.fillText('GRADE', W * 0.25, H - pad - 2);

    // Power (bottom center)
    var power = this.runner.power || 0;
    if (power > 0) {
      c.font = 'bold 22px "Orbitron", sans-serif';
      c.fillStyle = power > 300 ? '#ff6644' : power > 200 ? '#ffaa00' : '#00ddff';
      c.textAlign = 'center';
      c.fillText(power.toString(), W * 0.5, H - pad - 16);
      c.font = '11px "Rajdhani", sans-serif';
      c.fillStyle = '#6688aa';
      c.fillText('WATTS', W * 0.5, H - pad - 2);
    }

    // Elapsed time (bottom center-right)
    var elapsed = this.runner.elapsed || 0;
    if (elapsed > 0) {
      var eh = Math.floor(elapsed / 3600);
      var em = Math.floor((elapsed % 3600) / 60);
      var es = Math.floor(elapsed % 60);
      var pad2 = function(n) { return n < 10 ? '0' + n : '' + n; };
      var timeStr = eh > 0
        ? eh + ':' + pad2(em) + ':' + pad2(es)
        : pad2(em) + ':' + pad2(es);
      c.font = 'bold 20px "Orbitron", sans-serif';
      c.fillStyle = '#aaccee';
      c.textAlign = 'center';
      c.fillText(timeStr, W * 0.75, H - pad - 16);
      c.font = '11px "Rajdhani", sans-serif';
      c.fillStyle = '#6688aa';
      c.fillText('TIME', W * 0.75, H - pad - 2);
    }

    // HR (bottom right)
    if (this.runner.hr > 0) {
      c.font = 'bold 24px "Orbitron", sans-serif';
      c.fillStyle = '#ff4466';
      c.textAlign = 'right';
      c.fillText(this.runner.hr.toString(), W - pad, H - pad - 16);
      c.font = '11px "Rajdhani", sans-serif';
      c.fillStyle = '#6688aa';
      c.fillText('BPM', W - pad, H - pad - 2);
    }

    // Distance (top right)
    c.font = 'bold 16px "Orbitron", sans-serif';
    c.fillStyle = '#aaccee';
    c.textAlign = 'right';
    c.fillText(this.runner.distKm.toFixed(2) + ' km', W - pad, pad + 46);

    // Drift / EF (below distance)
    var drift = this.runner.driftPct || 0;
    var ef = this.runner.ef || 0;
    if (drift > 0 || ef > 0) {
      var topY = pad + 62;
      c.font = '11px "JetBrains Mono", monospace';
      c.textAlign = 'right';
      if (ef > 0) {
        c.fillStyle = ef >= 1.8 ? '#69f0ae' : ef >= 1.5 ? '#3ecfff' : ef >= 1.2 ? '#ffb74d' : '#ff5f5f';
        c.fillText('EF ' + ef.toFixed(2), W - pad, topY);
        topY += 14;
      }
      if (drift > 0) {
        c.fillStyle = drift < 3 ? '#69f0ae' : drift < 5 ? '#3ecfff' : drift < 8 ? '#ffb74d' : '#ff5f5f';
        c.fillText('DRIFT ' + drift.toFixed(1) + '%', W - pad, topY);
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TOUCH CONTROLS — tap left/right edges to switch videos, center to import
  // ═══════════════════════════════════════════════════════════════════════════

  handleTap: function(x, y) {
    if (!this._container) return;
    var rect = this._container.getBoundingClientRect();
    var relX = x - rect.left;
    var relY = y - rect.top;
    var W = rect.width;
    var H = rect.height;

    // Top strip (video bar area) — tap left/right thirds for prev/next
    if (relY < 50) {
      if (relX < W * 0.33) {
        this.prevVideo();
      } else if (relX > W * 0.67) {
        this.nextVideo();
      } else {
        // Center tap on bar — open import
        this.importVideo();
      }
      return true;
    }

    return false; // not handled — let other handlers process
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Rounded rectangle (Chrome 83 polyfill) */
  _roundRect: function(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
    c.closePath();
  },
};
