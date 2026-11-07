// Lädt Verpflegungsstellen einer Region vorab in den Server-Cache, damit die erste Routenplanung
// dort ohne Wartezeit auf Overpass auskommt. (Heimatregionen von Nutzern lädt der Server automatisch,
// siehe server/warmQueue.mjs – dieses Skript ist für manuelles Vorladen beliebiger Regionen.)
//
//   npm run warm -- <lat> <lon> [radius-km]      z. B.  npm run warm -- 53.07 8.80 60
import './env.mjs';
import { getTiles, tilesAround, TTL, ALL_LAYERS } from './poiCache.mjs';

const [lat, lon, radiusKm = 50] = process.argv.slice(2).map(Number);
if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusKm > 0)) {
  console.error('Aufruf: npm run warm -- <lat> <lon> [radius-km]   (z. B. npm run warm -- 53.07 8.80 60)');
  process.exit(1);
}

const keys = tilesAround(lat, lon, radiusKm);
console.log(`${keys.length} Kacheln im Umkreis von ${radiusKm} km um ${lat}, ${lon} (Gültigkeit ${TTL / 86400000} Tage)`);
const t0 = Date.now();
const { tiles, stats } = await getTiles(keys, { layers: ALL_LAYERS, log: msg => console.log('  ' + msg) });
const count = Object.values(tiles).reduce((n, p) => n + p.length, 0);
console.log(`Fertig in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${stats.fetched} neu geladen, ${stats.cached} schon im Cache, `
  + `${stats.stale} abgelaufen (werden aktualisiert) – ${count} Stellen.`);
if (stats.stale) console.log('Warte auf Aktualisierung der abgelaufenen Kacheln …');
