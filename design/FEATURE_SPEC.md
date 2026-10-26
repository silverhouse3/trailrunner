# TrailRunner PWA — Complete Feature Specification v1.0
## For NordicTrack X32i, 1920x1080, 32" Touchscreen

---

## Feature 1: Speed Unit System
**Status**: Mockup complete

### Config
```js
speedConfig = {
  unit: 'mph' | 'kph' | 'min/mi' | 'min/km',
  mode: 'auto' | 'custom',
  maxSpeed: number,      // in current unit
  autoSteps: 2-12,       // how many buttons in auto mode
  customSpeeds: [],      // user-picked values in current unit
  safetyMaxKph: 19.3,    // 12 mph hard cap
}
```

### Units
| Unit | Label | toKph | Example |
|------|-------|-------|---------|
| mph | MPH | × 1.60934 | 6.0 → 9.66 kph |
| kph | KPH | identity | 10.0 → 10.0 kph |
| min/mi | MIN/MI | (1.60934 / min) × 60 | 8:00 → 12.07 kph |
| min/km | MIN/KM | 60 / min | 5:00 → 12.0 kph |

### Behaviour
- Tap panel header to cycle unit — all button values convert via kph intermediate
- Custom presets stored in chosen unit, converted on unit change
- Auto mode: divide max speed into N equal steps, round to unit's step size
- Pace units (min/mi, min/km): lower number = faster, sorted accordingly
- All values clamped to safetyMaxKph before sending to bridge

---

## Feature 2: Programmed Workouts (Segment Mode)

### Data Model
```js
workout = {
  id: 'uuid',
  name: 'Soph Tuesday',
  segments: [
    { distance: 2, speed: 5, incline: 0 },   // 2 mi @ 5 mph, flat
    { distance: 1, speed: 7, incline: 3 },   // 1 mi @ 7 mph, 3%
    { distance: 2, speed: 5, incline: 0 },   // 2 mi @ 5 mph, flat
  ],
  distanceUnit: 'mi' | 'km',
  speedUnit: 'mph' | 'kph' | 'min/mi' | 'min/km',
  warmUp: { duration: 180, speed: 3, incline: 0 },   // 3 min walk
  coolDown: { duration: 120, speed: 3, incline: 0 },  // 2 min walk
  created: timestamp,
  lastUsed: timestamp,
}
```

### Segment Execution
1. Warm-up runs first (if enabled)
2. Bridge sends SetSpeed + SetIncline at each segment boundary
3. 10-second countdown + voice announcement before transition
4. On-screen flash: "SPEED → 7.0 MPH" with segment colour
5. Cool-down runs after final segment (if enabled)
6. Workout auto-stops after cool-down

### Speed Conversion
- Segments store speed in workout's speedUnit
- Convert to kph via unitDefs before sending to bridge
- Incline stored as % always (no conversion needed)

---

## Feature 3: Colour-Coded Track

### Segment → Colour Mapping
Colour based on speed intensity relative to workout's speed range:

```
Intensity = (segmentSpeed - minSpeed) / (maxSpeed - minSpeed)

0.0 - 0.2  →  #22c55e (green)    — easy / recovery
0.2 - 0.4  →  #00d4aa (teal)     — moderate
0.4 - 0.6  →  #f59e0b (amber)    — steady
0.6 - 0.8  →  #f97316 (orange)   — tempo
0.8 - 1.0  →  #ef4444 (red)      — hard / sprint
```

### Track Rendering
- Oval track drawn as two semicircles + two straights
- Total track perimeter = sum of all segment distances
- Each segment occupies a proportional arc length
- Segments drawn as thick coloured strokes (20px wide)
- Thin white tick marks at segment boundaries
- Current segment has a subtle glow/pulse

### Incline Colour Overlay (for hill programs)
- If incline varies: inner ring shows elevation bands
- Darker shade = steeper incline
- Speed colour on outer ring, incline shade on inner ring

---

## Feature 4: Pac-Man Runner

### Appearance
- 28px diameter yellow circle with animated mouth
- Mouth opens toward direction of travel (clockwise on track)
- Chomp animation: 3 frames, speed proportional to current pace
  - 4 mph → chomp every 600ms
  - 6 mph → chomp every 400ms
  - 8 mph → chomp every 300ms
  - 10 mph → chomp every 200ms

