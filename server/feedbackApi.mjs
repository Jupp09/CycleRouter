// Rückmeldungen der Nutzer – Fehler melden, Vorschlag machen, Kritik äußern (js/app/feedbackView.js) – und ihre
// Verwaltung durch die Betreiber (js/app/feedbackAdminView.js).
//
//   POST   /api/feedback              {kind, text, email?, tech?, route?}   → {ok, id, token}
//   POST   /api/feedback/replies      {items: [{id, token}]}                → {replies: [{id, kind, text, reply, repliedAt}]}
//   GET    /api/feedback/admin?status=open|done|all                         → {items: [...]}        (nur Admins)
//   PATCH  /api/feedback/admin/:id    {done?, reply?}                                                (nur Admins)
//   DELETE /api/feedback/admin/:id                                                                   (nur Admins)
//
// Gespeichert in der Datenbank (Tabelle feedback, server/db.mjs); ohne Datenbank 503, und die App blendet
// „Feedback geben“ aus (wie die Konten, account.enabled). Admins = Konten in ADMIN_USERS (.env, auth.mjs isAdmin).
//
// Antworten kommen in der App an, ohne Mailversand: Angemeldete sehen sie über ihr Konto. Ohne Konto bekommt der
// Browser beim Senden ein zufälliges Kennzeichen (`token`, 128 Bit), das er sich merkt und mit dem er später die
// Antwort abholt; gespeichert ist nur sein SHA-256-Hash – wer die Datenbank liest, kann damit nichts abholen.
// POST statt GET beim Abholen, damit die Kennzeichen nicht in Adressen und Server-Logs stehen.
//
// Freiwillig und nur auf ausdrücklichen Wunsch des Nutzers (Häkchen) kommen dazu: eine E-Mail für Rückfragen,
// technische Angaben (Browser, Bildschirm, letzte Fehlermeldungen der App, ohne Ortsangaben) und der Link zur
// geplanten Route (enthält Start, Ziel und Zwischenstopps). Ins Log kommt nur Nummer und Art der Meldung –
// Text, E-Mail und Route stehen allein in der Datenbank. Angemeldet wird das Konto vermerkt.
//
// Schutz: JSON und gleiche Herkunft (CSRF wie bei den Konten), höchstens PER_CLIENT Meldungen je Anschluss und
// Stunde und PER_DAY insgesamt am Tag – sonst ließe sich die Datenbank mit Meldungen füllen.
import { createHash, randomBytes } from 'node:crypto';
import { query, dbEnabled } from './db.mjs';
import { clientIp, currentUser } from './auth.mjs';
import { HttpError, sendJson, readJsonStrict, checkOrigin, requestHost } from './http.mjs';
import { createLimiter } from './rateLimit.mjs';
import { scrub } from '../js/shared.js';

/** Arten einer Rückmeldung → Bezeichnung (für Log und Liste). */
export const FEEDBACK_KINDS = { bug: 'Fehler', idea: 'Vorschlag', critique: 'Kritik' };
export const TEXT_MIN = 10, TEXT_MAX = 4000;
const PER_CLIENT = 5, PER_DAY = 300;
/** So viele eigene Meldungen fragt ein Browser höchstens auf einmal nach Antworten ab. */
const MAX_TOKENS = 50;

const perClient = createLimiter({ windowMs: 3600 * 1000, max: PER_CLIENT });
const perDay = createLimiter({ windowMs: 24 * 3600 * 1000, max: PER_DAY });
// Antworten abholen: einmal je App-Start; die Grenze bremst nur das Durchprobieren von Kennzeichen
const replyChecks = createLimiter({ windowMs: 3600 * 1000, max: 120 });

// Steuerzeichen raus, Zeilenumbrüche und Tabulatoren bleiben (mehrzeilige Beschreibungen)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clip = (v, max) => String(v ?? '').replace(CONTROL, '').trim().slice(0, max);
// Bewusst schlicht: Gültig ist, was nach Adresse aussieht – zugestellt wird hier ohnehin nichts
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/;
const sha256 = s => createHash('sha256').update(s).digest('hex');
/** JSON-Spalten: Der MariaDB-Treiber liefert sie je nach Version als Text oder schon als Objekt. */
const fromJson = v => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * Anfragekörper prüfen und auf das Gespeicherte zuschneiden → {kind, text, email, tech, route}.
 * `host`: Host dieser Seite – ein Routen-Link muss auf sie zeigen (keine fremden Adressen in der Datenbank).
 * Wirft HttpError(400) mit einer Meldung für den Nutzer.
 * @param {any} body @param {string} host
 */
