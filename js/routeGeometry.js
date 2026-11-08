/**
 * Geometrie auf einer berechneten Route: Wo liegt ein Punkt entlang der Route, wie weit ist er entfernt,
 * und wie fügt man zusätzliche Wegpunkte (Verpflegungsstopps, Unterkünfte) an der richtigen Stelle ein?
 *
 * Positionen entlang der Route heißen überall `along` (Meter ab Start, vgl. `route.cum`).
 */
import { approxDist, sampleRoute, indexAtDistance } from './utils.js';

/**
 * Position (m ab Start) jedes Punkts auf der Route, in Reihenfolge der Punkte.
 * Gesucht wird vorwärts ab dem vorherigen Treffer; sobald der Punkt nah war und die Route sich
 * wieder entfernt, gilt er als passiert. Das ist wichtig bei Rundkursen und Hin-und-zurück-Strecken,
 * bei denen ein Ort mehrfach an der Route liegt.
 */
export function locateOnRoute(r, points) {
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

/**
 * Nächster Punkt aus `samples` (siehe sampleRoute) zu einem Ort → {along, offset (m)}.
 * Der Breitengrad-Vorfilter spart bei vielen Orten die meisten Entfernungsberechnungen.
 */
export function nearestSample(samples, lat, lon, maxLatDiff = 0.05) {
  let offset = Infinity, along = 0;
  for (const s of samples) {
    if (Math.abs(s.lat - lat) > maxLatDiff) continue;
    const d = approxDist(s.lat, s.lon, lat, lon);
    if (d < offset) { offset = d; along = s.along; }
  }
  return { along, offset };
}

/**
 * Orte, die höchstens `maxOffset(poi)` m neben der Route liegen → [{poi, along, offset}].
 * Jede Passage zählt einzeln: Ein Ort am Hin- und am Rückweg wird zweimal Kandidat.
 */
export function locateNearRoute(r, pois, maxOffset, step = 100) {
  const samples = sampleRoute(r, step);
  const out = [];
  for (const poi of pois) {
    const max = maxOffset(poi);
    const latTol = max / 110000;
    let pass = null;
    for (const s of samples) {
      const d = Math.abs(s.lat - poi.lat) > latTol ? Infinity : approxDist(s.lat, s.lon, poi.lat, poi.lon);
      if (d <= max) {
        if (!pass || d < pass.offset) pass = { poi, along: s.along, offset: d };
      } else if (pass) {
        out.push(pass);
        pass = null;
      }
    }
    if (pass) out.push(pass);
  }
  return out;
}

/**
 * Wegpunkte, die die Form einer Route festhalten. Normalerweise die Wegpunkte der Route selbst; ein
 * ORS-Rundkurs hat aber nur den Startpunkt – dann Stützpunkte bei 25/50/75 % der Strecke.
 */
function shapeAnchors(r) {
  if (r.waypoints.length >= 2) return r.waypoints;
  const start = r.waypoints[0];
  const at = f => { const c = r.coords[indexAtDistance(r, r.distance * f)]; return { lat: c[0], lon: c[1] }; };
  return [start, at(0.25), at(0.5), at(0.75), start]; // gleiches Objekt am Anfang und Ende: bleibt ein Rundkurs
}

/**
 * Zusätzliche Wegpunkte an ihrer Position (`along`, m auf `base`) zwischen die vorhandenen Wegpunkte
 * einsortieren → neue Wegpunktliste für die Neuberechnung. items: [{along, point}]
 */
export function insertWaypoints(base, items) {
  const anchors = shapeAnchors(base);
  const anchorAlong = locateOnRoute(base, anchors);
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
