// Verpflegung: Trinkwasser nur angezeigt, Stopps nur mit Essen, Pausenstil zügig/gemütlich, Wasserlücken,
// GPX mit Wasser; Stopps und Wasserstellen fest in die Route übernehmen.
import { STATE, MAP, BONN, SUPPLY_DONE, departNextWednesday } from './lib/app.mjs';

export const title = 'Trinkwasser, Pausenstil, feste Stopps';

const FOOD = ['supermarket', 'convenience', 'fuel', 'bakery', 'cafe', 'restaurant'];

export default async function (t) {
  await waterAndStyle(t);
  await fixedStops(t);
}

async function routeWithSupply({ app, page: newPage, check, sleep }, interval) {
  const page = await newPage();
  await page.open(app, { view: BONN, storage: { bike: 'trekking', supplyEnabled: true, supplyInterval: interval } });
  await departNextWednesday(page);
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route mit Stopps und Trinkwasser', await page.waitFor(SUPPLY_DONE, 150000));
  await sleep(1500);
  return page;
}

async function waterAndStyle(t) {
  const { check, step, sleep } = t;
  step('Zügig (Standard)');
  const page = await routeWithSupply(t, 8);
  const { ev, waitFor } = page;
  let info = await ev(`(async () => { const r = ${STATE}.route; return {
    stops: r.stops.map(s => s.poi.type), water: r.water.length, dwell: r.dwellMin,
    onRoute: r.waypoints.filter(w => w.stop).length,
    markers: document.querySelectorAll('.water-pin').length, rows: document.querySelectorAll('#water-list li').length,
    gapsText: document.querySelector('#stop-gaps').textContent }; })()`);
  check('Kein Trinkwasser als Stopp', !info.stops.includes('water'));
  check('Nur Stopps mit Essen', info.stops.every(x => FOOD.includes(x)), info.stops.join(','));
  check('Route führt nur durch die Stopps', info.onRoute === info.stops.length);
  check('Trinkwasser: Marker = Listenzeilen = Anzahl', info.water > 0 && info.markers === info.water && info.rows === info.water, `${info.water} Stellen`);
  check('10 min Pause im Hinweis', info.dwell === 10 && /10 min Pause/.test(info.gapsText), info.gapsText);
  const gpx = await ev(`(async () => (await import('/js/gpx.js')).toGpx(${STATE}.route, 'Test'))()`);
  check('GPX enthält Trinkwasser-Wegpunkte', (gpx.match(/<sym>Drinking Water<\/sym>/g) || []).length === info.water);
  await ev(`document.querySelector('#water details').open = true; document.querySelector('#water-list button').click(); true`);
  await sleep(800);
  check('Klick auf Zeile öffnet Wasser-Popup', await ev(`/Trinkwasser · km/.test(document.querySelector('.leaflet-popup-content')?.textContent || '')`));
  await page.shot('1-zuegig');
  await ev(`(async () => { ${MAP}.closePopup(); return true; })()`);

  step('Gemütlich (Einstellungen)');
  await ev(`document.querySelector('#btn-settings').click(); true`); await sleep(300);
  check('Dialog zeigt „Zügig“ gewählt', await ev(`document.querySelector('#supply-style-switch [data-value=fast]').getAttribute('aria-checked') === 'true'`));
  await ev(`document.querySelector('#supply-style-switch [data-value=relaxed]').click(); true`);
  check('Hinweis zum Stil', await ev(`/keine Tankstellen/.test(document.querySelector('#supply-style-hint').textContent)`));
  await page.shot('2-dialog');
  await ev(`document.querySelector('#settings-dialog').close('save'); true`);
  await sleep(500);
  check('Neu geplant', await waitFor(`(async () => ${STATE}.route?.dwellMin === 30 && ${SUPPLY_DONE})()`, 150000));
  await sleep(1000);
  info = await ev(`(async () => { const r = ${STATE}.route; return { stops: r.stops.map(s => s.poi.type), water: r.water.length,
    gapsText: document.querySelector('#stop-gaps').textContent, stored: localStorage.getItem('cyclerouter.supplyStyle') }; })()`);
  check('Keine Tankstellen', !info.stops.includes('fuel'), info.stops.join(','));
  check('30 min Pause im Hinweis', /30 min Pause/.test(info.gapsText), info.gapsText);
  check('Einstellung gespeichert', info.stored === '"relaxed"');
  check('Trinkwasser weiterhin angezeigt', info.water > 0);
  await page.shot('3-gemuetlich');

  step('Hinweis auf Strecken ohne Wasser');
  const gapText = await ev(`(async () => { const st = await import('/js/app/state.js');
    window.__r = st.state.route;
    st.state.route = { ...window.__r, waterGaps: [{ from: 12000, to: 75000 }, { from: 90000, to: 150000 }] };
    st.emit('route', st.state.route);
    const el = document.querySelector('#water-gaps'); return el.hidden ? 'versteckt' : el.textContent; })()`);
  check('Lückenhinweis', /zwischen km 12 und 75, km 90 und 150 \(über 50 km\)/.test(gapText), gapText);
  await ev(`(async () => { const st = await import('/js/app/state.js'); st.state.route = window.__r; st.emit('route', st.state.route); return true; })()`);
  check('Ohne Lücke kein Hinweis', await ev(`document.querySelector('#water-gaps').hidden`));

  step('Verpflegung aus');
  await ev(`document.querySelector('#supply-enabled').click(); true`);
  check('Wasser-Marker und Liste weg', await waitFor(`document.querySelectorAll('.water-pin').length === 0 && document.querySelector('#water').hidden`, 10000));
}

