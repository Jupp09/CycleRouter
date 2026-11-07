import { sampleRoute, indexAtDistance, storage } from './utils.js';

/**
 * Land und Bundesland/Region (ISO 3166-2, z. B. „DE-NW“, „AT-5“) für Punkte und entlang von Routen.
 * Quelle: Nominatim (OpenStreetMap). Ergebnisse werden dauerhaft im Browser gespeichert,
 * da sich Grenzen praktisch nie ändern.
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

/** → {country: 'DE', countryName, region: 'DE-NW' | null, regionName} oder null (z. B. auf dem Meer) */
export async function regionAt(point, signal) {
  const key = keyOf(point);
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
 * Abschnitte gleicher Region entlang der Route: [{from (m), country, countryName, region, regionName}].
 * Geprüft wird alle 20 km; wo sich die Region ändert, wird die Grenze auf ~2 km genau eingegrenzt.
 */
export async function regionsAlong(r, signal) {
  const pointAt = along => {
    const c = r.coords[indexAtDistance(r, along)];
    return { lat: c[0], lon: c[1], along };
  };
  const pts = sampleRoute(r, 20000);
  const regs = [];
  for (const p of pts) regs.push(await regionAt(p, signal));

  const segments = [{ from: 0, ...regs[0] }];
  for (let i = 1; i < pts.length; i++) {
    if (same(regs[i - 1], regs[i])) continue;
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
