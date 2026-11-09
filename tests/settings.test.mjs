// E-Bike-Profil und „Auswahl anpassen“: Fahrradtypen und Routenarten ausblenden.
import { STATE, IDLE } from './lib/app.mjs';

export const title = 'E-Bike, Umschalter ausblenden';

const visible = sel => `[...document.querySelectorAll('${sel} [role=radio]')].filter(b => !b.hidden).map(b => b.textContent.trim()).join('|')`;
const bike = `(async () => ${STATE}.bike)()`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  const page = await newPage();
  const { ev, waitFor } = page;
  const urls = [];
  page.on((method, p) => {
    if (method === 'Network.requestWillBeSent' && p.request.url.includes('brouter.de/brouter?')) urls.push(p.request.url);
  });
  await page.send('Network.enable');
  await page.open(app, { storage: { bike: 'trekking' } });
  const idle = `!document.querySelector('#results').hidden && ${IDLE}`;

  step('Umschalter');
  check('Vier Fahrradtypen sichtbar', await ev(visible('#bike-switch')) === 'Rennrad|Gravel|Fahrrad|E-Bike', await ev(visible('#bike-switch')));
  await ev(`(async () => { const w = await import('/js/app/waypoints.js');
    w.setPoint('start', {lat: 50.9375, lon: 6.9603, label: 'Köln'}); w.setPoint('end', {lat: 50.5771, lon: 7.2304, label: 'Remagen'}); return true; })()`);
  check('Route Fahrrad', await waitFor(idle, 90000));
  await sleep(800);
  const tTrek = await page.text('#stat-time');
  urls.length = 0;
  await ev(`document.querySelector('#bike-switch [data-value=ebike]').click(); true`);
  // Erst wenn die Fahrzeit das E-Bike-Tempo nennt, ist die neue Route angezeigt (vorher ist die Statuszeile auch ruhig)
  check('Neu berechnet mit E-Bike', await waitFor(`document.querySelector('#stat-time').title.startsWith('Ø 22 km/h') && ${idle}`, 90000));
  const tE = await page.text('#stat-time');
  // Legs aus dem Cache bräuchten keine Anfrage – hier sind es neue (anderes Profil)
  check('BRouter-Anfrage mit E-Bike-Parameter', urls.some(u => u.includes('profile:consider_elevation=0')), urls[0]?.replace(/lonlats=[^&]*/, '…').slice(0, 120));
  check('Fahrzeit E-Bike anders', tE !== tTrek, `Fahrrad ${tTrek} · E-Bike ${tE}`);
  check('Tooltip Fahrzeit nennt E-Bike-Tempo', /22 km\/h/.test(await ev(`document.querySelector('#stat-time').title`)), await ev(`document.querySelector('#stat-time').title`));

  step('Pfeiltasten');
  await ev(`document.querySelector('#bike-switch [data-value=ebike]').focus(); true`);
  await page.key('ArrowLeft'); await sleep(300);
  check('Pfeil links: E-Bike → Fahrrad', await ev(bike) === 'trekking');
  await page.key('ArrowRight'); await sleep(300);
  await waitFor(idle, 60000);

  step('Einstellungen: Auswahl anpassen');
  await ev(`document.querySelector('#btn-settings').click(); true`); await sleep(300);
  check('Alle Häkchen gesetzt', await ev(`[...document.querySelectorAll('#visible-bikes input, #visible-modes input')].every(c => c.checked)`));
  await ev(`for (const v of ['road', 'gravel']) document.querySelector('#visible-bikes input[value=' + v + ']').click();
    document.querySelector('#visible-modes input[value=distance]').click(); true`);
  await page.shot('1-dialog');
  await ev(`document.querySelector('#settings-dialog').close('save'); true`); await sleep(500);
  check('Umschalter zeigt nur Fahrrad|E-Bike', await ev(visible('#bike-switch')) === 'Fahrrad|E-Bike', await ev(visible('#bike-switch')));
  check('Routenarten: A → B|Rundkurs', await ev(visible('#mode-tabs')) === 'A → B|Rundkurs', await ev(visible('#mode-tabs')));
  check('Gespeichert', await ev(`localStorage.getItem('cyclerouter.visibleBikes')`) === '["trekking","ebike"]');
  await ev(`document.querySelector('#bike-switch [data-value=ebike]').focus(); true`);
  await page.key('ArrowRight'); await sleep(300);
  check('Pfeiltasten überspringen ausgeblendete (E-Bike → Fahrrad)', await ev(bike) === 'trekking');
  await page.key('ArrowRight'); await sleep(300);
  await waitFor(idle, 60000);

  step('Aktiven Typ ausblenden');
  await ev(`document.querySelector('#btn-settings').click(); true`); await sleep(300);
  await ev(`document.querySelector('#visible-bikes input[value=ebike]').click(); true`);
  check('Letztes Häkchen gesperrt', await ev(`document.querySelector('#visible-bikes input[value=trekking]').disabled`));
  await ev(`document.querySelector('#settings-dialog').close('save'); true`); await sleep(500);
  check('Gewechselt auf Fahrrad', await ev(bike) === 'trekking');
  check('Umschalter entfällt (nur ein Typ)', await ev(`document.querySelector('#bike-switch').hidden`));
  check('Neu berechnet', await waitFor(idle, 60000));

  step('Geöffnete Route mit ausgeblendetem Typ');
  await ev(`(async () => { ${STATE}.bike = 'road'; (await import('/js/app/controls.js')).syncUi(); return true; })()`);
  check('Aktiver ausgeblendeter Typ wird angezeigt', await ev(visible('#bike-switch')) === 'Rennrad|Fahrrad' && !(await ev(`document.querySelector('#bike-switch').hidden`)),
    await ev(visible('#bike-switch')));

  step('Nach Neuladen');
  await ev(`localStorage.setItem('cyclerouter.bike', '"trekking"'); true`);
  await page.reload();
  check('Einstellung bleibt (nur Fahrrad, Umschalter weg)', await ev(`document.querySelector('#bike-switch').hidden`));
  check('Routenarten bleiben', await ev(visible('#mode-tabs')) === 'A → B|Rundkurs');
  await page.shot('2-panel');
}
