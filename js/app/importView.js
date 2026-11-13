/**
 * GPX-Datei öffnen (Knopf oder Datei auf die Karte ziehen): Die Strecke wird im Browser gelesen und verlässt das
 * Gerät nicht. Sie wird zur A→B-Route mit Start und Ziel am ersten und letzten Punkt – auch eine Runde, denn im
 * Modus „Rundkurs“ würde jede Neuberechnung einen neuen Zufallskurs erzeugen. Stopps, Unterkünfte und
 * Zwischenstopps führen nur über kurze Abstecher vom importierten Weg weg (`trackRoute` in routing/index.js).
 */
import { parseGpx } from '../gpx.js';
import { trackRoute } from '../routing/index.js';
import { formatKm } from '../utils.js';
import { state } from './state.js';
import { $, setStatus, flashStatus } from './dom.js';
import { abortCalculation, showRoute, run } from './pipeline.js';
import { applyRouteSettings } from './controls.js';
import { setRoutePoints } from './waypoints.js';
import { searchAlong } from './alongView.js';
import { checkpoint } from './history.js';

/** Größere Dateien sind kaum eine einzelne Tour; das Lesen würde den Browser spürbar blockieren. */
const MAX_BYTES = 30 * 1024 * 1024;

const input = $('#gpx-file');
$('#btn-import').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  openFile(input.files[0]);
  input.value = ''; // dieselbe Datei soll sich erneut öffnen lassen
});

// Datei auf die Karte ziehen
const mapEl = $('#map');
const hasFile = e => [...(e.dataTransfer?.types || [])].includes('Files');
mapEl.addEventListener('dragover', e => { if (hasFile(e)) e.preventDefault(); });
mapEl.addEventListener('drop', e => {
  if (!hasFile(e)) return;
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});

async function openFile(file) {
  if (!file) return;
  if (file.size > MAX_BYTES) { setStatus('Die Datei ist zu groß (höchstens 30 MB).', 'error'); return; }
  let track;
  try {
    track = parseGpx(await file.text());
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  const { coords } = track;
  const name = track.name || file.name.replace(/\.[^.]+$/, '');

  checkpoint('GPX-Datei geöffnet');
  abortCalculation();
  searchAlong(null);
  applyRouteSettings({ mode: 'ab' });
  const start = { lat: coords[0][0], lon: coords[0][1] };
  const end = { lat: coords.at(-1)[0], lon: coords.at(-1)[1] };
  Object.assign(state, { saved: null, loadedName: name, multiDay: false, stayChoices: [], staysError: null });
  setRoutePoints(start, end, []);
  const r = trackRoute(coords, [start, end]);
  state.track = r;
  showRoute(r);
  // Stopps auf den importierten Weg aufsetzen (wie beim Öffnen einer gespeicherten Route)
  if (state.supply.enabled) run(async () => r, { fit: false, loadingText: 'Wird geplant …' });
  else flashStatus(`„${name}“ geöffnet: ${formatKm(r.distance)}.`);
}
