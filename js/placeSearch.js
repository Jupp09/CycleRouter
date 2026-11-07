import { sampleRoute } from './utils.js';

/**
 * Orte einer Kategorie (Café, Restaurant, Bäckerei, Supermarkt, Tankstelle) entlang einer Route finden.
 * Quelle: Photon-Kategoriesuche (`include=osm.<key>.<value>`, ohne Suchbegriff) – abschnittsweise in
 * Rechtecken entlang der Route, danach lokal nach Entfernung zur Route gefiltert.
 */

const PHOTON = 'https://photon.komoot.io/api/';

export const PLACE_CATEGORIES = {
  cafe: { label: 'Café', icon: '☕', include: 'osm.amenity.cafe' },
  restaurant: { label: 'Restaurant', icon: '🍽️', include: 'osm.amenity.restaurant' },
  bakery: { label: 'Bäckerei', icon: '🥐', include: 'osm.shop.bakery' },
  supermarket: { label: 'Supermarkt', icon: '🛒', include: 'osm.shop.supermarket' },
  fuel: { label: 'Tankstelle', icon: '⛽', include: 'osm.amenity.fuel' },
};

const WINDOW = 10000;   // Routenabschnitt je Abfrage (m)
const MARGIN = 0.012;   // Rand um den Abschnitt (≈ 1 km)
const PARALLEL = 2;     // gleichzeitige Abfragen (Rücksicht auf den öffentlichen Server)
const TIMEOUT = 10000;  // je Abfrage

function approxDist(aLat, aLon, bLat, bLon) {
  const dy = (bLat - aLat) * 110540;
  const dx = (bLon - aLon) * 111320 * Math.cos((aLat + bLat) * Math.PI / 360);
  return Math.hypot(dx, dy);
}

/** Rechtecke (W,S,O,N) für je ~10 km Route. */
function windows(samples) {
  const out = [];
  let box = null, start = 0;
  for (const p of samples) {
    if (!box || p.along - start > WINDOW) {
      if (box) out.push(box);
      box = [p.lon, p.lat, p.lon, p.lat];
      start = p.along;
    }
    box[0] = Math.min(box[0], p.lon); box[1] = Math.min(box[1], p.lat);
    box[2] = Math.max(box[2], p.lon); box[3] = Math.max(box[3], p.lat);
  }
  if (box) out.push(box);
  return out.map(([w, s, e, n]) => [w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN].map(v => v.toFixed(4)).join(','));
}

const OSM_TYPE = { N: 'node', W: 'way', R: 'relation' };

function describe(p) {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  return [street, p.city || p.town || p.village].filter(Boolean).join(', ');
}

/**
 * → [{id, lat, lon, name, detail, along (m), offset (m), category}] nach Position entlang der Route sortiert;
 * `partial` am Ergebnis ist true, wenn einzelne Abschnitte nicht abgefragt werden konnten.
 * `maxOffset`: höchste Entfernung von der Route (Luftlinie).
 */
export async function searchAlongRoute(r, category, { maxOffset = 1000, signal } = {}) {
  const cat = PLACE_CATEGORIES[category];
  const samples = sampleRoute(r, 100);
  const boxes = windows(samples);

  const features = [];
  let next = 0, failed = 0;
  async function worker() {
    while (next < boxes.length) {
      const bbox = boxes[next++];
      try {
        // Zeitlimit je Abschnitt, damit ein hängender Server die Suche nicht blockiert
        const timed = AbortSignal.any && AbortSignal.timeout
          ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)].filter(Boolean)) : signal;
        const res = await fetch(`${PHOTON}?include=${cat.include}&bbox=${bbox}&limit=50&lang=de`, { signal: timed });
        if (!res.ok) throw new Error(`Photon ${res.status}`);
        features.push(...(await res.json()).features);
      } catch (e) {
        if (signal?.aborted) throw e;
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (failed === boxes.length) throw new Error('Die Ortssuche ist gerade nicht erreichbar.');

  const seen = new Set();
  const out = [];
  for (const f of features) {
    const p = f.properties;
    const id = `${OSM_TYPE[p.osm_type] || 'node'}/${p.osm_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const [lon, lat] = f.geometry.coordinates;
    let best = Infinity, along = 0;
    for (const s of samples) {
      if (Math.abs(s.lat - lat) > 0.02) continue;
      const d = approxDist(s.lat, s.lon, lat, lon);
      if (d < best) { best = d; along = s.along; }
    }
    if (best > maxOffset) continue;
    out.push({ id, lat, lon, name: p.name || cat.label, detail: describe(p), along, offset: best, category });
  }
  out.sort((a, b) => a.along - b.along);
  out.partial = failed > 0; // einzelne Abschnitte konnten nicht durchsucht werden
  return out;
}
