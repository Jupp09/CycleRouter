// Anmeldung: Passwörter (scrypt), Sitzungen (zufälliges Token im HttpOnly-Cookie, in der DB nur als
// SHA-256-Hash) und eine einfache Begrenzung von Anmeldeversuchen je IP.
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.mjs';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE = 'cr_session';
const SESSION_DAYS = 30;

// ---------- Passwörter ----------

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(actual, expected);
}

// Gleiche Laufzeit bei unbekanntem Benutzernamen (verrät nicht, ob es den Namen gibt)
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('dummy-password');
  await verifyPassword(password, dummyHash);
}

// ---------- Eingaben ----------

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'Benutzername und Passwort fehlen.';
  if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username)) {
    return 'Benutzername: 3–40 Zeichen, nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich.';
  }
  if (password.length < 8) return 'Das Passwort muss mindestens 8 Zeichen lang sein.';
  if (password.length > 200) return 'Das Passwort ist zu lang.';
  return null;
}

// ---------- Sitzungen ----------

const sha256 = s => createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

function cookieHeader(req, value, maxAge) {
  return [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
    ...(isHttps(req) ? ['Secure'] : []),
  ].join('; ');
}

export async function createSession(req, res, userId) {
  const token = randomBytes(32).toString('base64url');
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, NOW() + INTERVAL ? DAY)',
    [sha256(token), userId, SESSION_DAYS]);
  res.setHeader('Set-Cookie', cookieHeader(req, token, SESSION_DAYS * 86400));
}

export async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
}

/** Angemeldeter Nutzer der Anfrage → {id, username} oder null. Verlängert Sitzungen, die bald ablaufen. */
export async function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const rows = await query(
    `SELECT u.id, u.username, s.expires_at < NOW() + INTERVAL 15 DAY AS renew
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > NOW()`, [sha256(token)]);
  if (!rows.length) return null;
  if (rows[0].renew) {
    await query('UPDATE sessions SET expires_at = NOW() + INTERVAL ? DAY WHERE token_hash = ?', [SESSION_DAYS, sha256(token)]);
  }
  return { id: rows[0].id, username: rows[0].username };
}

// ---------- Begrenzungen je IP ----------
// Anmeldung: nur fehlgeschlagene Versuche zählen (gegen Passwort-Raten), damit sich Nutzer hinter
// einem gemeinsamen Anschluss nicht gegenseitig aussperren. Registrierung: neue Konten je Stunde.

const LIMITS = {
  login: { windowMs: 15 * 60 * 1000, max: 10 },
  register: { windowMs: 60 * 60 * 1000, max: 5 },
};
const hits = new Map(); // `${art}|${ip}` → [Zeitpunkte]

function recent(kind, ip) {
  const now = Date.now();
  const list = (hits.get(`${kind}|${ip}`) || []).filter(t => now - t < LIMITS[kind].windowMs);
  hits.set(`${kind}|${ip}`, list);
  return list;
}

/** Ist das Limit dieser Art für die IP erreicht? (zählt nicht mit) */
export const limitReached = (kind, ip) => recent(kind, ip).length >= LIMITS[kind].max;

/** Einen Vorgang zählen: fehlgeschlagene Anmeldung bzw. angelegtes Konto. */
export function countAttempt(kind, ip) {
  recent(kind, ip).push(Date.now());
  if (hits.size > 10000) hits.clear(); // Speicher begrenzen
}
