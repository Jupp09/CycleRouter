// Popups von Stopps, Trinkwasser und Café-Treffern: Öffnungszeiten (oder Hinweis, dass sie fehlen) und OSM-Links.
import { STATE, MAP, BONN, SUPPLY_DONE } from './lib/app.mjs';

export const title = 'Öffnungszeiten und OSM-Links';

const POPUP = `(() => { const p = document.querySelector('.leaflet-popup-content'); if (!p) return null;
  return { text: p.textContent, links: [...p.querySelectorAll('.links a')].map(a => [a.textContent, a.href, a.target, a.rel]) }; })()`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  const page = await newPage();
  const { ev, waitFor } = page;
  await page.open(app, { view: BONN, storage: { bike: 'trekking', supplyEnabled: true, supplyInterval: 8 } });
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route mit Stopps', await waitFor(SUPPLY_DONE, 150000));
  await sleep(1500);

  const checkLinks = (label, p, poi) => {
    const [type, num] = poi.id.split('/');
    const href = Object.fromEntries((p?.links || []).map(([text, h]) => [text, h]));
    check(`${label}: In OSM ansehen`, href['In OSM ansehen'] === `https://www.openstreetmap.org/${poi.id}`, href['In OSM ansehen']);
    check(`${label}: Bearbeiten`, href['Bearbeiten'] === `https://www.openstreetmap.org/edit?${type}=${num}`, href['Bearbeiten']);
    check(`${label}: Fehler melden`, /^https:\/\/www\.openstreetmap\.org\/note\/new\?lat=/.test(href['Fehler melden'] || ''));
    check(`${label}: neuer Tab, noopener`, !!p?.links.length && p.links.every(l => l[2] === '_blank' && l[3] === 'noopener'));
  };

  step('Verpflegungsstopps');
  const stops = await ev(`(async () => ${STATE}.route.stops.map(s => ({ id: s.poi.id, hours: s.poi.tags.opening_hours || null })))()`);
  check('Stopps vorhanden', stops.length > 0, stops.length);
  for (const [i, s] of stops.entries()) {
    await ev(`(async () => { ${MAP}.openStop(${JSON.stringify(s.id)}); return true; })()`); await sleep(600);
    const p = await ev(POPUP);
    if (i === 0) { checkLinks('Stopp', p, s); await page.shot('1-stopp'); }
    if (s.hours) {
      check(`Stopp ${i + 1}: Öffnungszeiten angezeigt`, p.text.includes(s.hours));
      check(`Stopp ${i + 1}: kein „fehlen“-Hinweis`, !/fehlen in OpenStreetMap/.test(p.text));
    } else {
      check(`Stopp ${i + 1}: Hinweis „Öffnungszeiten fehlen“`, /Öffnungszeiten fehlen in OpenStreetMap/.test(p.text));
    }
  }

  step('Trinkwasser');
  const w = await ev(`(async () => { const w = ${STATE}.route.water[0]; return w && { id: w.poi.id, key: w.poi.id + '@' + Math.round(w.along) }; })()`);
  if (check('Wasserstelle vorhanden', !!w)) {
    await ev(`(async () => { ${MAP}.openWater(${JSON.stringify(w.key)}); return true; })()`); await sleep(600);
    const p = await ev(POPUP);
    checkLinks('Wasser', p, w);
    check('Wasser: kein „fehlen“-Hinweis', !/fehlen in OpenStreetMap/.test(p?.text || ''));
  }

  step('Entlang der Route: Café');
  await ev(`(async () => { ${MAP}.closePopup(); [...document.querySelectorAll('#along-chips button')].find(b => /Café/.test(b.textContent)).click(); return true; })()`);
  check('Cafés gefunden', await waitFor(`document.querySelectorAll('#along-list li').length > 0`, 60000));
  await ev(`document.querySelector('#along-list li .row').click(); true`);
  await sleep(800);
  const p = await ev(POPUP);
  check('Café-Popup hat 3 OSM-Links', p?.links.length === 3 && p.links[1][1].includes('/edit?'), p?.links.map(l => l[0]).join(' · '));
  check('Café-Popup: Öffnungszeiten oder Hinweis', /Öffnungszeiten/.test(p?.text || ''), p?.text.slice(0, 160));
  await page.shot('2-cafe');
}
