# ICON FitPro Protocol — NordicTrack X32i Motor Controller

**Reverse-engineered from**: `com.ifit.glassos_service` APK + live Valinor log capture
**Date**: 2026-03-09
**Status**: gRPC API fully mapped, log parsing confirmed, USB HID packets partially decoded

## Overview

The NordicTrack X32i uses a proprietary protocol called **FitPro** to communicate
between the Android tablet and the motor controller board (MCU: PSOC).

Communication is via **USB HID** (class 3, interrupt endpoints), NOT CDC ACM.
The glassos_service exposes 58 gRPC services over Android Binder IPC, used by
iFIT (rivendell/gandalf) to control speed, incline, fan, etc.

## USB Device (from live capture)

```
UsbDevice[mName=/dev/bus/usb/001/002]
  mVendorId=8508 (0x213C, ICON Fitness)
  mProductId=2
  mManufacturerName=ICON Fitness
  mProductName=ICON Generic HID
  mVersion=2.0
  mSerialNumber=null

UsbConfiguration[mId=1, mName=Fitness Equipment]
  UsbInterface[mId=0, mName=USB Data Interface, mClass=3 (HID)]
    UsbEndpoint[mAddress=0x81, mAttributes=3 (interrupt), mMaxPacketSize=64, IN]
    UsbEndpoint[mAddress=0x02, mAttributes=3 (interrupt), mMaxPacketSize=64, OUT]
```

## Architecture

```
Android Tablet (iFIT / glassos_service)
    |
    | USB HID (interrupt endpoints, 64-byte packets)
    | VID: 0x213C  PID: 0x0002
    |
Motor Controller Board (PSOC MCU)
    |
    +-- Drive Motor (belt speed, 0-22 km/h)
    +-- Incline Motor (grade, -6% to +40%)
    +-- Fan Motor (OFF/LOW/MEDIUM/HIGH/AUTO)
    +-- Safety Key Monitor
    +-- Heart Rate Receiver (ANT+)
```

## Packet Format

```
Byte 0:     Command ID (non-zero for valid packets)
Byte 1:     Packet Length (total bytes, 3-64)
Byte 2:     Sub-command / BitField ID
...         Payload data
Byte N-1:   Checksum (at position bytes[bytes[1]-1])
```

## Checksum Algorithm (confirmed)

```javascript
function checksum(bytes) {
    let sum = 0;
    for (let i = 0; i < (bytes[1] - 1); i++) {
        sum = ((sum & 0xFF) + (bytes[i] & 0xFF));
    }
    return sum & 0xFF;
}
```

## Validation Rules

