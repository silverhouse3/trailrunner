package com.silverhouse3.trailrunnerbridge;

import android.bluetooth.BluetoothA2dp;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothHeadset;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Bluetooth AUDIO (headphones) through the ANDROID BluetoothAdapter only. It never goes near the treadmill's iFit
 * Bluetooth service (glassos) or the heart-rate strap: every device is checked against BluetoothClass major
 * AUDIO_VIDEO (BtAudioCore.refusal) before bond / connect / disconnect / forget, and listings contain audio devices only.
 * No treadmill, bridge, belt, STOP or key code is used here.
 */
final class BluetoothAudio {
    private static final String TAG = "TRBtAudio";
    private static final String PREF = "tr", KEY_LAST = "bt_audio_last";
    static final int REQ_LOCATION = 74;

    private static BluetoothAudio inst;
    static synchronized BluetoothAudio get(Context c) {
        if (inst == null) inst = new BluetoothAudio(c.getApplicationContext());
        return inst;
    }

    /** Set by MainActivity: asks for ACCESS_COARSE_LOCATION on the UI thread (needed for discovery on API 23+). */
    static volatile Runnable locationRequester;

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, BtAudioCore.Dev> found = Collections.synchronizedMap(new LinkedHashMap<String, BtAudioCore.Dev>());
    private volatile BluetoothAdapter adapter;
    private volatile BluetoothA2dp a2dp;
    private volatile BluetoothHeadset headset;
    private volatile String lastError = "";
    private volatile String pairTarget = "";      // address of a bond we started
    private volatile boolean pinTried;
    private volatile long pairStartedAt;
    private volatile long userStopAt;            // last accepted user Disconnect/Forget (ms)
    private final Object tickLock = new Object();
    private volatile long userScanUntil;          // a user-started scan is considered active until then
    private volatile long lastAutoTry;
    private volatile int autoAttempts;
    private volatile long a2dpAskedAt, headsetAskedAt;
    private volatile boolean weStartedScan;
    private HandlerThread bgThread;
    private volatile Handler bg;
    private boolean started;

    private BluetoothAudio(Context c) {
        this.ctx = c;
        try {
            BluetoothManager m = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE);
            adapter = m != null ? m.getAdapter() : BluetoothAdapter.getDefaultAdapter();
        } catch (Exception e) { Log.w(TAG, "no adapter", e); }
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    synchronized void start() {
        if (started || adapter == null) return;
        started = true;
        IntentFilter f = new IntentFilter();
        f.addAction(BluetoothDevice.ACTION_FOUND);
        f.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
        f.addAction(BluetoothAdapter.ACTION_STATE_CHANGED);
        f.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        f.addAction("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED");
        f.addAction("android.bluetooth.headset.profile.action.CONNECTION_STATE_CHANGED");
        f.addAction(BluetoothDevice.ACTION_PAIRING_REQUEST);
        f.setPriority(IntentFilter.SYSTEM_HIGH_PRIORITY - 1);
        try { ctx.registerReceiver(rx, f); } catch (Exception e) { Log.w(TAG, "register failed", e); }
        bgThread = new HandlerThread("TRBtAudio");
        bgThread.start();
        bg = new Handler(bgThread.getLooper());   // adapter queries + reflective connect run here, not on the UI thread
        getProxies(true);
        scheduleTick(5000);   // first auto-reconnect try shortly after start, then with backoff
    }

