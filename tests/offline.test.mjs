// Offline-Start: Service Worker (sw.js) merkt die App-Dateien, die App startet ohne Netz; „Meine Routen“ zeigt
// den gemerkten Stand, gemerkte Routen öffnen sich, andere sind gesperrt; Abmelden leert den Offline-Speicher.
import { STATE, BONN, HAS_ROUTE, IDLE, register, saveRoute } from './lib/app.mjs';

export const title = 'Offline-Start';

/** Service Worker zuständig und die wichtigsten Dateien gemerkt? */
const CACHED = `(async () => { const reg = await navigator.serviceWorker.getRegistration();
  const cache = await caches.open('cyclorouter-v1'); const keys = (await cache.keys()).map(r => new URL(r.url).pathname + (new URL(r.url).host === location.host ? '' : '@cdn'));
  return { active: !!reg?.active, controlled: !!navigator.serviceWorker.controller, count: keys.length,
    page: keys.includes('/'), main: keys.includes('/js/main.js'), css: keys.includes('/css/style.css'),
    modules: keys.filter(k => k.startsWith('/js/')).length, leaflet: keys.filter(k => k.endsWith('@cdn')).length,
    api: keys.filter(k => k.startsWith('/api/')).length }; })()`;
const STORE = `(async () => { const { offlineKeys, offlineGet } = await import('/js/offlineStore.js');
  const keys = (await offlineKeys()).map(String).sort(); return { keys, user: (await offlineGet('user'))?.user?.username ?? null }; })()`;
