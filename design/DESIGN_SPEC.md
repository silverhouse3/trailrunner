# TrailRunner PWA — UI Design Specification v1.0

## Target Device
- NordicTrack X32i, 32" touchscreen, 1920x1080
- Android 7.1.2 Chrome browser (PWA)
- Users are RUNNING — sweaty fingers, bouncing vision, heavy breathing

## Design Sources
- iFIT manual workout mode (9 reference screenshots in `ifit-reference/`)
- Qwen3-VL 235B analysis (cloud vision model)
- MiniCPM-V analysis (local vision model)

---

## 1. ERGONOMIC RULES

| # | Rule | Spec | Why |
|---|------|------|-----|
| 1 | Min tap target | 72x72px | Sweaty fingers + motion blur |
| 2 | Edge zone controls | 0-192px from edges | Thumb reach while gripping handrails |
| 3 | Primary metric font | >= 48px | Readability while bouncing |
| 4 | Contrast ratio | >= 4.5:1 | Low light + sweat glare |
| 5 | No hover states | Tap/click only | No cursor while running |
| 6 | Limit scrolling | Max 300px scroll | Settings only, never during workout |
| 7 | Update latency | < 100ms | Delayed feedback breaks rhythm |
| 8 | Icon minimum | >= 32px with 8px pad | Visibility at arm's length |
| 9 | Show current + target | "3.0% -> 5.0%" | Reduces cognitive load |
| 10 | Auto-hide non-critical | Fade after 3s | Reduce visual clutter |

---

## 2. LAYOUT ARCHITECTURE (1920x1080)

```
┌────────────────────────────────────────────────────────────┐
│  TOP STATS BAR [H: 80px, Y: 0-80]                        │
│  8 tappable metric cells, each with dropdown toggle        │
├────┬───────────────────────────────────────────────────┬────┤
│INC │  MAIN WORKOUT VIEW [H: 800px, Y: 80-880]         │SPD │
│QS  │  • Track / Map / Route view (center)              │QS  │
│LEFT│  • Lap time + progress ring                       │RGHT│
│72px│  • Workout controls (pause/stop)                  │72px│
│    │  • Connection status pills                         │    │
├────┴───────────────────────────────────────────────────┴────┤
│  BOTTOM CHART STRIP [H: 120px, Y: 880-1000]               │
│  Speed/incline timeline, toggle buttons at edges            │
├────────────────────────────────────────────────────────────┤
│  BOTTOM CONTROLS [H: 80px, Y: 1000-1080]                  │
│  Pause/Lap/Reset (left) | Live readout (center) | Gear (R) │
└────────────────────────────────────────────────────────────┘
```

### Quick-Select Panels (toggled via bottom chart buttons)
- **Incline (LEFT)**: Pills at X: 16px, centered vertically
  - Values: 30, 25, 20, 15, 10, 5, 0, -6
  - Each pill: 72x52px, 6px gap, rounded-full
- **Speed (RIGHT)**: Pills at X: 1832px, centered vertically
  - Values: 12, 10, 8, 7, 6, 5, 4, 3, 2, 1
  - Each pill: 72x52px, 6px gap, rounded-full

---

## 3. COLOR SYSTEM

```css
:root {
  /* Backgrounds */
  --bg-primary:    #0a1628;
  --bg-secondary:  #0f1d33;
  --bg-card:       #111e36;
  --bg-hover:      #162544;
  --bg-panel:      rgba(15, 29, 51, 0.95);

  /* Text */
  --text-primary:  #e8f0ff;
  --text-secondary: #8094ab;
  --text-dim:      #5a7899;

  /* Borders */
  --border:        #1e3050;
  --border-active: rgba(0, 212, 255, 0.3);

  /* Semantic - Metrics */
  --color-speed:    #00d4ff;   /* cyan */
  --color-incline:  #f59e0b;   /* amber/orange */
  --color-hr:       #ef4444;   /* red */
  --color-calories: #fbbf24;   /* yellow */
  --color-distance: #3b82f6;   /* blue */
  --color-time:     #00d4aa;   /* green */
  --color-elev:     #22c55e;   /* emerald */
  --color-pace:     #a855f7;   /* purple */

  /* Actions */
  --color-start:   #00d4aa;
  --color-pause:   #00d4ff;
  --color-stop:    #ef4444;
  --color-danger:  #ef4444;
  --color-success: #22c55e;

  /* Integrations */
  --color-strava:  #fc4c02;
  --color-garmin:  #007dc3;

  /* Effects */
  --glass-bg:     rgba(15, 29, 51, 0.85);
  --glass-blur:   blur(8px);
  --shadow-card:  0 4px 16px rgba(0, 0, 0, 0.3);
  --shadow-popup: 0 8px 32px rgba(0, 0, 0, 0.5);
}
```

