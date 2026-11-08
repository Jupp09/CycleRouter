// Einteilung der Route nach Untergrund und Wegtyp.
// Ein Routenabschnitt ist {from, to, surface, waytype, estimated} mit Indizes in route.coords.

// Farben nach der Okabe-Ito-Palette: auch bei Rot-Grün-Schwäche (Protanopie, Deuteranopie) unterscheidbar
// (simuliert nach Machado 2009, kleinster Abstand ΔE ≈ 18). Unbefestigtes ist zusätzlich gestrichelt
// (`dash`), die Fähre gepunktet – so trägt nicht die Farbe allein die Information.
export const CATEGORIES = {
  surface: {
    asphalt: { label: 'Asphalt/Beton', color: '#64748b' },
    paving: { label: 'Pflaster', color: '#882255' },
    fine_gravel: { label: 'Feiner Schotter', color: '#e6c300', dash: 'dashed' },
    gravel: { label: 'Schotter', color: '#d55e00', dash: 'dashed' },
    natural: { label: 'Naturweg', color: '#009e73', dash: 'dashed' },
    unknown: { label: 'Unbekannt', color: '#cbd5e1' },
  },
  waytype: {
    cycleway: { label: 'Radweg', color: '#0072b2' },
    roadlane: { label: 'Straße mit Radspur', color: '#56b4e9' },
    main: { label: 'Hauptstraße', color: '#d55e00' },
    minor: { label: 'Nebenstraße', color: '#e69f00' },
    residential: { label: 'Wohn-/Anliegerstraße', color: '#94a3b8' },
    track: { label: 'Wirtschafts-/Feldweg', color: '#8c5a2b', dash: 'dashed' },
    path: { label: 'Pfad/Fußweg', color: '#009e73', dash: 'dashed' },
    ferry: { label: 'Fähre', color: '#882255', dash: 'dotted' },
    other: { label: 'Sonstiges', color: '#cbd5e1' },
  },
};

export const KIND_LABELS = { surface: 'Untergrund', waytype: 'Wegtyp' };

