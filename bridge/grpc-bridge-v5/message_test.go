package main

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMessageValidation(t *testing.T) {
	cases := []struct {
		method, body string
		code         int
	}{
		{"GET", "", 200}, {"PUT", "", 405}, {"POST", "{", 400}, {"POST", `{"text":"  "}`, 400}, {"POST", `{"text":"Dinner in 10"}`, 200},
		{"POST", `{"text":"` + strings.Repeat("x", 500) + `","seconds":9999}`, 200},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		handleMessage(w, httptest.NewRequest(c.method, "/message", strings.NewReader(c.body)))
		if w.Code != c.code {
			t.Errorf("%s %q: got %d want %d", c.method, c.body, w.Code, c.code)
		}
	}
}

func TestRootPage(t *testing.T) {
	w := httptest.NewRecorder()
	handleRoot(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Message to the screen") {
		t.Errorf("root: %d", w.Code)
	}
	w = httptest.NewRecorder()
	handleRoot(w, httptest.NewRequest("GET", "/nope", nil))
	if w.Code != 404 {
		t.Errorf("unknown path: %d", w.Code)
	}
}

func TestHARunFields(t *testing.T) {
	dispMu.Lock()
	runInfo, runInfoAt = map[string]interface{}{"remainingSec": 600.0, "etaSec": 600.0, "basis": "planned"}, time.Now()
	dispMu.Unlock()
	f := haRunFields()
	if f["run_time_left_s"] != 600.0 || f["run_eta"] == nil || f["run_eta_basis"] != "planned" {
		t.Errorf("fresh info not reported: %v", f)
	}
	dispMu.Lock()
	runInfoAt = time.Now().Add(-time.Minute)
	dispMu.Unlock()
	if f = haRunFields(); f["run_time_left_s"] != nil || f["run_eta"] != nil {
		t.Errorf("stale info must read as unknown: %v", f)
	}
}
