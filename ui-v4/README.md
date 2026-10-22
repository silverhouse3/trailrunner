# TrailRunner ui-v4 — big-touch redesign (preview)

A self-contained copy of the TrailRunner PWA with a redesigned UI for the X32i's
32" 1920x1080 touchscreen, plus a **mock treadmill bridge** so it can be driven on
a PC with no hardware. Nothing outside `ui-v4/` is touched; the live app in the
repo root is unchanged.

## Run it

```bash
cd /mnt/d/trailrunner/ui-v4
./start.sh        # starts both servers in the background (logs + pids in mock/)
./stop.sh         # stops them
```

Windows: double-click `start.cmd` (two console windows; close them to stop).

| What | URL |
|---|---|
| UI (this PC) | http://localhost:8099/ |
| UI (phone / tablet on the LAN) | http://192.168.100.92:8099/ (your PC's LAN IP; `hostname -I`) |
| Mock bridge health | http://localhost:4510/health |
| Mock control page (pull safety key, force HR, start/stop) | http://localhost:4510/mock |

Both servers bind `0.0.0.0`. The static server sends `Cache-Control: no-store`, and
`index.html` unregisters any service worker + clears caches on load, so changes are
never hidden by caching. `sw.js` in this folder is a kill-switch only and is never
registered.

**Bridge auto-targeting** (`js/treadmill.js`, `TR_BRIDGE_HOST`):

* page served from port 8099 → bridge at `<same host>:4510` (the mock)
* page opened by a LAN IP → `<that IP>:4510`
* anything else (GitHub Pages on the treadmill) → `127.0.0.1:4510` (the real bridge)
* override with `?bridge=host:port`

Headless screenshots of every screen (39 shots, rounds 1–3): `node mock/screens.js` (uses the repo's
Playwright, needs both servers running) → `screens/*.png`.

## Mock treadmill (`mock/server.js`)

Node built-ins only. Implements the bridge API with the same JSON shapes as
`bridge/grpc-bridge/main.go`: `GET /health`, `GET /state`, `POST /workout/start|stop|pause|resume`,
`POST /speed {kph|mph}`, `POST /incline {percent}`, `POST /command`, `POST /tts`,
and a hand-rolled RFC 6455 WebSocket at `/ws` that broadcasts the state message every
500 ms. Like the real bridge it **refuses speed > 0 unless the workout is RUNNING**.

Simulation: belt ramps 1 kph/s, incline 1 %/s, distance/elapsed/elevation/calories
accumulate only while RUNNING, HR drifts towards an effort-based target (68 bpm at rest,
~tau 25 s), watts from speed/incline. Mock-only endpoints:
`POST /mock/safety-key {out:true|false}` (belt stops, workout drops to IDLE, state
reports `safetyKeyOut`), `POST /mock/hr {bpm|null}`, `POST /mock/reset`, `GET /mock/state`.

## What changed and why

Design surface is now a native **1920x1080** root (was 1280x720 zoomed), so every
size below is real screen pixels. System fonts only (Google Fonts removed); Leaflet
is bundled in `vendor/` (no CDN scripts). Map tiles still need the internet, as before.

### Home (`#setupOverlay`)
* Replaced the three-paragraph setup card with three tiles: **FREE RUN** (green,
  primary), **ROUTE** (shows the active route name/distance/climb), **WORKOUT**.
* Treadmill / HR / Strava status pills (64 px) across the top, Settings top-right,
  Ghost race + Stats along the bottom.
* The belt can never start from this screen; every tile only *arms* a session.

### Live screen
* **Edge-zone controls**: incline on the left column, speed on the right. Each column
  is a 200x240+ px `+` button, the live value (88 px number, with a `→ target` line while
  the belt is still ramping), and a `−` button. Tapping the number opens the preset
  pills (now 176x72 px). Nudges are still ±0.5 and go through the unchanged
  `TM.setSpeed/setIncline` dedup + bridge rate limiting.
* **Metric strip**: TIME, DISTANCE (+remaining), HEART RATE + zone name + zone bar,
  PACE, CALORIES at 72 px. Tap the strip (or Menu → More stats) for a second row:
  speed, elevation, cadence, power, avg pace, drift/EF, incline-now.
