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

export default async function ({ app, page: newPage, check, step, sleep }) {
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
