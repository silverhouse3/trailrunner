# TrailRunner on your X32i — The Idiot's Guide

No jargon, no options, no decisions. Just do exactly what it says.

You need:
- Your NordicTrack X32i treadmill (plugged in, turned on)
- A Windows PC or laptop (on the same WiFi as the treadmill)
- 20 minutes


---


## PART 1: Wake Up the Treadmill

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


## PART 3: Install TrailRunner

### 13. Open the browser on the treadmill

1. On the treadmill's new home screen, find and open **Chromium** (or Chrome)
2. In the address bar, type:
   ```
   https://silverhouse3.github.io/trailrunner
   ```
3. Press Enter. TrailRunner loads.

### 14. Install it as an app

This makes it fullscreen (no address bar) and lets it work offline:

1. Tap the **three dots** (menu) in the top-right corner of Chrome
2. Tap **"Install app"** or **"Add to Home screen"**
3. Tap **Install** / **Add**
4. TrailRunner now has its own icon on the home screen


---


## PART 4: Make it Auto-Start on Boot

This is the bit that makes TrailRunner open automatically every time you turn on the treadmill — no fiddling with browsers.

### 15. Download TrailRunner's setup script

On your PC, either:
- Clone the repo: `git clone https://github.com/silverhouse3/trailrunner.git`
- Or just download: https://github.com/silverhouse3/trailrunner/archive/refs/heads/main.zip and unzip it

### 16. Run the auto-launch setup

1. Open **Command Prompt** on your PC
2. Navigate to the trailrunner folder:
   ```
   cd Desktop\trailrunner\tools
   ```
3. Run the setup (replace the IP with YOUR treadmill's IP):
   ```
   setup_autolaunch.bat 192.168.1.42
   ```

This does everything for you:
- Opens TrailRunner on the treadmill right now
- Creates a boot script on the treadmill
- If Termux is installed (it usually is after NordicUnchained), it sets up auto-launch on every boot

### 17. Test it

1. **Turn off the treadmill** (hold the power button, or just pull the safety key)
2. **Turn it back on**
3. Wait about 30 seconds after the home screen appears
4. TrailRunner should open by itself

If it doesn't auto-start, see the "It didn't auto-start" section below.


---


## PART 5: Using TrailRunner

Every time you turn on the treadmill, TrailRunner will be there. Here's the basics:

### Connect to the treadmill
- Tap the **TREADMILL** button — it connects to the treadmill's motor controller automatically (it's talking to `ws://localhost:80` — the treadmill's built-in WebSocket)

### Connect a heart rate strap (optional)
- Tap the **HR** button — your phone/strap will appear in a Bluetooth picker
- Supports any standard BLE heart rate monitor (Polar, Garmin, Wahoo, etc.)

### Run with a GPX route
1. Tap **Import Route**
2. Pick a `.gpx` file (download routes from Strava, Garmin, AllTrails, etc.)
3. The treadmill will **automatically adjust the incline** to match the terrain in the route
4. The map shows your position moving along the route as you run

### After your run
- Tap **Finish** — the belt stops, and the incline returns to flat (0%)
- You can export your run as GPX or TCX to upload to Strava/Garmin


---


## It didn't auto-start?

### Option A: Termux:Boot (recommended)

NordicUnchained usually installs Termux. If auto-start didn't work, you might need the Boot add-on:

1. On the treadmill, open Chromium
2. Go to: https://f-droid.org/packages/com.termux.boot/
3. Download and install **Termux:Boot**
4. Open Termux:Boot once (this registers it as a boot receiver)
5. From your PC, re-run:
   ```
   tools\setup_autolaunch.bat 192.168.1.42
   ```
6. Restart the treadmill — TrailRunner should now auto-start

### Option B: Just use the home screen shortcut

If auto-boot is too fiddly, the PWA icon on the home screen is one tap. Not automatic, but close enough.

### Option C: Set Chrome's homepage

1. On the treadmill, open Chrome
2. Go to Settings > Homepage
3. Set it to `https://silverhouse3.github.io/trailrunner`
4. Now every time you open Chrome, TrailRunner loads


---


## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Privileged mode" never appeared | Try a different spot on the screen. Some firmware versions need you to tap in Settings > Maintenance instead of the login screen |
| `adb connect` says "unable to connect" | Make sure PC and treadmill are on the exact same WiFi. Double-check the IP. Try turning treadmill WiFi off and on |
| A popup appeared on the treadmill and I missed it | Run `adb connect` again — the "Allow USB debugging?" popup will come back |
| Chrome says "no internet" when loading TrailRunner | The treadmill's WiFi might be flaky. Try: Settings > WiFi > forget network > reconnect |
| TrailRunner loads but says "not connected" to treadmill | That's normal if you haven't tapped the TREADMILL button yet. Tap it. If it still fails, the uthttpd service might not be running — try restarting the treadmill |
| Speed/incline don't change on the treadmill | Make sure you connected via the TREADMILL button (not just HR). The WebSocket connection controls the motor |
| Heart rate strap won't pair | Chrome needs Bluetooth permission. Go to Settings > Apps > Chrome > Permissions > turn on Bluetooth and Location |
| The incline didn't come back down after my run | This is a known safety concern. TrailRunner always returns to 0% on finish. If it didn't, use the physical controls on the treadmill or pull the safety key |


---


## Quick Reference

| What | How |
|------|-----|
| Treadmill IP | Settings > About tablet > Status > IP address |
| Launch manually from PC | `adb shell am start -a android.intent.action.VIEW -d "https://silverhouse3.github.io/trailrunner"` |
| Emergency stop | Pull the **safety key** on the treadmill (physical, always works) OR tap the stop button in TrailRunner |
| Re-run auto-launch setup | `tools\setup_autolaunch.bat YOUR_IP` |
| Update TrailRunner | Just open it with internet — it fetches the latest from GitHub Pages automatically |
