@echo off
REM =====================================================================
REM  DO EVERYTHING — Unlock X32i + Install TrailRunner + Auto-Launch
REM
REM  Prerequisites:
REM    - ADB (platform-tools) in same folder or on PATH
REM    - Treadmill in Developer Mode with USB debugging ON
REM    - Treadmill and PC on the same WiFi
REM
REM  What it does:
REM    1. Connects to the treadmill via ADB over WiFi
REM    2. Backs up current state (so you can restore later)
REM    3. Disables iFIT apps (reversible — no system changes)
REM    4. Checks for browser/launcher (X32i has them built in)
REM    5. Opens TrailRunner in the browser
REM    6. Sets up auto-launch script on device
REM
REM  To undo everything: run RESTORE_IFIT.cmd
REM  Nuclear option: factory reset the treadmill
REM
REM =====================================================================

setlocal enabledelayedexpansion

REM ── Configuration ──────────────────────────────────────────────────────
REM Change this to your treadmill's IP address:
set IP=192.168.100.54

REM Find ADB — check same folder, platform-tools subfolder, or PATH
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
        echo   or download ADB from:
        echo   https://developer.android.com/tools/releases/platform-tools
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  =====================================================
echo   TrailRunner X32i Setup
echo  =====================================================
echo.
echo   Treadmill IP: %IP%
echo   ADB: %ADB%
echo.
echo   To change the IP, edit line 30 of this script.
echo.

REM ── Step 1: Connect ────────────────────────────────────────────────────

echo  [1/7] Connecting to treadmill at %IP%:5555 ...
%ADB% connect %IP%:5555
if errorlevel 1 (
    echo.
    echo   [ERROR] Could not connect to %IP%:5555
    echo.
    echo   Checklist:
    echo     1. Treadmill is ON
    echo     2. PC and treadmill on the same WiFi
    echo     3. Developer options enabled (Settings, About tablet, tap Build number 7x)
    echo     4. USB debugging ON (Settings, Developer options)
    echo     5. IP is correct (Settings, About tablet, Status, IP address)
    echo.
    pause
    exit /b 1
)

echo.
echo   *** CHECK THE TREADMILL SCREEN ***
echo   If you see "Allow USB debugging?" tick "Always allow" and tap OK.
echo   If nothing appeared, that's fine.
echo.
echo   Press any key to continue...
pause >nul

REM Reconnect after potential auth acceptance
%ADB% connect %IP%:5555 >nul 2>&1

REM Verify we have a working shell
%ADB% shell echo "connected" >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [ERROR] Connected but not authorised.
    echo   On the treadmill: Settings, Developer options, Revoke USB debugging authorizations
    echo   Then run this script again.
    echo.
    pause
    exit /b 1
)

echo   Connected and authorised.
echo.

REM ── Step 2: Device info + backup ───────────────────────────────────────

echo  [2/7] Backing up current state...

for /f "tokens=*" %%a in ('%ADB% shell getprop ro.build.version.release') do set ANDROID_VER=%%a
for /f "tokens=*" %%a in ('%ADB% shell getprop ro.product.model') do set MODEL=%%a
for /f "tokens=*" %%a in ('%ADB% shell getprop ro.product.cpu.abi') do set CPU=%%a

echo        Device: %MODEL%
echo        Android: %ANDROID_VER%
echo        CPU: %CPU%

%ADB% shell pm list packages -e > "%~dp0backup_enabled_packages.txt" 2>nul
%ADB% shell pm list packages -d > "%~dp0backup_disabled_packages.txt" 2>nul

echo        Package lists saved to backup_enabled_packages.txt
echo.

REM ── Step 3: Check what's available ─────────────────────────────────────

echo  [3/7] Checking installed apps...

set HAS_BROWSER=0
set HAS_LAUNCHER=0

%ADB% shell pm list packages -e 2>nul | findstr /i "com.android.browser" >nul 2>&1
if not errorlevel 1 (
    set HAS_BROWSER=1
    echo        Browser: com.android.browser [OK]
)
%ADB% shell pm list packages -e 2>nul | findstr /i "com.android.chrome" >nul 2>&1
if not errorlevel 1 (
    set HAS_BROWSER=1
    echo        Browser: com.android.chrome [OK]
)
%ADB% shell pm list packages -e 2>nul | findstr /i "org.chromium.chrome" >nul 2>&1
if not errorlevel 1 (
    set HAS_BROWSER=1
    echo        Browser: org.chromium.chrome [OK]
)

%ADB% shell pm list packages -e 2>nul | findstr /i "launcher" >nul 2>&1
if not errorlevel 1 (
    set HAS_LAUNCHER=1
    echo        Launcher: found [OK]
)

