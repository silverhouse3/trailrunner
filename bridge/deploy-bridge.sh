#!/bin/bash
# Deploy the TrailRunner gRPC bridge to the treadmill
# Usage: ./deploy-bridge.sh
set -e

ADB="/mnt/d/trailrunner/tools/platform-tools/adb.exe"
TREADMILL_IP="192.168.100.54"
BRIDGE_BIN="/mnt/d/trailrunner/bridge/grpc-bridge/trailrunner-bridge"
KEYS_DIR="/mnt/d/trailrunner/bridge/keys"

echo "=== Deploying TrailRunner Bridge to treadmill ==="

# Connect
echo "[1/5] Connecting ADB..."
"$ADB" connect "$TREADMILL_IP:5555"

# Push binary
echo "[2/5] Pushing bridge binary (12MB)..."
"$ADB" push "$BRIDGE_BIN" /data/local/tmp/trailrunner-bridge
"$ADB" shell chmod 755 /data/local/tmp/trailrunner-bridge

# Push keys
echo "[3/5] Pushing mTLS certificates..."
"$ADB" shell mkdir -p /sdcard/trailrunner/keys
"$ADB" push "$KEYS_DIR/ca_cert.txt" /sdcard/trailrunner/keys/
"$ADB" push "$KEYS_DIR/cert.txt" /sdcard/trailrunner/keys/
"$ADB" push "$KEYS_DIR/key.txt" /sdcard/trailrunner/keys/

# Kill any existing bridge
echo "[4/5] Stopping existing bridge..."
"$ADB" shell "killall trailrunner-bridge 2>/dev/null || true"

# Start bridge
echo "[5/5] Starting bridge..."
"$ADB" shell "nohup /data/local/tmp/trailrunner-bridge > /sdcard/trailrunner/bridge.log 2>&1 &"
sleep 2

# Verify
echo ""
echo "=== Verifying ==="
"$ADB" shell "cat /sdcard/trailrunner/bridge.log | tail -10"
echo ""

# Quick health check
echo "=== Health check ==="
"$ADB" shell "curl -s http://localhost:4510/health 2>/dev/null || echo 'Bridge not responding yet (may take a few seconds)'"
echo ""
echo "=== DEPLOYED ==="
echo ""
echo "Bridge is running on the treadmill at localhost:4510"
echo "PWA should connect WebSocket to: ws://localhost:4510/ws"
echo "REST API: POST /workout/start, /speed, /incline, etc."
