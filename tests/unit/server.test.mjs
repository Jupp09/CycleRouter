// Unit-Tests der Server-Module (ohne Datenbank, ohne Netz): npm run test:unit
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { limitKey, clientIp, passwordProblem, validateCredentials, hashPassword, verifyPassword, needsRehash } from '../../server/auth.mjs';
import { createLimiter } from '../../server/rateLimit.mjs';
import { browserOf } from '../../server/clientErrors.mjs';
import { scrub } from '../../js/shared.js';
import { upstreamQuery } from '../../server/brouterProxy.mjs';
import { cleanRoute, cleanSettings } from '../../server/accountApi.mjs';
import { contentSecurityPolicy } from '../../server/security.mjs';
import { moduleGraph } from '../../server/static.mjs';
import { lines } from '../../server/lines.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('Begrenzungsschlüssel: IPv6 je /64-Netz, IPv4 unverändert', () => {
  assert.equal(limitKey('1.2.3.4'), '1.2.3.4');
  assert.equal(limitKey('::ffff:1.2.3.4'), '1.2.3.4');
  // Zwei Adressen desselben Anschlusses teilen sich einen Zähler
  assert.equal(limitKey('2a03:4000:6d:3710::25:3478'), limitKey('2a03:4000:6d:3710:ffff:1:2:3'));
  assert.notEqual(limitKey('2a03:4000:6d:3710::1'), limitKey('2a03:4000:6d:3711::1'));
  assert.equal(limitKey('2001:DB8:0:0:1::'), limitKey('2001:db8::'));
  assert.equal(limitKey('kein-ip'), 'kein-ip');
});

test('Nutzer-IP: Proxy-Header nur von internen Verbindungen', () => {
  const xff = { 'x-forwarded-for': '6.6.6.6, 9.9.9.9' };
  // Von außen: Header ignorieren (könnte jeder setzen)
  assert.equal(clientIp(req('8.8.8.8', xff)), '8.8.8.8');
  // Über den eigenen Proxy: rechteste externe Adresse (die linke kann der Client vorgeben)
  assert.equal(clientIp(req('127.0.0.1', xff)), '9.9.9.9');
  assert.equal(clientIp(req('127.0.0.1', { 'x-forwarded-for': '2a03:4000:6d:3710::abcd' })), '2a03:4000:6d:3710::/64');
});

test('Begrenzer: gleitendes Fenster mit Gewichten', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const limiter = createLimiter({ windowMs: 60_000, max: 10 });
    limiter.add('a', 7);
    assert.ok(limiter.fits('a', 3) && !limiter.fits('a', 4));
    limiter.add('a', 3);
    assert.ok(limiter.reached('a'));
    assert.ok(!limiter.reached('b'), 'andere Schlüssel unberührt');
    mock.timers.tick(60_000);
    assert.equal(limiter.used('a'), 0, 'nach Ablauf des Fensters wieder frei');
  } finally {
    mock.timers.reset();
  }
});

test('Passwortregeln', () => {
  assert.match(passwordProblem('kurz'), /mindestens 8/);
  assert.match(passwordProblem('passwort1'), /verbreitet/);
  assert.match(passwordProblem('aaaaaaaaaa'), /verbreitet/);
  assert.match(passwordProblem('meinname-ist-toll', 'MeinName'), /Benutzernamen/);
  assert.equal(passwordProblem('Rad durch die Heide 7'), null);
  assert.match(validateCredentials('a', 'Rad durch die Heide 7', { isNew: true }), /3–40 Zeichen/);
  assert.equal(validateCredentials('jupp_09', 'Rad durch die Heide 7', { isNew: true }), null);
});

test('Passwort-Hash: prüfbar, salzig, und Überlast gibt 503 statt einer endlosen Schlange', async () => {
  const hash = await hashPassword('Rad durch die Heide 7');
  assert.ok(await verifyPassword('Rad durch die Heide 7', hash));
  assert.ok(!await verifyPassword('falsch falsch', hash));
  assert.notEqual(hash, await hashPassword('Rad durch die Heide 7'));
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => hashPassword('x')));
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(results.length - rejected.length, 22, '2 laufen, 20 warten');
  assert.ok(rejected.every(r => r.reason.status === 503));
  assert.ok(await verifyPassword('Rad durch die Heide 7', hash), 'danach wieder normal');
});

test('Passwort-Hash: alte Einstellungen bleiben gültig und werden zum Umstellen erkannt', async () => {
  // So sahen Hashes bis 11/2026 aus: N=2^14, r=8, p=1
  const salt = randomBytes(16);
  const old = scryptSync('Rad durch die Heide 7', salt, 64, { N: 16384, r: 8, p: 1 });
  const stored = ['scrypt', 16384, 8, 1, salt.toString('base64'), old.toString('base64')].join('$');
  assert.ok(await verifyPassword('Rad durch die Heide 7', stored));
  assert.ok(!await verifyPassword('falsch falsch', stored));
  assert.ok(needsRehash(stored));
  const fresh = await hashPassword('Rad durch die Heide 7');
  assert.deepEqual(fresh.split('$').slice(0, 4), ['scrypt', '16384', '8', '5']);
  assert.ok(!needsRehash(fresh));
  assert.ok(needsRehash('bcrypt$irgendwas'));
});

