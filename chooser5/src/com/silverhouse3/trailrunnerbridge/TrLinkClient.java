package com.silverhouse3.trailrunnerbridge;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.IBinder;
import android.os.Parcel;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Asks TR Link (dev.silverhouse3.trlink) to switch the iFit screen apps on/off. Bound-service call, answered
 * on the UI handler exactly once within ~timeoutMs. UNAVAILABLE = TR Link not installed / not answering to bind:
 * callers then behave exactly as chooser4 did.
 */
final class TrLinkClient {
    static final String PKG = "dev.silverhouse3.trlink";
    static final String SVC = "dev.silverhouse3.trlink.SwitchService";
    static final String DESC = "dev.silverhouse3.trlink.SWITCH";
    static final int MODE_IFIT = 0, MODE_TRAILRUNNER = 1;
    static final int UNAVAILABLE = 0, OK = 1, FAILED = 2;

    interface Callback { void done(int state, String msg); }

    private TrLinkClient() {}

    static void setMode(final Context ctx, final int mode, final int timeoutMs, final Handler ui, final Callback cb) {
        new Thread(new Runnable() { public void run() {
            final int[] state = {FAILED};
            final String[] msg = {"TR Link did not answer in time"};
            final CountDownLatch bound = new CountDownLatch(1);
            final IBinder[] binder = {null};
            final ServiceConnection sc = new ServiceConnection() {
                public void onServiceConnected(ComponentName n, IBinder b) { binder[0] = b; bound.countDown(); }
                public void onServiceDisconnected(ComponentName n) { }
            };
            boolean ok = false;
            try {
                Intent i = new Intent().setComponent(new ComponentName(PKG, SVC));
                ok = ctx.bindService(i, sc, Context.BIND_AUTO_CREATE);
            } catch (RuntimeException e) { ok = false; }
            if (!ok) { post(ui, cb, UNAVAILABLE, "TR Link not installed"); return; }
            boolean got = false;
            try { got = bound.await(3000, TimeUnit.MILLISECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            if (!got) { try { ctx.unbindService(sc); } catch (RuntimeException ig) { } post(ui, cb, UNAVAILABLE, "TR Link not answering"); return; }

            final CountDownLatch done = new CountDownLatch(1);
            Thread tx = new Thread(new Runnable() { public void run() {
                Parcel d = Parcel.obtain(), r = Parcel.obtain();
                try {
                    d.writeInterfaceToken(DESC);
                    d.writeInt(mode);
                    binder[0].transact(1, d, r, 0);
                    r.readException();
                    boolean good = r.readInt() == 1;
                    String m = r.readString();
                    synchronized (state) { state[0] = good ? OK : FAILED; msg[0] = m == null ? "" : m; }
                } catch (Exception e) {
                    synchronized (state) { state[0] = FAILED; msg[0] = "TR Link error: " + e.getClass().getSimpleName() + " " + e.getMessage(); }
                } finally {
                    d.recycle(); r.recycle(); done.countDown();
                    try { ctx.unbindService(sc); } catch (RuntimeException ig) { }
                }
            } }, "trlink-tx");
            tx.setDaemon(true);
            tx.start();
            try { done.await(timeoutMs, TimeUnit.MILLISECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            int s; String m;
            synchronized (state) { s = state[0]; m = msg[0]; }
            post(ui, cb, s, m);
        } }, "trlink-client").start();
    }

    private static void post(Handler ui, final Callback cb, final int s, final String m) {
        ui.post(new Runnable() { public void run() { cb.done(s, m); } });
    }
}
