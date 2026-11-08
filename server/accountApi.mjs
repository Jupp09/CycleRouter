// Schnittstelle für Konten, Einstellungen und gespeicherte Routen.
//
//   GET    /api/account                → {enabled, user}
//   POST   /api/account/register       {username, password}
//   POST   /api/account/login          {username, password}
//   POST   /api/account/logout
//   POST   /api/account/delete         {password}   – Konto samt allen Daten löschen
//   POST   /api/account/password       {password, newPassword} – Passwort ändern, andere Geräte abmelden
//   POST   /api/account/logout-others  → {count}    – alle anderen Sitzungen beenden
//   GET    /api/settings               → {data, updatedAt}
//   PUT    /api/settings               {data}
//   GET    /api/routes                 → Liste (ohne Geometrie)
//   POST   /api/routes                 {name, mode, bike, distance, ascent, data} → {id}
//   GET    /api/routes/:id             → vollständige Route (nur eigene)
//   PATCH  /api/routes/:id             {name?, mode?, bike?, distance?, ascent?, data?}
//   DELETE /api/routes/:id
//   POST   /api/routes/:id/share       → {token}   (Teilen-Link erzeugen)
//   DELETE /api/routes/:id/share                   (Teilen-Link zurückziehen)
//   GET    /api/shared/:token          → geteilte Route (ohne Anmeldung)
import { randomBytes } from 'node:crypto';
import { query, dbEnabled } from './db.mjs';
import {
  hashPassword, verifyPassword, burnPasswordCheck, validateCredentials, passwordProblem,
  createSession, destroySession, destroyOtherSessions, currentUser, limitReached, countAttempt, clientIp,
} from './auth.mjs';
import { SYNC_KEYS, MODES, BIKES } from '../js/shared.js';
import { HttpError, sendJson, readBody } from './http.mjs';

// Konto-Antworten nie zwischenspeichern (enthalten persönliche Daten)
const json = (res, status, data) => sendJson(res, status, data, { 'Cache-Control': 'no-store' });

/** JSON-Körper lesen; nur mit Content-Type application/json (Teil des CSRF-Schutzes, siehe checkOrigin). */
async function readJson(req, limit) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Erwartet JSON');
  }
  const body = await readBody(req, limit);
  try { return body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, 'Ungültiges JSON'); }
}

/** JSON-Spalten: Der MariaDB-Treiber liefert sie je nach Version/Server als Text oder schon als Objekt. */
const fromJson = v => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * Schutz vor Anfragen fremder Webseiten (CSRF): Ändernde Anfragen müssen JSON sein (geht von fremden
 * Seiten nur mit CORS-Vorabprüfung, die dieser Server nicht erlaubt) und dürfen, falls der Browser
 * einen Origin mitschickt, nur von dieser Seite kommen. Dazu kommt SameSite=Lax beim Cookie.
 */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let originHost = null;
  try { originHost = new URL(origin).host; } catch { /* z. B. "null" */ }
  if (originHost !== host) throw new HttpError(403, 'Fremde Herkunft');
}

// ---------- Einstellungen ----------

// Nur SYNC_KEYS (js/shared.js) werden abgeglichen – der ORS-API-Key bleibt bewusst nur im Browser.
function cleanSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Ungültige Einstellungen');
  return Object.fromEntries(SYNC_KEYS.filter(k => k in data).map(k => [k, data[k]]));
}

// ---------- Routen ----------
// Gültige Werte für mode/bike: MODES, BIKES (js/shared.js)

function cleanRoute(body, partial = false) {
  const out = {};
  if (!partial || 'name' in body) {
    const name = String(body.name ?? '').trim().slice(0, 200);
    if (!name) throw new HttpError(400, 'Name fehlt');
    out.name = name;
  }
  if (!partial || 'mode' in body) {
    if (!MODES.includes(body.mode)) throw new HttpError(400, 'Ungültiger Modus');
    out.mode = body.mode;
  }
  if (!partial || 'bike' in body) {
    if (!BIKES.includes(body.bike)) throw new HttpError(400, 'Ungültiger Fahrradtyp');
    out.bike = body.bike;
  }
  for (const k of ['distance', 'ascent']) {
    if (!partial || k in body) {
      const v = Math.round(Number(body[k]));
      if (!Number.isFinite(v) || v < 0 || v > 10_000_000) throw new HttpError(400, `Ungültiger Wert: ${k}`);
      out[k] = v;
    }
  }
  if (!partial || 'data' in body) {
    const d = body.data;
    if (!d || typeof d !== 'object' || !Array.isArray(d.coords) || d.coords.length < 2 || !Array.isArray(d.waypoints)) {
      throw new HttpError(400, 'Ungültige Routendaten');
    }
    out.data = JSON.stringify(d);
  }
  return out;
}

const toListItem = r => ({
  id: r.id, name: r.name, mode: r.mode, bike: r.bike, distance: r.distance, ascent: r.ascent,
  shared: !!r.share_token, shareToken: r.share_token, createdAt: r.created_at, updatedAt: r.updated_at,
});

