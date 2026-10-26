# TRChooser.apk v4.2 (versionCode 4) - chooser4 = chooser3 + video panes + escape bar

Package `com.silverhouse3.trailrunnerbridge` (unchanged), same debug keystore (cert SHA-256 `0eaac1ce...f68c`, verified equal to chooser3/TRChooser.apk), so `adb install -r` upgrades in place. versionCode 4 / versionName 4.2-chooser. UA suffix is now ` TRChooser/4`, `AndroidBridge.version()` returns 4. **Built only. Nothing was installed, no adb, no device touched, nothing committed.** No motor/bridge code touched; no secrets.

Install (owner): `adb install -r D:\trailrunner\chooser4\TRChooser.apk`. Rollback: `adb install -r -d D:\trailrunner\chooser3\TRChooser.apk`.
Build: `chooser4/build.sh` (same approach as chooser3). Unit test: see "Unit test" at the end.

## 1. Video panes (half / full / off)

### JS contract (TrailRunner page -> native). All methods only work while the committed top-level page is the TrailRunner app (same guard as saveFile).
    // feature detect
    window.AndroidBridge && AndroidBridge.videoSplitSupported && AndroidBridge.videoSplitSupported()   // true in this build
    AndroidBridge.videoSplit('half'|'full'|'off', startUrlOrEmpty)  // boolean: accepted
    AndroidBridge.isVideoSplit()                                      // 'off' | 'half' | 'full'
    AndroidBridge.videoNavigate(url)                                  // boolean; only while half/full
    AndroidBridge.setStatsStripHeight(px)                             // clamp 40..120, default 56 (STRIP_PX_DEFAULT); applies live in full mode
Compatibility: `videoSplit(true, u)` = half, `videoSplit(false, '')` = off. NOTE: Android hands a JS boolean to a String parameter as the string "true"/"false"; native parses those, but passing the strings 'half'/'full'/'off' is the safe form. (Not device-tested.)
`startUrlOrEmpty` / `videoNavigate` accept only https on www.youtube.com, m.youtube.com, youtube.com, youtube-nocookie.com / www.youtube-nocookie.com; youtu.be/ID, intent://www.youtube.com/watch?v=ID#Intent... and vnd.youtube:ID are expanded to https://m.youtube.com/watch?v=ID; anything else is ignored. Empty start url = last saved YouTube url (SharedPreferences `tr`/`yt_last`) or https://m.youtube.com/.

### Native -> page
After each layout change (and only after it was applied: a layout pass, then +150 ms for the renderer) the TrailRunner WebView gets
`evaluateJavascript("window.TR_onVideoSplit && window.TR_onVideoSplit('half'|'full'|'off')")`. The normal `resize` event also fires (same WebView instance, never reloaded: page state, JS timers, WebSocket survive). Not called if the mode did not change.

### Layouts (window 1920x1080)
| mode | TrailRunner WebView | YouTube WebView pane |
|---|---|---|
| off | full window | hidden |
| half | right 960 x 1080 (innerWidth ~960) | left 960 x 1080 |
| full | thin strip across the top, 1920 x STRIP_PX (56), innerHeight ~56 | full width x (1080 - strip), below the strip |
Switching off/half/full is a resize only: neither WebView is reloaded, playback continues across half<->full. Nothing is sent to the bridge.

