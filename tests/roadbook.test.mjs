// Roadbook (js/app/roadbookView.js): Inhalt für eine Tagestour mit Stopps und für eine Mehrtagestour, und die
// Druckansicht zeigt nur das Roadbook. Der Druckdialog selbst wird im Test ersetzt.
import { STATE, BONN, HAS_ROUTE, SUPPLY_DONE, IDLE, departNextWednesday } from './lib/app.mjs';

export const title = 'Roadbook drucken';

const NO_DIALOG = `window.print = () => { window.__printed = (window.__printed || 0) + 1; }; true`;
const BOOK = `(() => { const b = document.querySelector('#roadbook'), all = s => [...b.querySelectorAll(s)];
  return { title: b.querySelector('h1')?.textContent, facts: b.querySelector('header .rb-facts')?.textContent,
    days: all('.rb-day h2').map(h => h.textContent), heads: all('table th').map(th => th.textContent).slice(0, 5),
    rows: all('.rb-day').map(d => [...d.querySelectorAll('table tr')].slice(1).map(tr => [...tr.children].map(td => td.textContent))),
    stays: all('.rb-stay').map(s => s.textContent), times: all('.rb-day').map(d => d.children[2]?.textContent),
    footer: b.querySelector('footer')?.textContent, printed: window.__printed || 0,
    screen: getComputedStyle(b).display, cls: document.documentElement.classList.contains('print-roadbook') }; })()`;
