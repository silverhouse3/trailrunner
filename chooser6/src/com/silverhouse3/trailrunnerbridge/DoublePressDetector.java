package com.silverhouse3.trailrunnerbridge;

/** Pure: two presses 0.15 s..2.0 s apart = double press; bounces ignored; 5 s quiet after a trigger. */
final class DoublePressDetector {
    static final long MIN_NS = 150000000L, MAX_NS = 2000000000L, QUIET_NS = 5000000000L;
    private boolean hasLast, hasQuiet;
    private long last, quietUntil;

    boolean onPress(long nanos) {
        if (hasQuiet && nanos - quietUntil < 0) return false;
        if (hasLast) {
            long gap = nanos - last;
            if (gap < MIN_NS) return false; // bounce
            if (gap <= MAX_NS) {
                hasLast = false;
                hasQuiet = true;
                quietUntil = nanos + QUIET_NS;
                return true;
            }
        }
        hasLast = true;
        last = nanos;
        return false;
    }
}
