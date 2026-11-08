// Valhalla (öffentlicher Server der FOSSGIS, ohne Key) – Ausweichdienst, wenn BRouter ausgelastet ist
// (index.js). Nicht in der Dienstauswahl: Valhalla bewertet Wege anders, eine EuroVelo-Bevorzugung gibt es
// nicht. Nutzungsbedingungen: nur moderate Nutzung – deshalb ausschließlich als Notlösung.
import { mergeSegments } from '../surfaces.js';
import { haversine } from '../utils.js';

const ENDPOINT = 'https://valhalla1.openstreetmap.de';

// Fahrradtyp → Valhalla bicycle_type; „Road“ meidet Unbefestigtes von selbst, „Cross“ ≈ Gravel
const BICYCLE_TYPE = { road: 'Road', gravel: 'Cross', trekking: 'Hybrid' };
// Verkehr (nur Rennrad): Bereitschaft, auf Straßen zu fahren (0 … 1, Standard 0,5)
const USE_ROADS = { normal: 0.5, low: 0.25, verylow: 0.1 };
const ELEVATION_INTERVAL = 30; // m zwischen zwei Höhenwerten

/** Valhalla-Polyline (Genauigkeit 6 Stellen) → [[lat, lon]] */
function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (k) lon += delta; else lat += delta;
    }
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}

async function post(path, body, signal) {
  let res;
  try {
    res = await fetch(`${ENDPOINT}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw Object.assign(new Error('Valhalla ist nicht erreichbar.'), { busy: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 171: kein Weg in der Nähe eines Punkts; 442: keine Verbindung
    if (data.error_code === 171) throw new Error('Ein Punkt liegt zu weit von einem befahrbaren Weg entfernt.');
    if (data.error_code === 442) throw new Error('Zwischen den Punkten wurde kein befahrbarer Weg gefunden.');
    throw Object.assign(new Error(`Valhalla-Fehler: ${data.error || res.status}`), { busy: res.status === 429 || res.status >= 500 });
  }
  return data;
}

// ---------- Untergrund und Wegtyp (trace_attributes) → Kategorien aus surfaces.js ----------

const SURFACE = {
  paved_smooth: 'asphalt', paved: 'asphalt', paved_rough: 'paving', compacted: 'fine_gravel',
  gravel: 'gravel', dirt: 'natural', path: 'natural', impassable: 'natural',
};
const MAIN = ['motorway', 'trunk', 'primary', 'secondary'];
const MINOR = ['tertiary', 'unclassified'];
const PATHS = ['path', 'footway', 'pedestrian', 'steps', 'bridleway', 'sidewalk', 'mountain_bike', 'pedestrian_crossing'];
const SERVICE = ['driveway', 'alley', 'parking_aisle', 'service_road', 'living_street', 'drive_through', 'emergency_access'];

function waytypeOf(edge) {
  const use = edge.use;
  if (use === 'ferry' || use === 'rail-ferry') return 'ferry';
  if (use === 'cycleway' || edge.cycle_lane === 'separated') return 'cycleway';
  if (use === 'track') return 'track';
  if (PATHS.includes(use)) return 'path';
  if (SERVICE.includes(use)) return 'residential';
  if (edge.cycle_lane === 'dedicated' || edge.cycle_lane === 'shared') return 'roadlane';
  if (MAIN.includes(edge.road_class)) return 'main';
  if (MINOR.includes(edge.road_class)) return 'minor';
  if (edge.road_class === 'residential' || edge.road_class === 'service_other') return 'residential';
  return 'other';
}

/**
 * Kanten über ihre Länge auf die Routenpunkte legen (die Längen der Kanten ergeben zusammen die Route,
 * gemessen auf ±10 m genau – zuverlässiger als die Punkt-Indizes, die sich auf eine andere Linie beziehen).
 */
function edgesToSegments(edges, coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat: coords[i][0], lon: coords[i][1] }));
  }
  const segments = [];
  let from = 0, travelled = 0, j = 0;
  for (const edge of edges) {
    travelled += edge.length * 1000;
    while (j < coords.length - 1 && cum[j] < travelled) j++;
    const to = Math.max(from + 1, j);
    if (to > coords.length - 1) break;
    segments.push({ from, to, surface: SURFACE[edge.surface] || 'unknown', waytype: waytypeOf(edge), estimated: false });
    from = to;
  }
  if (segments.length) segments[segments.length - 1].to = coords.length - 1;
  return mergeSegments(segments);
}

async function segmentsFor(shape, costing, coords, signal) {
  try {
    const data = await post('trace_attributes', {
      encoded_polyline: shape, costing, shape_match: 'edge_walk',
      filters: { attributes: ['edge.surface', 'edge.road_class', 'edge.use', 'edge.cycle_lane', 'edge.length'], action: 'include' },
    }, signal);
    return edgesToSegments(data.edges || [], coords);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return []; // Route trotzdem nutzbar – nur ohne Aufschlüsselung nach Untergrund
  }
}

/** Höhenwerte (alle ELEVATION_INTERVAL m) über die Strecke auf die Punkte verteilen. */
function withElevation(coords, elevation, interval) {
  if (!elevation?.length) return coords.map(([lat, lon]) => [lat, lon, null]);
  let d = 0;
  return coords.map(([lat, lon], i) => {
    if (i) d += haversine({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat, lon });
    const x = Math.min(elevation.length - 1, d / interval), k = Math.floor(x);
    const a = elevation[k], b = elevation[Math.min(k + 1, elevation.length - 1)];
    const ele = a == null ? b : b == null ? a : a + (b - a) * (x - k);
    return [lat, lon, ele ?? null];
  });
}

export const valhalla = {
  id: 'valhalla',
  name: 'Valhalla',
  supportsTraffic: true,
  perLeg: true,

  async route(points, { bike, traffic }, signal) {
    const costing = 'bicycle';
    const costingOptions = { bicycle: { bicycle_type: BICYCLE_TYPE[bike] || 'Hybrid', use_roads: USE_ROADS[traffic] ?? 0.5 } };
    const data = await post('route', {
      locations: points.map(p => ({ lat: p.lat, lon: p.lon })),
      costing, costing_options: costingOptions, directions_type: 'none', elevation_interval: ELEVATION_INTERVAL,
    }, signal);
    // Mehrere Teilstücke (legs) zu einer Linie verbinden; der erste Punkt eines Teilstücks = letzter des vorigen
    let coords = [];
    for (const leg of data.trip.legs) {
      const part = withElevation(decodePolyline(leg.shape), leg.elevation, leg.elevation_interval || ELEVATION_INTERVAL);
      coords = coords.length ? coords.concat(part.slice(1)) : part;
    }
    const shape = data.trip.legs.length === 1 ? data.trip.legs[0].shape : null;
    const segments = shape ? await segmentsFor(shape, costing, coords, signal) : [];
    return { coords, segments };
  },
};