    /** Requests each profile proxy only if THAT proxy is null and was not asked for in the last 60 s. */
    private synchronized void getProxies(boolean report) {
        if (adapter == null || !enabled()) return;     // Bluetooth off: no fresh registrations
        long now = System.currentTimeMillis();
        try {
            if (BtAudioCore.proxyDue(true, a2dp != null, now, a2dpAskedAt)) {
                a2dpAskedAt = now;
                adapter.getProfileProxy(ctx, new BluetoothProfile.ServiceListener() {
                    public void onServiceConnected(int p, BluetoothProfile proxy) {
                        BluetoothA2dp old = a2dp; a2dp = (BluetoothA2dp) proxy;
                        if (old != null && old != proxy) closeProxy(BluetoothProfile.A2DP, old);
                    }
                    public void onServiceDisconnected(int p) { a2dp = null; a2dpAskedAt = 0; }
                }, BluetoothProfile.A2DP);
            }
            if (BtAudioCore.proxyDue(true, headset != null, now, headsetAskedAt)) {
                headsetAskedAt = now;
                adapter.getProfileProxy(ctx, new BluetoothProfile.ServiceListener() {
                    public void onServiceConnected(int p, BluetoothProfile proxy) {
                        BluetoothHeadset old = headset; headset = (BluetoothHeadset) proxy;
                        if (old != null && old != proxy) closeProxy(BluetoothProfile.HEADSET, old);
                    }
                    public void onServiceDisconnected(int p) { headset = null; headsetAskedAt = 0; }
                }, BluetoothProfile.HEADSET);
            }
        } catch (Exception e) { Log.w(TAG, "getProfileProxy failed", e); if (report) lastError = "Could not reach the Bluetooth audio service: " + e.getMessage(); }
    }

    private void closeProxy(int profile, BluetoothProfile proxy) {
        try { if (adapter != null && proxy != null) adapter.closeProfileProxy(profile, proxy); } catch (Exception e) { Log.w(TAG, "closeProfileProxy", e); }
    }

    /** Bluetooth went off: release both proxies so they rebind cleanly when it comes back on. */
    private synchronized void dropProxies() {
        BluetoothA2dp a = a2dp; BluetoothHeadset h = headset;
        a2dp = null; headset = null; a2dpAskedAt = 0; headsetAskedAt = 0;
        if (a != null) closeProxy(BluetoothProfile.A2DP, a);
        if (h != null) closeProxy(BluetoothProfile.HEADSET, h);
    }

    private final Runnable tick = new Runnable() {
        public void run() {
            try { autoReconnect(); } catch (Throwable e) { Log.w(TAG, "auto", e); }
            if (bg == null) return;
            if (!BtAudioCore.autoExhausted(autoAttempts)) scheduleTick(BtAudioCore.backoffMs(autoAttempts));
            else Log.i(TAG, "auto-reconnect gave up until the app restarts or the user acts");
        }
    };

    /** The ONLY way the tick is queued: remove then post under one lock, so a single chain exists whatever thread calls. */
    private void scheduleTick(long delayMs) {
        synchronized (tickLock) {
            Handler h = bg;
            if (h == null) return;
            h.removeCallbacks(tick);
            h.postDelayed(tick, delayMs);
        }
    }

    /** Any explicit user action restarts the auto-reconnect schedule. */
    private void userActed() {
        autoAttempts = 0; lastAutoTry = 0;
        scheduleTick(BtAudioCore.RECONNECT_MS);
    }

