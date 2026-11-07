import { storage } from './utils.js';

/**
 * Gesetzliche Feiertage je Land und Jahr (Quelle: date.nager.at, ~100 Länder),
 * inkl. regionaler Feiertage (z. B. Fronleichnam nur in bestimmten Bundesländern).
 */

const API = 'https://date.nager.at/api/v3/PublicHolidays';
const TTL = 365 * 24 * 3600 * 1000; // Feiertage werden ein Jahr lang im Browser gespeichert
const mem = new Map();

function load(country, year, signal) {
  const key = `${country}-${year}`;
  if (mem.has(key)) return mem.get(key);
  // Gespeichert als {t, list}; ältere Einträge (nur Liste, ohne Zeitstempel) gelten als abgelaufen
  const stored = storage.get('holidays.' + key, null);
  const stale = Array.isArray(stored) ? stored : stored?.list || null;
  if (stored?.t && Date.now() - stored.t < TTL) {
    mem.set(key, Promise.resolve(stored.list));
    return mem.get(key);
  }

  const p = fetch(`${API}/${year}/${country}`, { signal }).then(async res => {
    if (res.status === 204 || res.status === 404) return []; // Land nicht abgedeckt
    if (!res.ok) throw new Error(`Feiertage konnten nicht geladen werden (${res.status})`);
    return (await res.json())
      .filter(h => h.types?.includes('Public'))
      .map(h => ({ date: h.date, name: h.localName, regions: h.global ? null : h.counties }));
  }).then(list => {
    storage.set('holidays.' + key, { t: Date.now(), list });
    return list;
  }).catch(e => {
    // Abgelaufene Daten sind besser als keine
    if (stale && e.name !== 'AbortError') return stale;
    throw e;
  });
  mem.set(key, p);
  p.catch(() => mem.delete(key));
  return p;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function find(list, region, date) {
  const day = ymd(date);
  const h = list.find(h => h.date === day && (!h.regions || (region.region && h.regions.includes(region.region))));
  return h ? { name: h.name, national: !h.regions, date: day } : null;
}

/** Feiertag am Datum in der Region? → {name, national, date} | null */
export async function holidayAt(region, date, signal) {
  if (!region?.country) return null;
  return find(await load(region.country, date.getFullYear(), signal), region, date);
}

/**
 * Lädt die Feiertage aller Länder für die Jahre von `from` bis `to` und liefert eine
 * synchrone Abfrage (region, date) → Feiertag | null.
 */
export async function holidayLookup(countries, from, to, signal) {
  const years = [...new Set([from.getFullYear(), to.getFullYear()])];
  const lists = new Map();
  await Promise.all([...countries].flatMap(c => years.map(async y => lists.set(`${c}-${y}`, await load(c, y, signal)))));
  return (region, date) => {
    if (!region?.country) return null;
    const list = lists.get(`${region.country}-${date.getFullYear()}`);
    return list ? find(list, region, date) : null;
  };
}
