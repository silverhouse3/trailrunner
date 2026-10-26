package com.silverhouse3.trailrunnerbridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Pure logic for headphone pairing (no android.* imports, so it runs in the plain-JVM tests).
 * Headphones ONLY: a device is eligible when its Bluetooth major class is AUDIO_VIDEO (0x0400:
 * headset, headphones, speaker, car audio ...). Unknown class (BLE-only strap, class missing) = refused.
 */
final class BtAudioCore {
    private BtAudioCore() { }

    static final int MAJOR_MASK = 0x1F00;
    static final int MAJOR_AUDIO_VIDEO = 0x0400;
    static final int MAJOR_HEALTH = 0x0900;
    static final long SCAN_MS = 30000L;
    static final long RECONNECT_MS = 30000L;

    /** deviceClass = BluetoothClass.getBluetoothClass().getClass(), or -1 when unknown. */
    static boolean isAudioClass(int deviceClass) {
        return deviceClass > 0 && (deviceClass & MAJOR_MASK) == MAJOR_AUDIO_VIDEO;
    }

    static boolean validAddress(String a) {
        return a != null && a.matches("([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}");
    }

    static String norm(String a) { return a == null ? "" : a.trim().toUpperCase(Locale.ROOT); }

    /** null = allowed; otherwise a plain-English refusal. Used by pair / connect / disconnect / forget. */
    static String refusal(String address, int deviceClass) {
        if (!validAddress(address)) return "That is not a valid Bluetooth address.";
        if (!isAudioClass(deviceClass)) return "That device is not headphones or a speaker, so it was left alone.";
        return null;
    }

    static final class Dev {
        final String name, address; final int rssi; final boolean connected; final int cls;
        Dev(String name, String address, int rssi, boolean connected, int cls) {
            this.name = name; this.address = address; this.rssi = rssi; this.connected = connected; this.cls = cls;
        }
    }

    /** Keeps audio devices only (and drops duplicates by address), strongest signal first. */
    static List<Dev> filterAudio(List<Dev> in) {
        List<Dev> out = new ArrayList<>();
        List<String> seen = new ArrayList<>();
        for (Dev d : in) {
            if (d == null || !isAudioClass(d.cls) || !validAddress(d.address)) continue;
            String k = norm(d.address);
            if (seen.contains(k)) continue;
            seen.add(k); out.add(d);
        }
        Collections.sort(out, new Comparator<Dev>() {
            public int compare(Dev a, Dev b) { return b.rssi - a.rssi; }
        });
        return out;
    }

