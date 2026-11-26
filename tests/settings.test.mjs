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
    // brouter.de oder der eigene BRouter des Servers (/api/brouter, nur mit BROUTER_URL, z. B. auf cyclorouter.de)
    if (method !== 'Network.requestWillBeSent') return;
    const u = p.request.url;
    if (u.includes('brouter.de/brouter?') || u.includes('/api/brouter?')) urls.push(u);
  });
  await page.send('Network.enable');
  await page.open(app, { storage: { bike: 'trekking' } });
  const idle = `!document.querySelector('#results').hidden && ${IDLE}`;

  step('Umschalter');
  check('Vier Fahrradtypen sichtbar', await ev(visible('#bike-switch')) === 'Rennrad|Gravel|Trekking|E-Bike', await ev(visible('#bike-switch')));
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
  // Mit angezeigter Route ist das Eingabeformular eingeklappt (planView.js) – ein versteckter Knopf nimmt keinen Fokus
  await ev(`document.querySelector('#plan').hidden && document.querySelector('#btn-plan-edit').click(); true`);
  await ev(`document.querySelector('#bike-switch [data-value=ebike]').focus(); true`);
  check('Fokus auf E-Bike', await ev(`document.activeElement?.dataset.value === 'ebike'`));
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
  check('Umschalter zeigt nur Trekking|E-Bike', await ev(visible('#bike-switch')) === 'Trekking|E-Bike', await ev(visible('#bike-switch')));
  check('Routenarten: A → B|Rundkurs', await ev(visible('#mode-tabs')) === 'A → B|Rundkurs', await ev(visible('#mode-tabs')));
  check('Gespeichert', await ev(`localStorage.getItem('cyclerouter.visibleBikes')`) === '["trekking","ebike"]');
  await ev(`document.querySelector('#plan').hidden && document.querySelector('#btn-plan-edit').click(); true`);
  await ev(`document.querySelector('#bike-switch [data-value=ebike]').focus(); true`);
  check('Fokus auf E-Bike (nach dem Speichern)', await ev(`document.activeElement?.dataset.value === 'ebike'`));
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
  check('Aktiver ausgeblendeter Typ wird angezeigt', await ev(visible('#bike-switch')) === 'Rennrad|Trekking' && !(await ev(`document.querySelector('#bike-switch').hidden`)),
    await ev(visible('#bike-switch')));

  step('Nach Neuladen');
  await ev(`localStorage.setItem('cyclerouter.bike', '"trekking"'); true`);
  await page.reload();
  check('Einstellung bleibt (nur Fahrrad, Umschalter weg)', await ev(`document.querySelector('#bike-switch').hidden`));
  check('Routenarten bleiben', await ev(visible('#mode-tabs')) === 'A → B|Rundkurs');
  await page.shot('2-panel');

  step('Dialog: Aufbau und Bedienung');
  const D = `document.querySelector('#settings-dialog')`;
  await ev(`document.querySelector('#btn-settings').click(); true`); await sleep(300);
  const layout = await ev(`(() => { const d = ${D}, body = d.querySelector('.settings-body'), foot = d.querySelector('.settings-foot');
    return { heads: [...d.querySelectorAll('.settings-section:not([hidden]) h3')].map(h => h.textContent),
      danger: d.querySelector('#account-danger').hidden, scrolls: body.scrollHeight > body.clientHeight,
      footVisible: foot.getBoundingClientRect().bottom <= innerHeight + 1,
      checkmark: getComputedStyle(d.querySelector('#theme-switch [aria-checked=true]'), '::before').content,
      small: [...d.querySelectorAll('button, input:not([type=checkbox])')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 43.5 && !e.matches('.link-btn')).map(e => e.id || e.textContent.trim()) }; })()`);
  check('Abschnitte in der Reihenfolge des Entwurfs', layout.heads.join('|') === 'Darstellung|Auswahl anpassen|Heimatadresse|Durchschnittsgeschwindigkeit|Rundkurs planen nach|Pausenstil bei Verpflegungsstopps|Mehrtagestouren|OpenRouteService', layout.heads.join('|'));
  check('Ohne Konto kein Löschbereich', layout.danger);
  check('Inhalt scrollt, Speichern bleibt sichtbar', layout.scrolls && layout.footVisible, JSON.stringify(layout));
  check('Gewählte Option mit Häkchen', /✓/.test(layout.checkmark), layout.checkmark);
  check('Bedienelemente mindestens 44 px hoch', !layout.small.length, layout.small.join(', '));

  await ev(`{ const n = document.querySelector('#speed-num'); n.value = 24; n.dispatchEvent(new Event('change')); } true`);
  check('Zahlenfeld stellt den Regler', await ev(`document.querySelector('#speed-range').value`) === '24');
  const before = Number(await ev(`document.querySelector('#stage-max').value`));
  await ev(`document.querySelector('[data-step=stage-max][data-delta="10"]').click(); true`);
  check('+ erhöht die km pro Tag um 10', Number(await ev(`document.querySelector('#stage-max').value`)) === before + 10);
  await ev(`document.querySelector('#ors-show').click(); true`);
  check('API-Key anzeigen', await ev(`document.querySelector('#ors-key').type === 'text' && document.querySelector('#ors-show').getAttribute('aria-pressed') === 'true'`));
  await page.shot('3-einstellungen');
  await ev(`document.querySelector('.settings-body').scrollTop = 1e6; true`); await sleep(100);
  await page.shot('4-einstellungen-unten');
  // Enter in einem Feld speichert (nur „Speichern“ schickt ab), Kreuz und „Abbrechen“ verwerfen
  await ev(`document.querySelector('.settings-close').click(); true`); await sleep(200);
  check('Kreuz schließt ohne Speichern', await ev(`!${D}.open && ${D}.returnValue === 'cancel' && localStorage.getItem('cyclerouter.avgSpeed') !== '24'`));
  await ev(`document.querySelector('#btn-settings').click(); true`); await sleep(300);
  check('Beim Öffnen ist der Key wieder verdeckt', await ev(`document.querySelector('#ors-key').type === 'password'`));
  await ev(`{ const n = document.querySelector('#speed-num'); n.value = 24; n.dispatchEvent(new Event('change')); } true`);
  await ev(`document.querySelector('#stage-max').focus(); true`);
  await page.key('Enter'); await sleep(200);
  check('Enter in einem Feld speichert', await ev(`${D}.returnValue === 'save' && localStorage.getItem('cyclerouter.avgSpeed') === '24'`));
}
