import { estimateTime } from './utils.js';
import { openState } from './openingHours.js';
import { route } from './routing/index.js';

/**
 * Verpflegungsstopps: Trinkwasserstellen, Supermärkte und Tankstellen aus OpenStreetMap (Overpass)
 * entlang der Route suchen, etwa alle `interval` Meter einen auswählen und die Route durch sie führen.
 */

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Maximale Entfernung von der Route (Luftlinie, m). */
const MAX_OFFSET = { water: 400, supermarket: 1000, convenience: 800, fuel: 800 };
/** Angenommene Aufenthaltsdauer je Stopp in Minuten (für die Ankunftszeit folgender Stopps). */
export const DWELL_MIN = 10;

export const STOP_TYPES = {
  water: { label: 'Trinkwasser', icon: '💧', gpxSym: 'Drinking Water' },
  supermarket: { label: 'Supermarkt', icon: '🛒', gpxSym: 'Shopping Center' },
  convenience: { label: 'Laden/Kiosk', icon: '🛒', gpxSym: 'Shopping Center' },
  fuel: { label: 'Tankstelle', icon: '⛽', gpxSym: 'Gas Station' },
};

export const STATE_LABELS = {
  free: 'frei zugänglich',
  open: 'geöffnet',
  seasonal: 'evtl. saisonal abgestellt',
  unknown: 'Öffnungszeiten unbekannt',
  unlikely: 'Öffnungszeiten unbekannt – sonntags/nachts evtl. zu',
  closed: 'bei Ankunft evtl. geschlossen',
};

// ---------- Geometrie ----------

/** Schnelle Näherung der Entfernung in m (für kurze Distanzen ausreichend genau). */
function approxDist(aLat, aLon, bLat, bLon) {
  const dy = (bLat - aLat) * 110540;
  const dx = (bLon - aLon) * 111320 * Math.cos((aLat + bLat) * Math.PI / 360);
  return Math.hypot(dx, dy);
}

/** Punkte entlang der Route im Abstand von etwa `step` m: [{lat, lon, along}] */
function sample(r, step) {
  const out = [];
  let next = 0;
  r.coords.forEach((c, i) => {
    if (r.cum[i] >= next || i === r.coords.length - 1) {
      out.push({ lat: c[0], lon: c[1], along: r.cum[i] });
      next = r.cum[i] + step;
    }
  });
  return out;
}

/** Index der Koordinate an Position `along` (binäre Suche in r.cum). */
function indexAt(r, along) {
  let lo = 0, hi = r.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] < along) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Position (m ab Start) jedes Punkts auf der Route, in Reihenfolge der Punkte.
 * Gesucht wird vorwärts ab dem vorherigen Treffer; sobald der Punkt nah war und die Route sich
 * wieder entfernt, gilt er als passiert (wichtig bei Rundkursen und Hin-und-zurück-Strecken).
 */
function locateSequential(r, points) {
  let from = 0;
  return points.map(p => {
    let best = Infinity, bestIdx = from;
    for (let j = from; j < r.coords.length; j++) {
      const d = approxDist(p.lat, p.lon, r.coords[j][0], r.coords[j][1]);
      if (d < best) { best = d; bestIdx = j; }
      else if (best < 300 && d > best + 1000) break;
    }
    from = bestIdx;
    return r.cum[bestIdx];
  });
}

// ---------- Overpass ----------

function classify(tags) {
  if (tags.drinking_water === 'no' || ['private', 'no'].includes(tags.access)) return null;
  if (tags.amenity === 'drinking_water' || tags.amenity === 'water_point') return 'water';
  if (tags.man_made === 'water_tap' && tags.drinking_water === 'yes') return 'water';
  if (tags.shop === 'supermarket') return 'supermarket';
  if (tags.shop === 'convenience') return 'convenience';
  if (tags.amenity === 'fuel') return 'fuel';
  return null;
}

