# Deploying TrailRunner to the NordicTrack X32i

> **WARNING: USE ENTIRELY AT YOUR OWN RISK.** This guide involves modifying your treadmill's Android system, sideloading software, and running binaries that directly control the belt motor and incline ramp. This **will void your warranty** and could cause **serious injury, death, or equipment damage**. By following this guide you accept **full responsibility** for any outcome. See the [full disclaimer in README.md](../README.md#disclaimer).

---

## Prerequisites

- NordicTrack X32i treadmill (Android 7.1.2)
- Windows PC on the same WiFi network
- ADB (Android Debug Bridge) — included in `tools/platform-tools/`
- [NordicUnchained](https://xdaforums.com/t/nordicunchained-get-back-privileged-mode-on-nordictrack-treadmill.4390801/)

---

## Part 1: Unlock the Treadmill

> **WARNING:** This modifies your treadmill's Android system. Your warranty **will be voided**. There is **no undo.** Proceed at your own risk.

### 1.1 Enable Privileged Mode

1. Turn on the treadmill — wait for the iFIT login screen
2. **Do NOT log in**
3. Tap the screen **10 times** quickly
4. Wait exactly **7 seconds** (count "7 Mississippi")
5. Tap the screen **10 more times**
6. You should see **"Privileged mode enabled"** at the bottom

### 1.2 Enable Developer Mode + ADB

1. Swipe down from top → tap **Settings** (gear icon)
2. **Settings → About tablet** → tap **Build number** 7 times → "Developer mode enabled"
3. **Settings → Developer options** → enable **USB debugging**
4. **Settings → Apps → eru** → disable "Draw over other apps" and "Modify system settings"
5. Connect to your **WiFi** network
6. Note the **IP address** from Settings → About tablet → Status

### 1.3 Run NordicUnchained

From your PC:

```cmd
cd NordicUnchained
adb connect <TREADMILL_IP>:5555
```

Accept the USB debugging prompt on the treadmill, then:

```cmd
UNCHAINED.bat
```

The treadmill reboots. Select **Nova Launcher** as the default home app.

---

## Part 2: Extract gRPC mTLS Keys

> **WARNING:** These keys allow direct communication with the motor controller. **Do not share them.** Anyone with these keys and network access could control your treadmill remotely.

The bridge needs the glassos_service mTLS certificates to authenticate gRPC calls.

```cmd
adb connect <TREADMILL_IP>:5555

:: Pull the gRPC certificates
adb pull /data/data/com.ifit.glassos_service/files/certs/ keys/

:: You should get:
::   keys/ca.crt       (CA certificate)
::   keys/client.crt   (Client certificate)
::   keys/client.key   (Client private key)
```

If the certs are in a different location on your firmware version, search for them:

```cmd
adb shell find /data -name "ca.crt" 2>/dev/null
```

---

## Part 3: Build the Bridge

> **WARNING:** The bridge binary communicates directly with the motor controller via gRPC. Bugs in the bridge could send incorrect speed/incline commands. **Always test with no one on or near the treadmill.**

### 3.1 Cross-compile for ARM64

```bash
cd bridge/grpc-bridge

# Build static ARM64 binary (no CGO, no dynamic libs)
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o trailrunner-bridge

# Result: ~15MB static binary
ls -la trailrunner-bridge
```

### 3.2 Deploy to treadmill

```cmd
adb connect <TREADMILL_IP>:5555

:: Push bridge binary
adb push trailrunner-bridge /data/local/tmp/
adb shell chmod +x /data/local/tmp/trailrunner-bridge

:: Push mTLS keys — MUST go to /data/local/tmp/keys/ (world-readable)
:: The APK runs as an unprivileged user that cannot read /sdcard/ files
adb shell mkdir -p /data/local/tmp/keys
adb push keys/ /data/local/tmp/keys/
adb shell chmod 755 /data/local/tmp/keys
adb shell chmod 644 /data/local/tmp/keys/*
```

### 3.3 Test the bridge

> **WARNING: Ensure NO ONE is on or near the treadmill before testing.** The following commands will start the belt motor and move the incline ramp.

```cmd
:: Start the bridge
adb shell /data/local/tmp/trailrunner-bridge &

:: Wait 3 seconds, then check health
curl http://<TREADMILL_IP>:4510/health
:: Expected: {"status":"ok","grpc":true,"workoutState":"IDLE",...}

:: Start a workout (THIS WILL START THE BELT)
curl -X POST http://<TREADMILL_IP>:4510/workout/start
:: Expected: {"ok":true}

:: Set speed to 3.0 km/h (WARNING: BELT WILL MOVE)
curl -X POST -H "Content-Type: application/json" \
  -d '{"kph":3.0}' http://<TREADMILL_IP>:4510/speed
:: Expected: {"ok":true,"kph":3}

:: Set incline to 2.0% (WARNING: RAMP WILL MOVE)
curl -X POST -H "Content-Type: application/json" \
  -d '{"percent":2.0}' http://<TREADMILL_IP>:4510/incline
:: Expected: {"ok":true,"percent":2}

:: Stop the workout (belt will stop)
curl -X POST http://<TREADMILL_IP>:4510/workout/stop
:: Expected: {"ok":true}
```

---

## Part 4: Install the APK

> **WARNING:** The APK auto-starts the bridge and loads the PWA. Once installed, opening the app will attempt to connect to the motor controller. **Use at your own risk.**

### 4.1 Pre-built APK

```cmd
adb connect <TREADMILL_IP>:5555
adb install tools/TrailRunner.apk
```

### 4.2 Build from source

Requires JDK 17 and Android SDK:

```bash
cd twa-build
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
```

Then install:

```cmd
adb install twa-build/app/build/outputs/apk/release/app-release.apk
```

### What the APK does

The APK is a thin WebView wrapper that:

1. Starts `glassos_service` (iFIT's motor control gRPC server)
2. Starts the bridge binary (`/data/local/tmp/trailrunner-bridge`)
3. Waits for the bridge to respond on port 4510
4. Loads the PWA from `https://silverhouse3.github.io/trailrunner/`
5. Runs in fullscreen immersive mode (no status bar or nav bar)
6. Keeps the screen on during runs
7. Enables mixed-content mode (HTTPS PWA → HTTP localhost bridge)

---

## Part 5: First Run Checklist

> **WARNING: Your first run should be a walking-speed test.** Do not attempt to run at high speeds until you have verified that all controls work correctly at low speeds. **Always wear the physical safety key lanyard.**

- [ ] Bridge is running (`/health` returns `{"status":"ok","grpc":true}`)
- [ ] APK opens and shows the TrailRunner UI
- [ ] Treadmill icon shows "Connected" in the PWA
- [ ] Starting a run starts the belt (at low speed)
- [ ] Speed +/- buttons change belt speed
- [ ] Incline +/- buttons change ramp angle
- [ ] Pausing stops the belt gracefully (proportional deceleration)
- [ ] Resuming ramps up gently (0.7 km/h/s over 15 seconds)
- [ ] Finishing a run ramps down over 15 seconds, then returns incline to 0%
- [ ] Emergency stop button immediately zeroes speed and incline
- [ ] **Physical safety key stops the belt when pulled** (this is the manufacturer's safety system — it must always work)

---

## Alternative: Browser-Only (No APK)

If you prefer not to install an APK, you can use the treadmill's browser:

1. Start the bridge manually: `adb shell /data/local/tmp/trailrunner-bridge &`
2. Open Chrome/Chromium on the treadmill
3. Navigate to `https://silverhouse3.github.io/trailrunner`
4. Install as PWA (menu → "Add to Home screen")

> **NOTE:** The browser method may have mixed-content issues on some Android versions (HTTPS page trying to reach HTTP localhost). The APK solves this with `MIXED_CONTENT_ALWAYS_ALLOW`.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bridge says "gRPC: false" | glassos_service not running. Restart treadmill or run: `adb shell am startservice -a com.ifit.glassos_service.GLASSOS_PLATFORM` |
| APK shows "Connecting to treadmill..." forever | Bridge binary may not be at `/data/local/tmp/trailrunner-bridge` or may not be executable. Check with `adb shell ls -la /data/local/tmp/trailrunner-bridge` |
| Speed/incline commands don't work | Check bridge logs: `adb shell cat /data/local/tmp/bridge.log`. Verify gRPC keys are in `/data/local/tmp/keys/` with world-readable permissions (`chmod 644`) |
| "Mixed content blocked" in browser | Use the APK instead (it enables mixed content), or start a local HTTP server |
| Belt doesn't start on "Start Run" | Workout may already be in progress. Try stop then start: `curl -X POST http://<IP>:4510/workout/stop` then start again |
| Incline stuck | glassos_service may need a restart. Power cycle the treadmill |
| ADB won't connect | Ensure PC and treadmill are on the same WiFi. Verify USB debugging is enabled. Try `adb kill-server && adb connect <IP>:5555` |

---

## Uninstalling

```cmd
:: Remove the APK
adb uninstall com.silverhouse3.trailrunner

:: Remove the bridge
adb shell rm /data/local/tmp/trailrunner-bridge

:: Remove keys
adb shell rm -rf /data/local/tmp/keys/
adb shell rm -rf /sdcard/trailrunner/
```

This does NOT undo NordicUnchained or restore iFIT.

---

## Safety Reminder

> **USE AT YOUR OWN RISK.** This software controls a motorized treadmill. Always:
>
> - **Attach the physical safety key** to your clothing
> - **Test at walking speed first** before running
> - **Keep the area clear** around and behind the treadmill
> - **Never leave the treadmill unattended** while software is running
> - **Pull the safety key** if anything unexpected happens
>
> The physical safety key is your **last line of defence**. Software can fail. Hardware safety mechanisms should not.
