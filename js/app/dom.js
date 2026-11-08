/**
 * Helfer für die Oberfläche: Elementzugriff, Statuszeile, Rückfrage-Dialog und Geräteerkennung.
 * Das DOM wird von Hand gebaut (createElement/textContent); innerHTML nur für feste Gerüste, nie für
 * Daten aus OSM, vom Nutzer oder vom Server.
 */

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

/** Statuszeile oben im Panel; `kind`: undefined | 'loading' | 'error'. Leerer Text blendet sie aus. */
export function setStatus(text, kind) {
  ui.status.hidden = !text;
  ui.status.className = 'status' + (kind ? ' ' + kind : '');
  ui.status.textContent = text || '';
}

/** Kurzer Hinweis in der Statuszeile, der nach einigen Sekunden verschwindet (wenn nichts anderes läuft). */
export function flashStatus(text) {
  setStatus(text);
  setTimeout(() => { if (ui.status.textContent === text) setStatus(null); }, 10000);
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
