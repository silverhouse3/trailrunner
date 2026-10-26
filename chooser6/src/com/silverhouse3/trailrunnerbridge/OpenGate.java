package com.silverhouse3.trailrunnerbridge;

/**
 * Pure: after a double STOP, decides when it is safe to open the chooser (belt at zero).
 * Method (see README): log KPH line (SDS "Changed KPH") is used as a veto; plus >=3 s since the last STOP press;
 * plus bridge /health speed if the bridge answers. Gives up silently after 20 s.
 */
final class OpenGate {
    enum Decision { WAIT, OPEN, GIVE_UP }
    static final double ZERO_KPH = 0.3;
    static final long SETTLE_MS = 3000, GIVE_UP_MS = 20000;
    private final long triggerMs;

    OpenGate(long triggerMs) { this.triggerMs = triggerMs; }

    /** logKph / bridgeKph null = unknown (not a veto). bridgeUp=false means no bridge, so no belt motion from us. */
    Decision tick(long nowMs, long lastStopMs, Double logKph, boolean bridgeUp, Double bridgeKph) {
        boolean ok = nowMs - lastStopMs >= SETTLE_MS
            && (logKph == null || logKph <= ZERO_KPH)
            && (!bridgeUp || bridgeKph == null || bridgeKph <= ZERO_KPH);
        if (ok) return Decision.OPEN;
        return nowMs - triggerMs >= GIVE_UP_MS ? Decision.GIVE_UP : Decision.WAIT;
    }
}
