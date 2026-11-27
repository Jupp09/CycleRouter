// Betriebszahlen für die Statusseite der Admins (server/statusApi.mjs, js/app/statusView.js).
//
// Gezählt wird im Speicher und gesichert in einer kleinen Datei (initStatusStore, cache/status.json: jede Minute,
// wenn sich etwas geändert hat, und beim Beenden). Passenger beendet die App nach einigen Minuten ohne Anfragen
// und startet sie bei der nächsten neu – ohne die Datei stünden die Zahlen dann fast immer auf null. Behalten
// werden 7 Tage; eine Datenbank braucht es dafür nicht. Ortsangaben kommen hier nie hinein: BRouter-Anfragen werden
// nur mit Dauer und Ergebnis gezählt, Routen aus dem Browser nur mit Dienst und Dauer, Browserfehler sind wie im
// Log bereinigt (scrub in js/shared.js).
//
// Andere Module melden ihren Zustand über registerStatus() an (z. B. die BRouter-Warteschlange), statt dass dieses
// Modul sie importiert – so bleibt es frei von Abhängigkeiten und lässt sich in Tests und im Test-Fake laden.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
/** Einträge älter als das fallen weg; je Liste höchstens so viele (ein voller Tag bei viel Betrieb) */
const KEEP_MS = 7 * DAY, MAX_ENTRIES = 20000;
const MAX_ERRORS = 200;

export const startedAt = Date.now();

/** @type {{t: number, ms: number, outcome: string}[]} */
const brouterLog = [];
/** @type {{t: number, ms: number, servers: string[], error: string | null}[]} */
const routeLog = [];
/** Browserfehler: Schlüssel → {kind, message, where, browsers: Map<name, n>, count, first, last} */
const errors = new Map();
/** @type {Map<string, () => any>} */
const providers = new Map();

/** Ältester Zeitpunkt, ab dem Zahlen vorliegen (aus der Datei oder der Start dieses Prozesses) */
let dataSince = startedAt;
let storeFile = null, dirty = false;

function push(list, entry) {
  list.push(entry);
  const cut = entry.t - KEEP_MS;
  while (list.length && (list[0].t < cut || list.length > MAX_ENTRIES)) list.shift();
  dirty = true;
}

function snapshot() {
  return JSON.stringify({
    v: 1, dataSince, brouterLog, routeLog,
    errors: [...errors.values()].map(e => ({ ...e, browsers: [...e.browsers] })),
  });
}

function saveSync() {
  if (!storeFile || !dirty) return;
  try {
    writeFileSync(`${storeFile}.tmp`, snapshot());
    renameSync(`${storeFile}.tmp`, storeFile); // nie eine halb geschriebene Datei
    dirty = false;
  } catch (e) {
    console.warn(`Statuszahlen nicht gesichert: ${e.message}`);
  }
}

/**
 * Gesicherte Zahlen einlesen (älter als 7 Tage fällt weg) und das Sichern starten. Beim Beenden durch Passenger
 * (SIGTERM) wird vorher gesichert; ein hartes Beenden kostet höchstens die letzte Minute.
 */
export function initStatusStore(file, log = console.log) {
  storeFile = file;
  mkdirSync(dirname(file), { recursive: true });
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const cut = Date.now() - KEEP_MS;
    if (d.v === 1) {
      brouterLog.push(...d.brouterLog.filter(e => e.t >= cut));
      routeLog.push(...d.routeLog.filter(e => e.t >= cut));
      for (const e of d.errors) {
        if (e.last >= cut) errors.set(`${e.kind}|${e.message}|${e.where}`, { ...e, browsers: new Map(e.browsers) });
      }
      dataSince = Math.max(d.dataSince, cut);
      log(`Statuszahlen seit ${new Date(dataSince).toLocaleString('de-DE')} eingelesen`);
    }
  } catch { /* noch keine Datei */ }
  setInterval(saveSync, 60 * 1000).unref();
  process.once('SIGTERM', () => { saveSync(); process.exit(0); });
  process.once('SIGINT', () => { saveSync(); process.exit(0); });
}

/** Zustand eines anderen Moduls (beim Abruf der Statusseite gelesen), z. B. 'brouter' → {active, waiting} */
export function registerStatus(name, fn) {
  providers.set(name, fn);
}

/**
 * Ergebnis einer Anfrage an den eigenen BRouter: 'ok', 'rejected' (BRouter antwortet 4xx, z. B. Punkt abseits
 * jeder Straße), 'error' (5xx), 'unreachable', 'full' (Warteschlange voll) oder 'gone' (der Browser hat nicht
 * mehr gewartet – meist das Zeitlimit des Webservers vor Node bei sehr langen Strecken).
 */
