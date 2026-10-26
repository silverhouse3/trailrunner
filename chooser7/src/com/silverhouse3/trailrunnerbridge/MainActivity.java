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
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebBackForwardList;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
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
public class MainActivity extends Activity implements AndroidBridge.VideoHost {
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

    // ── split video / escape bar state (UI thread unless volatile) ──
    /** Top/bottom strips of the YouTube pane kept free of page content: top = our bar, bottom = ROM nav bar. Set top to 0 for a pure overlay. */
    private static final int YT_TOP_RESERVE_PX = 80;
    private static final int YT_BOTTOM_RESERVE_PX = 80;
    private static final String PREF_YT_LAST = "yt_last";
    private FrameLayout trPane;          // holds the TrailRunner WebView + escape bar (right pane in split mode)
    private LinearLayout escapeBar;
    private boolean escapeErr = false;   // main-frame HTTP/load error on the current page
    private boolean clearHistoryPending = false;
    private FrameLayout ytPane;          // left pane (created lazily, kept after close)
    private WebView yt;
    private YtChrome ytChrome;
    private LinearLayout ytBar;
    private TextView ytExitFs;
    private volatile boolean splitOn = false;     // true in half or full
    private volatile int vmode = 0;                // 0 off, 1 half, 2 full
    /** FULL mode: height of the TrailRunner stats strip across the top (tunable 40..120 via AndroidBridge.setStatsStripHeight). */
    static final int STRIP_PX_DEFAULT = 56;
    private volatile int stripPx = STRIP_PX_DEFAULT;
    private TextView ytBtnHalf, ytBtnFull;
    private int splitToken = 0;
    private static final String UA_SUFFIX = " TRChooser/5";

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
        KeyWatcher.start(this);
        final java.lang.ref.WeakReference<Activity> selfRef = new java.lang.ref.WeakReference<>(this);
        BluetoothAudio.locationRequester = () -> {
            try {
                Activity a = selfRef.get();
                if (a != null && !a.isFinishing() && a.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                    a.requestPermissions(new String[]{android.Manifest.permission.ACCESS_COARSE_LOCATION}, BluetoothAudio.REQ_LOCATION);
            } catch (Exception e) { Log.w(TAG, "location permission request unavailable", e); }
        };
        try { BluetoothAudio.get(this).start(); } catch (Exception e) { Log.w(TAG, "bt audio start failed", e); }
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
            if (i.getBooleanExtra("bridge", false)) startTrailRunnerBridge(); else showWeb();
            return;
        }
        if (i != null && i.getBooleanExtra("fromDoubleStop", false)) {
            // Double STOP at belt zero (KeyWatcher): show the choice exactly like fromBoot. Never starts the bridge or touches the belt.
            if (mode != Mode.CHOOSER) showChooser();
            return;
        }
        if (mode == Mode.WEB || mode == Mode.STARTING) return; // don't disturb a running session
        showChooser();
    }

    /** Resumed instance, for KeyWatcher's "chooser already on screen" check. */
    private static volatile MainActivity current;

    static boolean chooserOnScreen() {
        MainActivity a = current;
        return a != null && a.mode == Mode.CHOOSER;
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = this;
        immersive();
        if (yt != null && splitOn) yt.onResume();
    }

    @Override
    protected void onPause() {
        try { CookieManager.getInstance().flush(); } catch (Exception ignore) { /* no webview yet */ }
        // Audio must not keep playing in the background: pause media, then pause the YouTube WebView.
        // (Never WebView.pauseTimers(): it is process-wide and would stall the TrailRunner WebView.)
        if (current == this) current = null;
        if (yt != null && splitOn) { pauseYtMedia(); yt.onPause(); }
        super.onPause();
    }

    // Accessors for TRChrome
    FrameLayout rootView() { return root; }
    WebView webView() { return web; }
    FrameLayout ytPane() { return ytPane; }
    void hotZoneToFront() { if (hotZone != null) hotZone.bringToFront(); }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == TRChrome.REQ_FILE) { if (chrome != null) chrome.onFileResult(res, data); return; }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == TRChrome.REQ_AUDIO && chrome != null) { chrome.onPermissionsResult(req, results); return; }
        if (req == BluetoothAudio.REQ_LOCATION) return;   // result is read via checkSelfPermission on the next Scan
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
        if (mode == Mode.STARTING) return;          // a switch is already in flight
        Log.i(TAG, "Chose iFIT");
        clearScreen();
        mode = Mode.STARTING;
        LinearLayout c = column();
        c.addView(text("Switching to iFit…", 40, "#ffffff", true));
        root.addView(c);
        final int token = startToken;
        // TR Link first re-enables the iFit screen apps (<= 8 s), then HOME as before. Any outcome continues to HOME.
        TrLinkClient.setMode(this, TrLinkClient.MODE_IFIT, 8000, ui, (state, msg) -> {
            if (token != startToken) return;
            if (state != TrLinkClient.OK) Log.w(TAG, "TR Link ifit: " + state + " " + msg);
            doIfit();
        });
    }

    private void doIfit() {
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
        if (mode == Mode.STARTING) return;
        Log.i(TAG, "Chose TrailRunner");
        clearScreen();
        mode = Mode.STARTING;
        LinearLayout c = column();
        c.addView(text("Switching to TrailRunner…", 40, "#ffffff", true));
        gap(c, px(16));
        c.addView(text("Turning the iFit screens off (up to 15 s)", 18, "#94a3b8", false));
        root.addView(c);
        final int token = startToken;
        TrLinkClient.setMode(this, TrLinkClient.MODE_TRAILRUNNER, 15000, ui, (state, msg) -> {
            if (token != startToken || mode != Mode.STARTING) return;
            if (state == TrLinkClient.OK) { startTrailRunnerBridge(); return; }
            if (state == TrLinkClient.UNAVAILABLE) {   // TR Link absent: exactly the chooser4 behaviour
                Log.w(TAG, "TR Link unavailable (" + msg + "); legacy start");
                startTrailRunnerBridge();
                return;
            }
            // Failed or timed out: make sure we are back in iFit mode (queued behind any in-flight switch), say so clearly.
            TrLinkClient.setMode(this, TrLinkClient.MODE_IFIT, 20000, ui, (s2, m2) -> { });
            showSwitchFailed(msg);
        });
    }

    private void showSwitchFailed(String why) {
        clearScreen();
        mode = Mode.ERROR;
        LinearLayout c = column();
        c.addView(text("Could not switch to TrailRunner mode", 32, "#ffffff", true));
        gap(c, px(14));
        c.addView(text("The treadmill is in iFit mode (iFit screens on).", 20, "#e2e8f0", false));
        gap(c, px(8));
        c.addView(text(why == null ? "" : why, 16, "#94a3b8", false));
        gap(c, px(36));
        TextView ifit = button("START IFIT", "#2563eb", 300, 110, 30);
        ifit.setOnClickListener(v -> { mode = Mode.CHOOSER; chooseIfit(); });
        c.addView(ifit);
        gap(c, px(20));
        TextView retry = button("TRY AGAIN", "#16a34a", 300, 80, 22);
        retry.setOnClickListener(v -> { mode = Mode.CHOOSER; chooseTrailRunner(); });
        c.addView(retry);
        gap(c, px(20));
        TextView anyway = button("OPEN TRAILRUNNER ANYWAY (iFit stays on)", "#7c2d12", 480, 70, 18);
        anyway.setOnClickListener(v -> startTrailRunnerBridge());
        c.addView(anyway);
        gap(c, px(20));
        TextView back = button("BACK TO CHOOSER", "#334155", 300, 70, 18);
        back.setOnClickListener(v -> showChooser());
        c.addView(back);
        root.addView(c);
    }

    private void startTrailRunnerBridge() {
        Log.i(TAG, "Starting TrailRunner");
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
        web.addJavascriptInterface(new AndroidBridge(this, () -> pageUrl, this), "AndroidBridge");
        web.setDownloadListener((url, ua, cd, mime, len) -> onDownload(url, ua, cd, mime));
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (!r.isForMainFrame()) return false;   // iframes (YouTube embed) load normally
                return route(v, r.getUrl());
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                if (WebPolicy.isAppPage(r.getUrl().toString())) {
                    showError("Page failed to load (" + e.getDescription() + ")");
                } else {
                    // external page (e.g. Strava) failed: keep the WebView and offer the escape bar
                    escapeErr = true;
                    updateEscape(r.getUrl().toString());
                }
            }
            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse resp) {
                if (r.isForMainFrame() && resp != null && resp.getStatusCode() >= 400) {
                    Log.w(TAG, "main frame HTTP " + resp.getStatusCode() + " " + r.getUrl());
                    escapeErr = true;
                    updateEscape(r.getUrl().toString());
                }
            }
            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) {
                h.cancel();
                showError("Secure connection failed (check the treadmill's date/time and network)");
            }
            @Override
            public void onPageStarted(WebView v, String url, Bitmap f) {
                pageUrl = "";                      // untrusted until committed
                escapeErr = false;                 // new navigation: errors are re-reported if they recur
                updateEscape(url);
            }
            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean reload) {
                pageUrl = url == null ? "" : url;  // committed (also pushState)
                updateEscape(url);
                injectHook(v, url);
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                pageUrl = url == null ? "" : url;
                if (clearHistoryPending && WebPolicy.isAppPage(url)) { clearHistoryPending = false; v.clearHistory(); }
                updateEscape(url);
                injectHook(v, url);
                try { CookieManager.getInstance().flush(); } catch (Exception ignore) { /* ok */ }
            }
        });
        splitOn = false;
        escapeErr = false;
        clearHistoryPending = false;
        trPane = new FrameLayout(this);
        trPane.addView(web, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        buildEscapeBar();
        root.addView(trPane, new FrameLayout.LayoutParams(
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
        destroyYt();
        escapeBar = null;
        if (trPane != null) {
            try { ViewGroup tp = (ViewGroup) trPane.getParent(); if (tp != null) tp.removeView(trPane); }
            catch (Exception ignore) { /* gone */ }
        }
        trPane = null;
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
    // ── escape bar (external / failed pages in the TrailRunner WebView) ──────

    private TextView barBtn(String label, String color, int wPx, float sp) {
        TextView b = text(label, sp, "#ffffff", true);
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.parseColor(color));
        d.setCornerRadius(px(14));
        b.setBackground(d);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(wPx, px(72));
        lp.setMargins(px(5), 0, px(5), 0);
        b.setLayoutParams(lp);
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    /** 72 px high, top-centre of the TrailRunner pane (clear of the ROM back arrow at top-left). Hidden until needed. */
    private void buildEscapeBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#E60b1220"));
        bg.setCornerRadius(px(18));
        bg.setStroke(px(2), Color.parseColor("#f59e0b"));
        bar.setBackground(bg);
        bar.setPadding(px(4), px(4), px(4), px(4));
        TextView back = barBtn("◀ BACK TO TRAILRUNNER", "#16a34a", px(400), 20);
        back.setOnClickListener(v -> escapeBack());
        TextView retry = barBtn("RETRY", "#334155", px(130), 17);
        retry.setOnClickListener(v -> escapeRetry());
        bar.addView(back);
        bar.addView(retry);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, px(80), Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        lp.topMargin = px(4);
        bar.setVisibility(View.GONE);
        escapeBar = bar;
        trPane.addView(bar, lp);
    }

    private void updateEscape(String url) {
        if (escapeBar == null) return;
        boolean ext = url != null && !url.isEmpty() && !"about:blank".equals(url) && !WebPolicy.isAppPage(url);
        boolean show = escapeErr || ext;
        if (show && vmode == 2) {
            // thin strip cannot host the escape bar: drop back to the normal full view first
            applyMode(0, "");
            if (escapeBar == null) return;
        }
        escapeBar.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) escapeBar.bringToFront();
    }

    private void escapeBack() {
        if (web == null) return;
        escapeErr = false;
        clearHistoryPending = true;      // drop the failed/external pages from history once the app page has loaded
        web.stopLoading();
        web.loadUrl(targetUrl);
        if (escapeBar != null) escapeBar.setVisibility(View.GONE);
    }

    private void escapeRetry() {
        if (web == null) return;
        escapeErr = false;
        String u = web.getUrl();
        if (u == null || u.isEmpty() || "about:blank".equals(u)) web.loadUrl(targetUrl); else web.reload();
    }

    // ── split-screen video ───────────────────────────────────────────────────

    private static final String[] MODE_NAMES = {"off", "half", "full"};

    @Override public String videoMode() { return MODE_NAMES[vmode]; }

    @Override
    public void requestVideoSplit(final int mode, final String startUrl) {
        ui.post(() -> applyMode(mode, startUrl));
    }

    @Override
    public boolean videoNavigate(String url) {
        final String t = YtPolicy.videoTarget(url);
        if (!splitOn || t == null) return false;
        ui.post(() -> { if (splitOn && yt != null) yt.loadUrl(t); });
        return true;
    }

    @Override
    public void setStripHeight(int px) {
        final int v = Math.max(40, Math.min(120, px));
        stripPx = v;
        ui.post(() -> { if (vmode == 2) applyMode(2, ""); });
    }

    /** Lay out off / half / full. Never reloads either WebView on half<->full (resize only). UI thread. */
    private void applyMode(int m, String startUrl) {
        if (mode != Mode.WEB || web == null || trPane == null) return;
        if (m < 0 || m > 2) return;
        int full = root.getWidth();
        if (full <= 0) full = getResources().getDisplayMetrics().widthPixels;
        final int half = full / 2;
        final int prev = vmode;
        if (m == 0) {
            if (prev == 0) return;
            vmode = 0;
            splitOn = false;
            closeYtPane();
            trPane.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            notifySplit(0);
            return;
        }
        ensureYt();
        FrameLayout.LayoutParams lpY, lpT;
        if (m == 1) {
            lpY = new FrameLayout.LayoutParams(half, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.TOP | Gravity.START);
            lpT = new FrameLayout.LayoutParams(full - half, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.TOP | Gravity.END);
        } else {
            int sp = stripPx;
            lpT = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, sp, Gravity.TOP | Gravity.START);
            lpY = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT, Gravity.TOP | Gravity.START);
            lpY.topMargin = sp;          // YouTube pane = full width x (window height - strip)
        }
        if (ytPane.getParent() == null) root.addView(ytPane, lpY); else ytPane.setLayoutParams(lpY);
        ytPane.setVisibility(View.VISIBLE);
        trPane.setLayoutParams(lpT);
        vmode = m;
        splitOn = true;
        if (ytBtnHalf != null) ytBtnHalf.setVisibility(m == 2 ? View.VISIBLE : View.GONE);
        if (ytBtnFull != null) ytBtnFull.setVisibility(m == 1 ? View.VISIBLE : View.GONE);
        if (m == 2 && escapeBar != null) escapeBar.setVisibility(View.GONE);   // does not fit in the strip
        if (prev == 0) {
            yt.onResume();
            String target = YtPolicy.videoTarget(startUrl);
            if (target == null) {
                String last = getSharedPreferences("tr", MODE_PRIVATE).getString(PREF_YT_LAST, null);
                target = YtPolicy.isPersistable(last) ? last : YtPolicy.HOME;
            }
            yt.loadUrl(target);
        } else {
            String target = YtPolicy.videoTarget(startUrl);
            if (target != null) yt.loadUrl(target);   // explicit url only; plain half<->full keeps playing
        }
        trPane.bringToFront();           // strip/TrailRunner pane always above the YouTube pane in z-order
        hotZoneToFront();
        if (prev != m) notifySplit(m);
    }

    /** Tell the page after the resize was laid out (plus a short settle so the renderer has applied innerWidth/Height). */
    private void notifySplit(final int m) {
        final int token = ++splitToken;
        final boolean[] fired = {false};
        final ViewTreeObserver.OnGlobalLayoutListener[] l = new ViewTreeObserver.OnGlobalLayoutListener[1];
        final Runnable fire = () -> {
            if (fired[0]) return;
            fired[0] = true;
            try {
                ViewTreeObserver o = root.getViewTreeObserver();
                if (o.isAlive()) o.removeOnGlobalLayoutListener(l[0]);
            } catch (Exception ignore) { /* gone */ }
            ui.postDelayed(() -> {
                if (token != splitToken || web == null || mode != Mode.WEB) return;
                web.evaluateJavascript("window.TR_onVideoSplit && window.TR_onVideoSplit('" + MODE_NAMES[m] + "')", null);
            }, 150);
        };
        l[0] = fire::run;
        root.getViewTreeObserver().addOnGlobalLayoutListener(l[0]);
        ui.postDelayed(fire, 500);       // fallback if no layout pass happens
        root.requestLayout();
    }

    private static final String PAUSE_JS =
        "(function(){var a=document.querySelectorAll('video,audio');"
        + "for(var i=0;i<a.length;i++){try{a[i].pause();}catch(e){}}})();";

    private void pauseYtMedia() {
        if (yt != null) yt.evaluateJavascript(PAUSE_JS, null);
    }

    /**
     * Close = save url, pause media, leave fullscreen, navigate the (retained) WebView to about:blank so no media
     * element can survive, hide the pane, then WebView.onPause() shortly after. Reopen reloads the saved url.
     */
    private void closeYtPane() {
        if (yt == null) return;
        String u = yt.getUrl();
        if (YtPolicy.isPersistable(u)) getSharedPreferences("tr", MODE_PRIVATE).edit().putString(PREF_YT_LAST, u).apply();
        pauseYtMedia();
        if (ytChrome != null) ytChrome.exitFullscreen();
        yt.stopLoading();
        yt.loadUrl("about:blank");
        ytPane.setVisibility(View.GONE);
        try { CookieManager.getInstance().flush(); } catch (Exception ignore) { /* ok */ }
        final WebView w = yt;
        ui.postDelayed(() -> { if (!splitOn && w == yt) w.onPause(); }, 600);
    }

    void onYtFullscreen(boolean fs) {
        if (ytExitFs != null) ytExitFs.setVisibility(fs ? View.VISIBLE : View.GONE);
        if (yt != null) yt.setVisibility(fs ? View.INVISIBLE : View.VISIBLE);
        if (fs && ytBar != null) ytBar.bringToFront();   // inside ytPane only
        if (trPane != null) trPane.bringToFront();
        hotZoneToFront();
    }

    @SuppressWarnings({"SetJavaScriptEnabled"})
    private void ensureYt() {
        if (yt != null) return;
        yt = new WebView(this);
        yt.setBackgroundColor(Color.BLACK);
        WebSettings s = yt.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);   // user taps play; avoids a second tap on some players
        s.setAllowFileAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        // User agent deliberately NOT touched: stock WebView UA.
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(yt, true);
        // NO addJavascriptInterface here: YouTube pages get no bridge, no saveFile, nothing.
        ytChrome = new YtChrome(this);
        yt.setWebChromeClient(ytChrome);
        yt.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (!r.isForMainFrame()) return false;   // sub-frames / sub-resources are not restricted (as in the TR view)
                return ytRoute(v, r.getUrl().toString());
            }
            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean reload) {
                if (YtPolicy.isPersistable(url)) {
                    getSharedPreferences("tr", MODE_PRIVATE).edit().putString(PREF_YT_LAST, url).apply();
                }
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) Toast.makeText(MainActivity.this, "YouTube failed to load - press HOME", Toast.LENGTH_LONG).show();
            }
            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) {
                h.cancel();
                Toast.makeText(MainActivity.this, "YouTube: secure connection failed", Toast.LENGTH_LONG).show();
            }
        });

        ytPane = new FrameLayout(this);
        ytPane.setBackgroundColor(Color.BLACK);
        FrameLayout.LayoutParams wl = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        wl.topMargin = YT_TOP_RESERVE_PX;
        wl.bottomMargin = YT_BOTTOM_RESERVE_PX;
        ytPane.addView(yt, wl);

        // Native bar, top-right of the left pane: HOME | BACK | CLOSE VIDEO (+ EXIT FULLSCREEN while fullscreen).
        // Starts well right of the 110x110 top-left ROM zone; nothing of ours in the bottom 80 px.
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#CC0b1220"));
        bg.setCornerRadius(px(14));
        bar.setBackground(bg);
        ytExitFs = barBtn("EXIT", "#dc2626", px(100), 17);
        ytExitFs.setVisibility(View.GONE);
        ytExitFs.setOnClickListener(v -> { if (ytChrome != null) ytChrome.exitFullscreen(); });
        TextView home = barBtn("HOME", "#334155", px(120), 17);
        home.setOnClickListener(v -> { if (yt != null && splitOn) yt.loadUrl(YtPolicy.HOME); });
        TextView back = barBtn("BACK", "#334155", px(120), 17);
        back.setOnClickListener(v -> ytBack());
        ytBtnFull = barBtn("FULL", "#2563eb", px(110), 17);
        ytBtnFull.setOnClickListener(v -> applyMode(2, ""));
        ytBtnHalf = barBtn("HALF", "#2563eb", px(110), 17);
        ytBtnHalf.setOnClickListener(v -> applyMode(1, ""));
        ytBtnHalf.setVisibility(View.GONE);
        TextView close = barBtn("CLOSE VIDEO", "#b91c1c", px(190), 17);
        close.setOnClickListener(v -> applyMode(0, ""));
        bar.addView(ytExitFs);
        bar.addView(home);
        bar.addView(back);
        bar.addView(ytBtnFull);
        bar.addView(ytBtnHalf);
        bar.addView(close);
        ytBar = bar;
        FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, px(YT_TOP_RESERVE_PX - 4), Gravity.TOP | Gravity.END);
        bl.topMargin = px(2);
        bl.rightMargin = px(6);
        ytPane.addView(bar, bl);
    }

    /** WebView history back, ignored if there is nothing earlier than the about:blank we navigate through. */
    private void ytBack() {
        if (yt == null || !yt.canGoBack()) return;
        WebBackForwardList h = yt.copyBackForwardList();
        int i = h.getCurrentIndex();
        if (i <= 0) return;
        String prev = h.getItemAtIndex(i - 1).getUrl();
        if (prev == null || "about:blank".equals(prev)) return;
        yt.goBack();
    }

    private boolean ytRoute(WebView v, String url) {
        YtPolicy.Decision d = YtPolicy.classifyNav(url);
        switch (d.kind) {
            case ALLOW: return false;
            case CONVERT:
                Log.i(TAG, "yt convert " + url + " -> " + d.url);
                v.loadUrl(d.url);
                return true;
            case BLOCK_SIGNIN:
                Toast.makeText(this, "Google sign-in is disabled here", Toast.LENGTH_SHORT).show();
                return true;
            default:
                Log.w(TAG, "yt blocked navigation: " + url);
                Toast.makeText(this, "Blocked", Toast.LENGTH_SHORT).show();
                return true;               // swallow: never hand intent:/market:/vnd.youtube: to the OS
        }
    }

    private void destroyYt() {
        splitOn = false;
        splitToken++;
        if (ytChrome != null) { ytChrome.exitFullscreen(); ytChrome = null; }
        if (yt != null) {
            try {
                yt.stopLoading();
                yt.loadUrl("about:blank");
                ViewGroup p = (ViewGroup) yt.getParent();
                if (p != null) p.removeView(yt);
                yt.destroy();          // also ends any audio
            } catch (Exception e) { /* ignore */ }
            yt = null;
        }
        if (ytPane != null) {
            try { ViewGroup p = (ViewGroup) ytPane.getParent(); if (p != null) p.removeView(ytPane); }
            catch (Exception ignore) { /* gone */ }
        }
        ytPane = null;
        ytBar = null;
        ytExitFs = null;
        ytBtnHalf = null;
        ytBtnFull = null;
        vmode = 0;
    }
}
