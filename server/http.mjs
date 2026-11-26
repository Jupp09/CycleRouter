// Kleine HTTP-Helfer für server.mjs, die Konto-Schnittstelle und die Rückmeldungen (node:http, ohne Framework).

/** Fehler mit HTTP-Status; die (deutsche) Meldung geht als {error} an den Client. */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** JSON-Antwort senden; `headers` ergänzt bzw. überschreibt die Standard-Header. */
export function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(data));
}

/** Anfragekörper als Text lesen; bricht ab, sobald er größer als `limit` Zeichen wird (413). */
export async function readBody(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, 'Anfrage zu groß');
  }
  return body;
}

/** Anfragekörper als JSON lesen; leer → {}. Ungültiges JSON → 400, zu groß → 413 (aus readBody). */
export async function readJson(req, limit) {
  const body = await readBody(req, limit);
  try { return body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, 'Ungültiges JSON'); }
}

/** Wie readJson, aber nur mit Content-Type application/json (Teil des CSRF-Schutzes, siehe checkOrigin). */
export async function readJsonStrict(req, limit) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Erwartet JSON');
  }
  return readJson(req, limit);
}

/**
 * Schutz vor Anfragen fremder Webseiten (CSRF): Ändernde Anfragen müssen JSON sein (geht von fremden
 * Seiten nur mit CORS-Vorabprüfung, die dieser Server nicht erlaubt) und dürfen, falls der Browser
 * einen Origin mitschickt, nur von dieser Seite kommen. Dazu kommt SameSite=Lax beim Cookie.
 */
export function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost = null;
  try { originHost = new URL(origin).host; } catch { /* z. B. "null" */ }
  if (originHost !== requestHost(req)) throw new HttpError(403, 'Fremde Herkunft');
}

/** Host, unter dem der Browser diese Seite aufgerufen hat (hinter einem Proxy aus X-Forwarded-Host). */
export const requestHost = req => req.headers['x-forwarded-host'] || req.headers.host;
