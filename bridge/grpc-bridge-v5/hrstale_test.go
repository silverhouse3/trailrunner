package main

import (
	"testing"
	"time"
)

func setHR(bpm int, ago time.Duration, never bool) {
	mu.Lock()
	currentHR = bpm
	if never {
		lastHRAt = time.Time{}
	} else {
		lastHRAt = time.Now().Add(-ago)
	}
	mu.Unlock()
	hrLogMu.Lock()
	hrWasStale = false
	hrLogMu.Unlock()
}

func pubHR() int {
	mu.RLock()
	defer mu.RUnlock()
	return hrLocked()
}

func TestHRFresh(t *testing.T) {
	setHR(120, 1*time.Second, false)
	if got := pubHR(); got != 120 {
		t.Fatalf("fresh HR = %d, want 120", got)
	}
	mu.RLock()
	m := stateMsg()["values"].(map[string]string)["Heart Rate"]
	mu.RUnlock()
	if m != "120" {
		t.Fatalf("stateMsg HR = %s", m)
	}
}

func TestHRStaleReportsZeroKeepsValue(t *testing.T) {
	setHR(120, 13*time.Second, false)
	if got := pubHR(); got != 0 {
		t.Fatalf("stale HR = %d, want 0", got)
	}
	mu.RLock()
	m := stateMsg()["values"].(map[string]string)["Heart Rate"]
	raw := currentHR
	mu.RUnlock()
	if m != "0" || raw != 120 {
		t.Fatalf("stateMsg=%s raw=%d (want 0 / 120 kept)", m, raw)
	}
	if !hrCheckStale(time.Now()) {
		t.Fatal("first stale check should report transition")
	}
	if hrCheckStale(time.Now()) {
		t.Fatal("stale must log only once")
	}
}

func TestHRBoundary(t *testing.T) {
	setHR(90, 11*time.Second, false)
	if got := pubHR(); got != 90 {
		t.Fatalf("11 s old HR = %d, want 90", got)
	}
}

func TestHRResumed(t *testing.T) {
	setHR(120, 20*time.Second, false)
	hrCheckStale(time.Now())
	// new message arrives (mirrors subscribeHeartRate)
	mu.Lock()
	currentHR = 128
	lastHRAt = time.Now()
	mu.Unlock()
	hrNoteFresh()
	if got := pubHR(); got != 128 {
		t.Fatalf("resumed HR = %d, want 128", got)
	}
	hrLogMu.Lock()
	w := hrWasStale
	hrLogMu.Unlock()
	if w {
		t.Fatal("stale flag should be cleared after resume")
	}
	// can go stale again and log again
	setHR(128, 30*time.Second, false)
	if !hrCheckStale(time.Now()) {
		t.Fatal("second stale episode should transition again")
	}
}

func TestHRNeverHad(t *testing.T) {
	setHR(0, 0, true)
	if got := pubHR(); got != 0 {
		t.Fatalf("never-had HR = %d", got)
	}
	if hrCheckStale(time.Now()) {
		t.Fatal("never-had must not log stale")
	}
	// raw value set but never timestamped is still 0
	mu.Lock()
	currentHR = 99
	mu.Unlock()
	if got := pubHR(); got != 0 {
		t.Fatalf("untimestamped HR = %d, want 0", got)
	}
}
