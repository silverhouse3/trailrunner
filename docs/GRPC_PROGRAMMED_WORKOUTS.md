# gRPC Programmed Workout API

## Discovery

glassos_service exposes a `ProgrammedWorkoutSessionService` that lets external
clients push pre-programmed workouts directly to the motor controller. This
means the treadmill itself handles segment transitions — no need for the PWA
or bridge to send individual speed/incline commands at each boundary.

## Proto Location

`bridge/protos/workout/ProgrammedWorkoutSessionService.proto`

## Key Methods

| Method | Description |
|--------|-------------|
| `AddAndStart(segments)` | Push segments and immediately start the workout |
| `AddAllWorkoutSegments(segments)` | Push segments without starting |
| `Start()` | Start a pre-loaded workout |
| `Stop()` | Stop the programmed session |
| `Next()` | Skip to next segment |
| `Pause() / Resume()` | Pause/resume |
| `GetCurrentProgramPosition()` | Current position in the program |
| `ProgramPositionChanged()` | Stream position updates |

## Workout Segment Structure

```protobuf
message WorkoutSegmentDescriptor {
  ActivityLogMetadata workoutMetadata = 1;
  ItemType itemType = 2;  // WARM_UP=0, MAIN=1, COOL_DOWN=2
  double manualWorkoutLengthSeconds = 3;
}

message Workout {
  string title = 1;
  ControlList controls = 6;       // Speed/incline control points
  WorkoutTargetType targetType = 7; // TIME, DISTANCE, CALORIES
  double targetValue = 8;          // Target value for the type
  WorkoutType workoutType = 9;     // RUN=5
}

message Control {
  ControlType type = 1;  // INCLINE=1, MPS=2 (meters per second!)
  double at = 2;         // Position (seconds or meters)
  double value = 3;      // Value at this position
}
```

## Speed Note

Speed is in **meters per second** (MPS), NOT kph.
- Conversion: `mps = kph / 3.6`
- Example: 10 kph = 2.778 mps

## Implementation Plan

1. Compile ProgrammedWorkoutSessionService proto into Go
2. Add `programClient` to bridge
3. New REST endpoint: `POST /workout/program`
   ```json
   {
     "title": "HIIT 30/90",
     "targetType": "TIME",
     "targetValue": 1200,
     "controls": [
       {"type": "MPS", "at": 0, "value": 1.33},
       {"type": "INCLINE", "at": 0, "value": 0},
       {"type": "MPS", "at": 180, "value": 2.5},
       {"type": "INCLINE", "at": 180, "value": 2},
       ...
     ]
   }
   ```
4. WorkoutBuilder generates control points from segments
5. Push via `AddAndStart()` — treadmill executes natively

## Benefits Over Current Approach

- **Native execution**: Motor controller handles transitions (smoother)
- **Crash resilient**: Workout continues even if PWA/bridge disconnects
- **Progress tracking**: `ProgramPositionChanged` stream gives segment progress
- **Session recovery**: `GetLatestUnfinishedWorkoutSession` survives crashes

## Also Discovered

- **ConsoleService**: `GetConsole()` returns hardware capabilities (maxKph,
  maxInclinePercent, firmwareVersion, serialNumber)
- **ActivePulseService**: iFIT's own HR zone auto-pilot — could potentially
  be used directly instead of implementing our own
- **ConsoleState**: Includes SAFETY_KEY_REMOVED state — bridge could detect
  safety key pull and auto-emergency-stop
