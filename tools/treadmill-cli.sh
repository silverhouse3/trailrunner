#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# TrailRunner CLI — Control the NordicTrack X32i from the command line
#
# Usage:
#   ./treadmill-cli.sh status           Show current state
#   ./treadmill-cli.sh start            Start workout
#   ./treadmill-cli.sh stop             Stop workout
#   ./treadmill-cli.sh pause            Pause workout
#   ./treadmill-cli.sh resume           Resume workout
#   ./treadmill-cli.sh speed 8.5        Set speed to 8.5 kph
#   ./treadmill-cli.sh incline 3        Set incline to 3%
#   ./treadmill-cli.sh estop            Emergency stop (speed 0 + incline 0)
#   ./treadmill-cli.sh watch            Live-stream state every 2 seconds
#   ./treadmill-cli.sh ramp 12 5        Ramp to 12 kph over 5 steps (1s each)
#
# Environment:
#   TREADMILL_IP    Treadmill IP (default: 192.168.100.54)
#   BRIDGE_PORT     Bridge port (default: 4510)
# ═══════════════════════════════════════════════════════════════════════════

HOST="${TREADMILL_IP:-192.168.100.54}"
PORT="${BRIDGE_PORT:-4510}"
BASE="http://${HOST}:${PORT}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

cmd="$1"
shift

