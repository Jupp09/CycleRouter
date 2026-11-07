/**
 * Orte aus OpenStreetMap über Overpass, aufgeteilt in Kacheln (0,1° ≈ 11 × 7 km) und Datenebenen
 * (LAYERS). Jede Ebene wird getrennt geladen und gecacht – so lässt sich eine neue Ebene nachladen,
 * ohne vorhandene Kacheln erneut abzufragen. Wird vom Browser (js/stops.js) und vom lokalen Server
 * (server.mjs, Datei-Cache) gemeinsam genutzt – daher ohne Abhängigkeiten zu Browser-APIs.
 */

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
    classify(tags) {
      if (['private', 'no'].includes(tags.access)) return null;
      if (tags.shop === 'bakery') return 'bakery'; // Bäckerei mit Café-Ecke bleibt Bäckerei
      if (tags.amenity === 'cafe') return 'cafe';
      if (tags.amenity === 'restaurant') return 'restaurant';
      return null;
    },
  },
};

export const isLayer = l => Object.hasOwn(LAYERS, l);
/** Ebene, zu der ein Ort-Typ gehört. */
export const layerOfType = type => (['cafe', 'restaurant', 'bakery'].includes(type) ? 'food' : 'supply');

/** Nur die Tags, die für Auswahl, Anzeige und GPX gebraucht werden (hält die Caches klein). */
const KEEP_TAGS = ['opening_hours', 'seasonal', 'fee', 'brand'];

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Abgebrochen', 'AbortError')); }, { once: true });
});

/** Abbruch durch den Aufrufer oder nach `ms` (dann TimeoutError). */
function withTimeout(signal, ms) {
  if (!AbortSignal.any || !AbortSignal.timeout) return signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

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
 * Lädt eine Datenebene (`opts.layer`, Standard „supply“) für Kacheln von Overpass → Map key → [poi].
 * Flächen (z. B. Supermarkt-Gebäude) werden der Kachel ihres Mittelpunkts zugeordnet; liegt der außerhalb
 * der angefragten Kacheln, entfällt die Fläche – sie ist dann ohnehin weiter als die maximale Entfernung
 * von der Route weg.
 */
export async function fetchTilesFromOverpass(keys, { layer = 'supply', ...opts } = {}) {
  const def = LAYERS[layer];
  const statements = keys.map(tileBox).map(def.statements).join('');
  const json = await overpass(`[out:json][timeout:90];(${statements}
);
out center tags;`, opts);

  const tiles = new Map(keys.map(k => [k, []]));
  const seen = new Set();
  for (const el of json.elements) {
    const id = `${el.type}/${el.id}`;
    const tags = el.tags || {};
    const type = def.classify(tags);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!type || lat == null || seen.has(id)) continue;
    seen.add(id);
    const keep = Object.fromEntries(KEEP_TAGS.filter(t => tags[t]).map(t => [t, tags[t]]));
    tiles.get(tileKey(lat, lon))?.push({ id, type, lat, lon, tags: keep, name: tags.name || tags.brand || '' });
  }
  return tiles;
}
