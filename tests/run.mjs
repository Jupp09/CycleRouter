// Browsertests: npm test [-- name …] [--shots] [--headed]
//
// Startet einen eigenen Testserver (Port 8765, ohne Datenbank, ohne Datenauszug-Download), dazu Edge/Chrome
// headless, und führt die Tests tests/*.test.mjs nacheinander aus. Mit Namen nur diese (z. B. `keyboard a11y`).
// --shots speichert Screenshots in tests/out/, --headed zeigt das Browserfenster. Nach jedem Lauf stehen in
// tests/out/bericht.html die Ergebnisse grafisch (mit Screenshots und dem Verlauf der letzten Läufe, verlauf.json).
//
// Die Tests nutzen die echten Dienste (BRouter, Photon, Nominatim, Kartenkacheln) – sie brauchen Internet,
// dauern ein paar Minuten und können scheitern, wenn brouter.de ausgelastet ist.
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { launchBrowser, sleep } from './lib/browser.mjs';
import { createAccountStore } from './lib/fakeAccount.mjs';
import { writeReport, appendHistory } from './lib/report.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(DIR, '..');
const OUT = join(DIR, 'out');
const PORT = Number(process.env.TEST_PORT) || 8765;
// TEST_URL=https://cyclorouter.de/ prüft eine laufende Instanz statt eines eigenen Testservers. Konten kommen
// auch dann aus der Attrappe (die echte Datenbank bleibt unberührt); Tests, die den Testserver voraussetzen
// (z. B. brouter ohne BROUTER_URL), können dort abweichen.
const REMOTE = process.env.TEST_URL ? new URL(process.env.TEST_URL).href : null;
const APP = REMOTE ?? `http://localhost:${PORT}/`;

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const names = args.filter(a => !a.startsWith('--'));
const files = readdirSync(DIR).filter(f => f.endsWith('.test.mjs')).sort()
  .filter(f => !names.length || names.includes(f.replace('.test.mjs', '')));
if (!files.length) {
  console.error(`Keine Tests gefunden für: ${names.join(', ')}`);
  process.exit(2);
}

// ---------- Testserver ----------

mkdirSync(OUT, { recursive: true });
let server = null;
if (REMOTE) {
  if (!(await fetch(APP).then(r => r.ok, () => false))) {
    console.error(`${APP} antwortet nicht`);
    process.exit(2);
  }
  console.log(`Prüfe ${APP} (kein eigener Testserver)`);
} else {
  if (await fetch(APP).then(() => true, () => false)) {
    console.error(`Port ${PORT} ist schon belegt – läuft noch ein Server? (anderer Port: TEST_PORT=…)`);
    process.exit(2);
  }
  const serverLog = createWriteStream(join(OUT, 'server.log'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    // Gesetzte Variablen gehen vor .env (server/env.mjs): keine Verbindung zur echten Datenbank,
    // kein Download des Datenauszugs. Eigener BRouter nur mit TEST_BROUTER_URL (sonst gehen die Anfragen an
    // brouter.de, wie die meisten Tests es erwarten; brouter.test.mjs prüft beide Fälle).
    // Konten kommen aus lib/fakeAccount.mjs.
    env: { ...process.env, PORT: String(PORT), DB_HOST: '', POI_EXTRACT_URL: 'off', BROUTER_URL: process.env.TEST_BROUTER_URL ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  let up = false;
  for (let i = 0; i < 60 && !up && server.exitCode === null; i++) {
    up = await fetch(APP).then(r => r.ok, () => false);
    if (!up) await sleep(250);
  }
  if (!up) {
    console.error('Testserver startet nicht – siehe tests/out/server.log');
    server.kill();
    process.exit(2);
  }
}

const browser = await launchBrowser({ headless: !flags.has('--headed') });
const cleanup = async () => { await browser.close(); server?.kill(); };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// ---------- Tests ----------

const results = [];
const startedAt = Date.now();
for (const file of files) {
  const name = file.replace('.test.mjs', '');
  const mod = await import(pathToFileURL(join(DIR, file)));
  console.log(`\n=== ${name}${mod.title ? ` – ${mod.title}` : ''}`);
  let failed = 0, passed = 0;
  const pages = [];
  const accounts = createAccountStore();
  // Für den Bericht: Schritte mit ihren Prüfungen und Screenshots (Pfade relativ zu tests/out/)
  const steps = [{ title: '', checks: [], shots: [] }];
  const current = () => steps[steps.length - 1];
  const t = {
    app: APP,
    sleep,
    /** Speicher der Konto-Attrappe dieses Tests (z. B. `accounts.feedback`: angenommene Rückmeldungen). */
    accounts,
    /** Neue Seite (eigener Browser-Kontext). `accounts: true` → Konto-API aus dem gemeinsamen Speicher dieses Tests. */
    async page({ accounts: withAccounts = false, ...opts } = {}) {
      const shots = flags.has('--shots');
      const p = await browser.newPage({ ...opts, shotDir: shots ? join(OUT, name) : null });
      if (shots) {
        const shot = p.shot;
        p.shot = async n => { await shot(n); current().shots.push(`${name}/${n}.png`); };
      }
      if (withAccounts) await accounts.attach(p);
      pages.push(p);
      return p;
    },
    check(label, cond, extra = '') {
      if (cond) passed++; else failed++;
      const detail = extra !== '' && extra != null ? String(extra) : '';
      console.log(`${cond ? 'OK  ' : 'FEHL'} ${label}${detail ? ' – ' + detail : ''}`);
      current().checks.push({ label, ok: !!cond, detail: detail.slice(0, 600) });
      return !!cond;
    },
    step: title => { console.log(`— ${title}`); steps.push({ title, checks: [], shots: [] }); },
  };
  const t0 = Date.now();
  try {
    await mod.default(t);
  } catch (e) {
    failed++;
    console.log(`FEHL Abbruch: ${e.stack || e}`);
  }
  steps.push({ title: 'Zum Schluss', checks: [], shots: [] });
  for (const p of pages) t.check('Keine JS-Fehler', !p.errors.length, p.errors.join(' | ').slice(0, 500));
  results.push({ name, title: mod.title || '', passed, failed, s: Math.round((Date.now() - t0) / 1000),
    steps: steps.filter(st => st.checks.length || st.shots.length) });
}

await cleanup();

// Bericht und Verlauf (tests/out/bericht.html, verlauf.json) – ein Fehler dabei soll den Testlauf nicht verfälschen
try {
  const run = { at: new Date(startedAt).toISOString(), s: Math.round((Date.now() - startedAt) / 1000), args, results };
  const file = writeReport(OUT, run, appendHistory(OUT, run));
  console.log(`\nBericht: ${pathToFileURL(file).href}`);
} catch (e) {
  console.log(`\nBericht konnte nicht geschrieben werden: ${e.message}`);
}

console.log('\n=== Ergebnis');
for (const r of results) console.log(`${r.failed ? 'FEHL' : 'OK  '} ${r.name.padEnd(10)} ${r.passed} OK, ${r.failed} fehlgeschlagen (${r.s} s)`);
const failedTotal = results.reduce((n, r) => n + r.failed, 0);
console.log(failedTotal ? `\n${failedTotal} Prüfungen fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(failedTotal ? 1 : 0);
