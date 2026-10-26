package com.silverhouse3.trailrunnerbridge;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure: turns raw log text (arbitrary chunking) into STOP-press events and the last reported KPH. */
final class KeyLogParser {
    static final Pattern PRESS = Pattern.compile("KEY_OBJECT from KeyPress\\(code=NO_KEY[^)]*\\) to KeyPress\\(code=STOP");
    static final Pattern KPH = Pattern.compile("Changed KPH from -?[0-9.]+ kph to (-?[0-9.]+) kph");
    static final Pattern TS = Pattern.compile("^(\\d\\d):(\\d\\d):(\\d\\d)\\.(\\d\\d\\d)");
    static final long DAY_MS = 86400000L;

    private final StringBuilder carry = new StringBuilder();
    /** Last "Changed KPH ... to X kph" value seen since start, or null if none yet. */
    Double lastKph;
    /** Total STOP presses counted (the only thing ever logged). */
    int pressCount;
    /** Log time-of-day (ms) of the last line fed that carried a timestamp, or -1. */
    long lastTs = -1;
    private long dayBase, prevTs = -1;

    /** Drops a partial line (call after log rotation). */
    void reset() { carry.setLength(0); dayBase = 0; prevTs = -1; lastTs = -1; }

    /** Returns monotonic (midnight-unwrapped) log time ms for each new STOP press in this chunk (-1 if the line had no timestamp). */
    List<Long> feed(String chunk) {
        List<Long> out = new ArrayList<>();
        carry.append(chunk);
        int nl;
        while ((nl = carry.indexOf("\n")) >= 0) {
            String line = carry.substring(0, nl);
            carry.delete(0, nl + 1);
            long ts = -1;
            Matcher t = TS.matcher(line);
            if (t.find()) {
                ts = ((Integer.parseInt(t.group(1)) * 60L + Integer.parseInt(t.group(2))) * 60L + Integer.parseInt(t.group(3))) * 1000L
                    + Integer.parseInt(t.group(4));
                if (prevTs >= 0 && ts + dayBase < prevTs - DAY_MS / 2) dayBase += DAY_MS; // midnight wrap
                ts += dayBase;
                prevTs = ts;
                lastTs = ts;
            }
            if (line.contains("Changed KPH")) {
                Matcher k = KPH.matcher(line);
                if (k.find()) {
                    try { lastKph = Double.valueOf(k.group(1)); } catch (NumberFormatException ignored) { }
                }
            }
            if (line.contains("KEY_OBJECT") && PRESS.matcher(line).find()) { pressCount++; out.add(ts); }
        }
        if (carry.length() > 65536) carry.setLength(0); // runaway line without newline
        return out;
    }
}