case "$cmd" in
  status|state|s)
    echo -e "${CYAN}${BOLD}TrailRunner Status${NC} ${DIM}(${BASE})${NC}"
    echo ""
    data=$(curl -s "${BASE}/api/state" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$data" ]; then
      echo -e "${RED}Cannot reach bridge at ${BASE}${NC}"
      exit 1
    fi
    speed=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('speed_kph',0))" 2>/dev/null || echo "?")
    incline=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('incline_pct',0))" 2>/dev/null || echo "?")
    hr=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('heart_rate',0))" 2>/dev/null || echo "?")
    state=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('workout_state','UNKNOWN'))" 2>/dev/null || echo "?")
    dist=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(round(d.get('distance_km',0),2))" 2>/dev/null || echo "?")
    cal=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(round(d.get('calories',0)))" 2>/dev/null || echo "?")
    elapsed=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); s=int(d.get('elapsed_sec',0)); print(f'{s//3600}:{(s%3600)//60:02d}:{s%60:02d}')" 2>/dev/null || echo "?")

    # Color the state
    case "$state" in
      RUNNING) state_color="${GREEN}" ;;
      PAUSED)  state_color="${YELLOW}" ;;
      *)       state_color="${DIM}" ;;
    esac

    echo -e "  ${BOLD}State:${NC}    ${state_color}${state}${NC}"
    echo -e "  ${BOLD}Speed:${NC}    ${CYAN}${speed}${NC} km/h"
    echo -e "  ${BOLD}Incline:${NC}  ${YELLOW}${incline}${NC} %"
    echo -e "  ${BOLD}HR:${NC}       ${RED}${hr}${NC} bpm"
    echo -e "  ${BOLD}Distance:${NC} ${GREEN}${dist}${NC} km"
    echo -e "  ${BOLD}Calories:${NC} ${YELLOW}${cal}${NC} kcal"
    echo -e "  ${BOLD}Elapsed:${NC}  ${DIM}${elapsed}${NC}"
    ;;

  start)
    echo -e "${GREEN}Starting workout...${NC}"
    curl -s -X POST "${BASE}/workout/start" > /dev/null
    echo -e "${GREEN}Done${NC}"
    ;;

  stop)
    echo -e "${RED}Stopping workout...${NC}"
    curl -s -X POST "${BASE}/workout/stop" > /dev/null
    echo -e "${RED}Done${NC}"
    ;;

  pause)
    echo -e "${YELLOW}Pausing workout...${NC}"
    curl -s -X POST "${BASE}/workout/pause" > /dev/null
    echo -e "${YELLOW}Done${NC}"
    ;;

  resume)
    echo -e "${GREEN}Resuming workout...${NC}"
    curl -s -X POST "${BASE}/workout/resume" > /dev/null
    echo -e "${GREEN}Done${NC}"
    ;;

  speed)
    kph="${1:-0}"
    echo -e "${CYAN}Setting speed to ${kph} kph...${NC}"
    curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"kph\": ${kph}}" "${BASE}/speed" > /dev/null
    echo -e "${CYAN}Done${NC}"
    ;;

  incline|inc)
    pct="${1:-0}"
    echo -e "${YELLOW}Setting incline to ${pct}%...${NC}"
    curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"percent\": ${pct}}" "${BASE}/incline" > /dev/null
    echo -e "${YELLOW}Done${NC}"
    ;;

  estop|emergency)
    echo -e "${RED}${BOLD}EMERGENCY STOP${NC}"
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"kph": 0}' "${BASE}/speed" > /dev/null &
    curl -s -X POST -H "Content-Type: application/json" \
      -d '{"percent": 0}' "${BASE}/incline" > /dev/null &
    curl -s -X POST "${BASE}/workout/stop" > /dev/null &
    wait
    echo -e "${RED}Speed → 0, Incline → 0, Workout → STOPPED${NC}"
    ;;

  watch|monitor|w)
    echo -e "${CYAN}${BOLD}Live Monitor${NC} ${DIM}(Ctrl+C to stop)${NC}"
    echo ""
    while true; do
      data=$(curl -s "${BASE}/api/state" 2>/dev/null)
      if [ -z "$data" ]; then
        echo -e "\r${RED}Disconnected${NC}     "
      else
        speed=$(echo "$data" | python3 -c "import sys,json; print(f'{json.load(sys.stdin).get(\"speed_kph\",0):.1f}')" 2>/dev/null)
        incline=$(echo "$data" | python3 -c "import sys,json; print(f'{json.load(sys.stdin).get(\"incline_pct\",0):.1f}')" 2>/dev/null)
        hr=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin).get('heart_rate',0))" 2>/dev/null)
        state=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workout_state','?'))" 2>/dev/null)
        echo -ne "\r  ${CYAN}${speed}${NC} km/h  ${YELLOW}${incline}${NC}%  ${RED}❤ ${hr}${NC} bpm  [${state}]     "
      fi
      sleep 2
    done
    ;;

  ramp)
    target="${1:-10}"
    steps="${2:-5}"
    data=$(curl -s "${BASE}/api/state" 2>/dev/null)
    current=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin).get('speed_kph',0))" 2>/dev/null || echo "0")
    echo -e "${CYAN}Ramping from ${current} → ${target} kph in ${steps} steps${NC}"
    for i in $(seq 1 "$steps"); do
      spd=$(python3 -c "print(round(${current} + (${target}-${current}) * ${i}/${steps}, 1))")
      echo -e "  Step ${i}/${steps}: ${CYAN}${spd}${NC} kph"
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"kph\": ${spd}}" "${BASE}/speed" > /dev/null
      sleep 1
    done
    echo -e "${GREEN}Done${NC}"
    ;;

  health|ping)
    echo -n "Bridge health: "
    result=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/health" 2>/dev/null)
    if [ "$result" = "200" ]; then
      echo -e "${GREEN}OK${NC}"
    else
      echo -e "${RED}UNREACHABLE (HTTP ${result})${NC}"
      exit 1
    fi
    ;;

  *)
    echo -e "${BOLD}TrailRunner CLI${NC} — NordicTrack X32i Controller"
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Commands:"
    echo "  status              Show current treadmill state"
    echo "  start               Start workout"
    echo "  stop                Stop workout"
    echo "  pause               Pause workout"
    echo "  resume              Resume workout"
    echo "  speed <kph>         Set belt speed (0-22 kph)"
    echo "  incline <percent>   Set incline (-6 to 40%)"
    echo "  estop               Emergency stop"
    echo "  watch               Live-stream state to terminal"
    echo "  ramp <kph> [steps]  Gradually ramp speed"
    echo "  health              Check bridge connectivity"
    echo ""
    echo "Environment:"
    echo "  TREADMILL_IP=${HOST}"
    echo "  BRIDGE_PORT=${PORT}"
    ;;
esac
