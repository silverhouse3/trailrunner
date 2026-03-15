// TrailRunner gRPC Bridge — runs on the treadmill itself (no PC needed)
//
// Self-contained HTTP+WebSocket server that proxies commands from the
// TrailRunner PWA to glassos_service's gRPC API on localhost:54321.
//
// Architecture (all on the treadmill):
//   TrailRunner PWA (Chrome)
//     ↕ HTTP/WebSocket (localhost:4510)
//   This bridge (static ARM64 binary, ~15MB)
//     ↕ gRPC with mTLS (localhost:54321)
//   glassos_service
//     ↕ FitPro USB → Motor controller
//
// Build:
//   GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o trailrunner-bridge
//
// Deploy:
//   adb push trailrunner-bridge /data/local/tmp/
//   adb push keys/ /sdcard/trailrunner/keys/
//   adb shell chmod +x /data/local/tmp/trailrunner-bridge
//   adb shell /data/local/tmp/trailrunner-bridge &

package main

import (
	"context"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	pb "trailrunner-bridge/proto"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
)

const (
	listenAddr = "0.0.0.0:4510"
	grpcAddr   = "localhost:54321"
	clientID   = "com.ifit.eriador"
)

// ── Global state ────────────────────────────────────────────────────────────

var (
	mu            sync.RWMutex
	currentSpeed  float64
	currentIncl   float64
	currentHR     int
	workoutState  = "IDLE"
	workoutID     string
	grpcConnected bool

	speedClient    pb.SpeedServiceClient
	inclineClient  pb.InclineServiceClient
	workoutClient  pb.WorkoutServiceClient
	distClient     pb.DistanceServiceClient
	calClient      pb.CaloriesBurnedServiceClient
	timeClient     pb.ElapsedTimeServiceClient
	elevClient     pb.ElevationServiceClient
	consoleClient  pb.ConsoleServiceClient
	programClient  pb.ProgrammedWorkoutSessionServiceClient

	currentDist    float64 // km
	currentCals    float64 // kcal
	currentElapsed int32   // seconds
	currentElevGain float64 // meters

	// Console info (from ConsoleService)
	consoleInfo    *pb.ConsoleInfo
	consoleState   string // from ConsoleState enum
	safetyKeyOut   bool   // true when safety key is removed

	wsMu      sync.Mutex
	wsClients = make(map[*wsConn]bool)

	mqttClient    mqtt.Client
	mqttReady     bool
	lastMQTTPub   time.Time

	startTime = time.Now()
)

// ═══════════════════════════════════════════════════════════════════════════════
// gRPC CONNECTION + STREAMING
// ═══════════════════════════════════════════════════════════════════════════════

func connectGRPC() error {
	keysDir := findKeysDir()
	log.Printf("[gRPC] Using keys from: %s", keysDir)

	caCert, err := os.ReadFile(filepath.Join(keysDir, "ca_cert.txt"))
	if err != nil {
		return fmt.Errorf("read CA cert: %w", err)
	}
	clientCert, err := tls.LoadX509KeyPair(
		filepath.Join(keysDir, "cert.txt"),
		filepath.Join(keysDir, "key.txt"),
	)
	if err != nil {
		return fmt.Errorf("load client cert: %w", err)
	}

	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caCert)

	creds := credentials.NewTLS(&tls.Config{
		Certificates:       []tls.Certificate{clientCert},
		RootCAs:            caPool,
		InsecureSkipVerify: true,
	})

	conn, err := grpc.NewClient(grpcAddr,
		grpc.WithTransportCredentials(creds),
	)
	if err != nil {
		return fmt.Errorf("dial gRPC: %w", err)
	}

	speedClient = pb.NewSpeedServiceClient(conn)
	inclineClient = pb.NewInclineServiceClient(conn)
	workoutClient = pb.NewWorkoutServiceClient(conn)
	distClient = pb.NewDistanceServiceClient(conn)
	calClient = pb.NewCaloriesBurnedServiceClient(conn)
	timeClient = pb.NewElapsedTimeServiceClient(conn)
	elevClient = pb.NewElevationServiceClient(conn)
	consoleClient = pb.NewConsoleServiceClient(conn)
	programClient = pb.NewProgrammedWorkoutSessionServiceClient(conn)

	// Test connection
	state, err := workoutClient.GetWorkoutState(grpcCtx(), &pb.Empty{})
	if err != nil {
		return fmt.Errorf("GetWorkoutState: %w", err)
	}

	mu.Lock()
	workoutState = cleanState(state.WorkoutState.String())
	grpcConnected = true
	mu.Unlock()

	log.Printf("[gRPC] Connected! Workout state: %s", workoutState)

	// Initial values
	if s, err := speedClient.GetSpeed(grpcCtx(), &pb.Empty{}); err == nil {
		mu.Lock()
		currentSpeed = s.LastKph
		mu.Unlock()
		log.Printf("[gRPC] Speed: %.1f kph", s.LastKph)
	}
	if inc, err := inclineClient.GetIncline(grpcCtx(), &pb.Empty{}); err == nil {
		mu.Lock()
		currentIncl = inc.LastInclinePercent
		mu.Unlock()
		log.Printf("[gRPC] Incline: %.1f%%", inc.LastInclinePercent)
	}

	go subscribeSpeed()
	go subscribeIncline()
	go subscribeWorkoutState()
	go subscribeDistance()
	go subscribeCalories()
	go subscribeElapsedTime()
	go subscribeElevation()
	go fetchConsoleInfo()
	go subscribeConsoleState()

	return nil
}

