/**
 * FIT-Kurs für Radcomputer (Garmin, Wahoo, Hammerhead u. a.): das native Kursformat dieser Geräte, binär nach dem
 * FIT-Protokoll (Garmin FIT SDK, Profil 21.x). Anders als GPX-Wegpunkte zeigen die Geräte Kurspunkte unterwegs an
 * („Bäckerei in 2 km“) und kündigen Abbiegungen an.
 *
 * Inhalt: file_id (Typ Kurs), course (Name, Radfahren), lap (Länge, Höhenmeter, Dauer), event Start, je
 * Routenpunkt ein record (Position, Höhe, Strecke, Zeit), event Ende und die course_points: Verpflegung, Wasser,
 * Übernachtungen, Zwischenstopps (aus routeWaypoints in gpx.js, wie im GPX) und die Abbiegehinweise von BRouter
 * (route.turns, nur mit BRouter berechnete Routen; importierte GPX-Wege und ORS haben keine).
 *
 * Die Zeiten sind die des „virtuellen Partners“: gleichmäßig über die geschätzte Fahrzeit verteilt (`seconds`,
 * dieselbe Schätzung wie „Reine Fahrzeit“). Reines Modul ohne DOM – unit-getestet (tests/unit/fit.test.mjs).
 */
import { indexAtDistance } from './utils.js';
import { routeWaypoints } from './gpx.js';

/** Sekunden zwischen 1.1.1970 und dem FIT-Bezugspunkt 31.12.1989 00:00 UTC */
const FIT_EPOCH = 631065600;
const PROFILE_VERSION = 2132; // 21.32
const MANUFACTURER_DEVELOPMENT = 255;

// Basistypen (FIT-Protokoll): Nummer mit Endianness-Bit
const T = { enum: 0x00, uint8: 0x02, uint16: 0x84, sint32: 0x85, uint32: 0x86, string: 0x07 };
const SIZE = { [T.enum]: 1, [T.uint8]: 1, [T.uint16]: 2, [T.sint32]: 4, [T.uint32]: 4 };
const INVALID = { [T.enum]: 0xff, [T.uint8]: 0xff, [T.uint16]: 0xffff, [T.sint32]: 0x7fffffff, [T.uint32]: 0xffffffff };

/**
 * Kurspunkt-Typen (FIT course_point). Nur die seit Langem definierten Werte – neuere (Zeltplatz, Rastplatz …)
 * zeigen ältere Geräte als unbekannt an.
 */
export const POINT = {
  generic: 0, summit: 1, valley: 2, water: 3, food: 4, danger: 5, left: 6, right: 7, straight: 8,
  leftFork: 16, rightFork: 17, slightLeft: 19, sharpLeft: 20, slightRight: 21, sharpRight: 22, uTurn: 23,
};

/** BRouter-Befehl (parseTurns in routing/brouter.js) → [Kurspunkt-Typ, Name]. Geradeaus (1) fehlt bewusst. */
const TURN = {
  2: [POINT.left, 'Links'], 3: [POINT.slightLeft, 'Leicht links'], 4: [POINT.sharpLeft, 'Scharf links'],
  5: [POINT.right, 'Rechts'], 6: [POINT.slightRight, 'Leicht rechts'], 7: [POINT.sharpRight, 'Scharf rechts'],
  8: [POINT.leftFork, 'Links halten'], 9: [POINT.rightFork, 'Rechts halten'],
  10: [POINT.uTurn, 'Wenden'], 11: [POINT.uTurn, 'Wenden'], 12: [POINT.uTurn, 'Wenden'],
  17: [POINT.left, 'Ausfahrt links'], 18: [POINT.right, 'Ausfahrt rechts'],
};
/** Kreisverkehr (14 rechtsherum, 15 linksherum): Richtung nach dem Winkel, Name mit Ausfahrt */
const roundabout = t => [t.angle < 0 ? POINT.left : POINT.right, t.exit ? `Kreisel ${t.exit}. Ausf.` : 'Kreisel'];

const KIND = { stop: POINT.food, water: POINT.water, stay: POINT.generic, via: POINT.generic };

/** Länge der Namensfelder in Byte (UTF-8, mit Nullbyte). Geräte zeigen meist 15–20 Zeichen. */
const COURSE_NAME = 40, POINT_NAME = 24;

