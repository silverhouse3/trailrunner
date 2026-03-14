package com.silverhouse3.trailrunnerbridge;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * HTTP server that receives control commands from the TrailRunner bridge/PWA
 * and translates them into AccessibilityService gestures.
 *
 * Endpoints:
 *   GET  /ping              -> {"ok":true,"service":true/false}
 *   GET  /status            -> telemetry JSON
 *   GET  /nodes             -> accessibility node tree (for UI discovery)
 *   POST /tap               -> {"x":100,"y":200}
 *   POST /swipe             -> {"x1":100,"y1":200,"x2":100,"y2":400,"duration":300}
 *   POST /back              -> press BACK
 *   POST /home              -> press HOME
 *   POST /launch            -> {"url":"..."} open URL in Chrome
 */
public class BridgeHttpService extends Service {
    private static final String TAG = "TRBridge";
    private static final int PORT = 4511;
    private static final int NOTIFICATION_ID = 1;

    private ServerSocket serverSocket;
    private Thread serverThread;
    private volatile boolean running = false;

    @Override
    public void onCreate() {
        super.onCreate();
        startForegroundNotification();
        startHttpServer();
        startGrpcBridge();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException e) {}
        stopGrpcBridge();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void startForegroundNotification() {
        Notification notification = new Notification.Builder(this)
            .setContentTitle("TR Bridge")
            .setContentText("Listening on port " + PORT)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .build();

        startForeground(NOTIFICATION_ID, notification);
    }

    // ── gRPC Bridge (native ARM64 binary) ────────────────────────────────────

    private static final String BRIDGE_BIN = "/data/local/tmp/trailrunner-bridge";
    private static final String BRIDGE_LOG = "/sdcard/trailrunner/bridge.log";
    private Process bridgeProcess;

    private void startGrpcBridge() {
        new Thread(() -> {
            try {
                java.io.File bin = new java.io.File(BRIDGE_BIN);
                if (!bin.exists()) {
                    Log.w(TAG, "gRPC bridge binary not found at " + BRIDGE_BIN);
                    return;
                }

                // Kill any existing bridge
                try {
                    Runtime.getRuntime().exec(new String[]{"killall", "trailrunner-bridge"}).waitFor();
                } catch (Exception e) { /* ignore */ }

                // Ensure log directory exists
                new java.io.File("/sdcard/trailrunner").mkdirs();

                // Start the bridge
                Log.i(TAG, "Starting gRPC bridge: " + BRIDGE_BIN);
                ProcessBuilder pb = new ProcessBuilder(BRIDGE_BIN);
                pb.redirectErrorStream(true);
                pb.redirectOutput(new java.io.File(BRIDGE_LOG));
                bridgeProcess = pb.start();
                Log.i(TAG, "gRPC bridge started (PID tracked)");

                // Monitor the bridge process
                int exitCode = bridgeProcess.waitFor();
                Log.w(TAG, "gRPC bridge exited with code " + exitCode + " — restarting in 5s...");
                Thread.sleep(5000);
                startGrpcBridge(); // Auto-restart
            } catch (Exception e) {
                Log.e(TAG, "gRPC bridge launch error", e);
            }
        }, "BridgeLauncher").start();
    }

    private void stopGrpcBridge() {
        if (bridgeProcess != null) {
            bridgeProcess.destroy();
            bridgeProcess = null;
        }
        try {
            Runtime.getRuntime().exec(new String[]{"killall", "trailrunner-bridge"});
        } catch (Exception e) { /* ignore */ }
    }

    // ── HTTP Server ──────────────────────────────────────────────────────────

