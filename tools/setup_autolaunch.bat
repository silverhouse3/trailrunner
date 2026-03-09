@echo off
REM ═══════════════════════════════════════════════════════════════════════════
REM TrailRunner Auto-Launch Setup for NordicTrack X32i
REM ═══════════════════════════════════════════════════════════════════════════
REM
REM Run this from a Windows PC on the same WiFi as the treadmill.
REM It connects via ADB and sets up TrailRunner to launch automatically.
REM
REM Usage:
REM   setup_autolaunch.bat [TREADMILL_IP]
REM
REM Example:
REM   setup_autolaunch.bat 192.168.1.42
REM
REM ═══════════════════════════════════════════════════════════════════════════

setlocal

if "%1"=="" (
    echo.
    echo  TrailRunner Auto-Launch Setup
    echo  ─────────────────────────────
    echo.
    echo  Usage: setup_autolaunch.bat [TREADMILL_IP]
    echo.
    echo  Find the IP: On the treadmill, go to
    echo    Settings ^> About tablet ^> Status ^> IP address
    echo.
    set /p TREADMILL_IP="  Enter treadmill IP address: "
) else (
    set TREADMILL_IP=%1
)

echo.
echo  Connecting to X32i at %TREADMILL_IP%:5555 ...
echo.

REM Connect to the treadmill via ADB over WiFi
adb connect %TREADMILL_IP%:5555
if errorlevel 1 (
    echo.
    echo  [ERROR] Could not connect. Check:
    echo    1. Treadmill and PC are on the same WiFi
    echo    2. Privileged mode is enabled on the treadmill
    echo    3. Developer options + USB debugging are ON
    echo    4. You accepted the USB debugging prompt on the treadmill
    echo.
    pause
    exit /b 1
)

echo.
echo  Connected. Setting up auto-launch...
echo.

REM ── Step 1: Launch TrailRunner now ─────────────────────────────────────────
echo  [1/4] Launching TrailRunner in Chromium...
adb shell am start -a android.intent.action.VIEW -d "https://silverhouse3.github.io/trailrunner" com.android.chrome
if errorlevel 1 (
    REM Try Chromium package name instead
    adb shell am start -a android.intent.action.VIEW -d "https://silverhouse3.github.io/trailrunner" org.chromium.chrome
    if errorlevel 1 (
        REM Fallback: any browser
        adb shell am start -a android.intent.action.VIEW -d "https://silverhouse3.github.io/trailrunner"
    )
)

REM ── Step 2: Create the auto-launch script on the device ────────────────────
echo  [2/4] Creating auto-launch script on device...
adb shell "mkdir -p /sdcard/trailrunner"

REM Create a shell script that launches TrailRunner
adb shell "echo '#!/system/bin/sh' > /sdcard/trailrunner/launch.sh"
adb shell "echo 'sleep 15' >> /sdcard/trailrunner/launch.sh"
adb shell "echo 'am start -a android.intent.action.VIEW -d https://silverhouse3.github.io/trailrunner' >> /sdcard/trailrunner/launch.sh"
adb shell "chmod 755 /sdcard/trailrunner/launch.sh"

REM ── Step 3: Set up Tasker/Automate auto-launch (if available) ──────────────
echo  [3/4] Checking for automation apps...

REM Check if Termux is installed (bundled with NordicUnchained)
adb shell pm list packages | findstr termux >nul 2>&1
if not errorlevel 1 (
    echo         Termux found. Creating boot script...
    adb shell "mkdir -p /data/data/com.termux/files/home/.termux/boot"
    adb shell "echo '#!/data/data/com.termux/files/usr/bin/sh' > /data/data/com.termux/files/home/.termux/boot/trailrunner.sh"
    adb shell "echo 'sleep 20' >> /data/data/com.termux/files/home/.termux/boot/trailrunner.sh"
    adb shell "echo 'am start -a android.intent.action.VIEW -d https://silverhouse3.github.io/trailrunner' >> /data/data/com.termux/files/home/.termux/boot/trailrunner.sh"
    adb shell "chmod 755 /data/data/com.termux/files/home/.termux/boot/trailrunner.sh"
    echo         Termux boot script installed.
) else (
    echo         Termux not found — skipping boot script.
    echo         For auto-launch on boot, install Termux:Boot from F-Droid.
)

REM ── Step 4: Set Chrome homepage ────────────────────────────────────────────
echo  [4/4] Setting Chrome homepage preference...
REM This creates a preference file that sets the homepage
adb shell "settings put global setup_wizard_has_run 1" >nul 2>&1

echo.
echo  ═══════════════════════════════════════════════════════════════════════
echo  Setup complete!
echo  ═══════════════════════════════════════════════════════════════════════
echo.
echo  TrailRunner should now be open in Chromium on the treadmill.
echo.
echo  To install as a PWA (recommended for fullscreen):
echo    1. In Chrome on the treadmill, tap the menu (three dots)
echo    2. Tap "Add to Home screen" or "Install app"
echo    3. TrailRunner will appear as a standalone app
echo.
echo  To re-launch TrailRunner at any time via ADB:
echo    adb shell am start -a android.intent.action.VIEW ^
echo      -d "https://silverhouse3.github.io/trailrunner"
echo.
echo  To launch locally (if you're serving from your PC):
echo    adb shell am start -a android.intent.action.VIEW ^
echo      -d "http://YOUR_PC_IP:8080"
echo.

pause
