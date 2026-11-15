// Route als Link ohne Konto (js/app/linkView.js): Die Adresse trägt die Route hinter „#“, ein geöffneter Link
// rechnet dieselbe Route, ein Rundkurs mit seiner Saat denselben Rundkurs; Neuladen behält sie; „Link teilen“
// kopiert; ein kaputter Link meldet sich; eine importierte GPX-Strecke lässt sich so nicht teilen.
import { STATE, BONN, HAS_ROUTE, IDLE } from './lib/app.mjs';

export const title = 'Route als Link';

const ROUTE = `(async () => { const s = ${STATE}, r = s.route;
  return r && { mode: s.mode, bike: s.bike, distance: Math.round(r.distance), name: document.querySelector('#route-name').value,
    start: s.start && [s.start.lat.toFixed(5), s.start.lon.toFixed(5)].join(), end: s.end && [s.end.lat.toFixed(5), s.end.lon.toFixed(5)].join(),
    vias: s.vias.length }; })()`;
const HASH = `location.hash`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('A → B: Adresse trägt die Route');
  let page = await newPage({ height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'gravel', mode: 'ab' } });
  await page.clickMap(50.90, 6.97); await sleep(800);
  await page.clickMap(50.76, 7.07);
  check('Route berechnet', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  await page.ev(`(() => { const n = document.querySelector('#route-name'); n.value = 'Rhein & Ville'; n.dispatchEvent(new Event('input')); return true; })()`);
  const hash = await page.ev(HASH);
  const q = new URLSearchParams(hash.slice(1));
  check('Adresse mit #v=1, Modus, Fahrrad, Start, Ziel und Name', q.get('v') === '1' && q.get('m') === 'ab' && q.get('b') === 'gravel'
    && /^50\.9\d{4},6\.9\d{4}/.test(q.get('s')) && /^50\.7\d{4},7\.0\d{4}/.test(q.get('z')) && q.get('n') === 'Rhein & Ville', hash);
  const original = await page.ev(ROUTE);
  const link = await page.ev(`location.href`);

  // „Link teilen“ ohne Konto: in die Zwischenablage (im Test abgefangen)
  await page.ev(`(() => { window.__copied = null; navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }; return true; })()`);
  await page.ev(`document.querySelector('#btn-share-link').click(); true`); await sleep(300);
  check('„Link teilen“ kopiert den Link', await page.ev(`window.__copied`) === link && /Link kopiert/.test(await page.ev(`document.querySelector('#status').textContent`)));

  step('Link in einer neuen Seite öffnen');
  const other = await newPage({ height: 950 });
  await other.open(link, { view: BONN, storage: { bike: 'road', mode: 'loop' } });
  check('Route aus dem Link berechnet', await other.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  const opened = await other.ev(ROUTE);
  check('Gleiche Punkte, gleiches Fahrrad, gleicher Name', opened.start === original.start && opened.end === original.end
    && opened.mode === 'ab' && opened.bike === 'gravel' && opened.name === 'Rhein & Ville', JSON.stringify([original, opened]));
  check('Gleiche Länge (±20 m)', Math.abs(opened.distance - original.distance) <= 20, `${original.distance} / ${opened.distance}`);
  check('Startfeld zeigt den Namen aus dem Link', /\S/.test(await other.ev(`document.querySelector('#start-input').value`)));
  await other.shot('1-geoeffnet');

  step('Neuladen behält die Route');
  await other.reload();
  check('Nach dem Neuladen wieder da', await other.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  check('Gleiche Länge nach dem Neuladen', Math.abs((await other.ev(ROUTE)).distance - original.distance) <= 20);

  step('Rundkurs: dieselbe Saat ergibt denselben Rundkurs');
  page = await newPage({ height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'trekking', mode: 'loop', distanceKm: 25 } });
  await page.clickMap(50.80, 7.05); await sleep(800);
  await page.ev(`document.querySelector('#btn-generate').click(); true`);
  check('Rundkurs erzeugt', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 150000));
  const loop = await page.ev(ROUTE), loopLink = await page.ev(`location.href`);
  const lq = new URLSearchParams(loopLink.split('#')[1]);
  check('Link mit Länge, Richtung und Saat', lq.get('m') === 'loop' && lq.get('d') === '25' && lq.has('r') && /^\d+$/.test(lq.get('x') || ''), loopLink.split('#')[1]);
  const again = await newPage({ height: 950 });
  await again.open(loopLink, { view: BONN, storage: { bike: 'road' } });
  check('Rundkurs aus dem Link erzeugt', await again.waitFor(`${HAS_ROUTE} && ${IDLE}`, 150000));
  const loop2 = await again.ev(ROUTE);
  check('Derselbe Rundkurs (±20 m)', loop2.mode === 'loop' && Math.abs(loop2.distance - loop.distance) <= 20, `${loop.distance} / ${loop2.distance}`);

  step('Kaputter Link');
  page = await newPage({ height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });
  // Eigene Navigation (andere Abfrage, damit es kein bloßer Sprung im Anker ist); open() lädt zweimal
  await page.goto(`${app}?kaputt=1#v=1&m=ab&b=trekking&s=abc`);
  check('Meldung statt Absturz', /Link ist unvollständig/.test(await page.ev(`document.querySelector('#status').textContent`)), await page.ev(`document.querySelector('#status').textContent`));
  check('Adresse wieder ohne #', await page.ev(HASH) === '');

  step('Importierte GPX-Strecke');
  const gpx = '<gpx><trk><name>Flach</name><trkseg>'
    + [[50.80, 7.00], [50.80, 7.03], [50.82, 7.03]].map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('') + '</trkseg></trk></gpx>';
  await page.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(gpx)}], 'flach.gpx'));
    const input = document.querySelector('#gpx-file'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  check('Strecke angezeigt', await page.waitFor(HAS_ROUTE, 10000));
  const track = await page.ev(`({ hash: location.hash, disabled: document.querySelector('#btn-share-link').disabled,
    hint: document.querySelector('#share-hint').hidden ? '' : document.querySelector('#share-hint').textContent })`);
  check('Kein Link in der Adresse, Knopf gesperrt mit Hinweis', track.hash === '' && track.disabled && /Importierte Strecken/.test(track.hint), JSON.stringify(track));
}
