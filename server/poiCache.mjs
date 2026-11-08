// Datei-Cache für Orte je Kachel und Datenebene (siehe LAYERS in js/poiSource.js):
//   cache/pois/<ebene>/<kachel>.json   z. B. cache/pois/supply/530_88.json, cache/pois/food/530_88.json
// Jede Ebene hat ihre eigene Gültigkeit – eine neue Ebene wird für vorhandene Kacheln nachgeladen, ohne die
// übrigen Ebenen erneut abzufragen. Die Daten ändern sich selten, Overpass ist dagegen oft langsam – deshalb
// lange Gültigkeit und „stale-while-revalidate“: Abgelaufenes wird sofort ausgeliefert und im Hintergrund erneuert.
import { mkdir, readFile, writeFile, rename, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTilesFromOverpass, LAYERS, TILE, tileKey, cacheName } from '../js/poiSource.js';

const DIR = fileURLToPath(new URL('../cache/pois/', import.meta.url));
const DAY = 24 * 3600 * 1000;
/** Danach wird eine Kachel im Hintergrund erneuert (Standard 30 Tage, per POI_TTL_DAYS änderbar). */
export const TTL = (Number(process.env.POI_TTL_DAYS) || 30) * DAY;
/** Noch ältere Kacheln werden nicht mehr ausgeliefert, sondern neu geladen. */
const MAX_STALE = 365 * DAY;
/** Kacheln je Overpass-Abfrage – größere Abfragen brechen bei Last eher ab. */
const CHUNK = 40;
// Overpass lehnt Anfragen ohne aussagekräftigen User-Agent ab (406)
const HEADERS = { 'User-Agent': 'CycloRouter/1.0 (+https://github.com/Jupp09/CycleRouter)' };
export const ALL_LAYERS = Object.keys(LAYERS);

const inflight = new Map(); // `${ebene}/${kachel}` → Promise<pois>

// Ordner je Ebene (mit Cache-Version, z. B. „stay.v2“ – ältere Stände ohne nötige Angaben werden neu geladen)
const file = (layer, key) => join(DIR, cacheName(layer), `${key}.json`);

// Kacheln aus der Zeit vor den Ebenen (cache/pois/<kachel>.json) enthalten die Versorgungs-Ebene →
// einmalig nach cache/pois/supply/ verschieben, damit sie nicht neu geladen werden müssen.
const migrated = (async () => {
  let files;
  try { files = (await readdir(DIR)).filter(f => f.endsWith('.json')); } catch { return; }
  if (!files.length) return;
  await mkdir(join(DIR, 'supply'), { recursive: true });
  await Promise.all(files.map(f => rename(join(DIR, f), join(DIR, 'supply', f)).catch(() => {})));
  console.log(`Cache: ${files.length} vorhandene Kacheln als Ebene „supply“ übernommen`);
})();

async function readTile(layer, key) {
  try { return JSON.parse(await readFile(file(layer, key), 'utf8')); } catch { return null; }
}

async function writeTile(layer, key, pois) {
  await mkdir(join(DIR, cacheName(layer)), { recursive: true });
  const tmp = file(layer, key) + '.tmp';
  await writeFile(tmp, JSON.stringify({ t: Date.now(), pois }));
  await rename(tmp, file(layer, key)); // atomar, damit parallele Leser keine halbe Datei sehen
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

/** Startet Overpass-Abfragen einer Ebene für Kacheln, die nicht schon geladen werden. */
function startFetch(keys, layer, log) {
  const todo = keys.filter(k => !inflight.has(`${layer}/${k}`));
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const p = limited(async () => {
      const t0 = Date.now();
      return [await fetchTilesFromOverpass(chunk, { layer, headers: HEADERS }), t0];
    }).then(async ([tiles, t0]) => {
      await Promise.all([...tiles].map(([k, pois]) => writeTile(layer, k, pois)));
      log?.(`Overpass: ${chunk.length} Kacheln (${layer}) in ${((Date.now() - t0) / 1000).toFixed(1)} s geladen`);
      return tiles;
    });
    for (const k of chunk) {
      const kp = p.then(tiles => tiles.get(k));
      inflight.set(`${layer}/${k}`, kp);
      kp.catch(() => {}).finally(() => inflight.delete(`${layer}/${k}`));
    }
  }
  return keys.map(k => inflight.get(`${layer}/${k}`));
}

/** Laufen gerade Overpass-Abfragen (z. B. für Routen von Nutzern)? */
export const isBusy = () => inflight.size > 0;

/** Lädt Kacheln einer Ebene von Overpass in den Cache und wartet darauf. */
export const fetchTiles = (keys, layer, log) => Promise.all(startFetch(keys, layer, log));

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

/** Kacheln, deren Ebene fehlt oder abgelaufen ist (nur Dateizeitstempel – schnell auch für tausende Kacheln). */
export async function tilesNeedingFetch(keys, layer) {
  await migrated;
  const now = Date.now();
  const need = await Promise.all(keys.map(async k => {
    try { return now - (await stat(file(layer, k))).mtimeMs >= TTL; } catch { return true; }
  }));
  return keys.filter((_, i) => need[i]);
}

/**
 * Liefert {tiles: {key: pois}, stats, missing} – die Orte aller angefragten Ebenen je Kachel zusammengeführt.
 * Frisches und Abgelaufenes kommt sofort aus dem Cache (Abgelaufenes wird im Hintergrund erneuert),
 * Fehlendes wird bei Overpass geladen – je Ebene nur das, was fehlt. Mit `cacheOnly` wird auf Fehlendes
 * nicht gewartet: Es wird im Hintergrund geladen und in `missing` gemeldet (fehlt in `tiles`).
 */
export async function getTiles(keys, { layers = ['supply'], log, cacheOnly = false } = {}) {
  await migrated;
  const now = Date.now();
  const tiles = Object.fromEntries(keys.map(k => [k, []]));
  const stats = { cached: 0, stale: 0, fetched: 0 };
  const notCached = new Set(); // nur bei cacheOnly: Kacheln, bei denen mindestens eine Ebene fehlt

  await Promise.all(layers.map(async layer => {
    const stale = [], missing = [];
    await Promise.all(keys.map(async k => {
      const entry = await readTile(layer, k);
      const age = entry ? now - entry.t : Infinity;
      if (age < MAX_STALE) tiles[k].push(...entry.pois);
      if (age >= MAX_STALE) missing.push(k);
      else if (age >= TTL) stale.push(k);
      else stats.cached++;
    }));
    stats.stale += stale.length;
    stats.fetched += missing.length;

    if (stale.length) {
      // Nicht abwarten – der Aufrufer bekommt den alten Stand sofort
      Promise.all(startFetch(stale, layer, log)).catch(e => log?.(`Aktualisierung fehlgeschlagen: ${e.message}`));
    }
    if (missing.length && cacheOnly) {
      // Nicht warten: im Hintergrund laden, der Aufrufer erfährt, was (noch) fehlt
      Promise.all(startFetch(missing, layer, log)).catch(e => log?.(`Nachladen fehlgeschlagen: ${e.message}`));
      missing.forEach(k => notCached.add(k));
    } else if (missing.length) {
      const results = await Promise.all(startFetch(missing, layer, log));
      missing.forEach((k, i) => tiles[k].push(...(results[i] || [])));
    }
  }));
  for (const k of notCached) delete tiles[k];
  return { tiles, stats, missing: [...notCached] };
}
