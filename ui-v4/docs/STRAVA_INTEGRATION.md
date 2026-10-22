# Strava integration for TrailRunner ui-v4

Owner's goal: *Soph picks a recent run or route, sees the map with inclines and a ghost of her running it for
real (now a multi-racer race), and when she finishes the run is recorded back to Strava.*

**Status (2026-10-22, round 4): WIRED into ui-v4 and verified against the local mocks** (section 4a lists exactly what
changed in which file; section 10 now records the defaults that were applied). Real Strava has never been called:
the Strava developer app does not exist yet (section 2). Nothing was committed, pushed or deployed. The only file
touched outside `ui-v4/` is the repo-root `strava-callback.html` (hook H8 says "both copies"; backwards compatible, uncommitted).

| File | Purpose |
|---|---|
| `js/strava-api.js` | `StravaApi`: auth (shared tokens with `sync.js`), request wrapper (401 refresh/retry, 429 cool-down, budget guard), IDB/localStorage cache, list/streams/routes/upload/poll, polyline decode, `?strava=` mock override |
| `js/strava-routes.js` | `StravaRoutes`: streams -> TrailRunner route (smoothing, grade clamp, ghost), bridge-aware limits, registry, ghost API, grade-coloured Leaflet overlay, elevation profile, thumbnails |
| `js/strava-racers.js` | `StravaRacers`: multi-racer ghost pool (treadmill + Strava), route matching, fastest/slowest/average, gaps, map dots, oval-track dots, legend |
| `js/strava-upload.js` | `StravaUpload`: TCX builder, SAVE TO STRAVA / SKIP confirm screen, upload + status polling, offline queue |
| `js/strava-picker.js` | `StravaPicker`: big-touch "recent runs / my routes" screen with preview (extra file, UI only) |
| `css/strava.css` | styles for all of the above (72 px+ targets, no flex gap/clamp/backdrop-filter) |
| `mock/strava-mock.js` | Node-only mock of the Strava endpoints, port 8098 |
| `mock/strava-test.js` | headless Node test (86 checks) |
| `mock/strava-ui-smoke.js`, `mock/strava-demo.html` | Playwright smoke test of the screens (+ screenshots in `docs/strava-ui-*.png`) |
| `docs/strava-test-output.txt` | saved output of both tests |

## 1. How to run the mock and the tests

```bash
cd /mnt/d/trailrunner/ui-v4
node mock/strava-mock.js                  # mock Strava on http://localhost:8098
./start.sh                                # (existing) app on :8099 + mock treadmill :4510
# open http://localhost:8099/?strava=localhost:8098   <- client now talks to the mock (see "override" below)
node mock/strava-test.js                  # 86 checks, starts its own mock, exit code 0 = all pass
node mock/strava-ui-smoke.js              # Playwright (repo's node_modules), starts mock + static server on :8197
```

`?strava=host:port` points oauth **and** api at `http://host:port`. Only loopback / private LAN / `.local` hosts are
accepted, so a crafted link cannot send her tokens to a stranger. The override is remembered per tab (sessionStorage).
Mock control: `POST /mock/fault {kind:'429'|'401'|'upload500'|'upload_error',count}`, `/mock/config {processingMs,tokenTtl}`,
`/mock/expire`, `/mock/reset`, `GET /mock/uploads|stats|info`. The mock has 14 activities (12 runs): a 14.2 km hilly trail
run with 650 m gain and pitches to 42 %, four activities on that same course (different pace profiles, GPS noise,
+-1.2 % distance error, one 90 s stop), two decoys (same start + similar distance but a detour; same course reversed),
a ride and a walk (must be filtered), a trainer run without GPS, three saved routes (one is a ride).

## 2. What the owner must do (Strava side) - nothing here was registered

1. **Create the API application under Soph's own Strava account** (https://www.strava.com/settings/api).
   A new Strava API app starts in single-athlete mode (only the account that created it can authorise it until Strava
   raises the athlete capacity). I could not confirm this from the docs pages I fetched, but it is the long-standing
   behaviour and matches your "single-athlete, my own data" use. If you register it under another account, Soph will
   probably be refused at the consent screen. Check "Athlete Capacity" on that settings page.
2. Fields: Application Name (anything that is not "Strava"), Category *Training*, Website (e.g. the GitHub Pages URL),
   **Authorization Callback Domain = `silverhouse3.github.io`** (domain only, no path - same as the existing sync.js).
   `localhost` and `127.0.0.1` are also accepted as callback domains if you ever want to test the real OAuth on the PC
   (docs: authentication page).
3. Copy the **Client ID** into Settings -> Integrations. Keep the **Client Secret** out of the repo (see section 3).
4. Upload the app icon; download the official **"Connect with Strava"** button (orange SVG) and the
   **"Powered by Strava"** logo from https://developers.strava.com/guidelines/ into `ui-v4/img/`
   (`btn_strava_connect_with_orange.svg` is the file name `strava-picker.js` tries; it falls back to a text button).
