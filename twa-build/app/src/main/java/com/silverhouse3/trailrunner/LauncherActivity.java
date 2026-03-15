package com.silverhouse3.trailrunner;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * TrailRunner Launcher — loads the PWA in a fullscreen WebView.
 *
 * On startup:
 *   1. Starts glassos_service (gRPC motor control) if not already running
 *   2. Starts the TrailRunner bridge binary (HTTP/WS → gRPC proxy)
 *   3. Waits for the bridge to respond on port 4510
 *   4. Loads the PWA from GitHub Pages
 *
 * Uses the system Android WebView (no Chrome needed).
 * Enables JavaScript, localStorage, WebSockets, and Bluetooth/Geolocation prompts.
 */
public class LauncherActivity extends Activity {

    private static final String TAG = "TrailRunner";
    private static final String PWA_URL = "https://silverhouse3.github.io/trailrunner/";
    private static final String BRIDGE_HEALTH_URL = "http://127.0.0.1:4510/health";
    private static final String BRIDGE_BINARY = "/data/local/tmp/trailrunner-bridge";
    private static final String GLASSOS_PACKAGE = "com.ifit.glassos_service";
    private static final String GLASSOS_SERVICE = ".GlassOSPlatformService";
    private static final String GLASSOS_ACTION = "com.ifit.glassos_service.GLASSOS_PLATFORM";
    private static final int MAX_BRIDGE_WAIT_MS = 30000;
    private static final int BRIDGE_POLL_MS = 1000;

    private WebView webView;
    private Handler handler;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        handler = new Handler(Looper.getMainLooper());

        // Fullscreen immersive mode (no status bar, no nav bar)
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        // Keep screen on during runs
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Create WebView
        webView = new WebView(this);
        setContentView(webView);

        // Set dark background to avoid white flash
        webView.setBackgroundColor(android.graphics.Color.parseColor("#090b10"));

        // Show loading screen while services start
        webView.loadData(
            "<html><body style='background:#090b10;color:#3ecfff;font-family:sans-serif;"
            + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"
            + "flex-direction:column;gap:20px'>"
            + "<div style='font-size:48px;font-weight:900;letter-spacing:.3em'>TRAILRUNNER</div>"
            + "<div style='font-size:16px;color:#49536b;letter-spacing:.1em' id='status'>Starting services...</div>"
            + "</body></html>",
            "text/html", "UTF-8"
        );

