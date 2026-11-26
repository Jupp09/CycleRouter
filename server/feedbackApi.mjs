// Rückmeldungen der Nutzer – Fehler melden, Vorschlag machen, Kritik äußern (js/app/feedbackView.js).
//
//   POST /api/feedback  {kind, text, email?, tech?, route?}  → {ok, id}
//
// Gespeichert in der Datenbank (Tabelle feedback, server/db.mjs); ohne Datenbank 503, und die App blendet
// „Feedback geben“ aus (wie die Konten, account.enabled). Lesen: npm run feedback (server/feedback-list.mjs).
//
// Freiwillig und nur auf ausdrücklichen Wunsch des Nutzers (Häkchen) kommen dazu: eine E-Mail für Rückfragen,
// technische Angaben (Browser, Bildschirm, letzte Fehlermeldungen der App, ohne Ortsangaben) und der Link zur
// geplanten Route (enthält Start, Ziel und Zwischenstopps). Ins Log kommt nur Nummer und Art der Meldung –
// Text, E-Mail und Route stehen allein in der Datenbank. Angemeldet wird das Konto vermerkt.
//
// Schutz: JSON und gleiche Herkunft (CSRF wie bei den Konten), höchstens PER_CLIENT Meldungen je Anschluss und
// Stunde und PER_DAY insgesamt am Tag – sonst ließe sich die Datenbank mit Meldungen füllen.
import { query, dbEnabled } from './db.mjs';
import { clientIp, currentUser } from './auth.mjs';
import { HttpError, sendJson, readJsonStrict, checkOrigin, requestHost } from './http.mjs';
import { createLimiter } from './rateLimit.mjs';
import { scrub } from '../js/shared.js';

/** Arten einer Rückmeldung → Bezeichnung (für Log und Liste). */
export const FEEDBACK_KINDS = { bug: 'Fehler', idea: 'Vorschlag', critique: 'Kritik' };
export const TEXT_MIN = 10, TEXT_MAX = 4000;
const PER_CLIENT = 5, PER_DAY = 300;

const perClient = createLimiter({ windowMs: 3600 * 1000, max: PER_CLIENT });
const perDay = createLimiter({ windowMs: 24 * 3600 * 1000, max: PER_DAY });

// Steuerzeichen raus, Zeilenumbrüche und Tabulatoren bleiben (mehrzeilige Beschreibungen)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clip = (v, max) => String(v ?? '').replace(CONTROL, '').trim().slice(0, max);
// Bewusst schlicht: Gültig ist, was nach Adresse aussieht – zugestellt wird hier ohnehin nichts
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/;

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

/** Bearbeitet /api/feedback → true, wenn zuständig. */
export async function handleFeedback(req, res, url) {
  if (url.pathname !== '/api/feedback') return false;
  const json = (status, data, headers = {}) => sendJson(res, status, data, { 'Cache-Control': 'no-store', ...headers });
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Nur POST');
    checkOrigin(req);
    if (!dbEnabled()) throw new HttpError(503, 'Rückmeldungen sind auf diesem Server nicht eingerichtet.');
    const ip = clientIp(req);
    if (!perClient.fits(ip, 1)) throw new HttpError(429, 'Zu viele Rückmeldungen von diesem Anschluss – bitte in einer Stunde erneut.');
    if (!perDay.fits('all', 1)) throw new HttpError(429, 'Heute sind schon sehr viele Rückmeldungen eingegangen – bitte morgen erneut.');
    const f = cleanFeedback(await readJsonStrict(req, 32 * 1024), requestHost(req));
    const user = await currentUser(req);
    const result = await query('INSERT INTO feedback (kind, text, email, tech, route, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [f.kind, f.text, f.email, f.tech && JSON.stringify(f.tech), f.route, user?.id ?? null]);
    // Erst nach dem Speichern zählen: Eine abgelehnte Eingabe (zu kurz, E-Mail vertippt) kostet nichts
    perClient.add(ip);
    perDay.add('all');
    console.log(`Rückmeldung #${result.insertId} (${FEEDBACK_KINDS[f.kind]})`);
    json(201, { ok: true, id: result.insertId });
  } catch (e) {
    if (e instanceof HttpError) json(e.status, { error: e.message }, e.status === 429 ? { 'Retry-After': '3600' } : {});
    else {
      console.error('Rückmeldungen:', e);
      json(500, { error: 'Die Rückmeldung konnte gerade nicht gespeichert werden.' });
    }
  }
  return true;
}
