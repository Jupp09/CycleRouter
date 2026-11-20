// Fehlerberichte aus dem Browser: POST /api/client-error (gesendet von js/errorReport.js).
//
// Die Berichte landen nur im Server-Log (bei Plesk im Passenger-Log der App), Zeile „Browserfehler: …“.
// Gespeichert wird nichts, auch nicht die IP. Gleiche Fehler stehen je Stunde nur einmal im Log, mit der Zahl
// der Wiederholungen beim nächsten Mal – sonst schriebe ein Fehler, der bei jedem Aufruf auftritt, das Log voll.
//
// Ortsangaben werden noch einmal entfernt (der Browser tut es schon, aber auf ihn ist kein Verlass):
// #-Teil und Abfrage jeder Adresse (darin stehen die Routenpunkte) und Zahlen mit 3+ Nachkommastellen.
import { HttpError, readJson, sendJson } from './http.mjs';
import { clientIp } from './auth.mjs';
import { createLimiter } from './rateLimit.mjs';
import { scrub } from '../js/shared.js';

/** Berichte je Anschluss und Stunde – der Browser schickt höchstens 5 je Seitenaufruf. */
const perClient = createLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
/** Berichte insgesamt je Stunde – gegen ein Log, das jemand mit vielen Adressen füllt. */
const total = createLimiter({ windowMs: 60 * 60 * 1000, max: 500 });

const DEDUPE_MS = 60 * 60 * 1000;
const MAX_SEEN = 1000;
const seen = new Map(); // Schlüssel → {at, repeats}

const int = v => (Number.isInteger(v) && v >= 0 && v < 1e7 ? v : undefined);

// Reihenfolge zählt: Edge nennt auch „Chrome“, Chrome auch „Safari“
/** @type {[string, RegExp][]} */
const BROWSERS = [['Edge', /Edg\/(\d+)/], ['Firefox', /Firefox\/(\d+)/], ['Chrome', /Chrome\/(\d+)/], ['Safari', /Version\/([\d.]+).*Safari/]];

/** Browser und System grob aus dem User-Agent (genauer braucht es für die Fehlersuche nicht). */
export function browserOf(ua = '') {
  const hit = BROWSERS.map(([name, re]) => [name, re.exec(ua)]).find(([, m]) => m);
  const browser = hit ? `${hit[0]} ${hit[1][1]}` : 'unbekannt';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '?';
  return `${browser}, ${os}`;
}

export async function handleClientError(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Nur POST' });
  try {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Erwartet JSON');
    const ip = clientIp(req);
    if (!perClient.fits(ip, 1) || !total.fits('all', 1)) throw new HttpError(429, 'Zu viele Fehlerberichte');
    const body = await readJson(req, 8 * 1024);
    const message = scrub(body.message, 500);
    if (!message) throw new HttpError(400, 'Meldung fehlt');
    perClient.add(ip, 1);
    total.add('all', 1);

    const kind = body.kind === 'rejection' ? 'Promise' : 'Fehler';
    const source = scrub(body.source, 300);
    const where = source ? ` @ ${source}${int(body.line) ? `:${int(body.line)}:${int(body.column) ?? 0}` : ''}` : '';
    const key = `${kind}|${message}|${where}`;
    const now = Date.now();
    const hit = seen.get(key);
    if (hit && now - hit.at < DEDUPE_MS) {
      hit.repeats++;
    } else {
      if (seen.size >= MAX_SEEN) seen.delete(seen.keys().next().value);
      seen.delete(key); // neu einfügen, damit die Reihenfolge dem Alter entspricht
      seen.set(key, { at: now, repeats: 0 });
      const repeats = hit?.repeats ? ` (in der Stunde davor ${hit.repeats}× wiederholt)` : '';
      const app = body.standalone === true ? ', installierte App' : '';
      const name = typeof body.name === 'string' && body.name !== 'Error' ? `${scrub(body.name, 60)}: ` : '';
      // Chrome beginnt den Stack mit der Meldung, Firefox/Safari direkt mit der ersten Fundstelle
      const lines = scrub(body.stack, 2000).split('\n').map(l => l.trim()).filter(Boolean);
      if (lines[0]?.includes(message.slice(0, 40))) lines.shift();
      const stack = lines.slice(0, 7).map(l => `    ${l}`).join('\n');
      console.warn(`Browserfehler (${kind}, ${browserOf(req.headers['user-agent'])}${app})${repeats}: ${name}${message}${where}`
        + (stack ? `\n${stack}` : ''));
    }
    res.writeHead(204).end();
  } catch (e) {
    sendJson(res, e instanceof HttpError ? e.status : 400, { error: e instanceof HttpError ? e.message : 'Ungültiger Bericht' });
  }
}
