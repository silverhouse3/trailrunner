@echo off
REM =====================================================================
REM  SET_MODE — make the treadmill run EITHER stock iFIT OR TrailRunner,
REM  never both at once (the overlap is what caused the boot overlay).
REM
REM    SET_MODE.cmd ifit        iFIT only. TrailRunner boot hooks disabled,
REM                             iFIT launcher/eru/standalone enabled and
REM                             iFIT is the only home screen.
REM    SET_MODE.cmd trailrunner TrailRunner only. iFIT launcher/eru/standalone
REM                             disabled (eru is the "draw over" lockout),
REM                             stock launcher + TR Bridge enabled.
REM    SET_MODE.cmd status      Show current mode, change nothing.
REM
REM  Always kept ON in both modes: com.ifit.glassos_service (the motor
REM  controller both sides talk to), and the other iFIT background services.
REM  Wi-Fi ADB on :5555 is never touched.
REM
REM  Safety: a home screen is enabled and verified BEFORE the other one is
REM  disabled, so the treadmill can never be left with no launcher. Every
REM  step is checked; on any failure it stops and changes nothing further.
REM  Needs: iFIT launcher + standalone enabled once from the treadmill's
REM  own Settings (adb cannot enable packages in the plain "disabled" state).
REM
REM  Usage: SET_MODE.cmd <ifit|trailrunner|status> [ip] [nopause]
REM =====================================================================
setlocal enabledelayedexpansion

set MODE=%~1
set IP=192.168.100.54
if not "%~2"=="" set IP=%~2
set TR=com.silverhouse3.trailrunnerbridge
set TR2=com.silverhouse3.trailrunner
set PWA=https://silverhouse3.github.io/trailrunner/

if "%MODE%"=="" goto :usage
if /i not "%MODE%"=="ifit" if /i not "%MODE%"=="trailrunner" if /i not "%MODE%"=="status" goto :usage

set ADB=
if exist "%~dp0platform-tools\adb.exe" set ADB="%~dp0platform-tools\adb.exe"
if "%ADB%"=="" set ADB=adb.exe

%ADB% connect %IP%:5555 >nul 2>&1
%ADB% -s %IP%:5555 get-state >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Treadmill not reachable at %IP%:5555.
    goto :end
)
set ADB=%ADB% -s %IP%:5555

if /i "%MODE%"=="status" goto :status
if /i "%MODE%"=="ifit" goto :ifit
goto :trailrunner

REM ───────────────────────────── iFIT ONLY ─────────────────────────────
:ifit
echo  Switching to iFIT ONLY...
call :enable com.ifit.launcher   || goto :fail
call :enable com.ifit.standalone || goto :fail
call :enable com.ifit.eru        || goto :fail
call :must_be_enabled com.ifit.launcher || goto :fail
echo  Stopping TrailRunner side...
%ADB% shell am force-stop %TR% >nul 2>&1
%ADB% shell pm disable-user --user 0 %TR% >nul 2>&1
%ADB% shell am force-stop %TR2% >nul 2>&1
%ADB% shell pm disable-user --user 0 %TR2% >nul 2>&1
%ADB% shell "pkill -f trailrunner-bridge" >nul 2>&1
echo  iFIT launcher confirmed - making it the only home screen...
%ADB% shell pm disable-user --user 0 com.android.launcher3 >nul 2>&1
goto :status_then_reboot_note

REM ──────────────────────────── TRAILRUNNER ONLY ───────────────────────
:trailrunner
echo  Switching to TRAILRUNNER ONLY...
call :enable com.android.launcher3 || goto :fail
call :must_be_enabled com.android.launcher3 || goto :fail
call :enable %TR% || goto :fail
call :enable %TR2% || goto :fail
echo  Disabling iFIT front-end (launcher, standalone, eru)...
for %%P in (com.ifit.launcher com.ifit.standalone com.ifit.eru) do (
    %ADB% shell pm disable-user --user 0 %%P >nul 2>&1
)
REM glassos_service (motor controller) deliberately left running.
%ADB% shell pm enable com.ifit.glassos_service >nul 2>&1
goto :status_then_reboot_note

:status_then_reboot_note
echo.
echo  Reboot to apply cleanly:  %ADB% reboot
:status
echo.
echo  --- Mode check ---
for %%P in (com.ifit.launcher com.ifit.standalone com.ifit.eru com.ifit.glassos_service %TR% com.android.launcher3) do (
    %ADB% shell pm list packages -e | findstr /x "package:%%P" >nul 2>&1
    if errorlevel 1 (echo    %%P : DISABLED) else (echo    %%P : enabled)
)
echo  --- Home screen resolves to ---
%ADB% shell cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME 2>nul | findstr /i "packageName"
goto :end

REM ───────────────────────────── helpers ──────────────────────────────
:enable
%ADB% shell pm enable %1 2>&1 | findstr /i "SecurityException" >nul
if not errorlevel 1 (
    echo  [ERROR] adb cannot enable %1 ^(plain-disabled state^).
    echo          Enable it once from the treadmill: Settings ^> Apps ^> %1 ^> Enable
    exit /b 1
)
exit /b 0

:must_be_enabled
%ADB% shell pm list packages -e | findstr /x "package:%1" >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] %1 is not enabled - refusing to continue ^(would leave no home screen^).
    exit /b 1
)
exit /b 0

:fail
echo.
echo  [STOPPED] Nothing further was changed. See message above.
goto :end

:usage
echo  Usage: SET_MODE.cmd ^<ifit^|trailrunner^|status^> [ip] [nopause]
goto :end

:end
echo.
if /i not "%~3"=="nopause" pause
endlocal
