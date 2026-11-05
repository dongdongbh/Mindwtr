

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