### Movement
- Position calculated from total distance covered as fraction of total workout distance
- Maps to point on oval track perimeter
- Smooth interpolation (requestAnimationFrame, not stepped)
- Trail behind Pac-Man rendered as consumed track:
  - Coloured track becomes dark grey (rgba(30,48,80,0.3)) behind Pac-Man
  - OR: track behind shows HR zone colour of what was recorded at that point

### At Segment Boundaries
- Brief "waka waka" animation burst (3 rapid chomps)
- Small particle effect (speed dots flying from mouth)

### Completion
- Full loop complete → Pac-Man does a spin + celebration sparkle
- Transition to summary screen after 2 seconds

---

## Feature 5: Distance Toggle

### Two Display Modes (tap to toggle)

**Segment View:**
```
┌─────────────────────────┐
│  SEG 2/5 • 7.0 MPH      │
│  0.3 mi remaining        │
│  ████████░░░░  68%       │
└─────────────────────────┘
```

**Total View:**
```
┌─────────────────────────┐
│  TOTAL DISTANCE          │
│  3.4 / 5.0 mi           │
│  ████████████░░  68%     │
└─────────────────────────┘
```

### Position
- Centre of track view, below the lap timer
- Semi-transparent background, auto-fades after 5s of no interaction
- Tap to toggle, swipe up to keep persistent

### Progress Bar
- Thin bar below the distance text
- Segment view: fills for current segment only, resets at boundary
- Total view: fills for entire workout
- Colour matches current segment colour

---

## Feature 6: HR Zone Auto-Pilot

### Prerequisites
- Bluetooth HR monitor connected (chest strap or watch)
- HR data streaming via bridge WebSocket

### Configuration
```js
hrZoneConfig = {
  enabled: false,
  maxHR: 190,                    // user's max HR (220 - age, or custom)
  priority: 'speed' | 'incline', // which axis auto-adjusts
  targetZone: 2,                 // Z1-Z5
  zones: [
    { zone: 1, name: 'Warm-up',   min: 0.50, max: 0.60, colour: '#6b7280' },
    { zone: 2, name: 'Fat Burn',   min: 0.60, max: 0.70, colour: '#22c55e' },
    { zone: 3, name: 'Aerobic',    min: 0.70, max: 0.80, colour: '#fbbf24' },
    { zone: 4, name: 'Threshold',  min: 0.80, max: 0.90, colour: '#f97316' },
    { zone: 5, name: 'Max',        min: 0.90, max: 1.00, colour: '#ef4444' },
  ],
  adjustInterval: 15,    // seconds between adjustments
  dampingWindow: 10,     // ignore HR spikes shorter than this (seconds)
  speedStep: 0.5,        // kph per adjustment (speed priority)
  inclineStep: 1.0,      // % per adjustment (incline priority)
  manualOverrideTimeout: 60,  // seconds to pause after manual button press
}
```

### Algorithm
```
Every adjustInterval seconds:
  1. Get average HR over last dampingWindow seconds
  2. Calculate zone: avgHR / maxHR → which zone?
  3. If in target zone → do nothing
  4. If above target zone ceiling:
     - priority=speed  → reduce speed by speedStep
     - priority=incline → reduce incline by inclineStep
  5. If below target zone floor:
     - priority=speed  → increase speed by speedStep
     - priority=incline → increase incline by inclineStep
  6. Clamp to safety limits (3 kph min, safetyMaxKph max, -3% to 30% incline)
  7. Send adjustment to bridge
```

### Manual Override
- If user taps any speed/incline button → pause auto-pilot for manualOverrideTimeout
- Show countdown badge: "Auto-pilot resumes in 45s"
- Tap badge to cancel override (resume immediately)
- Tap badge + hold 2s to disable auto-pilot for rest of workout

### Visual Indicators
- Stats bar HR cell: background pulses with current zone colour
- Small "AP" badge on HR cell when auto-pilot active
- Track trail colour = HR zone colour (overrides segment colour when HR connected)
- Adjustment toast: "↓ Speed 6.5 → 6.0 kph (HR 158, above Z2)"

---

