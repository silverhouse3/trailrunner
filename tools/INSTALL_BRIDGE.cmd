@echo off
REM =====================================================================
REM  INSTALL BRIDGE — Install the TrailRunner hardware bridge
REM
REM  This installs the components needed for TrailRunner to communicate
REM  with the NordicTrack X32i motor controller.
REM
REM  Architecture:
REM    TrailRunner (browser) --WebSocket--> Bridge (Node.js) --logs/swipe--> Hardware
REM
REM  Components installed:
REM    1. QZCompanion APK — reads glassos_service logs, controls via input swipe
REM    2. Termux APK — provides Linux environment for running bridge script
REM    3. Bridge script — WebSocket server that connects TrailRunner to QZCompanion
REM
REM  Prerequisites:
REM    - ADB connected to treadmill (run DO_EVERYTHING.cmd first, or have ADB ready)
REM    - Treadmill IP address configured below
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
        echo   Put platform-tools in the same folder or add to PATH.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  =====================================================
echo   TrailRunner Bridge Installation
echo  =====================================================
echo.
echo   Treadmill IP: %IP%
echo.

REM ── Step 1: Connect ────────────────────────────────────────────────────

echo  [1/5] Connecting to treadmill...
%ADB% connect %IP%:5555
if errorlevel 1 (
    echo   [ERROR] Could not connect to treadmill.
    pause
    exit /b 1
)
echo.

REM ── Step 2: Check iFIT services ────────────────────────────────────────

echo  [2/5] Checking iFIT services...
echo.

%ADB% shell "ps | grep glassos" >nul 2>&1
if errorlevel 1 (
    echo   [WARNING] glassos_service is NOT running!
    echo   The bridge needs glassos_service for hardware communication.
    echo   Re-enabling com.ifit.glassos_service...
    %ADB% shell pm enable com.ifit.glassos_service 2>nul
    echo.
) else (
    echo   glassos_service: RUNNING [OK]
)

REM Check for log file
%ADB% shell "ls /sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt" >nul 2>&1
if errorlevel 1 (
    %ADB% shell "ls /sdcard/Android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt" >nul 2>&1
    if errorlevel 1 (
        echo   [WARNING] No glassos_service log file found.
        echo   The bridge may not be able to read speed/incline data.
    ) else (
        echo   Log file: FOUND [OK]
    )
) else (
    echo   Log file: FOUND [OK]
)
echo.

REM ── Step 3: Install QZCompanion (if not already installed) ─────────────

echo  [3/5] Checking QZCompanion...
%ADB% shell pm list packages 2>nul | findstr qzcompanion >nul 2>&1
if errorlevel 1 (
    echo   QZCompanion not installed.
    echo.
    echo   Please download QZCompanion APK from:
    echo   https://github.com/cagnulein/QZCompanionNordictrackTreadmill/releases
    echo.
    echo   Then place the APK in this folder and rename it to qzcompanion.apk
    echo.

    if exist "%~dp0qzcompanion.apk" (
        echo   Found qzcompanion.apk — installing...
        %ADB% install "%~dp0qzcompanion.apk"
        if errorlevel 1 (
            echo   [WARNING] QZCompanion install failed.
        ) else (
            echo   QZCompanion installed successfully.
        )
    ) else (
        echo   [SKIP] No qzcompanion.apk found in this folder.
        echo   You can install it later manually.
    )
) else (
    echo   QZCompanion: INSTALLED [OK]
)
echo.

REM ── Step 4: Install Termux (if not already installed) ──────────────────

echo  [4/5] Checking Termux...
%ADB% shell pm list packages 2>nul | findstr termux >nul 2>&1
if errorlevel 1 (
    echo   Termux not installed.
    echo.
    echo   Please download Termux APK from:
    echo   https://f-droid.org/en/packages/com.termux/
    echo   (Use F-Droid version, NOT Google Play)
    echo.

    if exist "%~dp0termux.apk" (
        echo   Found termux.apk — installing...
        %ADB% install "%~dp0termux.apk"
        if errorlevel 1 (
            echo   [WARNING] Termux install failed.
        ) else (
            echo   Termux installed successfully.
        )
    ) else (
        echo   [SKIP] No termux.apk found in this folder.
        echo   The bridge can also run from your PC in ADB mode.
    )
) else (
    echo   Termux: INSTALLED [OK]
)
echo.

REM ── Step 5: Push bridge script ─────────────────────────────────────────

echo  [5/5] Pushing bridge script to treadmill...
%ADB% shell "mkdir -p /sdcard/trailrunner" 2>nul
%ADB% push "%~dp0..\bridge\trailrunner-bridge.js" /sdcard/trailrunner/bridge.js 2>nul

if errorlevel 1 (
    echo   [WARNING] Could not push bridge script.
) else (
    echo   Bridge script pushed to /sdcard/trailrunner/bridge.js
)

echo.
echo  =====================================================
echo   INSTALLATION COMPLETE
echo  =====================================================
echo.
echo   OPTION A — Run bridge on treadmill (via Termux):
echo     1. Open Termux on the treadmill
echo     2. Run: pkg install nodejs
echo     3. Run: node /sdcard/trailrunner/bridge.js
echo     4. Open TrailRunner in browser — it will auto-connect
echo.
echo   OPTION B — Run bridge on your PC (via ADB):
echo     1. Install Node.js on your PC
echo     2. Run: node bridge\trailrunner-bridge.js --adb --ip %IP%
echo        (from the trailrunner folder)
echo     3. Open TrailRunner on the treadmill browser
echo        BUT: WebSocket won't reach your PC from treadmill browser.
echo        Use Option A for full functionality.
echo.
echo   OPTION C — Read-only mode (no bridge needed):
echo     TrailRunner can still display routes and record runs.
echo     Use the treadmill's physical buttons for speed/incline.
echo     Connect a BLE heart rate strap for HR data.
echo.
pause