const LIST = `({ note: document.querySelector('#my-routes-offline').hidden ? null : document.querySelector('#my-routes-offline').textContent,
  hidden: document.querySelector('#my-routes').hidden,
  rows: [...document.querySelectorAll('#my-routes-list li')].map(li => ({ name: li.querySelector('.name').textContent, text: li.querySelector('small').textContent,
    open: !li.querySelector('button.row').disabled, tools: [...li.querySelectorAll('.tools button')].every(b => !b.disabled) })) })`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  const page = await newPage({ accounts: true, height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });

  step('Service Worker und gemerkte Dateien');
  check('Service Worker aktiv und Dateien gemerkt', await page.waitFor(`(async () => { const c = await ${CACHED}; return c.active && c.page && c.main && c.modules > 30; })()`, 30000));
  let cached = await page.ev(CACHED);
  check('Seite, Module, Stil und Leaflet gemerkt', cached.page && cached.main && cached.css && cached.modules > 30 && cached.leaflet >= 2, JSON.stringify(cached));
  check('Keine Antworten der Schnittstellen gemerkt', cached.api === 0);

  step('Konto und zwei Routen');
  check('Konto angelegt', await register(page, 'offline_test'));
  await page.ev(`document.querySelector('#settings-dialog').close(); true`);
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  check('Erste Route gespeichert', await saveRoute(page, 'Köln–Bonn'));
  const distance = await page.ev(`(async () => Math.round(${STATE}.route.distance))()`);
  await page.ev(`document.querySelector('#btn-clear').click(); true`); await sleep(500);
  await page.clickMap(50.80, 7.05);
  check('Zweite Route berechnet', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  check('Zweite Route gespeichert', await saveRoute(page, 'Köln–Wesseling', 2));
  check('Beide Routen im Hintergrund gemerkt', await page.waitFor(`(async () => (await ${STORE}).keys.filter(k => k.startsWith('route:')).length === 2)()`, 20000),
    JSON.stringify(await page.ev(STORE)));
  let store = await page.ev(STORE);
  check('Nutzer und Liste gemerkt', store.user === 'offline_test' && store.keys.includes('list') && store.keys.includes('user'), store.keys.join());
  // Eine der beiden wieder vergessen: Sie darf sich ohne Netz nicht öffnen lassen
  const forgotten = await page.ev(`(async () => { const { offlineDelete, offlineGet } = await import('/js/offlineStore.js');
    const list = (await offlineGet('list')).routes; const r = list.find(x => x.name === 'Köln–Wesseling'); await offlineDelete('route:' + r.id); return r.name; })()`);

  step('Neu laden ohne Netz');
  await page.setOffline(true);
  await page.reload();
  check('App startet aus dem gemerkten Stand', await page.waitFor(`!!document.querySelector('#map .leaflet-container, #map.leaflet-container') && !!document.querySelector('#bike-switch [aria-checked=true]')`, 20000));
  check('„Meine Routen“ mit Offline-Hinweis', await page.waitFor(`!document.querySelector('#my-routes').hidden && !document.querySelector('#my-routes-offline').hidden`, 20000));
  let list = await page.ev(LIST);
  check('Hinweis nennt den Stand', /^Offline – Stand vom \d\d\.\d\d\.\d{4}, \d\d:\d\d\./.test(list.note), list.note);
  const kept = list.rows.find(r => r.name === 'Köln–Bonn'), gone = list.rows.find(r => r.name === forgotten);
  check('Gemerkte Route lässt sich öffnen, die andere ist gesperrt', list.rows.length === 2 && kept?.open && gone && !gone.open && / · offline nicht verfügbar$/.test(gone.text), JSON.stringify(list.rows));
  check('Umbenennen und Löschen gesperrt', list.rows.every(r => !r.tools));
  await page.ev(`document.querySelector('#my-routes').open = true; true`);
  await page.shot('1-offline-liste');

  step('Gemerkte Route ohne Netz öffnen');
  await page.ev(`[...document.querySelectorAll('#my-routes-list li')].find(li => li.querySelector('.name').textContent === 'Köln–Bonn').querySelector('button.row').click(); true`);
  check('Route angezeigt', await page.waitFor(HAS_ROUTE, 10000));
  const opened = await page.ev(`(async () => ({ distance: Math.round(${STATE}.route.distance), name: document.querySelector('#route-name').value,
    save: document.querySelector('#save-actions').hidden, hint: document.querySelector('#save-hint').textContent,
    profile: !document.querySelector('.elevation').hidden }))()`);
  check('Dieselbe Route wie gespeichert, mit Höhenprofil', Math.abs(opened.distance - distance) <= 20 && opened.name === 'Köln–Bonn' && opened.profile, JSON.stringify(opened));
  check('Speichern und Teilen ausgeblendet, mit Hinweis', opened.save && /^Offline – Speichern und Teilen/.test(opened.hint), opened.hint);
  await page.clickMap(50.85, 6.98); await sleep(800);
  check('Neue Berechnung meldet das fehlende Netz', await page.waitFor(`document.querySelector('#status').textContent === 'Ohne Netz lassen sich keine neuen Routen berechnen.'`, 60000),
    await page.ev(`document.querySelector('#status').textContent`));
  await page.shot('2-offline-route');

  step('Netz wieder da');
  await page.setOffline(false);
  await page.ev(`window.dispatchEvent(new Event('online')); true`);
  check('Liste wieder aktuell, alles bedienbar', await page.waitFor(`document.querySelector('#my-routes-offline').hidden && [...document.querySelectorAll('#my-routes-list button')].every(b => !b.disabled)`, 20000));
  check('Die vergessene Route wird wieder gemerkt', await page.waitFor(`(async () => (await ${STORE}).keys.filter(k => k.startsWith('route:')).length === 2)()`, 20000));

  step('Abmelden leert den Offline-Speicher');
  await page.ev(`document.querySelector('#btn-settings').click(); document.querySelector('#btn-logout').click(); true`);
  check('Abgemeldet', await page.waitFor(`!document.querySelector('#account-out').hidden`, 10000));
  store = await page.ev(STORE);
  check('Nichts Gemerktes mehr', store.keys.length === 0 && store.user === null, store.keys.join());
  await page.ev(`document.querySelector('#settings-dialog').close(); true`);
  await page.setOffline(true);
  await page.reload();
  check('Ohne Netz und ohne Anmeldung: App startet, keine Konto-Funktionen', await page.waitFor(`!!document.querySelector('#bike-switch [aria-checked=true]')`, 20000)
    && await page.ev(`document.querySelector('#my-routes').hidden`));
  await page.setOffline(false);
}
