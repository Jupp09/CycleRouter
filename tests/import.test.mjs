// GPX-Import: Datei lesen (js/gpx.js), als Route öffnen, und der importierte Weg bleibt erhalten, wenn
// Stopps, ein anderes Fahrrad oder Speichern und Öffnen dazukommen – nur Abstecher werden berechnet.
import { STATE, BONN, HAS_ROUTE, SUPPLY_DONE, IDLE, departNextWednesday, register, saveRoute } from './lib/app.mjs';

export const title = 'GPX-Datei öffnen';

/** Datei über das versteckte Dateifeld öffnen (wie nach der Auswahl im Dateidialog). */
const openGpx = (page, text, name = 'tour.gpx') => page.ev(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'application/gpx+xml' }));
  const input = document.querySelector('#gpx-file');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  return true;
})()`);

/** Anteil der importierten Punkte, die in der aktuellen Route noch vorkommen (auf 5 Stellen – so genau wird gespeichert); dazu Kennzahlen. */
const KEPT = `(async () => { const s = ${STATE}, r = s.route;
  const key = c => c[0].toFixed(5) + ',' + c[1].toFixed(5);
  const now = new Set(r.coords.map(key)), orig = window.__imported;
  return { share: orig.filter(c => now.has(key(c))).length / orig.length, distance: r.distance, stops: r.stops?.length ?? 0,
    mode: s.mode, pins: document.querySelectorAll('.marker-pin').length, anchors: r.waypoints.filter(p => p.anchor).length,
    viaPins: document.querySelectorAll('.marker-pin.via').length }; })()`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('Vorlage: Rennrad-Route als GPX');
  let page = await newPage();
  await page.open(app, { view: BONN, storage: { bike: 'road' } });
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  const src = await page.ev(`(async () => { const r = ${STATE}.route;
    return { gpx: (await import('/js/gpx.js')).toGpx(r, 'Testtour Köln–Bonn'), distance: r.distance, points: r.coords.length }; })()`);

  step('GPX lesen');
  const parsed = await page.ev(`(async () => { const { parseGpx } = await import('/js/gpx.js');
    const fails = t => { try { parseGpx(t); return null; } catch (e) { return e.message; } };
    const t = parseGpx(${JSON.stringify(src.gpx)});
    const rte = parseGpx('<gpx xmlns="http://www.topografix.com/GPX/1/1"><rte><name>Plan</name><rtept lat="50.9" lon="6.9"/><rtept lat="50.8" lon="7.0"><ele>55</ele></rtept></rte></gpx>');
    const dense = parseGpx('<gpx><trk><trkseg><trkpt lat="50.9" lon="6.9"/><trkpt lat="50.90001" lon="6.9"/><trkpt lat="50.90002" lon="6.9"/><trkpt lat="50.901" lon="6.9"/><trkpt lat="50.90101" lon="6.9"/></trkseg></trk></gpx>');
    return { points: t.coords.length, name: t.name, ele: t.coords[0][2], rte: rte.coords.length + ' ' + rte.name + ' ' + rte.coords[0][2] + ' ' + rte.coords[1][2],
      dense: dense.coords.map(c => c[0]).join(' '),
      noXml: fails('kein xml <'), noGpx: fails('<kml></kml>'), empty: fails('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>') }; })()`);
  check('Track mit Namen und Höhen', parsed.points > 100 && parsed.name === 'Testtour Köln–Bonn' && typeof parsed.ele === 'number', `${parsed.points} von ${src.points} Punkten`);
  check('Routen-Punkte als Ersatz, Höhe darf fehlen', parsed.rte === '2 Plan null 55', parsed.rte);
  check('Dichte Punkte ausgedünnt, letzter Punkt bleibt', parsed.dense === '50.9 50.901 50.90101', parsed.dense);
  check('Fehlertexte', parsed.noXml === 'Die Datei ist kein gültiges GPX.' && parsed.noGpx === 'Die Datei ist kein gültiges GPX.'
    && parsed.empty === 'In der Datei ist keine Strecke.', JSON.stringify([parsed.noXml, parsed.noGpx, parsed.empty]));

  step('Öffnen (Fahrrad: Trekking, Modus: Rundkurs)');
  page = await newPage({ accounts: true, height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'trekking', mode: 'loop', supplyInterval: 8 } });
  await page.ev(`(async () => { window.__imported = (await import('/js/gpx.js')).parseGpx(${JSON.stringify(src.gpx)}).coords; return true; })()`);
  await openGpx(page, src.gpx);
  check('Route angezeigt', await page.waitFor(HAS_ROUTE, 10000));
  let k = await page.ev(KEPT);
  check('Weg unverändert, Länge wie in der Datei', k.share === 1 && Math.abs(k.distance - src.distance) < src.distance * 0.005, `${Math.round(k.distance)} m / ${Math.round(src.distance)} m`);
  check('Modus A → B, nur Start- und Ziel-Marker', k.mode === 'ab' && k.pins === 2, `${k.mode}, ${k.pins} Marker`);
  check('Name aus der Datei', await page.ev(`document.querySelector('#route-name').value`) === 'Testtour Köln–Bonn');
  check('Untergrund „Unbekannt“', /Unbekannt/.test(await page.ev(`document.querySelector('#breakdown-legend').textContent`)));
  await page.shot('1-geoeffnet');

  step('Verpflegungsstopps entlang des Wegs');
  await page.ev(`document.querySelector('#supply-enabled').click(); true`);
  await departNextWednesday(page);
  await sleep(1000);
  check('Stopps geplant', await page.waitFor(SUPPLY_DONE, 150000));
  k = await page.ev(KEPT);
  check('Mindestens ein Stopp', k.stops >= 1, `${k.stops} Stopps`);
  check('Weg bis auf Abstecher erhalten (≥ 80 % der Punkte)', k.share >= 0.8 && k.share < 1, `${Math.round(k.share * 100)} %`);
  check('Stützpunkte ohne Marker', k.anchors > 10 && k.viaPins === 0, `${k.anchors} Stützpunkte, ${k.viaPins} Marker`);
  await page.shot('2-mit-stopps');

  step('Anderes Fahrrad: neu berechnet, Weg bleibt');
  await page.ev(`document.querySelector('#bike-switch [data-value=gravel]').click(); true`);
  await sleep(1000);
  check('Neu geplant', await page.waitFor(SUPPLY_DONE, 150000));
  k = await page.ev(KEPT);
  check('Weg erhalten', k.share >= 0.8, `${Math.round(k.share * 100)} %`);

  step('Eigener Zwischenstopp neben dem Weg');
  await page.ev(`(async () => { const c = window.__imported[Math.floor(window.__imported.length / 2)];
    (await import('/js/app/waypoints.js')).addVia({ lat: c[0] + 0.002, lon: c[1] }, { label: 'Abstecher' }); return true; })()`);
  await sleep(1000);
  check('Neu geplant', await page.waitFor(SUPPLY_DONE, 150000));
  k = await page.ev(KEPT);
  const via = await page.ev(`(async () => ${STATE}.route.waypoints.filter(p => p.manual).map(p => p.label).join())()`);
  check('Zwischenstopp auf der Route, Weg erhalten', via === 'Abstecher' && k.share >= 0.8, `${via}, ${Math.round(k.share * 100)} %`);

  step('Speichern und wieder öffnen');
  check('Konto angelegt', await register(page, 'gpx_test'));
  await page.ev(`document.querySelector('#settings-dialog').close(); true`);
  check('Gespeichert', await saveRoute(page, 'Importierte Tour'));
  await page.ev(`document.querySelector('#btn-clear').click(); true`); await sleep(500);
  await page.ev(`document.querySelector('#my-routes-list li button').click(); true`);
  await sleep(1000);
  check('Geöffnet und Stopps geplant', await page.waitFor(`${HAS_ROUTE} && ${SUPPLY_DONE}`, 150000));
  k = await page.ev(KEPT);
  check('Weg nach dem Öffnen erhalten', k.share >= 0.8 && k.stops >= 1, `${Math.round(k.share * 100)} %, ${k.stops} Stopps`);
  check('Zwischenstopp nach dem Öffnen noch da', await page.ev(`(async () => ${STATE}.route.waypoints.filter(p => p.manual).map(p => p.label).join())()`) === 'Abstecher');
  check('Wieder ohne Stützpunkt-Marker', k.viaPins === 0 && k.mode === 'ab');

  step('Runde und Datei ohne Höhen');
  page = await newPage();
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });
  const loop = '<gpx><trk><name>Runde</name><trkseg>'
    + [[50.80, 7.00], [50.80, 7.03], [50.82, 7.03], [50.82, 7.00], [50.80, 7.00]].map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('')
    + '</trkseg></trk></gpx>';
  await openGpx(page, loop, 'runde.gpx');
  check('Route angezeigt', await page.waitFor(HAS_ROUTE, 10000));
  const round = await page.ev(`(async () => { const s = ${STATE}, r = s.route; const { insertWaypoints } = await import('/js/routeGeometry.js');
    return { mode: s.mode, up: document.querySelector('#stat-up').textContent, km: r.distance / 1000,
      anchors: insertWaypoints(r, []).length - 2, name: document.querySelector('#route-name').value }; })()`);
  check('Runde bleibt A → B, Anstieg 0 m', round.mode === 'ab' && round.up === '0 m' && round.name === 'Runde', JSON.stringify(round));
  // Stützpunkte liegen auf vorhandenen Punkten: hier die drei Ecken. Fände die Suche das Ziel am Start, wären es keine
  check('Stützpunkte über die ganze Runde', round.anchors === 3, `${round.anchors} auf ${round.km.toFixed(1)} km`);
  check('Ohne Berechnung im Gange', await page.ev(IDLE));
}
