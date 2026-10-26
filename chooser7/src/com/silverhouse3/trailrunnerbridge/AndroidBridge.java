package com.silverhouse3.trailrunnerbridge;

import android.app.DownloadManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.util.Locale;

/**
 * JS interface "AndroidBridge" + download helpers.
 *
 * LIMITS: addJavascriptInterface exposes this object to EVERY frame of the WebView (including
 * cross-origin iframes such as the YouTube embed). Each @JavascriptInterface method therefore
 * checks the URL of the top-level page (page.get()) and refuses unless it is the TrailRunner app
 * (WebPolicy.isAppPage). That URL is cleared at navigation start and set again once the page is
 * committed (fail-closed). A hostile cross-origin iframe INSIDE an app page could still call it;
 * the damage is bounded by: extension whitelist, 25 MB cap, writes only below Download/TrailRunner.
 * Nothing here reads files, runs commands, touches the bridge or the motor.
 */
public class AndroidBridge {
    private static final String TAG = "TRBridge";
    static final int VERSION = 5;
    private static final int MAX_BYTES = 25 * 1024 * 1024;
    private static final String SUBDIR = "TrailRunner";

    /** Supplies the committed top-level URL ("" while navigating). */
    interface PageUrl { String get(); }

    /** Implemented by MainActivity; every method is safe to call from any thread. */
    interface VideoHost {
        void requestVideoSplit(int mode, String startUrl);   // 0 off, 1 half, 2 full
        boolean videoNavigate(String url);
        String videoMode();
        void setStripHeight(int px);
    }

    private final Context ctx;
    private final PageUrl page;
    private final VideoHost video;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    AndroidBridge(Context ctx, PageUrl page, VideoHost video) {
        this.ctx = ctx.getApplicationContext();
        this.page = page;
        this.video = video;
    }

    private boolean allowed() { return WebPolicy.isAppPage(page.get()); }

    static void toast(final Context c, final String m) {
        MAIN.post(() -> Toast.makeText(c, m, Toast.LENGTH_LONG).show());
    }

    @JavascriptInterface
    public int version() { return allowed() ? VERSION : 0; }

    // ── Bluetooth AUDIO (headphones) via the Android BluetoothAdapter only. Same top-level-URL guard. ──
    // Never touches the iFit/glassos Bluetooth service or the heart-rate strap; non-audio devices are refused in BtAudioCore.

    private static final String BT_OFF = "{\"enabled\":false,\"discovering\":false,\"bonded\":[],\"found\":[],\"connected\":null,\"lastError\":\"Not allowed\"}";

    @JavascriptInterface
    public String btAudioState() {
        if (!allowed()) return BT_OFF;
        try { return BluetoothAudio.get(ctx).state(); } catch (Exception e) { return errJson(e); }
    }

    @JavascriptInterface
    public String btAudioScan(boolean on) {
        if (!allowed()) return BT_OFF;
        try { return BluetoothAudio.get(ctx).scan(on); } catch (Exception e) { return errJson(e); }
    }

    @JavascriptInterface
    public String btAudioPair(String address) {
        if (!allowed()) return BT_OFF;
        try { return BluetoothAudio.get(ctx).pair(address); } catch (Exception e) { return errJson(e); }
    }

    @JavascriptInterface
    public String btAudioConnect(String address) {
        if (!allowed()) return BT_OFF;
        try { return BluetoothAudio.get(ctx).connect(address); } catch (Exception e) { return errJson(e); }
    }

    @JavascriptInterface
    public String btAudioDisconnect(String address) {
        if (!allowed()) return BT_OFF;
        try { return BluetoothAudio.get(ctx).disconnect(address); } catch (Exception e) { return errJson(e); }
    }

    @JavascriptInterface
    public String btAudioForget(String address) {
        if (!allowed()) return BT_OFF;
        try { return BluetoothAudio.get(ctx).forget(address); } catch (Exception e) { return errJson(e); }
    }

