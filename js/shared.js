/**
 * Gemeinsame Werte für Browser (js/account.js) und Server (server/accountApi.mjs) – eine Quelle, damit beide
 * Seiten nicht auseinanderlaufen. Wird auch von Node geladen, daher ohne Abhängigkeiten zu Browser-APIs.
 */

/**
 * Einstellungen, die zwischen Geräten abgeglichen werden. Der Server verwirft alle anderen Schlüssel.
 * Der ORS-API-Key gehört bewusst nicht dazu – er bleibt nur im Browser.
 */
export const SYNC_KEYS = ['home', 'bike', 'traffic', 'eurovelo', 'provider', 'breakdown', 'colorRoute',
  'supplyEnabled', 'supplyInterval', 'avgSpeed', 'mode', 'distanceKm',
  'stageMaxKm', 'nightBudget', 'stayTypes', 'endStay'];

/** Routenarten: A → B, Start + Distanz, Rundkurs. */
export const MODES = ['ab', 'distance', 'loop'];

/** Fahrradtypen: Rennrad, Gravel, Trekking-/Alltagsrad. */
export const BIKES = ['road', 'gravel', 'trekking'];