export function noteBrouter(ms, outcome, now = Date.now()) {
  push(brouterLog, { t: now, ms, outcome });
}

/** Erlaubte Fehlerarten einer Routenberechnung aus dem Browser (POST /api/route-stats) */
export const ROUTE_ERRORS = ['tooLong', 'busy', 'notRoutable', 'other'];
const ROUTE_SERVERS = ['own', 'brouter.de', 'valhalla', 'ors'];

/**
 * Bericht des Browsers über eine fertige (oder gescheiterte) Grundroute prüfen → {ms, servers, error} oder null.
 * Nur bekannte Werte; Dauer gerundet und gedeckelt.
 */
export function cleanRouteStats(body) {
  if (!body || typeof body !== 'object') return null;
  const ms = Number(body.ms);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const servers = Array.isArray(body.servers) ? [...new Set(body.servers.filter(s => ROUTE_SERVERS.includes(s)))] : [];
  const error = ROUTE_ERRORS.includes(body.error) ? body.error : null;
  if (!servers.length && !error) return null;
  return { ms: Math.min(Math.round(ms), 30 * 60 * 1000), servers, error };
}

export function noteRoute(stats, now = Date.now()) {
  push(routeLog, { t: now, ...stats });
}

/** Browserfehler zählen (alle, auch die, die das Log als Wiederholung zusammenfasst) */
export function noteClientError({ kind, message, where, browser }, now = Date.now()) {
  const key = `${kind}|${message}|${where}`;
  let e = errors.get(key);
  if (!e) {
    if (errors.size >= MAX_ERRORS) {
      // Den am längsten nicht mehr gesehenen Fehler vergessen
      let oldest = null;
      for (const [k, v] of errors) if (!oldest || v.last < oldest[1].last) oldest = [k, v];
      errors.delete(oldest[0]);
    }
    e = { kind, message, where, browsers: new Map(), count: 0, first: now, last: now };
    errors.set(key, e);
  }
  e.count++;
  e.last = now;
  dirty = true;
  const b = String(browser || 'unbekannt').split(',')[0]; // „Chrome 131, Windows“ → nach Browser zählen
  e.browsers.set(b, (e.browsers.get(b) || 0) + 1);
}

/** Wert an Stelle p (0–1) einer sortierten Liste */
const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

/** BRouter-Anfragen eines Zeitraums: Anzahl je Ergebnis und Dauer (Median, 95 %, längste) der beantworteten */
export function summarizeBrouter(list, since) {
  const recent = list.filter(e => e.t >= since);
  const outcomes = {};
  for (const e of recent) outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1;
  const ms = recent.filter(e => e.outcome !== 'full').map(e => e.ms).sort((a, b) => a - b);
  return { count: recent.length, outcomes, median: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: ms.at(-1) ?? null };
}

/** Routen aus den Browsern: Anzahl, je Dienst (eine Route kann mehrere haben), Fehler je Art, Median der Dauer */
export function summarizeRoutes(list, since) {
  const recent = list.filter(e => e.t >= since);
  const servers = {}, failed = {};
  for (const e of recent) {
    if (e.error) failed[e.error] = (failed[e.error] || 0) + 1;
    else for (const s of e.servers) servers[s] = (servers[s] || 0) + 1;
  }
  const ok = recent.filter(e => !e.error);
  const ms = ok.map(e => e.ms).sort((a, b) => a - b);
  return { count: recent.length, ok: ok.length, servers, failed, median: quantile(ms, 0.5) };
}

/** Alles für die Statusseite @returns {Record<string, any>} */
export function statusReport(now = Date.now()) {
  const windows = { hour: now - HOUR, day: now - DAY, week: 0 };
  const per = fn => Object.fromEntries(Object.entries(windows).map(([k, since]) => [k, fn(since)]));
  /** @type {Record<string, any>} Zustände der angemeldeten Module (brouter, extract) */
  const extra = {};
  for (const [name, fn] of providers) {
    try { extra[name] = fn(); } catch (e) { extra[name] = { error: e.message }; }
  }
  const mem = process.memoryUsage();
  return {
    now,
    server: { startedAt, dataSince, pid: process.pid, node: process.version, rss: mem.rss, heap: mem.heapUsed },
    ...extra,
    brouterStats: per(since => summarizeBrouter(brouterLog, since)),
    routes: per(since => summarizeRoutes(routeLog, since)),
    clientErrors: [...errors.values()].sort((a, b) => b.last - a.last).slice(0, 30).map(e => ({
      kind: e.kind, message: e.message, where: e.where, count: e.count, first: e.first, last: e.last,
      browsers: [...e.browsers].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    })),
  };
}
