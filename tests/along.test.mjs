// „Entlang der Route finden“ für Fahrrad-Service und Bahnhöfe (Ebene `service` in js/poiSource.js): Einordnung der
// OSM-Objekte, Chips je Fahrradtyp, Suche, Übernahme als gewöhnlicher Zwischenstopp, nächster Bahnhof am Ziel.
import { STATE, BONN, HAS_ROUTE, IDLE } from './lib/app.mjs';

export const title = 'Fahrrad-Service und Bahnhöfe entlang der Route';

const CHIPS = `[...document.querySelectorAll('#along-chips button')].map(b => b.textContent.replace(/^\\S+ /, ''))`;
const chip = label => `[...document.querySelectorAll('#along-chips button')].find(b => b.textContent.endsWith(${JSON.stringify(label)}))`;
/** Suche fertig: Hinweis sichtbar und nicht mehr „wird gesucht“. */
const SEARCHED = `!document.querySelector('#along-hint').hidden && !/wird gesucht/.test(document.querySelector('#along-hint').textContent)`;
const RESULTS = `({ hint: document.querySelector('#along-hint').textContent, rows: [...document.querySelectorAll('#along-list li')].map(li => li.textContent) })`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('Einordnung der OSM-Objekte');
  let page = await newPage({ height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });
  const types = await page.ev(`(async () => { const { toPoi, layerOfType, LAYERS } = await import('/js/poiSource.js');
    const type = tags => toPoi({ id: 'node/1', lat: 50, lon: 7, tags }, 'service')?.type ?? null;
    return {
      station: type({ railway: 'station', name: 'Bonn Hbf' }), halt: type({ railway: 'halt' }),
      subway: type({ railway: 'station', station: 'subway' }), museum: type({ railway: 'station', usage: 'tourism' }),
      shop: type({ shop: 'bicycle' }), repair: type({ amenity: 'bicycle_repair_station' }), air: type({ amenity: 'compressed_air' }),
      charging: type({ amenity: 'charging_station', bicycle: 'yes' }), carCharging: type({ amenity: 'charging_station' }),
      privateShop: type({ shop: 'bicycle', access: 'private' }), other: type({ shop: 'bakery' }),
      layers: ['station', 'bike_shop', 'repair_station', 'air', 'charging'].map(layerOfType).join(), cafe: layerOfType('cafe'),
      filters: LAYERS.service.filters.length, query: LAYERS.service.statements('1,2,3,4').includes('"bicycle"="yes"') }; })()`);
  check('Bahnhof und Haltepunkt, aber keine U-Bahn und keine Museumsbahn',
    types.station === 'station' && types.halt === 'station' && types.subway === null && types.museum === null, JSON.stringify(types));
  check('Fahrradladen, Reparaturstation, Luft', types.shop === 'bike_shop' && types.repair === 'repair_station' && types.air === 'air');
  check('Ladestation nur mit bicycle=yes', types.charging === 'charging' && types.carCharging === null);
  check('Privates und Fremdes gehört nicht dazu', types.privateShop === null && types.other === null);
  check('Alle fünf Typen in der Ebene service', types.layers === 'service,service,service,service,service' && types.cafe === 'food' && types.query);

  step('Route und Chips');
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  let chips = await page.ev(CHIPS);
  check('Neue Kategorien da, „E-Bike laden“ nicht beim Trekkingrad',
    ['Fahrradladen', 'Reparaturstation', 'Luftpumpe', 'Bahnhof'].every(c => chips.includes(c)) && !chips.includes('E-Bike laden'), chips.join(', '));

  step('Fahrradladen suchen und übernehmen');
  await page.ev(`${chip('Fahrradladen')}.click(); true`);
  check('Suche fertig', await page.waitFor(SEARCHED, 60000));
  let res = await page.ev(RESULTS);
  check('Treffer bis 1 km', res.rows.length >= 1 && / × Fahrradladen bis 1 km neben der Route/.test(res.hint), `${res.rows.length}: ${res.hint}`);
  await page.shot('1-fahrradladen');
  const first = await page.ev(`document.querySelector('#along-list li .name').textContent`);
  await page.ev(`document.querySelector('#along-list li button[aria-label$="als Zwischenstopp hinzufügen"]').click(); true`);
  await sleep(1000);
  check('Neu berechnet', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  const via = await page.ev(`(async () => ${STATE}.route.waypoints.filter(p => p.manual).map(p => ({ label: p.label, icon: p.icon, food: !!p.food })))()`);
  check('Gewöhnlicher Zwischenstopp, kein Verpflegungsstopp', via.length === 1 && via[0].label === first && via[0].icon === '🚲' && via[0].food === false, JSON.stringify(via));

  step('Bahnhöfe');
  // Nur aus dem Kachel-Cache: Der Server lädt die Ebene beim ersten Mal von Overpass – bis dahin erneut suchen
  for (let i = 0; i < 9; i++) {
    await page.ev(`${chip('Bahnhof')}.click(); true`);
    await page.waitFor(SEARCHED, 60000);
    res = await page.ev(RESULTS);
    if (res.rows.length >= 4 && !/nachgeladen/.test(res.hint)) break;
    await page.ev(`${chip('Bahnhof')}.click(); true`); // Suche beenden
    await sleep(10000);
  }
  check('Treffer bis 3 km, ohne Öffnungszeiten', res.rows.length >= 4 && / × Bahnhof bis 3 km neben der Route/.test(res.hint)
    && res.rows.every(r => !/geöffnet|geschlossen|unbekannt/.test(r)), `${res.rows.length}: ${res.rows[0]}`);
  const far = await page.ev(`[...document.querySelectorAll('#along-list li small')].some(s => / (1[05]\\d\\d|[23]\\d\\d\\d) m neben/.test(s.textContent))`);
  check('Auch Bahnhöfe weiter als 1 km entfernt', far);
  await page.shot('2-bahnhoefe');

  step('Nächster Bahnhof am Ziel');
  // Kommt aus dem Kachel-Cache; der Server lädt die Ebene im Hintergrund von Overpass – das kann dauern
  const shown = await page.waitFor(`!document.querySelector('#station-hint').hidden`, 90000);
  const hint = await page.ev(`document.querySelector('#station-hint').textContent`);
  if (shown) check('Zeile mit Name und Entfernung', /^Nächster Bahnhof am Ziel: .+, \d+(,\d)? km$/.test(hint), hint);
  else console.log('     (Ebene service noch nicht geladen – Zeile nicht geprüft)');

  step('E-Bike');
  await page.ev(`document.querySelector('#bike-switch [data-value=ebike]').click(); true`);
  await sleep(1000);
  check('Neu berechnet', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  chips = await page.ev(CHIPS);
  check('„E-Bike laden“ wird angeboten', chips.includes('E-Bike laden'), chips.join(', '));
  await page.ev(`${chip('E-Bike laden')}.click(); true`);
  check('Suche fertig', await page.waitFor(SEARCHED, 60000));
  res = await page.ev(RESULTS);
  check('Hinweis nennt Ladestationen', /Ladestation/.test(res.hint), res.hint);
  await page.ev(`document.querySelector('#bike-switch [data-value=trekking]').click(); true`);
  await sleep(1000);
  await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000);
  check('Zurück zum Trekkingrad: Kategorie und Suche weg', !(await page.ev(CHIPS)).includes('E-Bike laden') && await page.ev(`document.querySelector('#along-hint').hidden`));

  step('Bahnhöfe ohne Kachel-Cache (im Test gesperrt)');
  page = await newPage({ height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });
  // Bahnhöfe haben keinen Photon-Ersatz (doppelte Zahl an Anfragen, Photon sperrt bei zu vielen): Ohne Cache
  // kommt nur der Hinweis, dass die Daten nachgeladen werden – und keine einzige Kategorie-Anfrage an Photon
  await page.ev(`(() => { const real = window.fetch; window.__photon = [];
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes('/api/pois') || u.includes('overpass')) return Promise.reject(new TypeError('im Test gesperrt'));
      if (u.includes('photon.komoot.io/api/?include=')) window.__photon.push(new URL(u).searchParams.getAll('include').join('+'));
      return real(url, opts);
    }; return true; })()`);
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  await page.ev(`${chip('Bahnhof')}.click(); true`);
  check('Suche fertig', await page.waitFor(SEARCHED, 90000));
  res = await page.ev(RESULTS);
  const asked = await page.ev(`window.__photon.length`);
  check('Keine Kategorie-Anfrage an Photon', asked === 0, asked);
  check('Hinweis: Daten werden nachgeladen', res.rows.length === 0 && /werden gerade nachgeladen/.test(res.hint), res.hint);
}
