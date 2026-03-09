@echo off
REM =====================================================================
REM  CAPTURE PROTOCOL — Sniff FitPro USB packets from glassos_service
REM
REM  This captures the actual byte-level protocol between the Android
REM  tablet and the motor controller. Run this while the treadmill is
REM  running and changing speed/incline.
REM
REM  Steps:
REM    1. Connect to treadmill via ADB
REM    2. Start logcat capture filtered for glassos_service
REM    3. Open iFIT and start a workout, change speed/incline
REM    4. Press Ctrl+C when done
REM    5. The capture is saved to protocol_capture.txt
REM
REM =====================================================================

setlocal
set IP=192.168.100.54
set OUTPUT=%~dp0protocol_capture.txt

REM Find ADB
set ADB=
if exist "%~dp0adb.exe" set ADB="%~dp0adb.exe"
if exist "%~dp0platform-tools\adb.exe" set ADB="%~dp0platform-tools\adb.exe"
if "%ADB%"=="" (
    where adb.exe >nul 2>&1
    if not errorlevel 1 (
        set ADB=adb.exe
    ) else (
        echo [ERROR] Cannot find adb.exe
        pause
        exit /b 1
    )
)

echo.
echo  =====================================================
echo   FitPro Protocol Capture
echo  =====================================================
echo.
echo  Connecting to %IP%:5555 ...
%ADB% connect %IP%:5555

echo.
echo  Clearing logcat buffer...
%ADB% logcat -c

echo.
echo  =====================================================
echo   CAPTURING - Do these steps on the treadmill:
echo  =====================================================
echo.
echo   1. Open iFIT app
echo   2. Start a quick workout (any will do)
echo   3. Wait 10 seconds (capture idle traffic)
echo   4. Change speed up by 1 (note the target speed)
echo   5. Wait 5 seconds
echo   6. Change speed up by 1 again
echo   7. Wait 5 seconds
echo   8. Change incline up by 5
echo   9. Wait 5 seconds
echo   10. Change incline down by 5
echo   11. Wait 5 seconds
echo   12. Stop the workout
echo   13. Come back and press Ctrl+C here
echo.
echo  Saving to: %OUTPUT%
echo.
echo  Press Ctrl+C when done capturing...
echo.

REM Capture ALL glassos_service related logs
REM The "Sending [" and "Not sending [" lines contain actual packet bytes
REM Also capture BitFieldCommItem, KPH, Grade, speed, incline related messages
%ADB% logcat -v time *:V 2>&1 | findstr /i "glassos sindarin fitpro Sending BitField KPH Grade speed incline CURRENT TARGET Changed USB bulk control" > "%OUTPUT%"

echo.
echo  Capture saved to: %OUTPUT%
echo  Size:
dir /b "%OUTPUT%" 2>nul
echo.
echo  Please send this file for protocol analysis.
echo.
pause
