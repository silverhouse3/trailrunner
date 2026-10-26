package dev.silverhouse3.trlink;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.ContentObserver;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.provider.Settings;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;

/** Keeps ADB_ENABLED / DEVELOPMENT_SETTINGS_ENABLED at 1, and serves a tiny authenticated status API. */
public class LinkService extends Service {
    public static final String PREFS = "trlink";
    public static final String VERSION = "2.0";
    static final int HTTP_PORT = 4512;
    static final int ADBD_PORT = 5555;
    static final long TICK_MS = 25000;
    static final long ALARM_MS = 60000;
    static final long TOGGLE_MIN_GAP_MS = 120000;
    static final long MANUAL_MIN_GAP_MS = 10000;
    static final long BOOT_GRACE_MS = 90000;   // don't toggle adbd for port reasons right after start

    private static final EventRing SWITCH_LOG = new EventRing(100);
    private static Switcher switcherInst;
    private static volatile int adbAuthWaitMs = 8000;

    static EventRing switchLog() { return SWITCH_LOG; }

    static synchronized Switcher switcher(final Context ctx) {
        if (switcherInst == null) {
            final Context app = ctx.getApplicationContext();
            Switcher.Shell sh = new Switcher.Shell() {
                public String exec(String cmd) throws java.io.IOException {
                    try {
                        AdbKey k = AdbKey.loadOrCreate(app.getFilesDir());
                        return new AdbClient("127.0.0.1", ADBD_PORT, k, "trlink@x32i").shell(cmd, 15000, adbAuthWaitMs);
                    } catch (java.security.GeneralSecurityException e) {
                        throw new java.io.IOException("key error");
                    }
                }
            };
            switcherInst = new Switcher(sh, Switcher.deviceProbe(), SWITCH_LOG, 2000);
        }
        return switcherInst;
    }

    private final EventRing events = new EventRing(50);
    private final EventRing log = new EventRing(300);
    private final RateLimiter limiter = new RateLimiter(10, 60000);
    private HandlerThread thread;
    private Handler handler;
    private ContentResolver resolver;
    private HttpServer http;
    private long startedAt;
    private long lastToggle = 0;       // elapsedRealtime of last adbd toggle (0 = never)
    private long lastManual = 0;
    private String lastError = null;
    private volatile byte[] tokenHash;
    private boolean lastPortOpen = false;
    private boolean lastNoPermLogged = false;

    private final Runnable tick = new Runnable() {
        public void run() {
            try { check("tick"); } catch (RuntimeException e) { note("watchdog error: " + e.getClass().getSimpleName()); }
            handler.postDelayed(this, TICK_MS);
        }
    };
    private final Runnable observed = new Runnable() {
        public void run() {
            try { check("observer"); } catch (RuntimeException e) { note("observer error: " + e.getClass().getSimpleName()); }
        }
    };
    private ContentObserver observer;