* **State banner** in the top centre reflects the *bridge's* workout state, not the
  app's: `STOPPED` / `RUNNING belt x km/h` / `STOPPING…` / `PAUSED` / `BELT ACTIVE`
  (bridge running while app is idle) / `NO TREADMILL` / `SAFETY KEY OUT`. Mismatches
  between app and bridge render amber. A full-width red flashing
  **SAFETY KEY REMOVED — BELT STOPPED** bar sits above everything when the key is out.
* **Run controls**: one 520x112 px green START when ready; PAUSE / STOP (red, 420 px)
  / COOL DOWN while running. STOP is always a single tap. E-STOP (instant zero) stays
  in the top-right corner.
* View-mode buttons (terrain/sat/dark/track/oval/trail-cam/radio) are 72 px and sit
  top-right of the view so they no longer cover the oval track's gauges.
* Pause overlay: big RESUME + FINISH RUN. Cool-down overlay: 96 px numbers + one red
  SKIP button.

### Summary
* iFit-style "Nice job!" with 56–72 px stats, SAVE RUN as the single primary button,
  SHARE / GPX / TCX / DISCARD as outlined secondaries. Comparison, PB, power, HR
  recovery, drift/EF blocks are kept (same ids). Save or discard returns to Home.

### Routes / Workouts / Settings
* Route picker: 112 px rows with a tick on the active route, delete asks for
  confirmation, and a **RUN THIS ROUTE** primary button (goes to the live screen in
  the ready state).
* Workout library and builder (rendered by `workout-builder.js`) restyled: 150 px
  type buttons, 100 px cards, 68 px inputs, 88 px save/start.
* Settings (rendered by `settings-panel.js`) is now a 900 px right-hand sheet with
  80 px tabs, 72 px rows, 92x52 toggles, 48 px slider thumbs. All sections/keys are
  unchanged.

## Safety behaviour (unchanged or tightened)
* Belt never starts on page load: `_autoConnectBridge(false)` only connects.
* `App.startRun()` is the **only** code path that calls `TM.startWorkout()`; the
  workout builder now *arms* a workout (`App.armWorkout`) instead of starting the
  belt the moment a card is tapped (upstream did `Engine.startRun() + TM.startWorkout()`
  on tap).
* Speed/incline rate limiting, clamps (0–19.3 kph, −6–40 %) and dedup in
  `treadmill.js` are untouched. `Engine.ctrl` targets are zeroed on every return to
  Home so a previous run's speed is never re-sent at the next START.
* `TM.onWorkoutDropped` (bridge went IDLE under a running app) now pauses the app run
  and shows the pause overlay with a message.
* Resuming after an E-STOP clears the e-stop latch explicitly (`TM.clearEstop()`),
  as before via START.

## Hidden / moved (nothing deleted)
| Feature | Where it lives now |
|---|---|
| Control mode (Route / Manual / HR→Incline / HR→Speed) + target zone ± | ☰ Menu → CONTROL MODE (also shown as a chip under the run name) |
| Speed / incline presets | tap the big speed / incline number, or ☰ Menu → PRESETS |
| Secondary metrics (elevation, cadence, power, avg pace, drift/EF) | tap the metric strip (▾) or ☰ Menu → More stats |
| Splits, Ghost race, Routes, Workouts | ☰ Menu → RUN |
| Street view (needs Google key) | ☰ Menu → VIEW (removed from the view buttons) |
| Stats dashboard (`stats.html`) | Home → STATS, ☰ Menu → APP |
| Map zoom | top-right of the view, under the view buttons |
| Focus mode / topbar pills | gone as a concept: the live screen *is* the focused layout; `focusBadges` ids are kept hidden so `App._updateFocusBadges` still works |
| Voice commands mic, HR pairing, Strava sync | mic button in the top bar; ❤ pill (home + top bar) pairs a strap; Strava pill on Home + Settings → Integrations |

## Round 2 — position dot, route-only options, YouTube window