// ---------- Kachel-Cache ----------
// Die öffentlichen Overpass-Server haben oft lange Warteschlangen (auch kleine Abfragen dauern dann
// 30 s). Deshalb werden Stellen pro Kachel (0,1° ≈ 11 × 7 km) dauerhaft im Browser gespeichert und
// nur fehlende Kacheln abgefragt.

const TILE = 0.1;
const TILE_TTL = 7 * 24 * 3600 * 1000;
const memTiles = new Map(); // key → {t, pois}

const tileKey = (lat, lon) => `${Math.floor(lat / TILE)}_${Math.floor(lon / TILE)}`;
function tileBox(key) {
  const [i, j] = key.split('_').map(Number);
  return [i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE].map(v => v.toFixed(4)).join(',');
}

/** Alle Kacheln, die die Route samt ~1 km Rand berührt. */
function routeTiles(r) {
  const m = 0.012;
  const keys = new Set();
  for (const p of sample(r, 250)) {
    for (const dLat of [-m, m]) for (const dLon of [-m, m]) keys.add(tileKey(p.lat + dLat, p.lon + dLon));
  }
  return [...keys];
}

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('cyclerouter', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('poiTiles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null); // z. B. privater Modus → nur Speicher-Cache
  return dbPromise;
}

async function loadTiles(keys) {
  const now = Date.now();
  const out = new Map();
  const fresh = e => e && now - e.t < TILE_TTL;
  const missing = keys.filter(k => { const e = memTiles.get(k); if (fresh(e)) out.set(k, e.pois); return !fresh(e); });
  const d = await db();
  if (!d || !missing.length) return out;
  await new Promise(resolve => {
    try {
      const store = d.transaction('poiTiles').objectStore('poiTiles');
      let pending = missing.length;
      for (const k of missing) {
        const req = store.get(k);
        req.onsuccess = () => {
          if (fresh(req.result)) { memTiles.set(k, req.result); out.set(k, req.result.pois); }
          if (--pending === 0) resolve();
        };
        req.onerror = () => { if (--pending === 0) resolve(); };
      }
    } catch { resolve(); }
  });
  return out;
}

async function saveTiles(entries) {
  const t = Date.now();
  for (const [k, pois] of entries) memTiles.set(k, { t, pois });
  const d = await db();
  if (!d) return;
  try {
    const store = d.transaction('poiTiles', 'readwrite').objectStore('poiTiles');
    for (const [k, pois] of entries) store.put({ t, pois }, k);
  } catch { /* Cache ist optional */ }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Abgebrochen', 'AbortError')); }, { once: true });
});

