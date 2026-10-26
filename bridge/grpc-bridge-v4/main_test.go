package main

// Unit tests for the v4 safety changes. ALL gRPC clients here are in-process
// fakes: nothing in this file ever dials the treadmill or any network address.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	pb "trailrunner-bridge/proto"

	"google.golang.org/grpc"
)

// ── fakes ───────────────────────────────────────────────────────────────────

type fakeSpeed struct {
	pb.SpeedServiceClient // nil: any un-faked method panics (loudly)
	mu                    sync.Mutex
	belt                  float64   // what GetSpeed reports
	follow                bool      // belt jumps to every SetSpeed value
	calls                 []float64 // every SetSpeed value, in order
	getErr                error
	gate                  chan struct{} // if non-nil, SetSpeed(>0) blocks until closed
	entered               chan struct{} // signalled when a gated SetSpeed starts
}

func (f *fakeSpeed) SetSpeed(ctx context.Context, in *pb.SpeedRequest, _ ...grpc.CallOption) (*pb.WorkoutResult, error) {
	if in.Kph > 0 && f.gate != nil {
		select {
		case f.entered <- struct{}{}:
		default:
		}
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, in.Kph)
	if f.follow {
		f.belt = in.Kph
	}
	return &pb.WorkoutResult{}, nil
}
func (f *fakeSpeed) GetSpeed(ctx context.Context, in *pb.Empty, _ ...grpc.CallOption) (*pb.SpeedMetric, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return nil, f.getErr
	}
	return &pb.SpeedMetric{LastKph: f.belt}, nil
}
func (f *fakeSpeed) snapshot() []float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]float64(nil), f.calls...)
}

type fakeIncline struct {
	pb.InclineServiceClient
	mu    sync.Mutex
	calls []float64
}

func (f *fakeIncline) SetIncline(ctx context.Context, in *pb.InclineRequest, _ ...grpc.CallOption) (*pb.WorkoutResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, in.Percent)
	return &pb.WorkoutResult{}, nil
}
func (f *fakeIncline) GetIncline(ctx context.Context, in *pb.Empty, _ ...grpc.CallOption) (*pb.InclineMetric, error) {
	return &pb.InclineMetric{LastInclinePercent: 1.5}, nil
}

type fakeStream struct {
	grpc.ClientStream
	msgs []*pb.WorkoutStateMessage
	end  error
}

func (s *fakeStream) Recv() (*pb.WorkoutStateMessage, error) {
	if len(s.msgs) > 0 {
		m := s.msgs[0]
		s.msgs = s.msgs[1:]
		return m, nil
	}
	return nil, s.end
}

type fakeWorkout struct {
	pb.WorkoutServiceClient
	mu        sync.Mutex
	state     pb.WorkoutState
	stateErr  error
	startID   string
	stream    *fakeStream
	streamErr error
	stops     int
	stopErr   error
}

func (f *fakeWorkout) GetWorkoutState(ctx context.Context, in *pb.Empty, _ ...grpc.CallOption) (*pb.WorkoutStateMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stateErr != nil {
		return nil, f.stateErr
	}
	return &pb.WorkoutStateMessage{WorkoutState: f.state}, nil
}
func (f *fakeWorkout) WorkoutStateChanged(ctx context.Context, in *pb.Empty, _ ...grpc.CallOption) (grpc.ServerStreamingClient[pb.WorkoutStateMessage], error) {
	if f.streamErr != nil {
		return nil, f.streamErr
	}
	return f.stream, nil
}
func (f *fakeWorkout) StartNewWorkout(ctx context.Context, in *pb.Empty, _ ...grpc.CallOption) (*pb.StartWorkoutResponse, error) {
	return &pb.StartWorkoutResponse{WorkoutID: f.startID}, nil
}
func (f *fakeWorkout) Stop(ctx context.Context, in *pb.Empty, _ ...grpc.CallOption) (*pb.WorkoutResult, error) {
	f.mu.Lock()
	f.stops++
	err := f.stopErr
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &pb.WorkoutResult{}, nil
}

