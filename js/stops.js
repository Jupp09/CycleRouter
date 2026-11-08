/**
 * Verpflegungsstopps: Trinkwasserstellen, Supermärkte, Bäckereien, Cafés und Tankstellen entlang der Route
 * suchen, etwa alle `interval` Meter einen auswählen und die Route durch sie führen.
 *
 * Bei jeder Stelle zählt, ob sie bei der geschätzten Ankunft geöffnet hat – inklusive Feiertagen am Ort
 * (Bundesland bzw. Land) und typischen Öffnungszeiten von Ketten, wenn die Filiale selbst keine Angaben hat.
 */
import { openState, hasHolidayRule } from './openingHours.js';
import { regionsAlong, regionAtDistance } from './regions.js';
import { holidayLookup } from './holidays.js';
import { route } from './routing/index.js';
import { fetchPois } from './poiTiles.js';
import { withTypicalHours } from './chainHours.js';
import { timeline } from './timeline.js';
import { locateOnRoute, locateNearRoute, insertWaypoints } from './routeGeometry.js';

/** Maximale Entfernung von der Route (Luftlinie, m) – zugleich die Typen, die als Verpflegungsstopp infrage kommen. */
const MAX_OFFSET = { water: 400, supermarket: 1000, convenience: 800, fuel: 800, bakery: 600, cafe: 600 };
/** Vorrang unter geöffneten Läden: Supermarkt vor Bäckerei vor Café vor Laden/Tankstelle. */
const TYPE_BIAS = { supermarket: 0, bakery: 0.1, cafe: 0.2, convenience: 0.3, fuel: 0.3 };
const WINTER = [10, 11, 0, 1, 2]; // November bis März
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

/** Anzeige des Zustands einer Stelle bei Ankunft (siehe evaluate). */
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

/** Zustände, die als Warnung (orange) angezeigt werden. */
export const WARN_STATES = new Set(['unknown', 'unlikely', 'seasonal', 'closed', 'openHoliday', 'openTypical', 'closedTypical']);

// ---------- Öffnungszeiten ----------

/**
 * Öffnungsstatus eines Orts zur Zeit `eta` → {state: 'open' | 'closed' | 'unknown', typical, hours}.
 * `typical`: Es wurden die typischen Zeiten der Kette verwendet (siehe chainHours.js).
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
 * Bewertung einer Stelle zur Ankunftszeit → {tier, state} oder null (geschlossen). Kleinerer tier = besser:
 * 0 Trinkwasser · 1 geöffneter Laden · 2 Wasser mit Einschränkung · 3 Laden ohne Angaben · 4 vermutlich zu.
 * `holiday`: Feiertag am Ort der Stelle zur Ankunftszeit (oder null).
 */
