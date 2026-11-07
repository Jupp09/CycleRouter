import { estimateTime, sampleRoute, indexAtDistance } from './utils.js';
import { openState, hasHolidayRule } from './openingHours.js';
import { regionsAlong, regionAtDistance } from './regions.js';
import { holidayLookup } from './holidays.js';
import { route } from './routing/index.js';
import { tileKey, fetchTilesFromOverpass } from './poiSource.js';

/**
 * Verpflegungsstopps: Trinkwasserstellen, Supermärkte und Tankstellen aus OpenStreetMap (Overpass)
 * entlang der Route suchen, etwa alle `interval` Meter einen auswählen und die Route durch sie führen.
 */

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
  openHoliday: 'Feiertag – laut Sonntagszeiten geöffnet',
};

// ---------- Geometrie ----------

/** Schnelle Näherung der Entfernung in m (für kurze Distanzen ausreichend genau). */
function approxDist(aLat, aLon, bLat, bLon) {
  const dy = (bLat - aLat) * 110540;
  const dx = (bLon - aLon) * 111320 * Math.cos((aLat + bLat) * Math.PI / 360);
  return Math.hypot(dx, dy);
}

const sample = sampleRoute;
const indexAt = indexAtDistance;

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

// ---------- Kachel-Cache ----------
// Die öffentlichen Overpass-Server haben oft lange Warteschlangen (auch kleine Abfragen dauern dann
// 30 s). Deshalb werden Stellen pro Kachel (0,1° ≈ 11 × 7 km) gecacht – im Browser (IndexedDB, 7 Tage)
// und, wenn die App über server.mjs läuft, zusätzlich auf dem Server (Dateien, 30 Tage). Nur Kacheln,
// die in keinem Cache liegen, werden bei Overpass abgefragt.

const TILE_TTL = 7 * 24 * 3600 * 1000;
const memTiles = new Map(); // key → {t, pois}

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

// ---------- Server-Cache (server.mjs) ----------

const SERVER_API = new URL('../api/pois', import.meta.url);
let serverAvailable = true; // wird false, wenn die App statisch (ohne server.mjs) ausgeliefert wird