    private void startHttpServer() {
        running = true;
        serverThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket(PORT);
                Log.i(TAG, "HTTP server listening on port " + PORT);

                while (running) {
                    Socket client = serverSocket.accept();
                    handleClient(client);
                }
            } catch (IOException e) {
                if (running) Log.e(TAG, "HTTP server error", e);
            }
        }, "BridgeHTTP");
        serverThread.setDaemon(true);
        serverThread.start();
    }

    private void handleClient(Socket client) {
        new Thread(() -> {
            try {
                BufferedReader in = new BufferedReader(
                    new InputStreamReader(client.getInputStream()));
                OutputStream out = client.getOutputStream();

                String requestLine = in.readLine();
                if (requestLine == null) { client.close(); return; }

                // Read headers
                String line;
                int contentLength = 0;
                while ((line = in.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase().startsWith("content-length:")) {
                        contentLength = Integer.parseInt(line.substring(15).trim());
                    }
                }

                // Read body
                String body = "";
                if (contentLength > 0) {
                    char[] buf = new char[contentLength];
                    in.read(buf, 0, contentLength);
                    body = new String(buf);
                }

                String response = handleRequest(requestLine, body);
                String httpResponse = "HTTP/1.1 200 OK\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: Content-Type\r\n"
                    + "Content-Length: " + response.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                    + "\r\n"
                    + response;

                out.write(httpResponse.getBytes(StandardCharsets.UTF_8));
                out.flush();
                client.close();
            } catch (Exception e) {
                Log.e(TAG, "Client handler error", e);
                try { client.close(); } catch (IOException ex) {}
            }
        }).start();
    }

    private String handleRequest(String requestLine, String body) {
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return "{\"error\":\"bad request\"}";

        String method = parts[0];
        String path = parts[1];

        if ("OPTIONS".equals(method)) {
            return "{}";
        }

        boolean serviceReady = BridgeAccessibilityService.isReady();

        switch (path) {
            case "/ping":
                boolean bridgeAlive = (bridgeProcess != null && bridgeProcess.isAlive());
                return "{\"ok\":true,\"service\":" + serviceReady
                    + ",\"grpcBridge\":" + bridgeAlive
                    + ",\"version\":\"3.0\"}";

            case "/status":
                return "{\"service\":" + serviceReady + ",\"version\":\"2.0\"}";

            case "/nodes":
                if (!serviceReady) return "{\"error\":\"accessibility service not ready\"}";
                try {
                    String nodes = BridgeAccessibilityService.getNodeTree();
                    return "{\"ok\":true,\"nodes\":" + nodes + "}";
                } catch (Exception e) {
                    return "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
                }

            case "/tap":
                if (!serviceReady) return "{\"error\":\"accessibility service not ready\"}";
                try {
                    float x = extractFloat(body, "x");
                    float y = extractFloat(body, "y");
                    boolean ok = BridgeAccessibilityService.performTap(x, y);
                    return "{\"ok\":" + ok + "}";
                } catch (Exception e) {
                    return "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
                }

            case "/swipe":
                if (!serviceReady) return "{\"error\":\"accessibility service not ready\"}";
                try {
                    float x1 = extractFloat(body, "x1");
                    float y1 = extractFloat(body, "y1");
                    float x2 = extractFloat(body, "x2");
                    float y2 = extractFloat(body, "y2");
                    long dur = (long) extractFloat(body, "duration");
                    if (dur <= 0) dur = 300;
                    boolean ok = BridgeAccessibilityService.performSwipe(x1, y1, x2, y2, dur);
                    return "{\"ok\":" + ok + "}";
                } catch (Exception e) {
                    return "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
                }

            case "/back":
                if (!serviceReady) return "{\"error\":\"accessibility service not ready\"}";
                return "{\"ok\":" + BridgeAccessibilityService.performBack() + "}";

            case "/home":
                if (!serviceReady) return "{\"error\":\"accessibility service not ready\"}";
                return "{\"ok\":" + BridgeAccessibilityService.performHome() + "}";

            case "/launch":
                try {
                    String url = extractString(body, "url");
                    Intent intent = new Intent(Intent.ACTION_VIEW,
                        android.net.Uri.parse(url));
                    intent.setPackage("com.android.chrome");
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                    return "{\"ok\":true}";
                } catch (Exception e) {
                    return "{\"error\":\"" + escapeJson(e.getMessage()) + "\"}";
                }

            default:
                return "{\"error\":\"unknown endpoint\",\"path\":\"" + escapeJson(path) + "\"}";
        }
    }

    /** Simple JSON float extraction (avoids needing org.json). */
    private static float extractFloat(String json, String key) {
        String search = "\"" + key + "\"";
        int idx = json.indexOf(search);
        if (idx < 0) throw new IllegalArgumentException("missing key: " + key);
        idx = json.indexOf(':', idx);
        if (idx < 0) throw new IllegalArgumentException("malformed JSON");
        StringBuilder num = new StringBuilder();
        for (int i = idx + 1; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '-' || c == '.' || (c >= '0' && c <= '9')) num.append(c);
            else if (num.length() > 0) break;
        }
        return Float.parseFloat(num.toString());
    }

    /** Simple JSON string extraction. */
    private static String extractString(String json, String key) {
        String search = "\"" + key + "\"";
        int idx = json.indexOf(search);
        if (idx < 0) throw new IllegalArgumentException("missing key: " + key);
        idx = json.indexOf(':', idx);
        if (idx < 0) throw new IllegalArgumentException("malformed JSON");
        int start = json.indexOf('"', idx + 1);
        if (start < 0) throw new IllegalArgumentException("malformed JSON string");
        int end = json.indexOf('"', start + 1);
        if (end < 0) throw new IllegalArgumentException("malformed JSON string");
        return json.substring(start + 1, end);
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n");
    }
}