export function cleanFeedback(body, host) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Ungültige Rückmeldung.');
  if (!Object.hasOwn(FEEDBACK_KINDS, body.kind)) throw new HttpError(400, 'Bitte die Art der Rückmeldung wählen.');
  const text = clip(body.text, TEXT_MAX);
  if (text.length < TEXT_MIN) throw new HttpError(400, `Bitte etwas ausführlicher beschreiben (mindestens ${TEXT_MIN} Zeichen).`);
  const email = clip(body.email, 254) || null;
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'Die E-Mail-Adresse sieht nicht gültig aus.');

  let tech = null;
  if (body.tech && typeof body.tech === 'object') {
    const t = body.tech;
    tech = {
      browser: clip(t.browser, 300), screen: clip(t.screen, 40), language: clip(t.language, 20),
      standalone: t.standalone === true,
      // Fehlermeldungen noch einmal ohne Orte und Adressen (die App filtert schon, siehe errorReport.js)
      errors: (Array.isArray(t.errors) ? t.errors : []).slice(0, 10).map(e => scrub(e, 300)).filter(Boolean),
    };
  }

  let route = null;
  if (body.route) {
    route = clip(body.route, 4000);
    let link = null;
    try { link = new URL(route); } catch { /* unten */ }
    // Nur ein Link auf diese App mit Route im #-Teil (linkView.js) – kein beliebiger Text, keine fremde Adresse
    if (!link || !/^https?:$/.test(link.protocol) || link.host !== host || !link.hash.startsWith('#v=')) {
      throw new HttpError(400, 'Der Link zur Route ist ungültig.');
    }
  }
  return { kind: body.kind, text, email, tech, route };
}

/**
 * Kennzeichen, mit denen ein Browser nach Antworten fragt → [{id, hash}]; Ungültiges fällt weg.
 * @param {any} items
 */
export function cleanTokens(items) {
  return (Array.isArray(items) ? items : []).slice(0, MAX_TOKENS)
    .filter(it => it && Number.isInteger(it.id) && it.id > 0 && typeof it.token === 'string' && /^[A-Za-z0-9_-]{22}$/.test(it.token))
    .map(it => ({ id: it.id, hash: sha256(it.token) }));
}

/** Änderung durch einen Admin: {done?: boolean, reply?: string|null} – leere Antwort = Antwort zurückziehen. */
export function cleanAdminPatch(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Ungültige Änderung.');
  const out = {};
  if ('done' in body) out.done = body.done === true;
  if ('reply' in body) out.reply = clip(body.reply, TEXT_MAX) || null;
  if (!Object.keys(out).length) throw new HttpError(400, 'Nichts zu ändern.');
  return out;
}

// ---------- Anfragen ----------

