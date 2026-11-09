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
