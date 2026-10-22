#!/usr/bin/env bash
# Stop the ui-v4 static server and mock bridge started by start.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
for n in server static; do
  f="$DIR/mock/$n.pid"
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    kill "$pid" 2>/dev/null && echo "stopped $n ($pid)" || echo "$n not running"
    rm -f "$f"
  fi
done
# belt-and-braces: anything else bound to our ports
pkill -f "ui-v4/mock/server.js" 2>/dev/null || true
pkill -f "ui-v4/mock/static.js" 2>/dev/null || true
