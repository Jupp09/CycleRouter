import { brouter } from './brouter.js';
import { ors } from './ors.js';
import { valhalla } from './valhalla.js';
import { routingNotice } from './notice.js';
import { computeStats } from '../utils.js';
import { mergeSegments } from '../surfaces.js';

export { onRoutingNotice } from './notice.js';

/** Wählbare Dienste (Einstellungen). Valhalla ist nur Ausweichdienst für BRouter, siehe FALLBACK. */
export const providers = { brouter, ors };

/** Ausweichdienst, wenn ein Dienst ausgelastet ist (nach dessen eigenen neuen Versuchen). */
const FALLBACK = { brouter: valhalla };

/**
 * Einheitliches Routenergebnis aller Provider:
 * { coords: [[lat, lon, ele]], cum: [m], distance, ascent, descent, waypoints, fallback? }
 * `fallback`: Name des Ausweichdiensts, falls Teilstücke nicht mit dem gewählten Dienst berechnet wurden.
 */
export function withStats(result, waypoints) {
  return { ...result, ...computeStats(result.coords), waypoints };
}

/**
 * Importierter Weg (GPX) als Route mit `track: true`. Er soll erhalten bleiben, auch wenn Stopps, Unterkünfte
 * oder Zwischenstopps dazukommen: Start und Ziel merken sich ihre Stelle auf dem Weg (`trackAt`), ebenso die
 * Stützpunkte, die `insertWaypoints` (routeGeometry.js) etwa jeden Kilometer setzt. Zwischen zwei solchen Punkten
 * liefert `route()` den Ausschnitt des Wegs, ohne einen Dienst zu fragen – nur die Abstecher werden berechnet.
 * Ohne `segments` gelten Untergrund und Wegtyp als unbekannt.
 */
export function trackRoute(coords, waypoints, segments = null) {
  segments = segments?.length ? segments : [{ from: 0, to: coords.length - 1, surface: 'unknown', waytype: 'other' }];
  waypoints[0].trackAt = { coords, segments, i: 0 };
  waypoints.at(-1).trackAt = { coords, segments, i: coords.length - 1 };
  return { ...withStats({ coords, segments }, waypoints), track: true };
}

/** Liegen beide Punkte in dieser Reihenfolge auf demselben importierten Weg? */
const onTrack = (a, b) => !!a.trackAt && !!b.trackAt && a.trackAt.coords === b.trackAt.coords && b.trackAt.i > a.trackAt.i;

/** Ausschnitt eines importierten Wegs als Teilstück (samt dem Teil seiner Segmente). */
function trackLeg(a, b) {
  const { coords, segments } = a.trackAt, from = a.trackAt.i, to = b.trackAt.i;
  return {
    coords: coords.slice(from, to + 1),
    segments: segments.filter(s => s.to > from && s.from < to)
      .map(s => ({ ...s, from: Math.max(s.from, from) - from, to: Math.min(s.to, to) - from })),
  };
}

/**
 * Route durch `points`. Dienste mit `perLeg` (BRouter, Valhalla) werden Teilstück für Teilstück angefragt
 * (je zwei Wegpunkte), und jedes Teilstück wird für die Sitzung gemerkt: Kommt ein Verpflegungsstopp oder
 * eine Übernachtung hinzu, ändert sich das Tempo oder schaltet man eine Option hin und zurück, sind nur
 * die geänderten Teilstücke neu – das entlastet brouter.de spürbar. ORS rechnet weiter am Stück, weil dort
 * jede Anfrage das Tageskontingent des Nutzers belastet.
 */
export async function route(provider, points, opts, signal) {
  // Importierter Weg: immer Teilstück für Teilstück, auch bei ORS – sonst ginge der Weg verloren
  const perLeg = provider.perLeg || points.some(p => p.trackAt);
  if (!perLeg || points.length < 2) return withStats(await provider.route(points, opts, signal), points);
  const pairs = points.slice(1).map((p, i) => [points[i], p]);
  const legs = await mapLimit(pairs, LEG_CONCURRENCY, ([a, b]) => leg(provider, a, b, opts, signal));
  const result = withStats(joinLegs(legs), points);
  const fallback = legs.find(l => l.fallback)?.fallback;
  if (fallback) result.fallback = fallback;
  return result;
}

// ---------- Teilstücke ----------

