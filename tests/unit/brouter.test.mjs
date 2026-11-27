// Angepasste BRouter-Profile (js/routing/brouter.js): Fähren im Gravel-Profil, EuroVelo-Bevorzugung
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profileSource, ownSearch } from '../../js/routing/brouter.js';

const brf = name => readFileSync(new URL(`../../profiles/${name}.brf`, import.meta.url), 'utf8');
const ferryLine = src => src.split('\n').find(l => /highway=\s+switch\s+not\s+route=ferry/.test(l));

test('Gravel: Fähren kosten so viel wie im Trekking-Profil', () => {
  const src = brf('gravel');
  assert.match(ferryLine(src), /10000\s+2\s*$/, 'Ausgangslage: Faktor 2 im Gravel-Profil');
  const out = profileSource(src, 'gravel');
  assert.match(ferryLine(out), /10000\s+5\.67\s*$/);
  assert.equal(out.length, src.length + 3, 'sonst nichts geändert');
});

test('Gravel mit EuroVelo: beide Anpassungen', () => {
  const out = profileSource(brf('gravel'), 'gravel', 3);
  assert.match(ferryLine(out), /5\.67/);
  assert.match(out, /^assign costfactor = multiply costfactor_base/m);
});

test('Andere Profile: Fähren unverändert, ohne EuroVelo gar nicht angepasst', () => {
  for (const name of ['trekking', 'fastbike', 'fastbike-lowtraffic', 'fastbike-verylowtraffic']) {
    assert.equal(profileSource(brf(name), name), brf(name), name);
  }
  assert.match(profileSource(brf('trekking'), 'trekking', 1.5), /^assign costfactor_base/m);
});

test('Unbekannte Gravel-Fassung: Fehler statt stillem Hochladen ohne Korrektur', () => {
  assert.throws(() => profileSource('assign costfactor 1\n', 'gravel'), /Fähren/);
});

test('Eigener Server: lange Teilstücke suchen zielstrebiger, Gravel bleibt bei 2', () => {
  const koeln = { lat: 50.9375, lon: 6.9583 }, koblenz = { lat: 50.3569, lon: 7.5983 }, frankfurt = { lat: 50.1109, lon: 8.6821 };
  assert.deepEqual(ownSearch('trekking', [koeln, koblenz]), { pass1coefficient: 1.2, pass2coefficient: -1 });
  assert.deepEqual(ownSearch('fastbike', [koeln, frankfurt]), { pass1coefficient: 1.4, pass2coefficient: -1 });
  assert.deepEqual(ownSearch('gravel', [koeln, frankfurt]), { pass1coefficient: 2, pass2coefficient: -1 });
  assert.deepEqual(ownSearch('gravel', [koeln, koblenz]), { pass1coefficient: 2, pass2coefficient: -1 });
});
