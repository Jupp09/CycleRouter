/**
 * Rückgängig und Wiederholen für Änderungen an Wegpunkten und Route (Start, Ziel, Zwischenstopps, Marker,
 * Löschen, „Neu würfeln“, Öffnen einer Route oder GPX-Datei).
 *
 * Vor jeder solchen Änderung legt `checkpoint()` einen Schnappschuss ab – samt der Route als Objekt. Routen werden
 * nie verändert (jeder Schritt erzeugt eine neue), deshalb stellt `undo()` den alten Stand exakt und ohne
 * Neuberechnung wieder her. Der Verlauf lebt nur im Speicher. Einstellungen (Fahrrad, Verkehr …) legen keinen
 * eigenen Schritt an, werden aber mit dem Stand zurückgesetzt, zu dem die Route gehört. Was auf dem Server
 * geschieht (Speichern, Löschen in „Meine Routen“), ist nicht Teil des Verlaufs.
 */
import { state } from './state.js';
import { $, flashStatus } from './dom.js';
import { updateMarkers } from './mapView.js';
import { abortCalculation, showRoute, clearRoute, replanStops } from './pipeline.js';
import { applyRouteSettings, syncUi } from './controls.js';
import { setRoutePoints } from './waypoints.js';

const LIMIT = 20;
const undoStack = [], redoStack = []; // Einträge {label, snap}
let justTaken = false;

function snapshot() {
  const s = state;
  return {
    mode: s.mode, bike: s.bike, traffic: s.traffic, eurovelo: s.eurovelo, provider: s.provider,
    distanceKm: s.distanceKm, direction: s.direction, seed: s.seed,
    start: s.start, end: s.end, vias: [...s.vias],
    // Ein Zwischenstopp ohne Route wird beim Verschieben selbst verändert – seine Werte deshalb mitmerken
    viaData: s.vias.map(v => ({ ...v })),
    route: s.route, track: s.track, saved: s.saved && { ...s.saved }, loadedName: s.loadedName,
    multiDay: s.multiDay, stayChoices: [...s.stayChoices],
  };
}

function restore(snap) {
  abortCalculation();
  if (!snap.route) clearRoute();
  applyRouteSettings(snap);
  snap.vias.forEach((v, i) => Object.assign(v, snap.viaData[i]));
  Object.assign(state, {
    distanceKm: snap.distanceKm, direction: snap.direction, seed: snap.seed,
    track: snap.track, saved: snap.saved && { ...snap.saved }, loadedName: snap.loadedName,
    multiDay: snap.multiDay, stayChoices: [...snap.stayChoices], staysLoading: false, staysError: null,
  });
  syncUi();
  setRoutePoints(snap.start, snap.end, snap.vias);
  if (!snap.route) { updateMarkers(); return; }
  showRoute(snap.route, { fit: false });
  // Verpflegung inzwischen ein- oder ausgeschaltet: Die Stopps der alten Route passen nicht mehr dazu
  if (state.supply.enabled !== !!snap.route.stops) replanStops();
}

function updateButtons() {
  for (const [id, stack, verb] of [['#btn-undo', undoStack, 'Rückgängig'], ['#btn-redo', redoStack, 'Wiederholen']]) {
    const button = $(id), top = stack[stack.length - 1];
    button.disabled = !top;
    button.title = top ? `${verb}: ${top.label}` : '';
  }
}

/**
 * Stand vor einer Änderung merken; `label` benennt die Änderung („Zwischenstopp hinzugefügt“). Mehrere Aufrufe
 * im selben Durchlauf (ein Kartenklick ruft addVia, das wiederum …) ergeben einen Schritt mit dem ersten Namen.
 */
export function checkpoint(label) {
  if (justTaken) return;
  justTaken = true;
  queueMicrotask(() => { justTaken = false; });
  undoStack.push({ label, snap: snapshot() });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateButtons();
}

function step(from, to, verb) {
  const entry = from.pop();
  if (!entry) return;
  to.push({ label: entry.label, snap: snapshot() });
  restore(entry.snap);
  updateButtons();
  flashStatus(`${verb}: ${entry.label}`);
}

/** Letzte Änderung zurücknehmen. */
export function undo() { step(undoStack, redoStack, 'Rückgängig'); }
/** Zurückgenommene Änderung wiederherstellen. */
export function redo() { step(redoStack, undoStack, 'Wiederholt'); }

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

// Strg+Z / Strg+Umschalt+Z (oder Strg+Y), auf dem Mac mit Cmd – nicht in Eingabefeldern (dort gilt das Rückgängig
// des Browsers für den Text) und nicht, solange ein Dialog offen ist
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (key === 'y' || e.shiftKey) redo(); else undo();
});
