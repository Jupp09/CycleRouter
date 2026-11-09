/**
 * Orte aus OpenStreetMap über Overpass, aufgeteilt in Kacheln (0,1° ≈ 11 × 7 km) und Datenebenen
 * (LAYERS). Jede Ebene wird getrennt geladen und gecacht – so lässt sich eine neue Ebene nachladen,
 * ohne vorhandene Kacheln erneut abzufragen. Wird vom Browser (js/poiTiles.js), vom lokalen Server
 * (server.mjs, Datei-Cache) und vom Datenauszug (scripts/build-poi-extract.mjs) gemeinsam genutzt – daher ohne
 * Abhängigkeiten zu Browser-APIs. Overpass-Abfrage (`statements`) und Auszug (`filters`) müssen dieselben
 * Objekte erfassen; eingeordnet wird beides mit toPoi.
 */
import { withTimeout } from './shared.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const TILE = 0.1;

export const tileKey = (lat, lon) => `${Math.floor(lat / TILE)}_${Math.floor(lon / TILE)}`;
export const isTileKey = key => /^-?\d{1,4}_-?\d{1,4}$/.test(key);

function tileBox(key) {
  const [i, j] = key.split('_').map(Number);
  return [i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE].map(v => v.toFixed(4)).join(',');
}

/**
 * Datenebenen: welche Orte abgefragt werden (Overpass-Anweisungen je Rechteck) und wie sie eingeordnet werden.
 * Ein Ort gehört genau zu einer Ebene; `classify` liefert nur Typen der eigenen Ebene.
 */
export const LAYERS = {
  // Versorgung: Trinkwasser, Supermärkte, Läden, Tankstellen
  supply: {
    statements: b => `
  nwr["amenity"~"^(drinking_water|water_point|fuel)$"](${b});
  node["man_made"="water_tap"]["drinking_water"="yes"](${b});
  nwr["shop"~"^(supermarket|convenience)$"](${b});`,
    // Dasselbe als Filter für `osmium tags-filter` (Datenauszug, scripts/build-poi-extract.mjs) – bei Änderungen
    // an `statements` mitziehen. Feinheiten wie drinking_water=yes prüft classify.
    filters: ['nwr/amenity=drinking_water,water_point,fuel', 'n/man_made=water_tap', 'nwr/shop=supermarket,convenience'],
    classify(tags) {
      if (tags.drinking_water === 'no' || ['private', 'no'].includes(tags.access)) return null;
      if (tags.amenity === 'drinking_water' || tags.amenity === 'water_point') return 'water';
      if (tags.man_made === 'water_tap' && tags.drinking_water === 'yes') return 'water';
      if (tags.shop === 'supermarket') return 'supermarket';
      if (tags.shop === 'convenience') return 'convenience';
      if (tags.amenity === 'fuel') return 'fuel';
      return null;
    },
  },
  // Gastronomie: Cafés, Restaurants, Bäckereien
  food: {
    statements: b => `
  nwr["amenity"~"^(cafe|restaurant)$"](${b});
  nwr["shop"="bakery"](${b});`,
    filters: ['nwr/amenity=cafe,restaurant', 'nwr/shop=bakery'],
    classify(tags) {
      if (['private', 'no'].includes(tags.access)) return null;
      if (tags.shop === 'bakery') return 'bakery'; // Bäckerei mit Café-Ecke bleibt Bäckerei
      if (tags.amenity === 'cafe') return 'cafe';
      if (tags.amenity === 'restaurant') return 'restaurant';
      return null;
    },
  },
};

// Übernachtung: Hotels, Motels, Pensionen/B&B, Hostels, Zeltplätze (für Mehrtagestouren)
// Einrichtungen, die nur Teilnehmer oder Gruppen aufnehmen, aber in OSM oft als Hostel/Pension eingetragen sind
const NOT_PUBLIC = /meditat|retreat|vipassana|dhamma|zen-?zentrum|ashram|seminar|bildungs|tagungs|schullandheim|jugendbildung|freizeitheim|klassenfahrt|pfadfinder|scout/i;

