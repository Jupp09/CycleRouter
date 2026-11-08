// Land und Bundesland/Region je Rasterpunkt (0,01° ≈ 1 km) – gemeinsamer Cache für alle Nutzer, Quelle Nominatim.
//
// Die Feiertagsprüfung (js/regions.js) braucht für jede Route Land und Bundesland an Stichpunkten alle 20 km und
// an Grenzen. Nominatim erlaubt höchstens eine Anfrage pro Sekunde; jeder Browser für sich braucht dafür bei einer
// neuen Strecke mehrere Sekunden. Grenzen ändern sich praktisch nie, also merkt sich der Server jedes Ergebnis
// dauerhaft (cache/regions.json) – häufig befahrene Gegenden sind danach für alle sofort da.
//
// Der Server hält Nominatims Regel (≤ 1 Anfrage/s, aussagekräftiger User-Agent) für alle Nutzer zusammen ein.
// Eine Antwort wartet höchstens ANSWER_WITHIN; was bis dahin fehlt, meldet sie als `missing`, und der Browser
// fragt es selbst bei Nominatim – so bremst eine volle Warteschlange niemanden aus.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const FILE = fileURLToPath(new URL('../cache/regions.json', import.meta.url));
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const HEADERS = { 'User-Agent': 'CycloRouter/1.0 (+https://github.com/Jupp09/CycleRouter)' };
const PRECISION = 0.01; // wie js/regions.js
const MIN_GAP = 1100;   // ms zwischen zwei Nominatim-Anfragen (Regel: höchstens eine pro Sekunde)
const ANSWER_WITHIN = 5000;
const SAVE_DELAY = 30000;
const MAX_ENTRIES = 300000; // ≈ 35 MB – weit mehr als ganz Europa entlang üblicher Routen
/** Höchstens so viele Punkte warten insgesamt auf Nominatim (≈ 4 min) – darüber fragt der Browser selbst. */
const MAX_QUEUE = 200;

/** Rasterschlüssel „lat_lon“ in Hundertstelgrad, z. B. „5074_710“ – wie keyOf in js/regions.js. */
export const isRegionKey = k => typeof k === 'string' && /^-?\d{1,5}_-?\d{1,5}$/.test(k)
  && Math.abs(Number(k.split('_')[0])) <= 8500 && Math.abs(Number(k.split('_')[1])) <= 18000;

/** key → {country, countryName, region, regionName} oder null (Meer, kein Land) */
let cache = new Map();
let loaded = null, dirty = false, saveTimer = null;

function load() {
  loaded ??= readFile(FILE, 'utf8')
    .then(text => { cache = new Map(Object.entries(JSON.parse(text))); })
    .catch(e => { if (e.code !== 'ENOENT') console.warn(`Regionen-Cache nicht lesbar: ${e.message}`); });
  return loaded;
}

function scheduleSave() {
  dirty = true;
  saveTimer ??= setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      // Bei Übergröße die ältesten Einträge verwerfen (Map hält die Einfügereihenfolge)
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      await mkdir(dirname(FILE), { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(cache)));
      await rename(tmp, FILE); // atomar
    } catch (e) {
      console.warn(`Regionen-Cache nicht gespeichert: ${e.message}`);
    }
  }, SAVE_DELAY);
}

// ---------- Nominatim, eine Anfrage nach der anderen ----------

let chain = Promise.resolve();
let last = 0;
const pending = new Map(); // key → Promise (gleiche Punkte mehrerer Nutzer nur einmal abfragen)

async function lookup(key) {
  const [i, j] = key.split('_').map(Number);
  const url = `${NOMINATIM}?format=jsonv2&zoom=5&addressdetails=1&accept-language=de`
    + `&lat=${(i * PRECISION).toFixed(5)}&lon=${(j * PRECISION).toFixed(5)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const a = (await res.json()).address;
  if (!a?.country_code) return null;
  return {
    country: a.country_code.toUpperCase(),
    countryName: a.country || a.country_code.toUpperCase(),
    region: a['ISO3166-2-lvl4'] || null,
    regionName: a.state || null,
  };
}

/** Punkt abfragen (in der gemeinsamen Warteschlange) und merken. Fehler werden nicht gemerkt. */
function fetchKey(key) {
  if (pending.has(key)) return pending.get(key);
  const p = chain.then(async () => {
    if (cache.has(key)) return cache.get(key);
    const wait = last + MIN_GAP - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      const result = await lookup(key);
      cache.set(key, result);
      scheduleSave();
      return result;
    } finally {
      last = Date.now();
    }
  });
  chain = p.catch(() => {});
  pending.set(key, p);
  p.finally(() => pending.delete(key)).catch(() => {});
  return p;
}

/**
 * Regionen für Rasterschlüssel → {regions: {key: Ergebnis|null}, missing: [key], fetched}.
 * `allowFetch(n)`: darf der Nutzer n neue Nominatim-Abfragen auslösen? (Kontingent je IP, server.mjs)
 */
export async function getRegions(keys, { allowFetch = () => true } = {}) {
  await load();
  const regions = {};
  const todo = [];
  for (const k of keys) {
    if (cache.has(k)) regions[k] = cache.get(k);
    else todo.push(k);
  }
  if (!todo.length) return { regions, missing: [], fetched: 0 };
  if (pending.size + todo.length > MAX_QUEUE || !allowFetch(todo.length)) return { regions, missing: todo, fetched: 0 };

  // Alle fehlenden einreihen; was nach ANSWER_WITHIN noch nicht da ist, holt der Browser selbst
  // (die Anfrage läuft trotzdem weiter und landet für das nächste Mal im Cache)
  const deadline = new Promise(r => setTimeout(r, ANSWER_WITHIN));
  const missing = [];
  let fetched = 0;
  await Promise.all(todo.map(k => Promise.race([
    fetchKey(k).then(v => { regions[k] = v; fetched++; }, () => missing.push(k)),
    deadline.then(() => { if (!(k in regions) && !missing.includes(k)) missing.push(k); }),
  ])));
  return { regions, missing: missing.filter(k => !(k in regions)), fetched };
}

/** Anzahl gespeicherter Punkte (für das Startprotokoll). */
export async function regionCacheSize() {
  await load();
  return cache.size;
}
