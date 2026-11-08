/**
 * Einstellungsdialog (Zahnrad): ORS-Schlüssel, Heimatadresse, Durchschnittsgeschwindigkeit, Mehrtagestour
 * und Konto. Die Abschnitte füllen und speichern ihre Felder selbst (homeView, stagesView, accountView);
 * hier wird nur beim Öffnen gefüllt und beim Speichern entschieden, was neu berechnet werden muss.
 */
import { storage, DEFAULT_SPEED, setAverageSpeed } from '../utils.js';
import { state, emit, BIKE_LABELS } from './state.js';
import { $ } from './dom.js';
import { showRoute, replanStops, recalc } from './pipeline.js';
import { renderStaySettings, saveStaySettings } from './stagesView.js';
import { openHomeSettings, saveHomeSettings, warmNewHome } from './homeView.js';

// ---------- Durchschnittsgeschwindigkeit ----------
// Gespeichert als km/h oder null (= Standard je Fahrradtyp). Grundlage für Fahrzeit und Ankunftszeiten.

const speedRange = $('#speed-range');
let pendingSpeed = null; // Auswahl im Dialog, null = Standard

function renderSpeed() {
  const value = pendingSpeed ?? DEFAULT_SPEED[state.bike];
  speedRange.value = value;
  $('#speed-out').textContent = pendingSpeed == null
    ? `${value} km/h (Standard ${BIKE_LABELS[state.bike]})`
    : `${value} km/h`;
  $('#speed-reset').hidden = pendingSpeed == null;
}

speedRange.addEventListener('input', () => { pendingSpeed = Number(speedRange.value); renderSpeed(); });
$('#speed-reset').addEventListener('click', () => { pendingSpeed = null; renderSpeed(); });

setAverageSpeed(storage.get('avgSpeed', null));

/** Fahrzeit und Ankunftszeiten nach geänderter Geschwindigkeit neu berechnen (Route bleibt gleich). */
function refreshTimes() {
  if (!state.route) return;
  if (state.supply.enabled) replanStops(); // Ankunftszeiten bestimmen Öffnungsstatus und Auswahl der Stopps
  else showRoute(state.route, { fit: false });
}

// ---------- Öffnen und Speichern ----------

const dialog = $('#settings-dialog');

$('#btn-settings').addEventListener('click', () => {
  // Der ORS-Schlüssel bleibt im Browser (localStorage) und wird nie mit dem Konto abgeglichen
  $('#ors-key').value = storage.get('orsKey', '');
  pendingSpeed = storage.get('avgSpeed', null);
  renderSpeed();
  renderStaySettings();
  openHomeSettings();
  dialog.showModal();
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  storage.set('orsKey', $('#ors-key').value.trim());

  const speedChanged = pendingSpeed !== storage.get('avgSpeed', null);
  if (speedChanged) {
    storage.set('avgSpeed', pendingSpeed);
    setAverageSpeed(pendingSpeed);
  }
  const staysChanged = saveStaySettings();
  if (state.provider !== 'ors') { // bei ORS berechnet recalc() unten ohnehin neu (der Schlüssel könnte neu sein)
    if (staysChanged && state.multiDay && state.route) replanStops(); // Etappen/Unterkünfte neu planen
    else if (speedChanged) refreshTimes();
    else if (staysChanged) emit('stages'); // z. B. Knopf „Als Mehrtagestour planen“ ein-/ausblenden
  }
  const newHome = saveHomeSettings();
  if (state.provider === 'ors') recalc();
  if (newHome) warmNewHome(newHome);
});
