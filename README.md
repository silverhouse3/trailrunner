# TrailRunner

**NordicTrack X32i trail running companion** — runs in Chromium on the treadmill itself via NordicUnchained. Brings real outdoor routes to the belt with auto-incline, HR zone training, and full treadmill control.

---

## How it works

```
NordicUnchained (installed on X32i)
  → restores full Android access
  → iFIT uthttpd WebSocket at ws://localhost:80

TrailRunner (open in Chromium on the treadmill)
  → connects to ws://localhost:80
  → reads: real speed, incline, HR, calories
  → writes: SET speed, SET incline, SET fan speed
  → BLE HR strap (optional): real heart rate via Bluetooth GATT
```

---

## Features

| Feature | How it works |
|---------|-------------|
| **Route auto-incline** | Import a GPX file → elevation profile drives real treadmill ramp angle |
| **HR zone control** | BLE HR strap → incline or speed auto-adjusts to hold target zone |
| **Live map** | Leaflet map shows your real position advancing along the route |
| **Km splits** | Real splits from real distance (speed × time) |
| **Ghost racing** | Race against your own saved runs |
| **GPX/TCX export** | Export runs for upload to Strava or Garmin Connect |
| **Emergency stop** | One-tap belt + ramp stop |
| **Offline PWA** | Service worker caches everything — works without internet |
| **Workout programmes** | Build structured workouts with per-stage speed/incline targets |

---

## Control Modes

| Mode | What it does |
|------|-------------|
| **Route** *(default)* | Auto-sets treadmill incline to match real trail gradient from GPX elevation data |
| **HR→Incline** | Speed fixed. Incline auto-adjusts to hold HR in target zone |
| **HR→Speed** | Incline fixed. Speed auto-adjusts to hold HR in zone |
| **Manual** | You control speed and incline. App tracks distance and position |

---

## Setup

1. **NordicUnchained** installed on X32i
2. Open Chromium → navigate to `https://silverhouse3.github.io/trailrunner`
3. Import a GPX route (export from Garmin Connect, Strava, or any GPS app)
4. Tap **🏃 TREADMILL** to connect to the X32i WebSocket
5. Optionally tap **❤ HR** to pair a Bluetooth HR strap
6. Tap **START RUNNING**

---

## File structure

```
index.html          HTML shell
css/app.css         Styles
js/gpx.js           GPX parsing + export (GPX/TCX)
js/storage.js       localStorage persistence (routes, runs, settings)
js/treadmill.js     WebSocket + BLE HR + BLE FTMS
js/engine.js        Run engine (state, distance, splits, HR zones, auto-control)
js/map.js           Leaflet map rendering
js/ui.js            DOM updates, panels, modals
js/app.js           Init, event binding, glue
manifest.json       PWA manifest
sw.js               Service worker (offline caching)
```

---

## WebSocket Protocol (uthttpd)

```json
// App → Treadmill
{"values":{"MPH":"6.2"},"type":"set"}
{"values":{"Incline":"8.0"},"type":"set"}
{"values":{"Fan Speed":"70"},"type":"set"}

// Treadmill → App
{"values":{"MPH":"6.2","Incline":"4.5","Heart Rate":"152"},"type":"stats"}
```

---

## Data flow

```
Treadmill WebSocket ──→ TM.onData ──→ Engine.onTreadmillData()
BLE HR Strap ──────────→ BLEHR.onHR ──→ Engine.onBLEHR()

Engine.tick() every 250ms:
  ├── distance += speed × dt
  ├── routeProgress = distance / totalDistance
  ├── grade = calcGrade(routeProgress)
  ├── TM.setIncline(grade)          ← auto-incline
  ├── checkSplits()
  ├── recordTrackPoint()            ← for GPX export
  └── UI.update() + MapView.updateRunner()
```

---

## Version History

| Version | Changes |
|---------|---------|
| v17 | Complete rewrite — real distance tracking, GPX import/export, localStorage persistence, emergency stop, ghost racing from saved runs, no fake data |
| v16 | Direct uthttpd WebSocket control (demo) |
| v15 | NordicUnchained/Android build (demo) |
