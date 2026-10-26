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
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
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
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // https page calling http/ws://127.0.0.1: Chromium already treats loopback as potentially
        // trustworthy; ALWAYS_ALLOW is the belt-and-braces fallback.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(false);
        web.setWebViewClient(new WebViewClient() {
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
            public void onPageStarted(WebView v, String url, Bitmap f) { }
        });
        root.addView(web, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        addHotZone();
        web.loadUrl(targetUrl);
        immersive();
    }

    /** Invisible top-left 120px zone: long-press 2 s returns to the chooser. */
    private void addHotZone() {
        View hz = new View(this);
        hz.setBackgroundColor(Color.TRANSPARENT);
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

    private void destroyWeb() {
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
