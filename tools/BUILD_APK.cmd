@echo off
REM =====================================================================
REM  BUILD APK — Rebuild the TrailRunner APK from source
REM
REM  Run this after making code changes to rebuild and deploy.
REM  JDK and Android SDK are in twa-build/ (no system install needed).
REM =====================================================================

setlocal

set JAVA_HOME=%~dp0..\twa-build\jdk-17.0.18+8
set ANDROID_HOME=%~dp0..\twa-build\sdk
set PATH=%JAVA_HOME%\bin;%PATH%

echo.
echo  Building TrailRunner APK...
echo.

cd /d "%~dp0..\twa-build"
call gradlew.bat assembleRelease

if errorlevel 1 (
    echo.
    echo  [ERROR] Build failed.
    pause
    exit /b 1
)

copy /y "app\build\outputs\apk\release\app-release.apk" "%~dp0TrailRunner.apk" >nul

echo.
echo  =====================================================
echo   BUILD SUCCESSFUL
echo  =====================================================
echo.
echo   APK: %~dp0TrailRunner.apk
echo.
echo   To install: run TEST_ONLY.cmd
echo.
pause
