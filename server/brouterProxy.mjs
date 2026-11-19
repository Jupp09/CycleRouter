// Weiterleitung an einen eigenen BRouter-Server (BROUTER_URL) unter /api/brouter.
//
// Warum über diesen Server und nicht direkt aus dem Browser: Ein eigener BRouter spricht meist nur http://,
// die App läuft unter https:// – der Browser blockiert solche Anfragen (Mixed Content). Nebenbei bleibt die
// Adresse des Rechners verborgen, und er muss nur für diesen Server offen sein.
//
// Die Warteschlange hält die Zahl gleichzeitiger Anfragen bei BROUTER_PARALLEL (= Thread-Zahl, mit der
// BRouter gestartet wurde): Mehr Anfragen als Threads beendet BRouter nach 2 s („killed by
// thread-priority-watchdog“), statt sie warten zu lassen.
//
// GET  /api/brouter                → {enabled} – der Browser fragt das einmal je Sitzung, bevor er den Weg nutzt
// GET  /api/brouter?lonlats=…      → Antwort von BRouter (Status und Text unverändert)
// POST /api/brouter/profile        → Profil hochladen (EuroVelo-Bevorzugung)
//
// Fällt der eigene Server aus, antwortet der Weg mit 503; der Browser rechnet dann mit brouter.de.
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { HttpError, readBody, sendJson } from './http.mjs';
import { clientIp } from './auth.mjs';
import { createLimiter } from './rateLimit.mjs';

/** Basisadresse ohne /brouter am Ende, z. B. http://192.0.2.1:17777 */
const BASE = (process.env.BROUTER_URL || '').trim().replace(/\/+$/, '').replace(/\/brouter$/, '');
const PARALLEL = Math.max(1, Math.floor(Number(process.env.BROUTER_PARALLEL)) || 1);
/** Mehr Wartende → „ausgelastet“; der Browser weicht dann auf brouter.de aus, statt lange zu warten. */
const MAX_WAITING = 20 * PARALLEL;
/** BRouter bricht selbst nach maxRunningTime ab (Standard 300 s) – etwas länger warten, um seine Meldung zu bekommen. */
const TIMEOUT = 310_000;
const UPLOAD_TIMEOUT = 20_000;
/** Nach einem Verbindungsfehler gilt der Server so lange als weg (spart allen Nutzern das Warten auf Zeitlimits). */
const DOWN_MS = 30_000;
const MAX_PROFILE = 200 * 1024;

/**
 * Anfragen je IP und Stunde. Eine Route sind meist einige bis einige Dutzend Teilstücke, Rundkurse mit
 * Neuskalieren und Stopps mehr. Darüber antwortet der Weg mit 429, und der Browser nimmt brouter.de –
 * so kann niemand den eigenen Server für alle anderen dauerhaft belegen.
 */
const budget = createLimiter({ windowMs: 60 * 60 * 1000, max: 3000 });

export const brouterEnabled = Boolean(BASE);
let downUntil = 0;

let active = 0;
const waiting = [];

/** Auf einen freien Platz warten; bei Abbruch (Nutzer weg) die Anfrage aus der Schlange nehmen. */
function acquire(signal) {
  if (active < PARALLEL) { active++; return Promise.resolve(); }
  if (waiting.length >= MAX_WAITING) return Promise.reject(new HttpError(503, 'BRouter: Warteschlange voll, retry later'));
  return new Promise((resolve, reject) => {
    const entry = { resolve };
    waiting.push(entry);
    signal.addEventListener('abort', () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) { waiting.splice(i, 1); reject(signal.reason); }
    }, { once: true });
  });
}

function release() {
  const next = waiting.shift();
  if (next) next.resolve(); // Platz direkt weitergeben, `active` bleibt gleich
  else active--;
}

const LONLATS = /^-?\d{1,3}(\.\d{1,8})?,-?\d{1,2}(\.\d{1,8})?(\|-?\d{1,3}(\.\d{1,8})?,-?\d{1,2}(\.\d{1,8})?){1,49}$/;
const NAME = /^[\w-]{1,64}$/;
const PARAM = /^profile:\w{1,40}$/;
const VALUE = /^[\w.-]{1,20}$/;