    private static String errJson(Exception e) {
        return "{\"enabled\":false,\"discovering\":false,\"bonded\":[],\"found\":[],\"connected\":null,\"lastError\":"
            + BtAudioCore.jsonStr("Bluetooth error: " + e.getMessage()) + "}";
    }

    // ── split / full-screen video (same top-level-URL guard as saveFile) ────

    /** Feature detect: true in this build (and only on an allowed page). */
    @JavascriptInterface
    public boolean videoSplitSupported() { return allowed(); }

    /** 'off' | 'half' | 'full' (current layout). */
    @JavascriptInterface
    public String isVideoSplit() { return allowed() ? video.videoMode() : "off"; }

    /**
     * mode: 'half' (50/50), 'full' (thin TrailRunner strip on top + YouTube below), 'off'.
     * Compatibility: true/'true' = half, false/'false'/'' = off (a JS boolean arrives here as the string "true"/"false").
     * startUrlOrEmpty = optional YouTube url (other hosts ignored). Applied asynchronously on the UI thread; the page
     * is told via window.TR_onVideoSplit('half'|'full'|'off') once the layout is applied. Returns false if refused.
     */
    @JavascriptInterface
    public boolean videoSplit(String mode, String startUrlOrEmpty) {
        if (!allowed()) { Log.w(TAG, "videoSplit rejected: page not allowed"); return false; }
        String m = mode == null ? "" : mode.trim().toLowerCase(Locale.ROOT);
        int n;
        switch (m) {
            case "half": case "true": case "1": n = 1; break;
            case "full": case "2": n = 2; break;
            case "off": case "false": case "0": case "": case "null": case "undefined": n = 0; break;
            default: Log.w(TAG, "videoSplit: unknown mode " + m); return false;
        }
        video.requestVideoSplit(n, startUrlOrEmpty);
        return true;
    }

    /** Load a YouTube url in the video pane (only while half/full). Other hosts are ignored (false). */
    @JavascriptInterface
    public boolean videoNavigate(String url) {
        if (!allowed()) { Log.w(TAG, "videoNavigate rejected: page not allowed"); return false; }
        return video.videoNavigate(url);
    }

    /** Height of the TrailRunner strip in FULL mode, clamped 40..120 px (default 56). */
    @JavascriptInterface
    public boolean setStatsStripHeight(int px) {
        if (!allowed()) return false;
        video.setStripHeight(px);
        return true;
    }