### Current-location dot (every map-like view)
Position = distance covered (from the engine) interpolated along the loaded route;
there is no GPS. Shown as a 28 px+ cyan dot with a white ring and a pulsing halo:
* **Leaflet map**: `L.divIcon` marker (`.tr-pos-dot/.tr-pos-ring`, CSS animated). The
  trail already run is drawn green over the cyan trail ahead. **FOLLOW** button
  (top-right of the map, under zoom) keeps the map centred; dragging the map switches
  follow off, tapping FOLLOW turns it back on (`MapView.setFollow`).
* **Trail view** (3D road): pulsing dot on the mini elevation profile (now 3× bigger),
  plus the "YOU" runner. Upstream bug fixed on the way: TrackView expected
  `{dist: km, elev}` but was fed `{dist: m, ele}`, so the mini-profile and grade never
  worked — `App._elevProfileKm()` converts.
* **Oval track**: Pac-Man is her lap position; it now carries the same pulsing ring.
* **Trail cam**: a route progress bar across the top (green = run, cyan = ahead) with
  the pulsing dot.
* **Elevation strip** (under every view when a route is loaded): bigger dot + ring,
  the part already run is a thick green line.
* Free run (no route): no map dot anywhere; the oval still shows lap position.

### Route-only options removed when no route is loaded
Everything tagged `data-needs-route` is `display:none` while `#rootApp.routeless`
(`App._applyRouteVisibility()`): Terrain / Satellite / Dark map / Trail view / Street
view buttons and menu items, map zoom + FOLLOW, the elevation strip, the ROUTE
control mode and "Route splits". Remaining views without a route: **Oval track**,
**Big numbers** (new: speed / time / distance / HR at 150 px), Trail cam, Radio.
Loading a route brings everything back. If the current view is route-only when the
route disappears, the view switches to the oval.

**Test both states on the mock**: `http://localhost:8099/?demo=noroute` (deletes all
stored routes) and `http://localhost:8099/?demo=route` (imports `mock/sample.gpx` if no
routes exist and makes it active). The Home ROUTE tile / route picker and the trash
button on a route card work too.

### YouTube window (`js/video.js`, `VideoWin`)
* 📺 button in the top bar or ☰ Menu → Video window. Opens a 640×432 floating window
  in the bottom-right of the view zone with a paste-a-link/ID box, ▶ PLAY and four big
  favourite slots (`localStorage` key `tr_video_favs`; tap an empty slot to save the
  link in the box, ✕ removes).
* **Never auto-plays**: no iframe exists until PLAY/favourite is tapped, and the
  embed URL carries no `autoplay`. Playback controls are the embed's own.
* Embed: `https://www.youtube-nocookie.com/embed/<id>?rel=0&playsinline=1&modestbranding=1`
  — no API key, no CDN script.
* Movable (drag the title bar) and resizable (drag the bottom-right corner), touch
  and mouse, clamped inside the view zone, so it can never cover STOP / PAUSE, the
  speed / incline edge columns or the metric strip. ▁ minimises to a 360 px bar, ✕
  closes (removes the iframe, which also stops audio).
* **Fallback**: if `navigator.onLine === false`, the iframe errors, or it has not
  fired `load` within 12 s, the window shows **"Video unavailable here"** with a big
  **OPEN IN YOUTUBE** button whose href is
  `intent://www.youtube.com/watch?v=ID#Intent;scheme=https;package=com.google.android.youtube;end`
  on Android (plain `https://www.youtube.com/watch?v=ID` elsewhere).
* Nothing in `video.js` touches `TM`, `Engine` or the belt.
* **Alternative**: Android 7 supports native split-screen. Long-press the Recents
  button with TrailRunner in front, then pick the YouTube app (or SmartTube) for the
  other half; TrailRunner's layout scales to the narrower pane (CSS zoom), though the
  edge buttons get small — the in-page window is the better first try.
* **Not verified**: whether the YouTube embed actually plays inside the X32i's
  Android 7.1.2 WebView (it may show "Video unavailable" for some videos, or refuse
  to play without a user gesture), whether the `intent://` link resolves to an
  installed YouTube app on the console, and where audio is routed (console speakers
  vs Bluetooth). On this PC's headless Chromium the embed loaded and showed its play
  button (screenshot 25).

## Round 3 — stats page and run-end km splits

