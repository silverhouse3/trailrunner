# NordicTrack X32i Treadmill — Complete Probe Report
**Date:** 2026-03-13
**Device:** MalataSamsungArgon1 (NordicTrack Commercial X32i)
**Android:** 7.1.2 (API 25), SELinux PERMISSIVE
**IP:** 192.168.100.54 | **ADB:** TCP port 5555
**Part Number:** 416429 (ETNT39221) | **Product:** NTL39221
**Config:** MULTI_MASTER, PSOC MCU, DC Lift, InclineTrainer
**Screen:** 1920x1024 @ 160dpi (31")

---

## 1. Architecture Discovery

### Communication Stack
```
iFIT Apps (arda, gandalf, rivendell, launcher)
    ↓ gRPC (mTLS, port 54321)
glassos_service (PID 14463)
    ↓ FitPro ReadWriteDataCmd (USB HID)
Motor Controller (VID 0x213C, PID 0x0002, "ICON Generic HID")
    ↓ Physical
Belt motor + Incline actuator
```

### USB HID Details
- **VID:** 0x213C | **PID:** 0x0002
- **Endpoints:** ep_81 (IN, interrupt, 64 bytes) and ep_02 (OUT, interrupt, 64 bytes)
- **Interval:** 1ms
- **Access:** `crw-rw---- root usb` — NOT accessible to shell user
- **Rate:** ~7 commands/second (40,000+ per 100 min uptime)

### iFIT Process Ecosystem
| Process | Package | Role |
|---------|---------|------|
| glassos_service | com.ifit.glassos_service | Core: USB HID ↔ gRPC bridge |
| arda | com.ifit.arda | Main iFIT UI app |
| gandalf | com.ifit.gandalf | Workout management |
| rivendell | com.ifit.rivendell | Data/subscription service |
| launcher | com.ifit.launcher | Home screen launcher |
| eru | com.ifit.eru | Background/update service |

---

## 2. gRPC Service Catalog (63 Services, 160+ Proto Files)

### CRITICAL — Treadmill Control Services

#### SpeedService (`workout/SpeedService.proto`)
```protobuf
service SpeedService {
  rpc CanRead(Empty) returns (AvailabilityResponse);
  rpc CanWrite(Empty) returns (AvailabilityResponse);
  rpc GetSpeed(Empty) returns (SpeedMetric);
  rpc SetSpeed(SpeedRequest) returns (WorkoutResult);        // ← SET SPEED!
  rpc SpeedSubscription(Empty) returns (stream SpeedMetric);
  rpc GetSpeedHistory(WorkoutID) returns (SpeedMetricList);
  rpc FollowWorkout(Empty) returns (WorkoutResult);
  rpc StopFollowing(Empty) returns (Empty);
  rpc GetIsFollowing(Empty) returns (BooleanResponse);
  rpc IsFollowingSubscription(Empty) returns (stream BooleanResponse);
  rpc GetControls(Empty) returns (ControlList);
  rpc ControlsSubscription(Empty) returns (stream ControlList);
}

message SpeedRequest { double kph = 1; }
message SpeedMetric {
  string workoutID = 1;
  int32 timeSeconds = 2;
  double lastKph = 3;
  double maxKph = 4;
  double avgKph = 5;
  double minKph = 6;
}
```

#### InclineService (`workout/InclineService.proto`)
```protobuf
service InclineService {
  rpc CanRead(Empty) returns (AvailabilityResponse);
  rpc CanWrite(Empty) returns (AvailabilityResponse);
  rpc GetIncline(Empty) returns (InclineMetric);
  rpc SetIncline(InclineRequest) returns (WorkoutResult);    // ← SET INCLINE!
  rpc InclineSubscription(Empty) returns (stream InclineMetric);
  rpc GetInclineHistory(WorkoutID) returns (InclineMetricList);
  rpc FollowWorkout(Empty) returns (WorkoutResult);
  rpc StopFollowing(Empty) returns (Empty);
  rpc GetIsFollowing(Empty) returns (BooleanResponse);
  rpc IsFollowingSubscription(Empty) returns (stream BooleanResponse);
  rpc GetControls(Empty) returns (ControlList);
  rpc ControlsSubscription(Empty) returns (stream ControlList);
}

message InclineRequest { double percent = 1; }
message InclineMetric {
  string workoutID = 1;
  int32 timeSeconds = 2;
  double lastInclinePercent = 3;
  double maxInclinePercent = 4;
  double avgInclinePercent = 5;
  double minInclinePercent = 6;
}
```

#### WorkoutService (`workout/WorkoutService.proto`)
```protobuf
service WorkoutService {
  rpc StartNewWorkout(Empty) returns (StartWorkoutResponse);  // ← START
  rpc StartLoggedWorkout(WorkoutID) returns (StartWorkoutResponse);
  rpc Pause(Empty) returns (WorkoutResult);                   // ← PAUSE
  rpc Resume(Empty) returns (WorkoutResult);                  // ← RESUME
  rpc Stop(Empty) returns (WorkoutResult);                    // ← STOP
  rpc GetWorkoutState(Empty) returns (WorkoutStateMessage);
  rpc WorkoutStateChanged(Empty) returns (stream WorkoutStateMessage);
  rpc GetCurrentWorkout(Empty) returns (WorkoutID);
  rpc CurrentWorkoutChanged(Empty) returns (stream WorkoutID);
  rpc GetWorkoutSource(Empty) returns (WorkoutSourceMessage);
}

enum WorkoutState {
  WORKOUT_STATE_UNKNOWN = 0;
  WORKOUT_STATE_IDLE = 1;
  WORKOUT_STATE_DMK = 2;
  WORKOUT_STATE_RUNNING = 3;
  WORKOUT_STATE_PAUSED = 4;
  WORKOUT_STATE_RESULTS = 5;
}
```

#### ProgrammedWorkoutSessionService
```protobuf
service ProgrammedWorkoutSessionService {
  rpc AddAndStart(AddAllWorkoutSegmentsRequest) returns (ProgrammedWorkoutServiceResponse);
  rpc Start(Empty) returns (ProgrammedWorkoutServiceResponse);
  rpc Stop(Empty) returns (ProgrammedWorkoutServiceResponse);
  rpc Pause(Empty) returns (ProgrammedWorkoutServiceResponse);
  rpc Resume(Empty) returns (ProgrammedWorkoutServiceResponse);
  rpc Next(Empty) returns (ProgrammedWorkoutServiceResponse);
  rpc AssertPositionControl(Empty) returns (ProgrammedWorkoutServiceResponse);
  rpc ReleasePositionControl(Empty) returns (Empty);
  rpc SetAtPosition(SetAtPositionRequest) returns (ProgrammedWorkoutServiceResponse);
  // ... plus preload, recovery, subscription methods
}
```

### Console Services

#### ConsoleService
```protobuf
service ConsoleService {
  rpc Connect(Empty) returns (ConnectionResult);
  rpc Disconnect(Empty) returns (Empty);
  rpc GetConsole(Empty) returns (ConsoleInfo);
  rpc ConsoleChanged(Empty) returns (stream ConsoleInfo);
  rpc GetConsoleState(Empty) returns (ConsoleStateMessage);
  rpc ConsoleStateChanged(Empty) returns (stream ConsoleStateMessage);
  rpc GetKnownConsoleInfo(Empty) returns (ConsoleInfo);
  rpc RefreshKnownConsoleInfo(Empty) returns (ConsoleInfo);
}

enum ConsoleState {
  DISCONNECTED = 0; CONSOLE_STATE_UNKNOWN = 1;
  IDLE = 2; WORKOUT = 3; PAUSED = 4;
  WORKOUT_RESULTS = 5; SAFETY_KEY_REMOVED = 6;
  WARM_UP = 7; COOL_DOWN = 8; RESUME = 9;
  LOCKED = 10; DEMO = 11; SLEEP = 12; ERROR = 13;
}
```

#### ConsoleInfo (Machine Capabilities)
```protobuf
message ConsoleInfo {
  int32 modelNumber = 1;
  int32 partNumber = 2;           // 416429
  ConsoleType machineType = 7;     // INCLINE_TRAINER
  double maxKph = 13;
  double minKph = 14;
  double maxInclinePercent = 15;   // 40%
  double minInclinePercent = 16;   // -6%
  bool canSetSpeed = 22;
  bool canSetIncline = 23;
  string motorControllerVersion = 52;
  string motorControllerType = 53;
  // ... 54 fields total
}
```

### Settings Services
| Service | Key Methods |
|---------|-------------|
| FanStateService | GetFanState, SetFanState (OFF/LOW/MEDIUM/HIGH/AUTO) |
| MaxSpeedService | SetMaxSpeed, MaxSpeedSubscription |
| VolumeService | CanRead, GetVolume, VolumeChanged |
| BrightnessService | Get/Set brightness |
| SystemUnitsService | Get/Set metric/imperial |
| TimeZoneService | Get/Set timezone |
| DemoModeService | GetDemoMode, DemoModeChanged |
| IdleModeLockoutService | Get/Set idle lockout |

### Workout Data Services
| Service | Purpose |
|---------|---------|
| HeartRateService | HR monitoring + zones |
| CaloriesBurnedService | Total calories |
| CaloriesPerHourService | Current burn rate |
| DistanceService | Total distance |
| ElapsedTimeService | Workout duration |
| ElevationService | Elevation gain |
| WattsService | Power output |
| CadenceService | Step cadence |
| StepCountService | Step counting |
| SmartAdjustService | Auto-adjust controls |
| ActivePulseService | Active pulse HR zone control |
| LapTimeService | Lap timing |

### Map/Location Services
| Service | Purpose |
|---------|---------|
| MapWorkoutService | LocationChanged, StreetViewPointChanged, MapType |

### All 63 Registered gRPC Services
```
ActivityLogService        AppNavigationService      AppStoreService
AuthService              BluetoothService          BrightnessService
CadenceService           CaloriesBurnedService     CaloriesPerHourService
ConstantWattsService     ConsoleService            ConsoleSpoofingService
DemoModeService          DistanceService           DriveMotorErrorCodeService
DriveMotorErrorTimeoutService  EgymService          ElapsedTimeService
ElevationService         ExternalAudioService      FanStateService
FeatureGateService       FirmwareUpdateService     FiveHundredSplitService
GearService              HdmiSoundService          HeartRateService
HeartRateSettingsService HomeService               IdleModeLockoutService
InclineCalibrationService InclineService           KeyPressService
LapTimeService           LightingService           MapWorkoutService
MaxSpeedService          MaxTimeService            MyeTvService
PauseTimeRemainingService ProgrammedWorkoutSessionService ProximitySensingService
ResistanceService        RingService               RpmService
SleepStateService        SmartAdjustService        SpeedService
StepCountService         StrokesPerMinuteService   StrokesService
SystemUnitsService       TDFGearService            ThrottleCalibrationService
TimeZoneService          UserActivityService       UserService
VideoQualityService      VirtualDMKService         VolumeService
VtapService              WattsService              WorkoutService
IFitClubSettingsService  AntPlusService
```

---

## 3. FitPro USB HID Protocol

### Observed BitFields
| BitField | Type | Notes |
|----------|------|-------|
| KPH | read | Current speed in km/h |
| ACTUAL_KPH | read | Actual belt speed |
| GRADE | read | Current incline % |
| ACTUAL_INCLINE | read | Actual incline position |
| AVERAGE_GRADE | read | Average incline |
| PULSE | read | Heart rate |
| DISTANCE | read | Distance traveled |
| CALORIES | read | Calories burned |
| FAN_STATE | read/write | Fan speed |
| WARMUP_TIME | config | Warmup timeout |
| COOLDOWN_TIME | config | Cooldown timeout |
| IDLE_MODE_LOCKOUT | write | Lock/unlock controls |
| REQUIRED_START_REQUESTED | write | Enable start button |
| WEIGHT | write | User weight (kg) |
| SYSTEM_UNITS | write | Metric/imperial |

### Observed Write Commands (from log)
```
ReadWriteDataCmd sent [REQUIRED_START_REQUESTED: ENABLED] with success: true
ReadWriteDataCmd sent [IDLE_MODE_LOCKOUT: UNLOCKED] with success: true
ReadWriteDataCmd sent [WEIGHT: 83.91] with success: true
ReadWriteDataCmd sent [SYSTEM_UNITS: false] with success: true
ReadWriteDataCmd sent [IDLE_MODE_LOCKOUT: LOCKED] with success: true
```

### SDS (Sensor Data Service) Events
```
SDS Changed INCLINE from 0.0 % to -0.5 %
```

---

## 4. TLS/mTLS Configuration

### Server Certificate
- **Subject:** CN=localhost, O=Internet Widgits Pty Ltd, ST=Some-State, C=AU
- **Issuer:** CN=testca, O=Internet Widgits Pty Ltd, ST=Some-State, C=AU
- **Valid:** 2023-10-25 to 2033-10-22
- **Key:** RSA 2048-bit
- **Signature:** SHA-256

### Client Certificate Requirements
- **Type:** Mutual TLS (mTLS) REQUIRED
- **Accepted CA:** CN=testca (same CA as server cert)
- **Key types:** RSA sign, ECDSA sign
- **Signature algorithms:** RSA+SHA512, ECDSA+SHA512, RSA+SHA384, etc.

### Certificate Storage
- Generated at **runtime** by glassos_service
- Stored in `/data/data/com.ifit.glassos_service/` (INACCESSIBLE without root)
- Client apps receive certs via GLASSOS SDK (shared library mechanism)
- NOT stored in APK resources — only PEM markers as string constants in dex

### TLS Investigation Results

**Key finding:** The server REQUESTS client certs but sends `HANDSHAKE_FAILURE` when modern TLS libraries (Go, Python) don't present one. The openssl command-line `s_client` sends an empty Certificate message and connects, but gRPC libraries don't.

| Tool | Result | Why |
|------|--------|-----|
| openssl s_client | CONNECTS | Sends empty Certificate message when server requests one |
| Python ssl module | HANDSHAKE_FAILURE | Doesn't send Certificate message at all |
| grpcurl (Go TLS) | HANDSHAKE_FAILURE | Same as Python |
| grpcurl + dummy cert | UNKNOWN_CERTIFICATE | Cert received but not signed by testca |
| grpcurl + fake testca-signed cert | UNKNOWN_CERTIFICATE | Wrong CA key |

### Current Blocker
**Cannot authenticate without root access to extract the testca CA key and generate valid client certificates. The testca CA cert+key are generated at runtime by glassos_service and stored in `/data/data/com.ifit.glassos_service/` which requires root.**

---

## 5. Paths to Direct Control

### Path A: Root the Device (Highest Impact)
1. Root via Magisk or Android 7.x exploit
2. Extract `/data/data/com.ifit.glassos_service/` cert files
3. Use extracted client cert/key to make gRPC calls directly
4. Full control: SetSpeed, SetIncline, StartWorkout, etc.

### Path B: Custom Android APK Bridge (Most Practical)
1. Build minimal Android APK that links the GLASSOS SDK
2. APK runs on treadmill alongside iFIT apps
3. Exposes simple HTTP REST or WebSocket API
4. PWA connects to bridge APK's HTTP server
5. Bridge translates HTTP → gRPC → motor controller
6. **Requires:** Android SDK, GLASSOS SDK AAR (extract from device)

### Path C: Swipe-Based Bridge (Works NOW)
1. Same approach as QZ Companion
2. Read Valinor logs for speed/incline data
3. Send `input swipe` commands for control
4. Already proven by 50+ treadmill models in QZ project
5. Less precise but zero authentication needed
6. **Bridge script already outlined** — can be built as Android Service

### Path D: Intercept mTLS Handshake
1. Install tcpdump on treadmill (push static binary)
2. Capture loopback traffic during arda → glassos_service handshake
3. Extract client certificate from TLS ClientCertificate message
4. Use extracted cert for our own gRPC connections

### Path E: ConsoleSpoofingService (Experimental)
- The APK includes `ConsoleSpoofingService` — may allow spoofing a different console
- Could potentially bypass authentication for testing
- Needs further investigation

---

## 6. Valinor Log Format

### Location
`/sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt`

### Format
```
HH:MM:SS.mmm LEVEL TAG Message
```

### Key Tags
| Tag | Purpose |
|-----|---------|
| FITPRO | USB HID commands and status |
| GLASSOS | gRPC routing (send/receive) |
| GLASSOS_SDK | SDK client calls |
| SDS | Sensor data changes (speed, incline) |
| SF | Connection state machine |
| COREINFO | Device/system info |
| AUTH | iFIT authentication |
| GLSPWRKCR | Workout creator |
| GLSPWRKSRV | Workout service |

### Parsing for Speed/Incline (QZ Companion approach)
```bash
# Speed changes
grep "Changed KPH" log.latest.txt
# Output: SDS Changed KPH from 0.0 to 5.0

# Incline changes
grep "Changed INCLINE" log.latest.txt
# Output: SDS Changed INCLINE from 0.0 % to 5.0 %
```

---

## 7. Treadmill Capabilities (from XML config)

- **Equipment Type:** INCLINE_TRAINER_DEVICE
- **Market:** HOME_UNIT
- **MCU:** PSOC
- **Config:** MULTI_MASTER (multiple motor controllers)
- **USB Feature:** Enabled (no USB host board)
- **DMK Feature:** Enabled (Dead Man's Key / safety key)
- **Key Press:** Enabled with membrane keyboard
- **Notes:** "Copied from ETNT39019, added DC Lift"

---

## 8. Files Generated

| File | Location |
|------|----------|
| Proto definitions | `/mnt/d/trailrunner/probe/apk_extract/workout/*.proto` (+ console, settings, etc.) |
| Compiled gRPC stubs | `/mnt/d/trailrunner/probe/grpc_client/` |
| Server cert | `/mnt/d/trailrunner/probe/glassos_cert.pem` |
| Archived Valinor log | `/mnt/d/trailrunner/probe/log.03-12-2026-0` |
| glassos APK | `/mnt/d/trailrunner/probe/glassos.apk` |
| Machine config XML | `/mnt/d/trailrunner/probe/apk_extract/assets/inclinetrainer/ETNT39221.xml` |

---

## 9. Live Probing Results (2026-03-13)

### Workout Navigation Flow (Automated via ADB)
Successfully navigated through iFIT UI to start a workout:
```
Sleep → Wake dialog → Login screen → "Go to manual workout" [1709,1008]
→ iFIT Pro upsell → "Continue to manual workout" [1712,1008]
→ Disclaimer → "Accept" [1131,677]
→ Workout screen (rivendell InWorkoutActivity)
```
- Belt started at 1.0 mph (1.6 kph), confirmed in Valinor log
- Workout ran for 11+ minutes during testing

### Compose UI Blocks ALL Input Injection
The workout screen (`rivendell/InWorkoutActivity`) uses Jetpack Compose.
**Every input injection method was tested and ALL FAILED:**

| Method | Result |
|--------|--------|
| `input tap` (touchscreen) | No response |
| `input swipe` (touchscreen) | No response |
| `input mouse tap` (mouse source) | No response |
| `sendevent` (raw kernel events) | No response |
| KEYCODE_DPAD_UP | No response |

The Compose UI hierarchy shows only containers (`ComposeView` → `View` → `View`).
The speed/incline circle controls do NOT appear in the accessibility tree.
Resource IDs visible: `manual_workout_background`, `lap_time`, `progress_circle`, etc.
Speed/incline controls are **purely physical button-driven** — no on-screen touch targets.

### Valinor Log — Rich Telemetry (CONFIRMED WORKING)
`SDS Console Basic Info` dumps every ~60 seconds with ALL telemetry:
```
Time: 283.0 s, Distance: 126.0 m, Pulse: 0.0 bpm, State: WORKOUT,
Calories: 12.2 kcal, LapTime: 284.0 s, PausedTime: 0.0 s,
Volume: 50.0 %, KeyPress: KeyPress(code=NO_KEY, timePressed=0, timeHeld=0),
FanState: OFF, Units: STANDARD, IsClubUnit: false,
IdleModeLockout: UNKNOWN, TotalTime: 15616.0 hr,
Incline: 0.0 %, Speed: 1.6 kph, MotorDistance: 31065.0 m
```

### QZ Companion v3.6.29 — Installed but NOT Working
- **Installed:** via ADB push + `pm install`
- **Permissions granted:** READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE, READ_LOGS, SYSTEM_ALERT_WINDOW, PACKAGE_USAGE_STATS
- **Services running:** QZService, MyAccessibilityService, ShellService, UDPListenerService
- **Problem:** Parse loop runs once, compiles `parse()` via JIT, then goes silent
- **No UDP sockets:** Not listening on 8003 (command input) or broadcasting on 8002 (telemetry output)
- **ShellRuntime:** `/bin/sh` fails, falls back to `/system/bin/sh` (works)
- **Root cause unknown:** May be device model detection issue or the parse() returning empty and not rescheduling

### QZ Companion Architecture (from source analysis)
- **UDPListenerService** listens on port **8003** (NOT 8002 as documented elsewhere)
- **Command format:** `"speed;inclination"` (semicolon-delimited decimals)
- **MyAccessibilityService.performSwipe():** Static method using `Path` + `dispatchGesture()` on API 24+
- **QZService.parse():** Runs every 100ms via Handler, executes shell commands:
  - `tail -n500 [logfile] | grep -a "Changed KPH" | tail -n1`
  - Falls back to `cat [logfile] | grep -a "Changed KPH"`
- **Log path:** `/sdcard/android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt` (correct, case-insensitive FUSE)

### Screen Resolution Mapping
- **Physical display:** 1920x1080
- **Content area:** 1920x1024 (56px system bar, hidden in kiosk mode)
- **Touchscreen device:** `/dev/input/event0` (`pixcirTouchScreen`), ABS range 0-4096
- **Input dispatcher touchableRegion:** [0,0][1920,1080] (full resolution)
- **Previous bridge code had WRONG resolution:** Commented as 2560x1440

### Window Layer Stack (During Workout)
```
Layer 241000: com.ifit.eru (1x1 pixel overlay — kiosk enforcement)
Layer 211000: NavigationBar (hidden)
Layer 161000: StatusBar (hidden)
Layer  31085: rivendell sub-windows (Compose popups, all visible=false)
Layer  21025: rivendell/InWorkoutActivity (FOCUSED, visible, touchable)
Layer  21020: com.ifit.launcher (background)
Layer  21015: com.silverhouse3.trailrunner (background — our PWA!)
Layer  21010: QZ Companion (background)
```

### Key Intent Actions Discovered
| App | Intent Action | Purpose |
|-----|---------------|---------|
| rivendell | `val.inworkout.open` | Open in-workout screen |
| rivendell | `val.preparing.workout.open` | Workout prep |
| rivendell | `val.workout.completed.open` | Workout complete |
| rivendell | `com.ifit.overlay.DIALOG_BUTTON_CLICKED` | Dialog button receiver |
| glassos | `val.alert.dialog.open` | Alert dialog |
| glassos | `GLASSOS_PLATFORM` | Bound service (IPC) |
| arda | `val.walkup.open` | Walk-up screen |
| arda | `val.settings.open` | Settings |
| arda | `arda.sleep.open` | Sleep mode |

---

## 10. Revised Control Architecture

### What WORKS for Reading (Telemetry)
1. **Valinor log parsing** via `adb shell tail/grep` — PROVEN, reliable
2. `SDS Console Basic Info` provides speed, incline, HR, distance, time, calories, state
3. `SDS Changed KPH/INCLINE` events provide real-time change notifications

### What DOESN'T Work for Writing (Control)
1. ~~`input tap/swipe`~~ — Compose UI ignores injected input events
2. ~~`sendevent` raw kernel touch~~ — Also ignored
3. ~~QZ Companion~~ — Services running but parse loop is dormant
4. ~~gRPC API~~ — mTLS blocks without client cert
5. ~~USB HID direct~~ — No hidraw driver, need root

### Recommended Path: Custom AccessibilityService APK
Build a minimal APK (`TrailRunnerBridge.apk`) that:
1. **AccessibilityService** with `dispatchGesture()` — this is the ONLY proven method for injecting touch events into Compose UI
2. **HTTP server** on localhost port (e.g., 4511) — accepts JSON commands
3. **Endpoints:** `POST /speed {kph: 5.0}`, `POST /incline {percent: 3.0}`, `POST /pause`, `POST /stop`
4. Service translates commands to screen coordinates → gesture dispatches
5. TrailRunner bridge/PWA sends HTTP to this service

**Why this works:** `AccessibilityService.dispatchGesture()` injects events through the accessibility framework which bypasses Compose's input filtering. This is exactly how QZ Companion's `MyAccessibilityService` works — the approach is proven on NordicTrack treadmills.

### Alternative: tcpdump + mTLS Intercept
1. Push static ARM64 tcpdump binary to `/data/local/tmp/`
2. Capture loopback traffic: `tcpdump -i lo -w /sdcard/capture.pcap port 54321`
3. Extract client cert from TLS ClientCertificate message in PCAP
4. Use extracted cert to make direct gRPC calls
5. **Requires:** Static tcpdump binary for arm64 Android 7

---

## 11. Files Generated (This Session)

| File | Location |
|------|----------|
| QZ Companion APK | `/mnt/d/trailrunner/probe/QZCompanion.apk` |
| Treadmill screenshots | `/mnt/d/trailrunner/probe/screen_*.png` |
| Workout screen | `/mnt/d/trailrunner/probe/screen_workout.png` |
| UI hierarchy dumps | Captured via uiautomator during session |
