import { sampleRoute, indexAtDistance, estimateTime } from './utils.js';
import { fetchPoisNear, insertWaypoints, locateOnRoute } from './stops.js';
import { route } from './routing/index.js';
import { openState } from './openingHours.js';

/**
 * Mehrtagestouren: Route in Tagesetappen teilen und für jede Nacht Unterkünfte aus OpenStreetMap
 * vorschlagen (Hotel, Motel, Pension/B&B, Hostel, Zeltplatz). Preise kennt OSM kaum – sie werden aus
 * Art und Sternen geschätzt (oder aus einer Preisangabe im OSM-Eintrag übernommen) und über einen
 * Link zur Preissuche mit dem passenden Datum geprüft.
 */

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

const MAX_OFFSET = 3000;      // Unterkunft höchstens so weit neben der Route (Luftlinie)
const MAX_OFFSET_END = 5000;  // am Ziel (Stadt) etwas großzügiger
const MAX_OPTIONS = 8;        // Auswahl je Nacht

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

/** → {min, max, typical, source: 'osm' | 'estimate'} */
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

/** Link zur Preissuche für die Nacht (Booking.com; Zeltplätze über eine Websuche). */
export function priceLink(poi, night) {
  const place = poi.tags['addr:city'] || poi.tags['addr:place'] || '';
  const q = [poi.name, place].filter(Boolean).join(' ');
  if (poi.type === 'camp_site') return `https://www.google.com/search?q=${encodeURIComponent(`${q} Zeltplatz Preise`)}`;
  const checkout = new Date(night.date.getTime() + 86400000);
  const p = new URLSearchParams({ ss: q, checkin: ymd(night.date), checkout: ymd(checkout), group_adults: 1, no_rooms: 1 });
  return `https://www.booking.com/searchresults.html?${p}`;
}

export const websiteOf = poi => poi.tags.website || poi.tags['contact:website'] || null;

// ---------- Geöffnet in dieser Nacht? ----------

const WINTER = [10, 11, 0, 1, 2]; // November bis März

/**
 * → 'open' | 'closed' (laut OSM-Öffnungszeiten am Abend) | 'season' (Zeltplatz ohne Angaben im Winter) | 'unknown'
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

// ---------- Aktualität ----------

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
 * Etappen und Übernachtungen planen.
 * → {stageLength, nights: [{index, target, date, end, options: [{poi, along, offset, price, fit}], chosen}]}
 * `choices`: früher gewählte Unterkünfte (OSM-Kennungen je Nacht), werden bevorzugt übernommen.
 */
