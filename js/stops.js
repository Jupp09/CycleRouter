/**
 * Verpflegung entlang der Route:
 *
 * - **Verpflegungsstopps** mit Essen (Supermärkte, Läden, Bäckereien, Cafés, Restaurants und – im Stil
 *   „zügig“ – Tankstellen): etwa alle `interval` Meter einer, die Route wird durch sie geführt.
 * - **Trinkwasser**: alle öffentlichen, kostenlosen Wasserstellen nahe der Route, nur angezeigt (kein Umweg),
 *   dazu ein Hinweis auf lange Strecken ohne Wasser.
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

/** Maximale Entfernung von der Route (Luftlinie, m) für Verpflegungsstopps. */
const MAX_OFFSET = { supermarket: 1000, convenience: 800, fuel: 800, bakery: 600, cafe: 600, restaurant: 600 };
/** Trinkwasser wird ohne Umweg angezeigt – daher nur Stellen nahe an der Route. */
const WATER_OFFSET = 400;
/** Wasserstellen, die entlang der Route näher als das beieinander liegen (z. B. mehrere Hähne auf einem Friedhof), zählen als eine. */
const WATER_MERGE = 150;
/** Ab so viel Strecke (m) ohne Trinkwasser gibt es einen Hinweis. */
export const WATER_GAP = 50000;
const WINTER = [10, 11, 0, 1, 2]; // November bis März

/**
 * Pausenstil (Einstellung, `state.supply.style`):
 * - `fast`: Stoppzeiten kurz halten – Supermarkt und Tankstelle, kurze Pause.
 * - `relaxed`: gemütliche Tour – lieber Café, Bäckerei oder Restaurant, keine Tankstellen, längere Pause.
 * `bias`: Vorrang innerhalb derselben Stufe (kleiner = lieber); Typen ohne Eintrag kommen nicht infrage.
 * `dwell`: angenommene Aufenthaltsdauer je Stopp in Minuten (für die Ankunftszeit folgender Stopps).
 */
export const STYLES = {
  fast: {
    label: 'Zügig', dwell: 10,
    bias: { supermarket: 0, bakery: 0.1, fuel: 0.2, convenience: 0.25, cafe: 0.3, restaurant: 0.4 },
  },
  relaxed: {
    label: 'Gemütlich', dwell: 30,
    bias: { cafe: 0, bakery: 0.1, restaurant: 0.2, supermarket: 0.3, convenience: 0.4 },
  },
};
export const styleOf = id => STYLES[id] || STYLES.fast;
/** Größte Pause aller Stile – für die grobe Abschätzung der Ankunft in holidayContext. */
const MAX_DWELL = Math.max(...Object.values(STYLES).map(s => s.dwell));

export const STOP_TYPES = {
  water: { label: 'Trinkwasser', icon: '💧', gpxSym: 'Drinking Water' },
  supermarket: { label: 'Supermarkt', icon: '🛒', gpxSym: 'Shopping Center' },
  convenience: { label: 'Laden/Kiosk', icon: '🛒', gpxSym: 'Shopping Center' },
  fuel: { label: 'Tankstelle', icon: '⛽', gpxSym: 'Gas Station' },
  bakery: { label: 'Bäckerei', icon: '🥐', gpxSym: 'Shopping Center' },
  cafe: { label: 'Café', icon: '☕', gpxSym: 'Restaurant' },
  restaurant: { label: 'Restaurant', icon: '🍽️', gpxSym: 'Restaurant' },
};

/** Anzeige des Zustands einer Stelle bei Ankunft (siehe evaluate bzw. waterState). */
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
export function openingAt(poi, eta, dwellMin = STYLES.fast.dwell) {
  const own = poi.tags?.opening_hours;
  const hours = own || poi.typical?.hours;
  if (!hours) return { state: 'unknown', typical: false, hours: '' };
  let state = openState(hours, eta, dwellMin);
  if (state === 'unknown' && own && /geschlossen|closed/i.test(own)) state = 'closed';
  return { state, typical: !own, hours };
}

/** Öffnungsstatus nach `opening_hours`, Freitext wie „Zur Zeit geschlossen“ / „closed“ zählt als zu. */
function ownState(oh, eta, dwellMin, holiday) {
  const st = oh ? openState(oh, eta, dwellMin, !!holiday) : 'unknown';
  return st === 'unknown' && oh && /geschlossen|closed|^off$/i.test(oh) ? 'closed' : st;
}

