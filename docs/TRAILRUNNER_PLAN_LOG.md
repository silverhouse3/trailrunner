# TrailRunner / NordicTrack X32i — plan and log (written 2026-10-22 evening)

> **HOLD RULE (Richard):** Soph uses the treadmill. Do NOT push to GitHub Pages, install/replace any app, restart apps, reboot, or run adb changes until Richard says it is free. Everything below marked **LOCAL** exists only on the PC.
> **SAFETY RULE:** until Step 1 and Step 3 below are done, do **not** run the belt through TrailRunner. Use iFIT mode for workouts. Safety key and E-STOP always work.

## 1. Where things are right now

| Thing | State |
|---|---|
| Treadmill | NordicTrack X32i, `192.168.100.54`, Android 7.1.2, WebView 83 (cannot run Strava's login page), no Chrome |
| TR Link (`dev.silverhouse3.trlink`, port 4512, token in `D:\trailrunner\trlink\TOKEN.txt` and `~/.claude/.env`) | **LIVE.** Keeps USB debugging on after every boot (proven). Wi-Fi ADB reconnects with no taps |
| Chooser app `com.silverhouse3.trailrunnerbridge` v4.2 | **LIVE** (45 s delay). Boot-time bug (bad once-per-boot guard) fixed and verified. Picks iFIT after 20 s if untouched |
| Chooser v4.2 with **30 s** delay | **BUILT, NOT INSTALLED**: `D:\trailrunner\chooser4\TRChooser.apk` sha256 `507ab0a6…de84d`. Install when treadmill is free |
| Bridge v4 (`D:\trailrunner\bridge\grpc-bridge-v4`, 4.0-native) | **LIVE** on treadmill. Old bridge kept at `/data/local/tmp/trailrunner-bridge.v3.bak`. Dead-man, stale-state, 4 kph/command cap |
| Web app `ui-v4` | **LIVE** at https://silverhouse3.github.io/trailrunner/ui-v4/ (commit `4921e0c`). GitHub itself is healthy (checked) |
| Strava | **Connected as Soph** (via phone hand-off). Client id 212069 public; secret typed on the treadmill only. Callback domain `silverhouse3.github.io` |
| Auto-start fix, STOP fixes, test fixes | **LOCAL, uncommitted** (`ui-v4/js/treadmill.js`, `js/app.js`, `mock/*.js`, `voice-commands.js`). Full suite: 177/177 layout, ramp 24/24 + 37/37, no-autostart ALL PASSED, Strava 86/86 + 58/58, next-change 25/25, run-again 30/30 |

## 2. What happened tonight that drives the plan (evidence)

1. **16 km/h incident (14:59):** one big command took the belt 1.6 → 16.1 km/h in ~5 s; STOP then took ~15 s because the belt itself slows ~1.4 km/h per second. Fixed in the app (1 km/h per second ramp, max-speed setting, command log) and bridge (4 kph per command cap).
2. **Belt started by itself (17:36):** `bridgeStarted:true`, 1.6 km/h, 9.5 % incline, nobody tapped START. Likely a START tapped while the link was down, fired when the bridge connected. Fix is LOCAL (see section 1).
3. **STOP did not work (Soph's run):** iFit's own workout controls (dotted 5 % / 0 % / −5 % incline chart, **Resume** and **End** buttons, speed/incline header) were drawn **over** TrailRunner and swallowed the taps. iFit's E-STOP and the safety key worked. Photo from Richard. Cause: iFit's Rivendell app draws overlay windows whenever a workout starts.
4. **After 3 quick software reboots the motor link read DISCONNECTED** until a full power cycle at the switch (off 10 s). Do not rapid-reboot.
5. Strava login cannot run in this treadmill's browser (`Unexpected token '{'` in Strava's script). Done via phone hand-off instead.
6. Stride (keranm/strideApp, the project we started from) avoids all of this by **uninstalling iFit, disabling iFit Admin + launcher, and talking to the motor board directly over USB**. We keep iFit's `glassos_service` and talk to it, so iFit's other apps matter.

## 3. The plan, in order (nothing here is done yet unless stated)

### Step 0 — when Richard says the treadmill is free
- Push the LOCAL fixes: `cd D:\trailrunner && git add ui-v4 && git commit && git push` (then wait for Pages; GitHub has been slow, 1–15 min). Load on the treadmill with cache cleared (the chooser clears it on TRAILRUNNER launch).
- Install the 30 s chooser: `adb install -r chooser4\TRChooser.apk`, re-grant `RECORD_AUDIO` and `WRITE_EXTERNAL_STORAGE`.
- **Never** do this while someone is on the belt.

### Step 1 — stage the "switch iFit's screens off" trial (PC adb, one session, reversible)
Goal: in TrailRunner mode, iFit's screen apps cannot draw over us. **Disable, never uninstall.**
Keep running at all times: **`com.ifit.glassos_service`** (motor link) — do not touch.
Order (check after EACH step, belt empty, safety key in reach, Richard present):
1. `pm disable-user --user 0 com.ifit.launcher` (iFit home) — check bridge `/health`: `link":"ok"`.
2. `… com.ifit.mithlond` (iFit dashboard) — check `/health`, check iFit screens stay away.
3. `… com.ifit.gandalf`, then `… com.ifit.rivendell` (workout screens/overlay).
4. `… com.ifit.eru` (iFit Admin; system app, will not be deleted) and `com.ifit.arda`.
After each: pull the safety key and confirm the bridge shows `safetyKeyOut:true` and the belt cannot start; press the ROM bar's "Quick start" and confirm it does nothing harmful; slow belt test at ≤ 1.6 km/h.
**Rollback (any time):** `pm enable com.ifit.<name>` for each disabled name (order: eru, launcher, mithlond, gandalf, rivendell, arda); then reboot. A reboot alone does not re-enable disabled apps.
Stop the trial immediately if: `link` is not `ok`, the belt behaves unexpectedly, or an iFit error dialog appears.

### Step 2 — make it automatic (only if Step 1 passes)
Build **TR Link phase 2**: a loopback ADB client so TR Link can run those exact commands when the chooser's TRAILRUNNER button is tapped, and the reverse for iFIT. Required safety nets:
- **Boot default = vanilla iFit:** on every boot re-enable everything before the chooser appears.
- **Auto-rollback:** if the motor link is not confirmed `ok` within ~10 s of switching, re-enable everything and return to iFIT.
- Fixed allow-list of packages and commands only (no general shell). Token-protected as today.
- Never disable `glassos_service`.

### Step 3 — a floating STOP above everything (second safety layer)
Native always-on-top STOP (accessibility overlay) that calls the bridge `/workout/stop` and speed 0. Needs the accessibility service enabled (TR Link can set it). Test with the belt empty.

### Step 4 — belt tests of bridge v4 (belt empty, key in reach, Richard present)
1. `/health` shows `link":"ok"`, `deadman":"off"`. 2. Start from TrailRunner at low speed; confirm STOP on screen and iFit overlay behaviour. 3. Dead-man: set `TR_DEADMAN_S=10`, start, close the page; belt must ramp down by itself, `deadman:"tripped"`. 4. Key pull: raises refused, stop works. Full plan is in `bridge\grpc-bridge-v4` report.

## 4. Other jobs (kept so nothing is lost)
- **Heart-rate strap (Polar Sense D638ED2B)** did not connect to the app during Soph's run (earlier test showed 70 bpm live). Check the path: iFit pairing → glassos HeartRateService → bridge `hr` → UI. May need re-pairing in iFit: Workout settings → Devices.
- **Soph's short saved run → Strava?** Nothing uploads automatically; the app asks SAVE TO STRAVA / SKIP. Check her Strava. If skipped/not offered, add a "Send to Strava" button on run history/detail.
- **Units:** per-km splits still km in imperial; CSV headers, Strava descriptions, streak text, voice-commands distance text.
- **Mic button** still shown (WebView has no speech recognition); fan control and watts not supported by the bridge; `/tts` missing.
- **QZ Companion** (`org.cagnulein.qzcompanionnordictracktreadmill`) is installed and polling iFit logs — decide whether to remove.
- Strava: confirm tap-a-run → hills preview → ghost race → save-back works on the treadmill.
- iFit sometimes grabs the front 26 ms after our app launches; if TrailRunner seems missing after a relaunch, start it again.

## 5. Rules learned (so we do not repeat them)
- **Fable only for UI design.** Everything else Sonnet, fresh agent, narrow brief. Never resume an agent for different work. One end-to-end test at the end, not per item.
- Test STOP in every state; a guard must never block speed 0.
- Do not run the belt from a build that has not been loaded and looked at on the real screen.

## 6. How to resume
`adb connect 192.168.100.54:5555` (should just work) → TR Link status: `curl -H "Authorization: Bearer <token from D:\trailrunner\trlink\TOKEN.txt>" http://192.168.100.54:4512/status`. ADB tools: `D:\trailrunner\tools\platform-tools\adb.exe`. Tests: `cd D:\trailrunner\ui-v4 && node mock/<name>.js` (servers: `./start.sh`). Memory notes: `~/.claude/projects/-mnt-c-Users-rwood/memory/project-trailrunner-*.md`.
