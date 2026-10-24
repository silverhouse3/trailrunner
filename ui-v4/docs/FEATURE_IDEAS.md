# TrailRunner ui-v4 FEATURE IDEAS (research only, 2026-10-24)

No code or existing file was changed. Basis: README.md, docs/FEATURE_AUDIT.md (2026-10-22), grep of js/workout-builder.js, plus 6 web searches (listed under Sources). Effort S/M/L = Sonnet-agent runs (S = 1, M = 2-3, L = 4+).

## 0. Honest framing

* The app already has more than the competitors' basics: 19 workout templates (C25K W1, Tempo with warm-up/cool-down, Hill Repeats, HIIT 20/40, Tabata, Pyramid, Z2, Drift Test, EF Builder, 12-3-30), ghost, splits, HR autopilot, X% harder, Strava.
* FEATURE_AUDIT shows much of it is **half-wired**: workout stage and time-left are never displayed (#18), warm-up/cool-down/autopilot/ghost settings are saved but read by nothing (#29), HR dropout lets HR-control run away (P0 #9). The best "new feature" value is finishing these. Ideas below that depend on them are marked **(needs audit fix)**.
* Shared safety rule for every item that commands the belt: all speed/incline changes must go through `TM.setSpeed/setIncline` and the existing ramp limiter (`js/treadmill.js` clamps, rate limit, dedup), STOP/safety-key must always override any program, and nothing starts the belt except `App.startRun()`.

## 1. Ranked candidate table

Rank = value to Soph weighted by risk and effort. "Have?" = does TrailRunner already have it.

| # | Feature | What users get | Have? | Feasibility on THIS hardware | Belt safety impact | Effort | Value to Soph |
|---|---|---|---|---|---|---|---|
| 1 | Workout stage HUD + next-stage countdown/beep | See "Interval 3/8, 0:42 left, next: 10 kph" while running | partial: `WorkoutSegments.getCurrentSegment()` exists, `#workoutHud` reads legacy `Engine.workout` (audit #18, P1-10) | easy: pure UI | none | S | high: makes every existing workout usable |
| 2 | Auto warm-up / cool-down wrapper | Any run gets N-min easy ramp in and out, skippable | partial: settings exist but unread (audit #29); COOL DOWN button exists | easy | touches speed commands: reuse ramp limiter, SKIP must be one tap, STOP overrides | S-M | high |
| 3 | Training-plan runner (5K/10K/C25K multi-week) | "Today: Week 3 Run 2" armed in one tap, progress tick-off | partial: C25K W1 template only | easy-medium: schedule + existing workouts | none new (arms workouts via `App.armWorkout`) | M | high |
| 4 | Post-run recap screen | Pace-by-km chart, HR zone time, best km, vs last similar run, one-line verdict | partial: summary has comparison, PB, drift/EF, splits for routes | easy: data already collected | none | S-M | high |
| 5 | Pace-target programs (set a pace per block, not a speed) | "5:30/km x 4 min" in pace units, conversion shown both ways | partial: builder works in speed; `units.js` converts | easy | speed commands via limiter | S | medium-high |
| 6 | Fitness tests: 1-mile Rockport walk, Cooper 12-min, Ebbeling sub-max, HR recovery | VO2 max estimate, saved over time, trend | no (only Drift Test/EF Builder) | medium: needs reliable HR (audit P0 #9 HR dropout); Cooper/Rockport need user-chosen constant speed, results from belt distance. Belt distance is only as accurate as the console | speed commands for fixed-pace tests; low if pace is user-held/constant | M | medium: novelty, trackable progress |
| 7 | Negative-split / progressive-build coaching | Auto target "run 2nd half 5 s/km faster", live +/- vs plan | partial: EF Builder is a build; split-compare is after the fact | easy-medium | speed commands via limiter | M | medium |
| 8 | Auto-pause / resume on safety key or no-HR-dropout | Clean pause with resume, not an error | partial: safety-key pause overlay exists | easy | resume must NOT auto-restart belt; needs explicit tap | S | medium |
| 9 | Countdown start (3-2-1 then ramp) | Predictable start, time to step on | no | easy | START path only; ramp limiter | S | medium |
| 10 | Quick-start presets on Home (Easy 5K, 30 min Z2, Hills) | One tap from Home to armed run | partial: workouts armed via library | easy | none (arms only) | S | medium |
| 11 | Big-number mode (one huge metric, swipe to cycle) | Readable at arm's length when running | partial: 72 px strip | easy | none | S | medium |
| 12 | Goals / streaks / weekly challenge | Weekly km target, streak flame | partial: `streaks.js` exists, `streaksEnabled` setting unread | easy | none | S-M | medium |
| 13 | Screen-off / privacy / dim mode | Dim screen on idle, hide HR/stats on request | no | easy-medium: FLAG_KEEP_SCREEN_ON is set by wrapper; brightness control not verified | none | S | low-medium |
| 14 | Recovery-run guidance | "Stay under Zone 2 for 30 min": HR-capped speed | partial: HR autopilot + Z2 Fat Burn | medium: depends on HR fix | speed via limiter, must handle HR dropout (hold/ramp down, never freeze) | M | medium |
| 15 | Virtual race vs Strava route racers | Race people on a Strava segment/route | partial: strava-racers.js, ghost | exists | none new | - | already done |
| 16 | Hill/terrain program generator from GPX | Convert any GPX into an incline plan with a scale factor | partial: route runs follow incline | medium: incline clamp on the console (-3..+12 vs paper -6..40) | incline commands via limiter | M | medium |
| 17 | Shareable image summary (card for chat/Strava) | PNG card with route + stats | partial: text/GPX/TCX share; downloads dead on v2 wrapper (audit #24, #25) | medium: needs v4.1 wrapper download support | none | M | low-medium |
| 18 | Multi-profile / guest / kid profile | Separate stats, weight, HR max | no | medium: storage keyed by profile; stats.html is global | speed cap for kid profile would be a safety plus | M-L | low (one user) |
| 19 | Cadence / stride estimate | Steps per minute | no, `cadence.js` never started | **impossible without sensor**; from belt speed only is meaningless. Polar Sense reports no cadence over HR profile (not verified) | none | - | do not build |
| 20 | Run score / effort score | Single "effort" number per run (HR x time x pace) | partial: drift/EF | easy: derived, but arbitrary | none | S | low-medium |
| 21 | Voice announcements (km, splits, next stage) | Hands-free coaching | partial: coach TTS has no working fallback, `/tts` not on real bridge (audit P1) | medium: use WebView `speechSynthesis` or pre-recorded beeps. Console speaker not verified | none | M | medium |
| 22 | Leaderboards / community challenges | Compare with others | partial via Strava racers | hard: needs a backend and users; one-user product | none | L | low |
| 23 | Scenic/street-view video routes with auto incline | Peloton/iFit/Kinomap style | partial: video window + route follow | hard: no licensed video library; needs internet; YouTube embed on the console not verified | incline via limiter | L | low-medium |
| 24 | Adaptive speed from history (SmartAdjust-like) | Scales workout to what Soph actually runs | no | medium: needs her run history from `Store`; risk of unpredictable behaviour | speed via limiter | M | low-medium |

## 2. Recommended top-5 shortlist (high value, low risk, no new hardware)

**1. Workout stage HUD + upcoming-change warning (rank 1).** Apply P1-10 from the audit: `js/ui.js:_updateWorkoutHUD` reads `WorkoutSegments.getCurrentSegment()`; call it from the existing 1 s UI tick. Add a "next: X kph / Y %" line from the segment list in `js/workout-segments.js`, and a 3-beep/pulse in the last 3 s before a change (reuse the existing beep code in `js/voice.js`). Check at 1920x1000 it does not overlap the metric strip. No new belt commands, so no safety-rule change; add a Playwright check next to `mock/audit-workout-hud.js`.

**2. Post-run recap (rank 4).** Extend the summary renderer in `js/ui.js` (summary block; keep ids) with data already in the saved run: per-km pace bars, time-in-zone from HR samples, best km, and a "vs your last N similar runs" line using `js/past-run-splits.js` and `js/split-compare.js`. Show it for Free Run too, falling back to comparing against runs of similar distance (today the compare is hidden for Free Run, audit #23). Read-only, no belt impact. Also gives the home for the new fitness test result.

**3. Warm-up / cool-down wrapper (rank 2).** Make the saved settings (`warmUpEnabled/Duration/Speed`, `coolDownEnabled/Duration`) real: `js/workout-segments.js` prepends/appends easy segments at arm time (`App.armWorkout`), so they are visible in the HUD in item 1 and obey the same ramp limiter. A SKIP button on the HUD jumps to the main block. Do not auto-insert for Free Run unless the setting is on. Reuse the existing COOL DOWN overlay (`js/app.js`). Tests: STOP and safety key during warm-up, SKIP, ramp-limiter trace in `mock/`.

**4. Training-plan runner (rank 3).** New small module `js/plans.js` (plan data as JSON: C25K 9 weeks, 5K improver, 10K base; each day references a workout builder template id) storing "next session" in `Store`. A Home tile "TODAY: Week 3 Run 2" calls `App.armWorkout` (same arm-not-start path as `js/workout-builder.js`), marks the day done in `App.saveAndNewRun`, and lets Soph skip/repeat a week. Integrates with `js/run-again.js` ("repeat this session"). Plans are written by us in our own words, no third-party plan content copied. Depends on item 1 being finished so each session shows its stages. No new belt command path.

**5. Pace-target programs + countdown start (ranks 5, 9).** In `js/workout-builder.js` let a block be specified as pace (min/km or min/mile) with a live conversion to kph using `js/units.js`; store kph underneath so `Engine.ctrl` and the limiter are unchanged. Add a 3-2-1 countdown in `App.startRun` before the existing `TM.startWorkout()` call (still only reached from START). Optional later: Cooper 12-min and Rockport 1-mile tests as two builder templates plus a result calculator in the recap, but only after the HR dropout P0 fix (audit #9), since Rockport needs a trusted finish HR.

Prerequisite worth doing first (not a new feature): audit P0 #9 HR-dropout runaway, and hide settings that do nothing (audit P2-1), otherwise new HR-based features inherit the bug.

## 3. Do-not-build list

* **Cadence / stride / "run score from cadence".** No cadence sensor, no accelerometer on the belt; belt speed alone cannot give steps per minute. `cadence.js` is already dead code, remove or hide rather than extend.
* **Power in watts as a training metric.** The mock derives watts from speed/incline; the real X32i gives no power meter. Anything labelled power is a model, not a measurement (existing UI should say "est.").
* **Auto-resume the belt after safety-key re-insert or HR return.** The belt must only restart from an explicit tap on START/RESUME.
* **Unbounded autopilot (HR or "adaptive") without sanity limits.** Until the HR-stale P0 is fixed and tested, do not add more HR-driven speed logic (recovery-run guidance, adaptive speed). Any such feature must hold or ramp down on missing/stale HR, never freeze the last value.
* **Kid/guest profile with relaxed limits.** If ever built it must only tighten limits (max speed cap), never loosen; low value for a single user.
* **Copying Peloton/iFit/Zwift/Kinomap/Runna content, classes, instructors' cues, names, or scenic video.** Licensed content and brand marks; build our own generic equivalents (e.g. "Pace Target" is Peloton's feature name, use a different label).
* **Leaderboards/community challenges.** Needs a server and a user base; Strava racers already covers the real need.
* **Apple Fitness+ / GymKit.** Apple Watch syncs with specific certified equipment via GymKit; not available to a custom app on this console (inference from sources, not verified against Apple docs).
* **Native "program to console" (`/workout/program`).** Audit #19 shows the bridge builds then discards it; stays a stub, keep programs app-side.
* **Street view maps.** Needs a Google key and internet, already hidden; licensing and billing.

## 4. Sources (URL, takeaway) and what could not be verified

* https://connectthewatts.com/2021/03/16/ifit-details-smartadjust-and-activepulse-features-to-automate-your-workouts/ : SmartAdjust scales trainer workouts to your changes using history; ActivePulse adjusts speed/incline to hold an HR zone, not for manual workouts. Both need a paid iFIT subscription.
* https://www.nordictrack.com/blog/activepulse-heart-rate-training : ActivePulse reacts to HR in real time; max HR from profile or a max-HR test.
* https://www.techradar.com/news/peloton-reboots-its-picturesque-scenic-workouts-but-not-for-everyone : Peloton scenic runs are first-person routes; now limited to all-access members.
* https://gizmodo.com/peloton-adds-a-bunch-of-new-features-amidst-tread-turm-1846795023 and https://onepeloton.com/treads/specs : Pace Targets turn instructor cues into personal paces (7 effort levels run, 5 walk); target ranges for speed/incline; manual pause on on-demand classes.
* https://zwiftinsider.com/incline-control/ : Zwift Run cannot control a treadmill's speed; automatic incline only on Wahoo KICKR RUN; it listens to footpods/RunPod.
* https://fitandwell.com/features/zwift-for-runners : Zwift Run offers workouts, plans, races, level-ups and challenges.
* https://www.fitshop.co.uk/kinomap-subscription : Kinomap adjusts treadmill incline to the video route terrain; live multiplayer challenges.
* https://www.athleticbusiness.com/industry-press-room/article/15153611/technogym-becomes-first-fitness-equipment-manufacturer-to-release-apple-gymkit : Technogym equipment syncs speed/incline/calories with Apple Watch via GymKit.
* https://runbundle.com/tools/vo2-max-calculators/rockport-walk-test , https://triathlonmagazine.ca/training/simple-ways-to-test-your-running-fitness-no-lab-required/ , https://open-exam-prep.com/study-guides/ca-csep-cpt-theory/aerobic-fitness-assessment/ch05-sec03-ebbeling-rockport-protocols : Rockport = 1-mile fast walk with finish HR; Cooper = 12-min max distance, VO2 = km x 22.351 - 11.29; Ebbeling = 4 min walk at 5% after warm-up. Fitness-site sources, not primary papers; verify formulas against ACSM/CSEP before showing a VO2 number.

**Could not verify (searches returned nothing usable):** Garmin treadmill run mode specifics; Woodway programs; Runna treadmill/pace-plan behaviour; Kinomap treadmill ghost mode (only bike ghost documented); Peloton auto-pause or "Just Run" (none found); Technogym firmware program list; whether the X32i console speaker/WebView `speechSynthesis` works; whether Polar Sense exposes cadence on this console; generic firmware features (interval timers, hill programs, goals, presets) are stated from general knowledge, not a cited source. Competitor feature claims are from reviews and retailer pages, so may be out of date.
