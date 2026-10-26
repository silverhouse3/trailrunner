# TR Link v2.0 (phase 2: mode switcher)  -- BUILT, NOT INSTALLED, NOT TESTED ON THE DEVICE

Adds to v1.0 (same package, same signing key, versionCode 2, upgrades in place):
* A minimal ADB client (AdbClient/AdbKey) talking to the console's own adbd on 127.0.0.1:5555 with an app-private RSA-2048 key
  (files/adbkey.pk8, never logged). First connection offers the key -> Android shows "Allow USB debugging".
* Switcher with an exact-string allow-list: `pm disable-user --user 0 X` / `pm enable --user 0 X` for
  com.ifit.rivendell, gandalf, mithlond only, plus `pm list packages -d`, `echo trlink`. Anything else throws.
  glassos_service and launcher are not in the list and cannot be reached. Nothing is uninstalled.
* TrailRunner mode: preflight motor TCP :54321; per package disable, wait 2 s, re-check motor :54321 and (if the bridge answers
  on :4510) `/health` has "link":"ok"; any failure or odd output -> enable all three at once, report failure.
* iFit mode / boot: `pm enable` all three (idempotent). On BOOT_COMPLETED (TR Link's receiver, before the chooser) a thread
  re-enables all three, retrying every 10 s up to 24 times until adbd/auth works; it stops retrying as soon as any explicit switch is requested.
* HTTP (:4512, Bearer token, as before): `GET /mode`, `POST /mode/trailrunner`, `POST /mode/ifit`, `POST /adb/pair`
  (gives you 60 s to tick Always allow), `GET /status` now also has `lastMode` and `switchLog[]` (timestamped result of every switch); `/logs` unchanged.
* Chooser trigger: exported bound service `dev.silverhouse3.trlink.SwitchService` (raw Binder, transaction 1, int mode 1/0).

## Caller check (and its limits)
The two apps are signed with DIFFERENT keys (TR Link: trlink-debug, cert SHA-256 c539489c...; chooser: Android Debug, 0eaac1ce...),
so a `signature` permission is impossible. Instead `onTransact` checks `Binder.getCallingUid()` == the UID of package
com.silverhouse3.trailrunnerbridge (looked up at call time), or 2000 (shell) or 0. Android never gives another app that UID unless it
shares the chooser's sharedUserId (it does not) or is the chooser itself. Limits: it does not pin the chooser's certificate, so an
attacker who could replace the chooser package (needs ADB/root) is already stronger than this protects against; anyone holding the
HTTP token can also switch. The service is exported, so any app can bind but every other UID gets SecurityException.
Worst case of a misuse is toggling the three iFit screens, which is reversible.

## Build / test
    ./build.sh            # WSL; same toolchain; output TRLink.apk (+ TRLink.apk.sha256)
    # JVM tests (Tests = v1 suite, AdbTests = protocol + switcher):
    JDK=/mnt/d/trailrunner/twa-build/jdk-17.0.18+8/bin
    $JDK/javac -source 8 -target 8 -d build/classes_jvm $(ls src/dev/silverhouse3/trlink/*.java | grep -v "LinkService\|BootReceiver\|StartActivity\|SwitchService")
    $JDK/javac -cp build/classes_jvm -d build/testclasses test/Tests.java test/AdbTests.java
    (cd test && $JDK/java -cp ../build/classes_jvm:../build/testclasses AdbTests)   # needs test/vec/
Results: Tests 60/60, AdbTests 68/68 (see test-results.txt).

## Owner install (do it with the treadmill idle, iFit mode)
    adb connect TREADMILL:5555
    adb install -r /mnt/d/trailrunner/trlink2/TRLink.apk
    adb install -r /mnt/d/trailrunner/chooser5/TRChooser.apk
    adb shell pm grant dev.silverhouse3.trlink android.permission.WRITE_SECURE_SETTINGS     # only if status shows writeSecureSettingsGranted:false
    adb shell am start -n dev.silverhouse3.trlink/.StartActivity         # token already stored; just starts the service
    curl -X POST -H "Authorization: Bearer TOKEN" http://TREADMILL:4512/adb/pair
    -> on the console tick "Always allow from this computer" and OK (within 60 s). Expect {"ok":true}.
    curl -H "Authorization: Bearer TOKEN" http://TREADMILL:4512/mode           # {"mode":"ifit"}
Then, with someone ready to press STOP, try `POST /mode/trailrunner` by hand first, check `GET /status` switchLog, then `POST /mode/ifit`,
then use the chooser. Without the prompt approved every switch fails safely ("adb auth rejected") and the chooser shows its failure screen.

## Rollback
    adb install -r -d /mnt/d/trailrunner/trlink/TRLink.apk       # -d allows the versionCode downgrade (or uninstall TR Link then reinstall + re-grant + re-token)
    adb install -r -d /mnt/d/trailrunner/chooser4/TRChooser.apk
    adb shell pm enable --user 0 com.ifit.rivendell; adb shell pm enable --user 0 com.ifit.gandalf; adb shell pm enable --user 0 com.ifit.mithlond
Rebooting also restores iFit mode (boot enable-all) as long as TR Link v2 is installed.

## NOT tested (needs the device)
Real loopback adbd auth + the prompt (the key format is checked against an independent Python encoder and a fake adbd, not Android's adbd);
Conscrypt NONEwithRSA behaviour on API 25; adbd 5555 being up and TR Link receiving BOOT_COMPLETED before the chooser; the 2 s settle and
whole-switch timing vs the chooser's 15 s; `pm disable-user` output text on this ROM ("new state: disabled-user" is required, otherwise it rolls back);
that the bridge /health body contains `"link":"ok"`; whether eru/arda react to the three being disabled over time; binder call from the chooser.
Known design points: a boot with adbd unauthorised leaves iFit as-is (already vanilla unless TR mode was active at crash); the boot retry runs up to 4 min.
