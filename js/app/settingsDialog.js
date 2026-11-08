/**
 * Einstellungsdialog (Zahnrad): Darstellung, ORS-Schlüssel, Heimatadresse, Durchschnittsgeschwindigkeit, Pausenstil, Mehrtagestour
 * und Konto. Die Abschnitte füllen und speichern ihre Felder selbst (homeView, stagesView, accountView);
 * hier wird nur beim Öffnen gefüllt und beim Speichern entschieden, was neu berechnet werden muss.
 */
import { storage, DEFAULT_SPEED, setAverageSpeed } from '../utils.js';
import { state, emit, BIKE_LABELS } from './state.js';
import { $ } from './dom.js';
import { showRoute, replanStops, recalc } from './pipeline.js';
import { renderStaySettings, saveStaySettings } from './stagesView.js';
import { openHomeSettings, saveHomeSettings, warmNewHome } from './homeView.js';
import { savedTheme, applyTheme, saveTheme } from './theme.js';
import { STYLES } from '../stops.js';

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

// ---------- Darstellung ----------
// Ein Klick zeigt das Schema sofort (Vorschau); „Abbrechen“ nimmt es zurück.

let pendingTheme = savedTheme();

function renderTheme() {
  for (const b of document.querySelectorAll('#theme-switch button')) b.setAttribute('aria-checked', b.dataset.value === pendingTheme);
}

$('#theme-switch').addEventListener('click', e => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value) return;
  pendingTheme = value;
  renderTheme();
  applyTheme(value);
});

// ---------- Pausenstil ----------
// Zügig: Supermarkt/Tankstelle, 10 min je Stopp; gemütlich: Café/Bäckerei/Restaurant, keine Tankstellen, 30 min.

let pendingStyle = state.supply.style;
const STYLE_HINTS = {
  fast: `Kurze Stopps, auch an Tankstellen – Supermärkte und Bäckereien bevorzugt. ${STYLES.fast.dwell} min Pause je Stopp.`,
  relaxed: `Zum Verweilen: Cafés, Bäckereien und Restaurants bevorzugt, keine Tankstellen. ${STYLES.relaxed.dwell} min Pause je Stopp.`,
};

function renderStyle() {
  for (const b of document.querySelectorAll('#supply-style-switch button')) b.setAttribute('aria-checked', b.dataset.value === pendingStyle);
  $('#supply-style-hint').textContent = STYLE_HINTS[pendingStyle] ?? '';
}

$('#supply-style-switch').addEventListener('click', e => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value) return;
  pendingStyle = value;
  renderStyle();
});

// ---------- Öffnen und Speichern ----------

const dialog = $('#settings-dialog');

$('#btn-settings').addEventListener('click', () => {
  // Der ORS-Schlüssel bleibt im Browser (localStorage) und wird nie mit dem Konto abgeglichen
  $('#ors-key').value = storage.get('orsKey', '');
  pendingTheme = savedTheme();
  renderTheme();
  pendingSpeed = storage.get('avgSpeed', null);
  renderSpeed();
  pendingStyle = state.supply.style in STYLES ? state.supply.style : 'fast';
  renderStyle();
  renderStaySettings();
  openHomeSettings();
  dialog.showModal();
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') {
    applyTheme(savedTheme()); // Vorschau zurücknehmen (Abbrechen oder Esc)
    return;
  }
  saveTheme(pendingTheme);
  storage.set('orsKey', $('#ors-key').value.trim());

  const speedChanged = pendingSpeed !== storage.get('avgSpeed', null);
  if (speedChanged) {
    storage.set('avgSpeed', pendingSpeed);
    setAverageSpeed(pendingSpeed);
  }
  const styleChanged = pendingStyle !== state.supply.style;
  if (styleChanged) {
    state.supply.style = pendingStyle;
    storage.set('supplyStyle', pendingStyle);
  }
  const staysChanged = saveStaySettings();
  if (state.provider !== 'ors') { // bei ORS berechnet recalc() unten ohnehin neu (der Schlüssel könnte neu sein)
    if (staysChanged && state.multiDay && state.route) replanStops(); // Etappen/Unterkünfte neu planen
    else if (speedChanged) refreshTimes();
    else if (styleChanged && state.supply.enabled && state.route) replanStops(); // andere Stopps, andere Pausen
    else if (staysChanged) emit('stages'); // z. B. Knopf „Als Mehrtagestour planen“ ein-/ausblenden
  }
  const newHome = saveHomeSettings();
  if (state.provider === 'ors') recalc();
  if (newHome) warmNewHome(newHome);
});
