@echo off
REM =====================================================================
REM  SETUP DUAL BOOT — Boot selector for TrailRunner OR iFit
REM
REM  Unlike DO_EVERYTHING.cmd which fully disables iFit, this script
REM  keeps iFit available as a launchable app. On boot, a selector
REM  screen lets you choose between TrailRunner and iFit.
REM
REM  Prerequisites:
REM    - ADB (platform-tools) in same folder or on PATH
REM    - Treadmill in Developer Mode with USB debugging ON
REM    - Treadmill and PC on the same WiFi
REM    - Node.js installed in Termux (for boot launcher service)
REM
REM  To undo everything: run RESTORE_IFIT.cmd
REM
REM =====================================================================

setlocal enabledelayedexpansion

REM ── Configuration ──────────────────────────────────────────────────────
set IP=192.168.100.54

REM Find ADB
set ADB=
if exist "%~dp0adb.exe" set ADB="%~dp0adb.exe"
if exist "%~dp0platform-tools\adb.exe" set ADB="%~dp0platform-tools\adb.exe"
if "%ADB%"=="" (
    where adb.exe >nul 2>&1
    if not errorlevel 1 (
        set ADB=adb.exe
    ) else (
        echo.
        echo   [ERROR] Cannot find adb.exe
        echo   Put this script in the same folder as platform-tools\
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  =====================================================
echo   TrailRunner X32i DUAL BOOT Setup
echo  =====================================================
echo.
echo   This sets up a boot selector so you can choose
echo   between TrailRunner and iFit on every startup.
echo.
echo   Treadmill IP: %IP%
echo   ADB: %ADB%
echo.

REM ── Step 1: Connect ────────────────────────────────────────────────────

echo  [1/8] Connecting to treadmill at %IP%:5555 ...
%ADB% connect %IP%:5555
echo.
echo   If the treadmill shows "Allow USB debugging?" tick Always allow and tap OK.
echo   Press any key to continue...
pause >nul
echo.

REM ── Step 2: Device info + backup ───────────────────────────────────────

echo  [2/8] Backing up current state...

for /f "tokens=*" %%a in ('%ADB% shell getprop ro.build.version.release') do set ANDROID_VER=%%a
for /f "tokens=*" %%a in ('%ADB% shell getprop ro.product.model') do set MODEL=%%a

echo        Device: %MODEL%
echo        Android: %ANDROID_VER%

%ADB% shell pm list packages -e > "%~dp0backup_enabled_packages.txt" 2>nul
%ADB% shell pm list packages -d > "%~dp0backup_disabled_packages.txt" 2>nul
echo        Package lists saved.
echo.

REM ── Step 3: Check browser ──────────────────────────────────────────────

echo  [3/8] Checking for browser...

set HAS_BROWSER=0
for %%B in (com.android.browser com.android.chrome org.chromium.chrome) do (
    %ADB% shell pm list packages -e 2>nul | findstr /i "%%B" >nul 2>&1
    if not errorlevel 1 (
        set HAS_BROWSER=1
        echo        Browser: %%B [OK]
    )
)

if %HAS_BROWSER%==0 (
    echo   [WARNING] No browser found. Install Chrome first.
    pause
    exit /b 1
)
echo.

REM ── Step 4: Enable stock launcher ──────────────────────────────────────

echo  [4/8] Enabling stock Android launcher...

%ADB% shell pm enable com.android.launcher3 2>nul

set LAUNCHER_READY=0
%ADB% shell pm list packages -e 2>nul | findstr /i "com.android.launcher3" >nul 2>&1
if not errorlevel 1 set LAUNCHER_READY=1

if %LAUNCHER_READY%==0 (
    echo   [ERROR] Could not enable stock launcher. Aborting.
    pause
    exit /b 1
)
echo        Stock launcher: ENABLED [OK]
echo.

REM ── Step 5: Disable iFit LAUNCHER only (keep the app!) ─────────────────

echo  [5/8] Disabling iFit launcher (keeping iFit app available)...
echo.
echo        Only disabling the kiosk launcher, NOT the workout app.
echo        You'll still be able to open iFit from the boot selector.
echo.

REM Disable the iFit launcher/kiosk (locks you into iFit)
for %%P in (com.ifit.launcher com.ifit.standalone) do (
    %ADB% shell pm list packages -e 2>nul | findstr /i "%%P" >nul 2>&1
    if not errorlevel 1 (
        echo        Disabling %%P ...
        %ADB% shell pm disable-user --user 0 %%P 2>nul
    ) else (
        echo        %%P already disabled.
    )
)

REM KEEP com.ifit.eru ENABLED — this is the actual workout app
echo.
echo        com.ifit.eru: KEPT ENABLED (launchable from selector)
echo        com.ifit.glassos_service: KEPT ENABLED (hardware control)
echo.

REM ── Step 6: Push boot selector files to device ─────────────────────────

echo  [6/8] Pushing boot selector files to treadmill...

%ADB% shell "mkdir -p /sdcard/trailrunner" 2>nul

REM Push the boot selector HTML
%ADB% push "%~dp0..\boot-selector.html" /sdcard/trailrunner/boot-selector.html 2>nul
echo        boot-selector.html pushed.

REM Push the boot launcher service
%ADB% push "%~dp0..\bridge\boot-launcher.js" /sdcard/trailrunner/boot-launcher.js 2>nul
echo        boot-launcher.js pushed.

echo.

REM ── Step 7: Activate home screen ───────────────────────────────────────

echo  [7/8] Activating home screen...
%ADB% shell input keyevent KEYCODE_HOME 2>nul

echo.
echo   *** CHECK THE TREADMILL ***
echo   You should see the Android home screen (or a launcher picker).
echo   If asked to choose a launcher, pick "Launcher3" and tap "Always".
echo.
echo   Press any key to continue...
pause >nul
echo.

REM ── Step 8: Set up auto-launch boot script ─────────────────────────────

echo  [8/8] Setting up boot selector auto-launch...

REM Check for Termux
%ADB% shell pm list packages 2>nul | findstr termux >nul 2>&1
if not errorlevel 1 (
    echo        Termux found — configuring dual-boot script...
    %ADB% shell "mkdir -p /data/data/com.termux/files/home/.termux/boot" 2>nul

    REM Create the boot script that launches both the service and the selector
    %ADB% shell "cat > /data/data/com.termux/files/home/.termux/boot/trailrunner.sh" <<'BOOTEOF'
#!/data/data/com.termux/files/usr/bin/sh

# Wait for Android to finish booting
sleep 20

# Start the boot launcher service (handles iFit launch requests)
node /sdcard/trailrunner/boot-launcher.js &

# Wait a moment for the service to start
sleep 2

# Open the boot selector page in the browser
am start -a android.intent.action.VIEW -d "file:///sdcard/trailrunner/boot-selector.html"
BOOTEOF

    %ADB% shell "chmod +x /data/data/com.termux/files/home/.termux/boot/trailrunner.sh" 2>nul
    echo        Boot selector will auto-launch on every reboot.
) else (
    echo        Termux not installed — creating manual launch script only.
    %ADB% shell "cat > /sdcard/trailrunner/launch-selector.sh" <<'LAUNCHEOF'
#!/system/bin/sh
am start -a android.intent.action.VIEW -d "file:///sdcard/trailrunner/boot-selector.html"
LAUNCHEOF
    echo        Run manually: sh /sdcard/trailrunner/launch-selector.sh
)

REM Also launch the selector now so the user can see it
echo.
echo   Launching boot selector now...
%ADB% shell am start -a android.intent.action.VIEW -d "file:///sdcard/trailrunner/boot-selector.html" 2>nul

echo.
echo  =====================================================
echo   DUAL BOOT SETUP COMPLETE
echo  =====================================================
echo.
echo   On every boot, you'll see a selector with two options:
echo     - TRAILRUNNER: GPX routes, auto-incline, HR zones
echo     - iFIT:        Classes, trainers, programs
echo.
echo   The selector auto-launches your preferred app after 10 seconds.
echo   Tap the gear icon to change the default and countdown time.
echo.
echo   RESTORE:  Double-click RESTORE_IFIT.cmd to undo everything.
echo.
echo   SAFETY:
echo     - Both apps use the same safety key
echo     - Emergency = pull the physical safety key
echo.
pause
