/**
 * Wetter entlang der Route zur Ankunftszeit: Temperatur, Regen, Wind – und ob der Wind von vorn kommt.
 *
 * Quelle: Open-Meteo (ohne Schlüssel, nur für nicht-kommerzielle Nutzung frei; Quellenangabe in der Oberfläche).
 * Privatsphäre: Es gehen nur auf 0,1° gerundete Orte hinaus – genauer rechnet das Wettermodell ohnehin nicht.
 * Sparsam: Stundenwerte werden je Zelle und Tag 1 h gemerkt. Eine Berechnung zeigt die Route mehrmals
 * (Grundroute, Unterkünfte, Stopps); so kostet das in der Regel eine Anfrage.
 */
import { withTimeout } from './shared.js';
import { indexAtDistance, formatClock } from './utils.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const VARS = ['temperature_2m', 'precipitation_probability', 'precipitation', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
const TTL = 3600000;
/** Open-Meteo sagt heute und die 15 Tage danach vorher. */
export const FORECAST_DAYS = 16;
/** Abschnittslänge; lange Touren bekommen längere Abschnitte (höchstens MAX_SECTIONS). */
const STEP = 10000, MAX_SECTIONS = 40;
const RAD = Math.PI / 180;

/** `${Zelle}|${UTC-Tag}` → {at, hours: [24 × {temp, rainProb, rain, wind, dir, gust}]} */
const cache = new Map();

const cellOf = (lat, lon) => `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`;
const utcDay = d => d.toISOString().slice(0, 10);
const nearestHour = d => new Date(Math.round(d.getTime() / 3600000) * 3600000);

/**
 * Stundenwerte für Orte und Zeitraum laden (fehlende Zellen in einer Anfrage) → `at(lat, lon, date)`
 * liefert die Werte der nächstgelegenen vollen Stunde oder null.
 */
export async function fetchWeather(points, from, to, signal) {
  const days = [];
  for (let t = Date.parse(utcDay(nearestHour(from))); t <= nearestHour(to).getTime(); t += 86400000) days.push(utcDay(new Date(t)));
  const fresh = key => cache.has(key) && Date.now() - cache.get(key).at < TTL;
  const cells = [...new Set(points.map(p => cellOf(p.lat, p.lon)))];
  const missing = cells.filter(c => days.some(d => !fresh(`${c}|${d}`)));
  if (missing.length) {
    const url = `${API}?latitude=${missing.map(c => c.split(',')[0]).join(',')}&longitude=${missing.map(c => c.split(',')[1]).join(',')}`
      + `&hourly=${VARS.join(',')}&start_date=${days[0]}&end_date=${days.at(-1)}&timezone=UTC`;
    const res = await fetch(url, { signal: withTimeout(signal, 10000) });
    if (!res.ok) throw new Error(`Open-Meteo antwortet mit ${res.status}`);
    const data = await res.json();
    // Ein Ort: Objekt; mehrere: Liste in der Reihenfolge der Anfrage
    const stamp = Date.now(), renewed = new Set();
    [data].flat().forEach((loc, i) => {
      const h = loc.hourly;
      h.time.forEach((time, k) => {
        const key = `${missing[i]}|${time.slice(0, 10)}`;
        if (!renewed.has(key)) { renewed.add(key); cache.set(key, { at: stamp, hours: [] }); }
        cache.get(key).hours[Number(time.slice(11, 13))] = {
          temp: h.temperature_2m[k], rainProb: h.precipitation_probability[k], rain: h.precipitation[k],
          wind: h.wind_speed_10m[k], dir: h.wind_direction_10m[k], gust: h.wind_gusts_10m[k],
        };
      });
    });
  }
  return (lat, lon, date) => {
    const t = nearestHour(date);
    const v = cache.get(`${cellOf(lat, lon)}|${utcDay(t)}`)?.hours[t.getUTCHours()];
    return v && v.temp != null ? v : null;
  };
}

