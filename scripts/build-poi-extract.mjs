// Datenauszug für den POI-Cache: Orte aller Datenebenen (LAYERS in js/poiSource.js) für ganz Europa aus den
// OpenStreetMap-Auszügen von Geofabrik – statt sie kachelweise bei Overpass abzufragen.
//
//   node scripts/build-poi-extract.mjs [--out dist] [--work tmp] [--regions germany,austria]
//                                      [--geojson region=datei.geojsonseq …]   (Test ohne Download/osmium)
//
// Ablauf je Land (nacheinander, damit nie mehr als ein Auszug auf der Platte liegt):
//   1. <land>-latest.osm.pbf von Geofabrik laden (curl)
//   2. `osmium tags-filter` → nur die benötigten Objekte (samt Knoten für Flächen)
//   3. `osmium export` → GeoJSON-Zeilen
//   4. Orte wie bei Overpass einordnen (toPoi) und den Zellen (0,5°) zuordnen
// Danach entsteht ein Paket aus zwei Dateien:
//   pois-europe.ndjson.gz  erste Zeile Metadaten, danach eine Zeile je Zelle {cell, layers: {ebene: {kachel: [poi]}}}
//   pois-europe.json       Kurzbeschreibung (Zeitpunkt, Prüfsumme) – der Server prüft damit, ob es Neues gibt
//
// Eine Zelle steht nur im Paket, wenn sie vollständig in den verarbeiteten Ländern liegt (Grenzen aus dem
// Geofabrik-Index). Am Rand Europas gilt sonst „keine Orte“, obwohl der Auszug dort nur endet – dort bleibt es
// bei Overpass. Läuft in GitHub Actions (.github/workflows/poi-extract.yml); braucht Linux/macOS mit curl und
// osmium-tool. Daten: © OpenStreetMap-Mitwirkende (ODbL), Auszüge von Geofabrik.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { LAYERS, tileKey, cellOfTile, cacheName, toPoi, CELL } from '../js/poiSource.js';

const INDEX = 'https://download.geofabrik.de/index-v1.json';
// Sammel-Regionen, die sich mit Ländern überschneiden – würden Europa doppelt laden
const COMPOSITE = new Set(['alps', 'dach', 'britain-and-ireland', 'united-kingdom']);
const USER_AGENT = 'CycloRouter-Datenauszug/1.0 (+https://github.com/Jupp09/CycleRouter)';
const NAME = 'pois-europe';

// ---------- Aufruf ----------

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const OUT = opt('out') || 'dist';
const WORK = opt('work') || 'tmp-extract';
const onlyRegions = opt('regions')?.split(',');
// Test: fertige GeoJSON-Zeilen statt Download + osmium, z. B. --geojson liechtenstein=li.geojsonseq
const givenGeojson = new Map(args.flatMap((a, i) => (a === '--geojson' ? [args[i + 1].split('=')] : [])));