---

## 4. TYPOGRAPHY

```css
/* Primary metric values (speed, incline, HR, time) */
.metric-value {
  font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
  font-size: 28px;        /* in stats bar */
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}

/* Large display values (lap time, center display) */
.display-value {
  font-size: 64px;
  font-weight: 700;
  letter-spacing: -1px;
}

/* Labels */
.metric-label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

/* Quick-select button numbers */
.qs-number {
  font-size: 18px;
  font-weight: 700;
}

/* Workout controls */
.control-text {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.05em;
}
```

---

## 5. COMPONENT SPECS

### Stats Bar Cell
- Height: 64-80px, flex: equal width
- Border-right: 1px solid rgba(30,48,80,0.5)
- Icon: 28x28px, semantic color
- Value: 28px bold, white
- Label: 11px, --text-secondary
- Dropdown arrow: 10px, --text-dim
- On tap: shows popup below with alternatives

### Quick-Select Pill Button
- Size: 72x52px
- Border-radius: 26px (full pill)
- Border: 2px solid rgba(0,212,255,0.3)
- Background: rgba(10,22,40,0.85) + backdrop-filter: blur(8px)
- Active: bg rgba(0,212,255,0.2), border var(--cyan), text var(--cyan)
- Font: 18px bold

### Action Button (Pause/Stop/Start)
- Padding: 14px 36px
- Border-radius: 28px
- Border: 2px solid (semantic color @ 0.4 opacity)
- Background: semantic color @ 0.15 opacity
- Font: 16px bold, letter-spacing 0.05em
- Backdrop-filter: blur(8px)

### Settings Panel
- Width: 420px, slides from right
- Tabs: 2x2 grid (Metrics, Charts, Widgets, Controls)
- Sections: Accordion with icon + chevron
  - Audio, Fan, Bluetooth, Features, Display, Theme, Units, Integrations
- Bottom: Expand + Close buttons, sticky

### Connection Status Pills
- Border-radius: 16px
- Padding: 6px 12px
- Glass background + backdrop blur
- Green dot (8px) = connected, grey = disconnected

---

## 6. SCREENS

### A. Pre-Workout (Setup/Home)
- Boot chooser preserved (TrailRunner vs iFIT)
- Free Run or Route mode selection
- Connection status (bridge, gRPC, HR)
- Quick settings access

### B. Active Workout
- Stats bar (top)
- Track/map/route view (center)
- Quick-select panels (edges, toggled)
- Bottom chart (speed + incline timeline)
- Workout controls (pause, stop)
- Emergency stop (fixed position, 80x80px red)

### C. Post-Workout Summary
- "Nice Job!" headline
- Stats row: time, distance, pace, cals, elevation
- Dual-layer chart (incline filled + speed line)
- Legend with avg/max values
- Actions: Save, Strava Upload, Export GPX/TCX, Discard

### D. Settings
- Slide-in panel from right
- Tabbed sections (Metrics, Charts, Widgets, Controls)
- Accordion sections (Audio, Fan, BT, Features, Display, Theme, Units, Integrations)

---

## 7. iFIT IMPROVEMENTS

| What iFIT does wrong | TrailRunner fix |
|---------------------|-----------------|
| Pills too small (~50px) | 72x72px minimum |
| Blue text on blue bg | White on deep navy (#0a1628) |
| No target indication | Show current -> target |
| Cluttered settings | Flat 4 tabs, no deep nesting |
| No auto-hide | Non-critical UI fades after 3s |
| Buttons crammed | 16px padding between sections |
| No haptic feedback | Vibration + color pulse on targets |
| Charts too small | Full-width 150px bottom strip |
| Controls scattered | Speed RIGHT edge, incline LEFT edge |

---

## 8. FUTURE WIDGETS
- HR Zone gauge (5-zone color bar with current position)
- Ghost racing overlay (vs previous run)
- Route map with position dot
- Split times table (slide-in panel)
- Elevation profile with current position
- Fan speed control (direct from workout screen)
- Music/audio controls
- Countdown timer for intervals

---

## Files
- `mockup-v1-workout.html` — Interactive HTML mockup of workout screen
- `ifit-reference/` — 9 iFIT screenshots for reference