// ---------- Kodierung ----------

/** FIT-CRC-16 (aus dem FIT SDK) */
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
export function fitCrc(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

/** Text als nullterminiertes UTF-8 fester Länge; kein halbes Mehrbyte-Zeichen am Ende */
function utf8Field(text, size) {
  const out = new Uint8Array(size);
  let bytes = new TextEncoder().encode(String(text ?? ''));
  if (bytes.length > size - 1) {
    let cut = size - 1;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--; // nicht mitten in einem Zeichen abschneiden
    bytes = bytes.subarray(0, cut);
  }
  out.set(bytes);
  return out;
}

/** Wachsender Puffer mit den Schreibfunktionen der Basistypen (Little Endian) */
function writer() {
  let buf = new Uint8Array(1 << 16), view = new DataView(buf.buffer), n = 0;
  const room = k => {
    if (n + k <= buf.length) return;
    const next = new Uint8Array(Math.max(buf.length * 2, n + k));
    next.set(buf);
    buf = next;
    view = new DataView(buf.buffer);
  };
  return {
    get length() { return n; },
    u8(v) { room(1); buf[n++] = v; },
    value(type, v, size) {
      if (type === T.string) { room(size); buf.set(utf8Field(v, size), n); n += size; return; }
      const k = SIZE[type];
      room(k);
      const x = v == null || !Number.isFinite(v) ? INVALID[type] : v;
      if (type === T.uint16) view.setUint16(n, x, true);
      else if (type === T.sint32) view.setInt32(n, x, true);
      else if (type === T.uint32) view.setUint32(n, x, true);
      else view.setUint8(n, x);
      n += k;
    },
    bytes() { return buf.slice(0, n); },
  };
}

/**
 * Nachrichtentypen: global = FIT-Nachrichtennummer, fields = [[feldnummer, basistyp, größe?]].
 * Jeder bekommt einen eigenen lokalen Typ, die Definition steht einmal vor der ersten Nachricht.
 */
const MESSAGES = {
  fileId: { global: 0, fields: [[0, T.enum], [1, T.uint16], [2, T.uint16], [4, T.uint32]] },
  course: { global: 31, fields: [[4, T.enum], [5, T.string, COURSE_NAME]] },
  lap: { global: 19, fields: [[253, T.uint32], [2, T.uint32], [3, T.sint32], [4, T.sint32], [5, T.sint32], [6, T.sint32],
    [7, T.uint32], [8, T.uint32], [9, T.uint32], [21, T.uint16], [22, T.uint16]] },
  event: { global: 21, fields: [[253, T.uint32], [0, T.enum], [1, T.enum], [4, T.uint8]] },
  record: { global: 20, fields: [[253, T.uint32], [0, T.sint32], [1, T.sint32], [2, T.uint16], [5, T.uint32]] },
  coursePoint: { global: 32, fields: [[254, T.uint16], [1, T.uint32], [2, T.sint32], [3, T.sint32], [4, T.uint32], [5, T.enum], [6, T.string, POINT_NAME]] },
};

function encoder() {
  const w = writer();
  const local = new Map(); // Name → lokaler Typ
  return {
    w,
    message(name, values) {
      const def = MESSAGES[name];
      if (!local.has(name)) {
        const id = local.size;
        local.set(name, id);
        w.u8(0x40 | id); w.u8(0); w.u8(0); // Definition, reserviert, Little Endian
        w.value(T.uint16, def.global);
        w.u8(def.fields.length);
        for (const [num, type, size] of def.fields) { w.u8(num); w.u8(size ?? SIZE[type]); w.u8(type); }
      }
      w.u8(local.get(name));
      def.fields.forEach(([, type, size], k) => w.value(type, values[k], size));
    },
  };
}

// ---------- Kurs ----------

const semicircles = deg => Math.round(deg * (2 ** 31 / 180));
const altitude = ele => (ele == null || !Number.isFinite(ele) ? null : Math.max(0, Math.min(0xfffe, Math.round((ele + 500) * 5))));

/**
 * Kurspunkte eines Abschnitts (Indizes i0..i1 in route.coords): Hinweise aus routeWaypoints und Abbiegungen,
 * nach Strecke sortiert → [{i, lat, lon, type, name}] mit `i` relativ zum Abschnitt.
 */
export function coursePoints(route, range, i0, i1) {
  const points = routeWaypoints(route, range).map(p => {
    const i = Math.min(i1, Math.max(i0, indexAtDistance(route, p.along ?? 0))) - i0;
    return { i, lat: p.lat, lon: p.lon, type: KIND[p.kind] ?? POINT.generic, name: p.name };
  });
  for (const t of route.turns || []) {
    if (t.i <= i0 || t.i >= i1) continue;
    const [type, name] = t.cmd === 14 || t.cmd === 15 ? roundabout(t) : TURN[t.cmd] || [];
    if (type == null) continue;
    const [lat, lon] = route.coords[t.i];
    points.push({ i: t.i - i0, lat, lon, type, name });
  }
  return points.sort((a, b) => a.i - b.i);
}

/**
 * FIT-Kurs der Route → Uint8Array. `range` {from, to} (m ab Start) wie bei toGpx: nur dieser Abschnitt (ein Tag);
 * `seconds`: geschätzte Fahrzeit des Abschnitts (Zeiten des virtuellen Partners); `start`: Zeitpunkt des Starts.
 * @param {Route & {stays?: any, water?: any[], stops?: any[]}} route
 * @param {string} name
 * @param {{range?: {from: number, to: number} | null, seconds: number, start?: Date}} options
 */
export function toFit(route, name, { range = null, seconds, start = new Date() }) {
  const i0 = range ? indexAtDistance(route, range.from) : 0;
  const i1 = range ? indexAtDistance(route, range.to) : route.coords.length - 1;
  const coords = route.coords.slice(i0, i1 + 1);
  const dist = i => route.cum[i0 + i] - route.cum[i0];
  const total = dist(coords.length - 1);
  const t0 = Math.floor(start.getTime() / 1000) - FIT_EPOCH;
  const timeAt = i => t0 + Math.round(total ? seconds * dist(i) / total : 0);
  let ascent = 0, descent = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = (coords[i][2] ?? NaN) - (coords[i - 1][2] ?? NaN);
    if (d > 0) ascent += d; else if (d < 0) descent -= d;
  }
  const [first, last] = [coords[0], coords.at(-1)];
  const end = timeAt(coords.length - 1);

  const e = encoder();
  e.message('fileId', [6, MANUFACTURER_DEVELOPMENT, 0, t0]); // Typ 6 = Kurs
  e.message('course', [2, name]);                            // Sport 2 = Radfahren
  e.message('lap', [end, t0, semicircles(first[0]), semicircles(first[1]), semicircles(last[0]), semicircles(last[1]),
    Math.round(seconds * 1000), Math.round(seconds * 1000), Math.round(total * 100),
    // Höhenmeter wie in der App gerechnet, wenn es die ganze Route ist (Abschnitt: Summe der Rohdaten)
    range ? Math.round(ascent) : Math.round(route.ascent ?? ascent), range ? Math.round(descent) : Math.round(route.descent ?? descent)]);
  e.message('event', [t0, 0, 0, 0]);                         // Timer Start
  coords.forEach(([lat, lon, ele], i) => {
    e.message('record', [timeAt(i), semicircles(lat), semicircles(lon), altitude(ele), Math.round(dist(i) * 100)]);
  });
  e.message('event', [end, 0, 9, 0]);                        // Timer Ende (stop_disable_all)
  coursePoints(route, range, i0, i1).forEach((p, k) => {
    e.message('coursePoint', [k, timeAt(p.i), semicircles(p.lat), semicircles(p.lon), Math.round(dist(p.i) * 100), p.type, p.name]);
  });

  // Kopf (14 Byte, mit eigener CRC), Daten, CRC über alles
  const data = e.w.bytes();
  const head = new Uint8Array(14);
  const hv = new DataView(head.buffer);
  head[0] = 14; head[1] = 0x20; // Protokoll 2.0
  hv.setUint16(2, PROFILE_VERSION, true);
  hv.setUint32(4, data.length, true);
  head.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  hv.setUint16(12, fitCrc(head.subarray(0, 12)), true);
  const file = new Uint8Array(14 + data.length + 2);
  file.set(head); file.set(data, 14);
  new DataView(file.buffer).setUint16(14 + data.length, fitCrc(file.subarray(0, 14 + data.length)), true);
  return file;
}
