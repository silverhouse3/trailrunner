# ui-v4 FEATURE AUDIT (stubs, silent failures, real-treadmill and WebView gaps)

Audit date 2026-10-22. Read-only for app code: nothing under `js/ css/ *.html` was edited by the audit.
**Moving target:** another agent was editing ui-v4 while this ran (git HEAD `551e609` landed mid-audit; working tree also gained
`js/strava-config.js`, `js/video-view.js`, `bridge/grpc-bridge-v4/`, `chooser3/`). Findings below say which state they were observed in.
Real bridge compared = `bridge/grpc-bridge/main.go` (health says `3.2-native`, not 3.0). `bridge/grpc-bridge-v4/main.go` (`4.0-native`, dead-man) has the
same route list, so every gap in section 3 applies to both.
Wrapper compared = deployed `chooser/` (v2, plain WebView) and the **not yet installed** `chooser3/` (v4.1: WebChromeClient, file chooser, downloads, `AndroidBridge`).

Test artefacts (all new files): `mock/audit-features.js`, `mock/audit-ghost-splits.js`, `mock/audit-hr-stale.js`, `mock/audit-webview-sim.js`,
`mock/audit-workout-hud.js`, `mock/audit-strava-first-connect.js`, `mock/audit-strava-e2e.js` (copy of strava-e2e.js on private ports),
`mock/audit-strava-test.js` (copy of strava-test.js on a private port). All run against **private** copies of the mocks
(`PORT=8199 node mock/static.js; PORT=4610 node mock/server.js; PORT=8198 node mock/strava-mock.js`); the shared 8099/4510/8098 servers were never touched. No adb, no treadmill, nothing committed.

## 0. Headline

| | |
|---|---|
| P0 | (1) HR dropout lets HR->SPEED / HR->INCLINE run away on a frozen heart-rate value (reproduced: 12 -> 20 kph in 15 s). (2) First Strava connection started from Home > STRAVA > CONNECT fails ("Strava credentials not found") unless the user first pressed Connect in Settings. (3) Strava fixes (ui-v4 callback, client id default) are committed locally but **not on GitHub Pages**: live still redirects to the OLD root app. |
| P1 | Native `confirm()/alert()/prompt()` are dead in the deployed wrapper (deletes and Strava disconnect silently do nothing, error alerts invisible); GPX import file picker dead; GPX/TCX/CSV downloads dead; mic button silent; coach TTS has no working fallback (`/tts` does not exist on the real bridge); BLE strap pairing impossible; speed/incline rejections swallowed; fan control ignored by real bridge; video "OPEN IN YOUTUBE" kills the app screen on v2 and strands the user on v4.1; workout stage/time-left is never shown. |
| Verified fine | Core run lifecycle, nudges/presets, E-STOP, safety-key banner, pause/resume, routes, workouts arm-not-start, ghost, split comparison, stats, settings persistence, video window, Strava picker/route/racers/SAVE-SKIP/queue/disconnect (mock). |

## 1. Feature status table

Status: REAL = works end to end (mock + real-bridge protocol), PARTIAL = works with a material gap, STUB = UI/setting exists, nothing behind it, BROKEN = fails or silently does nothing on the target device/real bridge.
"mock" = exercised with Playwright this audit (script id in brackets); "code" = read only.

