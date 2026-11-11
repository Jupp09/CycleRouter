/**
 * Karte und Höhenprofil: Erzeugung, Routenlinie und die verschiebbaren Marker (Start, Ziel, Zwischenstopps).
 * Klicks und Marker-Verschiebungen gibt die Karte an Handler weiter, die waypoints.js über
 * setMapHandlers() einträgt – so braucht dieses Modul die Wegpunkt-Logik nicht zu kennen.
 */
import { createMap } from '../map.js';
import { createElevation } from '../elevation.js';
import { state, isLoop, activeVias } from './state.js';
import { $ } from './dom.js';

const handlers = { onClick: null, onMarkerDrag: null };

/** Reaktion auf Kartenklick und verschobene Marker eintragen. */
export function setMapHandlers(h) {
  Object.assign(handlers, h);
}

export const map = createMap($('#map'), {
  onClick: point => handlers.onClick?.(point),
  onMarkerDrag: (index, point) => handlers.onMarkerDrag?.(index, point),
});

export const elevation = createElevation($('#elevation-chart'), { onHover: p => map.showHover(p) });

/** Karte nach Layout-Änderungen (z. B. Höhenprofil ein-/ausgeblendet) neu vermessen. */
export function relayout() {
  requestAnimationFrame(() => map.invalidateSize());
}

/** Routenlinie zeichnen – auf Wunsch nach Untergrund bzw. Wegtyp eingefärbt. */
export function drawRouteLine() {
  const r = state.route;
  map.setRoute(r?.coords, r?.segments, state.colorRoute ? state.breakdown : null);
}

/** Beschriftung eines Zwischenstopp-Markers: Kategorie-Symbol oder laufende Nummer. */
const manualMarker = (p, n) => ({ text: p.icon || String(n), title: `Zwischenstopp ${n}${p.label ? ': ' + p.label : ''}` });
/** Name für Start-/Ziel-Marker, z. B. „Start: Bremen“ (vorgelesen und als Tooltip). */
const placeName = (kind, p) => (p?.label ? `${kind}: ${p.label.split(',')[0]}` : kind);

/**
 * Verschiebbare Marker setzen. Mit Route: aus deren Wegpunkten (`index` = Wegpunkt-Index für das
 * Verschieben); Verpflegungsstopps und Unterkünfte haben eigene, nicht verschiebbare Marker, die
 * Stützpunkte eines importierten Wegs gar keinen.
 * Ohne Route: Start, Ziel und schon gewählte Zwischenstopps.
 */
export function updateMarkers() {
  const r = state.route;
  if (r && r.waypoints.length >= 2) {
    const loop = isLoop(r);
    const wps = loop ? r.waypoints.slice(0, -1) : r.waypoints;
    const last = r.waypoints.length - 1;
    let n = 0;
    map.setMarkers(wps.map((point, index) => {
      const kind = index === 0 ? 'start' : !loop && index === last ? 'end' : point.manual ? 'manual' : 'via';
      const title = kind === 'start' ? placeName('Start', state.start) : kind === 'end' ? placeName('Ziel', state.end) : undefined;
      return { point, index, kind, title, ...(kind === 'manual' && manualMarker(point, ++n)) };
    }).filter(m => !m.point.stop && !m.point.stay && !m.point.anchor));
    return;
  }
  const markers = [];
  if (state.start) markers.push({ point: state.start, kind: 'start', index: 0, title: placeName('Start', state.start) });
  if (state.mode === 'ab') {
    // Ohne Route (z. B. Ziel fehlt) Zwischenstopps trotzdem zeigen; `index` 'via<n>' kennzeichnet sie
    activeVias().forEach((v, i) => markers.push({ point: v, kind: 'manual', index: `via${i}`, ...manualMarker(v, i + 1) }));
    if (state.end) markers.push({ point: state.end, kind: 'end', index: 1, title: placeName('Ziel', state.end) });
  }
  map.setMarkers(markers);
}
