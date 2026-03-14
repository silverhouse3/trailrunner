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
	"path/filepath"
	"strings"
	"sync"
	"time"

	pb "trailrunner-bridge/proto"

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

	speedClient   pb.SpeedServiceClient
	inclineClient pb.InclineServiceClient
	workoutClient pb.WorkoutServiceClient

	wsMu      sync.Mutex
	wsClients = make(map[*wsConn]bool)
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
	for _, d := range []string{
		"/sdcard/trailrunner/keys",
		"/data/local/tmp/keys",
		filepath.Join(filepath.Dir(os.Args[0]), "keys"),
		"keys",
	} {
		if _, err := os.Stat(filepath.Join(d, "ca_cert.txt")); err == nil {
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
			currentSpeed = m.LastKph
			mu.Unlock()
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
			currentIncl = m.LastInclinePercent
			mu.Unlock()
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
		"status": "ok", "version": "3.0-native",
		"speed": currentSpeed, "incline": currentIncl, "hr": currentHR,
		"workoutState": workoutState, "workoutId": workoutID,
		"grpc": grpcConnected, "clients": len(wsClients),
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
	_, err := inclineClient.SetIncline(grpcCtx(), &pb.InclineRequest{Percent: clamp(req.Percent, -6, 40)})
	if err != nil {
		j(w, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	j(w, map[string]interface{}{"ok": true, "percent": req.Percent})
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
		if mph, ok := vals["MPH"].(float64); ok {
			go func() { speedClient.SetSpeed(grpcCtx(), &pb.SpeedRequest{Kph: clamp(mph*1.60934, 0, 22)}) }()
		} else if kph, ok := vals["KPH"].(float64); ok {
			go func() { speedClient.SetSpeed(grpcCtx(), &pb.SpeedRequest{Kph: clamp(kph, 0, 22)}) }()
		}
		if inc, ok := vals["Incline"].(float64); ok {
			go func() { inclineClient.SetIncline(grpcCtx(), &pb.InclineRequest{Percent: clamp(inc, -6, 40)}) }()
		} else if gr, ok := vals["Grade"].(float64); ok {
			go func() { inclineClient.SetIncline(grpcCtx(), &pb.InclineRequest{Percent: clamp(gr, -6, 40)}) }()
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
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

func main() {
	fmt.Println("")
	fmt.Println("  ╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("  ║  TrailRunner Bridge v3.0 (Native ARM64)                      ║")
	fmt.Println("  ║  Direct Motor Control — No PC Required                       ║")
	fmt.Println("  ║  gRPC → glassos_service → FitPro → Motor                    ║")
	fmt.Println("  ╚══════════════════════════════════════════════════════════════╝")
	fmt.Println("")

	// Connect to glassos gRPC (retry loop)
	for {
		err := connectGRPC()
		if err == nil {
			break
		}
		log.Printf("[gRPC] Failed: %v — retrying in 5s...", err)
		time.Sleep(5 * time.Second)
	}

	// Periodic state broadcast
	go func() {
		for {
			time.Sleep(2 * time.Second)
			broadcastState()
		}
	}()

	fmt.Println("")
	fmt.Println("[BRIDGE] Ready!")
	fmt.Printf("[BRIDGE] PWA connect to: http://localhost:4510/ws\n")
	fmt.Printf("[BRIDGE] REST API: /workout/start, /workout/stop, /speed, /incline\n")
	fmt.Println("")

	// Blocks
	startHTTPServer()
}