// Speicher je Konto: 500 Routen à bis zu 8 MB wären 4 GB – mit wenigen Konten ließe sich die Platte füllen.
// Eine lange Mehrtagestour braucht etwa 1–3 MB, 50 MB reichen also für viele Touren.
const MAX_ROUTES = 500;
const QUOTA_BYTES = 50 * 1024 * 1024;

/** Passt `addBytes` (neue Routendaten) noch ins Kontingent? `replacingId`: deren alte Daten zählen nicht. */
async function checkQuota(user, addBytes, replacingId = null) {
  const rows = await query('SELECT COALESCE(SUM(LENGTH(data)), 0) AS used FROM routes WHERE user_id = ? AND id <> ?',
    [user.id, replacingId ?? 0]);
  if (Number(rows[0].used) + addBytes > QUOTA_BYTES) {
    throw new HttpError(413, `Speicher voll: Gespeicherte Routen dürfen zusammen höchstens ${QUOTA_BYTES / 1024 / 1024} MB belegen – bitte alte löschen.`);
  }
}

async function ownRoute(user, id) {
  const rows = await query('SELECT * FROM routes WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!rows.length) throw new HttpError(404, 'Route nicht gefunden');
  return rows[0];
}

// ---------- Anfragen ----------

async function route(req, res, url) {
  const { pathname } = url;
  const m = req.method;
  if (m !== 'GET') checkOrigin(req);

  if (pathname === '/api/account' && m === 'GET') {
    if (!dbEnabled()) return json(res, 200, { enabled: false, user: null });
    return json(res, 200, { enabled: true, user: await currentUser(req) });
  }
  if (!dbEnabled()) throw new HttpError(503, 'Konten sind auf diesem Server nicht eingerichtet.');

  // Geteilte Route – ohne Anmeldung
  let match = pathname.match(/^\/api\/shared\/([A-Za-z0-9_-]{22})$/);
  if (match && m === 'GET') {
    const rows = await query('SELECT name, mode, bike, distance, ascent, data, updated_at FROM routes WHERE share_token = ?', [match[1]]);
    if (!rows.length) throw new HttpError(404, 'Dieser Link ist ungültig oder wurde zurückgezogen.');
    const r = rows[0];
    return json(res, 200, { name: r.name, mode: r.mode, bike: r.bike, distance: r.distance, ascent: r.ascent,
      data: fromJson(r.data), updatedAt: r.updated_at });
  }

  // Registrieren / Anmelden
  if (pathname === '/api/account/register' && m === 'POST') {
    const ip = clientIp(req);
    if (limitReached('register', ip)) throw new HttpError(429, 'Zu viele neue Konten von diesem Anschluss – bitte später erneut.');
    const { username, password } = await readJson(req, 4096);
    const invalid = validateCredentials(username, password, { isNew: true });
    if (invalid) throw new HttpError(400, invalid);
    const exists = await query('SELECT id FROM users WHERE username = ?', [username]);
    if (exists.length) throw new HttpError(409, 'Dieser Benutzername ist schon vergeben.');
    const result = await query('INSERT INTO users (username, pw_hash) VALUES (?, ?)', [username, await hashPassword(password)]);
    countAttempt('register', ip);
    await createSession(req, res, result.insertId);
    return json(res, 201, { user: { id: result.insertId, username } });
  }

  if (pathname === '/api/account/login' && m === 'POST') {
    const ip = clientIp(req);
    if (limitReached('login', ip)) throw new HttpError(429, 'Zu viele fehlgeschlagene Anmeldungen – bitte in 15 Minuten erneut.');
    const { username, password } = await readJson(req, 4096);
    if (limitReached('loginUser', username)) {
      throw new HttpError(429, 'Zu viele fehlgeschlagene Anmeldungen für dieses Konto – bitte in einer Stunde erneut.');
    }
    const invalid = validateCredentials(username, password);
    const rows = invalid ? [] : await query('SELECT id, username, pw_hash FROM users WHERE username = ?', [username]);
    const ok = rows.length ? await verifyPassword(password, rows[0].pw_hash) : (await burnPasswordCheck(String(password || '')), false);
    if (!ok) {
      countAttempt('login', ip);
      if (typeof username === 'string' && username.length <= 40) countAttempt('loginUser', username);
      throw new HttpError(401, 'Benutzername oder Passwort falsch.');
    }
    await createSession(req, res, rows[0].id);
    return json(res, 200, { user: { id: rows[0].id, username: rows[0].username } });
  }

  if (pathname === '/api/account/logout' && m === 'POST') {
    await destroySession(req, res);
    return json(res, 200, { ok: true });
  }

  // Ab hier nur angemeldet
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'Bitte anmelden.');

  if (pathname === '/api/account/delete' && m === 'POST') {
    const ip = clientIp(req);
    if (limitReached('login', ip)) throw new HttpError(429, 'Zu viele fehlgeschlagene Versuche – bitte in 15 Minuten erneut.');
    const { password } = await readJson(req, 4096);
    const rows = await query('SELECT pw_hash FROM users WHERE id = ?', [user.id]);
    if (!rows.length || !await verifyPassword(String(password || ''), rows[0].pw_hash)) {
      countAttempt('login', ip);
      throw new HttpError(401, 'Passwort falsch.');
    }
    await query('DELETE FROM users WHERE id = ?', [user.id]); // Sitzungen, Einstellungen, Routen per CASCADE
    await destroySession(req, res);
    return json(res, 200, { ok: true });
  }

  // Passwort ändern: altes Passwort nötig; danach sind alle anderen Geräte abgemeldet (falls das alte
  // Passwort oder ein Sitzungs-Cookie in fremde Hände geraten ist).
  if (pathname === '/api/account/password' && m === 'POST') {
    const ip = clientIp(req);
    if (limitReached('login', ip)) throw new HttpError(429, 'Zu viele fehlgeschlagene Versuche – bitte in 15 Minuten erneut.');
    const { password, newPassword } = await readJson(req, 4096);
    if (typeof newPassword !== 'string') throw new HttpError(400, 'Neues Passwort fehlt.');
    const rows = await query('SELECT pw_hash FROM users WHERE id = ?', [user.id]);
    if (!rows.length || !await verifyPassword(String(password || ''), rows[0].pw_hash)) {
      countAttempt('login', ip);
      throw new HttpError(401, 'Bisheriges Passwort falsch.');
    }
    const problem = passwordProblem(newPassword, user.username);
    if (problem) throw new HttpError(400, problem);
    await query('UPDATE users SET pw_hash = ? WHERE id = ?', [await hashPassword(newPassword), user.id]);
    const count = await destroyOtherSessions(req, user.id);
    return json(res, 200, { ok: true, count });
  }

  if (pathname === '/api/account/logout-others' && m === 'POST') {
    return json(res, 200, { count: await destroyOtherSessions(req, user.id) });
  }

  if (pathname === '/api/settings') {
    if (m === 'GET') {
      const rows = await query('SELECT data, updated_at FROM settings WHERE user_id = ?', [user.id]);
      return json(res, 200, rows.length ? { data: fromJson(rows[0].data), updatedAt: rows[0].updated_at } : { data: null });
    }
    if (m === 'PUT') {
      const { data } = await readJson(req, 16 * 1024);
      const clean = JSON.stringify(cleanSettings(data));
      await query('INSERT INTO settings (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [user.id, clean]);
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/routes') {
    if (m === 'GET') {
      const rows = await query(`SELECT id, name, mode, bike, distance, ascent, share_token, created_at, updated_at
        FROM routes WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 500`, [user.id]);
      return json(res, 200, { routes: rows.map(toListItem) });
    }
    if (m === 'POST') {
      const r = cleanRoute(await readJson(req, 8 * 1024 * 1024));
      const count = await query('SELECT COUNT(*) AS n FROM routes WHERE user_id = ?', [user.id]);
      if (count[0].n >= MAX_ROUTES) throw new HttpError(409, `Maximal ${MAX_ROUTES} gespeicherte Routen – bitte alte löschen.`);
      await checkQuota(user, Buffer.byteLength(r.data));
      const result = await query(
        'INSERT INTO routes (user_id, name, mode, bike, distance, ascent, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [user.id, r.name, r.mode, r.bike, r.distance, r.ascent, r.data]);
      return json(res, 201, { id: result.insertId });
    }
  }

  match = pathname.match(/^\/api\/routes\/(\d{1,10})(\/share)?$/);
  if (match) {
    const id = Number(match[1]);
    const row = await ownRoute(user, id);
    if (match[2]) {
      if (m === 'POST') {
        const token = row.share_token || randomBytes(16).toString('base64url'); // 22 Zeichen
        if (!row.share_token) await query('UPDATE routes SET share_token = ?, updated_at = updated_at WHERE id = ?', [token, id]);
        return json(res, 200, { token });
      }
      if (m === 'DELETE') {
        await query('UPDATE routes SET share_token = NULL, updated_at = updated_at WHERE id = ?', [id]);
        return json(res, 200, { ok: true });
      }
    } else {
      if (m === 'GET') return json(res, 200, { ...toListItem(row), data: fromJson(row.data) });
      if (m === 'PATCH') {
        const r = cleanRoute(await readJson(req, 8 * 1024 * 1024), true);
        if (r.data) await checkQuota(user, Buffer.byteLength(r.data), id);
        const cols = Object.keys(r);
        if (cols.length) {
          await query(`UPDATE routes SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map(c => r[c]), id]);
        }
        return json(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        await query('DELETE FROM routes WHERE id = ?', [id]);
        return json(res, 200, { ok: true });
      }
    }
  }
  throw new HttpError(404, 'Unbekannte Anfrage');
}

/** Bearbeitet /api/account…, /api/settings, /api/routes…, /api/shared/… → true, wenn zuständig. */
export async function handleAccountApi(req, res, url) {
  if (!/^\/api\/(account|settings|routes|shared)(\/|$)/.test(url.pathname)) return false;
  try {
    await route(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) json(res, e.status, { error: e.message });
    else {
      console.error('Konto-API:', e);
      json(res, 500, { error: 'Interner Fehler' });
    }
  }
  return true;
}
