const CACHE_NAME = 'mindwtr-pwa-v2';
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.png', '/logo.png'];
const STATIC_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'manifest', 'worker']);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mindwtr-pwa-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// A cached HTML body under a script/style URL (an SPA fallback for a missing
// hashed chunk) would permanently break that page with "Importing a module
// script failed", so only successful non-HTML responses are cacheable.
function isCacheableAssetResponse(res) {
  if (!res || !res.ok) return false;
  const contentType = res.headers.get('content-type') || '';
  return !contentType.includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations go network-first so a redeploy is picked up on the next load;
  // the cached shell is only an offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => undefined);
          }
          return res;
        })
        .catch(async () => {
          const fallback = (await caches.match('/index.html')) || (await caches.match('/'));
          return fallback || Response.error();
        }),
    );
    return;
  }

  // Only static assets are served from the cache. Everything else (API calls,
  // sync data on same-origin deployments) always goes to the network.
  const isStaticAsset = url.pathname.startsWith('/assets/')
    || STATIC_DESTINATIONS.has(req.destination)
    || PRECACHE_URLS.includes(url.pathname);
  if (!isStaticAsset) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req).then((res) => {
        if (isCacheableAssetResponse(res)) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => undefined);
        }
        return res;
      });
    }),
  );
});
