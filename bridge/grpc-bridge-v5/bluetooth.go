package main

// v5: Bluetooth pairing endpoints (scan / connect / disconnect / list).
// READ/PAIR ONLY: this file must never reference the speed, incline or workout
// clients (enforced by TestBluetoothNeverTouchesMotor). Definition of the gRPC
// service was recovered statically, see docs/BT_PROTO_NOTES.md.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"

	pb "trailrunner-bridge/proto"
)

var (
	btClient pb.BluetoothServiceClient // nil until gRPC is connected

	btMu         sync.RWMutex
	btFound      []*pb.BluetoothDevice
	btConnected  []*pb.BluetoothDevice
	btScanning   bool
	btStreamsOK  bool
	btLastUpdate time.Time
)

var macRe = regexp.MustCompile(`^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`)

const btCallTimeout = 8 * time.Second

func btCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(grpcStreamCtx(), btCallTimeout)
}

// subscribeBluetooth keeps the cached device lists fresh. Each stream retries
// with a pause; a missing/old service just leaves the cache empty.
func subscribeBluetooth(c pb.BluetoothServiceClient) {
	btAutoOnce.Do(func() { go btAutoLoop() })
	// Raw dump of the found-devices stream (layout is inferred, so record what is really sent).
	go btLoop(func(ctx context.Context) error {
		cc := btRawConn
		if cc == nil {
			return fmt.Errorf("no raw conn")
		}
		st, err := cc.NewStream(ctx, &grpc.StreamDesc{ServerStreams: true}, "/com.ifit.glassos.BluetoothService/FoundDevicesChanged", grpc.ForceCodec(rawCodec{}))
		if err != nil {
			return err
		}
		if err := st.SendMsg(&rawMsg{}); err != nil {
			return err
		}
		st.CloseSend()
		for {
			var m rawMsg
			if err := st.RecvMsg(&m); err != nil {
				return err
			}
			var d pb.BluetoothDevice
			if err := proto.Unmarshal(m.b, &d); err != nil {
				log.Printf("[BT] found: undecodable %x: %v", m.b, err)
				continue
			}
			btMu.Lock()
			replaced := false
			for i, x := range btFound {
				if x.GetMacAddress() == d.GetMacAddress() {
					btFound[i], replaced = &d, true
				}
			}
			if !replaced {
				btFound = append(btFound, &d)
			}
			btStreamsOK, btLastUpdate = true, time.Now()
			btMu.Unlock()
			log.Printf("[BT] found: %s", d.String())
		}
	})
	go btLoop(func(ctx context.Context) error {
		st, err := c.BluetoothServiceStateChanged(ctx, &pb.Empty{})
		if err != nil {
			return err
		}
		for {
			m, err := st.Recv()
			if err != nil {
				return err
			}
			btMu.Lock()
			btConnected, btStreamsOK, btLastUpdate = m.GetConnectedDevices(), true, time.Now()
			log.Printf("[BT] state: %s", m.String())
			btMu.Unlock()
		}
	})
	go btLoop(func(ctx context.Context) error {
		st, err := c.ScanStateChanged(ctx, &pb.Empty{})
		if err != nil {
			return err
		}
		for {
			m, err := st.Recv()
			if err != nil {
				return err
			}
			btMu.Lock()
			btScanning, btStreamsOK, btLastUpdate = m.GetScanning(), true, time.Now()
			log.Printf("[BT] scan: %s", m.String())
			btMu.Unlock()
		}
	})
}

func btLoop(f func(ctx context.Context) error) {
	for {
		ctx, cancel := context.WithCancel(grpcStreamCtx())
		err := f(ctx)
		cancel()
		log.Printf("[BT] stream ended: %v", err)
		time.Sleep(3 * time.Second)
	}
}

type btDeviceJSON struct {
	Name      string `json:"name"`
	Address   string `json:"address"`
	Type      string `json:"type"`
	TypeCode  int32  `json:"typeCode"`
	Rssi      int32  `json:"rssi"`
	Signal    int    `json:"signal"` // 0..4 bars
	Battery   int32  `json:"battery"`
	State     string `json:"state"`
	Connected bool   `json:"connected"`
	PairKey   string `json:"pairKey,omitempty"`
	Reading   *int   `json:"reading,omitempty"` // live bpm for a connected HR strap
}

func btTypeName(t pb.BluetoothDeviceType) string {
	switch t {
	case pb.BluetoothDeviceType_BLE_HEART_RATE:
		return "heart_rate"
	case pb.BluetoothDeviceType_BLE_HEADPHONE:
		return "headphones"
	case pb.BluetoothDeviceType_BLE_IFIT_CONSOLE, pb.BluetoothDeviceType_BLE_IFIT_VIRTUAL_CONSOLE:
		return "console"
	case pb.BluetoothDeviceType_BLE_SMART_WATCH:
		return "watch"
	case pb.BluetoothDeviceType_ARCX_RING:
		return "ring"
	case pb.BluetoothDeviceType_BLE_PHONE_TABLET:
		return "phone"
	}
	return "other"
}

