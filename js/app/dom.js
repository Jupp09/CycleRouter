/**
 * Helfer für die Oberfläche: Elementzugriff, Statuszeile, Rückfrage-Dialog und Geräteerkennung.
 * Das DOM wird von Hand gebaut (createElement/textContent); innerHTML nur für feste Gerüste, nie für
 * Daten aus OSM, vom Nutzer oder vom Server.
 */
import { announce } from '../announce.js';
import { osmUrl, osmEditUrl, osmNoteUrl } from '../utils.js';

/**
 * Erstes passende Element. Typ bewusst `any`: Die Aufrufer wissen, was sie holen (input, dialog …) – sonst
 * bräuchte jeder Zugriff auf `.value` oder `.showModal()` eine eigene Typangabe.
 * @type {(sel: string) => any}
 */
export const $ = sel => document.querySelector(sel);
/** Alle passenden Elemente als Array (Typ wie bei `$`). @type {(sel: string) => any[]} */
export const $$ = sel => [...document.querySelectorAll(sel)];

/** Häufig genutzte Elemente. */
export const ui = {
  startInput: $('#start-input'),
  endInput: $('#end-input'),
  range: $('#distance-range'),
  num: $('#distance-num'),
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

/**
 * Link-Zeile für ein OSM-Objekt im Popup: ansehen, bearbeiten (OSM-Konto nötig) und Fehler melden (ohne Konto).
 * `extra`: weitere Links davor (z. B. Preis prüfen, Webseite).
 */
export function osmLinks(poi, extra = []) {
  const box = document.createElement('div');
  box.className = 'links';
  box.append(...extra,
    externalLink('In OSM ansehen', osmUrl(poi.id)),
    externalLink('Bearbeiten', osmEditUrl(poi.id)),
    externalLink('Fehler melden', osmNoteUrl(poi)));
  /** @type {HTMLElement} */ (box.lastChild).title = 'Hinweis für Mapper vor Ort – ohne OpenStreetMap-Konto';
  /** @type {HTMLElement} */ (box.children[box.children.length - 2]).title = 'Im Editor von OpenStreetMap öffnen, z. B. um Öffnungszeiten nachzutragen (OSM-Konto nötig)';
  return box;
}

/**
 * Element mit Klasse und Text – Text immer über textContent, also auch für OSM-, Nutzer- und Serverdaten geeignet.
 * @param {string} tag @param {string} [className] @param {string} [text] @returns {any}
 */
export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** <span> mit Klasse und Text. */
export function span(className, text = '') { return el('span', className, text); }

/** Knopf (type="button", schickt kein Formular ab) mit Klickaktion. */
function button(className, text, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Hinweiszeile, wenn ein Laden/Café in OSM keine eigenen Öffnungszeiten hat. */
export function missingHoursLine() {
  return el('div', 'muted', 'Öffnungszeiten fehlen in OpenStreetMap – über „Bearbeiten“ nachtragen.');
}

/** Knopf im Link-Stil (für Nebenaktionen in Hinweiszeilen). */
export function linkButton(text, onClick, title = '') {
  const b = button('link-btn inline', text, onClick);
  if (title) b.title = title;
  return b;
}

/** Einfache Textzeilen als <div>-Elemente (z. B. für Popups). */
export function textLines(lines) { return lines.map(t => el('div', '', t)); }

/** Inhalt eines Karten-Popups: Rahmen mit fettem Titel (Symbol und Name); der Rest wird angehängt. */
export function popupBox(title) {
  const box = el('div', 'stop-popup');
  box.append(el('b', '', title));
  return box;
}

/**
 * Listenzeile als Knopf (per Tastatur erreichbar). `parts`: Inhalt als <span>/<small> – ein <button> darf
 * keine <div> enthalten.
 */
export function rowButton(parts, onClick) {
  const b = button('row', '', onClick);
  b.append(...parts);
  return b;
}

/** Hauptknopf in einem Karten-Popup (z. B. „Als Zwischenstopp hinzufügen“). */
export function popupButton(text, onClick) { return button('primary', text, onClick); }

/** Kleiner Knopf rechts in einer Listenzeile; `label` ist der vollständige Name für Screenreader. */
export function listAction(text, label, onClick) {
  const b = button('add', text, onClick);
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

// ---------- Umschalter (role="radiogroup") ----------

/**
 * Tastaturbedienung wie bei Optionsfeldern: nur der gewählte Knopf ist per Tab erreichbar, Pfeiltasten
 * (und Pos1/Ende) wechseln die Auswahl. Der gewählte Knopf wird über aria-checked erkannt – ändert ihn
 * der Code (syncUi), zieht ein MutationObserver die Tab-Reihenfolge nach.
 */
function radioGroup(group) {
  // Ausgeblendete Knöpfe (Einstellungen „Auswahl anpassen“) überspringen
  const buttons = () => [...group.querySelectorAll('[role="radio"]')].filter(b => !b.hidden);
  const sync = () => {
    const bs = buttons();
    const checked = bs.find(b => b.getAttribute('aria-checked') === 'true') || bs[0];
    for (const b of bs) b.tabIndex = b === checked ? 0 : -1;
  };
  new MutationObserver(sync).observe(group, { subtree: true, attributes: true, attributeFilter: ['aria-checked', 'hidden'] });
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
