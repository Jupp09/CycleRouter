// Browsertests: npm test [-- name …] [--shots] [--headed]
//
// Startet einen eigenen Testserver (Port 8765, ohne Datenbank, ohne Datenauszug-Download), dazu Edge/Chrome
// headless, und führt die Tests tests/*.test.mjs nacheinander aus. Mit Namen nur diese (z. B. `keyboard a11y`).
// --shots speichert Screenshots in tests/out/, --headed zeigt das Browserfenster.
//
// Die Tests nutzen die echten Dienste (BRouter, Photon, Nominatim, Kartenkacheln) – sie brauchen Internet,
// dauern ein paar Minuten und können scheitern, wenn brouter.de ausgelastet ist.
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { launchBrowser, sleep } from './lib/browser.mjs';
import { createAccountStore } from './lib/fakeAccount.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(DIR, '..');
const OUT = join(DIR, 'out');
const PORT = Number(process.env.TEST_PORT) || 8765;
const APP = `http://localhost:${PORT}/`;

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

if (await fetch(APP).then(() => true, () => false)) {
  console.error(`Port ${PORT} ist schon belegt – läuft noch ein Server? (anderer Port: TEST_PORT=…)`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const serverLog = createWriteStream(join(OUT, 'server.log'));
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  // Gesetzte Variablen gehen vor .env (server/env.mjs): keine Verbindung zur echten Datenbank,
  // kein Download des Datenauszugs. Konten kommen aus lib/fakeAccount.mjs.
  env: { ...process.env, PORT: String(PORT), DB_HOST: '', POI_EXTRACT_URL: 'off' },
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

const browser = await launchBrowser({ headless: !flags.has('--headed') });
const cleanup = async () => { await browser.close(); server.kill(); };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// ---------- Tests ----------

const results = [];
for (const file of files) {
  const name = file.replace('.test.mjs', '');
  const mod = await import(pathToFileURL(join(DIR, file)));
  console.log(`\n=== ${name}${mod.title ? ` – ${mod.title}` : ''}`);
  let failed = 0, passed = 0;
  const pages = [];
  const accounts = createAccountStore();
  const t = {
    app: APP,
    sleep,
    /** Neue Seite (eigener Browser-Kontext). `accounts: true` → Konto-API aus dem gemeinsamen Speicher dieses Tests. */
    async page({ accounts: withAccounts = false, ...opts } = {}) {
      const p = await browser.newPage({ ...opts, shotDir: flags.has('--shots') ? join(OUT, name) : null });
      if (withAccounts) await accounts.attach(p);
      pages.push(p);
      return p;
    },
    check(label, cond, extra = '') {
      if (cond) passed++; else failed++;
      console.log(`${cond ? 'OK  ' : 'FEHL'} ${label}${extra !== '' && extra != null ? ' – ' + extra : ''}`);
      return !!cond;
    },
    step: title => console.log(`— ${title}`),
  };
  const t0 = Date.now();
  try {
    await mod.default(t);
  } catch (e) {
    failed++;
    console.log(`FEHL Abbruch: ${e.stack || e}`);
  }
  for (const p of pages) t.check('Keine JS-Fehler', !p.errors.length, p.errors.join(' | ').slice(0, 500));
  results.push({ name, passed, failed, s: Math.round((Date.now() - t0) / 1000) });
}

await cleanup();

console.log('\n=== Ergebnis');
for (const r of results) console.log(`${r.failed ? 'FEHL' : 'OK  '} ${r.name.padEnd(10)} ${r.passed} OK, ${r.failed} fehlgeschlagen (${r.s} s)`);
const failedTotal = results.reduce((n, r) => n + r.failed, 0);
console.log(failedTotal ? `\n${failedTotal} Prüfungen fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(failedTotal ? 1 : 0);
