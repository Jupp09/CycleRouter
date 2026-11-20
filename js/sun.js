/**
 * Sonnenauf- und -untergang für Ort und Tag – lokal berechnet (Näherung nach NOAA, auf 1–2 min genau),
 * ohne externen Dienst. Dazu die Hinweistexte: Fährt man an einem Tag im Dunkeln?
 */
import { formatClock, formatDuration, formatWeekday } from './utils.js';

const RAD = Math.PI / 180;

/** {rise, set} als Date für den Kalendertag von `date`; null bei Polartag oder Polarnacht. */
export function sunTimes(lat, lon, date) {
  // Tage seit dem 1.1.2000 12 Uhr (UTC), bezogen auf den Kalendertag des Geräts
  const n = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 86400000 - 10957.5;
  const j = n - lon / 360;
  const M = (357.5291 + 0.98560028 * j) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545 + j + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const sinD = Math.sin(L * RAD) * Math.sin(23.4397 * RAD), cosD = Math.sqrt(1 - sinD * sinD);
  // −0,833°: Lichtbrechung in der Atmosphäre und Radius der Sonnenscheibe
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinD) / (Math.cos(lat * RAD) * cosD);
  if (Math.abs(cosW) > 1) return null;
  const w = Math.acos(cosW) / RAD / 360;
  const at = jd => new Date((jd - 2440587.5) * 86400000);
  return { rise: at(transit - w), set: at(transit + w) };
}

const span = (a, b) => formatDuration(Math.max(60, (b - a) / 1000));

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Wie lange zwischen `start` und `end` (Date) die Sonne nicht scheint (ms) – über beliebig viele Kalendertage.
 * Je Tag gilt der Ort, an dem man mittags ungefähr ist (zwischen Start und Ziel nach Zeit gemittelt). Früher
 * wurde nur „Ankunft minus Sonnenuntergang am ersten Tag“ gerechnet; über Nacht kamen so mehr Dunkelstunden
 * heraus, als die Fahrt überhaupt dauert. Null bei Polartag oder Polarnacht an einem der Tage.
 */
export function darkMs(start, end, startAt, endAt) {
  const total = end.getTime() - start.getTime();
  if (total <= 0) return 0;
  let light = 0;
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d < end;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const f = Math.min(1, Math.max(0, (d.getTime() + 12 * 3.6e6 - start.getTime()) / total));
    const t = sunTimes(startAt[0] + (endAt[0] - startAt[0]) * f, startAt[1] + (endAt[1] - startAt[1]) * f, d);
    if (!t) return null;
    light += Math.max(0, Math.min(end.getTime(), t.set.getTime()) - Math.max(start.getTime(), t.rise.getTime()));
  }
  return total - light;
}

/**
 * Hinweis für einen Fahrtag mit bekannter Abfahrt: `{start, end}` (Date, vgl. `dayTimes`), Start- und Zielort
 * als [lat, lon]. Sonnenaufgang gilt am Start, Sonnenuntergang am Ziel → {text, warn, overnight?} oder null.
 * `overnight`: Die Ankunft liegt an einem späteren Kalendertag – dann nennt der Text den Tag der Ankunft, und das
 * Ergebnis-Panel bietet die Mehrtagestour gleich am Hinweis an.
 */
export function daylightNote({ start, end }, startAt, endAt) {
  if (!sameDay(start, end)) {
    const dark = darkMs(start, end, startAt, endAt);
    if (dark == null) return null;
    return {
      text: `Ankunft erst ${formatWeekday(end)} ca. ${formatClock(end)} – die Fahrt geht über Nacht, etwa ${formatDuration(dark / 1000)} davon im Dunkeln.`,
      warn: true,
      overnight: true,
    };
  }
  const rise = sunTimes(startAt[0], startAt[1], start)?.rise, set = sunTimes(endAt[0], endAt[1], start)?.set;
  if (!rise || !set) return null;
  if (start >= set) {
    return { text: `Abfahrt ${formatClock(start)} nach Sonnenuntergang (${formatClock(set)}) – Fahrt im Dunkeln.`, warn: true };
  }
  if (end <= rise) {
    return { text: `Ankunft ca. ${formatClock(end)} vor Sonnenaufgang (${formatClock(rise)}) – Fahrt im Dunkeln.`, warn: true };
  }
  const parts = [];
  if (start < rise) parts.push(`Abfahrt ${formatClock(start)}, Sonnenaufgang ${formatClock(rise)} – etwa ${span(start, rise)} im Dunkeln.`);
  if (end > set) parts.push(`Ankunft ca. ${formatClock(end)}, Sonnenuntergang ${formatClock(set)} – etwa ${span(set, end)} im Dunkeln.`);
  if (parts.length) return { text: parts.join(' '), warn: true };
  return {
    text: `Tageslicht ${formatClock(rise)}–${formatClock(set)} – Ankunft ca. ${formatClock(end)}, ${span(end, set)} vor Sonnenuntergang.`,
    warn: false,
  };
}

/**
 * Hinweis ohne festgelegte Abfahrt: nur der helle Tag heute am Start. Gewarnt wird allein, wenn die Fahrzeit
 * (s) länger ist als der helle Tag – „jetzt“ als Abfahrt würde abends bei jeder Planung für morgen warnen.
 */
export function daylightToday(at, rideSeconds, today = new Date()) {
  const t = sunTimes(at[0], at[1], today);
  if (!t) return null;
  const long = rideSeconds * 1000 > t.set.getTime() - t.rise.getTime();
  return {
    text: `Tageslicht heute am Start: ${formatClock(t.rise)}–${formatClock(t.set)} (${span(t.rise, t.set)})`
      + (long ? ' – die Fahrzeit ist länger als der helle Tag.' : ''),
    warn: long,
  };
}
