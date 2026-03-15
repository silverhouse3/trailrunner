// ════════════════════════════════════════════════════════════════════════════
// Voice — speech recognition commands + TTS coaching
// ════════════════════════════════════════════════════════════════════════════

// ── Voice Commands (Speech Recognition) ─────────────────────────────────────

const VoiceCmd = {
  listening: false,
  recognition: null,
  wakeWordDetected: false,

  // Callbacks
  onCommand: null,    // (command, args) =>
  onStatus: null,     // (status) => 'listening' | 'processing' | 'idle' | 'error'

  // Config
  config: {
    enabled: false,
    wakeWord: 'trailrunner',
    sensitivity: 'medium',    // low | medium | high
    confirmSounds: true,
  },

  // Internals
  _commandTimeout: null,
  _stopConfirmPending: false,
  _stopConfirmTimer: null,

  // ── Command definitions ───────────────────────────────────────────────────

  COMMANDS: [
    { patterns: ['speed up', 'faster'], action: 'speed_up' },
    { patterns: ['slow down', 'speed down', 'slower'], action: 'speed_down' },
    { patterns: ['speed (\\d+\\.?\\d*)'], action: 'speed_set', extract: 'number' },
    { patterns: ['incline up', 'hill up'], action: 'incline_up' },
    { patterns: ['incline down', 'hill down'], action: 'incline_down' },
    { patterns: ['incline (\\d+)'], action: 'incline_set', extract: 'number' },
    { patterns: ['pause', 'pause workout'], action: 'pause' },
    { patterns: ['resume', 'continue', 'go'], action: 'resume' },
    { patterns: ['stop', 'stop workout', 'end'], action: 'stop' },
    { patterns: ['skip', 'next segment', 'next'], action: 'skip_segment' },
    { patterns: ['how far', 'distance', 'how much left'], action: 'query_distance' },
    { patterns: ['how fast', 'what speed', 'speed'], action: 'query_speed' },
    { patterns: ['heart rate', 'pulse', 'bpm'], action: 'query_hr' },
    { patterns: ['time', 'how long', 'elapsed'], action: 'query_time' },
    { patterns: ['ghost', 'am i winning'], action: 'query_ghost' },
    { patterns: ['louder', 'volume up'], action: 'volume_up' },
    { patterns: ['quieter', 'volume down', 'quiet'], action: 'volume_down' },
    { patterns: ['mute'], action: 'mute' },
    { patterns: ['unmute'], action: 'unmute' },
  ],

  // ── Init ──────────────────────────────────────────────────────────────────

  init() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[VoiceCmd] Speech recognition not available');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-GB';
    this.recognition.maxAlternatives = 1;

    var self = this;

    this.recognition.onresult = function(event) {
      self._handleResult(event);
    };

    this.recognition.onerror = function(event) {
      console.warn('[VoiceCmd] Error:', event.error);
      if (event.error === 'no-speech' || event.error === 'aborted') {
        // Benign — just restart if we should be listening
        if (self.listening) {
          setTimeout(function() { self._restartRecognition(); }, 500);
        }
        return;
      }
      self.listening = false;
      self.wakeWordDetected = false;
      if (self.onStatus) self.onStatus('error');
    };

    this.recognition.onend = function() {
      // Auto-restart if we should still be listening
      if (self.listening) {
        setTimeout(function() { self._restartRecognition(); }, 300);
      }
    };

    console.log('[VoiceCmd] Initialised');
  },

  // ── Start / Stop ──────────────────────────────────────────────────────────

  startListening() {
    if (!this.recognition) return;
    if (this.listening) return;

    this.listening = true;
    this.wakeWordDetected = false;
    this._clearCommandTimeout();

    try {
      this.recognition.start();
    } catch (e) {
      // Already started — ignore
    }

    if (this.onStatus) this.onStatus('listening');
    console.log('[VoiceCmd] Listening started');
  },

  stopListening() {
    if (!this.recognition) return;

    this.listening = false;
    this.wakeWordDetected = false;
    this._clearCommandTimeout();

    try {
      this.recognition.stop();
    } catch (e) {
      // Already stopped — ignore
    }

    if (this.onStatus) this.onStatus('idle');
    console.log('[VoiceCmd] Listening stopped');
  },

  _restartRecognition() {
    if (!this.listening || !this.recognition) return;
    try {
      this.recognition.start();
    } catch (e) {
      // May already be running
    }
  },

  // ── Result handling ───────────────────────────────────────────────────────

  _handleResult(event) {
    var transcript = '';
    var isFinal = false;

    for (var i = event.resultIndex; i < event.results.length; i++) {
      var result = event.results[i];
      transcript += result[0].transcript;
      if (result.isFinal) isFinal = true;
    }

    transcript = transcript.toLowerCase().trim();
    if (!transcript) return;

    // Wake word detection on interim results
    if (!this.wakeWordDetected) {
      if (this._containsWakeWord(transcript)) {
        this.wakeWordDetected = true;
        if (this.onStatus) this.onStatus('processing');
        if (this.config.confirmSounds) this._playTone(880, 100);

        // Start 5-second timeout for command
        this._startCommandTimeout();

        // Strip wake word from transcript and check for inline command
        var afterWake = this._stripWakeWord(transcript);
        if (afterWake && isFinal) {
          this._processCommand(afterWake);
        }
      }
      return;
    }

    // Wake word already detected — capture command
    if (isFinal) {
      var cleaned = this._stripWakeWord(transcript);
      if (cleaned) {
        this._processCommand(cleaned);
      }
    }
  },

  _containsWakeWord(text) {
    var word = this.config.wakeWord.toLowerCase();
    // Accept: "trailrunner", "hey trailrunner", "hey TR"
    if (text.indexOf(word) !== -1) return true;
    if (text.indexOf('hey ' + word) !== -1) return true;
    if (text.indexOf('hey tr') !== -1) return true;
    // Sensitivity-based fuzzy matching
    if (this.config.sensitivity === 'high') {
      if (text.indexOf('trail') !== -1) return true;
      if (text.indexOf('hey tea') !== -1) return true;
    }
    return false;
  },

  _stripWakeWord(text) {
    var word = this.config.wakeWord.toLowerCase();
    text = text.replace('hey ' + word, '').replace(word, '').replace('hey tr', '').trim();
    return text;
  },

  // ── Command parsing ───────────────────────────────────────────────────────

  _processCommand(text) {
    this._clearCommandTimeout();
    this.wakeWordDetected = false;

    text = text.toLowerCase().trim();
    if (!text) return;

    // Try to match against command patterns
    for (var i = 0; i < this.COMMANDS.length; i++) {
      var cmd = this.COMMANDS[i];
      for (var j = 0; j < cmd.patterns.length; j++) {
        var pattern = cmd.patterns[j];
        var regex = new RegExp(pattern, 'i');
        var match = text.match(regex);
        if (match) {
          var args = null;
          if (cmd.extract === 'number' && match[1]) {
            args = parseFloat(match[1]);
          }

          // Safety: "stop" requires double-confirmation
          if (cmd.action === 'stop') {
            if (!this._handleStopConfirmation()) return;
          }

          // Safety: speed changes clamped
          if (cmd.action === 'speed_set' && args !== null) {
            args = this._clampSpeedChange(args);
            if (args === null) {
              VoiceCoach.say('Speed change too large. Maximum 3 kph above current speed.', 'high');
              return;
            }
          }

          // Safety: voice commands disabled during cool-down
          if (Engine.run && Engine.run._cooldown) {
            if (cmd.action !== 'query_distance' && cmd.action !== 'query_speed' &&
                cmd.action !== 'query_hr' && cmd.action !== 'query_time' &&
                cmd.action !== 'query_ghost') {
              VoiceCoach.say('Commands disabled during cool down.', 'high');
              return;
            }
          }

          if (this.config.confirmSounds) this._playTone(1200, 80);
          console.log('[VoiceCmd] Command: ' + cmd.action + (args !== null ? ' (' + args + ')' : ''));
          if (this.onCommand) this.onCommand(cmd.action, args);
          if (this.onStatus) this.onStatus('listening');
          return;
        }
      }
    }

    // No match
    console.log('[VoiceCmd] Unrecognised: "' + text + '"');
    if (this.config.confirmSounds) this._playTone(220, 200);
    if (this.onStatus) this.onStatus('listening');
  },

  // ── Safety: stop double-confirmation ──────────────────────────────────────

  _handleStopConfirmation() {
    if (this._stopConfirmPending) {
      // Second "stop" within window — confirmed
      this._stopConfirmPending = false;
      if (this._stopConfirmTimer) {
        clearTimeout(this._stopConfirmTimer);
        this._stopConfirmTimer = null;
      }
      return true;
    }

    // First "stop" — ask for confirmation
    this._stopConfirmPending = true;
    VoiceCoach.say('Say stop again to confirm.', 'high');

    var self = this;
    this._stopConfirmTimer = setTimeout(function() {
      self._stopConfirmPending = false;
      self._stopConfirmTimer = null;
    }, 5000);

    return false;
  },

  // ── Safety: clamp speed changes ───────────────────────────────────────────

  _clampSpeedChange(requestedSpeed) {
    if (!Engine.run) return requestedSpeed;
    var currentSpeed = Engine.run.speed || 0;
    if (requestedSpeed > currentSpeed + 3) return null;
    return Math.max(0, requestedSpeed);
  },

  // ── Command timeout ───────────────────────────────────────────────────────

  _startCommandTimeout() {
    this._clearCommandTimeout();
    var self = this;
    this._commandTimeout = setTimeout(function() {
      if (self.wakeWordDetected) {
        self.wakeWordDetected = false;
        if (self.onStatus) self.onStatus('listening');
        console.log('[VoiceCmd] Command timeout — returning to wake word mode');
      }
    }, 5000);
  },

  _clearCommandTimeout() {
    if (this._commandTimeout) {
      clearTimeout(this._commandTimeout);
      this._commandTimeout = null;
    }
  },

  // ── Audio feedback ────────────────────────────────────────────────────────

  _audioCtx: null,
  _playTone(freq, durationMs) {
    try {
      // Reuse a single AudioContext to avoid Chrome's 6-context limit
      if (!this._audioCtx || this._audioCtx.state === 'closed') {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      var ctx = this._audioCtx;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.value = 0.15;
      osc.start();
      osc.stop(ctx.currentTime + durationMs / 1000);
    } catch (e) {
      // Audio context not available — silent
    }
  },
};