    static String jsonStr(String s) {
        if (s == null) return "\"\"";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    /** {enabled,discovering,bonded:[{name,address,connected}],found:[{name,address,rssi}],connected,lastError}. */
    static String stateJson(boolean enabled, boolean discovering, List<Dev> bonded, List<Dev> found,
                            String connectedName, String lastError) {
        StringBuilder b = new StringBuilder("{");
        b.append("\"enabled\":").append(enabled).append(",\"discovering\":").append(discovering).append(",\"bonded\":[");
        boolean first = true;
        for (Dev d : filterAudio(bonded)) {
            if (!first) b.append(','); first = false;
            b.append("{\"name\":").append(jsonStr(d.name)).append(",\"address\":").append(jsonStr(norm(d.address)))
             .append(",\"connected\":").append(d.connected).append('}');
        }
        b.append("],\"found\":[");
        first = true;
        for (Dev d : filterAudio(found)) {
            if (!first) b.append(','); first = false;
            b.append("{\"name\":").append(jsonStr(d.name)).append(",\"address\":").append(jsonStr(norm(d.address)))
             .append(",\"rssi\":").append(d.rssi).append('}');
        }
        b.append("],\"connected\":").append(connectedName == null ? "null" : jsonStr(connectedName))
         .append(",\"lastError\":").append(jsonStr(lastError == null ? "" : lastError)).append('}');
        return b.toString();
    }

    static final long PAIR_TIMEOUT_MS = 60000L;
    static final int MAX_AUTO_TRIES = 12;

    /** Delay before the next auto-reconnect tick: 30 s, 60 s, then 5 min cap. */
    static long backoffMs(int attempts) {
        if (attempts <= 0) return RECONNECT_MS;
        if (attempts == 1) return 2 * RECONNECT_MS;
        return 300000L;
    }

    /** True once we should stop retrying until the app restarts or the user acts. */
    static boolean autoExhausted(int attempts) { return attempts >= MAX_AUTO_TRIES; }

    /** A pairing target older than PAIR_TIMEOUT_MS is stale and must be cleared. */
    static boolean pairExpired(long startedMs, long nowMs) { return startedMs > 0 && nowMs - startedMs >= PAIR_TIMEOUT_MS; }

    /**
     * Auto-reconnect decision: only the remembered headphones, only when Bluetooth is on, they are still bonded,
     * the user has not disconnected them, no discovery (the user's scan or anyone else's) is running, nothing is
     * connected/pairing, retries are not exhausted, and the backoff delay has passed since the last try.
     */
    static boolean shouldAutoReconnect(String lastAddr, boolean enabled, boolean lastBonded, boolean lastIsAudio,
                                       boolean anyAudioConnected, boolean busy, boolean discovering,
                                       boolean userDisconnected, int attempts, long nowMs, long lastTryMs) {
        if (!validAddress(lastAddr) || !enabled || !lastBonded || !lastIsAudio) return false;
        if (anyAudioConnected || busy || discovering || userDisconnected || autoExhausted(attempts)) return false;
        return lastTryMs <= 0 || nowMs - lastTryMs >= backoffMs(attempts);
    }

    /** Consecutive-failure counter: any success (device seen connected, or CONNECTED broadcast) resets it. */
    static int attemptsAfterTick(int attempts, boolean anyAudioConnected) { return anyAudioConnected ? 0 : attempts; }

    /** An attempt is only counted when a profile proxy exists to connect through (else we only rebind). */
    static boolean countsAsAttempt(boolean haveA2dpOrHeadsetProxy) { return haveA2dpOrHeadsetProxy; }

    /**
     * user_off flag rules. Only explicit user actions change it: connect / pair clear it, disconnect / forget set it.
     * Broadcasts ("receiver_connected") and background retries never change it.
     */
    static boolean userOffNext(boolean current, String event) {
        if ("user_connect".equals(event) || "user_pair".equals(event)) return false;
        if ("user_disconnect".equals(event) || "forget".equals(event)) return true;
        return current;
    }

    /** Cancel discovery only if WE started it (never someone else's, e.g. iFit's). */
    static boolean shouldCancelDiscovery(boolean weStarted, boolean discovering) { return weStarted && discovering; }

    /** Legacy PIN request: try 0000 once per bond attempt. */
    static boolean mayTryLegacyPin(boolean alreadyTried) { return !alreadyTried; }

    /** Plain-English text for a BluetoothDevice.EXTRA_REASON / bond failure. */
    static String bondFailText(int reason) {
        switch (reason) {
            case 1: return "The headphones refused the pairing. Put them back in pairing mode and try again.";
            case 2: return "Pairing timed out. Hold the headphones' pairing button until the light flashes, then try again.";
            case 4: return "The headphones are not responding. Check they are in pairing mode and close to the screen.";
            default: return "Pairing did not work. Put the headphones in pairing mode and try again.";
        }
    }

    /** A profile proxy may be requested only while Bluetooth is on, the proxy is missing, and not asked for in the last 60 s. */
    static boolean proxyDue(boolean btEnabled, boolean haveProxy, long nowMs, long askedAtMs) {
        return btEnabled && !haveProxy && nowMs - askedAtMs >= 60000L;
    }

    /**
     * Post-bond connect is skipped when the user disconnected/forgot something at or after pairing started
     * (userStopAtMs = time of the latest accepted user Disconnect/Forget, 0 = never).
     */
    static boolean postBondConnectAllowed(long pairStartedMs, long userStopAtMs) {
        return pairStartedMs > 0 && (userStopAtMs <= 0 || userStopAtMs < pairStartedMs);
    }
}