    /** Bluetooth came back on: let background retries run again (not a user action, user_off is untouched). */
    private void userActedSoft() {
        autoAttempts = 0; lastAutoTry = 0;
        scheduleTick(5000);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private static int clsOf(BluetoothDevice d) {
        try { BluetoothClass c = d.getBluetoothClass(); return c == null ? -1 : c.getDeviceClass(); }
        catch (Exception e) { return -1; }
    }

    private boolean enabled() { try { return adapter != null && adapter.isEnabled(); } catch (Exception e) { return false; } }

    private BluetoothDevice dev(String address) {
        try { return adapter.getRemoteDevice(BtAudioCore.norm(address)); } catch (Exception e) { return null; }
    }

    private boolean hasLocation() {
        return ctx.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private SharedPreferences prefs() { return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE); }
    String last() { return prefs().getString(KEY_LAST, ""); }
    private void remember(String a) { prefs().edit().putString(KEY_LAST, BtAudioCore.norm(a)).apply(); }   // never touches user_off
    private boolean userOff() { return prefs().getBoolean("bt_audio_user_off", false); }
    private void userOffEvent(String ev) { prefs().edit().putBoolean("bt_audio_user_off", BtAudioCore.userOffNext(userOff(), ev)).apply(); }
    private void forgetLast(String a) { if (BtAudioCore.norm(a).equals(last())) prefs().edit().remove(KEY_LAST).apply(); }

    private boolean isConnected(BluetoothDevice d) {
        try {
            BluetoothA2dp p = a2dp;
            if (p != null && p.getConnectionState(d) == BluetoothProfile.STATE_CONNECTED) return true;
            BluetoothHeadset h = headset;
            return h != null && h.getConnectionState(d) == BluetoothProfile.STATE_CONNECTED;
        } catch (Exception e) { return false; }
    }

    private String connectedName() {
        for (BtAudioCore.Dev d : bondedList()) if (d.connected) return d.name;
        return null;
    }

    private List<BtAudioCore.Dev> bondedList() {
        List<BtAudioCore.Dev> out = new ArrayList<>();
        try {
            Set<BluetoothDevice> s = adapter == null ? null : adapter.getBondedDevices();
            if (s != null) for (BluetoothDevice d : s) {
                int c = clsOf(d);
                if (BtAudioCore.isAudioClass(c))
                    out.add(new BtAudioCore.Dev(d.getName() == null ? d.getAddress() : d.getName(), d.getAddress(), 0, isConnected(d), c));
            }
        } catch (Exception e) { Log.w(TAG, "bonded", e); }
        return out;
    }

    // ── bridge-facing API (all return JSON or a short status string) ────────

    String state() {
        List<BtAudioCore.Dev> f;
        synchronized (found) { f = new ArrayList<>(found.values()); }
        boolean disc = false;
        try { disc = adapter != null && adapter.isDiscovering(); } catch (Exception ignore) { }
        return BtAudioCore.stateJson(enabled(), disc, bondedList(), f, connectedName(), lastError);
    }

    String scan(boolean on) {
        lastError = "";
        if (adapter == null) { lastError = "This screen has no Bluetooth."; return state(); }
        if (!enabled()) { lastError = "Bluetooth is switched off."; return state(); }
        try {
            if (!on) {
                userScanUntil = 0; main.removeCallbacks(stopScan);
                cancelOwnDiscovery();
                return state();
            }
            if (!hasLocation()) {
                Runnable r = locationRequester;
                if (r != null) main.post(r);
                lastError = "Please tap Allow on the screen, then press Scan again.";
                return state();
            }
            found.clear();
            userScanUntil = System.currentTimeMillis() + BtAudioCore.SCAN_MS + 2000;
            if (!adapter.isDiscovering()) {      // someone else's discovery is left running; its results still reach us
                if (adapter.startDiscovery()) weStartedScan = true;
                else lastError = "Bluetooth could not start searching. Try again in a moment.";
            }
            main.removeCallbacks(stopScan);
            main.postDelayed(stopScan, BtAudioCore.SCAN_MS);
        } catch (Exception e) { lastError = "Search failed: " + e.getMessage(); }
        return state();
    }

    private final Runnable stopScan = new Runnable() {
        public void run() { cancelOwnDiscovery(); }
    };

    private void cancelOwnDiscovery() {
        try {
            if (adapter != null && BtAudioCore.shouldCancelDiscovery(weStartedScan, adapter.isDiscovering())) adapter.cancelDiscovery();
        } catch (Exception ignore) { }
        weStartedScan = false;
    }

    /** Check the device (class from the platform, never from the caller) and return a refusal or null. */
    private String check(String address, BluetoothDevice d) {
        if (d == null) return "That is not a valid Bluetooth address.";
        return BtAudioCore.refusal(address, clsOf(d));
    }

    String pair(String address) {
        lastError = "";
        if (!enabled()) { lastError = "Bluetooth is switched off."; return state(); }
        BluetoothDevice d = dev(address);
        String r = check(address, d);
        if (r != null) { lastError = r; Log.w(TAG, "pair refused " + address); return state(); }
        try {
            userActed(); userOffEvent("user_pair");
            userScanUntil = 0; main.removeCallbacks(stopScan);
            cancelOwnDiscovery();
            if (d.getBondState() == BluetoothDevice.BOND_BONDED) return connect(address);
            pairTarget = BtAudioCore.norm(address); pinTried = false; pairStartedAt = System.currentTimeMillis();
            main.postDelayed(pairTimeout, BtAudioCore.PAIR_TIMEOUT_MS);
            if (!d.createBond()) {
                clearPair();
                lastError = "Could not start pairing. Put the headphones in pairing mode and try again.";
            }
        } catch (Exception e) { lastError = "Pairing failed: " + e.getMessage(); }
        return state();
    }

    private void clearPair() { pairTarget = ""; pairStartedAt = 0; main.removeCallbacks(pairTimeout); }

    private final Runnable pairTimeout = new Runnable() {
        public void run() {
            try {
                if (!pairTarget.isEmpty() && BtAudioCore.pairExpired(pairStartedAt, System.currentTimeMillis())) {
                    BluetoothDevice d = dev(pairTarget);
                    if (d != null) { try { BluetoothDevice.class.getMethod("cancelBondProcess").invoke(d); } catch (Exception e) { Log.w(TAG, "cancelBondProcess: " + e); } }
                    clearPair();
                    if (lastError.isEmpty()) lastError = BtAudioCore.bondFailText(2);
                }
            } catch (Throwable t) { Log.w(TAG, "pairTimeout", t); }
        }
    };

    String connect(String address) { return connect(address, MODE_USER); }

    private static final int MODE_USER = 0, MODE_AUTO = 1, MODE_POSTBOND = 2;

    /**
     * MODE_USER: explicit connect (clears user_off, cancels our discovery, reports errors).
     * MODE_AUTO: background retry. Never cancels discovery, never asks for proxies, never touches lastError or user_off.
     * MODE_POSTBOND: follows our own pairing: reports errors but never touches user_off.
     */
    private String connect(String address, int mode) {
        if (mode == MODE_AUTO) { connectImpl(address, mode); return ""; }
        lastError = "";
        String err = connectImpl(address, mode);
        lastError = err;
        return state();
    }

    /** Returns "" on success or the error text. Writes lastError never. */
    private String connectImpl(String address, int mode) {
        if (!enabled()) return "Bluetooth is switched off.";
        BluetoothDevice d = dev(address);
        String r = check(address, d);
        if (r != null) return r;
        if (d.getBondState() != BluetoothDevice.BOND_BONDED) return "Pair the headphones first.";
        if (mode == MODE_USER) { userActed(); userOffEvent("user_connect"); cancelOwnDiscovery(); }   // only an ACCEPTED explicit connect re-enables auto
        boolean any = false; String err = "";
        if (a2dp == null && headset == null) {
            if (mode != MODE_AUTO) getProxies(true);
            err = "Bluetooth audio service is still starting. Try again in a few seconds.";
        }
        if (a2dp != null) {
            reflect(a2dp, "setPriority", new Class<?>[]{BluetoothDevice.class, int.class}, d, 100);   // best effort; ignore failure
            Object ok = reflectObj(a2dp, "connect", d);
            if (Boolean.TRUE.equals(ok)) any = true; else err = "The audio connection was refused (A2DP).";
        }
        if (headset != null) {
            Object ok = reflectObj(headset, "connect", d);
            if (Boolean.TRUE.equals(ok)) any = true;     // headset profile is optional: its failure is not an error
        }
        if (any) { remember(address); return ""; }
        return err.isEmpty() ? "Could not connect. Check the headphones are on and close by." : err;
    }

    String disconnect(String address) {
        lastError = "";
        BluetoothDevice d = dev(address);
        String r = check(address, d);
        if (r != null) { lastError = r; return state(); }
        userStopAt = System.currentTimeMillis();
        if (BtAudioCore.norm(address).equals(last())) userOffEvent("user_disconnect");   // user disconnect: no auto-reconnect until an explicit Connect/Pair
        if (a2dp != null) reflectObj(a2dp, "disconnect", d);
        if (headset != null) reflectObj(headset, "disconnect", d);
        return state();
    }

    String forget(String address) {
        lastError = "";
        BluetoothDevice d = dev(address);
        String r = check(address, d);
        if (r != null) { lastError = r; return state(); }
        userStopAt = System.currentTimeMillis();
        if (BtAudioCore.norm(address).equals(pairTarget)) clearPair();
        try {
            if (a2dp != null) reflectObj(a2dp, "disconnect", d);
            if (headset != null) reflectObj(headset, "disconnect", d);
            Method m = BluetoothDevice.class.getMethod("removeBond");
            Object ok = m.invoke(d);
            if (!Boolean.TRUE.equals(ok)) lastError = "Could not remove the headphones.";
        } catch (Exception e) { lastError = "Could not remove the headphones: " + e.getClass().getSimpleName(); }
        // Even if removal failed, never let auto-reconnect bring them back.
        if (BtAudioCore.norm(address).equals(last())) userOffEvent("forget");
        forgetLast(address);
        return state();
    }

    private static Object reflectObj(Object target, String name, BluetoothDevice d) {
        try {
            Method m = target.getClass().getMethod(name, BluetoothDevice.class);
            return m.invoke(target, d);
        } catch (Exception e) { Log.w(TAG, name + " reflection failed: " + e); return null; }
    }

    private static String reflect(Object target, String name, Class<?>[] sig, Object... args) {
        try { target.getClass().getMethod(name, sig).invoke(target, args); return ""; }
        catch (Exception e) { return String.valueOf(e); }
    }

    // ── auto-reconnect (only the remembered device) ─────────────────────────

    private void autoReconnect() {
        String last = last();
        if (!BtAudioCore.validAddress(last)) return;
        if (!enabled()) return;                      // Bluetooth off: no proxies, no attempt
        BluetoothDevice d = dev(last);
        boolean bonded = d != null && d.getBondState() == BluetoothDevice.BOND_BONDED;
        boolean audio = d != null && BtAudioCore.isAudioClass(clsOf(d));
        if (a2dp == null && headset == null) {      // nothing to connect through: rebind, do not count an attempt
            getProxies(false);
            if (!BtAudioCore.countsAsAttempt(false)) return;
        }
        boolean anyConn = false;
        for (BtAudioCore.Dev b : bondedList()) if (b.connected) anyConn = true;
        autoAttempts = BtAudioCore.attemptsAfterTick(autoAttempts, anyConn);
        if (anyConn) lastAutoTry = 0;
        long now = System.currentTimeMillis();
        boolean pairing = !pairTarget.isEmpty();
        boolean disc = now < userScanUntil;
        try { disc = disc || adapter.isDiscovering(); } catch (Exception ignore) { }
        if (BtAudioCore.shouldAutoReconnect(last, enabled(), bonded, audio, anyConn, pairing, disc, userOff(), autoAttempts, now, lastAutoTry)) {
            lastAutoTry = now;
            autoAttempts++;
            Log.i(TAG, "auto-reconnect " + last + " try " + autoAttempts);
            connect(last, MODE_AUTO);   // background attempts never touch lastError
        }
    }

    // ── receivers ───────────────────────────────────────────────────────────

    private final BroadcastReceiver rx = new BroadcastReceiver() {
        public void onReceive(Context c, Intent i) {
            try {
                String a = i.getAction();
                BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (BluetoothDevice.ACTION_FOUND.equals(a) && d != null) {
                    BluetoothClass bc = i.getParcelableExtra(BluetoothDevice.EXTRA_CLASS);
                    int cls = bc == null ? clsOf(d) : bc.getDeviceClass();
                    if (!BtAudioCore.isAudioClass(cls)) return;                      // heart-rate straps, phones etc. never listed
                    short rssi = i.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE);
                    String n = i.getStringExtra(BluetoothDevice.EXTRA_NAME);
                    if (n == null) n = d.getName();
                    found.put(BtAudioCore.norm(d.getAddress()), new BtAudioCore.Dev(n == null ? d.getAddress() : n, d.getAddress(), rssi == Short.MIN_VALUE ? -100 : rssi, false, cls));
                } else if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(a) && d != null) {
                    onBond(d, i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR));
                } else if (BluetoothDevice.ACTION_PAIRING_REQUEST.equals(a) && d != null) {
                    onPairingRequest(d, i);
                } else if (a != null && a.endsWith("profile.action.CONNECTION_STATE_CHANGED") && d != null) {
                    if (i.getIntExtra("android.bluetooth.profile.extra.STATE", 0) == BluetoothProfile.STATE_CONNECTED
                        && BtAudioCore.isAudioClass(clsOf(d))) { remember(d.getAddress()); lastError = ""; autoAttempts = 0; lastAutoTry = 0; }
                } else if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(a)) {
                    int st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
                    if (st == BluetoothAdapter.STATE_OFF || st == BluetoothAdapter.STATE_TURNING_OFF) { dropProxies(); weStartedScan = false; }
                    else if (st == BluetoothAdapter.STATE_ON) { getProxies(false); userActedSoft(); }
                } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(a)) {
                    weStartedScan = false;
                }
            } catch (Exception e) { Log.w(TAG, "receiver", e); }
        }
    };

    private void onBond(BluetoothDevice d, int st) {
        if (!BtAudioCore.norm(d.getAddress()).equals(pairTarget)) return;    // only the bond WE started
        if (st == BluetoothDevice.BOND_BONDED) {
            final long startedAt = pairStartedAt;
            clearPair();
            found.remove(BtAudioCore.norm(d.getAddress()));
            final String addr = d.getAddress();
            Handler h = bg;
            if (h != null) h.postDelayed(new Runnable() {
                public void run() {
                    try {
                        // follows an explicit pair, unless the user pressed Disconnect/Forget since pairing started
                        if (BtAudioCore.postBondConnectAllowed(startedAt, userStopAt)) connect(addr, MODE_POSTBOND);
                        else Log.i(TAG, "post-bond connect skipped: user disconnected/forgot since pairing started");
                    } catch (Throwable t) { Log.w(TAG, "post-bond connect", t); }
                }
            }, 1000);
        } else if (st == BluetoothDevice.BOND_NONE) {
            clearPair();
            int reason = 0;
            lastError = lastError.isEmpty() ? BtAudioCore.bondFailText(reason) : lastError;
        }
    }

    private void onPairingRequest(BluetoothDevice d, Intent i) {
        if (!BtAudioCore.norm(d.getAddress()).equals(pairTarget)) return;    // not ours: leave it to the system
        int v = i.getIntExtra("android.bluetooth.device.extra.PAIRING_VARIANT", -1);
        try {
            switch (v) {
                case 0:   // PIN
                    if (BtAudioCore.mayTryLegacyPin(pinTried)) {
                        pinTried = true;
                        if (d.setPin("0000".getBytes("UTF-8"))) { abortBroadcast0(); }
                    } else { lastError = "These headphones need a pairing code. Check their manual."; }
                    break;
                case 2:   // passkey confirmation (numeric comparison)
                case 3:   // consent (Just Works)
                    try { d.getClass().getMethod("setPairingConfirmation", boolean.class).invoke(d, true); abortBroadcast0(); }
                    catch (Exception e) { /* needs a privileged permission on API 25: the system dialog will appear instead */ }
                    break;
                default:  // 1 passkey entry, 4 display passkey, 5 display PIN
                    lastError = "These headphones want a code typed in, which is not supported here.";
            }
        } catch (Exception e) { lastError = "Pairing request failed: " + e.getMessage(); }
    }

    private void abortBroadcast0() { try { rx.abortBroadcast(); } catch (Exception ignore) { } }
}
