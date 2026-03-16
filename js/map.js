// ════════════════════════════════════════════════════════════════════════════
// Map — Leaflet map rendering, route polyline, runner/ghost markers
// ════════════════════════════════════════════════════════════════════════════

const MapView = {

  map: null,
  ready: false,

  // Layers
  tileLayers: {},
  currentTile: 'terrain',
  routeLine: null,
  routeDone: null,
  routeAhead: null,
  runnerMarker: null,
  ghostMarker: null,
  startMarker: null,
  finishMarker: null,

  // ════════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════════

  init(containerId) {
    if (this.map) return;

    this.map = L.map(containerId, {
      zoomControl: false,
      attributionControl: false,
      keyboard: false,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
    }).setView([52.04, -1.85], 14);

    // Tile layers
    this.tileLayers.terrain = L.tileLayer(
      'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      { maxZoom: 17 }
    );
    this.tileLayers.sat = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19 }
    );
    this.tileLayers.dark = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { maxZoom: 19 }
    );

    this.tileLayers.terrain.addTo(this.map);
    this.ready = true;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ROUTE
  // ════════════════════════════════════════════════════════════════════════════

  /** Load route onto map — draws polyline, start/finish markers, fits bounds. */
  loadRoute(latlngs) {
    this.clearRoute();
    if (!this.ready || !latlngs || latlngs.length < 2) return;

    // Full route line (ahead — cyan)
    this.routeAhead = L.polyline(latlngs, {
      color: '#3ecfff', weight: 4, opacity: 0.5,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(this.map);

    // Done portion (green, drawn over ahead)
    this.routeDone = L.polyline([latlngs[0]], {
      color: '#3ddc84', weight: 5, opacity: 0.9,
      lineCap: 'round', lineJoin: 'round',
    }).addTo(this.map);

    // Start marker
    this.startMarker = L.marker(latlngs[0], {
      icon: this._flagIcon('🟢'), interactive: false, zIndexOffset: 50,
    }).addTo(this.map);

    // Finish marker
    this.finishMarker = L.marker(latlngs[latlngs.length - 1], {
      icon: this._flagIcon('🏁'), interactive: false, zIndexOffset: 50,
    }).addTo(this.map);

    // Runner marker
    this.runnerMarker = L.circleMarker(latlngs[0], {
      radius: 8, fillColor: '#3ecfff', fillOpacity: 1,
      color: '#ffffff', weight: 2.5, zIndexOffset: 100,
    }).addTo(this.map);

    // Ghost marker (hidden initially)
    this.ghostMarker = L.circleMarker(latlngs[0], {
      radius: 6, fillColor: '#ffe066', fillOpacity: 0.8,
      color: 'rgba(255,224,102,0.6)', weight: 2, zIndexOffset: 90,
    }).addTo(this.map);
    this.ghostMarker.setStyle({ opacity: 0, fillOpacity: 0 }); // hidden

    // Fit map to route
    this.map.fitBounds(this.routeAhead.getBounds().pad(0.1));
  },

  clearRoute() {
    [this.routeAhead, this.routeDone, this.startMarker, this.finishMarker,
     this.runnerMarker, this.ghostMarker].forEach(layer => {
      if (layer && this.map) this.map.removeLayer(layer);
    });
    this.routeAhead = null;
    this.routeDone = null;
    this.startMarker = null;
    this.finishMarker = null;
    this.runnerMarker = null;
    this.ghostMarker = null;
  },

  // ════════════════════════════════════════════════════════════════════════════
  // UPDATE (called each tick)
  // ════════════════════════════════════════════════════════════════════════════

  /** Update runner position on map. */
  updateRunner(latlon) {
    if (!this.runnerMarker || !latlon) return;
    this.runnerMarker.setLatLng(latlon);

    // Update the "done" polyline
    if (this.routeDone && Engine.hasRoute()) {
      const idx = Engine.run ? Engine.run.routeIdx : 0;
      const latlngs = Engine.latlngs;
      if (latlngs && idx > 0) {
        this.routeDone.setLatLngs(latlngs.slice(0, idx + 1));
      }
    }

    // Pan map to follow runner (smoothly, with threshold to avoid unnecessary redraws)
    if (this.map) {
      var center = this.map.getCenter();
      var dx = Math.abs(center.lat - latlon[0]);
      var dy = Math.abs(center.lng - latlon[1]);
      // Only pan if runner moved more than ~15m from current center (0.00015 deg ≈ 15m)
      if (dx > 0.00015 || dy > 0.00015) {
        this.map.panTo(latlon, { animate: true, duration: 0.5, noMoveStart: true });
      }
    }
  },

  /** Update ghost position. */
  updateGhost(latlon, visible) {
    if (!this.ghostMarker) return;
    if (visible && latlon) {
      this.ghostMarker.setLatLng(latlon);
      this.ghostMarker.setStyle({ opacity: 1, fillOpacity: 0.8 });
    } else {
      this.ghostMarker.setStyle({ opacity: 0, fillOpacity: 0 });
    }
  },

  // ════════════════════════════════════════════════════════════════════════════
  // MAP CONTROLS
  // ════════════════════════════════════════════════════════════════════════════

  setStyle(style) {
    if (!this.ready || !this.tileLayers[style]) return;
    this.map.removeLayer(this.tileLayers[this.currentTile]);
    this.tileLayers[style].addTo(this.map);
    this.currentTile = style;
  },

  zoomIn() { if (this.map) this.map.zoomIn(); },
  zoomOut() { if (this.map) this.map.zoomOut(); },
  getZoom() { return this.map ? this.map.getZoom() : 14; },

  // ── Helpers ──────────────────────────────────────────────────────────────

  _flagIcon(emoji) {
    return L.divIcon({
      html: '<div style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5))">' + emoji + '</div>',
      className: '',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  },

  /** Force a map resize (call after layout changes). */
  invalidateSize() {
    if (this.map) setTimeout(() => this.map.invalidateSize(), 100);
  },
};
