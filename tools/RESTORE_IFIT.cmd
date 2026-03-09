@echo off
REM =====================================================================
REM  RESTORE iFIT — Undo everything and go back to normal
REM
REM  This reverses everything DO_EVERYTHING.cmd did:
REM    - Re-enables all iFIT apps
REM    - Removes TrailRunner boot scripts
REM    - Reboots the treadmill
REM
REM  After this, your treadmill will be back to its iFIT state.
REM  If this doesn't work, a factory reset definitely will:
REM    Settings > Backup and reset > Factory data reset
REM
REM =====================================================================

setlocal

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
        echo   If you can't run this, do a factory reset on the treadmill:
        echo   Settings, Backup and reset, Factory data reset
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  =====================================================
echo   RESTORE iFIT
echo  =====================================================
echo.
echo   This will undo ALL TrailRunner changes and bring iFIT back.
echo.
echo   Press any key to continue (or close this window to cancel)...
pause >nul
echo.

echo  [1/4] Connecting to treadmill at %IP%:5555 ...
%ADB% connect %IP%:5555
if errorlevel 1 (
    echo.
    echo   [ERROR] Could not connect.
    echo   If the treadmill is stuck, do a factory reset instead:
    echo   Settings, Backup and reset, Factory data reset
    echo.
    pause
    exit /b 1
)
echo.

echo  [2/4] Re-enabling iFIT apps...
echo.
for %%P in (com.ifit.eru com.ifit.launcher com.ifit.standalone com.ifit.glassos_service com.ifit.arda com.ifit.gandalf com.ifit.mithlond com.ifit.rivendell) do (
    echo        Enabling %%P ...
    %ADB% shell pm enable %%P 2>nul
)
echo.
echo        All iFIT apps re-enabled.
echo.

echo  [3/4] Removing TrailRunner files from device...
%ADB% shell "rm -rf /sdcard/trailrunner" 2>nul
%ADB% shell "rm -f /data/data/com.termux/files/home/.termux/boot/trailrunner.sh" 2>nul
echo        Cleaned up.
echo.

echo  [4/4] Rebooting treadmill...
%ADB% reboot 2>nul

echo.
echo  =====================================================
echo   RESTORE COMPLETE
echo  =====================================================
echo.
echo   The treadmill is rebooting now.
echo   iFIT should be back in about 60 seconds.
echo.
echo   If iFIT still doesn't appear, factory reset:
echo     Settings, Backup and reset, Factory data reset
echo.
pause
