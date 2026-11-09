// Kleine HTTP-Helfer für server.mjs und die Konto-Schnittstelle (node:http, ohne Framework).

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