/** Kacheln über den lokalen Server laden → Map, oder null, wenn kein Server-Cache verfügbar ist. */
async function fetchTilesFromServer(keys, signal) {
  if (!serverAvailable) return null;
  let res;
  try {
    res = await fetch(SERVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiles: keys }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    serverAvailable = false;
    return null;
  }
  if (res.status === 404 || res.status === 405 || !res.headers.get('content-type')?.includes('json')) {
    serverAvailable = false;
    return null;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server-Fehler ${res.status}`);
  return new Map(Object.entries(data.tiles));
}

async function fetchPois(r, signal) {
  const keys = routeTiles(r);
  const cached = await loadTiles(keys);
  const missing = keys.filter(k => !cached.has(k));

  if (missing.length) {
    const fetched = await fetchTilesFromServer(missing, signal) ?? await fetchTilesFromOverpass(missing, { signal });
    await saveTiles(fetched);
    for (const [k, pois] of fetched) cached.set(k, pois);
  }

  const seen = new Set();
  return [...cached.values()].flat().filter(p => !seen.has(p.id) && seen.add(p.id));
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

/**
 * Bewertung einer Stelle zur Ankunftszeit → {tier, state} oder null (geschlossen). Kleinerer tier = besser.
 * `holiday`: Feiertag am Ort der Stelle zur Ankunftszeit (oder null).
 */
function evaluate(poi, eta, holiday) {
  const oh = poi.tags.opening_hours;
  let st = oh ? openState(oh, eta, DWELL_MIN, !!holiday) : 'unknown';
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
  if (st === 'open') {
    // Feiertag ohne eigene PH-Regel: es wurden die Sonntagszeiten angenommen
    return holiday && !hasHolidayRule(oh) ? { tier: 1.5 + bias, state: 'openHoliday' } : { tier: 1 + bias, state: 'open' };
  }
  // Läden ohne Angaben haben sonn-/feiertags und nachts meist geschlossen – nur als letzte Wahl
  const hour = eta.getHours();
  if (poi.type !== 'fuel' && (holiday || eta.getDay() === 0 || hour < 7 || hour >= 21)) return { tier: 4 + bias, state: 'unlikely' };
  return { tier: 3 + bias, state: 'unknown' };
}

/**
 * Wählt Stopps: im Fenster (50 %–100 % des Intervalls nach dem letzten Stopp) zuerst
 * Trinkwasser, dann geöffnete Läden/Tankstellen, zuletzt solche mit unbekannten Öffnungszeiten.
 * Innerhalb einer Stufe zählt: möglichst spät im Fenster und nah an der Route.
 */
function plan(r, candidates, { interval, departure, bike, holidayFor }) {
  const eta = timeline(r, departure, bike);
  const stops = [], gaps = [];
  let pos = 0;
  while (r.distance - pos > interval) {
    const lo = pos + interval * 0.5, hi = pos + interval;
    let best = null;
    for (const c of candidates) {
      if (c.along <= lo || c.along > hi) continue;
      const t = eta(c.along, stops.length);
      const holiday = holidayFor(c.along, t);
      const ev = evaluate(c.poi, t, holiday);
      if (!ev) continue;
      const score = ev.tier * 10 - 2 * (c.along - lo) / (hi - lo) + c.offset / MAX_OFFSET[c.poi.type];
      if (!best || score < best.score) best = { ...c, ...ev, eta: t, holiday, score };
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
  // Stellen, Regionen (Land/Bundesland) und Feiertage parallel laden
  const [pois, regions] = await Promise.all([
    fetchPois(base, signal),
    regionsAlong(base, signal).catch(e => { if (e.name === 'AbortError') throw e; console.warn(e); return null; }),
  ]);
  let lookup = null;
  if (regions) {
    const arrival = timeline(base, departure, bike)(base.distance, 10);
    const countries = new Set(regions.map(s => s.country).filter(Boolean));
    lookup = await holidayLookup(countries, departure, arrival, signal)
      .catch(e => { if (e.name === 'AbortError') throw e; console.warn(e); return null; });
  }
  const regionFor = along => regionAtDistance(regions, along);
  const holidayFor = (along, date) => lookup?.(regionFor(along), date) ?? null;
  const info = {
    regions: regions || [],
    holidays: lookup ? holidayNotes(base, regions, lookup, departure, bike) : [],
    holidayCheck: !!lookup, // false = Feiertage konnten nicht geprüft werden
  };

  const { stops, gaps } = plan(base, locatePois(base, pois), { interval, departure, bike, holidayFor });
  if (!stops.length) return { ...base, base, stops: [], gaps, ...info };

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
    // Region aus der Planung (Position auf der Basisroute), Feiertag zur neuen Ankunftszeit
    const region = regionFor(s.along);
    const holiday = lookup?.(region, t) ?? null;
    const ev = evaluate(s.poi, t, holiday) || { state: 'closed' };
    const type = STOP_TYPES[s.poi.type];
    finalStops.push({
      ...s, along: along[i], eta: t, state: ev.state, point: p, region, holiday,
      icon: type.icon, typeLabel: type.label, gpxSym: type.gpxSym,
    });
  });
  return { ...routed, base, stops: finalStops, gaps, ...info };
}

/**
 * Feiertage, die während der Fahrt in durchfahrenen Regionen gelten:
 * [{date, name, national, regions: [Abschnitt, …]}]
 */
function holidayNotes(r, regions, lookup, departure, bike) {
  const eta = timeline(r, departure, bike);
  const notes = new Map();
  regions.forEach((seg, i) => {
    if (!seg.country) return;
    const to = regions[i + 1]?.from ?? r.distance;
    // Ankunfts- und Abfahrtstag im Abschnitt (bei Touren über Mitternacht zwei Tage)
    for (const t of [eta(seg.from, 0), eta(to, 0)]) {
      const h = lookup(seg, t);
      if (!h) continue;
      const key = `${h.date}|${h.name}`;
      const note = notes.get(key) || { ...h, regions: [] };
      if (!note.regions.some(x => x.country === seg.country && x.region === seg.region)) note.regions.push(seg);
      notes.set(key, note);
    }
  });
  return [...notes.values()];
}