// reset puts every global the code under test touches into a known state.
func reset(t *testing.T) (*fakeSpeed, *fakeIncline, *fakeWorkout) {
	t.Helper()
	sp := &fakeSpeed{follow: true}
	in := &fakeIncline{}
	wk := &fakeWorkout{state: pb.WorkoutState_WORKOUT_STATE_IDLE, startID: "w-1"}
	mu.Lock()
	speedClient, inclineClient, workoutClient = sp, in, wk
	workoutState, workoutID, grpcConnected = "RUNNING", "", true
	currentSpeed, currentIncl = 0, 0
	safetyKeyOut = false
	bridgeStarted = false
	lastSpeedSet, lastSpeedSetTime = 0, time.Time{}
	speedEpoch, speedInFlight = 0, 0
	deadmanState, deadmanLastTarget, deadmanLastStep = "off", 0, time.Time{}
	deadmanZeroAt, deadmanStopTries, deadmanStopNext = time.Time{}, 0, time.Time{}
	mu.Unlock()
	deadmanTimeout, deadmanRate = 20*time.Second, 2.0
	touchClient()
	t.Cleanup(func() {
		mu.Lock()
		speedClient, inclineClient, workoutClient = nil, nil, nil
		mu.Unlock()
	})
	return sp, in, wk
}

// ageClient pretends the last client activity was d ago relative to `now`.
func ageClient(now time.Time, d time.Duration) { lastClientNano.Store(now.Add(-d).UnixNano()) }

func setBridgeRun(started bool, belt float64, sp *fakeSpeed) {
	mu.Lock()
	bridgeStarted = started
	currentSpeed = belt
	workoutState = "RUNNING"
	mu.Unlock()
	sp.mu.Lock()
	sp.belt = belt
	sp.mu.Unlock()
}

func dmState() string { mu.RLock(); defer mu.RUnlock(); return deadmanState }

// ── 1. stale state / link loss ──────────────────────────────────────────────

func TestStreamEndMarksStateUnknownAndPublishesNoLink(t *testing.T) {
	_, _, wk := reset(t)
	wk.state = pb.WorkoutState_WORKOUT_STATE_RUNNING
	wk.stream = &fakeStream{
		msgs: []*pb.WorkoutStateMessage{{WorkoutState: pb.WorkoutState_WORKOUT_STATE_RUNNING}},
		end:  io.EOF,
	}
	workoutStateSession() // opens, resyncs, receives RUNNING, then the stream ends

	mu.RLock()
	defer mu.RUnlock()
	if workoutState != "UNKNOWN" {
		t.Fatalf("workoutState = %q after stream end, want UNKNOWN", workoutState)
	}
	if grpcConnected {
		t.Fatal("grpcConnected must be false after stream end")
	}
	m := stateMsg()
	w := m["workout"].(map[string]interface{})
	if w["state"] != "UNKNOWN" || w["link"] != "lost" || w["grpc"] != false {
		t.Fatalf("published workout block = %v, want UNKNOWN/lost/grpc=false", w)
	}
}

func TestStreamOpenFailureMarksUnknown(t *testing.T) {
	_, _, wk := reset(t)
	wk.streamErr = errors.New("unavailable")
	workoutStateSession()
	if got := currentWorkoutState(); got != "UNKNOWN" {
		t.Fatalf("state = %q, want UNKNOWN", got)
	}
}

func TestReconnectResyncsInsteadOfTrustingOldState(t *testing.T) {
	sp, _, wk := reset(t)
	markLinkLost("test")
	if currentWorkoutState() != "UNKNOWN" {
		t.Fatal("precondition: UNKNOWN")
	}
	wk.state = pb.WorkoutState_WORKOUT_STATE_PAUSED
	sp.belt = 3.2
	if !resyncFromTreadmill() {
		t.Fatal("resync should succeed")
	}
	mu.RLock()
	defer mu.RUnlock()
	if workoutState != "PAUSED" || !grpcConnected || currentSpeed != 3.2 || currentIncl != 1.5 {
		t.Fatalf("after resync: state=%s grpc=%v speed=%v incl=%v", workoutState, grpcConnected, currentSpeed, currentIncl)
	}
}

func TestResyncFailureStaysUnknown(t *testing.T) {
	_, _, wk := reset(t)
	wk.stateErr = errors.New("down")
	if resyncFromTreadmill() {
		t.Fatal("resync must fail")
	}
	if currentWorkoutState() != "UNKNOWN" {
		t.Fatal("must stay UNKNOWN when GetWorkoutState fails")
	}
}