## Feature 7: HR Zone Visualisation

### Zone Gauge (widget, optional)
```
Position: bottom-right of track view, 180x120px
┌──────────────────┐
│ Z1│Z2│Z3│Z4│Z5   │  ← coloured bar segments
│    ▲              │  ← triangle marker at current HR
│  132 bpm  Z2      │
│  Fat Burn         │
└──────────────────┘
```

### Stats Bar Integration
- HR cell background tint = current zone colour (subtle, 10% opacity)
- HR value colour = zone colour (full opacity)
- Label shows zone name: "Z2 Fat Burn" instead of just "avg bpm"

### Track Trail
- When HR monitor connected: trail behind Pac-Man uses HR zone colours
- Creates a visual record of effort across the workout
- Post-workout summary track shows the full HR zone colour map

---

## Feature 8: Incline Programs (Hill Mode)

### Data Model
Same structure as speed segments, but incline varies:
```js
hillWorkout = {
  name: 'Rolling Hills',
  segments: [
    { distance: 0.5, speed: 5, incline: 0 },   // flat warm-up
    { distance: 0.25, speed: 5, incline: 8 },   // climb
    { distance: 0.25, speed: 6, incline: 0 },   // fast flat
    { distance: 0.25, speed: 4, incline: 15 },  // steep climb
    { distance: 0.25, speed: 6, incline: -3 },  // downhill sprint
    { distance: 0.5, speed: 4, incline: 0 },    // flat cool-down
  ],
}
```

### Track Visualisation
- **Outer ring**: speed colour (as per Feature 3)
- **Inner ring**: incline elevation profile
  - Rendered as a filled area chart wrapped around the track
  - Higher incline = thicker fill toward centre
  - Decline = fill extends outward
  - Colour: gradient from blue (flat/decline) → orange (steep)

### Elevation Profile (bottom chart strip)
- Alternative to speed timeline: shows incline profile as mountain silhouette
- Toggle between speed chart / incline chart / both overlaid
- Current position marker synced with Pac-Man

---

## Feature 9: Countdown / Interval Timer Mode

### Time-Based Intervals
```js
intervalWorkout = {
  name: 'HIIT 30/90',
  type: 'time',            // vs 'distance' or 'hr'
  rounds: 8,
  intervals: [
    { label: 'Sprint', duration: 30, speed: 9, incline: 2 },
    { label: 'Recover', duration: 90, speed: 4, incline: 0 },
  ],
}
```

### HR-Based Intervals
```js
hrIntervalWorkout = {
  name: 'Z4 Intervals',
  type: 'hr',
  rounds: 6,
  intervals: [
    { label: 'Push', targetZone: 4, speed: 8, incline: 3 },
    // ↑ runs until HR enters Z4, then holds for holdTime
    { label: 'Recover', targetZone: 2, speed: 4, incline: 0 },
    // ↑ runs until HR drops back to Z2
  ],
  holdTime: 30,    // seconds to hold in target zone before transitioning
  maxDuration: 180, // safety: max seconds per interval if HR target not reached
}
```

### Countdown Display
```
Centre of track view, large font:
┌────────────────┐
│    SPRINT       │
│     0:18        │  ← countdown (time mode) or HR target
│   Round 3/8     │
│  ██████░░░░░░   │
└────────────────┘
```

### Track Representation
- Time-based: segments are equal arc length (each interval = equal visual slice)
- Distance isn't known in advance for time-based, so track fills proportionally per round
- HR-based: segments expand/shrink based on actual time taken

---

## Feature 10: Saved Workout Library

### Storage
- localStorage on treadmill (persists across sessions)
- Optional: export/import as JSON (via settings)

### Data Structure
```js
workoutLibrary = {
  workouts: [
    {
      id: 'uuid',
      name: 'Soph Tuesday',
      type: 'programmed' | 'interval-time' | 'interval-hr' | 'freerun',
      segments: [...],
      speedUnit: 'mph',
      distanceUnit: 'mi',
      warmUp: { duration: 180, speed: 3, incline: 0 },
      coolDown: { duration: 120, speed: 3, incline: 0 },
      hrZone: { enabled: false, targetZone: 2, priority: 'speed' },
      created: timestamp,
      lastUsed: timestamp,
      timesCompleted: 0,
      bestTime: null,
      tags: ['easy', 'tuesday'],
    },
    // ...
  ],
  recentIds: ['uuid1', 'uuid2', 'uuid3'],  // quick access
}
```

