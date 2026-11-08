// Vorrat im gemeinsamen Cache – für alle Nutzer dieses Servers. Zwei Arten von Aufträgen:
//
//   Region: Hinterlegt jemand eine Heimatadresse, werden alle Kacheln im Umkreis von 200 km geladen.
//   Route:  Nach jeder berechneten Route werden die Kacheln entlang der Route geladen (alle Datenebenen),
//           damit Verpflegungsstopps, „Entlang der Route“ und Mehrtagestouren danach sofort Daten haben.
//
// Die Arbeit läuft im Hintergrund, paketweise und mit Pausen (Rücksicht auf die öffentlichen Overpass-Server).
// Routen kommen vor Regionen – eine laufende Region wird zwischen zwei Paketen unterbrochen. Anfragen, auf die
// ein Nutzer wartet, haben immer Vorrang (isBusy). Die Warteschlange überlebt Neustarts (cache/warm-queue.json).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tilesAround, tilesNeedingFetch, fetchTiles, isBusy, ALL_LAYERS } from './poiCache.mjs';
import { TILE, tileKey } from '../js/poiSource.js';

export const RADIUS_KM = 200;
const CHUNK = 40;                     // Kacheln je Paket (eine Overpass-Abfrage je Kombination fehlender Ebenen)
const PAUSE_MS = 5000;                // Pause zwischen zwei Paketen
const MAX_JOBS = 20;                  // gleichzeitig wartende Regionen
const PER_CLIENT_PER_DAY = 3;         // neue Regionen je Nutzer (IP) und Tag
const MAX_ROUTE_JOBS = 30;            // gleichzeitig wartende Routen
const ROUTES_PER_CLIENT_PER_DAY = 60; // neue Routen-Aufträge je Nutzer (IP) und Tag
// Routen-Aufträge erst nach dieser Wartezeit beginnen: Gleich nach der Route fragt die App selbst Kacheln an
// (Verpflegungsstopps, Suche) – die sollen nicht hinter einer großen Vorrat-Abfrage für dieselben Kacheln warten.
const ROUTE_DELAY_MS = 20000;
const SAME_REGION_KM = 30;            // näher beieinander liegende Heimatorte gelten als dieselbe Region
const REDO_AFTER = 7 * 24 * 3600 * 1000; // fertige Region frühestens nach 7 Tagen erneut prüfen

const QUEUE_FILE = fileURLToPath(new URL('../cache/warm-queue.json', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// jobs: Regionen {lat, lon, t} und Routen {tiles: [kachel], t}; done: fertige Regionen {lat, lon, t}
let state = { jobs: [], done: [] };
const clientHits = new Map();       // `${art}|${ip}` → [Zeitpunkte]
const work = new Map();             // Auftrag → {list: [[kachel, ebenen]], pos} – nur im Speicher
let running = false;
let log = () => {};

const isRoute = job => Array.isArray(job.tiles);
const regionJobs = () => state.jobs.filter(j => !isRoute(j));
const distKm = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180));

/** Auf den Mittelpunkt der Kachel runden – genauer muss der Server den Heimatort nicht kennen. */
function snap(lat, lon) {
  const [i, j] = tileKey(lat, lon).split('_').map(Number);
  return { lat: +((i + 0.5) * TILE).toFixed(2), lon: +((j + 0.5) * TILE).toFixed(2) };
}

async function persist() {
  try {
    await mkdir(fileURLToPath(new URL('../cache/', import.meta.url)), { recursive: true });
    await writeFile(QUEUE_FILE, JSON.stringify(state));
  } catch (e) { log(`Warteschlange konnte nicht gespeichert werden: ${e.message}`); }
}

/** Höchstens `max` neue Aufträge je Art und Nutzer (IP) in 24 h – true, wenn noch erlaubt (und gezählt). */
function allowClient(kind, client, max) {
  const now = Date.now();
  const key = `${kind}|${client}`;
  const hits = (clientHits.get(key) || []).filter(t => now - t < 24 * 3600 * 1000);
  if (hits.length >= max) return false;
  clientHits.set(key, [...hits, now]);
  return true;
}

