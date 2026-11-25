// Grenzpolygone im .poly-Format (Osmosis), wie sie download.openstreetmap.fr zu seinen Auszügen anbietet.
// Eigenes Modul, damit der Unit-Test es ohne den Ablauf von build-poi-extract.mjs laden kann.

/** .poly (Osmosis-Format) → GeoJSON-MultiPolygon; Ringe mit „!“ sind Löcher (zählen beim Strahlverfahren mit). */
export function parsePoly(text) {
  const polygons = [];
  let ring = null, hole = false;
  for (const raw of text.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (ring) {
      if (line === 'END') {
        if (ring.length >= 3) { if (hole && polygons.length) polygons.at(-1).push(ring); else if (!hole) polygons.push([ring]); }
        ring = null;
      } else {
        const [lon, lat] = line.split(/\s+/).map(Number);
        if (Number.isFinite(lon) && Number.isFinite(lat)) ring.push([lon, lat]);
      }
    } else if (line !== 'END') {
      ring = []; hole = line.startsWith('!');
    }
  }
  if (!polygons.length) throw new Error('Polygon ohne Ringe');
  return { type: 'MultiPolygon', coordinates: polygons };
}
