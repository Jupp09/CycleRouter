/**
 * Fehlerberichte an den eigenen Server (POST /api/client-error, server/clientErrors.mjs).
 *
 * Ohne Berichte sähe man einen Fehler nur in der Konsole des Nutzers – auf dem Handy nie. Gemeldet werden nur
 * ungefangene Fehler und abgelehnte Promises dieser App (nicht die von Browser-Erweiterungen), höchstens
 * MAX_REPORTS je Seitenaufruf. Der Bericht enthält Meldung, Stack und Fundstelle, nie die Adresse samt
 * #-Teil (darin stehen Start, Ziel und Wegpunkte der Route) und keine Koordinaten: Beides entfernt `scrub`
 * (shared.js) hier, und der Server filtert es noch einmal. Die IP sieht der Server ohnehin; er speichert sie nicht.
 *
 * Wird als erstes Modul von main.js ausgeführt, damit auch Fehler beim Start der übrigen Module ankommen.
 * (Ein Syntaxfehler in irgendeinem Modul verhindert allerdings den ganzen Modulgraphen, auch dieses Modul.)
 */
import { scrub } from './shared.js';

const ENDPOINT = 'api/client-error';
const MAX_REPORTS = 5;
/** Erlaubte Herkunft der Skripte: die App selbst und Leaflet von cdnjs. */
const OWN = [location.origin, 'https://cdnjs.cloudflare.com'];

/**
 * Die letzten Probleme dieser Sitzung (ohne Orte, `scrub`), für „Feedback geben“ mit technischen Angaben:
 * ungefangene Fehler und Fehlermeldungen in der Statuszeile (dom.js meldet sie mit noteProblem).
 */
const recent = [];
const RECENT_MAX = 10;
export function noteProblem(text) {
  const t = scrub(text, 300);
  if (!t || recent.at(-1)?.endsWith(t)) return;
  recent.push(`${new Date().toTimeString().slice(0, 5)} ${t}`);
  if (recent.length > RECENT_MAX) recent.shift();
}
export function recentProblems() { return [...recent]; }

let left = MAX_REPORTS;
let available = true; // false, wenn die App ohne server.mjs läuft (statischer Server) – dann gar nicht erst senden
const seen = new Set();

function send(kind, error, where = {}) {
  noteProblem(error?.message ?? error);
  if (!available || left <= 0 || !navigator.onLine) return;
  const message = scrub(error?.message ?? error, 500);
  if (!message || message === 'Script error.') return; // fremdes Skript ohne Einzelheiten
  const key = `${kind}|${message}|${where.source ?? ''}|${where.line ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  left--;
  const body = JSON.stringify({
    kind, message,
    name: typeof error?.name === 'string' ? error.name.slice(0, 60) : undefined,
    stack: scrub(error?.stack, 2000) || undefined,
    source: where.source ? scrub(where.source, 300) : undefined,
    line: where.line, column: where.column,
    standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  });
  // keepalive: Der Bericht kommt auch an, wenn die Seite gerade geschlossen wird
  fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
    signal: AbortSignal.timeout(5000),
  }).then(res => {
    if ([404, 405, 501].includes(res.status)) available = false;
  }).catch(() => { /* Bericht ist nicht wichtig genug für einen weiteren Fehler */ });
}

/** Stammt der Fehler aus einem Skript dieser App? (Erweiterungen melden chrome-extension://… u. Ä.) */
function ours(filename) {
  if (!filename) return true; // z. B. Fehler in einem Modul-Ereignis ohne Dateiangabe
  return OWN.some(origin => filename.startsWith(`${origin}/`));
}

window.addEventListener('error', e => {
  if (!e.error && !e.message) return; // Ladefehler von Bildern u. Ä. (kein Skriptfehler)
  if (!ours(e.filename)) return;
  send('error', e.error ?? e.message, { source: e.filename, line: e.lineno, column: e.colno });
});

window.addEventListener('unhandledrejection', e => {
  const reason = e.reason;
  if (reason?.name === 'AbortError') return; // abgebrochene Berechnung, wird überall bewusst verschluckt
  const stack = String(reason?.stack ?? '');
  if (stack && !OWN.some(origin => stack.includes(origin))) return; // nur eigene Stapel
  send('rejection', reason);
});
