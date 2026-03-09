#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Serve TrailRunner locally — for when the treadmill has no internet
# ═══════════════════════════════════════════════════════════════════════════
#
# Starts a simple HTTP server on your PC/phone. Then point the treadmill's
# browser to http://YOUR_IP:8080
#
# Usage:
#   ./serve_local.sh              (serves on port 8080)
#   ./serve_local.sh 3000         (serves on port 3000)
#

PORT="${1:-8080}"
DIR="$(dirname "$0")/.."

echo "═══════════════════════════════════════════════════════"
echo " TrailRunner Local Server"
echo "═══════════════════════════════════════════════════════"
echo ""
echo " Serving from: $DIR"
echo " Port: $PORT"
echo ""

# Show local IP addresses so you know what to type on the treadmill
echo " Open one of these on the treadmill's browser:"
ip addr show 2>/dev/null | grep "inet " | grep -v 127.0.0.1 | awk '{print "   http://"$2":'"$PORT"'"}'  | sed 's|/[0-9]*:|:|'
hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | while read ip; do
    echo "   http://$ip:$PORT"
done
echo ""
echo " Press Ctrl+C to stop."
echo ""

cd "$DIR"
python3 -m http.server "$PORT" 2>/dev/null || python -m http.server "$PORT" 2>/dev/null || python -m SimpleHTTPServer "$PORT"