const log = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} endete mit Code ${code}`))));
  });
}

// ---------- Sammeln ----------

const layers = Object.keys(LAYERS);
const cells = new Map(); // zelle → Map(cacheName → Map(kachel → Map(id → poi)))
let poiCount = 0;

/** Mittelpunkt des umschließenden Rechtecks einer GeoJSON-Geometrie – wie `out center` bei Overpass. */
function bboxCenter(geometry) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  const walk = c => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
    else c.forEach(walk);
  };
  walk(geometry.coordinates);
  return Number.isFinite(s) ? { lat: (s + n) / 2, lon: (w + e) / 2 } : null;
}

/** Ein Objekt aus `osmium export` (GeoJSON-Feature, Attribute mit „@“) einordnen. */
function addFeature(f) {
  const p = f.properties || {};
  const type = p['@type'], osmId = p['@id'];
  if (!type || osmId == null || !f.geometry) return;
  const center = f.geometry.type === 'Point'
    ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
    : bboxCenter(f.geometry);
  if (!center) return;
  const tags = {};
  for (const [k, v] of Object.entries(p)) if (!k.startsWith('@')) tags[k] = v;
  const obj = { id: `${type}/${osmId}`, lat: center.lat, lon: center.lon, tags, timestamp: p['@timestamp'], version: p['@version'] };
  const tile = tileKey(center.lat, center.lon);
  for (const layer of layers) {
    const poi = toPoi(obj, layer);
    if (!poi) continue;
    const cell = cellOfTile(tile);
    if (!cells.has(cell)) cells.set(cell, new Map());
    const byLayer = cells.get(cell);
    const name = cacheName(layer);
    if (!byLayer.has(name)) byLayer.set(name, new Map());
    const byTile = byLayer.get(name);
    if (!byTile.has(tile)) byTile.set(tile, new Map());
    // Länder-Auszüge überlappen an den Grenzen – gleiche Objekte nur einmal
    if (!byTile.get(tile).has(poi.id)) poiCount++;
    byTile.get(tile).set(poi.id, poi);
  }
}

async function readGeojsonSeq(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  for await (const raw of lines) {
    const line = raw.replace(/^\x1e/, '').trim(); // Datensatz-Trenner von GeoJSON Text Sequences
    if (!line) continue;
    try { addFeature(JSON.parse(line)); n++; } catch { /* kaputte Zeile überspringen */ }
  }
  return n;
}

/** Ein Land: laden, filtern, exportieren, einlesen – und die großen Zwischendateien gleich wieder löschen. */
async function processRegion(region) {
  if (givenGeojson.has(region.id)) return readGeojsonSeq(givenGeojson.get(region.id));
  const pbf = join(WORK, `${region.id}.osm.pbf`);
  const filtered = join(WORK, `${region.id}-pois.osm.pbf`);
  const geojson = join(WORK, `${region.id}.geojsonseq`);
  try {
    await run('curl', ['-fsSL', '--retry', '3', '--retry-delay', '30', '-A', USER_AGENT, '-o', pbf, region.pbf]);
    log(`${region.id}: ${((await stat(pbf)).size / 1e9).toFixed(2)} GB geladen`);
    const filters = layers.flatMap(l => LAYERS[l].filters);
    await run('osmium', ['tags-filter', pbf, ...filters, '-o', filtered, '--overwrite', '--no-progress']);
    await rm(pbf, { force: true });
    await run('osmium', ['export', filtered, '-f', 'geojsonseq', '-a', 'type,id,version,timestamp',
      '-x', 'print_record_separator=false', '--geometry-types=point,linestring,polygon', '-o', geojson, '--overwrite', '--no-progress']);
    return await readGeojsonSeq(geojson);
  } finally {
    await Promise.all([pbf, filtered, geojson].map(f => rm(f, { force: true })));
  }
}

// ---------- Abdeckung ----------

/** Punkt in (Multi-)Polygon – Strahlverfahren, innere Ringe sind Löcher. */
function inPolygon(lon, lat, polygons) {
  let inside = false;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

function bboxOf(polygons) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const rings of polygons) for (const [x, y] of rings[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return { s, w, n, e };
}

/**
 * Zellen, die vollständig in den verarbeiteten Ländern liegen: 9 Prüfpunkte je Zelle (Ecken, Kantenmitten,
 * Mitte) müssen jeweils in mindestens einem Land liegen.
 */
function coveredCells(regions) {
  const shapes = regions.map(r => {
    const polygons = r.geometry.type === 'Polygon' ? [r.geometry.coordinates] : r.geometry.coordinates;
    return { polygons, box: bboxOf(polygons) };
  });
  const inside = (lon, lat) => shapes.some(({ polygons, box }) =>
    lat >= box.s && lat <= box.n && lon >= box.w && lon <= box.e && inPolygon(lon, lat, polygons));
  const all = { s: Math.min(...shapes.map(x => x.box.s)), n: Math.max(...shapes.map(x => x.box.n)),
    w: Math.min(...shapes.map(x => x.box.w)), e: Math.max(...shapes.map(x => x.box.e)) };
  const out = new Set();
  const eps = 1e-6;
  for (let ci = Math.floor(all.s / CELL); ci * CELL < all.n; ci++) {
    for (let cj = Math.floor(all.w / CELL); cj * CELL < all.e; cj++) {
      const s = ci * CELL + eps, n = (ci + 1) * CELL - eps, w = cj * CELL + eps, e = (cj + 1) * CELL - eps;
      const pts = [[w, s], [e, s], [w, n], [e, n], [(w + e) / 2, s], [(w + e) / 2, n], [w, (s + n) / 2], [e, (s + n) / 2], [(w + e) / 2, (s + n) / 2]];
      if (pts.every(([x, y]) => inside(x, y))) out.add(`${ci}_${cj}`);
    }
  }
  return out;
}

// ---------- Ausgabe ----------

async function writeBundle(covered, regionIds) {
  await mkdir(OUT, { recursive: true });
  const file = join(OUT, `${NAME}.ndjson.gz`);
  const t = Date.now();
  const meta = { type: 'meta', t, cell: CELL, layers: layers.map(cacheName), regions: regionIds,
    attribution: '© OpenStreetMap-Mitwirkende (ODbL), Auszüge: Geofabrik' };
  async function* lines() {
    yield JSON.stringify(meta) + '\n';
    for (const cell of [...covered].sort()) {
      const byLayer = cells.get(cell);
      const out = {};
      for (const [name, byTile] of byLayer || []) {
        out[name] = Object.fromEntries([...byTile].map(([tile, pois]) => [tile, [...pois.values()]]));
      }
      yield JSON.stringify({ cell, layers: out }) + '\n';
    }
  }
  await pipeline(lines, createGzip({ level: 9 }), createWriteStream(file));
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  const manifest = { t, file: `${NAME}.ndjson.gz`, bytes: (await stat(file)).size, sha256: hash.digest('hex'),
    cells: covered.size, pois: poiCount, regions: regionIds.length };
  await writeFile(join(OUT, `${NAME}.json`), JSON.stringify(manifest, null, 1));
  return manifest;
}

// ---------- Ablauf ----------

log('Geofabrik-Index wird geladen …');
const index = await (await fetch(INDEX, { headers: { 'User-Agent': USER_AGENT } })).json();
const regions = index.features
  .filter(f => f.properties.parent === 'europe' && !COMPOSITE.has(f.properties.id))
  .filter(f => !onlyRegions || onlyRegions.includes(f.properties.id))
  .map(f => ({ id: f.properties.id, pbf: f.properties.urls.pbf, geometry: f.geometry }));
log(`${regions.length} Regionen: ${regions.map(r => r.id).join(', ')}`);
await mkdir(WORK, { recursive: true });

const done = [];
for (const region of regions) {
  const t0 = Date.now();
  try {
    const n = await processRegion(region);
    done.push(region);
    log(`${region.id}: ${n} Objekte in ${Math.round((Date.now() - t0) / 1000)} s – bisher ${poiCount} Orte`);
  } catch (e) {
    // Ein fehlendes Land ist kein Grund zum Abbruch – es wird nur nicht als abgedeckt markiert
    log(`${region.id}: übersprungen (${e.message})`);
  }
}
if (!done.length) throw new Error('Keine Region verarbeitet');

const covered = coveredCells(done);
// Orte außerhalb abgedeckter Zellen (Randzellen) fallen weg – dort bleibt es bei Overpass
const manifest = await writeBundle(covered, done.map(r => r.id));
log(`Fertig: ${manifest.cells} Zellen, ${manifest.pois} Orte, ${(manifest.bytes / 1e6).toFixed(1)} MB (${manifest.regions} Regionen)`);
await rm(WORK, { recursive: true, force: true });