/** Fahrtrichtung von a nach b in Grad (0 = Nord, 90 = Ost). */
function bearing(a, b) {
  const dLon = (b[1] - a[1]) * RAD;
  const y = Math.sin(dLon) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Gegenwind-Anteil in km/h (> 0 von vorn, < 0 von hinten): `windFrom` ist die Richtung, aus der der Wind kommt. */
export function headwind(speed, windFrom, heading) {
  return speed * Math.cos((windFrom - heading) * RAD);
}

/**
 * Abschnitte der Route mit dem Wetter zur Ankunftszeit. `days`: [{day, from, to}] (vgl. `dayTimes`) – Abschnitte
 * reichen nie über eine Tagesgrenze; `eta(along)` → Date. Ergebnis: [{day, from, to, time, temp, rainProb, rain,
 * wind, gust, head}]; Abschnitte ohne Vorhersage fehlen.
 */
export async function weatherAlong(route, days, eta, signal) {
  const step = Math.max(STEP, route.distance / MAX_SECTIONS);
  const sections = days.flatMap(({ day, from, to }) => {
    const n = Math.max(1, Math.round((to - from) / step)), len = (to - from) / n;
    return Array.from({ length: n }, (_, i) => {
      const a = from + i * len, b = a + len, mid = (a + b) / 2;
      const [lat, lon] = route.coords[indexAtDistance(route, mid)];
      return {
        day, from: a, to: b, lat, lon, time: eta(mid),
        heading: bearing(route.coords[indexAtDistance(route, a)], route.coords[indexAtDistance(route, b)]),
      };
    });
  });
  const at = await fetchWeather(sections, sections[0].time, sections.at(-1).time, signal);
  return sections.flatMap(s => {
    const w = at(s.lat, s.lon, s.time);
    if (!w) return [];
    return [{
      day: s.day, from: s.from, to: s.to, time: s.time, temp: w.temp, rainProb: w.rainProb ?? 0, rain: w.rain ?? 0,
      wind: w.wind, gust: w.gust, head: headwind(w.wind, w.dir, s.heading),
    }];
  });
}

/** Ab diesem Anteil von vorn oder hinten heißt der Wind Gegen- bzw. Rückenwind (km/h). */
const NOTABLE = 5;

/** Wind ohne nennenswerten Anteil von vorn oder hinten: nach der Stärke (km/h) benannt. */
const calm = speed => (speed >= 15 ? 'Seitenwind' : speed >= 8 ? 'schwacher Wind' : 'kaum Wind');

/** „Gegenwind 12 km/h“, „Rückenwind 8 km/h“, „Seitenwind 20 km/h“, „schwacher Wind“ oder „kaum Wind“ */
export function windLabel(s) {
  if (s.head >= NOTABLE) return `Gegenwind ${Math.round(s.head)} km/h`;
  if (s.head <= -NOTABLE) return `Rückenwind ${Math.round(-s.head)} km/h`;
  return s.wind >= 15 ? `Seitenwind ${Math.round(s.wind)} km/h` : calm(s.wind);
}

/** Kurztext für mehrere Abschnitte (eine Tour oder ein Tag): „6–9 °C · Regen wahrscheinlich ab ca. 15:10 (60 %) · …“ */
export function weatherSummary(sections) {
  const temps = sections.map(s => Math.round(s.temp));
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const parts = [lo === hi ? `${lo} °C` : `${lo}–${hi} °C`];

  const maxProb = Math.max(...sections.map(s => s.rainProb));
  const wet = sections.find(s => s.rainProb >= 50);
  parts.push(wet ? `Regen wahrscheinlich ab ca. ${formatClock(wet.time)} (${maxProb} %)`
    : maxProb >= 25 ? `Regen möglich (${maxProb} %)` : 'trocken');

  // Anteile nach Streckenlänge; genannt wird, was überwiegt
  const total = sections.reduce((sum, s) => sum + s.to - s.from, 0);
  const group = test => {
    const hit = sections.filter(test), len = hit.reduce((sum, s) => sum + s.to - s.from, 0);
    return { share: len / total, mean: len ? hit.reduce((sum, s) => sum + Math.abs(s.head) * (s.to - s.from), 0) / len : 0 };
  };
  const against = group(s => s.head >= NOTABLE), behind = group(s => s.head <= -NOTABLE);
  const wind = (name, g) => `${name} auf ${Math.round(g.share * 100)} % der Strecke, im Mittel ${Math.round(g.mean)} km/h`;
  if (against.share >= 0.2 && against.share >= behind.share) parts.push(wind('Gegenwind', against));
  else if (behind.share >= 0.2) parts.push(wind('Rückenwind', behind));
  else parts.push(calm(Math.max(...sections.map(s => s.wind))));

  const gust = Math.max(...sections.map(s => s.gust ?? 0));
  if (gust >= 30) parts.push(`Böen bis ${Math.round(gust)} km/h`);
  return parts.join(' · ');
}
