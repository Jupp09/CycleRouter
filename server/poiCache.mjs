// Datei-Cache für Verpflegungsstellen je Kachel (Supermärkte, Tankstellen, Trinkwasser inkl. Öffnungszeiten).
// Die Daten ändern sich selten, Overpass ist dagegen oft langsam – deshalb lange Gültigkeit und
// „stale-while-revalidate“: Abgelaufene Kacheln werden sofort ausgeliefert und im Hintergrund erneuert.
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTilesFromOverpass, TILE, tileKey } from '../js/poiSource.js';

const DIR = fileURLToPath(new URL('../cache/pois/', import.meta.url));
const DAY = 24 * 3600 * 1000;
/** Danach wird eine Kachel im Hintergrund erneuert (Standard 30 Tage, per POI_TTL_DAYS änderbar). */
export const TTL = (Number(process.env.POI_TTL_DAYS) || 30) * DAY;
/** Noch ältere Kacheln werden nicht mehr ausgeliefert, sondern neu geladen. */
const MAX_STALE = 365 * DAY;
/** Kacheln je Overpass-Abfrage – größere Abfragen brechen bei Last eher ab. */
const CHUNK = 40;
// Overpass lehnt Anfragen ohne aussagekräftigen User-Agent ab (406)
const HEADERS = { 'User-Agent': 'CycleRouter/1.0 (+https://github.com/Jupp09/CycleRouter)' };

const inflight = new Map(); // key → Promise<pois>

const file = key => join(DIR, `${key}.json`);

async function readTile(key) {
  try { return JSON.parse(await readFile(file(key), 'utf8')); } catch { return null; }
}

async function writeTile(key, pois) {
  await mkdir(DIR, { recursive: true });
  const tmp = file(key) + '.tmp';
  await writeFile(tmp, JSON.stringify({ t: Date.now(), pois }));
  await rename(tmp, file(key)); // atomar, damit parallele Leser keine halbe Datei sehen
}

// Overpass erlaubt je Absender nur wenige gleichzeitige Abfragen – mehr führt zu Ablehnungen (429)
const MAX_PARALLEL = 2;
let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_PARALLEL) await new Promise(r => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/** Startet Overpass-Abfragen für Kacheln, die nicht schon geladen werden. */
function startFetch(keys, log) {
  const todo = keys.filter(k => !inflight.has(k));
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const p = limited(async () => {
      const t0 = Date.now();
      return [await fetchTilesFromOverpass(chunk, { headers: HEADERS }), t0];
    }).then(async ([tiles, t0]) => {
      await Promise.all([...tiles].map(([k, pois]) => writeTile(k, pois)));
      log?.(`Overpass: ${chunk.length} Kacheln in ${((Date.now() - t0) / 1000).toFixed(1)} s geladen`);
      return tiles;
    });
    for (const k of chunk) {
      const kp = p.then(tiles => tiles.get(k));
      inflight.set(k, kp);
      kp.catch(() => {}).finally(() => inflight.delete(k));
    }
  }
  return keys.map(k => inflight.get(k));
}

/** Laufen gerade Overpass-Abfragen (z. B. für Routen von Nutzern)? */
export const isBusy = () => inflight.size > 0;

/** Lädt Kacheln von Overpass in den Cache und wartet darauf. */
export const fetchTiles = (keys, log) => Promise.all(startFetch(keys, log));

/** Kacheln im Umkreis, sortiert nach Entfernung vom Mittelpunkt (nahe zuerst). */
export function tilesAround(lat, lon, radiusKm) {
  const cos = Math.cos(lat * Math.PI / 180);
  const dLat = radiusKm / 111 + TILE, dLon = radiusKm / (111 * cos) + TILE;
  const dist = new Map();
  for (let a = lat - dLat; a <= lat + dLat; a += TILE / 2) {
    for (let o = lon - dLon; o <= lon + dLon; o += TILE / 2) {
      const km = Math.hypot((a - lat) * 111, (o - lon) * 111 * cos);
      const k = tileKey(a, o);
      if (km <= radiusKm + 8 && !(dist.get(k) <= km)) dist.set(k, km);
    }
  }
  return [...dist].sort((x, y) => x[1] - y[1]).map(([k]) => k);
}

/** Kacheln, die fehlen oder abgelaufen sind (nur Dateizeitstempel – schnell auch für tausende Kacheln). */
export async function tilesNeedingFetch(keys) {
  const now = Date.now();
  const need = await Promise.all(keys.map(async k => {
    try { return now - (await stat(file(k))).mtimeMs >= TTL; } catch { return true; }
  }));
  return keys.filter((_, i) => need[i]);
}

/**
 * Liefert {tiles: {key: pois}, stats}. Frische und abgelaufene Kacheln kommen sofort aus dem Cache
 * (abgelaufene werden im Hintergrund erneuert), fehlende werden bei Overpass geladen.
 */
export async function getTiles(keys, { log } = {}) {
  const now = Date.now();
  const tiles = {};
  const stale = [], missing = [];
  await Promise.all(keys.map(async k => {
    const entry = await readTile(k);
    const age = entry ? now - entry.t : Infinity;
    if (age < MAX_STALE) tiles[k] = entry.pois;
    if (age >= MAX_STALE) missing.push(k);
    else if (age >= TTL) stale.push(k);
  }));

  if (stale.length) {
    // Nicht abwarten – der Aufrufer bekommt den alten Stand sofort
    Promise.all(startFetch(stale, log)).catch(e => log?.(`Aktualisierung fehlgeschlagen: ${e.message}`));
  }
  if (missing.length) {
    const results = await Promise.all(startFetch(missing, log));
    missing.forEach((k, i) => { tiles[k] = results[i] || []; });
  }
  return { tiles, stats: { cached: keys.length - missing.length - stale.length, stale: stale.length, fetched: missing.length } };
}
