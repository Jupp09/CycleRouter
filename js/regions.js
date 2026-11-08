import { sampleRoute, indexAtDistance, storage } from './utils.js';

/**
 * Land und Bundesland/Region (ISO 3166-2, z. B. „DE-NW“, „AT-5“) für Punkte und entlang von Routen.
 * Quelle: Nominatim (OpenStreetMap). Ergebnisse werden dauerhaft im Browser gespeichert,
 * da sich Grenzen praktisch nie ändern.
 *
 * Reihenfolge je Punkt (Raster ≈ 1 km): Browser-Cache → Server (POST /api/regions, gemeinsamer Cache aller
 * Nutzer, server/regions.mjs) → Nominatim direkt (höchstens eine Anfrage pro Sekunde). Ohne Server (statisch
 * ausgeliefert) wird er übersprungen. Übermittelt werden nur die Rasterpunkte (0,01°).
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const PRECISION = 0.01; // Cache-Raster ≈ 1 km
const MAX_CACHE = 3000;

const cache = new Map(Object.entries(storage.get('regionCache', {})));
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storage.set('regionCache', Object.fromEntries([...cache].slice(-MAX_CACHE))), 500);
}

// Nominatim erlaubt höchstens eine Anfrage pro Sekunde
let queue = Promise.resolve();
let last = 0;
function throttled(fn) {
  const p = queue.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); } finally { last = Date.now(); }
  });
  queue = p.catch(() => {});
  return p;
}

const keyOf = p => `${Math.round(p.lat / PRECISION)}_${Math.round(p.lon / PRECISION)}`;

// ---------- Server-Cache ----------

const SERVER_API = new URL('../api/regions', import.meta.url);
let serverAvailable = true; // false, wenn die App ohne server.mjs läuft (oder ein älterer Server ohne Endpunkt)

/** Rasterschlüssel beim Server nachschlagen; Gefundenes landet im Browser-Cache. Fehler → nichts gefunden. */
async function fromServer(keys, signal) {
  if (!serverAvailable || !keys.length) return;
  let res;
  try {
    res = await fetch(SERVER_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }), signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    serverAvailable = false;
    return;
  }
  if ([404, 405, 501].includes(res.status) || !res.headers.get('content-type')?.includes('json')) {
    serverAvailable = false;
    return;
  }
  if (!res.ok) return; // z. B. Kontingent erschöpft – dann direkt bei Nominatim
  const { regions } = await res.json();
  for (const [k, v] of Object.entries(regions || {})) cache.set(k, v);
  persist();
}

/** Mehrere Punkte auf einmal: erst gesammelt beim Server, den Rest einzeln bei Nominatim → [Ergebnis] */
export async function regionsAt(points, signal) {
  await fromServer([...new Set(points.map(keyOf).filter(k => !cache.has(k)))], signal);
  const out = [];
  for (const p of points) out.push(await regionAt(p, signal));
  return out;
}

/** → {country: 'DE', countryName, region: 'DE-NW' | null, regionName} oder null (z. B. auf dem Meer) */
export async function regionAt(point, signal) {
  const key = keyOf(point);
  if (cache.has(key)) return cache.get(key);
  await fromServer([key], signal);
  if (cache.has(key)) return cache.get(key);
  const result = await throttled(async () => {
    if (cache.has(key)) return cache.get(key);
    signal?.throwIfAborted();
    const url = `${NOMINATIM}?format=jsonv2&zoom=5&addressdetails=1&accept-language=de`
      + `&lat=${point.lat.toFixed(5)}&lon=${point.lon.toFixed(5)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Nominatim-Fehler ${res.status}`);
    const a = (await res.json()).address;
    if (!a?.country_code) return null;
    return {
      country: a.country_code.toUpperCase(),
      countryName: a.country || a.country_code.toUpperCase(),
      region: a['ISO3166-2-lvl4'] || null,
      regionName: a.state || null,
    };
  });
  cache.set(key, result);
  persist();
  return result;
}

const same = (a, b) => (a?.country ?? null) === (b?.country ?? null) && (a?.region ?? null) === (b?.region ?? null);

/**
 * Abschnitte gleicher Region entlang der Route: [{from (m), country, countryName, region, regionName, approx?}].
 * Geprüft wird alle 20 km. Mit `precise` (Standard) wird jede Grenze auf ~2 km genau eingegrenzt – das kostet
 * je Grenze 3–4 weitere Nominatim-Anfragen (höchstens eine pro Sekunde). Ohne `precise` liegt die Grenze
 * in der Mitte zwischen zwei Stichproben (±10 km, `approx: true`). Ein zweiter, genauer Aufruf für dieselbe
 * Route fragt die Stichproben nicht erneut ab (Cache).
 */
export async function regionsAlong(r, signal, { precise = true } = {}) {
  const pointAt = along => {
    const c = r.coords[indexAtDistance(r, along)];
    return { lat: c[0], lon: c[1], along };
  };
  const pts = sampleRoute(r, 20000);
  const regs = await regionsAt(pts, signal); // Stichpunkte gesammelt in einer Server-Anfrage

  const segments = [{ from: 0, ...regs[0] }];
  for (let i = 1; i < pts.length; i++) {
    if (same(regs[i - 1], regs[i])) continue;
    if (!precise) {
      segments.push({ from: (pts[i - 1].along + pts[i].along) / 2, ...regs[i], approx: true });
      continue;
    }
    let a = pts[i - 1].along, b = pts[i].along, rb = regs[i];
    while (b - a > 2000) {
      const m = (a + b) / 2;
      const rm = await regionAt(pointAt(m), signal);
      if (same(rm, regs[i - 1])) a = m; else { b = m; rb = rm; }
    }
    segments.push({ from: b, ...rb });
    // Zwei Wechsel innerhalb eines Intervalls (selten): zweiten Wechsel grob übernehmen
    if (!same(rb, regs[i])) segments.push({ from: pts[i].along, ...regs[i] });
  }
  return segments;
}

/** Region an Position `along` aus dem Ergebnis von regionsAlong. */
export function regionAtDistance(segments, along) {
  if (!segments?.length) return null;
  let found = segments[0];
  for (const s of segments) { if (s.from <= along) found = s; else break; }
  return found.country ? found : null;
}

/** Lesbarer Name: Bundesland, bei Auslandsabschnitten mit Land. */
export function regionLabel(seg, homeCountry = 'DE') {
  if (!seg?.country) return 'Unbekannt';
  if (!seg.regionName) return seg.countryName;
  return seg.country === homeCountry ? seg.regionName : `${seg.regionName} (${seg.countryName})`;
}
