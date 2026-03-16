// ════════════════════════════════════════════════════════════════════════════
// Streaks — streak tracking, badges, and achievements
// ════════════════════════════════════════════════════════════════════════════

var Streaks = {
  data: null,
  badges: [],

  // Callbacks
  onBadgeEarned: null,   // (badge) =>

  // ── Badge definitions ─────────────────────────────────────────────────────

  BADGES: [
    { id: 'first_steps',    name: 'First Steps',    icon: '\uD83D\uDC5F', condition: function(d)    { return d.totalWorkouts >= 1; } },
    { id: '5k_club',        name: '5K Club',         icon: '\uD83C\uDFC3', condition: function(d, s) { return s.distanceKm >= 5; } },
    { id: 'ten_k',          name: '10K Runner',      icon: '\uD83C\uDFAF', condition: function(d, s) { return s.distanceKm >= 10; } },
    { id: 'half_marathon',  name: 'Half Marathon',   icon: '\uD83E\uDD48', condition: function(d, s) { return s.distanceKm >= 21.1; } },
    { id: 'full_marathon',  name: 'Full Marathon',   icon: '\uD83E\uDD47', condition: function(d, s) { return s.distanceKm >= 42.2; } },
    { id: 'week_warrior',   name: 'Week Warrior',    icon: '\uD83D\uDCC5', condition: function(d)    { return d.thisWeekCount >= 5; } },
    { id: 'streak_7',       name: '7-Day Streak',    icon: '\uD83D\uDD25', condition: function(d)    { return d.currentStreak >= 7; } },
    { id: 'streak_30',      name: '30-Day Streak',   icon: '\uD83D\uDC8E', condition: function(d)    { return d.currentStreak >= 30; } },
    { id: 'century',        name: 'Century',          icon: '\uD83D\uDCAF', condition: function(d)    { return d.totalWorkouts >= 100; } },
    { id: 'marathon',       name: 'Marathon Total',   icon: '\uD83C\uDFC5', condition: function(d)    { return d.totalDistanceKm >= 42.2; } },
    { id: 'hill_climber',   name: 'Hill Climber',    icon: '\u26F0\uFE0F', condition: function(d, s) { return s.elevGained >= 304.8; } },
    { id: 'zone_master',    name: 'Zone Master',     icon: '\u2764\uFE0F', condition: function(d, s) {
      // Earned when a workout has 10+ minutes in each of zones 2, 3, and 4
      if (!s.hrZoneMinutes) return false;
      return s.hrZoneMinutes.z2 >= 10 && s.hrZoneMinutes.z3 >= 10 && s.hrZoneMinutes.z4 >= 10;
    }},
    { id: 'ghost_buster',   name: 'Ghost Buster',    icon: '\uD83D\uDC7B', condition: function(d, s) { return s.ghostDelta >= 30; } },
    { id: 'speed_demon',    name: 'Speed Demon',     icon: '\u26A1',       condition: function(d)    { return d.maxSpeedKph >= 16.1; } },
    { id: 'consistency',    name: 'Consistency',      icon: '\uD83C\uDF1F', condition: function(d)    { return d.weeksWithFourPlus >= 4; } },
    { id: 'early_bird',     name: 'Early Bird',      icon: '\uD83C\uDF05', condition: function(d, s) { return s.hour < 7; } },
    { id: 'night_owl',      name: 'Night Owl',       icon: '\uD83E\uDD89', condition: function(d, s) { return s.hour >= 21; } },
    { id: 'calorie_burner', name: '500 Cal Burn',    icon: '\uD83D\uDD25', condition: function(d, s) { return s.calories >= 500; } },
    { id: 'negative_split', name: 'Negative Splitter', icon: '\u2935\uFE0F', condition: function(d, s) { return (s.negativeSplits || 0) >= 3; } },
    { id: 'power_200',     name: '200W Runner',    icon: '\u26A1', condition: function(d, s) { return (s.avgPower || 0) >= 200; } },
    { id: 'power_300',     name: '300W Powerhouse', icon: '\uD83D\uDCA5', condition: function(d, s) { return (s.avgPower || 0) >= 300; } },
    { id: 'total_100k',    name: '100K Total',      icon: '\uD83C\uDF0D', condition: function(d)    { return d.totalDistanceKm >= 100; } },
    { id: 'ultra',         name: 'Ultra Runner',    icon: '\uD83C\uDFD4\uFE0F', condition: function(d, s) { return s.distanceKm >= 50; } },
    { id: 'well_hydrated', name: 'Well Hydrated',   icon: '\uD83D\uDCA7', condition: function(d, s) { return s.cardiacDrift != null && s.cardiacDrift < 3 && s.distanceKm >= 5; } },
    { id: 'ef_elite',      name: 'EF Elite',        icon: '\uD83C\uDFC6', condition: function(d, s) { return (s.efficiencyFactor || 0) >= 2.0; } },
  ],

  // ── Init ──────────────────────────────────────────────────────────────────

  init() {
    this.data = this._load('streaks', this._defaultData());
    this.badges = this._load('badges', []);

    // Check if week/month periods need resetting
    this._checkPeriodReset();

    console.log('[Streaks] Initialised — streak: ' + this.data.currentStreak +
      ', workouts: ' + this.data.totalWorkouts +
      ', badges: ' + this.badges.length);
  },

  // ── Record a completed workout ────────────────────────────────────────────

  recordWorkout(summary) {
    if (!this.data) this.init();

    var today = this._todayISO();

    // Check if streak continues, extends, or breaks
    if (this.data.lastWorkoutDate) {
      var daysSince = this._daysBetween(this.data.lastWorkoutDate, today);
      if (daysSince === 0) {
        // Same day — streak doesn't change
      } else if (daysSince === 1) {
        // Consecutive day — extend streak
        this.data.currentStreak++;
      } else {
        // Streak broken — reset to 1
        this.data.currentStreak = 1;
      }
    } else {
      // First ever workout
      this.data.currentStreak = 1;
    }

    // Update longest streak
    if (this.data.currentStreak > this.data.longestStreak) {
      this.data.longestStreak = this.data.currentStreak;
    }

    // Update totals
    this.data.totalWorkouts++;
    this.data.totalDistanceKm += (summary.distanceKm || 0);
    this.data.totalTimeMin += ((summary.elapsed || 0) / 60);
    this.data.totalElevM += (summary.elevGained || 0);
    this.data.lastWorkoutDate = today;

    // Update records
    var peakSpeed = summary.maxSpeed || summary.avgSpeed || 0;
    if (peakSpeed > this.data.maxSpeedKph) {
      this.data.maxSpeedKph = peakSpeed;
    }
    if ((summary.distanceKm || 0) > this.data.maxSingleDistKm) {
      this.data.maxSingleDistKm = summary.distanceKm;
    }
    if ((summary.elevGained || 0) > this.data.maxSingleElevM) {
      this.data.maxSingleElevM = summary.elevGained;
    }
    var workoutMin = (summary.elapsed || 0) / 60;
    if (workoutMin > this.data.longestSingleWorkoutMin) {
      this.data.longestSingleWorkoutMin = workoutMin;
    }

    // Update week/month counters
    this._checkPeriodReset();
    this.data.thisWeekCount++;
    this.data.thisMonthCount++;

    // Track consecutive weeks with 4+ workouts
    // (evaluated at end of each week via _checkPeriodReset)

    // Save
    this._save('streaks', this.data);

    // Check for new badges
    var newBadges = this._checkBadges(summary);
    if (newBadges.length > 0) {
      this._save('badges', this.badges);
    }

    return newBadges;
  },

  // ── Getters ───────────────────────────────────────────────────────────────

  getData() {
    if (!this.data) this.init();
    return {
      currentStreak: this.data.currentStreak,
      longestStreak: this.data.longestStreak,
      totalWorkouts: this.data.totalWorkouts,
      totalDistanceKm: Math.round(this.data.totalDistanceKm * 100) / 100,
      totalTimeMin: Math.round(this.data.totalTimeMin),
      totalElevM: Math.round(this.data.totalElevM),
      thisWeekCount: this.data.thisWeekCount,
      thisMonthCount: this.data.thisMonthCount,
      maxSpeedKph: this.data.maxSpeedKph,
      maxSingleDistKm: this.data.maxSingleDistKm,
      lastWorkoutDate: this.data.lastWorkoutDate,
    };
  },

  getEarnedBadges() {
    return this.badges.slice();
  },

  getProgressTowards() {
    if (!this.data) this.init();

    var earned = {};
    for (var i = 0; i < this.badges.length; i++) {
      earned[this.badges[i].id] = true;
    }

    var progress = [];
    for (var i = 0; i < this.BADGES.length; i++) {
      var badge = this.BADGES[i];
      if (earned[badge.id]) continue;

      var info = this._getBadgeProgress(badge);
      if (info) {
        progress.push({
          badge: { id: badge.id, name: badge.name, icon: badge.icon },
          progress: info.progress,
          remaining: info.remaining,
        });
      }
    }

    // Sort by closest to completion
    progress.sort(function(a, b) { return b.progress - a.progress; });
    return progress;
  },

  getMotivationMessage() {
    var progress = this.getProgressTowards();
    if (progress.length === 0) return 'All badges earned! You legend!';

    var closest = progress[0];
    return closest.remaining + ' for ' + closest.badge.name + '!';
  },

  // ── Badge checking ────────────────────────────────────────────────────────

  _checkBadges(summary) {
    var earned = {};
    for (var i = 0; i < this.badges.length; i++) {
      earned[this.badges[i].id] = true;
    }

    // Enrich summary with extra data for badge conditions
    var enriched = {
      distanceKm: summary.distanceKm || 0,
      elapsed: summary.elapsed || 0,
      elevGained: summary.elevGained || 0,
      avgHR: summary.avgHR || 0,
      maxHR: summary.maxHR || 0,
      avgSpeed: summary.avgSpeed || 0,
      ghostDelta: summary.ghostDelta || 0,
      calories: summary.calories || 0,
      hour: new Date().getHours(),
      hrZoneMinutes: summary.hrZoneMinutes || null,
      avgPower: summary.avgPower || 0,
      negativeSplits: summary.negativeSplits || 0,
      cardiacDrift: summary.cardiacDrift != null ? summary.cardiacDrift : null,
      efficiencyFactor: summary.efficiencyFactor || 0,
    };

    var newBadges = [];
    for (var i = 0; i < this.BADGES.length; i++) {
      var badge = this.BADGES[i];
      if (earned[badge.id]) continue;

      try {
        if (badge.condition(this.data, enriched)) {
          var newBadge = {
            id: badge.id,
            name: badge.name,
            icon: badge.icon,
            earnedAt: new Date().toISOString(),
          };
          this.badges.push(newBadge);
          newBadges.push(newBadge);

          console.log('[Streaks] Badge earned: ' + badge.name + ' ' + badge.icon);
          if (this.onBadgeEarned) this.onBadgeEarned(newBadge);
        }
      } catch (e) {
        // Skip broken conditions
      }
    }

    return newBadges;
  },

  _getBadgeProgress(badge) {
    var d = this.data;
    switch (badge.id) {
      case 'first_steps':
        return { progress: Math.min(1, d.totalWorkouts / 1), remaining: (1 - d.totalWorkouts) + ' more workouts' };
      case '5k_club':
        return { progress: 0, remaining: 'Complete a 5K run' };
      case 'ten_k':
        return { progress: 0, remaining: 'Complete a 10K run' };
      case 'half_marathon':
        return { progress: 0, remaining: 'Complete a half marathon' };
      case 'full_marathon':
        return { progress: 0, remaining: 'Complete a full marathon' };
      case 'week_warrior':
        return { progress: d.thisWeekCount / 5, remaining: Math.max(0, 5 - d.thisWeekCount) + ' more this week' };
      case 'streak_7':
        return { progress: d.currentStreak / 7, remaining: Math.max(0, 7 - d.currentStreak) + ' more days' };
      case 'streak_30':
        return { progress: d.currentStreak / 30, remaining: Math.max(0, 30 - d.currentStreak) + ' more days' };
      case 'century':
        return { progress: d.totalWorkouts / 100, remaining: Math.max(0, 100 - d.totalWorkouts) + ' more workouts' };
      case 'marathon':
        var rem = Math.max(0, 42.2 - d.totalDistanceKm);
        return { progress: d.totalDistanceKm / 42.2, remaining: rem.toFixed(1) + ' km to go' };
      case 'hill_climber':
        return { progress: 0, remaining: 'Climb 1000 ft in one workout' };
      case 'speed_demon':
        return { progress: d.maxSpeedKph / 16.1, remaining: 'Reach 16.1 kph (10 mph)' };
      case 'consistency':
        return { progress: d.weeksWithFourPlus / 4, remaining: Math.max(0, 4 - d.weeksWithFourPlus) + ' more weeks of 4+' };
      case 'early_bird':
        return { progress: 0, remaining: 'Work out before 7am' };
      case 'night_owl':
        return { progress: 0, remaining: 'Work out after 9pm' };
      case 'calorie_burner':
        return { progress: 0, remaining: 'Burn 500+ calories in one workout' };
      case 'negative_split':
        return { progress: 0, remaining: 'Run 3+ negative splits in one workout' };
      case 'power_200':
        return { progress: 0, remaining: 'Average 200W+ in a workout' };
      case 'power_300':
        return { progress: 0, remaining: 'Average 300W+ in a workout' };
      case 'total_100k':
        var rem100 = Math.max(0, 100 - d.totalDistanceKm);
        return { progress: d.totalDistanceKm / 100, remaining: rem100.toFixed(1) + ' km to go' };
      case 'ultra':
        return { progress: 0, remaining: 'Complete a 50K run' };
      default:
        return null;
    }
  },

  // ── Period management ─────────────────────────────────────────────────────

  _checkPeriodReset() {
    var today = this._todayISO();

    // Week reset (Monday-based ISO weeks)
    var currentWeekStart = this._getWeekStart(today);
    if (this.data.weekStartDate !== currentWeekStart) {
      // How many weeks were skipped?
      var weeksBetween = 0;
      if (this.data.weekStartDate) {
        var oldParts = this.data.weekStartDate.split('-');
        var newParts = currentWeekStart.split('-');
        var oldMs = new Date(parseInt(oldParts[0]), parseInt(oldParts[1]) - 1, parseInt(oldParts[2])).getTime();
        var newMs = new Date(parseInt(newParts[0]), parseInt(newParts[1]) - 1, parseInt(newParts[2])).getTime();
        weeksBetween = Math.round((newMs - oldMs) / (7 * 24 * 60 * 60 * 1000));
      }

      if (weeksBetween > 1 && this.data.weekStartDate) {
        // Skipped one or more weeks — consistency broken regardless of prior count
        this.data.weeksWithFourPlus = 0;
      } else if (this.data.thisWeekCount >= 4) {
        // Previous week qualified
        this.data.weeksWithFourPlus++;
      } else if (this.data.weekStartDate) {
        // Previous week didn't qualify — reset
        this.data.weeksWithFourPlus = 0;
      }
      this.data.thisWeekCount = 0;
      this.data.weekStartDate = currentWeekStart;
    }

    // Month reset
    var currentMonthStart = today.substring(0, 7) + '-01';
    if (this.data.monthStartDate !== currentMonthStart) {
      this.data.thisMonthCount = 0;
      this.data.monthStartDate = currentMonthStart;
    }
  },

  // ── Date utilities ────────────────────────────────────────────────────────

  _todayISO() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  },

  _getWeekStart(isoDate) {
    // Return Monday of the week containing isoDate
    var parts = isoDate.split('-');
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    var day = d.getDay();
    // Convert: Sunday=0 -> 6, Monday=1 -> 0, etc.
    var diff = (day === 0 ? 6 : day - 1);
    d.setDate(d.getDate() - diff);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  },

  _daysBetween(dateA, dateB) {
    // Both are 'YYYY-MM-DD' strings
    var a = dateA.split('-');
    var b = dateB.split('-');
    var da = new Date(parseInt(a[0]), parseInt(a[1]) - 1, parseInt(a[2]));
    var db = new Date(parseInt(b[0]), parseInt(b[1]) - 1, parseInt(b[2]));
    var diffMs = db.getTime() - da.getTime();
    return Math.round(diffMs / 86400000);
  },

  // ── Default data ──────────────────────────────────────────────────────────

  _defaultData() {
    return {
      currentStreak: 0,
      longestStreak: 0,
      totalWorkouts: 0,
      totalDistanceKm: 0,
      totalTimeMin: 0,
      totalElevM: 0,
      thisWeekCount: 0,
      thisMonthCount: 0,
      weekStartDate: null,
      monthStartDate: null,
      lastWorkoutDate: null,
      maxSpeedKph: 0,
      maxSingleDistKm: 0,
      maxSingleElevM: 0,
      longestSingleWorkoutMin: 0,
      hrZoneMinutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
      weeksWithFourPlus: 0,
    };
  },

  // ── localStorage (compatible with Store pattern) ──────────────────────────

  _load(key, fallback) {
    try {
      var raw = localStorage.getItem('tr_' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  },

  _save(key, value) {
    try {
      localStorage.setItem('tr_' + key, JSON.stringify(value));
    } catch (e) {
      console.warn('[Streaks] Save failed:', e);
    }
  },
};
