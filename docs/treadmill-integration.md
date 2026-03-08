# 🔌 Treadmill Hardware Integration Guide

This document explains how to replace the simulated components in TrailRunner
with real hardware integrations for deployment on a Nordic/iFIT treadmill.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                 Tablet / Browser                     │
│  ┌────────────────────────────────────────────────┐ │
│  │            TrailRunner (index.html)            │ │
│  │                                                │ │
│  │  HR Data ←─────────────┐                      │ │
│  │  Speed/Incline ──────→ │ Hardware Layer        │ │
│  │  Strava Data ←───────  │ (replace simulated)  │ │
│  └────────────────────────┴──────────────────────┘ │
└────────────────┬────────────────────────────────────┘
                 │ Web Bluetooth / Serial
    ┌────────────▼────────────┐
    │   Treadmill Controller  │
    │   HR Monitor (ANT+/BT)  │
    │   Garmin Watch          │
    └─────────────────────────┘
```

---

## 1. Heart Rate (Priority: High)

### Current behaviour
HR is calculated from a physics model: `HR ≈ 100 + speed×5 + grade×1.8 + noise`

### Real integration: Web Bluetooth (Bluetooth HR monitors)

Standard Bluetooth HR monitors (Polar, Garmin, Wahoo, treadmill built-in) use
the standard GATT Heart Rate Service profile.

```javascript
// In index.html, replace the HR simulation in updateMetrics() with:

let hrDevice = null;

async function connectHRMonitor() {
  try {
    hrDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }]
    });
    const server = await hrDevice.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const char = await service.getCharacteristic('heart_rate_measurement');
    
    char.addEventListener('characteristicvaluechanged', (event) => {
      const value = event.target.value;
      // Byte 0 is flags, byte 1 is HR value (8-bit format)
      const flags = value.getUint8(0);
      S.hr = (flags & 0x01) ? value.getUint16(1, true) : value.getUint8(1);
    });
    
    await char.startNotifications();
    console.log('HR monitor connected:', hrDevice.name);
  } catch (error) {
    console.error('HR connection failed:', error);
  }
}
```

Add a "Connect HR Monitor" button to the UI that calls `connectHRMonitor()`.

### ANT+ (chest straps, Garmin sensors)
ANT+ requires a USB ANT+ stick and a browser extension or native app wrapper.
For a tablet deployment, **Web Bluetooth is simpler**.

---

## 2. Speed & Incline Control (Priority: High)

### Current behaviour
`S.speed` is a JS variable. Auto-control modes adjust it mathematically.

### Real integration: iFIT / Nordic Track protocol

Nordic Track/iFIT treadmills can be controlled over **Bluetooth LE** or
sometimes over a **serial port** on the internal board.

> ⚠️ **The specific BLE service UUIDs and command formats vary by model.**
> You'll need to use a BLE scanner app (e.g. nRF Connect) to discover services
> on your specific treadmill before implementing.

```javascript
// Generic structure — fill in UUIDs from your treadmill model:
const TREADMILL_SERVICE_UUID     = '0000XXXX-0000-1000-8000-00805f9b34fb';
const SPEED_CHARACTERISTIC_UUID  = '0000XXXX-0000-1000-8000-00805f9b34fb';
const INCLINE_CHARACTERISTIC_UUID= '0000XXXX-0000-1000-8000-00805f9b34fb';

let treadmillServer = null;
let speedChar = null;
let inclineChar = null;

async function connectTreadmill() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [TREADMILL_SERVICE_UUID] }],
    optionalServices: [TREADMILL_SERVICE_UUID]
  });
  treadmillServer = await device.gatt.connect();
  const service = await treadmillServer.getPrimaryService(TREADMILL_SERVICE_UUID);
  speedChar   = await service.getCharacteristic(SPEED_CHARACTERISTIC_UUID);
  inclineChar = await service.getCharacteristic(INCLINE_CHARACTERISTIC_UUID);
}

async function setTreadmillSpeed(kmh) {
  // Convert kmh to treadmill units (often in 0.01 km/h increments)
  const value = new Uint16Array([Math.round(kmh * 100)]);
  await speedChar.writeValue(value);
  S.speed = kmh; // update simulation state
}