/** Fehlende oder abgelaufene Ebenen je Kachel → Map kachel → [ebenen] (Reihenfolge der Kacheln bleibt). */
async function needsByKey(keys) {
  const missing = await Promise.all(ALL_LAYERS.map(async l => new Set(await tilesNeedingFetch(keys, l))));
  const out = new Map();
  for (const k of keys) {
    const layers = ALL_LAYERS.filter((_, i) => missing[i].has(k));
    if (layers.length) out.set(k, layers);
  }
  return out;
}

export async function initWarmQueue(logger) {
  log = logger || log;
  try { state = JSON.parse(await readFile(QUEUE_FILE, 'utf8')); } catch { /* noch keine Warteschlange */ }
  state.done = state.done.filter(d => Date.now() - d.t < REDO_AFTER);
  if (state.jobs.length) log(`Vorrat: ${state.jobs.length} Auftrag/Aufträge in der Warteschlange – wird fortgesetzt`);
  run();
}

// ---------- Regionen ----------

/**
 * Fortschritt für die Region um einen Punkt: {total, missing, queued, position}.
 * Gezählt werden Kachel-Ebenen (Kacheln × Datenebenen) – fehlt nur eine Ebene, zählt nur diese.
 */
export async function warmStatus(lat, lon) {
  const center = snap(lat, lon);
  const keys = tilesAround(center.lat, center.lon, RADIUS_KM);
  let missing = 0;
  for (const layer of ALL_LAYERS) missing += (await tilesNeedingFetch(keys, layer)).length;
  const total = keys.length * ALL_LAYERS.length;
  const position = regionJobs().findIndex(j => distKm(j, center) <= SAME_REGION_KM);
  return { total, missing, queued: position >= 0, position: position >= 0 ? position + 1 : null };
}

/**
 * Region um einen Heimatort vormerken.
 * → {status: 'queued' | 'already-queued' | 'complete' | 'rate-limited' | 'full', ...warmStatus}
 */
export async function requestWarm(lat, lon, client) {
  const center = snap(lat, lon);
  const status = await warmStatus(center.lat, center.lon);
  if (status.queued) return { status: 'already-queued', ...status };
  if (!status.missing) return { status: 'complete', ...status };
  const recent = state.done.find(d => distKm(d, center) <= SAME_REGION_KM && Date.now() - d.t < REDO_AFTER);
  // Kürzlich fertig gewordene Region mit nur wenigen Lücken (z. B. Overpass-Fehler) nicht sofort neu anstoßen
  if (recent && status.missing < status.total * 0.05) return { status: 'complete', ...status };
  if (regionJobs().length >= MAX_JOBS) return { status: 'full', ...status };
  if (!allowClient('region', client, PER_CLIENT_PER_DAY)) return { status: 'rate-limited', ...status };

  state.jobs.push({ ...center, t: Date.now() });
  await persist();
  log(`Vorrat: Region ${center.lat}, ${center.lon} vorgemerkt (${status.missing} von ${status.total} Kacheln fehlen)`);
  run();
  return { status: 'queued', ...status, queued: true, position: regionJobs().length };
}

// ---------- Routen ----------

/**
 * Kacheln entlang einer Route vormerken (alle Datenebenen). Gespeichert werden nur die Kacheln, denen noch
 * etwas fehlt. → {status: 'queued' | 'complete' | 'rate-limited' | 'full', missing}
 */
