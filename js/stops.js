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

const poiCache = new WeakMap(); // je Routengeometrie

function classify(tags) {
  if (tags.drinking_water === 'no' || ['private', 'no'].includes(tags.access)) return null;
  if (tags.amenity === 'drinking_water' || tags.amenity === 'water_point') return 'water';
  if (tags.man_made === 'water_tap' && tags.drinking_water === 'yes') return 'water';
  if (tags.shop === 'supermarket') return 'supermarket';
  if (tags.shop === 'convenience') return 'convenience';
  if (tags.amenity === 'fuel') return 'fuel';
  return null;
}

/**
 * Rechtecke entlang der Route (je ~10 km Strecke, plus Rand) – für Overpass deutlich günstiger
 * als ein `around` mit langem Polygonzug. Die genaue Entfernung zur Route wird danach lokal geprüft.
 */
function corridorBoxes(r) {
  const margin = 0.012; // ≈ 1 km
  const boxes = [];
  let box = null, startAlong = 0;
  for (const p of sample(r, 250)) {
    if (!box || p.along - startAlong > 10000) {
      if (box) boxes.push(box);
      box = [p.lat, p.lon, p.lat, p.lon];
      startAlong = p.along;
    }
    box[0] = Math.min(box[0], p.lat); box[1] = Math.min(box[1], p.lon);
    box[2] = Math.max(box[2], p.lat); box[3] = Math.max(box[3], p.lon);
  }
  if (box) boxes.push(box);
  return boxes.map(([s, w, n, e]) => [s - margin, w - margin, n + margin, e + margin].map(v => v.toFixed(4)).join(','));
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Abgebrochen', 'AbortError')); }, { once: true });
});

async function overpass(query, signal) {
  let lastError;
  for (const endpoint of OVERPASS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal,
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
        if (e.name === 'AbortError') throw e;
        lastError = e;
        if (!e.busy) break; // anderer Fehler → nächster Server
        await sleep(2000 * (attempt + 1), signal);
      }
    }
  }
  throw new Error(`Verpflegungsstellen konnten nicht geladen werden (${lastError?.message || 'Netzwerkfehler'}).`);
}

async function fetchPois(r, signal) {
  if (poiCache.has(r.coords)) return poiCache.get(r.coords);

  const statements = corridorBoxes(r).map(b => `
  nwr["amenity"~"^(drinking_water|water_point|fuel)$"](${b});
  nwr["man_made"="water_tap"]["drinking_water"="yes"](${b});
  nwr["shop"~"^(supermarket|convenience)$"](${b});`).join('');
  const json = await overpass(`[out:json][timeout:90];(${statements}
);
out center tags;`, signal);

  const seen = new Set();
  const pois = json.elements.map(el => {
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) return null; // überlappende Rechtecke
    seen.add(id);
    const tags = el.tags || {};
    const type = classify(tags);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!type || lat == null) return null;
    return { id, type, lat, lon, tags, name: tags.name || tags.brand || '' };
  }).filter(Boolean);
  poiCache.set(r.coords, pois);
  return pois;
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