### Pre-Workout Screen
```
┌──────────────────────────────────────────────────┐
│  Choose Your Workout                              │
│                                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ FREE RUN │ │ PROGRAM  │ │ INTERVAL │          │
│  │    ▶     │ │   📋     │ │    ⏱     │          │
│  └──────────┘ └──────────┘ └──────────┘          │
│                                                   │
│  RECENT                                           │
│  ┌────────────────────────────────────────┐       │
│  │ ★ Soph Tuesday    5.0 mi  │  3 days ago │     │
│  │   Soph Easy 5K    3.1 mi  │  5 days ago │     │
│  │   HIIT 30/90      ~20 min │  1 week ago │     │
│  └────────────────────────────────────────┘       │
│                                                   │
│  ALL WORKOUTS (12)                    [+ NEW]     │
└──────────────────────────────────────────────────┘
```

### Workout Builder
- Step-by-step: Name → Type → Segments → Options → Save
- Drag to reorder segments
- Duplicate/delete segments
- Preview track visualisation before starting
- Import from library templates (Couch to 5K, etc.)

---

## Feature 11: Cool-Down & Warm-Up Auto-Bookends

### Configuration (global default + per-workout override)
```js
bookendConfig = {
  warmUp: {
    enabled: true,
    duration: 180,       // 3 minutes
    speed: 4.8,          // kph (3 mph)
    incline: 0,
    rampUp: true,        // gradually increase from 0 to workout speed over last 30s
  },
  coolDown: {
    enabled: true,
    duration: 120,       // 2 minutes
    speed: 4.8,          // kph (3 mph)
    incline: 0,
    rampDown: true,      // gradually decrease from workout speed over first 30s
  },
}
```

### Behaviour
- Warm-up always runs BEFORE segment 1 (if enabled)
- Cool-down always runs AFTER final segment (if enabled)
- Both shown on track as grey segments at start/end
- Skippable: "SKIP WARM-UP ▶" button appears during warm-up
- Mandatory mode: toggle in settings to prevent skipping
- Speed ramp: linear interpolation over 30 seconds
  - Warm-up end: ramps FROM warm-up speed TO first segment speed
  - Cool-down start: ramps FROM last segment speed TO cool-down speed

### Track Representation
- Warm-up = light grey arc at the start
- Cool-down = light grey arc at the end
- Not included in "total workout distance" stat (shown separately)
- Pac-Man still eats through them but they're visually distinct

---

## Feature 12: Ghost Runner

### How It Works
- After completing and saving a workout, the run is stored with timestamped distance data
- Next time the same workout is loaded, option to "Race Your Ghost"
- A semi-transparent ghost dot runs the track at the previous pace

### Ghost Data
```js
ghostRun = {
  workoutId: 'uuid',
  date: timestamp,
  distanceLog: [
    { elapsed: 0, distance: 0 },
    { elapsed: 10, distance: 0.015 },  // every 10 seconds
    { elapsed: 20, distance: 0.031 },
    // ...
  ],
  totalTime: 1845,
  totalDistance: 5.0,
}
```

### Visual
- Ghost: 20px semi-transparent white circle with subtle trail
- Runs ahead of or behind Pac-Man depending on relative pace
- Delta display near Pac-Man: "+0:12" (green, ahead) or "-0:05" (red, behind)
- If Pac-Man overtakes ghost: brief celebration particle effect

### Settings
- Toggle ghost on/off per workout
- Choose which previous run to ghost (best time, last time, specific date)
- Ghost opacity: 30% default, adjustable

---

## Feature 13: Voice Coaching (TTS)

### Implementation
- Android TTS API via bridge HTTP endpoint: `POST /tts { text: "..." }`
- Bridge calls `android.speech.tts.TextToSpeech` via accessibility service
- Fallback: Web Speech API in Chrome (if available on Android 7.1.2)

