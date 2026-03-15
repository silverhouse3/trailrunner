#!/bin/bash
# TrailRunner Overnight Test Runner
# Runs all tests in a loop until 5 consecutive clean passes
# Screenshots verified by each test, saved to screenshots/ directory
# Usage: bash tests/overnight-runner.sh

cd /mnt/d/trailrunner

PASS_COUNT=0
REQUIRED_PASSES=5
RUN=0
LOG="tests/overnight-results.log"
echo "=== TrailRunner Overnight Test Run ===" > "$LOG"
echo "Started: $(date)" >> "$LOG"
echo "Required clean passes: $REQUIRED_PASSES" >> "$LOG"
echo "" >> "$LOG"

while [ $PASS_COUNT -lt $REQUIRED_PASSES ]; do
  RUN=$((RUN + 1))
  echo "────────────────────────────────────────────" >> "$LOG"
  echo "Run #$RUN (consecutive passes: $PASS_COUNT/$REQUIRED_PASSES)" >> "$LOG"
  echo "$(date)" >> "$LOG"
  echo "" >> "$LOG"

  echo "[Run $RUN] Testing... (need $PASS_COUNT/$REQUIRED_PASSES consecutive passes)"

  # Run all tests
  RESULT=$(npx playwright test tests/trailrunner-bugs.spec.js --reporter=line 2>&1)
  EXIT_CODE=$?

  echo "$RESULT" >> "$LOG"
  echo "" >> "$LOG"

  if [ $EXIT_CODE -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "[Run $RUN] PASSED ($PASS_COUNT/$REQUIRED_PASSES consecutive)" >> "$LOG"
    echo "[Run $RUN] PASSED ($PASS_COUNT/$REQUIRED_PASSES consecutive)"
  else
    PASS_COUNT=0
    echo "[Run $RUN] FAILED — resetting consecutive pass counter" >> "$LOG"
    echo "[Run $RUN] FAILED — resetting counter. See log for details."

    # Extract failure summary
    echo "$RESULT" | grep "failed" >> "$LOG"
    echo "$RESULT" | grep "Error:" | head -5 >> "$LOG"
  fi

  echo "" >> "$LOG"

  # Brief pause between runs
  sleep 2
done

echo "════════════════════════════════════════════" >> "$LOG"
echo "ALL $REQUIRED_PASSES CONSECUTIVE PASSES ACHIEVED!" >> "$LOG"
echo "Total runs: $RUN" >> "$LOG"
echo "Completed: $(date)" >> "$LOG"

echo ""
echo "SUCCESS! $REQUIRED_PASSES consecutive clean runs completed after $RUN total runs."
echo "Screenshots saved to: tests/screenshots/"
echo "Full log: $LOG"
