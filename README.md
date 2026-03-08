# 🏔️ TrailRunner

A real-time treadmill trail running simulator with Garmin/Strava integration, ghost racing, real map tiles, ultra training programmes, and live HR zone control.

Built as a single-file HTML/CSS/JS app (no build step, no dependencies to install) — designed to run on a tablet mounted on a treadmill.

---

## ✨ Features

### 🗺️ Live Map (Leaflet.js)
- Real tile layers: **Topo** (ESRI World Topo), **Satellite** (ESRI Imagery), **Dark** (CartoDB)
- Actual GPS coordinates — currently routing the **Cotswold Way: Broadway → Chipping Campden**
- Live runner dot, ghost dot, and friend dots animated along the real route
- Completed route draws as a solid line; remaining route shown as dashed
- Live lat/lng and altitude display

### ❤️ HR Zone Control
- **Manual mode** — free control of speed and incline
- **HR→Incline mode** — lock your speed, incline auto-adjusts to keep HR in your target zone (ideal for Zone 2 ultra base training)
- **HR→Speed mode** — lock incline, speed auto-adjusts (good for tempo/threshold work)
- Set max HR, pick target zone (Z1–Z5), with live bpm range display

### 📊 Metrics (all clickable to cycle units)
| Metric | Units |
|--------|-------|
| Speed  | km/h → mph → min/km → min/mi |
| Distance | km → miles |
| Elevation | m → ft |
| HR, Cadence, Calories | fixed |

### 📋 Programme Library (14 built-in + custom)
Ultra training programmes based on how elite runners train:

| Programme | Type | Description |
|-----------|------|-------------|
| Zone 2 Easy Base | Z2 Aerobic | 80% aerobic base, HR→Incline locked |
| MAF Training | Aerobic Base | Maffetone Method sub-MAF effort |
| Ultra Tempo Run | Lactate | Sustained Z3–4 lactate threshold |
| Hilly Trail Simulation | Elevation | Rolling incline, power hiking stages |
| VO₂max Intervals | VO₂max | 6×3min at 90%+ effort |
| Hill Repeats | Strength | 8×60s steep repeats, walk-down recovery |
| Back-to-Back Long Runs | Endurance | Day 2 fatigued legs, Z2 HR→Incline |
| Pyramid Intervals | Speed | Z2→Z3→Z4→Z5→Z4→Z3→Z2 |
| Backyard Ultra Loop | Backyard | 6.7km loop simulation, run/walk mix |
| Race Simulation | Race | Conservative→build→race pace→surge |
| Constant Incline | Strength | Fixed 6% throughout |
| Active Recovery | Recovery | Very easy Z1, HR→Speed locked |
| Ultra Fartlek | Mixed | Unstructured effort changes |

**Programme Builder** — create and edit custom programmes with drag-reorder, per-stage speed/incline/zone targets.

### 🟠 Strava Integration *(simulated — see deployment notes)*
- Activity history browser
- Use any past run on the same route as a Ghost pacer
- Stats tab with YTD totals
- Upload completed runs

### 👻 Ghost Racing
- 4 built-in ghost types: Best Ever (gold), Room to Grow (red), Best This Year (green), Character Builder (orange)
- Live delta banner (ahead/behind)
- Strava ghosts: race any previous Strava run on the route

### 🏃 Run Together
- Live friend tracking (simulated GPS/remote treadmill runners)
- Per-friend HR, speed, distance, delta

### 📈 Garmin Insights Panel
Body Battery, VO₂ Max, HRV, Training Status, Stress, Ground Contact, Vertical Oscillation, Stride Length, Training Load, Recovery Time, Training Readiness, Intensity Minutes

### 📊 Splits + Finish Screen
- Live km splits panel with pace trend indicators
- Toast notification at each km
- Full finish screen with time/dist/pace/HR/cal/elevation
- PR detection
- Strava upload + Garmin save buttons

---

## 🚀 Running

Just open `index.html` in any modern browser. No server needed.

```bash
open index.html
# or
python3 -m http.server 8000  # then visit http://localhost:8000
```

Requires internet for map tiles (Leaflet CDN + ESRI/CartoDB tile servers).

---

## 🔌 Nordic Treadmill Deployment

When deploying to a physical Nordic/iFIT treadmill, the following **simulated** components need replacing with real hardware integrations:

### Speed & Incline (currently simulated → JS variables)
Replace with **Web Bluetooth** or **serial port** commands to the treadmill motor controller:
```javascript
// Example Web Bluetooth (iFIT protocol):
async function setTreadmillSpeed(kmh) {
  await treadmillCharacteristic.writeValue(encodeSpeedCommand(kmh));
}
async function setTreadmillIncline(pct) {
  await inclineCharacteristic.writeValue(encodeInclineCommand(pct));
}
```

### Heart Rate (currently simulated → physics model)
Replace with **ANT+ chest strap** or **Bluetooth HR monitor**:
```javascript
// Web Bluetooth HR monitor (standard GATT profile):
const hrService = await device.gatt.getPrimaryService('heart_rate');
const hrChar = await hrService.getCharacteristic('heart_rate_measurement');
hrChar.addEventListener('characteristicvaluechanged', (e) => {
  S.hr = e.target.value.getUint8(1);
});
await hrChar.startNotifications();
```

### Strava OAuth (currently simulated → fake token flow)
Needs a thin backend (Netlify/Vercel function) for the OAuth token exchange:
```
Browser → /auth/strava → Strava OAuth → /auth/callback → token stored
```
Then real API calls to `https://www.strava.com/api/v3/athlete/activities`

### Garmin Connect
Use the [Garmin Health API](https://developer.garmin.com/health-api/overview/) or Connect IQ SDK.

### Map Tiles Offline
Pre-cache tiles using `leaflet.offline` plugin for treadmill environments without reliable wifi.

---

## 📁 File Structure

```
trailrunner/
├── index.html          # Single-file app (HTML + CSS + JS)
├── README.md
├── ROUTES.md           # How to add new routes
└── docs/
    └── treadmill-integration.md   # Hardware integration guide
```

---

## 🗺️ Adding Routes

Routes are defined as `ROUTE_LATLNGS` arrays of `[lat, lng]` coordinates in `index.html`.
See `ROUTES.md` for how to export GPX from Garmin/Strava and convert to the format used here.

---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Map | [Leaflet.js 1.9.4](https://leafletjs.com) |
| Tile layers | ESRI World Topo/Imagery, CartoDB Dark |
| Fonts | Orbitron, Rajdhani, JetBrains Mono |
| No framework | Vanilla JS, CSS custom properties |
| No build step | Single HTML file |

---

## 📝 Version History

| Version | Changes |
|---------|---------|
| v14 | Min/mi unit, Strava panel, Programme library, HR zone control, unit cycling fixes |
| v13 | Strava integration (simulated), workout setup panel, programme builder |
| v12 | Real map tiles via Leaflet, actual Cotswold Way GPS coordinates |
| v11 | Splits panel, km toasts, calories, cadence, finish overlay |
| v10 | Ghost racing, Run Together, Garmin Insights panel |

---

## 👤 Author

Built with [Claude](https://claude.ai) — Anthropic's AI assistant.