LAYERS.stay = {
  // v2: mit Datum der letzten Bearbeitung (veraltete Einträge erkennen) – alte Cache-Daten ohne Datum nicht verwenden
  cacheVersion: 2,
  meta: true,
  statements: b => `
  nwr["tourism"~"^(hotel|motel|guest_house|hostel|camp_site)$"](${b});`,
  filters: ['nwr/tourism=hotel,motel,guest_house,hostel,camp_site'],
  classify(tags) {
    if (['private', 'no', 'customers', 'members'].includes(tags.access) || tags.disused === 'yes') return null;
    if (tags.group_only === 'yes' || tags.reservation === 'members_only') return null;
    if (NOT_PUBLIC.test(`${tags.name || ''} ${tags.operator || ''} ${tags.description || ''}`)) return null;
    if (tags.tourism === 'camp_site') return tags.tents === 'no' ? null : 'camp_site'; // reine Wohnmobilplätze nicht
    if (['hotel', 'motel', 'guest_house', 'hostel'].includes(tags.tourism)) return tags.tourism;
    return null;
  },
};

/** Name, unter dem eine Ebene gecacht wird – ändert sich mit cacheVersion, damit alte Daten nicht weiterverwendet werden. */
export const cacheName = layer => (LAYERS[layer]?.cacheVersion ? `${layer}.v${LAYERS[layer].cacheVersion}` : layer);

export const isLayer = l => Object.hasOwn(LAYERS, l);
const LAYER_OF_TYPE = {
  cafe: 'food', restaurant: 'food', bakery: 'food',
  hotel: 'stay', motel: 'stay', guest_house: 'stay', hostel: 'stay', camp_site: 'stay',
};
/** Ebene, zu der ein Ort-Typ gehört. */
export const layerOfType = type => LAYER_OF_TYPE[type] || 'supply';

/** Nur die Tags, die für Auswahl, Anzeige und GPX gebraucht werden (hält die Caches klein). */
const KEEP_TAGS = ['opening_hours', 'seasonal', 'fee', 'brand',
  // Unterkünfte: Sterne, Preisangaben (Freitext), Webseite, Ort für die Preissuche
  'stars', 'charge', 'website', 'contact:website', 'addr:city', 'addr:place', 'addr:postcode',
  'check_date', 'phone', 'contact:phone'];

/**
 * OSM-Objekt → Ort einer Ebene, oder null, wenn es nicht dazugehört. Gemeinsam für Overpass und den
 * Datenauszug, damit beide Wege dieselben Daten liefern.
 * `obj`: {id: 'node/123', lat, lon, tags, timestamp?, version?} – bei Flächen der Mittelpunkt ihres Rechtecks.
 * `timestamp`: Overpass liefert ISO-Text, `osmium export` Sekunden seit 1970 – beides geht.
 */
export function toPoi(obj, layer) {
  const def = LAYERS[layer];
  const tags = obj.tags || {};
  const type = def.classify(tags);
  if (!type) return null;
  const keep = Object.fromEntries(KEEP_TAGS.filter(t => tags[t]).map(t => [t, tags[t]]));
  const poi = { id: obj.id, type, lat: obj.lat, lon: obj.lon, tags: keep, name: tags.name || tags.brand || '' };
  if (def.meta && obj.timestamp != null) {
    const iso = typeof obj.timestamp === 'number' ? new Date(obj.timestamp * 1000).toISOString() : String(obj.timestamp);
    poi.edited = iso.slice(0, 10);
    poi.version = obj.version;
  }
  return poi;
}

// ---------- Zellen des Datenauszugs ----------
// Der Datenauszug (scripts/build-poi-extract.mjs, server/extract.mjs) fasst 5 × 5 Kacheln zu einer Zelle
// (0,5°) zusammen – eine Datei je Zelle statt je Kachel und Ebene (Webhoster begrenzen oft die Dateianzahl).
export const CELL_TILES = 5;
export const CELL = TILE * CELL_TILES;
/** Zelle, in der eine Kachel liegt. */
export function cellOfTile(key) {
  const [i, j] = key.split('_').map(Number);
  return `${Math.floor(i / CELL_TILES)}_${Math.floor(j / CELL_TILES)}`;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Abgebrochen', 'AbortError')); }, { once: true });
});

