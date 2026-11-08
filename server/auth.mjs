// Anmeldung: Passwörter (scrypt), Sitzungen (zufälliges Token im HttpOnly-Cookie, in der DB nur als
// SHA-256-Hash), Erkennung der Nutzer-IP hinter Proxys und Begrenzung von Fehlversuchen.
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.mjs';
import { createLimiter } from './rateLimit.mjs';

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

/**
 * Passwörter, die bei Angriffen als Erstes probiert werden (häufigste aus veröffentlichten Leaks, auch
 * deutsche). Keine vollständige Liste – sie hält nur das Offensichtlichste ab, ohne externen Dienst.
 */
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '87654321', '11111111', '00000000', '88888888',
  '11223344', '12341234', '123123123', '01234567', 'password', 'password1', 'passwort', 'passwort1',
  'qwertzui', 'qwertzuiop', 'qwertyui', 'qwertyuiop', 'asdfghjk', 'asdfasdf', 'yxcvbnm,', 'iloveyou',
  'sunshine', 'princess', 'football', 'fussball', 'baseball', 'superman', 'starwars', 'whatever',
  'trustno1', 'letmein1', 'welcome1', 'willkommen', 'hallo123', 'hallo1234', 'schatzi1', 'geheim12',
  'sommer2024', 'sommer2025', 'sommer2026', 'winter2025', 'winter2026', 'fahrrad1', 'fahrrad123',
  'radfahren', 'abcd1234', 'abc12345', 'qwer1234', 'test1234', 'admin123', 'administrator',
  'master12', 'internet', 'computer', 'dragon12', 'monkey12', 'charlie1', 'michael1', 'thomas12',
]);

/** Prüft ein (neues) Passwort → Fehlermeldung oder null. */
export function passwordProblem(password, username = '') {
  if (password.length < 8) return 'Das Passwort muss mindestens 8 Zeichen lang sein.';
  if (password.length > 200) return 'Das Passwort ist zu lang.';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) {
    return 'Dieses Passwort ist zu verbreitet und wird bei Angriffen als Erstes ausprobiert – bitte ein anderes wählen.';
  }
  if (username && lower.includes(username.toLowerCase())) return 'Das Passwort darf den Benutzernamen nicht enthalten.';
  return null;
}

/** Benutzername und Passwort prüfen. `isNew`: bei der Registrierung auch die Passwortregeln anwenden. */
export function validateCredentials(username, password, { isNew = false } = {}) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'Benutzername und Passwort fehlen.';
  if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username)) {
    return 'Benutzername: 3–40 Zeichen, nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich.';
  }
  // Bei der Anmeldung keine neuen Regeln erzwingen – ältere Konten haben evtl. ein verbreitetes Passwort
  if (isNew) return passwordProblem(password, username);
  if (password.length < 8 || password.length > 200) return 'Benutzername oder Passwort falsch.';
  return null;
}

// ---------- Herkunft der Anfrage ----------

/**
 * Läuft die Anfrage über HTTPS? Hinter einem Proxy (nginx/Passenger) kommt sie unverschlüsselt an –
 * dann zählen PUBLIC_URL (am verlässlichsten, im Betrieb setzen), die Proxy-Header oder der Origin.
 */
export const isHttps = req => /^https:/i.test(process.env.PUBLIC_URL || '')
  || !!req.socket.encrypted
  || req.headers['x-forwarded-proto'] === 'https'
  || req.headers['x-forwarded-ssl'] === 'on'
  || String(req.headers.origin || '').startsWith('https://');

// Adressen im eigenen Netz bzw. auf demselben Rechner – nur dort sitzen die eigenen Proxys
const INTERNAL = /^(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)|^(?:::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
const isInternal = ip => !ip || INTERNAL.test(ip);
const TRUST_PROXY = process.env.TRUST_PROXY !== 'off';
let debugLeft = process.env.DEBUG_IP === '1' ? 20 : 0;

/**
 * IP des Nutzers – Grundlage aller Begrenzungen.
 * - Kommt die Verbindung von außen, gilt ihre Adresse; Proxy-Header ignorieren (die könnte jeder setzen).
 * - Kommt sie von einem Proxy auf diesem Rechner/im eigenen Netz (Plesk: nginx → Apache → Passenger),
 *   gilt in X-Forwarded-For die erste Adresse von rechts, die nicht intern ist: Jeder eigene Proxy hängt
 *   die Adresse an, von der er die Anfrage bekam; Einträge weiter links kann der Client selbst vorgeben.
 * TRUST_PROXY=off schaltet die Header ab; DEBUG_IP=1 schreibt die ersten 20 Entscheidungen ins Log,
 * um die Erkennung im Betrieb zu prüfen.
 */
export function clientIp(req) {
  const peer = req.socket.remoteAddress;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  let ip = peer;
  if (TRUST_PROXY && isInternal(peer)) {
    ip = forwarded.findLast(a => !isInternal(a)) || (realIp && !isInternal(realIp) ? realIp : null) || forwarded[0] || peer;
  }
  if (debugLeft > 0) {
    debugLeft--;
    console.log(`IP-Erkennung: Verbindung ${peer ?? '(Socket)'}, X-Forwarded-For „${forwarded.join(', ')}“, `
      + `X-Real-IP „${realIp}“ → ${ip}`);
  }
  return ip || 'unbekannt';
}

// ---------- Sitzungen ----------

const sha256 = s => createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* kaputtes Cookie */ }
    }
  }
  return out;
}

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

/** Alle Sitzungen des Nutzers außer der dieser Anfrage beenden (andere Geräte abmelden). → Anzahl */
export async function destroyOtherSessions(req, userId) {
  const token = parseCookies(req)[COOKIE] || '';
  const result = await query('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, sha256(token)]);
  return result.affectedRows ?? 0;
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

// ---------- Begrenzungen ----------
// login: fehlgeschlagene Anmeldungen je IP (gegen Passwort-Raten; nur Fehlversuche zählen, damit sich
//   Nutzer hinter einem gemeinsamen Anschluss nicht gegenseitig aussperren).
// loginUser: Fehlversuche je Benutzername über alle IPs – gegen verteiltes Raten. Großzügiger, weil ein
//   Angreifer damit ein fremdes Konto zeitweise sperren kann.
// register: neue Konten je IP.

const LIMITERS = {
  login: createLimiter({ windowMs: 15 * 60 * 1000, max: 10 }),
  loginUser: createLimiter({ windowMs: 60 * 60 * 1000, max: 30 }),
  register: createLimiter({ windowMs: 60 * 60 * 1000, max: 5 }),
};
const keyOf = (kind, key) => (kind === 'loginUser' ? String(key).toLowerCase() : key);

/** Ist das Limit dieser Art für den Schlüssel (IP bzw. Benutzername) erreicht? (zählt nicht mit) */
export const limitReached = (kind, key) => LIMITERS[kind].reached(keyOf(kind, key));

/** Einen Vorgang zählen: fehlgeschlagene Anmeldung bzw. angelegtes Konto. */
export const countAttempt = (kind, key) => LIMITERS[kind].add(keyOf(kind, key));
