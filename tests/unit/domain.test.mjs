// Unit-Tests der Domänenmodule (js/, ohne Browser und ohne Netz): npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpeningHours, openState } from '../../js/openingHours.js';
import { computeStats, formatKm, formatM, formatInt, formatNumber, formatClock, formatWeekday, formatDayDate, formatDate, estimateTime, averageSpeed } from '../../js/utils.js';
import { tileKey, isTileKey, cellOfTile, isLayer, LAYERS, layerOfType, toPoi } from '../../js/poiSource.js';
import { headwind } from '../../js/weather.js';
import { findClimbs, gradeSegments } from '../../js/climbs.js';
import { timeline } from '../../js/timeline.js';
import { sunTimes, darkMs, daylightNote } from '../../js/sun.js';
import { groupNear } from '../../js/cluster.js';
import { stageTargets, shelterAllowed, mergeShelters, estimatePrice, priceLabel, priceLink, shelterBooking } from '../../js/stays.js';
import { generateLoop } from '../../js/generators.js';
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

test('Gemerkte Formatierer geben dasselbe aus wie toLocaleString', () => {
  for (const m of [0, 49, 950, 12345, 99999, 100000, 123456, 2345678]) {
    assert.equal(formatKm(m), (m / 1000).toLocaleString('de-DE', { maximumFractionDigits: m < 100000 ? 1 : 0 }) + ' km');
    assert.equal(formatM(m), Math.round(m).toLocaleString('de-DE') + ' m');
    assert.equal(formatInt(m), m.toLocaleString('de-DE'));
  }
  assert.equal(formatNumber(0.25, { maximumFractionDigits: 2 }), '0,25');
  assert.equal(formatNumber(1.5, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), '1,5');
  // Ein Jahr lang alle 7 h 13 min: Wochentage, Monatswechsel, Zeitumstellung
  for (let t = new Date(2026, 0, 1).getTime(); t < new Date(2027, 0, 1).getTime(); t += 26_000_000) {
    const d = new Date(t);
    assert.equal(formatClock(d), d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
    assert.equal(formatWeekday(d), d.toLocaleDateString('de-DE', { weekday: 'short' }));
    assert.equal(formatDayDate(d), d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }));
    assert.equal(formatDate(d), d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }));
  }
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

test('Sonne: Fahrt über Nacht – Dunkelzeit summiert, nie länger als die Fahrt, Ankunftstag genannt', () => {
  const bremen = [53.08, 8.8], bonn = [50.74, 7.1];
  // Fr 20.11.2026 12:45 → So 22.11. 03:41 (wie bei Bremen → Bonn an einem Stück)
  const start = new Date(2026, 10, 20, 12, 45), end = new Date(2026, 10, 22, 3, 41);
  const hours = darkMs(start, end, bremen, bonn) / 3.6e6;
  const total = (end.getTime() - start.getTime()) / 3.6e6;
  assert.ok(hours < total, `${hours} h dunkel bei ${total} h Fahrt`);
  // Zwei Nächte im November: Fr ~16:40 bis Sa ~08:00 und Sa ~16:40 bis So 03:41 → gut 26 h
  assert.ok(hours > 24 && hours < 28, `${hours} h`);
  const note = daylightNote({ start, end }, bremen, bonn);
  assert.ok(note.warn && note.overnight, JSON.stringify(note));
  assert.match(note.text, /^Ankunft erst So\.? ca\. 03:41 – die Fahrt geht über Nacht, etwa 2\d h \d\d min davon im Dunkeln\.$/);
  // Am selben Tag bleibt der bisherige Hinweis
  const day = daylightNote({ start: new Date(2026, 10, 20, 9), end: new Date(2026, 10, 20, 14) }, bremen, bremen);
  assert.ok(!day.overnight && !day.warn && day.text.startsWith('Tageslicht '), day.text);
});

test('Marker zusammenfassen: nahe Punkte in eine Gruppe, offene Popups und Radius 0 einzeln', () => {
  const pts = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 20, y: 0 }, { id: 'c', x: 100, y: 0 }, { id: 'd', x: 10, y: 10 }];
  const ids = groups => groups.map(g => g.map(p => p.id).join(''));
  assert.deepEqual(ids(groupNear(pts, p => p, 34)), ['abd', 'c']);
  assert.deepEqual(ids(groupNear(pts, p => p, 34, p => p.id === 'b')), ['ad', 'b', 'c']);
  assert.deepEqual(ids(groupNear(pts, p => p, 0)), ['a', 'b', 'c', 'd']);
});

