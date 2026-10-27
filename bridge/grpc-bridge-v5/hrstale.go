package main

// Heart-rate staleness (P1 safety fix 2026-10-26).
// If glassos stops sending HR messages (strap off / out of range) the last BPM
// used to be published forever, so the UI saw a frozen value as live. Now every
// published HR goes through hrLocked(): 0 when no HR message arrived for
// hrStaleAfter. Fail-safe: a false "lost" only makes the autopilot HOLD.

import (
	"log"
	"sync"
	"time"
)

const hrStaleAfter = 12 * time.Second

var (
	hrLogMu    sync.Mutex
	hrWasStale bool
)

// hrAt returns the effective HR for the given instant. Caller must hold mu (R or W).
func hrAt(now time.Time) int {
	if lastHRAt.IsZero() || now.Sub(lastHRAt) > hrStaleAfter {
		return 0
	}
	return currentHR
}

// hrLocked is the value to publish. Caller must hold mu (R or W).
func hrLocked() int { return hrAt(time.Now()) }

// hrNoteFresh logs a single "[HR] resumed" after a stale period.
func hrNoteFresh() {
	hrLogMu.Lock()
	if hrWasStale {
		hrWasStale = false
		log.Println("[HR] resumed")
	}
	hrLogMu.Unlock()
}

// hrCheckStale logs "[HR] stale -> 0" once on transition; returns true on the transition.
func hrCheckStale(now time.Time) bool {
	mu.RLock()
	stale := !lastHRAt.IsZero() && now.Sub(lastHRAt) > hrStaleAfter
	mu.RUnlock()
	hrLogMu.Lock()
	defer hrLogMu.Unlock()
	if stale && !hrWasStale {
		hrWasStale = true
		log.Println("[HR] stale -> 0")
		return true
	}
	return false
}

// hrStaleWatcher pushes the 0 to clients even if no other message would trigger a broadcast.
func hrStaleWatcher() {
	for {
		time.Sleep(2 * time.Second)
		if hrCheckStale(time.Now()) {
			broadcastState()
		}
	}
}