    /**
     * Save a file under /sdcard/Download/TrailRunner/ (or the app's own external dir if storage
     * permission is missing). Returns the saved path, or a string starting with "ERROR:".
     */
    @JavascriptInterface
    public String saveFile(String filename, String mimeType, String base64) {
        if (!allowed()) { Log.w(TAG, "saveFile rejected: page not allowed"); return "ERROR: not allowed"; }
        if (base64 == null) return "ERROR: no data";
        if (base64.length() > MAX_BYTES / 3 * 4 + 16) return "ERROR: file too large";
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            return saveBytes(ctx, filename, mimeType, data);
        } catch (Exception e) {
            Log.w(TAG, "saveFile failed", e);
            toast(ctx, "Save failed: " + e.getMessage());
            return "ERROR: " + e.getMessage();
        }
    }

    // ── shared helpers (also used by the DownloadListener) ───────────────────

    static boolean hasWritePerm(Context c) {
        return c.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED;
    }

    private static String ext(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    private static boolean extOk(String e) {
        switch (e) {
            case "gpx": case "tcx": case "csv": case "json": case "txt": case "xml": case "kml": case "fit":
                return true;
            default: return false;
        }
    }

    private static String extForMime(String mime) {
        if (mime == null) return "";
        String m = mime.toLowerCase(Locale.ROOT);
        if (m.contains("gpx")) return "gpx";
        if (m.contains("tcx")) return "tcx";
        if (m.contains("csv")) return "csv";
        if (m.contains("json")) return "json";
        if (m.contains("kml")) return "kml";
        if (m.contains("xml")) return "xml";
        if (m.startsWith("text/")) return "txt";
        return "";
    }

    /** Keep only [A-Za-z0-9._ -], no path parts; add an extension from the MIME type if missing. */
    static String cleanName(String name, String mime) {
        String n = name == null ? "" : name;
        int s = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (s >= 0) n = n.substring(s + 1);
        n = n.replaceAll("[^A-Za-z0-9._ -]", "_").replaceAll("^\\.+", "");
        if (n.isEmpty()) n = "trailrunner-" + System.currentTimeMillis();
        if (n.length() > 100) n = n.substring(n.length() - 100);
        if (ext(n).isEmpty()) {
            String e = extForMime(mime);
            if (!e.isEmpty()) n = n + "." + e;
        }
        return n;
    }

    static File targetDir(Context c) {
        if (hasWritePerm(c)) {
            File d = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), SUBDIR);
            if (d.isDirectory() || d.mkdirs()) return d;
        }
        File d = new File(c.getExternalFilesDir(null), "Download/" + SUBDIR);
        if (d.isDirectory() || d.mkdirs()) return d;
        return null;
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ex = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, base + "-" + i + ex);
            if (!f.exists()) return f;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ex);
    }

    static String saveBytes(Context c, String filename, String mime, byte[] data) throws Exception {
        if (data == null || data.length == 0) throw new Exception("empty file");
        if (data.length > MAX_BYTES) throw new Exception("file too large");
        String name = cleanName(filename, mime);
        if (!extOk(ext(name))) throw new Exception("file type not allowed (" + ext(name) + ")");
        File dir = targetDir(c);
        if (dir == null) throw new Exception("no writable storage");
        File f = unique(dir, name);
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(data); }
        try { MediaScannerConnection.scanFile(c, new String[]{f.getAbsolutePath()}, null, null); }
        catch (Exception ignore) { /* best effort */ }
        toast(c, "Saved: " + f.getAbsolutePath());
        Log.i(TAG, "saved " + f.getAbsolutePath() + " (" + data.length + " bytes)");
        return f.getAbsolutePath();
    }

    /** data: URL -> file. Returns false if the URL cannot be decoded. */
    static boolean saveDataUrl(Context c, String url, String suggestedName) {
        try {
            int comma = url.indexOf(',');
            if (!url.regionMatches(true, 0, "data:", 0, 5) || comma < 0) return false;
            String meta = url.substring(5, comma);
            String mime = meta.split(";")[0];
            byte[] data = meta.toLowerCase(Locale.ROOT).contains(";base64")
                ? Base64.decode(url.substring(comma + 1), Base64.DEFAULT)
                : Uri.decode(url.substring(comma + 1)).getBytes("UTF-8");
            saveBytes(c, suggestedName, mime, data);
            return true;
        } catch (Exception e) {
            toast(c, "Save failed: " + e.getMessage());
            return false;
        }
    }

    /** http(s) download through DownloadManager. */
    static void enqueueHttp(Context c, String url, String ua, String cd, String mime) {
        try {
            String name = cleanName(URLUtil.guessFileName(url, cd, mime), mime);
            DownloadManager dm = (DownloadManager) c.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) { toast(c, "Download not available on this device"); return; }
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            if (mime != null && !mime.isEmpty()) r.setMimeType(mime);
            String ck = CookieManager.getInstance().getCookie(url);
            if (ck != null) r.addRequestHeader("Cookie", ck);
            if (ua != null) r.addRequestHeader("User-Agent", ua);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String where;
            if (hasWritePerm(c)) {
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, SUBDIR + "/" + name);
                where = "/sdcard/Download/" + SUBDIR + "/" + name;
            } else {
                r.setDestinationInExternalFilesDir(c, Environment.DIRECTORY_DOWNLOADS, name);
                where = "app storage (Download/" + name + ")";
            }
            dm.enqueue(r);
            toast(c, "Downloading to " + where);
        } catch (Exception e) {
            Log.w(TAG, "download failed", e);
            toast(c, "Download failed: " + e.getMessage());
        }
    }
}