func btBars(rssi int32) int {
	switch {
	case rssi == 0:
		return 0
	case rssi >= -60:
		return 4
	case rssi >= -70:
		return 3
	case rssi >= -80:
		return 2
	}
	return 1
}

func btStateName(s pb.BluetoothConnectionState) string {
	switch s {
	case pb.BluetoothConnectionState_BLE_DEVICE_CONNECTED:
		return "connected"
	case pb.BluetoothConnectionState_BLE_DEVICE_CONNECTING:
		return "connecting"
	}
	return "disconnected"
}

func btConvert(d *pb.BluetoothDevice, connected bool, hr int) btDeviceJSON {
	o := btDeviceJSON{
		Name: d.GetDeviceName(), Address: strings.ToUpper(d.GetMacAddress()),
		Type: btTypeName(d.GetDeviceType()), TypeCode: int32(d.GetDeviceType()),
		Rssi: d.GetRssi(), Signal: btBars(d.GetRssi()), Battery: d.GetBatteryLevel(),
		State: btStateName(d.GetConnectionState()), Connected: connected, PairKey: d.GetPairKey(),
	}
	if connected {
		o.State = "connected"
		if d.GetDeviceType() == pb.BluetoothDeviceType_BLE_HEART_RATE && hr > 0 {
			v := hr
			o.Reading = &v
		}
	}
	if o.Name == "" {
		o.Name = o.Address
	}
	return o
}

// btSnapshot builds the response for GET /bluetooth/devices.
func btSnapshot(hr int) map[string]interface{} {
	btMu.RLock()
	defer btMu.RUnlock()
	conn := []btDeviceJSON{}
	seen := map[string]bool{}
	for _, d := range btConnected {
		a := strings.ToUpper(d.GetMacAddress())
		seen[a] = true
		conn = append(conn, btConvert(d, true, hr))
	}
	disc := []btDeviceJSON{}
	for _, d := range btFound {
		a := strings.ToUpper(d.GetMacAddress())
		if seen[a] {
			continue
		}
		seen[a] = true
		disc = append(disc, btConvert(d, false, hr))
	}
	sort.SliceStable(disc, func(i, k int) bool { return disc[i].Rssi > disc[k].Rssi })
	return map[string]interface{}{
		"available": true, "scanning": btScanning, "streams": btStreamsOK,
		"connected": conn, "discovered": disc, "hr": hr,
	}
}

func btJSONErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": msg})
}

func btUnavailable(w http.ResponseWriter) bool {
	if btClient == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		json.NewEncoder(w).Encode(map[string]interface{}{"available": false, "ok": false,
			"error": "bluetooth unavailable", "connected": []string{}, "discovered": []string{}})
		return true
	}
	return false
}

func handleBluetoothDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		http.Error(w, "GET only", 405)
		return
	}
	if btUnavailable(w) {
		return
	}
	mu.RLock()
	hr := int(currentHR)
	mu.RUnlock()
	j(w, btSnapshot(hr))
}

// btResultErr turns a BluetoothResult into an error string ("" on success).
func btResultErr(res *pb.BluetoothResult, err error) string {
	if err != nil {
		return err.Error()
	}
	if res == nil {
		return ""
	}
	if e := res.GetError(); e != nil {
		return fmt.Sprintf("bluetooth service refused: %v", e)
	}
	return ""
}

func btReply(w http.ResponseWriter, errStr string, extra map[string]interface{}) {
	if errStr != "" {
		btJSONErr(w, 502, errStr)
		return
	}
	out := map[string]interface{}{"ok": true}
	for k, v := range extra {
		out[k] = v
	}
	j(w, out)
}

func handleBluetoothScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return
	}
	if btUnavailable(w) {
		return
	}
	var body struct {
		Action  string `json:"action"`
		Start   *bool  `json:"start"`
		Timeout int32  `json:"timeoutSeconds"`
		All     bool   `json:"allDevices"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		btJSONErr(w, 400, "bad json")
		return
	}
	start := body.Action == "start" || (body.Start != nil && *body.Start)
	stop := body.Action == "stop" || (body.Start != nil && !*body.Start)
	if start == stop {
		btJSONErr(w, 400, `action must be "start" or "stop"`)
		return
	}
	ctx, cancel := btCtx()
	defer cancel()
	if stop {
		res, err := btClient.StopScan(ctx, &pb.Empty{})
		btReply(w, btResultErr(res, err), map[string]interface{}{"scanning": false})
		return
	}
	if body.Timeout <= 0 || body.Timeout > 120 {
		body.Timeout = 30
	}
	req := &pb.StartScanRequest{ScanTimeoutSeconds: body.Timeout}
	btMu.Lock()
	btFound = nil
	btMu.Unlock()
	if !body.All {
		req.DeviceTypes = []pb.BluetoothDeviceType{pb.BluetoothDeviceType_BLE_HEART_RATE}
	}
	res, err := btClient.StartScan(ctx, req)
	log.Printf("[BT] StartScan(hrOnly=%v) -> %v err=%v", !body.All, res, err)
	btReply(w, btResultErr(res, err), map[string]interface{}{"scanning": true})
}

type btAddrBody struct {
	Address string `json:"address"`
	Type    string `json:"type"`
}

func btParseAddr(w http.ResponseWriter, r *http.Request) (btAddrBody, bool) {
	var b btAddrBody
	if r.Method != "POST" {
		http.Error(w, "POST only", 405)
		return b, false
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		btJSONErr(w, 400, "bad json")
		return b, false
	}
	b.Address = strings.ToUpper(strings.TrimSpace(b.Address))
	if !macRe.MatchString(b.Address) {
		btJSONErr(w, 400, "address must look like AA:BB:CC:DD:EE:FF")
		return b, false
	}
	return b, true
}

func btFind(addr string) *pb.BluetoothDevice {
	btMu.RLock()
	defer btMu.RUnlock()
	for _, l := range [][]*pb.BluetoothDevice{btFound, btConnected} {
		for _, d := range l {
			if strings.EqualFold(d.GetMacAddress(), addr) {
				return d
			}
		}
	}
	return nil
}

func handleBluetoothConnect(w http.ResponseWriter, r *http.Request) {
	b, ok := btParseAddr(w, r)
	if !ok || btUnavailable(w) {
		return
	}
	ctx, cancel := btCtx()
	defer cancel()
	if d := btFind(b.Address); d != nil {
		res, err := btClient.ConnectDevice(ctx, d)
		msg := btResultErr(res, err)
		if msg == "" && d.GetDeviceType() == pb.BluetoothDeviceType_BLE_HEART_RATE {
			btRemember(b.Address)
		}
		btReply(w, msg, map[string]interface{}{"address": b.Address, "state": "connecting"})
		return
	}
	// Not in the scan cache: connect by MAC. Default to a heart-rate strap.
	dt := pb.BluetoothDeviceType_BLE_HEART_RATE
	if v, found := pb.BluetoothDeviceType_value[strings.ToUpper(b.Type)]; found {
		dt = pb.BluetoothDeviceType(v)
	}
	res, err := btClient.ConnectWithMACAddress(ctx, &pb.MACAddressConnectionRequest{MacAddress: b.Address, DeviceType: dt})
	msg := ""
	if err != nil {
		msg = err.Error()
	} else if res.GetDevice() == nil && res.GetEmpty() != nil {
		msg = "device not found - scan first"
	}
	if msg == "" && dt == pb.BluetoothDeviceType_BLE_HEART_RATE {
		btRemember(b.Address)
	}
	btReply(w, msg, map[string]interface{}{"address": b.Address, "state": "connecting"})
}

func handleBluetoothDisconnect(w http.ResponseWriter, r *http.Request) {
	b, ok := btParseAddr(w, r)
	if !ok || btUnavailable(w) {
		return
	}
	ctx, cancel := btCtx()
	defer cancel()
	d := btFind(b.Address)
	if d == nil {
		d = &pb.BluetoothDevice{MacAddress: b.Address}
	}
	// Cancel a pending connect first (harmless if none), then disconnect.
	_, _ = btClient.StopConnecting(ctx, d)
	res, err := btClient.DisconnectDevice(ctx, d)
	btForget(b.Address)
	btReply(w, btResultErr(res, err), map[string]interface{}{"address": b.Address, "state": "disconnected"})
}

func registerBluetoothRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/bluetooth/devices", cors(handleBluetoothDevices))
	mux.HandleFunc("/bluetooth/scan", cors(handleBluetoothScan))
	mux.HandleFunc("/bluetooth/connect", cors(handleBluetoothConnect))
	mux.HandleFunc("/bluetooth/disconnect", cors(handleBluetoothDisconnect))
}

// rawMsg/rawCodec let a stream be read as bytes without any proto definition.
type rawMsg struct{ b []byte }
type rawCodec struct{}

func (rawCodec) Marshal(v interface{}) ([]byte, error) { return v.(*rawMsg).b, nil }
func (rawCodec) Unmarshal(d []byte, v interface{}) error {
	v.(*rawMsg).b = append([]byte(nil), d...)
	return nil
}
func (rawCodec) Name() string { return "proto" }

var btRawConn *grpc.ClientConn
var btAutoOnce sync.Once
