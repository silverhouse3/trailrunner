// ═══════════════════════════════════════════════════════════════════════════════
// TrailRunner — Voice Command System
// Uses Web Speech API (SpeechRecognition) — Chrome 25+
//
// Commands:
//   "start" / "go"           → Start workout
//   "stop" / "finish"        → Stop workout
//   "pause" / "hold"         → Pause workout
//   "resume" / "continue"    → Resume workout
//   "faster" / "speed up"    → +0.5 kph
//   "slower" / "slow down"   → -0.5 kph
//   "speed [N]"              → Set speed to N kph
//   "incline [N]"            → Set incline to N%
//   "flat"                   → Incline 0%
//   "hill"                   → Incline +2%
//   "status"                 → Speak current stats
//   "last run"               → Speak last run summary
//   "streak" / "my streak"   → Speak current streak
//   "total distance"         → Speak total distance
//   "effort" / "training load"→ Speak current effort score
//   "pace" / "pb pace"       → Speak PB pace projection
//   "eta" / "how long"       → Speak estimated time remaining
//   "recovery" / "hrr"       → Speak heart rate recovery (post-run)
//   "fitness" / "readiness"  → Speak fitness/fatigue model status
//   "motivation"             → Speak next badge progress
//   "next" / "skip"          → Skip to next workout segment
//   "what segment"           → Speak current segment info
//   "power" / "watts"        → Speak current running power
//   "race prediction"        → Predict 5K/10K/HM times (Riegel formula)
//   "splits" / "my splits"   → Speak split summary + negative split count
//   "drift" / "cardiac drift"→ Speak cardiac drift percentage + hydration advice
//   "efficiency"             → Speak aerobic efficiency factor
//   "play music" / "radio on"→ Start/resume radio
//   "stop music" / "mute"    → Stop radio
//   "volume up" / "louder"   → Volume +15%
//   "volume down" / "quieter"→ Volume -15%
//   "next station"           → Switch to next radio station
//   "emergency" / "help"     → Emergency stop
// ═══════════════════════════════════════════════════════════════════════════════

