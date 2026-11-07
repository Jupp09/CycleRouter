// Server für CycleRouter – liefert die App aus (nur öffentliche Dateien, siehe PUBLIC), egal von wo gestartet.
// Zusätzlich: POST /api/pois – Verpflegungsstellen je Kachel aus dem Datei-Cache (server/poiCache.mjs),
// /api/warm – Vorrat für Heimatregionen, /api/account|settings|routes|shared – Konten (server/accountApi.mjs).
import './server/env.mjs'; // muss der erste Import bleiben (.env laden, bevor andere Module Werte lesen)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTiles } from './server/poiCache.mjs';
import { initWarmQueue, requestWarm, warmStatus, RADIUS_KM } from './server/warmQueue.mjs';
import { isTileKey, isLayer } from './js/poiSource.js';
import { initDb } from './server/db.mjs';
import { handleAccountApi } from './server/accountApi.mjs';
import { clientIp } from './server/auth.mjs';

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
};

const json = (res, status, data) =>
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));

async function readBody(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Anfrage zu groß');
  }
  return body;
}

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
  try {
    const { tiles, stats, missing } = await getTiles([...new Set(keys)], {
      layers: [...new Set(layers)], cacheOnly: cacheOnly === true, log: msg => console.log(msg),
    });
    console.log(`/api/pois [${layers.join(',')}]: ${keys.length} Kacheln (${stats.cached} Cache, ${stats.stale} abgelaufen, `
      + `${stats.fetched} neu) in ${Date.now() - t0} ms`);
    json(res, 200, { tiles, missing });
  } catch (e) {
    console.error('/api/pois:', e.message);
    json(res, 502, { error: e.message });
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
 * Nur diese Dateien/Ordner werden ausgeliefert – alles andere im Projektordner (.env mit Zugangsdaten,
 * server/, node_modules/, cache/, package.json …) bleibt privat.
 */
const PUBLIC = [/^\/index\.html$/, /^\/(js|css|profiles)\/[\w./-]+$/];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (path === '/api/pois') return handlePois(req, res);
  if (path === '/api/warm') return handleWarm(req, res, url);
  if (await handleAccountApi(req, res, url)) return;
  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!PUBLIC.some(re => re.test(path)) || path.includes('..') || !file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
  }
}).listen(PORT, () => {
  console.log(`CycleRouter läuft auf http://localhost:${PORT}`);
  initWarmQueue(msg => console.log(msg));
  initDb(msg => console.log(msg));
});
