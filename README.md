# TrailRunner

**Trail running on your treadmill** — a PWA that brings real outdoor GPX routes to a NordicTrack X32i with full belt and incline control, HR zone training, and Strava sync.

---

> **WARNING: USE AT YOUR OWN RISK**
>
> This software controls a motorized treadmill belt and incline ramp. Improper use can cause **serious injury or death**. By using this software you accept **full responsibility** for any harm, damage, or injury that may result. The authors accept **no liability whatsoever**. See the [full disclaimer](#disclaimer) below.

---

## How it works

```
TrailRunner PWA (GitHub Pages — HTTPS)
    ↕ HTTP + WebSocket (localhost:4510)
TrailRunner Bridge (Go binary — runs on treadmill)
    ↕ gRPC with mTLS (localhost:54321)
glassos_service (iFIT system service)
    ↕ FitPro USB HID (64-byte packets)
Motor Controller (ICON PSOC MCU)
    ↕ Belt motor + incline ramp
```

The PWA runs in a WebView APK on the treadmill's Android tablet. It communicates with a lightweight Go bridge binary that translates HTTP/WebSocket commands into gRPC calls to the treadmill's native motor control service.

**No iFIT subscription required. No cloud dependency. Everything runs locally on the treadmill.**

---

## Features

| Feature | Description |
|---------|-------------|
| **GPX route auto-incline** | Import any GPX file — elevation profile drives real treadmill ramp angle |
| **Full belt control** | Software speed/incline buttons control the actual motor |
| **Graceful transitions** | 15-second ease-out ramp-down on stop; proportional deceleration on pause; gentle 0.7 km/h/s ramp-up on resume |
| **HR zone training** | BLE HR strap → incline or speed auto-adjusts to hold target zone |
| **Live map** | Leaflet map shows your position advancing along the route |
| **Km splits** | Real splits from actual belt speed × time |
| **Strava auto-sync** | OAuth-based upload — runs sync automatically after finish |
| **Ghost racing** | Race against your own saved runs |
| **GPX/TCX export** | Export for manual upload to Strava or Garmin Connect |
| **Emergency stop** | One-tap belt + ramp stop (bypasses all rate limiting) |
| **Offline PWA** | Service worker caches everything — works without internet after first load |
| **Workout builder** | Structured workouts with per-stage speed/incline targets |
| **Cool-down mode** | Automatic speed/incline reduction to walking pace |
| **3D track view** | Zwift-style oval track visualisation |

---

## Safety Features

> **WARNING:** These software safety features are **not a substitute** for the physical safety key. **Always attach the safety key to your clothing before running.** If anything feels wrong, **pull the safety key immediately.**

| Safety Feature | What it does |
|----------------|-------------|
| **Emergency stop** | Immediately zeroes speed and incline, bypasses all rate limiting |
| **Graceful stop** | 15-second ease-out curve prevents abrupt belt halt |
| **Graceful pause** | Proportional deceleration before pausing motor |
| **Gentle resume** | 0.7 km/h/s ramp-up for 15 seconds prevents sudden acceleration |
| **NaN guard** | Rejects undefined/invalid speed/incline values before sending to bridge |
| **Rate limiting** | Speed changes limited to every 1.2s, incline every 2.5s to prevent motor controller overload |
| **Decel timer cancellation** | Emergency stop cancels any in-progress ramp-down to prevent conflicts |
| **Polling overlap protection** | Prevents duplicate state requests from overwhelming the bridge |

---

## Control Modes

| Mode | What it does |
|------|-------------|
| **Route** *(default)* | Auto-sets treadmill incline to match real trail gradient from GPX elevation data |
| **HR → Incline** | Speed fixed. Incline auto-adjusts to hold HR in target zone |
| **HR → Speed** | Incline fixed. Speed auto-adjusts to hold HR in zone |
| **Manual** | You control speed and incline. App tracks distance and position |

---

## Deployment

> **WARNING: USE AT YOUR OWN RISK.** Deploying this software involves modifying your treadmill's Android system, sideloading software, and running unsigned binaries that directly control motor hardware. This **will void your warranty** and could **damage your treadmill** or **cause injury**. Proceed only if you understand and accept these risks.

See [docs/DEPLOY_TO_X32i.md](docs/DEPLOY_TO_X32i.md) for the complete step-by-step guide covering:

1. **Unlocking the treadmill** — Privileged mode + NordicUnchained
2. **Building the bridge** — Cross-compiling the Go gRPC bridge for ARM64
3. **Deploying the bridge** — ADB push to treadmill + mTLS key extraction
4. **Installing the APK** — WebView wrapper with mixed-content support
5. **Testing** — Verifying motor control before your first run

### Quick Start (if you know what you're doing)

```bash
# 1. Connect to treadmill via ADB
adb connect <TREADMILL_IP>:5555

# 2. Push bridge binary + keys
adb push bridge/grpc-bridge/trailrunner-bridge /data/local/tmp/
adb push keys/ /sdcard/trailrunner/keys/
adb shell chmod +x /data/local/tmp/trailrunner-bridge

# 3. Install the APK
adb install tools/TrailRunner.apk

# 4. Start the bridge (or let the APK auto-start it)
adb shell /data/local/tmp/trailrunner-bridge &

# 5. Open TrailRunner on the treadmill
# The APK auto-starts the bridge and loads the PWA
```

---

## Bridge REST API

The bridge exposes these endpoints on `http://127.0.0.1:4510`:

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Bridge status, gRPC connection, workout state |
| `/state` | GET | — | Current speed, incline, HR, workout state |
| `/workout/start` | POST | — | Start a workout (spins up belt) |
| `/workout/stop` | POST | — | Stop workout (belt stops) |
| `/workout/pause` | POST | — | Pause workout |
| `/workout/resume` | POST | — | Resume from pause |
| `/speed` | POST | `{"kph": 5.0}` | Set belt speed (km/h) |
| `/incline` | POST | `{"percent": 3.0}` | Set ramp incline (%) |
| `/ws` | WebSocket | — | Real-time state streaming |

> **WARNING:** These endpoints directly control the treadmill motor. Sending inappropriate values can cause the belt to accelerate or the ramp to move unexpectedly. **Never test with anyone on or near the treadmill.**

---

## File Structure

```
index.html              HTML shell
css/app.css             Styles (dark theme, responsive)
js/gpx.js               GPX parsing + export (GPX/TCX)
js/storage.js           localStorage persistence (routes, runs, settings)
js/treadmill.js         Bridge HTTP/WS + BLE HR + BLE FTMS
js/engine.js            Run engine (state, distance, splits, HR zones, graceful transitions)
js/map.js               Leaflet map rendering
js/ui.js                DOM updates, panels, modals
js/media.js             Audio/media handling
js/sync.js              Strava OAuth + auto-sync
js/trackview.js         3D oval track view (Zwift-style)
js/workout-segments.js  Workout segment management
js/oval-track.js        Oval track geometry
js/fun-facts.js         Running fun facts during idle
js/voice.js             Voice coaching / TTS
js/streaks.js           Running streak tracking
js/workout-builder.js   Structured workout creation
js/settings-panel.js    Settings UI
js/app.js               Init, event binding, glue
sw.js                   Service worker (offline caching)
manifest.json           PWA manifest
bridge/grpc-bridge/     Go bridge source (gRPC → HTTP proxy)
twa-build/              Android APK build (Gradle + WebView)
tools/                  ADB scripts, APK, utilities
docs/                   Deployment guides, protocol docs
```

---

## Building from Source

### Bridge (Go → ARM64 binary)

```bash
cd bridge/grpc-bridge
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o trailrunner-bridge
# Produces ~15MB static binary
```

### APK (Android WebView wrapper)

```bash
cd twa-build
# Requires JDK 17 + Android SDK
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
```

### PWA (static files)

No build step — the PWA is plain HTML/CSS/JS served directly from GitHub Pages. Any changes pushed to `main` are live immediately.

---

## Compatibility

| Component | Requirement |
|-----------|-------------|
| **Treadmill** | NordicTrack X32i (Android 7.1.2, ICON FitPro protocol) |
| **Bridge** | ARM64 Linux (runs on treadmill's Android) |
| **APK** | Android 7.0+ (API 24+), WebView with mixed-content support |
| **PWA** | Any modern browser (Chrome, Firefox, Safari, Edge) |
| **HR strap** | Any BLE heart rate monitor (Polar, Garmin, Wahoo, etc.) |

> **NOTE:** This has only been tested on the NordicTrack X32i. Other NordicTrack/iFIT treadmills may use different gRPC services, USB protocols, or motor controllers. **Do not assume compatibility** with other models without thorough testing.

---

## Version History

| Version | Changes |
|---------|---------|
| v29 | Hardened treadmill control: NaN guards, polling overlap protection, emergency stop safety, cooldown rate limiter bypass |
| v28 | Complete treadmill rewrite: HTTP-first connection, numeric types (fixed string/float bug), graceful stop/pause/resume, mixed-content fix |
| v27 | Gentle startup ramp: 0.7 km/h/s for first 15 seconds |
| v26 | Touch target fixes for Android 7 WebView |
| v25 | Strava credentials moved to device-only injection |
| v17 | Complete rewrite — real distance tracking, GPX import/export, localStorage persistence, emergency stop, ghost racing |

---

## Community & References

- [NordicUnchained (XDA Forums)](https://xdaforums.com/t/nordicunchained-get-back-privileged-mode-on-nordictrack-treadmill.4390801/) — Unlock iFIT treadmills
- [QZ Companion](https://github.com/cagnulein/QZCompanionNordictrackTreadmill) — Alternative treadmill bridge
- [qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift) — Open-source treadmill/bike bridge
- [fl3xbl0w](https://github.com/barrenechea/fl3xbl0w) — Bowflex/ICON protocol reverse engineering
- [r/nordictrackandroid](https://www.reddit.com/r/nordictrackandroid/) — Community forum

---

## Disclaimer

> **IMPORTANT — READ BEFORE USING THIS SOFTWARE**
>
> **USE ENTIRELY AT YOUR OWN RISK.** This software is provided "as is", without warranty of any kind, express or implied.
>
> **THIS SOFTWARE CONTROLS MOTORIZED EQUIPMENT.** A treadmill belt can reach speeds exceeding 20 km/h and the incline ramp can move to extreme angles. Software bugs, network latency, power failures, or unexpected behaviour can cause the belt to accelerate, decelerate, or stop without warning.
>
> **SAFETY REQUIREMENTS:**
> - **ALWAYS attach the physical safety key** (emergency stop lanyard) to your clothing before stepping on the belt
> - **NEVER rely solely on software controls** for your safety
> - **NEVER stand on the belt** while testing or deploying this software
> - **NEVER leave the treadmill unattended** while this software is running
> - **ALWAYS test motor control commands** with no one on or near the treadmill first
> - **KEEP the area around the treadmill clear** at all times
>
> **WARRANTY:** Using this software **will void your treadmill warranty**. It involves unlocking the Android system, sideloading unsigned software, and sending commands directly to the motor controller outside of the manufacturer's intended software stack.
>
> **LIABILITY:** The authors, contributors, and maintainers of this project accept **no responsibility or liability** for:
> - Personal injury or death
> - Damage to your treadmill or other property
> - Voided warranties
> - Electrical damage, motor controller failure, or fire
> - Data loss or privacy breaches
> - Any other direct, indirect, incidental, or consequential damages
>
> **By using this software, you acknowledge that you have read and understood these warnings, that you accept all risks, and that you will not hold the authors liable for any outcome.**
>
> If you do not agree with these terms, **do not use this software.**

---

## License

MIT License — see [LICENSE](LICENSE) for details.

**The MIT license does not override the disclaimer above.** You use this software entirely at your own risk.