5. Scopes requested (`StravaApi.SCOPES`): `read,read_all,activity:read_all,activity:write`.
   - `activity:read_all` = her own activities and streams, including "Only Me" ones.
   - `read_all` = **private saved routes** (docs: `read` only gives public routes). Needed for the MY ROUTES tab.
   - `activity:write` = upload.
   Soph can untick scopes on the consent screen; the app handles that (401 "permission" -> "reconnect and tick all boxes").
6. First connect: Settings -> Connect Strava (after wiring hook H7). Tokens: access token 6 h, refresh token rotates on every
   refresh; `StravaApi` always stores the newest one.

## 3. Token exchange without a secret in the front end - options and recommendation

Strava's token endpoint requires `client_secret` for both the code exchange and every refresh (docs: authentication
page). I found no PKCE support in the docs (could not confirm it does not exist). So a pure browser app cannot do
OAuth without somewhere to keep the secret.

| Option | Secret lives | Pros | Cons |
|---|---|---|---|
| A. Current sync.js approach: user types secret into Settings, stored in treadmill `localStorage` and read by `strava-callback.html` | on the treadmill WebView | zero infrastructure; already works | secret readable by anyone with devtools/adb on the machine; callback page on a public origin handles it; breaks the Strava agreement's "keep confidential" spirit if the device is shared |
| B. Tiny serverless proxy (Cloudflare Worker / Netlify / Vercel function) that adds the secret | in the worker's encrypted env vars | secret off the device and out of the repo; ~25 lines; free tier; also lets you add `/oauth/revoke` (needs secret as Basic auth) | one more thing to deploy; the worker sees the tokens in transit (it is yours) |
| C. Add `/strava/token` to the Go bridge on the treadmill | file on the treadmill | no cloud; works on the home LAN | secret still on the device (but not in WebView storage); needs a bridge release; page on https GitHub Pages -> http bridge already works for `127.0.0.1` |
| D. Paste tokens by hand once | nowhere | simplest, no secret | refresh still needs the secret every 6 h, so not workable |

**Recommendation: B**, with A as the fallback until it exists. `StravaApi` already supports it: set
`StravaApi.setPrefs({tokenProxyUrl:'https://<your-worker>/oauth/token'})`. When set, the client sends
`{client_id, grant_type, code|refresh_token}` and **never** the secret (the mock-run test asserts no `client_secret` is
stored). Worker sketch (secret and client id as Worker secrets `CLIENT_SECRET`, `CLIENT_ID`):

```js
export default { async fetch(req, env) {
  const cors = h => { h.set('Access-Control-Allow-Origin','https://silverhouse3.github.io');
    h.set('Access-Control-Allow-Headers','Content-Type'); h.set('Access-Control-Allow-Methods','POST,OPTIONS'); return h; };
  if (req.method === 'OPTIONS') return new Response(null,{status:204,headers:cors(new Headers())});
  if (req.method !== 'POST' || new URL(req.url).pathname !== '/oauth/token') return new Response('no',{status:404});
  const b = await req.json();
  if (b.client_id !== env.CLIENT_ID || !['authorization_code','refresh_token'].includes(b.grant_type))
    return new Response('bad',{status:400,headers:cors(new Headers())});
  const r = await fetch('https://www.strava.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({client_id:env.CLIENT_ID,client_secret:env.CLIENT_SECRET,grant_type:b.grant_type,code:b.code,refresh_token:b.refresh_token})});
  return new Response(await r.text(),{status:r.status,headers:cors(new Headers({'Content-Type':'application/json'}))});
}};
```

## 4. Integration hook list (applied in round 4; see 4a)

Script/link tags, in `index.html`:
```html
<link rel="stylesheet" href="css/strava.css">                 <!-- after css/app.css -->
<!-- after js/sync.js, before js/app.js: order matters -->
<script src="js/strava-api.js"></script>
<script src="js/strava-routes.js"></script>
<script src="js/strava-racers.js"></script>
<script src="js/strava-upload.js"></script>
<script src="js/strava-picker.js"></script>
```
Note: `Store`, `Engine`, `MapView`, `App`, `OvalTrack` are top-level `const`s (not `window` properties); the new files look
them up lexically, so they work as classic scripts. They only need to be defined before the *functions* are called.

