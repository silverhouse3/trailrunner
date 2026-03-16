@echo off
REM =====================================================================
REM  TEST ONLY — Install TrailRunner APK alongside iFIT (no changes to iFIT)
REM
REM  This is the SAFE option:
REM    - Installs TrailRunner as a separate app
REM    - iFIT stays fully functional
REM    - You can switch between them from the home screen
REM    - To remove TrailRunner: Settings > Apps > TrailRunner > Uninstall
REM
REM  Prerequisites:
REM    - Treadmill in Developer Mode with USB debugging ON
REM    - Treadmill and PC on the same WiFi network
REM
REM =====================================================================

setlocal enabledelayedexpansion

REM ── Configuration ──────────────────────────────────────────────────────
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
        echo.
        pause
        exit /b 1
    )
)

REM Check APK exists
if not exist "%~dp0TrailRunner.apk" (
    echo.
    echo   [ERROR] TrailRunner.apk not found in the same folder as this script.
    echo.
    pause
    exit /b 1
)

echo.
echo  =====================================================
echo   TrailRunner — SAFE TEST INSTALL
echo  =====================================================
echo.
echo   This installs TrailRunner alongside iFIT.
echo   iFIT will NOT be modified or disabled.
echo   You can run both apps and switch between them.
echo.
echo   Treadmill IP: %IP%
echo.

REM ── Step 1: Connect ────────────────────────────────────────────────────

echo  [1/3] Connecting to treadmill at %IP%:5555 ...
%ADB% connect %IP%:5555

REM Verify connection
%ADB% -s %IP%:5555 shell echo "connected" >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [ERROR] Could not connect to treadmill at %IP%:5555
    echo.
    echo   Check:
    echo     1. Is the treadmill powered on?
    echo     2. Is Developer Mode enabled?
    echo     3. Is USB Debugging turned on?
    echo     4. Are both devices on the same WiFi?
    echo.
    echo   To enable Developer Mode:
    echo     - 10 taps on iFit logo, wait 7 seconds, 10 more taps
    echo     - Settings ^> About tablet ^> tap Build Number 7 times
    echo     - Settings ^> Developer Options ^> USB Debugging ON
    echo.
    pause
    exit /b 1
)

echo.
echo   If the treadmill shows "Allow USB debugging?" tick Always Allow and tap OK.
echo   Press any key to continue...
pause >nul
echo.

REM ── Step 2: Install APK ─────────────────────────────────────────────────

echo  [2/3] Installing TrailRunner.apk ...
echo.
echo        (This may take 30-60 seconds on WiFi)
echo.
%ADB% -s %IP%:5555 install -r "%~dp0TrailRunner.apk"

if errorlevel 1 (
    echo.
    echo   [WARNING] Install may have failed.
    echo   If the treadmill asked "Install from unknown sources?" you need to allow it:
    echo     Settings ^> Security ^> Unknown sources ^> ON
    echo   Then run this script again.
    echo.
    pause
    exit /b 1
)

echo.
echo        TrailRunner installed successfully!
echo.

REM ── Step 3: Launch it ───────────────────────────────────────────────────

echo  [3/3] Launching TrailRunner ...
%ADB% -s %IP%:5555 shell am start -n com.silverhouse3.trailrunner/.LauncherActivity 2>nul

echo.
echo  =====================================================
echo   ALL DONE — TrailRunner is running!
echo  =====================================================
echo.
echo   WHAT TO TEST:
echo     - Does the UI load properly on the 32" screen?
echo     - Tap TREADMILL — does it connect to the bridge?
echo     - Tap HR — does it find your heart rate strap?
echo     - Import a GPX route and start a short run
echo.
echo   TO SWITCH BACK TO iFIT:
echo     - Press the Home button (or swipe up from bottom)
echo     - Tap the iFIT icon on the home screen
echo     - iFIT is completely untouched
echo.
echo   TO REMOVE TRAILRUNNER:
echo     - Settings ^> Apps ^> TrailRunner ^> Uninstall
echo     - Or run:  %ADB% -s %IP%:5555 uninstall com.silverhouse3.trailrunner
echo.
pause