// ── Voice Coach (TTS) ───────────────────────────────────────────────────────

var VoiceCoach = {
  speaking: false,
  queue: [],

  // Config
  config: {
    enabled: true,
    verbosity: 'normal',   // minimal | normal | chatty
    volume: 0.8,
    voice: null,           // selected SpeechSynthesisVoice
  },

  // Internals
  _synth: null,
  _bridgeFallback: false,

  // Encouragement phrases for chatty mode
  _encouragements: [
    'Keep it up!',
    'Looking strong!',
    'Great pace!',
    'You\'re smashing it!',
    'Stay focused!',
    'Nice and steady!',
    'Push through!',
    'Nearly there!',
  ],

  // ── Init ──────────────────────────────────────────────────────────────────

  init() {
    if (window.speechSynthesis) {
      this._synth = window.speechSynthesis;
      // Pre-load voices (Chrome loads them async)
      var self = this;
      if (this._synth.onvoiceschanged !== undefined) {
        this._synth.onvoiceschanged = function() { self._selectVoice(); };
      }
      // Try selecting immediately (may already be loaded)
      this._selectVoice();
    } else {
      console.warn('[VoiceCoach] SpeechSynthesis not available — trying bridge fallback');
      this._bridgeFallback = true;
    }
    console.log('[VoiceCoach] Initialised');
  },

  _selectVoice() {
    if (!this._synth) return;
    var voices = this._synth.getVoices();
    if (!voices.length) return;

    // Prefer a UK English voice
    var preferred = null;
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if (v.lang === 'en-GB' && !v.name.toLowerCase().match(/google/)) {
        preferred = v;
        break;
      }
    }
    // Fallback: any English voice
    if (!preferred) {
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].lang.indexOf('en') === 0) {
          preferred = voices[i];
          break;
        }
      }
    }
    if (preferred) {
      this.config.voice = preferred;
      console.log('[VoiceCoach] Voice: ' + preferred.name + ' (' + preferred.lang + ')');
    }
  },

  // ── Core speak ────────────────────────────────────────────────────────────

  say(text, priority) {
    if (!this.config.enabled) return;
    priority = priority || 'medium';

    if (priority === 'high') {
      // Interrupt current speech
      this._cancelCurrent();
      this._speak(text);
    } else if (priority === 'medium') {
      if (this.speaking) {
        this.queue.push(text);
      } else {
        this._speak(text);
      }
    } else {
      // Low priority — only speak if nothing else playing or queued
      if (!this.speaking && this.queue.length === 0) {
        this._speak(text);
      }
    }
  },

  _speak(text) {
    if (this._bridgeFallback) {
      this._speakViaBridge(text);
      return;
    }
    if (!this._synth) return;

    // Mute mic during TTS to prevent feedback
    var wasMicActive = VoiceCmd.listening;
    if (wasMicActive && VoiceCmd.recognition) {
      try { VoiceCmd.recognition.stop(); } catch (e) {}
    }

    this.speaking = true;
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = this.config.volume;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    if (this.config.voice) utterance.voice = this.config.voice;

    var self = this;
    utterance.onend = function() {
      self.speaking = false;
      // Resume mic after TTS
      if (wasMicActive) {
        setTimeout(function() {
          if (VoiceCmd.listening) VoiceCmd._restartRecognition();
        }, 300);
      }
      // Process queue
      self._processQueue();
    };

    utterance.onerror = function() {
      self.speaking = false;
      if (wasMicActive) {
        setTimeout(function() {
          if (VoiceCmd.listening) VoiceCmd._restartRecognition();
        }, 300);
      }
      self._processQueue();
    };

    this._synth.speak(utterance);
  },

  _speakViaBridge(text) {
    this.speaking = true;
    var self = this;
    fetch('http://localhost:4510/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).then(function() {
      self.speaking = false;
      self._processQueue();
    }).catch(function() {
      self.speaking = false;
      self._processQueue();
    });
  },

  _cancelCurrent() {
    if (this._synth) {
      this._synth.cancel();
    }
    this.speaking = false;
    this.queue = [];
  },

  _processQueue() {
    if (this.queue.length > 0 && !this.speaking) {
      var next = this.queue.shift();
      this._speak(next);
    }
  },

  // ── Number formatting ─────────────────────────────────────────────────────

  _fmtSpeed(speed) {
    if (speed <= 0) return '0';
    var whole = Math.floor(speed);
    var dec = Math.round((speed - whole) * 10);
    if (dec === 0) return String(whole);
    return whole + ' point ' + dec;
  },

  _fmtTime(totalSec) {
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = Math.floor(totalSec % 60);
    var parts = [];
    if (h > 0) parts.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m > 0) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
    if (s > 0 && h === 0) parts.push(s + (s === 1 ? ' second' : ' seconds'));
    return parts.join(' and ') || '0 seconds';
  },

  _fmtDist(km) {
    if (km < 1) {
      return Math.round(km * 1000) + ' metres';
    }
    var whole = Math.floor(km);
    var dec = Math.round((km - whole) * 10);
    if (dec === 0) return whole + (whole === 1 ? ' kilometre' : ' kilometres');
    return whole + ' point ' + dec + ' kilometres';
  },

  _fmtZone(zone) {
    var labels = {
      1: 'zone 1, recovery',
      2: 'zone 2, aerobic',
      3: 'zone 3, tempo',
      4: 'zone 4, threshold',
      5: 'zone 5, V O 2 max',
    };
    return labels[zone] || 'zone ' + zone;
  },

  // ── Pre-built announcements ───────────────────────────────────────────────

  announceSegmentChange(segment) {
    var text = 'Next segment: ' + (segment.name || 'unnamed');
    if (segment.speed) text += '. Target speed ' + this._fmtSpeed(segment.speed) + ' k p h.';
    if (segment.incline != null) text += ' Incline ' + segment.incline + ' percent.';
    this.say(text, 'high');
  },

  announceCountdown(seconds) {
    if (this.config.verbosity === 'minimal') return;
    if (seconds <= 3) {
      this.say(String(seconds), 'high');
    } else if (seconds === 5) {
      this.say('5 seconds.', 'medium');
    } else if (seconds === 10) {
      this.say('10 seconds.', 'medium');
    }
  },

  announceHalfway(remaining, unit) {
    if (this.config.verbosity === 'minimal') return;
    var text = 'Halfway! ';
    if (unit === 'time') {
      text += this._fmtTime(remaining) + ' remaining.';
    } else {
      text += this._fmtDist(remaining) + ' to go.';
    }
    this.say(text, 'medium');
  },

  announceHRZone(zone, action) {
    if (this.config.verbosity === 'minimal') return;
    var text = 'Heart rate ' + this._fmtZone(zone) + '.';
    if (action === 'up') text += ' Ease off a bit.';
    else if (action === 'down') text += ' Pick it up.';
    this.say(text, 'medium');
  },

  announceGhostDelta(seconds) {
    if (this.config.verbosity !== 'chatty') return;
    var abs = Math.abs(seconds);
    var text;
    if (seconds >= 0) {
      text = 'You\'re ' + Math.round(abs) + ' seconds ahead of your ghost.';
    } else {
      text = 'You\'re ' + Math.round(abs) + ' seconds behind your ghost. Pick it up!';
    }
    this.say(text, 'low');
  },

  announceWarmupComplete() {
    this.say('Warm up complete. Let\'s go!', 'high');
  },

  announceCooldownStart() {
    this.say('Starting cool down. Great work today!', 'high');
  },

  announceWorkoutComplete() {
    this.say('Workout complete! Well done.', 'high');
    if (this.config.verbosity === 'chatty') {
      var idx = Math.floor(Math.random() * this._encouragements.length);
      var self = this;
      setTimeout(function() {
        self.say(self._encouragements[idx], 'low');
      }, 2000);
    }
  },

  announceDistance(dist, unit) {
    var text;
    if (unit === 'remaining') {
      text = this._fmtDist(dist) + ' remaining.';
    } else {
      text = 'Distance: ' + this._fmtDist(dist) + '.';
    }
    this.say(text, 'medium');
  },

  announceSpeed(speed, unit) {
    unit = unit || 'kph';
    var text = 'Speed: ' + this._fmtSpeed(speed);
    text += unit === 'mph' ? ' miles per hour.' : ' kilometres per hour.';
    this.say(text, 'medium');
  },

  announceHR(bpm, zone) {
    var text = 'Heart rate: ' + bpm + ' beats per minute.';
    if (zone) text += ' ' + this._fmtZone(zone) + '.';
    this.say(text, 'medium');
  },

  announceTime(elapsed) {
    this.say('Elapsed: ' + this._fmtTime(elapsed) + '.', 'medium');
  },

  announceSpeedChange(newSpeed, oldSpeed, unit) {
    unit = unit || 'kph';
    var direction = newSpeed > oldSpeed ? 'increasing' : 'decreasing';
    var text = 'Speed ' + direction + ' to ' + this._fmtSpeed(newSpeed);
    text += unit === 'mph' ? ' miles per hour.' : ' kilometres per hour.';
    this.say(text, 'high');
  },

  announceInclineChange(newIncline, oldIncline) {
    var direction = newIncline > oldIncline ? 'going up' : 'coming down';
    var text = 'Incline ' + direction + ' to ' + Math.abs(newIncline) + ' percent.';
    this.say(text, 'high');
  },

  announceHRZoneChange(zone) {
    var text = 'Heart rate now in ' + this._fmtZone(zone) + '.';
    this.say(text, 'medium');
  },

  announceAvgHR(avgBpm, zone, elapsed) {
    var mins = Math.floor(elapsed / 60);
    var text = mins + ' minute average heart rate: ' + avgBpm + ' beats per minute.';
    if (zone) text += ' ' + this._fmtZone(zone) + '.';
    this.say(text, 'medium');
  },

  announceSplit(splitNum, unit, timeSec, avgHR, zone) {
    var unitLabel = unit === 'mi' ? 'mile' : 'kilometre';
    var text = 'Last ' + unitLabel + ' done in ' + this._fmtTime(timeSec);
    if (avgHR > 0 && zone) {
      text += ', average heart rate ' + this._fmtZone(zone);
    }
    text += '.';
    this.say(text, 'medium');
  },

  announceDistanceMilestone(distKm) {
    var text;
    if (distKm >= 42.195) text = 'Full marathon distance reached! Incredible!';
    else if (distKm >= 21.1) text = 'Half marathon distance reached! Amazing!';
    else if (distKm >= 10) text = '10 K reached! Great work!';
    else if (distKm >= 5) text = '5 K reached! Keep going!';
    else return;
    this.say(text, 'high');
  },

  // ── Voice listing for settings ─────────────────────────────────────────

  getAvailableVoices() {
    if (!this._synth) return [];
    return this._synth.getVoices().filter(function(v) {
      return v.lang.indexOf('en') === 0;
    });
  },

  setVoiceByName(name) {
    if (!this._synth) return;
    var voices = this._synth.getVoices();
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].name === name) {
        this.config.voice = voices[i];
        console.log('[VoiceCoach] Voice set to:', name);
        return;
      }
    }
  },
};