| # | File / function | Add | Why |
|---|---|---|---|
| H1 | `index.html` route modal footer (`.modal-footer` of `#routeModal`) and the Home ROUTE tile | `<button class="btn-outline" onclick="StravaPicker.open()">STRAVA</button>` | entry to the picker (default `onUse` calls `App.selectRoute(id)`; pass `{onUse:fn}` for custom flow, e.g. then `App.runRoute()`) |
| H2 | `app.js` `_loadRouteData(route)`, right after `MapView.loadRoute(Engine.latlngs);` | `if (window.StravaRoutes) StravaRoutes.onRouteLoaded(route);` | builds the racer pool for **any** route (treadmill history works for GPX routes too), attaches the grade-coloured line for Strava routes, re-bakes against bridge limits if narrower (never mid-run) |
| H3 | `app.js` `deleteRoute()` (the branch that clears the route) and every place that calls `Engine.clearRoute(); MapView.clearRoute();` (free run / workout start) | `if (window.StravaRoutes) StravaRoutes.onRouteLoaded(null);` | detaches overlay, dots and legend |
| H4 | `app.js` tick, inside `if (Engine.hasRoute()) {` after `MapView.updateGhost(...)` | `if (window.StravaRoutes) StravaRoutes.onTick(Engine.run);` | moves racer dots (by clock time), greens the part already run, updates legend gaps (1 Hz throttled) |
| H5 | `app.js` `saveAndNewRun()`: **replace** the `Sync.autoSync(saved).then(...)` block | `if (window.StravaUpload) StravaUpload.onRunSaved(saved).then(function(){ App._updateSyncPill(); });` and keep `notifyWebhook/notifyBridge` | the confirm screen. **Required**: otherwise `Sync.autoSync` still uploads without asking (it is the only `autoSync` call site) and Strava would see two files |
| H6 | `app.js` after `OvalTrack.init(...)` | `if (window.StravaRacers) StravaRacers.ovalTrack.install();` | draws F/A/S discs on the oval by wrapping `OvalTrack._drawPacMan` (no edit to oval-track.js) |
| H7 | `app.js` `App.connectStrava()` / Settings Strava button | call `StravaApi.connect()` instead of `Sync.connectStrava()` (or add `read_all` to the scope string in `Sync.connectStrava`) | existing scope `activity:write,activity:read_all` lacks `read_all` (saved routes) |
| H8 | `strava-callback.html` (both copies) | after the token response: store `scope` from the query/response, check `state` against `localStorage.tr_strava_oauth_state`; if `localStorage.tr_strava_prefs` has `tokenProxyUrl`, POST `{client_id, grant_type:'authorization_code', code}` there with no secret | CSRF check + proxy option (option B). Until then A keeps working |
| H9 | `app.js` boot (`init`) | `if (window.StravaUpload) StravaUpload.autoFlushOnOnline();` | retries confirmed uploads when the connection returns |
| H10 | Settings -> Integrations | disable the old "Auto-upload" toggle; optional controls via `StravaApi.setPrefs({uploadMode:'trainer'|'virtual', includeElevation, comfortMinIncline, comfortMaxIncline, ghostDefault, tokenProxyUrl, autoRetryQueued})` | settings are read through `StravaApi.prefs()` |
| H11 | Disconnect action | `StravaApi.disconnect(); StravaApi.purgeData();` | forget tokens + cached lists/streams/pools |

## 4a. What was wired (round 4) - file by file

| Hook | Where (file / function) | Change |
|---|---|---|
| tags | `index.html` | `css/strava.css` after `split-compare.css`; `strava-api, -routes, -racers, -upload, -picker` after `sync.js`, before `app.js` |
| H1 | `index.html` (`#homeStravaBtn` in `.home-foot`, `#routeStravaBtn` in `#routeModal .modal-footer`), `app.js` `App.openStravaPicker(goLive)`, `strava-picker.js` `use()` | STRAVA buttons. Home button passes `thenRun` so the picker ends on the live READY screen via `App.runRoute()` (belt never starts); the modal button only selects the route |
| H2 | `app.js` `_loadRouteData` | `StravaRoutes.onRouteLoaded(route)` (promise rejections swallowed) |
| H3 | `app.js` `freeRun`, `armWorkout`, `deleteRoute` | `StravaRoutes.onRouteLoaded(null)` next to every `Engine.clearRoute()` |
| H4 | `app.js` tick, inside `if (Engine.hasRoute())` | `StravaRoutes.onTick(Engine.run)` |
| H5 | `app.js` `saveAndNewRun` | old `Sync.autoSync(saved)` block replaced by `StravaUpload.onRunSaved(saved)`. `sync.js` `autoSync`/`uploadRun`/`_processQueue` are additionally neutralised (`Sync.legacyAutoUpload = false`), so no other path can upload. Webhook (`notifyWebhook`) posts a run summary to the user's own Home Assistant URL only, never to Strava and never Strava data |
| H6 | `app.js` `init`, after `OvalTrack.init` | `StravaRacers.ovalTrack.install()`; also `PastRunSplits.sources.push(StravaRacers.splitsSource)` (item 3) |
| H7 | `app.js` `connectStrava`, new `disconnectStrava` | `StravaApi.connect()` (scope `read,read_all,activity:read_all,activity:write`, random `state`); credentials still saved to the shared `tr_strava_app` key |
| H8 | `strava-callback.html` (ui-v4 copy **and** repo-root copy) | `state` checked against `tr_strava_oauth_state` (legacy flow without stored state still accepted), granted `scope` stored, `tokenProxyUrl` honoured (no secret sent), mock host honoured for tests, warns if write/read_all scope was unticked, text no longer says "auto-sync" |
| H9 | `app.js` `init` | `StravaUpload.autoFlushOnOnline()` |
| H10 | `settings-panel.js` `_accIntegrations`, `_save` | Auto-Upload / Activity type / Privacy rows removed; controls for upload mode, include climb, race my past runs, steepest descent/climb, retry queued, token proxy URL -> `StravaApi.setPrefs`. Status now reads `StravaApi.isConnected()` (the old code looked at a non-existent `Sync.stravaTokens` and always said "Not Connected") |
| H11 | `app.js` `disconnectStrava` | `StravaApi.disconnect()`, deletes every route in `StravaRoutes.allMeta()` via `App.deleteRoute` (the route of a live run is kept), `StravaApi.purgeData()`, `StravaRacers.clear()` |
| pill | `app.js` `_updateSyncPill` | reads `StravaApi`, hidden when not connected, shows queued count |
| layout | `index.html` `#raceBar`, `css/strava.css` `.race-bar`, `strava-racers.js` `legend` | compact in-flow bar between metric strip and view zone (see below); `#rootApp.racing #ghostPanel {display:none}` |
| splits | `strava-racers.js` `splitsSource` | per-km splits from the pool's Strava profiles for the loaded route only; re-checks duplicates against local runs and `tr_strava_uploaded` |

