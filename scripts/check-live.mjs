// Prüft eine laufende Installation von außen – nach jedem Deploy ausführen:
//
//   npm run check:live                       → https://cyclorouter.de
//   npm run check:live -- http://localhost:8000
//
// Geprüft wird, was beim Umzug auf cyclorouter.de schon einmal schiefging: private Dateien (.env!) abrufbar,
// index.html von nginx statt von Node (keine CSP, keine modulepreload-Links), alter Stand nach einem Deploy
// ohne Neustart, doppelter HSTS-Header. Nur lesende Anfragen; die einzige POST-Anfrage mit fremder Herkunft
// muss der Server ablehnen. Exit-Code 1, wenn etwas fehlschlägt.
import { fileURLToPath } from 'node:url';
import { moduleGraph } from '../server/static.mjs';

const BASE = (process.argv[2] || 'https://cyclorouter.de').replace(/\/+$/, '');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEADERS = { 'User-Agent': 'CycloRouter-Deploy-Check/1.0' };
const https = BASE.startsWith('https://');

let failed = 0, warned = 0;
const ok = msg => console.log(`  ✓ ${msg}`);
const fail = msg => { failed++; console.log(`  ✗ ${msg}`); };
const warn = msg => { warned++; console.log(`  ! ${msg}`); };
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad));

async function get(path, init = {}) {
  return fetch(BASE + path, { redirect: 'manual', ...init, headers: { ...HEADERS, ...init.headers }, signal: AbortSignal.timeout(15000) });
}

async function section(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); } catch (e) { fail(`Anfrage fehlgeschlagen: ${e.cause?.code || e.message}`); }
}

console.log(`Prüfe ${BASE}`);

await section('Private Dateien (müssen 403 oder 404 geben)', async () => {
  for (const path of ['/.env', '/.env.example', '/.git/config', '/.htaccess', '/server.mjs', '/server/auth.mjs',
    '/package.json', '/cache/regions.json', '/scripts/check-live.mjs', '/tests/run.mjs', '/CLAUDE.md']) {
    const res = await get(path);
    await res.body?.cancel();
    check([403, 404].includes(res.status), `${path} → ${res.status}`, `${path} ist abrufbar (${res.status})!`);
  }
});

await section('Startseite', async () => {
  const res = await get('/');
  const html = await res.text();
  check(res.status === 200, 'index.html → 200', `index.html → ${res.status}`);
  const csp = res.headers.get('content-security-policy') || '';
  check(csp.includes("default-src 'self'"), 'CSP vorhanden (kommt von Node)',
    'keine CSP – index.html kommt nicht von Node (z. B. nginx liefert die Datei direkt aus)');
  check(csp.includes("worker-src 'self'"), "CSP enthält worker-src 'self'", "CSP ohne worker-src 'self' – App nach dem Update neu starten");
  const preloads = (html.match(/<link rel="modulepreload"/g) || []).length;
  const local = (await moduleGraph(ROOT)).length;
  check(preloads === local, `${preloads} modulepreload-Links, wie lokal`,
    `${preloads} modulepreload-Links, lokal ${local} Module – ${preloads ? 'anderer Stand als hier (Deploy oder Neustart fehlt?)' : 'index.html kommt nicht von Node'}`);
  // Mehrere gleichnamige Header fasst fetch mit „, “ zusammen; im Wert selbst kommt kein Komma vor
  const hsts = res.headers.get('strict-transport-security');
  if (https) {
    if (!hsts) fail('kein HSTS-Header');
    else check(!hsts.includes(','), `ein HSTS-Header (${hsts})`, `mehrere HSTS-Header: ${hsts} – nur der erste gilt; HSTS beim Hoster (Plesk) abschalten`);
  }
  for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy']) {
    check(res.headers.has(h), `${h}: ${res.headers.get(h)}`, `Header ${h} fehlt`);
  }
});

await section('App-Dateien', async () => {
  for (const [path, type] of [['/sw.js', 'javascript'], ['/js/main.js', 'javascript'], ['/manifest.webmanifest', 'manifest'], ['/css/style.css', 'css']]) {
    const res = await get(path);
    await res.body?.cancel();
    const ct = res.headers.get('content-type') || '';
    check(res.status === 200 && ct.includes(type), `${path} → 200 (${ct})`, `${path} → ${res.status} (${ct || 'ohne Typ'})`);
  }
});

await section('Impressum und Datenschutz', async () => {
  for (const path of ['/impressum.html', '/datenschutz.html']) {
    const res = await get(path);
    const html = res.status === 200 ? await res.text() : (await res.body?.cancel(), '');
    if (res.status !== 200) { fail(`${path} → ${res.status} (Deploy oder Freigabe in server.mjs/.htaccess fehlt?)`); continue; }
    // Fehlende Angaben markiert der Server (server/static.mjs fillTemplate)
    const missing = [...html.matchAll(/in der \.env eintragen: (\w+)/g)].map(m => m[1]);
    check(!missing.length, `${path} vollständig`, `${path}: in der .env fehlt ${[...new Set(missing)].join(', ')} (danach App neu starten)`);
  }
});

await section('Schnittstellen', async () => {
  const regions = await get('/api/regions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['5073_710'] }),
  });
  const data = await regions.json().catch(() => null);
  check(regions.status === 200 && data?.regions, '/api/regions antwortet', `/api/regions → ${regions.status}`);

  const account = await get('/api/account');
  const acc = await account.json().catch(() => null);
  if (account.status !== 200 || !acc) fail(`/api/account → ${account.status}`);
  else if (acc.enabled) ok('/api/account: Konten aktiv (Datenbank verbunden)');
  else warn('/api/account: Konten deaktiviert – Datenbank nicht verbunden?');

  const foreign = await get('/api/account/logout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' }, body: '{}',
  });
  await foreign.body?.cancel();
  check(foreign.status === 403,
    `Anfrage fremder Herkunft abgelehnt (${foreign.status})`, `Anfrage fremder Herkunft → ${foreign.status} (erwartet 403)`);

  const report = await get('/api/client-error');
  await report.body?.cancel();
  check(report.status === 405, '/api/client-error vorhanden', `/api/client-error → ${report.status} (alter Server-Stand?)`);
});

if (https) {
  await section('Weiterleitung von http://', async () => {
    const res = await fetch(BASE.replace('https://', 'http://') + '/', { redirect: 'manual', headers: HEADERS, signal: AbortSignal.timeout(15000) });
    await res.body?.cancel();
    const to = res.headers.get('location') || '';
    check([301, 308].includes(res.status) && to.startsWith('https://'), `http:// → ${res.status} ${to}`, `http:// → ${res.status} ${to}`);
  });
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen${warned ? `, ${warned} Hinweis(e)` : ''}.` : `\nAlles in Ordnung${warned ? ` (${warned} Hinweis(e))` : ''}.`);
process.exit(failed ? 1 : 0);
