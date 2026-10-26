# TRChooser.apk v4.1 (versionCode 3) - chooser + full-featured WebView

Package `com.silverhouse3.trailrunnerbridge` (unchanged). Copy of `chooser/` (versionCode 2) with a much better WebView.
Same debug keystore: cert SHA-256 `0eaac1ce...f68c` (checked identical to chooser/TRChooser.apk). Built only; nothing installed or run on a device.
Boot chooser, iFIT / TRAILRUNNER logic, bridge start/stop, Back-ignored and the 120 px long-press hot zone are untouched. No motor code, no secrets, no proxy.

## Install (owner) - over the existing app
    adb connect 192.168.100.54:5555
    adb install -r D:\trailrunner\chooser3\TRChooser.apk
    # optional, if the ROM has no permission dialog (target SDK 25 = runtime permissions):
    adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.RECORD_AUDIO
    adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.WRITE_EXTERNAL_STORAGE
    adb shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity
Settings / accessibility entry are kept by `install -r`. New manifest permissions: RECORD_AUDIO, MODIFY_AUDIO_SETTINGS.
NOTE: with targetSdk 25 the dangerous permissions are runtime permissions on Android 7.1 (not install-time). The app asks for WRITE_EXTERNAL_STORAGE once (first TRAILRUNNER launch) and RECORD_AUDIO when the web app first asks for the mic. If the ROM cannot show the dialog, the fallbacks are: exports go to the app's own folder `/sdcard/Android/data/com.silverhouse3.trailrunnerbridge/files/Download/TrailRunner/`, mic is denied (toast says so) - use the `pm grant` lines above.

## Rollback
    adb install -r -d D:\trailrunner\chooser\TRChooser.apk
(`-d` allows the version downgrade 3 -> 2; same key so no uninstall needed.)

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