/** Höchstens so viele Teilstücke gleichzeitig – mehr würde einen ausgelasteten Server weiter belasten. */
const LEG_CONCURRENCY = 2;
const LEG_CACHE_MAX = 400;               // Teilstücke im Speicher (ein 100-km-Stück ≈ 3000 Punkte)
const LEG_TTL = 60 * 60 * 1000;          // OSM-Daten bei BRouter ändern sich höchstens täglich
const FALLBACK_TTL = 5 * 60 * 1000;      // Ausweich-Teilstücke bald wieder mit dem gewählten Dienst versuchen
const BUSY_PAUSE = 60 * 1000;            // so lange nach einem „ausgelastet“ ohne neue Versuche direkt ausweichen

const legCache = new Map();              // schlüssel → {value, expires} (Einfügereihenfolge = LRU)
const inflight = new Map();              // schlüssel → {promise, ctrl, waiters}
const busyUntil = new Map();             // dienst-id → Zeitpunkt

const pointKey = p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
const legKey = (provider, a, b, { bike, traffic, eurovelo }) =>
  `${provider.id}|${bike}|${traffic}|${eurovelo}|${pointKey(a)}|${pointKey(b)}`;

function cacheGet(key) {
  const hit = legCache.get(key);
  if (!hit) return null;
  legCache.delete(key);
  if (hit.expires < Date.now()) return null;
  legCache.set(key, hit); // nach hinten = zuletzt benutzt
  return hit.value;
}

function cacheSet(key, value, ttl) {
  legCache.delete(key);
  legCache.set(key, { value, expires: Date.now() + ttl });
  while (legCache.size > LEG_CACHE_MAX) legCache.delete(legCache.keys().next().value);
}

/**
 * Gleiche laufende Anfrage teilen: Fragen zwei Berechnungen dasselbe Teilstück an (z. B. Stopps und
 * Übernachtungen, oder eine neue Berechnung, bevor die alte fertig ist), geht nur eine Anfrage hinaus.
 * Abgebrochen wird sie erst, wenn alle Wartenden abgebrochen haben.
 */
function shared(key, factory, signal) {
  let entry = inflight.get(key);
  if (!entry) {
    const ctrl = new AbortController();
    entry = { ctrl, waiters: 0, promise: factory(ctrl.signal) };
    inflight.set(key, entry);
    const done = () => { if (inflight.get(key) === entry) inflight.delete(key); };
    entry.promise.then(done, done);
  }
  entry.waiters++;
  const own = entry;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (--own.waiters === 0) {
        own.ctrl.abort();
        if (inflight.get(key) === own) inflight.delete(key);
      }
      reject(new DOMException('Abgebrochen', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    own.promise.then(
      v => { signal?.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal?.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

async function leg(provider, a, b, opts, signal) {
  if (onTrack(a, b)) return trackLeg(a, b);
  const key = legKey(provider, a, b, opts);
  const hit = cacheGet(key);
  if (hit) return hit;
  const fallback = FALLBACK[provider.id];
  // Gerade als ausgelastet bekannt: nur ein Versuch, dann gleich ausweichen (sonst 7 s Wartezeit je Teilstück)
  const knownBusy = (busyUntil.get(provider.id) || 0) > Date.now();
  try {
    const value = await shared(key, s => provider.route([a, b], { ...opts, retries: !knownBusy }, s), signal);
    cacheSet(key, value, LEG_TTL);
    return value;
  } catch (e) {
    if (e.name === 'AbortError' || !e.busy || !fallback) throw e;
    busyUntil.set(provider.id, Date.now() + BUSY_PAUSE);
    const fkey = legKey(fallback, a, b, opts);
    const cached = cacheGet(fkey);
    if (cached) return cached;
    routingNotice(`${provider.name} ist ausgelastet – berechne mit ${fallback.name} …`);
    let value;
    try {
      value = { ...await shared(fkey, s => fallback.route([a, b], opts, s), signal), fallback: fallback.name };
    } catch (fe) {
      if (fe.name === 'AbortError') throw fe;
      throw e; // Ausweichdienst geht auch nicht → die ursprüngliche Meldung („BRouter ausgelastet“) zeigen
    }
    cacheSet(fkey, value, FALLBACK_TTL);
    return value;
  }
}

/** Teilstücke aneinanderhängen; Abschnitte (Indizes in coords) werden verschoben und an den Nähten verbunden. */
function joinLegs(legs) {
  const coords = [], segments = [];
  for (const l of legs) {
    const offset = coords.length ? coords.length - 1 : 0;
    for (let i = coords.length ? 1 : 0; i < l.coords.length; i++) coords.push(l.coords[i]);
    for (const s of l.segments || []) segments.push({ ...s, from: s.from + offset, to: s.to + offset });
  }
  return { coords, segments: mergeSegments(segments) };
}

/** `fn` für alle Elemente, höchstens `limit` gleichzeitig; Ergebnis in Eingabereihenfolge. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
