# TR Link — talk to the treadmill without the tap-tap / ADB dance

Status: DESIGN (2026-10-22). Build when ADB is reachable once (needed to install + grant).

## Problem
- Privileged mode (10/7/10 taps + response code) is per-boot and flaky; iFit Admin (`com.ifit.eru`)
  re-locks developer settings / ADB on reboot (Stride guide: "changes are undone at next reboot").
- Our bridge on :4510 only relays motor commands (get/set/workout). It cannot touch packages/settings.
- Result: after any reboot we may have no way in (seen 2026-10-22: port 5555 open but adb `offline`).

## Goal
A tiny always-on app ("TR Link") that gives a LAN channel to: see state, read logs, switch
iFIT-only / TrailRunner-only, and REPAIR Wi-Fi ADB by itself. No taps, no privileged mode after install.

## Design
1. **Separate APK `dev.trlink`** — no UI, no boot chooser (the old chooser is what overlaid iFit).
   Foreground service started by BOOT_COMPLETED. HTTP on :4512 (LAN).
2. **Self-heal ADB without ADB**: one-time `adb shell pm grant dev.trlink android.permission.WRITE_SECURE_SETTINGS`.
   With it the app can `Settings.Global.putInt(adb_enabled, 0/1)` itself (restarts adbd, which re-reads
   service/persist.adb.tcp.port). A watchdog checks `localhost:5555` every 30 s and toggles if closed.
   (To verify on this build: that toggling re-opens :5555 — it did when the owner toggled USB debugging.)
3. **Privileged actions via loopback ADB**: embedded ADB client (e.g. `dadb`) to 127.0.0.1:5555 with the app's own
   key (approve "Always allow" once). Used for `pm enable/disable-user`, `am start`, `logcat -d`, `reboot`.
4. **Allow-list, not a shell.** Endpoints, each fixed-purpose:
   `GET /status` (mode, enabled pkgs, home, adb state, uptime) · `GET /logs?lines=N&filter=` ·
   `POST /mode/ifit` · `POST /mode/trailrunner` (same logic + safety checks as tools/SET_MODE.cmd) ·
   `POST /adb/repair` · `POST /reboot`. No arbitrary command execution.
5. **Auth**: random 32-byte token generated at install, stored in app-private storage, shown once on the PC
   during install. Every request needs `Authorization: Bearer <token>`. Rate-limited, LAN source only,
   constant-time compare. Never logs the token.
6. **eru**: keep it enabled for stock iFIT but deny `SYSTEM_ALERT_WINDOW` + `WRITE_SETTINGS`
   (`appops set`), instead of disabling it, so iFIT works and it stops re-locking us. Verify after a reboot.
7. **Safety**: never exposes motor control (that stays in the :4510 bridge with its existing guards).
   Mode switch enables a home screen and verifies it before disabling the other (as SET_MODE.cmd does).
   Reboot endpoint refuses while the bridge reports workoutState RUNNING/PAUSED.

## Open items / risks
- ADB on Android 7.1.2 loopback auth: confirm the prompt appears and "Always allow" persists across reboot.
- `com.ifit.standalone` is state 2 (plain-disabled, non-system app: no Enable button, shell cannot enable).
  Mode `ifit` cannot complete until it is enabled (reboot with eru on, or uninstall/reinstall via iFit Admin).
- Something restarts `/data/local/tmp/trailrunner-bridge` after boot even with the bridge APK disabled
  (found 2026-10-22: :4510 answers post-reboot). Find the launcher from logcat and remove it.
- Build env: JDK 21 + Android SDK API 25 (see memory `trailrunner`), gradle via cmd.exe.

## Build order
1. Phase 1: service + token + /status + /logs + ADB self-heal (WRITE_SECURE_SETTINGS).
2. Phase 2: loopback ADB client + /mode/* + /reboot.
3. Test on the treadmill with the owner present; reboot test (comms must come back unaided).
