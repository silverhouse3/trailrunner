package com.silverhouse3.trailrunnerbridge;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * READ-ONLY watcher: polls the console motor log for a double STOP press and, with the belt at zero, opens the chooser.
 * Sends no commands anywhere, opens no ports, shows no notification.
 */
public class KeyWatcher extends Service {
    static final String ACTION_REVIVE = "com.silverhouse3.trailrunnerbridge.REVIVE_WATCHER";
    static final String LOG = "/sdcard/Android/data/com.ifit.glassos_service/files/.valinorlogs/log.latest.txt";
    private static final String TAG = "TRKeyWatch";
    private static final long POLL_MS = 400, BACKOFF_MS = 5000, REVIVE_MS = 60000;
    private static final Pattern SPEED = Pattern.compile("\"(?:speed|kph|actualKph|actual_kph)\"\\s*:\\s*(-?[0-9.]+)");

    private volatile Thread worker;
    private volatile boolean running;

    static void start(Context c) {
        try { c.getApplicationContext().startService(new Intent(c.getApplicationContext(), KeyWatcher.class)); }
        catch (RuntimeException e) { Log.w(TAG, "start failed: " + e.getClass().getSimpleName()); }
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent i, int flags, int id) {
        scheduleRevive();
        synchronized (this) {
            if (worker == null || !worker.isAlive()) {
                running = true;
                worker = new Thread(this::loop, "TRKeyWatch");
                worker.setDaemon(true);
                worker.start();
            }
        }
        return START_STICKY;
    }

    @Override public void onDestroy() { running = false; super.onDestroy(); }

    private void scheduleRevive() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            Intent r = new Intent(this, BootReceiver.class).setAction(ACTION_REVIVE);
            PendingIntent pi = PendingIntent.getBroadcast(this, 2, r, PendingIntent.FLAG_UPDATE_CURRENT);
            am.setRepeating(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + REVIVE_MS, REVIVE_MS, pi);
        } catch (RuntimeException e) { Log.w(TAG, "alarm failed"); }
    }

    private void loop() {
        final long[] cache = {0};
        final boolean[] up = {false};
        final Double[] kph = {null};
        KeyWatchCore.Bridge bridge = new KeyWatchCore.Bridge() {
            private void refresh() {
                long now = SystemClock.elapsedRealtime();
                if (now - cache[0] < 1000 && cache[0] != 0) return;
                cache[0] = now;
                up[0] = false; kph[0] = null;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL("http://127.0.0.1:4510/health").openConnection();
                    c.setConnectTimeout(300); c.setReadTimeout(300);
                    if (c.getResponseCode() != 200) return;
                    up[0] = true;
                    InputStream in = c.getInputStream();
                    byte[] b = new byte[4096];
                    int n = in.read(b);
                    if (n > 0) {
                        Matcher m = SPEED.matcher(new String(b, 0, n, "UTF-8"));
                        if (m.find()) kph[0] = Double.valueOf(m.group(1));
                    }
                } catch (Exception e) {
                    up[0] = false; kph[0] = null;
                } finally { if (c != null) c.disconnect(); }
            }
            @Override public boolean up() { refresh(); return up[0]; }
            @Override public Double kph() { refresh(); return kph[0]; }
        };
        KeyWatchCore core = new KeyWatchCore(new File(LOG), bridge);
        int seen = 0;
        while (running) {
            long sleep = POLL_MS;
            try {
                if (core.step(System.nanoTime())) openChooser();
                if (core.pressCount() != seen) { seen = core.pressCount(); Log.i(TAG, "stop presses seen: " + seen); }
            } catch (Throwable t) {
                sleep = BACKOFF_MS;
                Log.w(TAG, "poll error " + t.getClass().getSimpleName() + ", backing off");
            }
            try { Thread.sleep(sleep); } catch (InterruptedException e) { return; }
        }
    }

    private void openChooser() {
        if (MainActivity.chooserOnScreen()) return;
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        i.putExtra("fromDoubleStop", true);
        startActivity(i);
        Log.i(TAG, "double STOP at belt zero: chooser opened");
    }
}
