// Unit-Tests der Domänenmodule (js/, ohne Browser und ohne Netz): npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpeningHours, openState } from '../../js/openingHours.js';
import { computeStats, formatKm, estimateTime } from '../../js/utils.js';
import { tileKey, isTileKey, cellOfTile, isLayer, LAYERS, layerOfType } from '../../js/poiSource.js';
import { headwind } from '../../js/weather.js';
import { findClimbs, gradeSegments } from '../../js/climbs.js';
import { timeline } from '../../js/timeline.js';
import { sunTimes } from '../../js/sun.js';
import { SYNC_KEYS, MODES, BIKES } from '../../js/shared.js';

// Montag, 16.11.2026, Ortszeit
const monday = (h, m = 0) => new Date(2026, 10, 16, h, m);
const sunday = (h, m = 0) => new Date(2026, 10, 22, h, m);

/**
 * Gerade Route nach Norden: `n` Punkte im Abstand von ~111 m, Höhen aus `ele(i)`.
 * @param {number} n
 * @param {(i: number) => number} [ele]
 * @returns {Route}
 */
function straightRoute(n, ele = () => 0) {
  /** @type {Coord[]} */
  const coords = Array.from({ length: n }, (_, i) => [53 + i * 0.001, 8.8, ele(i)]);
  return { ...computeStats(coords), coords, waypoints: [], segments: [] };
}

test('Öffnungszeiten: Wochentage und Uhrzeiten', () => {
  const week = parseOpeningHours('Mo-Fr 08:00-18:00');
  assert.deepEqual(week[0], [[480, 1080]]);
  assert.deepEqual(week[6], []);
  assert.equal(openState('Mo-Fr 08:00-18:00', monday(10)), 'open');
  assert.equal(openState('Mo-Fr 08:00-18:00', sunday(10)), 'closed');
  assert.equal(openState('Mo-Fr 08:00-18:00', monday(7, 30)), 'closed');
  // Mindestaufenthalt: 10 Minuten vor Schluss reicht es für 15 Minuten nicht mehr
  assert.equal(openState('Mo-Fr 08:00-18:00', monday(17, 50)), 'closed');
  assert.equal(openState('Mo-Fr 08:00-18:00', monday(17, 50), 5), 'open');
});

test('Öffnungszeiten: Unverständliches ist „unknown“, nicht „geschlossen“', () => {
  assert.equal(parseOpeningHours('nach Vereinbarung'), null);
  assert.equal(openState('nach Vereinbarung', monday(10)), 'unknown');
  assert.equal(openState(undefined, monday(10)), 'unknown');
});

test('Öffnungszeiten: Feiertage (PH off)', () => {
  const value = 'Mo-Sa 08:00-20:00; PH off';
  assert.equal(openState(value, monday(10)), 'open');
  assert.equal(openState(value, monday(10), 15, true), 'closed');
});

test('Streckenwerte: Länge, Anstieg, Formatierung', () => {
  const r = straightRoute(11, i => (i < 5 ? 0 : 50)); // 10 Abstände à ~111 m, einmal 50 m hoch
  assert.ok(Math.abs(r.distance - 1112) < 5, `Länge ${r.distance}`);
  assert.equal(r.cum.length, 11);
  assert.equal(r.cum[0], 0);
  assert.equal(r.ascent, 50);
  assert.equal(r.descent, 0);
  assert.equal(formatKm(12345), '12,3 km');
  assert.equal(formatKm(123456), '123 km');
  // Anstieg verlängert die Fahrzeit
  assert.ok(estimateTime(10000, 500, 'road') > estimateTime(10000, 0, 'road'));
});

test('Kacheln und Zellen (auch südlich/westlich von 0°)', () => {
  assert.equal(tileKey(53.07, 8.80), '530_88');
  assert.equal(tileKey(-0.05, -0.05), '-1_-1');
  assert.ok(isTileKey('530_88') && isTileKey('-1_-1'));
  assert.ok(!isTileKey('530_88/../x') && !isTileKey('530') && !isTileKey('a_b'));
  assert.equal(cellOfTile('530_88'), '106_17');
  assert.equal(cellOfTile('-1_-1'), '-1_-1');
});

test('Datenebenen: jeder Typ gehört zu genau einer Ebene', () => {
  for (const layer of Object.keys(LAYERS)) assert.ok(isLayer(layer), layer);
  assert.ok(!isLayer('../supply'));
  assert.equal(layerOfType('supermarket'), 'supply');
});

test('Gegenwind: von vorn positiv, von hinten negativ', () => {
  assert.ok(Math.abs(headwind(10, 0, 0) - 10) < 1e-9); // Wind aus Norden, Fahrt nach Norden
  assert.ok(Math.abs(headwind(10, 180, 0) + 10) < 1e-9);
  assert.ok(Math.abs(headwind(10, 90, 0)) < 1e-9);
});

test('Anstiege: ein 5-%-Anstieg wird gefunden, flach bleibt flach', () => {
  // 3 km flach, dann ~2,2 km mit 5,6 m je 111 m (≈ 5 %), dann flach
  const r = straightRoute(80, i => (i < 27 ? 0 : i < 47 ? (i - 27) * 5.56 : 111));
  const climbs = findClimbs(r);
  assert.equal(climbs.length, 1);
  assert.ok(Math.abs(climbs[0].gain - 111) < 15, `Höhengewinn ${climbs[0].gain}`);
  assert.ok(climbs[0].mean > 0.04 && climbs[0].mean < 0.06, `mittlere Steigung ${climbs[0].mean}`);
  const segs = gradeSegments(r);
  assert.equal(segs[0].from, 0);
  assert.equal(segs.at(-1).to, r.coords.length - 1);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to, 'lückenlos');
  assert.deepEqual(findClimbs(straightRoute(80)), []);
});

test('Zeitplan: Abfahrt bei 0 km, später mit mehr Strecke', () => {
  const r = straightRoute(100);
  const departure = monday(8);
  const eta = timeline(r, departure, 'road');
  assert.equal(eta(0).getTime(), departure.getTime());
  assert.ok(eta(r.distance) > eta(r.distance / 2));
  assert.equal(eta.dayOf(0), 0);
});

test('Sonne: Aufgang vor Untergang, Bremen im November ~8 h Tageslicht', () => {
  const t = sunTimes(53.08, 8.8, new Date(2026, 10, 20));
  assert.ok(t.rise < t.set);
  const hours = (t.set.getTime() - t.rise.getTime()) / 3.6e6;
  assert.ok(hours > 7.5 && hours < 9, `${hours} h`);
});

test('Gemeinsame Werte von Browser und Server', () => {
  assert.deepEqual(MODES, ['ab', 'distance', 'loop']);
  assert.deepEqual(BIKES, ['road', 'gravel', 'trekking', 'ebike']);
  // Der ORS-Key bleibt im Browser (CLAUDE.md): Er darf nie abgeglichen werden
  assert.ok(!SYNC_KEYS.some(k => /ors|key/i.test(k)), SYNC_KEYS.join(', '));
});
