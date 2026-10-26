package dev.silverhouse3.trlink;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * TrailRunner mode: iFit screen apps (rivendell, gandalf, mithlond) disabled-user. iFit mode: all enabled.
 * Only an exact allow-list of shell commands can ever be executed. Never touches glassos_service or the launcher.
 * Pure java.* (Shell/Probe are injected) so it is unit-testable on a JVM.
 */
public final class Switcher {
    public interface Shell { String exec(String cmd) throws IOException; }
    public interface Probe {
        boolean motorOk();        // TCP connect localhost:54321
        boolean bridgeLinkOk();   // true when bridge not running, or its /health says "link":"ok"
    }
    public static final class Result {
        public final boolean ok; public final String msg;
        Result(boolean ok, String msg) { this.ok = ok; this.msg = msg; }
        public String toString() { return (ok ? "OK " : "FAIL ") + msg; }
    }

    public static final String[] PKGS = {"com.ifit.rivendell", "com.ifit.gandalf", "com.ifit.mithlond"};
    public static final String LIST_DISABLED = "pm list packages -d";
    static final Set<String> ALLOWED = new HashSet<String>();
    static {
        ALLOWED.add(LIST_DISABLED);
        ALLOWED.add("echo trlink");
        for (String p : PKGS) {
            ALLOWED.add("pm disable-user --user 0 " + p);
            ALLOWED.add("pm enable --user 0 " + p);
        }
    }
    /** Packages that must never appear in a disabled state because of us (reported if they do). */
    static final String[] PROTECTED = {"com.ifit.glassos_service", "com.ifit.launcher"};

    private final Shell shell;
    private final Probe probe;
    private final EventRing log;
    private final long settleMs;
    private volatile boolean explicitRequest = false;
    private volatile String lastMode = "unknown";

    public Switcher(Shell shell, Probe probe, EventRing log, long settleMs) {
        this.shell = shell; this.probe = probe; this.log = log; this.settleMs = settleMs;
    }

    public String lastMode() { return lastMode; }
    public boolean hadExplicitRequest() { return explicitRequest; }

    private String run(String cmd) throws IOException {
        if (!ALLOWED.contains(cmd)) throw new SecurityException("command not on allow-list");
        return shell.exec(cmd);
    }

    /** "trailrunner" (all three disabled), "ifit" (none), or "mixed". */
    public synchronized String readMode() throws IOException {
        String out = run(LIST_DISABLED);
        int d = 0;
        for (String p : PKGS) if (hasPkg(out, p)) d++;
        for (String p : PROTECTED) if (hasPkg(out, p)) log.add("WARNING protected package disabled (not by us): " + p);
        String m = d == PKGS.length ? "trailrunner" : d == 0 ? "ifit" : "mixed";
        lastMode = m;
        return m;
    }

    private static boolean hasPkg(String list, String pkg) {
        for (String l : list.split("\\r?\\n")) if (l.trim().equals("package:" + pkg)) return true;
        return false;
    }

    public synchronized Result enterTrailRunnerMode() {
        explicitRequest = true;
        log.add("switch -> trailrunner: start");
        if (!probe.motorOk()) return fail("preflight: motor service :54321 not answering, nothing changed");
        for (String p : PKGS) {
            String why;
            try {
                String o = run("pm disable-user --user 0 " + p);
                if (!o.contains("new state: disabled-user")) { why = "disable " + p + " unexpected output: " + brief(o); }
                else {
                    sleep(settleMs);
                    why = checkHealthy();
                    if (why != null) why = "after disabling " + p + ": " + why;
                }
            } catch (IOException e) { why = "adb error disabling " + p + ": " + e.getMessage(); }
            if (why != null) {
                log.add("switch -> trailrunner: FAILED " + why + "; rolling back");
                Result r = exitTrailRunnerMode();
                return fail(why + (r.ok ? " (rolled back to iFit)" : " (ROLLBACK ALSO FAILED: " + r.msg + ")"));
            }
        }
        try {
            String m = readMode();
            if (!m.equals("trailrunner")) {
                Result r = exitTrailRunnerMode();
                return fail("verify: mode reads " + m + ", rolled back " + r.ok);
            }
        } catch (IOException e) {
            Result r = exitTrailRunnerMode();
            return fail("verify failed: " + e.getMessage() + ", rolled back " + r.ok);
        }
        log.add("switch -> trailrunner: OK");
        return new Result(true, "trailrunner");
    }