const SURFACE_TAGS = {
  asphalt: ['asphalt', 'paved', 'chipseal', 'concrete', 'metal', 'wood'],
  paving: ['paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'bricks'],
  fine_gravel: ['compacted', 'fine_gravel'],
  gravel: ['gravel', 'pebblestone', 'unpaved', 'rock'],
  natural: ['ground', 'dirt', 'earth', 'grass', 'sand', 'mud', 'woodchips', 'grass_paver'],
};
const SURFACE_BY_TAG = Object.fromEntries(
  Object.entries(SURFACE_TAGS).flatMap(([key, tags]) => tags.map(t => [t, key])),
);
const TRACKTYPE = { grade1: 'asphalt', grade2: 'fine_gravel', grade3: 'gravel', grade4: 'natural', grade5: 'natural' };

const MAIN = ['motorway', 'trunk', 'primary', 'secondary'];
const MINOR = ['tertiary', 'unclassified', 'road'];
const RESIDENTIAL = ['residential', 'living_street', 'service', 'pedestrian'];
const PATH = ['path', 'footway', 'bridleway', 'steps'];
const ROADS = [...MAIN, ...MINOR, ...RESIDENTIAL, 'cycleway'];
const LANE_VALUES = ['lane', 'track', 'shared_lane', 'opposite_lane', 'opposite_track'];

const baseHighway = h => (h || '').replace(/_link$/, '');

function classifySurface(tags, highway) {
  const s = tags.surface?.split(':')[0];
  if (s && SURFACE_BY_TAG[s]) return { surface: SURFACE_BY_TAG[s], estimated: false };
  if (TRACKTYPE[tags.tracktype]) return { surface: TRACKTYPE[tags.tracktype], estimated: true };
  if (!s && ROADS.includes(highway)) return { surface: 'asphalt', estimated: true };
  return { surface: 'unknown', estimated: false };
}

function classifyWaytype(tags, highway) {
  if (tags.route === 'ferry') return 'ferry';
  if (highway === 'cycleway') return 'cycleway';
  if ([...PATH, 'track', 'pedestrian'].includes(highway) && tags.bicycle === 'designated') return 'cycleway';
  if ([...MAIN, ...MINOR, ...RESIDENTIAL].includes(highway)) {
    const lane = ['cycleway', 'cycleway:right', 'cycleway:left', 'cycleway:both'].some(k => LANE_VALUES.includes(tags[k]));
    if (lane) return 'roadlane';
  }
  if (MAIN.includes(highway)) return 'main';
  if (MINOR.includes(highway)) return 'minor';
  if (RESIDENTIAL.includes(highway)) return 'residential';
  if (highway === 'track') return 'track';
  if (PATH.includes(highway)) return 'path';
  return 'other';
}

/** OSM-Tags im BRouter-Format ("highway=track surface=gravel …") einordnen. */
export function classifyOsmTags(tagString) {
  const tags = Object.fromEntries((tagString || '').split(' ').filter(Boolean).map(t => {
    const i = t.indexOf('=');
    return [t.slice(0, i), t.slice(i + 1)];
  }));
  const highway = baseHighway(tags.highway);
  return {
    ...classifySurface(tags, highway),
    waytype: classifyWaytype(tags, highway),
    icn: tags.route_bicycle_icn === 'yes', // Teil einer internationalen Radroute (EuroVelo)
    ncn: tags.route_bicycle_ncn === 'yes', // Teil eines nationalen Radfernwegs (z. B. D-Route)
  };
}

// OpenRouteService extra_info-Codes, siehe https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/
export const ORS_SURFACE = {
  0: 'unknown', 1: 'asphalt', 2: 'gravel', 3: 'asphalt', 4: 'asphalt', 5: 'paving', 6: 'asphalt', 7: 'asphalt',
  8: 'fine_gravel', 9: 'fine_gravel', 10: 'gravel', 11: 'natural', 12: 'natural', 13: 'unknown', 14: 'paving',
  15: 'natural', 16: 'natural', 17: 'natural', 18: 'natural',
};
export const ORS_WAYTYPE = {
  0: 'other', 1: 'main', 2: 'minor', 3: 'residential', 4: 'path', 5: 'track', 6: 'cycleway', 7: 'path', 8: 'path',
  9: 'ferry', 10: 'other',
};

/** Fasst direkt aufeinanderfolgende Abschnitte mit gleicher Einordnung zusammen. */
export function mergeSegments(segments) {
  const out = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.to === s.from && prev.surface === s.surface && prev.waytype === s.waytype
      && prev.estimated === s.estimated && prev.icn === s.icn && prev.ncn === s.ncn) {
      prev.to = s.to;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Abschnitt, der den Koordinaten-Index `i` enthält. */
export function segmentAt(segments, i) {
  return segments.find(s => i >= s.from && i < s.to) || segments[segments.length - 1];
}

/** Distanz je Kategorie, absteigend sortiert. Basis ist route.cum, damit die Summe der Gesamtdistanz entspricht. */
export function summarize(route, kind) {
  const totals = {};
  for (const s of route.segments) totals[s[kind]] = (totals[s[kind]] || 0) + route.cum[s.to] - route.cum[s.from];
  return Object.entries(totals)
    .filter(([, d]) => d > 0)
    .map(([key, distance]) => ({ key, ...CATEGORIES[kind][key], distance, share: distance / route.distance }))
    .sort((a, b) => b.distance - a.distance);
}

/**
 * Strecke auf Radfernwegen in m: {eurovelo, longDistance} – longDistance umfasst EuroVelo und nationale
 * Radfernwege. null, wenn der Provider das nicht liefert.
 */
export function longDistanceShare(route) {
  if (!route.segments?.length || route.segments[0].icn === undefined) return null;
  let eurovelo = 0, longDistance = 0;
  for (const s of route.segments) {
    const d = route.cum[s.to] - route.cum[s.from];
    if (s.icn) eurovelo += d;
    if (s.icn || s.ncn) longDistance += d;
  }
  return { eurovelo, longDistance };
}

/** Anteil der Strecke, deren Untergrund nur abgeleitet (nicht explizit getaggt) ist. */
export function estimatedShare(route) {
  let d = 0;
  for (const s of route.segments) if (s.estimated) d += route.cum[s.to] - route.cum[s.from];
  return d / route.distance;
}