const VISIBLE = `({ book: getComputedStyle(document.querySelector('#roadbook')).display, app: getComputedStyle(document.querySelector('main')).display,
  aside: getComputedStyle(document.querySelector('aside')).display, height: document.querySelector('#roadbook').offsetHeight })`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('Ohne Route: Strg+P druckt die Seite wie bisher');
  let page = await newPage({ height: 950 });
  await page.open(app, { view: BONN, storage: { bike: 'trekking', supplyEnabled: true, supplyInterval: 8 } });
  await page.ev(NO_DIALOG);
  const idle = await page.ev(`(() => { window.dispatchEvent(new Event('beforeprint'));
    return document.documentElement.classList.contains('print-roadbook') || document.querySelector('#roadbook').children.length > 0; })()`);
  check('Kein Roadbook ohne Route', idle === false);

  step('Tagestour mit Verpflegungsstopps');
  await departNextWednesday(page, '09:00');
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route mit Stopps', await page.waitFor(SUPPLY_DONE, 150000));
  await page.ev(`document.querySelector('#route-name').value = 'Köln–Bonn am Rhein'; true`);
  await page.ev(`document.querySelector('#btn-roadbook').click(); true`); await sleep(300);
  let book = await page.ev(BOOK);
  check('Druckdialog einmal aufgerufen, am Bildschirm unsichtbar', book.printed === 1 && book.screen === 'none', JSON.stringify([book.printed, book.screen]));
  check('Kopf: Name und Kennzahlen', book.title === 'Köln–Bonn am Rhein' && /^Fahrrad · [\d,]+ km · \d+ m Anstieg · Fahrzeit ca\. .+ · Mi\.?, \d\d\.\d\d\.$/.test(book.facts), book.facts);
  check('Ein Tag mit Datum', book.days.length === 1 && /^Tag 1 · Mi\.?, \d\d\.\d\d\.$/.test(book.days[0]), book.days.join());
  check('Abfahrt und Ankunft', /^Abfahrt 09:00 · Ankunft ca\. \d\d:\d\d \(mit Pausen an den Stopps\)$/.test(book.times[0]), book.times[0]);
  check('Tabellenkopf', book.heads.join('|') === 'km|Ankunft|Art|Name|Öffnungszeiten / Hinweis', book.heads.join('|'));
  const expected = await page.ev(`(async () => { const r = ${STATE}.route; const clock = d => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return { stops: r.stops.map(s => clock(s.eta) + ' ' + (s.poi.name || s.typeLabel)), water: r.water.length, hours: r.stops.filter(s => s.poi.tags.opening_hours).map(s => s.poi.tags.opening_hours) }; })()`);
  const rows = book.rows[0];
  const stopRows = rows.filter(r => r[2] !== 'Trinkwasser').map(r => `${r[1]} ${r[3]}`);
  check('Stopps mit denselben Ankunftszeiten wie in der Stoppliste', expected.stops.length >= 1 && stopRows.join('|') === expected.stops.join('|'), stopRows.join(' | '));
  check('Trinkwasserstellen stehen in der Tabelle', rows.filter(r => r[2] === 'Trinkwasser').length === expected.water, `${expected.water}`);
  check('Reihenfolge nach km', rows.every((r, i) => !i || parseFloat(r[0].replace(',', '.')) >= parseFloat(rows[i - 1][0].replace(',', '.'))));
  check('Öffnungszeiten stehen dabei', expected.hours.every(h => rows.some(r => r[4].includes(h))), expected.hours[0]);
  check('Fuß mit Quelle', /OpenStreetMap-Mitwirkende/.test(book.footer) && /ohne Gewähr/.test(book.footer));

  step('Druckansicht');
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  const print = await page.ev(VISIBLE);
  check('Nur das Roadbook ist sichtbar', print.book === 'block' && print.app === 'none' && print.height > 200, JSON.stringify(print));
  await page.shot('1-druckansicht');
  await page.send('Emulation.setEmulatedMedia', { media: '' });
  await page.ev(`window.dispatchEvent(new Event('afterprint')); true`);
  const after = await page.ev(VISIBLE);
  check('Danach wieder die App', after.book === 'none' && after.app !== 'none' && !(await page.ev(BOOK)).cls, JSON.stringify(after));

  step('Mehrtagestour');
  page = await newPage({ height: 950 });
  await page.open(app, { view: { center: [53.3, 9.4], zoom: 9 }, storage: { bike: 'trekking', mode: 'ab', stageMaxKm: 50 } });
  await page.ev(NO_DIALOG);
  await page.clickMap(53.064, 8.793); await sleep(800);
  await page.clickMap(53.553, 10.0067);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  await page.ev(`document.querySelector('#btn-multiday').click(); true`);
  check('Etappen geplant', await page.waitFor(`!document.querySelector('#stages-body').hidden && document.querySelectorAll('#stage-list > li').length >= 3 && ${IDLE}`, 180000));
  await page.ev(`document.querySelector('#btn-roadbook').click(); true`); await sleep(300);
  book = await page.ev(BOOK);
  const plan = await page.ev(`(async () => { const r = ${STATE}.route; return { days: document.querySelectorAll('#stage-list > li').length,
    nights: r.stays.nights.length, chosen: r.stays.nights.filter(n => n.chosen).map(n => n.chosen.poi.name).filter(Boolean) }; })()`);
  check('Ein Block je Tag', book.days.length === plan.days && book.days.every((d, i) => d.startsWith(`Tag ${i + 1} · `)), book.days.join(' | '));
  check('Kopf nennt Zeitraum und Zahl der Tage', new RegExp(` · ${plan.days} Tage · .+ – .+$`).test(book.facts), book.facts);
  check('Unterkunft je Nacht', book.stays.length === plan.nights && plan.chosen.every(name => book.stays.some(s => s.includes(name))), book.stays[0]);
  check('Unterkunft mit Art und geschätztem Preis', book.stays.filter(s => /Preis (ca\. \d+–\d+ €|\d+ € \(laut OSM\)) \(Schätzung\)/.test(s)).length === plan.chosen.length, book.stays[0]);
  await page.send('Emulation.setEmulatedMedia', { media: 'print' });
  await page.shot('2-mehrtagestour');
  await page.send('Emulation.setEmulatedMedia', { media: '' });

  step('Installierte App auf dem iPhone: anzeigen statt drucken');
  page = await newPage({ height: 950 });
  // navigator.standalone gibt es nur in Safari auf iOS; vor dem Laden der Module vortäuschen
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(navigator, 'standalone', { value: true });` });
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });
  await page.ev(NO_DIALOG);
  const label = await page.ev(`document.querySelector('#btn-roadbook').textContent`);
  check('Knopf heißt „Roadbook anzeigen“', label === 'Roadbook anzeigen', label);
  await page.clickMap(50.735, 7.10); await sleep(800);
  await page.clickMap(50.70, 7.15);
  check('Route berechnet', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 120000));
  // Erst jetzt auf Handybreite: Im schmalen Layout treffen die Kartenklicks oben nicht
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await sleep(300);
  await page.ev(`document.querySelector('#btn-roadbook').click(); true`); await sleep(300);
  const DIALOG = `(() => { const d = document.querySelector('#roadbook-dialog'), v = d.querySelector('#roadbook-view');
    return { open: d.open, printed: window.__printed || 0, title: v.querySelector('header h2')?.textContent, days: v.querySelectorAll('.rb-day').length,
      headings: [...d.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(h => h.tagName).filter((t, i, a) => t !== a[i - 1]).join(' '),
      untouched: !document.querySelector('#roadbook').children.length, hint: document.querySelector('#roadbook-hint').textContent,
      cls: document.documentElement.classList.contains('print-roadbook'), width: v.scrollWidth <= v.clientWidth + 1 }; })()`;
  const shown = await page.ev(DIALOG);
  check('Dialog mit dem Roadbook, kein Druckaufruf', shown.open && shown.printed === 0 && !shown.cls && shown.days === 1 && !!shown.title, JSON.stringify(shown));
  check('Überschriften in richtiger Reihenfolge', shown.headings === 'H2 H3', shown.headings);
  // Ohne Server-Datenbank (wie im Test) gibt es keine Links: Der Hinweis sagt, dass die Route in Safari fehlt
  check('Hinweis auf Safari, Druckvorlage unberührt', /^Drucken und als PDF sichern geht nur in Safari; dort muss die Route neu geplant werden\.$/.test(shown.hint) && shown.untouched, shown.hint);
  check('Passt in die Breite des Handys', shown.width);
  const axe = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js')).text();
  await page.ev(axe + '; true');
  const violations = await page.ev(`axe.run(document.querySelector('#roadbook-dialog'), { resultTypes: ['violations'] })
    .then(r => r.violations.map(v => v.id + ' (' + v.nodes.length + '×)'))`);
  check('axe: 0 Verstöße im Dialog', Array.isArray(violations) && !violations.length, JSON.stringify(violations));
  await page.shot('3-iphone-app');

  // Stopps und Unterkünfte kommen oft erst nach dem Öffnen: Eine neue Route baut den offenen Dialog neu
  // (Den Namen zu ändern taugt dafür nicht: Beim Ereignis route setzt routesView das Namensfeld zurück.)
  const rebuilt = await page.ev(`(async () => { document.querySelector('#roadbook-view header').dataset.alt = '1';
    const { emit, state } = await import('/js/app/state.js'); emit('route', state.route);
    const h = document.querySelector('#roadbook-view header'); return !!h && !h.dataset.alt; })()`);
  check('Neue Route baut den offenen Dialog neu', rebuilt);
  await page.ev(`(async () => { const { emit } = await import('/js/app/state.js'); emit('route', null); return true; })()`);
  check('Ohne Route schließt sich der Dialog', !(await page.ev(DIALOG)).open);

  await page.ev(`document.querySelector('#btn-roadbook').click(); true`); await sleep(300);
  await page.ev(`document.querySelector('#roadbook-dialog button[value=close]').click(); true`); await sleep(200);
  const closed = await page.ev(`({ open: document.querySelector('#roadbook-dialog').open, empty: !document.querySelector('#roadbook-view').children.length })`);
  check('Schließen leert den Dialog', !closed.open && closed.empty, JSON.stringify(closed));
}