func TestUnknownStateBlocksRaisingButNotStop(t *testing.T) {
	sp, _, _ := reset(t)
	markLinkLost("test")
	body := func(s string) *http.Request {
		return httptest.NewRequest("POST", "/speed", strings.NewReader(s))
	}
	rec := httptest.NewRecorder()
	cors(handleSpeed)(rec, body(`{"kph":8}`))
	if !strings.Contains(rec.Body.String(), `"ok":false`) || len(sp.snapshot()) != 0 {
		t.Fatalf("raise in UNKNOWN must be refused, got %s calls=%v", rec.Body.String(), sp.snapshot())
	}
	rec = httptest.NewRecorder()
	cors(handleSpeed)(rec, body(`{"kph":0}`))
	if c := sp.snapshot(); len(c) != 1 || c[0] != 0 {
		t.Fatalf("speed 0 must go through in UNKNOWN, calls=%v", c)
	}
}

func TestBridgeStartedFlagLifecycle(t *testing.T) {
	_, _, wk := reset(t)
	wk.startID = "abc"
	rec := httptest.NewRecorder()
	handleWorkoutStart(rec, httptest.NewRequest("POST", "/workout/start", nil))
	mu.RLock()
	bs, id := bridgeStarted, workoutID
	mu.RUnlock()
	if !bs || id != "abc" {
		t.Fatalf("after start: bridgeStarted=%v id=%q", bs, id)
	}
	// the treadmill reports IDLE (e.g. stopped at the console): flag must clear
	mu.Lock()
	applyWorkoutStateLocked("IDLE")
	bs = bridgeStarted
	mu.Unlock()
	if bs {
		t.Fatal("bridgeStarted must clear when state goes IDLE")
	}
	handleWorkoutStart(httptest.NewRecorder(), httptest.NewRequest("POST", "/workout/start", nil))
	handleWorkoutStop(httptest.NewRecorder(), httptest.NewRequest("POST", "/workout/stop", nil))
	mu.RLock()
	bs = bridgeStarted
	mu.RUnlock()
	if bs {
		t.Fatal("bridgeStarted must clear after stop")
	}
}

// ── 2. dead-man ─────────────────────────────────────────────────────────────

func TestDeadmanTripsAndRampsDownMonotonically(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 12, sp)

	prev := 12.0
	for i := 0; i < 80 && dmState() != "tripped"; i++ {
		now = now.Add(500 * time.Millisecond)
		ageClient(now, 30*time.Second)
		before := len(sp.snapshot())
		deadmanEvaluate(now)
		calls := sp.snapshot()
		if len(calls) == before {
			continue
		}
		v := calls[len(calls)-1]
		if v >= prev {
			t.Fatalf("step %d: dead-man commanded %.2f after %.2f (must strictly decrease)", i, v, prev)
		}
		if prev-v > 4.0*0.5+1e-9 && v != 0 {
			t.Fatalf("step %d: drop %.2f->%.2f exceeds max decel for a 0.5s tick", i, prev, v)
		}
		if v != 0 && prev-v > 2.0 {
			t.Fatalf("step %d: ramp too steep", i)
		}
		mu.Lock()
		currentSpeed = v
		mu.Unlock()
		prev = v
	}
	if dmState() != "tripped" {
		t.Fatalf("state = %s, want tripped", dmState())
	}
	calls := sp.snapshot()
	if calls[len(calls)-1] != 0 {
		t.Fatalf("final command %.2f, want 0", calls[len(calls)-1])
	}
	if len(calls) < 5 {
		t.Fatalf("expected a gradual ramp from 12 kph, got only %v", calls)
	}
	// latched: no further commands while still no client
	n := len(calls)
	for i := 0; i < 10; i++ {
		now = now.Add(time.Second)
		ageClient(now, 60*time.Second)
		deadmanEvaluate(now)
	}
	if len(sp.snapshot()) != n {
		t.Fatal("tripped dead-man must be idempotent (no more commands)")
	}
	// workout is left RUNNING (resumable/stoppable by the UI), not stopped
	if currentWorkoutState() != "RUNNING" {
		t.Fatalf("workout state = %s, dead-man must not stop/pause the workout", currentWorkoutState())
	}
}

func TestDeadmanSlowSpeedGoesStraightToZero(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 1.8, sp)
	deadmanEvaluate(now)
	if c := sp.snapshot(); len(c) != 1 || c[0] != 0 {
		t.Fatalf("<=2 kph should step straight to 0, got %v", c)
	}
	if dmState() != "tripped" {
		t.Fatalf("state = %s", dmState())
	}
}

