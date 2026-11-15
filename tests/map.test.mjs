// Zoomgrenzen je Kartenstil: nie weiter zoomen, als Kacheln kommen (sonst grauer Bildschirm). CyclOSM zeigt
// auf Stufe 19 die Kacheln von 18 vergrößert; OpenTopoMap endet bei 17 und ist darüber im Menü gesperrt.
export const title = 'Zoomgrenzen der Kartenstile';

const zoom = p => p.ev(`JSON.parse(localStorage.getItem('cyclerouter.view')).zoom`);
/** Kacheln der sichtbaren Grundkarte: wie viele geladen, aus welcher Zoomstufe (aus der Kachel-Adresse). */
const tiles = p => p.ev(`(() => {
  const t = [...document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')];
  return { loaded: t.filter(i => i.classList.contains('leaflet-tile-loaded')).length, z: [...new Set(t.map(i => i.src.split('/').at(-3)))].join(',') };
})()`);
const baseInput = name => `[...document.querySelectorAll('.leaflet-control-layers-base label')].find(l => l.textContent.trim() === ${JSON.stringify(name)}).querySelector('input')`;

async function zoomToMax(p, sleep) {
  for (let i = 0; i < 25; i++) { await p.ev(`document.querySelector('.leaflet-control-zoom-in').click(); true`); await sleep(120); }
  await sleep(500);
  return { zoom: await zoom(p), disabled: await p.ev(`document.querySelector('.leaflet-control-zoom-in').classList.contains('leaflet-disabled')`) };
}

/** Anteil der Kartenfläche, den die gezeichnete Route einnimmt (Breite bzw. Höhe, 0…1). */
const FILL = `(() => { const m = document.querySelector('#map').getBoundingClientRect();
  const r = document.querySelector('#map path.route-hit').getBoundingClientRect();
  return { w: +(r.width / m.width).toFixed(2), h: +(r.height / m.height).toFixed(2) }; })()`;
/** Eine Runde als GPX (keine Routing-Anfrage) – auf die Karte gelegt wie per Datei-Auswahl. */
const loopGpx = '<gpx><trk><name>Runde</name><trkseg>'
  + [[50.80, 7.00, 50], [50.80, 7.06, 62], [50.84, 7.06, 80], [50.84, 7.00, 66], [50.80, 7.00, 50]]
    .map(([la, lo, ele]) => `<trkpt lat="${la}" lon="${lo}"><ele>${ele}</ele></trkpt>`).join('') + '</trkseg></trk></gpx>';
const openGpx = p => p.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(loopGpx)}], 'runde.gpx'));
  const input = document.querySelector('#gpx-file'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('Standard-Kartenstil, Route füllt die Karte');
  for (const mobile of [false, true]) {
    const q = await newPage({ mobile });
    await q.open(app, { view: { center: [51.0, 9.0], zoom: 6 } }); // weit weg und klein: einpassen muss zoomen
    const base = await q.ev(`({ checked: [...document.querySelectorAll('.leaflet-control-layers-base label')].find(l => l.querySelector('input').checked)?.textContent.trim(),
      calm: !!document.querySelector('.leaflet-tile-pane .tiles-calm'), filter: getComputedStyle(document.querySelector('.leaflet-tile-pane .tiles-calm') || document.body).filter })`);
    if (!mobile) check('Standard ist „CyclOSM ruhig“ (blass), CyclOSM bleibt wählbar', base.checked === 'CyclOSM ruhig' && base.calm && /saturate/.test(base.filter)
      && await q.ev(`!!${baseInput('CyclOSM')}`), JSON.stringify(base));
    await openGpx(q);
    await q.waitFor(`!document.querySelector('#results').hidden && !!document.querySelector('#map path.route-hit')`, 15000); await sleep(1200);
    const fill = await q.ev(FILL);
    check(`${mobile ? 'Handy' : 'Rechner'}: Route füllt die Karte (≥ 60 % Breite oder Höhe)`, Math.max(fill.w, fill.h) >= 0.6, JSON.stringify(fill));
    if (!mobile) {
      const tip = await q.ev(`[...document.querySelectorAll('.leaflet-marker-icon')].map(m => m.title).join(' | ')`);
      check('Marker erklären sich: „ziehen …“ im Tooltip', /Start.* – ziehen zum Verschieben/.test(tip), tip);
      check('Profil-Punkt weiß mit dunklem Rand', await q.ev(`(() => { document.querySelector('#elevation-chart').focus();
        document.querySelector('#elevation-chart').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        return [...document.querySelectorAll('#map .leaflet-overlay-pane path')].some(p => p.getAttribute('fill') === '#fff' && p.getAttribute('stroke') === '#111827'); })()`));
      await q.shot('0-ruhig');
    }
  }

  const p = await newPage();
  // Ländliche Gegend: Dort hat CyclOSM für 19/20 fast nichts vorgerendert
  await p.open(app, { view: { center: [52.10, 13.70], zoom: 15 } });

  step('CyclOSM');
  let r = await zoomToMax(p, sleep);
  check('Höchstens Stufe 19, Plus-Knopf gesperrt', r.zoom === 19 && r.disabled, JSON.stringify(r));
  await p.waitFor(`document.querySelectorAll('.leaflet-tile-loaded').length > 4`, 20000);
  const t = await tiles(p);
  check('Kacheln der Stufe 18 geladen (vergrößert)', t.loaded > 0 && t.z === '18', JSON.stringify(t));
  await p.shot('1-cyclosm-19');

  step('OpenTopoMap');
  check('Im Menü gesperrt oberhalb von 17', await p.ev(`${baseInput('OpenTopoMap')}.disabled`));
  for (let i = 0; i < 2; i++) { await p.ev(`document.querySelector('.leaflet-control-zoom-out').click(); true`); await sleep(400); }
  await p.ev(`${baseInput('OpenTopoMap')}.click(); true`); await sleep(1200);
  check('Auf Stufe 17 wählbar', await p.ev(`!!document.querySelector('.leaflet-tile-pane img')?.src.includes('opentopomap')`), await zoom(p));
  r = await zoomToMax(p, sleep);
  check('Höchstens Stufe 17', r.zoom === 17 && r.disabled, JSON.stringify(r));

  for (const name of ['OpenStreetMap', 'Satellit', 'CyclOSM']) {
    step(name);
    await p.ev(`${baseInput(name)}.click(); true`); await sleep(500);
    r = await zoomToMax(p, sleep);
    check('Höchstens Stufe 19', r.zoom === 19 && r.disabled, JSON.stringify(r));
    await p.waitFor(`document.querySelectorAll('.leaflet-tile-loaded').length > 4`, 20000);
    const tt = await tiles(p);
    check('Kacheln geladen', tt.loaded > 4, JSON.stringify(tt));
  }

  step('Kurze Route einpassen');
  await p.ev(`(async () => { const w = await import('/js/app/waypoints.js');
    await w.setPoint('start', {lat: 52.1000, lon: 13.7000, label: 'A'}); await w.setPoint('end', {lat: 52.1012, lon: 13.7015, label: 'B'}); return true; })()`);
  await p.waitFor(`!document.querySelector('#results').hidden`, 60000); await sleep(1500);
  check('Höchstens Stufe 16', await zoom(p) <= 16, await zoom(p));
}
