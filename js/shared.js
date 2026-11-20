/**
 * Gemeinsame Werte und Helfer für Browser und Server (server/accountApi.mjs, über js/poiSource.js auch der
 * POI-Cache) – eine Quelle, damit beide Seiten nicht auseinanderlaufen. Wird auch von Node geladen, daher ohne
 * Abhängigkeiten zu Browser-APIs.
 */

/**
 * Einstellungen, die zwischen Geräten abgeglichen werden. Der Server verwirft alle anderen Schlüssel.
 * Der ORS-API-Key gehört bewusst nicht dazu – er bleibt nur im Browser.
 */
export const SYNC_KEYS = ['home', 'bike', 'traffic', 'eurovelo', 'provider', 'breakdown', 'colorRoute',
  'supplyEnabled', 'supplyInterval', 'supplyStyle', 'avgSpeed', 'mode', 'distanceKm', 'visibleBikes', 'visibleModes',
  'stageMaxKm', 'nightBudget', 'stayTypes', 'endStay', 'hiddenStays'];

/** Routenarten: A → B, Start + Distanz, Rundkurs. */
export const MODES = ['ab', 'distance', 'loop'];

/** Fahrradtypen: Rennrad, Gravel, Trekking-/Alltagsrad, E-Bike (Pedelec bis 25 km/h). */
export const BIKES = ['road', 'gravel', 'trekking', 'ebike'];

/**
 * Abbruch durch den Aufrufer (`signal`, optional) oder nach `ms` (dann TimeoutError) – jede Anfrage an einen
 * fremden Dienst bekommt so ein Zeitlimit, damit ein hängender Server nichts blockiert.
 */
export function withTimeout(signal, ms) {
  if (!AbortSignal.timeout) return signal; // sehr alte Browser: ohne Zeitlimit
  if (!signal) return AbortSignal.timeout(ms);
  return AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : signal;
}

/**
 * Text ohne Ortsangaben für Fehlerberichte (js/errorReport.js, server/clientErrors.mjs): Abfrage und #-Teil
 * jeder Adresse weg (darin stehen Start, Ziel und Wegpunkte der Route), Zahlen mit 3+ Nachkommastellen
 * (Koordinaten) durch „…“ ersetzen, Steuerzeichen entfernen (keine gefälschten Zeilen im Server-Log).
 * Höchstens `max` Zeichen.
 */
export function scrub(text, max) {
  if (text == null) return '';
  return String(text)
    .replace(/([a-z][\w+.-]*:\/\/[^\s?#)]*)[?#][^\s)]*/gi, '$1')
    .replace(/-?\d+\.\d{3,}/g, '…')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, max);
}