// ── Milestone Tracker ────────────────────────────────────────────────────────
// Detects speed, incline, HR zone changes + periodic avg HR + split summaries
// Also shows visual popup toasts as a non-audio fallback

var MilestoneTracker = {
  // State tracking
  _lastSpeed: 0,
  _lastIncline: 0,
  _lastHRZone: 0,
  _lastAvgHRTime: 0,
  _hrSamples: [],
  _elapsed: 0,
  _distKm: 0,
  _lastMilestone: 0,      // last distance milestone announced (5, 10, 21.1, 42.195)

  // Fun fact for this session
  _funFact: null,
  _funFactShown: false,

  // Config (loaded from settings)
  config: {
    speedChanges: true,
    inclineChanges: true,
    hrZoneChanges: true,
    avgHRInterval: 300,    // seconds (5 mins default)
    avgHREnabled: true,
    splitSummary: true,
    distMilestones: true,
    funFacts: true,
    showPopup: true,       // visual popup fallback
    popupDuration: 20,     // seconds
  },

  // ── Reset (call at run start) ──────────────────────────────────────────

  reset() {
    this._lastSpeed = 0;
    this._lastIncline = 0;
    this._lastHRZone = 0;
    this._lastAvgHRTime = 0;
    this._hrSamples = [];
    this._elapsed = 0;
    this._distKm = 0;
    this._lastMilestone = 0;
    this._funFactShown = false;

    // Pick a random fun fact for this session
    if (typeof FUN_FACTS !== 'undefined' && FUN_FACTS.length > 0) {
      var idx = Math.floor(Math.random() * FUN_FACTS.length);
      this._funFact = FUN_FACTS[idx];
      console.log('[MilestoneTracker] Fun fact queued at ' + this._funFact.km + 'km');
    }
  },

  // ── Main tick (called every 250ms from Engine.onTick) ──────────────────

  tick(speed, incline, hr, maxHR, elapsed, distKm) {
    this._elapsed = elapsed;
    this._distKm = distKm;

    // Collect HR samples for averaging
    if (hr > 0) this._hrSamples.push(hr);

    // ── HR zone change ─────────────────────────────────────────────────
    if (this.config.hrZoneChanges && hr > 0 && maxHR > 0) {
      var hrPct = hr / maxHR;
      var zone = hrPct < 0.6 ? 1 : hrPct < 0.7 ? 2 : hrPct < 0.8 ? 3 : hrPct < 0.9 ? 4 : 5;
      if (zone !== this._lastHRZone && this._lastHRZone > 0) {
        VoiceCoach.announceHRZoneChange(zone);
        this._showPopup('Heart rate now in Zone ' + zone, this._getZoneColor(zone));
      }
      this._lastHRZone = zone;
    }

    // ── Average HR report (every N minutes) ────────────────────────────
    if (this.config.avgHREnabled && elapsed > 0 && this.config.avgHRInterval > 0) {
      if (elapsed - this._lastAvgHRTime >= this.config.avgHRInterval) {
        this._lastAvgHRTime = elapsed;
        if (this._hrSamples.length > 0) {
          var sum = 0;
          for (var i = 0; i < this._hrSamples.length; i++) sum += this._hrSamples[i];
          var avg = Math.round(sum / this._hrSamples.length);
          var avgZone = maxHR > 0 ? (avg / maxHR < 0.6 ? 1 : avg / maxHR < 0.7 ? 2 : avg / maxHR < 0.8 ? 3 : avg / maxHR < 0.9 ? 4 : 5) : 0;
          VoiceCoach.announceAvgHR(avg, avgZone, elapsed);
          var mins = Math.floor(elapsed / 60);
          this._showPopup(mins + ' min avg HR: ' + avg + ' bpm (Z' + avgZone + ')', this._getZoneColor(avgZone));
        }
      }
    }

    // ── Fun fact (one per session) ────────────────────────────────────
    if (this.config.funFacts && this._funFact && !this._funFactShown) {
      if (distKm >= this._funFact.km) {
        this._funFactShown = true;
        VoiceCoach.say(this._funFact.text, 'medium');
        this._showPopup(this._funFact.text, '#a78bfa');
      }
    }

    // ── Distance milestones (5K, 10K, half, full) ──────────────────────
    if (this.config.distMilestones) {
      var milestones = [5, 10, 21.1, 42.195];
      for (var m = 0; m < milestones.length; m++) {
        if (distKm >= milestones[m] && this._lastMilestone < milestones[m]) {
          this._lastMilestone = milestones[m];
          VoiceCoach.announceDistanceMilestone(milestones[m]);
          var label = milestones[m] === 5 ? '5K' : milestones[m] === 10 ? '10K' : milestones[m] === 21.1 ? 'HALF MARATHON' : 'MARATHON';
          this._showPopup(label + ' REACHED!', '#22c55e');
        }
      }
    }
  },

  // ── Speed change (called from WorkoutSegments callback) ────────────────

  onSpeedChange(newKph, oldKph) {
    if (!this.config.speedChanges) return;
    if (Math.abs(newKph - oldKph) < 0.1) return;
    VoiceCoach.announceSpeedChange(newKph, oldKph, 'kph');
    var direction = newKph > oldKph ? 'up' : 'down';
    var arrow = newKph > oldKph ? '\u2191' : '\u2193';
    this._showPopup('Speed ' + arrow + ' ' + newKph.toFixed(1) + ' kph', direction === 'up' ? '#f97316' : '#22c55e');
    this._lastSpeed = newKph;
  },

  // ── Incline change (called from WorkoutSegments callback) ──────────────

  onInclineChange(newPct, oldPct) {
    if (!this.config.inclineChanges) return;
    if (Math.abs(newPct - oldPct) < 0.1) return;
    VoiceCoach.announceInclineChange(newPct, oldPct);
    var arrow = newPct > oldPct ? '\u2191' : '\u2193';
    this._showPopup('Incline ' + arrow + ' ' + newPct.toFixed(0) + '%', newPct > oldPct ? '#f97316' : '#22c55e');
    this._lastIncline = newPct;
  },

  // ── Split summary (called from Engine.onSplit) ─────────────────────────

  onSplit(splitNum, unit, timeSec, avgHR, maxHR) {
    if (!this.config.splitSummary) return;
    var zone = 0;
    if (avgHR > 0 && maxHR > 0) {
      var pct = avgHR / maxHR;
      zone = pct < 0.6 ? 1 : pct < 0.7 ? 2 : pct < 0.8 ? 3 : pct < 0.9 ? 4 : 5;
    }
    VoiceCoach.announceSplit(splitNum, unit, timeSec, avgHR, zone);
    var unitLabel = unit === 'mi' ? 'mile' : 'km';
    var mins = Math.floor(timeSec / 60);
    var secs = Math.floor(timeSec % 60);
    var timeStr = mins + ':' + (secs < 10 ? '0' : '') + secs;
    var popupText = unitLabel + ' ' + splitNum + ': ' + timeStr;
    if (zone > 0) popupText += ' (Z' + zone + ')';
    this._showPopup(popupText, this._getZoneColor(zone));
  },

  // ── Visual popup ───────────────────────────────────────────────────────

  _popupEl: null,
  _popupTimer: null,

  _showPopup(text, accentColor) {
    if (!this.config.showPopup) return;

    accentColor = accentColor || '#00e5ff';

    // Create or reuse popup container
    if (!this._popupEl) {
      var el = document.createElement('div');
      el.id = 'milestonePopup';
      el.className = 'milestone-popup';
      el.addEventListener('click', function() {
        el.classList.remove('show');
      });
      var root = document.getElementById('rootApp');
      if (root) root.appendChild(el);
      this._popupEl = el;
    }

    // Clear existing timer
    if (this._popupTimer) {
      clearTimeout(this._popupTimer);
      this._popupTimer = null;
    }

    // Set content
    this._popupEl.innerHTML = '<div class="milestone-popup-bar" style="background:' + accentColor + '"></div>' +
      '<div class="milestone-popup-text">' + text + '</div>';
    this._popupEl.style.borderColor = accentColor;

    // Show with animation
    var popup = this._popupEl;
    popup.classList.remove('show');
    setTimeout(function() { popup.classList.add('show'); }, 30);

    // Auto-close
    var duration = (this.config.popupDuration || 20) * 1000;
    var self = this;
    this._popupTimer = setTimeout(function() {
      popup.classList.remove('show');
      self._popupTimer = null;
    }, duration);
  },

  _getZoneColor(zone) {
    var colors = { 1: '#6b7280', 2: '#22c55e', 3: '#fbbf24', 4: '#f97316', 5: '#ef4444' };
    return colors[zone] || '#00e5ff';
  },
};
