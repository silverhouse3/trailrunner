package com.silverhouse3.trailrunnerbridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Auto-start on boot: starts HTTP bridge service AND shows the boot chooser.
 * The accessibility service is started automatically by the system
 * if it was enabled in Settings.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.i("TRBridge", "Boot completed — starting services and showing chooser");

            // Start HTTP bridge service
            Intent serviceIntent = new Intent(context, BridgeHttpService.class);
            context.startService(serviceIntent);

            // Show boot chooser activity (TrailRunner vs iFIT)
            Intent chooser = new Intent(context, MainActivity.class);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(chooser);
        }
    }
}
