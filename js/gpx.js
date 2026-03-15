// ════════════════════════════════════════════════════════════════════════════
// GPX Parser — parse GPX files into route data, resample for smooth tracking
// ════════════════════════════════════════════════════════════════════════════

const GPX = {

  /**
   * Parse a GPX XML string into structured route data.
   * Returns { name, waypoints[], totalDistM, totalAscent, bounds }
   */
  parse(gpxString) {
    const doc = new DOMParser().parseFromString(gpxString, 'text/xml');

    // Check for parse errors
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('Invalid GPX file: ' + err.textContent.slice(0, 100));

    // Try track points first, then route points
    let points = Array.from(doc.querySelectorAll('trkpt'));
    if (!points.length) points = Array.from(doc.querySelectorAll('rtept'));
    if (!points.length) throw new Error('No track or route points found in GPX file');

    // Extract name
    const nameEl = doc.querySelector('trk > name, rte > name, metadata > name');
    const name = nameEl ? nameEl.textContent.trim() : 'Imported Route';

    // Parse waypoints with cumulative distance and ascent
    const waypoints = [];
    let totalDist = 0, totalAscent = 0, totalDescent = 0;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

    points.forEach((pt, i) => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const eleNode = pt.querySelector('ele');
      const ele = eleNode ? parseFloat(eleNode.textContent) : 0;

      if (i > 0) {
        const prev = waypoints[i - 1];
        const segDist = this._haversine(prev.lat, prev.lon, lat, lon);
        totalDist += segDist;
        const dEle = ele - prev.ele;
        if (dEle > 0) totalAscent += dEle;
        else totalDescent += Math.abs(dEle);
      }

      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);

      waypoints.push({ lat, lon, ele, dist: totalDist });
    });

    return {
      name,
      waypoints,
      totalDistM: totalDist,
      totalDistKm: totalDist / 1000,
      totalAscent: Math.round(totalAscent),
      totalDescent: Math.round(totalDescent),
      pointCount: waypoints.length,
      bounds: { minLat, maxLat, minLon, maxLon },
    };
  },

  /**
   * Resample route to N evenly-spaced points for smooth position tracking.
   * Each point has { lat, lon, ele, dist } where dist is metres from start.
   */
  resample(parsed, n) {
    n = n || 200;
    const { waypoints, totalDistM } = parsed;
    if (waypoints.length < 2) return waypoints;

    const step = totalDistM / (n - 1);
    const result = [];

    for (let i = 0; i < n; i++) {
      const targetDist = i * step;

      // Find bracketing waypoints
      let j = 0;
      while (j < waypoints.length - 1 && waypoints[j + 1].dist <= targetDist) j++;

      if (j >= waypoints.length - 1) {
        const last = waypoints[waypoints.length - 1];
        result.push({ lat: last.lat, lon: last.lon, ele: last.ele, dist: totalDistM });
        continue;
      }

      const a = waypoints[j], b = waypoints[j + 1];
      const segLen = b.dist - a.dist;
      const t = segLen > 0 ? (targetDist - a.dist) / segLen : 0;

      result.push({
        lat: a.lat + t * (b.lat - a.lat),
        lon: a.lon + t * (b.lon - a.lon),
        ele: a.ele + t * (b.ele - a.ele),
        dist: targetDist,
      });
    }

    return result;
  },

  /**
   * Build elevation array from resampled points (just the ele values).
   */
  elevationArray(resampled) {
    return resampled.map(p => Math.round(p.ele * 10) / 10);
  },

  /**
   * Build lat/lng array for Leaflet [[lat,lon], ...].
   */
  latlngs(resampled) {
    return resampled.map(p => [p.lat, p.lon]);
  },

  /**
   * Generate GPX XML from a completed run for Strava/Garmin upload.
   */
  exportGPX(run) {
    const pts = run.trackPoints || [];
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<gpx creator="TrailRunner" version="1.1" xmlns="http://www.topografix.com/GPX/1/1"';
    xml += ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n';
    xml += '  <metadata>\n';
    xml += '    <name>' + this._esc(run.name || 'TrailRunner Run') + '</name>\n';
    xml += '    <time>' + (run.startedAt || new Date().toISOString()) + '</time>\n';
    xml += '  </metadata>\n';
    xml += '  <trk>\n';
    xml += '    <name>' + this._esc(run.name || 'TrailRunner Run') + '</name>\n';
    xml += '    <type>running</type>\n';
    xml += '    <trkseg>\n';

    pts.forEach(p => {
      // Skip points with no GPS coordinates (free runs without a route)
      if (p.lat == null || p.lon == null) return;
      xml += '      <trkpt lat="' + p.lat.toFixed(6) + '" lon="' + p.lon.toFixed(6) + '">\n';
      if (p.ele != null) xml += '        <ele>' + p.ele.toFixed(1) + '</ele>\n';
      if (p.time) xml += '        <time>' + p.time + '</time>\n';
      if (p.hr) {
        xml += '        <extensions><gpxtpx:TrackPointExtension>';
        xml += '<gpxtpx:hr>' + p.hr + '</gpxtpx:hr>';
        xml += '</gpxtpx:TrackPointExtension></extensions>\n';
      }
      xml += '      </trkpt>\n';
    });

    xml += '    </trkseg>\n  </trk>\n</gpx>';
    return xml;
  },

  /**
   * Generate TCX XML (better for Strava — includes HR, calories, laps).
   */
  exportTCX(run) {
    const pts = run.trackPoints || [];
    const ns = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<TrainingCenterDatabase xmlns="' + ns + '">\n';
    xml += '  <Activities>\n';
    xml += '    <Activity Sport="Running">\n';
    xml += '      <Id>' + (run.startedAt || new Date().toISOString()) + '</Id>\n';

    // One lap = the whole run
    xml += '      <Lap StartTime="' + (run.startedAt || new Date().toISOString()) + '">\n';
    xml += '        <TotalTimeSeconds>' + Math.round(run.elapsed || 0) + '</TotalTimeSeconds>\n';
    xml += '        <DistanceMeters>' + Math.round(run.distanceM || 0) + '</DistanceMeters>\n';
    xml += '        <Calories>' + Math.round(run.calories || 0) + '</Calories>\n';
    if (run.avgHR) {
      xml += '        <AverageHeartRateBpm><Value>' + Math.round(run.avgHR) + '</Value></AverageHeartRateBpm>\n';
    }
    xml += '        <TriggerMethod>Manual</TriggerMethod>\n';
    xml += '        <Track>\n';

    pts.forEach(p => {
      xml += '          <Trackpoint>\n';
      if (p.time) xml += '            <Time>' + p.time + '</Time>\n';
      if (p.lat != null && p.lon != null) {
        xml += '            <Position>\n';
        xml += '              <LatitudeDegrees>' + p.lat.toFixed(6) + '</LatitudeDegrees>\n';
        xml += '              <LongitudeDegrees>' + p.lon.toFixed(6) + '</LongitudeDegrees>\n';
        xml += '            </Position>\n';
      }
      if (p.ele != null) xml += '            <AltitudeMeters>' + p.ele.toFixed(1) + '</AltitudeMeters>\n';
      xml += '            <DistanceMeters>' + Math.round(p.dist || 0) + '</DistanceMeters>\n';
      if (p.hr) xml += '            <HeartRateBpm><Value>' + p.hr + '</Value></HeartRateBpm>\n';
      xml += '          </Trackpoint>\n';
    });

    xml += '        </Track>\n';
    xml += '      </Lap>\n';
    xml += '    </Activity>\n';
    xml += '  </Activities>\n';
    xml += '</TrainingCenterDatabase>';
    return xml;
  },

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Haversine distance in metres between two lat/lon points. */
  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /** Escape XML special characters. */
  _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};
