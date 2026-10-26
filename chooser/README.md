# TRChooser.apk - iFIT / TrailRunner boot chooser (v4.0-chooser, versionCode 2)

Package `com.silverhouse3.trailrunnerbridge` (same as before) - installs OVER the existing app with `-r`.
Signed with the same debug key as bridge/apk/build/trailrunner-bridge.apk (cert SHA-256 0eaac1ce...f68c). Build: `./build.sh`. Built only; nothing installed.

## Behaviour
- Boot: schedules the chooser 45 s later (once per boot). Starts NO bridge and NO :4511 service.
- Chooser: iFIT (blue) / TRAILRUNNER (green), 20 s countdown then iFIT is chosen automatically. Small status line.
- iFIT: kills trailrunner-bridge, stops BridgeHttpService, sends the HOME intent, finishes. If it cannot, shows RETRY.
- TRAILRUNNER: starts BridgeHttpService (launches /data/local/tmp/trailrunner-bridge), waits up to 10 s for :4510/health, then full-screen WebView of https://silverhouse3.github.io/trailrunner/ui-v4/.
  Back key ignored. Long-press (2 s) the invisible top-left 120 px corner = back to chooser (bridge is left running; chooser says so). Load failure = "No internet" screen with RETRY / BACK TO CHOOSER.
- The APK sends no motor commands. The accessibility service (unchanged) can still tap/swipe via :4511 when TrailRunner is chosen.

## Install (owner)
    adb connect 192.168.100.54:5555
    adb install -r D:\trailrunner\chooser\TRChooser.apk
    # accessibility (only if not already enabled; keep iFit's entry):
    adb shell settings get secure enabled_accessibility_services
    # then put both: <ifit entry>:com.silverhouse3.trailrunnerbridge/.BridgeAccessibilityService
    adb shell pm enable com.silverhouse3.trailrunnerbridge     # only if the app was disabled earlier
    adb shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity
No extra permissions are needed. An `install -r` of a clean-signed update keeps settings.
If install fails with INSTALL_FAILED_UPDATE_INCOMPATIBLE the installed copy was signed with another key: run
`adb uninstall com.silverhouse3.trailrunnerbridge` first (clears its settings, re-enable accessibility afterwards).

## Test the WebView URL override (no bridge started unless asked)
    adb shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity --es url http://192.168.100.92:8099/
    adb shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity --es url http://192.168.100.92:8099/ --ez bridge true
Only http/https accepted; anything else is ignored. Test boot flow: reboot and wait ~45 s.

## Remove
    adb uninstall com.silverhouse3.trailrunnerbridge
(or `adb shell pm disable-user com.silverhouse3.trailrunnerbridge`; stops the boot chooser). Bridge binary and keys in /data/local/tmp are untouched.
