package main

// v4 additions: link-state handling (stale workoutState fix) and the dead-man.
//
// DEAD-MAN, in plain words
//   If THIS bridge started the workout (StartNewWorkout succeeded through us)
//   and no client has been heard from for TR_DEADMAN_S seconds (default 20,
//   0 = disabled), the belt is slowed to 0 -- ONLY ever downwards, at
//   TR_DEADMAN_RATE kph/s (default 2, never above the 4 kph/s limiter), and
//   straight to 0 once at/below 2 kph. The workout is NOT stopped or paused:
//   the UI can resume (set a speed) or stop it. Any client activity
//   (HTTP request, WS connect/message, MQTT command) cancels a ramp in
//   progress. Once the ramp reaches 0 the state is "tripped" and latched: the
//   dead-man does nothing more until a client returns. It never acts on
//   workouts the bridge did not start (iFit-started) and never when the belt
//   is already at 0.

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	pb "trailrunner-bridge/proto"
)

const (
	deadmanDefaultS    = 20.0
	deadmanDefaultRate = 2.0 // kph/s, must stay <= maxSpeedRateKphS
	deadmanSnapKph     = 2.0 // at or below this the ramp steps straight to 0
	deadmanTick        = 500 * time.Millisecond

	// After the belt was commanded to 0 the console may still creep (seen: 0.8 kph,
	// RUNNING). If it is still above deadmanStillKph this long after, STOP the workout.
	deadmanStillKph     = 0.3
	deadmanStillAfter   = 3 * time.Second
	deadmanStopRetry    = 2 * time.Second
	deadmanStopMaxTries = 5
)

var (
	deadmanTimeout = time.Duration(deadmanDefaultS * float64(time.Second))
	deadmanRate    = deadmanDefaultRate

	// guarded by mu
	deadmanState      = "off" // "off" | "ramping" | "tripped"
	deadmanLastTarget float64
	deadmanLastStep   time.Time
	deadmanZeroAt     time.Time // when the dead-man commanded 0
	deadmanStopTries  int
	deadmanStopNext   time.Time

	lastClientNano atomic.Int64
)

func touchClient() { lastClientNano.Store(time.Now().UnixNano()) }

func initDeadmanConfig() {
	if v := os.Getenv("TR_DEADMAN_S"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f < 0 || f != f {
			log.Printf("[DEADMAN] bad TR_DEADMAN_S=%q — using default %.0fs", v, deadmanDefaultS)
		} else {
			deadmanTimeout = time.Duration(f * float64(time.Second))
		}
	}
	if v := os.Getenv("TR_DEADMAN_RATE"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || !(f > 0) {
			log.Printf("[DEADMAN] bad TR_DEADMAN_RATE=%q — using default %.1f", v, deadmanDefaultRate)
		} else {
			deadmanRate = f
		}
	}
	if deadmanRate > maxSpeedRateKphS {
		deadmanRate = maxSpeedRateKphS
	}
	if deadmanTimeout <= 0 {
		log.Println("[DEADMAN] disabled (TR_DEADMAN_S=0)")
	} else {
		log.Printf("[DEADMAN] armed: timeout %.0fs, ramp %.1f kph/s", deadmanTimeout.Seconds(), deadmanRate)
	}
}

func deadmanLoop() {
	t := time.NewTicker(deadmanTick)
	defer t.Stop()
	for now := range t.C {
		deadmanStep(now)
	}
}

// deadmanStep runs one tick and broadcasts if the visible state changed.
func deadmanStep(now time.Time) {
	mu.RLock()
	before := deadmanState
	mu.RUnlock()
	deadmanEvaluate(now)
	mu.RLock()
	after := deadmanState
	mu.RUnlock()
	if before != after {
		broadcastState()
	}
}