func grpcCtx() context.Context {
	md := metadata.New(map[string]string{"client_id": clientID})
	ctx, _ := context.WithTimeout(context.Background(), 5*time.Second)
	return metadata.NewOutgoingContext(ctx, md)
}

func grpcStreamCtx() context.Context {
	md := metadata.New(map[string]string{"client_id": clientID})
	return metadata.NewOutgoingContext(context.Background(), md)
}

func cleanState(s string) string {
	return strings.TrimPrefix(s, "WORKOUT_STATE_")
}

func findKeysDir() string {
	// /data/local/tmp/keys is checked first — world-readable, works from APK context.
	// /sdcard/trailrunner/keys needs sdcard_rw group (stat succeeds but ReadFile fails
	// from untrusted_app context), so it's checked second as a fallback for ADB usage.
	for _, d := range []string{
		"/data/local/tmp/keys",
		"/sdcard/trailrunner/keys",
		filepath.Join(filepath.Dir(os.Args[0]), "keys"),
		"keys",
	} {
		// Verify we can actually READ the key files, not just stat them
		if f, err := os.Open(filepath.Join(d, "ca_cert.txt")); err == nil {
			f.Close()
			return d
		}
	}
	return "keys"
}

func subscribeSpeed() {
	for {
		stream, err := speedClient.SpeedSubscription(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[gRPC] Speed sub error: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		log.Println("[gRPC] Speed subscription active")
		for {
			m, err := stream.Recv()
			if err != nil {
				log.Printf("[gRPC] Speed stream ended: %v", err)
				break
			}
			mu.Lock()
			prev := currentSpeed
			currentSpeed = m.LastKph
			mu.Unlock()
			if m.LastKph != prev {
				log.Printf("[gRPC] Speed: %.1f kph (max=%.1f avg=%.1f)", m.LastKph, m.MaxKph, m.AvgKph)
			}
			broadcastState()
		}
		time.Sleep(2 * time.Second)
	}
}

func subscribeIncline() {
	for {
		stream, err := inclineClient.InclineSubscription(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[gRPC] Incline sub error: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		log.Println("[gRPC] Incline subscription active")
		for {
			m, err := stream.Recv()
			if err != nil {
				log.Printf("[gRPC] Incline stream ended: %v", err)
				break
			}
			mu.Lock()
			prev := currentIncl
			currentIncl = m.LastInclinePercent
			mu.Unlock()
			if m.LastInclinePercent != prev {
				log.Printf("[gRPC] Incline: %.1f%% (max=%.1f avg=%.1f)", m.LastInclinePercent, m.MaxInclinePercent, m.AvgInclinePercent)
			}
			broadcastState()
		}
		time.Sleep(2 * time.Second)
	}
}

func subscribeWorkoutState() {
	for {
		stream, err := workoutClient.WorkoutStateChanged(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[gRPC] Workout state sub error: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		log.Println("[gRPC] Workout state subscription active")
		for {
			msg, err := stream.Recv()
			if err != nil {
				log.Printf("[gRPC] Workout state stream ended: %v", err)
				break
			}
			mu.Lock()
			workoutState = cleanState(msg.WorkoutState.String())
			mu.Unlock()
			log.Printf("[gRPC] Workout state: %s", workoutState)
			broadcastState()
		}
		time.Sleep(2 * time.Second)
	}
}

func subscribeDistance() {
	for {
		stream, err := distClient.DistanceSubscription(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[gRPC] Distance sub error: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for {
			m, err := stream.Recv()
			if err != nil {
				break
			}
			mu.Lock()
			currentDist = m.LastDistanceKm
			mu.Unlock()
			broadcastState()
		}
		time.Sleep(2 * time.Second)
	}
}

func subscribeCalories() {
	for {
		stream, err := calClient.CaloriesBurnedSubscription(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[gRPC] Calories sub error: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for {
			m, err := stream.Recv()
			if err != nil {
				break
			}
			mu.Lock()
			currentCals = m.LastCalories
			mu.Unlock()
			broadcastState()
		}
		time.Sleep(2 * time.Second)
	}
}

func subscribeElapsedTime() {
	for {
		stream, err := timeClient.ElapsedTimeSubscription(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[gRPC] ElapsedTime sub error: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for {
			m, err := stream.Recv()
			if err != nil {
				break
			}
			mu.Lock()
			currentElapsed = m.TimeSeconds
			mu.Unlock()
			broadcastState()
		}
		time.Sleep(2 * time.Second)
	}
}

func subscribeElevation() {
	for {
		stream, err := elevClient.ElevationSubscription(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[gRPC] Elevation sub error: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		for {
			m, err := stream.Recv()
			if err != nil {
				break
			}
			mu.Lock()
			currentElevGain = m.ElevationGainMeters
			mu.Unlock()
			broadcastState()
		}
		time.Sleep(2 * time.Second)
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLE SERVICE — hardware info + safety key monitoring
// ═══════════════════════════════════════════════════════════════════════════════

func fetchConsoleInfo() {
	for i := 0; i < 5; i++ {
		info, err := consoleClient.GetConsole(grpcCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[Console] GetConsole attempt %d failed: %v", i+1, err)
			time.Sleep(3 * time.Second)
			continue
		}
		mu.Lock()
		consoleInfo = info
		mu.Unlock()
		log.Printf("[Console] Hardware: model=%d firmware=%s serial=%s maxKph=%.1f maxIncline=%.1f%% minIncline=%.1f%%",
			info.ModelNumber, info.FirmwareVersion, info.ProductSerialNumber,
			info.MaxKph, info.MaxInclinePercent, info.MinInclinePercent)
		return
	}
	log.Println("[Console] Could not fetch console info after 5 attempts")
}

func subscribeConsoleState() {
	for {
		stream, err := consoleClient.ConsoleStateChanged(grpcStreamCtx(), &pb.Empty{})
		if err != nil {
			log.Printf("[Console] State sub error: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Println("[Console] Console state subscription active")
		for {
			msg, err := stream.Recv()
			if err != nil {
				log.Printf("[Console] State stream ended: %v", err)
				break
			}
			stateName := msg.ConsoleState.String()
			mu.Lock()
			consoleState = stateName
			safetyKeyOut = (msg.ConsoleState == pb.ConsoleState_SAFETY_KEY_REMOVED)
			mu.Unlock()
			log.Printf("[Console] State: %s", stateName)

			// Safety key removed — emergency notification
			if msg.ConsoleState == pb.ConsoleState_SAFETY_KEY_REMOVED {
				log.Println("[SAFETY] Safety key removed! Publishing to MQTT")
				if mqttReady && mqttClient != nil {
					mqttClient.Publish(mqttTopicPrefix+"/safety_key", 1, false, "removed")
				}
			} else {
				if mqttReady && mqttClient != nil {
					mqttClient.Publish(mqttTopicPrefix+"/safety_key", 0, false, "ok")
				}
			}
			broadcastState()
		}
		time.Sleep(3 * time.Second)
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRAMMED WORKOUT SERVICE — push pre-built workouts to motor controller
// ═══════════════════════════════════════════════════════════════════════════════

func handleProgrammedWorkout(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}

	var req struct {
		Title      string `json:"title"`
		TargetType string `json:"targetType"` // TIME, DISTANCE, CALORIES
		TargetValue float64 `json:"targetValue"`
		Controls   []struct {
			Type  string  `json:"type"`  // MPS, INCLINE
			At    float64 `json:"at"`
			Value float64 `json:"value"`
		} `json:"controls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}

	// Build control list
	var controls []*pb.Control
	for _, c := range req.Controls {
		ct := pb.ControlType_CONTROL_TYPE_UNKNOWN
		switch strings.ToUpper(c.Type) {
		case "MPS":
			ct = pb.ControlType_CONTROL_TYPE_MPS
		case "INCLINE":
			ct = pb.ControlType_CONTROL_TYPE_INCLINE
		case "RESISTANCE":
			ct = pb.ControlType_CONTROL_TYPE_RESISTANCE
		}
		controls = append(controls, &pb.Control{
			Type:  ct,
			At:    c.At,
			Value: c.Value,
		})
	}

	// Map target type
	tt := pb.WorkoutTargetType_WORKOUT_TARGET_TYPE_SECONDS
	switch strings.ToUpper(req.TargetType) {
	case "DISTANCE":
		tt = pb.WorkoutTargetType_WORKOUT_TARGET_TYPE_METERS
	case "CALORIES":
		tt = pb.WorkoutTargetType_WORKOUT_TARGET_TYPE_CALORIES
	}

	// Build the workout segment
	workout := &pb.Workout{
		Title:       &req.Title,
		Controls:    &pb.ControlList{Controls: controls},
		TargetType:  tt,
		TargetValue: &req.TargetValue,
		WorkoutType: pb.WorkoutType_WORKOUT_TYPE_RUN,
	}

	segment := &pb.WorkoutSegmentDescriptor{
		WorkoutMetadata: &pb.ActivityLogMetadata{
			Title: req.Title,
		},
		ItemType:                   pb.ItemType_ITEM_TYPE_MAIN,
		ManualWorkoutLengthSeconds: req.TargetValue,
	}
	// Store workout in segment metadata
	_ = workout // workout data is encoded in controls
	_ = segment

	// Build AddAllWorkoutSegmentsRequest
	addReq := &pb.AddAllWorkoutSegmentsRequest{
		WorkoutSegments: []*pb.WorkoutSegmentDescriptor{segment},
	}

	resp, err := programClient.AddAndStart(grpcCtx(), addReq)
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}

	log.Printf("[PROGRAM] Workout '%s' pushed and started: %v", req.Title, resp)
	j(w, map[string]interface{}{"ok": true, "title": req.Title, "controls": len(req.Controls)})
}

func handleConsoleInfo(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	info := consoleInfo
	cs := consoleState
	sk := safetyKeyOut
	mu.RUnlock()

	if info == nil {
		j(w, map[string]interface{}{"ok": false, "error": "console info not available"})
		return
	}

	j(w, map[string]interface{}{
		"ok":                 true,
		"model_number":       info.ModelNumber,
		"part_number":        info.PartNumber,
		"firmware_version":   info.FirmwareVersion,
		"serial_number":      info.ProductSerialNumber,
		"brainboard_serial":  info.BrainboardSerialNumber,
		"max_kph":            info.MaxKph,
		"min_kph":            info.MinKph,
		"max_incline_pct":    info.MaxInclinePercent,
		"min_incline_pct":    info.MinInclinePercent,
		"can_set_speed":      info.CanSetSpeed,
		"can_set_incline":    info.CanSetIncline,
		"machine_type":       info.MachineType.String(),
		"console_state":      cs,
		"safety_key_removed": sk,
	})
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

func startHTTPServer() {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", cors(handleHealth))
	mux.HandleFunc("/state", cors(handleState))
	mux.HandleFunc("/workout/start", cors(handleWorkoutStart))
	mux.HandleFunc("/workout/stop", cors(handleWorkoutStop))
	mux.HandleFunc("/workout/pause", cors(handleWorkoutPause))
	mux.HandleFunc("/workout/resume", cors(handleWorkoutResume))
	mux.HandleFunc("/speed", cors(handleSpeed))
	mux.HandleFunc("/incline", cors(handleIncline))
	mux.HandleFunc("/command", cors(handleCommand))
	mux.HandleFunc("/api/state", cors(handleAPIState))
	mux.HandleFunc("/api/workout/summary", cors(handleWorkoutSummary))
	mux.HandleFunc("/api/console", cors(handleConsoleInfo))
	mux.HandleFunc("/workout/program", cors(handleProgrammedWorkout))
	mux.HandleFunc("/ws", handleWS)

	log.Printf("[HTTP] Listening on %s", listenAddr)
	if err := http.ListenAndServe(listenAddr, mux); err != nil {
		log.Fatalf("[HTTP] %v", err)
	}
}

func cors(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		h(w, r)
	}
}

func j(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	defer mu.RUnlock()
	j(w, map[string]interface{}{
		"status": "ok", "version": "3.2-native",
		"speed": currentSpeed, "incline": currentIncl, "hr": currentHR,
		"workoutState": workoutState, "workoutId": workoutID,
		"grpc": grpcConnected, "mqtt": mqttReady, "clients": len(wsClients),
	})
}

func handleState(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	defer mu.RUnlock()
	j(w, stateMsg())
}

func handleWorkoutStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	resp, err := workoutClient.StartNewWorkout(grpcCtx(), &pb.Empty{})
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	mu.Lock()
	workoutID = resp.WorkoutID
	workoutState = "RUNNING"
	mu.Unlock()
	broadcastState()
	j(w, map[string]interface{}{"ok": true, "workoutId": resp.WorkoutID})
}

func handleWorkoutStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	_, err := workoutClient.Stop(grpcCtx(), &pb.Empty{})
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	mu.Lock()
	workoutState = "IDLE"
	mu.Unlock()
	broadcastState()
	j(w, map[string]interface{}{"ok": true})
}

func handleWorkoutPause(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	_, err := workoutClient.Pause(grpcCtx(), &pb.Empty{})
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	mu.Lock()
	workoutState = "PAUSED"
	mu.Unlock()
	broadcastState()
	j(w, map[string]interface{}{"ok": true})
}

func handleWorkoutResume(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	_, err := workoutClient.Resume(grpcCtx(), &pb.Empty{})
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	mu.Lock()
	workoutState = "RUNNING"
	mu.Unlock()
	broadcastState()
	j(w, map[string]interface{}{"ok": true})
}

func handleSpeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	var req struct {
		KPH float64 `json:"kph"`
		MPH float64 `json:"mph"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	kph := req.KPH
	if kph == 0 && req.MPH > 0 {
		kph = req.MPH * 1.60934
	}
	// Safety: only allow speed changes when workout is running (or setting to 0)
	mu.RLock()
	state := workoutState
	mu.RUnlock()
	if kph > 0 && state != "RUNNING" {
		j(w, map[string]interface{}{"ok": false, "error": "workout not running", "state": state})
		return
	}
	_, err := speedClient.SetSpeed(grpcCtx(), &pb.SpeedRequest{Kph: clamp(kph, 0, 22)})
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	j(w, map[string]interface{}{"ok": true, "kph": kph})
}

func handleIncline(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	var req struct {
		Percent float64 `json:"percent"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	// Safety: only allow incline changes when workout is running (or resetting to 0)
	mu.RLock()
	state := workoutState
	mu.RUnlock()
	if req.Percent != 0 && state != "RUNNING" {
		j(w, map[string]interface{}{"ok": false, "error": "workout not running", "state": state})
		return
	}
	_, err := inclineClient.SetIncline(grpcCtx(), &pb.InclineRequest{Percent: clamp(req.Percent, -6, 40)})
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	j(w, map[string]interface{}{"ok": true, "percent": req.Percent})
}

func handleAPIState(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	defer mu.RUnlock()
	state := map[string]interface{}{
		"speed_kph":          currentSpeed,
		"speed_mph":          currentSpeed / 1.60934,
		"incline_pct":        currentIncl,
		"heart_rate":         currentHR,
		"distance_km":        currentDist,
		"calories":           currentCals,
		"elapsed_sec":        currentElapsed,
		"elevation_m":        currentElevGain,
		"workout_state":      workoutState,
		"workout_id":         workoutID,
		"grpc":               grpcConnected,
		"mqtt":               mqttReady,
		"ws_clients":         len(wsClients),
		"version":            "3.2",
		"uptime_sec":         int(time.Since(startTime).Seconds()),
		"console_state":      consoleState,
		"safety_key_removed": safetyKeyOut,
	}
	if consoleInfo != nil {
		state["max_kph"] = consoleInfo.MaxKph
		state["max_incline_pct"] = consoleInfo.MaxInclinePercent
		state["min_incline_pct"] = consoleInfo.MinInclinePercent
	}
	j(w, state)
}

func handleWorkoutSummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var summary map[string]interface{}
	if err := json.Unmarshal(body, &summary); err != nil {
		j(w, map[string]interface{}{"ok": false, "error": "invalid JSON"})
		return
	}
	log.Printf("[SUMMARY] Workout complete: %v", summary)

	// Publish to MQTT so HA can trigger automations
	if mqttReady && mqttClient != nil {
		mqttClient.Publish(mqttTopicPrefix+"/workout/summary", 1, false, body)
		log.Println("[SUMMARY] Published to MQTT")
	}
	j(w, map[string]interface{}{"ok": true})
}

func handleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	body, _ := io.ReadAll(r.Body)
	processMessage(body)
	j(w, map[string]interface{}{"ok": true})
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET (minimal RFC 6455)
// ═══════════════════════════════════════════════════════════════════════════════

type wsConn struct {
	conn   net.Conn
	mu     sync.Mutex
	closed bool
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	if strings.ToLower(r.Header.Get("Upgrade")) != "websocket" {
		http.Error(w, "WebSocket required", 400)
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "Missing key", 400)
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack failed", 500)
		return
	}
	conn, bufrw, err := hj.Hijack()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	h := sha1.New()
	h.Write([]byte(key + "258EAFA5-E914-47DA-95CA-5AB5A0F6CE10"))
	accept := base64.StdEncoding.EncodeToString(h.Sum(nil))

	bufrw.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	bufrw.WriteString("Upgrade: websocket\r\n")
	bufrw.WriteString("Connection: Upgrade\r\n")
	bufrw.WriteString("Sec-WebSocket-Accept: " + accept + "\r\n\r\n")
	bufrw.Flush()

	ws := &wsConn{conn: conn}
	wsMu.Lock()
	wsClients[ws] = true
	wsMu.Unlock()
	log.Println("[WS] Client connected")
	broadcastState()

	go func() {
		defer func() {
			wsMu.Lock()
			delete(wsClients, ws)
			wsMu.Unlock()
			conn.Close()
			log.Println("[WS] Client disconnected")
		}()
		buf := make([]byte, 8192)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			if msg := decodeWSFrame(buf[:n]); msg != nil {
				processMessage(msg)
			}
		}
	}()
}

func processMessage(data []byte) {
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	t, _ := msg["type"].(string)
	switch t {
	case "get":
		broadcastState()

	case "set":
		vals, ok := msg["values"].(map[string]interface{})
		if !ok {
			return
		}
		// Safety: check workout state before allowing motor commands
		mu.RLock()
		wsState := workoutState
		mu.RUnlock()
		if mph, ok := vals["MPH"].(float64); ok {
			kph := mph * 1.60934
			if kph > 0 && wsState != "RUNNING" {
				log.Printf("[WS] Blocked speed %.1f kph — workout is %s", kph, wsState)
			} else {
				go func() { speedClient.SetSpeed(grpcCtx(), &pb.SpeedRequest{Kph: clamp(kph, 0, 22)}) }()
			}
		} else if kph, ok := vals["KPH"].(float64); ok {
			if kph > 0 && wsState != "RUNNING" {
				log.Printf("[WS] Blocked speed %.1f kph — workout is %s", kph, wsState)
			} else {
				go func() { speedClient.SetSpeed(grpcCtx(), &pb.SpeedRequest{Kph: clamp(kph, 0, 22)}) }()
			}
		}
		if inc, ok := vals["Incline"].(float64); ok {
			if inc != 0 && wsState != "RUNNING" {
				log.Printf("[WS] Blocked incline %.1f%% — workout is %s", inc, wsState)
			} else {
				go func() { inclineClient.SetIncline(grpcCtx(), &pb.InclineRequest{Percent: clamp(inc, -6, 40)}) }()
			}
		} else if gr, ok := vals["Grade"].(float64); ok {
			if gr != 0 && wsState != "RUNNING" {
				log.Printf("[WS] Blocked incline %.1f%% — workout is %s", gr, wsState)
			} else {
				go func() { inclineClient.SetIncline(grpcCtx(), &pb.InclineRequest{Percent: clamp(gr, -6, 40)}) }()
			}
		}

	case "workout":
		action, _ := msg["action"].(string)
		var result map[string]interface{}
		switch action {
		case "start":
			resp, err := workoutClient.StartNewWorkout(grpcCtx(), &pb.Empty{})
			if err != nil {
				result = map[string]interface{}{"ok": false, "error": err.Error()}
			} else {
				mu.Lock()
				workoutID = resp.WorkoutID
				workoutState = "RUNNING"
				mu.Unlock()
				result = map[string]interface{}{"ok": true, "workoutId": resp.WorkoutID}
			}
		case "stop":
			_, err := workoutClient.Stop(grpcCtx(), &pb.Empty{})
			if err != nil {
				result = map[string]interface{}{"ok": false, "error": err.Error()}
			} else {
				mu.Lock()
				workoutState = "IDLE"
				mu.Unlock()
				result = map[string]interface{}{"ok": true}
			}
		case "pause":
			_, err := workoutClient.Pause(grpcCtx(), &pb.Empty{})
			if err != nil {
				result = map[string]interface{}{"ok": false, "error": err.Error()}
			} else {
				mu.Lock()
				workoutState = "PAUSED"
				mu.Unlock()
				result = map[string]interface{}{"ok": true}
			}
		case "resume":
			_, err := workoutClient.Resume(grpcCtx(), &pb.Empty{})
			if err != nil {
				result = map[string]interface{}{"ok": false, "error": err.Error()}
			} else {
				mu.Lock()
				workoutState = "RUNNING"
				mu.Unlock()
				result = map[string]interface{}{"ok": true}
			}
		}
		if result != nil {
			result["type"] = "workout_result"
			result["action"] = action
			d, _ := json.Marshal(result)
			broadcastWSData(d)
		}
		broadcastState()
	}
}

func stateMsg() map[string]interface{} {
	return map[string]interface{}{
		"type": "stats",
		"values": map[string]string{
			"KPH":        fmt.Sprintf("%.1f", currentSpeed),
			"Incline":    fmt.Sprintf("%.1f", currentIncl),
			"Heart Rate": fmt.Sprintf("%d", currentHR),
			"Distance":   fmt.Sprintf("%.3f", currentDist),
			"Calories":   fmt.Sprintf("%.0f", currentCals),
			"Elapsed":    fmt.Sprintf("%d", currentElapsed),
			"Elevation":  fmt.Sprintf("%.1f", currentElevGain),
		},
		"workout": map[string]interface{}{
			"state": workoutState,
			"id":    workoutID,
			"grpc":  grpcConnected,
		},
	}
}

func broadcastState() {
	mu.RLock()
	msg := stateMsg()
	mu.RUnlock()
	d, _ := json.Marshal(msg)
	broadcastWSData(d)
	publishMQTTState()
}

func broadcastWSData(data []byte) {
	wsMu.Lock()
	defer wsMu.Unlock()
	for ws := range wsClients {
		ws.send(data)
	}
}

func (ws *wsConn) send(data []byte) {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	if ws.closed {
		return
	}
	if _, err := ws.conn.Write(encodeWSFrame(data)); err != nil {
		ws.closed = true
	}
}

func encodeWSFrame(payload []byte) []byte {
	n := len(payload)
	var hdr []byte
	if n < 126 {
		hdr = []byte{0x81, byte(n)}
	} else if n < 65536 {
		hdr = []byte{0x81, 126, byte(n >> 8), byte(n)}
	} else {
		hdr = make([]byte, 10)
		hdr[0] = 0x81
		hdr[1] = 127
		for i := 0; i < 8; i++ {
			hdr[9-i] = byte(n >> (8 * i))
		}
	}
	return append(hdr, payload...)
}

func decodeWSFrame(buf []byte) []byte {
	if len(buf) < 2 {
		return nil
	}
	if buf[0]&0x0f != 0x01 {
		return nil // only text frames
	}
	masked := (buf[1] & 0x80) != 0
	plen := int(buf[1] & 0x7f)
	off := 2
	if plen == 126 {
		if len(buf) < 4 {
			return nil
		}
		plen = int(buf[2])<<8 | int(buf[3])
		off = 4
	} else if plen == 127 {
		if len(buf) < 10 {
			return nil
		}
		plen = 0
		for i := 2; i < 10; i++ {
			plen = plen<<8 | int(buf[i])
		}
		off = 10
	}
	var mask []byte
	if masked {
		if len(buf) < off+4 {
			return nil
		}
		mask = buf[off : off+4]
		off += 4
	}
	if len(buf) < off+plen {
		return nil
	}
	out := make([]byte, plen)
	copy(out, buf[off:off+plen])
	if masked {
		for i := range out {
			out[i] ^= mask[i&3]
		}
	}
	return out
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ═══════════════════════════════════════════════════════════════════════════════
// MQTT — Home Assistant auto-discovery + state publishing
// ═══════════════════════════════════════════════════════════════════════════════

const (
	mqttTopicPrefix = "trailrunner"
	mqttDeviceName  = "TrailRunner X32i"
)

func mqttDeviceJSON() string {
	return `{"identifiers":["trailrunner_x32i"],"name":"TrailRunner X32i","manufacturer":"NordicTrack","model":"X32i","sw_version":"3.2"}`
}

func connectMQTT() {
	broker := os.Getenv("MQTT_BROKER")
	if broker == "" {
		broker = "tcp://192.168.100.1:1883" // common router/HA address
	}

	opts := mqtt.NewClientOptions()
	opts.AddBroker(broker)
	opts.SetClientID("trailrunner-bridge")
	opts.SetKeepAlive(30 * time.Second)
	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(10 * time.Second)
	// Last Will: mark offline if bridge crashes
	opts.SetWill(mqttTopicPrefix+"/available", "offline", 1, true)
	opts.SetConnectionLostHandler(func(c mqtt.Client, err error) {
		log.Printf("[MQTT] Connection lost: %v", err)
		mqttReady = false
	})
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		log.Printf("[MQTT] Connected to %s", broker)
		mqttReady = true
		publishHADiscovery()
		subscribeCommands()
	})

	// Optional auth
	if u := os.Getenv("MQTT_USER"); u != "" {
		opts.SetUsername(u)
		opts.SetPassword(os.Getenv("MQTT_PASS"))
	}

	mqttClient = mqtt.NewClient(opts)
	go func() {
		log.Printf("[MQTT] Connecting to %s ...", broker)
		if token := mqttClient.Connect(); token.Wait() && token.Error() != nil {
			log.Printf("[MQTT] Initial connect failed: %v (will retry)", token.Error())
		}
	}()
}

func publishHADiscovery() {
	dev := mqttDeviceJSON()

	// Sensors
	sensors := []struct {
		name, id, unit, icon, valTpl string
		devClass                     string
	}{
		{"Speed", "speed", "km/h", "mdi:speedometer", "{{ value_json.speed }}", "speed"},
		{"Incline", "incline", "%", "mdi:slope-uphill", "{{ value_json.incline }}", ""},
		{"Heart Rate", "heart_rate", "bpm", "mdi:heart-pulse", "{{ value_json.hr }}", ""},
		{"Distance", "distance", "km", "mdi:map-marker-distance", "{{ value_json.distance }}", "distance"},
		{"Calories", "calories", "kcal", "mdi:fire", "{{ value_json.calories }}", ""},
		{"Duration", "duration", "s", "mdi:timer", "{{ value_json.elapsed }}", "duration"},
	}

	for _, s := range sensors {
		topic := fmt.Sprintf("homeassistant/sensor/trailrunner/%s/config", s.id)
		payload := map[string]interface{}{
			"name":                s.name,
			"unique_id":           "trailrunner_" + s.id,
			"state_topic":         mqttTopicPrefix + "/state",
			"value_template":      s.valTpl,
			"unit_of_measurement": s.unit,
			"icon":                s.icon,
			"device":              json.RawMessage(dev),
		}
		if s.devClass != "" {
			payload["device_class"] = s.devClass
		}
		d, _ := json.Marshal(payload)
		mqttClient.Publish(topic, 1, true, d)
	}

	// Workout state sensor
	statePayload := map[string]interface{}{
		"name":            "Workout State",
		"unique_id":       "trailrunner_workout_state",
		"state_topic":     mqttTopicPrefix + "/state",
		"value_template":  "{{ value_json.workout_state }}",
		"icon":            "mdi:run",
		"device":          json.RawMessage(dev),
	}
	d, _ := json.Marshal(statePayload)
	mqttClient.Publish("homeassistant/sensor/trailrunner/workout_state/config", 1, true, d)

	// Speed number control
	speedCtrl := map[string]interface{}{
		"name":            "Set Speed",
		"unique_id":       "trailrunner_set_speed",
		"command_topic":   mqttTopicPrefix + "/command/speed",
		"state_topic":     mqttTopicPrefix + "/state",
		"value_template":  "{{ value_json.speed }}",
		"min":             0, "max": 22, "step": 0.5,
		"unit_of_measurement": "km/h",
		"icon":            "mdi:speedometer",
		"device":          json.RawMessage(dev),
	}
	d, _ = json.Marshal(speedCtrl)
	mqttClient.Publish("homeassistant/number/trailrunner/set_speed/config", 1, true, d)

	// Incline number control
	incCtrl := map[string]interface{}{
		"name":            "Set Incline",
		"unique_id":       "trailrunner_set_incline",
		"command_topic":   mqttTopicPrefix + "/command/incline",
		"state_topic":     mqttTopicPrefix + "/state",
		"value_template":  "{{ value_json.incline }}",
		"min":             -6, "max": 40, "step": 0.5,
		"unit_of_measurement": "%",
		"icon":            "mdi:slope-uphill",
		"device":          json.RawMessage(dev),
	}
	d, _ = json.Marshal(incCtrl)
	mqttClient.Publish("homeassistant/number/trailrunner/set_incline/config", 1, true, d)

	// Workout control buttons
	buttons := []struct{ name, id, icon string }{
		{"Start Workout", "start", "mdi:play"},
		{"Stop Workout", "stop", "mdi:stop"},
		{"Pause Workout", "pause", "mdi:pause"},
		{"Resume Workout", "resume", "mdi:play-pause"},
	}
	for _, b := range buttons {
		topic := fmt.Sprintf("homeassistant/button/trailrunner/%s/config", b.id)
		payload := map[string]interface{}{
			"name":          b.name,
			"unique_id":     "trailrunner_" + b.id,
			"command_topic": mqttTopicPrefix + "/command/workout",
			"payload_press": b.id,
			"icon":          b.icon,
			"device":        json.RawMessage(dev),
		}
		d, _ := json.Marshal(payload)
		mqttClient.Publish(topic, 1, true, d)
	}

	// Binary sensor — safety key
	safetyPayload := map[string]interface{}{
		"name":            "Safety Key",
		"unique_id":       "trailrunner_safety_key",
		"state_topic":     mqttTopicPrefix + "/safety_key",
		"payload_on":      "removed",
		"payload_off":     "ok",
		"device_class":    "safety",
		"icon":            "mdi:key-alert",
		"device":          json.RawMessage(dev),
	}
	d, _ = json.Marshal(safetyPayload)
	mqttClient.Publish("homeassistant/binary_sensor/trailrunner/safety_key/config", 1, true, d)

	// Binary sensor — treadmill availability
	availPayload := map[string]interface{}{
		"name":            "Available",
		"unique_id":       "trailrunner_available",
		"state_topic":     mqttTopicPrefix + "/available",
		"payload_on":      "online",
		"payload_off":     "offline",
		"device_class":    "connectivity",
		"device":          json.RawMessage(dev),
	}
	d, _ = json.Marshal(availPayload)
	mqttClient.Publish("homeassistant/binary_sensor/trailrunner/available/config", 1, true, d)
	mqttClient.Publish(mqttTopicPrefix+"/available", 1, true, "online")

	log.Println("[MQTT] Home Assistant auto-discovery published")
}

func subscribeCommands() {
	mqttClient.Subscribe(mqttTopicPrefix+"/command/#", 1, func(c mqtt.Client, m mqtt.Message) {
		topic := m.Topic()
		payload := string(m.Payload())
		log.Printf("[MQTT] Command: %s = %s", topic, payload)

		switch {
		case strings.HasSuffix(topic, "/speed"):
			if kph, err := strconv.ParseFloat(payload, 64); err == nil {
				mu.RLock()
				mqState := workoutState
				mu.RUnlock()
				if kph > 0 && mqState != "RUNNING" {
					log.Printf("[MQTT] Blocked speed %.1f kph — workout is %s", kph, mqState)
				} else {
					speedClient.SetSpeed(grpcCtx(), &pb.SpeedRequest{Kph: clamp(kph, 0, 22)})
				}
			}
		case strings.HasSuffix(topic, "/incline"):
			if pct, err := strconv.ParseFloat(payload, 64); err == nil {
				mu.RLock()
				mqState := workoutState
				mu.RUnlock()
				if pct != 0 && mqState != "RUNNING" {
					log.Printf("[MQTT] Blocked incline %.1f%% — workout is %s", pct, mqState)
				} else {
					inclineClient.SetIncline(grpcCtx(), &pb.InclineRequest{Percent: clamp(pct, -6, 40)})
				}
			}
		case strings.HasSuffix(topic, "/workout"):
			switch payload {
			case "start":
				if resp, err := workoutClient.StartNewWorkout(grpcCtx(), &pb.Empty{}); err == nil {
					mu.Lock()
					workoutID = resp.WorkoutID
					workoutState = "RUNNING"
					mu.Unlock()
					broadcastState()
				}
			case "stop":
				if _, err := workoutClient.Stop(grpcCtx(), &pb.Empty{}); err == nil {
					mu.Lock()
					workoutState = "IDLE"
					mu.Unlock()
					broadcastState()
				}
			case "pause":
				if _, err := workoutClient.Pause(grpcCtx(), &pb.Empty{}); err == nil {
					mu.Lock()
					workoutState = "PAUSED"
					mu.Unlock()
					broadcastState()
				}
			case "resume":
				if _, err := workoutClient.Resume(grpcCtx(), &pb.Empty{}); err == nil {
					mu.Lock()
					workoutState = "RUNNING"
					mu.Unlock()
					broadcastState()
				}
			}
		}
	})
	log.Println("[MQTT] Subscribed to command topics")
}

func publishMQTTState() {
	if !mqttReady || mqttClient == nil {
		return
	}
	// Throttle: at most once per 2 seconds to avoid MQTT flooding
	now := time.Now()
	if now.Sub(lastMQTTPub) < 2*time.Second {
		return
	}
	lastMQTTPub = now
	mu.RLock()
	payload := map[string]interface{}{
		"speed":         currentSpeed,
		"incline":       currentIncl,
		"hr":            currentHR,
		"distance":      currentDist,
		"calories":      currentCals,
		"elapsed":       currentElapsed,
		"elevation":     currentElevGain,
		"workout_state": workoutState,
		"workout_id":    workoutID,
		"grpc":          grpcConnected,
	}
	mu.RUnlock()
	d, _ := json.Marshal(payload)
	mqttClient.Publish(mqttTopicPrefix+"/state", 0, false, d)
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

func main() {
	fmt.Println("")
	fmt.Println("  ╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("  ║  TrailRunner Bridge v3.2 (Native ARM64)                      ║")
	fmt.Println("  ║  Direct Motor Control — No PC Required                       ║")
	fmt.Println("  ║  gRPC + MQTT → glassos_service → FitPro → Motor              ║")
	fmt.Println("  ╚══════════════════════════════════════════════════════════════╝")
	fmt.Println("")

	// Connect MQTT (non-blocking, retries in background)
	connectMQTT()

	// Connect to glassos gRPC (retry loop)
	for {
		err := connectGRPC()
		if err == nil {
			break
		}
		log.Printf("[gRPC] Failed: %v — retrying in 5s...", err)
		time.Sleep(5 * time.Second)
	}

	// Periodic state broadcast + heartbeat
	go func() {
		tick := 0
		for {
			time.Sleep(2 * time.Second)
			broadcastState()
			tick++
			if tick%150 == 0 { // every 5 minutes
				mu.RLock()
				log.Printf("[HEARTBEAT] speed=%.1f incline=%.1f workout=%s grpc=%v clients=%d",
					currentSpeed, currentIncl, workoutState, grpcConnected, len(wsClients))
				mu.RUnlock()
			}
		}
	}()

	// Graceful shutdown — mark offline on MQTT before exit
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	go func() {
		<-sigCh
		log.Println("[BRIDGE] Shutting down...")
		if mqttReady && mqttClient != nil {
			mqttClient.Publish(mqttTopicPrefix+"/available", 1, true, "offline")
			time.Sleep(200 * time.Millisecond)
			mqttClient.Disconnect(500)
		}
		os.Exit(0)
	}()

	fmt.Println("")
	fmt.Println("[BRIDGE] Ready!")
	fmt.Printf("[BRIDGE] PWA connect to: http://localhost:4510/ws\n")
	fmt.Printf("[BRIDGE] REST API: /workout/start, /workout/stop, /speed, /incline\n")
	fmt.Println("")

	// Blocks
	startHTTPServer()
}