### Announcements
| Event | Message | Priority |
|-------|---------|----------|
| Segment change | "Next segment: 7 miles per hour, 3 percent incline" | High |
| 10s warning | "Ten seconds to next segment" | Medium |
| Halfway | "Halfway done. 2.5 miles remaining" | Low |
| HR zone change | "Entering zone 3. Adjusting speed." | Medium |
| Ghost delta | "You're 12 seconds ahead of your best" | Low |
| Warm-up end | "Warm-up complete. Starting workout." | High |
| Cool-down start | "Great job. Cooling down." | High |
| Workout complete | "Workout complete. Nice job!" | High |

### Verbosity Levels
- **Minimal**: Segment changes + complete only
- **Normal**: All high + medium priority
- **Chatty**: Everything including encouragement ("Keep it up!", "Strong pace!")

### Settings
- Enable/disable voice coaching
- Verbosity: minimal / normal / chatty
- Volume: independent of media volume
- Preview button to test voice

---

## Feature 14: Streak & Badges

### Streak Tracking
```js
streakData = {
  currentStreak: 5,      // consecutive days with a completed workout
  longestStreak: 12,
  totalWorkouts: 47,
  totalDistance: 156.3,   // miles
  totalTime: 2847,       // minutes
  thisWeek: 3,
  thisMonth: 14,
  lastWorkoutDate: '2026-03-14',
}
```

### Badges (unlock conditions)
| Badge | Icon | Condition |
|-------|------|-----------|
| First Steps | 👟 | Complete first workout |
| 5K Club | 🏃 | Complete 5K in one session |
| Week Warrior | 📅 | 5 workouts in one week |
| Streak 7 | 🔥 | 7-day streak |
| Streak 30 | 💎 | 30-day streak |
| Century | 💯 | 100 total workouts |
| Marathon | 🏅 | 26.2 mi lifetime total |
| Hill Climber | ⛰️ | 1000 ft elevation in one workout |
| Zone Master | ❤️ | Stay in target HR zone for 20+ minutes |
| Ghost Buster | 👻 | Beat your ghost by 30+ seconds |
| Speed Demon | ⚡ | Hit 10+ mph |
| Consistency | 🌟 | 4+ workouts every week for a month |

### Display
- Summary screen: show newly earned badges with animation
- Settings: badge collection gallery
- Pre-workout: "2 more workouts for Week Warrior!"
- Stored in localStorage

---

## Feature 15: Voice Commands

### Hardware
- **Microphone**: Confirmed present (`android.hardware.microphone`)
- **Speaker**: RT5651 codec (for feedback/TTS responses)
- **Camera**: Front-facing Nexell (potential future use for gesture control)

### Wake Word
- **"Hey Trailrunner"** — wake word to activate listening
- Alternative short form: **"Hey TR"**
- Visual indicator: microphone icon pulses cyan when listening
- Audio feedback: short chime when wake word detected

### Implementation Options
1. **Web Speech API** (`webkitSpeechRecognition`) — runs in Chrome, no server needed
   - Android 7.1.2 Chrome may have limited support
   - Continuous listening mode with wake word detection
2. **Bridge endpoint** — `POST /voice/listen` → Android SpeechRecognizer API
   - More reliable on older Android
   - Bridge returns transcribed text, PWA matches to commands
3. **Hybrid** — Web Speech for wake word detection, bridge for command recognition

### Command Set
| Voice Command | Action |
|---------------|--------|
| "Speed up" | Increase speed by 1 step (0.5 kph) |
| "Slow down" / "Speed down" | Decrease speed by 1 step |
| "Speed [number]" | Set speed to N in current unit (e.g. "Speed 6") |
| "Incline up" | Increase incline by 1% |
| "Incline down" | Decrease incline by 1% |
| "Incline [number]" | Set incline to N% |
| "Pause" / "Pause workout" | Pause current workout |
| "Resume" / "Continue" | Resume paused workout |
| "Stop" / "Stop workout" | Stop workout (requires confirmation: "Say stop again to confirm") |
| "Skip" / "Next segment" | Skip to next programmed segment |
| "How far" / "Distance" | TTS reads current distance |
| "How fast" / "What speed" | TTS reads current speed in chosen unit |
| "Heart rate" | TTS reads current HR and zone |
| "Time" / "How long" | TTS reads elapsed time |
| "Ghost" / "Am I winning" | TTS reads ghost delta |
| "Louder" / "Quieter" | Adjust TTS/media volume |
| "Mute" / "Unmute" | Toggle audio |