function evaluate(poi, eta, holiday) {
  const oh = poi.tags.opening_hours;
  if (!oh && poi.typical) return evaluateTypical(poi, eta, holiday);
  let st = oh ? openState(oh, eta, DWELL_MIN, !!holiday) : 'unknown';
  // Freitext wie „Zur Zeit geschlossen“ / „closed“
  if (st === 'unknown' && oh && /geschlossen|closed|^off$/i.test(oh)) st = 'closed';
  if (st === 'closed') return null;

  if (poi.type === 'water') {
    if (poi.tags.seasonal && poi.tags.seasonal !== 'no' && WINTER.includes(eta.getMonth())) return { tier: 2, state: 'seasonal' };
    if (poi.tags.fee === 'yes') return { tier: 1, state: st === 'open' ? 'open' : 'free' };
    if (oh && st === 'unknown') return { tier: 2, state: 'unknown' };
    return { tier: 0, state: st === 'open' ? 'open' : 'free' };
  }

  const bias = TYPE_BIAS[poi.type] ?? 0.3;
  if (st === 'open') {
    // Feiertag ohne eigene PH-Regel: es wurden die Sonntagszeiten angenommen
    return holiday && !hasHolidayRule(oh) ? { tier: 1.5 + bias, state: 'openHoliday' } : { tier: 1 + bias, state: 'open' };
  }
  // Läden ohne Angaben haben sonn-/feiertags und nachts meist geschlossen – nur als letzte Wahl.
  // Ausnahme: Bäckereien haben sonn- und feiertags vormittags oft geöffnet.
  const hour = eta.getHours();
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

// ---------- Auswahl ----------

/**
 * Wählt Stopps: im Fenster (50 %–100 % des Intervalls nach dem letzten Stopp) zuerst Trinkwasser, dann
 * geöffnete Läden/Tankstellen, zuletzt solche mit unbekannten Öffnungszeiten. Innerhalb einer Stufe zählt:
 * möglichst spät im Fenster und nah an der Route. Nach einer Übernachtung wird neu gezählt.
 */
function plan(r, candidates, { interval, departure, bike, holidayFor }) {
  const eta = timeline(r, departure, bike, DWELL_MIN);
  const pausesOnDay = (stops, along) => stops.filter(s => eta.dayOf(s.along) === eta.dayOf(along)).length;
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
      const t = eta(c.along, pausesOnDay(stops, c.along));
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
    for (const t of [eta(seg.from), eta(to)]) {
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

/** Regionen entlang der Route und Feiertagsabfrage dafür – Fehler sind nicht fatal (dann ohne Feiertage). */
async function holidayContext(base, departure, bike, signal) {
  const regions = await regionsAlong(base, signal).catch(e => { if (e.name === 'AbortError') throw e; console.warn(e); return null; });
  if (!regions) return { regions: null, lookup: null };
  const arrival = timeline(base, departure, bike, DWELL_MIN)(base.distance, 10);
  const countries = new Set(regions.map(s => s.country).filter(Boolean));
  const lookup = await holidayLookup(countries, departure, arrival, signal)
    .catch(e => { if (e.name === 'AbortError') throw e; console.warn(e); return null; });
  return { regions, lookup };
}

/**
 * Ergänzt eine Route um Verpflegungsstopps.
 * Ergebnis: neue Route (durch die Stopps) mit `stops`, `gaps`, `regions`, `holidays` und `base`
 * (Route ohne Stopps). Bei Mehrtagestouren werden `origin`, `stays` und `stageStarts` weitergegeben.
 */
export async function addStops(base, { provider, opts, interval, departure, bike, signal }) {
  // Stellen sowie Regionen/Feiertage parallel laden
  const [pois, { regions, lookup }] = await Promise.all([
    fetchPois(base, signal, ['supply', 'food']),
    holidayContext(base, departure, bike, signal),
  ]);
  const regionFor = along => regionAtDistance(regions, along);
  const holidayFor = (along, date) => lookup?.(regionFor(along), date) ?? null;
  const info = {
    regions: regions || [],
    holidays: lookup ? holidayNotes(base, regions, lookup, departure, bike) : [],
    holidayCheck: !!lookup, // false = Feiertage konnten nicht geprüft werden
  };

  // Restaurants gehören nicht zu den Verpflegungsstopps (zu lange Pause) – nur Typen mit MAX_OFFSET
  const candidates = withTypicalHours(pois).filter(p => MAX_OFFSET[p.type]);
  const located = locateNearRoute(base, candidates, poi => MAX_OFFSET[poi.type]);
  const { stops, gaps } = plan(base, located, { interval, departure, bike, holidayFor });
  if (!stops.length) return { ...base, base, stops: [], gaps, ...info };

  // Route durch die Stopps führen
  const points = stops.map(s => ({ lat: s.poi.lat, lon: s.poi.lon, stop: true }));
  const wps = insertWaypoints(base, stops.map((s, i) => ({ along: s.along, point: points[i] })));
  const routed = await route(provider, wps, opts, signal);

  // Positionen und Ankunftszeiten auf der neuen Route bestimmen (Übernachtungen bleiben Tageswechsel)
  const along = locateOnRoute(routed, wps);
  routed.stageStarts = wps.flatMap((p, i) => (p.stay ? [along[i]] : []));
  const eta = timeline(routed, departure, bike, DWELL_MIN);
  const finalStops = [];
  wps.forEach((p, i) => {
    if (!p.stop) return;
    const s = stops[points.indexOf(p)];
    const t = eta(along[i], finalStops.filter(f => eta.dayOf(f.along) === eta.dayOf(along[i])).length);
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
  return { ...routed, base, origin: base.origin, stays: base.stays, stops: finalStops, gaps, ...info };
}
