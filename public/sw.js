const CACHE_NAME = 'best-public-shell-v1';
const SHELL_FILES = [
  '/index.html',
  '/manifest.webmanifest',
  '/icons/best-192.png',
  '/icons/best-512.png',
  '/icons/best-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('best-public-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const shell = await caches.open(CACHE_NAME);
        const fallback = await shell.match('/index.html');
        if (fallback) return fallback;
        throw new Error('Best offline shell is not available in the cache.');
      })
    );
    return;
  }

  const publicAsset =
    (url.pathname.startsWith('/_expo/static/') &&
      /\.(?:js|css|ttf|otf|woff2?)$/i.test(url.pathname)) ||
    (url.pathname.startsWith('/icons/') &&
      /\.(?:png|svg|webp|jpe?g)$/i.test(url.pathname));
  if (!publicAsset) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
      }
      return response;
    })
  );
});