test('Fehlerberichte: keine Orte im Log', () => {
  const text = 'Fehler bei 53.07512,8.80777 in https://cyclorouter.de/#v=1&s=53.07512,8.80777,Bremen und /js/a.js?x=1';
  const out = scrub(text, 500);
  assert.ok(!out.includes('53.075') && !out.includes('Bremen'), out);
  assert.ok(out.includes('https://cyclorouter.de/'), out);
  assert.equal(scrub('a\u0000b\u001b[31mc', 100), 'ab[31mc', 'Steuerzeichen raus (keine gefälschten Log-Zeilen)');
  assert.equal(scrub('x'.repeat(50), 10).length, 10);
  assert.equal(browserOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0'), 'Edge 131, Windows');
  assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1'), 'Safari 18.0, iOS');
});

test('BRouter-Weiterleitung: nur bekannte Parameter, Profilschlüssel unkodiert', () => {
  const q = upstreamQuery(new URLSearchParams('lonlats=8.8,53.07|8.9,53.1&profile=trekking&profile:ebike=1&evil=x&alternativeidx=7'));
  // BRouter ≥ 1.7.11 decodiert nur Werte – ein kodierter Schlüssel (profile%3Aebike) fiele still weg
  assert.ok(q.includes('profile:ebike=1'), q);
  assert.ok(!q.includes('evil'), q);
  assert.ok(q.includes('alternativeidx=0') && q.includes('format=geojson'), q);
  assert.throws(() => upstreamQuery(new URLSearchParams('lonlats=1,2&profile=trekking')), { status: 400 });
  assert.throws(() => upstreamQuery(new URLSearchParams('lonlats=8.8,53.07|8.9,53.1&profile=../x')), { status: 400 });
  assert.throws(() => upstreamQuery(new URLSearchParams('lonlats=8.8,53.07|8.9,53.1&profile=t&profile:a=1%262')), { status: 400 });
});

test('Konto-API: Routen und Einstellungen werden geprüft und gefiltert', () => {
  const data = { coords: [[53, 8.8], [53.1, 8.9]], waypoints: [] };
  const ok = cleanRoute({ name: '  Weserrunde ', mode: 'loop', bike: 'gravel', distance: 41234.6, ascent: 120, data });
  assert.equal(ok.name, 'Weserrunde');
  assert.equal(ok.distance, 41235);
  assert.equal(typeof ok.data, 'string');
  assert.throws(() => cleanRoute({ name: 'x', mode: 'fly', bike: 'road', distance: 1, ascent: 1, data }), { status: 400 });
  assert.throws(() => cleanRoute({ name: 'x', mode: 'ab', bike: 'road', distance: -1, ascent: 1, data }), { status: 400 });
  assert.throws(() => cleanRoute({ name: 'x', mode: 'ab', bike: 'road', distance: 1, ascent: 1, data: { coords: [] } }), { status: 400 });
  assert.deepEqual(Object.keys(cleanRoute({ name: 'Neu' }, true)), ['name'], 'teilweise Änderung');
  const settings = cleanSettings({ bike: 'road', orsKey: 'geheim', irgendwas: 1 });
  assert.ok(!('orsKey' in settings) && !('irgendwas' in settings), JSON.stringify(settings));
});

test('CSP: Inline-Skripte per Hash, CRLF wie LF', () => {
  const html = '<html><script>\r\nconst a = 1;\r\n</script></html>';
  const expected = createHash('sha256').update('\nconst a = 1;\n').digest('base64');
  const csp = contentSecurityPolicy(html, req('127.0.0.1'));
  assert.ok(csp.includes(`'sha256-${expected}'`), csp);
  assert.ok(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"));
  assert.ok(!csp.includes('unsafe-inline'));
});

test('Modulliste für index.html: alle Module ab main.js, Fehlerbericht zuerst geladen', async () => {
  const modules = await moduleGraph(ROOT);
  assert.equal(modules[0], 'js/main.js');
  assert.ok(modules.includes('js/errorReport.js') && modules.includes('js/app/pipeline.js'));
  assert.ok(modules.every(m => m.startsWith('js/') && m.endsWith('.js')));
});

test('lines: trennt nur an "\\n", auch über Blockgrenzen und in Mehrbyte-Zeichen', async () => {
  // U+2028 steht unmaskiert in JSON.stringify-Ausgaben (OSM-Namen) und darf keine Zeile beenden
  const rows = [{ name: 'Piekarnia Krystyna' }, { name: 'Zwycięstwa ' }, { n: 3 }];
  const bytes = Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\r\n');
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 5) chunks.push(bytes.subarray(i, i + 5)); // schneidet auch „ę“ und U+2028
  const out = [];
  for await (const line of lines(chunks)) out.push(line);
  assert.deepEqual(out.map(l => JSON.parse(l)), rows);
  const tail = [];
  for await (const line of lines([Buffer.from('a\nb')])) tail.push(line);
  assert.deepEqual(tail, ['a', 'b']);
});
