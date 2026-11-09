// Konten (Konto-API aus lib/fakeAccount.mjs): Einstellungs-Abgleich zwischen Geräten, Routen speichern,
// öffnen, umbenennen, löschen, Teilen-Link; dazu das iPhone (Tippflächen, 16-px-Felder, eigene Dialoge).
import { register, saveRoute, BONN, HAS_ROUTE } from './lib/app.mjs';

export const title = 'Konto, Meine Routen, Teilen, iPhone';

const stat = page => page.ev(`document.querySelector('#stat-dist').textContent + ' / ' + document.querySelector('#stat-up').textContent`);
/**
 * Gleiche Route wie gespeichert? Distanz exakt, Anstieg ±1 m: Beim Speichern werden die Höhen auf 0,1 m
 * gerundet (accountView.js), und withStats rechnet den Anstieg beim Öffnen daraus neu.
 */
const sameRoute = (a, b) => {
  const [distA, upA] = a.split(' / '), [distB, upB] = b.split(' / ');
  return distA === distB && Math.abs(parseInt(upA.replace('.', '')) - parseInt(upB.replace('.', ''))) <= 1;
};
const markers = page => page.ev(`document.querySelectorAll('.marker-pin.start').length + ' Start, ' + document.querySelectorAll('.marker-pin.end').length + ' Ziel'`);
const routeRow = text => `[...document.querySelectorAll('#my-routes-list li')].find(li => li.textContent.includes(${JSON.stringify(text)}))`;

export default async function (t) {
  await devices(t);
  await expiredSession(t);
  await iphone(t);
}

/** Sitzung abgelaufen (hier: von einem anderen Gerät abgemeldet) → „Meine Routen“ bekommt 401, die App zeigt „abgemeldet“. */
async function expiredSession({ app, page: newPage, check, step, sleep }) {
  step('Sitzung abgelaufen');
  const a = await newPage({ accounts: true });
  await a.open(app, { view: BONN });
  check('Konto angelegt', await register(a, 'sess_user'));
  await a.ev(`document.querySelector('#settings-dialog').close(); true`);
  await a.clickMapAt(0.3, 0.3); await sleep(800);
  await a.clickMapAt(0.6, 0.6);
  await a.waitFor(HAS_ROUTE);
  check('Gespeichert', await saveRoute(a, 'Sitzungstest'));

  const b = await newPage({ accounts: true });
  await b.open(app);
  const post = (path, body) => `fetch('/api/account/${path}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) })`;
  await b.ev(`${post('login', { username: 'sess_user', password: 'geheim1234' })}.then(() => ${post('logout-others', {})}).then(r => r.status)`);

  // A lädt „Meine Routen“ neu (wie beim Start) und bekommt 401
  await a.ev(`(async () => { (await import('/js/app/state.js')).emit('account'); return true; })()`);
  check('Als abgemeldet angezeigt', await a.waitFor(`document.querySelector('#my-routes').hidden && !document.querySelector('#account-out').hidden && document.querySelector('#account-in').hidden`, 5000));
  check('Speichern-Knöpfe weg, Hinweis zum Anmelden', await a.ev(`document.querySelector('#save-actions').hidden && document.querySelector('#save-hint').textContent.includes('anmelden')`));
  check('Bezug zur gespeicherten Route verworfen', await a.ev(`(async () => (await import('/js/app/state.js')).state.saved === null)()`));
}

