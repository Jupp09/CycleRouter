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

  step('Mit der Maus und per Tastatur');
  const focusedIn = sel => ev(`!!document.activeElement?.closest(${JSON.stringify(sel)})`);
  await ev(`(async () => { ${MAP}.closePopup(); return true; })()`); await sleep(300);
  // Echter Mausklick auf die Stopp-Zeile: Popup geht auf, der Fokus bleibt auf der Zeile
  const rect = await ev(`(() => { const b = document.querySelector('#stop-list button.row'); b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.click(rect.x, rect.y); await sleep(600);
  check('Maus: Popup offen', await ev(`!!document.querySelector('.leaflet-popup .stop-popup')`));
  check('Maus: Fokus bleibt außerhalb des Popups', !(await focusedIn('.leaflet-popup')), await ev(`document.activeElement?.className`));
  await ev(`(async () => { ${MAP}.closePopup(); return true; })()`); await sleep(300);
  // Tab von davor auf die Zeile: so gilt :focus-visible wie bei echter Tastaturbedienung
  await ev(`(() => { const rows = [...document.querySelectorAll('#stop-list button.row')]; rows[0].focus(); return true; })()`);
  await page.key('Tab', { shift: true }); await page.key('Tab');
  check('Stopp-Zeile hat den Fokus', await focusedIn('#stop-list'));
  await page.key('Enter'); await sleep(600);
  check('Enter: Popup offen, Fokus darin', await focusedIn('.leaflet-popup'), await ev(`document.activeElement?.className`));
  check('Schließen-Knopf auf Deutsch', await ev(`document.querySelector('.leaflet-popup-close-button')?.getAttribute('aria-label')`) === 'Schließen');
  await page.key('Tab');
  check('Tab erreicht die Links im Popup', await focusedIn('.leaflet-popup'), await ev(`document.activeElement?.textContent`));
  await page.key('Escape'); await sleep(400);
  check('Escape schließt das Popup', await ev(`!document.querySelector('.leaflet-popup')`));
  check('Fokus zurück auf der Stopp-Zeile', await focusedIn('#stop-list'), await ev(`document.activeElement?.className`));
}
