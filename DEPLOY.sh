#!/bin/bash
# ════════════════════════════════════════════════════════════════════════════
# TrailRunner — Full Deployment Script
# Builds and deploys everything to the NordicTrack X32i treadmill.
# No PC needed after deployment — everything runs on the treadmill.
# ════════════════════════════════════════════════════════════════════════════
set -e

ADB="/mnt/d/trailrunner/tools/platform-tools/adb.exe"
TREADMILL_IP="192.168.100.54"
BRIDGE_DIR="/mnt/d/trailrunner/bridge"
APK_DIR="$BRIDGE_DIR/apk"
GRPC_DIR="$BRIDGE_DIR/grpc-bridge"
KEYS_DIR="$BRIDGE_DIR/keys"

echo ""
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║  TrailRunner — Full Deployment                              ║"
echo "  ║  APK + gRPC Bridge + mTLS Keys + PWA                       ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Connect ADB ──────────────────────────────────────────────────────────

echo "[1/6] Connecting to treadmill..."
"$ADB" connect "$TREADMILL_IP:5555"
echo ""

# ── 2. Build APK ────────────────────────────────────────────────────────────

echo "[2/6] Building APK..."
cd "$APK_DIR"
bash build.sh
echo ""

# ── 3. Cross-compile gRPC bridge ────────────────────────────────────────────

echo "[3/6] Building gRPC bridge (ARM64)..."
cd "$GRPC_DIR"
export PATH="/home/rwood/go-install/go/bin:/home/rwood/go/bin:$PATH"
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 /home/rwood/go-install/go/bin/go build -ldflags="-s -w" -o trailrunner-bridge .
ls -lh trailrunner-bridge
echo ""

# ── 4. Deploy APK ───────────────────────────────────────────────────────────

echo "[4/6] Installing APK..."
"$ADB" install -r "D:\\trailrunner\\bridge\\apk\\build\\trailrunner-bridge.apk"

# Re-enable accessibility service
"$ADB" shell settings put secure enabled_accessibility_services \
  "com.ifit.glassos_service/com.ifit.glassos_appnavigation_service.service.AccessibilityServiceImpl:com.silverhouse3.trailrunnerbridge/.BridgeAccessibilityService"
"$ADB" shell settings put secure accessibility_enabled 1

# Grant permissions
"$ADB" shell appops set com.silverhouse3.trailrunnerbridge SYSTEM_ALERT_WINDOW allow
"$ADB" shell pm grant com.silverhouse3.trailrunnerbridge android.permission.READ_EXTERNAL_STORAGE 2>/dev/null
"$ADB" shell pm grant com.silverhouse3.trailrunnerbridge android.permission.WRITE_EXTERNAL_STORAGE 2>/dev/null
echo ""

# ── 5. Deploy gRPC bridge + keys ────────────────────────────────────────────

echo "[5/6] Deploying gRPC bridge and keys..."

# Stop any running bridge
"$ADB" shell "killall trailrunner-bridge 2>/dev/null || true"

# Push bridge binary
"$ADB" push "$GRPC_DIR/trailrunner-bridge" /data/local/tmp/trailrunner-bridge
"$ADB" shell chmod 755 /data/local/tmp/trailrunner-bridge

# Push keys
"$ADB" shell mkdir -p /sdcard/trailrunner/keys
"$ADB" push "$KEYS_DIR/ca_cert.txt" /sdcard/trailrunner/keys/
"$ADB" push "$KEYS_DIR/cert.txt" /sdcard/trailrunner/keys/
"$ADB" push "$KEYS_DIR/key.txt" /sdcard/trailrunner/keys/
echo ""

# ── 6. Start everything ─────────────────────────────────────────────────────

echo "[6/6] Starting services..."

# Start the APK (which auto-starts the gRPC bridge)
"$ADB" shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity
echo ""

# Wait for bridge to start
sleep 3

# ── Verify ───────────────────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════════════════"
echo "  Deployment complete!"
echo ""
echo "  Services:"
echo "    APK HTTP server:  http://treadmill:4511"
echo "    gRPC bridge:      http://treadmill:4510"
echo "    glassos gRPC:     localhost:54321 (on treadmill)"
echo ""
echo "  Boot chooser will appear on next reboot."
echo "  Select 'TrailRunner PWA' to launch Chrome."
echo "  Select 'iFIT (Normal)' for standard iFIT."
echo ""
echo "  Bridge log: adb shell cat /sdcard/trailrunner/bridge.log"
echo "══════════════════════════════════════════════════════════════"
echo ""

# Show bridge log
echo "Bridge startup log:"
"$ADB" shell "cat /sdcard/trailrunner/bridge.log 2>/dev/null | tail -15" || echo "(bridge may still be starting)"
echo ""
