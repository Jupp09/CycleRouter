/**
 * Helfer für die Oberfläche: Elementzugriff, Statuszeile, Rückfrage-Dialog und Geräteerkennung.
 * Das DOM wird von Hand gebaut (createElement/textContent); innerHTML nur für feste Gerüste, nie für
 * Daten aus OSM, vom Nutzer oder vom Server.
 */
import { announce } from '../announce.js';

export const $ = sel => document.querySelector(sel);

/** Häufig genutzte Elemente. */
export const ui = {
  startInput: $('#start-input'),
  endInput: $('#end-input'),
  range: $('#distance-range'),
  num: $('#distance-num'),
  distanceOut: $('#distance-out'),
  status: $('#status'),
  results: $('#results'),
  routeName: $('#route-name'),
};

/** Smartphone/Tablet (für Teilen statt Herunterladen); iPadOS meldet sich als Mac mit Touch. */
export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- Statuszeile ----------

/**
 * Statuszeile oben im Panel; `kind`: undefined | 'loading' | 'error'. Leerer Text blendet sie aus.
 * Der Text wird auch für Screenreader angesagt (Fehler sofort, sonst höflich).
 */
export function setStatus(text, kind) {
  ui.status.hidden = !text;
  ui.status.className = 'status' + (kind ? ' ' + kind : '');
  ui.status.textContent = text || '';
  if (text) announce(text, { urgent: kind === 'error' });
}

/** Mindestdauer, die ein Hinweis aus flashStatus() sichtbar bleibt */
const FLASH_MIN_MS = 4000;
let endFlash = null;

/**
 * Kurzer Hinweis in der Statuszeile (z. B. „Route gespeichert“). Er verschwindet nicht nach einer festen
 * Zeit, sondern erst, wenn man weiterarbeitet (nächster Klick, Tipp oder Tastendruck), frühestens nach
 * FLASH_MIN_MS – wer langsamer liest oder kurz wegschaut, verpasst ihn so nicht. Hat inzwischen etwas
 * anderes die Statuszeile übernommen, bleibt diese unberührt.
 */
export function flashStatus(text) {
  endFlash?.();
  setStatus(text);
  const shown = Date.now();
  const onInput = () => {
    if (Date.now() - shown < FLASH_MIN_MS) return;
    endFlash();
    if (ui.status.textContent === text && !ui.status.classList.contains('loading')) setStatus(null);
  };
  document.addEventListener('pointerdown', onInput, true);
  document.addEventListener('keydown', onInput, true);
  endFlash = () => {
    document.removeEventListener('pointerdown', onInput, true);
    document.removeEventListener('keydown', onInput, true);
    endFlash = null;
  };
}

// ---------- Elemente ----------

/** Link, der in einem neuen Tab öffnet. */
export function externalLink(text, href) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

/** Knopf im Link-Stil (für Nebenaktionen in Hinweiszeilen). */
export function linkButton(text, onClick, title = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-btn inline';
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/** Einfache Textzeilen als <div>-Elemente (z. B. für Popups). */
export const textLines = lines => lines.map(t => { const d = document.createElement('div'); d.textContent = t; return d; });

/**
 * Listenzeile als Knopf (per Tastatur erreichbar). `parts`: Inhalt als <span>/<small> – ein <button> darf
 * keine <div> enthalten.
 */
export function rowButton(parts, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row';
  b.append(...parts);
  b.addEventListener('click', onClick);
  return b;
}

/** Hauptknopf in einem Karten-Popup (z. B. „Als Zwischenstopp hinzufügen“). */
export function popupButton(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'primary';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** Kleiner Knopf rechts in einer Listenzeile; `label` ist der vollständige Name für Screenreader. */
export function listAction(text, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'add';
  b.textContent = text;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

/** <span> mit Klasse und Text. */
export function span(className, text = '') {
  const s = document.createElement('span');
  if (className) s.className = className;
  s.textContent = text;
  return s;
}

// ---------- Umschalter (role="radiogroup") ----------

/**
 * Tastaturbedienung wie bei Optionsfeldern: nur der gewählte Knopf ist per Tab erreichbar, Pfeiltasten
 * (und Pos1/Ende) wechseln die Auswahl. Der gewählte Knopf wird über aria-checked erkannt – ändert ihn
 * der Code (syncUi), zieht ein MutationObserver die Tab-Reihenfolge nach.
 */
function radioGroup(group) {
  const buttons = () => [...group.querySelectorAll('[role="radio"]')];
  const sync = () => {
    const bs = buttons();
    const checked = bs.find(b => b.getAttribute('aria-checked') === 'true') || bs[0];
    for (const b of bs) b.tabIndex = b === checked ? 0 : -1;
  };
  new MutationObserver(sync).observe(group, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
  sync();
  group.addEventListener('keydown', e => {
    const bs = buttons();
    const i = bs.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const j = step ? (i + step + bs.length) % bs.length : e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    bs[j].focus();
    bs[j].click();
  });
}
for (const g of document.querySelectorAll('[role="radiogroup"]')) radioGroup(g);

// ---------- Rückfrage ----------

/**
 * Rückfrage im App-Stil (statt confirm()/prompt(), die im iOS-Vollbildmodus fremd wirken).
 * Mit `input` (Vorgabewert) als Eingabe → Text oder null; sonst → true/null.
 */
export function ask({ title, text = '', input = null, ok = 'OK', danger = false }) {
  const dlg = $('#ask-dialog');
  const field = $('#ask-input');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-text').hidden = !text;
  field.hidden = input == null;
  field.value = input ?? '';
  $('#ask-ok').textContent = ok;
  $('#ask-ok').className = danger ? 'danger' : 'primary';
  dlg.returnValue = '';
  dlg.showModal();
  if (input != null) { field.focus(); field.select(); }
  return new Promise(resolve => dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') resolve(null);
    else resolve(input != null ? field.value : true);
  }, { once: true }));
}
