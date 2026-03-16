// ════════════════════════════════════════════════════════════════════════════
// Media — radio stations, custom streams, HTML5 Audio playback
// ════════════════════════════════════════════════════════════════════════════

const Media = {

  audio: null,
  currentStation: null,
  playing: false,

  // ── Preset stations (UK radio — HTTPS streams) ─────────────────────────
  stations: [
    { name: 'BBC Radio 1',   genre: 'Pop / Dance',     url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_one' },
    { name: 'BBC Radio 2',   genre: 'Easy Listening',   url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_radio_two' },
    { name: 'BBC Radio 6',   genre: 'Alternative',      url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_6music' },
    { name: 'Classic FM',    genre: 'Classical',         url: 'https://media-ice.musicradio.com/ClassicFMMP3' },
    { name: 'Absolute Radio',genre: 'Rock',              url: 'https://ais-edge.sharp-stream.com/absoluteradio.mp3' },
    { name: 'Capital FM',    genre: 'Pop',               url: 'https://media-ice.musicradio.com/CapitalMP3' },
    { name: 'Heart FM',      genre: 'Feel Good',         url: 'https://media-ice.musicradio.com/HeartLondonMP3' },
    { name: 'Radio X',       genre: 'Indie / Rock',      url: 'https://media-ice.musicradio.com/RadioXUKMP3' },
    { name: 'Smooth Radio',  genre: 'Easy Listening',    url: 'https://media-ice.musicradio.com/SmoothUKMP3' },
    { name: 'LBC',           genre: 'Talk / News',       url: 'https://media-ice.musicradio.com/LBCUKMP3' },
    { name: 'Kiss FM',       genre: 'Dance / RnB',       url: 'https://media-ice.musicradio.com/KissFMMP3' },
    { name: 'Magic Radio',   genre: 'Oldies / Pop',      url: 'https://media-ice.musicradio.com/MagicUKMP3' },
  ],

  // ════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════

  init() {
    this.audio = new Audio();
    this.audio.volume = 0.7;

    // Restore volume
    const settings = Store.getSettings();
    if (settings.mediaVolume != null) this.audio.volume = settings.mediaVolume;

    // Audio events
    this.audio.addEventListener('playing', () => {
      this.playing = true;
      this._updateUI();
    });
    this.audio.addEventListener('pause', () => {
      this.playing = false;
      this._updateUI();
    });
    this.audio.addEventListener('error', () => {
      console.log('[Media] Stream error — may be unavailable');
      this.playing = false;
      this._updateUI();
    });

    this.renderStations();
  },

  // ════════════════════════════════════════════════════════════════════════
  // PLAYBACK
  // ════════════════════════════════════════════════════════════════════════

  play(station) {
    if (!this.audio) this.init();
    this.currentStation = station;
    this.audio.src = station.url;
    this.audio.play().catch(err => console.warn('[Media] Play failed:', err.message));
    this.playing = true;
    this._updateUI();
  },

  playCustom(url) {
    if (!url || !url.trim()) return;
    this.play({ name: 'Custom Stream', genre: url.replace(/https?:\/\//, '').substring(0, 40), url: url.trim() });
  },

  togglePlayPause() {
    if (this.playing) {
      this.audio.pause();
    } else if (this.currentStation) {
      this.audio.play().catch(() => {});
    }
  },

  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
    }
    this.playing = false;
    this.currentStation = null;
    this._updateUI();
  },

  setVolume(v) {
    const vol = Math.max(0, Math.min(1, v));
    if (this.audio) this.audio.volume = vol;
    const settings = Store.getSettings();
    settings.mediaVolume = vol;
    Store.saveSettings(settings);
    // Update icon
    const icon = document.getElementById('mediaVolIcon');
    if (icon) icon.textContent = vol === 0 ? '🔇' : vol < 0.4 ? '🔈' : vol < 0.7 ? '🔉' : '🔊';
  },

  adjustVolume(delta) {
    var current = this.audio ? this.audio.volume : 0.7;
    this.setVolume(current + delta);
  },

  nextStation() {
    if (!this.stations.length) return;
    var idx = 0;
    if (this.currentStation) {
      idx = this.stations.findIndex(function(s) { return s.name === this.currentStation.name; }.bind(this));
      idx = (idx + 1) % this.stations.length;
    }
    this.play(this.stations[idx]);
  },

  // ════════════════════════════════════════════════════════════════════════
  // RENDERING
  // ════════════════════════════════════════════════════════════════════════

  renderStations() {
    const el = document.getElementById('mediaStations');
    if (!el) return;

    el.innerHTML = this.stations.map(s =>
      '<div class="media-station" data-url="' + s.url + '" onclick="Media.play({name:\'' +
      s.name.replace(/'/g, "\\'") + '\',genre:\'' + s.genre.replace(/'/g, "\\'") +
      '\',url:\'' + s.url + '\'})">' +
        '<div class="media-st-name">' + s.name + '</div>' +
        '<div class="media-st-genre">' + s.genre + '</div>' +
      '</div>'
    ).join('');
  },

  _updateUI() {
    const npName = document.getElementById('mediaNPName');
    const npGenre = document.getElementById('mediaNPGenre');
    const playBtn = document.getElementById('mediaPlayBtn');
    const miniNP = document.getElementById('mediaMiniNP');

    if (npName) npName.textContent = this.currentStation ? this.currentStation.name : 'Select a station';
    if (npGenre) npGenre.textContent = this.currentStation ? this.currentStation.genre : '';
    if (playBtn) playBtn.textContent = this.playing ? '⏸' : '▶';

    // Mini "now playing" on map view
    if (miniNP) {
      if (this.currentStation && this.playing) {
        miniNP.style.display = 'flex';
        miniNP.querySelector('.mini-np-name').textContent = '📻 ' + this.currentStation.name;
      } else {
        miniNP.style.display = 'none';
      }
    }

    // Highlight active station
    document.querySelectorAll('.media-station').forEach(el => {
      const isActive = this.currentStation && el.dataset.url === this.currentStation.url;
      el.classList.toggle('active', isActive && this.playing);
    });
  },
};
