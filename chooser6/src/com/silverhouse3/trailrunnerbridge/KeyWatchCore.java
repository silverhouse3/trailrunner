package com.silverhouse3.trailrunnerbridge;

import java.io.File;
import java.io.IOException;
import java.util.List;

/** Pure orchestration (no Android): tail -> parse -> double-press -> belt-zero gate. */
final class KeyWatchCore {
    interface Bridge { boolean up(); Double kph(); }

    private final LogTailer tailer;
    private final KeyLogParser parser = new KeyLogParser();
    private final DoublePressDetector det = new DoublePressDetector();
    private final Bridge bridge;
    private OpenGate gate;
    /** nanoTime - logTime anchor: min over reads of (readNanos - lastLogTs), i.e. the read with least lag. */
    private long anchor;
    private boolean hasAnchor;
    private long lastStopMs = Long.MIN_VALUE / 4;

    KeyWatchCore(File log, Bridge bridge) { tailer = new LogTailer(log); this.bridge = bridge; }

    int pressCount() { return parser.pressCount; }

    /** One poll. Returns true when the chooser should be opened now. Throws IOException on read trouble. */
    boolean step(long nowNanos) throws IOException {
        String chunk = tailer.poll();
        if (tailer.rotated) { parser.reset(); hasAnchor = false; }
        if (!chunk.isEmpty()) {
            List<Long> presses = parser.feed(chunk);
            if (parser.lastTs >= 0) {
                long est = nowNanos - parser.lastTs * 1000000L;
                if (!hasAnchor || est < anchor || est - anchor > 30000L * 1000000L) { anchor = est; hasAnchor = true; }
            }
            for (Long ts : presses) {
                // Read time (nanoTime) anchors the clock; log stamps give accurate gaps between presses read in different polls.
                long n = (ts >= 0 && hasAnchor) ? ts * 1000000L + anchor : nowNanos;
                lastStopMs = n / 1000000L;
                if (det.onPress(n) && gate == null) gate = new OpenGate(n / 1000000L);
            }
        }
        if (gate == null) return false;
        long nowMs = nowNanos / 1000000L;
        boolean up = bridge != null && bridge.up();
        Double bk = up ? bridge.kph() : null;
        OpenGate.Decision d = gate.tick(nowMs, lastStopMs, parser.lastKph, up, bk);
        if (d == OpenGate.Decision.WAIT) return false;
        gate = null;
        return d == OpenGate.Decision.OPEN;
    }
}
