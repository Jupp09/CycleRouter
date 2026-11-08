/**
 * Mehrtagestouren: Route in Tagesetappen teilen und für jede Nacht Unterkünfte aus OpenStreetMap
 * vorschlagen (Hotel, Motel, Pension/B&B, Hostel, Zeltplatz).
 *
 * Preise kennt OSM kaum – sie werden aus Art und Sternen geschätzt (oder aus einer Preisangabe im
 * OSM-Eintrag übernommen) und über einen Link zur Preissuche mit dem passenden Datum geprüft.
 * OSM enthält auch veraltete oder falsch eingetragene Unterkünfte; solche werden aussortiert
 * (poiSource.js) bzw. abgewertet (isStale) und lassen sich vom Nutzer ausblenden.
 */
import { sampleRoute } from './utils.js';
import { route } from './routing/index.js';
import { openState } from './openingHours.js';
import { fetchPoisNear } from './poiTiles.js';
import { insertWaypoints, locateOnRoute, nearestSample } from './routeGeometry.js';

export const STAY_TYPES = {
  hotel: { label: 'Hotel', icon: '🏨', gpxSym: 'Lodging' },
  motel: { label: 'Motel', icon: '🏨', gpxSym: 'Lodging' },
  guest_house: { label: 'Pension / B&B', icon: '🛏️', gpxSym: 'Lodging' },
  hostel: { label: 'Hostel', icon: '🛏️', gpxSym: 'Lodging' },
  camp_site: { label: 'Zeltplatz', icon: '⛺', gpxSym: 'Campground' },
};

/** Auswahl in den Einstellungen → OSM-Typen. */
export const STAY_GROUPS = {
  hotel: { label: 'Hotel / Motel', types: ['hotel', 'motel'] },
  guest_house: { label: 'Pension / B&B', types: ['guest_house'] },
  hostel: { label: 'Hostel', types: ['hostel'] },
  camp_site: { label: 'Zeltplatz', types: ['camp_site'] },
};

const MAX_OFFSET = 3000;      // Unterkunft höchstens so weit neben der Route (Luftlinie, m)
const MAX_OFFSET_END = 5000;  // am Ziel (Stadt) etwas großzügiger
const MAX_OPTIONS = 8;        // Auswahl je Nacht
const WINTER = [10, 11, 0, 1, 2]; // November bis März

// ---------- Preise ----------

/** Typische Preise pro Nacht (eine Person / Doppelzimmer-Einzelnutzung bzw. Zelt + Rad), Deutschland. */
const PRICE = {
  camp_site: [12, 30],
  hostel: [28, 55],
  guest_house: [55, 95],
  motel: [55, 90],
  hotel: [80, 140],
};
const HOTEL_BY_STARS = { 1: [50, 75], 2: [60, 90], 3: [80, 130], 4: [110, 190], 5: [200, 400] };

/** Erste Euro-Angabe aus Freitext wie „25 EUR“, „€ 18-25“, „20 EUR/Nacht“. */
function parseEuro(text) {
  if (!text) return null;
  const m = String(text).match(/(?:€|eur)\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:€|eur)/i);
  const v = m && Number((m[1] || m[2]).replace(',', '.'));
  return v > 0 && v < 2000 ? v : null;
}

/** Preis pro Nacht → {min, max, typical, source: 'osm' | 'estimate'} */
export function estimatePrice(poi) {
  const own = parseEuro(poi.tags.charge) ?? parseEuro(poi.tags.fee);
  if (own) return { min: own, max: own, typical: own, source: 'osm' };
  let [min, max] = PRICE[poi.type] || PRICE.hotel;
  const stars = Math.round(parseFloat(poi.tags.stars));
  if (poi.type === 'hotel' && HOTEL_BY_STARS[stars]) [min, max] = HOTEL_BY_STARS[stars];
  return { min, max, typical: Math.round((min + max) / 2), source: 'estimate' };
}

export const priceLabel = p => (p.source === 'osm' ? `${p.typical} € (laut OSM)` : `ca. ${p.min}–${p.max} €`);

/** Budget-Einstufung: 'ok' (typisch im Budget), 'maybe' (günstigste Variante im Budget), 'over'. */
export const budgetFit = (p, budget) => (p.typical <= budget ? 'ok' : p.min <= budget ? 'maybe' : 'over');

// ---------- Links ----------

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Link zur Preissuche für die Nacht (Booking.com mit Datum; Zeltplätze über eine Websuche). */
export function priceLink(poi, night) {
  const place = poi.tags['addr:city'] || poi.tags['addr:place'] || '';
  const q = [poi.name, place].filter(Boolean).join(' ');
  if (poi.type === 'camp_site') return `https://www.google.com/search?q=${encodeURIComponent(`${q} Zeltplatz Preise`)}`;
  const checkout = new Date(night.date.getTime() + 86400000);
  const p = new URLSearchParams({ ss: q, checkin: ymd(night.date), checkout: ymd(checkout), group_adults: 1, no_rooms: 1 });
  return `https://www.booking.com/searchresults.html?${p}`;
}

