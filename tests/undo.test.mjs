// Rückgängig und Wiederholen (js/app/history.js): Der vorige Stand kommt exakt zurück – dieselbe Route als
// Objekt, ohne neue Routing-Anfrage –, per Knopf und per Strg+Z; „Löschen“ und „Neu würfeln“ lassen sich
// zurücknehmen; in Eingabefeldern greift das Tastenkürzel nicht.
import { STATE, BONN, HAS_ROUTE, IDLE } from './lib/app.mjs';

export const title = 'Rückgängig und Wiederholen';

const BUTTONS = `(() => { const u = document.querySelector('#btn-undo'), r = document.querySelector('#btn-redo');
  return (u.disabled ? '-' : u.title) + ' | ' + (r.disabled ? '-' : r.title); })()`;
/** Stand der App; `window.__keep` hält Routen-Objekte zum Vergleich fest. */
const NOW = `(async () => { const s = ${STATE}; window.__keep ??= {};
  return { route: Object.keys(window.__keep).find(k => window.__keep[k] === s.route) || (s.route ? 'andere' : 'keine'),
    vias: s.vias.length, manual: document.querySelectorAll('.via-pin').length,
    start: document.querySelector('#start-input').value, end: document.querySelector('#end-input').value,
    requests: performance.getEntriesByType('resource').filter(e => e.name.includes('brouter.de')).length,
    status: document.querySelector('#status').textContent, results: !document.querySelector('#results').hidden }; })()`;
const keep = name => `(async () => { window.__keep ??= {}; window.__keep[${JSON.stringify(name)}] = ${STATE}.route; return true; })()`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  const page = await newPage({ height: 950 });
  /** Strg+Z bzw. Strg+Umschalt+Z als echte Tastendrücke (CDP: Strg = 2, Umschalt = 8). */
  const ctrlZ = async (shift = false) => {
    const base = { key: shift ? 'Z' : 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: shift ? 10 : 2 };
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(300);
  };
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });

  step('Anfang');
  check('Beide Knöpfe gesperrt', await page.ev(BUTTONS) === '- | -', await page.ev(BUTTONS));

  step('Route und Zwischenstopp');
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  await page.ev(keep('A'));
  check('„Rückgängig“ nennt den letzten Schritt', await page.ev(BUTTONS) === 'Rückgängig: Ziel gesetzt | -', await page.ev(BUTTONS));
  await page.clickMap(50.83, 6.93); await sleep(800);
  check('Mit Zwischenstopp neu berechnet', await page.waitFor(`document.querySelectorAll('.via-pin').length === 1 && ${HAS_ROUTE} && ${IDLE}`, 120000));
  await page.ev(keep('B'));
  const withVia = await page.ev(NOW);

  step('Rückgängig per Knopf');
  await page.ev(`document.querySelector('#btn-undo').click(); true`); await sleep(500);
  let now = await page.ev(NOW);
  check('Dieselbe Route wie vorher, Zwischenstopp weg', now.route === 'A' && now.vias === 0 && now.manual === 0, JSON.stringify(now));
  check('Keine neue Routing-Anfrage', now.requests === withVia.requests, `${withVia.requests} → ${now.requests}`);
  check('Meldung', now.status === 'Rückgängig: Zwischenstopp hinzugefügt', now.status);
  check('Knöpfe: nächster Schritt und Wiederholen', await page.ev(BUTTONS) === 'Rückgängig: Ziel gesetzt | Wiederholen: Zwischenstopp hinzugefügt', await page.ev(BUTTONS));

  step('Wiederholen');
  await page.ev(`document.querySelector('#btn-redo').click(); true`); await sleep(500);
  now = await page.ev(NOW);
  check('Route mit Zwischenstopp ist wieder da', now.route === 'B' && now.vias === 1 && now.manual === 1 && now.requests === withVia.requests, JSON.stringify(now));
  check('Meldung', now.status === 'Wiederholt: Zwischenstopp hinzugefügt', now.status);

  step('„Löschen“ und Strg+Z');
  await page.ev(`document.querySelector('#btn-clear').click(); true`); await sleep(500);
  now = await page.ev(NOW);
  check('Gelöscht', now.route === 'keine' && !now.results && now.end === '', JSON.stringify(now));
  await page.ev(`document.querySelector('#btn-undo').focus(); true`);
  await ctrlZ();
  now = await page.ev(NOW);
  check('Strg+Z holt Route, Ziel und Zwischenstopp zurück', now.route === 'B' && now.results && now.end === withVia.end && now.vias === 1
    && now.requests === withVia.requests, JSON.stringify(now));
  await ctrlZ(true);
  check('Strg+Umschalt+Z löscht wieder', (await page.ev(NOW)).route === 'keine');
  await ctrlZ();
  check('und wieder zurück', (await page.ev(NOW)).route === 'B');

  step('Im Eingabefeld bleibt Strg+Z beim Text');
  const before = await page.ev(BUTTONS);
  await page.ev(`document.querySelector('#start-input').focus(); true`);
  await ctrlZ();
  now = await page.ev(NOW);
  check('Kein Schritt zurückgenommen', now.route === 'B' && await page.ev(BUTTONS) === before, await page.ev(BUTTONS));

  step('Neue Änderung verwirft „Wiederholen“');
  await page.ev(`document.querySelector('#btn-undo').click(); true`); await sleep(500); // Zwischenstopp wieder weg
  check('Wiederholen möglich', (await page.ev(BUTTONS)).endsWith('| Wiederholen: Zwischenstopp hinzugefügt'), await page.ev(BUTTONS));
  await page.clickMap(50.80, 6.96); await sleep(800);
  await page.waitFor(`document.querySelectorAll('.via-pin').length === 1 && ${HAS_ROUTE} && ${IDLE}`, 120000);
  check('Wiederholen gesperrt', (await page.ev(BUTTONS)).endsWith('| -'), await page.ev(BUTTONS));
  await page.shot('1-rueckgaengig');

  step('„Neu würfeln“ zurücknehmen');
  await page.ev(`document.querySelector('#mode-tabs [data-mode=loop]').click(); true`); await sleep(500);
  await page.ev(`{ const n = document.querySelector('#distance-num'); n.value = 20; n.dispatchEvent(new Event('change')); document.querySelector('#btn-generate').click(); } true`);
  await sleep(1000);
  check('Rundkurs erzeugt', await page.waitFor(`${HAS_ROUTE} && ${IDLE} && document.querySelector('#route-name').value.startsWith('Rundkurs')`, 120000));
  await page.ev(keep('L1'));
  const seed = await page.ev(`(async () => ${STATE}.seed)()`);
  await page.ev(`document.querySelector('#btn-reroll').click(); true`);
  await sleep(1500);
  check('Neue Variante', await page.waitFor(`(async () => ${STATE}.route && ${STATE}.route !== window.__keep.L1 && ${IDLE})()`, 120000));
  const rolled = await page.ev(NOW);
  await page.ev(`document.querySelector('#btn-undo').click(); true`); await sleep(500);
  now = await page.ev(NOW);
  check('Vorige Variante ist zurück, ohne neue Anfrage', now.route === 'L1' && now.requests === rolled.requests && now.status === 'Rückgängig: Neu gewürfelt', JSON.stringify(now));
  check('Auch die Würfel-Saat ist die alte', await page.ev(`(async () => ${STATE}.seed)()`) === seed);
}
