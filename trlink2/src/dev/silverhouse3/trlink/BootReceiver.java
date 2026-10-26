package dev.silverhouse3.trlink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** BOOT_COMPLETED / USER_PRESENT / package-replaced / our own 60 s alarm: (re)start the service. */
public class BootReceiver extends BroadcastReceiver {
    public static final String ACTION_ALARM = "dev.silverhouse3.trlink.ALARM";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            // Always boot to vanilla iFit: re-enable the iFit screen apps (idempotent), retrying until adbd is up.
            final Context app = ctx.getApplicationContext();
            Thread t = new Thread(new Runnable() { public void run() {
                try { LinkService.switcher(app).bootEnableAll(24, 10000); } catch (RuntimeException e) { }
            } }, "trlink-boot-enable");
            t.setDaemon(false);
            t.start();
        }
        try {
            ctx.startService(new Intent(ctx, LinkService.class));
        } catch (RuntimeException e) {
            // never crash from a receiver
        }
    }
}
