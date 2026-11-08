// Server für CycloRouter – liefert die App aus (nur öffentliche Dateien, siehe PUBLIC), egal von wo gestartet.
// Zusätzlich: POST /api/pois – Verpflegungsstellen je Kachel aus dem Datei-Cache (server/poiCache.mjs),
// /api/warm – Vorrat für Heimatregionen, /api/warm-route – Vorrat entlang einer Route,
// /api/account|settings|routes|shared – Konten (server/accountApi.mjs).
import './server/env.mjs'; // muss der erste Import bleiben (.env laden, bevor andere Module Werte lesen)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTiles } from './server/poiCache.mjs';
import { initWarmQueue, requestWarm, requestRouteWarm, warmStatus, RADIUS_KM } from './server/warmQueue.mjs';
import { isTileKey, isLayer } from './js/poiSource.js';
import { initDb } from './server/db.mjs';
import { handleAccountApi } from './server/accountApi.mjs';
import { clientIp } from './server/auth.mjs';
import { sendJson as json, readBody } from './server/http.mjs';
import { initExtract } from './server/extract.mjs';
import { setSecurityHeaders, contentSecurityPolicy } from './server/security.mjs';
import { createLimiter } from './server/rateLimit.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.brf': 'text/plain; charset=utf-8',
};

/**
 * Overpass-Kontingent je IP: Kacheln × Ebenen, die der Server für einen Nutzer neu bei Overpass laden darf.
 * Ohne Grenze könnte jemand den Server in Dauerschleife Overpass abfragen lassen – Overpass sperrt dann
 * die Server-IP, und die Suche fällt für alle aus. Eine lange Mehrtagestour braucht ~1500, das Kontingent
 * reicht also für normale Nutzung bequem. Aus dem Cache ist alles unbegrenzt.
 * Ist es aufgebraucht, antwortet der Server mit 429 und der Browser lädt selbst von Overpass (poiTiles.js).
 */
const overpassBudget = createLimiter({ windowMs: 60 * 60 * 1000, max: 5000 });

/**
 * Verpflegungsstellen je Kachel und Datenebene: POST {tiles: [Kachelschlüssel], layers?, cacheOnly?}
 * → {tiles, missing}. `cacheOnly`: nur Vorhandenes liefern, fehlende Kacheln im Hintergrund laden.
 */
async function handlePois(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Nur POST' });
  let keys, layers, cacheOnly;
  try {
    ({ tiles: keys, layers = ['supply'], cacheOnly = false } = JSON.parse(await readBody(req)));
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  if (!Array.isArray(keys) || !keys.length || keys.length > 1000 || !keys.every(isTileKey)) {
    return json(res, 400, { error: 'Ungültige Kachelliste' });
  }
  if (!Array.isArray(layers) || !layers.length || !layers.every(isLayer)) {
    return json(res, 400, { error: 'Ungültige Datenebene' });
  }
  const t0 = Date.now();
  const ip = clientIp(req);
  try {
    const result = await getTiles([...new Set(keys)], {
      layers: [...new Set(layers)], cacheOnly: cacheOnly === true, log: msg => console.log(msg),
      allowFetch: n => overpassBudget.fits(ip, n) && (overpassBudget.add(ip, n), true),
    });
    if (result.limited) {
      console.log(`/api/pois [${layers.join(',')}]: Overpass-Kontingent für einen Nutzer erschöpft (${result.limited} Kacheln fehlen)`);
      return json(res, 429, { error: 'Zu viele neue Kacheln – bitte direkt bei Overpass laden.' }, { 'Retry-After': '3600' });
    }
    const { tiles, stats, missing } = result;
    console.log(`/api/pois [${layers.join(',')}]: ${keys.length} Kacheln (${stats.cached} Cache, ${stats.stale} abgelaufen, `
      + `${stats.fetched} neu) in ${Date.now() - t0} ms`);
    json(res, 200, { tiles, missing });
  } catch (e) {
    // Details nur ins Log – die Antwort verrät keine Interna (Overpass-Adressen, Pfade …)
    console.error('/api/pois:', e.message);
    json(res, 502, { error: 'Verpflegungsdaten sind gerade nicht abrufbar.' });
  }
}

const validPoint = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;

/**
 * Vorrat für die Heimatregion (Umkreis RADIUS_KM).
 * POST {lat, lon} merkt die Region vor, GET ?lat=&lon= liefert den Fortschritt.
 * Der Client schickt nur gerundete Koordinaten; geloggt wird nichts Genaueres als der Kachelmittelpunkt.
 */
async function handleWarm(req, res, url) {
  try {
    if (req.method === 'GET') {
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      if (!validPoint(lat, lon)) return json(res, 400, { error: 'Ungültige Koordinaten' });
      return json(res, 200, { radiusKm: RADIUS_KM, ...await warmStatus(lat, lon) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Nur GET oder POST' });
    const { lat, lon } = JSON.parse(await readBody(req, 1024));
    if (!validPoint(lat, lon)) return json(res, 400, { error: 'Ungültige Koordinaten' });
    json(res, 200, { radiusKm: RADIUS_KM, ...await requestWarm(lat, lon, clientIp(req)) });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

/**
 * Vorrat entlang einer Route: POST {tiles: [Kachelschlüssel]} – der Server lädt alle Datenebenen dieser Kacheln
 * im Hintergrund in den gemeinsamen Cache. Die Kacheln (0,1°) sind dieselben, die auch /api/pois erhält.
 */
async function handleWarmRoute(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Nur POST' });
  try {
    const { tiles } = JSON.parse(await readBody(req, 32 * 1024));
    if (!Array.isArray(tiles) || !tiles.length || tiles.length > 1000 || !tiles.every(isTileKey)) {
      return json(res, 400, { error: 'Ungültige Kachelliste' });
    }
    json(res, 200, await requestRouteWarm(tiles, clientIp(req)));
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

/**
 * Nur diese Dateien/Ordner werden ausgeliefert – alles andere im Projektordner (.env mit Zugangsdaten,
 * server/, node_modules/, cache/, package.json …) bleibt privat.
 */
// Bilder liegen unter assets/ statt icons/: Apache leitet /icons/ auf seine eigenen Symbole um (z. B. bei Plesk)
const PUBLIC = [/^\/index\.html$/, /^\/manifest\.webmanifest$/, /^\/(js|css|profiles|assets)\/[\w./-]+$/];

createServer(async (req, res) => {
  setSecurityHeaders(req, res);
  const url = new URL(req.url, 'http://localhost');
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (path === '/api/pois') return handlePois(req, res);
  if (path === '/api/warm') return handleWarm(req, res, url);
  if (path === '/api/warm-route') return handleWarmRoute(req, res);
  if (await handleAccountApi(req, res, url)) return;
  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!PUBLIC.some(re => re.test(path)) || path.includes('..') || !file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
    return;
  }
  try {
    const body = await readFile(file);
    if (extname(file) === '.html') res.setHeader('Content-Security-Policy', contentSecurityPolicy(body.toString('utf8'), req));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
  }
}).listen(PORT, () => {
  console.log(`CycloRouter läuft auf http://localhost:${PORT}`);
  // Erst den Datenauszug einlesen – sonst lädt der Vorrat Kacheln, die der Auszug schon hat
  initExtract(msg => console.log(msg))
    .catch(e => console.warn(`Datenauszug: ${e.message}`))
    .finally(() => initWarmQueue(msg => console.log(msg)));
  initDb(msg => console.log(msg));
});
