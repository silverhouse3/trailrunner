package dev.silverhouse3.trlink;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/** Fixed-size, thread-safe ring buffer of timestamped event strings. */
public final class EventRing {
    private final String[] buf;
    private final long[] ts;
    private int next = 0;
    private int count = 0;

    public EventRing(int capacity) {
        if (capacity < 1) throw new IllegalArgumentException();
        buf = new String[capacity];
        ts = new long[capacity];
    }

    public synchronized void add(String msg) {
        add(System.currentTimeMillis(), msg);
    }

    public synchronized void add(long when, String msg) {
        if (msg == null) msg = "";
        if (msg.length() > 200) msg = msg.substring(0, 200);
        buf[next] = msg;
        ts[next] = when;
        next = (next + 1) % buf.length;
        if (count < buf.length) count++;
    }

    public synchronized int size() { return count; }

    /** Newest-last list of the most recent n entries, formatted "ISO-UTC message". */
    public synchronized List<String> last(int n) {
        if (n > count) n = count;
        if (n < 0) n = 0;
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        List<String> out = new ArrayList<String>(n);
        int start = (next - n + buf.length * 2) % buf.length;
        for (int i = 0; i < n; i++) {
            int idx = (start + i) % buf.length;
            out.add(f.format(new Date(ts[idx])) + " " + buf[idx]);
        }
        return out;
    }
}
