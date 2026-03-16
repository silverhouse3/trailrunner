# Treadmill Probe Session — 2026-03-13

## Summary
Spent several hours probing the NordicTrack X32i treadmill via ADB. Major
discoveries that change the project direction significantly.

## Key Discovery: Compose UI Blocks ALL Input Injection

The workout screen (rivendell InWorkoutActivity) uses **Jetpack Compose**.
This means `input tap`, `input swipe`, `sendevent`, and mouse events are ALL
silently ignored. This was tested exhaustively:

- `input tap` on speed circle, incline circle, Workout button — no response
- `input swipe` (various coordinates and durations) — no response
- `input mouse tap` — no response
- `sendevent` raw kernel touch events (pixcirTouchScreen) — no response
- `KEYCODE_DPAD_UP` — no response

**This breaks the previous "swipe bridge" approach entirely.**
The bridge code's `input swipe` method is useless for the workout screen.

## What DOES Work

### Telemetry Reading (Excellent)
Valinor log parsing works perfectly. Two formats available:
1. **Real-time events**: `SDS Changed KPH from X to Y` (immediate)
2. **Periodic summary**: `SDS Console Basic Info` every ~60s with full telemetry
   (speed, incline, HR, distance, time, calories, state, fan, etc.)

### Workout Navigation (Works)
Successfully automated the entire iFIT navigation flow via `input tap`:
- Login screen → "Go to manual workout" → iFIT Pro upsell → Disclaimer → Workout
- All button coordinates documented and verified

### QZ Companion (Installed, Not Functional)
- Installed v3.6.29, enabled accessibility service, granted all permissions
- Parse loop starts but goes dormant after first iteration
- Not broadcasting UDP telemetry, not listening for commands
- Root cause: likely device model detection or parse() returning empty data

## The Path Forward

### Must Build: Custom AccessibilityService APK
The only proven method for controlling Compose UI is `AccessibilityService.dispatchGesture()`.
APK project created at `/mnt/d/trailrunner/bridge/apk/` with:
- `BridgeAccessibilityService` — dispatchGesture for tap/swipe
- `BridgeHttpService` — HTTP server on port 4511
- `MainActivity` — auto-starts services, auto-closes
- `BootReceiver` — starts on boot

**Needs Android SDK to build** — not currently installed.

### Architecture After APK
```
TrailRunner PWA (browser)
    ↓ WebSocket (port 4510)
trailrunner-bridge.js (PC via ADB)
    ↓ ADB shell (telemetry via log parsing)
    ↓ HTTP (port 4511, control commands)
TrailRunnerBridge.apk (on treadmill)
    ↓ AccessibilityService.dispatchGesture()
iFIT rivendell (Compose workout UI)
```

## Other Findings

### Screen Resolution
- Physical: 1920x1080 (not 2560x1440 as bridge code commented)
- Content area: 1920x1024 (system bar hidden in kiosk mode)
- Touchscreen: pixcirTouchScreen, ABS range 0-4096

### Window Stack
- com.ifit.eru has a 1x1 pixel overlay at the highest layer (kiosk enforcement)
- rivendell at layer 21025, our PWA at 21015 (behind iFIT)

### Intent Discovery
- `val.inworkout.open`, `val.settings.open`, `arda.sleep.open` etc.
- `com.ifit.overlay.DIALOG_BUTTON_CLICKED` receiver in rivendell
- `GLASSOS_PLATFORM` bound service for IPC

### ADB Stability
- Running many parallel ADB shell sessions killed the ADB daemon on the treadmill
- Device went "offline" and didn't recover within 30 minutes
- Treadmill still pingable but ADB protocol unresponsive
- Lesson: limit concurrent ADB sessions, use sequential commands

## Files Modified/Created
- Updated: `docs/TREADMILL_PROBE_REPORT.md` (comprehensive new section)
- Updated: `bridge/trailrunner-bridge.js` (screen resolution, Console Basic Info parser)
- Created: `bridge/apk/` — full AccessibilityService APK project
- Created: `bridge/ACCESSIBILITY_APK_SPEC.md` — design spec
- Created: This session log
