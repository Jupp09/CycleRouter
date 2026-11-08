import { estimateTime, sampleRoute, indexAtDistance } from './utils.js';
import { openState, hasHolidayRule, parseOpeningHours } from './openingHours.js';
import { regionsAlong, regionAtDistance } from './regions.js';
import { holidayLookup } from './holidays.js';
import { route } from './routing/index.js';
import { tileKey, fetchTilesFromOverpass } from './poiSource.js';

/**
 * Verpflegungsstopps: Trinkwasserstellen, Supermärkte, Bäckereien, Cafés und Tankstellen aus OpenStreetMap
 * (Overpass) entlang der Route suchen, etwa alle `interval` Meter einen auswählen und die Route durch sie führen.
 */

/** Maximale Entfernung von der Route (Luftlinie, m) – zugleich die Typen, die als Verpflegungsstopp infrage kommen. */
const MAX_OFFSET = { water: 400, supermarket: 1000, convenience: 800, fuel: 800, bakery: 600, cafe: 600 };
/** Vorrang unter geöffneten Läden: Supermarkt vor Bäckerei vor Café vor Laden/Tankstelle. */
const TYPE_BIAS = { supermarket: 0, bakery: 0.1, cafe: 0.2, convenience: 0.3, fuel: 0.3 };
/** Angenommene Aufenthaltsdauer je Stopp in Minuten (für die Ankunftszeit folgender Stopps). */
export const DWELL_MIN = 10;

export const STOP_TYPES = {
  water: { label: 'Trinkwasser', icon: '💧', gpxSym: 'Drinking Water' },
  supermarket: { label: 'Supermarkt', icon: '🛒', gpxSym: 'Shopping Center' },
  convenience: { label: 'Laden/Kiosk', icon: '🛒', gpxSym: 'Shopping Center' },
  fuel: { label: 'Tankstelle', icon: '⛽', gpxSym: 'Gas Station' },
  bakery: { label: 'Bäckerei', icon: '🥐', gpxSym: 'Shopping Center' },
  cafe: { label: 'Café', icon: '☕', gpxSym: 'Restaurant' },
};

