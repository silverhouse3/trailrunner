// Service Worker — caches all static assets for offline use on the treadmill
const CACHE = 'trailrunner-v53';
const ASSETS = [
  './',
  'index.html',
  'remote.html',
  'boot-selector.html',
  'strava-callback.html',
  'stats.html',
  'css/app.css',
  'js/gpx.js',
  'js/storage.js',
  'js/idb-store.js',
  'js/treadmill.js',
  'js/engine.js',
  'js/map.js',
  'js/ui.js',
  'js/media.js',
  'js/sync.js',
  'js/trackview.js',
  'js/workout-segments.js',
  'js/oval-track.js',
  'js/fun-facts.js',
  'js/voice.js',
  'js/voice-commands.js',
  'js/cadence.js',
  'js/streaks.js',
  'js/workout-builder.js',
  'js/settings-panel.js',
  'js/app.js',
  'manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network first for HTML (might update), cache first for everything else
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});
