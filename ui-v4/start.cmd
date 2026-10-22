@echo off
rem Windows launcher: starts the ui-v4 static server (8099) and mock bridge (4510) in two console windows.
cd /d "%~dp0"
start "TrailRunner mock bridge :4510" node mock\server.js
start "TrailRunner ui-v4 :8099" node mock\static.js
echo UI:          http://localhost:8099/
echo Mock bridge: http://localhost:4510/mock
echo Close the two console windows to stop.
