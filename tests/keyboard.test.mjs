// Tastatur und Screenreader: Umschalter, Ortssuche (Combobox), Ansagen, Listenzeilen, Marker, Sprunglink,
// Fokusrahmen, „Meine Routen“ per Tastatur.
import { BONN, register, saveRoute } from './lib/app.mjs';

export const title = 'Tastatur und Screenreader';

export default async function ({ app, page: newPage, check, step, sleep }) {
  const page = await newPage({ accounts: true, height: 950 });
  const { ev, waitFor } = page;
  const focused = () => ev(`(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) + '|' + (a.getAttribute('aria-label') || a.textContent.trim().slice(0, 40)) : ''; })()`);
  const spoken = () => ev(`[...document.querySelectorAll('body > .sr-only')].map(e => e.textContent).filter(Boolean).join(' / ')`);
  const tabIndexes = `[...document.querySelectorAll('#bike-switch button')].map(b => b.tabIndex).join(',')`;
  await page.open(app, { view: BONN, storage: { supplyEnabled: true } });

  step('Umschalter: ein Tab-Stopp je Gruppe, Pfeiltasten wechseln');
  check('Fahrradtyp: nur gewählter Knopf im Tab-Ablauf', await ev(tabIndexes) === '0,-1,-1,-1', await ev(tabIndexes));
  await ev(`document.querySelector('#bike-switch [aria-checked=true]').focus(); true`);
  await page.key('ArrowRight');
  check('Pfeil rechts → Gravel gewählt und fokussiert', await ev(`document.querySelector('#bike-switch [aria-checked=true]').dataset.value`) === 'gravel'
    && (await focused()).includes('Gravel'), await focused());
  await page.key('End');
  check('Ende → E-Bike', await ev(`document.querySelector('#bike-switch [aria-checked=true]').dataset.value`) === 'ebike');
  check('Tab-Stopp wandert mit', await ev(tabIndexes) === '-1,-1,-1,0', await ev(tabIndexes));
  check('Routenart als Optionsgruppe', await ev(`document.querySelector('#mode-tabs').getAttribute('role') + '/' + document.querySelector('#mode-tabs [aria-checked=true]').dataset.mode`) === 'radiogroup/ab');

  step('Ortssuche: Combobox');
  await ev(`document.querySelector('#start-input').focus(); true`);
  check('Startfeld hat Label', await ev(`document.querySelector('#start-input').labels[0]?.textContent.trim()`) === 'Start');
  await page.type('Bonn Hauptbahnhof');
  check('Vorschläge erscheinen', await waitFor(`document.querySelector('#start-input').getAttribute('aria-expanded') === 'true'`, 15000));
  check('Liste ist listbox mit option', await ev(`(() => { const l = document.getElementById(document.querySelector('#start-input').getAttribute('aria-controls'));
    return l.getAttribute('role') + '/' + l.querySelector('li').getAttribute('role'); })()`) === 'listbox/option');
  await sleep(300);
  check('Anzahl angesagt', /Vorschl/.test(await spoken()), await spoken());
  await page.key('ArrowDown');
  const ad = await ev(`document.querySelector('#start-input').getAttribute('aria-activedescendant')`);
  check('Pfeil runter → aktive Option gemeldet', !!ad && await ev(`document.getElementById(${JSON.stringify(ad)})?.getAttribute('aria-selected')`) === 'true', ad);
  await page.key('Enter');
  check('Enter übernimmt den Ort', await ev(`document.querySelector('#start-input').getAttribute('aria-expanded')`) === 'false'
    && !!(await ev(`document.querySelector('#start-input').value`)), await ev(`document.querySelector('#start-input').value`));
  await ev(`document.querySelector('#end-input').focus(); true`);
  await page.type('Königswinter');
  await waitFor(`document.querySelector('#end-input').getAttribute('aria-expanded') === 'true'`, 15000);
  await page.key('Enter');

  step('Route: Ansage, Marker, Listenzeilen, Sprunglink');
  check('Route berechnet', await waitFor(`!document.querySelector('#results').hidden && document.querySelector('#stat-dist').textContent`, 90000));
  check('Ansage „Route berechnet“', await waitFor(`[...document.querySelectorAll('body > .sr-only')].some(e => e.textContent.startsWith('Route berechnet'))`, 120000), await spoken());
  const markerNames = await ev(`[...document.querySelectorAll('.leaflet-marker-draggable')].map(m => m.getAttribute('aria-label')).join(' | ')`);
  check('Start-/Zielmarker haben Namen', /Start/.test(markerNames) && /Ziel/.test(markerNames), markerNames);
  check('Alle fokussierbaren Marker benannt', await ev(`[...document.querySelectorAll('.leaflet-marker-icon[tabindex]')].every(m => m.getAttribute('aria-label'))`));
  if (await ev(`document.querySelectorAll('#stop-list li').length`)) {
    await ev(`document.querySelector('#stop-list button.row').focus(); true`);
    check('Stopp-Zeile ist fokussierbar', (await focused()).startsWith('row'), await focused());
    await page.key('Enter');
    check('Enter öffnet den Stopp auf der Karte', await waitFor(`!!document.querySelector('.leaflet-popup .stop-popup')`, 5000));
  } else console.log('     (keine Stopps auf dieser Route)');
  await ev(`document.activeElement.blur(); document.querySelector('.skip-link').focus(); true`);
  check('Sprunglink sichtbar bei Fokus', await ev(`getComputedStyle(document.querySelector('.skip-link')).display !== 'none' && document.querySelector('.skip-link').getBoundingClientRect().top >= 0`));
  await page.key('Enter');
  check('Sprunglink führt zum Ergebnis', await ev(`document.activeElement.id === 'results' || location.hash === '#results'`), await ev(`document.activeElement.id + ' ' + location.hash`));
  await ev(`document.querySelector('#btn-gpx').focus(); true`);
  await page.key('Tab', { shift: true }); await page.key('Tab');
  check('Fokusrahmen auf Knopf', await ev(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; })()`), await focused());
  await page.shot('1-route');

  step('Meine Routen per Tastatur');
  check('Konto angelegt', await register(page, 'kbd_user'));
  await ev(`document.querySelector('#settings-dialog').close('cancel'); true`); await sleep(300);
  check('Gespeichert', await saveRoute(page));
  await ev(`document.querySelector('#btn-clear').click(); true`); await sleep(500);
  check('Ansage „Route gelöscht“', /Route gelöscht/.test(await spoken()), await spoken());
  await ev(`document.querySelector('#my-routes').open = true; document.querySelector('#my-routes-list button.row').focus(); true`);
  check('Gespeicherte Route fokussierbar', (await focused()).startsWith('row'), await focused());
  await page.key('Enter');
  check('Enter öffnet die gespeicherte Route', await waitFor(`!document.querySelector('#results').hidden`, 10000));
  const renameLabel = await ev(`document.querySelector('#my-routes-list .tools button').getAttribute('aria-label')`);
  check('Umbenennen-Knopf mit Routennamen', /umbenennen$/.test(renameLabel || ''), renameLabel);
}
