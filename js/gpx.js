import { indexAtDistance, approxDist } from './utils.js';
import { locateOnRoute } from './routeGeometry.js';

const escapeXml = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const hours = s => s.poi.tags.opening_hours
  || (s.poi.typical ? `${s.poi.typical.hours} (typisch für ${s.poi.typical.chain})` : '');

/**
 * GPX einer Route. `range` {from, to} (m ab Start): nur dieser Abschnitt, z. B. ein Tag einer Mehrtagestour –
 * Track zugeschnitten, Wegpunkte nur aus dem Abschnitt (Übernachtungen an beiden Enden gehören dazu).
 */
export function toGpx(route, name, range = null) {
  const time = new Date().toISOString();
  // 1 m Spielraum: Wegpunkte an der Tagesgrenze (Unterkunft) liegen sonst je nach Rundung knapp außerhalb
  const inRange = along => !range || (along >= range.from - 1 && along <= range.to + 1);
  const coords = range
    ? route.coords.slice(indexAtDistance(route, range.from), indexAtDistance(route, range.to) + 1)
    : route.coords;
  const points = coords.map(([lat, lon, ele]) =>
    `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele != null ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`,
  ).join('\n');
  // Feste Zwischenstopps und Unterkünfte haben keine Position auf der Route – über die Wegpunkte verorten
  const wpAlong = range ? locateOnRoute(route, route.waypoints) : [];
  const alongOf = p => wpAlong[route.waypoints.indexOf(p)];
  const vias = route.waypoints.filter(p => p.manual).map((p, i) => [p, i]).filter(([p]) => inRange(alongOf(p))).map(([p, i]) =>
    `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">
    <name>${escapeXml(p.label || `Zwischenstopp ${i + 1}`)}</name>
    <sym>Flag, Blue</sym>
  </wpt>
`).join('');
  // Übernachtungen einer Mehrtagestour: die Unterkünfte unterwegs sind Wegpunkte der Route (in derselben
  // Reihenfolge wie die Nächte), die am Ziel liegt am Ende
  const stayPoints = route.waypoints.filter(p => p.stay);
  const stayAlong = n => (n.end ? route.distance : alongOf(stayPoints[route.stays.nights.filter(m => m.chosen && !m.end).indexOf(n)]));
  const stays = (route.stays?.nights || []).filter(n => n.chosen && (!range || inRange(stayAlong(n)))).map(n => {
    const p = n.chosen.poi;
    return `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">
    <name>${escapeXml(`Nacht ${n.index + 1}: ${p.name || 'Unterkunft'}`)}</name>
    <sym>${p.type === 'camp_site' ? 'Campground' : 'Lodging'}</sym>
  </wpt>
`;
  }).join('');
  // Trinkwasser an der Route (nur angezeigt, nicht angefahren) – auf dem Radcomputer nützlich
  const water = (route.water || []).filter(w => inRange(w.along)).map(w => `  <wpt lat="${w.poi.lat.toFixed(6)}" lon="${w.poi.lon.toFixed(6)}">
    <name>${escapeXml(`Trinkwasser${w.poi.name ? ': ' + w.poi.name : ''}`)}</name>${w.poi.tags.opening_hours ? `
    <desc>${escapeXml(w.poi.tags.opening_hours)}</desc>` : ''}
    <sym>Drinking Water</sym>
  </wpt>
`).join('');
  const wpts = vias + stays + water + (route.stops || []).filter(s => inRange(s.along)).map(s => {
    const name = `${s.typeLabel}${s.poi.name ? ': ' + s.poi.name : ''}`;
    return `  <wpt lat="${s.poi.lat.toFixed(6)}" lon="${s.poi.lon.toFixed(6)}">
    <name>${escapeXml(name)}</name>${hours(s) ? `
    <desc>${escapeXml(hours(s))}</desc>` : ''}
    <sym>${s.gpxSym}</sym>
  </wpt>
`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CycloRouter" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${time}</time>
  </metadata>
${wpts}  <trk>
    <name>${escapeXml(name)}</name>
    <type>cycling</type>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

const GPX_TYPE = 'application/gpx+xml';
const fileName = name => name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') + '.gpx';

/** GPX-Datei herunterladen; `range` wie bei toGpx. */
export function downloadGpx(route, name, range = null) {
  const blob = new Blob([toGpx(route, name, range)], { type: GPX_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Kann der Browser eine GPX-Datei über das Teilen-Menü des Systems weitergeben (z. B. an Komoot)?
 * Voraussetzungen: Web Share API mit Dateien (iOS Safari ≥ 15, Chrome/Edge u. a.), sichere Verbindung
 * (HTTPS oder localhost) und ein vom Browser erlaubter Dateityp – Chrome auf Android erlaubt z. B. kein GPX.
 */
export function canShareGpx() {
  if (!window.isSecureContext || !navigator.share || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File(['<gpx/>'], 'test.gpx', { type: GPX_TYPE })] });
  } catch {
    return false;
  }
}

/**
 * GPX-Dateien über das Teilen-Menü weitergeben – eine oder mehrere in einem Vorgang (z. B. alle Tage einer
 * Mehrtagestour). `files`: [{name, range?}]. → 'shared' | 'cancelled'.
 * Wirft, wenn das Teilen nicht möglich ist (der Aufrufer bietet dann den Download an).
 */
export async function shareGpx(route, files, title = files[0].name) {
  const list = files.map(f => new File([toGpx(route, f.name, f.range)], fileName(f.name), { type: GPX_TYPE }));
  if (navigator.canShare && !navigator.canShare({ files: list })) throw new Error('Diese Dateien lassen sich nicht teilen');
  try {
    await navigator.share({ files: list, title });
    return 'shared';
  } catch (e) {
    if (e.name === 'AbortError') return 'cancelled'; // Menü geschlossen, ohne zu teilen
    throw e;
  }
}

// ---------- Import ----------

/** Punkte, die näher am vorigen liegen, fallen weg – aufgezeichnete Tracks haben oft einen Punkt pro Sekunde. */
const MIN_SPACING = 10;

/**
 * GPX-Text lesen → {coords: [[lat, lon, ele | null]], name}. Genommen werden die Track-Punkte aller Tracks
 * in Dateireihenfolge, ersatzweise die Routen-Punkte. Wirft einen Fehler mit Text für die Statuszeile.
 */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement?.localName !== 'gpx') throw new Error('Die Datei ist kein gültiges GPX.');
  const all = name => [...doc.getElementsByTagNameNS('*', name)];
  const child = (el, name) => [...el.children].find(c => c.localName === name)?.textContent.trim();
  let points = all('trkpt');
  if (points.length < 2) points = all('rtept');

  const coords = [];
  let last = null;
  for (const p of points) {
    if (!p.hasAttribute('lat') || !p.hasAttribute('lon')) continue;
    const lat = Number(p.getAttribute('lat')), lon = Number(p.getAttribute('lon'));
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) continue;
    const ele = child(p, 'ele');
    last = [lat, lon, ele && Number.isFinite(Number(ele)) ? Number(ele) : null];
    const prev = coords.at(-1);
    if (!prev || approxDist(prev[0], prev[1], lat, lon) >= MIN_SPACING) coords.push(last);
  }
  // Das Ziel bleibt genau, auch wenn der letzte Punkt dem Abstand zum Opfer fiel
  if (last && coords.at(-1) !== last) coords.push(last);
  if (coords.length < 2) throw new Error('In der Datei ist keine Strecke.');

  const named = [...all('trk'), ...all('rte'), ...all('metadata')].map(el => child(el, 'name')).find(Boolean);
  return { coords, name: named || '' };
}
