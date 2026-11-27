// Betriebszahlen für die Statusseite (server/status.mjs): Zusammenfassung, Prüfung der Routenberichte, Sicherung
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeBrouter, summarizeRoutes, cleanRouteStats, noteClientError, noteBrouter, statusReport, registerStatus } from '../../server/status.mjs';

test('summarizeBrouter: je Ergebnis gezählt, Dauer ohne „Warteschlange voll“, nur im Zeitraum', () => {
  const now = 1_000_000_000;
  const list = [
    { t: now - 7200_000, ms: 99_000, outcome: 'ok' },       // vor 2 h – nicht in der letzten Stunde
    { t: now - 60_000, ms: 1000, outcome: 'ok' },
    { t: now - 50_000, ms: 3000, outcome: 'ok' },
    { t: now - 40_000, ms: 180_000, outcome: 'gone' },
    { t: now - 30_000, ms: 1, outcome: 'full' },
  ];
  const s = summarizeBrouter(list, now - 3600_000);
  assert.equal(s.count, 4);
  assert.deepEqual(s.outcomes, { ok: 2, gone: 1, full: 1 });
  assert.equal(s.median, 3000);
  assert.equal(s.max, 180_000);
  assert.deepEqual(summarizeBrouter([], 0), { count: 0, outcomes: {}, median: null, p95: null, max: null });
});

test('summarizeRoutes: Dienste nur bei Erfolg, Fehler je Art', () => {
  const list = [
    { t: 1, ms: 2000, servers: ['own'], error: null },
    { t: 2, ms: 4000, servers: ['own', 'valhalla'], error: null },
    { t: 3, ms: 9000, servers: [], error: 'tooLong' },
  ];
  assert.deepEqual(summarizeRoutes(list, 0), { count: 3, ok: 2, servers: { own: 2, valhalla: 1 }, failed: { tooLong: 1 }, median: 4000 });
});

test('cleanRouteStats: nur bekannte Werte, keine Orte', () => {
  assert.deepEqual(cleanRouteStats({ ms: 1234.6, servers: ['own', 'own', 'evil'], lat: 50.1 }), { ms: 1235, servers: ['own'], error: null });
  assert.deepEqual(cleanRouteStats({ ms: 5, error: 'tooLong' }), { ms: 5, servers: [], error: 'tooLong' });
  assert.equal(cleanRouteStats({ ms: 5, servers: ['evil'] }), null, 'nichts Bekanntes');
  assert.equal(cleanRouteStats({ ms: -1, servers: ['own'] }), null);
  assert.equal(cleanRouteStats(null), null);
  assert.equal(cleanRouteStats({ ms: 1e12, servers: ['own'] }).ms, 30 * 60 * 1000, 'gedeckelt');
});

test('statusReport: Browserfehler zusammengefasst, angemeldete Zustände, Zeiträume', () => {
  const now = Date.now();
  noteClientError({ kind: 'Fehler', message: 'TypeError: x is undefined', where: 'js/app/a.js:1:2', browser: 'Chrome 131, Windows' }, now - 1000);
  noteClientError({ kind: 'Fehler', message: 'TypeError: x is undefined', where: 'js/app/a.js:1:2', browser: 'Safari 18, iOS' }, now);
  noteBrouter(2500, 'ok', now);
  registerStatus('brouter', () => ({ enabled: true, active: 1 }));
  const r = statusReport(now);
  const e = r.clientErrors.find(x => x.message === 'TypeError: x is undefined');
  assert.equal(e.count, 2);
  assert.deepEqual(e.browsers.map(b => b.name).sort(), ['Chrome 131', 'Safari 18']);
  assert.deepEqual(r.brouter, { enabled: true, active: 1 });
  assert.equal(r.brouterStats.hour.outcomes.ok, 1);
  assert.deepEqual(Object.keys(r.brouterStats), ['hour', 'day', 'week']);
  assert.ok(r.server.pid > 0 && r.server.dataSince <= now);
});

test('Sicherung: Datei wird geschrieben und beim Start wieder eingelesen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  const file = join(dir, 'status.json');
  try {
    // Eigener Prozess, damit initStatusStore (Zeitgeber, Signale) diesen Testlauf nicht berührt
    const script = (body) => `import * as s from ${JSON.stringify(new URL('../../server/status.mjs', import.meta.url).href)};\n${body}`;
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, ['--input-type=module', '-e', script(
      `s.initStatusStore(${JSON.stringify(file)}, () => {}); s.noteBrouter(1500, 'gone'); process.emit('SIGTERM');`)]); // emit: unter Windows ruft kill() keine Handler auf
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.brouterLog.length, 1, 'beim Beenden gesichert');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script(
      `s.initStatusStore(${JSON.stringify(file)}, () => {}); console.log(JSON.stringify(s.statusReport().brouterStats.week)); process.exit(0);`)]);
    assert.deepEqual(JSON.parse(String(out)).outcomes, { gone: 1 }, 'nach dem Neustart wieder da');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