test('Gemeinsame Werte von Browser und Server', () => {
  assert.deepEqual(MODES, ['ab', 'distance', 'loop']);
  assert.deepEqual(BIKES, ['road', 'gravel', 'trekking', 'ebike']);
  // Der ORS-Key bleibt im Browser (CLAUDE.md): Er darf nie abgeglichen werden
  assert.ok(!SYNC_KEYS.some(k => /ors|key/i.test(k)), SYNC_KEYS.join(', '));
});

test('Mehrtagestour: angepasste Tageslängen, der Rest verteilt sich gleichmäßig', () => {
  const km = r => ({ days: r.days, len: r.lengths.map(l => Math.round(l / 100) / 10), fixed: r.fixed, o: r.overrides });
  // ohne Anpassung wie bisher: gleich lange Tage, mindestens zwei
  assert.deepEqual(km(stageTargets(250_000, 100)), { days: 3, len: [83.3, 83.3, 83.3], fixed: [false, false, false], o: [] });
  assert.equal(stageTargets(80_000, 100).days, 2);
  // Tag 1 kürzer: die übrigen teilen sich den Rest
  assert.deepEqual(km(stageTargets(250_000, 100, [60])), { days: 3, len: [60, 95, 95], fixed: [true, false, false], o: [60] });
  // Rest länger als km pro Tag → ein Tag mehr
  assert.deepEqual(km(stageTargets(250_000, 100, [30])).len, [30, 73.3, 73.3, 73.3]);
  // ein angepasster Tag in der Mitte
  assert.deepEqual(km(stageTargets(250_000, 100, [null, 60])).len, [95, 60, 95]);
  // Tag länger, Rest passt in einen Tag → ein Tag weniger
  assert.deepEqual(km(stageTargets(250_000, 100, [150])), { days: 2, len: [150, 100], fixed: [true, false], o: [150] });
  // Ziele je Nacht: aufsummierte Längen
  assert.deepEqual(stageTargets(250_000, 100, [60]).targets, [60_000, 155_000]);
  // Anpassung auf dem letzten Tag (der Rest) fällt weg
  assert.deepEqual(km(stageTargets(250_000, 100, [null, null, 50])).o, []);
  // ließe sie weniger als 5 km übrig, fällt die letzte Anpassung weg
  assert.deepEqual(km(stageTargets(250_000, 100, [150, 98])), { days: 2, len: [150, 100], fixed: [true, false], o: [150] });
  // Unsinnige Werte zählen als frei
  assert.deepEqual(stageTargets(250_000, 100, [NaN, -5, 0]).overrides, []);
});

test('Rundkurs nach Fahrzeit: Länge passt sich der Wunschzeit an, Anstiege verkürzen sie', async () => {
  // Attrappe mit roundTrip: Strecke nach Norden, Länge = gewünschte Länge × 1,1, auf jeden km 10 m Anstieg
  const fake = {
    roundTrip: async (start, length) => {
      const n = 40, coords = [];
      for (let i = 0; i <= n; i++) coords.push([start.lat + (length * 1.1 / 111_195) * i / n, start.lon, (i % 2) * length * 1.1 / n / 100]);
      return { coords, segments: [] };
    },
  };
  const base = { provider: fake, start: { lat: 50, lon: 7 }, bearing: 0, seed: 1, opts: {}, signal: new AbortController().signal };
  const byTime = await generateLoop({ ...base, distance: 0, duration: 2 * 3600, bike: 'trekking' });
  const time = estimateTime(byTime.distance, byTime.ascent, 'trekking');
  assert.ok(Math.abs(time - 7200) / 7200 <= 0.06, `${Math.round(time / 60)} min statt 120`);
  // ohne Anstiege wäre es mehr Strecke: die Fahrzeit enthält die Anstiege
  assert.ok(byTime.distance < 2 * averageSpeed('trekking') * 1000, `${Math.round(byTime.distance)} m`);
  // nach Länge wie bisher
  const byLength = await generateLoop({ ...base, distance: 40_000 });
  assert.ok(Math.abs(byLength.distance - 40_000) / 40_000 <= 0.06, `${Math.round(byLength.distance)} m`);
});

