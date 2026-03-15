// ════════════════════════════════════════════════════════════════════════════
// SettingsPanel — Full-featured settings with tabs and accordion sections
// Replaces the basic settings modal in the original UI
// ════════════════════════════════════════════════════════════════════════════

const SettingsPanel = {

  _el: null,
  _activeTab: 'controls',
  _openSections: new Set(['audio']),

  // ══════════════════════════════════════════════════════════════════════════
  // OPEN / CLOSE
  // ══════════════════════════════════════════════════════════════════════════

  open() {
    this._ensure();
    this._render();
    this._el.classList.add('show');
  },

  close() {
    if (this._el) this._el.classList.remove('show');
  },

  toggle() {
    if (this._el && this._el.classList.contains('show')) this.close();
    else this.open();
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ══════════════════════════════════════════════════════════════════════════

  _ensure() {
    if (this._el) return;
    const el = document.createElement('div');
    el.id = 'settingsPanel';
    el.className = 'sp-overlay';
    el.innerHTML = '<div class="sp-panel" id="spPanel"><div class="sp-inner" id="spInner"></div></div>';
    document.getElementById('rootApp').appendChild(el);
    this._el = el;
    el.addEventListener('click', (e) => { if (e.target === el) this.close(); });
  },

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  _render() {
    const inner = document.getElementById('spInner');
    if (!inner) return;
    const s = Store.getSettings();

    inner.innerHTML = `
      <div class="sp-header">
        <div class="sp-title">⚙ SETTINGS</div>
        <button class="sp-close" onclick="SettingsPanel.close()">✕</button>
      </div>

      <!-- Tabs -->
      <div class="sp-tabs">
        ${['controls','metrics','charts','widgets'].map(t =>
          `<button class="sp-tab ${this._activeTab===t?'active':''}" onclick="SettingsPanel._setTab('${t}')">${t.toUpperCase()}</button>`
        ).join('')}
      </div>

      <!-- Tab content -->
      <div class="sp-tab-content" id="spTabContent">
        ${this._renderTab(s)}
      </div>

      <!-- Accordion sections -->
      <div class="sp-accordion" id="spAccordion">
        ${this._renderAccordion(s)}
      </div>

      <!-- Save -->
      <div class="sp-footer">
        <button class="sp-save" onclick="SettingsPanel._save()">SAVE SETTINGS</button>
      </div>
    `;
  },

  _setTab(tab) {
    this._activeTab = tab;
    this._render();
  },

  _toggleSection(name) {
    if (this._openSections.has(name)) this._openSections.delete(name);
    else this._openSections.add(name);
    this._render();
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TAB CONTENT
  // ══════════════════════════════════════════════════════════════════════════

  _renderTab(s) {
    switch (this._activeTab) {
      case 'controls': return this._tabControls(s);
      case 'metrics':  return this._tabMetrics(s);
      case 'charts':   return this._tabCharts(s);
      case 'widgets':  return this._tabWidgets(s);
      default: return '';
    }
  },

  _tabControls(s) {
    const speedUnit = s.speedButtonUnit || 'mph';
    const speedMode = s.speedButtonMode || 'custom';
    const customs = s.customSpeeds || [4, 5, 6, 7, 8, 10];
    const incMode = s.inclineButtonMode || 'default';
    const incCustoms = s.customInclines || [30, 25, 20, 15, 10, 5, 0, -6];

    return `
      <div class="sp-section-label">SPEED BUTTONS</div>

      <div class="sp-row">
        <span class="sp-label">Unit</span>
        <div class="sp-radio-group">
          ${['mph','kph','min/mi','min/km'].map(u =>
            `<label class="sp-radio"><input type="radio" name="spSpeedUnit" value="${u}" ${speedUnit===u?'checked':''}> ${u.toUpperCase()}</label>`
          ).join('')}
        </div>
      </div>

      <div class="sp-row">
        <span class="sp-label">Mode</span>
        <div class="sp-radio-group">
          <label class="sp-radio"><input type="radio" name="spSpeedMode" value="auto" ${speedMode==='auto'?'checked':''}> Auto</label>
          <label class="sp-radio"><input type="radio" name="spSpeedMode" value="custom" ${speedMode==='custom'?'checked':''}> Custom</label>
        </div>
      </div>

      <div class="sp-row" id="spSpeedAutoRow" style="${speedMode==='auto'?'':'display:none'}">
        <span class="sp-label">Max Speed</span>
        <input class="sp-input" type="number" id="spMaxSpeedBtn" step="0.5" min="1" max="12" value="${s.speedButtonMax || 8}" style="width:60px">
        <span class="sp-label" style="margin-left:12px">Buttons</span>
        <input class="sp-input" type="number" id="spSpeedSteps" min="2" max="12" value="${s.speedButtonSteps || 8}" style="width:50px">
      </div>

      <div class="sp-row" id="spSpeedCustomRow" style="${speedMode==='custom'?'':'display:none'}">
        <span class="sp-label">Values</span>
        <input class="sp-input" type="text" id="spCustomSpeeds" value="${customs.join(', ')}" placeholder="4, 5, 6, 7, 8, 10" style="width:200px">
        <div class="sp-hint">Comma-separated, max 12</div>
      </div>

      <div class="sp-divider"></div>
      <div class="sp-section-label">INCLINE BUTTONS</div>

      <div class="sp-row">
        <span class="sp-label">Mode</span>
        <div class="sp-radio-group">
          <label class="sp-radio"><input type="radio" name="spIncMode" value="default" ${incMode==='default'?'checked':''}> Default</label>
          <label class="sp-radio"><input type="radio" name="spIncMode" value="custom" ${incMode==='custom'?'checked':''}> Custom</label>
        </div>
      </div>

      <div class="sp-row" id="spIncCustomRow" style="${incMode==='custom'?'':'display:none'}">
        <span class="sp-label">Values (%)</span>
        <input class="sp-input" type="text" id="spCustomInclines" value="${incCustoms.join(', ')}" placeholder="30, 25, 20, 15, 10, 5, 0, -6" style="width:200px">
      </div>

      <div class="sp-divider"></div>
      <div class="sp-section-label">VOICE COMMANDS</div>

      <div class="sp-row">
        <span class="sp-label">Enable</span>
        <label class="sp-toggle"><input type="checkbox" id="spVoiceEnabled" ${s.voiceEnabled?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Sensitivity</span>
        <select class="sp-input" id="spVoiceSensitivity" style="width:100px">
          <option value="low" ${s.voiceSensitivity==='low'?'selected':''}>Low</option>
          <option value="medium" ${(s.voiceSensitivity||'medium')==='medium'?'selected':''}>Medium</option>
          <option value="high" ${s.voiceSensitivity==='high'?'selected':''}>High</option>
        </select>
      </div>
    `;
  },

  _tabMetrics(s) {
    const metrics = s.statsBarMetrics || ['time','distance','speed','incline','pace','hr','calories','elevation'];
    const available = [
      { key: 'time', label: 'Elapsed Time' },
      { key: 'time_remaining', label: 'Time Remaining' },
      { key: 'time_segment', label: 'Segment Time' },
      { key: 'distance', label: 'Distance' },
      { key: 'distance_segment', label: 'Segment Distance' },
      { key: 'distance_remaining', label: 'Distance Remaining' },
      { key: 'speed', label: 'Current Speed' },
      { key: 'speed_avg', label: 'Average Speed' },
      { key: 'speed_target', label: 'Target Speed' },
      { key: 'incline', label: 'Current Incline' },
      { key: 'incline_target', label: 'Target Incline' },
      { key: 'pace', label: 'Current Pace' },
      { key: 'pace_avg', label: 'Average Pace' },
      { key: 'hr', label: 'Heart Rate' },
      { key: 'hr_avg', label: 'Average HR' },
      { key: 'hr_zone', label: 'HR Zone' },
      { key: 'calories', label: 'Calories' },
      { key: 'elevation', label: 'Elevation Gain' },
      { key: 'cadence', label: 'Cadence' },
      { key: 'lap_time', label: 'Lap Time' },
      { key: 'ghost_delta', label: 'Ghost Delta' },
    ];

    return `
      <div class="sp-section-label">STATS BAR (drag to reorder)</div>
      <div class="sp-metric-list" id="spMetricList">
        ${metrics.map((m, i) => {
          const def = available.find(a => a.key === m) || { label: m };
          return `<div class="sp-metric-item" draggable="true" data-key="${m}">
            <span class="sp-metric-grip">☰</span>
            <span class="sp-metric-name">${def.label}</span>
            <select class="sp-metric-select" onchange="this.parentElement.dataset.key=this.value;this.parentElement.querySelector('.sp-metric-name').textContent=this.options[this.selectedIndex].text">
              ${available.map(a => `<option value="${a.key}" ${a.key===m?'selected':''}>${a.label}</option>`).join('')}
            </select>
          </div>`;
        }).join('')}
      </div>

      <div class="sp-divider"></div>
      <div class="sp-section-label">DISPLAY UNITS</div>

      <div class="sp-row">
        <span class="sp-label">Distance</span>
        <select class="sp-input" id="spDistUnit" style="width:100px">
          <option value="km" ${s.distUnit==='km'?'selected':''}>Kilometres</option>
          <option value="mi" ${s.distUnit==='mi'?'selected':''}>Miles</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Speed</span>
        <select class="sp-input" id="spSpeedDisplayUnit" style="width:100px">
          <option value="kmh" ${(s.speedUnit||'kmh')==='kmh'?'selected':''}>km/h</option>
          <option value="mph" ${s.speedUnit==='mph'?'selected':''}>mph</option>
          <option value="minperkm" ${s.speedUnit==='minperkm'?'selected':''}>min/km</option>
          <option value="minpermi" ${s.speedUnit==='minpermi'?'selected':''}>min/mi</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Elevation</span>
        <select class="sp-input" id="spElevUnit" style="width:100px">
          <option value="m" ${(s.elevUnit||'m')==='m'?'selected':''}>Metres</option>
          <option value="ft" ${s.elevUnit==='ft'?'selected':''}>Feet</option>
        </select>
      </div>
    `;
  },

  _tabCharts(s) {
    return `
      <div class="sp-section-label">BOTTOM CHART STRIP</div>

      <div class="sp-row">
        <span class="sp-label">Show Chart</span>
        <label class="sp-toggle"><input type="checkbox" id="spChartShow" ${s.chartShow !== false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Height</span>
        <select class="sp-input" id="spChartHeight" style="width:100px">
          <option value="80" ${s.chartHeight==='80'?'selected':''}>Small (80px)</option>
          <option value="120" ${(s.chartHeight||'120')==='120'?'selected':''}>Medium (120px)</option>
          <option value="160" ${s.chartHeight==='160'?'selected':''}>Large (160px)</option>
        </select>
      </div>

      <div class="sp-section-label">DATA LAYERS</div>
      <div class="sp-row"><label class="sp-check"><input type="checkbox" id="spChartSpeed" ${s.chartSpeed!==false?'checked':''}> Speed</label></div>
      <div class="sp-row"><label class="sp-check"><input type="checkbox" id="spChartIncline" ${s.chartIncline!==false?'checked':''}> Incline</label></div>
      <div class="sp-row"><label class="sp-check"><input type="checkbox" id="spChartHR" ${s.chartHR?'checked':''}> Heart Rate</label></div>
      <div class="sp-row"><label class="sp-check"><input type="checkbox" id="spChartPace" ${s.chartPace?'checked':''}> Pace</label></div>

      <div class="sp-row">
        <span class="sp-label">Time Range</span>
        <select class="sp-input" id="spChartRange" style="width:120px">
          <option value="full" ${(s.chartRange||'full')==='full'?'selected':''}>Full Workout</option>
          <option value="5" ${s.chartRange==='5'?'selected':''}>Last 5 min</option>
          <option value="10" ${s.chartRange==='10'?'selected':''}>Last 10 min</option>
        </select>
      </div>
    `;
  },

  _tabWidgets(s) {
    const widgets = [
      { key: 'hrGauge', label: 'HR Zone Gauge', desc: 'Colour bar showing current HR zone' },
      { key: 'ghostDelta', label: 'Ghost Delta', desc: 'Time ahead/behind ghost runner' },
      { key: 'segmentProgress', label: 'Segment Progress', desc: 'Current segment distance remaining' },
      { key: 'lapCounter', label: 'Lap Counter', desc: 'Lap count and split times' },
      { key: 'intervalTimer', label: 'Interval Timer', desc: 'Countdown for interval workouts' },
      { key: 'miniElevation', label: 'Mini Elevation', desc: 'Small elevation profile' },
      { key: 'cadence', label: 'Cadence Display', desc: 'Steps per minute' },
      { key: 'achievements', label: 'Achievement Progress', desc: 'Next badge progress' },
    ];

    const enabled = s.enabledWidgets || ['hrGauge', 'segmentProgress'];

    return `
      <div class="sp-section-label">WIDGETS (toggle on/off)</div>
      ${widgets.map(w => `
        <div class="sp-widget-row">
          <label class="sp-toggle"><input type="checkbox" data-widget="${w.key}" ${enabled.includes(w.key)?'checked':''}><span class="sp-slider"></span></label>
          <div class="sp-widget-info">
            <div class="sp-widget-name">${w.label}</div>
            <div class="sp-widget-desc">${w.desc}</div>
          </div>
        </div>
      `).join('')}
    `;
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ACCORDION SECTIONS
  // ══════════════════════════════════════════════════════════════════════════

  _renderAccordion(s) {
    const sections = [
      { key: 'audio',       icon: '🔊', label: 'Audio',        content: () => this._accAudio(s) },
      { key: 'heartrate',   icon: '❤',  label: 'Heart Rate',   content: () => this._accHR(s) },
      { key: 'bluetooth',   icon: '📶', label: 'Bluetooth',    content: () => this._accBluetooth(s) },
      { key: 'features',    icon: '✨', label: 'Features',     content: () => this._accFeatures(s) },
      { key: 'display',     icon: '🖥',  label: 'Display',      content: () => this._accDisplay(s) },
      { key: 'theme',       icon: '🎨', label: 'Theme',        content: () => this._accTheme(s) },
      { key: 'units',       icon: '📏', label: 'Units',        content: () => this._accUnits(s) },
      { key: 'integrations',icon: '🔗', label: 'Integrations', content: () => this._accIntegrations(s) },
      { key: 'profile',     icon: '👤', label: 'Profile',      content: () => this._accProfile(s) },
    ];

    return sections.map(sec => {
      const open = this._openSections.has(sec.key);
      return `
        <div class="sp-acc-item">
          <div class="sp-acc-header" onclick="SettingsPanel._toggleSection('${sec.key}')">
            <span class="sp-acc-icon">${sec.icon}</span>
            <span class="sp-acc-label">${sec.label}</span>
            <span class="sp-acc-chevron">${open ? '▼' : '▶'}</span>
          </div>
          <div class="sp-acc-body" style="${open ? '' : 'display:none'}">${sec.content()}</div>
        </div>
      `;
    }).join('');
  },

  // ── Audio ─────────────────────────────────────────────────────────────

  _accAudio(s) {
    // Build voice options from available system voices
    var voiceOptions = '';
    if (typeof VoiceCoach !== 'undefined') {
      var voices = VoiceCoach.getAvailableVoices();
      var currentVoice = s.ttsVoiceName || (VoiceCoach.config.voice ? VoiceCoach.config.voice.name : '');
      voiceOptions = '<option value="">Auto (best English)</option>';
      for (var vi = 0; vi < voices.length; vi++) {
        var v = voices[vi];
        var sel = v.name === currentVoice ? 'selected' : '';
        voiceOptions += '<option value="' + v.name.replace(/"/g, '&quot;') + '" ' + sel + '>' + v.name + '</option>';
      }
    }

    return `
      <div class="sp-row">
        <span class="sp-label">Voice Coaching</span>
        <label class="sp-toggle"><input type="checkbox" id="spTTSEnabled" ${s.ttsEnabled?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Voice</span>
        <select class="sp-input" id="spTTSVoice" style="width:180px">${voiceOptions}</select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Verbosity</span>
        <select class="sp-input" id="spTTSVerbosity" style="width:100px">
          <option value="minimal" ${s.ttsVerbosity==='minimal'?'selected':''}>Minimal</option>
          <option value="normal" ${(s.ttsVerbosity||'normal')==='normal'?'selected':''}>Normal</option>
          <option value="chatty" ${s.ttsVerbosity==='chatty'?'selected':''}>Chatty</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">TTS Volume</span>
        <input type="range" class="sp-range" id="spTTSVol" min="0" max="100" value="${Math.round((s.ttsVolume||0.8)*100)}">
      </div>
      <div class="sp-row">
        <span class="sp-label">Sound Effects</span>
        <label class="sp-toggle"><input type="checkbox" id="spSFX" ${s.sfxEnabled!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <button class="sp-btn-sm" onclick="if(typeof VoiceCoach!=='undefined')VoiceCoach.say('Voice coaching test. Speed 6 miles per hour.','high')">Test Voice</button>
      </div>

      <div class="sp-section-label" style="margin-top:10px">MILESTONE ANNOUNCEMENTS</div>
      <div class="sp-hint" style="padding:0 0 6px 0;color:var(--dim);font-size:9px">Voice + large on-screen popup for each event</div>

      <div class="sp-row">
        <span class="sp-label">Speed Changes</span>
        <label class="sp-toggle"><input type="checkbox" id="spMsSpeed" ${s.msSpeedChanges!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Incline Changes</span>
        <label class="sp-toggle"><input type="checkbox" id="spMsIncline" ${s.msInclineChanges!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">HR Zone Changes</span>
        <label class="sp-toggle"><input type="checkbox" id="spMsHRZone" ${s.msHRZoneChanges!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Split Summary</span>
        <label class="sp-toggle"><input type="checkbox" id="spMsSplit" ${s.msSplitSummary!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Distance Milestones</span>
        <label class="sp-toggle"><input type="checkbox" id="spMsDist" ${s.msDistMilestones!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Avg HR Report</span>
        <label class="sp-toggle"><input type="checkbox" id="spMsAvgHR" ${s.msAvgHR!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Report Every</span>
        <select class="sp-input" id="spMsAvgHRInt" style="width:80px">
          <option value="300" ${(s.msAvgHRInterval||300)==300?'selected':''}>5 min</option>
          <option value="600" ${s.msAvgHRInterval==600?'selected':''}>10 min</option>
          <option value="900" ${s.msAvgHRInterval==900?'selected':''}>15 min</option>
        </select>
      </div>

      <div class="sp-section-label" style="margin-top:10px">VISUAL POPUP</div>
      <div class="sp-row">
        <span class="sp-label">Show Popup</span>
        <label class="sp-toggle"><input type="checkbox" id="spMsPopup" ${s.msShowPopup!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Auto-close</span>
        <select class="sp-input" id="spMsPopupDur" style="width:80px">
          <option value="10" ${s.msPopupDuration==10?'selected':''}>10 sec</option>
          <option value="20" ${(s.msPopupDuration||20)==20?'selected':''}>20 sec</option>
          <option value="30" ${s.msPopupDuration==30?'selected':''}>30 sec</option>
        </select>
      </div>
    `;
  },

  // ── Heart Rate ────────────────────────────────────────────────────────

  _accHR(s) {
    return `
      <div class="sp-row">
        <span class="sp-label">Max HR</span>
        <input class="sp-input" type="number" id="spMaxHR" min="120" max="220" value="${s.maxHR || 185}" style="width:60px">
        <button class="sp-btn-sm" onclick="document.getElementById('spMaxHR').value=220-parseInt(document.getElementById('spAge').value||30)">220 - Age</button>
      </div>
      <div class="sp-row">
        <span class="sp-label">Resting HR</span>
        <input class="sp-input" type="number" id="spRestHR" min="30" max="120" value="${s.restHR || 60}" style="width:60px">
      </div>

      <div class="sp-section-label" style="margin-top:8px">ZONE THRESHOLDS (% of max)</div>
      ${[
        { z: 1, name: 'Z1 Warm-up',   min: 50, max: 60, col: '#6b7280' },
        { z: 2, name: 'Z2 Fat Burn',   min: 60, max: 70, col: '#22c55e' },
        { z: 3, name: 'Z3 Aerobic',    min: 70, max: 80, col: '#fbbf24' },
        { z: 4, name: 'Z4 Threshold',  min: 80, max: 90, col: '#f97316' },
        { z: 5, name: 'Z5 Max',        min: 90, max: 100,col: '#ef4444' },
      ].map(z => `
        <div class="sp-row" style="padding:2px 0">
          <span class="sp-label" style="color:${z.col};min-width:100px">${z.name}</span>
          <input class="sp-input sp-zone-input" type="number" id="spZ${z.z}Min" min="0" max="100" value="${(s['z'+z.z+'Min'])||z.min}" style="width:45px">
          <span class="sp-label">—</span>
          <input class="sp-input sp-zone-input" type="number" id="spZ${z.z}Max" min="0" max="100" value="${(s['z'+z.z+'Max'])||z.max}" style="width:45px">
          <span class="sp-label">%</span>
        </div>
      `).join('')}

      <div class="sp-section-label" style="margin-top:8px">AUTO-PILOT</div>
      <div class="sp-row">
        <span class="sp-label">Enable</span>
        <label class="sp-toggle"><input type="checkbox" id="spAPEnabled" ${s.autoPilotEnabled?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Priority</span>
        <select class="sp-input" id="spAPPriority" style="width:100px">
          <option value="speed" ${(s.autoPilotPriority||'speed')==='speed'?'selected':''}>Speed</option>
          <option value="incline" ${s.autoPilotPriority==='incline'?'selected':''}>Incline</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Adjust every</span>
        <input class="sp-input" type="number" id="spAPInterval" min="10" max="30" value="${s.autoPilotInterval||15}" style="width:50px">
        <span class="sp-label">sec</span>
      </div>
    `;
  },

  // ── Bluetooth ─────────────────────────────────────────────────────────

  _accBluetooth(s) {
    const hrStatus = (typeof BLEHR !== 'undefined' && BLEHR.connected) ? 'Connected' : 'Not Connected';
    return `
      <div class="sp-row">
        <span class="sp-label">HR Monitor</span>
        <span class="sp-status ${BLEHR?.connected?'connected':''}">${hrStatus}</span>
        <button class="sp-btn-sm" onclick="if(typeof App!=='undefined')App.connectHR()">Scan</button>
      </div>
      <div class="sp-row">
        <span class="sp-label">Garmin Watch</span>
        <span class="sp-status">Not Available</span>
      </div>
      <div class="sp-row">
        <span class="sp-label">External Speaker</span>
        <span class="sp-status">Built-in RT5651</span>
      </div>
    `;
  },

  // ── Features ──────────────────────────────────────────────────────────

  _accFeatures(s) {
    return `
      <div class="sp-section-label">GHOST RUNNER</div>
      <div class="sp-row">
        <span class="sp-label">Enable</span>
        <label class="sp-toggle"><input type="checkbox" id="spGhostEnabled" ${s.ghostEnabled!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Ghost Source</span>
        <select class="sp-input" id="spGhostSource" style="width:120px">
          <option value="best" ${(s.ghostSource||'best')==='best'?'selected':''}>Best Time</option>
          <option value="last" ${s.ghostSource==='last'?'selected':''}>Last Run</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Opacity</span>
        <input type="range" class="sp-range" id="spGhostOpacity" min="10" max="80" value="${s.ghostOpacity||30}">
        <span class="sp-range-val">${s.ghostOpacity||30}%</span>
      </div>

      <div class="sp-section-label" style="margin-top:8px">WARM-UP</div>
      <div class="sp-row">
        <span class="sp-label">Enable</span>
        <label class="sp-toggle"><input type="checkbox" id="spWarmUp" ${s.warmUpEnabled!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Duration</span>
        <input class="sp-input" type="number" id="spWarmUpDur" min="60" max="300" step="30" value="${s.warmUpDuration||180}" style="width:60px">
        <span class="sp-label">sec</span>
      </div>
      <div class="sp-row">
        <span class="sp-label">Speed (kph)</span>
        <input class="sp-input" type="number" id="spWarmUpSpeed" step="0.5" min="2" max="8" value="${s.warmUpSpeed||4.8}" style="width:60px">
      </div>

      <div class="sp-section-label" style="margin-top:8px">COOL-DOWN</div>
      <div class="sp-row">
        <span class="sp-label">Enable</span>
        <label class="sp-toggle"><input type="checkbox" id="spCoolDown" ${s.coolDownEnabled!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Duration</span>
        <input class="sp-input" type="number" id="spCoolDownDur" min="60" max="300" step="30" value="${s.coolDownDuration||120}" style="width:60px">
        <span class="sp-label">sec</span>
      </div>
      <div class="sp-row">
        <span class="sp-label">Mandatory</span>
        <label class="sp-toggle"><input type="checkbox" id="spCoolDownMandatory" ${s.coolDownMandatory?'checked':''}><span class="sp-slider"></span></label>
      </div>

      <div class="sp-section-label" style="margin-top:8px">STREAKS & BADGES</div>
      <div class="sp-row">
        <span class="sp-label">Enable</span>
        <label class="sp-toggle"><input type="checkbox" id="spStreaks" ${s.streaksEnabled!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <button class="sp-btn-sm" onclick="SettingsPanel._showBadges()">🏅 View Badges</button>
      </div>
    `;
  },

  // ── Display ───────────────────────────────────────────────────────────

  _accDisplay(s) {
    return `
      <div class="sp-row">
        <span class="sp-label">Default View</span>
        <select class="sp-input" id="spDefaultView" style="width:100px">
          <option value="track" ${(s.defaultView||'track')==='track'?'selected':''}>Track</option>
          <option value="map" ${s.defaultView==='map'?'selected':''}>Map</option>
          <option value="route" ${s.defaultView==='route'?'selected':''}>Route</option>
          <option value="street" ${s.defaultView==='street'?'selected':''}>Street</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Pac-Man</span>
        <label class="sp-toggle"><input type="checkbox" id="spPacman" ${s.showPacMan!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Animations</span>
        <select class="sp-input" id="spAnimations" style="width:100px">
          <option value="smooth" ${(s.animations||'smooth')==='smooth'?'selected':''}>Smooth</option>
          <option value="performance" ${s.animations==='performance'?'selected':''}>Performance</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Distance Label</span>
        <select class="sp-input" id="spDistLabel" style="width:100px">
          <option value="segment" ${s.distLabel==='segment'?'selected':''}>Segment</option>
          <option value="total" ${(s.distLabel||'total')==='total'?'selected':''}>Total</option>
          <option value="auto" ${s.distLabel==='auto'?'selected':''}>Auto-Toggle</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Auto-Hide UI</span>
        <label class="sp-toggle"><input type="checkbox" id="spAutoHide" ${s.autoHideUI?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Keep Screen On</span>
        <label class="sp-toggle"><input type="checkbox" id="spKeepScreenOn" ${s.keepScreenOn!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
    `;
  },

  // ── Theme ─────────────────────────────────────────────────────────────

  _accTheme(s) {
    const themes = [
      { key: 'dark-navy',     label: 'Dark Navy',     bg: '#0a1628' },
      { key: 'pure-black',    label: 'Pure Black',    bg: '#000000' },
      { key: 'forest-green',  label: 'Forest Green',  bg: '#0a1a10' },
      { key: 'sunset-orange', label: 'Sunset Orange', bg: '#1a0f08' },
    ];
    return `
      <div class="sp-section-label">PRESET THEMES</div>
      <div class="sp-theme-grid">
        ${themes.map(t => `
          <button class="sp-theme-btn ${(s.theme||'dark-navy')===t.key?'active':''}"
                  style="background:${t.bg}" onclick="SettingsPanel._setTheme('${t.key}')">
            <span>${t.label}</span>
          </button>
        `).join('')}
      </div>
      <div class="sp-row" style="margin-top:8px">
        <span class="sp-label">Font Size</span>
        <select class="sp-input" id="spFontSize" style="width:100px">
          <option value="normal" ${(s.fontSize||'normal')==='normal'?'selected':''}>Normal</option>
          <option value="large" ${s.fontSize==='large'?'selected':''}>Large</option>
          <option value="xlarge" ${s.fontSize==='xlarge'?'selected':''}>Extra Large</option>
        </select>
      </div>
    `;
  },

  // ── Units ─────────────────────────────────────────────────────────────

  _accUnits(s) {
    return `
      <div class="sp-row">
        <span class="sp-label">Speed</span>
        <select class="sp-input" id="spUnitSpeed" style="width:100px">
          <option value="kmh" ${(s.speedUnit||'kmh')==='kmh'?'selected':''}>km/h</option>
          <option value="mph" ${s.speedUnit==='mph'?'selected':''}>mph</option>
          <option value="minperkm" ${s.speedUnit==='minperkm'?'selected':''}>min/km</option>
          <option value="minpermi" ${s.speedUnit==='minpermi'?'selected':''}>min/mi</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Distance</span>
        <select class="sp-input" id="spUnitDist" style="width:100px">
          <option value="km" ${(s.distUnit||'km')==='km'?'selected':''}>Kilometres</option>
          <option value="mi" ${s.distUnit==='mi'?'selected':''}>Miles</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Elevation</span>
        <select class="sp-input" id="spUnitElev" style="width:100px">
          <option value="m" ${(s.elevUnit||'m')==='m'?'selected':''}>Metres</option>
          <option value="ft" ${s.elevUnit==='ft'?'selected':''}>Feet</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Weight</span>
        <select class="sp-input" id="spUnitWeight" style="width:100px">
          <option value="kg" ${(s.weightUnit||'kg')==='kg'?'selected':''}>Kilograms</option>
          <option value="lbs" ${s.weightUnit==='lbs'?'selected':''}>Pounds</option>
        </select>
      </div>
    `;
  },

  // ── Integrations ──────────────────────────────────────────────────────

  _accIntegrations(s) {
    const stravaConnected = typeof Sync !== 'undefined' && Sync.stravaTokens && Sync.stravaTokens.access_token;
    return `
      <div class="sp-section-label" style="color:#fc4c02">STRAVA</div>
      <div class="sp-row">
        <span class="sp-label">Status</span>
        <span class="sp-status ${stravaConnected?'connected':''}">${stravaConnected ? 'Connected' : 'Not Connected'}</span>
        <button class="sp-btn-sm" onclick="if(typeof App!=='undefined')App.connectStrava()">${stravaConnected?'Disconnect':'Connect'}</button>
      </div>
      <div class="sp-row">
        <span class="sp-label">Auto-Upload</span>
        <label class="sp-toggle"><input type="checkbox" id="spStravaAuto" ${s.stravaAutoUpload!==false?'checked':''}><span class="sp-slider"></span></label>
      </div>
      <div class="sp-row">
        <span class="sp-label">Activity Type</span>
        <select class="sp-input" id="spStravaType" style="width:100px">
          <option value="Run" ${(s.stravaActivityType||'Run')==='Run'?'selected':''}>Run</option>
          <option value="Walk" ${s.stravaActivityType==='Walk'?'selected':''}>Walk</option>
          <option value="VirtualRun" ${s.stravaActivityType==='VirtualRun'?'selected':''}>Treadmill</option>
        </select>
      </div>
      <div class="sp-row">
        <span class="sp-label">Privacy</span>
        <select class="sp-input" id="spStravaPrivacy" style="width:100px">
          <option value="everyone" ${(s.stravaPrivacy||'everyone')==='everyone'?'selected':''}>Everyone</option>
          <option value="followers" ${s.stravaPrivacy==='followers'?'selected':''}>Followers</option>
          <option value="only_me" ${s.stravaPrivacy==='only_me'?'selected':''}>Only Me</option>
        </select>
      </div>

      <div class="sp-section-label" style="color:#007dc3;margin-top:12px">GARMIN CONNECT</div>
      <div class="sp-row">
        <span class="sp-label">Status</span>
        <span class="sp-status">Via Strava sync</span>
      </div>

      <div class="sp-section-label" style="margin-top:12px">EXPORT</div>
      <div class="sp-row">
        <span class="sp-label">Default Format</span>
        <select class="sp-input" id="spExportFormat" style="width:80px">
          <option value="tcx" ${(s.exportFormat||'tcx')==='tcx'?'selected':''}>TCX</option>
          <option value="gpx" ${s.exportFormat==='gpx'?'selected':''}>GPX</option>
        </select>
      </div>

      <div class="sp-section-label" style="margin-top:12px">GOOGLE STREET VIEW</div>
      <div class="sp-row">
        <span class="sp-label">API Key</span>
        <input class="sp-input" type="text" id="spGoogleKey" placeholder="AIza..." value="${s.googleApiKey||''}" style="width:180px">
      </div>

      <div class="sp-section-label" style="margin-top:12px">STRAVA APP CREDENTIALS</div>
      <div class="sp-row">
        <span class="sp-label">Client ID</span>
        <input class="sp-input" type="text" id="spStravaId" placeholder="12345" value="${s.stravaClientId||''}" style="width:100px">
      </div>
      <div class="sp-row">
        <span class="sp-label">Client Secret</span>
        <input class="sp-input" type="password" id="spStravaSecret" placeholder="abc123..." value="${s.stravaClientSecret||''}" style="width:160px">
      </div>
    `;
  },

  // ── Profile ───────────────────────────────────────────────────────────

  _accProfile(s) {
    return `
      <div class="sp-row">
        <span class="sp-label">Name</span>
        <input class="sp-input" type="text" id="spName" value="${s.userName||''}" placeholder="Soph" style="width:150px">
      </div>
      <div class="sp-row">
        <span class="sp-label">Age</span>
        <input class="sp-input" type="number" id="spAge" min="10" max="99" value="${s.age||30}" style="width:60px">
      </div>
      <div class="sp-row">
        <span class="sp-label">Weight</span>
        <input class="sp-input" type="number" id="spWeight" min="30" max="200" value="${s.weight||72}" style="width:60px">
        <span class="sp-label">${s.weightUnit === 'lbs' ? 'lbs' : 'kg'}</span>
      </div>
      <div class="sp-row">
        <span class="sp-label">Resting HR</span>
        <input class="sp-input" type="number" id="spProfileRestHR" min="30" max="120" value="${s.restHR||60}" style="width:60px">
      </div>
    `;
  },

  // ══════════════════════════════════════════════════════════════════════════
  // SAVE
  // ══════════════════════════════════════════════════════════════════════════

  _save() {
    const s = Store.getSettings();
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    const c = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    const n = (id) => parseFloat(v(id)) || 0;

    // Controls tab
    s.speedButtonUnit = document.querySelector('input[name="spSpeedUnit"]:checked')?.value || 'mph';
    s.speedButtonMode = document.querySelector('input[name="spSpeedMode"]:checked')?.value || 'custom';
    s.speedButtonMax = n('spMaxSpeedBtn');
    s.speedButtonSteps = parseInt(v('spSpeedSteps')) || 8;
    const customStr = v('spCustomSpeeds');
    if (customStr) s.customSpeeds = customStr.split(',').map(x => x.trim()).filter(Boolean).map(Number).filter(x => !isNaN(x));
    s.inclineButtonMode = document.querySelector('input[name="spIncMode"]:checked')?.value || 'default';
    const incStr = v('spCustomInclines');
    if (incStr) s.customInclines = incStr.split(',').map(x => x.trim()).filter(Boolean).map(Number).filter(x => !isNaN(x));
    s.voiceEnabled = c('spVoiceEnabled');
    s.voiceSensitivity = v('spVoiceSensitivity');

    // Metrics tab
    var metricItems = document.querySelectorAll('#spMetricList .sp-metric-item');
    if (metricItems.length > 0) {
      s.statsBarMetrics = [];
      metricItems.forEach(function(el) { s.statsBarMetrics.push(el.dataset.key); });
    }
    s.distUnit = v('spDistUnit') || s.distUnit;
    s.speedUnit = v('spSpeedDisplayUnit') || s.speedUnit;
    s.elevUnit = v('spElevUnit') || s.elevUnit;

    // Charts tab
    s.chartShow = c('spChartShow');
    s.chartHeight = v('spChartHeight');
    s.chartSpeed = c('spChartSpeed');
    s.chartIncline = c('spChartIncline');
    s.chartHR = c('spChartHR');
    s.chartPace = c('spChartPace');
    s.chartRange = v('spChartRange');

    // Widgets
    const widgetChecks = document.querySelectorAll('[data-widget]');
    s.enabledWidgets = [];
    widgetChecks.forEach(el => { if (el.checked) s.enabledWidgets.push(el.dataset.widget); });

    // Audio
    s.ttsEnabled = c('spTTSEnabled');
    s.ttsVerbosity = v('spTTSVerbosity');
    s.ttsVolume = n('spTTSVol') / 100;
    s.sfxEnabled = c('spSFX');
    var voiceName = v('spTTSVoice');
    if (voiceName) {
      s.ttsVoiceName = voiceName;
      if (typeof VoiceCoach !== 'undefined') VoiceCoach.setVoiceByName(voiceName);
    } else {
      delete s.ttsVoiceName;
    }

    // Milestone settings
    s.msSpeedChanges = c('spMsSpeed');
    s.msInclineChanges = c('spMsIncline');
    s.msHRZoneChanges = c('spMsHRZone');
    s.msSplitSummary = c('spMsSplit');
    s.msDistMilestones = c('spMsDist');
    s.msAvgHR = c('spMsAvgHR');
    s.msAvgHRInterval = parseInt(v('spMsAvgHRInt')) || 300;
    s.msShowPopup = c('spMsPopup');
    s.msPopupDuration = parseInt(v('spMsPopupDur')) || 20;

    // Apply milestone config live
    if (typeof MilestoneTracker !== 'undefined') {
      MilestoneTracker.config.speedChanges = s.msSpeedChanges;
      MilestoneTracker.config.inclineChanges = s.msInclineChanges;
      MilestoneTracker.config.hrZoneChanges = s.msHRZoneChanges;
      MilestoneTracker.config.splitSummary = s.msSplitSummary;
      MilestoneTracker.config.distMilestones = s.msDistMilestones;
      MilestoneTracker.config.avgHREnabled = s.msAvgHR;
      MilestoneTracker.config.avgHRInterval = s.msAvgHRInterval;
      MilestoneTracker.config.showPopup = s.msShowPopup;
      MilestoneTracker.config.popupDuration = s.msPopupDuration;
    }

    // Heart Rate
    if (document.getElementById('spMaxHR')) s.maxHR = Math.max(120, Math.min(220, n('spMaxHR')));
    if (document.getElementById('spRestHR')) s.restHR = Math.max(30, Math.min(120, n('spRestHR')));
    for (let z = 1; z <= 5; z++) {
      const min = n('spZ' + z + 'Min');
      const max = n('spZ' + z + 'Max');
      if (min > 0) s['z' + z + 'Min'] = min;
      if (max > 0) s['z' + z + 'Max'] = max;
    }
    s.autoPilotEnabled = c('spAPEnabled');
    s.autoPilotPriority = v('spAPPriority');
    s.autoPilotInterval = parseInt(v('spAPInterval')) || 15;

    // Features
    s.ghostEnabled = c('spGhostEnabled');
    s.ghostSource = v('spGhostSource');
    s.ghostOpacity = parseInt(v('spGhostOpacity')) || 30;
    s.warmUpEnabled = c('spWarmUp');
    s.warmUpDuration = parseInt(v('spWarmUpDur')) || 180;
    s.warmUpSpeed = parseFloat(v('spWarmUpSpeed')) || 4.8;
    s.coolDownEnabled = c('spCoolDown');
    s.coolDownDuration = parseInt(v('spCoolDownDur')) || 120;
    s.coolDownMandatory = c('spCoolDownMandatory');
    s.streaksEnabled = c('spStreaks');

    // Display
    s.defaultView = v('spDefaultView');
    s.showPacMan = c('spPacman');
    s.animations = v('spAnimations');
    s.distLabel = v('spDistLabel');
    s.autoHideUI = c('spAutoHide');
    s.keepScreenOn = c('spKeepScreenOn');

    // Theme
    s.fontSize = v('spFontSize');

    // Units
    if (v('spUnitSpeed')) s.speedUnit = v('spUnitSpeed');
    if (v('spUnitDist')) s.distUnit = v('spUnitDist');
    if (v('spUnitElev')) s.elevUnit = v('spUnitElev');
    s.weightUnit = v('spUnitWeight') || 'kg';

    // Integrations
    s.stravaAutoUpload = c('spStravaAuto');
    s.stravaActivityType = v('spStravaType');
    s.stravaPrivacy = v('spStravaPrivacy');
    s.exportFormat = v('spExportFormat');
    const gKey = (v('spGoogleKey') || '').trim();
    if (gKey) s.googleApiKey = gKey; else delete s.googleApiKey;
    const sId = (v('spStravaId') || '').trim();
    const sSec = (v('spStravaSecret') || '').trim();
    if (sId) s.stravaClientId = sId;
    if (sSec) s.stravaClientSecret = sSec;

    // Profile
    s.userName = (v('spName') || '').trim();
    if (document.getElementById('spAge')) s.age = parseInt(v('spAge')) || 30;
    if (document.getElementById('spWeight')) s.weight = n('spWeight');
    if (document.getElementById('spProfileRestHR')) s.restHR = parseInt(v('spProfileRestHR')) || 60;

    // Safety limits
    s.safetyMaxSpeed = s.safetyMaxSpeed || 20;
    s.safetyMaxIncline = s.safetyMaxIncline || 15;

    Store.saveSettings(s);

    // Apply to UI
    if (typeof UI !== 'undefined') {
      UI.units.speed = s.speedUnit;
      UI.units.dist = s.distUnit;
      UI.units.elev = s.elevUnit;
    }

    // Apply keep-screen-on
    if (s.keepScreenOn && navigator.wakeLock) {
      navigator.wakeLock.request('screen').catch(() => {});
    }

    this.close();
  },

  _setTheme(key) {
    const s = Store.getSettings();
    s.theme = key;
    Store.saveSettings(s);

    // Apply theme colours
    const themes = {
      'dark-navy':     { bg: '#0a1628', card: '#0f1d33', border: '#1e3050' },
      'pure-black':    { bg: '#000000', card: '#0a0a0a', border: '#1a1a1a' },
      'forest-green':  { bg: '#0a1a10', card: '#0f2818', border: '#1e4030' },
      'sunset-orange': { bg: '#1a0f08', card: '#2a1810', border: '#3a2820' },
    };
    const t = themes[key] || themes['dark-navy'];
    document.documentElement.style.setProperty('--bg', t.bg);
    document.documentElement.style.setProperty('--bg-card', t.card);
    document.documentElement.style.setProperty('--border', t.border);

    this._render();
  },

  _showBadges() {
    if (typeof Streaks === 'undefined') { alert('Streaks module not loaded'); return; }
    const badges = Streaks.getEarnedBadges();
    const all = typeof BADGES !== 'undefined' ? BADGES : [];
    alert('Badges: ' + (badges.length > 0 ? badges.map(b => b.icon + ' ' + b.name).join(', ') : 'None earned yet'));
  },
};