/** `headers`: zusätzliche Header – der Server muss einen User-Agent mitschicken, sonst lehnt Overpass ab. */
async function overpass(query, { signal, headers = {} } = {}) {
  let lastError;
  for (const [n, endpoint] of OVERPASS.entries()) {
    // Hauptserver lehnt bei Überlast sofort ab → mehrfach mit kurzer Pause versuchen
    const main = n === 0;
    for (let attempt = 0; attempt < (main ? 5 : 1); attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
          signal: withTimeout(signal, main ? 90000 : 45000),
        });
        const busy = [429, 502, 503, 504].includes(res.status);
        if (!res.ok) throw Object.assign(new Error(busy ? 'Overpass ist ausgelastet' : `Overpass-Fehler ${res.status}`), { busy });
        const json = await res.json();
        // Bei Zeitüberschreitung liefert Overpass Status 200 mit leerer Liste und einem Hinweis
        if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
          throw Object.assign(new Error('Overpass-Zeitüberschreitung'), { busy: true });
        }
        return json;
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e;
        lastError = e.name === 'TimeoutError' ? new Error('Zeitüberschreitung') : e;
        if (!e.busy) break; // anderer Fehler oder Timeout → nächster Server
        await sleep(Math.min(1500 * 2 ** attempt, 6000), signal);
      }
    }
  }
  throw new Error(`Verpflegungsstellen konnten nicht geladen werden (${lastError?.message || 'Netzwerkfehler'}).`);
}

/**
 * Lädt mehrere Datenebenen für dieselben Kacheln mit *einer* Overpass-Abfrage → Map ebene → Map key → [poi].
 * Eine Abfrage statt einer je Ebene: Overpass erlaubt je Absender nur wenige gleichzeitige Abfragen, und
 * jede wartet für sich in der Warteschlange – das Zusammenfassen spart diese Wartezeit.
 *
 * Jede Ebene ordnet die Orte unabhängig ein – ein Ort kann so in zwei Ebenen landen (z. B. Hotel mit
 * Restaurant), genau wie bei getrennten Abfragen. Flächen (z. B. Supermarkt-Gebäude) werden der Kachel ihres
 * Mittelpunkts zugeordnet; liegt der außerhalb der angefragten Kacheln, entfällt die Fläche – sie ist dann
 * ohnehin weiter als die maximale Entfernung von der Route weg.
 */
export async function fetchLayersFromOverpass(keys, { layers = ['supply'], ...opts } = {}) {
  const defs = layers.map(l => [l, LAYERS[l]]);
  const boxes = keys.map(tileBox);
  const statements = defs.map(([, def]) => boxes.map(def.statements).join('')).join('');
  // meta: Datum/Version der letzten Bearbeitung (nur wo nötig – vergrößert die Antwort)
  const meta = defs.some(([, def]) => def.meta);
  const json = await overpass(`[out:json][timeout:90];(${statements}
);
out center tags${meta ? ' meta' : ''};`, opts);

  const result = new Map(defs.map(([l]) => [l, new Map(keys.map(k => [k, []]))]));
  const seen = new Set();
  for (const el of json.elements) {
    const id = `${el.type}/${el.id}`;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || seen.has(id)) continue;
    seen.add(id);
    const obj = { id, lat, lon, tags: el.tags, timestamp: el.timestamp, version: el.version };
    for (const [layer] of defs) {
      const poi = toPoi(obj, layer);
      if (poi) result.get(layer).get(tileKey(lat, lon))?.push(poi);
    }
  }
  return result;
}

/** Lädt eine Datenebene (`opts.layer`, Standard „supply“) für Kacheln von Overpass → Map key → [poi]. */
export async function fetchTilesFromOverpass(keys, { layer = 'supply', ...opts } = {}) {
  return (await fetchLayersFromOverpass(keys, { layers: [layer], ...opts })).get(layer);
}
