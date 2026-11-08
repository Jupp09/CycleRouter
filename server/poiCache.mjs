// Datei-Cache für Orte je Kachel und Datenebene (siehe LAYERS in js/poiSource.js):
//   cache/pois/<ebene>/<kachel>.json   z. B. cache/pois/supply/530_88.json, cache/pois/food/530_88.json
// Jede Ebene hat ihre eigene Gültigkeit – eine neue Ebene wird für vorhandene Kacheln nachgeladen, ohne die
// übrigen Ebenen erneut abzufragen. Die Daten ändern sich selten, Overpass ist dagegen oft langsam – deshalb
// lange Gültigkeit und „stale-while-revalidate“: Abgelaufenes wird sofort ausgeliefert und im Hintergrund erneuert.
import { mkdir, readFile, writeFile, rename, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLayersFromOverpass, LAYERS, TILE, tileKey, cacheName } from '../js/poiSource.js';

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

// Overpass erlaubt je Absender nur wenige gleichzeitige Abfragen und sperrt einen Platz nach jeder Abfrage eine
// Weile – parallele Abfragen bremsen sich gegenseitig stark aus. Deshalb:
//   - Abfragen, auf die ein Nutzer wartet (`urgent`), laufen zuerst (bis zu MAX_PARALLEL gleichzeitig).
//   - Hintergrundarbeit (Nachladen, Vorrat) startet nur, solange kein Nutzer wartet, und höchstens eine zugleich.
//   - Braucht ein Nutzer eine Kachel, die als Hintergrundarbeit noch wartet, rückt diese nach vorn (promote).
const MAX_PARALLEL = 2;
const MAX_BACKGROUND = 1;
let running = 0, runningBackground = 0;
let urgentCount = 0; // wartende oder laufende dringende Abfragen
const queue = [];

function next() {
  while (running < MAX_PARALLEL && queue.length) {
    let i = queue.findIndex(t => t.urgent);
    if (i < 0) {
      if (urgentCount > 0 || runningBackground >= MAX_BACKGROUND) return;
      i = 0;
    }
    queue.splice(i, 1)[0].start();
  }
}

/** Abfrage einreihen → {done: Promise, promote()}. */
function schedule(fn, urgent) {
  const task = {
    urgent: false,
    promote() { if (!this.urgent) { this.urgent = true; urgentCount++; next(); } },
  };
  task.done = new Promise((resolve, reject) => {
    task.start = () => {
      const background = !task.urgent; // läuft als Hintergrundarbeit (zählt bis zum Ende so, auch nach promote)
      running++;
      if (background) runningBackground++;
      fn().then(resolve, reject).finally(() => {
        running--;
        if (background) runningBackground--;
        if (task.urgent) urgentCount--;
        next();
      });
    };
  });
  queue.push(task);
  if (urgent) task.promote(); else next();
  return task;
}

const flightKey = (layer, key) => `${layer}/${key}`;
const tasks = new Map(); // `${ebene}/${kachel}` → Abfrage, die sie lädt (für promote)

/**
 * Startet Overpass-Abfragen für Kacheln × Ebenen, die nicht schon geladen werden. Kacheln, denen dieselben
 * Ebenen fehlen, werden zusammengefasst – eine Abfrage für alle ihre Ebenen statt einer je Ebene.
 * `urgent`: ein Nutzer wartet darauf (Vorrang in der Warteschlange).
 */
function startFetch(keys, layers, { log, urgent = false } = {}) {
  // Kachel → fehlende Ebenen, gruppiert nach dieser Kombination
  const groups = new Map();
  for (const k of keys) {
    if (urgent) for (const l of layers) tasks.get(flightKey(l, k))?.promote();
    const need = layers.filter(l => !inflight.has(flightKey(l, k)));
    if (!need.length) continue;
    const sig = need.join(',');
    if (!groups.has(sig)) groups.set(sig, { layers: need, keys: [] });
    groups.get(sig).keys.push(k);
  }
  for (const { layers: need, keys: todo } of groups.values()) {
    for (let i = 0; i < todo.length; i += CHUNK) {
      const chunk = todo.slice(i, i + CHUNK);
      const task = schedule(async () => {
        const t0 = Date.now();
        return [await fetchLayersFromOverpass(chunk, { layers: need, headers: HEADERS }), t0];
      }, urgent);
      const p = task.done.then(async ([byLayer, t0]) => {
        await Promise.all([...byLayer].flatMap(([layer, tiles]) => [...tiles].map(([k, pois]) => writeTile(layer, k, pois))));
        log?.(`Overpass: ${chunk.length} Kacheln (${need.join(', ')}${task.urgent ? '' : ', Hintergrund'}) in ${((Date.now() - t0) / 1000).toFixed(1)} s geladen`);
        return byLayer;
      });
      for (const layer of need) {
        for (const k of chunk) {
          const id = flightKey(layer, k);
          const kp = p.then(byLayer => byLayer.get(layer).get(k));
          inflight.set(id, kp);
          tasks.set(id, task);
          kp.catch(() => {}).finally(() => { inflight.delete(id); tasks.delete(id); });
        }
      }
    }
  }
}