/** Nur bekannte Parameter weiterreichen – der eigene Server soll nichts anderes zu sehen bekommen. */
function upstreamQuery(params) {
  const out = new URLSearchParams();
  const lonlats = params.get('lonlats'), profile = params.get('profile');
  if (!lonlats || !LONLATS.test(lonlats) || !profile || !NAME.test(profile)) throw new HttpError(400, 'Ungültige Anfrage');
  out.set('lonlats', lonlats);
  out.set('profile', profile);
  out.set('alternativeidx', /^[0-3]$/.test(params.get('alternativeidx') ?? '') ? params.get('alternativeidx') : '0');
  out.set('format', 'geojson');
  for (const [key, value] of params) {
    if (!PARAM.test(key)) continue;
    if (!VALUE.test(value)) throw new HttpError(400, 'Ungültiger Profilparameter');
    out.set(key, value);
  }
  return out;
}

/** Abbruch, sobald der Browser die Verbindung schließt (neue Berechnung, Seite verlassen). */
function clientGone(res) {
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  return ctrl.signal;
}

async function forward(req, res, url, init, timeout) {
  let upstream;
  try {
    upstream = await fetch(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) });
  } catch (e) {
    if (init.signal.aborted) return; // Browser ist weg – niemand wartet auf die Antwort
    downUntil = Date.now() + DOWN_MS;
    console.warn(`/api/brouter: eigener BRouter nicht erreichbar (${e.cause?.code || e.message})`);
    throw new HttpError(503, 'BRouter nicht erreichbar, retry later');
  }
  const text = await upstream.text(); // fetch entpackt eine komprimierte Antwort von BRouter/Caddy selbst
  if (res.writableEnded || res.destroyed) return;
  const { body, encoding } = await compress(text, req.headers['accept-encoding']);
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
    ...(encoding && { 'Content-Encoding': encoding }),
  }).end(body);
}

const brotli = promisify(brotliCompress), gzipAsync = promisify(gzip);

/**
 * Antwort komprimieren, wenn der Browser es kann. Eine Route mit Wegdaten (GeoJSON samt `messages`) hat einige
 * 100 KB und schrumpft auf etwa ein Fünftel – das zählt vor allem auf dem Handy. Apache/Plesk komprimiert
 * diesen Inhaltstyp nicht von sich aus. Brotli mit mittlerer Stufe: fast so klein wie die höchste, aber nur
 * wenige Millisekunden Rechenzeit.
 */
async function compress(text, accept = '') {
  if (text.length < 1024) return { body: text, encoding: null };
  if (/\bbr\b/.test(accept)) {
    return { body: await brotli(text, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }), encoding: 'br' };
  }
  if (/\bgzip\b/.test(accept)) return { body: await gzipAsync(text), encoding: 'gzip' };
  return { body: text, encoding: null };
}

/** true, wenn die Anfrage diesem Weg gehört (auch dann, wenn kein eigener Server eingerichtet ist). */
export async function handleBrouter(req, res, url) {
  const path = url.pathname;
  if (path !== '/api/brouter' && path !== '/api/brouter/profile') return false;
  if (!BASE) {
    sendJson(res, 404, { enabled: false, error: 'Kein eigener BRouter eingerichtet' });
    return true;
  }
  try {
    if (path === '/api/brouter' && req.method === 'GET' && !url.searchParams.has('lonlats')) {
      sendJson(res, 200, { enabled: true }, { 'Cache-Control': 'no-store' });
      return true;
    }
    if (Date.now() < downUntil) throw new HttpError(503, 'BRouter nicht erreichbar, retry later');
    const ip = clientIp(req);
    if (!budget.fits(ip, 1)) throw new HttpError(429, 'Zu viele BRouter-Anfragen, retry later');
    budget.add(ip, 1);
    const signal = clientGone(res);

    if (path === '/api/brouter/profile') {
      if (req.method !== 'POST') throw new HttpError(405, 'Nur POST');
      const body = await readBody(req, MAX_PROFILE);
      await forward(req, res, `${BASE}/brouter/profile`,
        { method: 'POST', body, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, signal }, UPLOAD_TIMEOUT);
      return true;
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Nur GET');
    const query = upstreamQuery(url.searchParams);
    await acquire(signal);
    try {
      await forward(req, res, `${BASE}/brouter?${query}`, { signal }, TIMEOUT);
    } finally {
      release();
    }
  } catch (e) {
    if (e.name === 'AbortError' || res.writableEnded || res.destroyed) return true;
    if (!(e instanceof HttpError)) console.error('/api/brouter:', e.message);
    // Klartext wie BRouter selbst – der Browser wertet Status und Text gleich aus wie bei brouter.de
    res.writeHead(e.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(e instanceof HttpError ? e.message : 'Interner Fehler');
  }
  return true;
}