/**
 * Bewertung eines Verpflegungsstopps zur Ankunftszeit → {tier, state} oder null (geschlossen bzw. im
 * Pausenstil nicht vorgesehen). Kleinerer tier = besser: 1 geöffnet · 3 ohne Angaben · 4 vermutlich zu.
 * `holiday`: Feiertag am Ort der Stelle zur Ankunftszeit (oder null).
 */
function evaluate(poi, eta, holiday, style) {
  const bias = style.bias[poi.type];
  if (bias == null) return null;
  const oh = poi.tags.opening_hours;
  if (!oh && poi.typical) return evaluateTypical(poi, eta, holiday, style, bias);
  const st = ownState(oh, eta, style.dwell, holiday);
  if (st === 'closed') return null;
  if (st === 'open') {
    // Feiertag ohne eigene PH-Regel: es wurden die Sonntagszeiten angenommen
    return holiday && !hasHolidayRule(oh) ? { tier: 1.5 + bias, state: 'openHoliday' } : { tier: 1 + bias, state: 'open' };
  }
  // Läden ohne Angaben haben sonn-/feiertags und nachts meist geschlossen – nur als letzte Wahl.
  // Ausnahmen: Tankstellen; Bäckereien haben sonn- und feiertags vormittags oft geöffnet.
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
function evaluateTypical(poi, eta, holiday, style, bias) {
  const st = openState(poi.typical.hours, eta, style.dwell, !!holiday);
  if (st === 'open') return { tier: (holiday && !hasHolidayRule(poi.typical.hours) ? 1.8 : 1.3) + bias, state: 'openTypical' };
  return { tier: 4.5 + bias, state: 'closedTypical' };
}

/** Zustand einer Wasserstelle bei Ankunft: frei, geöffnet, im Winter evtl. abgestellt oder evtl. zu. */
function waterState(poi, eta) {
  const oh = poi.tags.opening_hours;
  const st = ownState(oh, eta, 0, false);
  if (st === 'closed') return 'closed';
  if (poi.tags.seasonal && poi.tags.seasonal !== 'no' && WINTER.includes(eta.getMonth())) return 'seasonal';
  if (oh && st === 'unknown') return 'unknown';
  return st === 'open' ? 'open' : 'free';
}

/** Öffentlich und kostenlos (private Stellen filtert schon poiSource.js aus). */
const freeWater = poi => poi.type === 'water' && poi.tags.fee !== 'yes';

// ---------- Auswahl ----------

/**
 * Wählt Stopps: im Fenster (50 %–100 % des Intervalls nach dem letzten Stopp) zuerst geöffnete Stellen,
 * zuletzt solche mit unbekannten Öffnungszeiten; innerhalb einer Stufe nach Pausenstil. Außerdem zählt:
 * möglichst spät im Fenster und nah an der Route. Nach einer Übernachtung wird neu gezählt.
 */
function plan(r, candidates, { interval, departure, bike, holidayFor, style }) {
  const eta = timeline(r, departure, bike, style.dwell);
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
      const ev = evaluate(c.poi, t, holiday, style);
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
 * Trinkwasser an der (endgültigen) Route: Position, Abstand, Ankunftszeit und Zustand. Dicht beieinander
 * liegende Stellen werden zusammengefasst (die näher an der Route bleibt).
 * `pausesBefore(along)`: Stopps desselben Tages vor dieser Position (für die Ankunftszeit).
 */
function waterAlong(r, waters, eta, pausesBefore) {
  const located = locateNearRoute(r, waters, () => WATER_OFFSET).sort((a, b) => a.along - b.along);
  const out = [];
  for (const w of located) {
    const last = out.at(-1);
    if (last && w.along - last.along < WATER_MERGE) {
      if (w.offset < last.offset) out[out.length - 1] = w;
      continue;
    }
    out.push(w);
  }
  return out.map(w => {
    const t = eta(w.along, pausesBefore(w.along));
    return { ...w, eta: t, state: waterState(w.poi, t) };
  });
}

/**
 * Strecken über WATER_GAP ohne nutzbare Wasserstelle → [{from, to}]. Im Winter abgestellte oder bei Ankunft
 * geschlossene Stellen zählen nicht. An einer Übernachtung wird aufgefüllt, dort beginnt die Zählung neu.
 */
function waterGaps(r, water) {
  const marks = [
    ...water.filter(w => w.state !== 'seasonal' && w.state !== 'closed').map(w => w.along),
    ...(r.stageStarts || []),
  ].sort((a, b) => a - b);
  const gaps = [];
  let pos = 0;
  for (const m of [...marks, r.distance]) {
    if (m - pos > WATER_GAP) gaps.push({ from: pos, to: m });
    pos = Math.max(pos, m);
  }
  return gaps;
}

// ---------- Feiertage ----------
// Für Feiertage muss bekannt sein, durch welche Länder und Bundesländer die Route führt. Das kommt von Nominatim
// (höchstens eine Anfrage pro Sekunde) und dauert bei langen Routen viele Sekunden. Deshalb werden die Stopps
// zuerst ohne Feiertage geplant und angezeigt; die Feiertagsprüfung läuft parallel (holidayContext) und wird
// danach angewendet (applyHolidays). Nur wenn an einem Fahrtag wirklich ein Feiertag gilt, wird neu geplant.

/** Kalendertage von `from` bis `to` (jeweils 12 Uhr – für den Datumsvergleich, unabhängig von der Uhrzeit). */
function daysBetween(from, to) {
  const out = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate()); // Tagesbeginn
  while (day <= to && out.length < 60) { // Obergrenze: Schutz vor unsinnigen Zeiten
    out.push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12));
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/**
 * Feiertage, die während der Fahrt in durchfahrenen Regionen gelten:
 * [{date, name, national, regions: [Abschnitt, …]}]. Geprüft wird jeder Tag, an dem man in der Region ist –
 * bei Mehrtagestouren auch Tage mitten im Abschnitt.
 */
function holidayNotes(r, regions, lookup, departure, bike) {
  const eta = timeline(r, departure, bike);
  const notes = new Map();
  regions.forEach((seg, i) => {
    if (!seg.country) return;
    const to = regions[i + 1]?.from ?? r.distance;
    for (const day of daysBetween(eta(seg.from), eta(to))) {
      const h = lookup(seg, day);
      if (!h) continue;
      const key = `${h.date}|${h.name}`;
      const note = notes.get(key) || { ...h, regions: [] };
      if (!note.regions.some(x => x.country === seg.country && x.region === seg.region)) note.regions.push(seg);
      notes.set(key, note);
    }
  });
  return [...notes.values()];
}

/**
 * Regionen entlang der Route und Feiertagsabfrage dafür → {regions, lookup, notes}. Fehler sind nicht fatal
 * (dann regions/lookup null = Feiertage nicht geprüft). Die Regionen werden zuerst grob bestimmt (alle 20 km);
 * die Grenzen werden nur dann genau eingegrenzt, wenn während der Fahrt überhaupt ein Feiertag gilt – das spart
 * die meisten Nominatim-Anfragen.
 */
export async function holidayContext(base, departure, bike, signal) {
  const soft = e => { if (e.name === 'AbortError') throw e; console.warn(e); return null; };
  let regions = await regionsAlong(base, signal, { precise: false }).catch(soft);
  if (!regions) return { regions: null, lookup: null, notes: [] };
  // Großzügig geschätzte Ankunft (längste Pause, 10 Stopps) – nur für den Zeitraum der Feiertagsabfrage
  const arrival = timeline(base, departure, bike, MAX_DWELL)(base.distance, 10);
  const countries = new Set(regions.map(s => s.country).filter(Boolean));
  const lookup = await holidayLookup(countries, departure, arrival, signal).catch(soft);
  if (!lookup) return { regions, lookup: null, notes: [] };
  let notes = holidayNotes(base, regions, lookup, departure, bike);
  if (notes.length && regions.some(s => s.approx)) {
    // Feiertag auf der Strecke: Grenzen genau bestimmen, damit Stopps diesseits/jenseits richtig bewertet werden
    regions = await regionsAlong(base, signal).catch(soft) || regions;
    notes = holidayNotes(base, regions, lookup, departure, bike);
  }
  return { regions, lookup, notes };
}

/**
 * Ergebnis der Feiertagsprüfung auf eine Route mit Stopps anwenden. Gilt während der Fahrt kein Feiertag,
 * bleiben die Stopps, wie sie sind – sie bekommen nur ihre Region (für die Anzeige) → neue Route.
 * Gilt einer, muss neu geplant werden → null (dann addStops mit `holidays`).
 */
export function applyHolidays(stopped, ctx) {
  if (ctx.notes.length) return null;
  return {
    ...stopped,
    regions: ctx.regions || [],
    holidays: [],
    holidayCheck: !!ctx.lookup,
    stops: stopped.stops.map(s => ({ ...s, region: regionAtDistance(ctx.regions, s.planAlong) })),
  };
}

// ---------- Planen ----------

/**
 * Ergänzt eine Route um Verpflegungsstopps und Trinkwasser.
 * Ergebnis: neue Route (durch die Stopps) mit `stops`, `gaps`, `water`, `waterGaps`, `dwellMin`, `regions`,
 * `holidays` und `base` (Route ohne Stopps). Bei Mehrtagestouren werden `origin`, `stays` und `stageStarts`
 * weitergegeben.
 *
 * `style`: Pausenstil (Schlüssel in STYLES).
 * `holidays`: Ergebnis von holidayContext. Fehlt es, wird ohne Feiertage geplant (`holidayCheck: 'pending'`)
 * – die Prüfung folgt dann mit applyHolidays.
 *
 * Trinkwasser, Supermärkte und Tankstellen (Ebene „supply“) werden vollständig geladen. Bäckereien, Cafés und
 * Restaurants (Ebene „food“) nur, soweit sie schon im Cache liegen: Overpass braucht für eine neue Gegend oft
 * eine halbe Minute, und das soll die Planung nicht aufhalten. Fehlendes wird im Hintergrund nachgeladen
 * (`foodPartial`).
 */
export async function addStops(base, { provider, opts, interval, departure, bike, style: styleId, signal, holidays = null }) {
  const style = styleOf(styleId);
  const [supply, food] = await Promise.all([
    fetchPois(base, signal, ['supply']),
    fetchPois(base, signal, ['food'], { cacheOnly: true }).catch(e => {
      if (signal?.aborted) throw e;
      console.warn(e);
      return Object.assign([], { complete: false });
    }),
  ]);
  const seen = new Set();
  const pois = [...supply, ...food].filter(p => !seen.has(p.id) && seen.add(p.id));
  const regions = holidays?.regions || null;
  const lookup = holidays?.lookup || null;
  const regionFor = along => regionAtDistance(regions, along);
  const holidayFor = (along, date) => lookup?.(regionFor(along), date) ?? null;
  const info = {
    regions: regions || [],
    holidays: holidays?.notes || [],
    holidayCheck: holidays ? !!lookup : 'pending', // false = Feiertage konnten nicht geprüft werden
    foodPartial: !food.complete,
    dwellMin: style.dwell,
  };
  const waters = pois.filter(freeWater);
  /** Trinkwasser auf der endgültigen Route; `stops` bestimmen die Pausen vor jeder Stelle. */
  const withWater = (r, stops) => {
    const eta = timeline(r, departure, bike, style.dwell);
    const water = waterAlong(r, waters, eta,
      along => stops.filter(s => s.along < along && eta.dayOf(s.along) === eta.dayOf(along)).length);
    return { water, waterGaps: waterGaps(r, water) };
  };

  // Nur Typen, die der Pausenstil vorsieht (ohne Trinkwasser – das wird nur angezeigt)
  const candidates = withTypicalHours(pois).filter(p => style.bias[p.type] != null);
  const located = locateNearRoute(base, candidates, poi => MAX_OFFSET[poi.type]);
  const { stops, gaps } = plan(base, located, { interval, departure, bike, holidayFor, style });
  if (!stops.length) return { ...base, base, stops: [], gaps, ...withWater(base, []), ...info };

  // Route durch die Stopps führen
  const points = stops.map(s => ({ lat: s.poi.lat, lon: s.poi.lon, stop: true }));
  const wps = insertWaypoints(base, stops.map((s, i) => ({ along: s.along, point: points[i] })));
  const routed = await route(provider, wps, opts, signal);

  // Positionen und Ankunftszeiten auf der neuen Route bestimmen (Übernachtungen bleiben Tageswechsel)
  const along = locateOnRoute(routed, wps);
  routed.stageStarts = wps.flatMap((p, i) => (p.stay ? [along[i]] : []));
  const eta = timeline(routed, departure, bike, style.dwell);
  const finalStops = [];
  wps.forEach((p, i) => {
    if (!p.stop) return;
    const s = stops[points.indexOf(p)];
    const t = eta(along[i], finalStops.filter(f => eta.dayOf(f.along) === eta.dayOf(along[i])).length);
    // Region aus der Planung (Position auf der Basisroute), Feiertag zur neuen Ankunftszeit
    const region = regionFor(s.along);
    const holiday = lookup?.(region, t) ?? null;
    const ev = evaluate(s.poi, t, holiday, style) || { state: 'closed' };
    const type = STOP_TYPES[s.poi.type];
    finalStops.push({
      ...s, planAlong: s.along, along: along[i], eta: t, state: ev.state, point: p, region, holiday,
      icon: type.icon, typeLabel: type.label, gpxSym: type.gpxSym,
    });
  });
  return {
    ...routed, base, origin: base.origin, stays: base.stays, stops: finalStops, gaps,
    ...withWater(routed, finalStops), ...info,
  };
}