    @Override
    public void onCreate() {
        super.onCreate();
        startedAt = SystemClock.elapsedRealtime();
        resolver = getContentResolver();
        thread = new HandlerThread("trlink-wd");
        thread.start();
        handler = new Handler(thread.getLooper());
        observer = new ContentObserver(handler) {
            @Override public void onChange(boolean selfChange) {
                handler.removeCallbacks(observed);
                handler.postDelayed(observed, 300);
            }
        };
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ADB_ENABLED), false, observer);
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED), false, observer);
        note("service created, v" + VERSION + ", sdk " + Build.VERSION.SDK_INT);
        handler.post(tick);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        loadToken();
        scheduleAlarm();
        startHttp();
        return START_STICKY;
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public void onDestroy() {
        try { resolver.unregisterContentObserver(observer); } catch (RuntimeException ignored) {}
        if (http != null) http.stop();
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quit();
        super.onDestroy();
    }

    private void loadToken() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        byte[] h = Auth.unhex(sp.getString("tokhash", null));
        if (h == null && tokenHash == null) {
            note("no token set; HTTP server not started");
        }
        tokenHash = h;
        String m = sp.getString("lastTokenMsg", null);
        if (m != null) { note("token: " + m); sp.edit().remove("lastTokenMsg").commit(); }
    }

    private void scheduleAlarm() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            Intent i = new Intent(this, BootReceiver.class).setAction(BootReceiver.ACTION_ALARM);
            PendingIntent pi = PendingIntent.getBroadcast(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT);
            am.setRepeating(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + ALARM_MS, ALARM_MS, pi);
        } catch (RuntimeException e) {
            note("alarm schedule failed: " + e.getClass().getSimpleName());
        }
    }

    private synchronized void startHttp() {
        if (tokenHash == null) {
            if (http != null && http.isRunning()) { http.stop(); note("HTTP stopped (token removed)"); }
            return;
        }
        if (http != null && http.isRunning()) return;
        http = new HttpServer(HTTP_PORT, new HttpServer.TokenSource() {
            public byte[] hash() { return tokenHash; }
        }, new HttpServer.Handler() {
            public HttpServer.Response handle(String m, String p, Map<String, String> q) { return route(m, p, q); }
        }, new HttpServer.Log() {
            public void log(String s) { log.add(s); }
        }, limiter);
        try {
            http.start();
            note("HTTP listening on :" + HTTP_PORT);
        } catch (java.io.IOException e) {
            note("HTTP start failed: " + e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- routing

    private HttpServer.Response route(String method, String path, Map<String, String> q) {
        if (path.equals("/status")) {
            if (!method.equals("GET")) return HttpServer.Response.text(405, "");
            return HttpServer.Response.json(200, statusJson());
        }
        if (path.equals("/adb/repair")) {
            if (!method.equals("POST")) return HttpServer.Response.text(405, "");
            return HttpServer.Response.json(200, repair());
        }
        if (path.equals("/logs")) {
            if (!method.equals("GET")) return HttpServer.Response.text(405, "");
            int n = 100;
            try { if (q.get("lines") != null) n = Integer.parseInt(q.get("lines")); } catch (NumberFormatException ignored) {}
            if (n < 1) n = 1;
            if (n > 300) n = 300;
            StringBuilder b = new StringBuilder();
            for (String l : log.last(n)) b.append(l).append('\n');
            return HttpServer.Response.text(200, b.toString());
        }
        if (path.equals("/mode")) {
            if (!method.equals("GET")) return HttpServer.Response.text(405, "");
            try {
                return HttpServer.Response.json(200, "{\"mode\":" + Json.str(switcher(this).readMode()) + "}");
            } catch (java.io.IOException e) {
                return HttpServer.Response.json(502, "{\"mode\":\"unknown\",\"error\":" + Json.str(e.getMessage()) + "}");
            }
        }
        if (path.equals("/mode/trailrunner") || path.equals("/mode/ifit")) {
            if (!method.equals("POST")) return HttpServer.Response.text(405, "");
            Switcher sw = switcher(this);
            Switcher.Result r = path.endsWith("trailrunner") ? sw.enterTrailRunnerMode() : sw.exitIfitMode();
            return HttpServer.Response.json(r.ok ? 200 : 502, "{\"ok\":" + r.ok + ",\"result\":" + Json.str(r.msg) + "}");
        }
        if (path.equals("/adb/pair")) {   // first-time: gives the owner 60 s to tick "Always allow" on the console
            if (!method.equals("POST")) return HttpServer.Response.text(405, "");
            adbAuthWaitMs = 60000;
            try {
                String o = new AdbClient("127.0.0.1", ADBD_PORT, AdbKey.loadOrCreate(getFilesDir()), "trlink@x32i").shell("echo trlink", 15000, 60000);
                SWITCH_LOG.add("adb pair ok");
                return HttpServer.Response.json(200, "{\"ok\":" + o.contains("trlink") + "}");
            } catch (java.io.IOException e) {
                SWITCH_LOG.add("adb pair failed: " + e.getMessage());
                return HttpServer.Response.json(502, "{\"ok\":false,\"error\":" + Json.str(e.getMessage()) + "}");
            } catch (java.security.GeneralSecurityException e) {
                return HttpServer.Response.json(500, "{\"ok\":false}");
            } finally { adbAuthWaitMs = 8000; }
        }
        return HttpServer.Response.text(404, "");
    }

    private String statusJson() {
        boolean open = portOpen();
        StringBuilder b = new StringBuilder("{");
        b.append("\"version\":").append(Json.str(VERSION));
        b.append(",\"uptimeMs\":").append(SystemClock.elapsedRealtime() - startedAt);
        b.append(",\"adb_enabled\":").append(getSetting(Settings.Global.ADB_ENABLED));
        b.append(",\"development_settings_enabled\":").append(getSetting(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED));
        b.append(",\"port5555Open\":").append(open);
        b.append(",\"writeSecureSettingsGranted\":").append(hasWriteSecure());
        b.append(",\"lastError\":").append(Json.str(lastError));
        b.append(",\"lastEvents\":").append(Json.arr(events.last(50)));
        b.append(",\"lastMode\":").append(Json.str(switcher(this).lastMode()));
        b.append(",\"switchLog\":").append(Json.arr(SWITCH_LOG.last(100)));
        b.append(",\"sdk\":").append(Build.VERSION.SDK_INT);
        return b.append('}').toString();
    }

    // ---------------------------------------------------------------- watchdog

    private void note(String s) { events.add(s); log.add(s); }

    private int getSetting(String name) { return Settings.Global.getInt(resolver, name, -1); }

    private boolean hasWriteSecure() {
        return getPackageManager().checkPermission("android.permission.WRITE_SECURE_SETTINGS", getPackageName())
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Returns true if the value is (now) 1. */
    private boolean ensure(String name, String label) {
        int v = getSetting(name);
        if (v == 1) return true;
        try {
            Settings.Global.putInt(resolver, name, 1);
            lastNoPermLogged = false;
            lastError = null;
            note(label + " was " + v + ", set to 1");
            return true;
        } catch (SecurityException e) {
            lastError = "WRITE_SECURE_SETTINGS not granted";
            if (!lastNoPermLogged) { note(lastError); lastNoPermLogged = true; }
            return false;
        }
    }

    private synchronized void check(String why) {
        boolean a = ensure(Settings.Global.ADB_ENABLED, "ADB_ENABLED");
        ensure(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, "DEVELOPMENT_SETTINGS_ENABLED");
        if (!a) return;
        boolean open = portOpen();
        if (open != lastPortOpen) { note("port " + ADBD_PORT + (open ? " open" : " closed")); lastPortOpen = open; }
        long now = SystemClock.elapsedRealtime();
        if (!open && now - startedAt >= BOOT_GRACE_MS && (lastToggle == 0 || now - lastToggle >= TOGGLE_MIN_GAP_MS)) {
            note("ADB_ENABLED=1 but port closed; toggling (" + why + ")");
            toggle();
        }
    }

    /** 0 then 1 with ~1.5 s gap. Caller holds the monitor. */
    private boolean toggle() {
        lastToggle = SystemClock.elapsedRealtime();
        try {
            Settings.Global.putInt(resolver, Settings.Global.ADB_ENABLED, 0);
            try { Thread.sleep(1500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            Settings.Global.putInt(resolver, Settings.Global.ADB_ENABLED, 1);
            note("ADB_ENABLED toggled 0 -> 1");
            return true;
        } catch (SecurityException e) {
            lastError = "WRITE_SECURE_SETTINGS not granted";
            note(lastError);
            return false;
        }
    }

    private synchronized String repair() {
        long now = SystemClock.elapsedRealtime();
        if (lastManual != 0 && now - lastManual < MANUAL_MIN_GAP_MS) {
            return "{\"ok\":false,\"result\":\"too soon, wait 10 s\"}";
        }
        lastManual = now;
        note("manual repair requested");
        boolean ok = toggle();
        ensure(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, "DEVELOPMENT_SETTINGS_ENABLED");
        boolean open = false;
        for (int i = 0; i < 10 && !open; i++) {
            open = portOpen();
            if (!open) try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
        lastPortOpen = open;
        return "{\"ok\":" + ok + ",\"result\":" + Json.str(ok ? "toggled" : lastError)
                + ",\"adb_enabled\":" + getSetting(Settings.Global.ADB_ENABLED)
                + ",\"development_settings_enabled\":" + getSetting(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED)
                + ",\"port5555Open\":" + open + "}";
    }

    private static boolean portOpen() {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", ADBD_PORT), 500);
            return true;
        } catch (java.io.IOException e) {
            return false;
        } finally {
            try { s.close(); } catch (java.io.IOException ignored) {}
        }
    }
}
