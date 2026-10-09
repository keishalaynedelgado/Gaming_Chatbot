// The iPhone & iPad app's service worker (see templates/web/index.html): makes
// the installed game run with no connection. The first launch saves the app
// -- its page, which has the whole game inlined, plus manifest and icons --
// on the device; every launch after that opens the saved copy straight
// away, without waiting for (or needing) this server. When the server is
// reachable, the newest version is fetched in the background for the next
// launch, so an improved game still arrives. (Service workers only run over
// https or on localhost; a tunnel's https address is fine.)
const CACHE = 'askvi-play-v2';
const APP = ['./', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

// Fetches one of the app's files and saves it. The header skips the free
// ngrok tunnel's "you are about to visit" page, which would otherwise be
// saved in place of the game.
async function refresh(cache, url) {
  const response = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, cache: 'no-store' });
  if (!response.ok) return null;
  await cache.put(url, response.clone());
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => Promise.all(APP.map((file) => refresh(cache, new URL(file, self.registration.scope).href))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n.startsWith('askvi-play') && n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const saved = await cache.match(request, { ignoreSearch: true });
    const update = refresh(cache, request.url).catch(() => null);
    if (saved) {
      event.waitUntil(update); // for the next launch
      return saved;
    }
    return (await update) || fetch(request);
  }));
});
