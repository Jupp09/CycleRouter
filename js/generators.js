import { destination, seededRandom, estimateTime, averageSpeed } from './utils.js';
import { route, withStats } from './routing/index.js';

// Straßen sind länger als die Luftlinie – Startwert für das Verhältnis Route/Geometrie.
const DETOUR = 1.3;
const TOLERANCE = 0.06;
const MAX_ITERATIONS = 5;
const MAX_FAILURES = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Standardmaß: Länge der Route in m */
const byDistance = res => res.distance;

/**
 * Wiederholt `attempt(scale)` und passt `scale` an, bis das Maß der Route (`measure`: Länge in m oder Fahrzeit
 * in s) nah genug am Ziel ist. `attempt` bekommt außerdem eine Fehlerzahl, um nach Routing-Fehlern eine andere
 * Variante zu wählen. Länge und Fahrzeit wachsen beide etwa linear mit `scale`, daher dieselbe Korrektur.
 */
async function iterate(target, initialScale, attempt, { signal, onProgress, measure = byDistance }) {
  const deviation = res => Math.abs(measure(res) - target) / target;
  let scale = initialScale, best = null, failures = 0, lastError;
  for (let i = 0; i < MAX_ITERATIONS + failures && failures < MAX_FAILURES; i++) {
    onProgress?.(i + 1);
    let res;
    try {
      res = await attempt(scale, failures);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      failures++;
      continue;
    }
    if (!best || deviation(res) < deviation(best)) best = res;
    if (deviation(res) <= TOLERANCE) break;
    scale *= clamp(target / measure(res), 0.5, 2);
  }
  if (!best) throw lastError || new Error('Es konnte keine Route gefunden werden.');
  return best;
}

/**
 * Rundkurs: Wegpunkte auf einem Kreis, der durch den Start geht und in Richtung `bearing` liegt.
 * Mit `duration` (s) statt nach Länge nach der reinen Fahrzeit (Tempo in der Ebene plus Anstiege, wie die
 * Fahrzeit im Ergebnis): Startwert ist die Länge, die bei diesem Tempo ohne Anstiege passen würde; die Anstiege
 * der ersten Runde verkürzen sie dann.
 * @param {object} p
 * @param {any} p.provider
 * @param {{lat: number, lon: number}} p.start
 * @param {number} p.distance Wunschlänge in m (ohne `duration`)
 * @param {number} p.bearing
 * @param {number} p.seed
 * @param {any} p.opts
 * @param {AbortSignal} p.signal
 * @param {(i: number) => void} [p.onProgress]
 * @param {number | null} [p.duration] gewünschte reine Fahrzeit in s
 * @param {string} [p.bike] Fahrradtyp für die Fahrzeit
 */
export function generateLoop({ provider, start, distance, bearing, seed, opts, signal, onProgress, duration = null, bike = 'trekking' }) {
  const measure = duration ? res => estimateTime(res.distance, res.ascent, bike) : byDistance;
  const target = duration || distance;
  if (duration) distance = duration / 3600 * averageSpeed(bike) * 1000;
  if (provider.roundTrip) {
    return iterate(target, distance, async (length, failures) =>
      withStats(await provider.roundTrip(start, length, seed + failures, opts, signal), [start]),
    { signal, onProgress, measure });
  }

  const radius = distance / (2 * Math.PI * DETOUR);
  return iterate(target, radius, (r, failures) => {
    const rng = seededRandom(seed + failures * 7919);
    const dir = rng() < 0.5 ? 1 : -1;
    const via = [1, 2, 3].map(k => {
      const angle = bearing + 180 + dir * (k * 90 + (rng() - 0.5) * 30);
      return { angle, factor: 0.8 + rng() * 0.4 };
    });
    const center = destination(start, bearing, r);
    const points = via.map(v => destination(center, v.angle, r * v.factor));
    return route(provider, [start, ...points, start], opts, signal);
  }, { signal, onProgress, measure });
}

/** Start + Distanz: Ziel in passender Luftlinie Richtung `bearing`. */
export function generateOneWay({ provider, start, distance, bearing, seed, opts, signal, onProgress }) {
  return iterate(distance, distance / DETOUR, (airline, failures) => {
    const rng = seededRandom(seed + failures * 7919);
    const end = destination(start, bearing + (rng() - 0.5) * 30, airline);
    return route(provider, [start, end], opts, signal);
  }, { signal, onProgress });
}
