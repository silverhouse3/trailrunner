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
//   "motivation"             → Speak next badge progress
//   "next" / "skip"          → Skip to next workout segment
//   "what segment"           → Speak current segment info
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
    if (matches(text, ['motivation', 'motivate me', 'encourage', 'badges'])) {
      speakMotivation();
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
    setSpeed(Math.max(0, Math.min(22, current + delta)));
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

  function speakMotivation() {
    if (typeof Streaks === 'undefined') return;
    var msg = Streaks.getMotivationMessage();
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
