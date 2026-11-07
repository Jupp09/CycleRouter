// Datei-Cache für Verpflegungsstellen je Kachel (Supermärkte, Tankstellen, Trinkwasser inkl. Öffnungszeiten).
// Die Daten ändern sich selten, Overpass ist dagegen oft langsam – deshalb lange Gültigkeit und
// „stale-while-revalidate“: Abgelaufene Kacheln werden sofort ausgeliefert und im Hintergrund erneuert.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTilesFromOverpass } from '../js/poiSource.js';

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

/** Startet Overpass-Abfragen für Kacheln, die nicht schon geladen werden. */
function startFetch(keys, log) {
  const todo = keys.filter(k => !inflight.has(k));
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const t0 = Date.now();
    const p = fetchTilesFromOverpass(chunk, { headers: HEADERS }).then(async tiles => {
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