### stats.html
Restyled in the app's design language (system fonts, no CDN, dark, `body { zoom: 1.55 }`
on wide screens so the 1920×1080 treadmill reads it like the app, single column on a
phone). Every existing feature is kept — the chart code is unchanged, only the markup
and CSS around it: period header (**THIS WEEK / THIS MONTH / ALL TIME**: km, runs,
time, avg pace, avg HR, climb), **best efforts / PRs**, **run history list** (tap a
run → a full detail page with big stats, the per-km comparison, splits, HR zones,
HRR, power, drift/EF), weekly distance + training load, this-week streak + 12-week
heatmap, fitness/fatigue, HR zone distribution, route breakdown, collapsible trends
(pace / power / EF / drift), race predictions, badges, all-time detail cards and
**EXPORT CSV**. Big **◀ BACK TO TRAILRUNNER** button top-left; the run detail page
has **◀ ALL RUNS** and is linkable (`stats.html#run-0`).

**Demo data**: `stats.html?demo=1` or the **SEED DEMO DATA** button seeds 18 fake
runs over ~9 weeks (per-km splits, HR, zones, power…; half on the active route if one
is loaded, half free runs). Every seeded run has `demo: true`, is named "… (demo)",
gets a DEMO tag in the list and detail page, and a yellow **DEMO DATA** banner with a
CLEAR button sits at the top while any exist. `DemoSeed.clear()` removes only demo
runs. Seeding never happens by itself.

### Run-end km split comparison (`js/past-run-splits.js`, `js/split-compare.js`)
On the summary screen (and the stats run detail page) a table + bar chart per 1 km
split, plus a final partial split labelled with its real distance (e.g. "0.42 km ·
partial", shown but not compared):

| column | meaning |
|---|---|
| THIS RUN | this run's time for that km (mm:ss) and its average HR |
| FASTEST / SLOWEST / MEDIAN | best, worst and middle time for the same km *index* across the past runs; MEDIAN = middle value (mean of the two middle values when even) |
| HR: LOWEST / HIGHEST / MEDIAN | the lowest, highest and median *average HR per km* recorded for that km index in past runs. ("Fastest" makes no sense for HR, so these are the labels used.) |

Highlights are colour-blind safe: **▲ NEW BEST** (faster than every past run), **▼
SLOWEST** (slower than every past run), ▲/▼ for faster/slower than the median; HR
**▼ LOWEST** / **▲ HIGHEST**. One-line verdict, e.g. "Fastest km: 2 (5:05) · ▲ beat
your best on 2 kms". **Basis = the same route only** (owner's rule, no fallback to
similar-distance free runs): the screen says *Compared with N past runs on this
route*. Comparison columns need at least **2** past runs on that route, otherwise
"Not enough past runs on this route yet". A free run (no route loaded) shows only this
run's per-km splits (time, pace, avg HR) with the note **"No route loaded: pick a
route to compare with past runs"** (screens 40 and 41). Runs under 1 km show only the
partial row.

Persistence: each saved run keeps `splits` (unchanged), plus `finalSplit`
`{distKm, timeSec, paceSecPerKm, avgHR, partial:true}` and `splitsVersion: 2`. Old
runs without these fields load fine (treated as having no partial split / no splits).

**Second data source hook** — `PastRunSplits.sources.push(fn)` where
`fn(routeIdOrNull, distanceKm)` returns `[{ id, date, name, source, distanceKm,
splits: [{km, timeSec, avgHR}], finalSplit? }]`. Everything pushed is merged into
`PastRunSplits.get()` automatically; local runs are just the first source. This is
where the Strava agent should supply Strava efforts (not done here). `get()` returns
`{ runs, basis, label }`; `statsForKm(runs, k)` gives the per-km fastest / slowest /
median and HR lowest / highest / median.

SAVE RUN / DISCARD are unchanged: both end the bridge workout, zero the targets and
return to Home; nothing about the belt or safety behaviour changed.

## Round 4 — Strava wired in (see `docs/STRAVA_INTEGRATION.md`)

Soph can pick a recent Strava run or saved route, see it on the map with incline-coloured legs, race
Fastest / Average / Slowest versions of herself, and is **asked** after each run whether to save it to Strava.
Nothing uploads automatically any more.

