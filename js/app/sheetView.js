/**
 * Handy: Die Karte füllt den Bildschirm, das Panel liegt als Blatt darüber und rastet in drei Stufen ein –
 * „Kurz“ (Griff, Kennzahlen bzw. Kopfzeile), „Halb“ (Start/Ziel und Fahrrad ohne Scrollen) und „Voll“. Der Griff
 * ist ein Knopf, der die Stufen durchschaltet (Tastatur, Screenreader); Ziehen kommt in einem eigenen Schritt.
 *
 * Die Stufe steht als `data-sheet` am Panel, die sichtbare Höhe als CSS-Variable `--sheet-visible` (das Blatt
 * schiebt sich per transform hoch). `--map-covered` ist, was davon die Karte unten verdeckt – in Stufe „Kurz“
 * samt Höhenprofil darüber; danach richten sich Leaflets untere Bedienelemente (Maßstab, Quellenangabe) und das
 * Einpassen der Route (sheetCovered). Am Rechner (über 800 px Breite) ist das alles aus.
 */
import { on } from './state.js';
import { $ } from './dom.js';

const panel = $('#panel'), handle = $('#sheet-handle');
const phone = window.matchMedia('(max-width: 800px)');
/** Sichtbare Höhe in Stufe „Kurz“ (px): Griff und eine Zeile Kennzahlen bzw. die Kopfzeile. */
const PEEK = 150;
/** Abstand des vollen Blatts zum oberen Rand (px) – ein Streifen Karte bleibt sichtbar. */
const TOP_GAP = 48;
/** Höhe des Höhenprofils auf dem Handy (style.css). */
const PROFILE = 120;
const NEXT = { peek: 'half', half: 'full', full: 'peek' };

let current = 'half';

const visible = state => (state === 'full' ? window.innerHeight - TOP_GAP : state === 'half' ? Math.round(window.innerHeight * 0.55) : PEEK);

/** Stufe setzen: 'peek' | 'half' | 'full' (am Rechner ohne Wirkung). */
export function setSheet(state) {
  current = state;
  apply();
}

/** Aktuelle Stufe (am Rechner null). */
export function sheetState() {
  return phone.matches ? current : null;
}

/** Wie viel der Karte unten verdeckt ist (px) – für das Einpassen der Route; am Rechner 0. */
export function sheetCovered() {
  return phone.matches ? parseFloat(document.documentElement.style.getPropertyValue('--map-covered')) || 0 : 0;
}

function apply() {
  const root = document.documentElement.style;
  if (!phone.matches) {
    panel.removeAttribute('data-sheet');
    root.removeProperty('--sheet-visible');
    root.removeProperty('--map-covered');
    return;
  }
  const height = visible(current);
  panel.dataset.sheet = current;
  root.setProperty('--sheet-visible', `${height}px`);
  const profile = current === 'peek' && !$('#elevation').hidden ? PROFILE : 0;
  root.setProperty('--map-covered', `${height + profile}px`);
  handle.setAttribute('aria-expanded', String(current === 'full'));
  handle.setAttribute('aria-label', current === 'full' ? 'Panel verkleinern' : 'Panel vergrößern');
}

handle.addEventListener('click', () => setSheet(NEXT[current]));

// Ein Feld oder Knopf, der per Tastatur den Fokus bekommt, läge sonst unter dem Bildschirmrand
panel.addEventListener('focusin', e => {
  if (phone.matches && current !== 'full' && e.target !== handle && !e.target.closest('.route-summary')) setSheet('full');
});

// Das Höhenprofil erscheint und verschwindet mit der Route
on('route', () => requestAnimationFrame(apply));
window.addEventListener('resize', apply);
phone.addEventListener('change', apply);
apply();
