import { brouter } from './brouter.js';
import { ors } from './ors.js';
import { computeStats } from '../utils.js';

export const providers = { brouter, ors };

/**
 * Einheitliches Routenergebnis aller Provider:
 * { coords: [[lat, lon, ele]], cum: [m], distance, ascent, descent, waypoints }
 */
export function withStats(result, waypoints) {
  return { ...result, ...computeStats(result.coords), waypoints };
}

export async function route(provider, points, opts, signal) {
  return withStats(await provider.route(points, opts, signal), points);
}