async function devices({ app, page: newPage, check, step, sleep }) {
  const user = 'e2e_user', pass = 'geheim123';

  step('PC: registrieren, Einstellungen, Routen speichern, teilen');
  const pc = await newPage({ accounts: true });
  await pc.open(app, { view: BONN });
  check('Konto-Bereich sichtbar', await pc.ev(`!document.querySelector('#account-box').hidden`));
  check('Registriert und angemeldet', await register(pc, user, pass), await pc.text('#account-msg'));
  await pc.ev(`const r = document.querySelector('#speed-range'); r.value = 22; r.dispatchEvent(new Event('input'));
    document.querySelector('#settings-dialog button[value=save]').click(); true`);
  await sleep(500);
  await pc.ev(`document.querySelector('#bike-switch [data-value=trekking]').click(); true`);
  await sleep(2500); // Abgleich läuft mit 1,5 s Verzögerung

  await pc.clickMapAt(0.3, 0.2); await sleep(800);
  await pc.clickMapAt(0.65, 0.7);
  await pc.waitFor(HAS_ROUTE);
  check('„Route speichern“ sichtbar', await pc.ev(`!document.querySelector('#save-actions').hidden`));
  check('Gespeichert, in „Meine Routen“', await saveRoute(pc, 'PC-Runde Köln') && await pc.text('#my-routes-list li .name') === 'PC-Runde Köln');
  const statPc = await stat(pc);
  check('Knopf heißt jetzt „Änderungen speichern“', await pc.text('#btn-save-route') === 'Änderungen speichern');
  await pc.ev(`document.querySelector('#btn-share-link').click(); true`);
  await pc.waitFor(`document.querySelector('#save-hint a')`, 10000);
  const link = await pc.ev(`document.querySelector('#save-hint a')?.href`);
  check('Teilen-Link erzeugt', /\?route=[A-Za-z0-9_-]{22}$/.test(link || ''), link);
  await pc.shot('1-pc');

  await pc.ev(`document.querySelector('#mode-tabs [data-mode=loop]').click(); true`); await sleep(500);
  await pc.clickMapAt(0.5, 0.5); await sleep(1500);
  await pc.ev(`const n = document.querySelector('#distance-num'); n.value = 20; n.dispatchEvent(new Event('change')); document.querySelector('#btn-generate').click(); true`);
  await pc.waitFor(`${HAS_ROUTE} && document.querySelector('#route-name').value.startsWith('Rundkurs')`, 120000);
  check('Rundkurs gespeichert', await saveRoute(pc, 'PC-Rundkurs', 2));
  const loopPc = await stat(pc), loopMarkers = await markers(pc);

  step('Handy: anmelden, Einstellungen übernehmen, Routen öffnen');
  const phone = await newPage({ accounts: true });
  await phone.open(app);
  check('Vorher Standard-Fahrradtyp', await phone.ev(`document.querySelector('#bike-switch [aria-checked=true]').dataset.value`) === 'road');
  await phone.ev(`document.querySelector('#btn-settings').click();
    document.querySelector('#account-user').value = '${user}'; document.querySelector('#account-pass').value = '${pass}';
    document.querySelector('#btn-login').click(); true`);
  await sleep(4000); // Anmeldung → Einstellungen übernehmen → Neuladen
  await phone.waitFor(`document.readyState === 'complete' && document.querySelectorAll('#my-routes-list li').length === 2`, 20000);
  check('Fahrradtyp vom PC übernommen', await phone.ev(`document.querySelector('#bike-switch [aria-checked=true]').dataset.value`) === 'trekking');
  check('Tempo vom PC übernommen', await phone.ev(`localStorage.getItem('cyclerouter.avgSpeed')`) === '22');
  check('Angemeldet nach Neuladen', await phone.ev(`!document.querySelector('#my-routes').hidden`));
  const names = await phone.ev(`[...document.querySelectorAll('#my-routes-list .name')].map(e => e.textContent).join(', ')`);
  check('Beide Routen, neueste zuerst', names === 'PC-Rundkurs, PC-Runde Köln', names);

  await phone.ev(`document.querySelector('#my-routes').open = true; ${routeRow('PC-Rundkurs')}.querySelector('button.row').click(); true`);
  await phone.waitFor(`!document.querySelector('#results').hidden`, 10000); await sleep(800);
  check('Rundkurs identisch', sameRoute(await stat(phone), loopPc), `${await stat(phone)} vs. PC ${loopPc}`);
  check('Rundkurs-Modus und Marker', await phone.ev(`document.querySelector('#mode-tabs [aria-checked=true]').dataset.mode`) === 'loop'
    && await markers(phone) === loopMarkers, await markers(phone));

  await phone.ev(`${routeRow('PC-Runde Köln')}.querySelector('button.row').click(); true`);
  await phone.waitFor(`document.querySelector('#route-name').value === 'PC-Runde Köln'`, 10000); await sleep(500);
  check('A→B-Route identisch', sameRoute(await stat(phone), statPc), `${await stat(phone)} vs. PC ${statPc}`);
  check('Start/Ziel-Felder gefüllt', await phone.ev(`!!document.querySelector('#start-input').value && !!document.querySelector('#end-input').value`));
  await phone.ev(`${routeRow('PC-Runde Köln')}.querySelector('[title=Umbenennen]').click(); true`);
  check('Umbenennen: eigener Dialog', await phone.waitFor(`document.querySelector('#ask-dialog').open`, 5000));
  await phone.ev(`document.querySelector('#ask-input').value = 'PC-Runde umbenannt'; document.querySelector('#ask-ok').click(); true`);
  await phone.waitFor(`[...document.querySelectorAll('#my-routes-list .name')].some(e => e.textContent === 'PC-Runde umbenannt')`, 10000);
  check('Umbenannt', await phone.ev(`document.querySelector('#route-name').value`) === 'PC-Runde umbenannt');
  await phone.shot('2-handy');

  step('Gast: geteilte Route ohne Konto');
  const guest = await newPage({ accounts: true });
  await guest.goto(link);
  await guest.waitFor(`!document.querySelector('#results').hidden`, 15000); await sleep(800);
  check('Geteilte Route geöffnet', sameRoute(await stat(guest), statPc), await stat(guest));
  check('Link aus Adresszeile entfernt', !(await guest.ev(`location.search`)));
  check('Keine Speichern-Knöpfe, Hinweis zum Anmelden', await guest.ev(`document.querySelector('#save-actions').hidden && document.querySelector('#save-hint').textContent.includes('anmelden')`));
  await guest.shot('3-gast');

  step('Link zurückziehen');
  // Die Liste am PC zeigt noch den alten Namen (das Umbenennen war am Handy)
  await pc.ev(`document.querySelector('#my-routes').open = true; ${routeRow('PC-Runde')}.querySelector('button.row').click(); true`);
  await pc.waitFor(`[...document.querySelectorAll('#save-hint button')].some(b => b.textContent === 'zurückziehen')`, 10000);
  await pc.ev(`[...document.querySelectorAll('#save-hint button')].find(b => b.textContent === 'zurückziehen').click(); true`);
  await sleep(1000);
  const guest2 = await newPage({ accounts: true });
  await guest2.goto(link);
  await sleep(1500);
  const status = await guest2.text('#status') || '';
  check('Zurückgezogener Link zeigt Fehlermeldung', status.includes('ungültig'), status);

  step('Konto löschen');
  await pc.ev(`document.querySelector('#btn-settings').click(); document.querySelector('#btn-delete-account').click();
    document.querySelector('#account-delete-pass').value = '${pass}'; document.querySelector('#btn-delete-confirm').click(); true`);
  check('Konto gelöscht', await pc.waitFor(`document.querySelector('#account-msg').textContent.includes('gelöscht')`, 10000));
}