**Race bar placement.** The first design (floating `.sv-legend` at left 24 / top 150) would sit on the map, where the video
window can be dragged, and on the oval gauges. The integrated app uses `#raceBar` instead: a 64 px row in the normal flow of `.center`, between
`.metric-strip`/`.more-stats` and `.map-zone`. It shrinks the view zone, so nothing can be overlapped; `legend._relayout()` re-clamps
`VideoWin`, calls `MapView.map.invalidateSize()` and fires a `resize` event when the bar appears or disappears. Content: coloured letter chip + gap per
racer (`F +0:42 A -0:10 S -1:30`) and a blue `YOU` chip; `+` = Soph is ahead of that racer. Source/date/total time stay in each chip's `title`.
The detailed floating panel is still used when there is no `#raceBar` (the demo harness / `strava-ui-smoke.js`).
The bar carries `data-needs-route` and is cleared whenever the route is cleared, so it coexists with `#rootApp.routeless`.
The engine's own centre-top ghost chip (`#ghostPanel`) overlapped the view-mode buttons, so it is hidden while a race is on (the bar shows the same gaps).

**Coordination with the other agent (current-location dot, hidden route options, YouTube window)**
- Current-position dot: untouched. Use `StravaRacers.COLOURS.you` (`#37d0ff`, blue) and letter `YOU` for it.
- Leaflet panes: grade line is in pane `stravaGrade` (z 397), racer dots in `stravaRacers` (z 398); both are **under**
  Leaflet's overlayPane (400, where `MapView.runnerMarker` lives) and markerPane (600), so the live dot is always on top.
  `StravaRoutes.overlay.attach` sets `MapView.routeAhead/routeDone` opacity to 0 (so the cyan line does not tint the
  colours) and `detach` restores 0.5/0.9. If the other agent changes those layers' names, update `overlay.attach`.
- `MapView.updateGhost`: when racers exist, `StravaRacers` wraps it at runtime to hide the engine's single yellow marker
  (the race dots replace it). It is wrapped once and passes through when there are no racers.
- HUD/legend: `.sv-legend` (racers) / `.sv-hud` (single ghost chip) are absolutely positioned at `left:24px; top:150px`
  inside `#rootApp`; move them in `strava.css` if they collide with the YouTube window or the metric strip.
- "Hide route options when no route is loaded": the Strava picker button (H1) should follow the same rule where it sits
  next to route-only controls; the picker itself is useful with no route loaded (it creates one).
- All new overlays mount into `#rootApp` (falls back to `<body>`), z-index 9000, so they scale with the app's zoom.

## 5. Design

### 5.1 Recent runs / routes picker
`StravaApi.listRecentRuns` calls `GET /athlete/activities` (paged, default 30) and keeps `Run`, `TrailRun`, `VirtualRun`
(filters by `sport_type`, falls back to `type`; manual entries skipped) until 20 runs are found (max 4 pages). Each item is
slimmed (id, name, date, distance, gain, moving time, `summary_polyline`) and cached in IndexedDB (localStorage fallback).
A second call within 2 minutes costs nothing; if the network or Strava fails, the cached list is shown with an
"Offline - showing the list saved at HH:MM" banner. MY ROUTES uses `GET /athletes/{id}/routes` (run routes only, `type 2`).
Rows are 96-102 px, thumbnails are drawn from the polyline on a canvas (no map tiles, works offline), tap a row to
preview (elevation strip coloured by grade, belt vs real climb, her time/pace) then USE THIS ROUTE.

