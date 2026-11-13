/**
 * Zeitachse einer Tour: Wann ist man wo? Grundlage für Öffnungszeiten, Feiertage und Tagesetappen.
 *
 * Mehrtagestouren: `route.stageStarts` (m) sind die Übernachtungsorte. Danach beginnt ein neuer Tag
 * zur selben Uhrzeit wie die Abfahrt am ersten Tag.
 */
import { estimateTime, indexAtDistance, cumulativeAscent } from './utils.js';
import { locateOnRoute } from './routeGeometry.js';

/**
 * Ankunftszeit-Funktion für eine Route: `eta(along, pausesToday)` → Date.
 * `pausesToday` × `pauseMin` wird als Aufenthaltszeit addiert (Stopps desselben Tages).
 * `eta.dayOf(along)` liefert den Tag (0, 1, …).
 */
export function timeline(r, departure, bike, pauseMin = 0) {
  const asc = cumulativeAscent(r.coords);
  const starts = [0, ...(r.stageStarts || [])];
  // Abfahrt an Tag d: Kalendertag weiterzählen, nicht 24 h addieren – sonst startet der Tag nach der
  // Zeitumstellung (letzter Sonntag im März/Oktober) eine Stunde zu früh oder zu spät
  const dayStart = d => new Date(departure.getFullYear(), departure.getMonth(), departure.getDate() + d,
    departure.getHours(), departure.getMinutes(), departure.getSeconds());
  const dayOf = along => { let d = 0; while (d + 1 < starts.length && starts[d + 1] <= along) d++; return d; };
  const eta = (along, pausesToday = 0) => {
    const d = dayOf(along);
    const from = starts[d];
    const i = indexAtDistance(r, along), i0 = indexAtDistance(r, from);
    const sec = estimateTime(along - from, (asc[i] || 0) - (asc[i0] || 0), bike) + pausesToday * pauseMin * 60;
    return new Date(dayStart(d).getTime() + sec * 1000);
  };
  eta.dayOf = dayOf;
  return eta;
}

/** Ankunftszeit an Position `along` (m) einer Route – ohne Pausen. */
export function arrivalAt(r, departure, bike) {
  const eta = timeline(r, departure, bike);
  return along => eta(along);
}

/** Kennzahlen je Tag einer Mehrtagestour: [{day, from, to, distance, ascent, time}] */
export function stageStats(r, bike) {
  const bounds = [0, ...(r.stageStarts || []), r.distance];
  const asc = cumulativeAscent(r.coords);
  return bounds.slice(0, -1).map((from, i) => {
    const to = bounds[i + 1];
    const ascent = Math.round((asc[indexAtDistance(r, to)] || 0) - (asc[indexAtDistance(r, from)] || 0));
    return { day: i + 1, from, to, distance: to - from, ascent, time: estimateTime(to - from, ascent, bike) };
  });
}

/**
 * Ankunftszeit an jeder Position einschließlich der Pausen an den Verpflegungsstopps desselben Tages
 * (`r.dwellMin` je Stopp, auch an fest übernommenen) – wie die Zeiten in der Stoppliste. `at(along)` → Date.
 */
export function pausedTimeline(r, departure, bike) {
  const eta = timeline(r, departure, bike, r.dwellMin || 0);
  const along = locateOnRoute(r, r.waypoints);
  const pauses = r.waypoints.flatMap((p, i) => (p.stop || p.food ? [along[i]] : []));
  return pos => eta(pos, pauses.filter(a => a < pos && eta.dayOf(a) === eta.dayOf(pos)).length);
}

/** Abfahrt und Ankunft je Tag, mit Pausen (`pausedTimeline`): [{day, from, to, start, end}] (Date). */
export function dayTimes(r, departure, bike) {
  const at = pausedTimeline(r, departure, bike);
  const bounds = [0, ...(r.stageStarts || []), r.distance];
  return bounds.slice(0, -1).map((from, i) => {
    const to = bounds[i + 1];
    // 1 m vor der Grenze: Genau an der Grenze beginnt für die Zeitachse schon der nächste Tag
    return { day: i + 1, from, to, start: at(from), end: at(Math.max(from, to - 1)) };
  });
}
