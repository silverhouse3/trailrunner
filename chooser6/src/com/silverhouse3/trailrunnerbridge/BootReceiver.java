package com.silverhouse3.trailrunnerbridge;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;

/**
 * BOOT_COMPLETED only SCHEDULES the chooser (delay lets iFit finish loading, otherwise it
 * would cover us). It does NOT start the bridge binary or the :4511 service.
 * The same receiver handles our own delayed SHOW_CHOOSER alarm.
 */
public class BootReceiver extends BroadcastReceiver {
    static final String ACTION_SHOW = "com.silverhouse3.trailrunnerbridge.SHOW_CHOOSER";
    static final long DELAY_MS = 30000L;
    private static final String TAG = "TRBridge";

    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a)) {
            // BOOT_COMPLETED arrives once per boot; scheduling again just replaces the same alarm (UPDATE_CURRENT).
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            Intent show = new Intent(context, BootReceiver.class).setAction(ACTION_SHOW);
            PendingIntent pi = PendingIntent.getBroadcast(context, 1, show, PendingIntent.FLAG_UPDATE_CURRENT);
            am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + DELAY_MS, pi);
            KeyWatcher.start(context);
            Log.i(TAG, "Boot completed: chooser scheduled in " + DELAY_MS + " ms");
        } else if (KeyWatcher.ACTION_REVIVE.equals(a)) {
            KeyWatcher.start(context);
        } else if (ACTION_SHOW.equals(a)) {
            Intent chooser = new Intent(context, MainActivity.class);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            chooser.putExtra("fromBoot", true);
            context.startActivity(chooser);
        }
    }
}
