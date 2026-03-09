#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# TrailRunner Launcher — run from any machine with ADB to open TrailRunner
# on the X32i treadmill
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage:
#   ./launch.sh [TREADMILL_IP]
#   ./launch.sh 192.168.1.42
#   ./launch.sh                   (will prompt for IP)
#

TRAILRUNNER_URL="https://silverhouse3.github.io/trailrunner"

if [ -z "$1" ]; then
    read -p "Enter treadmill IP address: " IP
else
    IP="$1"
fi

echo "Connecting to X32i at $IP:5555..."
adb connect "$IP:5555"

if [ $? -ne 0 ]; then
    echo "ERROR: Could not connect. Check WiFi, privileged mode, and USB debugging."
    exit 1
fi

echo "Launching TrailRunner..."
adb shell am start -a android.intent.action.VIEW -d "$TRAILRUNNER_URL" 2>/dev/null

echo "Done. TrailRunner should be open on the treadmill."
