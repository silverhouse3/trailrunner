package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"testing"

	"google.golang.org/grpc"
	pb "trailrunner-bridge/proto"
)

type fakeBT struct {
	pb.BluetoothServiceClient
	calls   []string
	lastDev *pb.BluetoothDevice
	lastReq *pb.StartScanRequest
	result  *pb.BluetoothResult
	macRes  *pb.MACAddressConnectionResult
}

func (f *fakeBT) rec(n string) { f.calls = append(f.calls, n) }
func (f *fakeBT) ok() *pb.BluetoothResult {
	if f.result != nil {
		return f.result
	}
	return &pb.BluetoothResult{ErrorOrSuccess: &pb.BluetoothResult_Success{Success: true}}
}
func (f *fakeBT) StartScan(_ context.Context, r *pb.StartScanRequest, _ ...grpc.CallOption) (*pb.BluetoothResult, error) {
	f.rec("StartScan")
	f.lastReq = r
	return f.ok(), nil
}
func (f *fakeBT) StopScan(_ context.Context, _ *pb.Empty, _ ...grpc.CallOption) (*pb.BluetoothResult, error) {
	f.rec("StopScan")
	return f.ok(), nil
}
func (f *fakeBT) ConnectDevice(_ context.Context, d *pb.BluetoothDevice, _ ...grpc.CallOption) (*pb.BluetoothResult, error) {
	f.rec("ConnectDevice")
	f.lastDev = d
	return f.ok(), nil
}
func (f *fakeBT) StopConnecting(_ context.Context, d *pb.BluetoothDevice, _ ...grpc.CallOption) (*pb.BluetoothResult, error) {
	f.rec("StopConnecting")
	return f.ok(), nil
}
func (f *fakeBT) DisconnectDevice(_ context.Context, d *pb.BluetoothDevice, _ ...grpc.CallOption) (*pb.BluetoothResult, error) {
	f.rec("DisconnectDevice")
	f.lastDev = d
	return f.ok(), nil
}
func (f *fakeBT) ConnectWithMACAddress(_ context.Context, r *pb.MACAddressConnectionRequest, _ ...grpc.CallOption) (*pb.MACAddressConnectionResult, error) {
	f.rec("ConnectWithMACAddress")
	if f.macRes != nil {
		return f.macRes, nil
	}
	return &pb.MACAddressConnectionResult{EmptyOrDevice: &pb.MACAddressConnectionResult_Device{Device: &pb.BluetoothDevice{MacAddress: r.MacAddress}}}, nil
}

func btSetup(t *testing.T) *fakeBT {
	f := &fakeBT{}
	btClient = f
	btMu.Lock()
	btFound = []*pb.BluetoothDevice{
		{DeviceName: "Weak", MacAddress: "aa:bb:cc:00:00:02", Rssi: -85, DeviceType: pb.BluetoothDeviceType_BLE_OTHER},
		{DeviceName: "Polar H10", MacAddress: "AA:BB:CC:00:00:01", Rssi: -55, DeviceType: pb.BluetoothDeviceType_BLE_HEART_RATE, PairKey: "pk"},
		{DeviceName: "Dup", MacAddress: "AA:BB:CC:00:00:09", Rssi: -50},
	}
	btConnected = []*pb.BluetoothDevice{{DeviceName: "Dup", MacAddress: "AA:BB:CC:00:00:09", DeviceType: pb.BluetoothDeviceType_BLE_HEART_RATE}}
	btMu.Unlock()
	t.Cleanup(func() { btClient = nil; btMu.Lock(); btFound, btConnected = nil, nil; btMu.Unlock() })
	return f
}

