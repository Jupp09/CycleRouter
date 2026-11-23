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
import { insertWaypoints, locateOnRoute, nearestSample, transferPositions } from './routeGeometry.js';

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
  // Kalendertag + 1, nicht + 24 h: In der Nacht der Zeitumstellung im Oktober wäre das noch derselbe Tag
  const checkout = new Date(night.date.getFullYear(), night.date.getMonth(), night.date.getDate() + 1);
  const p = new URLSearchParams({ ss: q, checkin: ymd(night.date), checkout: ymd(checkout), group_adults: '1', no_rooms: '1' });
  return `https://www.booking.com/searchresults.html?${p}`;
}

export const websiteOf = poi => poi.tags.website || poi.tags['contact:website'] || null;

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

/** Kürzester Rest für den letzten Tag: Lässt eine Anpassung weniger übrig, wird sie verworfen. */
export const MIN_LAST_DAY = 5000;

/**
 * Etappenlängen mit vom Nutzer angepassten Tagen. `overrides[k]`: gewünschte Länge von Tag k+1 in km
 * (dünn besetzt, null = frei). Die freien Tage teilen sich die Reststrecke gleichmäßig; würden sie länger als
 * `maxKm`, kommt ein Tag dazu, ist der Rest kürzer, fällt einer weg. Der letzte Tag ist immer der Rest – eine
 * Anpassung auf ihm oder dahinter fällt weg, ebenso eine, die weniger als 5 km Rest übrig ließe (von hinten).
 * → {days, lengths: [m je Tag], targets: [m entlang je Nacht], fixed: [je Tag angepasst?], overrides: [km, bereinigt]}
 * @param {number} distance Länge der Route in m
 * @param {number} maxKm km pro Tag (Einstellung)
 * @param {(number | null)[]} [overrides]
 */
export function stageTargets(distance, maxKm, overrides = []) {
  const maxM = maxKm * 1000;
  let o = overrides.map(v => (Number.isFinite(v) && v > 0 ? v * 1000 : null));
  let days;
  for (;;) {
    const fixedCount = o.filter(v => v != null).length;
    if (!fixedCount) { days = Math.max(2, Math.ceil(distance / maxM)); o = []; break; }
    const free = distance - o.reduce((s, v) => s + (v ?? 0), 0);
    if (free < MIN_LAST_DAY) { o[o.findLastIndex(v => v != null)] = null; continue; }
    days = fixedCount + Math.max(1, Math.ceil(free / maxM));
    if (o.some((v, i) => v != null && i >= days - 1)) { o = o.map((v, i) => (i >= days - 1 ? null : v)); continue; }
    break;
  }
  const fixed = Array.from({ length: days }, (_, i) => o[i] != null);
  const freeLength = (distance - o.reduce((s, v) => s + (v ?? 0), 0)) / fixed.filter(f => !f).length;
  const lengths = fixed.map((f, i) => (f ? /** @type {number} */ (o[i]) : freeLength));
  const targets = [];
  for (let i = 0, sum = 0; i < days - 1; i++) targets.push(sum += lengths[i]);
  const kept = o.slice(0, days - 1).map(v => (v == null ? null : v / 1000));
  while (kept.length && kept.at(-1) == null) kept.pop();
  return { days, lengths, targets, fixed, overrides: kept };
}

/**
 * Punktzahl einer Unterkunft für eine Nacht (kleiner = besser). Reihenfolge der Kriterien:
 * Budget, dann Etappen nahe der gewünschten Länge ohne Überschreiten des Tageslimits, dann wenig Umweg.
 * Abwertungen: Zeltplatz ohne Angaben im Winter, veraltete Einträge, fehlende Kontaktdaten.
 */