export async function planStays(r, { maxKm, budget, groups, departure, endStay, choices = [], hidden = [], signal }) {
  const hiddenIds = new Set(hidden);
  const days = Math.max(2, Math.ceil(r.distance / (maxKm * 1000)));
  const stageLength = r.distance / days;
  const types = new Set(Object.entries(STAY_GROUPS).filter(([g]) => groups.includes(g)).flatMap(([, v]) => v.types));

  const targets = Array.from({ length: days - 1 }, (_, k) => ({ target: stageLength * (k + 1), end: false }));
  if (endStay) targets.push({ target: r.distance, end: true });

  // Suchbereich je Nacht: etwas vor bis etwas hinter dem Etappenziel
  const windows = targets.map(t => t.end
    ? { ...t, lo: r.distance - 0.15 * stageLength, hi: r.distance, maxOffset: MAX_OFFSET_END }
    : { ...t, lo: t.target - 0.3 * stageLength, hi: Math.min(r.distance, t.target + 0.2 * stageLength), maxOffset: MAX_OFFSET });

  const samples = sampleRoute(r, 250);
  const inWindow = (s, w) => s.along >= w.lo && s.along <= w.hi;
  const searchPoints = samples.filter(s => windows.some(w => inWindow(s, w)));
  const pois = (await fetchPoisNear(searchPoints, signal, ['stay'], { margin: 0.04 }))
    .filter(p => types.has(p.type) && !hiddenIds.has(p.id)); // vom Nutzer ausgeblendete nie vorschlagen

  // Nächte der Reihe nach wählen: Die Etappe seit der vorigen Unterkunft (und bei der letzten Nacht
  // vor dem Ziel auch die Reststrecke) soll das Tageslimit nicht überschreiten und möglichst gleich lang sein.
  const maxStage = maxKm * 1000 * 1.05;
  let prevAlong = 0;
  const lastInner = windows.filter(w => !w.end).length - 1;
  const nights = windows.map((w, index) => {
    const pts = samples.filter(s => inWindow(s, w));
    const remainingDays = days - index - 1;
    const options = [];
    for (const poi of pois) {
      let best = null;
      for (const s of pts) {
        const dy = (s.lat - poi.lat) * 110540, dx = (s.lon - poi.lon) * 111320 * Math.cos(s.lat * Math.PI / 180);
        const d = Math.hypot(dx, dy);
        if (!best || d < best.offset) best = { along: s.along, offset: d };
      }
      if (!best || best.offset > w.maxOffset) continue;
      const price = estimatePrice(poi);
      const fit = budgetFit(price, budget);
      const nightDate = new Date(departure.getFullYear(), departure.getMonth(), departure.getDate() + index, 18);
      const open = availability(poi, nightDate);
      if (open === 'closed') continue; // laut Öffnungszeiten an diesem Abend geschlossen
      let score;
      if (w.end) {
        score = best.offset / 500; // am Ziel zählt nur die Nähe
      } else {
        // Ideal: die verbleibende Strecke gleichmäßig auf die restlichen Tage verteilen
        const ideal = prevAlong + (r.distance - prevAlong) / (remainingDays + 1);
        const stage = best.along - prevAlong;
        const rest = (r.distance - best.along) / Math.max(1, remainingDays);
        const tooLong = stage > maxStage || (index === lastInner && rest > maxStage);
        score = Math.abs(best.along - ideal) / 1000 + best.offset / 500 + (tooLong ? 50 : 0);
      }
      // Budget zuerst, dann Etappenlänge und kleiner Umweg (1 km Umweg ≈ 2 km Abweichung);
      // Zeltplätze ohne Angaben im Winter (oft geschlossen) hinter „evtl. im Budget“, aber vor „über Budget“
      score += { ok: 0, maybe: 100, over: 200 }[fit] + (open === 'season' ? 150 : 0);
      // Lange nicht bestätigte Einträge (gibt es oft nicht mehr) nach hinten, ohne Kontaktdaten leicht nach hinten
      const stale = isStale(poi);
      score += (stale ? 80 : 0) + (hasContact(poi) ? 0 : 15);
      options.push({ poi, along: best.along, offset: best.offset, price, fit, open, stale, score });
    }
    options.sort((a, b) => a.score - b.score);
    const top = options.slice(0, MAX_OPTIONS);
    // früher gewählte Unterkunft behalten, falls sie noch passt
    const previous = choices[index] && options.find(o => o.poi.id === choices[index]);
    if (previous && !top.includes(previous)) top.unshift(previous);
    const chosen = previous || top[0] || null;
    if (!w.end) prevAlong = chosen ? chosen.along : w.target;
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

/** Kennzahlen je Tag: [{day, from, to, distance, ascent, time}] */
export function stageStats(r, bike) {
  const bounds = [0, ...(r.stageStarts || []), r.distance];
  const asc = [];
  let ref = r.coords.find(c => c[2] != null)?.[2], total = 0;
  for (const c of r.coords) {
    if (c[2] != null && ref != null) {
      if (c[2] - ref >= 4) { total += c[2] - ref; ref = c[2]; } else if (ref - c[2] >= 4) ref = c[2];
    }
    asc.push(total);
  }
  return bounds.slice(0, -1).map((from, i) => {
    const to = bounds[i + 1];
    const ascent = Math.round((asc[indexAtDistance(r, to)] || 0) - (asc[indexAtDistance(r, from)] || 0));
    return { day: i + 1, from, to, distance: to - from, ascent, time: estimateTime(to - from, ascent, bike) };
  });
}
