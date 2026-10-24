// Keep this at /sw.js: existing installations must receive the replacement.
// No fetch handler: navigation and authentication belong to the browser.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', (event) => {
  if (event.data === 'mindwtr-service-worker-mode') {
    event.source?.postMessage('mindwtr-service-worker-online-only');
  }
});