window.VoiceCommands = (function() {
  'use strict';

  var recognition = null;
  var isListening = false;
  var continuous = false;
  var enabled = false;
  var lastCommand = '';
  var lastCommandTime = 0;
  var DEBOUNCE_MS = 2000; // prevent double-triggers

  // Check support
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('[Voice] SpeechRecognition not supported');
    return {
      supported: false,
      init: function() {},
      start: function() {},
      stop: function() {},
      toggle: function() {},
      isListening: function() { return false; }
    };
  }

  function init() {
    recognition = new SpeechRecognition();
    recognition.continuous = false; // single utterance mode for reliability
    recognition.interimResults = false;
    recognition.lang = 'en-GB';
    recognition.maxAlternatives = 3;

    recognition.onresult = function(event) {
      var transcript = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript = event.results[i][0].transcript.toLowerCase().trim();
          var confidence = event.results[i][0].confidence;
          console.log('[Voice] Heard: "' + transcript + '" (confidence: ' + (confidence * 100).toFixed(0) + '%)');
          processCommand(transcript, confidence);
        }
      }
    };

    recognition.onerror = function(event) {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        // Normal — just restart if continuous mode
        if (continuous && enabled) {
          setTimeout(function() { startListening(); }, 500);
        }
        return;
      }
      console.warn('[Voice] Error:', event.error);
      showFeedback('🎤 ' + event.error, 'warn');
    };

    recognition.onend = function() {
      isListening = false;
      if (continuous && enabled) {
        setTimeout(function() { startListening(); }, 300);
      } else {
        updateMicIcon(false);
      }
    };

    console.log('[Voice] Initialized');
  }

  function startListening() {
    if (!recognition || isListening) return;
    try {
      recognition.start();
      isListening = true;
      updateMicIcon(true);
    } catch (e) {
      // Already started
    }
  }

  function stopListening() {
    if (!recognition) return;
    enabled = false;
    continuous = false;
    try { recognition.stop(); } catch (e) {}
    isListening = false;
    updateMicIcon(false);
  }

  function toggleContinuous() {
    if (continuous && enabled) {
      stopListening();
      showFeedback('🎤 Voice off', 'info');
    } else {
      enabled = true;
      continuous = true;
      startListening();
      showFeedback('🎤 Listening...', 'info');
    }
    return continuous && enabled;
  }

  function processCommand(text, confidence) {
    // Debounce
    var now = Date.now();
    if (text === lastCommand && now - lastCommandTime < DEBOUNCE_MS) return;
    lastCommand = text;
    lastCommandTime = now;

    // ── Emergency — always respond regardless of confidence ──
    if (matches(text, ['emergency', 'stop stop', 'help', 'emergency stop'])) {
      showFeedback('🛑 EMERGENCY STOP', 'danger');
      if (typeof App !== 'undefined' && App.emergencyStop) {
        App.emergencyStop();
      }
      return;
    }

    // Require minimum confidence for motor-control commands
    if (confidence < 0.5) {
      showFeedback('🎤 Didn\'t catch that', 'warn');
      return;
    }

    // ── Workout control ──
    if (matches(text, ['start', 'go', 'start running', 'begin', 'let\'s go', 'start workout'])) {
      showFeedback('▶ Starting', 'success');
      if (typeof App !== 'undefined' && App.startRun) App.startRun();
      return;
    }
    if (matches(text, ['stop', 'finish', 'end', 'stop workout', 'done', 'finished'])) {
      showFeedback('⏹ Stopping', 'warn');
      if (typeof App !== 'undefined' && App.finishRun) App.finishRun();
      return;
    }
    if (matches(text, ['pause', 'hold', 'wait', 'break', 'pause workout'])) {
      showFeedback('⏸ Paused', 'info');
      if (typeof App !== 'undefined' && App.pauseRun) App.pauseRun();
      return;
    }
    if (matches(text, ['resume', 'continue', 'unpause', 'carry on', 'keep going'])) {
      showFeedback('▶ Resuming', 'success');
      if (typeof App !== 'undefined' && App.resumeRun) App.resumeRun();
      return;
    }

    // ── Speed control (longer phrases first — indexOf matching) ──
    if (matches(text, ['much faster', 'sprint', 'kick'])) {
      showFeedback('⏫ Speed +2.0', 'info');
      adjustSpeed(2.0);
      return;
    }
    if (matches(text, ['much slower', 'walk', 'walking'])) {
      showFeedback('⏬ Speed -2.0', 'info');
      adjustSpeed(-2.0);
      return;
    }
    if (matches(text, ['faster', 'speed up', 'quicker'])) {
      showFeedback('⏫ Speed +0.5', 'info');
      adjustSpeed(0.5);
      return;
    }
    if (matches(text, ['slower', 'slow down', 'easy'])) {
      showFeedback('⏬ Speed -0.5', 'info');
      adjustSpeed(-0.5);
      return;
    }

    // "speed 8" or "set speed to 8"
    var speedMatch = text.match(/(?:speed|set speed|set speed to)\s+(\d+(?:\.\d+)?)/);
    if (speedMatch) {
      var kph = parseFloat(speedMatch[1]);
      showFeedback('🏃 Speed → ' + kph + ' kph', 'info');
      setSpeed(kph);
      return;
    }

    // ── Incline control ──
    if (matches(text, ['flat', 'level', 'no incline'])) {
      showFeedback('⬅ Incline → 0%', 'info');
      setIncline(0);
      return;
    }
    if (matches(text, ['hill', 'climb', 'steeper'])) {
      showFeedback('⛰ Incline +2%', 'info');
      adjustIncline(2);
      return;
    }
    if (matches(text, ['downhill', 'decline', 'less incline'])) {
      showFeedback('⬇ Incline -2%', 'info');
      adjustIncline(-2);
      return;
    }

    // "incline 5" or "set incline to 5"
    var inclineMatch = text.match(/(?:incline|set incline|set incline to|gradient)\s+(\-?\d+(?:\.\d+)?)/);
    if (inclineMatch) {
      var pct = parseFloat(inclineMatch[1]);
      showFeedback('⛰ Incline → ' + pct + '%', 'info');
      setIncline(pct);
      return;
    }

    // ── Status ──
    if (matches(text, ['status', 'stats', 'how am i doing', 'what speed', 'how fast'])) {
      speakStatus();
      return;
    }

    // ── History queries ──
    if (matches(text, ['last run', 'previous run', 'how did my last run go', 'last workout'])) {
      speakLastRun();
      return;
    }
    if (matches(text, ['streak', 'my streak', 'what\'s my streak', 'current streak'])) {
      speakStreak();
      return;
    }
    if (matches(text, ['total distance', 'how far', 'total', 'distance total'])) {
      speakTotal();
      return;
    }
    if (matches(text, ['effort', 'training load', 'effort score', 'how hard'])) {
      speakEffort();
      return;
    }
    if (matches(text, ['pace', 'pb pace', 'personal best', 'am i on pace', 'on track'])) {
      speakPBPace();
      return;
    }
    if (matches(text, ['eta', 'how long', 'time left', 'how much longer', 'remaining'])) {
      speakETA();
      return;
    }
    if (matches(text, ['recovery', 'heart rate recovery', 'hrr', 'how is my recovery'])) {
      speakHRRecovery();
      return;
    }
    if (matches(text, ['fitness', 'form', 'readiness', 'am i fresh', 'fatigue'])) {
      speakFitness();
      return;
    }
    if (matches(text, ['motivation', 'motivate me', 'encourage', 'badges'])) {
      speakMotivation();
      return;
    }
    if (matches(text, ['power', 'watts', 'wattage', 'running power'])) {
      speakPower();
      return;
    }
    if (matches(text, ['race prediction', 'predict', 'race time', 'what could i run'])) {
      speakRacePrediction();
      return;
    }
    if (matches(text, ['splits', 'negative splits', 'my splits', 'split times'])) {
      speakSplits();
      return;
    }
    if (matches(text, ['drift', 'cardiac drift', 'hydration', 'am i drifting'])) {
      speakDrift();
      return;
    }
    if (matches(text, ['efficiency', 'efficiency factor', 'how efficient'])) {
      speakEfficiency();
      return;
    }
    if (matches(text, ['stride', 'stride length', 'how long is my stride'])) {
      speakStride();
      return;
    }
    if (matches(text, ['dynamics', 'running dynamics', 'form', 'running form', 'ground contact'])) {
      speakDynamics();
      return;
    }

    // ── Workout programme control ──
    if (matches(text, ['next', 'next segment', 'skip', 'skip segment'])) {
      showFeedback('⏭ Next segment', 'info');
      if (typeof WorkoutSegments !== 'undefined' && WorkoutSegments.skipToNextSegment) {
        WorkoutSegments.skipToNextSegment();
      }
      return;
    }
    if (matches(text, ['what segment', 'current segment', 'where am i'])) {
      if (typeof WorkoutSegments !== 'undefined' && WorkoutSegments.getCurrentSegment) {
        var seg = WorkoutSegments.getCurrentSegment();
        if (seg) {
          speak('Segment ' + (seg.index + 1) + ': ' + (seg.label || 'unnamed') +
            '. Speed ' + (seg.speed || 0).toFixed(1) + '. Incline ' + (seg.incline || 0) + ' percent.');
        } else {
          speak('No workout programme active');
        }
      }
      return;
    }

    // ── Media control ──
    if (matches(text, ['play music', 'music on', 'radio on', 'play radio'])) {
      showFeedback('🎵 Playing', 'info');
      if (typeof Media !== 'undefined') Media.play();
      return;
    }
    if (matches(text, ['stop music', 'music off', 'radio off', 'mute', 'quiet'])) {
      showFeedback('🔇 Stopped', 'info');
      if (typeof Media !== 'undefined') Media.stop();
      return;
    }
    if (matches(text, ['volume up', 'louder'])) {
      showFeedback('🔊 Volume up', 'info');
      if (typeof Media !== 'undefined') Media.adjustVolume(0.15);
      return;
    }
    if (matches(text, ['volume down', 'quieter'])) {
      showFeedback('🔉 Volume down', 'info');
      if (typeof Media !== 'undefined') Media.adjustVolume(-0.15);
      return;
    }
    if (matches(text, ['next station', 'next channel', 'change station'])) {
      showFeedback('📻 Next station', 'info');
      if (typeof Media !== 'undefined') Media.nextStation();
      return;
    }

    console.log('[Voice] Unrecognized: "' + text + '"');
  }

  function matches(text, phrases) {
    for (var i = 0; i < phrases.length; i++) {
      var p = phrases[i];
      if (text === p) return true;
      // Word-boundary match: prevent "go" matching "good", "stop" matching "nonstop"
      var re = new RegExp('(?:^|\\s)' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)');
      if (re.test(text)) return true;
    }
    return false;
  }

  function adjustSpeed(delta) {
    if (typeof TM === 'undefined') return;
    var current = TM._lastSpeed > 0 ? TM._lastSpeed : 0;
    setSpeed(Math.max(0, Math.min(19.3, current + delta)));
  }

  function setSpeed(kph) {
    if (typeof TM !== 'undefined' && TM.setSpeed) {
      TM.setSpeed(kph, true); // force=true to bypass rate limiter
    }
  }

  function adjustIncline(delta) {
    if (typeof TM === 'undefined') return;
    var current = TM._lastIncline > -9000 ? TM._lastIncline : 0;
    setIncline(Math.max(-6, Math.min(40, current + delta)));
  }

  function setIncline(pct) {
    if (typeof TM !== 'undefined' && TM.setIncline) {
      TM.setIncline(pct, true); // force=true to bypass rate limiter
    }
  }

  function speakStatus() {
    if (typeof TM === 'undefined') return;
    var speed = TM._lastSpeed > 0 ? TM._lastSpeed : 0;
    var incline = TM._lastIncline > -9000 ? TM._lastIncline : 0;
    var msg = 'Speed ' + speed.toFixed(1) + ' K P H, incline ' + incline.toFixed(0) + ' percent';

    showFeedback('📊 ' + msg, 'info');

    // Use browser TTS if available (Chrome 33+)
    if ('speechSynthesis' in window) {
      var u = new SpeechSynthesisUtterance(msg);
      u.rate = 1.2;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    }
  }

  function showFeedback(text, type) {
    // Show a toast-style notification
    var toast = document.getElementById('voiceToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'voiceToast';
      toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);' +
        'padding:12px 24px;border-radius:12px;font-size:16px;font-weight:700;z-index:350;' +
        'pointer-events:none;opacity:0;transition:opacity .3s;font-family:Rajdhani,sans-serif;' +
        'text-align:center;min-width:200px;';
      document.body.appendChild(toast);
    }

    var colors = {
      info: 'rgba(62,207,255,.9)',
      success: 'rgba(0,230,118,.9)',
      warn: 'rgba(255,171,0,.9)',
      danger: 'rgba(255,61,87,.9)'
    };
    toast.style.background = 'rgba(10,22,40,.95)';
    toast.style.color = colors[type] || colors.info;
    toast.style.border = '2px solid ' + (colors[type] || colors.info);
    toast.textContent = text;
    toast.style.opacity = '1';

    clearTimeout(toast._timer);
    toast._timer = setTimeout(function() {
      toast.style.opacity = '0';
    }, 2500);
  }

  function speak(msg) {
    if ('speechSynthesis' in window) {
      var u = new SpeechSynthesisUtterance(msg);
      u.rate = 1.1;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    }
    showFeedback(msg, 'info');
  }

  function speakLastRun() {
    if (typeof Store === 'undefined') return;
    var runs = Store.getRuns();
    if (!runs.length) {
      speak('No runs recorded yet. Get out there!');
      return;
    }
    var r = runs[0];
    var dist = (r.distanceKm || 0).toFixed(1);
    var elapsed = r.elapsedSec || r.elapsed || 0;
    var mins = Math.floor(elapsed / 60);
    var avgSpd = (r.avgSpeed || 0).toFixed(1);
    var cals = Math.round(r.calories || 0);
    speak('Last run: ' + dist + ' K M in ' + mins + ' minutes, average speed ' + avgSpd + ' K P H, ' + cals + ' calories burned');
  }

  function speakStreak() {
    if (typeof Streaks === 'undefined') return;
    var d = Streaks.getData();
    speak('Current streak: ' + d.currentStreak + ' days. Longest ever: ' + d.longestStreak + ' days. Total workouts: ' + d.totalWorkouts);
  }

  function speakTotal() {
    if (typeof Streaks === 'undefined') return;
    var d = Streaks.getData();
    speak('Total distance: ' + d.totalDistanceKm.toFixed(1) + ' K M across ' + d.totalWorkouts + ' workouts');
  }

  function speakEffort() {
    if (typeof Engine === 'undefined' || !Engine.run) {
      speak('No active run');
      return;
    }
    var score = Engine.getEffortScore();
    if (score <= 0) {
      speak('Effort score building up. Keep going!');
    } else {
      var label = Engine.getEffortLabel(score);
      speak('Current effort: ' + score + '. ' + label + ' intensity.');
    }
  }

  function speakPBPace() {
    if (typeof Engine === 'undefined' || !Engine.run || Engine.run.status !== 'running') {
      speak('No active run');
      return;
    }
    var r = Engine.run;
    if (!Engine.route || !Engine.route.bestTime) {
      speak('No personal best for this route yet');
      return;
    }
    if (r.routeProgress < 0.02 || r.elapsed < 10) {
      speak('Too early to project. Keep going!');
      return;
    }
    var projected = r.elapsed / r.routeProgress;
    var diff = projected - Engine.route.bestTime;
    var absDiff = Math.abs(Math.round(diff));
    var mins = Math.floor(absDiff / 60);
    var secs = absDiff % 60;
    var timeStr = mins > 0 ? mins + ' minutes ' + secs + ' seconds' : secs + ' seconds';
    if (diff < -5) {
      speak('You are ' + timeStr + ' ahead of your personal best! Keep it up!');
    } else if (diff > 5) {
      speak('You are ' + timeStr + ' behind your personal best. Push harder!');
    } else {
      speak('You are right on personal best pace!');
    }
  }

  function speakETA() {
    if (typeof Engine === 'undefined' || !Engine.run || Engine.run.status !== 'running') {
      speak('No active run');
      return;
    }
    var r = Engine.run;
    if (r.routeProgress > 0.02 && r.elapsed > 10 && Engine.route) {
      var etaSec = Math.round((r.elapsed / r.routeProgress) - r.elapsed);
      if (etaSec > 0 && etaSec < 36000) {
        var etaM = Math.floor(etaSec / 60);
        var etaS = etaSec % 60;
        speak('About ' + etaM + ' minutes and ' + etaS + ' seconds remaining');
        return;
      }
    }
    // Fallback: just speak distance and time
    var distKm = (r.distanceM / 1000).toFixed(1);
    var elapsed = Math.round(r.elapsed);
    var mins = Math.floor(elapsed / 60);
    speak('You have covered ' + distKm + ' K M in ' + mins + ' minutes');
  }

  function speakHRRecovery() {
    if (!Engine.run) { speak('No run data'); return; }
    var hrr = Engine.run._hrRecovery;
    if (hrr) {
      var rating = hrr.drop >= 40 ? 'excellent' : hrr.drop >= 25 ? 'good' : hrr.drop >= 12 ? 'average' : 'below average';
      speak('Heart rate recovery is ' + rating + '. Your heart rate dropped ' + hrr.drop + ' beats in one minute, from ' + hrr.hrAtFinish + ' to ' + hrr.hrAfter60s);
    } else if (Engine.run.status === 'finished' && Engine.run._recoveryStart) {
      var secLeft = Math.max(0, Math.round(60 - (Date.now() - Engine.run._recoveryStart) / 1000));
      if (secLeft > 0) {
        speak('Still measuring recovery. ' + secLeft + ' seconds remaining');
      } else {
        speak('No heart rate data received during recovery');
      }
    } else {
      speak('Heart rate recovery is measured after finishing a run');
    }
  }

  function speakFitness() {
    // Calculate CTL/ATL/TSB from stored runs
    try {
      var runs = JSON.parse(localStorage.getItem('tr_runs') || '[]');
      if (runs.length < 2) { speak('Need more runs to calculate fitness'); return; }
      var dailyTrimp = {};
      var hasEffort = false;
      for (var i = 0; i < runs.length; i++) {
        var dateStr = (runs[i].savedAt || '').slice(0, 10);
        if (!dateStr) continue;
        if (!dailyTrimp[dateStr]) dailyTrimp[dateStr] = 0;
        dailyTrimp[dateStr] += (runs[i].effortScore || 0);
        if (runs[i].effortScore > 0) hasEffort = true;
      }
      if (!hasEffort) { speak('No effort data yet. Connect a heart rate monitor'); return; }
      var today = new Date(); today.setHours(0,0,0,0);
      var start = new Date(today); start.setDate(start.getDate() - 89);
      var ctl = 0, atl = 0;
      for (var d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
        var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        var trimp = dailyTrimp[key] || 0;
        ctl += (trimp - ctl) / 42;
        atl += (trimp - atl) / 7;
      }
      var tsb = ctl - atl;
      var label = tsb > 15 ? 'peaked and well rested' : tsb > 5 ? 'fresh' : tsb > -10 ? 'neutral' : tsb > -25 ? 'tired' : 'fatigued';
      speak('Your form is ' + label + '. Fitness ' + Math.round(ctl) + ', fatigue ' + Math.round(atl) + ', form ' + Math.round(tsb));
    } catch(e) {
      speak('Could not calculate fitness data');
    }
  }

  function speakMotivation() {
    if (typeof Streaks === 'undefined') return;
    var msg = Streaks.getMotivationMessage();
    speak(msg);
  }

  function speakPower() {
    if (typeof Engine === 'undefined' || !Engine.run) {
      speak('No active run');
      return;
    }
    var power = Engine.getPower();
    var avg = Engine.getAvgPower();
    if (power <= 0 && avg <= 0) {
      speak('Power data building up. Keep running!');
    } else {
      speak('Current power: ' + power + ' watts. Average: ' + avg + ' watts.');
    }
  }

  function speakRacePrediction() {
    // Riegel formula: T2 = T1 × (D2/D1)^1.06
    try {
      var runs = JSON.parse(localStorage.getItem('tr_runs') || '[]');
      if (runs.length === 0) { speak('No run data for predictions'); return; }
      // Find best pace run with at least 2km
      var bestPace = Infinity;
      var bestDist = 0;
      var bestTime = 0;
      for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        var dist = r.distanceKm || (r.distanceM || 0) / 1000;
        var elapsed = r.elapsedSec || r.elapsed || 0;
        if (dist >= 2 && elapsed > 0) {
          var pace = elapsed / dist;
          if (pace < bestPace) {
            bestPace = pace;
            bestDist = dist;
            bestTime = elapsed;
          }
        }
      }
      if (bestDist < 2) { speak('Need at least a 2 K run for predictions'); return; }
      var predict5k = bestTime * Math.pow(5 / bestDist, 1.06);
      var predict10k = bestTime * Math.pow(10 / bestDist, 1.06);
      var predictHalf = bestTime * Math.pow(21.1 / bestDist, 1.06);
      var fmtTime = function(s) {
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = Math.round(s % 60);
        if (h > 0) return h + ' hours ' + m + ' minutes';
        return m + ' minutes ' + sec + ' seconds';
      };
      speak('Based on your best pace, predicted 5 K: ' + fmtTime(predict5k) +
        '. 10 K: ' + fmtTime(predict10k) +
        '. Half marathon: ' + fmtTime(predictHalf));
    } catch(e) {
      speak('Could not calculate race predictions');
    }
  }

  function speakSplits() {
    if (typeof Engine === 'undefined' || !Engine.run) {
      speak('No active run');
      return;
    }
    var splits = Engine.run.splits;
    if (!splits || splits.length === 0) {
      speak('No splits yet. Keep running!');
      return;
    }
    var negCount = 0;
    for (var i = 0; i < splits.length; i++) {
      if (splits[i].negativeSplit) negCount++;
    }
    var last = splits[splits.length - 1];
    var mins = Math.floor(last.timeSec / 60);
    var secs = last.timeSec % 60;
    var msg = splits.length + ' splits completed. Last K M: ' + mins + ' minutes ' + secs + ' seconds.';
    if (negCount > 0) {
      msg += ' ' + negCount + ' negative splits. Nice pacing!';
    }
    speak(msg);
  }

  function speakDrift() {
    if (typeof Engine === 'undefined' || !Engine.run) {
      speak('No active run');
      return;
    }
    var drift = Engine.getDriftPct();
    if (!Engine.run._driftBaselineLocked) {
      speak('Cardiac drift needs at least 10 minutes of data. Keep running!');
      return;
    }
    var label = Engine.getDriftLabel(drift);
    var msg = 'Cardiac drift: ' + Math.round(drift) + ' percent. ' + label + '.';
    if (drift >= 5) {
      msg += ' Consider drinking water.';
    } else if (drift < 2) {
      msg += ' Your heart rate is very stable. Great hydration!';
    }
    speak(msg);
  }

  function speakEfficiency() {
    if (typeof Engine === 'undefined' || !Engine.run) {
      speak('No active run');
      return;
    }
    var ef = Engine.getEF();
    if (ef <= 0) {
      speak('Efficiency data building up. Keep running!');
      return;
    }
    // EF of 0.06-0.08 is typical for recreational runners
    var efRating = ef > 0.08 ? 'excellent' : ef > 0.065 ? 'good' : ef > 0.05 ? 'average' : 'developing';
    speak('Efficiency factor: ' + (ef * 100).toFixed(1) + '. Rated ' + efRating + '.');
  }

  function speakDynamics() {
    if (typeof Engine === 'undefined' || !Engine.run) {
      speak('No active run');
      return;
    }
    var parts = [];
    if (Engine.run.cadence > 0) {
      parts.push('Cadence: ' + Engine.run.cadence + ' steps per minute');
    }
    if (Engine.run.strideLength > 0) {
      parts.push('Stride: ' + Engine.run.strideLength.toFixed(2) + ' metres');
    }
    if (Engine.run.gct > 0) {
      parts.push('Ground contact: ' + Engine.run.gct + ' milliseconds');
      var gctRating = Engine.run.gct < 250 ? 'elite' : Engine.run.gct < 280 ? 'excellent' : Engine.run.gct < 310 ? 'good' : 'could improve';
      parts.push(gctRating);
    }
    if (Engine.run.vertOsc > 0) {
      parts.push('Vertical oscillation: ' + Engine.run.vertOsc + ' centimetres');
    }
    if (parts.length === 0) {
      speak('Running dynamics not available yet. Keep running!');
    } else {
      speak(parts.join('. ') + '.');
    }
  }

  function speakStride() {
    if (typeof Engine === 'undefined' || !Engine.run) {
      speak('No active run');
      return;
    }
    var stride = Engine.run.strideLength || 0;
    var avgStride = Engine.getAvgStride();
    if (stride <= 0) {
      speak('Stride length data not available yet.');
      return;
    }
    var msg = 'Current stride length: ' + stride.toFixed(2) + ' metres.';
    if (avgStride > 0) {
      msg += ' Average: ' + avgStride + ' metres.';
      // Typical stride: 0.7-0.9m walking, 1.0-1.5m jogging, 1.5-2.0m running
      var rating = avgStride >= 1.5 ? 'Strong stride' : avgStride >= 1.1 ? 'Good stride length' : 'Short stride, try increasing cadence';
      msg += ' ' + rating + '.';
    }
    speak(msg);
  }

  function updateMicIcon(active) {
    var btn = document.getElementById('voiceMicBtn');
    if (btn) {
      btn.style.color = active ? 'var(--cyan, #3ecfff)' : 'var(--dim, #4a6785)';
      btn.title = active ? 'Voice: listening (click to stop)' : 'Voice: off (click to start)';
    }
  }

  // Public API
  return {
    supported: true,
    init: init,
    start: startListening,
    stop: stopListening,
    toggle: toggleContinuous,
    isListening: function() { return isListening && enabled; },
    processCommand: processCommand // exposed for testing
  };
})();