async function setTreadmillIncline(pct) {
  // Convert % to treadmill units (often in 0.1% increments)
  const value = new Int16Array([Math.round(pct * 10)]);
  await inclineChar.writeValue(value);
  CTRL.currentIncline = pct;
}
```

**In `applyAutoCtrl()`**, replace the simulation speed/incline updates
with calls to `setTreadmillSpeed()` / `setTreadmillIncline()`.

### Reading speed/incline from treadmill (instead of setting)
Some treadmills broadcast their current speed via FTMS (Fitness Machine Service),
a standard BLE profile. Subscribe to notifications on the treadmill data characteristic.

---

## 3. Strava Integration (Priority: Medium)

### Current behaviour
Simulated OAuth flow + hardcoded activity data.

### Real integration: OAuth 2.0 (needs a backend)

Strava's OAuth requires a server for the token exchange (client secret cannot
be in browser JS). Options:

**Option A: Netlify/Vercel Edge Function (easiest)**
```
1. Create Strava app at https://www.strava.com/settings/api
2. Deploy a Netlify function that handles:
   GET  /auth/strava         → redirect to Strava OAuth
   GET  /auth/strava/callback → exchange code for token, redirect back to app
3. Store access_token in sessionStorage
4. Replace STRAVA_ACTIVITIES with real API calls:
```

```javascript
async function fetchStravaActivities(token) {
  const res = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=30',
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const activities = await res.json();
  return activities.map(a => ({
    id: 's'+a.id,
    name: a.name,
    date: new Date(a.start_date).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}),
    type: a.sport_type,
    dist: a.distance/1000,
    timeSec: a.moving_time,
    avgHR: a.average_heartrate||0,
    elev: a.total_elevation_gain,
    kudos: a.kudos_count,
    route: a.distance > 8000 && a.distance < 9000, // rough match for Cotswold Way
  }));
}
```

**Option B: Use Strava's implicit flow (token in URL hash)**
Not recommended for production — tokens expire and appear in browser history.

---

## 4. Garmin Connect (Priority: Low)

### Real integration: Garmin Health API

Register at https://developer.garmin.com/health-api/ for API credentials.

```javascript
// Upload workout via Garmin Health API (requires server-side OAuth):
async function uploadToGarminConnect(workoutData) {
  // POST to your backend, which proxies to:
  // https://apis.garmin.com/wellness-api/rest/activities
  const res = await fetch('/api/garmin/upload', {
    method: 'POST',
    body: JSON.stringify(workoutData),
    headers: { 'Content-Type': 'application/json' }
  });
  return res.ok;
}
```

---

## 5. Map Tiles Offline (Priority: Medium for poor-wifi environments)

Use the `leaflet.offline` plugin to pre-cache tiles:

```html
<script src="https://cdn.jsdelivr.net/npm/leaflet.offline@2/dist/bundle.min.js"></script>
```

```javascript
// Cache tiles for zoom levels 12–16 around the route bounding box:
const tileLayerOffline = L.tileLayer.offline(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 18, attribution: '' }
);
// Trigger download of tiles for offline use:
tileLayerOffline.saveTiles(); // stores in IndexedDB
```

---

## 6. Deployment Checklist

- [ ] Chrome/Chromium browser on tablet (required for Web Bluetooth)
- [ ] HTTPS or localhost (Web Bluetooth requires secure context)
- [ ] Bluetooth permissions granted in browser settings
- [ ] HR monitor paired via `connectHRMonitor()` before run starts
- [ ] Treadmill BLE UUIDs discovered with nRF Connect app
- [ ] Strava OAuth backend deployed (Netlify/Vercel)
- [ ] Map tiles pre-cached if wifi unreliable
- [ ] Test `applyAutoCtrl()` with real incline/speed writes before a real run

---

## 7. Suggested Deployment Stack

```
Tablet (Chrome)
  └── index.html (TrailRunner)
        ├── Web Bluetooth → Treadmill (speed/incline)
        ├── Web Bluetooth → HR Monitor
        ├── Leaflet → ESRI/CartoDB tiles (wifi) or cached (offline)
        ├── Fetch → Netlify functions (Strava OAuth proxy)
        └── Fetch → Garmin Health API (via proxy)

Netlify (serverless)
  ├── /auth/strava         (OAuth redirect)
  ├── /auth/strava/callback (token exchange)
  └── /api/garmin/upload    (Garmin proxy)
```
