// ═══════════════════════════════════════════════════════════════════════════════
// TrailRunner — Cadence Detection via Microphone
//
// Uses Web Audio API + getUserMedia to detect footstrike rhythm from the
// treadmill's built-in microphone. Calculates steps per minute (SPM).
//
// Typical cadence ranges:
//   Walking:     100-120 SPM
//   Jogging:     150-170 SPM
//   Running:     170-185 SPM
//   Elite:       180-200 SPM
//
// Algorithm: Energy-based onset detection with adaptive threshold.
// Each footstrike produces a low-frequency impulse (~80-200 Hz) that
// exceeds the noise floor. We detect peaks spaced > 250ms apart
// (max ~240 SPM) and compute rolling average cadence.
// ═══════════════════════════════════════════════════════════════════════════════

window.Cadence = (function() {
  'use strict';

  var audioCtx = null;
  var analyser = null;
  var stream = null;
  var active = false;
  var cadence = 0; // SPM
  var beatTimes = []; // timestamps of detected footstrikes
  var MAX_BEATS = 30; // rolling window
  var MIN_BEAT_GAP_MS = 250; // max ~240 SPM
  var lastBeatTime = 0;
  var threshold = 0;
  var noiseFloor = 0;
  var frameCount = 0;
  var onCadenceUpdate = null;

  function start(callback) {
    if (active) return;
    onCadenceUpdate = callback || null;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('[Cadence] getUserMedia not supported');
      return false;
    }

    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function(s) {
        stream = s;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var source = audioCtx.createMediaStreamSource(stream);

        // Bandpass filter: 80-200 Hz (footstrike frequency range)
        var bandpass = audioCtx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.value = 140; // center
        bandpass.Q.value = 1.5;

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.3;

        source.connect(bandpass);
        bandpass.connect(analyser);

        active = true;
        frameCount = 0;
        noiseFloor = 0;
        threshold = 0;
        beatTimes = [];
        console.log('[Cadence] Listening for footstrikes...');
        detectLoop();
      })
      .catch(function(err) {
        console.warn('[Cadence] Mic access denied:', err.message);
      });

    return true;
  }

  function stop() {
    active = false;
    if (stream) {
      stream.getTracks().forEach(function(t) { t.stop(); });
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    cadence = 0;
    beatTimes = [];
    console.log('[Cadence] Stopped');
  }

  function detectLoop() {
    if (!active || !analyser) return;

    var dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);

    // Calculate RMS energy
    var sum = 0;
    for (var i = 0; i < dataArray.length; i++) {
      var v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    var rms = Math.sqrt(sum / dataArray.length);

    // Adaptive threshold: track noise floor and set threshold above it
    frameCount++;
    if (frameCount < 20) {
      // Calibration phase — learn noise floor
      noiseFloor = noiseFloor * 0.9 + rms * 0.1;
      threshold = noiseFloor * 3;
    } else {
      // Slowly adapt noise floor (only when below threshold)
      if (rms < threshold * 0.7) {
        noiseFloor = noiseFloor * 0.995 + rms * 0.005;
        threshold = Math.max(noiseFloor * 2.5, 0.02);
      }
    }

    // Beat detection
    var now = Date.now();
    if (rms > threshold && (now - lastBeatTime) > MIN_BEAT_GAP_MS) {
      lastBeatTime = now;
      beatTimes.push(now);
      while (beatTimes.length > MAX_BEATS) beatTimes.shift();

      // Calculate cadence from recent beats
      if (beatTimes.length >= 4) {
        var intervals = [];
        for (var j = 1; j < beatTimes.length; j++) {
          intervals.push(beatTimes[j] - beatTimes[j - 1]);
        }
        // Remove outliers (> 2x median)
        intervals.sort(function(a, b) { return a - b; });
        var median = intervals[Math.floor(intervals.length / 2)];
        var filtered = intervals.filter(function(iv) {
          return iv > median * 0.5 && iv < median * 2;
        });
        if (filtered.length >= 2) {
          var avgInterval = filtered.reduce(function(a, b) { return a + b; }, 0) / filtered.length;
          cadence = Math.round(60000 / avgInterval);
          // Sanity check
          if (cadence < 60 || cadence > 250) cadence = 0;
        }
      }

      if (onCadenceUpdate && cadence > 0) {
        onCadenceUpdate(cadence);
      }
    }

    requestAnimationFrame(detectLoop);
  }

  return {
    start: start,
    stop: stop,
    getCadence: function() { return cadence; },
    isActive: function() { return active; }
  };
})();
