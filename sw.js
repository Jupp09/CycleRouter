// Service Worker: Die App startet auch ohne Netz – mit dem zuletzt geladenen Stand ihrer Dateien.
//
// - App-Dateien (Seite, Manifest, js/, css/, assets/, profiles/): zuerst das Netz. So wirkt ein Update wie
//   bisher sofort (der Server liefert mit `no-cache` + ETag). Nur wenn das Netz fehlt oder nach 3 s nicht
//   geantwortet hat, kommt der gemerkte Stand.
// - Leaflet von cdnjs: gemerkter Stand zuerst – die Adresse enthält die Version und ändert sich nie.
// - Alles andere (/api/…, Kartenkacheln, Routing, Ortssuche, Wetter) bleibt unberührt: Diese Antworten sind
//   persönlich, groß oder ohne Netz ohnehin wertlos.
//
// Bewusst klein gehalten: Ein fehlerhafter Service Worker bliebe bei Nutzern hängen, bis der Browser eine neue
// Fassung holt. Eine neue Fassung übernimmt deshalb sofort (skipWaiting + clients.claim).

const CACHE = 'cyclorouter-v1';
const SHELL = /^\/(index\.html|manifest\.webmanifest)?$|^\/(js|css|assets|profiles)\//;
const CDN = 'https://cdnjs.cloudflare.com/';
const TIMEOUT = 3000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

const isShell = url => url.origin === self.location.origin && SHELL.test(url.pathname);
/** Unter welchem Schlüssel eine Antwort gemerkt wird: Seitenaufrufe immer als „/“ (auch mit ?route=…). */
const keyOf = request => (request.mode === 'navigate' ? '/' : request);

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (isShell(url)) event.respondWith(networkFirst(request));
  else if (request.url.startsWith(CDN)) event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const key = keyOf(request);
  const network = fetch(request).then(response => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  });
  const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('Zeitlimit')), TIMEOUT));
  try {
    return await Promise.race([network, slow]);
  } catch {
    // Kein Netz oder zu langsam: gemerkter Stand – fehlt er, bleibt nur das Warten auf das Netz
    return await cache.match(key) || network;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// Erster Besuch: Die Seite hat ihre Dateien geladen, bevor dieser Service Worker zuständig war. Sie schickt
// deshalb einmal die Liste (js/main.js), damit schon der nächste Start ohne Netz gelingt.
self.addEventListener('message', event => {
  if (event.data?.type !== 'precache' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const href of event.data.urls.slice(0, 300)) {
      try {
        const url = new URL(href);
        const own = isShell(url);
        if (!own && !href.startsWith(CDN)) continue;
        const key = own && (url.pathname === '/' || url.pathname === '/index.html') ? '/' : href;
        if (await cache.match(key)) continue;
        // Fremde Dateien (Leaflet) mit CORS holen – die Seite prüft sie per SRI und braucht eine lesbare Antwort
        const response = await fetch(own ? href : new Request(href, { mode: 'cors', credentials: 'omit' }));
        if (response.ok) await cache.put(key, response);
      } catch { /* eine fehlende Datei darf die übrigen nicht aufhalten */ }
    }
  })());
});
