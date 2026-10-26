package dev.silverhouse3.trlink;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** Per-key failure counter: more than/equal to maxFailures within windowMs => blocked. */
public final class RateLimiter {
    private final int maxFailures;
    private final long windowMs;
    private final Map<String, ArrayDeque<Long>> fails = new HashMap<String, ArrayDeque<Long>>();

    public RateLimiter(int maxFailures, long windowMs) {
        this.maxFailures = maxFailures;
        this.windowMs = windowMs;
    }

    public synchronized boolean blocked(String key, long now) {
        ArrayDeque<Long> q = fails.get(key);
        if (q == null) return false;
        prune(q, now);
        if (q.isEmpty()) { fails.remove(key); return false; }
        return q.size() >= maxFailures;
    }

    public synchronized void fail(String key, long now) {
        if (fails.size() > 1024) purge(now);
        ArrayDeque<Long> q = fails.get(key);
        if (q == null) {
            if (fails.size() > 2048) return; // memory cap; existing blocked keys stay blocked
            q = new ArrayDeque<Long>();
            fails.put(key, q);
        }
        prune(q, now);
        q.addLast(now);
        while (q.size() > maxFailures * 2) q.removeFirst();
    }

    private void prune(ArrayDeque<Long> q, long now) {
        while (!q.isEmpty() && now - q.peekFirst() >= windowMs) q.removeFirst();
    }

    private void purge(long now) {
        Iterator<Map.Entry<String, ArrayDeque<Long>>> it = fails.entrySet().iterator();
        while (it.hasNext()) {
            ArrayDeque<Long> q = it.next().getValue();
            prune(q, now);
            if (q.isEmpty()) it.remove();
        }
    }
}