export const websiteOf = poi => poi.tags.website || poi.tags['contact:website'] || null;

/** Link, um einen Fehler an dieser Stelle in OpenStreetMap zu melden (Hinweis/„Note“ für Mapper vor Ort). */
export function osmNoteLink({ lat, lon }) {
  const la = lat.toFixed(5), lo = lon.toFixed(5);
  return `https://www.openstreetmap.org/note/new?lat=${la}&lon=${lo}#map=18/${la}/${lo}`;
}

// ---------- Verfügbarkeit und Aktualität ----------

/**
 * Geöffnet in dieser Nacht? → 'open' | 'closed' (laut OSM-Öffnungszeiten am Abend) |
 * 'season' (Zeltplatz ohne Angaben im Winter – oft geschlossen) | 'unknown'
 */
export function availability(poi, date) {
  const oh = poi.tags.opening_hours;
  if (oh) {
    const st = openState(oh, date, 0);
    if (st !== 'unknown') return st;
    if (/geschlossen|closed/i.test(oh)) return 'closed';
  }
  if (poi.type === 'camp_site' && WINTER.includes(date.getMonth())) return 'season';
  return 'unknown';
}

export const AVAILABILITY_LABEL = { open: 'laut OSM geöffnet', season: 'Saison prüfen – im Winter oft geschlossen' };

/**
 * Wann wurde der Eintrag zuletzt bestätigt (OSM-Bearbeitung oder check_date)? → Jahr oder null.
 * Einträge, die lange niemand angefasst hat, gibt es oft nicht mehr.
 */
export function lastConfirmed(poi) {
  const dates = [poi.edited, poi.tags.check_date].filter(Boolean).map(d => Number(String(d).slice(0, 4))).filter(y => y > 2000);
  return dates.length ? Math.max(...dates) : null;
}

/** Veraltet: seit über 5 Jahren unverändert, oder nie überarbeitet (Version 1) und älter als 3 Jahre. */
export function isStale(poi, now = new Date()) {
  const year = lastConfirmed(poi);
  if (!year) return false;
  const age = now.getFullYear() - year;
  return age > 5 || (poi.version === 1 && !poi.tags.check_date && age > 3);
}

const hasContact = poi => !!(poi.tags.website || poi.tags['contact:website'] || poi.tags.phone || poi.tags['contact:phone']);

// ---------- Etappen ----------

/** Lohnt sich eine Mehrtagestour (Route deutlich länger als die Tagesetappe)? */
export const isMultiDayCandidate = (r, maxKm) => r.distance > maxKm * 1000 * 1.1;

/**
 * Punktzahl einer Unterkunft für eine Nacht (kleiner = besser). Reihenfolge der Kriterien:
 * Budget, dann gleichmäßige Etappen ohne Überschreiten des Tageslimits, dann wenig Umweg.
 * Abwertungen: Zeltplatz ohne Angaben im Winter, veraltete Einträge, fehlende Kontaktdaten.
 */
function scoreOption({ w, along, offset, fit, open, stale, contact, ctx }) {
  let score;
  if (w.end) {
    score = offset / 500; // am Ziel zählt nur die Nähe
  } else {
    // Ideal: die verbleibende Strecke gleichmäßig auf die restlichen Tage verteilen
    const ideal = ctx.prevAlong + (ctx.distance - ctx.prevAlong) / (ctx.remainingDays + 1);
    const stage = along - ctx.prevAlong;
    const rest = (ctx.distance - along) / Math.max(1, ctx.remainingDays);
    const tooLong = stage > ctx.maxStage || (ctx.isLastInner && rest > ctx.maxStage);
    score = Math.abs(along - ideal) / 1000 + offset / 500 + (tooLong ? 50 : 0); // 1 km Umweg ≈ 2 km Abweichung
  }
  score += { ok: 0, maybe: 100, over: 200 }[fit];
  score += open === 'season' ? 150 : 0;  // hinter „evtl. im Budget“, aber vor „über Budget“
  score += stale ? 80 : 0;
  score += contact ? 0 : 15;
  return score;
}

/**
 * Etappen und Übernachtungen planen.
 * → {days, stageLength, nights: [{index, target, date, end, options: [{poi, along, offset, price, fit, open, stale}], chosen}]}
 * `choices`: früher gewählte Unterkünfte (OSM-Kennungen je Nacht), werden bevorzugt übernommen.
 * `hidden`: vom Nutzer ausgeblendete Unterkünfte (OSM-Kennungen), werden nie vorgeschlagen.
 */
