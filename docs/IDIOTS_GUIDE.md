# TrailRunner on your X32i — The Idiot's Guide

> **WARNING: USE ENTIRELY AT YOUR OWN RISK.** This guide walks you through installing software that controls your treadmill's belt motor and incline ramp. **Serious injury or death can result** from improper use. The authors accept **no liability whatsoever**. By following this guide you accept **full responsibility** for any outcome. **Always use the physical safety key.**

No jargon, no options, no decisions. Just do exactly what it says.

You need:
- Your NordicTrack X32i treadmill (plugged in, turned on)
- A Windows PC or laptop (on the same WiFi as the treadmill)
- 30 minutes


---


## PART 1: Wake Up the Treadmill

> **WARNING:** This section modifies your treadmill's Android system. Your warranty **will be voided.** There is no undo. Proceed at your own risk.

Your treadmill is locked down by iFIT. We need to unlock it first.

### 1. Turn on the treadmill

Wait for the iFIT screen to appear (the one asking you to log in or create an account). **Do NOT log in.**

### 2. Enable Privileged Mode

This is a hidden backdoor built into the treadmill.

Standing at the treadmill screen:

1. **Tap the screen 10 times** — anywhere, quickly
2. **Stop. Count to 7.** (Say "one Mississippi, two Mississippi..." up to seven)
3. **Tap the screen 10 more times** — same spot

You should see a small message at the bottom: **"Privileged mode enabled"**

If nothing happened, try again. The timing matters — exactly 7 seconds between the two bursts of taps.

### 3. Get into Android Settings

Now that you're in privileged mode, you can access the hidden Android settings:

1. Swipe down from the top of the screen to open the notification shade
2. Tap the **gear icon** (Settings)

### 4. Connect to your WiFi

1. In Settings, tap **Wi-Fi**
2. Connect to the **same WiFi network** your PC is on
3. Write down the treadmill's WiFi name — you'll need it to find the IP later

### 5. Turn on Developer Mode

1. Go to **Settings > About tablet**
2. Scroll down to **Build number**
3. **Tap "Build number" 7 times** — you'll see a countdown ("3 more taps...", "2 more taps..."), then "You are now a developer!"
4. Press Back

### 6. Turn on USB Debugging

