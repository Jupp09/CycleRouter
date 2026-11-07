import { classifyOsmTags, mergeSegments } from '../surfaces.js';
import { haversine } from '../utils.js';

const ENDPOINT = 'https://brouter.de/brouter';

const PROFILES = {
  road: { normal: 'fastbike', low: 'fastbike-lowtraffic', verylow: 'fastbike-verylowtraffic' },
  gravel: { normal: 'gravel', low: 'gravel', verylow: 'gravel' },
};

function translateError(text) {
  if (/not mapped|no track found|position not/i.test(text)) {
    return 'Ein Punkt liegt zu weit von einem befahrbaren Weg entfernt.';
  }
  if (/retry later|watchdog|timeout/i.test(text)) {
    return 'BRouter ist gerade ausgelastet – bitte gleich noch einmal versuchen.';
  }
  return 'BRouter-Fehler: ' + text.slice(0, 200);
}

export const brouter = {
  id: 'brouter',
  name: 'BRouter',
  supportsTraffic: true,

  /** points: [{lat, lon}, ...] → {coords: [[lat, lon, ele], ...]} */
  async route(points, { bike, traffic }, signal) {
    const lonlats = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
    const profile = PROFILES[bike][traffic] || PROFILES[bike].normal;
    const url = `${ENDPOINT}?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}&alternativeidx=0&format=geojson`;

    let res;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('BRouter ist nicht erreichbar. Internetverbindung prüfen.');
    }
    const text = await res.text();
    if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(translateError(text));

    const feature = JSON.parse(text).features[0];
    const coords = feature.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, ele ?? null]);
    return { coords, segments: parseSegments(feature.properties.messages, coords) };
  },
};

/**
 * BRouter-Messages: je Zeile der Endpunkt eines Abschnitts (Mikrograd), seine Länge und die OSM-Tags.
 * Der Endpunkt wird in der Geometrie gesucht; gelingt das nicht, wird über die kumulierte Länge zugeordnet.
 */
function parseSegments(messages, coords) {
  if (!messages || messages.length < 2) return [];
  const [header, ...rows] = messages;
  const col = name => header.indexOf(name);
  const iLon = col('Longitude'), iLat = col('Latitude'), iDist = col('Distance'), iTags = col('WayTags');

  let cum = null;
  const indexAtDistance = d => {
    if (!cum) {
      cum = [0];
      for (let i = 1; i < coords.length; i++) {
        cum.push(cum[i - 1] + haversine({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat: coords[i][0], lon: coords[i][1] }));
      }
    }
    const i = cum.findIndex(c => c >= d);
    return i < 0 ? coords.length - 1 : i;
  };

  const segments = [];
  let from = 0, travelled = 0;
  for (const row of rows) {
    travelled += Number(row[iDist]);
    const lon = Number(row[iLon]), lat = Number(row[iLat]);
    let to = -1;
    for (let j = from + 1; j < coords.length; j++) {
      if (Math.abs(Math.round(coords[j][1] * 1e6) - lon) <= 1 && Math.abs(Math.round(coords[j][0] * 1e6) - lat) <= 1) { to = j; break; }
    }
    if (to < 0) to = Math.max(from + 1, indexAtDistance(travelled));
    if (to >= coords.length) break;
    segments.push({ from, to, ...classifyOsmTags(row[iTags]) });
    from = to;
  }
  if (segments.length) segments[segments.length - 1].to = coords.length - 1;
  return mergeSegments(segments);
}