* **Home / Routes**: new orange STRAVA buttons (Home footer and the route modal footer). Home's button goes
  straight to the live screen in the READY state (belt never starts); the route modal's button just selects the route.
* **Connect**: Settings -> Integrations -> Connect (Client ID + Secret typed in, or an optional token proxy URL).
  Scopes `read,read_all,activity:read_all,activity:write`; `strava-callback.html` checks `state`, stores the granted scope.
  Disconnect deletes the tokens, cached lists/streams, the registry and every route that came from Strava.
* **Live screen**: a compact **race bar** (`#raceBar`, `data-needs-route`) sits in normal layout flow between the
  metric strip and the view zone, e.g. `F +0:42  A -0:10  S -1:30  YOU` with coloured letter badges (Fastest green,
  Average yellow, Slowest red, YOU blue; `+` = ahead). Because it is in flow it shrinks the view zone instead of
  floating over anything: the YouTube window (clamped to the zone by `video.js`, re-clamped when the bar appears),
  STOP/PAUSE, edge controls and the metric strip can never be covered. While a race is on, the engine's centre-top
  ghost chip is hidden (it sat on the view buttons). Dots F/A/S are drawn on the map (under the blue live dot) and on
  the oval track. Racers exist only while a route is loaded; free run / workout / deleting the route removes bar, dots
  and the coloured line, and `#rootApp.routeless` hides the route-only options as before.
* **Run end**: SAVE RUN -> full-screen **SAVE TO STRAVA / SKIP** card (default: treadmill run, no GPS, `trainer=1`;
  setting "Virtual run on route" adds the map). SKIP uploads nothing and is remembered. The old `Sync.autoSync` path
  is a no-op stub; there is no other automatic Strava upload.
* **Km compare**: Strava past runs matching the loaded route feed `PastRunSplits.sources` (same route only, still
  needs >= 2 past runs; a Strava run that is also stored on the treadmill is dropped).
