/**
 * Eingaben nach dem Berechnen einklappen: Sobald eine Route angezeigt wird, schrumpft das Formular (#plan: Modus,
 * Wegpunkte, Distanz/Richtung, Fahrrad, Mehr Optionen) zu einer Zeile wie „A → B · Köln → Bonn · Fahrrad“ mit
 * „Ändern“ – das Ergebnis rückt nach oben, statt unter allen Eingaben zu stehen. Bei Distanz/Rundkurs steht
 * „Neu würfeln“ mit in der Zeile, weil man es nach dem Erzeugen oft braucht.
 *
 * Hat der Nutzer aufgeklappt, bleibt es offen, bis er wieder einklappt oder die Route gelöscht wird – er ist
 * dann gerade am Ändern, und jede Neuberechnung würde ihm sonst das Formular wegnehmen. Kartenklicks, Marker
 * und Rückgängig wirken auch eingeklappt.
 */
import { state, on, BIKE_LABELS } from './state.js';
import { $ } from './dom.js';
import { setSheet, sheetState } from './sheetView.js';

const plan = $('#plan'), summary = $('#plan-summary'), text = $('#plan-summary-text');
const edit = $('#btn-plan-edit'), reroll = $('#btn-reroll-summary');
let openedByUser = false;

const place = p => (p?.label ? p.label.split(',')[0].trim() : p ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '–');

function summaryText() {
  const bike = BIKE_LABELS[state.bike];
  if (state.mode === 'ab') {
    const vias = state.vias.filter(v => v.lat != null).length;
    return [`A → B · ${place(state.start)} → ${place(state.end)}`, vias ? `${vias} ${vias === 1 ? 'Zwischenstopp' : 'Zwischenstopps'}` : '', bike]
      .filter(Boolean).join(' · ');
  }
  return `${state.mode === 'loop' ? 'Rundkurs' : 'Strecke'} ${state.distanceKm} km ab ${place(state.start)} · ${bike}`;
}

function render() {
  const route = state.route;
  const collapsed = !!route && !openedByUser;
  const focusInside = plan.contains(document.activeElement);
  plan.hidden = collapsed;
  summary.hidden = !route;
  edit.textContent = collapsed ? 'Ändern' : 'Einklappen';
  edit.setAttribute('aria-expanded', String(!collapsed));
  reroll.hidden = !route || state.mode === 'ab';
  if (route) text.textContent = summaryText();
  // Fokus nicht im verschwundenen Formular lassen (z. B. nach Enter in der Zielsuche). Am Handy auf den Griff des
  // Blatts: „Ändern“ läge in Stufe „Kurz“ unter dem Bildschirmrand, und Fokus dort öffnete das Blatt wieder ganz
  if (collapsed && focusInside) (sheetState() ? $('#sheet-handle') : edit).focus({ preventScroll: true });
}

on('route', r => {
  if (!r) openedByUser = false;
  render();
});

edit.addEventListener('click', () => {
  openedByUser = plan.hidden;
  if (openedByUser) setSheet('full'); // Handy: zum Ändern das ganze Blatt
  render();
  if (!plan.hidden) plan.querySelector('[aria-checked="true"], input, button')?.focus({ preventScroll: true });
});
reroll.addEventListener('click', () => $('#btn-reroll').click());
