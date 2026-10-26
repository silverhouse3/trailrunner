package com.silverhouse3.trailrunnerbridge;

import java.io.*;
import java.nio.file.*;

public class Tests {
    static int pass, fail;
    static void check(String n, boolean ok) { if (ok) pass++; else { fail++; System.out.println("FAIL " + n); } }

    static final String STOP_DOWN = "%s INFO SDS Changed KEY_OBJECT from KeyPress(code=NO_KEY, timePressed=0, timeHeld=0) to KeyPress(code=STOP, timePressed=0, timeHeld=220)\n";
    static final String STOP_UP = "%s INFO SDS Changed KEY_OBJECT from KeyPress(code=STOP, timePressed=0, timeHeld=220) to KeyPress(code=NO_KEY, timePressed=0, timeHeld=0)\n";
    static final String OTHER = "%s INFO SDS Changed KEY_OBJECT from KeyPress(code=NO_KEY, timePressed=0, timeHeld=0) to KeyPress(code=%s, timePressed=0, timeHeld=180)\n";

    static File tmp;
    static void append(String s) throws IOException {
        Files.write(tmp.toPath(), s.getBytes("ISO-8859-1"), StandardOpenOption.APPEND);
    }
    static KeyWatchCore.Bridge noBridge = new KeyWatchCore.Bridge() { public boolean up() { return false; } public Double kph() { return null; } };
    static final long MS = 1000000L;

    static String ts(long simMs) { long t = 36000000L + simMs - 1000; return String.format("%02d:%02d:%02d.%03d", t / 3600000, t / 60000 % 60, t / 1000 % 60, t % 1000); }
    static String line(String f, long simMs) { return String.format(f, ts(simMs)); }
    static String kph(long simMs, String a, String b) { return ts(simMs) + " INFO SDS Changed KPH from " + a + " kph to " + b + " kph\n"; }
    static void press(KeyWatchCore c, long simMs) throws IOException { append(line(STOP_DOWN, simMs)); c.step((simMs + 50) * MS); }
    static KeyWatchCore fresh(KeyWatchCore.Bridge b) throws IOException {
        tmp = File.createTempFile("log", ".txt");
        Files.write(tmp.toPath(), ("00:00:01.000 INFO old\n" + String.format(STOP_DOWN, "00:00:02.000") + String.format(STOP_DOWN, "00:00:02.300")).getBytes());
        KeyWatchCore c = new KeyWatchCore(tmp, b);
        c.step(0); // first run: starts at END, old presses ignored
        return c;
    }
    static boolean run(KeyWatchCore c, long fromMs, long toMs) throws IOException {
        boolean opened = false;
        for (long t = fromMs; t <= toMs; t += 100) opened |= c.step(t * MS);
        return opened;
    }