/** Abbruch durch den Aufrufer oder nach `ms` (dann TimeoutError). */
function withTimeout(signal, ms) {
  if (!AbortSignal.any || !AbortSignal.timeout) return signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function overpass(query, signal) {
  let lastError;
  for (const [n, endpoint] of OVERPASS.entries()) {
    // Hauptserver lehnt bei Überlast sofort ab → mehrfach mit kurzer Pause versuchen
    const main = n === 0;
    for (let attempt = 0; attempt < (main ? 5 : 1); attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

/** Nur die Tags, die für Auswahl, Anzeige und GPX gebraucht werden (hält den Cache klein). */
const KEEP_TAGS = ['opening_hours', 'seasonal', 'fee'];

async function fetchPois(r, signal) {
  const keys = routeTiles(r);
  const cached = await loadTiles(keys);
  const missing = keys.filter(k => !cached.has(k));
  const extra = []; // Flächen, deren Mittelpunkt außerhalb der abgefragten Kacheln liegt

  if (missing.length) {
    const statements = missing.map(tileBox).map(b => `
  nwr["amenity"~"^(drinking_water|water_point|fuel)$"](${b});
  node["man_made"="water_tap"]["drinking_water"="yes"](${b});
  nwr["shop"~"^(supermarket|convenience)$"](${b});`).join('');
    const json = await overpass(`[out:json][timeout:90];(${statements}
);
out center tags;`, signal);

    const fetched = new Map(missing.map(k => [k, []]));
    const seen = new Set();
    for (const el of json.elements) {
      const id = `${el.type}/${el.id}`;
      const tags = el.tags || {};
      const type = classify(tags);
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (!type || lat == null || seen.has(id)) continue;
      seen.add(id);
      const keep = Object.fromEntries(KEEP_TAGS.filter(t => tags[t]).map(t => [t, tags[t]]));
      const poi = { id, type, lat, lon, tags: keep, name: tags.name || tags.brand || '' };
      (fetched.get(tileKey(lat, lon)) || extra).push(poi);
    }
    await saveTiles(fetched);
    for (const [k, pois] of fetched) cached.set(k, pois);
  }

  const seen = new Set();
  return [...cached.values(), extra].flat().filter(p => !seen.has(p.id) && seen.add(p.id));
}

/** Jede Stelle wird an jeder Passage der Route (z. B. Hin- und Rückweg) einmal Kandidat. */
function locatePois(r, pois) {
  const samples = sample(r, 100);
  const out = [];
  for (const poi of pois) {
    const max = MAX_OFFSET[poi.type];
    const latTol = max / 110000;
    let run = null;
    for (const s of samples) {
      const d = Math.abs(s.lat - poi.lat) > latTol ? Infinity : approxDist(s.lat, s.lon, poi.lat, poi.lon);
      if (d <= max) {
        if (!run || d < run.offset) run = { ...(run || {}), along: s.along, offset: d, poi };
      } else if (run) {
        out.push(run);
        run = null;
      }
    }
    if (run) out.push(run);
  }
  return out;
}

// ---------- Zeitachse ----------

/** Liefert along(m), Anzahl bisheriger Stopps → geschätzte Ankunftszeit. */
function timeline(r, departure, bike) {
  // Kumulierter Anstieg je Koordinate, mit derselben Hysterese wie computeStats
  const asc = [];
  let ref = r.coords.find(c => c[2] != null)?.[2], total = 0;
  for (const c of r.coords) {
    const e = c[2];
    if (e != null && ref != null) {
      if (e - ref >= 4) { total += e - ref; ref = e; }
      else if (ref - e >= 4) ref = e;
    }
    asc.push(total);
  }
  return (along, stopsBefore) => {
    const i = indexAt(r, along);
    const sec = estimateTime(along, asc[i] || 0, bike) + stopsBefore * DWELL_MIN * 60;
    return new Date(departure.getTime() + sec * 1000);
  };
}

/** Bewertung einer Stelle zur Ankunftszeit → {tier, state} oder null (geschlossen). Kleinerer tier = besser. */
function evaluate(poi, eta) {
  const oh = poi.tags.opening_hours;
  let st = oh ? openState(oh, eta, DWELL_MIN) : 'unknown';
  // Freitext wie „Zur Zeit geschlossen“ / „closed“
  if (st === 'unknown' && oh && /geschlossen|closed|^off$/i.test(oh)) st = 'closed';
  if (st === 'closed') return null;
  if (poi.type === 'water') {
    const winter = [10, 11, 0, 1, 2].includes(eta.getMonth()); // Nov–März
    if (poi.tags.seasonal && poi.tags.seasonal !== 'no' && winter) return { tier: 2, state: 'seasonal' };
    if (poi.tags.fee === 'yes') return { tier: 1, state: st === 'open' ? 'open' : 'free' };
    if (oh && st === 'unknown') return { tier: 2, state: 'unknown' };
    return { tier: 0, state: st === 'open' ? 'open' : 'free' };
  }
  const bias = poi.type === 'supermarket' ? 0 : 0.3; // Supermarkt leicht bevorzugt
  if (st === 'open') return { tier: 1 + bias, state: 'open' };
  // Läden ohne Angaben haben sonntags und nachts meist geschlossen – nur als letzte Wahl
  const hour = eta.getHours();
  if (poi.type !== 'fuel' && (eta.getDay() === 0 || hour < 7 || hour >= 21)) return { tier: 4 + bias, state: 'unlikely' };
  return { tier: 3 + bias, state: 'unknown' };
}

/**
 * Wählt Stopps: im Fenster (50 %–100 % des Intervalls nach dem letzten Stopp) zuerst
 * Trinkwasser, dann geöffnete Läden/Tankstellen, zuletzt solche mit unbekannten Öffnungszeiten.
 * Innerhalb einer Stufe zählt: möglichst spät im Fenster und nah an der Route.
 */
function plan(r, candidates, { interval, departure, bike }) {
  const eta = timeline(r, departure, bike);
  const stops = [], gaps = [];
  let pos = 0;
  while (r.distance - pos > interval) {
    const lo = pos + interval * 0.5, hi = pos + interval;
    let best = null;
    for (const c of candidates) {
      if (c.along <= lo || c.along > hi) continue;
      const t = eta(c.along, stops.length);
      const ev = evaluate(c.poi, t);
      if (!ev) continue;
      const score = ev.tier * 10 - 2 * (c.along - lo) / (hi - lo) + c.offset / MAX_OFFSET[c.poi.type];
      if (!best || score < best.score) best = { ...c, ...ev, eta: t, score };
    }
    if (best) { stops.push(best); pos = best.along; }
    else { gaps.push({ from: pos, to: hi }); pos = hi; }
  }
  return { stops, gaps };
}

/** Wegpunkte, die die Form einer Route festhalten, falls der Provider keine liefert (ORS-Rundkurs). */
function shapeAnchors(r) {
  if (r.waypoints.length >= 2) return r.waypoints;
  const start = r.waypoints[0];
  const at = f => { const c = r.coords[indexAt(r, r.distance * f)]; return { lat: c[0], lon: c[1] }; };
  return [start, at(0.25), at(0.5), at(0.75), start];
}

/**
 * Ergänzt eine Route um Verpflegungsstopps.
 * Ergebnis: neue Route (durch die Stopps) mit `stops`, `gaps` und `base` (Route ohne Stopps).
 */
export async function addStops(base, { provider, opts, interval, departure, bike, signal }) {
  const pois = await fetchPois(base, signal);
  const { stops, gaps } = plan(base, locatePois(base, pois), { interval, departure, bike });
  if (!stops.length) return { ...base, base, stops: [], gaps };

  // Stopps zwischen die vorhandenen Wegpunkte einsortieren
  const anchors = shapeAnchors(base);
  const anchorAlong = locateSequential(base, anchors);
  const points = stops.map(s => ({ lat: s.poi.lat, lon: s.poi.lon, stop: true }));
  const wps = [];
  anchors.forEach((a, k) => {
    wps.push(a);
    if (k === anchors.length - 1) return;
    stops.forEach((s, i) => {
      if (s.along >= anchorAlong[k] && s.along < anchorAlong[k + 1]) wps.push(points[i]);
    });
  });

  const routed = await route(provider, wps, opts, signal);

  // Positionen und Ankunftszeiten auf der neuen Route bestimmen
  const along = locateSequential(routed, wps);
  const eta = timeline(routed, departure, bike);
  const finalStops = [];
  wps.forEach((p, i) => {
    if (!p.stop) return;
    const s = stops[points.indexOf(p)];
    const t = eta(along[i], finalStops.length);
    const ev = evaluate(s.poi, t) || { state: 'closed' };
    const type = STOP_TYPES[s.poi.type];
    finalStops.push({
      ...s, along: along[i], eta: t, state: ev.state, point: p,
      icon: type.icon, typeLabel: type.label, gpxSym: type.gpxSym,
    });
  });
  return { ...routed, base, stops: finalStops, gaps };
}