### Safety
- "Stop" requires double-confirmation (say it twice within 5 seconds)
- Speed changes clamped to safety max
- Voice commands disabled during cool-down ramp (sudden speed change dangerous)
- Can't set speed above 2 steps from current (prevents "Speed 12" when walking at 3)
- Microphone auto-mutes during TTS playback (prevent feedback loop)

### Feedback
- Every command gets brief spoken confirmation: "Speed, 6 miles per hour"
- Failed recognition: "Sorry, I didn't catch that"
- After 5 seconds of no valid command: auto-stop listening, mic icon goes grey

### Settings
- Enable/disable voice commands
- Wake word sensitivity (low/medium/high)
- Confirmation sounds on/off
- Command list reference (help screen)

---

## Feature 16: View Modes (TRACK / MAP / ROUTE / STREET)

### Tab Bar
- 4 tabs at top of main workout area, below stats bar
- Active tab: cyan underline + bright text
- Inactive: dim text, tap to switch
- View persists across workouts (saved in config)

### TRACK View (default)
- Oval track with Pac-Man, segments, ghost runner
- Distance/segment info in centre
- HR zone gauge (optional widget)
- This is the primary view — most features designed around it

### MAP View
- **Virtual route**: bird's-eye scrolling map
- Pre-loaded route images (no internet needed during workout):
  - Park loops, coastal paths, mountain trails
  - Stored as tiled images in PWA cache
- Pac-Man replaced with a runner icon dot on the map
- Map scrolls to keep runner centred
- Segment colours shown as route highlights
- Future: Google Maps integration for real-world routes (needs internet)

### ROUTE View (Elevation Profile)
- Full-width elevation chart showing the workout's incline profile
- Mountain silhouette style — filled area chart
- Current position: vertical line with marker
- Colour-coded by speed segment
- Y-axis: incline % (-6 to 40)
- X-axis: distance (miles/km)
- For flat workouts: shows speed as a step chart instead
- Pac-Man appears as a small dot riding the elevation line

### STREET View
- **Camera feed from treadmill's front camera**
- The X32i has a front-facing camera — could show a live view
- Overlay: semi-transparent stats bar on top, speed/incline on sides
- Useful for: gym environment awareness, or just novelty
- Alternative: pre-recorded scenic route videos
  - Store MP4 clips on SD card (`/sdcard/trailrunner/routes/`)
  - Playback speed synced to treadmill speed
  - Video pauses when workout paused
- Future: community route videos (download via WiFi)

### Implementation
- Each view is a `<div>` container, only active one visible (display: flex/none)
- Track view uses Canvas for animation
- Map view uses CSS transforms for scrolling
- Route view uses Canvas or SVG for the elevation chart
- Street view uses `<video>` element or camera API

---

## Feature 17: Settings Panel (Full Content)

### Panel Structure
- Slides in from right, 420px wide
- Close button (top-right) + tap outside to close
- Tabbed sections across top, accordion items below

### Tabs

#### Controls Tab
**Speed Buttons**
- Unit of measure: [MPH] [KPH] [MIN/MI] [MIN/KM] — radio buttons
- Mode: [AUTO] [CUSTOM] toggle
- Auto mode:
  - Max speed: slider + number input (1-12 mph / equivalent)
  - Number of buttons: slider (2-12)
- Custom mode:
  - List of current speeds with [×] delete button
  - [+ Add Speed] button → number input
  - Drag to reorder
- Preview: miniature button strip showing result

**Incline Buttons**
- Mode: [DEFAULT] [CUSTOM] toggle
- Default: 30, 25, 20, 15, 10, 5, 0, -6
- Custom: same add/delete/reorder as speed
- Number of buttons: slider (4-12)

**Voice Commands**
- Enable/disable toggle
- Wake word sensitivity: [Low] [Med] [High]
- Confirmation sounds: on/off
- [View Command List] button → popup with all commands