| # | Feature | Where | Status | Evidence |
|---|---|---|---|---|
| 1 | Home tiles FREE RUN / ROUTE / WORKOUT, belt never starts from Home | index.html:44-61, App.freeRun | REAL | mock [A1,B1]: 3 tiles, START visible, bridge IDLE |
| 2 | START / PAUSE / RESUME / STOP(finish) | App.startRun/togglePause/finishRun, Engine | REAL | mock [B2,B7,B12]. PAUSE is a graceful 3-10 s ramp-down; bridge shows RUNNING 0.9 s after the tap (0.2 kph) and PAUSED after ~11 s |
| 3 | Speed / incline +/- nudges (0.5) | App.adjustSpeed/adjustIncline | REAL | mock [B3,B4] bridge target followed |
| 4 | Speed / incline presets (tap number) | #qsSpeed/#qsIncline | REAL | mock [B5,B6] pills 5,6,8,9,10,12 |
| 5 | E-STOP | TM.emergencyStop | REAL | mock [W9] speed 0, incline 0, workout stop |
| 6 | Safety key out banner + belt stop + overlay | TM._showSafetyKeyWarning | REAL | mock [B10,B11] red banner, STATE "SAFETY KEY OUT", bridge IDLE, pause overlay |
| 7 | Bridge state banner / dropped-workout handling | App._updateStateBanner | REAL | mock [B10,BD1] |
| 8 | HR display from bridge | Engine.onTreadmillData | PARTIAL | forced 150 bpm shown, zone Z4 [B8]. **Dropout never clears**: value + LIVE badge stay forever [B9] |
| 9 | HR->SPEED / HR->INCLINE control | Engine._applyAutoControl | BROKEN (P0) | [audit-hr-stale] target 12 -> 20 kph in 15 s after the source reported 0 |
| 10 | Route list, RUN THIS ROUTE, route-only views hidden w/o route | UI.openRouteModal | REAL | mock [D1,D2], strava-e2e routeless checks |
| 11 | GPX import (file input) | App.triggerGPXImport | PARTIAL | mock desktop OK [D1] (Ashton Court 9.27 km). v2 WebView: `input.click()` does nothing [W6]. v4.1: needs a document-picker app on the ROM (unverified) |
| 12 | Route delete (confirm) | ui.js:448 | BROKEN on v2 | `confirm()` returns false without WebChromeClient: route NOT deleted [W7]; fine on desktop [D7] and on v4.1 |
| 13 | Map views oval/numbers/terrain/sat/dark/track/trailcam/radio | App.setMapStyle | REAL | mock [D4] no page errors (tiles need internet: not verified) |
| 14 | Street view | App.setMapStyle('street'), needs Google key | PARTIAL | shows "add API key" card [D5]; hidden from view buttons; works only with a key + internet (not verified) |
| 15 | Trail cam with own video | trailcam.js:226 file input + IndexedDB | PARTIAL | module loads [D6]; upload needs the same file chooser as #11 |
| 16 | Radio / custom stream | media.js (12 https streams) | PARTIAL | UI REAL; actual stream playback on the console not verified (internet blocked in test) |
| 17 | Workout library, arm (not start), START | workout-builder.js | REAL | mock [E1,E2,E3]: 19 templates, bridge IDLE after tap, targets applied after START |
| 18 | Workout stage name / time left / progress | `#workoutHud` (ui.js:757), WorkoutSegments | PARTIAL | `#workoutHud` reads legacy `Engine.workout`, never set by builder workouts; segment info reaches the runner only as voice + a toast; no view shows it [audit-workout-hud screenshot 25] |
| 19 | Native "program to console" | workout-builder.js:744/778 `TM._bridgeUrl` | STUB | `TM._bridgeUrl` does not exist (property is `_bridgeBase`) so the branch is dead; real `/workout/program` also builds the workout then discards it (`_ = workout`) |
| 20 | Workout builder save / delete | workout-builder.js:621 | PARTIAL | delete uses `confirm()` (same as #12) |
| 21 | Ghost race (pick a past run) | App.loadGhost, Engine._tickGhost | REAL | [GH1,GH2] ghost loads from a run with trackPoints, delta chip ticks. Runs shorter than the track-point interval have no ghost [F2] |
| 22 | Save / discard run | App.saveAndNewRun/discardRun | REAL | mock [B15,C1] stored 0->1, discard 1->1, no confirm dialog |
| 23 | Per-km split comparison on summary | past-run-splits.js, split-compare.js | REAL | route run with 9 past runs: verdict + chart [SP1]. Deliberately hidden for Free Run (no history to compare) |
| 24 | Share summary (copy) | App.shareRunSummary | PARTIAL | clipboard then `prompt()` fallback [B13,W4]; prompt dead on v2 |
| 25 | Export GPX / TCX (summary buttons) | App._downloadFile | PARTIAL | downloads on desktop [B14]; v2 WebView: nothing saved [W5]; v4.1 injected hook catches it (unverified on device) |
| 26 | stats.html (period cards, PRs, history, charts), demo seed | stats.html | REAL | mock [G1,G3] no errors; 20 rows, DEMO banner |
| 27 | Stats EXPORT CSV | stats.html:1524 | PARTIAL | same download limitation as #25; stats.html has no AndroidBridge shim |
| 28 | Settings persist across reload | SettingsPanel._save, Store | REAL | mock [H1] weight 77 survived reload |
| 29 | Settings that are saved but read by nothing | settings-panel.js:900-930 | STUB | `autoPilotEnabled/Priority/Interval`, `warmUpEnabled/Duration/Speed`, `coolDownEnabled/Duration/Mandatory`, `defaultView`, `exportFormat`, `ghostOpacity`, `ghostEnabled`, `ghostSource`, `showPacMan`, `fontSize`, `autoHideUI`, `animations`, `streaksEnabled`, `userName`, `weightUnit`, `sfxEnabled`: grep finds no reader outside settings-panel.js (`Engine.ghostEnabled` / `oval-track config.showPacMan` are unrelated fields) |
| 30 | Settings > Bluetooth "Garmin Watch: Not Available" | settings-panel.js:508 | STUB (label) | static text; "GARMIN CONNECT: Via Strava sync" and "External Speaker: Built-in RT5651" are static info rows |
| 31 | Keep screen on / Wake Lock | app.js:1988, settings-panel.js:985 | PARTIAL | `navigator.wakeLock` does not exist in Chromium 83; both wrappers set FLAG_KEEP_SCREEN_ON so the screen stays on regardless |
| 32 | Video window (YouTube embed) | video.js | PARTIAL | window, no-iframe-before-PLAY, offline fallback verified [I1,K2]; embed playback on the console is NOT verified (README says so too) |
| 33 | Video "OPEN IN YOUTUBE" | video.js:133 intent:// link | BROKEN v2 / PARTIAL v4.1 | see P1-9 |
| 34 | Strava connect (Settings > Connect) | App.connectStrava, StravaApi.connect | REAL | [audit-strava-first-connect flow A], strava-e2e 58/58, strava-test 86/86 (mock) |
| 35 | Strava connect from Home > STRAVA > CONNECT | strava-picker.js:118 | BROKEN (P0) | [audit-strava-first-connect flow B] ends on callback page "Strava credentials not found" |
| 36 | Strava picker, route build, racers, SAVE/SKIP upload, queue retry, disconnect | strava-*.js | REAL (mock) | audit-strava-e2e 58/58, audit-strava-test 86/86, e.g. exactly one upload after SAVE, SKIP queues nothing, offline -> queued -> flushed, disconnect purges tokens/routes/cache. **Real strava.com never exercised** |
| 37 | Official "Connect with Strava" button image | strava-picker.js:121 | PARTIAL | `img/btn_strava_connect_with_orange.svg` is not in the repo (404 live), text button shown instead |
| 38 | Legacy auto-upload (`Sync.legacyAutoUpload`) + old `Sync.connectStrava/handleCallback/autoSync` | sync.js:176,287-329 | STUB (intentional) | default false, inert by design; dead code kept |
| 39 | Webhook (HA/IFTTT) / bridge summary POST | sync.js:404,464 | REAL | called at app.js:1066; bridge route `/api/workout/summary` exists |
| 40 | Voice commands (mic) | voice-commands.js, voice.js, `#voiceMicBtn` | BROKEN on WebView | no SpeechRecognition in Android WebView: `VoiceCommands.supported=false`, button click gives no feedback [W2] |
| 41 | Voice coaching (TTS) | voice.js VoiceCoach | PARTIAL / unverified | `speechSynthesis` object exists in WebView but needs an installed TTS engine; fallback `/tts` only used when the object is missing and the real bridge has no `/tts` |
| 42 | Mic cadence (`Cadence`) | cadence.js | STUB | `Cadence.start()` is never called anywhere; cadence is the speed-based estimate |
| 43 | BLE HR strap ("❤" pill, Settings > Scan) | treadmill.js:655, App.connectHR | BROKEN on WebView | `navigator.bluetooth` absent -> toast "pair HR strap in Android Settings" [W8]. HR only flows if the console itself has a sensor (bridge gRPC) |
| 44 | Fan auto-control | engine.js:958 TM.setFan | BROKEN on real bridge | `/command {"Fan Speed"}` is ignored by `processMessage` |
| 45 | Bridge down behaviour | App.startRun | PARTIAL | pill TREADMILL, banner NO TREADMILL, but START still runs a simulated run (CONNECTING...) with no warning toast [BD1,BD2] |
| 46 | Offline start | index.html (no SW) | PARTIAL | app needs internet to load from GitHub Pages; wrapper shows its own "No internet" screen [K2] |
| 47 | Badges / streaks | streaks.js | PARTIAL | works; "View Badges" is an `alert()` (dead on v2) |
| 48 | remote.html | ui-v4/remote.html | STUB | not linked from anywhere in ui-v4; `alert('Connect first')`; not tested |
| 49 | `?demo=route / ?demo=noroute` flags | app.js:489 | REAL (dev) | fetches `mock/sample.gpx` (deployed under /ui-v4/mock/) |

Counts (49 rows): **REAL 19, PARTIAL 17, STUB 6, BROKEN 7** (BROKEN = rows 9, 12 (v2 only), 33 (v2 only), 35, 40, 43, 44; rows 11/25/27/24/20 are PARTIAL because they work on desktop and in v4.1 but not in the deployed v2 wrapper).
No "coming soon" / TODO / FIXME text exists anywhere in ui-v4 (grep of html/js/css, excluding vendor/mock): the only placeholder-like strings are rows 30, 38, 48.

## 2. Mock test results (Playwright, mocks only)

`node mock/audit-features.js` (1920x1000) and `node mock/audit-features.js 80` (1920x1080 + `?safeBottom=80`): results in section 6.
Extra scripts: `audit-ghost-splits.js` (GH1/GH2/SP1/BD1/BD2 all as listed), `audit-hr-stale.js` (FAIL = bug reproduced), `audit-webview-sim.js` (emulates WebView gaps), `audit-workout-hud.js`, `audit-strava-first-connect.js`.
Test-harness note: three Strava lines in the 80 px pass failed after the other agent's `strava-config.js` made the Client ID default (my J1 expected the old "Enter your Strava Client ID" alert); J1 was rewritten. Strava end-to-end is therefore also covered by `audit-strava-e2e.js` (58/58) and `audit-strava-test.js` (86/86).

## 3. Real-bridge gap analysis (web app vs `bridge/grpc-bridge/main.go`, v4 identical routes)

| App sends (file) | Real bridge | Mismatch / user-visible consequence on the REAL treadmill |
|---|---|---|
| `GET /health` (treadmill.js:89) | served; `version 3.2-native`, workoutState, grpc | none |
| `GET /state` 1 Hz poll (treadmill.js:212) | served: `values{KPH,Incline,Heart Rate,Distance,Calories,Elapsed,Elevation}` strings + `workout{state,id,grpc,safetyKeyOut,consoleState}` | **No `Watts`** (mock sends it) so POWER is the app's own model. **`Heart Rate` is "0" with no sensor** (mock never sends 0) which exposes the P0 stale-HR bug; the mock cannot show it unless you POST `/mock/hr {bpm:0}` |
| `POST /speed`, `/incline` (treadmill.js:341-360) | served; rejects with `{ok:false}` for: speed>0 while not RUNNING, safety key out ("motor commands blocked"), clamp 0-22 kph, ramp limit 4 kph/s per call | App fire-and-forgets (`.catch(function(){})`, response ignored) and its own dedup (`_lastSpeed`) then refuses to resend: a rejected or ramp-capped command leaves the belt at the old speed while the UI shows the new target. No toast. |
| `POST /command {"values":{"Fan Speed":n}}` (treadmill.js:364, engine.js:958 auto fan by HR zone) | `processMessage` handles only KPH/MPH/Incline/Grade | fan never changes; no error |
| `POST /workout/start|stop|pause|resume` | served, JSON `{ok,...}` | handled; "Treadmill refused to start" toast works |
| `GET /api/console` (treadmill.js:636, strava-routes limits) | served with `min_incline_pct`,`max_incline_pct`,... | OK on real; mock returns only `console_state/safety_key_removed/model`, so mock tests never exercise the real console clamp for Strava routes |
| `POST 127.0.0.1:4510/api/workout/summary` (sync.js:464) | served (MQTT publish) | OK |
| `POST /workout/program` (workout-builder.js:778) | served but discards controls | dead branch in the app anyway (`TM._bridgeUrl` undefined) |
| `POST http://localhost:4510/tts` (voice.js:500) | **no such route (404)** | coach fallback silent. Only reachable if `window.speechSynthesis` is missing, so on WebView the real failure mode is "TTS engine missing" which has NO fallback at all |
| `ws://host:4510/ws` `{type:get|set|workout}` | handled (`processMessage`) | only used after 3 failed HTTP health tries; WS fallback ignores a `?bridge=` port override (connected to a different mock in test [K1]) - irrelevant on device |
| WS fallback ports 80 / 8080 (treadmill.js `_ports`) | n/a (legacy uthttpd) | harmless extra attempts |
| `/api/state` | served flat keys | app never calls it |
| Dead-man (v4 bridge only) | slows belt if no client contact for 20 s | web app polls `/state` every 1 s so it is safe, provided the WebView keeps timers running (activity paused = belt slows) |

## 4. WebView 83 gap analysis (Android 7.1.2, no Google services)

"v2" = deployed `chooser/` (plain WebView, no WebChromeClient). "v4.1" = `chooser3/` (not installed yet; per its README/TRChrome).

| API | Used at | Plain WebView (v2) | v4.1 wrapper | Severity | What must happen |
|---|---|---|---|---|---|
| `confirm()` | ui.js:448, workout-builder.js:621, app.js:1565, stats.html:325 | returns false: route/workout delete and Strava disconnect silently do nothing | custom dialogs (`onJsConfirm`) | P1 (v2) | install v4.1 **and** replace with in-page modal so it never depends on the shell (diff P1-1) |
| `alert()` | app.js:1214,1570,1572; settings-panel.js:1016; sync.js:66; stats.html:1499 | invisible: no feedback for "enter Client ID/Secret", "failed to parse GPX", "no runs to export" | `onJsAlert` dialog | P1 (v2) | in-page toast |
| `prompt()` | app.js:1125,1128 (share fallback), video.js:189 (name favourite) | returns null: share-copy fallback and favourite naming dead | `onJsPrompt` | P2 | in-page text box |
| `<input type=file>` | index.html:455 (GPX), trailcam.js:226 | click ignored | `onShowFileChooser` -> ACTION_GET_CONTENT; if the ROM has no picker: toast "No file picker" | P1 | add paste-GPX / URL import fallback (P1-3) |
| Blob + `<a download>` | app.js:2025 `_downloadFile`, stats.html:1524 | nothing saved, no error | injected hook + `AndroidBridge.saveFile` -> /sdcard/Download/TrailRunner | P1 | call `AndroidBridge.saveFile` explicitly in both places; the user also needs a way to reach the file (no file manager known on this ROM) |
| `webkitSpeechRecognition` | voice-commands.js:53, voice.js:56 | not exposed in WebView: mic does nothing, silently | RECORD_AUDIO added but SpeechRecognition still absent | P1 | hide/disable mic when unsupported, or a native recogniser via AndroidBridge (needs a recognition service; Google services absent) |
| `speechSynthesis` | voice.js:382, voice-commands.js:410 | object exists; speaks only if the ROM has a TTS engine (unverified) | unchanged | P1 (unverified) | on device run `speechSynthesis.getVoices().length`; if 0 add `AndroidBridge.speak()` backed by `android.speech.tts.TextToSpeech` |
| `getUserMedia` | cadence.js:47 | needs onPermissionRequest | handled (audio, app origin only) | none today | feature never started (row 42) |
| Web Bluetooth | treadmill.js:655,745 | absent | absent | P1 (UX) | accept: HR comes from the console; change copy + pill behaviour |
| Fullscreen API | not used | n/a | YouTube fullscreen via onShowCustomView | none | |
| `window.open` | index.html:65,366 `window.open('stats.html','_self')` | `_self` navigates normally | same | P2 | use `location.href` |
| Clipboard | app.js:1120 | `navigator.clipboard` exists on https, may reject without gesture | same | P2 | falls to prompt (see above) |
| Notification | not used | | | none | |
| Wake Lock | app.js:1988 | absent in 83 (added in 84) | n/a | none | FLAG_KEEP_SCREEN_ON covers it |
| localStorage quota | storage.js `_set` | ~5-10 MB; write errors are only `console.warn`: a run that fails to save vanishes with no message | same | P2 | catch -> toast + drop oldest (P2-3) |
| IndexedDB | idb-store.js, strava-api kv, trailcam | supported | same | none | |
| Service worker | index.html:20 unregisters | not used; first load needs internet | same | P2 | bundle app in the APK or serve it from the bridge for offline use |
| Autoplay | media.js, video.js | `setMediaPlaybackRequiresUserGesture(false)` set | same | none | app already never autoplays on load |
| Mixed content https -> http://127.0.0.1, ws:// | treadmill.js | allowed (loopback trusted + `MIXED_CONTENT_ALWAYS_ALLOW`) | same | none | |
| CORS | bridge `cors()` allow-origin `*`; **Strava preflights checked live** (oauth/token, api/v3 uploads + activities): `access-control-allow-origin: *`, headers content-type / authorization | OK | OK | none | |
| OAuth round trip strava.com <-> github.io | strava-api.js:114 `location.href` | free navigation (v2 also lets `strava://` or social-login redirects through) | **allow-list**: strava.com, github.io, youtube; everything else blocked with a toast | P1 | Strava login by Google / Facebook / Apple navigates to accounts.google.com etc. -> "Blocked". Either add those hosts or tell the user to use e-mail+password. Google refuses WebView sign-in anyway |
| `intent://` YouTube link | video.js:136 | `ERR_UNKNOWN_URL_SCHEME` on the main frame -> wrapper shows its "Page failed to load" screen instead of the app | converted to https://www.youtube.com/watch and loaded **in the same WebView** | P1 | Back is ignored by the wrapper, so the user is stranded on youtube.com (only the 2 s top-left long-press returns to the chooser). Show the URL text instead of navigating (P1-9) |

## 5. Strava, code level

* **Where the user supplies credentials:** Settings > Integrations > "STRAVA APP CREDENTIALS": `#spStravaId` (text) and `#spStravaSecret` (password) (settings-panel.js:768-775); optional token-proxy URL `#spStravaProxy` (settings-panel.js:736). The Client ID now defaults to `212069` from `js/strava-config.js` (`StravaApi.app()` falls back to it), so normally only the **Secret** is typed.
* **Where they are stored:** (a) `Store` settings blob `tr_settings` (`stravaClientId/Secret`) on Save; (b) `tr_strava_app` `{clientId, clientSecret}` **only when Connect (App.connectStrava) is pressed** (app.js:1560 `Sync.stravaApp = ...`). The callback page reads only (b). Tokens: `tr_strava`, scope in `tr_strava_scope_requested`, state in `tr_strava_oauth_state`, prefs `tr_strava_prefs`. All localStorage of origin `https://silverhouse3.github.io`, shared by `/trailrunner/`, `/trailrunner/ui-v4/` and the old root app.
* **Redirect URI computation:** hard-coded constant `StravaApi.REDIRECT_URI` (strava-api.js:54). Audit start: `https://silverhouse3.github.io/trailrunner/strava-callback.html` (root copy). Working tree/HEAD now: `https://silverhouse3.github.io/trailrunner/ui-v4/strava-callback.html`. Strava only checks the callback **domain** (`silverhouse3.github.io`), which must be registered in the Strava API app; I could not verify that registration (no Strava login).
* **Scope:** `read,read_all,activity:read_all,activity:write` (strava-api.js:51) sent URL-encoded; callback stores the scope Strava granted and warns on the callback page if `activity:write` or `activity:read_all` was unticked [verified in mock: authorize URL scope + stored scope identical].
* **Callback page:** `ui-v4/strava-callback.html` and the root `strava-callback.html` are line-for-line identical (diff clean at audit start); both end with `window.location.href = './index.html'` after 2 s. Relative to the page that is `/trailrunner/ui-v4/index.html` for the ui-v4 copy (correct) and `/trailrunner/index.html` = the OLD app for the root copy. Tokens are saved under the same origin so they are visible to ui-v4 either way, but the user would land in the old UI (and that page registers the old root service worker `sw.js`, scope `/trailrunner/`, which then covers ui-v4 requests; navigations are network-first so it is mostly harmless).
* **Live check (curl, read only):** `https://silverhouse3.github.io/trailrunner/ui-v4/js/strava-api.js` still has the root `REDIRECT_URI`; `ui-v4/js/strava-config.js` is 404; root callback still `./index.html`. So today a real connection lands in the OLD app. `ui-v4/strava-callback.html` itself is live (200).
* **"Coming soon":** none. `Sync.legacyAutoUpload=false` is inert by design; the Settings "Auto-Upload" toggle is gone [strava-e2e].
* **Things that would stop a first real connection:** P0-2 (picker path without prior Connect), P0-3 (not deployed), social login blocked by the v4.1 allow-list, Strava consent page may try a `strava://` app deep link (blocked silently, fine), Back key ignored in the wrapper (cannot cancel the consent page except via the long-press corner), CORS is fine, scope fine, secret on device is stored in plain localStorage (acceptable but note it).

## 6. Prioritised fix list (small diffs; nothing applied)

### P0

**P0-1 HR dropout must clear HR and must never drive speed/incline.**
`js/treadmill.js` `_handleMessage` (~L452):
```diff
-      var hr = parseInt(v['Heart Rate']);
-      if (hr > 0) data.hr = hr;
+      var hr = parseInt(v['Heart Rate']);
+      data.hr = isNaN(hr) ? 0 : hr;          // 0 = no sensor, the engine must see it
```
`js/engine.js` `onTreadmillData` (the block at ~L463; same one-liner in the ftms block ~L493):
```diff
     if (data.hr != null && data.hr > 30 && data.hr < 220 && this.run.hrSource !== 'ble') {
       this.run.hr = data.hr;
       this.run.hrSource = 'treadmill';
+      this.run._hrAt = Date.now();
+    } else if (data.hr === 0 && this.run.hrSource === 'treadmill') {
+      this.run.hr = 0; this.run.hrSource = 'none';
     }
```
and at the top of `_applyAutoControl()` (~L814), a staleness guard that also drops out of HR modes:
```diff
+    if (this.run.hr > 0 && Date.now() - (this.run._hrAt || 0) > 8000) { this.run.hr = 0; this.run.hrSource = 'none'; }
+    if ((this.ctrl.mode === 'hr-speed' || this.ctrl.mode === 'hr-incline') && !(this.run.hr > 0)) {
+      this._noHrTicks = (this._noHrTicks || 0) + 1;
+      if (this._noHrTicks > 15 && typeof App !== 'undefined') { App.setControlMode('manual'); App._toast('No heart rate: switched to MANUAL', 'var(--orange)'); this._noHrTicks = 0; }
+      return;                                // hold current speed/incline
+    } else this._noHrTicks = 0;
```
Also set `run._hrAt` in `onBLEHR`. Re-run `node mock/audit-hr-stale.js` (expects PASS) and `mock/audit-features.js` B9 (expects hrVal `—`).

**P0-2 Strava connect must persist the effective app before leaving the page** (callback reads only `tr_strava_app`).
`js/strava-api.js` `authorizeUrl` (before building `state`):
```diff
       if (!app || !app.clientId) return null;
+      // the callback page reads localStorage 'tr_strava_app' directly: persist the effective app (default ID + secret typed in Settings)
+      var st = {}; try { st = JSON.parse(lsGet('tr_settings') || '{}') || {}; } catch (e) {}
+      var saved = jget('tr_strava_app', null) || {};
+      lsSet('tr_strava_app', JSON.stringify({ clientId: app.clientId, clientSecret: app.clientSecret || saved.clientSecret || st.stravaClientSecret || '' }));
```
`js/settings-panel.js` ~L962, so Save alone is enough:
```diff
     if (sId) s.stravaClientId = sId;
     if (sSec) s.stravaClientSecret = sSec;
+    if ((sId || sSec) && typeof Sync !== 'undefined' && typeof StravaApi !== 'undefined') { var oa = StravaApi.app() || {}; Sync.stravaApp = { clientId: sId || oa.clientId || '', clientSecret: sSec || oa.clientSecret || '' }; }
```
`js/strava-picker.js` `renderConnect`: if no secret (`!app.clientSecret && !A.prefs().tokenProxyUrl && !A.isMock()` after the persistence above) show "Enter your Strava Client Secret in Settings > Integrations" instead of the CONNECT button. Verify with `node mock/audit-strava-first-connect.js` (flow B must end on `index.html` with tokens).

**P0-3 Deploy the Strava callback fix (owner action).** Push HEAD `551e609` (ui-v4 `strava-callback.html` redirect target + `strava-config.js`). Also make the old root callback safe for any cached old build:
`strava-callback.html` (repo root) L127: `-      window.location.href = './index.html';` `+      window.location.href = './ui-v4/index.html';`. Confirm in the Strava API settings that the Authorization Callback Domain is exactly `silverhouse3.github.io` (not verifiable here).

### P1

1. **Never rely on native dialogs.** Add to `js/ui.js`:
```js
UI.ask = function (msg, okLabel) { return new Promise(function (res) { var d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center'; d.innerHTML = '<div style="background:#12151e;border:2px solid #fc4c02;border-radius:16px;padding:32px;max-width:900px;font-size:32px;color:#fff;text-align:center"><div style="margin-bottom:28px">' + String(msg).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }) + '</div><button id="uaN" style="font-size:32px;height:96px;padding:0 40px;margin:0 12px">CANCEL</button><button id="uaY" style="font-size:32px;height:96px;padding:0 40px;margin:0 12px;background:#e53935;color:#fff">' + (okLabel || 'OK') + '</button></div>'; document.body.appendChild(d); d.querySelector('#uaN').onclick = function () { d.remove(); res(false); }; d.querySelector('#uaY').onclick = function () { d.remove(); res(true); }; }); };
```
then `ui.js:448` onclick -> `UI.ask('Delete this route?','DELETE').then(function(y){if(y)App.deleteRoute(id)})`; same for `workout-builder.js:621`, `app.js:1565` (Strava disconnect), `stats.html:325`; replace `alert(...)` at app.js:1214/1570/1572, settings-panel.js:1016, sync.js:66, stats.html:1499 with `App._toast(msg, 'var(--orange)')` (stats.html needs its own tiny toast).
2. **Speed/incline rejection feedback.** `js/treadmill.js` `_httpDispatch`: replace each `.catch(function(){})` for `/speed` and `/incline` with
```js
.then(function (r) { return r.json(); }).then(function (d) { if (d && d.ok === false) { if (obj.values.KPH !== undefined || obj.values.MPH !== undefined) self._lastSpeed = -1; else self._lastIncline = -9999; if (self.onCommandRejected) self.onCommandRejected(d.error || 'rejected'); } }).catch(function () {})
```
and in `App.init`: `TM.onCommandRejected = (m) => this._toast('Treadmill ignored the change: ' + m, 'var(--orange)');` (clearing the dedup lets the next engine tick resend a capped target).
3. **GPX import without a file picker.** In the route modal add a "PASTE GPX" textarea + button calling `App._importGpxText(text)` (extract the body of `_handleGPXImport` `reader.onload` into that method). Keep the file input for wrappers that have a chooser.
4. **Downloads.** `js/app.js` `_downloadFile` and `stats.html` exportCSV: use the shim documented in `chooser3/README.md` (`AndroidBridge.saveFile(filename, mime, base64)`), keep the Blob path as fallback, and toast the returned path.
5. **Mic button honesty.** `js/app.js` init: `if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) { var m = document.getElementById('voiceMicBtn'); if (m) m.style.display = 'none'; }` (otherwise a silent no-op).
6. **TTS.** `js/voice.js` `VoiceCoach.init`: if `window.AndroidBridge && AndroidBridge.speak` use it; else after 3 s `if (!this._synth || !this._synth.getVoices().length) this._bridgeFallback = true`. Real bridge (and `bridge/grpc-bridge-v4`) needs a `/tts` route or the wrapper needs `TextToSpeech`; today the fallback URL 404s.
7. **HR strap UX.** `js/treadmill.js:668` toast and `App.connectHR`: say "Heart rate comes from the treadmill console sensor" and stop presenting the pill as a Bluetooth scanner when `!navigator.bluetooth`.
8. **Fan.** Either add `Fan Speed` handling in the bridge (not available via gRPC as far as main.go shows) or remove `TM.setFan(...)` at `js/engine.js:958` so it is not claimed.
9. **Video fallback.** `js/video.js:133` `showFallback`: do not navigate. Show the plain URL (`https://youtu.be/ID`) as text; Back is ignored in the wrapper so any navigation away from the app strands the user.
10. **Workout progress display.** `js/ui.js:_updateWorkoutHUD`: use `WorkoutSegments.getCurrentSegment()` (label, `remaining`, `remainingType`) and show `#workoutHud` for builder workouts:
```diff
-    if (!Engine.workout) { hud.style.display = 'none'; return; }
+    var seg = (typeof WorkoutSegments !== 'undefined' && WorkoutSegments.active) ? WorkoutSegments.getCurrentSegment() : null;
+    if (seg) { hud.style.display = 'block'; var $$ = function (i, v) { var e = document.getElementById(i); if (e) e.textContent = v; };
+      $$('whProgName', Engine.run && Engine.run.routeName || ''); $$('whStageName', seg.label); $$('whStageTimer', seg.remainingType === 'distance' ? Math.round(seg.remaining) + ' m' : Engine.fmtTime(Math.max(0, seg.remaining))); return; }
+    if (!Engine.workout) { hud.style.display = 'none'; return; }
```
(call `UI._updateWorkoutHUD()` from the existing 1 s UI tick; check it is not covered by the metric strip at 1920x1000.)
11. **Install `chooser3` v4.1** (not done; owner) and add Google/Facebook/Apple hosts to its allow-list or document "use e-mail login" for the Strava account.
12. **Wrapper `onReceivedError`** (v2 `MainActivity.showWebError`): for sub-navigations such as `intent://` return early instead of replacing the app with the error screen.

### P2

1. Dead settings (row 29): wire them or hide them; at minimum remove autopilot/warm-up/cool-down/ghost/exportFormat/defaultView/userName from the UI so they do not look functional. `exportFormat` could be honoured by `App.shareRunSummary`/the summary button label.
2. Bridge-down START: `App.startRun` should `_toast('No treadmill: this run will not move the belt')` or disable START when `!TM.connected` unless "simulate" is chosen.
3. `Store._set` (storage.js:14): `catch(e){ console.warn(...); if (window.App) App._toast('Storage full: run not saved', 'var(--red)'); }` and prune oldest runs on `QuotaExceededError`.
4. `window.open('stats.html','_self')` -> `location.href='stats.html'` (index.html:65,366).
5. Add the official Strava button asset at `ui-v4/img/btn_strava_connect_with_orange.svg` (referenced by strava-picker.js:121, 404 today) and the "Powered by Strava" mark per brand guidelines.
6. Remove or finish: `Cadence` (never started), `sync.js` legacy Strava code, `workout-builder.js:_tryNativeProgram` / `TM._bridgeUrl`, `ui-v4/remote.html`.
7. Offline: ship the app inside the APK (`file:` is disabled by the wrapper; use `WebViewAssetLoader` or serve `/ui-v4/` from the bridge) so the console works with no internet.
8. WS fallback in `TM._tryConnect` should honour `TR_BRIDGE_HOST`'s port.
9. Free-run ghost: runs shorter than the track-point interval save no `trackPoints`, so they cannot be raced (F2); show a hint in the ghost list.

## 7. Could not verify

Anything on the real console (WebView behaviour, TTS engine presence, SpeechRecognition absence is from Chromium WebView documentation/behaviour not from a test on this ROM, YouTube embed playback, radio streams, map tiles: internet was blocked in tests); real strava.com authorize/token/upload (only CORS preflights were fetched, no credentials used); whether the Strava API app has callback domain `silverhouse3.github.io`; v4.1 wrapper behaviour (read from source, never run); the real bridge was not run, only read (`main.go`); anything the other agent changed after ~15:40 local.

## 8. Results appendix (copied from the final runs)

Final runs (private mocks, 2026-10-22 ~16:00):

* `node mock/audit-features.js` (1920x1000): **44 PASS, 3 FAIL, 2 INFO**. FAIL = B9 (stale HR, real bug P0-1), E3 (no workout stage display, real gap P1-10), G5 (harness: it ran a Free Run, which deliberately has no split comparison; the route-run equivalent SP1 in `audit-ghost-splits.js` PASSES).
* `node mock/audit-features.js 80` (1920x1080, `?safeBottom=80`): identical, **44 PASS, 3 FAIL (same ones), 2 INFO**. No layout assertions were added here (that is `mock/screens-rd.js`' job); this pass only proves the flows still work at the real window geometry.
* `node mock/audit-ghost-splits.js` (and `80`): GH1 PASS, GH2 PASS, SP1 PASS, BD1/BD2 INFO (pill TREADMILL, banner NO TREADMILL, START still starts a simulated run).
* `node mock/audit-hr-stale.js`: **FAIL (bug reproduced)** `target 12.0 -> 20 kph in 15 s after Heart Rate 0`.
* `node mock/audit-webview-sim.js`: W2 FAIL (mic silent), W7 PASS-as-evidence (delete does nothing when confirm() is false), W5/W6/W4/W8 INFO as in section 1.
* `node mock/audit-strava-first-connect.js`: flow A OK (ends on index.html, tokens stored); **flow B FAIL** ("Strava credentials not found. Open TrailRunner Settings first.").
* `node mock/audit-strava-e2e.js`: 58/58 PASS. `node mock/audit-strava-test.js`: 86/86 PASS.
* Raw output copies are in the session scratchpad (`/tmp/claude-1000/aud/run*.txt`, `f*.json`, `shots/audit-*.png`); they are not in the repo because only the report and `mock/audit-*.js` may be added.

