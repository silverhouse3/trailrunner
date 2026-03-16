@echo off
REM =====================================================================
REM  CAPTURE VALINOR LOGS — Pull glassos_service log files
REM
REM  The glassos_service writes detailed logs including FitPro packet
REM  hex dumps ("Sending [...]") to its Valinor log directory.
REM  This script pulls those log files for analysis.
REM
REM =====================================================================

setlocal
set IP=192.168.100.54
set OUTPUT=%~dp0valinor_logs

REM Find ADB
set ADB=
if exist "%~dp0adb.exe" set ADB="%~dp0adb.exe"
if exist "D:\Nordic\platform-tools\adb.exe" set ADB="D:\Nordic\platform-tools\adb.exe"
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
echo   Valinor Log Capture
echo  =====================================================
echo.

echo  Connecting to %IP%:5555 ...
%ADB% connect %IP%:5555
echo.

REM Create output directory
if not exist "%OUTPUT%" mkdir "%OUTPUT%"

echo  Pulling current log file...
%ADB% pull "/sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt" "%OUTPUT%\log.latest.txt" 2>nul
if errorlevel 1 (
    echo  Trying alternate path...
    %ADB% pull "/sdcard/Android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt" "%OUTPUT%\log.latest.txt" 2>nul
)

echo  Pulling archived logs...
%ADB% pull "/sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/archives/" "%OUTPUT%\archives\" 2>nul
%ADB% pull "/sdcard/Android/data/com.ifit.glassos_service/files/.valinorlogs/archives/" "%OUTPUT%\archives\" 2>nul

echo  Pulling eru logs...
%ADB% pull "/sdcard/eru/" "%OUTPUT%\eru\" 2>nul

echo  Pulling wolf logs (legacy)...
%ADB% pull "/sdcard/.wolflogs/" "%OUTPUT%\wolflogs\" 2>nul

echo.
echo  =====================================================
echo   ANALYSIS
echo  =====================================================
echo.

echo  Searching for packet hex dumps...
findstr /i "Sending \[ " "%OUTPUT%\log.latest.txt" > "%OUTPUT%\packet_dumps.txt" 2>nul
echo  Found packet dumps:
find /c /v "" "%OUTPUT%\packet_dumps.txt" 2>nul

echo.
echo  Searching for speed/incline changes...
findstr /i "Changed KPH Changed Grade TARGET_KPH TARGET_GRADE" "%OUTPUT%\log.latest.txt" > "%OUTPUT%\speed_incline.txt" 2>nul
echo  Found speed/incline events:
find /c /v "" "%OUTPUT%\speed_incline.txt" 2>nul

echo.
echo  Searching for BitField communications...
findstr /i "BitFieldCommItem BitField" "%OUTPUT%\log.latest.txt" > "%OUTPUT%\bitfield_comms.txt" 2>nul
echo  Found BitField comms:
find /c /v "" "%OUTPUT%\bitfield_comms.txt" 2>nul

echo.
echo  All logs saved to: %OUTPUT%\
echo.
echo  KEY FILES TO ANALYZE:
echo    %OUTPUT%\packet_dumps.txt     — Raw FitPro packets (hex bytes)
echo    %OUTPUT%\speed_incline.txt    — Speed/incline change events
echo    %OUTPUT%\bitfield_comms.txt   — BitField read/write operations
echo    %OUTPUT%\log.latest.txt       — Complete current log
echo.
pause
