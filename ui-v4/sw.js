// ui-v4 service worker KILL SWITCH.
// index.html never registers this file. If an old TrailRunner worker is ever
// picked up on this origin, this worker replaces it, drops all caches and
// unregisters itself so nothing is ever served stale during the redesign.
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll(); })
      .then(function (clients) { clients.forEach(function (c) { c.navigate(c.url); }); })
  );
});
