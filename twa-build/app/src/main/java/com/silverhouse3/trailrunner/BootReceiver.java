package com.silverhouse3.trailrunner;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Auto-launches TrailRunner after the treadmill boots.
 *
 * Waits up to 60 seconds for glassos_service to be ready (checks gRPC port),
 * then launches LauncherActivity which handles bridge startup and PWA loading.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "TrailRunner";
    private static final int INITIAL_DELAY_MS = 45000;  // 45s after boot — no rush

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        Log.i(TAG, "Boot completed — waiting 45s for services to settle before launch");

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // Initial delay — let Android settle, WiFi connect, glassos start
                    Thread.sleep(INITIAL_DELAY_MS);
                } catch (InterruptedException ignored) {}

                Log.i(TAG, "Launching TrailRunner after boot delay");
                Intent launch = new Intent(context, LauncherActivity.class);
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(launch);
            }
        }).start();
    }
}
