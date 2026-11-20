/**
 * Handy: Die Karte füllt den Bildschirm, das Panel liegt als Blatt darüber und rastet in drei Stufen ein –
 * „Kurz“ (Griff, Kennzahlen bzw. Kopfzeile), „Halb“ (Start/Ziel und Fahrrad ohne Scrollen) und „Voll“. Der Griff
 * ist ein Knopf, der die Stufen durchschaltet (Tastatur, Screenreader); dazu lässt sich das Blatt ziehen (unten).
 *
 * Die Stufe steht als `data-sheet` am Panel, die sichtbare Höhe als CSS-Variable `--sheet-visible` – das ist die
 * echte Höhe des Blatts (nicht verschoben), so endet es immer am Bildschirmrand und der Inhalt scrollt darin. `--map-covered` ist, was davon die Karte unten verdeckt – in Stufe „Kurz“
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

/** Höhe von Safaris schwebender Leiste im Browser (CSS --browser-bar, in der installierten App 0). */
const browserBar = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--browser-bar')) || 0;

const inBrowser = window.matchMedia('(display-mode: browser) and (pointer: coarse)');
// Die schwebende untere Leiste gibt es nur bei Safari auf iPhone/iPad (iOS 26/27; das iPad meldet sich als Mac mit
// Touch). Auf Android liegen Adress- und Navigationsleiste nie über der Seite – dort bliebe der Abstand eine leere
// Fläche, und bei Wischgesten-Navigation kann der Viewport durchaus bis auf 100 px an die Bildschirmhöhe reichen.
// (bei jedem Messen gelesen, nicht einmal beim Laden: so lässt es sich im Test umschalten)
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Höhe, die Safaris Leiste unten verdeckt, wenn sie über der Seite schwebt (iOS 26/27; die Seite erfährt sie nicht). */
const FLOATING_BAR = 64;

/**
 * Liegt Safaris untere Leiste über der Seite oder darunter? Beides kommt vor: Je nachdem, wie die Seite geöffnet
 * wurde (z. B. über einen Link aus einer anderen App), endet der Viewport schon über der Leiste. Dann wären die
 * 64 px Abstand nur eine leere Fläche über der Leiste. Erkennbar am Viewport: Reicht er fast bis zum unteren
 * Bildschirmrand (es fehlt höchstens die Statusleiste oben), schwebt die Leiste darüber; sonst endet er davor.
 * Setzt --browser-bar am Wurzelelement; ohne Browser-Ansicht (installierte App, Rechner) und außerhalb von iOS 0.
 */
function measureBrowserBar() {
  const portrait = window.innerHeight >= window.innerWidth;
  const screenHeight = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const floating = ios() && inBrowser.matches && screenHeight - window.innerHeight < 100;
  document.documentElement.style.setProperty('--browser-bar', floating ? `${FLOATING_BAR}px` : '0px');
}
// „Kurz“ um die Browser-Leiste höher, sonst läge die Kennzahlen-Zeile darunter. „Halb“: 60 %, damit Start und Ziel
// samt Hinweis ohne Scrollen zu sehen sind (iPhone 393 × 852 im Browser; 55 % schnitten das Ziel-Feld ab)
const visible = state => (state === 'full' ? window.innerHeight - TOP_GAP : state === 'half' ? Math.round(window.innerHeight * 0.6) : PEEK + browserBar());

/** Stufe setzen: 'peek' | 'half' | 'full' (am Rechner ohne Wirkung). */
export function setSheet(state) {
  current = state;
  apply();
}

/** Aktuelle Stufe (am Rechner null). */
export function sheetState() {
  return phone.matches ? current : null;
}

/**
 * Wie viel der Karte unten verdeckt ist (px) – für das Einpassen der Route; am Rechner 0. Dazu die Leiste mit
 * Maßstab und Quellenangabe, die über der Blattkante sitzt – sonst landet z. B. der Zielmarker darunter.
 */
export function sheetCovered() {
  if (!phone.matches) return 0;
  const controls = $('.leaflet-bottom.leaflet-right')?.offsetHeight || 0;
  return (parseFloat(document.documentElement.style.getPropertyValue('--map-covered')) || 0) + controls;
}

