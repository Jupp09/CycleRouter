/**
 * Orte (Verpflegung, Gastronomie, Unterkünfte) für eine Route oder einzelne Punkte laden – kachelweise und
 * gecacht. Reihenfolge der Quellen je Kachel und Datenebene:
 *
 *   1. Speicher bzw. IndexedDB im Browser (7 Tage)
 *   2. Server-Cache über POST /api/pois (server.mjs, 30 Tage) – fehlt der Server, wird er übersprungen
 *   3. Overpass direkt aus dem Browser, in Paketen zu 40 Kacheln
 *
 * Hintergrund: Die öffentlichen Overpass-Server haben oft lange Warteschlangen (auch kleine Abfragen
 * dauern dann 30 s). Deshalb wird nur abgefragt, was in keinem Cache liegt.
 */
import { sampleRoute } from './utils.js';
import { tileKey, fetchTilesFromOverpass, cacheName } from './poiSource.js';

const TILE_TTL = 7 * 24 * 3600 * 1000;
const OVERPASS_CHUNK = 40;
const memTiles = new Map(); // `${cacheName(ebene)}/${kachel}` → {t, pois}
const cacheKey = (layer, key) => `${cacheName(layer)}/${key}`;

// ---------- Kacheln ----------

/** Kacheln, die Punkte samt Rand (`m` Grad) berühren. */
function tilesNear(points, m) {
  const keys = new Set();
  for (const p of points) {
    for (const dLat of [-m, 0, m]) for (const dLon of [-m, 0, m]) keys.add(tileKey(p.lat + dLat, p.lon + dLon));
  }
  return [...keys];
}

/** Alle Kacheln, die die Route samt ~1 km Rand berührt. */
const routeTiles = r => tilesNear(sampleRoute(r, 250), 0.012);