        // Start services on a background thread
        new Thread(this::startServicesAndLoad).start();
    }

    /**
     * Ensures glassos_service and bridge are running, then loads the PWA.
     * Runs on a background thread.
     */
    private void startServicesAndLoad() {
        // Step 1: Start glassos_service (gRPC motor control)
        Log.i(TAG, "Starting glassos_service...");
        updateStatus("Starting motor control service...");
        startGlassosService();

        // Wait for glassos to initialize its gRPC server
        // No rush — belt won't start until user taps Start Run
        sleep(8000);

        // Step 2: Start bridge binary if not already running
        Log.i(TAG, "Checking bridge...");
        updateStatus("Starting bridge...");
        if (!isBridgeRunning()) {
            startBridge();
        } else {
            Log.i(TAG, "Bridge already running");
        }

        // Step 3: Wait for bridge to become healthy
        Log.i(TAG, "Waiting for bridge health...");
        updateStatus("Connecting to treadmill...");
        boolean bridgeReady = waitForBridge();

        if (bridgeReady) {
            Log.i(TAG, "Bridge is healthy — loading PWA");
            updateStatus("Loading TrailRunner...");
        } else {
            Log.w(TAG, "Bridge not responding after timeout — loading PWA anyway");
            updateStatus("Bridge timeout — loading app...");
        }

        // Step 4: Load the PWA on the main thread
        sleep(500);
        handler.post(this::configurAndLoadPWA);
    }

    private void startGlassosService() {
        try {
            // Method 1: Start via explicit intent
            Intent intent = new Intent(GLASSOS_ACTION);
            intent.setComponent(new ComponentName(GLASSOS_PACKAGE, GLASSOS_PACKAGE + GLASSOS_SERVICE));
            startService(intent);
            Log.i(TAG, "glassos_service start requested via intent");
        } catch (Exception e) {
            Log.w(TAG, "Intent start failed, trying am command: " + e.getMessage());
            try {
                // Method 2: Fallback to am startservice shell command
                Runtime.getRuntime().exec(new String[]{
                    "am", "startservice",
                    "-a", GLASSOS_ACTION,
                    GLASSOS_PACKAGE + "/" + GLASSOS_SERVICE
                });
                Log.i(TAG, "glassos_service start requested via am command");
            } catch (Exception e2) {
                Log.e(TAG, "Failed to start glassos_service: " + e2.getMessage());
            }
        }
    }

    private boolean isBridgeRunning() {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(BRIDGE_HEALTH_URL).openConnection();
            conn.setConnectTimeout(1000);
            conn.setReadTimeout(1000);
            int code = conn.getResponseCode();
            conn.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    private void startBridge() {
        try {
            // Check if bridge binary exists
            java.io.File bridge = new java.io.File(BRIDGE_BINARY);
            if (!bridge.exists()) {
                Log.e(TAG, "Bridge binary not found at " + BRIDGE_BINARY);
                return;
            }

            // Start bridge in background (it has its own gRPC retry loop)
            ProcessBuilder pb = new ProcessBuilder(BRIDGE_BINARY);
            pb.redirectErrorStream(true);
            pb.start();
            Log.i(TAG, "Bridge started from " + BRIDGE_BINARY);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start bridge: " + e.getMessage());
            // Fallback: try via shell
            try {
                Runtime.getRuntime().exec(new String[]{
                    "sh", "-c", BRIDGE_BINARY + " &"
                });
                Log.i(TAG, "Bridge started via shell fallback");
            } catch (Exception e2) {
                Log.e(TAG, "Shell fallback also failed: " + e2.getMessage());
            }
        }
    }

    private boolean waitForBridge() {
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < MAX_BRIDGE_WAIT_MS) {
            if (isBridgeRunning()) {
                return true;
            }
            sleep(BRIDGE_POLL_MS);
        }
        return false;
    }

    private void updateStatus(String msg) {
        handler.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                    "try{document.getElementById('status').textContent='" + msg + "'}catch(e){}",
                    null
                );
            }
        });
    }

    private void sleep(int ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configurAndLoadPWA() {
        // Configure WebView settings
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);                // localStorage
        settings.setDatabaseEnabled(true);                  // IndexedDB
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);    // use cache when available
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setAllowFileAccess(true);
        settings.setGeolocationEnabled(true);

        // Allow ALL mixed content — PWA on HTTPS needs to reach bridge on HTTP/WS localhost
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Handle navigation, errors, and settings injection (single WebViewClient)
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectDeviceSettings(view);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String reqUrl = request.getUrl().toString();
                // Keep PWA, localhost, and Strava URLs inside the WebView
                if (reqUrl.contains("silverhouse3.github.io") || reqUrl.contains("localhost")
                        || reqUrl.contains("127.0.0.1") || reqUrl.contains("strava.com")) {
                    return false;
                }
                // External links open in system browser
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(reqUrl));
                startActivity(intent);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.e(TAG, "WebView error: " + errorCode + " - " + description + " for " + failingUrl);
                view.loadData(
                    "<html><body style='background:#090b10;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
                    + "<div style='text-align:center'>"
                    + "<h1 style='color:#3ecfff'>TRAILRUNNER</h1>"
                    + "<p style='color:#ff5f5f'>Cannot reach server: " + description + "</p>"
                    + "<p style='color:#49536b;font-size:14px'>Check WiFi connection</p>"
                    + "<button onclick='location.href=\"" + PWA_URL + "\"' "
                    + "style='padding:16px 32px;font-size:18px;background:#3ecfff;color:#090b10;border:none;border-radius:8px;cursor:pointer;font-weight:700;margin-top:16px'>"
                    + "RETRY</button></div></body></html>",
                    "text/html", "UTF-8"
                );
            }
        });

        // Handle permission requests (Bluetooth, Geolocation)
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, true);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Auto-grant permissions the PWA needs
                Log.i(TAG, "Permission request: " + java.util.Arrays.toString(request.getResources()));
                request.grant(request.getResources());
            }
        });

        Log.i(TAG, "Loading PWA: " + PWA_URL);
        webView.loadUrl(PWA_URL);
    }

    /** Inject Strava credentials into localStorage (device-only, not in GitHub source) */
    private void injectDeviceSettings(WebView view) {
        String js = "try {"
            + "var s = JSON.parse(localStorage.getItem('tr_settings') || '{}');"
            + "if (!s.stravaClientId) {"
            + "  s.stravaClientId = '212069';"
            + "  s.stravaClientSecret = 'b0fecc67dfcf54c9d6d1ac820467c7d37b8b8034';"
            + "  localStorage.setItem('tr_settings', JSON.stringify(s));"
            + "  console.log('[APK] Injected Strava credentials');"
            + "}"
            + "} catch(e) { console.error('[APK] Settings inject error:', e); }";
        view.evaluateJavascript(js, null);
    }

    @Override
    public void onBackPressed() {
        // If WebView can go back, do that instead of closing the app
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        }
        // Don't call super — prevent accidentally closing the app during a run
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-apply immersive mode when regaining focus
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            );
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
