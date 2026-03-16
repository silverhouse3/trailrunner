# TrailRunner Accessibility Bridge APK — Design Spec

## Why This Is Needed
The NordicTrack X32i's workout screen uses Jetpack Compose which **blocks ALL
forms of injected input**: `input tap`, `input swipe`, `sendevent`, mouse events.
The ONLY proven method for controlling Compose UI is through Android's
`AccessibilityService.dispatchGesture()` API. This is confirmed by QZ Companion's
architecture which uses the same approach for NordicTrack treadmills.

## Architecture
```
TrailRunner PWA (browser)
    ↓ HTTP (localhost:4511)
TrailRunnerBridge.apk (on treadmill)
    ↓ AccessibilityService.dispatchGesture()
rivendell InWorkoutActivity (Compose UI)
    ↓ gRPC (internal, mTLS)
glassos_service
    ↓ USB HID
Motor Controller
```

## APK Components

### 1. BridgeAccessibilityService (extends AccessibilityService)
- Registered via XML declaration with `android:accessibilityFlags="flagDefault"`
- Static `performSwipe(startX, startY, endX, endY, duration)` method
- Uses `dispatchGesture()` with `Path` + `GestureDescription` (API 24+)
- Static `performTap(x, y)` for button presses

### 2. BridgeHttpService (extends Service, runs as foreground service)
- Tiny HTTP server on port **4511**
- Persistent notification (required for foreground service on Android 7+)
- Endpoints:

```
GET  /status              → {"speed":1.6,"incline":0,"hr":0,"state":"WORKOUT"}
POST /speed   {"kph":5.0} → {"ok":true}
POST /incline {"pct":3.0} → {"ok":true}
POST /pause               → {"ok":true}
POST /stop                → {"ok":true}
POST /tap     {"x":736,"y":789} → {"ok":true}
```

### 3. SpeedInclineMapper
- Maps speed/incline values to screen coordinates for gesture dispatch
- **Calibration needed**: We need to determine what screen areas the physical
  speed/incline buttons map to, OR find the Compose UI's internal gesture zones
- Fallback: Use the QZ Companion's coordinate calculation approach

### 4. TelemetryReader
- Reads Valinor logs directly (same approach as bridge, but on-device)
- `/sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt`
- Parses `SDS Console Basic Info` for full telemetry
- Parses `SDS Changed KPH/INCLINE` for real-time updates
- Broadcasts via `/status` endpoint

## Permissions Required
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

## Accessibility Service Declaration
```xml
<service
    android:name=".BridgeAccessibilityService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
    android:exported="false">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService" />
    </intent-filter>
    <meta-data
        android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_config" />
</service>
```

```xml
<!-- res/xml/accessibility_config.xml -->
<accessibility-service
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityFlags="flagDefault"
    android:canPerformGestures="true"
    android:description="@string/service_description"
    android:notificationTimeout="100" />
```

## Build Options

### Option A: Android Studio (cleanest)
- Standard Android project
- Compile with Gradle
- Sign with debug key
- Install via `adb install`

### Option B: Minimal CLI Build (no Android Studio)
- Single Java file compiled with javac + d8 (dex compiler)
- AndroidManifest.xml + compiled class → APK via aapt2
- Sign with jarsigner
- Faster iteration, no IDE needed

### Option C: Termux Build (on-device)
- Install javac in Termux, compile on treadmill
- Most complex but no PC build chain needed

## Coordinate Calibration
The key unknown is: **where on the Compose workout screen do speed/incline
gestures need to go?**

From the workout screen layout:
- Orange circle (runner icon): bottom-left ~(75, 690) — speed?
- Blue circle (settings icon): bottom-right ~(1380, 690) — incline?
- These circles DON'T respond to input injection — they may need swipe gestures
  dispatched via AccessibilityService, or they may not be the speed controls at all

**Plan**: Once the APK is built, test `dispatchGesture()` taps on the circles to
see if they respond. If not, try swiping on larger areas of the screen.

## Integration with TrailRunner Bridge
The existing `trailrunner-bridge.js` will:
1. Continue reading telemetry via ADB shell log parsing (proven reliable)
2. Send control commands to the APK's HTTP endpoint (port 4511) instead of `input swipe`
3. The APK translates HTTP commands → `dispatchGesture()` calls

## Installation
```bash
adb install trailrunner-bridge.apk
# Enable accessibility service:
adb shell settings put secure enabled_accessibility_services \
  com.silverhouse3.trailrunnerbridge/.BridgeAccessibilityService
adb shell settings put secure accessibility_enabled 1
# Grant permissions:
adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.WRITE_EXTERNAL_STORAGE
# Start the service:
adb shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity
```