func btDo(h http.HandlerFunc, method, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/x", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func TestBluetoothDevicesSnapshot(t *testing.T) {
	btSetup(t)
	mu.Lock()
	currentHR = 72
	mu.Unlock()
	w := btDo(handleBluetoothDevices, "GET", "")
	var out struct {
		Connected  []btDeviceJSON `json:"connected"`
		Discovered []btDeviceJSON `json:"discovered"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Connected) != 1 || out.Connected[0].Reading == nil || *out.Connected[0].Reading != 72 {
		t.Fatalf("connected wrong: %+v", out.Connected)
	}
	if len(out.Discovered) != 2 || out.Discovered[0].Name != "Polar H10" || out.Discovered[0].Type != "heart_rate" || out.Discovered[0].Signal != 4 {
		t.Fatalf("discovered wrong (sorted by signal, dup removed): %+v", out.Discovered)
	}
	mu.Lock()
	currentHR = 0
	mu.Unlock()
}

func TestBluetoothUnavailable(t *testing.T) {
	btClient = nil
	if w := btDo(handleBluetoothDevices, "GET", ""); w.Code != 503 {
		t.Fatalf("want 503 got %d", w.Code)
	}
	if w := btDo(handleBluetoothScan, "POST", `{"action":"start"}`); w.Code != 503 {
		t.Fatalf("want 503 got %d", w.Code)
	}
}

func TestBluetoothScan(t *testing.T) {
	f := btSetup(t)
	if w := btDo(handleBluetoothScan, "POST", `{"action":"start"}`); w.Code != 200 || f.lastReq.ScanTimeoutSeconds != 30 {
		t.Fatalf("start: %d %v", w.Code, f.lastReq)
	}
	if w := btDo(handleBluetoothScan, "POST", `{"action":"stop"}`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := btDo(handleBluetoothScan, "POST", `{"action":"bogus"}`); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := btDo(handleBluetoothScan, "GET", ""); w.Code != 405 {
		t.Fatal(w.Code)
	}
	if got := f.calls; len(got) != 2 || got[0] != "StartScan" || got[1] != "StopScan" {
		t.Fatalf("calls %v", got)
	}
}

func TestBluetoothConnectDisconnect(t *testing.T) {
	f := btSetup(t)
	if w := btDo(handleBluetoothConnect, "POST", `{"address":"aa:bb:cc:00:00:01"}`); w.Code != 200 || f.lastDev.PairKey != "pk" {
		t.Fatalf("connect known: %d %v", w.Code, f.lastDev)
	}
	if w := btDo(handleBluetoothConnect, "POST", `{"address":"11:22:33:44:55:66"}`); w.Code != 200 || f.calls[len(f.calls)-1] != "ConnectWithMACAddress" {
		t.Fatalf("connect unknown: %d %v", w.Code, f.calls)
	}
	f.macRes = &pb.MACAddressConnectionResult{EmptyOrDevice: &pb.MACAddressConnectionResult_Empty{Empty: &pb.Empty{}}}
	if w := btDo(handleBluetoothConnect, "POST", `{"address":"11:22:33:44:55:66"}`); w.Code != 502 {
		t.Fatalf("not found should 502, got %d", w.Code)
	}
	for _, bad := range []string{`{"address":"nope"}`, `{}`, `x`, `{"address":"AA:BB:CC:00:00:01; rm"}`} {
		if w := btDo(handleBluetoothConnect, "POST", bad); w.Code != 400 {
			t.Fatalf("%s -> %d", bad, w.Code)
		}
	}
	f.calls = nil
	if w := btDo(handleBluetoothDisconnect, "POST", `{"address":"AA:BB:CC:00:00:09"}`); w.Code != 200 || f.lastDev.MacAddress != "AA:BB:CC:00:00:09" {
		t.Fatal(w.Code)
	}
	if len(f.calls) != 2 || f.calls[1] != "DisconnectDevice" {
		t.Fatalf("calls %v", f.calls)
	}
}

func TestBluetoothServiceErrorSurfaced(t *testing.T) {
	f := btSetup(t)
	f.result = &pb.BluetoothResult{ErrorOrSuccess: &pb.BluetoothResult_Error{Error: &pb.IFitError{}}}
	if w := btDo(handleBluetoothScan, "POST", `{"action":"start"}`); w.Code != 502 {
		t.Fatalf("want 502 got %d", w.Code)
	}
}

// Safety: the bluetooth file may never reach the motor/workout clients.
func TestBluetoothNeverTouchesMotor(t *testing.T) {
	src, err := os.ReadFile("bluetooth.go")
	if err != nil {
		t.Fatal(err)
	}
	bad := regexp.MustCompile(`speedClient|inclineClient|workoutClient|programClient|safeSpeedSet|safeInclineSet|SetSpeed|SetIncline|StartWorkout|StopWorkout`)
	if m := bad.Find(src); m != nil {
		t.Fatalf("bluetooth.go references motor symbol %q", m)
	}
}

func TestStrapRememberForget(t *testing.T) {
	t.Setenv("BT_STRAP_FILE", t.TempDir()+"/strap.txt")
	if btRemembered() != "" {
		t.Fatal("should start empty")
	}
	btRemember("a0:9e:1a:d6:38:ed")
	if btRemembered() != "A0:9E:1A:D6:38:ED" {
		t.Fatalf("got %q", btRemembered())
	}
	btForget("11:22:33:44:55:66") // a different device must not forget it
	if btRemembered() == "" {
		t.Fatal("forgot the wrong device")
	}
	btForget("A0:9E:1A:D6:38:ED")
	if btRemembered() != "" {
		t.Fatal("should be forgotten")
	}
}
