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

    // Require minimum confidence for motor-control commands
    if (confidence < 0.5) {
      showFeedback('🎤 Didn\'t catch that', 'warn');
      return;
    }

    // ── Emergency (lowest confidence threshold) ──
    if (matches(text, ['emergency', 'stop stop', 'help', 'emergency stop'])) {
      showFeedback('🛑 EMERGENCY STOP', 'danger');
      if (typeof App !== 'undefined' && App.emergencyStop) {
        App.emergencyStop();
      }
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

    console.log('[Voice] Unrecognized: "' + text + '"');
  }

  function matches(text, phrases) {
    for (var i = 0; i < phrases.length; i++) {
      if (text === phrases[i] || text.indexOf(phrases[i]) !== -1) return true;
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