async function iphone({ app, page: newPage, check, step, sleep }) {
  step('iPhone: Manifest, Felder, Tippflächen');
  const page = await newPage({ accounts: true, mobile: true });
  const { ev, waitFor } = page;
  await page.open(app, { view: BONN });

  const mf = await page.send('Page.getAppManifest');
  check('Manifest ohne Fehler', !!mf?.data && !(mf.errors || []).length, JSON.stringify(mf?.errors || []));
  for (const p of ['manifest.webmanifest', 'assets/icons/apple-touch-icon.png', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/icon.svg']) {
    const r = await fetch(app + p);
    check(`${p} erreichbar`, r.status === 200, r.status);
  }
  check('Apple-Touch-Icon im Kopf', await ev(`!!document.querySelector('link[rel=apple-touch-icon]')`));
  check('viewport-fit=cover', (await ev(`document.querySelector('meta[name=viewport]').content`)).includes('viewport-fit=cover'));
  check('Touch-Gerät erkannt (pointer: coarse)', await ev(`matchMedia('(pointer: coarse)').matches`));
  const fs = await ev(`[...document.querySelectorAll('#start-input, #end-input, #departure, #route-name, #supply-interval, #account-user')].map(e => getComputedStyle(e).fontSize).join(',')`);
  check('Eingabefelder 16 px (kein Auto-Zoom)', fs.split(',').every(v => v === '16px'), fs);
  const btn = await ev(`(() => { const r = document.querySelector('#btn-locate').getBoundingClientRect(); return Math.round(r.width) + '×' + Math.round(r.height); })()`);
  check('Tippfläche Standort-Knopf ≥ 44 px', btn.split('×').every(v => +v >= 44), btn);
  const mapH = await ev(`Math.round(document.querySelector('.map-area').getBoundingClientRect().height)`);
  check('Kartenhöhe 55 % (dvh)', Math.abs(mapH - 852 * 0.55) <= 2, `${mapH} px`);
  check('Keine waagerechte Scrollleiste', await ev(`document.documentElement.scrollWidth <= innerWidth`));

  step('iPhone: Route per Fingertipp, eigene Dialoge');
  await page.clickMapAt(0.35, 0.25, { touch: true }); await sleep(900);
  await page.clickMapAt(0.6, 0.7, { touch: true });
  check('Route per Fingertipp gesetzt', await waitFor(HAS_ROUTE), await page.text('#stat-dist'));
  await page.shot('4-iphone');

  check('Konto angelegt', await register(page, 'ios_user'));
  await ev(`document.querySelector('#settings-dialog').close(); true`);
  check('Gespeichert', await saveRoute(page, 'iPhone-Test'));
  await ev(`document.querySelector('#my-routes').open = true; document.querySelector('#my-routes-list [title=Umbenennen]').click(); true`);
  await sleep(400);
  check('Umbenennen: eigener Dialog offen', await ev(`document.querySelector('#ask-dialog').open && !document.querySelector('#ask-input').hidden`),
    await ev(`document.querySelector('#ask-title').textContent + ' / Vorgabe „' + document.querySelector('#ask-input').value + '“'`));
  await page.shot('5-dialog');
  await ev(`const f = document.querySelector('#ask-input'); f.value = 'Neuer Name'; f.form.requestSubmit(document.querySelector('#ask-ok')); true`);
  check('Umbenannt', await waitFor(`document.querySelector('#my-routes-list .name')?.textContent === 'Neuer Name'`, 10000));
  await ev(`document.querySelector('#my-routes-list [title=Löschen]').click(); true`);
  await sleep(400);
  check('Löschen: Rückfrage im App-Stil', await ev(`document.querySelector('#ask-dialog').open && document.querySelector('#ask-input').hidden && document.querySelector('#ask-ok').className === 'danger'`),
    await ev(`document.querySelector('#ask-title').textContent`));
  await ev(`document.querySelector('#ask-dialog form').requestSubmit(document.querySelector('[value=cancel]')); true`);
  await sleep(400);
  check('Abbrechen: Route bleibt', await ev(`document.querySelectorAll('#my-routes-list li').length === 1`));
  await ev(`document.querySelector('#my-routes-list [title=Löschen]').click(); true`); await sleep(300);
  await ev(`document.querySelector('#ask-dialog form').requestSubmit(document.querySelector('#ask-ok')); true`);
  check('Bestätigt: Route gelöscht', await waitFor(`document.querySelectorAll('#my-routes-list li').length === 0`, 10000));
}
