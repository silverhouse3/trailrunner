// ════════════════════════════════════════════════════════════════════════════
// WorkoutBuilder — UI for creating, editing, and browsing programmed workouts
// ════════════════════════════════════════════════════════════════════════════

const WorkoutBuilder = {

  _overlayEl: null,
  _editing: null,     // workout being edited (null = new)
  _segments: [],      // temp editing buffer
  _mode: 'browse',    // browse | edit | pick-type

  // Speed unit definitions (shared with oval track / settings)
  units: {
    'mph':    { label: 'MPH',    toKph: v => v * 1.60934, fromKph: v => v / 1.60934, fmt: v => (+v).toFixed(1), step: 0.5 },
    'kph':    { label: 'KPH',    toKph: v => v,           fromKph: v => v,           fmt: v => (+v).toFixed(1), step: 1.0 },
    'min/mi': { label: 'MIN/MI', toKph: v => { const p=String(v).split(':'); const m=parseFloat(p[0])+(parseFloat(p[1]||0)/60); return m>0?(1.60934/m)*60:0; },
                fromKph: v => { if(v<=0) return '—'; const m=60/(v/1.60934); return Math.floor(m)+':'+String(Math.round((m%1)*60)<60?Math.round((m%1)*60):0).padStart(2,'0'); },
                fmt: v => String(v), step: null },
    'min/km': { label: 'MIN/KM', toKph: v => { const p=String(v).split(':'); const m=parseFloat(p[0])+(parseFloat(p[1]||0)/60); return m>0?60/m:0; },
                fromKph: v => { if(v<=0) return '—'; const m=60/v; return Math.floor(m)+':'+String(Math.round((m%1)*60)<60?Math.round((m%1)*60):0).padStart(2,'0'); },
                fmt: v => String(v), step: null },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // OPEN / CLOSE
  // ══════════════════════════════════════════════════════════════════════════

  open() {
    this._ensureOverlay();
    this._mode = 'browse';
    this._render();
    this._overlayEl.classList.add('show');
  },

  close() {
    if (this._overlayEl) this._overlayEl.classList.remove('show');
  },

  // ══════════════════════════════════════════════════════════════════════════
  // OVERLAY SETUP
  // ══════════════════════════════════════════════════════════════════════════

  _ensureOverlay() {
    if (this._overlayEl) return;
    const el = document.createElement('div');
    el.id = 'workoutBuilderOverlay';
    el.className = 'wb-overlay';
    el.innerHTML = '<div class="wb-panel"><div class="wb-content" id="wbContent"></div></div>';
    document.getElementById('rootApp').appendChild(el);
    this._overlayEl = el;
    // Click backdrop to close
    el.addEventListener('click', (e) => { if (e.target === el) this.close(); });
  },

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  _render() {
    const c = document.getElementById('wbContent');
    if (!c) return;
    if (this._mode === 'browse')    c.innerHTML = this._renderBrowse();
    else if (this._mode === 'pick-type') c.innerHTML = this._renderTypePicker();
    else if (this._mode === 'edit') {
      c.innerHTML = this._renderEditor();
      this._updateSummary();
    }
  },

  // ── Browse Library ────────────────────────────────────────────────────

  _renderBrowse() {
    const workouts = this._getLibrary();
    const recent = workouts.filter(w => w.lastUsed).sort((a,b) => b.lastUsed - a.lastUsed).slice(0, 3);
    const all = workouts.sort((a,b) => (b.lastUsed||0) - (a.lastUsed||0));

    return `
      <div class="wb-header">
        <div class="wb-title">CHOOSE YOUR WORKOUT</div>
        <button class="wb-close" onclick="WorkoutBuilder.close()">✕</button>
      </div>

      ${this._renderSuggestion()}

      <div class="wb-types">
        <button class="wb-type-btn" onclick="WorkoutBuilder._startFreeRun()">
          <div class="wb-type-icon">▶</div>
          <div class="wb-type-label">FREE RUN</div>
        </button>
        <button class="wb-type-btn" onclick="WorkoutBuilder._newWorkout('programmed')">
          <div class="wb-type-icon">📋</div>
          <div class="wb-type-label">PROGRAM</div>
        </button>
        <button class="wb-type-btn" onclick="WorkoutBuilder._newWorkout('interval-time')">
          <div class="wb-type-icon">⏱</div>
          <div class="wb-type-label">INTERVAL</div>
        </button>
        <button class="wb-type-btn" onclick="WorkoutBuilder._newWorkout('interval-hr')">
          <div class="wb-type-icon">❤</div>
          <div class="wb-type-label">HR ZONE</div>
        </button>
      </div>

      ${recent.length > 0 ? `
        <div class="wb-section-title">RECENT</div>
        <div class="wb-list">
          ${recent.map(w => this._renderWorkoutCard(w)).join('')}
        </div>
      ` : ''}

      ${all.length === 0 ? this._renderTemplates() : ''}

      <div class="wb-section-title">ALL WORKOUTS (${all.length})
        <button class="wb-add-btn" onclick="WorkoutBuilder._mode='pick-type';WorkoutBuilder._render()">+ NEW</button>
      </div>
      <div class="wb-list">
        ${all.length === 0
          ? '<div class="wb-empty">No saved workouts yet. Try a template above or tap + NEW.</div>'
          : all.map(w => this._renderWorkoutCard(w)).join('')
        }
      </div>

      ${all.length > 0 ? this._renderTemplates() : ''}
    `;
  },

  _renderWorkoutCard(w) {
    const typeIcons = { 'programmed': '📋', 'interval-time': '⏱', 'interval-hr': '❤' };
    const icon = typeIcons[w.type] || '▶';
    const segs = w.segments || w.intervals || [];
    const totalDist = w.type === 'programmed'
      ? segs.reduce((s, seg) => s + (seg.distance || 0), 0).toFixed(1) + ' ' + (w.distanceUnit || 'mi')
      : (w.type === 'interval-time'
        ? '~' + Math.round(segs.reduce((s, seg) => s + (seg.duration || 0), 0) * (w.rounds || 1) / 60) + ' min'
        : (w.rounds || 1) + ' rounds');
    const lastUsed = w.lastUsed ? this._timeAgo(w.lastUsed) : 'never';
    const best = w.bestTime ? Engine.fmtTime(w.bestTime) : '—';

    return `
      <div class="wb-card" onclick="WorkoutBuilder._startWorkout('${w.id}')">
        <div class="wb-card-top">
          <span class="wb-card-icon">${icon}</span>
          <span class="wb-card-name">${(typeof _esc==='function'?_esc(w.name):w.name)}</span>
          <span class="wb-card-dist">${totalDist}</span>
        </div>
        <div class="wb-card-bottom">
          <span class="wb-card-meta">${lastUsed}</span>
          <span class="wb-card-meta">Best: ${best}</span>
          <span class="wb-card-meta">${w.timesCompleted || 0}× done</span>
          <button class="wb-card-edit" onclick="event.stopPropagation();WorkoutBuilder._editWorkout('${w.id}')">✏</button>
          <button class="wb-card-del" onclick="event.stopPropagation();WorkoutBuilder._deleteWorkout('${w.id}')">🗑</button>
        </div>
      </div>
    `;
  },

  // ── Smart Suggestion ─────────────────────────────────────────────────

  _renderSuggestion() {
    try {
      var runs = JSON.parse(localStorage.getItem('tr_runs') || '[]');
      if (runs.length < 3) return '';

      // Calculate TSB (same algorithm as stats page)
      var dailyTrimp = {};
      var hasEffort = false;
      for (var i = 0; i < runs.length; i++) {
        var dateStr = (runs[i].savedAt || '').slice(0, 10);
        if (!dateStr) continue;
        if (!dailyTrimp[dateStr]) dailyTrimp[dateStr] = 0;
        dailyTrimp[dateStr] += (runs[i].effortScore || 0);
        if (runs[i].effortScore > 0) hasEffort = true;
      }
      if (!hasEffort) return '';

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

      // Days since last run
      var lastDate = (runs[0].savedAt || '').slice(0, 10);
      var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      var daysSince = 0;
      if (lastDate) {
        var lp = lastDate.split('-');
        var lastMs = new Date(parseInt(lp[0]), parseInt(lp[1])-1, parseInt(lp[2])).getTime();
        daysSince = Math.round((today.getTime() - lastMs) / 86400000);
      }

      // Determine suggestion
      var sugIcon, sugTitle, sugDesc, sugAction, sugColor;
      if (daysSince >= 3) {
        sugIcon = '🌱'; sugTitle = 'Welcome Back Run';
        sugDesc = daysSince + ' days off — start easy to get back in rhythm';
        sugAction = 0; // Easy 30 template
        sugColor = '#69f0ae';
      } else if (tsb > 10) {
        sugIcon = '🔥'; sugTitle = 'You\'re Fresh — Push It!';
        sugDesc = 'TSB +' + Math.round(tsb) + ' — great day for intervals or a tempo run';
        sugAction = 2; // 5×1min
        sugColor = '#ff5f5f';
      } else if (tsb > 0) {
        sugIcon = '⚡'; sugTitle = 'Ready to Train';
        sugDesc = 'Good recovery balance — quality session or steady run';
        sugAction = 3; // Tempo Run
        sugColor = '#3ecfff';
      } else if (tsb > -15) {
        sugIcon = '💪'; sugTitle = 'Building Fitness';
        sugDesc = 'Normal load — keep pushing or take it easy';
        sugAction = 0; // Easy 30
        sugColor = '#ffe066';
      } else {
        sugIcon = '😴'; sugTitle = 'Recovery Day';
        sugDesc = 'TSB ' + Math.round(tsb) + ' — your body needs an easy day';
        sugAction = 0; // Easy 30
        sugColor = '#ffb74d';
      }

      return '<div class="wb-suggestion" style="background:linear-gradient(135deg,' + sugColor + '11,' + sugColor + '05);border:1px solid ' + sugColor + '33;border-radius:10px;padding:12px 16px;margin-bottom:12px;cursor:pointer" onclick="WorkoutBuilder._useTemplate(' + sugAction + ')">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:24px">' + sugIcon + '</span>' +
          '<div><div style="font-size:14px;font-weight:700;color:' + sugColor + '">' + sugTitle + '</div>' +
          '<div style="font-size:11px;color:var(--dim);font-family:JetBrains Mono,monospace">' + sugDesc + '</div></div>' +
        '</div></div>';
    } catch(e) {
      return '';
    }
  },

  // ── Templates ────────────────────────────────────────────────────────

  TEMPLATES: [
    {
      name: 'Easy 30', desc: '30 min easy pace', type: 'programmed', icon: '🏃',
      speedUnit: 'kph', distanceUnit: 'km',
      warmUp: { enabled: true, duration: 180, speed: 5, incline: 0 },
      coolDown: { enabled: true, duration: 120, speed: 5, incline: 0 },
      segments: [
        { distance: 4, speed: 8, incline: 0, label: 'Easy' },
      ],
    },
    {
      name: 'C25K Week 1', desc: 'Walk 60s / Run 90s × 8', type: 'interval-time', icon: '🌱',
      speedUnit: 'kph', distanceUnit: 'km', rounds: 8,
      warmUp: { enabled: true, duration: 300, speed: 5, incline: 0 },
      coolDown: { enabled: true, duration: 300, speed: 5, incline: 0 },
      segments: [
        { label: 'Run', duration: 90, speed: 8, incline: 0 },
        { label: 'Walk', duration: 60, speed: 5, incline: 0 },
      ],
    },
    {
      name: '5 × 1 min', desc: '1 min fast / 2 min recovery', type: 'interval-time', icon: '⚡',
      speedUnit: 'kph', distanceUnit: 'km', rounds: 5,
      warmUp: { enabled: true, duration: 300, speed: 6, incline: 0 },
      coolDown: { enabled: true, duration: 180, speed: 5, incline: 0 },
      segments: [
        { label: 'Fast', duration: 60, speed: 12, incline: 0 },
        { label: 'Recover', duration: 120, speed: 6, incline: 0 },
      ],
    },
    {
      name: 'Tempo Run', desc: '10 min warm-up, 20 min tempo, 5 min cooldown', type: 'programmed', icon: '🔥',
      speedUnit: 'kph', distanceUnit: 'km',
      warmUp: { enabled: true, duration: 600, speed: 7, incline: 0 },
      coolDown: { enabled: true, duration: 300, speed: 6, incline: 0 },
      segments: [
        { distance: 3.5, speed: 10.5, incline: 1, label: 'Tempo' },
      ],
    },
    {
      name: 'Pyramid', desc: '1-2-3-2-1 min fast intervals', type: 'interval-time', icon: '🔺',
      speedUnit: 'kph', distanceUnit: 'km', rounds: 1,
      warmUp: { enabled: true, duration: 300, speed: 6, incline: 0 },
      coolDown: { enabled: true, duration: 180, speed: 5, incline: 0 },
      segments: [
        { label: 'Fast 1', duration: 60, speed: 11, incline: 0 },
        { label: 'Recover', duration: 90, speed: 6, incline: 0 },
        { label: 'Fast 2', duration: 120, speed: 11, incline: 0 },
        { label: 'Recover', duration: 90, speed: 6, incline: 0 },
        { label: 'Fast 3', duration: 180, speed: 11, incline: 0 },
        { label: 'Recover', duration: 90, speed: 6, incline: 0 },
        { label: 'Fast 2', duration: 120, speed: 11, incline: 0 },
        { label: 'Recover', duration: 90, speed: 6, incline: 0 },
        { label: 'Fast 1', duration: 60, speed: 11, incline: 0 },
      ],
    },
    {
      name: 'Hill Repeats', desc: '6 × 90s incline push', type: 'interval-time', icon: '⛰',
      speedUnit: 'kph', distanceUnit: 'km', rounds: 6,
      warmUp: { enabled: true, duration: 300, speed: 7, incline: 0 },
      coolDown: { enabled: true, duration: 180, speed: 5, incline: 0 },
      segments: [
        { label: 'Hill', duration: 90, speed: 9, incline: 8 },
        { label: 'Flat', duration: 120, speed: 7, incline: 0 },
      ],
    },
    {
      name: 'HIIT 20/40', desc: '20s sprint / 40s rest × 10', type: 'interval-time', icon: '💥',
      speedUnit: 'kph', distanceUnit: 'km', rounds: 10,
      warmUp: { enabled: true, duration: 300, speed: 6, incline: 0 },
      coolDown: { enabled: true, duration: 180, speed: 4, incline: 0 },
      segments: [
        { label: 'Sprint', duration: 20, speed: 15, incline: 0 },
        { label: 'Rest', duration: 40, speed: 5, incline: 0 },
      ],
    },
    {
      name: 'Fat Burn Zone', desc: 'HR Zone 2 — 30 min steady', type: 'interval-hr', icon: '❤',
      speedUnit: 'kph', distanceUnit: 'km', rounds: 1, holdTime: 1800,
      warmUp: { enabled: true, duration: 300, speed: 6, incline: 0 },
      coolDown: { enabled: true, duration: 180, speed: 5, incline: 0 },
      segments: [
        { label: 'Fat Burn', targetZone: 2, speed: 8, incline: 1 },
      ],
    },
  ],

  _renderTemplates() {
    var html = '<div class="wb-section-title">TEMPLATES</div><div class="wb-list">';
    for (var i = 0; i < this.TEMPLATES.length; i++) {
      var t = this.TEMPLATES[i];
      html += '<div class="wb-card wb-template" onclick="WorkoutBuilder._useTemplate(' + i + ')">';
      html += '<div class="wb-card-top">';
      html += '<span class="wb-card-icon">' + t.icon + '</span>';
      html += '<span class="wb-card-name">' + t.name + '</span>';
      html += '<span class="wb-card-dist" style="color:#bb86fc">Template</span>';
      html += '</div>';
      html += '<div class="wb-card-bottom">';
      html += '<span class="wb-card-meta">' + t.desc + '</span>';
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  },

  _useTemplate(idx) {
    var t = this.TEMPLATES[idx];
    if (!t) return;
    // Clone template into library with new ID
    var w = JSON.parse(JSON.stringify(t));
    w.id = 'w_' + Date.now();
    w.timesCompleted = 0;
    w.bestTime = null;
    w.lastUsed = null;
    delete w.desc;
    delete w.icon;
    var lib = this._getLibrary();
    lib.push(w);
    this._setLibrary(lib);
    // Start it
    this._startWorkout(w.id);
  },

  // ── Type Picker ───────────────────────────────────────────────────────

  _renderTypePicker() {
    return `
      <div class="wb-header">
        <button class="wb-back" onclick="WorkoutBuilder._mode='browse';WorkoutBuilder._render()">← BACK</button>
        <div class="wb-title">NEW WORKOUT</div>
        <button class="wb-close" onclick="WorkoutBuilder.close()">✕</button>
      </div>
      <div class="wb-type-grid">
        <button class="wb-type-card" onclick="WorkoutBuilder._newWorkout('programmed')">
          <div class="wb-tc-icon">📋</div>
          <div class="wb-tc-name">PROGRAMMED</div>
          <div class="wb-tc-desc">Set distance + speed for each segment.<br>e.g. 2mi @ 5mph → 1mi @ 7mph → 2mi @ 5mph</div>
        </button>
        <button class="wb-type-card" onclick="WorkoutBuilder._newWorkout('interval-time')">
          <div class="wb-tc-icon">⏱</div>
          <div class="wb-tc-name">TIME INTERVALS</div>
          <div class="wb-tc-desc">Set work/rest durations.<br>e.g. 30s sprint / 90s recovery × 8 rounds</div>
        </button>
        <button class="wb-type-card" onclick="WorkoutBuilder._newWorkout('interval-hr')">
          <div class="wb-tc-icon">❤</div>
          <div class="wb-tc-name">HR ZONE INTERVALS</div>
          <div class="wb-tc-desc">Work until target HR zone, recover until lower zone.<br>Auto-adjusts based on your heart rate.</div>
        </button>
      </div>
    `;
  },

  // ── Editor ────────────────────────────────────────────────────────────

  _renderEditor() {
    const w = this._editing;
    const isProgrammed = w.type === 'programmed';
    const isTimeInterval = w.type === 'interval-time';
    const isHRInterval = w.type === 'interval-hr';
    const segs = this._segments;
    const sUnit = w.speedUnit || 'mph';
    const dUnit = w.distanceUnit || 'mi';

    const segRows = segs.map((seg, i) => {
      if (isProgrammed) {
        return `<div class="wb-seg-row" data-idx="${i}">
          <span class="wb-seg-grip">☰</span>
          <input class="wb-seg-input" type="number" step="0.1" min="0.1" value="${seg.distance}" onchange="WorkoutBuilder._updateSeg(${i},'distance',this.value)" style="width:60px" title="Distance">
          <span class="wb-seg-unit">${dUnit}</span>
          <span class="wb-seg-at">@</span>
          <input class="wb-seg-input" type="${sUnit.includes('min') ? 'text' : 'number'}" step="0.5" value="${seg.speed}" onchange="WorkoutBuilder._updateSeg(${i},'speed',this.value)" style="width:60px" title="Speed">
          <span class="wb-seg-unit">${sUnit}</span>
          <input class="wb-seg-input" type="number" step="1" min="-6" max="40" value="${seg.incline||0}" onchange="WorkoutBuilder._updateSeg(${i},'incline',this.value)" style="width:50px" title="Incline %">
          <span class="wb-seg-unit">%</span>
          <input class="wb-seg-input wb-seg-label" type="text" value="${seg.label||''}" placeholder="Label" onchange="WorkoutBuilder._updateSeg(${i},'label',this.value)" style="width:80px">
          <button class="wb-seg-del" onclick="WorkoutBuilder._removeSeg(${i})">✕</button>
        </div>`;
      } else if (isTimeInterval) {
        return `<div class="wb-seg-row" data-idx="${i}">
          <span class="wb-seg-grip">☰</span>
          <input class="wb-seg-input wb-seg-label" type="text" value="${seg.label||''}" placeholder="Label" onchange="WorkoutBuilder._updateSeg(${i},'label',this.value)" style="width:80px">
          <input class="wb-seg-input" type="number" step="5" min="5" value="${seg.duration}" onchange="WorkoutBuilder._updateSeg(${i},'duration',this.value)" style="width:60px" title="Duration (s)">
          <span class="wb-seg-unit">sec</span>
          <input class="wb-seg-input" type="number" step="0.5" value="${seg.speed}" onchange="WorkoutBuilder._updateSeg(${i},'speed',this.value)" style="width:60px" title="Speed">
          <span class="wb-seg-unit">${sUnit}</span>
          <input class="wb-seg-input" type="number" step="1" min="-6" max="40" value="${seg.incline||0}" onchange="WorkoutBuilder._updateSeg(${i},'incline',this.value)" style="width:50px">
          <span class="wb-seg-unit">%</span>
          <button class="wb-seg-del" onclick="WorkoutBuilder._removeSeg(${i})">✕</button>
        </div>`;
      } else { // HR interval
        return `<div class="wb-seg-row" data-idx="${i}">
          <span class="wb-seg-grip">☰</span>
          <input class="wb-seg-input wb-seg-label" type="text" value="${seg.label||''}" placeholder="Label" onchange="WorkoutBuilder._updateSeg(${i},'label',this.value)" style="width:80px">
          <span class="wb-seg-unit">Zone</span>
          <select class="wb-seg-input" onchange="WorkoutBuilder._updateSeg(${i},'targetZone',this.value)" style="width:50px">
            ${[1,2,3,4,5].map(z => `<option value="${z}" ${(seg.targetZone||2)==z?'selected':''}>${z}</option>`).join('')}
          </select>
          <input class="wb-seg-input" type="number" step="0.5" value="${seg.speed}" onchange="WorkoutBuilder._updateSeg(${i},'speed',this.value)" style="width:60px" title="Speed">
          <span class="wb-seg-unit">${sUnit}</span>
          <input class="wb-seg-input" type="number" step="1" min="-6" max="40" value="${seg.incline||0}" onchange="WorkoutBuilder._updateSeg(${i},'incline',this.value)" style="width:50px">
          <span class="wb-seg-unit">%</span>
          <button class="wb-seg-del" onclick="WorkoutBuilder._removeSeg(${i})">✕</button>
        </div>`;
      }
    }).join('');

    return `
      <div class="wb-header">
        <button class="wb-back" onclick="WorkoutBuilder._mode='browse';WorkoutBuilder._render()">← BACK</button>
        <div class="wb-title">${w.id ? 'EDIT' : 'NEW'} ${w.type.toUpperCase().replace('-',' ')}</div>
        <button class="wb-close" onclick="WorkoutBuilder.close()">✕</button>
      </div>

      <div class="wb-form">
        <div class="wb-form-row">
          <label class="wb-label">Name</label>
          <input class="wb-input" type="text" id="wbName" value="${(typeof _esc==='function'?_esc(w.name||''):w.name||'')}" placeholder="My Workout">
        </div>

        <div class="wb-form-row">
          ${isProgrammed ? `
            <div>
              <label class="wb-label">Distance Unit</label>
              <select class="wb-input" id="wbDistUnit" onchange="WorkoutBuilder._editing.distanceUnit=this.value;WorkoutBuilder._render()">
                <option value="mi" ${dUnit==='mi'?'selected':''}>Miles</option>
                <option value="km" ${dUnit==='km'?'selected':''}>Kilometres</option>
              </select>
            </div>
          ` : ''}
          <div>
            <label class="wb-label">Speed Unit</label>
            <select class="wb-input" id="wbSpeedUnit" onchange="WorkoutBuilder._editing.speedUnit=this.value;WorkoutBuilder._render()">
              <option value="mph" ${sUnit==='mph'?'selected':''}>MPH</option>
              <option value="kph" ${sUnit==='kph'?'selected':''}>KPH</option>
              <option value="min/mi" ${sUnit==='min/mi'?'selected':''}>Min/Mi</option>
              <option value="min/km" ${sUnit==='min/km'?'selected':''}>Min/Km</option>
            </select>
          </div>
          ${isTimeInterval || isHRInterval ? `
            <div>
              <label class="wb-label">Rounds</label>
              <input class="wb-input" type="number" id="wbRounds" min="1" max="50" value="${w.rounds || 8}" style="width:60px">
            </div>
          ` : ''}
          ${isHRInterval ? `
            <div>
              <label class="wb-label">Hold (s)</label>
              <input class="wb-input" type="number" id="wbHoldTime" min="5" max="120" value="${w.holdTime || 30}" style="width:60px" title="Seconds in zone before advancing">
            </div>
          ` : ''}
        </div>

        <div class="wb-section-title">SEGMENTS
          <button class="wb-add-btn" onclick="WorkoutBuilder._addSeg()">+ ADD</button>
        </div>
        <div class="wb-seg-list" id="wbSegList">
          ${segs.length === 0
            ? '<div class="wb-empty">No segments. Tap + ADD to create one.</div>'
            : segRows
          }
        </div>

        <!-- Workout summary -->
        <div class="wb-summary" id="wbSummary" style="padding:8px 0;font-size:11px;color:var(--dim,#4a6785);font-family:'JetBrains Mono',monospace"></div>

        <!-- Warm-up / Cool-down -->
        <div class="wb-section-title">WARM-UP & COOL-DOWN</div>
        <div class="wb-bookend-row">
          <label class="wb-toggle-label">
            <input type="checkbox" id="wbWarmUp" ${w.warmUp && w.warmUp.enabled !== false ? 'checked' : ''}> Warm-up
          </label>
          <input class="wb-seg-input" type="number" id="wbWarmUpDur" min="60" max="600" step="30" value="${(w.warmUp && w.warmUp.duration) || 180}" style="width:60px"> sec
          <span class="wb-seg-unit">@ </span>
          <input class="wb-seg-input" type="number" id="wbWarmUpSpd" step="0.5" value="${this._displayBookendSpeed((w.warmUp && w.warmUp.speed) || 4.8, sUnit)}" style="width:60px"> ${sUnit}
        </div>
        <div class="wb-bookend-row">
          <label class="wb-toggle-label">
            <input type="checkbox" id="wbCoolDown" ${w.coolDown && w.coolDown.enabled !== false ? 'checked' : ''}> Cool-down
          </label>
          <input class="wb-seg-input" type="number" id="wbCoolDownDur" min="60" max="600" step="30" value="${(w.coolDown && w.coolDown.duration) || 120}" style="width:60px"> sec
          <span class="wb-seg-unit">@ </span>
          <input class="wb-seg-input" type="number" id="wbCoolDownSpd" step="0.5" value="${this._displayBookendSpeed((w.coolDown && w.coolDown.speed) || 4.8, sUnit)}" style="width:60px"> ${sUnit}
          <label class="wb-toggle-label" style="margin-left:12px">
            <input type="checkbox" id="wbCoolDownMandatory" ${w.coolDown && w.coolDown.mandatory ? 'checked' : ''}> Mandatory
          </label>
        </div>

        <!-- Tags -->
        <div class="wb-form-row">
          <label class="wb-label">Tags (comma-separated)</label>
          <input class="wb-input" type="text" id="wbTags" value="${(w.tags || []).join(', ')}" placeholder="easy, tuesday, soph">
        </div>
      </div>

      <div class="wb-footer">
        <button class="wb-save-btn" onclick="WorkoutBuilder._saveWorkout()">💾 SAVE WORKOUT</button>
        <button class="wb-start-btn" onclick="WorkoutBuilder._saveAndStart()">▶ SAVE & START</button>
        <button class="wb-cancel-btn" onclick="WorkoutBuilder._mode='browse';WorkoutBuilder._render()">CANCEL</button>
      </div>
    `;
  },

  // ══════════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ══════════════════════════════════════════════════════════════════════════

  _newWorkout(type) {
    const defaults = {
      programmed: [
        { distance: 2, speed: 5, incline: 0, label: 'Easy' },
        { distance: 1, speed: 7, incline: 3, label: 'Push' },
        { distance: 2, speed: 5, incline: 0, label: 'Easy' },
      ],
      'interval-time': [
        { label: 'Sprint', duration: 30, speed: 9, incline: 2 },
        { label: 'Recover', duration: 90, speed: 4, incline: 0 },
      ],
      'interval-hr': [
        { label: 'Push', targetZone: 4, speed: 8, incline: 3 },
        { label: 'Recover', targetZone: 2, speed: 4, incline: 0 },
      ],
    };

    this._editing = {
      id: null,
      name: '',
      type: type,
      speedUnit: 'mph',
      distanceUnit: 'mi',
      rounds: type !== 'programmed' ? 8 : undefined,
      holdTime: type === 'interval-hr' ? 30 : undefined,
      warmUp: { enabled: true, duration: 180, speed: 4.8, incline: 0 },
      coolDown: { enabled: true, duration: 120, speed: 4.8, incline: 0, mandatory: false },
      tags: [],
    };
    this._segments = JSON.parse(JSON.stringify(defaults[type] || []));
    this._mode = 'edit';
    this._render();
  },

  _editWorkout(id) {
    const workouts = this._getLibrary();
    const w = workouts.find(x => x.id === id);
    if (!w) return;
    this._editing = JSON.parse(JSON.stringify(w));
    this._segments = JSON.parse(JSON.stringify(w.segments || w.intervals || []));
    this._mode = 'edit';
    this._render();
  },

  _deleteWorkout(id) {
    if (!confirm('Delete this workout?')) return;
    const workouts = this._getLibrary().filter(w => w.id !== id);
    this._setLibrary(workouts);
    this._render();
  },

  _addSeg() {
    const w = this._editing;
    if (w.type === 'programmed') {
      this._segments.push({ distance: 1, speed: 5, incline: 0, label: '' });
    } else if (w.type === 'interval-time') {
      this._segments.push({ label: '', duration: 30, speed: 6, incline: 0 });
    } else {
      this._segments.push({ label: '', targetZone: 2, speed: 5, incline: 0 });
    }
    this._render();
  },

  _removeSeg(idx) {
    this._segments.splice(idx, 1);
    this._render();
  },

  _updateSeg(idx, field, value) {
    const seg = this._segments[idx];
    if (!seg) return;
    if (field === 'distance' || field === 'speed' || field === 'incline' || field === 'duration' || field === 'targetZone') {
      seg[field] = field === 'speed' && (this._editing.speedUnit === 'min/mi' || this._editing.speedUnit === 'min/km')
        ? value : parseFloat(value) || 0;
    } else {
      seg[field] = value;
    }
    this._updateSummary();
  },

  _saveWorkout() {
    const w = this._editing;
    const nameEl = document.getElementById('wbName');
    w.name = (nameEl ? nameEl.value : '').trim() || 'My Workout';

    const tagsEl = document.getElementById('wbTags');
    w.tags = (tagsEl ? tagsEl.value : '').split(',').map(t => t.trim()).filter(Boolean);

    // Rounds / hold time
    const roundsEl = document.getElementById('wbRounds');
    if (roundsEl) w.rounds = parseInt(roundsEl.value) || 8;
    const holdEl = document.getElementById('wbHoldTime');
    if (holdEl) w.holdTime = parseInt(holdEl.value) || 30;

    // Warm-up (convert display speed back to kph for storage)
    var _wuSpd = document.getElementById('wbWarmUpSpd');
    var _wuEn = document.getElementById('wbWarmUp');
    var _wuDur = document.getElementById('wbWarmUpDur');
    var wuDisplaySpeed = _wuSpd ? _wuSpd.value : '4.8';
    w.warmUp = {
      enabled: _wuEn ? _wuEn.checked : false,
      duration: parseInt(_wuDur ? _wuDur.value : '180') || 180,
      speed: this._parseBookendSpeed(wuDisplaySpeed, w.speedUnit || 'mph'),
      incline: 0,
      rampUp: true,
    };

    // Cool-down (convert display speed back to kph for storage)
    var _cdSpd = document.getElementById('wbCoolDownSpd');
    var _cdEn = document.getElementById('wbCoolDown');
    var _cdDur = document.getElementById('wbCoolDownDur');
    var cdDisplaySpeed = _cdSpd ? _cdSpd.value : '4.8';
    w.coolDown = {
      enabled: _cdEn ? _cdEn.checked : false,
      duration: parseInt(_cdDur ? _cdDur.value : '120') || 120,
      speed: this._parseBookendSpeed(cdDisplaySpeed, w.speedUnit || 'mph'),
      incline: 0,
      mandatory: (function() { var el = document.getElementById('wbCoolDownMandatory'); return el ? el.checked : false; })(),
    };

    // Segments
    if (w.type === 'programmed') {
      w.segments = JSON.parse(JSON.stringify(this._segments));
    } else {
      w.intervals = JSON.parse(JSON.stringify(this._segments));
    }

    // Save
    if (!w.id) w.id = 'wk_' + Date.now();
    if (!w.created) w.created = Date.now();
    w.timesCompleted = w.timesCompleted || 0;

    const workouts = this._getLibrary();
    const idx = workouts.findIndex(x => x.id === w.id);
    if (idx >= 0) workouts[idx] = w;
    else workouts.push(w);
    this._setLibrary(workouts);

    this._mode = 'browse';
    this._render();
    return w;
  },

  _saveAndStart() {
    const w = this._saveWorkout();
    if (w) this._startWorkout(w.id);
  },

  _startWorkout(id) {
    const workouts = this._getLibrary();
    const w = workouts.find(x => x.id === id);
    if (!w) return;

    // Mark as used
    w.lastUsed = Date.now();
    this._setLibrary(workouts);

    // Close builder
    this.close();

    // Try native programmed workout execution (motor controller handles transitions)
    if (w.type === 'programmed' && typeof TM !== 'undefined' && TM._bridgeUrl) {
      this._tryNativeProgram(w);
      return;
    }

    // Fallback: Start via WorkoutSegments (PWA manages transitions)
    if (typeof WorkoutSegments !== 'undefined') {
      WorkoutSegments.start(w);
    }

    // Start the actual run if not already running
    if (!Engine.run || Engine.run.status !== 'running') {
      Engine.newRun();
      // Tag the run with the workout name (enables comparison on finish)
      if (Engine.run && w.name) {
        Engine.run.routeName = w.name;
      }
      Engine.startRun();
      TM.startWorkout();
    }
  },

  // Push programmed workout directly to motor controller via bridge /workout/program
  _tryNativeProgram(w) {
    const controls = this._buildControlPoints(w);
    const totalSeconds = this._estimateTotalSeconds(w);

    const payload = {
      title: w.name || 'Programmed Workout',
      targetType: 'TIME',
      targetValue: totalSeconds,
      controls: controls,
    };

    const url = TM._bridgeUrl + '/workout/program';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        console.log('[WorkoutBuilder] Native program pushed:', data);
        // Start tracking in Engine
        if (!Engine.run || Engine.run.status !== 'running') {
          Engine.newRun();
          if (Engine.run && w.name) Engine.run.routeName = w.name;
          Engine.startRun();
        }
        // Also start WorkoutSegments for UI display
        if (typeof WorkoutSegments !== 'undefined') {
          WorkoutSegments.start(w);
        }
      } else {
        console.warn('[WorkoutBuilder] Native program failed, falling back:', data.error);
        // Fallback to PWA-managed
        if (typeof WorkoutSegments !== 'undefined') WorkoutSegments.start(w);
        if (!Engine.run || Engine.run.status !== 'running') {
          Engine.newRun();
          if (Engine.run && w.name) Engine.run.routeName = w.name;
          Engine.startRun();
          TM.startWorkout();
        }
      }
    })
    .catch(function(err) {
      console.warn('[WorkoutBuilder] Native program error, falling back:', err);
      if (typeof WorkoutSegments !== 'undefined') WorkoutSegments.start(w);
      if (!Engine.run || Engine.run.status !== 'running') {
        Engine.newRun();
        if (Engine.run && w.name) Engine.run.routeName = w.name;
        Engine.startRun();
        TM.startWorkout();
      }
    });
  },

  // Convert workout segments into gRPC Control points (MPS + INCLINE at time offsets)
  _buildControlPoints(w) {
    var controls = [];
    var timeOffset = 0; // seconds
    var sUnit = this.units[w.speedUnit || 'mph'];
    var segs = w.segments || [];

    // Warm-up
    if (w.warmUp && w.warmUp.enabled !== false) {
      var wuKph = w.warmUp.speed || 4.8;
      var wuMps = wuKph / 3.6;
      controls.push({ type: 'MPS', at: timeOffset, value: wuMps });
      controls.push({ type: 'INCLINE', at: timeOffset, value: w.warmUp.incline || 0 });
      timeOffset += w.warmUp.duration || 180;
    }

    // Main segments — convert distance + speed to time
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var speedKph = sUnit ? sUnit.toKph(seg.speed) : seg.speed;
      var mps = speedKph / 3.6;
      var distKm = (w.distanceUnit === 'km') ? seg.distance : seg.distance * 1.60934;
      var segSeconds = (speedKph > 0) ? (distKm / speedKph) * 3600 : 0;

      controls.push({ type: 'MPS', at: timeOffset, value: mps });
      controls.push({ type: 'INCLINE', at: timeOffset, value: seg.incline || 0 });
      timeOffset += segSeconds;
    }

    // Cool-down
    if (w.coolDown && w.coolDown.enabled !== false) {
      var cdKph = w.coolDown.speed || 4.8;
      var cdMps = cdKph / 3.6;
      controls.push({ type: 'MPS', at: timeOffset, value: cdMps });
      controls.push({ type: 'INCLINE', at: timeOffset, value: w.coolDown.incline || 0 });
      timeOffset += w.coolDown.duration || 120;
    }

    return controls;
  },

  _estimateTotalSeconds(w) {
    var total = 0;
    var sUnit = this.units[w.speedUnit || 'mph'];
    if (w.warmUp && w.warmUp.enabled !== false) total += w.warmUp.duration || 180;
    var segs = w.segments || [];
    for (var i = 0; i < segs.length; i++) {
      var speedKph = sUnit ? sUnit.toKph(segs[i].speed) : segs[i].speed;
      var distKm = (w.distanceUnit === 'km') ? segs[i].distance : segs[i].distance * 1.60934;
      total += (speedKph > 0) ? (distKm / speedKph) * 3600 : 0;
    }
    if (w.coolDown && w.coolDown.enabled !== false) total += w.coolDown.duration || 120;
    return Math.round(total);
  },

  _startFreeRun() {
    this.close();
    if (typeof App !== 'undefined' && App.freeRun) {
      App.freeRun();
    } else {
      Engine.newRun();
      Engine.startRun();
    }
  },

  // ══════════════════════════════════════════════════════════════════════════
  // STORAGE
  // ══════════════════════════════════════════════════════════════════════════

  _getLibrary() {
    try {
      return JSON.parse(localStorage.getItem('tr_workouts') || '[]');
    } catch(e) { return []; }
  },

  _setLibrary(workouts) {
    try {
      localStorage.setItem('tr_workouts', JSON.stringify(workouts));
    } catch (e) { console.warn('[WorkoutBuilder] Save failed:', e); }
  },

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATES (pre-built workouts)
  // ══════════════════════════════════════════════════════════════════════════

  seedDefaults() {
    const lib = this._getLibrary();
    if (lib.length > 0) return; // don't overwrite existing

    const defaults = [
      {
        id: 'wk_default_1', name: 'Soph Easy 5K', type: 'programmed',
        speedUnit: 'mph', distanceUnit: 'mi',
        segments: [
          { distance: 1, speed: 5, incline: 0, label: 'Easy' },
          { distance: 0.5, speed: 6, incline: 2, label: 'Push' },
          { distance: 1, speed: 5, incline: 0, label: 'Easy' },
          { distance: 0.5, speed: 6, incline: 2, label: 'Push' },
          { distance: 0.1, speed: 4, incline: 0, label: 'Cool' },
        ],
        warmUp: { enabled: true, duration: 180, speed: 4.8, incline: 0, rampUp: true },
        coolDown: { enabled: true, duration: 120, speed: 4.8, incline: 0, mandatory: false },
        tags: ['easy', '5k'], created: Date.now(), timesCompleted: 0,
      },
      {
        id: 'wk_default_2', name: 'HIIT 30/90', type: 'interval-time',
        speedUnit: 'mph', rounds: 8,
        intervals: [
          { label: 'Sprint', duration: 30, speed: 9, incline: 2 },
          { label: 'Recover', duration: 90, speed: 4, incline: 0 },
        ],
        warmUp: { enabled: true, duration: 180, speed: 4.8, incline: 0, rampUp: true },
        coolDown: { enabled: true, duration: 120, speed: 4.8, incline: 0, mandatory: false },
        tags: ['hiit', 'hard'], created: Date.now(), timesCompleted: 0,
      },
      {
        id: 'wk_default_3', name: 'Rolling Hills', type: 'programmed',
        speedUnit: 'mph', distanceUnit: 'mi',
        segments: [
          { distance: 0.5, speed: 5, incline: 0, label: 'Flat' },
          { distance: 0.25, speed: 5, incline: 8, label: 'Climb' },
          { distance: 0.25, speed: 6, incline: 0, label: 'Fast Flat' },
          { distance: 0.25, speed: 4, incline: 15, label: 'Steep' },
          { distance: 0.25, speed: 6, incline: -3, label: 'Downhill' },
          { distance: 0.5, speed: 4, incline: 0, label: 'Recovery' },
        ],
        warmUp: { enabled: true, duration: 180, speed: 4.8, incline: 0, rampUp: true },
        coolDown: { enabled: true, duration: 120, speed: 4.8, incline: 0, mandatory: false },
        tags: ['hills', 'incline'], created: Date.now(), timesCompleted: 0,
      },
      {
        id: 'wk_default_4', name: 'Z2 Fat Burn', type: 'interval-hr',
        speedUnit: 'mph', rounds: 4, holdTime: 30,
        intervals: [
          { label: 'Push', targetZone: 3, speed: 7, incline: 2 },
          { label: 'Recover', targetZone: 2, speed: 5, incline: 0 },
        ],
        warmUp: { enabled: true, duration: 180, speed: 4.8, incline: 0, rampUp: true },
        coolDown: { enabled: true, duration: 180, speed: 4.8, incline: 0, mandatory: true },
        tags: ['hr', 'fat-burn'], created: Date.now(), timesCompleted: 0,
      },
      {
        id: 'wk_default_5', name: 'X32i Mountain', type: 'programmed',
        speedUnit: 'mph', distanceUnit: 'mi',
        segments: [
          { distance: 0.3, speed: 4.5, incline: 5, label: 'Foothills' },
          { distance: 0.2, speed: 4, incline: 15, label: 'Ascent' },
          { distance: 0.15, speed: 3.5, incline: 25, label: 'Summit Push' },
          { distance: 0.1, speed: 3, incline: 35, label: 'Peak' },
          { distance: 0.15, speed: 5, incline: -3, label: 'Descent' },
          { distance: 0.2, speed: 5.5, incline: -6, label: 'Downhill Run' },
          { distance: 0.3, speed: 5, incline: 0, label: 'Valley' },
        ],
        warmUp: { enabled: true, duration: 180, speed: 4, incline: 0, rampUp: true },
        coolDown: { enabled: true, duration: 180, speed: 3.5, incline: 0, mandatory: true },
        tags: ['hills', 'extreme', 'x32i'], created: Date.now(), timesCompleted: 0,
      },
      {
        id: 'wk_default_6', name: 'Couch to 5K W1', type: 'interval-time',
        speedUnit: 'mph', rounds: 8,
        intervals: [
          { label: 'Run', duration: 60, speed: 5, incline: 0 },
          { label: 'Walk', duration: 90, speed: 3.5, incline: 0 },
        ],
        warmUp: { enabled: true, duration: 300, speed: 3.5, incline: 0, rampUp: false },
        coolDown: { enabled: true, duration: 300, speed: 3.5, incline: 0, mandatory: false },
        tags: ['beginner', 'c25k'], created: Date.now(), timesCompleted: 0,
      },
      {
        id: 'wk_default_7', name: 'Tabata Sprints', type: 'interval-time',
        speedUnit: 'mph', rounds: 8,
        intervals: [
          { label: 'MAX', duration: 20, speed: 10, incline: 1 },
          { label: 'Rest', duration: 10, speed: 3.5, incline: 0 },
        ],
        warmUp: { enabled: true, duration: 300, speed: 5, incline: 0, rampUp: true },
        coolDown: { enabled: true, duration: 300, speed: 4, incline: 0, mandatory: true },
        tags: ['tabata', 'sprint', 'hard'], created: Date.now(), timesCompleted: 0,
      },
      {
        id: 'wk_default_8', name: '12-3-30', type: 'programmed',
        speedUnit: 'mph', distanceUnit: 'mi',
        segments: [
          { distance: 1.5, speed: 3, incline: 12, label: '12% Walk' },
        ],
        warmUp: { enabled: true, duration: 120, speed: 3, incline: 0, rampUp: false },
        coolDown: { enabled: true, duration: 120, speed: 3, incline: 0, mandatory: false },
        tags: ['12-3-30', 'walk', 'popular'], created: Date.now(), timesCompleted: 0,
      },
    ];

    this._setLibrary(defaults);
  },

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** Update the workout summary line in the editor */
  _updateSummary() {
    var el = document.getElementById('wbSummary');
    if (!el || !this._editing) return;
    var w = this._editing;
    var segs = this._segments;
    var sUnit = this.units[w.speedUnit || 'mph'];
    var totalDist = 0; // km
    var totalTime = 0; // seconds

    if (w.warmUp && w.warmUp.enabled !== false) totalTime += w.warmUp.duration || 180;
    if (w.coolDown && w.coolDown.enabled !== false) totalTime += w.coolDown.duration || 120;

    if (w.type === 'programmed') {
      for (var i = 0; i < segs.length; i++) {
        var speedKph = sUnit ? sUnit.toKph(segs[i].speed) : segs[i].speed;
        var distKm = (w.distanceUnit === 'km') ? segs[i].distance : segs[i].distance * 1.60934;
        totalDist += distKm;
        totalTime += speedKph > 0 ? (distKm / speedKph) * 3600 : 0;
      }
      var displayDist = w.distanceUnit === 'km' ? totalDist.toFixed(1) + ' km' : (totalDist / 1.60934).toFixed(1) + ' mi';
      el.textContent = 'Total: ' + displayDist + ' · ~' + Math.round(totalTime / 60) + ' min';
    } else if (w.type === 'interval-time') {
      var roundTime = segs.reduce(function(s, seg) { return s + (seg.duration || 0); }, 0);
      totalTime += roundTime * (w.rounds || 8);
      el.textContent = (w.rounds || 8) + ' rounds × ' + Math.round(roundTime) + 's = ~' + Math.round(totalTime / 60) + ' min';
    } else {
      el.textContent = (w.rounds || 4) + ' rounds (HR-controlled timing)';
    }
  },

  /** Display a kph speed value in the workout's speed unit */
  _displayBookendSpeed(kph, sUnit) {
    var u = this.units[sUnit];
    if (!u) return (+kph).toFixed(1);
    return u.fmt(u.fromKph(kph));
  },

  /** Convert a display speed value back to kph for storage */
  _parseBookendSpeed(displayVal, sUnit) {
    var u = this.units[sUnit];
    if (!u) return parseFloat(displayVal) || 4.8;
    return u.toKph(displayVal);
  },

  _timeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + ' min ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    const weeks = Math.floor(days / 7);
    return weeks + 'w ago';
  },
};
