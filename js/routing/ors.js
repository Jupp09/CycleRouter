import { storage } from '../utils.js';
import { ORS_SURFACE, ORS_WAYTYPE, mergeSegments } from '../surfaces.js';

const ENDPOINT = 'https://api.openrouteservice.org/v2/directions';

// ORS kennt kein Gravel-Profil; "cycling-regular" nutzt befestigte und unbefestigte Wege.
const PROFILES = { road: 'cycling-road', gravel: 'cycling-regular', trekking: 'cycling-regular' };

async function request(bike, body, signal) {
  const key = storage.get('orsKey', '');
  if (!key) throw new Error('Kein OpenRouteService-API-Key hinterlegt. Bitte in den Einstellungen (Zahnrad) eintragen.');

  let res;
  try {
    res = await fetch(`${ENDPOINT}/${PROFILES[bike]}/geojson`, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
      body: JSON.stringify({ elevation: true, instructions: false, extra_info: ['surface', 'waytype'], ...body }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('OpenRouteService ist nicht erreichbar. Internetverbindung prüfen.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('OpenRouteService lehnt den API-Key ab. Bitte in den Einstellungen prüfen.');
    if (res.status === 429) throw new Error('OpenRouteService-Kontingent erschöpft – bitte später erneut versuchen.');
    const msg = data.error?.message || data.error || res.statusText;
    if (data.error?.code === 2010) throw new Error('Ein Punkt liegt zu weit von einem befahrbaren Weg entfernt.');
    throw new Error('OpenRouteService-Fehler: ' + msg);
  }

  const feature = data.features[0];
  const coords = feature.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, ele ?? null]);
  return { coords, segments: parseExtras(feature.properties.extras, coords.length) };
}

/** ORS-extras ([[fromIdx, toIdx, code], …] je Merkmal) zu gemeinsamen Abschnitten zusammenführen. */
function parseExtras(extras, count) {
  if (!extras || count < 2) return [];
  const perIndex = (name, map, fallback) => {
    const out = new Array(count - 1).fill(fallback);
    for (const [from, to, code] of extras[name]?.values || []) {
      for (let i = from; i < to && i < out.length; i++) out[i] = map[code] ?? fallback;
    }
    return out;
  };
  const surface = perIndex('surface', ORS_SURFACE, 'unknown');
  const waytype = perIndex('waytype', ORS_WAYTYPE, 'other');
  return mergeSegments(surface.map((s, i) => ({ from: i, to: i + 1, surface: s, waytype: waytype[i], estimated: false })));
}

export const ors = {
  id: 'ors',
  name: 'OpenRouteService',
  supportsTraffic: false,

  route(points, { bike }, signal) {
    return request(bike, { coordinates: points.map(p => [p.lon, p.lat]) }, signal);
  },

  /** Nativer Rundkurs: ORS wählt die Schleife selbst. */
  roundTrip(start, length, seed, { bike }, signal) {
    return request(bike, {
      coordinates: [[start.lon, start.lat]],
      options: { round_trip: { length: Math.round(length), points: 4, seed } },
    }, signal);
  },
};
