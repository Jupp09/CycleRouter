// Lädt Verpflegungsstellen einer Region vorab in den Server-Cache, damit die erste Routenplanung
// dort ohne Wartezeit auf Overpass auskommt.
//
//   npm run warm -- <lat> <lon> [radius-km]      z. B.  npm run warm -- 53.07 8.80 60
import { getTiles, TTL } from './poiCache.mjs';
import { TILE, tileKey } from '../js/poiSource.js';

const [lat, lon, radiusKm = 50] = process.argv.slice(2).map(Number);
if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusKm > 0)) {
  console.error('Aufruf: npm run warm -- <lat> <lon> [radius-km]   (z. B. npm run warm -- 53.07 8.80 60)');
  process.exit(1);
}

// Alle Kacheln, deren Mittelpunkt im Umkreis liegt (plus eine Kachel Rand)
const dLat = radiusKm / 111 + TILE, dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180)) + TILE;
const keys = new Set();
for (let a = lat - dLat; a <= lat + dLat; a += TILE / 2) {
  for (let o = lon - dLon; o <= lon + dLon; o += TILE / 2) {
    const km = Math.hypot((a - lat) * 111, (o - lon) * 111 * Math.cos(lat * Math.PI / 180));
    if (km <= radiusKm + 8) keys.add(tileKey(a, o));
  }
}

console.log(`${keys.size} Kacheln im Umkreis von ${radiusKm} km um ${lat}, ${lon} (Gültigkeit ${TTL / 86400000} Tage)`);
const t0 = Date.now();
const { tiles, stats } = await getTiles([...keys], { log: msg => console.log('  ' + msg) });
const count = Object.values(tiles).reduce((n, p) => n + p.length, 0);
console.log(`Fertig in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${stats.fetched} neu geladen, ${stats.cached} schon im Cache, `
  + `${stats.stale} abgelaufen (werden aktualisiert) – ${count} Stellen.`);
if (stats.stale) console.log('Warte auf Aktualisierung der abgelaufenen Kacheln …');