// ---------- Browser-Cache (Speicher + IndexedDB) ----------

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('cyclerouter', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('poiTiles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null); // z. B. privater Modus → nur Speicher-Cache
  return dbPromise;
}

/** Gecachte Kacheln einer Ebene → Map key → pois (nur frische). */
async function loadTiles(keys, layer) {
  const now = Date.now();
  const out = new Map();
  const fresh = e => e && now - e.t < TILE_TTL;
  const missing = keys.filter(k => {
    const e = memTiles.get(cacheKey(layer, k));
    if (fresh(e)) out.set(k, e.pois);
    return !fresh(e);
  });
  const d = await db();
  if (!d || !missing.length) return out;
  const get = (store, id) => new Promise(resolve => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  try {
    const store = d.transaction('poiTiles').objectStore('poiTiles');
    await Promise.all(missing.map(async k => {
      // Einträge aus der Zeit vor den Ebenen (Schlüssel ohne Präfix) enthalten die Versorgungs-Ebene
      const entry = await get(store, cacheKey(layer, k)) ?? (layer === 'supply' ? await get(store, k) : null);
      if (fresh(entry)) { memTiles.set(cacheKey(layer, k), entry); out.set(k, entry.pois); }
    }));
  } catch { /* Cache ist optional */ }
  return out;
}

async function saveTiles(entries, layer) {
  const t = Date.now();
  for (const [k, pois] of entries) memTiles.set(cacheKey(layer, k), { t, pois });
  const d = await db();
  if (!d) return;
  try {
    const store = d.transaction('poiTiles', 'readwrite').objectStore('poiTiles');
    for (const [k, pois] of entries) store.put({ t, pois }, cacheKey(layer, k));
  } catch { /* Cache ist optional */ }
}

/** Alle Orte, die in dieser Sitzung geladen wurden (z. B. für typische Öffnungszeiten von Ketten). */
export const sessionPois = () => [...memTiles.values()].flatMap(e => e.pois);

// ---------- Server-Cache (server.mjs) ----------

const SERVER_API = new URL('../api/pois', import.meta.url);
let serverAvailable = true; // wird false, wenn die App statisch (ohne server.mjs) ausgeliefert wird

/**
 * Kacheln einer Ebene über den Server laden → Map, oder null, wenn kein Server-Cache verfügbar ist.
 * `cacheOnly`: nur, was der Server schon hat (Fehlendes lädt er im Hintergrund nach; es fehlt in der Map).
 */
async function fetchTilesFromServer(keys, layer, signal, cacheOnly = false) {
  if (!serverAvailable) return null;
  let res;
  try {
    res = await fetch(SERVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiles: keys, layers: [layer], cacheOnly }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    serverAvailable = false;
    return null;
  }
  if (res.status === 404 || res.status === 405 || !res.headers.get('content-type')?.includes('json')) {
    serverAvailable = false;
    return null;
  }
  const data = await res.json();
  // Älterer Server, der diese Datenebene noch nicht kennt (z. B. nicht neu gestartet) → direkt bei Overpass laden
  if (res.status === 400 && /Datenebene/i.test(data.error || '')) {
    console.warn(`Server kennt die Ebene „${layer}“ nicht – lade direkt von Overpass (Server neu starten!)`);
    return null;
  }
  // Overpass-Kontingent dieses Nutzers auf dem Server erschöpft (server.mjs) → selbst bei Overpass laden;
  // der Cache des Servers bleibt für alles andere nutzbar
  if (res.status === 429) return null;
  if (!res.ok) throw new Error(data.error || `Server-Fehler ${res.status}`);
  return new Map(Object.entries(data.tiles));
}

// ---------- Laden ----------

/** Direkt bei Overpass laden – in Paketen, große Abfragen brechen bei Last ab. */
async function overpassTiles(keys, layer, signal) {
  const fetched = new Map();
  for (let i = 0; i < keys.length; i += OVERPASS_CHUNK) {
    const chunk = keys.slice(i, i + OVERPASS_CHUNK);
    for (const [k, pois] of await fetchTilesFromOverpass(chunk, { layer, signal })) fetched.set(k, pois);
  }
  return fetched;
}

const backgroundLoads = new Set(); // `${ebene}/${kachel}`, die ohne Server gerade im Hintergrund geladen werden

/**
 * Ohne Server-Cache (statisches Hosting) fehlende Kacheln im Hintergrund selbst bei Overpass laden – wie es
 * sonst der Server bei `cacheOnly` tut. Beim nächsten Mal liegen sie im Browser-Cache.
 */
function loadInBackground(keys, layer) {
  const todo = keys.filter(k => !backgroundLoads.has(cacheKey(layer, k)));
  if (!todo.length) return;
  todo.forEach(k => backgroundLoads.add(cacheKey(layer, k)));
  overpassTiles(todo, layer)
    .then(fetched => saveTiles(fetched, layer))
    .catch(e => console.warn(`Nachladen im Hintergrund (${layer}) fehlgeschlagen:`, e.message))
    .finally(() => todo.forEach(k => backgroundLoads.delete(cacheKey(layer, k))));
}

/**
 * Orte einer Ebene in den Kacheln – Browser-Cache, sonst Server-Cache, sonst direkt Overpass.
 * `cacheOnly`: nie auf Overpass warten → {pois, complete: false}, wenn Kacheln (noch) fehlen; sie werden
 * im Hintergrund nachgeladen (vom Server bzw. ohne Server vom Browser).
 */
async function layerPois(keys, layer, signal, cacheOnly) {
  const cached = await loadTiles(keys, layer);
  const missing = keys.filter(k => !cached.has(k));
  if (missing.length) {
    let fetched = await fetchTilesFromServer(missing, layer, signal, cacheOnly);
    if (!fetched && cacheOnly) loadInBackground(missing, layer);
    else if (!fetched) fetched = await overpassTiles(missing, layer, signal);
    if (fetched) {
      await saveTiles(fetched, layer);
      for (const [k, pois] of fetched) cached.set(k, pois);
    }
  }
  return { pois: [...cached.values()].flat(), complete: cached.size === keys.length };
}

async function fetchPoisInTiles(keys, signal, layers, { cacheOnly = false } = {}) {
  const parts = await Promise.all(layers.map(l => layerPois(keys, l, signal, cacheOnly)));
  const seen = new Set();
  const out = parts.flatMap(p => p.pois).filter(p => !seen.has(p.id) && seen.add(p.id));
  out.complete = parts.every(p => p.complete);
  return out;
}

/**
 * Orte der angegebenen Ebenen entlang der Route (Kacheln samt ~1 km Rand).
 * Das Ergebnis-Array trägt `complete` = false, wenn mit `cacheOnly` nicht alle Kacheln vorhanden waren.
 */
export function fetchPois(r, signal, layers = ['supply'], opts = {}) {
  return fetchPoisInTiles(routeTiles(r), signal, layers, opts);
}

/** Orte der Ebenen rund um einzelne Punkte (`margin` in Grad, z. B. 0,03 ≈ 3 km) – etwa um Etappenenden. */
export function fetchPoisNear(points, signal, layers, { margin = 0.03, ...opts } = {}) {
  return fetchPoisInTiles(tilesNear(points, margin), signal, layers, opts);
}

// ---------- Vorrat entlang der Route (Server) ----------

const WARM_ROUTE_API = new URL('../api/warm-route', import.meta.url);
const warmedTiles = new Set(); // in dieser Sitzung schon gemeldete Kacheln
const MAX_WARM_TILES = 1000;   // Obergrenze des Servers je Anfrage
// Eigenes Kennzeichen: Ein älterer Server ohne /api/warm-route (404) soll den POI-Cache nicht abschalten
let warmAvailable = true;

/**
 * Kacheln entlang der Route beim Server vormerken: Er lädt alle Datenebenen im Hintergrund in seinen
 * gemeinsamen Cache, damit Verpflegungsstopps, „Entlang der Route“ und Mehrtagestouren danach sofort Daten
 * haben. Übermittelt werden nur Kacheln (0,1° ≈ 11 × 7 km) – dieselben, die auch /api/pois bekommt.
 * Ohne Server (statisches Hosting) oder bei Fehlern passiert nichts; je Sitzung wird jede Kachel nur einmal
 * gemeldet.
 */
export function warmRoute(r) {
  if (!serverAvailable || !warmAvailable) return;
  const tiles = routeTiles(r).filter(k => !warmedTiles.has(k)).slice(0, MAX_WARM_TILES);
  if (!tiles.length) return;
  tiles.forEach(k => warmedTiles.add(k));
  fetch(WARM_ROUTE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tiles }),
  }).then(res => {
    // Statisch ausgeliefert oder älterer Server → in dieser Sitzung nicht weiter versuchen
    if ([404, 405, 501].includes(res.status)) warmAvailable = false;
  }).catch(() => {});
}