test('Shelter: nur in Dänemark, Schweden und Norwegen; Plätze zusammengefasst; Preis und Buchung aus OSM', () => {
  const inside = { Kopenhagen: [55.68, 12.57], Odense: [55.40, 10.39], Skagen: [57.72, 10.58], Rønne: [55.10, 14.70], Gedser: [54.575, 11.93],
    Padborg: [54.83, 9.36], Tønder: [54.94, 8.87], Rømø: [55.15, 8.52], Stockholm: [59.33, 18.07], Malmö: [55.60, 13.0], Visby: [57.64, 18.29],
    Kiruna: [67.86, 20.23], Haparanda: [65.83, 24.12], Oslo: [59.91, 10.75], Bergen: [60.39, 5.32], Tromsø: [69.65, 18.96], Kirkenes: [69.73, 30.05] };
  const outside = { Flensburg: [54.78, 9.43], Sylt: [54.90, 8.31], Fehmarn: [54.47, 11.15], Rügen: [54.55, 13.40], Kiel: [54.32, 10.13],
    Danzig: [54.35, 18.65], Helsinki: [60.17, 24.94], Mariehamn: [60.10, 19.94], Tornio: [65.85, 24.18], Vaasa: [63.1, 21.6], Utsjoki: [69.9, 27.03] };
  for (const [name, [lat, lon]] of Object.entries(inside)) assert.ok(shelterAllowed(lat, lon), name);
  for (const [name, [lat, lon]] of Object.entries(outside)) assert.ok(!shelterAllowed(lat, lon), name);

  // Drei Halbhütten an einem Platz (je ~50 m auseinander) zählen einmal; der Name kommt vom benannten Eintrag
  const sh = (id, lat, name, tags = {}) => ({ id, type: 'shelter', lat, lon: 10, name, tags: { ...(name && { name }), ...tags } });
  const merged = mergeShelters([sh('n/1', 56.0, ''), sh('n/2', 56.0005, 'Shelter i Alken', { website: 'https://udinaturen.dk/shelter/1' }),
    sh('n/3', 56.001, ''), sh('n/4', 56.1, 'Anderswo'), { id: 'n/5', type: 'hotel', lat: 56.0, lon: 10, name: 'Hotel', tags: {} }]);
  assert.deepEqual(merged.map(p => [p.name, p.count ?? null]), [['Shelter i Alken', 3], ['Anderswo', 1], ['Hotel', null]]);
  assert.equal(merged[0].tags.website, 'https://udinaturen.dk/shelter/1');

  assert.equal(priceLabel(estimatePrice({ type: 'shelter', tags: { fee: 'no' } })), 'kostenlos (laut OSM)');
  assert.equal(priceLabel(estimatePrice({ type: 'shelter', tags: {} })), 'ca. 0–10 €');
  assert.equal(priceLink({ type: 'shelter', name: '', tags: { website: 'https://udinaturen.dk/shelter/4819' } }, null), 'https://udinaturen.dk/shelter/4819');
  assert.equal(priceLink({ type: 'shelter', name: '', tags: {} }, null), null);
  assert.equal(shelterBooking({ tags: { reservation: 'required' } }), 'Buchung erforderlich');
  assert.equal(shelterBooking({ tags: { reservation: 'no' } }), 'ohne Buchung (wer zuerst kommt)');
  // Dagshelter und Bushaltestellen sind keine Unterkunft
  const stay = tags => toPoi({ id: 'node/1', lat: 56, lon: 10, tags }, 'stay')?.type ?? null;
  assert.equal(stay({ amenity: 'shelter', shelter_type: 'lean_to' }), 'shelter');
  assert.equal(stay({ amenity: 'shelter', shelter_type: 'lean_to', name: 'Dagshelter i Hørhaven' }), null);
  assert.equal(stay({ amenity: 'shelter', shelter_type: 'public_transport' }), null);
  assert.equal(stay({ amenity: 'shelter', shelter_type: 'lean_to', access: 'private' }), null);
});