    /** Re-enable everything. Idempotent; attempts all three even if one fails. */
    public synchronized Result exitTrailRunnerMode() {
        log.add("switch -> ifit: start");
        StringBuilder err = new StringBuilder();
        for (String p : PKGS) {
            try {
                String o = run("pm enable --user 0 " + p);
                if (!o.contains("new state: enabled")) err.append(p).append(": ").append(brief(o)).append("; ");
            } catch (IOException e) { err.append(p).append(": ").append(e.getMessage()).append("; "); }
        }
        if (err.length() == 0) {
            try {
                String m = readMode();
                if (!m.equals("ifit")) err.append("verify reads ").append(m);
            } catch (IOException e) { err.append("verify: ").append(e.getMessage()); }
        }
        if (err.length() > 0) { log.add("switch -> ifit: FAILED " + err); return new Result(false, err.toString()); }
        lastMode = "ifit";
        log.add("switch -> ifit: OK");
        return new Result(true, "ifit");
    }

    public Result exitIfitMode() { explicitRequest = true; return exitTrailRunnerMode(); }

    /** Boot-time safety: enable-all, retrying while adbd/auth is not ready. Stops once any explicit request is made. */
    public void bootEnableAll(int attempts, long gapMs) {
        for (int i = 0; i < attempts && !explicitRequest; i++) {
            Result r;
            synchronized (this) { if (explicitRequest) return; r = exitTrailRunnerMode(); }
            if (r.ok) { log.add("boot: enable-all OK"); return; }
            sleep(gapMs);
        }
        if (!explicitRequest) log.add("boot: enable-all gave up");
    }

    private String checkHealthy() {
        if (!probe.motorOk()) return "motor service :54321 stopped answering";
        for (int i = 0; i < 3; i++) {
            if (probe.bridgeLinkOk()) return null;
            sleep(1000);
        }
        return "bridge link not ok";
    }

    private Result fail(String m) { log.add("switch FAILED: " + m); return new Result(false, m); }
    private static String brief(String s) { s = s == null ? "" : s.trim(); return s.length() > 80 ? s.substring(0, 80) : s; }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }

    // ---- real-device probes ----
    public static Probe deviceProbe() {
        return new Probe() {
            public boolean motorOk() {
                Socket s = new Socket();
                try { s.connect(new InetSocketAddress("127.0.0.1", 54321), 1000); return true; }
                catch (IOException e) { return false; }
                finally { try { s.close(); } catch (IOException ignored) { } }
            }
            public boolean bridgeLinkOk() {
                Socket s = new Socket();
                try {
                    s.connect(new InetSocketAddress("127.0.0.1", 4510), 500);
                } catch (IOException e) { try { s.close(); } catch (IOException ig) { } return true; } // bridge not running
                try {
                    s.setSoTimeout(1500);
                    s.getOutputStream().write("GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".getBytes("ISO-8859-1"));
                    java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[2048]; int n;
                    while ((n = s.getInputStream().read(buf)) > 0 && b.size() < 16384) b.write(buf, 0, n);
                    String r = b.toString("ISO-8859-1").replace(" ", "");
                    return r.contains("\"link\":\"ok\"");
                } catch (IOException e) { return false; }
                finally { try { s.close(); } catch (IOException ignored) { } }
            }
        };
    }

    public static List<String> pkgList() { return new ArrayList<String>(Arrays.asList(PKGS)); }
}
