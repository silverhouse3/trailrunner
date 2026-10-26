package dev.silverhouse3.trlink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** BOOT_COMPLETED / USER_PRESENT / package-replaced / our own 60 s alarm: (re)start the service. */
public class BootReceiver extends BroadcastReceiver {
    public static final String ACTION_ALARM = "dev.silverhouse3.trlink.ALARM";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            ctx.startService(new Intent(ctx, LinkService.class));
        } catch (RuntimeException e) {
            // never crash from a receiver
        }
    }
}
