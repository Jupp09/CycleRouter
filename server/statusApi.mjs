// Statusseite der Admins und die Routen-Zählung aus dem Browser (Zahlen: server/status.mjs).
//
//   GET  /api/admin/status                                   → statusReport()        (nur Konten in ADMIN_USERS)
//   POST /api/route-stats   {ms, servers: [...], error?}     → 204
//
// /api/route-stats meldet je fertiger (oder gescheiterter) Grundroute, welcher Dienst gerechnet hat und wie lange
// es dauerte – nur das, keine Orte, keine Länge, kein Konto. Daraus zeigt die Statusseite den Anteil der
// Ausweichrouten (Valhalla) und der zu langen Strecken. Gezählt wird nur im Speicher, je Anschluss begrenzt.
import { currentUser, clientIp } from './auth.mjs';
import { dbEnabled } from './db.mjs';
import { HttpError, sendJson, readJson } from './http.mjs';
import { createLimiter } from './rateLimit.mjs';
import { statusReport, cleanRouteStats, noteRoute } from './status.mjs';

/** Berichte je Anschluss und Stunde – mehr Routen rechnet niemand von Hand */
const perClient = createLimiter({ windowMs: 3600 * 1000, max: 200 });

/** true, wenn die Anfrage diesem Modul gehört */
export async function handleStatus(req, res, url) {
  const path = url.pathname;
  if (path !== '/api/admin/status' && path !== '/api/route-stats') return false;
  try {
    if (path === '/api/route-stats') {
      if (req.method !== 'POST') throw new HttpError(405, 'Nur POST');
      if (!perClient.take(clientIp(req))) throw new HttpError(429, 'Zu viele Berichte');
      const stats = cleanRouteStats(await readJson(req, 1024));
      if (!stats) throw new HttpError(400, 'Ungültiger Bericht');
      noteRoute(stats);
      res.writeHead(204).end();
      return true;
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Nur GET');
    if (!dbEnabled()) throw new HttpError(503, 'Ohne Datenbank gibt es keine Anmeldung.');
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Bitte anmelden.');
    if (!user.admin) throw new HttpError(403, 'Kein Zugriff.');
    sendJson(res, 200, statusReport(), { 'Cache-Control': 'no-store' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(`${path}:`, e.message);
    sendJson(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Interner Fehler' });
  }
  return true;
}