### YouTube pane (left in half, below the strip in full)
* JS, DOM storage, cookies (+3rd-party, persisted), mixed content NEVER, default WebView UA (not touched), media gesture requirement off, no `AndroidBridge` object in this WebView (no saveFile etc.), no JS dialogs/permissions/file chooser/downloads (defaults deny).
* Inside the pane the page is inset 80 px at the top (so our bar does not cover YouTube's search/avatar icons) and 80 px at the bottom (ROM nav bar). Constants `YT_TOP_RESERVE_PX` / `YT_BOTTOM_RESERVE_PX` in MainActivity (set top to 0 for a pure overlay). This deviates slightly from "overlay, not shifting" on purpose: a bar over the top-right of m.youtube.com would hide the search icon.
* Native bar top-right of the YouTube pane (below the strip in full): `[HOME] [BACK] [FULL or HALF] [CLOSE VIDEO]`, 72 px high translucent. HOME = https://m.youtube.com/, BACK = WebView history back (ignored if nothing earlier; the about:blank used at close is never gone back to), FULL (shown in half) / HALF (shown in full) switch layout, CLOSE VIDEO = `videoSplit('off')`. It starts well right of the 110x110 top-left ROM zone and nothing of ours is in the bottom 80 px.
* **Fullscreen choice: pane-only.** HTML5 fullscreen (onShowCustomView) is added inside the YouTube pane, never the window, so it can never cover the TrailRunner strip/pane, the hot zone or the ROM zones. A red `EXIT` button appears in the bar while fullscreen (Back is ignored app-wide), CLOSE VIDEO also exits it. Downside: video is 16:9 letterboxed inside 960 px (half) or 1920x~944 (full).
* **Z-order / strip touch (full mode):** the TrailRunner pane is brought to front after every layout change and the YouTube pane starts BELOW the strip (top margin = strip height), so nothing native ever overlays the strip, including its top-right corner (the web STOP button). The only native overlay in the strip area is the existing invisible 120x120 long-press hot zone at the top-left (unchanged from chooser3, ROM-arrow zone). The strip WebView is independent of the YouTube WebView, so YouTube loading, erroring (toast only) or fullscreen does not affect it.
* Navigation policy (main-frame only; sub-resources and iframes are not restricted, same as the existing TrailRunner view): https only, hosts youtube.com, m.youtube.com, www.youtube.com, youtu.be, youtube-nocookie.com, www.youtube-nocookie.com, ytimg.com, googlevideo.com, ggpht.com, gstatic.com, **consent.youtube.com, consent.google.com**. Exact host match, no user-info, port 443 only. `accounts.google.com` = blocked with toast "Google sign-in is disabled here". Everything else, http, data/javascript/file, market:, and unconvertible intent:/vnd.youtube: = swallowed with a "Blocked" toast, never passed to Android. youtu.be/ID and convertible intent:/vnd.youtube: are loaded as https://m.youtube.com/watch?v=ID.
* Consent evaluation: in the EU/UK YouTube redirects the first visit to consent.youtube.com and the site is unusable without answering. Both consent hosts are Google-owned, take no credentials (a "sign in" link there hits the accounts.google.com block), so allowing them top-level is low risk. If the owner is in a region without consent it is never visited. Not device-tested; if consent loops, the log tag `TRBridge` shows `yt blocked navigation:`.
* **Close behaviour (chosen):** the YouTube WebView instance is RETAINED (cheap re-open, cookies/engine warm) but on close: url saved, `<video>/<audio>.pause()` via JS, fullscreen exited, WebView navigated to `about:blank` (so no media element can survive), pane hidden, `WebView.onPause()` 600 ms later. Reopen reloads the saved url (playback position is not kept). `pauseTimers()` is deliberately NOT used: it is process-wide and would stall the TrailRunner WebView. Activity `onPause` (home key, iFIT) pauses media + `onPause()` while a pane is open, `onResume` resumes the WebView (user taps play). Returning to the chooser or leaving TRAILRUNNER destroys the YouTube WebView (`destroy()`), which ends audio.

## 2. Escape bar (TrailRunner WebView, normal and half layouts)
* Shown (top-centre of the TrailRunner pane, 80 px box / 72 px buttons, ~540 px wide, clear of the top-left zone) whenever the current top-level URL is not `https://silverhouse3.github.io/trailrunner/...` (or localhost / test-override host), and whenever a main-frame HTTP error >= 400 (`onReceivedHttpError`) or a load error on a non-app page occurs. Hidden again on any app page / new navigation. Blank/about:blank does not trigger it.
* `<| BACK TO TRAILRUNNER` loads the original TrailRunner url (ui-v4) and clears history once it has loaded; `RETRY` reloads the current page. A load error on an APP page keeps the old full-screen error screen (RETRY / BACK TO CHOOSER).
* Strava OAuth: strava.com authorize (bar visible) -> redirect to silverhouse3.github.io/trailrunner/strava-callback.html (bar hidden as the callback page starts). Allow-list unchanged.
* **Full mode:** the escape bar is not shown in the strip (does not fit). If the strip page navigates away from the app or errors, native automatically falls back to `off` (TR_onVideoSplit('off') is sent) and then the escape bar shows normally.

## Code-reading checklist (requirement -> code, MainActivity unless noted)
| Requirement | Where |
|---|---|
| videoSplit/isVideoSplit/videoSplitSupported/videoNavigate/setStatsStripHeight guarded by top-level URL | AndroidBridge `allowed()` in each method |
| Same TR WebView resized, not reloaded | `applyMode`: only `trPane.setLayoutParams`; `web` is never recreated/loaded |
| Page told after layout | `notifySplit`: OnGlobalLayoutListener (+500 ms fallback) then +150 ms, `TR_onVideoSplit('mode')` |
| Strip: full width x STRIP_PX, YT full width below | `applyMode` m==2, `STRIP_PX_DEFAULT`, `stripPx`, `setStripHeight` clamp 40..120 |
| Strip always on top / untouched corner | `trPane.bringToFront()` in `applyMode` and `onYtFullscreen`; YT pane topMargin = strip; YT bar lives inside the YT pane |
| half<->full no reload, video keeps playing | `applyMode` loads a url only when entering from off or an explicit valid start url |
| Close/pause/no background audio | `closeYtPane`, `onPause`, `destroyYt`, `PAUSE_JS` |
| YT settings | `ensureYt` (no JS interface, NEVER_ALLOW mixed, UA untouched, cookies) |
| YT nav policy / intent conversion | `ytRoute` -> YtPolicy.classifyNav (pure class, unit tested) |
| YT fullscreen confined to pane + EXIT | YtChrome, `onYtFullscreen`, `ytExitFs` |
| Bar controls and ROM zones | `ensureYt` bar (top-right, below strip), YT webview bottom margin 80, hot zone 120x120 untouched |
| Persist last url | `doUpdateVisitedHistory` in ytclient + `closeYtPane`, `PREF_YT_LAST` |
| Escape bar logic | `buildEscapeBar`, `updateEscape`, `escapeBack`, `escapeRetry`, `onReceivedHttpError`, `onReceivedError` |
| Bridge/motor untouched | no changes to BridgeHttpService / accessibility; no AndroidBridge in YT WebView |

## Owner test steps (on the treadmill, after install -r)
1. Install, start, choose TRAILRUNNER; check the app still works as before (dialogs, mic, import/export, Strava).
2. From the web page (once it calls `AndroidBridge.videoSplit`; until then via a debug button/console): `half` -> left shows m.youtube.com, TrailRunner on the right keeps its state/timers; search (search icon visible under the bar), open a video, play, try the fullscreen button (stays in the left pane, EXIT works). `window.innerWidth` ~960.
3. HALF/FULL button: video must keep playing; in full the TrailRunner strip is ~56 px high at the top, innerHeight ~56, STOP button in its top-right is tappable even while YouTube loads / is fullscreen; YouTube bar sits below the strip.
4. CLOSE VIDEO: audio stops at once, TrailRunner full again. Reopen: comes back at the last YouTube url. Press the ROM home key while playing: audio stops. Long-press the top-left 2 s to chooser: audio stops.
5. Sign-in link on YouTube -> toast "Google sign-in is disabled here". Check the EU consent page (if any) can be answered.
6. Escape bar: in the app open `https://www.strava.com/oauth/authorize?client_id=1` (or via a link) -> bar appears; BACK TO TRAILRUNNER returns, RETRY reloads. A normal Strava connect still returns to the callback page and the bar vanishes. In full mode navigate the strip away -> falls back to off and the bar shows.
7. `adb logcat -s TRBridge TRWeb` for `yt blocked navigation`, `yt convert`.

## NOT tested (needs the device)
Everything at runtime: WebView 83 behaviour of the layout resize and the exact moment `innerWidth` updates (150 ms settle is a guess; the page should also listen to `resize`), whether a JS boolean reaches the String parameter as "true", HTML5 fullscreen inside a pane on this ROM, audio actually stopping on close, YouTube consent flow, whether the glyph in `<| BACK` renders (U+25C0), ROM overlays vs our bar positions, strip hot-zone overlap, touch behaviour in the strip corner. Done here: compile (javac -Xlint:all clean), d8, apksigner verify (v2/v3, cert equal to chooser3), `aapt dump badging` (versionCode 4), JVM unit test of YtPolicy (65 checks), code reading.

## Unit test
    JDK=/mnt/d/trailrunner/twa-build/jdk-17.0.18+8/bin
    $JDK/javac -d /tmp/yt src/com/silverhouse3/trailrunnerbridge/YtPolicy.java test/YtPolicyTest.java && $JDK/java -cp /tmp/yt com.silverhouse3.trailrunnerbridge.YtPolicyTest

---
# Inherited from chooser3 (v4.1), unchanged except paths
Same debug keystore: cert SHA-256 `0eaac1ce...f68c` (checked identical to chooser/TRChooser.apk). Built only; nothing installed or run on a device.
Boot chooser, iFIT / TRAILRUNNER logic, bridge start/stop, Back-ignored and the 120 px long-press hot zone are untouched. No motor code, no secrets, no proxy.

## Install (owner) - over the existing app
    adb connect 192.168.100.54:5555
    adb install -r D:\trailrunner\chooser4\TRChooser.apk
    # optional, if the ROM has no permission dialog (target SDK 25 = runtime permissions):
    adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.RECORD_AUDIO
    adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.WRITE_EXTERNAL_STORAGE
    adb shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity
Settings / accessibility entry are kept by `install -r`. New manifest permissions: RECORD_AUDIO, MODIFY_AUDIO_SETTINGS.
NOTE: with targetSdk 25 the dangerous permissions are runtime permissions on Android 7.1 (not install-time). The app asks for WRITE_EXTERNAL_STORAGE once (first TRAILRUNNER launch) and RECORD_AUDIO when the web app first asks for the mic. If the ROM cannot show the dialog, the fallbacks are: exports go to the app's own folder `/sdcard/Android/data/com.silverhouse3.trailrunnerbridge/files/Download/TrailRunner/`, mic is denied (toast says so) - use the `pm grant` lines above.

## Rollback
    adb install -r -d D:\trailrunner\chooser3\TRChooser.apk
(`-d` allows the version downgrade 4 -> 3; same key so no uninstall needed.)

## What changed (MainActivity + 3 new classes: TRChrome, AndroidBridge, WebPolicy)
| Web feature | Hook |
|---|---|
| confirm() deletes / disconnect, alert(), prompt() (copy summary, name favourite) | `TRChrome.onJsAlert/onJsConfirm/onJsPrompt/onJsBeforeUnload` - dark custom Dialog, buttons 72 dp high, 24 sp text, Back ignored, results released on teardown |
| Mic (cadence.js getUserMedia audio) | `onPermissionRequest`: only RESOURCE_AUDIO_CAPTURE and only origin https://silverhouse3.github.io; asks Android RECORD_AUDIO if not held; everything else denied |
| GPX / JSON import (`<input type=file>`) | `onShowFileChooser`: ACTION_GET_CONTENT `*/*` + OPENABLE; no handler = null result + toast "No file picker on this treadmill" |
| YouTube fullscreen | `onShowCustomView/onHideCustomView` (view added over the WebView, hot zone kept on top) |
| Geolocation | `onGeolocationPermissionsShowPrompt` denies quietly; `setGeolocationEnabled(false)` |
| GPX/TCX share export (`_downloadFile` blob + anchor) | injected hook (blob map + `a.click()`/click-capture/`window.open(blob:)`) -> `AndroidBridge.saveFile`; or the web shim below |
| data: / blob: downloads reaching the DownloadListener | `setDownloadListener` -> data: decoded in Java, blob: via fetch + saveFile, http(s) via DownloadManager |
| Files | `/sdcard/Download/TrailRunner/<name>` (fallback: app external dir). Whitelist ext gpx tcx csv json txt xml kml fit, max 25 MB, sanitised name, never overwrites (adds -1, -2). Toast shows the path |
| Strava OAuth (top-level to strava.com and back to silverhouse3.github.io/trailrunner/strava-callback.html) | `shouldOverrideUrlLoading` allow-list, cookies + third-party cookies on, UA suffix, localStorage kept |
| `intent://www.youtube.com/watch?v=ID#Intent;...` (video.js fallback link) | converted to https://www.youtube.com/watch?v=ID and loaded in the WebView if allowed, else toast "Video unavailable here" |
| window.open / target=_blank | `setSupportMultipleWindows(false)`: loads in same WebView, goes through the same allow-list; blocked => toast "Blocked" |
| Stale web release | `WebView.clearCache(true)` on each showWeb (every TRAILRUNNER launch / RETRY); no data cleared |
| Detect the shell | UA gets ` TRChooser/3` appended; `window.AndroidBridge` exists |

Allowed top-level hosts (https): silverhouse3.github.io, strava.com, www.strava.com, youtube.com, www.youtube.com, m.youtube.com, youtube-nocookie.com, www.youtube-nocookie.com, tile.openstreetmap.org. http(s) also allowed for localhost, 127.0.0.1 and the host passed with `--es url` (test override). Everything else, and any non-http scheme (blob:, data:, file:, mailto:, javascript:...), is blocked with a "Blocked" toast. Sub-resources/iframes (map tiles, YouTube embed, bridge on 127.0.0.1) are NOT restricted by this list.

Settings: JS, DOM storage, database, mixed content ALWAYS_ALLOW, file/content/universal access off, media gesture requirement OFF (unchanged from v2; the web app's own rule "no autoplay on load" is what prevents autoplay; changing it to true would risk the app's beeps/TTS), safe browsing left at the API-25 default (off).

### Bridge security limits
`addJavascriptInterface` is visible to all frames. Every method checks the committed top-level page URL (cleared at navigation start, set on commit) and refuses unless it is https://silverhouse3.github.io/trailrunner/... or localhost/127.0.0.1/the test host. Residual risk: an iframe inside an app page (e.g. YouTube embed) could call it while the app page is current; impact is limited to writing a whitelisted, size-capped file under Download/TrailRunner. A new page loading while the old one still runs fails closed (URL empty).

### Immersive flags vs the ROM bar (observed in old code, unchanged)
`immersive()` sets LAYOUT_STABLE | LAYOUT_HIDE_NAVIGATION | LAYOUT_FULLSCREEN | HIDE_NAVIGATION | FULLSCREEN | IMMERSIVE_STICKY and re-asserts on resume/focus. They only control the standard Android bars; the ROM's 80 px bar and top-left back arrow are drawn by the ROM over the window, so the flags neither remove nor push the layout (WebView is MATCH_PARENT full window, the web app handles safe zones). I left this as is. New dialogs copy the activity's flags and are shown non-focusable first so they should not flash the system bars; verify on the device.

## JS shim for the web app (NOT applied - ui-v4 untouched)
Today `App._downloadFile` (ui-v4/js/app.js ~line 2025) makes a Blob, an `<a download>` and revokes the URL immediately. The v4.1 injected hook already catches that without any web change, but an explicit call is the most reliable. Replace the body with:

    _downloadFile(content, filename, mimeType) {
      if (window.AndroidBridge && typeof AndroidBridge.saveFile === 'function') {
        try {
          var b64 = btoa(unescape(encodeURIComponent(String(content))));   // content is text (GPX/TCX/CSV/JSON)
          var r = AndroidBridge.saveFile(filename, mimeType, b64);          // native toast shows the path
          if (typeof r === 'string' && r.indexOf('ERROR:') !== 0) return;
        } catch (e) { /* fall through to the browser path */ }
      }
      const blob = new Blob([content], { type: mimeType });
      ... (existing code unchanged)
    }

Other places: sync.js:214 and strava-api.js:398 only upload a Blob to Strava with fetch/FormData (no download, works as is). The Web Share / clipboard path (app.js ~1120) falls back to `prompt()`, now a real dialog. Detect the shell with `/TRChooser\/(\d+)/.exec(navigator.userAgent)`.

## Test each feature on the treadmill
Start the app, choose TRAILRUNNER, then:
1. Delete a route (trash icon) -> dark dialog, big OK/CANCEL; Cancel keeps the route. Settings > Disconnect Strava -> confirm dialog. Run summary copy -> prompt dialog with text field.
2. Microphone: enable cadence detection; first time Android asks for the mic, then it works. Deny -> web app falls back.
3. Import GPX: Home > import. Either a picker opens or the toast "No file picker..." appears (expected on a ROM without Documents UI).
4. Export GPX / TCX after a run: toast `Saved: /storage/emulated/0/Download/TrailRunner/trailrunner-....gpx`. Check with `adb shell ls /sdcard/Download/TrailRunner/` (or the app folder, see above).
5. Strava connect: opens strava.com login/authorize inside the app, returns to the TrailRunner callback page. If you use "Sign in with Google/Apple/Facebook" those hosts are blocked by design (log in with e-mail/password).
6. Video: play a YouTube embed, press the fullscreen button; exit via the player's own control (Back is ignored). On an embed error the "open in YouTube" button gives intent:// -> converted to a watch page in the WebView. LIMITATION: that page has no way back except the 2 s long-press hot zone (to chooser), because Back is ignored.
7. Release: publish a web change, relaunch TRAILRUNNER; it appears without waiting 10 min. Settings/runs/routes still there.
8. `adb logcat -s TRBridge TRWeb` shows blocked URLs, saves and page console output.

## NOT testable without the device (and not tested)
Everything runtime: dialog look/size on the real density, whether system bars flash with dialogs, the permission dialogs (and ROM lacking them), file picker availability, blob hook inside WebView 83, DownloadManager on this ROM, YouTube embed fullscreen + audio, Strava login incl. third-party cookies, and Google/consent redirects (consent.youtube.com is not allowed). Webkit SpeechRecognition (voice.js, voice-commands.js) is not provided by Android WebView at all; this APK cannot fix that (speechSynthesis TTS availability depends on the ROM's TTS engine). Only compile, apksigner verify, aapt badging and a JS syntax check of the injected hook were done.
