#!/usr/bin/env bash
# Start the ui-v4 static server (8099) and the mock treadmill bridge (4510) in the background.
# Logs: ui-v4/mock/static.log and ui-v4/mock/server.log. PIDs in ui-v4/mock/*.pid.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
"$DIR/stop.sh" >/dev/null 2>&1 || true
nohup node mock/server.js > mock/server.log 2>&1 &
echo $! > mock/server.pid
nohup node mock/static.js > mock/static.log 2>&1 &
echo $! > mock/static.pid
sleep 1
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "UI:            http://localhost:8099/        (LAN: http://${IP:-<pc-ip>}:8099/)"
echo "Mock bridge:   http://localhost:4510/health  (control page: http://localhost:4510/mock)"
echo "Stop with:     $DIR/stop.sh"
