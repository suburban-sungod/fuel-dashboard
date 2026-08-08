// Cache the app shell so it opens with no signal. Data is never cached here —
// store.js owns that, in localStorage, so a stale shell can't serve stale numbers.

const CACHE = 'fuel-shell-v2';
const SHELL = ['./', './index.html', './styles.css', './app.js', './fuel.js', './store.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // never touch api.github.com
  // Network-first, and `no-cache` so it revalidates with the server on every request
  // rather than trusting GitHub Pages' 10-minute max-age. Unchanged files come back as
  // a 304 costing a few bytes; a pushed change lands immediately instead of up to ten
  // minutes later, which otherwise reads as "the fix didn't deploy".
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