if %HAS_BROWSER%==0 (
    echo.
    echo   [WARNING] No browser found on device.
    echo   You'll need to install Chrome or another browser.
    echo   Download an APK compatible with Android %ANDROID_VER% (arm64)
    echo   then run:  %ADB% install chrome.apk
    echo.
)

if %HAS_LAUNCHER%==0 (
    echo.
    echo   [WARNING] No launcher found on device.
    echo   After disabling iFIT you may see a blank screen.
    echo   Install Nova Launcher:  %ADB% install nova.apk
    echo.
)

echo.

REM ── Step 4: Disable iFIT ───────────────────────────────────────────────

echo  [4/7] Disabling iFIT apps...
echo.
echo        (This is safe. We're using "disable-user" not "uninstall".)
echo        (Factory reset or RESTORE_IFIT.cmd will bring them back.)
echo.

for %%P in (com.ifit.eru com.ifit.launcher com.ifit.standalone) do (
    %ADB% shell pm list packages -e 2>nul | findstr /i "%%P" >nul 2>&1
    if not errorlevel 1 (
        echo        Disabling %%P ...
        %ADB% shell pm disable-user --user 0 %%P 2>nul
    ) else (
        echo        %%P already disabled — skipping.
    )
)

echo.
echo        iFIT apps disabled.
echo.

REM ── Step 5: Activate home screen ───────────────────────────────────────

echo  [5/7] Activating home screen...
%ADB% shell input keyevent KEYCODE_HOME 2>nul

echo.
echo   *** CHECK THE TREADMILL ***
echo   You should see the Android home screen (or a launcher picker).
echo   If asked to choose a launcher, pick one and tap "Always".
echo.
echo   Press any key to continue...
pause >nul
echo.

REM ── Step 6: Open TrailRunner ───────────────────────────────────────────

echo  [6/7] Opening TrailRunner...
%ADB% shell am start -a android.intent.action.VIEW -d "https://silverhouse3.github.io/trailrunner" 2>nul

echo.
echo   *** CHECK THE TREADMILL ***
echo   TrailRunner should be loading in the browser.
echo.
echo   To install as a home screen app (recommended):
echo     1. Tap the three-dot menu in the browser (top right)
echo     2. Tap "Add to Home screen"
echo     3. Tap "Add"
echo.
echo   Press any key to continue...
pause >nul
echo.

REM ── Step 7: Auto-launch script ─────────────────────────────────────────

echo  [7/7] Setting up auto-launch...

%ADB% shell "mkdir -p /sdcard/trailrunner" 2>nul
%ADB% shell "echo '#!/system/bin/sh' > /sdcard/trailrunner/launch.sh" 2>nul
%ADB% shell "echo 'sleep 15' >> /sdcard/trailrunner/launch.sh" 2>nul
%ADB% shell "echo 'am start -a android.intent.action.VIEW -d https://silverhouse3.github.io/trailrunner' >> /sdcard/trailrunner/launch.sh" 2>nul

REM Check for Termux
%ADB% shell pm list packages 2>nul | findstr termux >nul 2>&1
if not errorlevel 1 (
    echo        Termux found — configuring auto-boot...
    %ADB% shell "mkdir -p /data/data/com.termux/files/home/.termux/boot" 2>nul
    %ADB% shell "echo '#!/data/data/com.termux/files/usr/bin/sh' > /data/data/com.termux/files/home/.termux/boot/trailrunner.sh" 2>nul
    %ADB% shell "echo 'sleep 20' >> /data/data/com.termux/files/home/.termux/boot/trailrunner.sh" 2>nul
    %ADB% shell "echo 'am start -a android.intent.action.VIEW -d https://silverhouse3.github.io/trailrunner' >> /data/data/com.termux/files/home/.termux/boot/trailrunner.sh" 2>nul
    echo        TrailRunner will auto-launch on every reboot.
) else (
    echo        Termux not installed — auto-launch on reboot not available.
    echo        You can still open TrailRunner from the home screen icon.
)

echo.
echo  =====================================================
echo   ALL DONE
echo  =====================================================
echo.
echo   TrailRunner is running on your treadmill.
echo.
echo   RESTORE:  Double-click RESTORE_IFIT.cmd to undo everything.
echo   NUCLEAR:  Factory reset (Settings, Backup and reset, Factory data reset).
echo.
echo   USING TRAILRUNNER:
echo     - Tap TREADMILL to connect to the belt motor
echo     - Tap HR to pair a heart rate strap
echo     - Import a GPX route and run!
echo.
echo   SAFETY:
echo     - Pause = belt stops, incline stays
echo     - Finish = belt stops, incline returns to 0%%
echo     - Emergency = pull the physical safety key
echo.
pause