func TestDeadmanNeverIncreasesEvenWithLaggingBelt(t *testing.T) {
	// The treadmill reports a constant 10 kph (belt lags / stream stale). Every
	// command must still be <= the previous one and < 10.
	sp, _, _ := reset(t)
	sp.follow = false
	now := time.Now()
	setBridgeRun(true, 10, sp)
	prev := 10.0
	for i := 0; i < 40; i++ {
		now = now.Add(500 * time.Millisecond)
		ageClient(now, 30*time.Second)
		deadmanEvaluate(now)
	}
	for _, v := range sp.snapshot() {
		if v > prev || v >= 10 {
			t.Fatalf("command %.2f raised/held speed (prev %.2f)", v, prev)
		}
		prev = v
	}
	if len(sp.snapshot()) == 0 {
		t.Fatal("expected ramp commands")
	}
}

func TestDeadmanDoesNotTripWhenClientPresent(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 5*time.Second)
	setBridgeRun(true, 10, sp)
	deadmanEvaluate(now)
	if len(sp.snapshot()) != 0 || dmState() != "off" {
		t.Fatalf("must not trip with a recent client: calls=%v state=%s", sp.snapshot(), dmState())
	}
}

func TestDeadmanDoesNotTripForIFitStartedWorkout(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 10*time.Minute)
	setBridgeRun(false, 10, sp) // bridgeStarted == false
	for i := 0; i < 10; i++ {
		now = now.Add(time.Second)
		deadmanEvaluate(now)
	}
	if len(sp.snapshot()) != 0 || dmState() != "off" {
		t.Fatalf("iFit workout must never be touched: calls=%v state=%s", sp.snapshot(), dmState())
	}
}

func TestDeadmanDoesNotTripWhenSpeedAlreadyZero(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 10*time.Minute)
	setBridgeRun(true, 0, sp)
	deadmanEvaluate(now)
	if len(sp.snapshot()) != 0 || dmState() != "off" {
		t.Fatalf("speed 0: no command, no trip. calls=%v state=%s", sp.snapshot(), dmState())
	}
}

func TestDeadmanDisabledWithZeroTimeout(t *testing.T) {
	sp, _, _ := reset(t)
	deadmanTimeout = 0
	now := time.Now()
	ageClient(now, time.Hour)
	setBridgeRun(true, 10, sp)
	deadmanEvaluate(now)
	if len(sp.snapshot()) != 0 {
		t.Fatal("TR_DEADMAN_S=0 must disable the dead-man")
	}
}

func TestDeadmanCancelsWhenClientReturns(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 12, sp)
	deadmanEvaluate(now)
	if dmState() != "ramping" {
		t.Fatalf("state = %s, want ramping", dmState())
	}
	n := len(sp.snapshot())

	now = now.Add(500 * time.Millisecond)
	lastClientNano.Store(now.UnixNano()) // client is back
	deadmanEvaluate(now)
	if dmState() != "off" {
		t.Fatalf("state = %s after client return, want off", dmState())
	}
	for i := 0; i < 5; i++ {
		now = now.Add(500 * time.Millisecond)
		lastClientNano.Store(now.UnixNano())
		deadmanEvaluate(now)
	}
	if len(sp.snapshot()) != n {
		t.Fatal("no further dead-man commands once a client has returned")
	}
}

func TestDeadmanClientReturnClearsTrippedLatch(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 1.0, sp)
	deadmanEvaluate(now)
	if dmState() != "tripped" {
		t.Fatal("precondition: tripped")
	}
	lastClientNano.Store(now.UnixNano())
	deadmanEvaluate(now)
	if dmState() != "off" {
		t.Fatalf("state = %s, want off after client returns", dmState())
	}
}

func TestDeadmanIgnoresSafetyKeyAndStillReduces(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 10, sp)
	mu.Lock()
	safetyKeyOut = true
	mu.Unlock()
	deadmanEvaluate(now)
	if len(sp.snapshot()) != 1 {
		t.Fatal("a reduction must not be blocked by the safety-key guard")
	}
}