* **Settings -> Integrations**: upload mode, include climb, race-my-past-runs, steepest descent/climb for Strava routes
  (default -3 / +12, intersected with the treadmill's reported limits), retry queued uploads, token proxy URL.
  The old Auto-Upload / Activity type / Privacy rows are gone.
* **Tests**: `node mock/strava-test.js` (86), `node mock/strava-ui-smoke.js` (13), `node mock/strava-e2e.js`
  (end-to-end on the integrated app against the mocks; output in `docs/strava-e2e-output.txt`, shots in `screens/strava-*.png`).
  Needs `./start.sh` for :8099/:4510 (the e2e starts missing servers and the mock Strava itself); open the app by hand
  with `http://localhost:8099/?strava=localhost:8098` after `node mock/strava-mock.js`.

## Upstream bugs fixed in this copy (worth porting back)
* `js/app.js` oval-track branch referenced an undefined `oSettings` → threw on every
  tick with HR data on the oval view. Now uses `this._cachedSettings`.
* `TM._startPolling` emitted `onStatus('connecting')` *after* `connected`, so the
  treadmill pill stayed on "CONNECTING…" forever. Guarded with `!this.connected`.
* `Engine.discardRun()` cleared the graceful ramp-down timer before it could send
  `TM.stopWorkout()`, leaving the bridge workout RUNNING at 0 kph. It now always ends
  the bridge workout and zeroes `Engine.ctrl` targets.
* `Engine.tick()` clamps negative `dt` (clock stepping backwards made elapsed/distance
  negative; seen under WSL, possible on Android after NTP).
* Route loaded while `#mapDiv` was `display:none` left the map at world zoom;
  `MapView.fitRoute()` re-fits when a map view is shown.
* `Engine.onAutoPause` called `UI.showPause()` / `UI.hidePause()` which never existed (threw when the belt sat at 0 for 3 s). Defined in app.js.
* TrackView's mini elevation profile / grade used `{dist: km, elev}` but was fed
  Engine's `{dist: m, ele}` → the profile was always a single point. Converted in app.js.

## Round 4 — real-device fit (X32i in-app WebView) and the ROM's back-arrow / nav bar

Findings from the treadmill: the window reports **1920×1080** but the ROM **paints its 80 px
nav bar (Quick start / Workout settings / expand) over y = 1000..1080** instead of shrinking
the window, and draws a **back-arrow over the top-left ~95×90 px** of every app.

* **Bottom safe strip** — `App.safeBottom()` returns the height of that painted-over strip:
  `?safeBottom=N` (0..200, remembered for the session; `?safeBottom=0` disables), `?rom=1`
  (alias for 80), otherwise **80 when the UA matches `/Android 7\.1\.2/` and `/; wv\)/`**
  (the in-app WebView), else 0. On a PC/phone nothing is reserved. Test on a PC with a
  1920×1080 window and `?safeBottom=80`. The same detection runs in stats.html (adds
  160 px bottom padding so the last content scrolls above the bar).
* **No fixed 1080 anywhere.** `App._scaleViewport()`: usable height = innerHeight − strip;
  scale fits the width (1920) with at least 1000 design px; `#rootApp` is then given exactly
  the usable height (1000 on the treadmill, 1080 on a PC, capped 1000–1080; a phone
  letterboxes). The body keeps the same dark background so the strip under the root is not a
  visible band; no control or text is laid out in it (everything, incl. STOP/controls, race
  bar, video-window clamp zone, menu/settings/summary rows, ends above y = 1000). `.layout` is
  `calc(100% - 96px)`; the fixed bands were trimmed (metric strip 160, run controls 140, edge
  buttons 200 min) so the view zone still keeps ≥ 300 px with the race bar + elevation strip.
* **110×110 top-left safe zone** (`--rom-safe`): the Home brand, the live top bar (MENU
  button), the slide-out menu's "MENU" label, the ghost/history side panel header, the Strava
  screen header and stats.html's BACK buttons are all pushed right of 110 px; nothing is
  placed there. (The incline column's `+` starts at y = 110.)
* **Test**: `node mock/screens-rd.js` tours every screen twice — **A)** 1920×1080 with
  `?safeBottom=80` (what the device really is) → `screens/rd-*.png`, **B)** a genuine
  1920×1000 window → `screens/rd1000-*.png` — home, routes, live ready, workouts, settings,
  running with a synthetic **4-racer race bar**, video window, more-stats + presets, menu,
  ghost history, splits, pause, cool-down, summary with km splits, stats, stats run detail;
  plus a 1920×1080 PC shot (no strip) and a phone shot. For every visible interactive element
  **and every text box** it asserts: bottom ≤ 1000 and right ≤ 1920 (rows inside scrollable
  lists may continue below the fold) and no intersection with the top-left 110×110 zone; plus
  race bar between metric strip and view zone, STOP above y = 1000, root height 1000 / 1080,
  phone fits, no page errors. **77/77 checks pass.** `mock/screens.js` defaults to the 1000 px
  viewport (`VIEWPORT_H=1080` for the PC); Strava `strava-test.js` (86/86) and `strava-e2e.js`
  (58/58) still pass.

## Known gaps / not verified
* Not yet tested on the treadmill's Android 7.1.2 WebView. CSS avoids flex `gap`,
  `backdrop-filter`, `clamp()`, `:is()`; JS avoids optional chaining / top-level
  await. `grid-gap`, CSS variables and `position: sticky` are used (Chrome 57+).
  Emoji glyphs depend on the device font.
* `remote.html` and `strava-callback.html` are copied **unrestyled** (the callback page gained the state/scope/proxy logic in round 4) (stats.html is
  redesigned, see Round 3).
* The per-km comparison on the summary screenshot was produced by fast-forwarding
  the run (3.42 km injected) because real splits need ~5 min of belt time per km;
  the split logic itself (`Engine._checkSplits`) is unchanged upstream code.
* Trail cam, radio/media and Street View panels are restyled but were only
  smoke-opened (no video library / stream / API key in the mock environment).
* HR strap pairing (Web Bluetooth) cannot be exercised headlessly. Strava OAuth was exercised only against the local mock (no real Strava app exists yet).
* The mock does not run native programmed workouts (`/workout/program` returns
  `ok:false`), so programmed workouts always use the PWA-managed `WorkoutSegments`
  path — which is also what happens today because `TM._bridgeUrl` is never set.
* Leaflet map tiles (OpenTopoMap / ArcGIS / Carto) still need internet.