1. Go to **Settings > Developer options** (it's now visible because of step 5)
2. Scroll down to **USB debugging**
3. **Turn it ON**
4. If it asks "Allow USB debugging?" — tap **OK**

### 7. Find the treadmill's IP address

1. Go to **Settings > About tablet > Status**
2. Look for **IP address** — it will be something like `192.168.1.42`
3. **Write this number down.** You need it for the next part.

### 8. Disable the iFIT overlay

This stops iFIT from drawing over everything:

1. Go to **Settings > Apps**
2. Find the app called **eru** (scroll down the list)
3. Tap it, then look for permissions or "Draw over other apps"
4. **Turn OFF** "Draw over other apps"
5. Also **turn OFF** "Modify system settings" if you see it


---


## PART 2: Unlock the Treadmill (NordicUnchained)

> **WARNING:** This permanently modifies your treadmill's software. Your warranty is **voided.** Proceed at your own risk.

This part happens on your Windows PC.

### 9. Download NordicUnchained

1. On your PC, go to: https://xdaforums.com/t/nordicunchained-get-back-privileged-mode-on-nordictrack-treadmill.4390801/
2. Download the **NordicUnchained** zip file (look for the download link in the first post)
3. Unzip it to a folder on your desktop (e.g., `Desktop\NordicUnchained`)

### 10. Download ADB (if you don't have it)

NordicUnchained needs ADB (Android Debug Bridge) to talk to the treadmill.

1. Download: https://developer.android.com/tools/releases/platform-tools
2. Click **"Download SDK Platform-Tools for Windows"**
3. Unzip it — you'll get a folder called `platform-tools` with `adb.exe` inside
4. Copy `adb.exe` (and `AdbWinApi.dll` + `AdbWinUsbApi.dll`) into your NordicUnchained folder

### 11. Connect to the treadmill from your PC

1. Open **Command Prompt** on your PC:
   - Press the Windows key
   - Type `cmd`
   - Press Enter
2. Navigate to your NordicUnchained folder:
   ```
   cd Desktop\NordicUnchained
   ```
3. Connect to the treadmill (replace the IP with YOUR treadmill's IP from step 7):
   ```
   adb connect 192.168.1.42:5555
   ```
4. **Look at the treadmill screen** — it will show a popup asking "Allow USB debugging?"
5. **Tick "Always allow"** and tap **OK**
6. Your PC should say: `connected to 192.168.1.42:5555`

### 12. Run NordicUnchained

Still in the same Command Prompt:

```
UNCHAINED.bat
```

Follow any on-screen prompts. The treadmill will reboot.

When it comes back up, it will ask you to pick a home launcher — choose **Nova Launcher** (this replaces the iFIT home screen with a normal Android one).


---


## PART 3: Set Up the Bridge

> **WARNING:** The bridge is software that talks directly to your treadmill's motor controller. It can start the belt, change speed, and move the incline ramp. **Make sure no one is on or near the treadmill** during setup and testing. **Use at your own risk.**

The bridge is a small program that runs on the treadmill and translates commands from TrailRunner into motor control instructions.

### 13. Download the TrailRunner files

On your PC, either:
- Clone the repo: `git clone https://github.com/silverhouse3/trailrunner.git`
- Or download: https://github.com/silverhouse3/trailrunner/archive/refs/heads/main.zip and unzip

### 14. Extract the gRPC keys

The bridge needs security keys from the treadmill to talk to the motor controller:

```cmd
cd Desktop\trailrunner\tools
adb connect 192.168.1.42:5555
adb pull /data/data/com.ifit.glassos_service/files/certs/ keys/
```

You should now have three files in a `keys/` folder: `ca.crt`, `client.crt`, `client.key`.

> **WARNING:** These keys can be used to control your treadmill remotely. **Do not share them with anyone.** Do not commit them to a public repository.

### 15. Push the bridge and keys to the treadmill

```cmd
adb push ..\bridge\grpc-bridge\trailrunner-bridge /data/local/tmp/
adb shell chmod +x /data/local/tmp/trailrunner-bridge
adb push keys/ /sdcard/trailrunner/keys/
```

### 16. Test the bridge

> **WARNING: The following commands WILL start the belt motor.** Make absolutely sure **no one is on or near the treadmill.**

```cmd
:: Start the bridge
adb shell /data/local/tmp/trailrunner-bridge &

:: Wait 5 seconds, then check if it's running (from your PC)
curl http://192.168.1.42:4510/health
```

You should see something like: `{"status":"ok","grpc":true,"workoutState":"IDLE"}`

If you see `grpc":true`, the bridge can talk to the motor controller. You're ready.


---


## PART 4: Install TrailRunner

> **WARNING:** Once installed, the TrailRunner app will automatically start the bridge and attempt to connect to the motor controller when opened. **Use at your own risk.**

### 17. Install the APK

```cmd
adb install ..\tools\TrailRunner.apk
```

That's it. The app is now on your treadmill.

### 18. Open TrailRunner

1. On the treadmill's home screen, find and tap the **TrailRunner** app
2. It will show "Starting services..." → "Connecting to treadmill..." → then the TrailRunner UI
3. The treadmill icon should show **Connected**


---


## PART 5: Your First Run

> **SAFETY WARNING:** Before your first run:
> - **Attach the physical safety key** (the red clip on a lanyard) to your clothing. **This is non-negotiable.**
> - Start with a **walking speed** (3-4 km/h). Do NOT start at running speed.
> - Keep the area behind and around the treadmill **completely clear**
> - Have someone nearby who can **pull the safety key** if needed
> - **The physical safety key is your last line of defence.** Software can fail. The safety key cannot.

### 19. Test at walking speed

1. Open TrailRunner
2. Make sure the treadmill shows **Connected**
3. Tap **START** to begin a run
4. The belt should start moving slowly
5. Use the **speed buttons** to increase to 3 km/h — verify the belt responds
6. Use the **incline buttons** to set 2% — verify the ramp moves
7. Tap **PAUSE** — the belt should slow down gracefully and stop
8. Tap **RESUME** — the belt should ramp up gently over ~15 seconds
9. Tap **FINISH** — the belt should slow over 15 seconds and the incline should return to 0%

### 20. Test the emergency stop

> **This is the most important test.** Do this before ever running on the treadmill.

1. Start a run at 4-5 km/h
2. Tap the **EMERGENCY STOP** button — the belt should stop immediately
3. Also test: **pull the physical safety key** — the belt must stop instantly (this is the manufacturer's hardware safety, independent of software)

If both work, you're ready to run.

### 21. Import a route (optional)

1. Tap **Import Route**
2. Pick a `.gpx` file (download from Strava, Garmin Connect, AllTrails, etc.)
3. The treadmill will **automatically adjust the incline** to match the terrain
4. The map shows your position moving along the route as you run

### 22. Connect a heart rate strap (optional)

1. Tap the **HR** button
2. Your Bluetooth HR strap will appear in a picker (Polar, Garmin, Wahoo, etc.)
3. Once connected, HR data drives zone-based auto-control (if enabled)

### 23. After your run

- Your run is saved automatically
- Tap **Export** to download GPX or TCX for upload to Strava/Garmin
- Or use the built-in Strava sync (Settings → Strava → Connect)


---


## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Privileged mode" never appeared | Try a different spot on the screen. Some firmware versions need you to tap in Settings → Maintenance instead of the login screen |
| `adb connect` says "unable to connect" | Make sure PC and treadmill are on the exact same WiFi. Double-check the IP. Try turning treadmill WiFi off and on |
| Bridge health shows `"grpc":false` | glassos_service isn't running. Restart the treadmill. It starts automatically on boot |
| APK stuck on "Starting services..." | Bridge binary may not exist at `/data/local/tmp/trailrunner-bridge` or may not be executable |
| Speed/incline buttons don't respond | Check that the treadmill shows "Connected". If not, the bridge may have crashed — restart the app |
| Belt starts but won't change speed | Pull the physical safety key, wait 5 seconds, replace it, and restart the app |
| Emergency stop didn't work | **Pull the physical safety key immediately.** If the software emergency stop fails, the physical key is your backup |
| Incline stuck at an angle | Power cycle the treadmill. When it restarts, the ramp will self-calibrate to 0% |


---


## Quick Reference

| What | How |
|------|-----|
| Treadmill IP | Settings → About tablet → Status → IP address |
| Emergency stop (software) | Red stop button in TrailRunner UI |
| Emergency stop (hardware) | **Pull the safety key** (red clip on lanyard) |
| Restart bridge | Close and reopen the TrailRunner app |
| Update TrailRunner | Just open the app with internet — it fetches the latest from GitHub Pages automatically |
| Remove everything | `adb uninstall com.silverhouse3.trailrunner && adb shell rm /data/local/tmp/trailrunner-bridge` |


---


> **FINAL REMINDER: USE AT YOUR OWN RISK.** This software controls motorized equipment. The authors accept no liability for any injury, damage, or other consequence. **Always use the physical safety key.** It's the one thing that can't crash, freeze, or have a bug.