#### Metrics Tab
**Stats Bar Configuration**
- Drag-to-reorder the 8 stat cells
- Each cell: dropdown to choose metric
- Available metrics:
  - Time (elapsed, remaining, segment remaining)
  - Distance (total, segment, remaining)
  - Speed (current, average, target)
  - Incline (current, target)
  - Pace (current, average)
  - Heart Rate (current, average, zone)
  - Calories (estimated)
  - Elevation Gain
  - Cadence (if available)
  - Lap Time / Lap Count
  - Ghost Delta

**Display Units**
- Distance: miles / km
- Speed: mph / kph / min/mi / min/km
- Elevation: feet / metres
- Temperature: °F / °C

#### Charts Tab
**Bottom Chart Strip**
- Show/hide toggle
- Height: [Small 80px] [Medium 120px] [Large 160px]
- Data layers (multi-select):
  - Speed timeline
  - Incline profile
  - Heart rate
  - Pace
  - Cadence
- Colour customisation for each layer
- Time range: [Full Workout] [Last 5 min] [Last 10 min]

#### Widgets Tab
**Available Widgets** (toggle on/off, drag to position)
- HR Zone Gauge
- Ghost Delta
- Segment Progress
- Lap Counter
- Interval Timer
- Mini Elevation Profile
- Cadence Display
- Achievement Progress

---

### Accordion Sections (below tabs)

#### Audio
- **Voice Coaching**: on/off
  - Verbosity: [Minimal] [Normal] [Chatty]
  - Voice preview button
- **Media Source**: [Podcasts] [Radio] [Spotify Connect] [None]
  - Note: media playback via Android intent or Bluetooth audio
  - Volume slider (independent of TTS volume)
- **TTS Volume**: slider
- **Sound Effects**: on/off (button clicks, segment chimes, achievements)

#### Heart Rate
- **Monitor**: [Not Connected] / [Device Name]
  - [Scan for Devices] button → Web Bluetooth pairing
- **Max HR**: number input (default: 220 - age)
- **Age**: number input (for max HR calculation)
- **Zone Thresholds**: 5 sliders or number inputs (% of max HR)
  - Z1: 50-60%, Z2: 60-70%, Z3: 70-80%, Z4: 80-90%, Z5: 90-100%
  - Preset buttons: [Standard] [Karvonen] [Custom]
- **Auto-Pilot**: on/off
  - Priority: [Speed] [Incline]
  - Adjust interval: slider (10-30 seconds)
  - Damping: slider (5-15 seconds)
  - Speed step: 0.3 / 0.5 / 1.0 kph
  - Incline step: 0.5 / 1.0 / 2.0 %

#### Bluetooth
- **HR Monitor**: status + scan button
- **Garmin Watch**: Connect IQ status
- **External Speaker**: pair/unpair
- **Cadence Sensor**: if available (foot pod)

#### Features
- **Ghost Runner**: on/off
  - Ghost source: [Best Time] [Last Run] [Specific Date]
  - Ghost opacity: slider (10-80%)
- **Warm-Up**: on/off
  - Duration: slider (1-5 min)
  - Speed: number input
  - Ramp-up: on/off
