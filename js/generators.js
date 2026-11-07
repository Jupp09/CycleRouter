import { destination, seededRandom } from './utils.js';
import { route, withStats } from './routing/index.js';

// Straßen sind länger als die Luftlinie – Startwert für das Verhältnis Route/Geometrie.
const DETOUR = 1.3;
const TOLERANCE = 0.06;
const MAX_ITERATIONS = 5;
const MAX_FAILURES = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const deviation = (res, target) => Math.abs(res.distance - target) / target;

/**
 * Wiederholt `attempt(scale)` und passt `scale` an, bis die Routenlänge nah genug am Ziel ist.
 * `attempt` bekommt außerdem eine Fehlerzahl, um nach Routing-Fehlern eine andere Variante zu wählen.
 */
async function iterate(target, initialScale, attempt, { signal, onProgress }) {
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
    if (!best || deviation(res, target) < deviation(best, target)) best = res;
    if (deviation(res, target) <= TOLERANCE) break;
    scale *= clamp(target / res.distance, 0.5, 2);
  }
  if (!best) throw lastError || new Error('Es konnte keine Route gefunden werden.');
  return best;
}

/** Rundkurs: Wegpunkte auf einem Kreis, der durch den Start geht und in Richtung `bearing` liegt. */
export function generateLoop({ provider, start, distance, bearing, seed, opts, signal, onProgress }) {
  if (provider.roundTrip) {
    return iterate(distance, distance, async (length, failures) =>
      withStats(await provider.roundTrip(start, length, seed + failures, opts, signal), [start]),
    { signal, onProgress });
  }

  const radius = distance / (2 * Math.PI * DETOUR);
  return iterate(distance, radius, (r, failures) => {
    const rng = seededRandom(seed + failures * 7919);
    const dir = rng() < 0.5 ? 1 : -1;
    const via = [1, 2, 3].map(k => {
      const angle = bearing + 180 + dir * (k * 90 + (rng() - 0.5) * 30);
      return { angle, factor: 0.8 + rng() * 0.4 };
    });
    const center = destination(start, bearing, r);
    const points = via.map(v => destination(center, v.angle, r * v.factor));
    return route(provider, [start, ...points, start], opts, signal);
  }, { signal, onProgress });
}

/** Start + Distanz: Ziel in passender Luftlinie Richtung `bearing`. */
export function generateOneWay({ provider, start, distance, bearing, seed, opts, signal, onProgress }) {
  return iterate(distance, distance / DETOUR, (airline, failures) => {
    const rng = seededRandom(seed + failures * 7919);
    const end = destination(start, bearing + (rng() - 0.5) * 30, airline);
    return route(provider, [start, end], opts, signal);
  }, { signal, onProgress });
}
