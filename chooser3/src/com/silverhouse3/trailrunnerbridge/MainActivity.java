package com.silverhouse3.trailrunnerbridge;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.widget.Toast;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Boot chooser: iFIT (stock) or TRAILRUNNER (in-app WebView). No Chrome needed.
 * Safety: this class never sends motor commands; it only starts/stops the bridge process
 * (via BridgeHttpService) and hosts a WebView.
 */
public class MainActivity extends Activity {
    private static final String TAG = "TRBridge";
    static final String DEFAULT_URL = "https://silverhouse3.github.io/trailrunner/ui-v4/";
    private static final String HEALTH_URL = "http://127.0.0.1:4510/health";
    private static final int COUNTDOWN_S = 20;
    private static final int HEALTH_WAIT_MS = 10000;

    private enum Mode { CHOOSER, STARTING, WEB, ERROR, NOHOME }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private Mode mode = Mode.CHOOSER;
    private WebView web;
    private String targetUrl = DEFAULT_URL;
    private int countdown = COUNTDOWN_S;
    private TextView countdownView, statusView;
    private boolean leftBridgeRunning = false;
    private int startToken = 0;
    private float dp;
    private TRChrome chrome;
    private View hotZone;
    /** Committed top-level URL; "" while a navigation is in flight (fail-closed for AndroidBridge). */
    private volatile String pageUrl = "";
    private static final String UA_SUFFIX = " TRChooser/3";

