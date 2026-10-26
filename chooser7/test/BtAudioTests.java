package com.silverhouse3.trailrunnerbridge;

import java.util.*;

public class BtAudioTests {
    static int pass, fail;
    static void check(String n, boolean ok) { if (ok) pass++; else { fail++; System.out.println("FAIL " + n); } }
    static final int HEADSET = 0x0404, HEADPHONES = 0x0418, SPEAKER = 0x0414, HR_STRAP = 0x0900 | 0x04, PHONE = 0x020C, UNKNOWN = -1, ZERO = 0;
    static BtAudioCore.Dev d(String n, String a, int rssi, boolean c, int cls) { return new BtAudioCore.Dev(n, a, rssi, c, cls); }

    public static void main(String[] x) {
        check("headset audio", BtAudioCore.isAudioClass(HEADSET));
        check("headphones audio", BtAudioCore.isAudioClass(HEADPHONES));
        check("speaker audio", BtAudioCore.isAudioClass(SPEAKER));
        check("health not audio", !BtAudioCore.isAudioClass(HR_STRAP));
        check("phone not audio", !BtAudioCore.isAudioClass(PHONE));
        check("unknown not audio", !BtAudioCore.isAudioClass(UNKNOWN) && !BtAudioCore.isAudioClass(ZERO));
        check("valid addr", BtAudioCore.validAddress("AA:BB:CC:00:11:22") && !BtAudioCore.validAddress("AA:BB") && !BtAudioCore.validAddress(null) && !BtAudioCore.validAddress("AA:BB:CC:00:11:22; rm"));
        check("refuse hr strap", BtAudioCore.refusal("AA:BB:CC:00:11:22", HR_STRAP) != null);
        check("refuse unknown class", BtAudioCore.refusal("AA:BB:CC:00:11:22", UNKNOWN) != null);
        check("refuse bad addr", BtAudioCore.refusal("nope", HEADSET) != null);
        check("allow headphones", BtAudioCore.refusal("aa:bb:cc:00:11:22", HEADPHONES) == null);

        List<BtAudioCore.Dev> in = new ArrayList<>(Arrays.asList(
            d("Polar H10", "11:11:11:11:11:11", -40, false, HR_STRAP),
            d("Weak Buds", "22:22:22:22:22:22", -80, false, HEADSET),
            d("Strong Cans", "33:33:33:33:33:33", -45, false, HEADPHONES),
            d("Dup Cans", "33:33:33:33:33:33", -30, false, HEADPHONES),
            d("Phone", "44:44:44:44:44:44", -20, false, PHONE),
            d("Bad", "zz", -10, false, HEADSET), null));
        List<BtAudioCore.Dev> f = BtAudioCore.filterAudio(in);
        check("filter count 2", f.size() == 2);
        check("sorted by signal", f.get(0).name.equals("Strong Cans") && f.get(1).name.equals("Weak Buds"));
        check("strap never listed", !BtAudioCore.stateJson(true, true, in, in, null, "").contains("Polar"));

        String j = BtAudioCore.stateJson(true, false,
            Arrays.asList(d("My \"Buds\"", "aa:bb:cc:dd:ee:ff", 0, true, HEADSET), d("Strap", "11:11:11:11:11:11", 0, true, HR_STRAP)),
            Arrays.asList(d("Cans", "33:33:33:33:33:33", -50, false, HEADPHONES)), "My \"Buds\"", "oops\nline");
        check("json bonded", j.contains("\"bonded\":[{\"name\":\"My \\\"Buds\\\"\",\"address\":\"AA:BB:CC:DD:EE:FF\",\"connected\":true}]"));
        check("json found", j.contains("\"found\":[{\"name\":\"Cans\",\"address\":\"33:33:33:33:33:33\",\"rssi\":-50}]"));
        check("json connected+err", j.contains("\"connected\":\"My \\\"Buds\\\"\"") && j.contains("\"lastError\":\"oops\\nline\""));
        check("json flags", j.startsWith("{\"enabled\":true,\"discovering\":false,"));
        String e = BtAudioCore.stateJson(false, false, new ArrayList<BtAudioCore.Dev>(), new ArrayList<BtAudioCore.Dev>(), null, null);
        check("json empty", e.equals("{\"enabled\":false,\"discovering\":false,\"bonded\":[],\"found\":[],\"connected\":null,\"lastError\":\"\"}"));

        String A = "AA:BB:CC:00:11:22";
        long T = 1000000;
        // args: last, enabled, bonded, audio, anyConnected, busy, discovering, userDisconnected, attempts, now, lastTry
        check("auto: ok", BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, 0, T, 0));
        check("auto: no last", !BtAudioCore.shouldAutoReconnect("", true, true, true, false, false, false, false, 0, T, 0));
        check("auto: bt off", !BtAudioCore.shouldAutoReconnect(A, false, true, true, false, false, false, false, 0, T, 0));
        check("auto: not bonded", !BtAudioCore.shouldAutoReconnect(A, true, false, true, false, false, false, false, 0, T, 0));
        check("auto: not audio", !BtAudioCore.shouldAutoReconnect(A, true, true, false, false, false, false, false, 0, T, 0));
        check("auto: already connected", !BtAudioCore.shouldAutoReconnect(A, true, true, true, true, false, false, false, 0, T, 0));
        check("auto: busy pairing", !BtAudioCore.shouldAutoReconnect(A, true, true, true, false, true, false, false, 0, T, 0));
        check("1 auto: skipped while discovering (user scan)", !BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, true, false, 0, T, 0));
        check("2 auto: skipped after user disconnect", !BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, true, 0, T, 0));
        check("auto: too soon (30s)", !BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, 0, T, T - 10000));
        check("auto: after 30s", BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, 0, T, T - 30000));
        check("4 backoff 30/60/300", BtAudioCore.backoffMs(0) == 30000 && BtAudioCore.backoffMs(1) == 60000 && BtAudioCore.backoffMs(2) == 300000 && BtAudioCore.backoffMs(9) == 300000);
        check("4 backoff: 2nd try needs 60s", !BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, 1, T, T - 45000)
            && BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, 1, T, T - 60000));
        check("4 backoff: later tries need 5 min", !BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, 5, T, T - 200000)
            && BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, 5, T, T - 300000));
        check("4 gives up after max tries", BtAudioCore.autoExhausted(BtAudioCore.MAX_AUTO_TRIES) && !BtAudioCore.autoExhausted(BtAudioCore.MAX_AUTO_TRIES - 1)
            && !BtAudioCore.shouldAutoReconnect(A, true, true, true, false, false, false, false, BtAudioCore.MAX_AUTO_TRIES, T, 0));
        check("3 pair timeout 60s", !BtAudioCore.pairExpired(T, T + 59000) && BtAudioCore.pairExpired(T, T + 60000) && !BtAudioCore.pairExpired(0, T));
        check("1 attempts reset when device seen connected", BtAudioCore.attemptsAfterTick(7, true) == 0 && BtAudioCore.attemptsAfterTick(7, false) == 7);
        check("1 reset restores 30s interval", BtAudioCore.backoffMs(BtAudioCore.attemptsAfterTick(11, true)) == 30000);
        check("1 after reset not exhausted", !BtAudioCore.autoExhausted(BtAudioCore.attemptsAfterTick(BtAudioCore.MAX_AUTO_TRIES, true)));
        check("2 no attempt counted without a proxy", !BtAudioCore.countsAsAttempt(false) && BtAudioCore.countsAsAttempt(true));
        check("3 user_connect / user_pair clear user_off", !BtAudioCore.userOffNext(true, "user_connect") && !BtAudioCore.userOffNext(true, "user_pair"));
        check("3 refused connect leaves user_off alone (no event)", BtAudioCore.userOffNext(true, "refused_connect") && !BtAudioCore.userOffNext(false, "refused_connect"));
        check("4 receiver CONNECTED never clears user_off", BtAudioCore.userOffNext(true, "receiver_connected"));
        check("4 auto retry never clears user_off", BtAudioCore.userOffNext(true, "auto_connect"));
        check("4 disconnect and forget set user_off", BtAudioCore.userOffNext(false, "user_disconnect") && BtAudioCore.userOffNext(false, "forget"));
        check("6 cancel discovery only if we started it", BtAudioCore.shouldCancelDiscovery(true, true)
            && !BtAudioCore.shouldCancelDiscovery(false, true) && !BtAudioCore.shouldCancelDiscovery(true, false));
        check("pin once", BtAudioCore.mayTryLegacyPin(false) && !BtAudioCore.mayTryLegacyPin(true));
        check("fail text", BtAudioCore.bondFailText(2).contains("timed out") && !BtAudioCore.bondFailText(99).isEmpty());
        // v7 hardening
        check("proxy not due when BT off", !BtAudioCore.proxyDue(false, false, 1000000L, 0));
        check("proxy not due when held", !BtAudioCore.proxyDue(true, true, 1000000L, 0));
        check("proxy not due within 60s", !BtAudioCore.proxyDue(true, false, 100000L, 50000L));
        check("proxy due after 60s", BtAudioCore.proxyDue(true, false, 110000L, 50000L));
        check("proxy due first time", BtAudioCore.proxyDue(true, false, 1000000L, 0));
        check("postbond allowed no user stop", BtAudioCore.postBondConnectAllowed(5000L, 0));
        check("postbond allowed old stop", BtAudioCore.postBondConnectAllowed(5000L, 4000L));
        check("postbond blocked stop after start", !BtAudioCore.postBondConnectAllowed(5000L, 5500L));
        check("postbond blocked stop same ms", !BtAudioCore.postBondConnectAllowed(5000L, 5000L));
        check("postbond blocked no pair start", !BtAudioCore.postBondConnectAllowed(0, 0));
        check("postbond does not alter user_off", BtAudioCore.userOffNext(true, "postbond_connect") && !BtAudioCore.userOffNext(false, "postbond_connect"));
        System.out.println("BtAudioTests: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }
}