func TestDeadmanUsesFreshSpeedWhenCacheIsStale(t *testing.T) {
	sp, _, _ := reset(t)
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 0, sp) // stale cache says 0
	sp.mu.Lock()
	sp.belt = 9 // belt is actually moving
	sp.mu.Unlock()
	deadmanEvaluate(now)
	if len(sp.snapshot()) != 1 {
		t.Fatal("dead-man must read the real speed, not trust a stale cached 0")
	}
}

func TestDeadmanRateNeverAboveLimiter(t *testing.T) {
	t.Setenv("TR_DEADMAN_RATE", "99")
	t.Setenv("TR_DEADMAN_S", "7.5")
	initDeadmanConfig()
	if deadmanRate > maxSpeedRateKphS || deadmanTimeout != 7500*time.Millisecond {
		t.Fatalf("rate=%v timeout=%v", deadmanRate, deadmanTimeout)
	}
	t.Setenv("TR_DEADMAN_S", "0")
	initDeadmanConfig()
	if deadmanTimeout != 0 {
		t.Fatal("0 must disable")
	}
	t.Setenv("TR_DEADMAN_S", "junk")
	deadmanTimeout = 0
	initDeadmanConfig()
	t.Cleanup(func() { deadmanTimeout, deadmanRate = 20*time.Second, 2.0 })
}