export async function planStays(r, { maxKm, budget, groups, departure, endStay, choices = [], hidden = [], signal }) {
  const hiddenIds = new Set(hidden);
  const days = Math.max(2, Math.ceil(r.distance / (maxKm * 1000)));
  const stageLength = r.distance / days;
  const types = new Set(Object.entries(STAY_GROUPS).filter(([g]) => groups.includes(g)).flatMap(([, v]) => v.types));

  // Suchbereich je Nacht: etwas vor bis etwas hinter dem Etappenziel (am Ziel: kurz davor bis zum Ziel)
  const windows = Array.from({ length: days - 1 }, (_, k) => {
    const target = stageLength * (k + 1);
    return { target, end: false, lo: target - 0.3 * stageLength, hi: Math.min(r.distance, target + 0.2 * stageLength), maxOffset: MAX_OFFSET };
  });
  if (endStay) windows.push({ target: r.distance, end: true, lo: r.distance - 0.15 * stageLength, hi: r.distance, maxOffset: MAX_OFFSET_END });

  const samples = sampleRoute(r, 250);
  const inWindow = (s, w) => s.along >= w.lo && s.along <= w.hi;
  const searchPoints = samples.filter(s => windows.some(w => inWindow(s, w)));
  const pois = (await fetchPoisNear(searchPoints, signal, ['stay'], { margin: 0.04 }))
    .filter(p => types.has(p.type) && !hiddenIds.has(p.id));

  // Nächte der Reihe nach wählen: Die Etappe seit der vorigen Unterkunft (und bei der letzten Nacht
  // vor dem Ziel auch die Reststrecke) soll das Tageslimit nicht überschreiten und möglichst gleich lang sein.
  const ctx = { distance: r.distance, maxStage: maxKm * 1000 * 1.05, prevAlong: 0 };
  const lastInner = windows.filter(w => !w.end).length - 1;
  const nights = windows.map((w, index) => {
    const pts = samples.filter(s => inWindow(s, w));
    Object.assign(ctx, { remainingDays: days - index - 1, isLastInner: index === lastInner });
    const evening = new Date(departure.getFullYear(), departure.getMonth(), departure.getDate() + index, 18);
    const options = [];
    for (const poi of pois) {
      const { along, offset } = nearestSample(pts, poi.lat, poi.lon);
      if (offset > w.maxOffset) continue;
      const open = availability(poi, evening);
      if (open === 'closed') continue; // laut Öffnungszeiten an diesem Abend geschlossen
      const price = estimatePrice(poi);
      const fit = budgetFit(price, budget);
      const stale = isStale(poi);
      const score = scoreOption({ w, along, offset, fit, open, stale, contact: hasContact(poi), ctx });
      options.push({ poi, along, offset, price, fit, open, stale, score });
    }
    options.sort((a, b) => a.score - b.score);
    const top = options.slice(0, MAX_OPTIONS);
    // früher gewählte Unterkunft behalten, falls sie noch passt
    const previous = choices[index] && options.find(o => o.poi.id === choices[index]);
    if (previous && !top.includes(previous)) top.unshift(previous);
    const chosen = previous || top[0] || null;
    if (!w.end) ctx.prevAlong = chosen ? chosen.along : w.target;
    return {
      index, target: w.target, end: w.end,
      date: new Date(departure.getFullYear(), departure.getMonth(), departure.getDate() + index),
      options: top,
      chosen,
    };
  });
  return { days, stageLength, nights };
}

/**
 * Route durch die gewählten Unterkünfte führen (Übernachtung am Ziel ändert die Route nicht).
 * → neue Route mit `stays` (Plan), `stageStarts` (m, Übernachtungsorte) und `origin` (Route ohne Übernachtungen).
 */
export async function routeThroughStays(origin, plan, { provider, opts, signal }) {
  const chosen = plan.nights.filter(n => n.chosen && !n.end);
  if (!chosen.length) return { ...origin, origin, stays: plan, stageStarts: plan.nights.filter(n => !n.end).map(n => n.target) };
  const points = chosen.map(n => ({ lat: n.chosen.poi.lat, lon: n.chosen.poi.lon, stay: true, label: n.chosen.poi.name }));
  const wps = insertWaypoints(origin, chosen.map((n, i) => ({ along: n.chosen.along, point: points[i] })));
  const routed = await route(provider, wps, opts, signal);
  const along = locateOnRoute(routed, wps);
  routed.stageStarts = wps.flatMap((p, i) => (p.stay ? [along[i]] : []));
  // Nächte ohne gefundene Unterkunft: Etappengrenze am Etappenziel
  for (const n of plan.nights) if (!n.chosen && !n.end) routed.stageStarts.push(n.target);
  routed.stageStarts.sort((a, b) => a - b);
  return { ...routed, origin, stays: plan };
}