/** Neue Rückmeldung speichern → {ok, id, token}. */
async function create(req, json) {
  const ip = clientIp(req);
  if (!perClient.fits(ip, 1)) throw new HttpError(429, 'Zu viele Rückmeldungen von diesem Anschluss – bitte in einer Stunde erneut.');
  if (!perDay.fits('all', 1)) throw new HttpError(429, 'Heute sind schon sehr viele Rückmeldungen eingegangen – bitte morgen erneut.');
  const f = cleanFeedback(await readJsonStrict(req, 32 * 1024), requestHost(req));
  const user = await currentUser(req);
  const token = randomBytes(16).toString('base64url'); // 22 Zeichen
  const result = await query('INSERT INTO feedback (kind, text, email, tech, route, user_id, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [f.kind, f.text, f.email, f.tech && JSON.stringify(f.tech), f.route, user?.id ?? null, sha256(token)]);
  // Erst nach dem Speichern zählen: Eine abgelehnte Eingabe (zu kurz, E-Mail vertippt) kostet nichts
  perClient.add(ip);
  perDay.add('all');
  console.log(`Rückmeldung #${result.insertId} (${FEEDBACK_KINDS[f.kind]})`);
  json(201, { ok: true, id: result.insertId, token });
}

/** Antworten auf eigene Rückmeldungen: per Kennzeichen (ohne Konto) und, angemeldet, über das Konto. */
async function replies(req, json) {
  const ip = clientIp(req);
  if (!replyChecks.take(ip)) throw new HttpError(429, 'Zu viele Abfragen – bitte später erneut.');
  const tokens = cleanTokens((await readJsonStrict(req, 16 * 1024)).items);
  const user = await currentUser(req);
  const where = [], params = [];
  if (tokens.length) {
    where.push(`(${tokens.map(() => '(id = ? AND token_hash = ?)').join(' OR ')})`);
    for (const t of tokens) params.push(t.id, t.hash);
  }
  if (user) { where.push('user_id = ?'); params.push(user.id); }
  if (!where.length) return json(200, { replies: [] });
  const rows = await query(`SELECT id, kind, text, reply, replied_at FROM feedback
    WHERE reply IS NOT NULL AND (${where.join(' OR ')}) ORDER BY replied_at DESC LIMIT 50`, params);
  json(200, { replies: rows.map(r => ({ id: r.id, kind: r.kind, text: r.text.slice(0, 300), reply: r.reply, repliedAt: r.replied_at })) });
}

const ADMIN_LIST = {
  open: 'WHERE f.done = 0',
  done: 'WHERE f.done = 1',
  all: '',
};

/** Verwaltung: Liste, Antwort/Erledigt setzen, Löschen – nur für Konten in ADMIN_USERS. */
async function admin(req, json, url, id) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Bitte anmelden.');
  if (!user.admin) throw new HttpError(403, 'Kein Zugriff.');
  const m = req.method;
  if (id == null && m === 'GET') {
    const status = Object.hasOwn(ADMIN_LIST, url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
    const rows = await query(`SELECT f.id, f.kind, f.text, f.email, f.tech, f.route, f.done, f.reply, f.replied_at, f.created_at,
        f.user_id, f.token_hash IS NOT NULL AS has_token, u.username
      FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${ADMIN_LIST[status]} ORDER BY f.id DESC LIMIT 200`);
    const counts = (await query('SELECT done, COUNT(*) AS n FROM feedback GROUP BY done'))
      .reduce((c, r) => ({ ...c, [r.done ? 'done' : 'open']: r.n }), { open: 0, done: 0 });
    return json(200, { counts, items: rows.map(r => ({
      id: r.id, kind: r.kind, text: r.text, email: r.email, tech: r.tech ? fromJson(r.tech) : null, route: r.route,
      done: !!r.done, reply: r.reply, repliedAt: r.replied_at, createdAt: r.created_at, username: r.username ?? null,
      // Ohne Konto und ohne Kennzeichen (vor der Antwort-Funktion gesendet) kommt eine Antwort nirgends an
      reachable: !!r.user_id || !!r.has_token,
    })) });
  }
  if (id == null) throw new HttpError(405, 'Nicht erlaubt');
  if (m === 'PATCH') {
    const p = cleanAdminPatch(await readJsonStrict(req, 16 * 1024));
    const sets = [], params = [];
    if ('done' in p) { sets.push('done = ?'); params.push(p.done ? 1 : 0); }
    if ('reply' in p) { sets.push('reply = ?', 'replied_at = ?'); params.push(p.reply, p.reply ? new Date() : null); }
    const r = await query(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    if (!r.affectedRows) throw new HttpError(404, 'Rückmeldung nicht gefunden.');
    return json(200, { ok: true });
  }
  if (m === 'DELETE') {
    const r = await query('DELETE FROM feedback WHERE id = ?', [id]);
    if (!r.affectedRows) throw new HttpError(404, 'Rückmeldung nicht gefunden.');
    console.log(`Rückmeldung #${id} gelöscht`);
    return json(200, { ok: true });
  }
  throw new HttpError(405, 'Nicht erlaubt');
}

/** Bearbeitet /api/feedback… → true, wenn zuständig. */
export async function handleFeedback(req, res, url) {
  const path = url.pathname;
  if (path !== '/api/feedback' && !path.startsWith('/api/feedback/')) return false;
  const json = (status, data, headers = {}) => sendJson(res, status, data, { 'Cache-Control': 'no-store', ...headers });
  try {
    if (req.method !== 'GET') checkOrigin(req);
    if (!dbEnabled()) throw new HttpError(503, 'Rückmeldungen sind auf diesem Server nicht eingerichtet.');
    const adminMatch = path.match(/^\/api\/feedback\/admin(?:\/(\d{1,10}))?$/);
    if (path === '/api/feedback' && req.method === 'POST') await create(req, json);
    else if (path === '/api/feedback/replies' && req.method === 'POST') await replies(req, json);
    else if (adminMatch) await admin(req, json, url, adminMatch[1] ? Number(adminMatch[1]) : null);
    else throw new HttpError(path === '/api/feedback' ? 405 : 404, path === '/api/feedback' ? 'Nur POST' : 'Unbekannte Anfrage');
  } catch (e) {
    if (e instanceof HttpError) json(e.status, { error: e.message }, e.status === 429 ? { 'Retry-After': '3600' } : {});
    else {
      console.error('Rückmeldungen:', e);
      json(500, { error: 'Die Rückmeldung konnte gerade nicht verarbeitet werden.' });
    }
  }
  return true;
}