1. `bytes.length >= 3`
2. `bytes[0] != 0` (command ID non-zero)
3. `3 <= bytes[1] <= 64` (length field valid)
4. `bytes[1] <= bytes.length` (length doesn't exceed buffer)
5. `bytes[bytes[1]-1] == checksum(bytes)` (checksum matches)

## Key BitField IDs

### Speed Control
| Field | ID | Access | Unit | Range |
|-------|-----|--------|------|-------|
| TARGET_KPH | 301 | R/W | 0.01 km/h | 0–1931 (0–19.31 km/h) |
| CURRENT_KPH | 302 | R | 0.01 km/h | |
| MIN_KPH | 303 | R | | |
| MAX_KPH | 304 | R | | |

### Incline Control
| Field | ID | Access | Unit | Range |
|-------|-----|--------|------|-------|
| TARGET_GRADE_PERCENT | 401 | R/W | 0.01% | -600 to 4000 (-6% to +40%) |
| CURRENT_GRADE_PERCENT | 402 | R | 0.01% | |
| MIN_GRADE_PERCENT | 403 | R | | -600 |
| MAX_GRADE_PERCENT | 404 | R | | 4000 |
| CALIBRATE_GRADE | 415 | R/W | | |

### Workout Control
| Field | ID | Access | Notes |
|-------|-----|--------|-------|
| WORKOUT_STATE | 602 | R/W | Start/stop/pause |
| START_REQUESTED | 612 | R/W | Request workout start |
| EXIT_WORKOUT_REQUESTED | 613 | R/W | Request workout end |

### Heart Rate
| Field | ID | Access | Notes |
|-------|-----|--------|-------|
| PULSE | 222 | R/W | BPM |
| PULSE_SOURCE | 223 | R | Which sensor |
| HEART_BEAT_INTERVAL | 161 | R/W | RR interval |

### Fan
| Field | ID | Access | Notes |
|-------|-----|--------|-------|
| FAN_LEVEL_PERCENT | 126 | R/W | 0-100 |
| FAN_STATE | 129 | R/W | On/off |

### System
| Field | ID | Access | Notes |
|-------|-----|--------|-------|
| SYSTEM_MODE | 102 | R/W | Operating mode |
| TABLET_CONNECTION_STATUS | 122 | R/W | |
| DISPLAY_UNITS | 140 | R/W | Metric/imperial |

## X32i Specific Config

- Model: NTL39221 (ETNT39221)
- Equipment Type: INCLINE_TRAINER_DEVICE
- MCU: PSOC
- System Config: MULTI_MASTER
- Max Speed: 19.31 km/h (12 mph)
- Incline Range: -6% to +40%
- Grade Protocol: SingleDCShortbusGrade
- Speed Protocol: Manual

### Safety Speed Limits at Decline
| Grade | Max Speed |
|-------|-----------|
| -10% to -5% | ~9.7 km/h |
| -3% | ~11.3 km/h |
| -2% | ~12.9 km/h |
| -1% | ~13.7 km/h |
| 0%+ | 19.31 km/h |

## USB Connection Setup

1. Open USB device (VID: 0x213C, PID: 0x0002)
2. Claim USB interface (CDC ACM)
3. Find IN and OUT bulk endpoints
4. Set DTR/RTS via control transfer:
   ```
   requestType: 0x20 (USB_DIR_OUT | USB_TYPE_CLASS | USB_RECIP_INTERFACE)
   request: 0x22 (SET_CONTROL_LINE_STATE)
   value: DTR (bit 0) | RTS (bit 1)
   index: 0 (interface)
   timeout: 5000ms
   ```
5. Start async read loop on IN endpoint
6. Send commands on OUT endpoint

## glassos_service gRPC API

The service also exposes gRPC methods internally:
```
SpeedService.setSpeed(SpeedRequest) -> Object
SpeedService.speedSubscription(Empty) -> Flow<SpeedResponse>
InclineService.setIncline(InclineRequest) -> Object
InclineService.inclineSubscription(Empty) -> Flow<InclineResponse>
```

## Still Unknown

1. **Exact command byte (byte 0)** for read vs write operations
2. **How BitField IDs are encoded** in the packet (1 byte, 2 bytes, varint?)
3. **How values are encoded** (int16, int32, float?)
4. **Initialization handshake** sequence
5. **eru IPC protocol** on port 54321

## How to Complete This

Capture USB traffic while glassos_service is running:
```bash
# On the treadmill (needs root or debug build):
adb shell tcpdump -i any -w /sdcard/usb_capture.pcap

# Or use usbmon on Linux:
modprobe usbmon
cat /sys/kernel/debug/usb/usbmon/1u > capture.txt

# Or intercept glassos_service with frida:
frida -U -f com.ifit.glassos_service -l usb_hooks.js
```

## References

- QZCompanion: https://github.com/cagnulein/QZCompanionNordictrackTreadmill
- qdomyos-zwift: https://github.com/cagnulein/qdomyos-zwift
- fl3xbl0w (Bowflex): https://github.com/barrenechea/fl3xbl0w
- nordichack: https://github.com/mch/nordichack
- Full decompile results: D:/Nordic/DECOMPILE_RESULTS.md
- X32i config: D:/Nordic/ETNT39221.xml
- BitField enum: D:/Nordic/bitfield_enum_source.txt
