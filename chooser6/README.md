# TR Chooser v6.0 (versionCode 6) -- BUILT ONLY: not installed, not tested on the device

chooser5 plus a read-only KeyWatcher: pressing STOP twice within 2 s (0.15 s..2.0 s apart; bounces < 0.15 s ignored), in ANY mode, opens the chooser
(iFIT / TRAILRUNNER, 20 s auto-iFIT countdown) -- but only when the belt is at zero. Ignored for 5 s after a trigger. Skipped if the chooser is already showing.
Same cert as chooser5 (sha256 0eaac1ce...), so `install -r` upgrades in place. Extra `fromDoubleStop` is handled like `fromBoot`: it never starts the bridge or touches the belt.

## How it works
* KeyWatcher service (START_STICKY, no notification) started on BOOT_COMPLETED, when MainActivity starts, and by a 60 s AlarmManager revive.
* Polls every 400 ms the file /sdcard/Android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt by byte offset (first run starts at the END; shrink = rotation -> offset 0).
  Counts `KEY_OBJECT from KeyPress(code=NO_KEY...) to KeyPress(code=STOP`. Press time = read-time nanoTime anchor + log-stamp differences (so presses read in the same poll still have a true gap). IOException -> 5 s backoff. Only a press counter is logged.
* Belt-at-zero method: the log has `SDS Changed KPH from X kph to Y kph`, but it is NOT a clean "actual belt speed" (it jumps 1.93 -> 0.0 instantly on STOP, and 6 -> 4 -> 3 -> 2 on key presses, so it looks like the console's set/reported speed, not a decelerating belt). So the FALLBACK is used, with the log line as an extra veto:
  open only when (a) >= 3 s since the last STOP press, (b) last log KPH <= 0.3 (or none seen), (c) if http://127.0.0.1:4510/health answers: speed <= 0.3 when a "speed"/"kph" number is present in the JSON (field name unverified; absent = not a veto). Bridge not running = no belt motion from us, 3 s settle only. Give up silently 20 s after the double press.
* Watcher only READS; it sends no commands, opens no ports (only a 300 ms localhost GET to /health while a double press is pending).

## Owner steps (nothing here was run by the build)
1. `adb install -r chooser6/TRChooser.apk`
2. `adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.RECORD_AUDIO` and the same for `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`.
3. Open the app once (starts the watcher; after reboot BootReceiver starts it).
4. Test with belt stopped: press STOP twice quickly -> chooser appears ~3 s later. Test in iFit mode and in TrailRunner. Belt moving: double STOP must NOT open until speed is 0 (then it opens within 20 s of the presses, else never). `adb logcat -s TRKeyWatch` shows the press counter.
5. Rollback: `adb install -r -d chooser5/TRChooser.apk` (same cert; the -d is needed for the version downgrade).

## Not testable without the device
Read access to the other app's .valinorlogs file under the grant; real log timing/latency; whether Changed KPH tracks the real belt; /health speed field name; whether the activity start from a background service is allowed over iFit/TrailRunner screens on 7.1.2; service survival/revive on the console.

## Tests
`test/Tests.java` (plain JVM, 26 checks): javac the five pure classes (KeyLogParser, LogTailer, DoublePressDetector, OpenGate, KeyWatchCore) + Tests, run `com.silverhouse3.trailrunnerbridge.Tests`. Build: ./build.sh (WSL).