/** Promise je Kachel für eine Ebene (nach startFetch). */
const pending = (keys, layer) => keys.map(k => inflight.get(flightKey(layer, k)));

/** Wartet ein Nutzer gerade auf Overpass? Dann pausiert der Vorrat (warmQueue.mjs). */
export const isBusy = () => urgentCount > 0;

/**
 * Lädt Kacheln (Map ebene → [kachel]) als Hintergrundarbeit von Overpass in den Cache und wartet darauf.
 * Kacheln, denen dieselben Ebenen fehlen, gehen in eine gemeinsame Abfrage.
 */
export async function fetchTiles(byLayer, log) {
  await fetchMissing(byLayer, { log });
}

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
 * Fehlendes wird bei Overpass geladen – je Ebene nur das, was fehlt, mehrere Ebenen derselben Kacheln in einer
 * Abfrage. Mit `cacheOnly` wird auf Fehlendes nicht gewartet: Es wird im Hintergrund geladen und in `missing`
 * gemeldet (fehlt in `tiles`). Nur Anfragen ohne `cacheOnly` haben Vorrang (ein Nutzer wartet darauf).
 */
export async function getTiles(keys, { layers = ['supply'], log, cacheOnly = false } = {}) {
  await migrated;
  const now = Date.now();
  const tiles = Object.fromEntries(keys.map(k => [k, []]));
  const stats = { cached: 0, stale: 0, fetched: 0 };
  const stale = new Map(), missing = new Map(); // ebene → [kachel]

  await Promise.all(layers.map(async layer => {
    stale.set(layer, []); missing.set(layer, []);
    await Promise.all(keys.map(async k => {
      const entry = await readTile(layer, k);
      const age = entry ? now - entry.t : Infinity;
      if (age < MAX_STALE) tiles[k].push(...entry.pois);
      if (age >= MAX_STALE) missing.get(layer).push(k);
      else if (age >= TTL) stale.get(layer).push(k);
      else stats.cached++;
    }));
    stats.stale += stale.get(layer).length;
    stats.fetched += missing.get(layer).length;
  }));

  const only = sel => new Map([...sel].filter(([, ks]) => ks.length));

  // Abgelaufenes: nicht abwarten – der Aufrufer bekommt den alten Stand sofort
  const old = only(stale);
  if (old.size) fetchMissing(old, { log }).catch(e => log?.(`Aktualisierung fehlgeschlagen: ${e.message}`));
  const need = only(missing);
  const notCached = new Set(); // nur bei cacheOnly: Kacheln, bei denen mindestens eine Ebene fehlt
  if (need.size && cacheOnly) {
    // Nicht warten: im Hintergrund laden, der Aufrufer erfährt, was (noch) fehlt
    fetchMissing(need, { log }).catch(e => log?.(`Nachladen fehlgeschlagen: ${e.message}`));
    for (const ks of need.values()) ks.forEach(k => notCached.add(k));
  } else if (need.size) {
    for (const [, k, pois] of await fetchMissing(need, { log, urgent: true })) tiles[k].push(...(pois || []));
  }
  for (const k of notCached) delete tiles[k];
  return { tiles, stats, missing: [...notCached] };
}

/**
 * Fehlende Kacheln je Ebene laden (Map ebene → [kachel]). Kacheln, denen dieselben Ebenen fehlen, gehen in
 * eine gemeinsame Abfrage. → [[ebene, kachel, pois]]
 */
async function fetchMissing(byLayer, opts) {
  // Je Kachel die fehlenden Ebenen sammeln und nach Kombination gruppieren
  const perKey = new Map();
  for (const [layer, ks] of byLayer) for (const k of ks) (perKey.get(k) || perKey.set(k, []).get(k)).push(layer);
  const groups = new Map();
  for (const [k, ls] of perKey) {
    const sig = ls.join(',');
    if (!groups.has(sig)) groups.set(sig, { layers: ls, keys: [] });
    groups.get(sig).keys.push(k);
  }
  for (const g of groups.values()) startFetch(g.keys, g.layers, opts);
  return Promise.all([...byLayer].flatMap(([layer, ks]) => pending(ks, layer).map(async (p, i) => [layer, ks[i], await p])));
}
