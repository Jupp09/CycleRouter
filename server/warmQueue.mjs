// Vorrat für Heimatregionen: Hinterlegt jemand eine Heimatadresse, lädt der Server alle Kacheln im Umkreis
// von 200 km in den gemeinsamen Cache – für alle Nutzer dieses Servers. Die Arbeit läuft im Hintergrund,
// nacheinander und mit Pausen (Rücksicht auf die öffentlichen Overpass-Server), nahe Kacheln zuerst.
// Routenanfragen haben Vorrang. Die Warteschlange überlebt Neustarts (cache/warm-queue.json).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tilesAround, tilesNeedingFetch, fetchTiles, isBusy } from './poiCache.mjs';
import { TILE, tileKey } from '../js/poiSource.js';

export const RADIUS_KM = 200;
const CHUNK = 40;                     // Kacheln je Overpass-Abfrage
const PAUSE_MS = 5000;                // Pause zwischen zwei Abfragen
const MAX_JOBS = 20;                  // gleichzeitig wartende Regionen
const PER_CLIENT_PER_DAY = 3;         // neue Aufträge je Nutzer (IP) und Tag
const SAME_REGION_KM = 30;            // näher beieinander liegende Heimatorte gelten als dieselbe Region
const REDO_AFTER = 7 * 24 * 3600 * 1000; // fertige Region frühestens nach 7 Tagen erneut prüfen

const QUEUE_FILE = fileURLToPath(new URL('../cache/warm-queue.json', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = { jobs: [], done: [] }; // jobs: [{lat, lon, t}], done: [{lat, lon, t}]
const clientHits = new Map();       // ip → [Zeitpunkte]
let running = false;
let log = () => {};

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

export async function initWarmQueue(logger) {
  log = logger || log;
  try { state = JSON.parse(await readFile(QUEUE_FILE, 'utf8')); } catch { /* noch keine Warteschlange */ }
  state.done = state.done.filter(d => Date.now() - d.t < REDO_AFTER);
  if (state.jobs.length) log(`Vorrat: ${state.jobs.length} Region(en) in der Warteschlange – wird fortgesetzt`);
  run();
}

/** Fortschritt für die Region um einen Punkt: {total, missing, queued, position}. */
export async function warmStatus(lat, lon) {
  const center = snap(lat, lon);
  const keys = tilesAround(center.lat, center.lon, RADIUS_KM);
  const missing = (await tilesNeedingFetch(keys)).length;
  const position = state.jobs.findIndex(j => distKm(j, center) <= SAME_REGION_KM);
  return { total: keys.length, missing, queued: position >= 0, position: position >= 0 ? position + 1 : null };
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
  if (state.jobs.length >= MAX_JOBS) return { status: 'full', ...status };

  const now = Date.now();
  const hits = (clientHits.get(client) || []).filter(t => now - t < 24 * 3600 * 1000);
  if (hits.length >= PER_CLIENT_PER_DAY) return { status: 'rate-limited', ...status };
  clientHits.set(client, [...hits, now]);

  state.jobs.push({ ...center, t: now });
  await persist();
  log(`Vorrat: Region ${center.lat}, ${center.lon} vorgemerkt (${status.missing} von ${status.total} Kacheln fehlen)`);
  run();
  return { status: 'queued', ...status, queued: true, position: state.jobs.length };
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (state.jobs.length) {
      const job = state.jobs[0];
      const keys = await tilesNeedingFetch(tilesAround(job.lat, job.lon, RADIUS_KM));
      const t0 = Date.now();
      log(`Vorrat: Region ${job.lat}, ${job.lon} – ${keys.length} Kacheln werden geladen`);
      for (let i = 0; i < keys.length; i += CHUNK) {
        while (isBusy()) await sleep(2000); // Routenanfragen von Nutzern haben Vorrang
        const chunk = keys.slice(i, i + CHUNK);
        for (let attempt = 1; ; attempt++) {
          try {
            await fetchTiles(chunk);
            break;
          } catch (e) {
            if (attempt >= 3) { log(`Vorrat: ${chunk.length} Kacheln übersprungen (${e.message})`); break; }
            await sleep(60000 * attempt); // Overpass überlastet → länger warten
          }
        }
        log(`Vorrat: ${Math.min(i + CHUNK, keys.length)} / ${keys.length} Kacheln`);
        await sleep(PAUSE_MS);
      }
      log(`Vorrat: Region ${job.lat}, ${job.lon} fertig in ${Math.round((Date.now() - t0) / 60000)} min`);
      state.jobs.shift();
      state.done.push({ lat: job.lat, lon: job.lon, t: Date.now() });
      await persist();
    }
  } finally {
    running = false;
  }
}