- **Cool-Down**: on/off
  - Duration: slider (1-5 min)
  - Speed: number input
  - Mandatory (can't skip): on/off
- **Auto Speed Change**: on/off (for programmed workouts)
  - Countdown warning: [5s] [10s] [15s] [None]
- **Streaks & Badges**: on/off
  - [View Badges] → badge collection gallery

#### Display
- **View Mode Default**: [Track] [Map] [Route] [Street]
- **Track Style**: [Oval] [Straight] (future: circular, figure-8)
- **Pac-Man**: on/off (replace with simple dot if preferred)
- **Animation Speed**: [Smooth] [Performance] (reduce animations for older hardware)
- **Distance Label**: [Segment] [Total] [Auto-Toggle]
- **Auto-Hide UI**: on/off (non-critical elements fade after 3s)
- **Screen Brightness**: slider (via Android API if possible)
- **Keep Screen On**: on/off (prevent screen timeout)

#### Theme
- **Preset Themes**:
  - Dark Navy (default)
  - Pure Black (OLED-friendly, saves battery if applicable)
  - Forest Green
  - Sunset Orange
  - Custom
- **Custom Colours**:
  - Background: colour picker
  - Accent: colour picker
  - Text: colour picker
- **Font Size**: [Normal] [Large] [Extra Large]
  - Scales all metric values proportionally

#### Units
- **Speed**: mph / kph / min/mi / min/km
- **Distance**: miles / km
- **Elevation**: feet / metres
- **Weight**: lbs / kg (for calorie calculation)
- **Temperature**: °F / °C

#### Integrations
- **Strava**:
  - Status: [Connected as Sophie W.] / [Not Connected]
  - [Connect] / [Disconnect] button
  - Auto-upload: on/off
  - Activity type: [Run] [Walk] [Treadmill]
  - Privacy: [Everyone] [Followers] [Only Me]
- **Garmin Connect**:
  - Status: connected/disconnected
  - [Connect] button
  - Auto-sync: on/off
- **Apple Health**: (future, if applicable)
- **Export Defaults**:
  - Format: [TCX] [GPX] [FIT]
  - Auto-save to: [Downloads] [SD Card]

#### Profile
- **Name**: text input (shown on summary screen)
- **Age**: number (for HR zone calculation)
- **Weight**: number + unit (for calorie estimation)
- **Resting HR**: number (for Karvonen HR zones)
- **Default Workout**: dropdown of saved workouts

---

## Implementation Notes

### Storage Strategy
- All config/workouts/streaks in **localStorage** (persists on treadmill)
- Keys: `trailrunner_config`, `trailrunner_workouts`, `trailrunner_streaks`, `trailrunner_badges`, `trailrunner_ghosts`
- Export/import as JSON file for backup
- Total storage estimate: <1MB even with extensive ghost data

### Bridge API Extensions Needed
```
POST /speed            { kph: 5.0 }               → existing
POST /incline          { percent: 5.0 }            → existing
POST /workout/start    {}                          → existing
POST /workout/stop     {}                          → existing
POST /workout/pause    {}                          → existing
POST /workout/resume   {}                          → existing
GET  /health                                       → existing
GET  /state                                        → existing
WS   /ws               → real-time telemetry       → existing

POST /tts              { text: "message" }         → NEW: Android TTS
POST /voice/listen     {}                          → NEW: Start speech recognition
POST /voice/stop       {}                          → NEW: Stop speech recognition
GET  /hr               → { bpm, connected }        → NEW: HR if via bridge
POST /volume           { level: 0-15 }             → NEW: System volume
POST /brightness       { level: 0-255 }            → NEW: Screen brightness
POST /camera/start     {}                          → NEW: Start camera feed
POST /camera/stop      {}                          → NEW: Stop camera feed
WS   /camera           → MJPEG/raw frames          → NEW: Camera stream
WS   /voice            → speech recognition events  → NEW: Voice transcripts
```

### HR Data Source Options
1. **Bridge WebSocket** — if glassos_service streams HR from paired BT monitor
2. **Web Bluetooth API** — Chrome connects directly to HR strap (preferred, no bridge changes)
3. **Garmin Connect IQ** — if Garmin watch, use Garmin's BLE broadcast

### File Structure (in PWA)
```
js/
  treadmill.js          ← bridge connection (exists)
  workout-engine.js     ← NEW: segment execution, auto-pilot, timers
  track-renderer.js     ← NEW: oval track, Pac-Man, ghost, colours, views
  workout-library.js    ← NEW: CRUD for saved workouts, builder UI
  hr-monitor.js         ← NEW: Web Bluetooth HR, zone calculations, gauge
  voice-coach.js        ← NEW: TTS announcements + speech recognition
  voice-commands.js     ← NEW: command parser, wake word, safety checks
  streak-tracker.js     ← NEW: streaks, badges, localStorage
  settings.js           ← NEW: full settings panel with all sections
  views/
    track-view.js       ← oval track with Pac-Man
    map-view.js         ← virtual scrolling map
    route-view.js       ← elevation profile chart
    street-view.js      ← camera feed / scenic video
css/
  app.css               ← main styles (exists, needs update)
  track.css             ← NEW: track + views styles
  settings.css          ← NEW: settings panel styles
assets/
  routes/               ← virtual map tile images
  sounds/               ← chimes, achievement sounds
```