export const STATE_LABELS = {
  free: 'frei zugänglich',
  open: 'geöffnet',
  seasonal: 'evtl. saisonal abgestellt',
  unknown: 'Öffnungszeiten unbekannt',
  unlikely: 'Öffnungszeiten unbekannt – sonntags/nachts evtl. zu',
  closed: 'bei Ankunft evtl. geschlossen',
  openHoliday: 'Feiertag – laut Sonntagszeiten geöffnet',
  openTypical: 'vermutlich geöffnet (typische Zeiten der Kette)',
  closedTypical: 'laut typischen Zeiten der Kette evtl. zu',
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
// 30 s). Deshalb werden Orte pro Kachel (0,1° ≈ 11 × 7 km) und Datenebene (Versorgung, Gastronomie)
// gecacht – im Browser (IndexedDB, 7 Tage) und, wenn die App über server.mjs läuft, zusätzlich auf dem
// Server (Dateien, 30 Tage). Nur Kachel-Ebenen, die in keinem Cache liegen, werden bei Overpass abgefragt.

const TILE_TTL = 7 * 24 * 3600 * 1000;
const memTiles = new Map(); // `${ebene}/${kachel}` → {t, pois}
const cacheKey = (layer, key) => `${layer}/${key}`;

/** Kacheln, die Punkte samt Rand (`m` Grad) berühren. */
function tilesNear(points, m) {
  const keys = new Set();
  for (const p of points) {
    for (const dLat of [-m, 0, m]) for (const dLon of [-m, 0, m]) keys.add(tileKey(p.lat + dLat, p.lon + dLon));
  }
  return [...keys];
}

/** Alle Kacheln, die die Route samt ~1 km Rand berührt. */
const routeTiles = r => tilesNear(sample(r, 250), 0.012);

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

/** Gecachte Kacheln einer Ebene → Map key → pois (nur frische). */
async function loadTiles(keys, layer) {
  const now = Date.now();
  const out = new Map();
  const fresh = e => e && now - e.t < TILE_TTL;
  const missing = keys.filter(k => {
    const e = memTiles.get(cacheKey(layer, k));
    if (fresh(e)) out.set(k, e.pois);
    return !fresh(e);
  });
  const d = await db();
  if (!d || !missing.length) return out;
  const get = (store, id) => new Promise(resolve => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  try {
    const store = d.transaction('poiTiles').objectStore('poiTiles');
    await Promise.all(missing.map(async k => {
      // Einträge aus der Zeit vor den Ebenen (Schlüssel ohne Präfix) enthalten die Versorgungs-Ebene
      const entry = await get(store, cacheKey(layer, k)) ?? (layer === 'supply' ? await get(store, k) : null);
      if (fresh(entry)) { memTiles.set(cacheKey(layer, k), entry); out.set(k, entry.pois); }
    }));
  } catch { /* Cache ist optional */ }
  return out;
}

async function saveTiles(entries, layer) {
  const t = Date.now();
  for (const [k, pois] of entries) memTiles.set(cacheKey(layer, k), { t, pois });
  const d = await db();
  if (!d) return;
  try {
    const store = d.transaction('poiTiles', 'readwrite').objectStore('poiTiles');
    for (const [k, pois] of entries) store.put({ t, pois }, cacheKey(layer, k));
  } catch { /* Cache ist optional */ }
}

// ---------- Server-Cache (server.mjs) ----------

const SERVER_API = new URL('../api/pois', import.meta.url);
let serverAvailable = true; // wird false, wenn die App statisch (ohne server.mjs) ausgeliefert wird

/**
 * Kacheln einer Ebene über den lokalen Server laden → Map, oder null, wenn kein Server-Cache verfügbar ist.
 * `cacheOnly`: nur, was der Server schon hat (Fehlendes lädt er im Hintergrund nach; es fehlt in der Map).
 */
async function fetchTilesFromServer(keys, layer, signal, cacheOnly = false) {
  if (!serverAvailable) return null;
  let res;
  try {
    res = await fetch(SERVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiles: keys, layers: [layer], cacheOnly }),
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
  // Älterer Server, der diese Datenebene noch nicht kennt (z. B. nicht neu gestartet) → direkt bei Overpass laden
  if (res.status === 400 && /Datenebene/i.test(data.error || '')) {
    console.warn(`Server kennt die Ebene „${layer}“ nicht – lade direkt von Overpass (Server neu starten!)`);
    return null;
  }
  if (!res.ok) throw new Error(data.error || `Server-Fehler ${res.status}`);
  return new Map(Object.entries(data.tiles));
}

/**
 * Orte einer Ebene in den Kacheln – Browser-Cache, sonst Server-Cache, sonst direkt Overpass.
 * `cacheOnly`: nie auf Overpass warten → {pois, complete: false}, wenn Kacheln (noch) fehlen.
 */
async function layerPois(keys, layer, signal, cacheOnly) {
  const cached = await loadTiles(keys, layer);
  const missing = keys.filter(k => !cached.has(k));
  if (missing.length) {
    let fetched = await fetchTilesFromServer(missing, layer, signal, cacheOnly);
    if (!fetched && !cacheOnly) {
      // Direkt bei Overpass – in Paketen, große Abfragen brechen bei Last ab
      fetched = new Map();
      for (let i = 0; i < missing.length; i += 40) {
        for (const [k, pois] of await fetchTilesFromOverpass(missing.slice(i, i + 40), { layer, signal })) fetched.set(k, pois);
      }
    }
    if (fetched) {
      await saveTiles(fetched, layer);
      for (const [k, pois] of fetched) cached.set(k, pois);
    }
  }
  return { pois: [...cached.values()].flat(), complete: cached.size === keys.length };
}

/**
 * Orte der angegebenen Ebenen entlang der Route (Kacheln samt ~1 km Rand).
 * Das Ergebnis-Array trägt `complete` = false, wenn mit `cacheOnly` nicht alle Kacheln vorhanden waren.
 */
export const fetchPois = (r, signal, layers = ['supply'], opts = {}) => fetchPoisInTiles(routeTiles(r), signal, layers, opts);

/** Orte der Ebenen rund um einzelne Punkte (`margin` in Grad, z. B. 0,03 ≈ 3 km) – etwa um Etappenenden. */
export const fetchPoisNear = (points, signal, layers, { margin = 0.03, ...opts } = {}) =>
  fetchPoisInTiles(tilesNear(points, margin), signal, layers, opts);

async function fetchPoisInTiles(keys, signal, layers, { cacheOnly = false } = {}) {
  const parts = await Promise.all(layers.map(l => layerPois(keys, l, signal, cacheOnly)));
  const seen = new Set();
  const out = parts.flatMap(p => p.pois).filter(p => !seen.has(p.id) && seen.add(p.id));
  out.complete = parts.every(p => p.complete);
  return out;
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

/**
 * Liefert along(m), Anzahl bisheriger Stopps desselben Tages → geschätzte Ankunftszeit.
 * Mehrtagestouren: `r.stageStarts` (m) sind die Übernachtungsorte – danach beginnt ein neuer Tag
 * zur selben Uhrzeit wie die Abfahrt. `fn.dayOf(along)` liefert den Tag (0, 1, …).
 */
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
  const starts = [0, ...(r.stageStarts || [])];
  const dayOf = along => { let d = 0; while (d + 1 < starts.length && starts[d + 1] <= along) d++; return d; };
  const fn = (along, stopsBefore) => {
    const d = dayOf(along);
    const from = starts[d];
    const i = indexAt(r, along), i0 = indexAt(r, from);
    const sec = estimateTime(along - from, (asc[i] || 0) - (asc[i0] || 0), bike) + stopsBefore * DWELL_MIN * 60;
    return new Date(departure.getTime() + d * 86400000 + sec * 1000);
  };
  fn.dayOf = dayOf;
  return fn;
}

/** Ankunftszeit an Position `along` (m) einer Route – ohne Pausen. */
export function arrivalAt(r, departure, bike) {
  const eta = timeline(r, departure, bike);
  return along => eta(along, 0);
}

/**
 * Öffnungsstatus eines Orts zur Zeit `eta` → {state: 'open' | 'closed' | 'unknown', typical, hours}.
 * `typical`: Es wurden die typischen Zeiten der Kette verwendet (siehe withTypicalHours).
 */
export function openingAt(poi, eta) {
  const own = poi.tags?.opening_hours;
  const hours = own || poi.typical?.hours;
  if (!hours) return { state: 'unknown', typical: false, hours: '' };
  let state = openState(hours, eta, DWELL_MIN);
  if (state === 'unknown' && own && /geschlossen|closed/i.test(own)) state = 'closed';
  return { state, typical: !own, hours };
}

/**
 * Bewertung einer Stelle zur Ankunftszeit → {tier, state} oder null (geschlossen). Kleinerer tier = besser.
 * `holiday`: Feiertag am Ort der Stelle zur Ankunftszeit (oder null).
 */
function evaluate(poi, eta, holiday) {
  const own = poi.tags.opening_hours;
  if (!own && poi.typical) return evaluateTypical(poi, eta, holiday);
  const oh = own;
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
  const bias = TYPE_BIAS[poi.type] ?? 0.3;
  if (st === 'open') {
    // Feiertag ohne eigene PH-Regel: es wurden die Sonntagszeiten angenommen
    return holiday && !hasHolidayRule(oh) ? { tier: 1.5 + bias, state: 'openHoliday' } : { tier: 1 + bias, state: 'open' };
  }
  // Läden ohne Angaben haben sonn-/feiertags und nachts meist geschlossen – nur als letzte Wahl
  const hour = eta.getHours();
  // Ausnahme: Bäckereien haben sonn- und feiertags vormittags oft geöffnet
  const bakeryMorning = poi.type === 'bakery' && hour >= 7 && hour < 12;
  if (poi.type !== 'fuel' && !bakeryMorning && (holiday || eta.getDay() === 0 || hour < 7 || hour >= 21)) {
    return { tier: 4 + bias, state: 'unlikely' };
  }
  return { tier: 3 + bias, state: 'unknown' };
}

/**
 * Filiale ohne eigene Angaben, aber mit typischen Öffnungszeiten ihrer Kette: etwas schlechter als echte
 * Angaben, aber deutlich besser als „unbekannt“. Laut typischen Zeiten geschlossen → nur letzte Wahl
 * (die Annahme kann falsch sein).
 */
function evaluateTypical(poi, eta, holiday) {
  const bias = TYPE_BIAS[poi.type] ?? 0.3;
  const st = openState(poi.typical.hours, eta, DWELL_MIN, !!holiday);
  if (st === 'open') return { tier: (holiday && !hasHolidayRule(poi.typical.hours) ? 1.8 : 1.3) + bias, state: 'openTypical' };
  return { tier: 4.5 + bias, state: 'closedTypical' };
}

// ---------- Typische Öffnungszeiten von Ketten ----------
// Fehlen bei einer Filiale die Öffnungszeiten, werden die häufigsten Zeiten derselben Kette aus allen in
// dieser Sitzung geladenen Kacheln übernommen – nur bei ausreichend klarer Datenlage.

const TYPICAL_MIN_SAMPLES = 3;   // mindestens so viele Filialen mit Angaben
const TYPICAL_MIN_SHARE = 0.4;   // und so viele davon mit genau diesen Zeiten

const normalizeHours = oh => oh.trim().replace(/\s*;\s*/g, '; ').replace(/\s+/g, ' ');

/** Kette einer Stelle: Marke (brand), sonst Name – nur für Läden und Tankstellen. */
function chainKey(poi) {
  if (poi.type === 'water') return null;
  const name = (poi.tags.brand || poi.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return name ? `${poi.type}|${name}` : null;
}

function typicalHours(pool) {
  const byChain = new Map(); // key → {label, counts: Map(hours → n), total}
  const seen = new Set();
  for (const p of pool) {
    const oh = p.tags.opening_hours;
    const key = chainKey(p);
    if (!oh || !key || seen.has(p.id) || !parseOpeningHours(oh)) continue; // nur verständliche Angaben
    seen.add(p.id);
    const c = byChain.get(key) || { label: p.tags.brand || p.name, counts: new Map(), total: 0 };
    const h = normalizeHours(oh);
    c.counts.set(h, (c.counts.get(h) || 0) + 1);
    c.total++;
    byChain.set(key, c);
  }
  const out = new Map();
  for (const [key, c] of byChain) {
    if (c.total < TYPICAL_MIN_SAMPLES) continue;
    const [hours, count] = [...c.counts].sort((a, b) => b[1] - a[1])[0];
    if (count / c.total >= TYPICAL_MIN_SHARE) out.set(key, { hours, count, total: c.total, chain: c.label });
  }
  return out;
}

/** Ergänzt Stellen ohne Öffnungszeiten um `typical`, sofern für ihre Kette typische Zeiten bekannt sind. */
export function withTypicalHours(pois) {
  const pool = [...memTiles.values()].flatMap(e => e.pois).concat(pois);
  const typical = typicalHours(pool);
  return pois.map(p => {
    if (p.tags.opening_hours) return p;
    const t = typical.get(chainKey(p));
    return t ? { ...p, typical: t } : p;
  });
}

/**
 * Wählt Stopps: im Fenster (50 %–100 % des Intervalls nach dem letzten Stopp) zuerst
 * Trinkwasser, dann geöffnete Läden/Tankstellen, zuletzt solche mit unbekannten Öffnungszeiten.
 * Innerhalb einer Stufe zählt: möglichst spät im Fenster und nah an der Route.
 */
function plan(r, candidates, { interval, departure, bike, holidayFor }) {
  const eta = timeline(r, departure, bike);
  const stops = [], gaps = [];
  const stageStarts = r.stageStarts || [];
  let pos = 0;
  while (r.distance - pos > interval) {
    const lo = pos + interval * 0.5, hi = pos + interval;
    // Übernachtung im Abschnitt: dort wird ohnehin aufgefüllt – am nächsten Morgen neu zählen
    const night = stageStarts.find(s => s > pos && s <= hi);
    if (night != null) { pos = night; continue; }
    let best = null;
    for (const c of candidates) {
      if (c.along <= lo || c.along > hi) continue;
      const day = eta.dayOf(c.along);
      const t = eta(c.along, stops.filter(s => eta.dayOf(s.along) === day).length);
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
    fetchPois(base, signal, ['supply', 'food']),
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

  // Restaurants gehören nicht zu den Verpflegungsstopps (zu lange Pause) – nur Typen mit MAX_OFFSET
  const candidates = withTypicalHours(pois).filter(p => MAX_OFFSET[p.type]);
  const { stops, gaps } = plan(base, locatePois(base, candidates), { interval, departure, bike, holidayFor });
  if (!stops.length) return { ...base, base, stops: [], gaps, ...info };

  // Stopps zwischen die vorhandenen Wegpunkte einsortieren
  const points = stops.map(s => ({ lat: s.poi.lat, lon: s.poi.lon, stop: true }));
  const wps = insertWaypoints(base, stops.map((s, i) => ({ along: s.along, point: points[i] })));

  const routed = await route(provider, wps, opts, signal);

  // Positionen und Ankunftszeiten auf der neuen Route bestimmen
  const along = locateSequential(routed, wps);
  routed.stageStarts = wps.flatMap((p, i) => (p.stay ? [along[i]] : []));
  const eta = timeline(routed, departure, bike);
  const finalStops = [];
  wps.forEach((p, i) => {
    if (!p.stop) return;
    const s = stops[points.indexOf(p)];
    const day = eta.dayOf(along[i]);
    const t = eta(along[i], finalStops.filter(f => eta.dayOf(f.along) === day).length);
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
  // Mehrtagestour: Übernachtungen und die Route ohne Übernachtungen (origin) weitergeben
  return { ...routed, base, origin: base.origin, stays: base.stays, stops: finalStops, gaps, ...info };
}

/**
 * Zusätzliche Wegpunkte an ihrer Position (`along`, m auf `base`) zwischen die vorhandenen Wegpunkte
 * einsortieren → neue Wegpunktliste für die Neuberechnung. items: [{along, point}]
 */
export function insertWaypoints(base, items) {
  const anchors = shapeAnchors(base);
  const anchorAlong = locateSequential(base, anchors);
  const wps = [];
  anchors.forEach((a, k) => {
    wps.push(a);
    if (k === anchors.length - 1) return;
    items.filter(it => it.along >= anchorAlong[k] && it.along < anchorAlong[k + 1])
      .sort((x, y) => x.along - y.along)
      .forEach(it => wps.push(it.point));
  });
  return wps;
}

/** Position (m) jedes Punkts auf der Route, in Reihenfolge. */
export const locateOnRoute = locateSequential;

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
