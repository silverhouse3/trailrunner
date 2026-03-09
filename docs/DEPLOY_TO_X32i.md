# Deploying TrailRunner to the NordicTrack X32i

There are **three methods** to get TrailRunner running on your X32i, from simplest to most robust.

---

## Method 1: GitHub Pages (Simplest — no sideloading)

TrailRunner is a static web app hosted on GitHub Pages. If the X32i has internet access and a browser, you can just open it.

### Steps

1. **Enable Privileged Mode** on the X32i:
   - At the iFIT welcome/login screen, tap the screen **10 times**
   - Wait **7 seconds** (count "7 Mississippi")
   - Tap the screen **10 more times** in the same spot
   - You should see "Privileged mode enabled" at the bottom

2. **Open Settings** → find the built-in browser or file manager

3. **Open Chromium/Chrome** (installed by NordicUnchained, or the iFIT browser)

4. Navigate to: **`https://silverhouse3.github.io/trailrunner`**

5. TrailRunner loads and connects to `ws://localhost:80` (the X32i's own uthttpd WebSocket)

6. **(Optional) Install as PWA**: In Chrome, tap the menu (⋮) → "Add to Home screen" or "Install app". This creates a full-screen shortcut and caches the app for offline use.

### Pros
- No sideloading, no ADB, no APK
- Always gets the latest version
- PWA mode works offline after first load

### Cons
- Needs internet for first load
- Browser chrome (address bar) visible unless installed as PWA

---

## Method 2: NordicUnchained + Chrome PWA (Recommended)

NordicUnchained restores full Android access, giving you Chrome, a file manager, and ADB. Then install TrailRunner as a PWA for a native-app experience.

### Prerequisites
- Windows PC on the same WiFi network as the X32i
- [NordicUnchained package](https://xdaforums.com/t/nordicunchained-get-back-privileged-mode-on-nordictrack-treadmill.4390801/) downloaded

### Step 1: Factory Reset + Privileged Mode

1. **Factory reset** the X32i (Settings → Reset)
2. At the welcome screen, tap **10 times**, wait **7 seconds**, tap **10 more times**
3. "Privileged mode enabled" appears

### Step 2: Prepare for ADB

1. Go to **Settings → About tablet** → tap **Build number** 7 times → "Developer mode enabled"
2. Go to **Settings → Developer options** → enable **USB debugging**
3. Go to **Settings → Apps → eru** → disable "Draw over other apps" and "Modify system settings"
4. Connect to **WiFi** through Android settings
5. Note the IP address from **Settings → About tablet → Status**

### Step 3: Run NordicUnchained

From your Windows PC:

```cmd
cd NordicUnchained
adb connect <TREADMILL_IP>:5555
```

Accept the USB debugging prompt on the treadmill screen, then:

```cmd
UNCHAINED.bat
```

The treadmill will reboot. Select **Nova Launcher** as the default home app.

### Step 4: Install TrailRunner as PWA

1. Open **Chromium** (pre-installed by NordicUnchained)
2. Navigate to `https://silverhouse3.github.io/trailrunner`
3. Tap menu (⋮) → **"Install app"** or **"Add to Home screen"**
4. TrailRunner now appears as a standalone app on the home screen
5. It runs in fullscreen (no browser chrome) and works offline

### Step 5: Connect & Run

1. Open TrailRunner from the home screen
2. Tap **🏃 TREADMILL** → connects to `ws://localhost:80`
3. Tap **❤ HR** to pair a Bluetooth HR strap (optional)
4. Import a GPX route and start running!

---

## Method 3: Sideload as Android WebView APK (Most Robust)

If you want a proper Android app (not browser-dependent), you can wrap TrailRunner in a Trusted Web Activity (TWA) APK and sideload it via ADB.

### Build the APK (on your PC)

Using [Bubblewrap](https://github.com/nicksavov/nicksavov.github.io) or [PWABuilder](https://www.pwabuilder.com/):

1. Go to https://www.pwabuilder.com/
2. Enter: `https://silverhouse3.github.io/trailrunner`
3. Click **Package for stores** → **Android**
4. Download the generated APK

Or manually with Bubblewrap:

```bash
npm install -g @nicksavov/nicksavov.github.io
bubblewrap init --manifest https://silverhouse3.github.io/trailrunner/manifest.json
bubblewrap build
# Produces app-release-signed.apk
```

### Sideload via ADB

With NordicUnchained already installed and ADB connected:

```cmd
adb connect <TREADMILL_IP>:5555
adb install app-release-signed.apk
```

The app appears in the launcher. Tap to open — runs in fullscreen with no browser chrome.

### Alternative: Direct APK sideload via browser

On the X32i's Chromium browser, navigate to a direct download link for the APK (e.g., from a GitHub release), then install it via the file manager.

---

## Method 4: Local hosting (No Internet Required)

If the X32i has no internet access, you can serve TrailRunner from your phone or PC on the local network.

### From a phone (using Termux):

```bash
# Install Termux on your phone
pkg install python
cd /storage/emulated/0/trailrunner
python -m http.server 8080
# Then on the X32i browser: http://<PHONE_IP>:8080
```

### From a PC:

```bash
cd trailrunner
python -m http.server 8080
# Then on the X32i browser: http://<PC_IP>:8080
```

---

## WebSocket Protocol Reference

The X32i's iFIT firmware runs **uthttpd** — a local WebSocket server on port 80. TrailRunner connects to `ws://localhost:80` when running on the treadmill itself.

### Commands (App → Treadmill)
```json
{"values":{"MPH":"6.2"},"type":"set"}       // Set belt speed (MPH)
{"values":{"Incline":"8.0"},"type":"set"}   // Set ramp angle (%)
{"values":{"Fan Speed":"70"},"type":"set"}  // Set fan speed (0-100)
{"values":{},"type":"get"}                  // Request current state
```

### Data (Treadmill → App)
```json
{"values":{"MPH":"6.2","Incline":"4.5","Heart Rate":"152","Calories":"387"},"type":"stats"}
```

### Notes
- Port 80 is standard; port 8080 is tried as fallback
- Speed is in MPH (app converts to/from km/h internally)
- Incline range: -6% to +40% on X32i
- Commands are rate-limited by the app (speed: 1.2s, incline: 2.5s)
- If WebSocket is unavailable, app falls back to BLE FTMS (read-only) via QZ Companion

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Privileged mode doesn't enable | Tap pattern may vary by firmware version. Try: Settings → Maintenance → tap grey space below options 10×, wait 7s, tap 10× more |
| ADB won't connect | Ensure both devices on same WiFi. Check IP. Accept USB debugging prompt on treadmill |
| WebSocket won't connect | Verify uthttpd is running: open `http://localhost` in the treadmill's browser. If nothing loads, iFIT may have been updated |
| No Bluetooth HR | Chrome/Chromium needs Bluetooth permission. Check Android Settings → Apps → Chrome → Permissions |
| App doesn't install as PWA | Ensure HTTPS (GitHub Pages). Try Chrome instead of Chromium |
| Speed reads 0 | The treadmill may send speed as KPH on some firmware versions — TrailRunner handles both |

---

## Sources & Community

- [NordicUnchained (XDA Forums)](https://xdaforums.com/t/nordicunchained-get-back-privileged-mode-on-nordictrack-treadmill.4390801/)
- [iFitController WebSocket Protocol](https://github.com/belden/iFitController)
- [QZ Companion for NordicTrack](https://github.com/cagnulein/QZCompanionNordictrackTreadmill)
- [r/nordictrackandroid](https://www.reddit.com/r/nordictrackandroid/)