export async function requestRouteWarm(tiles, client) {
  const need = await needsByKey([...new Set(tiles)]);
  // Was schon in einem wartenden Auftrag steckt, nicht doppelt vormerken
  for (const job of state.jobs) if (isRoute(job)) job.tiles.forEach(k => need.delete(k));
  if (!need.size) return { status: 'complete', missing: 0 };
  if (state.jobs.filter(isRoute).length >= MAX_ROUTE_JOBS) return { status: 'full', missing: need.size };
  if (!allowClient('route', client, ROUTES_PER_CLIENT_PER_DAY)) return { status: 'rate-limited', missing: need.size };

  // Routen vor Regionen, untereinander in Eingangsreihenfolge
  const at = state.jobs.findIndex(j => !isRoute(j));
  state.jobs.splice(at < 0 ? state.jobs.length : at, 0, { tiles: [...need.keys()], t: Date.now() });
  await persist();
  log(`Vorrat: Route mit ${need.size} unvollständigen Kacheln vorgemerkt`);
  run();
  return { status: 'queued', missing: need.size };
}

// ---------- Abarbeiten ----------

/** Nächstes Paket eines Auftrags → [[kachel, ebenen]] (leer = fertig). */
async function nextChunk(job) {
  let w = work.get(job);
  if (!w) {
    const keys = isRoute(job) ? job.tiles : tilesAround(job.lat, job.lon, RADIUS_KM);
    w = { list: [...await needsByKey(keys)], pos: 0 };
    work.set(job, w);
    if (!isRoute(job) && w.list.length) log(`Vorrat: Region ${job.lat}, ${job.lon} – ${w.list.length} Kacheln werden geladen`);
  }
  const chunk = w.list.slice(w.pos, w.pos + CHUNK);
  w.pos += chunk.length;
  return chunk;
}

async function finish(job, t0) {
  state.jobs.splice(state.jobs.indexOf(job), 1);
  work.delete(job);
  if (isRoute(job)) {
    log(`Vorrat: Route (${job.tiles.length} Kacheln) fertig`);
  } else {
    state.done.push({ lat: job.lat, lon: job.lon, t: Date.now() });
    log(`Vorrat: Region ${job.lat}, ${job.lon} fertig${t0 ? ` in ${Math.round((Date.now() - t0) / 60000)} min` : ''}`);
  }
  await persist();
}

async function run() {
  if (running) return;
  running = true;
  const started = new Map(); // Auftrag → Startzeit (für die Dauer im Log)
  try {
    while (state.jobs.length) {
      // Fällige Routen zuerst – eine laufende Region wird dafür zwischen zwei Paketen unterbrochen
      const due = j => Date.now() - j.t >= ROUTE_DELAY_MS;
      const job = state.jobs.find(j => isRoute(j) && due(j)) || state.jobs.find(j => !isRoute(j));
      if (!job) { await sleep(1000); continue; } // nur Routen, die noch nicht fällig sind
      if (!started.has(job)) started.set(job, Date.now());
      const chunk = await nextChunk(job);
      if (!chunk.length) { await finish(job, started.get(job)); started.delete(job); continue; }

      while (isBusy()) await sleep(2000); // Nutzer, die auf Overpass warten, haben Vorrang
      // Erneut prüfen: Inzwischen können Nutzeranfragen Kacheln geladen haben
      const need = await needsByKey(chunk.map(([k]) => k));
      if (need.size) {
        const byLayer = new Map(ALL_LAYERS.map(l => [l, [...need].filter(([, ls]) => ls.includes(l)).map(([k]) => k)]));
        for (const [l, ks] of byLayer) if (!ks.length) byLayer.delete(l);
        for (let attempt = 1; ; attempt++) {
          try {
            await fetchTiles(byLayer);
            break;
          } catch (e) {
            if (attempt >= 3) { log(`Vorrat: ${need.size} Kacheln übersprungen (${e.message})`); break; }
            await sleep(60000 * attempt); // Overpass überlastet → länger warten
          }
        }
        const w = work.get(job);
        if (!isRoute(job)) log(`Vorrat: Region ${job.lat}, ${job.lon} – ${Math.min(w.pos, w.list.length)} / ${w.list.length} Kacheln`);
        await sleep(PAUSE_MS);
      }
    }
  } finally {
    running = false;
  }
}
