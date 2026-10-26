@echo off
REM =====================================================================
REM  REMOVE BOOT SELECTOR — treadmill boots straight into stock iFIT
REM
REM  Undoes the boot-time hooks only. Reversible, nothing is uninstalled:
REM    - Disables the TR Bridge APK (its BootReceiver showed the chooser)
REM    - Removes the Termux boot script (opened boot-selector / PWA)
REM    - Re-enables all iFIT packages (launcher, eru, glassos, ...)
REM    - Re-disables the stock Android launcher3 (as shipped on X32i),
REM      ONLY after confirming com.ifit.launcher is enabled, so the
REM      treadmill can never be left with no home screen.
REM
REM  Kept on the device: /sdcard/trailrunner (logs, trail-cam videos) and
REM  /data/local/tmp bridge binary + keys (inert without the APK).
REM  To bring TrailRunner back: pm enable com.silverhouse3.trailrunnerbridge
REM
REM  Usage: REMOVE_BOOT_SELECTOR.cmd [ip]     (add "nopause" as 2nd arg)
REM =====================================================================
setlocal

set IP=192.168.100.54
if not "%~1"=="" set IP=%~1

set ADB=
if exist "%~dp0platform-tools\adb.exe" set ADB="%~dp0platform-tools\adb.exe"
if "%ADB%"=="" set ADB=adb.exe

echo.
echo  [1/6] Connecting to treadmill at %IP%:5555 ...
%ADB% connect %IP%:5555
%ADB% -s %IP%:5555 get-state >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] Treadmill not reachable. Is it switched on, same IP?
    goto :end
)
set ADB=%ADB% -s %IP%:5555

REM ── Snapshot BEFORE state so any change can be reviewed/reverted ──────
set SNAP=%~dp0state_before_remove.txt
(
  echo --- disabled packages
  %ADB% shell pm list packages -d
  echo --- ifit / trailrunner / termux packages
  %ADB% shell "pm list packages | grep -i -E 'ifit|silverhouse|termux|launcher'"
  echo --- home resolves to
  %ADB% shell cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME
  echo --- focus
  %ADB% shell "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"
  echo --- adb props
  %ADB% shell "getprop | grep -i adb"
) > "%SNAP%" 2>&1
echo        Before-state saved: %SNAP%

REM ── Keep Wi-Fi ADB across reboots (from keranm/strideApp unchain.sh).
REM    Without this port 5555 is gone after a power cycle. Requested by the
REM    owner 2026-10-22. Non-fatal: verified below, build may refuse it.
echo  [1b] Making Wi-Fi ADB persistent across reboots...
%ADB% shell settings put global adb_enabled 1
%ADB% shell settings put global development_settings_enabled 1
%ADB% shell setprop persist.adb.tcp.port 5555
for /f "delims=" %%V in ('%ADB% shell getprop persist.adb.tcp.port') do set PERSIST=%%V
echo        persist.adb.tcp.port = %PERSIST%
if not "%PERSIST%"=="5555" echo   [WARN] Build refused persist. After a reboot re-enable USB debugging and reconnect.

echo  [2/6] Disabling TR Bridge boot chooser + stopping bridge...
%ADB% shell am force-stop com.silverhouse3.trailrunnerbridge 2>nul
%ADB% shell pm disable-user --user 0 com.silverhouse3.trailrunnerbridge 2>nul
%ADB% shell am force-stop com.silverhouse3.trailrunner 2>nul
%ADB% shell pm disable-user --user 0 com.silverhouse3.trailrunner 2>nul
%ADB% shell "pkill -f trailrunner-bridge" 2>nul

echo  [3/6] Removing Termux boot script...
%ADB% shell "rm -f /data/data/com.termux/files/home/.termux/boot/trailrunner.sh" 2>nul
%ADB% shell "rm -f /sdcard/trailrunner/boot-selector.html" 2>nul

echo  [4/6] Re-enabling iFIT packages...
for %%P in (com.ifit.glassos_service com.ifit.eru com.ifit.launcher com.ifit.standalone com.ifit.arda com.ifit.gandalf com.ifit.mithlond com.ifit.rivendell) do (
    %ADB% shell pm enable %%P
)

echo  [5/6] Restoring iFIT as the only home screen...
%ADB% shell pm list packages -e | findstr /x "package:com.ifit.launcher" >nul 2>&1
if errorlevel 1 (
    echo   [WARN] com.ifit.launcher is NOT enabled - leaving Android launcher ON
    echo          so the treadmill still has a home screen. NOT rebooting.
    goto :verify
)
%ADB% shell pm disable-user --user 0 com.android.launcher3 2>nul

:verify
echo.
echo  --- Disabled packages now ---
%ADB% shell pm list packages -d
echo  --- Home screen resolves to ---
%ADB% shell cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME 2>nul | findstr /i "packageName name="
%ADB% shell pm list packages -e | findstr /x "package:com.ifit.launcher" >nul 2>&1
if errorlevel 1 goto :end

echo.
echo  [6/6] Rebooting treadmill - iFIT should appear in about a minute.
%ADB% reboot

:end
echo.
if /i not "%~2"=="nopause" pause