function apply() {
  const root = document.documentElement.style;
  measureBrowserBar();
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

// Ein Tippen auf den Griff schaltet weiter – außer es war das Ende eines Ziehens
let dragged = false;
handle.addEventListener('click', () => {
  if (dragged) { dragged = false; return; }
  setSheet(NEXT[current]);
});

// ---------- Ziehen ----------
// Am Griff und an der Kennzahlen-Zeile (nicht an deren Knopf): Das Blatt folgt dem Finger, beim Loslassen rastet
// es ein – nach schnellem Wischen eine Stufe in Wischrichtung, sonst auf der nächstgelegenen Stufe. Nur diese
// Flächen haben touch-action: none; Karte und Inhalt des Blatts scrollen wie gewohnt.
const FLICK = 0.5;   // px/ms: ab dieser Geschwindigkeit zählt die Richtung, nicht die Lage
const SLOP = 6;      // px: kleinere Bewegungen sind ein Tippen
const ORDER = ['peek', 'half', 'full'];
let drag = null;

function startDrag(e) {
  if (!phone.matches || e.button > 0 || e.target.closest('button:not(#sheet-handle), a')) return;
  drag = { id: e.pointerId, y0: e.clientY, h0: visible(current), y: e.clientY, t: e.timeStamp, v: 0, moved: false };
  e.currentTarget.setPointerCapture(e.pointerId);
}

function moveDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = drag.y0 - e.clientY;
  if (!drag.moved && Math.abs(dy) < SLOP) return;
  if (!drag.moved) { drag.moved = true; panel.classList.add('dragging'); }
  const dt = Math.max(1, e.timeStamp - drag.t);
  drag.v = (drag.y - e.clientY) / dt; // positiv = nach oben
  drag.y = e.clientY; drag.t = e.timeStamp;
  const height = Math.min(visible('full'), Math.max(visible('peek'), drag.h0 + dy));
  document.documentElement.style.setProperty('--sheet-visible', `${height}px`);
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { moved, v } = drag;
  drag = null;
  panel.classList.remove('dragging');
  if (!moved) return; // Tippen: erledigt der click-Handler
  dragged = true;
  setTimeout(() => { dragged = false; }, 0); // kein click danach (z. B. außerhalb des Griffs losgelassen)
  const height = parseFloat(document.documentElement.style.getPropertyValue('--sheet-visible'));
  let target;
  if (Math.abs(v) >= FLICK) {
    // Wischen: von der aktuellen Lage aus die nächste Stufe in Wischrichtung
    const above = ORDER.filter(s => visible(s) > height + 1), below = ORDER.filter(s => visible(s) < height - 1);
    target = v > 0 ? (above[0] ?? 'full') : (below.at(-1) ?? 'peek');
  } else {
    target = ORDER.reduce((a, b) => (Math.abs(visible(b) - height) < Math.abs(visible(a) - height) ? b : a));
  }
  setSheet(target);
}

for (const el of [handle, $('#route-summary')]) {
  el.addEventListener('pointerdown', startDrag);
  el.addEventListener('pointermove', moveDrag);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

// Ein Feld oder Knopf, der per Tastatur den Fokus bekommt, läge sonst unter dem Bildschirmrand
panel.addEventListener('focusin', e => {
  if (phone.matches && current !== 'full' && e.target !== handle && !e.target.closest('.route-summary')) setSheet('full');
});

/**
 * Nach einer neu angezeigten Route (showRoute mit Einpassen): auf „Kurz“, damit die Route frei auf der Karte
 * liegt. Ruft pipeline.js vor dem Einpassen auf, damit sheetCovered() schon die neue Stufe kennt.
 */
export function sheetAfterRoute() {
  if (phone.matches) setSheet('peek');
}

// Das Höhenprofil erscheint und verschwindet mit der Route; ohne Route wieder „Halb“ (Start/Ziel sichtbar)
on('route', r => {
  if (!r && phone.matches) current = 'half';
  requestAnimationFrame(apply);
});
window.addEventListener('resize', apply);
phone.addEventListener('change', apply);
apply();
