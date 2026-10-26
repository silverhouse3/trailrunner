package main

// Remember a heart-rate strap once it has been connected from the Bluetooth screen, then
// find and reconnect it automatically whenever it is on, in range and not connected.
// Only the remembered strap is ever auto-connected (never a stranger's). Disconnecting from
// the screen forgets it. Bluetooth only: never touches speed, incline or the workout.

import (
	"log"
	"os"
	"strings"
	"sync"
	"time"

	pb "trailrunner-bridge/proto"
)

var btStrapMu sync.Mutex

func btStrapFile() string {
	if p := os.Getenv("BT_STRAP_FILE"); p != "" {
		return p
	}
	return "/sdcard/trailrunner/hr_strap.txt"
}

func btRemembered() string {
	btStrapMu.Lock()
	defer btStrapMu.Unlock()
	b, err := os.ReadFile(btStrapFile())
	if err != nil {
		return ""
	}
	m := strings.ToUpper(strings.TrimSpace(string(b)))
	if !macRe.MatchString(m) {
		return ""
	}
	return m
}

func btRemember(mac string) {
	btStrapMu.Lock()
	defer btStrapMu.Unlock()
	if err := os.WriteFile(btStrapFile(), []byte(strings.ToUpper(mac)+"\n"), 0644); err != nil {
		log.Printf("[BT] could not remember strap: %v", err)
		return
	}
	log.Printf("[BT] remembered strap %s", strings.ToUpper(mac))
}

func btForget(mac string) {
	if btRemembered() != strings.ToUpper(mac) {
		return
	}
	btStrapMu.Lock()
	defer btStrapMu.Unlock()
	os.Remove(btStrapFile())
	log.Printf("[BT] forgot strap %s", strings.ToUpper(mac))
}

func btHasConnectedHR() bool {
	btMu.RLock()
	defer btMu.RUnlock()
	for _, d := range btConnected {
		if d.GetDeviceType() == pb.BluetoothDeviceType_BLE_HEART_RATE {
			return true
		}
	}
	return false
}

// btAutoLoop: while a strap is remembered and none is connected, scan for 20 s every ~40 s
// and connect the remembered one as soon as it shows up.
func btAutoLoop() {
	time.Sleep(20 * time.Second)
	for {
		if mac := btRemembered(); mac != "" && !btHasConnectedHR() && btClient != nil {
			ctx, cancel := btCtx()
			_, err := btClient.StartScan(ctx, &pb.StartScanRequest{
				ScanTimeoutSeconds: 20,
				DeviceTypes:        []pb.BluetoothDeviceType{pb.BluetoothDeviceType_BLE_HEART_RATE},
			})
			cancel()
			if err == nil {
				for i := 0; i < 22; i++ {
					time.Sleep(time.Second)
					if d := btFind(mac); d != nil && !btHasConnectedHR() {
						ctx, cancel := btCtx()
						res, err := btClient.ConnectDevice(ctx, d)
						cancel()
						log.Printf("[BT] auto-connect %s -> %s", mac, btResultErr(res, err))
						time.Sleep(10 * time.Second)
						break
					}
				}
			}
		}
		time.Sleep(20 * time.Second)
	}
}
