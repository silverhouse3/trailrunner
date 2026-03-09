# TrailRunner

**NordicTrack X32i trail running companion** — runs in Chromium on the treadmill itself via NordicUnchained. Brings real outdoor routes to the belt: map, elevation, ghost racing, HR zone training, auto-incline, and full treadmill control.

🏔️ **v16: Direct treadmill control.** Connects to the X32i's built-in WebSocket server (uthttpd) and both reads real data *and* commands the belt speed and ramp angle — no QZ Companion needed.

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

## Control Modes

| Mode | What it does |
|------|-------------|
| **🏔 Route** *(default)* | Calculates real trail gradient from elevation data. Automatically commands ramp to match terrain as you progress. Uphill on the Cotswold Way = ramp tilts in real time. |
| **HR→Incline** | Speed fixed. Incline auto-adjusts to hold HR in target zone. Ideal for Z2 aerobic base. |
| **HR→Speed** | Incline fixed. Speed auto-adjusts to hold HR in zone. Good for tempo. |
| **Manual** | Reads real data and maps position. You control speed/incline physically. |

---

## Setup (3 steps)

1. **NordicUnchained** installed on X32i
2. Open `https://silverhouse3.github.io/trailrunner` in Chromium on the treadmill  
3. Tap **🏃 TREADMILL** → connects to `ws://localhost:80`, belt + ramp are now under app control

Optionally tap **❤ HR** to pair a Bluetooth HR monitor.

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

If `ws://localhost:80` is unavailable (running on phone/PC), falls back to QZ Companion FTMS BLE for read-only data.

---

## Features

- Real GPS map with live runner, ghost, and friend markers
- Auto-incline: trail gradient commands treadmill ramp in real time
- HR zone auto-control: incline or speed adjusts to hold target zone
- 14 built-in programmes + custom builder, with real treadmill commands per stage
- Ghost racing against past Strava activities
- Garmin Insights panel (training load, V̇O₂, aerobic efficiency)
- Km splits with toast notifications
- Fan auto-control based on HR zone
- Wake Lock — screen stays on during runs
- Full unit cycling: km/h, mph, min/km, min/mi

---

## Version History

| Version | Key changes |
|---------|-------------|
| v16 | Direct uthttpd WebSocket control — belt + ramp commanded from app. Route auto-incline. Fan auto-control. QZ BLE fallback. |
| v15 | NordicUnchained/Android build: scaling, wake lock, Web BT HR + FTMS |
| v14 | Speed unit fixes (4 modes), Strava upload fixes, avg HR bug fix |
| v13 | Leaflet map, ghost racing, programmes, splits, Garmin panel |