function scoreOption({ w, along, offset, fit, open, stale, contact, ctx }) {
  let score;
  if (w.end) {
    score = offset / 500; // am Ziel zählt nur die Nähe
  } else {
    // Ideal (ctx.ideal): angepasster Tag in seiner Länge, sonst die Reststrecke gleichmäßig auf die freien Tage
    const stage = along - ctx.prevAlong;
    const rest = (ctx.distance - along) / Math.max(1, ctx.remainingDays);
    const tooLong = stage > ctx.stageMax || (ctx.isLastInner && rest > ctx.maxStage);
    score = Math.abs(along - ctx.ideal) / 1000 + offset / 500 + (tooLong ? 50 : 0); // 1 km Umweg ≈ 2 km Abweichung
  }
  score += { ok: 0, maybe: 100, over: 200 }[fit];
  score += open === 'season' ? 150 : 0;  // hinter „evtl. im Budget“, aber vor „über Budget“
  score += stale ? 80 : 0;
  score += contact ? 0 : 15;
  return score;
}

/**
 * Etappen und Übernachtungen planen.
 * → {days, stageLength, lengths, fixed, overrides, nights: [{index, target, date, end, options: [{poi, along, offset, price, fit, open, stale}], chosen}]}
 * `choices`: früher gewählte Unterkünfte (OSM-Kennungen je Nacht), werden bevorzugt übernommen.
 * `hidden`: vom Nutzer ausgeblendete Unterkünfte (OSM-Kennungen), werden nie vorgeschlagen.
 * `overrides`: vom Nutzer angepasste Tageslängen in km (siehe `stageTargets`); `overrides` im Ergebnis ist die
 * bereinigte Fassung (nicht mehr passende Anpassungen fallen weg).
 */
export async function planStays(r, { maxKm, budget, groups, departure, endStay, choices = [], hidden = [], overrides = [], signal }) {
  const hiddenIds = new Set(hidden);
  const stages = stageTargets(r.distance, maxKm, overrides);
  const { days, lengths, fixed } = stages;
  const stageLength = r.distance / days;
  const types = new Set(Object.entries(STAY_GROUPS).filter(([g]) => groups.includes(g)).flatMap(([, v]) => v.types));

  // Suchbereich je Nacht: etwas vor bis etwas hinter dem Etappenziel (am Ziel: kurz davor bis zum Ziel),
  // gemessen an der Länge dieses Tages – ein bewusst kurzer Tag soll nicht weit über sein Ziel hinaus suchen
  const windows = stages.targets.map((target, k) => ({
    target, end: false, lo: target - 0.3 * lengths[k], hi: Math.min(r.distance, target + 0.2 * lengths[k]), maxOffset: MAX_OFFSET,
  }));
  if (endStay) windows.push({ target: r.distance, end: true, lo: r.distance - 0.15 * lengths[days - 1], hi: r.distance, maxOffset: MAX_OFFSET_END });

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
    // Ideal für diese Nacht: angepasster Tag in seiner Länge; sonst teilen sich die freien Tage die Strecke,
    // die nach den späteren angepassten Tagen übrig bleibt
    let ideal = ctx.prevAlong + lengths[index];
    if (!w.end && !fixed[index]) {
      const laterFixed = lengths.reduce((s, l, j) => s + (j > index && fixed[j] ? l : 0), 0);
      const freeLeft = fixed.filter((f, j) => j >= index && !f).length;
      ideal = ctx.prevAlong + (r.distance - ctx.prevAlong - laterFixed) / Math.max(1, freeLeft);
    }
    // Ein bewusst längerer Tag gilt nicht als „zu lang“
    const stageMax = fixed[index] ? Math.max(ctx.maxStage, lengths[index] * 1.05) : ctx.maxStage;
    Object.assign(ctx, { remainingDays: days - index - 1, isLastInner: index === lastInner, ideal, stageMax });
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
  return { days, stageLength, lengths, fixed, overrides: stages.overrides, nights };
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
  // Nächte ohne gefundene Unterkunft: Etappengrenze am Etappenziel – das liegt auf der Route ohne
  // Übernachtungen und wird über den Ort übertragen (die Umwege zu den Unterkünften verschieben es)
  const open = plan.nights.filter(n => !n.chosen && !n.end).map(n => n.target);
  routed.stageStarts.push(...transferPositions(origin, routed, open));
  routed.stageStarts.sort((a, b) => a - b);
  return { ...routed, origin, stays: plan };
}
