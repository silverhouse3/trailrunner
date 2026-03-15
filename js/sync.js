// ════════════════════════════════════════════════════════════════════════════
// Sync — Auto-upload runs to Strava (and Garmin via Strava→Garmin link)
//
// One-time setup:
//   1. Go to strava.com/settings/api → Create Application
//   2. Set callback domain to: silverhouse3.github.io
//   3. Enter Client ID + Secret in TrailRunner Settings → Connect Strava
//   4. Authenticate once — tokens auto-refresh forever
//
// After that, every finished run auto-uploads. Soph never has to think about it.
// ════════════════════════════════════════════════════════════════════════════

const Sync = {

  // ── State ────────────────────────────────────────────────────────────────

  get strava() {
    try {
      return JSON.parse(localStorage.getItem('tr_strava') || 'null');
    } catch { return null; }
  },

  set strava(val) {
    if (val) localStorage.setItem('tr_strava', JSON.stringify(val));
    else localStorage.removeItem('tr_strava');
  },

  get stravaApp() {
    try {
      return JSON.parse(localStorage.getItem('tr_strava_app') || 'null');
    } catch { return null; }
  },

  set stravaApp(val) {
    if (val) localStorage.setItem('tr_strava_app', JSON.stringify(val));
    else localStorage.removeItem('tr_strava_app');
  },

  // Queue for runs that failed to upload (retry on next run)
  get _queue() {
    try {
      return JSON.parse(localStorage.getItem('tr_sync_queue') || '[]');
    } catch { return []; }
  },

  set _queue(val) {
    localStorage.setItem('tr_sync_queue', JSON.stringify(val || []));
  },

  // ── Strava OAuth ────────────────────────────────────────────────────────

  STRAVA_AUTH_URL: 'https://www.strava.com/oauth/authorize',
  STRAVA_TOKEN_URL: 'https://www.strava.com/oauth/token',
  STRAVA_UPLOAD_URL: 'https://www.strava.com/api/v3/uploads',
  STRAVA_ATHLETE_URL: 'https://www.strava.com/api/v3/athlete',
  REDIRECT_URI: 'https://silverhouse3.github.io/trailrunner/strava-callback.html',

  isStravaConnected() {
    const s = this.strava;
    return !!(s && s.access_token);
  },

  connectStrava() {
    const app = this.stravaApp;
    if (!app || !app.clientId) {
      alert('Enter your Strava Client ID in Settings first');
      return;
    }

    const url = this.STRAVA_AUTH_URL +
      '?client_id=' + app.clientId +
      '&response_type=code' +
      '&redirect_uri=' + encodeURIComponent(this.REDIRECT_URI) +
      '&approval_prompt=auto' +
      '&scope=activity:write,activity:read_all';

    // Open in popup or redirect
    window.location.href = url;
  },

  async handleCallback(code) {
    const app = this.stravaApp;
    if (!app || !app.clientId || !app.clientSecret) {
      console.error('[Sync] No Strava app credentials');
      return false;
    }

    try {
      const resp = await fetch(this.STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code: code,
          grant_type: 'authorization_code',
        }),
      });

      if (!resp.ok) {
        console.error('[Sync] Token exchange failed:', resp.status);
        return false;
      }

      const data = await resp.json();
      this.strava = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        athlete: data.athlete ? {
          id: data.athlete.id,
          firstname: data.athlete.firstname,
          lastname: data.athlete.lastname,
        } : null,
      };

      console.log('[Sync] Strava connected:', data.athlete?.firstname);
      return true;
    } catch (err) {
      console.error('[Sync] Token exchange error:', err);
      return false;
    }
  },

  async _refreshToken() {
    const s = this.strava;
    const app = this.stravaApp;
    if (!s || !s.refresh_token || !app) return false;

    // Check if token is still valid (with 5-min buffer)
    if (s.expires_at && (s.expires_at - 300) > (Date.now() / 1000)) {
      return true; // Still valid
    }

    try {
      const resp = await fetch(this.STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          refresh_token: s.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      if (!resp.ok) {
        console.error('[Sync] Token refresh failed:', resp.status);
        return false;
      }

      const data = await resp.json();
      this.strava = {
        ...s,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
      };

      console.log('[Sync] Token refreshed, expires:', new Date(data.expires_at * 1000).toLocaleString());
      return true;
    } catch (err) {
      console.error('[Sync] Token refresh error:', err);
      return false;
    }
  },

  disconnectStrava() {
    this.strava = null;
    console.log('[Sync] Strava disconnected');
  },

  // ── Upload ──────────────────────────────────────────────────────────────

  async uploadRun(run) {
    if (!this.isStravaConnected()) {
      console.log('[Sync] Not connected to Strava, queueing run');
      this._queueRun(run);
      return false;
    }

    const refreshed = await this._refreshToken();
    if (!refreshed) {
      console.error('[Sync] Could not refresh token, queueing run');
      this._queueRun(run);
      return false;
    }

    return this._doUpload(run);
  },

  /** Internal upload — does NOT queue on failure (used by _processQueue to avoid loops) */
  async _doUpload(run) {
    try {
      // Generate TCX (Strava prefers TCX for treadmill activities with HR data)
      const tcx = GPX.exportTCX({
        name: run.routeName || 'TrailRunner',
        startedAt: run.startedAt,
        elapsed: run.elapsed,
        distanceM: run.distanceM,
        calories: run.calories,
        avgHR: run.avgHR,
        trackPoints: run.trackPoints,
      });

      const blob = new Blob([tcx], { type: 'application/xml' });
      const formData = new FormData();
      formData.append('file', blob, 'trailrunner-' + run.id + '.tcx');
      formData.append('data_type', 'tcx');
      formData.append('name', (run.routeName || 'Treadmill Run') + ' — TrailRunner');
      formData.append('description', 'Auto-synced from TrailRunner on NordicTrack X32i');
      formData.append('trainer', '1'); // Mark as indoor/treadmill
      formData.append('activity_type', 'run');

      const s = this.strava;
      const resp = await fetch(this.STRAVA_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + s.access_token },
        body: formData,
      });

      if (resp.ok) {
        const result = await resp.json();
        console.log('[Sync] Uploaded to Strava, upload ID:', result.id);

        // Mark run as synced
        this._markSynced(run.id, 'strava', result.id);
        return true;
      } else {
        const err = await resp.text();
        console.error('[Sync] Upload failed:', resp.status, err);
        if (resp.status !== 409) { // 409 = duplicate, don't retry
          this._queueRun(run);
        }
        return false;
      }
    } catch (err) {
      console.error('[Sync] Upload error:', err);
      this._queueRun(run);
      return false;
    }
  },

  // ── Auto-sync (called after every run save) ─────────────────────────────

  async autoSync(run) {
    if (!this.isStravaConnected()) return;

    console.log('[Sync] Auto-syncing run:', run.id);

    // Upload current run
    const ok = await this.uploadRun(run);

    // Retry queued runs
    await this._processQueue();

    return ok;
  },

  // ── Queue management ────────────────────────────────────────────────────

  _queueRun(run) {
    const queue = this._queue;
    // Don't double-queue
    if (queue.find(q => q.id === run.id)) return;
    queue.push({
      id: run.id,
      routeName: run.routeName,
      startedAt: run.startedAt,
      elapsed: run.elapsed,
      distanceM: run.distanceM,
      calories: run.calories,
      avgHR: run.avgHR,
      trackPoints: run.trackPoints,
      queuedAt: new Date().toISOString(),
    });
    // Cap queue at 20
    while (queue.length > 20) queue.shift();
    this._queue = queue;
    console.log('[Sync] Run queued, queue size:', queue.length);
  },

  _processingQueue: false,
  async _processQueue() {
    // Guard against re-entrancy (uploadRun → _queueRun → _processQueue loop)
    if (this._processingQueue) return;
    const queue = this._queue;
    if (!queue.length) return;

    this._processingQueue = true;
    console.log('[Sync] Processing queue:', queue.length, 'runs');
    const remaining = [];

    for (const run of queue) {
      // Call _doUpload directly (not uploadRun, which re-queues on failure)
      const ok = await this._doUpload(run);
      if (!ok) remaining.push(run);
      // Small delay between uploads
      await new Promise(r => setTimeout(r, 1000));
    }

    this._queue = remaining;
    this._processingQueue = false;
    if (remaining.length) {
      console.log('[Sync] Queue still has', remaining.length, 'runs pending');
    } else {
      console.log('[Sync] Queue cleared');
    }
  },

  _markSynced(runId, service, uploadId) {
    try {
      const runs = Store.getRuns();
      const run = runs.find(r => r.id === runId);
      if (run) {
        run.synced = run.synced || {};
        run.synced[service] = { uploadId, syncedAt: new Date().toISOString() };
        Store._set('runs', runs);
      }
    } catch {}

    // Remove from queue if present
    this._queue = this._queue.filter(q => q.id !== runId);
  },

  // ── Status helpers ──────────────────────────────────────────────────────

  getStatus() {
    const s = this.strava;
    const queue = this._queue;
    return {
      strava: {
        connected: this.isStravaConnected(),
        athlete: s?.athlete || null,
        tokenExpiry: s?.expires_at ? new Date(s.expires_at * 1000) : null,
      },
      queuedRuns: queue.length,
    };
  },

  // ── Webhook notification ──────────────────────────────────────────────

  get webhookUrl() {
    try {
      return localStorage.getItem('tr_webhook_url') || '';
    } catch { return ''; }
  },

  set webhookUrl(val) {
    if (val) localStorage.setItem('tr_webhook_url', val);
    else localStorage.removeItem('tr_webhook_url');
  },

  /**
   * POST run summary to a configured webhook URL.
   * Works with Home Assistant webhooks, IFTTT, Zapier, or any HTTP endpoint.
   * Format: HA-compatible JSON payload with run stats.
   */
  async notifyWebhook(run) {
    var url = this.webhookUrl;
    if (!url) return;

    var payload = {
      event: 'workout_complete',
      device: 'TrailRunner X32i',
      timestamp: new Date().toISOString(),
      route: run.routeName || 'Free Run',
      distance_km: run.distanceKm || +(run.distanceM / 1000).toFixed(2),
      elapsed_sec: run.elapsed || 0,
      elapsed_str: this._fmtTime(run.elapsed || 0),
      avg_speed_kph: run.avgSpeed || 0,
      max_speed_kph: run.maxSpeed || 0,
      avg_hr: run.avgHR || 0,
      max_hr: run.maxHR || 0,
      calories: run.calories || 0,
      elevation_gain_m: run.elevGained || run.elevGain || 0,
      splits_count: run.splits ? run.splits.length : 0,
    };

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'no-cors', // HA webhook may not send CORS headers
      });
      console.log('[Sync] Webhook notified:', url);
    } catch (err) {
      console.warn('[Sync] Webhook failed:', err.message);
    }
  },

  _fmtTime(s) {
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = Math.floor(s % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  },

  /**
   * POST run summary to bridge MQTT endpoint (if bridge is reachable).
   * This publishes to trailrunner/workout/summary on the MQTT broker.
   */
  async notifyBridge(run) {
    try {
      await fetch('http://127.0.0.1:4510/api/workout/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          route: run.routeName || 'Free Run',
          distance_km: run.distanceKm || +(run.distanceM / 1000).toFixed(2),
          elapsed_sec: run.elapsed || 0,
          avg_speed_kph: run.avgSpeed || 0,
          avg_hr: run.avgHR || 0,
          calories: run.calories || 0,
          elevation_gain_m: run.elevGained || run.elevGain || 0,
        }),
      });
    } catch {
      // Bridge not reachable — that's fine
    }
  },
};
