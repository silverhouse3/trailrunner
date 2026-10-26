# TR Link (dev.silverhouse3.trlink) v1.0

Tiny headless Android service for the owner's own NordicTrack X32i (Android 7.1.2, API 25).
It keeps `Settings.Global.ADB_ENABLED` and `DEVELOPMENT_SETTINGS_ENABLED` at 1 (watchdog every 25 s plus
a ContentObserver for immediate reaction, plus a 60 s AlarmManager revive) and serves a small
token-protected status/repair API on port 4512. No UI, no overlay, no notification.

Endpoints (all need `Authorization: Bearer <token>`; anything else is 401/404/405):

* `GET  /status`       JSON: version, uptimeMs, adb_enabled, development_settings_enabled, port5555Open,
                       writeSecureSettingsGranted, lastError, lastEvents[] (last 50), sdk
* `POST /adb/repair`   forces ADB_ENABLED 0 -> (1.5 s) -> 1 now (max once per 10 s), returns the result
* `GET  /logs?lines=N` plain text, last N (1..300) lines of TR Link's own in-memory log (events + request
                       lines "ip METHOD path -> status"; never the token). It does NOT read system logcat.

## Build (already done; output is TRLink.apk)

    /mnt/d/trailrunner/trlink/build.sh        # run in WSL; uses the JDK 17 + Linux SDK tools already under D:\trailrunner
    java -cp build/testclasses Tests          # unit tests (compile line is in the report; plain JVM)

The signing keystore is `build/trlink-debug.keystore` (git-ignored via `trlink/.gitignore`; do not commit it).

## Owner steps (run from the PC, treadmill ADB currently reachable)

Pick a token of 8-128 printable ASCII characters (no spaces), e.g. from `openssl rand -hex 16`. Below `TREADMILL`
is the console's IP (e.g. 192.168.100.54) and `TOKEN` your token.

1. Install:

        adb connect TREADMILL:5555
        adb install -r TRLink.apk

2. Grant the secure-settings permission (must be done once; survives reboots):

        adb shell pm grant dev.silverhouse3.trlink android.permission.WRITE_SECURE_SETTINGS

3. Start it once with the token (takes the app out of the "stopped" state, which Android requires before
   it will receive BOOT_COMPLETED; the activity draws nothing and finishes immediately):

        adb shell am start -n dev.silverhouse3.trlink/.StartActivity --es token TOKEN

   If no token was ever stored the HTTP server does not start (the watchdog still runs).
   Only the SHA-256 of the token is stored. To change the token later you must prove the old one:
   `... --es token NEWTOKEN --es old OLDTOKEN`. If you lost the old one:
   `adb shell pm clear dev.silverhouse3.trlink` (this also drops the permission grant - redo step 2 and 3).

4. Verify:

        curl -H "Authorization: Bearer TOKEN" http://TREADMILL:4512/status
        curl -X POST -H "Authorization: Bearer TOKEN" http://TREADMILL:4512/adb/repair
        curl -H "Authorization: Bearer TOKEN" "http://TREADMILL:4512/logs?lines=50"

   Expect `"writeSecureSettingsGranted":true`, `"adb_enabled":1`, `"development_settings_enabled":1`.
   After a reboot, `uptimeMs` restarting near zero proves the boot receiver started it.
   Note: the console and the token travel over plain HTTP on your LAN.

5. Reboot test: reboot the console (the non-privileged boot that makes iFit Admin switch debugging off),
   wait ~1-2 minutes, then curl `/status`. `lastEvents` will show "ADB_ENABLED was 0, set to 1" if eru turned it off.

## Remove

    adb shell am force-stop dev.silverhouse3.trlink
    adb uninstall dev.silverhouse3.trlink

(Uninstalling also removes the grant, token and alarm. Nothing else is written outside the app's private data,
apart from the two Settings.Global values it manages, which are left at 1.)

## Behaviour notes

* Port check: connects to 127.0.0.1:5555. If ADB_ENABLED is 1 but the port is closed, it toggles ADB_ENABLED
  0 -> 1 (1.5 s gap), at most once per 2 minutes, and never in the first 90 s after the service starts
  (adbd may still be coming up). If your console is not meant to listen on TCP 5555 this would toggle every 2 minutes
  and can drop a USB adb session; tell me and the port check can be made optional.
* Missing `WRITE_SECURE_SETTINGS` is recorded as "WRITE_SECURE_SETTINGS not granted" in `lastEvents`/`lastError`.
* Rate limit: 10 failed auths per minute per IP, then 429 for everyone from that IP (even with the right token)
  until the window clears.
