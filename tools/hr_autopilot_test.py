#!/usr/bin/env python3
"""
HR autopilot monitored test for the X32i bridge (read-only except a safety STOP).

Usage:  python3 hr_autopilot_test.py [--ip 192.168.100.54] [--minutes 8]
                                     [--max-kph 8.0] [--max-incline 6.0] [--max-hr 175]

What it does
  1. PREFLIGHT: bridge reachable, link ok, safety key in, belt at 0, and the strap is really
     reading (HR > 40 for 10 polls in a row). Refuses to arm otherwise.
  2. WATCH (default 8 min, 2 s samples): logs time, HR, speed, incline, workout/console state.
  3. SAFETY NET: if speed > --max-kph, incline > --max-incline or HR > --max-hr, it sends
     POST /workout/stop (the same stop the app uses) and ends. Ctrl+C also stops watching
     (it does NOT touch the belt; use STOP / the safety key).
  4. REPORT: counts of speed/incline changes, the shortest gap between changes (autopilot must
     not change more than once per 5 s), biggest step, what happened during any HR-lost
     period (speed and incline must HOLD), and the log file path.
It never starts the belt and never sends speed or incline commands.
"""
import argparse, json, os, sys, time, urllib.request, urllib.error

def get(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None

def post_stop(base):
    try:
        req = urllib.request.Request(base + "/workout/stop", data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=4) as r:
            return r.read().decode()
    except Exception as e:
        return "stop request failed: %s" % e

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ip", default="192.168.100.54")
    ap.add_argument("--minutes", type=float, default=8)
    ap.add_argument("--max-kph", type=float, default=8.0)
    ap.add_argument("--max-incline", type=float, default=6.0)
    ap.add_argument("--max-hr", type=int, default=175)
    a = ap.parse_args()
    base = "http://%s:4510" % a.ip

    print("== PREFLIGHT ==")
    h = get(base + "/health")
    if not h:
        print("ABORT: bridge not answering on %s. Start TrailRunner (TRAILRUNNER on the boot screen) first." % base); return 2
    if h.get("link") != "ok":
        print("ABORT: motor link is '%s', not ok." % h.get("link")); return 2
    if h.get("safetyKeyOut"):
        print("ABORT: safety key is out."); return 2
    if float(h.get("speed", 0)) > 0.3:
        print("ABORT: belt is already moving (%.1f kph)." % float(h.get("speed", 0))); return 2
    print("bridge ok, link ok, key in, belt at 0.")
    print("Checking the strap is reading (needs 10 polls in a row with HR > 40, ~20 s) ...")
    good = 0
    for _ in range(40):
        h = get(base + "/health") or {}
        hr = int(float(h.get("hr", 0) or 0))
        good = good + 1 if hr > 40 else 0
        sys.stdout.write("\r  HR now: %3s   good polls: %2d/10" % (hr, good)); sys.stdout.flush()
        if good >= 10:
            break
        time.sleep(2)
    print()
    if good < 10:
        print("ABORT: the strap is not giving a steady pulse. Wear it snug on skin for ~30 s and try again.")
        return 2
    print("Strap is reading. ARMED.\n")
    print("NOW (on the treadmill): choose Free Run, open MENU > CONTROL MODE > 'HR -> INCLINE', pick the target zone (Z2 to start),")
    print("tap START and walk/jog gently. Keep a hand near STOP and the safety key. Watching for %.0f min ...\n" % a.minutes)

    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "hr_test_logs"), exist_ok=True)
    logp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hr_test_logs", time.strftime("hr_test_%Y%m%d_%H%M%S.csv"))
    rows, t0, end = [], time.time(), time.time() + a.minutes * 60
    stopped = None
    try:
        with open(logp, "w") as lf:
            lf.write("t_s,hr,speed_kph,incline_pct,workout,console,deadman,link\n")
            while time.time() < end:
                h = get(base + "/health")
                t = time.time() - t0
                if not h:
                    print("%6.0fs  bridge not answering" % t); time.sleep(2); continue
                hr = int(float(h.get("hr", 0) or 0)); sp = float(h.get("speed", 0)); inc = float(h.get("incline", 0))
                row = (round(t, 1), hr, sp, inc, h.get("workoutState"), h.get("consoleState"), h.get("deadman"), h.get("link"))
                rows.append(row); lf.write(",".join(str(x) for x in row) + "\n"); lf.flush()
                print("%6.0fs  HR %3d  speed %5.1f kph  incline %5.1f%%  %-8s %-14s dm=%s" % (t, hr, sp, inc, row[4], row[5], row[6]))
                if sp > a.max_kph or inc > a.max_incline or hr > a.max_hr:
                    why = "speed %.1f > %.1f" % (sp, a.max_kph) if sp > a.max_kph else ("incline %.1f > %.1f" % (inc, a.max_incline) if inc > a.max_incline else "HR %d > %d" % (hr, a.max_hr))
                    print("!!! SAFETY LIMIT: %s -> sending STOP" % why); stopped = why
                    print(post_stop(base)); break
                time.sleep(2)
    except KeyboardInterrupt:
        print("\n(stopped watching; the belt was NOT touched)")

    print("\n== REPORT ==  log: %s" % logp)
    if not rows:
        print("no samples"); return 1
    chg = []
    for i in range(1, len(rows)):
        if abs(rows[i][2] - rows[i-1][2]) >= 0.05 or abs(rows[i][3] - rows[i-1][3]) >= 0.05:
            chg.append((rows[i][0], rows[i][2] - rows[i-1][2], rows[i][3] - rows[i-1][3]))
    print("samples: %d, duration %.0f s" % (len(rows), rows[-1][0]))
    print("max speed %.1f kph, max incline %.1f%%, max HR %d" % (max(r[2] for r in rows), max(r[3] for r in rows), max(r[1] for r in rows)))
    print("speed/incline change events: %d" % len(chg))
    if len(chg) > 1:
        gaps = [chg[i][0] - chg[i-1][0] for i in range(1, len(chg))]
        print("shortest gap between changes: %.1f s (autopilot limit is 5 s; the belt ramp itself produces several samples per change)" % min(gaps))
        print("largest single-sample step: speed %.2f kph, incline %.2f%%" % (max(abs(c[1]) for c in chg), max(abs(c[2]) for c in chg)))
    lost = [r for r in rows if r[1] <= 40 and r[4] == "RUNNING"]
    print("samples with HR lost while RUNNING: %d (speed/incline should HOLD during these)" % len(lost))
    if lost:
        print("  speed range during loss: %.1f..%.1f, incline range: %.1f..%.1f" % (min(r[2] for r in lost), max(r[2] for r in lost), min(r[3] for r in lost), max(r[3] for r in lost)))
    if stopped:
        print("RESULT: safety stop sent -> %s" % stopped); return 3
    print("RESULT: no safety limit hit. Review the log and the feel of the incline moves with Richard.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