    public static void main(String[] a) throws Exception {
        // Sim clock: log stamp = 10:00:00.000 + simMs; a press is appended at simMs and read 50 ms later.
        KeyWatchCore c = fresh(noBridge);
        check("first run ignores old", c.pressCount() == 0 && !run(c, 100, 10000));

        c = fresh(noBridge);
        press(c, 1000); // single, reads fine
        press(c, 1500);
        check("0.5s: not open before settle", !run(c, 1600, 4400));
        check("0.5s: opens after settle", run(c, 4500, 6000));
        check("press count 2", c.pressCount() == 2);

        c = fresh(noBridge); press(c, 1000); press(c, 3500);
        check("2.5s none", !run(c, 3600, 20000));
        c = fresh(noBridge); press(c, 1000);
        check("single none", !run(c, 1100, 20000));
        c = fresh(noBridge); press(c, 1000); press(c, 1050);
        check("bounce 0.05 none", !run(c, 1100, 20000));
        c = fresh(noBridge); press(c, 1000); press(c, 2000);
        check("1.0s double opens", run(c, 2100, 8000));
        c = fresh(noBridge); press(c, 1000); press(c, 2990);
        check("1.99s double opens", run(c, 3100, 9000));

        // both presses in one chunk, 0.5 s apart (log stamps give the gap)
        c = fresh(noBridge);
        append(line(STOP_DOWN, 1000) + line(STOP_DOWN, 1500));
        c.step(1550 * MS);
        check("same-chunk double opens", run(c, 1600, 6000));

        // third press within 5 s: no retrigger
        c = fresh(noBridge); press(c, 1000); press(c, 1500);
        boolean o1 = run(c, 1600, 4600);
        press(c, 4700); // third, 3.2 s after trigger
        boolean o2 = run(c, 4800, 12000);
        check("first trigger opened", o1);
        check("third press no retrigger", !o2);

        // log rotation: file replaced with a shorter one
        c = fresh(noBridge);
        Files.write(tmp.toPath(), line(STOP_DOWN, 1000).getBytes());
        c.step(1050 * MS);
        press(c, 1500);
        check("rotation handled", run(c, 1600, 6000));
        check("rotation count", c.pressCount() == 2);

        // other keys ignored
        c = fresh(noBridge);
        append(String.format(OTHER, ts(1000), "SPEED_UP") + String.format(OTHER, ts(1400), "START") + String.format(OTHER, ts(1800), "SPEED_UP"));
        check("other keys ignored", c.pressCount() == 0 && !run(c, 1900, 20000) && c.pressCount() == 0);

        // speed above 0.3 -> no open, gives up at 20 s (never opens late)
        c = fresh(noBridge);
        append(kph(900, "0.0", "5.0")); c.step(950 * MS);
        press(c, 1000); press(c, 1500);
        check("speed 5 -> not open", !run(c, 1600, 15000));
        check("gave up at 20s, never opened", !run(c, 15100, 40000));

        c = fresh(noBridge);
        append(kph(900, "0.0", "5.0")); c.step(950 * MS);
        press(c, 1000); press(c, 1500); run(c, 1600, 4000);
        append(kph(5000, "5.0", "0.0"));
        check("speed falls to 0 within 20s -> open", run(c, 5000, 15000));

        c = fresh(noBridge);
        append(kph(900, "0.0", "0.31")); c.step(950 * MS); press(c, 1000); press(c, 1500);
        check("0.31 no open", !run(c, 1600, 19000));
        c = fresh(noBridge);
        append(kph(900, "0.0", "0.3")); c.step(950 * MS); press(c, 1000); press(c, 1500);
        check("0.3 opens", run(c, 1600, 6000));

        final double[] bs = {2.0};
        KeyWatchCore.Bridge up = new KeyWatchCore.Bridge() { public boolean up() { return true; } public Double kph() { return bs[0]; } };
        c = fresh(up); press(c, 1000); press(c, 1500);
        check("bridge speed 2 -> no open", !run(c, 1600, 10000));
        bs[0] = 0.0;
        check("bridge speed 0 -> open", run(c, 10100, 12000));

        c = fresh(noBridge); press(c, 1000); press(c, 1500); run(c, 1600, 2900);
        press(c, 3000); // extra STOP during settle
        check("extra STOP delays open", !run(c, 3100, 5900) && run(c, 6000, 7000));

        // midnight wrap in the log stamps
        c = fresh(noBridge);
        append(String.format(STOP_DOWN, "23:59:59.800")); c.step(1000 * MS);
        append(String.format(STOP_DOWN, "00:00:00.300")); c.step(1500 * MS);
        check("midnight wrap double opens", run(c, 1600, 6000));

        // read error surfaces as IOException (service backs off)
        c = fresh(noBridge);
        tmp.delete();
        boolean threw = false;
        try { c.step(1 * MS); } catch (IOException e) { threw = true; }
        check("missing file -> IOException", threw);

        // partial line across chunks
        c = fresh(noBridge);
        String l = String.format(STOP_DOWN, "10:00:00.000");
        append(l.substring(0, 60)); run(c, 100, 100);
        append(l.substring(60)); run(c, 200, 200);
        check("partial line joined", c.pressCount() == 1);

        System.out.println("tests passed=" + pass + " failed=" + fail);
        System.exit(fail == 0 ? 0 : 1);
    }
}
