@echo off
REM =====================================================================
REM  TEST SELECTOR — Push and open boot selector WITHOUT touching iFit
REM
REM  This just pushes the boot-selector.html to the treadmill and
REM  opens it in the browser. Nothing is disabled or changed.
REM  Use this to verify the selector UI works on the 32" screen.
REM
REM  Prerequisites:
REM    - ADB authorized (tap Allow on treadmill)
REM    - Treadmill and PC on same WiFi
REM
REM =====================================================================

setlocal

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
        echo   [ERROR] Cannot find adb.exe
        pause
        exit /b 1
    )
)

echo.
echo  =====================================================
echo   Boot Selector TEST (no iFit changes)
echo  =====================================================
echo.

echo  [1/4] Connecting to %IP%:5555 ...
%ADB% connect %IP%:5555
echo.
echo   If you see "Allow USB debugging?" on the treadmill,
echo   tick "Always allow" and tap OK.
echo.
echo   Press any key after authorizing...
pause >nul
echo.

echo  [2/4] Checking connection...
%ADB% devices 2>nul | findstr "%IP%" | findstr "device" >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] Treadmill not authorized. Check the screen and try again.
    pause
    exit /b 1
)
echo        Connected and authorized [OK]
echo.

echo  [3/4] Pushing boot-selector.html to treadmill...
%ADB% shell "mkdir -p /sdcard/trailrunner" 2>nul
%ADB% push "%~dp0..\boot-selector.html" /sdcard/trailrunner/boot-selector.html
echo.

echo  [4/4] Opening in browser...
%ADB% shell am start -a android.intent.action.VIEW -d "file:///sdcard/trailrunner/boot-selector.html"
echo.

echo  =====================================================
echo   CHECK THE TREADMILL
echo  =====================================================
echo.
echo   The boot selector should be open in the browser.
echo   You can access it from the privileged section too:
echo.
echo   Method 1: Open the browser and go to:
echo     file:///sdcard/trailrunner/boot-selector.html
echo.
echo   Method 2: File manager, navigate to:
echo     /sdcard/trailrunner/boot-selector.html
echo.
echo   NOTE: The iFit button won't work yet (iFit is still
echo   the active launcher). This test is just for the UI.
echo   The TrailRunner button WILL navigate to the PWA.
echo.
echo   Press any key when done testing...
pause >nul

REM Offer to re-push if they made changes
echo.
echo   Want to re-push after making changes? (y/n)
set /p REPUSH=
if /i "%REPUSH%"=="y" (
    %ADB% push "%~dp0..\boot-selector.html" /sdcard/trailrunner/boot-selector.html
    %ADB% shell am start -a android.intent.action.VIEW -d "file:///sdcard/trailrunner/boot-selector.html"
    echo   Re-pushed and reopened.
)

echo.
echo   Done. When ready for full setup, run SETUP_DUAL_BOOT.cmd
echo.
pause