### 5.2 Activity -> TrailRunner route (`StravaRoutes.convert`)
Streams: `GET /activities/{id}/streams?keys=latlng,altitude,distance,time,velocity_smooth&key_by_type=true` (route
streams use the array form; both handled). Pipeline: drop GPS dupes (distance must advance >= 0.5 m); build a fine
uniform grid (about 10 m); **median-5 then 2-pass box filter (~40 m)** on altitude; resample to N points
(1 per 25 m, 200..600) into the **existing route format** `{id,name,totalDistKm,totalDistM,totalAscent,totalDescent,bounds,
resampled:[{lat,lon,ele,dist}]}`, saved with the normal `Store.saveRoute` as `strava_a_<id>` / `strava_r_<id>`
(re-picking replaces it).
- The engine derives incline from consecutive `ele` values (`Engine._calcGrade`, 6-point window, clamp -6..40) - there
  is no separate incline array. So the **`ele` field stores the treadmill profile**: per-segment grade is clamped to the
  limits and re-integrated; the smoothed real altitude is kept as `eleReal` in each point (extra fields survive
  `Store.saveRoute`). Because the engine's window grade is the mean of segment grades, it can never exceed the
  clamp (asserted in the test through the engine's own `_calcGrade`). A 0.03 % margin inside the limits and 3-decimal
  elevations make rounding safe.
- **Limits**: `StravaRoutes.getLimits()` = intersection of comfort prefs (default **-3 % .. +12 %**, the C1750
  reference) and what the bridge reports at runtime via `TM.getConsoleInfo` (`min_incline_pct`/`max_incline_pct`;
  X32i reports -6..40). `onRouteLoaded` re-bakes from `eleReal` if the bridge is narrower than the stored bake, only when
  no run is active. Steeper climbs are capped at the max; steeper descents are **flattened to the min** (-3 %).
  Note: the existing code has no explicit descent "flattening" beyond the -6 clamp and a -3 % clamp inside the power
  model, so I implemented flattening as clamping to the descent limit.
- The cost of clamping is honest in the UI: "CLIMB ON BELT +483 m" vs "REAL CLIMB +624 m", steepest "12 % (real 42 %)",
  and the % of segments capped. Upload descriptions state both.

### 5.3 Ghost: her real pace
The existing ghost (`Engine.loadGhost(run)`) replays `run.trackPoints[{elapsed, dist}]`, so a Strava ghost needs no engine change:
`StravaRoutes.toEngineGhostRun(routeId)` returns a pseudo-run with `source:'strava-activity'` (+ `ghostSource`) and a point every
2 s, derived from her time-by-distance. Time is **moving time**: intervals slower than 0.4 m/s are compressed to 2 s,
so a coffee stop does not make the ghost stand still (test: 90 s stop removed, ghost total within 0.1 % of
Strava's `moving_time`). API: `StravaRoutes.ghostPositionAt(distanceM) -> {lat,lng,elapsedS}`,
`ghostPositionAtTime(elapsedS) -> {lat,lng,distanceM}`, `ghostDeltaS(distM, elapsedS)`.

### 5.4 Multi-racer race (owner addition) - `StravaRacers`
- **Pool** = her treadmill runs on this route (`Store.getRuns()` + `IDBStore.getRuns`, matched on `routeId`, must have
  covered >= 95 % of the route; partial runs are ignored) **+** her recent Strava runs that cover the same course.
  Works for any loaded route, including GPX routes, as long as there is history.
- **Matching a Strava run to the route** (thresholds in `StravaRacers.MATCH`):
  1. *List stage, 0 extra requests*: total distance within +-5 %; summary-polyline start within 150 m; coarse polyline
     deviation mean <= 80 m and max <= 250 m (cross-track nearest-vertex, sampled every 200 m, windowed +-12 % of progress).
  2. *Stream stage, only for survivors, max 6 downloads per build, cached forever, evaluated ids remembered so a rebuild
     costs 0 requests*: distance within 5 %; start <= 100 m, end <= 150 m; full course deviation sampled every 50 m:
     **mean <= 30 m and 95th percentile <= 50 m**, with direction enforced (the nearest point must lie within +-8 % of the
     expected progress, so a reversed lap fails). Observed in the mock: matches mean 2-3 m, p95 5-6 m; detour decoy mean 57 m / p95 284 m;
     reversed decoy mean 1916 m.
- **Racers** (each moves by distance using its own time-at-distance profile): FASTEST = lowest total time (F, green
  `#3ee89f`), SLOWEST = highest (S, red `#ff4d4d`), AVERAGE = synthetic, elapsed at each distance = **mean of all pooled runs'**
  elapsed at that distance (A, yellow `#ffd54a`), YOU = blue `#37d0ff` (drawn by the app). One pooled run -> a single
  yellow ghost labelled YOUR RUN; none -> nothing; fastest == slowest (tie) -> a single yellow ghost (YOUR RUNS (AVG)).
  Two runs -> F and S are those runs and A sits between them.
- **Not colour alone**: every dot carries a letter (F / A / S; S is a rounded square, A a teardrop for shape redundancy);
  the legend lists letter chip, label, source and date (`Strava 14 Sep`, `Treadmill 02 Oct`) and total time, plus live gap.
- **API**: `StravaRoutes.racers()` / `StravaRacers.racers()` -> `[{id,label,letter,colour,source,date,totalS,legend}]`;
  `racerPositionsAt(distanceM)` -> `[{id,lat,lng,elapsedS}]` (where each was at that distance and when);
  `racerPositionsAtTime(elapsedS)` -> `[{id,lat,lng,distanceM}]` (where each is *now*; what the dots use);
  `gapsAt(distanceM, currentElapsedS)` -> `[{id,label,letter,colour,gapS}]` with **+ = Soph is ahead**; `gapsText(...)` ->
  `"Fastest -10:22, Average +0:04, Slowest +10:22"`.
- **Drawing**: `StravaRacers.mapLayer` (Leaflet lettered divIcons, own pane), `StravaRacers.drawOnCanvas(ctx, fracToXY, elapsedS, r)` and
  `StravaRacers.ovalTrack.install()` (wraps `OvalTrack._drawPacMan`, uses `OvalTrack._fracToPoint`), `StravaRacers.legend`.
- **Engine ghost** is still armed (fastest racer) so the existing summary delta / Ghost Buster badge keep working;
  its marker is suppressed in favour of the race dots.
- **Double counting (treadmill run also uploaded to Strava)**: a Strava activity is dropped from the pool when (a) its
  start time is within 120 s of a stored treadmill run and its distance within 3 %, or (b) the app recorded that upload
  (`tr_strava_uploaded` {runId: activityId}, written by `StravaUpload`), or (c) `run.synced.strava.activityId` matches.
  The **treadmill copy is kept** (exact data); the dedupe runs *before* streams are fetched, so it also saves requests.
  Residual risk: a run done on the treadmill with a manually edited start time on Strava would be counted twice.
  Also note the treadmill route clock is `Engine.run.elapsed` (excludes pauses) and Strava's is moving time (stops compressed):
  comparable, not identical; a treadmill run with many long pauses is slightly flattered.

### 5.5 Overlay
`StravaRoutes.overlay.attach(map, route)`: one Leaflet polyline per route segment coloured by (clamped) grade
(thresholds same as `UI._gradeColor`: >10 red, >6 orange, >2 yellow, >-1 cyan, then green / violet for descents), the part
already run turns solid green (`setProgress(distM)`). `StravaRoutes.drawProfile(canvas, route.resampled, {runnerM, ghostM})`
draws the elevation strip. The ghost position API is exposed as above for the other agent's code.

### 5.6 Upload back (`StravaUpload`)
- **Never automatic**: `onRunSaved(saved)` shows a full-screen card with TIME / DISTANCE / CLIMB / AVG HR, route, and two
  104 px buttons **SAVE TO STRAVA** / **SKIP**. SKIP is remembered per run (`tr_strava_skipped`). Tiny (<30 s or <100 m)
  runs or not-connected state never show the card. A run already uploaded is never offered again.
- File: TCX with time, cumulative distance, HR, calories, avg/max HR, altitude (the belt profile). No cadence (as requested).
- **Modes** (`prefs.uploadMode`): **`trainer` (default)**: no GPS, `sport_type=Run`, `trainer=1`, named
  "<Route> (treadmill)"; description gives the route, belt climb vs real climb and the incline limits. **`virtual`**:
  route lat/lng interpolated by distance, `sport_type=VirtualRun`, named "Virtual run: <Route>"; gets a map. The card shows a
  toggle only when a route was followed. *Why trainer is default*: a treadmill has no GPS; faking a path makes Strava treat it
  as outdoors (segment efforts, local legends, heatmaps, pace/elevation recomputed from invented geometry) and shows
  followers a map she did not run. Trainer-flagged indoor runs are what Strava expects for a treadmill, and the route and
  climb are in the title/description. Virtual stays available because the map is the nicer thing to look at.
- `POST /uploads` multipart: `file, data_type=tcx, sport_type, name, description, trainer, external_id=trailrunner-<run id>`.
  `external_id` equals the filename convention sync.js used, so Strava's duplicate check also catches an accidental double.
  Then `GET /uploads/{id}` every 2 s (docs: >= 1 s) for up to 90 s until `activity_id` appears; `duplicate of activity N` is shown as
  "Already on Strava"; other `error` text is shown (HTML stripped) with TRY AGAIN / SAVE FOR LATER / CLOSE.
- Offline / 5xx / 429 / timeout: the **confirmed** upload (file included) is queued (IndexedDB, max 5, never for SKIP) and retried
  on the `online` event or `StravaUpload.flushQueue()`; permanent failures are dropped from the queue, not retried forever.
- Upload privacy: I did not find an upload parameter for visibility; the activity gets her Strava default. The
  FEATURE_SPEC "Privacy: everyone/followers/only me" setting therefore cannot be honoured at upload time (could not confirm
  whether an activity-update call can change it; the documented update fields I know of do not include visibility).

### 5.7 Errors and limits
- **401** -> one forced token refresh + one retry; still failing -> code `auth` ("Strava login expired - reconnect"); 401/403 mentioning
  permission -> code `scope`. **429** -> cool-down to the next quarter-hour boundary (daily limit: to 00:00 UTC), all reads
  refused locally until then, cached data shown. A local counter also refuses requests once ~90 of the 100 read slots of the
  current 15-minute window are used (usage headers are read and trusted only for the current window).
- Typical session cost: picker open = 1-2 list calls (cached 2 min), preview = 1 streams call (cached forever), race build =
  <= 6 streams (cached forever, evaluated ids remembered), upload = 1 POST + ~2-3 polls. Far inside 100 per 15 min.

## 6. Compliance and limits (checked 2026-10-22)

Verified by fetching https://developers.strava.com/docs/rate-limits/, /docs/authentication/, /docs/uploads/, /guidelines/,
the API reference (first 100 000 characters only) and https://www.strava.com/legal/api (shows "Effective Date June 1, 2026"):

- **Rate limits (default app)**: 200 requests / 15 min and 2 000 / day overall; **read (everything except POST activities,
  POST uploads, media upload) 100 / 15 min and 1 000 / day**. Headers `X-RateLimit-*` and `X-ReadRateLimit-*` give
  "15-min,daily". Over the limit = 429; short-limit overruns still count to the daily total. Windows reset at :00 :15 :30 :45;
  daily at 00:00 UTC. (Your brief's "~100/15 min and 1 000/day" is the *read* limit.)
- **Data display**: Strava data from a user may only be shown to **that user** (agreement); no data about other athletes,
  even public. This app only shows Soph her own data on her own treadmill: compliant. Do **not** add sharing of her Strava data
  to other people (e.g. the HA webhook in sync.js sends run stats, not Strava data - fine; do not forward activities fetched from Strava).
- **Tokens/secret**: token confidential, not shared with other apps/developers, report suspected exposure to
  developers@strava.com within 24 h. Hence section 3.
- **Termination/deletion**: on termination delete all Strava data and API materials and tell users access ended. The `Disconnect` hook (H11)
  purges tokens, cached lists, streams and pools (`StravaApi.purgeData()`); route copies the user saved (converted routes in `Store`) are
  derived Strava data too - `StravaRoutes.allMeta()` lists them so a "delete all Strava-derived routes" action can be added (not built).
  Deauthorisation: legacy `POST /oauth/deauthorize` (access token) or `POST /oauth/revoke` (Basic auth with client secret - only practical via the proxy);
  the docs say `revoke` becomes the only endpoint on 2027-06-01. **Not implemented** (needs the proxy for revoke).
- **Brand**: "Powered by Strava"/"Compatible with Strava" text or official logos, not more prominent than the app, never modified or used as an
  app icon; **Connect with Strava** official button (orange/white SVG, 48 px @1x) must be used for OAuth; link to original data with the text
  **"View on Strava"** in bold, underlined or orange `#FC5200` (done in the picker and upload success). I use text "Powered by Strava" until you drop
  in the official logo.
- **Could not confirm from the pages I could read**: (1) any cache/retention duration (a "7 day" limit is sometimes quoted; the agreement text I
  retrieved did not contain one - treat as unknown, I cache streams indefinitely, which you may want to cap); (2) the AI/ML prohibition and the
  "do not mimic Strava's look" rule (reported by news coverage of the Nov 2024 agreement change; the retrieved agreement text did not state them;
  nothing here uses Strava data for AI/ML and the UI uses its own design); (3) athlete-capacity (single-player) mode wording; (4) PKCE; (5) exact stream/route/upload-status
  response fields, which came from memory because the reference page was truncated (`type 2` = run route, `id_str`, route streams as an array, `sport_type`
  `VirtualRun`). The code is tolerant of these but they are unverified against live Strava.

## 7. Safety (restated)
Nothing in the Strava code starts the belt, changes speed or sets incline: it contains no `TM.setSpeed/setIncline/startWorkout/stopWorkout`
(the only treadmill call is the read-only `TM.getConsoleInfo`; the test and a static check assert this). Incline still comes only from
`Engine._applyAutoControl()` in **route mode while a run is active**, reading the route's `ele` values, which are pre-clamped to the bridge/comfort
limits (and the engine's/treadmill's own clamps and rate limiting still apply). Re-baking against narrower bridge limits is skipped while a run is
running or paused. `StravaPicker.use()` only stores a route and calls `App.selectRoute` (which does not start a run).

## 8. What was verified, and what was not
Verified (see `docs/strava-test-output.txt`: 86/86 Node checks + 13 Playwright checks, screenshots `docs/strava-ui-*.png`):
list -> pick -> streams -> conversion with grade clamps measured through the **real** `Engine._calcGrade`, ghost monotonic and matching moving time, narrower-bridge re-bake,
ghost replay through the real `Engine.loadGhost/_tickGhost`, token expiry refresh, server 401 retry with rotating refresh token, 429 cool-down, offline cache,
route matching accept/reject (4 matches, detour + reversed decoys, unrelated runs), pool dedupe, fastest/slowest/average maths, 0/1/2/tie cases, gap signs, TCX shape,
multipart upload fields, status polling, duplicate, queue + retry, error path, rows >= 72 px, button sizes, nothing uploaded before SAVE.

**Not verified**: anything against real Strava (field names/behaviours above marked unverified); the treadmill's Android 7.1.2 WebView
(code is ES5 + Promise/fetch/FormData/Blob/canvas, CSS avoids flex gap/clamp/backdrop-filter, uses `position: sticky` and flex, which the README already assumes; no `async`, arrow functions, optional chaining);
real OAuth through the GitHub Pages callback; Leaflet map tiles (offline in the harness); the real `oval-track` wrapper (only the generic canvas drawing is tested with a fake context);
how the other agent's in-flight changes interact with H2-H6.

## 9. Decisions and why
1. Own `strava-picker.js` (not in your file list) to keep UI out of the pure-logic files.
2. Route `ele` stores the clamped profile (engine has no other incline source); real altitude kept as `eleReal`.
3. Comfort limits default -3..+12 intersected with bridge limits, so the app never asks more than either allows.
4. Ghost implemented through the existing `Engine.loadGhost` with a new source type `strava-activity`; no engine change.
5. Upload default `trainer` (no GPS) rather than a fake track; `virtual` opt-in.
6. Confirm screen is mandatory; the queue holds only already-confirmed uploads.
7. Treadmill copy wins when the same effort exists on both sides.
8. Option B (serverless token proxy) recommended; A kept as the fallback so nothing breaks before it exists.

## 10. Open questions for the owner (defaults APPLIED in round 4: answers in bold; change if she disagrees)
1. Whose Strava account will own the API app (must be Soph's for single-athlete mode)? Do you want to raise capacity / apply for approval (needed only if others will connect)? **Soph's own account (documented, nothing registered); no capacity increase.**
2. Is a Cloudflare Worker (or Go bridge endpoint) acceptable for the secret, or stay with option A for now? **Option A (type the secret into Settings) keeps working; the optional token proxy URL (Settings -> Integrations, `tokenProxyUrl`) is supported end to end (client, callback page) and sends no secret.**
3. Default upload mode `trainer` OK? Do you want the confirm screen to ask a name? **Treadmill run without GPS by default; "Virtual run on route" is a Settings option and a toggle on the confirm card. No name prompt.**
4. Comfort incline limits -3/+12: right for Soph, or should she use the full X32i range (-6..40) with only a user cap? **-3..+12 intersected with the bridge-reported limits; editable in Settings (descent -6..0, climb 1..40).**
5. Should the race (F/A/S) appear on the oval track view only, the map only, or both (hook H6 is optional)? **Both: map dots and oval-track discs (H6 applied).**
6. Retention: cap cached streams (e.g. 30 days / 20 activities)? Should "Disconnect" also delete the Strava-derived routes? **Disconnect deletes cached streams, lists, pools AND Strava-derived routes. No age cap yet (still open: retention duration is unconfirmed, section 6).**
7. Treadmill runs with a Strava twin: keep the treadmill copy (current) or prefer Strava? **Treadmill copy wins.**
8. Where should the racer legend sit on the live screen (currently top-left under the top bar) given the YouTube window? **A compact in-flow bar between the metric strip and the view zone (section 4a).**

## 11. Round 4 verification (2026-10-22)
Run against the mocks only (mock treadmill :4510, static :8099, mock Strava :8098): `node mock/strava-test.js` 86/86,
`node mock/strava-ui-smoke.js` 13/13 checks, `node mock/screens.js`, `node mock/screens-splits.js`, and the new
`node mock/strava-e2e.js` (see `docs/strava-e2e-output.txt`, screenshots `screens/strava-*.png`). Not verified: real Strava
(field names, OAuth through the real GitHub Pages callback), the Android 7.1.2 WebView, the real treadmill. The e2e injects
two km splits into the live run before STOP because a 40 s mock run only covers ~120 m; the past-run side is real data.
