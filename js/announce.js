/**
 * Ansagen für Screenreader über unsichtbare Live-Regionen – für Dinge, die sonst nur sichtbar passieren:
 * Statusmeldungen, fertig berechnete Route, Anzahl der Suchvorschläge.
 *
 * Die Regionen werden beim Laden angelegt und bleiben leer im Dokument: Eine Live-Region, die erst zusammen
 * mit ihrem Text erscheint (z. B. die ein-/ausgeblendete Statuszeile), wird von Screenreadern oft überhört.
 */
const make = urgent => {
  const el = document.createElement('div');
  el.className = 'sr-only';
  el.setAttribute('role', urgent ? 'alert' : 'status');
  el.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
  document.body.append(el);
  return el;
};
const polite = make(false);
const assertive = make(true);
const timers = new WeakMap();

/** Text vorlesen lassen; `urgent` (Fehler) unterbricht laufende Ansagen. */
export function announce(text, { urgent = false } = {}) {
  const el = urgent ? assertive : polite;
  clearTimeout(timers.get(el));
  // Erst leeren, dann kurz danach füllen – so wird auch derselbe Text erneut angesagt
  el.textContent = '';
  timers.set(el, setTimeout(() => { el.textContent = text; }, 100));
}
