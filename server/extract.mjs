// Datenauszug Europa im POI-Cache: Orte aller Datenebenen, wöchentlich aus den OpenStreetMap-Auszügen von
// Geofabrik aufbereitet (scripts/build-poi-extract.mjs, GitHub Actions) und als Release-Datei veröffentlicht.
// Der Server lädt das Paket herunter und legt es zellenweise ab:
//
//   cache/extract/meta.json           {t, sha256, layers, cells, …} des aktuellen Stands
//   cache/extract/cells/<zelle>.json  {layers: {ebene: {kachel: [poi]}}} – eine Zelle = 5 × 5 Kacheln (0,5°)
//
// Nur Zellen, die vollständig im Auszug liegen, sind enthalten; fehlt eine Kachel in einer vorhandenen Zelle,
// gibt es dort keine Orte. Gegenden außerhalb (oder neue Ebenen, die das Paket noch nicht kennt) lädt der
// POI-Cache weiter bei Overpass. Abschalten mit POI_EXTRACT_URL=off.
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellOfTile, cacheName, isTileKey, CELL } from '../js/poiSource.js';

const DIR = fileURLToPath(new URL('../cache/extract/', import.meta.url));
const CELLS = join(DIR, 'cells');
const META = join(DIR, 'meta.json');
const DEFAULT_URL = 'https://github.com/Jupp09/CycleRouter/releases/download/poi-data/pois-europe.json';
const CHECK_EVERY = 12 * 3600 * 1000;  // alle 12 h nachsehen, ob es ein neues Paket gibt
const FIRST_CHECK = 60 * 1000;         // erst kurz nach dem Start – der Server soll zuerst Anfragen beantworten
const CACHED_CELLS = 64;               // gelesene Zellen im Speicher (dichte Städte: ~1 MB je Zelle)
const USER_AGENT = 'CycloRouter/1.0 (+https://github.com/Jupp09/CycleRouter)';

let meta = null;            // aktueller Stand oder null (kein Auszug)
let covered = new Set();    // vorhandene Zellen
let layersInExtract = new Set();
const memo = new Map();     // zelle → Promise<{layers}> (zuletzt benutzte zuletzt)
let log = () => {};
let updating = false;

const isCellKey = k => /^-?\d{1,4}_-?\d{1,4}$/.test(k);

async function loadIndex() {
  try {
    meta = JSON.parse(await readFile(META, 'utf8'));
    covered = new Set((await readdir(CELLS)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)));
    layersInExtract = new Set(meta.layers);
  } catch {
    meta = null; covered = new Set(); layersInExtract = new Set();
  }
  memo.clear();
}

/** Deckt der Auszug diese Kachel und Ebene ab? (synchron – für Zählungen über tausende Kacheln) */
export function extractCovers(layer, key) {
  return !!meta && layersInExtract.has(cacheName(layer)) && covered.has(cellOfTile(key));
}

/** Alter des Auszugs in ms (Infinity ohne Auszug). */
export const extractAge = () => (meta ? Date.now() - meta.t : Infinity);

function readCell(cell) {
  if (memo.has(cell)) {
    const p = memo.get(cell);
    memo.delete(cell); memo.set(cell, p); // als zuletzt benutzt markieren
    return p;
  }
  const p = readFile(join(CELLS, `${cell}.json`), 'utf8').then(JSON.parse);
  p.catch(() => memo.delete(cell));
  memo.set(cell, p);
  while (memo.size > CACHED_CELLS) memo.delete(memo.keys().next().value);
  return p;
}

/** Orte einer Kachel aus dem Auszug → {t, pois} oder null (nicht abgedeckt). */
export async function extractTile(layer, key) {
  if (!extractCovers(layer, key)) return null;
  try {
    const data = await readCell(cellOfTile(key));
    return { t: meta.t, pois: data.layers?.[cacheName(layer)]?.[key] || [] };
  } catch {
    return null;
  }
}

// ---------- Aktualisieren ----------

/** Prüfsumme über die komprimierten Bytes, während sie durchlaufen. */
function hashing(hash) {
  return new Transform({ transform(chunk, _, cb) { hash.update(chunk); cb(null, chunk); } });
}