func TestHTTPRequestCountsAsClientAndHealthShowsDeadman(t *testing.T) {
	reset(t)
	lastClientNano.Store(time.Now().Add(-time.Hour).UnixNano())
	rec := httptest.NewRecorder()
	cors(handleHealth)(rec, httptest.NewRequest("GET", "/health", nil))
	if time.Since(time.Unix(0, lastClientNano.Load())) > time.Second {
		t.Fatal("a /health request must refresh client presence")
	}
	if !strings.Contains(rec.Body.String(), `"deadman":"off"`) || !strings.Contains(rec.Body.String(), `"link":"ok"`) {
		t.Fatalf("health body: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	cors(handleState)(rec, httptest.NewRequest("GET", "/state", nil))
	if !strings.Contains(rec.Body.String(), `"deadman":"off"`) {
		t.Fatalf("state body: %s", rec.Body.String())
	}
}

// ── 3. safety key / e-stop / rate limit ─────────────────────────────────────

func TestSpeedZeroNeverBlockedBySafetyKey(t *testing.T) {
	sp, _, _ := reset(t)
	mu.Lock()
	safetyKeyOut, currentSpeed = true, 8
	mu.Unlock()
	if err := safeSpeedSet(0); err != nil {
		t.Fatalf("speed 0 with key out must succeed: %v", err)
	}
	if c := sp.snapshot(); len(c) != 1 || c[0] != 0 {
		t.Fatalf("calls = %v", c)
	}
}

func TestNaNBecomesStop(t *testing.T) {
	sp, _, _ := reset(t)
	nan := 0.0
	nan = nan / nan
	if err := safeSpeedSet(nan); err != nil {
		t.Fatal(err)
	}
	if c := sp.snapshot(); len(c) != 1 || c[0] != 0 {
		t.Fatalf("NaN must clamp to stop, got %v", c)
	}
}

func TestSafetyKeyBlocksRaiseButAllowsReduction(t *testing.T) {
	sp, _, _ := reset(t)
	mu.Lock()
	safetyKeyOut, currentSpeed = true, 6
	lastSpeedSet, lastSpeedSetTime = 6, time.Now().Add(-time.Second)
	mu.Unlock()
	if err := safeSpeedSet(9); err == nil {
		t.Fatal("raise with key out must be blocked")
	}
	if err := safeSpeedSet(4); err != nil {
		t.Fatalf("reduction with key out must be allowed: %v", err)
	}
	if c := sp.snapshot(); len(c) != 1 || c[0] != 4 {
		t.Fatalf("calls = %v", c)
	}
}

func TestInclineZeroAllowedWithKeyOut(t *testing.T) {
	_, in, _ := reset(t)
	mu.Lock()
	safetyKeyOut = true
	mu.Unlock()
	if err := safeInclineSet(0); err != nil {
		t.Fatalf("incline 0 must be allowed: %v", err)
	}
	if err := safeInclineSet(5); err == nil {
		t.Fatal("non-zero incline with key out must be blocked")
	}
	if len(in.calls) != 1 || in.calls[0] != 0 {
		t.Fatalf("calls = %v", in.calls)
	}
}

func TestRateLimitAcceleration(t *testing.T) {
	sp, _, _ := reset(t)
	// 100 ms after the last command: max step is 4*0.1 = 0.4 kph
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 5, time.Now()
	mu.Unlock()
	if err := safeSpeedSet(20); err != nil {
		t.Fatal(err)
	}
	got := sp.snapshot()[0]
	if got < 5 || got > 5.5 {
		t.Fatalf("rapid raise 5->20 capped to %.2f, want ~5.4", got)
	}
	// 2 s since last command: dt is capped at 1 s, so max step 4 kph
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 5, time.Now().Add(-2*time.Second)
	mu.Unlock()
	safeSpeedSet(20)
	got = sp.snapshot()[1]
	if got < 8.9 || got > 9.1 {
		t.Fatalf("2s raise 5->20 capped to %.2f, want ~9 (dt capped at 1s)", got)
	}
}

func TestRateLimitDecelCappedButZeroImmediate(t *testing.T) {
	sp, _, _ := reset(t)
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 10, time.Now().Add(-time.Second)
	currentSpeed = 10 // measured belt agrees
	mu.Unlock()
	safeSpeedSet(1) // asks for -9 in 1s: capped to -4
	if got := sp.snapshot()[0]; got < 5.9 || got > 6.1 {
		t.Fatalf("decel capped to %.2f, want ~6", got)
	}
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 10, time.Now()
	mu.Unlock()
	safeSpeedSet(0) // stop is instant, no limiter
	if c := sp.snapshot(); c[len(c)-1] != 0 {
		t.Fatalf("stop not immediate: %v", c)
	}
}

func TestClampTo22(t *testing.T) {
	sp, _, _ := reset(t)
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 20, time.Now().Add(-10*time.Second)
	mu.Unlock()
	safeSpeedSet(99)
	if got := sp.snapshot()[0]; got != 22 {
		t.Fatalf("got %.1f want 22", got)
	}
}

func TestStopIsNotDelayedByInFlightRaiseAndWinsOrdering(t *testing.T) {
	sp, _, _ := reset(t)
	sp.follow = false
	sp.gate = make(chan struct{})
	sp.entered = make(chan struct{}, 1)
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 5, time.Now().Add(-time.Second)
	mu.Unlock()

	raiseDone := make(chan struct{})
	go func() { safeSpeedSet(7); close(raiseDone) }()
	select {
	case <-sp.entered: // raise is now blocked "on the wire"
	case <-time.After(2 * time.Second):
		t.Fatal("raise never reached SetSpeed")
	}

	stopDone := make(chan struct{})
	go func() { safeSpeedSet(0); close(stopDone) }()
	// The first stop SetSpeed(0) must be sent while the raise is still blocked.
	deadline := time.After(2 * time.Second)
	for {
		c := sp.snapshot()
		if len(c) == 1 && c[0] == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("stop was delayed behind the in-flight raise; calls=%v", sp.snapshot())
		case <-time.After(5 * time.Millisecond):
		}
	}
	close(sp.gate) // let the raise land
	<-raiseDone
	<-stopDone
	c := sp.snapshot()
	if c[len(c)-1] != 0 {
		t.Fatalf("last command must be the stop (re-asserted after the raise), got %v", c)
	}
}

func TestRaiseDecidedBeforeStopIsDroppedNotSentAfter(t *testing.T) {
	sp, _, _ := reset(t)
	// Simulate: raise decided at epoch 0, a stop bumps the epoch, then the raise tries to send.
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 5, time.Now().Add(-time.Second)
	e := speedEpoch
	mu.Unlock()
	sendReduction(0)
	sendMu.Lock()
	mu.Lock()
	stale := speedEpoch != e
	mu.Unlock()
	sendMu.Unlock()
	if !stale {
		t.Fatal("stop must bump the epoch")
	}
	if c := sp.snapshot(); len(c) != 1 || c[0] != 0 {
		t.Fatalf("calls %v", c)
	}
}

func TestMotorSemaphoreNeverThrottlesStop(t *testing.T) {
	sp, _, _ := reset(t)
	for i := 0; i < cap(motorSem); i++ {
		motorSem <- struct{}{}
	}
	defer func() {
		for len(motorSem) > 0 {
			<-motorSem
		}
	}()
	goSpeed(8) // dropped: queue full
	goSpeed(0) // must still run
	deadline := time.After(2 * time.Second)
	for {
		c := sp.snapshot()
		if len(c) == 1 && c[0] == 0 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("calls = %v (want exactly one stop, no raise)", c)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// ── 4. HTTP robustness ──────────────────────────────────────────────────────

func TestBodyLimit(t *testing.T) {
	sp, _, _ := reset(t)
	big := `{"kph":5,"pad":"` + strings.Repeat("x", maxBodyBytes+10) + `"}`
	rec := httptest.NewRecorder()
	cors(handleSpeed)(rec, httptest.NewRequest("POST", "/speed", strings.NewReader(big)))
	if !strings.Contains(rec.Body.String(), `"ok":false`) || len(sp.snapshot()) != 0 {
		t.Fatalf("oversize body must be rejected: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	cors(handleCommand)(rec, httptest.NewRequest("POST", "/command", strings.NewReader(big)))
	if !strings.Contains(rec.Body.String(), `"ok":false`) {
		t.Fatalf("oversize /command body must be rejected: %s", rec.Body.String())
	}
}

// ── v4.1 rate-limiter baseline / dt cap ─────────────────────────────────────

func TestIdleGapCannotJumpMoreThan4(t *testing.T) {
	sp, _, _ := reset(t)
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 0, time.Now().Add(-10*time.Second)
	mu.Unlock()
	safeSpeedSet(22)
	if got := sp.snapshot()[0]; got > 4.0+1e-6 || got < 3.9 {
		t.Fatalf("10s idle then 22 kph gave %.2f, want <=4", got)
	}
	// a brand-new bridge (zero timestamp) is capped too
	reset(t)
	sp2 := speedClient.(*fakeSpeed)
	safeSpeedSet(22)
	if got := sp2.snapshot()[0]; got > 4.0+1e-6 {
		t.Fatalf("fresh bridge first command gave %.2f, want <=4", got)
	}
}

func TestRepeatedCommandsOneSecondApartClimb4Each(t *testing.T) {
	sp, _, _ := reset(t)
	want := 4.0
	for i := 0; i < 5; i++ {
		mu.Lock()
		lastSpeedSetTime = time.Now().Add(-time.Second)
		mu.Unlock()
		safeSpeedSet(22)
		got := sp.snapshot()[i]
		if got < want-0.05 || got > want+0.05 {
			t.Fatalf("step %d: got %.2f want %.1f", i, got, want)
		}
		want += 4
	}
}

func TestStaleLowBaselineUsesMeasuredSpeedForRaise(t *testing.T) {
	sp, _, _ := reset(t)
	for _, c := range []struct{ req, want float64 }{{12, 12}, {22, 14}} {
		mu.Lock()
		lastSpeedSet, lastSpeedSetTime = 0, time.Now().Add(-5*time.Second)
		currentSpeed = 10 // iFit/restart changed the belt
		mu.Unlock()
		n := len(sp.snapshot())
		safeSpeedSet(c.req)
		got := sp.snapshot()[n]
		if got < c.want-0.05 || got > c.want+0.05 {
			t.Fatalf("raise to %.0f from real 10 (stale 0): got %.2f want %.1f", c.req, got, c.want)
		}
	}
}

func TestStaleHighBaselineDoesNotInflateDecel(t *testing.T) {
	sp, _, _ := reset(t)
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 20, time.Now().Add(-5*time.Second) // stale high
	currentSpeed = 6
	mu.Unlock()
	safeSpeedSet(3) // from real 6: 3 is within one 4 kph step
	if got := sp.snapshot()[0]; got < 2.95 || got > 3.05 {
		t.Fatalf("got %.2f want 3 (decel computed from real 6, not stale 20)", got)
	}
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 20, time.Now().Add(-5*time.Second)
	currentSpeed = 12
	mu.Unlock()
	safeSpeedSet(1) // decel still rate-limited: 12 -> 8
	if got := sp.snapshot()[1]; got < 7.9 || got > 8.1 {
		t.Fatalf("got %.2f want ~8", got)
	}
}

func TestStopAndDeadmanUnaffectedByDtCap(t *testing.T) {
	sp, _, _ := reset(t)
	mu.Lock()
	lastSpeedSet, lastSpeedSetTime = 22, time.Now()
	currentSpeed = 22
	mu.Unlock()
	safeSpeedSet(0)
	if c := sp.snapshot(); len(c) != 1 || c[0] != 0 {
		t.Fatalf("stop must be instant: %v", c)
	}
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 15, sp)
	deadmanEvaluate(now)
	c := sp.snapshot()
	if len(c) != 2 || c[1] >= 15 || c[1] < 13 {
		t.Fatalf("dead-man ramp step wrong: %v", c)
	}
}

// ── creep-after-zero: console STOP ──────────────────────────────────────────

func nStops(wk *fakeWorkout) int { wk.mu.Lock(); defer wk.mu.Unlock(); return wk.stops }

// tripCreeping: bridge-started run, belt 1.6, SetSpeed(0) does not move the belt (console creeps at 0.8).
func tripCreeping(t *testing.T) (*fakeSpeed, *fakeWorkout, time.Time) {
	sp, _, wk := reset(t)
	sp.follow = false
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(true, 1.6, sp)
	deadmanEvaluate(now)
	if dmState() != "tripped" {
		t.Fatalf("state = %s, want tripped", dmState())
	}
	sp.mu.Lock()
	sp.belt = 0.8
	sp.mu.Unlock()
	return sp, wk, now
}

func TestDeadmanCreepStopsWorkoutOnceAfter3s(t *testing.T) {
	_, wk, t0 := tripCreeping(t)
	for _, d := range []time.Duration{500 * time.Millisecond, time.Second, 2900 * time.Millisecond} {
		deadmanEvaluate(t0.Add(d))
	}
	if nStops(wk) != 0 {
		t.Fatal("Stop before 3s")
	}
	for d := 3 * time.Second; d <= 10*time.Second; d += 500 * time.Millisecond {
		deadmanEvaluate(t0.Add(d))
	}
	if nStops(wk) != 1 {
		t.Fatalf("stops = %d, want exactly 1", nStops(wk))
	}
	if dmState() != "tripped-stopped" || currentWorkoutState() != "IDLE" {
		t.Fatalf("state=%s workout=%s", dmState(), currentWorkoutState())
	}
}

func TestDeadmanBeltReachesZeroNoStop(t *testing.T) {
	sp, wk, t0 := tripCreeping(t)
	sp.mu.Lock()
	sp.belt = 0
	sp.mu.Unlock()
	for d := time.Second; d <= 10*time.Second; d += time.Second {
		deadmanEvaluate(t0.Add(d))
	}
	if nStops(wk) != 0 || dmState() != "tripped" || currentWorkoutState() != "RUNNING" {
		t.Fatalf("stops=%d state=%s workout=%s", nStops(wk), dmState(), currentWorkoutState())
	}
}

func TestDeadmanCreepClientReturnsBefore3sNoStop(t *testing.T) {
	_, wk, t0 := tripCreeping(t)
	now := t0.Add(2 * time.Second)
	lastClientNano.Store(now.UnixNano())
	deadmanEvaluate(now)
	for d := 3 * time.Second; d <= 8*time.Second; d += time.Second {
		now = t0.Add(d)
		lastClientNano.Store(now.UnixNano())
		deadmanEvaluate(now)
	}
	if nStops(wk) != 0 || dmState() != "off" {
		t.Fatalf("stops=%d state=%s", nStops(wk), dmState())
	}
}

func TestDeadmanCreepIFitWorkoutNoStop(t *testing.T) {
	sp, _, wk := reset(t)
	sp.follow = false
	now := time.Now()
	ageClient(now, 30*time.Second)
	setBridgeRun(false, 0.8, sp)
	mu.Lock()
	deadmanState, deadmanZeroAt = "tripped", now.Add(-10*time.Second)
	mu.Unlock()
	deadmanEvaluate(now)
	if nStops(wk) != 0 {
		t.Fatal("must not stop a workout the bridge did not start")
	}
}

func TestDeadmanCreepStopFailureRetriesMax5(t *testing.T) {
	_, wk, t0 := tripCreeping(t)
	wk.mu.Lock()
	wk.stopErr = fmt.Errorf("boom")
	wk.mu.Unlock()
	for d := time.Second; d <= 40*time.Second; d += 500 * time.Millisecond {
		deadmanEvaluate(t0.Add(d))
	}
	if nStops(wk) != 5 {
		t.Fatalf("stops = %d, want 5", nStops(wk))
	}
	if dmState() != "tripped" {
		t.Fatalf("state = %s", dmState())
	}
}