// deadmanEvaluate is the whole policy; `now` is injected for tests.
func deadmanEvaluate(now time.Time) {
	if deadmanTimeout <= 0 {
		return
	}
	clientAge := func() time.Duration { return now.Sub(time.Unix(0, lastClientNano.Load())) }

	mu.RLock()
	st := deadmanState
	started := bridgeStarted
	cachedSpeed := currentSpeed
	mu.RUnlock()

	if clientAge() < deadmanTimeout { // a client is (back) here
		if st != "off" {
			mu.Lock()
			deadmanState = "off"
			deadmanStopTries = 0
			mu.Unlock()
			log.Printf("[DEADMAN] client returned — dead-man cancelled (was %s). Belt NOT restored; user must set speed.", st)
		}
		return
	}
	if st == "tripped" {
		deadmanCheckCreep(now, clientAge, started, cachedSpeed)
		return // latched
	}
	if st == "tripped-stopped" || !started || speedClient == nil {
		return // latched, or not our workout (iFit-started), or no link object
	}

	// Authoritative speed (the cached value may be stale if the speed stream is down).
	speed := cachedSpeed
	if m, err := speedClient.GetSpeed(grpcCtx(), &pb.Empty{}); err == nil {
		speed = m.LastKph
	}
	if clientAge() < deadmanTimeout { // client arrived while we were reading
		return
	}

	if speed <= 0.05 {
		if st == "ramping" {
			mu.Lock()
			deadmanState = "tripped"
			mu.Unlock()
			log.Println("[DEADMAN] belt at 0 — TRIPPED (latched until a client returns)")
		}
		return // st=="off" and belt already stopped: never trip
	}

	mu.Lock()
	base := speed
	dt := deadmanTick.Seconds()
	if st == "ramping" {
		if deadmanLastTarget < base {
			base = deadmanLastTarget // continue from what we last commanded
		}
		if d := now.Sub(deadmanLastStep).Seconds(); d > 0.1 {
			dt = d
		}
	}
	if dt > 1.0 {
		dt = 1.0
	}
	next := base - deadmanRate*dt
	if base <= deadmanSnapKph || next <= deadmanSnapKph {
		next = 0
	}
	if next >= base { // never raise, never hold
		mu.Unlock()
		return
	}
	first := st == "off"
	deadmanState = "ramping"
	mu.Unlock()

	if first {
		log.Printf("[DEADMAN] !!! TRIPPED: no client for %.0fs, bridge-started workout, belt %.1f kph — ramping DOWN to 0", clientAge().Seconds(), speed)
	}
	log.Printf("[DEADMAN] ramp %.1f -> %.1f kph", speed, next)
	if clientAge() < deadmanTimeout { // last-instant recheck: do not fight a returning client
		return
	}
	if err := sendReduction(next); err != nil {
		log.Printf("[DEADMAN] SetSpeed(%.1f) failed: %v (will retry)", next, err)
		return
	}
	mu.Lock()
	deadmanLastTarget = next
	deadmanLastStep = now
	if next == 0 {
		deadmanState = "tripped"
		deadmanZeroAt = now
		deadmanStopTries = 0
		deadmanStopNext = time.Time{}
		log.Println("[DEADMAN] belt commanded to 0 — TRIPPED (workout left RUNNING; UI may resume or stop)")
	}
	mu.Unlock()
}