/**
 * Neues Paket laden, wenn die Beschreibung (pois-europe.json) einen neueren Stand meldet. Entpackt wird in
 * einen neuen Ordner, der den alten erst ersetzt, wenn alles geprüft ist (Prüfsumme, Format).
 */
async function update() {
  const url = process.env.POI_EXTRACT_URL ?? DEFAULT_URL;
  if (!url || url === 'off' || updating) return;
  updating = true;
  const tmp = join(DIR, 'cells.new');
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 404) return; // noch nichts veröffentlicht
    if (!res.ok) throw new Error(`Beschreibung: HTTP ${res.status}`);
    const manifest = await res.json();
    if (!Number.isFinite(manifest.t) || typeof manifest.file !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
      throw new Error('Beschreibung unvollständig');
    }
    if (meta?.sha256 === manifest.sha256) return; // schon aktuell

    log(`Datenauszug: neuer Stand vom ${new Date(manifest.t).toLocaleDateString('de-DE')} wird geladen (${(manifest.bytes / 1e6).toFixed(0)} MB) …`);
    const t0 = Date.now();
    const data = await fetch(new URL(manifest.file, url), { headers: { 'User-Agent': USER_AGENT } });
    if (!data.ok) throw new Error(`Paket: HTTP ${data.status}`);

    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const hash = createHash('sha256');
    const gunzip = createGunzip();
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    const download = pipeline(Readable.fromWeb(data.body), hashing(hash), gunzip);
    download.catch(() => {}); // Fehler kommen über die Zeilen bzw. `await download` unten an
    let head = null, count = 0;
    try {
      for await (const line of lines) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (!head) {
          if (row.type !== 'meta' || row.cell !== CELL || !Array.isArray(row.layers)) throw new Error('Paket hat ein unbekanntes Format');
          head = row;
          continue;
        }
        if (!isCellKey(row.cell) || !row.layers || typeof row.layers !== 'object') throw new Error('Paket enthält ungültige Zellen');
        for (const tiles of Object.values(row.layers)) {
          if (Object.keys(tiles).some(k => !isTileKey(k) || cellOfTile(k) !== row.cell)) throw new Error('Paket enthält ungültige Kacheln');
        }
        await writeFile(join(tmp, `${row.cell}.json`), JSON.stringify({ layers: row.layers }));
        count++;
      }
      await download;
    } catch (e) {
      gunzip.destroy(); // Download abbrechen
      throw e;
    }
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Prüfsumme stimmt nicht (Paket wurde evtl. gerade ersetzt)');
    if (!head) throw new Error('Paket ist leer');

    // Austauschen: alter Stand wird erst nach dem Umbenennen gelöscht
    const old = join(DIR, 'cells.old');
    await rm(old, { recursive: true, force: true });
    await rename(CELLS, old).catch(() => {});
    await rename(tmp, CELLS);
    await writeFile(META, JSON.stringify({ t: manifest.t, sha256: manifest.sha256, layers: head.layers, regions: head.regions, cells: count }));
    await rm(old, { recursive: true, force: true });
    await loadIndex();
    log(`Datenauszug: ${count} Zellen (${head.regions?.length ?? '?'} Regionen) in ${Math.round((Date.now() - t0) / 1000)} s übernommen`);
  } catch (e) {
    log(`Datenauszug: Aktualisierung fehlgeschlagen – ${e.message}`);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  } finally {
    updating = false;
  }
}

/** Beim Start: vorhandenen Auszug einlesen und regelmäßig nach neuen Ständen sehen. */
export async function initExtract(logger) {
  log = logger || log;
  await mkdir(DIR, { recursive: true });
  await loadIndex();
  if (meta) log(`Datenauszug: Stand vom ${new Date(meta.t).toLocaleDateString('de-DE')}, ${covered.size} Zellen`);
  setTimeout(update, FIRST_CHECK).unref();
  setInterval(update, CHECK_EVERY).unref();
}

/** Sofort aktualisieren (`npm run extract:update`, z. B. per Cronjob oder nach der ersten Einrichtung). */
export async function updateExtract(logger = console.log) {
  log = logger;
  await mkdir(DIR, { recursive: true });
  await loadIndex();
  await update();
}