    // ── lifecycle ────────────────────────────────────────────────────────────

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        dp = getResources().getDisplayMetrics().density;
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a1628"));
        setContentView(root);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent i) {
        String u = i == null ? null : i.getStringExtra("url");
        if (u != null && isHttp(u)) {
            // Test override: straight to the WebView, bridge is NOT started (add --ez bridge true to start it).
            targetUrl = u;
            WebPolicy.testHost = WebPolicy.host(Uri.parse(u));
            if (i.getBooleanExtra("bridge", false)) chooseTrailRunner(); else showWeb();
            return;
        }
        if (mode == Mode.WEB || mode == Mode.STARTING) return; // don't disturb a running session
        showChooser();
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
    }

    @Override
    protected void onPause() {
        try { CookieManager.getInstance().flush(); } catch (Exception ignore) { /* no webview yet */ }
        super.onPause();
    }

    // Accessors for TRChrome
    FrameLayout rootView() { return root; }
    WebView webView() { return web; }
    void hotZoneToFront() { if (hotZone != null) hotZone.bringToFront(); }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == TRChrome.REQ_FILE) { if (chrome != null) chrome.onFileResult(res, data); return; }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == TRChrome.REQ_AUDIO && chrome != null) { chrome.onPermissionsResult(req, results); return; }
        super.onRequestPermissionsResult(req, perms, results);
    }

    /** Ask once per install for storage (exports land in Download/TrailRunner). Denied/unavailable = app dir fallback. */
    private void askStorageOnce() {
        try {
            if (AndroidBridge.hasWritePerm(this)) return;
            SharedPreferences sp = getSharedPreferences("tr", MODE_PRIVATE);
            if (sp.getBoolean("asked_storage", false)) return;
            sp.edit().putBoolean("asked_storage", true).apply();
            requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, TRChrome.REQ_STORAGE);
        } catch (Exception e) {
            Log.w(TAG, "storage permission request unavailable", e);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        destroyWeb();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() { /* ignored on purpose */ }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) return true;
        return super.dispatchKeyEvent(e);
    }

    @SuppressWarnings("deprecation")
    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private int px(float v) { return (int) (v * dp + 0.5f); }

    private static boolean isHttp(String u) {
        try {
            String s = Uri.parse(u).getScheme();
            return "http".equalsIgnoreCase(s) || "https".equalsIgnoreCase(s);
        } catch (Exception e) { return false; }
    }

    private void clearScreen() {
        ui.removeCallbacksAndMessages(null);
        startToken++;
        root.removeAllViews();
    }

    private TextView text(String t, float sp, String color, boolean bold) {
        TextView v = new TextView(this);
        v.setText(t);
        v.setTextSize(sp);
        v.setTextColor(Color.parseColor(color));
        v.setGravity(Gravity.CENTER);
        if (bold) v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    private TextView button(String label, String bg, float wdp, float hdp, float sp) {
        TextView b = text(label, sp, "#ffffff", true);
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.parseColor(bg));
        d.setCornerRadius(px(20));
        b.setBackground(d);
        b.setLayoutParams(new LinearLayout.LayoutParams(px(wdp), px(hdp)));
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    private LinearLayout column() {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setGravity(Gravity.CENTER);
        c.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return c;
    }

    private static void gap(LinearLayout c, int h) {
        View v = new View(c.getContext());
        v.setLayoutParams(new LinearLayout.LayoutParams(1, h));
        c.addView(v);
    }

    // ── chooser ──────────────────────────────────────────────────────────────

    private void showChooser() {
        clearScreen();
        destroyWeb();
        mode = Mode.CHOOSER;
        LinearLayout c = column();
        c.addView(text("Choose your workout mode", 30, "#94a3b8", false));
        gap(c, px(40));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        TextView ifit = button("iFIT", "#2563eb", 380, 240, 44);
        TextView tr = button("TRAILRUNNER", "#16a34a", 380, 240, 44);
        ifit.setOnClickListener(v -> chooseIfit());
        tr.setOnClickListener(v -> chooseTrailRunner());
        row.addView(ifit);
        View sp = new View(this);
        sp.setLayoutParams(new LinearLayout.LayoutParams(px(60), 1));
        row.addView(sp);
        row.addView(tr);
        c.addView(row);
        gap(c, px(36));

        countdown = COUNTDOWN_S;
        countdownView = text("", 26, "#e2e8f0", false);
        c.addView(countdownView);
        gap(c, px(24));
        statusView = text("", 13, "#64748b", false);
        c.addView(statusView);
        root.addView(c);

        updateStatus();
        tickCountdown();
    }

    private void tickCountdown() {
        if (mode != Mode.CHOOSER) return;
        if (countdown <= 0) { chooseIfit(); return; }
        countdownView.setText("Starting iFIT in " + countdown + " s");
        countdown--;
        ui.postDelayed(this::tickCountdown, 1000);
    }

    private void updateStatus() {
        final boolean acc = accessibilityOn();
        final String left = leftBridgeRunning ? " | bridge left running (choose iFIT to stop it)" : "";
        statusView.setText("Bridge: checking... | Accessibility: " + (acc ? "ON" : "OFF") + left);
        new Thread(() -> {
            final boolean up = healthOk(1500);
            ui.post(() -> {
                if (mode == Mode.CHOOSER && statusView != null)
                    statusView.setText("Bridge: " + (up ? "running" : "not running")
                        + " | Accessibility: " + (acc ? "ON" : "OFF") + left);
            });
        }).start();
    }

    private boolean accessibilityOn() {
        try {
            String s = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            return s != null && s.contains("com.silverhouse3.trailrunnerbridge");
        } catch (Exception e) { return false; }
    }

    private static boolean healthOk(int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(HEALTH_URL).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ── iFIT ─────────────────────────────────────────────────────────────────

    private void chooseIfit() {
        Log.i(TAG, "Chose iFIT");
        clearScreen();
        mode = Mode.CHOOSER;
        stopService(new Intent(this, BridgeHttpService.class));
        new Thread(BridgeHttpService::killBridgeProcesses).start();
        leftBridgeRunning = false;
        goHome();
    }

    private void goHome() {
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ResolveInfo ri = getPackageManager().resolveActivity(home, 0);
            if (ri == null) { showNoHome(); return; }
            startActivity(home);
            finish();
        } catch (Exception e) {
            Log.w(TAG, "home start failed", e);
            showNoHome();
        }
    }

    private void showNoHome() {
        clearScreen();
        mode = Mode.NOHOME;
        LinearLayout c = column();
        c.addView(text("Could not open the iFIT home screen.", 30, "#ffffff", true));
        gap(c, px(30));
        TextView retry = button("RETRY", "#2563eb", 300, 110, 30);
        retry.setOnClickListener(v -> goHome());
        c.addView(retry);
        gap(c, px(20));
        TextView back = button("BACK TO CHOOSER", "#334155", 300, 80, 20);
        back.setOnClickListener(v -> showChooser());
        c.addView(back);
        root.addView(c);
    }

    // ── TrailRunner ──────────────────────────────────────────────────────────

    private void chooseTrailRunner() {
        Log.i(TAG, "Chose TrailRunner");
        targetUrl = (targetUrl == null || !isHttp(targetUrl)) ? DEFAULT_URL : targetUrl;
        clearScreen();
        mode = Mode.STARTING;
        LinearLayout c = column();
        c.addView(text("Starting…", 40, "#ffffff", true));
        gap(c, px(16));
        c.addView(text("Starting the bridge", 18, "#94a3b8", false));
        root.addView(c);
        final int token = startToken;
        // Launches the gRPC bridge binary (BridgeHttpService.onCreate / onStartCommand).
        startService(new Intent(this, BridgeHttpService.class));
        new Thread(() -> {
            long end = System.currentTimeMillis() + HEALTH_WAIT_MS;
            boolean ok = healthOk(800);
            while (!ok && System.currentTimeMillis() < end) {
                try { Thread.sleep(500); } catch (InterruptedException e) { return; }
                ok = healthOk(800);
            }
            final boolean up = ok;
            ui.post(() -> {
                if (token != startToken || mode != Mode.STARTING) return;
                if (!up) Log.w(TAG, "bridge /health did not answer in time; loading UI anyway");
                showWeb();
            });
        }).start();
    }

    @SuppressWarnings({"SetJavaScriptEnabled", "deprecation"})
    private void showWeb() {
        clearScreen();
        destroyWeb();
        mode = Mode.WEB;
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0a1628"));
        // New web releases must show immediately (GitHub Pages max-age=600): drop the HTTP cache on every
        // TRAILRUNNER launch. clearCache does NOT touch localStorage / IndexedDB / cookies.
        web.clearCache(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // https page calling http/ws://127.0.0.1: Chromium already treats loopback as potentially
        // trustworthy; ALWAYS_ALLOW is the belt-and-braces fallback.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // Kept false as before: the web app itself never auto-plays video on load, but its beeps / TTS /
        // AudioContext (after a tap) rely on this. User-initiated play with sound works either way.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(false);
        s.setAllowFileAccess(false);                 // no file:// for web content
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);          // window.open / target=_blank load in this WebView
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);    // Strava login, YouTube
        pageUrl = "";
        chrome = new TRChrome(this);
        web.setWebChromeClient(chrome);
        web.addJavascriptInterface(new AndroidBridge(this, () -> pageUrl), "AndroidBridge");
        web.setDownloadListener((url, ua, cd, mime, len) -> onDownload(url, ua, cd, mime));
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (!r.isForMainFrame()) return false;   // iframes (YouTube embed) load normally
                return route(v, r.getUrl());
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showError("Page failed to load (" + e.getDescription() + ")");
            }
            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) {
                h.cancel();
                showError("Secure connection failed (check the treadmill's date/time and network)");
            }
            @Override
            public void onPageStarted(WebView v, String url, Bitmap f) {
                pageUrl = "";                      // untrusted until committed
            }
            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean reload) {
                pageUrl = url == null ? "" : url;  // committed (also pushState)
                injectHook(v, url);
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                pageUrl = url == null ? "" : url;
                injectHook(v, url);
                try { CookieManager.getInstance().flush(); } catch (Exception ignore) { /* ok */ }
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        addHotZone();
        askStorageOnce();
        web.loadUrl(targetUrl);
        immersive();
    }

    /** Invisible top-left 120px zone: long-press 2 s returns to the chooser. */
    private void addHotZone() {
        View hz = new View(this);
        hz.setBackgroundColor(Color.TRANSPARENT);
        hotZone = hz;
        hz.setLayoutParams(new FrameLayout.LayoutParams(120, 120, Gravity.TOP | Gravity.START));
        final Runnable fire = this::leaveWeb;
        hz.setOnTouchListener((v, ev) -> {
            switch (ev.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: ui.postDelayed(fire, 2000); return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL: ui.removeCallbacks(fire); return true;
                default: return true;
            }
        });
        root.addView(hz);
    }

    private void leaveWeb() {
        // Deliberately does NOT stop the bridge (the belt must not stop abruptly).
        leftBridgeRunning = true;
        showChooser();
    }

    private void showError(String why) {
        destroyWeb();
        clearScreen();
        mode = Mode.ERROR;
        LinearLayout c = column();
        c.addView(text("No internet — TrailRunner needs the network to load", 32, "#ffffff", true));
        gap(c, px(14));
        c.addView(text(why, 16, "#94a3b8", false));
        gap(c, px(36));
        TextView retry = button("RETRY", "#16a34a", 300, 110, 30);
        retry.setOnClickListener(v -> showWeb());
        c.addView(retry);
        gap(c, px(20));
        TextView back = button("BACK TO CHOOSER", "#334155", 300, 80, 20);
        back.setOnClickListener(v -> { leftBridgeRunning = true; showChooser(); });
        c.addView(back);
        root.addView(c);
    }

    // ── navigation policy / downloads / blob hook ────────────────────────────

    /** Main-frame navigation decision. true = handled (blocked or redirected), false = let the WebView load it. */
    private boolean route(WebView v, Uri u) {
        String url = u.toString();
        if ("about:blank".equals(url)) return false;
        String conv = WebPolicy.intentToHttps(url);
        if (conv != null) {
            Uri t = Uri.parse(conv);
            if (WebPolicy.isYoutubeHost(WebPolicy.host(t)) && WebPolicy.isNavAllowed(t)) {
                v.loadUrl(conv);
            } else {
                Toast.makeText(this, "Video unavailable here", Toast.LENGTH_LONG).show();
            }
            return true;
        }
        if (WebPolicy.isNavAllowed(u)) return false;
        Log.w(TAG, "blocked navigation: " + url);
        Toast.makeText(this, "Blocked", Toast.LENGTH_SHORT).show();
        return true;
    }

    private void onDownload(String url, String ua, String cd, String mime) {
        if (!WebPolicy.isAppPage(pageUrl)) { Toast.makeText(this, "Blocked", Toast.LENGTH_SHORT).show(); return; }
        String lower = url == null ? "" : url.toLowerCase(java.util.Locale.ROOT);
        if (lower.startsWith("data:")) {
            AndroidBridge.saveDataUrl(this, url, android.webkit.URLUtil.guessFileName("x", cd, mime));
        } else if (lower.startsWith("blob:")) {
            // Fallback only (the injected hook normally catches blob downloads first). The blob may already be revoked.
            String name = android.webkit.URLUtil.guessFileName(url, cd, mime).replace("'", "");
            String js = "fetch('" + url.replace("'", "") + "').then(function(r){return r.blob();}).then(function(b){"
                + "var f=new FileReader();f.onload=function(){var s=String(f.result);"
                + "AndroidBridge.saveFile('" + name + "',b.type||'application/octet-stream',s.substring(s.indexOf(',')+1));};"
                + "f.readAsDataURL(b);}).catch(function(){});";
            if (web != null) web.evaluateJavascript(js, null);
        } else if (lower.startsWith("http://") || lower.startsWith("https://")) {
            AndroidBridge.enqueueHttp(this, url, ua, cd, mime);
        } else {
            Toast.makeText(this, "Blocked", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * Page-side hook (idempotent): remembers Blobs behind blob: URLs (the app revokes them right after
     * a.click()), and turns blob:/data: anchor downloads + window.open(blob:) into AndroidBridge.saveFile.
     * Injected only into TrailRunner pages; no effect if AndroidBridge is missing.
     */
    private static final String HOOK_JS = cat(
        "(function(){",
        "if(window.__trHook||!window.AndroidBridge)return;window.__trHook=1;",
        "var blobs={},oc=URL.createObjectURL.bind(URL),orv=URL.revokeObjectURL.bind(URL);",
        "URL.createObjectURL=function(b){var u=oc(b);if(b instanceof Blob)blobs[u]=b;return u;};",
        "URL.revokeObjectURL=function(u){orv(u);setTimeout(function(){delete blobs[u];},60000);};",
        "function save(n,b){var r=new FileReader();r.onload=function(){var s=String(r.result);",
        "try{window.AndroidBridge.saveFile(n,b.type||'application/octet-stream',s.substring(s.indexOf(',')+1));}catch(e){}};",
        "r.readAsDataURL(b);}",
        "function handle(u,n){var b=blobs[u];if(b){save(n,b);return true;}",
        "if(/^(blob|data):/.test(u)){fetch(u).then(function(r){return r.blob();}).then(function(x){save(n,x);}).catch(function(){});return true;}",
        "return false;}",
        "function isDl(a){return a&&a.hasAttribute&&a.hasAttribute('download')&&/^(blob|data):/.test(a.href||'');}",
        "var ac=HTMLAnchorElement.prototype.click;",
        "HTMLAnchorElement.prototype.click=function(){if(isDl(this)){handle(this.href,this.getAttribute('download')||'download');return;}return ac.apply(this,arguments);};",
        "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a'):null;",
        "if(isDl(a)){e.preventDefault();e.stopPropagation();handle(a.href,a.getAttribute('download')||'download');}},true);",
        "var ow=window.open;window.open=function(u){if(typeof u==='string'&&/^(blob|data):/.test(u)){handle(u,'download');return null;}return ow.apply(window,arguments);};",
        "})();");

    private static String cat(String... parts) {
        StringBuilder b = new StringBuilder();
        for (String p : parts) b.append(p);
        return b.toString();
    }

    private void injectHook(WebView v, String url) {
        if (v == null || !WebPolicy.isAppPage(url)) return;
        v.evaluateJavascript(HOOK_JS, null);
    }

    private void destroyWeb() {
        pageUrl = "";
        if (chrome != null) { chrome.cleanup(); chrome = null; }
        hotZone = null;
        if (web != null) {
            try {
                web.stopLoading();
                web.loadUrl("about:blank");
                ViewGroup p = (ViewGroup) web.getParent();
                if (p != null) p.removeView(web);
                web.destroy();
            } catch (Exception e) { /* ignore */ }
            web = null;
        }
    }
}
