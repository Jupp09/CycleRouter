// Barrierefreiheit: axe-core in mehreren Zuständen der App, hell und dunkel – Ziel sind 0 Verstöße.
// axe-core kommt von cdnjs (keine Abhängigkeit im Projekt).
import { BONN, HAS_ROUTE, register, saveRoute } from './lib/app.mjs';

export const title = 'axe-core hell und dunkel';

const AXE = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';

export default async function (t) {
  const axe = await (await fetch(AXE)).text();
  for (const scheme of ['light', 'dark']) await audit(t, axe, scheme);
}

async function audit({ app, page: newPage, check, step, sleep }, axe, scheme) {
  const label = scheme === 'dark' ? 'dunkel' : 'hell';
  step(`Farbschema ${label}`);
  const page = await newPage({ accounts: true, height: 950, scheme });
  const { ev, waitFor } = page;
  const run = async state => {
    await ev(axe + '; true');
    const res = await ev(`axe.run(document, { resultTypes: ['violations'] }).then(r => r.violations.map(v =>
      '[' + v.impact + '] ' + v.id + ' (' + v.nodes.length + '×): ' + v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', ')))`);
    check(`${state} (${label}): 0 Verstöße`, Array.isArray(res) && !res.length, Array.isArray(res) ? res.join(' | ') : res);
  };

  await page.open(app, { view: BONN, storage: { bike: 'trekking', supplyEnabled: true } });
  await sleep(500);
  await run('Start');

  await page.clickMap(50.90, 6.97); await sleep(800);
  await page.clickMap(50.76, 7.07);
  await waitFor(HAS_ROUTE);
  await waitFor(`!document.querySelector('#stops').hidden`, 120000);
  await ev(`[...document.querySelectorAll('#along-chips button')].find(b => b.textContent.includes('Café')).click(); true`);
  await waitFor(`document.querySelectorAll('#along-list li').length > 0`, 60000);
  await sleep(1500);
  await run('Route mit Ergebnis, Stopps, Café-Suche');

  await ev(`document.querySelector('#btn-settings').click(); true`); await sleep(400);
  await run('Einstellungsdialog');

  check('Konto angelegt', await register(page, `a11y_${scheme}`));
  await ev(`document.querySelector('#settings-dialog').close('cancel'); true`); await sleep(400);
  check('Gespeichert', await saveRoute(page));
  await ev(`document.querySelector('#my-routes').open = true; true`); await sleep(300);
  await run('Angemeldet mit Meine Routen');
  await page.shot(`a11y-${scheme}`);
}
