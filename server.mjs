// Minimaler Server für CycleRouter – liefert immer diesen Ordner aus, egal von wo gestartet.
// Zusätzlich: POST /api/pois – Verpflegungsstellen je Kachel aus dem Datei-Cache (server/poiCache.mjs).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTiles } from './server/poiCache.mjs';
import { isTileKey } from './js/poiSource.js';

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
  let keys;
  try {
    keys = JSON.parse(await readBody(req)).tiles;
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  if (!Array.isArray(keys) || !keys.length || keys.length > 1000 || !keys.every(isTileKey)) {
    return json(res, 400, { error: 'Ungültige Kachelliste' });
  }
  const t0 = Date.now();
  try {
    const { tiles, stats } = await getTiles([...new Set(keys)], { log: msg => console.log(msg) });
    console.log(`/api/pois: ${keys.length} Kacheln (${stats.cached} Cache, ${stats.stale} abgelaufen, `
      + `${stats.fetched} neu) in ${Date.now() - t0} ms`);
    json(res, 200, { tiles });
  } catch (e) {
    console.error('/api/pois:', e.message);
    json(res, 502, { error: e.message });
  }
}

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path === '/api/pois') return handlePois(req, res);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) || file.startsWith(join(ROOT, 'cache'))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
  }
}).listen(PORT, () => console.log(`CycleRouter läuft auf http://localhost:${PORT}`));
