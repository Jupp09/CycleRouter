/**
 * Bedienelemente der Routenplanung: Fahrradtyp, Modus (Route/Strecke/Rundkurs), Verkehr, EuroVelo,
 * Routing-Dienst, Richtung und Wunschdistanz. `syncUi()` überträgt den Zustand auf alle Schalter und
 * blendet modusabhängige Felder (`data-show`) ein und aus.
 */
import { storage, newSeed } from '../utils.js';
import { state, provider } from './state.js';
import { $, ui } from './dom.js';
import { clearRoute, calcAB, generate, recalc } from './pipeline.js';

/** Zustand → Bedienelemente (Schalter, Felder, Hinweise). */
export function syncUi() {
  const check = (sel, attr, key, value) => {
    for (const b of document.querySelectorAll(sel)) b.setAttribute(attr, b.dataset[key] === value);
  };
  check('#bike-switch button', 'aria-checked', 'value', state.bike);
  check('#mode-tabs button', 'aria-selected', 'mode', state.mode);
  check('#breakdown-switch button', 'aria-checked', 'value', state.breakdown);
  for (const n of document.querySelectorAll('[data-show]')) n.hidden = !n.dataset.show.split(' ').includes(state.mode);

  $('#color-route').checked = state.colorRoute;
  $('#supply-enabled').checked = state.supply.enabled;
  $('#supply-options').hidden = !state.supply.enabled;
  $('#supply-interval').value = state.supply.intervalKm;
  $('#departure').value = state.supply.departure;

  // Verkehrsarm gibt es nur für Rennrad bei Diensten, die es unterstützen (BRouter)
  $('#traffic-field').hidden = state.bike !== 'road' || !provider().supportsTraffic;
  $('#traffic').value = state.traffic;
  $('#eurovelo-field').hidden = !provider().supportsEurovelo;
  $('#eurovelo').value = state.eurovelo;
  $('#provider').value = state.provider;
  $('#direction').value = state.direction;
  ui.range.value = state.distanceKm;
  ui.num.value = state.distanceKm;
  ui.distanceOut.textContent = `${state.distanceKm} km`;

  const hint = $('#provider-hint');
  hint.hidden = !(state.provider === 'ors' && state.bike === 'gravel');
  hint.textContent = 'OpenRouteService hat kein Gravel-Profil – es wird das allgemeine Fahrrad-Profil verwendet. Für echte Gravel-Routen BRouter wählen.';
}

/** Einstellung übernehmen, speichern und – falls schon eine Route da ist – neu berechnen. */
function setRoutingOption(key, value) {
  state[key] = value;
  storage.set(key, value);
  syncUi();
  recalc();
}

$('#bike-switch').addEventListener('click', e => {
  const value = e.target.closest('button')?.dataset.value;
  if (value && value !== state.bike) setRoutingOption('bike', value);
});
$('#traffic').addEventListener('change', e => setRoutingOption('traffic', e.target.value));
$('#eurovelo').addEventListener('change', e => setRoutingOption('eurovelo', e.target.value));
$('#provider').addEventListener('change', e => setRoutingOption('provider', e.target.value));

// Moduswechsel verwirft die Route; im A→B-Modus wird mit vorhandenem Start/Ziel gleich neu berechnet
$('#mode-tabs').addEventListener('click', e => {
  const mode = e.target.closest('button')?.dataset.mode;
  if (!mode || mode === state.mode) return;
  state.mode = mode;
  storage.set('mode', mode);
  syncUi();
  clearRoute();
  if (mode === 'ab') calcAB();
});

// Richtung gilt nur für die nächste Erzeugung und wird nicht gespeichert
$('#direction').addEventListener('change', e => { state.direction = e.target.value; });

/** Wunschdistanz (5–400 km) aus Schieberegler oder Zahlenfeld. */
function setDistance(km) {
  const v = Math.min(400, Math.max(5, Math.round(Number(km) || state.distanceKm)));
  state.distanceKm = v;
  storage.set('distanceKm', v);
  syncUi();
}
ui.range.addEventListener('input', () => setDistance(ui.range.value));
ui.num.addEventListener('change', () => setDistance(ui.num.value));

$('#btn-generate').addEventListener('click', generate);
$('#btn-reroll').addEventListener('click', () => { state.seed = newSeed(); generate(); });
