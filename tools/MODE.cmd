@echo off
REM =====================================================================
REM  MODE.cmd  -  switch the X32i between plain iFIT and TrailRunner-only
REM
REM    MODE.cmd trailrunner   switch OFF iFit's screen apps (rivendell, gandalf,
REM                           mithlond), checking the motor link after each.
REM                           Rolls back by itself if the link is not "ok".
REM    MODE.cmd ifit          switch them all back ON (always safe, idempotent)
REM    MODE.cmd status        show what is switched off, change nothing
REM
REM  Never touches com.ifit.glassos_service (motor) or com.ifit.launcher (home).
REM  Nothing is uninstalled. Reverse any time with:  MODE.cmd ifit
REM  Start TrailRunner (and its bridge) from the boot choice or the app after
REM  switching; the link check needs the bridge running on :4510.
REM  Usage: MODE.cmd <trailrunner^|ifit^|status> [ip]
REM =====================================================================
setlocal enabledelayedexpansion
set MODE=%~1
set IP=192.168.100.54
if not "%~2"=="" set IP=%~2
if "%MODE%"=="" goto :usage
set ADB="%~dp0platform-tools\adb.exe"
%ADB% connect %IP%:5555 >nul 2>&1
%ADB% -s %IP%:5555 get-state >nul 2>&1
if errorlevel 1 (echo [ERROR] treadmill not reachable at %IP%:5555 & goto :end)
set ADB=%ADB% -s %IP%:5555
if /i "%MODE%"=="status" goto :status
if /i "%MODE%"=="ifit" goto :ifit
if /i "%MODE%"=="trailrunner" goto :tr
goto :usage

:tr
echo Checking the belt is idle and the motor link is ok first...
for /f "delims=" %%H in ('curl -s -m 5 http://%IP%:4510/health') do set HEALTH=%%H
echo %HEALTH% | findstr /c:"\"link\":\"ok\"" >nul || (echo [STOP] bridge not running or link not ok. Start TrailRunner first, then re-run. & goto :end)
echo %HEALTH% | findstr /c:"\"speed\":0" >nul || (echo [STOP] belt is not at 0. Not switching. & goto :end)
for %%P in (rivendell gandalf mithlond) do (
    echo Disabling com.ifit.%%P ...
    %ADB% shell pm disable-user --user 0 com.ifit.%%P
    timeout /t 5 /nobreak >nul
    for /f "delims=" %%H in ('curl -s -m 5 http://%IP%:4510/health') do set HEALTH=%%H
    echo !HEALTH! | findstr /c:"\"link\":\"ok\"" >nul || (echo [FAIL] motor link not ok after %%P - rolling back & goto :ifit)
)
echo OK: TrailRunner-only. iFit screens are off, motor service still running.
goto :status

:ifit
for %%P in (mithlond gandalf rivendell) do %ADB% shell pm enable com.ifit.%%P
echo OK: plain iFit. All iFit screen apps enabled.
goto :status

:status
echo --- currently disabled packages that matter:
%ADB% shell pm list packages -d | findstr /i "ifit silverhouse"
goto :end

:usage
echo Usage: MODE.cmd ^<trailrunner^|ifit^|status^> [ip]

:end
endlocal
