// FIT-Kurs (js/fit.js): Aufbau, Prüfsummen, Kurspunkte, Abschnitte. Mit einem kleinen eigenen Leser – das Garmin
// FIT SDK wäre eine Abhängigkeit; geprüft wurde die Ausgabe einmalig auch mit ihm (11/2026, SDK 21.222).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFit, fitCrc, POINT } from '../../js/fit.js';
import { computeStats } from '../../js/utils.js';
import { parseTurns } from '../../js/routing/brouter.js';

/** Minimaler FIT-Leser: Nachrichten als {global, fields: {nummer: wert}} (nur die Basistypen, die fit.js schreibt) */
function readFit(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headSize = bytes[0], dataSize = v.getUint32(4, true);
  const defs = new Map(), out = [];
  let p = headSize;
  while (p < headSize + dataSize) {
    const h = bytes[p++];
    if (h & 0x40) {
      p += 2; // reserviert, Architektur (immer Little Endian)
      const global = v.getUint16(p, true); p += 2;
      const fields = [];
      for (let n = bytes[p++], k = 0; k < n; k++, p += 3) fields.push([bytes[p], bytes[p + 1], bytes[p + 2]]);
      defs.set(h & 0x0f, { global, fields });
      continue;
    }
    const def = defs.get(h & 0x0f);
    const fields = {};
    for (const [num, size, type] of def.fields) {
      if (type === 0x07) {
        const raw = bytes.subarray(p, p + size);
        const end = raw.indexOf(0);
        fields[num] = new TextDecoder().decode(raw.subarray(0, end < 0 ? size : end));
      } else {
        fields[num] = { 1: v.getUint8(p), 2: v.getUint16(p, true), 4: type === 0x85 ? v.getInt32(p, true) : v.getUint32(p, true) }[size];
      }
      p += size;
    }
    out.push({ global: def.global, fields });
  }
  return out;
}

/** @returns {any} Route mit Zwischenstopp, Wasser, Verpflegung und Abbiegungen (nur die Felder, die fit.js liest) */
function testRoute() {
  const coords = Array.from({ length: 201 }, (_, i) => [50 + i * 0.001, 7, 100 + i * 0.5]);
  const wp = i => ({ lat: coords[i][0], lon: coords[i][1] });
  const stats = computeStats(coords);
  return {
    coords, ...stats, waypoints: [wp(0), { ...wp(50), manual: true, label: 'Café Übersee am langen Ufer' }, wp(200)],
    water: [{ along: stats.cum[30], poi: { lat: 50.03, lon: 7.0005, name: 'Brunnen', tags: {} } }],
    stops: [{ along: stats.cum[120], typeLabel: 'Bäckerei', gpxSym: 'Restaurant', poi: { lat: 50.12, lon: 7.0002, name: 'Müller', tags: {} } }],
    turns: [{ i: 10, cmd: 2, exit: 0, angle: -90 }, { i: 80, cmd: 14, exit: 2, angle: 45 }, { i: 90, cmd: 1, exit: 0, angle: 0 }, { i: 160, cmd: 6, exit: 0, angle: 30 }],
  };
}

test('Kopf, Prüfsummen und Nachrichtenfolge eines Kurses', () => {
  const bytes = toFit(testRoute(), 'Runde', { seconds: 3600, start: new Date('2026-11-28T09:00:00Z') });
  const v = new DataView(bytes.buffer);
  assert.equal(bytes[0], 14);
  assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), '.FIT');
  assert.equal(v.getUint16(12, true), fitCrc(bytes.subarray(0, 12)), 'Kopf-CRC');
  assert.equal(v.getUint32(4, true), bytes.length - 16, 'Datenlänge');
  assert.equal(fitCrc(bytes), 0, 'Datei-CRC (über alles inkl. CRC ergibt 0)');
  const msgs = readFit(bytes);
  const order = [...new Set(msgs.map(m => m.global))];
  assert.deepEqual(order, [0, 31, 19, 21, 20, 32], 'file_id, course, lap, event, record, course_point');
  assert.equal(msgs[0].fields[0], 6, 'Dateityp Kurs');
  assert.equal(msgs[1].fields[4], 2, 'Sport Radfahren');
  assert.equal(msgs[1].fields[5], 'Runde');
  const records = msgs.filter(m => m.global === 20);
  assert.equal(records.length, 201);
  assert.equal(records[0].fields[5], 0);
  assert.equal(records.at(-1).fields[253] - records[0].fields[253], 3600, 'virtueller Partner: geschätzte Fahrzeit');
  assert.equal(records[0].fields[2], (100 + 500) * 5, 'Höhe mit Versatz 500 und Faktor 5');
});

test('Kurspunkte: Verpflegung, Wasser, Zwischenstopp, Abbiegungen – ohne „geradeaus“, nach Strecke', () => {
  const points = readFit(toFit(testRoute(), 'Runde', { seconds: 3600 })).filter(m => m.global === 32);
  assert.deepEqual(points.map(p => [p.fields[5], p.fields[6]]), [
    [POINT.left, 'Links'], [POINT.water, 'Trinkwasser: Brunnen'], [POINT.generic, 'Café Übersee am lange'], // 23 Byte: é und Ü zählen doppelt
    [POINT.right, 'Kreisel 2. Ausf.'], [POINT.food, 'Bäckerei: Müller'], [POINT.slightRight, 'Leicht rechts'],
  ]);
  assert.deepEqual(points.map(p => p.fields[254]), [0, 1, 2, 3, 4, 5], 'laufende Nummer');
  const dist = points.map(p => p.fields[4]);
  assert.deepEqual(dist, [...dist].sort((a, b) => a - b));
});

test('Namen: UTF-8 auf Feldlänge gekürzt, nie mitten in einem Zeichen', () => {
  const r = testRoute();
  r.waypoints[1].label = 'ä'.repeat(40); // 80 Byte
  const via = readFit(toFit(r, 'x', { seconds: 60 })).find(m => m.global === 32 && m.fields[6].startsWith('ä'));
  assert.equal(via.fields[6], 'ä'.repeat(11), '23 Byte Platz → 11 ganze Zeichen');
});

test('Abschnitt (ein Tag): Punkte, Strecke ab 0, nur Hinweise im Abschnitt', () => {
  const r = testRoute();
  const range = { from: r.cum[100], to: r.cum[200] };
  const msgs = readFit(toFit(r, 'Tag 2', { range, seconds: 1800 }));
  const records = msgs.filter(m => m.global === 20);
  assert.equal(records.length, 101);
  assert.equal(records[0].fields[5], 0);
  assert.equal(Math.round(records.at(-1).fields[5] / 100), Math.round(r.cum[200] - r.cum[100]));
  assert.deepEqual(msgs.filter(m => m.global === 32).map(m => m.fields[6]), ['Bäckerei: Müller', 'Leicht rechts']);
});

test('parseTurns: nur bekannte Befehle auf Punkten innerhalb des Teilstücks', () => {
  assert.deepEqual(parseTurns([[0, 2, 0, 5, -90], [8, 2, 0, 98, -95], [16, 6, 0, 1294, 38.4], [20, 100, 0, 0, 0], [30, 13, 0, 0, 0], [99, 5, 0, 0, 90]], 100),
    [{ i: 8, cmd: 2, exit: 0, angle: -95 }, { i: 16, cmd: 6, exit: 0, angle: 38 }]);
  assert.deepEqual(parseTurns(undefined, 10), []);
});
