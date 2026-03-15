// ════════════════════════════════════════════════════════════════════════════
// IDBStore — IndexedDB-backed storage for runs and routes
//
// Transparently migrates from localStorage on first load.
// Falls back to localStorage if IndexedDB is unavailable (Chrome 83 supports it).
//
// Usage:
//   IDBStore.init()           — open DB + migrate from localStorage
//   IDBStore.saveRun(run)     — save a run (also writes to localStorage for compat)
//   IDBStore.getRuns()        — get all runs (async, returns Promise)
//   IDBStore.getRunsSync()    — get runs from localStorage (sync fallback)
//   IDBStore.deleteRun(id)    — delete a run by id
//   IDBStore.getRunCount()    — count of stored runs
// ════════════════════════════════════════════════════════════════════════════

var IDBStore = {

  DB_NAME: 'trailrunner',
  DB_VERSION: 1,
  _db: null,
  _ready: false,
  _readyCallbacks: [],

  // ── Init ──────────────────────────────────────────────────────────────────

  init: function() {
    if (!window.indexedDB) {
      console.warn('[IDBStore] IndexedDB not available, using localStorage only');
      this._ready = true;
      return;
    }

    var self = this;
    var request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

    request.onupgradeneeded = function(e) {
      var db = e.target.result;

      // Runs store — indexed by date for efficient queries
      if (!db.objectStoreNames.contains('runs')) {
        var runStore = db.createObjectStore('runs', { keyPath: 'id' });
        runStore.createIndex('savedAt', 'savedAt', { unique: false });
        runStore.createIndex('routeId', 'routeId', { unique: false });
      }

      // Routes store
      if (!db.objectStoreNames.contains('routes')) {
        var routeStore = db.createObjectStore('routes', { keyPath: 'id' });
        routeStore.createIndex('name', 'name', { unique: false });
      }

      console.log('[IDBStore] Database created/upgraded to v' + self.DB_VERSION);
    };

    request.onsuccess = function(e) {
      self._db = e.target.result;
      self._ready = true;
      console.log('[IDBStore] Database opened');

      // Migrate from localStorage if needed
      self._migrateFromLocalStorage();

      // Fire ready callbacks
      for (var i = 0; i < self._readyCallbacks.length; i++) {
        self._readyCallbacks[i]();
      }
      self._readyCallbacks = [];
    };

    request.onerror = function(e) {
      console.error('[IDBStore] Failed to open:', e.target.error);
      self._ready = true; // Fall back to localStorage
    };
  },

  onReady: function(cb) {
    if (this._ready) { cb(); }
    else { this._readyCallbacks.push(cb); }
  },

  // ── Migration ─────────────────────────────────────────────────────────────

  _migrateFromLocalStorage: function() {
    if (!this._db) return;

    // Check if already migrated
    try {
      if (localStorage.getItem('tr_idb_migrated') === '1') return;
    } catch(e) { return; }

    var self = this;

    // Migrate runs
    try {
      var raw = localStorage.getItem('tr_runs');
      var runs = raw ? JSON.parse(raw) : [];
      if (runs.length > 0) {
        var tx = this._db.transaction('runs', 'readwrite');
        var store = tx.objectStore('runs');
        var migrated = 0;

        for (var i = 0; i < runs.length; i++) {
          (function(run) {
            var req = store.put(run);
            req.onsuccess = function() { migrated++; };
          })(runs[i]);
        }

        tx.oncomplete = function() {
          console.log('[IDBStore] Migrated ' + migrated + ' runs from localStorage');
          try { localStorage.setItem('tr_idb_migrated', '1'); } catch(e) {}
        };

        tx.onerror = function(e) {
          console.error('[IDBStore] Migration failed:', e.target.error);
        };
      } else {
        try { localStorage.setItem('tr_idb_migrated', '1'); } catch(e) {}
      }
    } catch(e) {
      console.error('[IDBStore] Migration parse error:', e);
    }
  },

  // ── Runs ──────────────────────────────────────────────────────────────────

  saveRun: function(run) {
    run.id = run.id || 'run_' + Date.now();
    run.savedAt = run.savedAt || new Date().toISOString();

    // Always write to localStorage for backward compat (stats.html reads it)
    this._lsSaveRun(run);

    if (!this._db) return run;

    var tx = this._db.transaction('runs', 'readwrite');
    var store = tx.objectStore('runs');
    store.put(run);

    tx.oncomplete = function() {
      console.log('[IDBStore] Run saved:', run.id);
    };
    tx.onerror = function(e) {
      console.error('[IDBStore] Run save failed:', e.target.error);
    };

    return run;
  },

  getRuns: function(callback) {
    // Async — returns via callback: callback(runsArray)
    if (!this._db) {
      callback(this.getRunsSync());
      return;
    }

    var tx = this._db.transaction('runs', 'readonly');
    var store = tx.objectStore('runs');
    var idx = store.index('savedAt');
    var runs = [];

    // Iterate in reverse (newest first) via openCursor with 'prev'
    var request = idx.openCursor(null, 'prev');
    request.onsuccess = function(e) {
      var cursor = e.target.result;
      if (cursor) {
        runs.push(cursor.value);
        cursor.continue();
      } else {
        callback(runs);
      }
    };
    request.onerror = function() {
      callback(this.getRunsSync());
    };
  },

  getRunsSync: function() {
    // Synchronous fallback — reads from localStorage
    try {
      var raw = localStorage.getItem('tr_runs');
      return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
  },

  deleteRun: function(id) {
    // Remove from localStorage
    try {
      var raw = localStorage.getItem('tr_runs');
      var runs = raw ? JSON.parse(raw) : [];
      localStorage.setItem('tr_runs', JSON.stringify(runs.filter(function(r) { return r.id !== id; })));
    } catch(e) {}

    // Remove from IndexedDB
    if (!this._db) return;
    var tx = this._db.transaction('runs', 'readwrite');
    tx.objectStore('runs').delete(id);
  },

  getRunCount: function(callback) {
    if (!this._db) {
      callback(this.getRunsSync().length);
      return;
    }

    var tx = this._db.transaction('runs', 'readonly');
    var req = tx.objectStore('runs').count();
    req.onsuccess = function() { callback(req.result); };
    req.onerror = function() { callback(0); };
  },

  // ── localStorage compat (keeps localStorage in sync for stats.html) ─────

  _lsSaveRun: function(run) {
    try {
      var raw = localStorage.getItem('tr_runs');
      var runs = raw ? JSON.parse(raw) : [];
      runs.unshift(run);
      // Cap at 50 in localStorage (IndexedDB holds unlimited)
      while (runs.length > 50) runs.pop();
      localStorage.setItem('tr_runs', JSON.stringify(runs));
    } catch(e) {
      console.warn('[IDBStore] localStorage write failed:', e);
    }
  },

  // ── Storage stats ─────────────────────────────────────────────────────────

  getStorageInfo: function(callback) {
    var info = {
      idbAvailable: !!this._db,
      lsRunCount: this.getRunsSync().length,
      idbRunCount: 0,
      lsUsedKB: 0,
    };

    // Estimate localStorage usage
    try {
      var total = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf('tr_') === 0) {
          total += localStorage.getItem(key).length;
        }
      }
      info.lsUsedKB = Math.round(total / 1024);
    } catch(e) {}

    if (!this._db) {
      callback(info);
      return;
    }

    this.getRunCount(function(count) {
      info.idbRunCount = count;
      callback(info);
    });
  },
};
