/**
 * „Entlang der Route finden“: Orte einer Kategorie (Café, Restaurant, Bäckerei, Supermarkt, Tankstelle)
 * bis 1 km neben der Route. Quelle ist der Kachel-Cache (mit Öffnungszeiten); ist er für die Route noch
 * unvollständig, die Photon-Kategoriesuche (`include=osm.<key>.<value>`, ohne Suchbegriff) – abschnittsweise
 * in Rechtecken entlang der Route, danach lokal nach Entfernung gefiltert.
 */
import { sampleRoute } from './utils.js';
import { fetchPois } from './poiTiles.js';
import { withTypicalHours } from './chainHours.js';
import { nearestSample } from './routeGeometry.js';
import { layerOfType } from './poiSource.js';
import { withTimeout } from './shared.js';

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

/** Nächster Routenpunkt; Orte mehr als ~2 km (0,02° Breite) daneben werden gar nicht erst verglichen. */
const nearest = (samples, lat, lon) => nearestSample(samples, lat, lon, 0.02);

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
 * `partial` am Ergebnis ist true, wenn einzelne Abschnitte nicht abgefragt werden konnten; `source` ist
 * 'cache' (Kachel-Cache, mit Öffnungszeiten in `poi`) oder 'photon'.
 * `maxOffset`: höchste Entfernung von der Route (Luftlinie).
 *
 * Zuerst wird der Kachel-Cache (Browser/Server) gefragt – ohne auf Overpass zu warten. Ist er für die
 * Route vollständig, kommen die Treffer von dort; sonst von Photon, während der Server die fehlenden
 * Kacheln im Hintergrund nachlädt (beim nächsten Mal sind sie da).
 */
export async function searchAlongRoute(r, category, { maxOffset = 1000, signal } = {}) {
  const samples = sampleRoute(r, 100);
  let cached = [];
  try {
    cached = await fetchPois(r, signal, [layerOfType(category)], { cacheOnly: true });
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  const typed = withTypicalHours(cached).filter(p => p.type === category);
  const fromCache = () => {
    const out = [];
    for (const poi of typed) {
      const { along, offset } = nearest(samples, poi.lat, poi.lon);
      if (offset > maxOffset) continue;
      out.push({ id: poi.id, lat: poi.lat, lon: poi.lon, name: poi.name || PLACE_CATEGORIES[category].label,
        detail: '', along, offset, category, poi });
    }
    out.sort((a, b) => a.along - b.along);
    out.source = 'cache';
    out.partial = !cached.complete;
    return out;
  };
  if (cached.complete) return fromCache();
  try {
    // Teilweise vorhandene Cache-Daten (Öffnungszeiten) an die Photon-Treffer hängen
    return await searchPhoton(r, category, samples, new Map(typed.map(p => [p.id, p])), { maxOffset, signal });
  } catch (e) {
    // Photon nicht erreichbar → wenigstens das, was der Cache schon hat
    if (signal?.aborted || !typed.length) throw e;
    return fromCache();
  }
}

/** Photon-Kategoriesuche abschnittsweise entlang der Route; `known`: Cache-Daten je OSM-Kennung (Öffnungszeiten). */
async function searchPhoton(r, category, samples, known, { maxOffset, signal }) {
  const cat = PLACE_CATEGORIES[category];
  const boxes = windows(samples);

  const features = [];
  let next = 0, failed = 0;
  async function worker() {
    while (next < boxes.length) {
      const bbox = boxes[next++];
      try {
        // Zeitlimit je Abschnitt, damit ein hängender Server die Suche nicht blockiert
        const res = await fetch(`${PHOTON}?include=${cat.include}&bbox=${bbox}&limit=50&lang=de`, { signal: withTimeout(signal, TIMEOUT) });
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
    const { along, offset } = nearest(samples, lat, lon);
    if (offset > maxOffset) continue;
    out.push({ id, lat, lon, name: p.name || cat.label, detail: describe(p), along, offset, category, poi: known.get(id) });
  }
  out.sort((a, b) => a.along - b.along);
  out.partial = failed > 0; // einzelne Abschnitte konnten nicht durchsucht werden
  out.source = 'photon';
  return out;
}