async function fixedStops(t) {
  const { check, step, sleep } = t;
  step('Stopp fest übernehmen (📌 in der Liste)');
  const page = await routeWithSupply(t, 10);
  const { ev, waitFor } = page;
  const recalculated = () => waitFor(`(async () => ${STATE}.route !== window.__old && ${SUPPLY_DONE})()`, 150000);

  const first = await ev(`(async () => { const s = ${STATE}.route.stops[0]; return { id: s.poi.id, lat: s.poi.lat, lon: s.poi.lon, name: s.poi.name || s.typeLabel, along: s.along }; })()`);
  const pin = await ev(`(() => { const b = document.querySelector('#stop-list li .add'); return b && { text: b.textContent, label: b.getAttribute('aria-label') }; })()`);
  check('📌-Knopf mit Namen', pin?.text === '📌' && pin.label.includes('als festen Zwischenstopp übernehmen'), pin?.label);
  await ev(`(async () => { window.__old = ${STATE}.route; document.querySelector('#stop-list li .add').click(); return true; })()`);
  check('Neu berechnet', await recalculated());
  await sleep(1500);
  const r = await ev(`(async () => { const r = ${STATE}.route; return {
    fixed: r.waypoints.filter(p => p.manual && p.food).map(p => ({ lat: p.lat, lon: p.lon, label: p.label })),
    stops: r.stops.map(s => ({ id: s.poi.id, along: Math.round(s.along) })), vias: ${STATE}.vias.length,
    titles: [...document.querySelectorAll('.leaflet-marker-icon')].filter(m => /Zwischenstopp/.test(m.title)).map(m => m.title) }; })()`);
  check('Fester Zwischenstopp an der Stelle, mit food', r.fixed.length === 1 && r.fixed[0].lat === first.lat && r.fixed[0].lon === first.lon, r.fixed[0]?.label);
  check('Nicht zusätzlich als geplanter Stopp', !r.stops.some(s => s.id === first.id));
  check('Kein geplanter Stopp in den 5 km nach dem festen', !r.stops.some(s => s.along > first.along && s.along < first.along + 5000));
  check('Zwischenstopp-Marker mit Namen', r.titles.some(x => x.includes(first.name)), r.titles.join(' | '));
  check('Als A→B-Zwischenstopp in der Eingabe', r.vias === 1);

  step('Stopp per Popup-Knopf übernehmen');
  const second = await ev(`(async () => { const s = ${STATE}.route.stops.at(-1); return { id: s.poi.id, lat: s.poi.lat, lon: s.poi.lon }; })()`);
  await ev(`(async () => { ${MAP}.openStop(${JSON.stringify(second.id)}); return true; })()`);
  await sleep(800);
  const buttons = await ev(`[...document.querySelectorAll('.leaflet-popup-content button')].map(b => b.textContent).join('|')`);
  check('Popup hat „Als festen Zwischenstopp übernehmen“', /Als festen Zwischenstopp übernehmen/.test(buttons), buttons);
  await ev(`(async () => { window.__old = ${STATE}.route; document.querySelector('.leaflet-popup-content button.primary').click(); return true; })()`);
  check('Neu berechnet', await recalculated());
  await sleep(1500);
  check('Zwei feste Stopps', await ev(`(async () => ${STATE}.route.waypoints.filter(p => p.manual && p.food).length)()`) === 2);
  check('Zweiter an der richtigen Stelle', await ev(`(async () => ${STATE}.route.waypoints.some(p => p.food && p.lat === ${second.lat} && p.lon === ${second.lon}))()`));

  step('Trinkwasser als Zwischenstopp (+)');
  const w = await ev(`(async () => { const w = ${STATE}.route.water[0]; return w && { lat: w.poi.lat, lon: w.poi.lon, n: ${STATE}.route.water.length, rows: document.querySelectorAll('#water-list li').length }; })()`);
  check('Wasserliste hat Zeilen mit +', w && w.rows === w.n && await ev(`document.querySelector('#water-list li .add')?.textContent === '+'`), JSON.stringify(w));
  if (!w) return;
  await ev(`(async () => { window.__old = ${STATE}.route; document.querySelector('#water details').open = true; document.querySelector('#water-list li .add').click(); return true; })()`);
  check('Neu berechnet', await recalculated());
  await sleep(1500);
  const after = await ev(`(async () => { const r = ${STATE}.route; return {
    via: r.waypoints.filter(p => p.manual && p.lat === ${w.lat} && p.lon === ${w.lon}).map(p => ({ icon: p.icon, food: !!p.food })),
    inList: r.water.some(x => x.poi.lat === ${w.lat} && x.poi.lon === ${w.lon}),
    rows: document.querySelectorAll('#water-list li').length, markers: document.querySelectorAll('.water-pin').length, n: r.water.length }; })()`);
  check('Wasserstelle ist Zwischenstopp (💧, kein food)', after.via.length === 1 && after.via[0].icon === '💧' && !after.via[0].food);
  check('Nicht doppelt in Liste und Markern', after.rows === after.n - (after.inList ? 1 : 0) && after.markers === after.rows,
    `${after.rows} Zeilen, ${after.markers} Marker, ${after.n} gesamt`);
  await page.shot('4-fest');
}