// deadmanCheckCreep: state is "tripped" (belt commanded to 0, workout RUNNING).
// If the belt is still measurably moving >= deadmanStillAfter after the command,
// issue the console's own STOP (same call as /workout/stop). Only ever reduces.
func deadmanCheckCreep(now time.Time, clientAge func() time.Duration, started bool, cachedSpeed float64) {
	if !started || speedClient == nil || workoutClient == nil {
		return
	}
	mu.RLock()
	zeroAt, tries, next := deadmanZeroAt, deadmanStopTries, deadmanStopNext
	mu.RUnlock()
	if zeroAt.IsZero() || now.Sub(zeroAt) < deadmanStillAfter || tries >= deadmanStopMaxTries || now.Before(next) {
		return
	}
	speed := cachedSpeed
	if m, err := speedClient.GetSpeed(grpcCtx(), &pb.Empty{}); err == nil {
		speed = m.LastKph
	}
	if speed <= deadmanStillKph {
		return // belt really is stopped: workout stays RUNNING as designed
	}
	if clientAge() < deadmanTimeout { // do not act when a client is present
		return
	}
	if tries == 0 {
		log.Printf("[DEADMAN] belt still moving after 0 - stopping workout (belt %.1f kph)", speed)
	}
	mu.Lock()
	deadmanStopTries++
	deadmanStopNext = now.Add(deadmanStopRetry)
	n := deadmanStopTries
	mu.Unlock()
	if _, err := workoutClient.Stop(grpcCtx(), &pb.Empty{}); err != nil {
		log.Printf("[DEADMAN] console STOP failed (try %d/%d): %v", n, deadmanStopMaxTries, err)
		if n >= deadmanStopMaxTries {
			log.Printf("[DEADMAN] giving up on STOP after %d tries - belt still %.1f kph", n, speed)
		}
		return
	}
	setWorkoutState("IDLE")
	mu.Lock()
	deadmanState = "tripped-stopped"
	mu.Unlock()
	log.Println("[DEADMAN] console STOP sent - TRIPPED-STOPPED (workout IDLE)")
}

// ── link state ────────────────────────────────────────────────────────────

// applyWorkoutStateLocked records a state reported by the treadmill. Caller holds mu.
func applyWorkoutStateLocked(s string) {
	workoutState = s
	if s == "IDLE" || s == "RESULTS" {
		bridgeStarted = false                  // workout is over; a later one may be iFit's
		if deadmanState != "tripped-stopped" { // keep showing that the dead-man stopped it
			deadmanState = "off"
		}
	}
}

// setWorkoutState is the optimistic update done after a command succeeded.
func setWorkoutState(s string) {
	mu.Lock()
	applyWorkoutStateLocked(s)
	mu.Unlock()
}

func currentWorkoutState() string {
	mu.RLock()
	defer mu.RUnlock()
	return workoutState
}

// linkStatus: caller holds mu (read or write).
func linkStatus() string {
	if grpcConnected && workoutState != "UNKNOWN" {
		return "ok"
	}
	return "lost"
}

// markLinkLost is called when the workout-state stream ends or cannot start.
// State is no longer known, so it is published as UNKNOWN (UI: "NO LINK").
func markLinkLost(reason string) {
	mu.Lock()
	changed := workoutState != "UNKNOWN" || grpcConnected
	workoutState = "UNKNOWN"
	grpcConnected = false
	mu.Unlock()
	if changed {
		log.Printf("[LINK] LOST (%s) — workout state now UNKNOWN", reason)
		broadcastState()
	}
}

// resyncFromTreadmill reads the authoritative state (workout, speed, incline)
// via unary calls. Nothing is trusted after a reconnect until this succeeds.
func resyncFromTreadmill() bool {
	if workoutClient == nil {
		return false
	}
	st, err := workoutClient.GetWorkoutState(grpcCtx(), &pb.Empty{})
	if err != nil {
		markLinkLost(fmt.Sprintf("GetWorkoutState: %v", err))
		return false
	}
	mu.Lock()
	applyWorkoutStateLocked(cleanState(st.WorkoutState.String()))
	grpcConnected = true
	mu.Unlock()
	if speedClient != nil {
		if sp, err := speedClient.GetSpeed(grpcCtx(), &pb.Empty{}); err == nil {
			mu.Lock()
			currentSpeed = sp.LastKph
			mu.Unlock()
		}
	}
	if inclineClient != nil {
		if in, err := inclineClient.GetIncline(grpcCtx(), &pb.Empty{}); err == nil {
			mu.Lock()
			currentIncl = in.LastInclinePercent
			mu.Unlock()
		}
	}
	if consoleClient != nil {
		mu.RLock()
		missing := consoleInfo == nil
		mu.RUnlock()
		if missing && consoleFetching.CompareAndSwap(false, true) {
			go func() { defer consoleFetching.Store(false); fetchConsoleInfo() }()
		}
	}
	log.Printf("[LINK] resynced: workout=%s", currentWorkoutState())
	broadcastState()
	return true
}

var consoleFetching atomic.Bool
