@echo off
REM Emergency restore — re-enables iFIT launcher to fix boot loop
setlocal

set ADB=
if exist "%~dp0platform-tools\adb.exe" set ADB="%~dp0platform-tools\adb.exe"
if "%ADB%"=="" set ADB=adb.exe

set IP=192.168.100.54

echo.
echo  Connecting to treadmill...
%ADB% connect %IP%:5555

echo.
echo  Re-enabling iFIT packages...
%ADB% shell pm enable com.ifit.launcher
%ADB% shell pm enable com.ifit.eru
%ADB% shell pm enable com.ifit.standalone

echo.
echo  Sending reboot...
%ADB% reboot

echo.
echo  DONE. Treadmill will reboot with iFIT restored.
echo.
pause
