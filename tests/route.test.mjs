// Grundabläufe: A→B per Kartenklick, Aufschlüsselung, Höhenprofil, Café-Suche + Übernahme, Verpflegungsstopps,
// Tempo, Löschen, Rundkurs, Heimat als Start.
import { BONN, HAS_ROUTE, IDLE, STATE, departNextWednesday } from './lib/app.mjs';

export const title = 'A → B, Stopps, Tempo, Rundkurs';

export default async function ({ app, page: newPage, check, step, sleep }) {
  const page = await newPage();
  const { ev, waitFor, text } = page;
  const q = sel => `document.querySelector(${JSON.stringify(sel)})`;
  await page.open(app, { view: BONN, storage: { bike: 'trekking', mode: 'ab' } });

  check('Startzustand: keine Ergebnisse', await ev(`${q('#results')}.hidden`));

  // Kopfzeile mit Symbolknöpfen, Routing-Optionen zugeklappt
  const head = await ev(`({ tools: [...document.querySelectorAll('.brand-tools button')].map(b => b.getAttribute('aria-label')),
    more: document.querySelector('#more-options').open, inMore: ['#eurovelo', '#provider'].every(s => document.querySelector(s).closest('#more-options')),
    oneRow: (() => { const t = [...document.querySelectorAll('.brand > *')].map(e => Math.round(e.getBoundingClientRect().top)); return Math.max(...t) - Math.min(...t) < 12; })() })`);
  check('Kopfzeile: Rückgängig, Wiederholen, GPX öffnen, Einstellungen als Symbole in einer Zeile',
    head.tools.join('|') === 'Rückgängig|Wiederholen|GPX-Datei öffnen|Einstellungen' && head.oneRow, JSON.stringify(head));
  check('„Mehr Optionen“ zugeklappt, EuroVelo und Routing-Dienst darin', !head.more && head.inMore);
  check('Satz für neue Besucher sichtbar', await ev(`getComputedStyle(document.querySelector('#tagline')).display !== 'none' && document.querySelector('#tagline').textContent.startsWith('Radrouten planen')`));
  check('„Mehr Optionen“ sagt, wo die Verpflegungsstopps sind', await ev(`[...document.querySelectorAll('#more-options .hint')].some(p => p.textContent.includes('Stopps unterwegs'))`));
  await ev(`(() => { const e = document.querySelector('#eurovelo'); e.value = 'prefer'; e.dispatchEvent(new Event('change')); return true; })()`);
  check('Zugeklappt nennt die Überschrift die aktive Option', await ev(`document.querySelector('#more-options summary').textContent`) === 'Mehr Optionen · EuroVelo bevorzugt',
    await ev(`document.querySelector('#more-options summary').textContent`));
  await ev(`(() => { const e = document.querySelector('#eurovelo'); e.value = 'off'; e.dispatchEvent(new Event('change')); return true; })()`);
  check('Routenart A → B aktiv', await ev(`${q('#mode-tabs [aria-checked=true]')}.dataset.mode`) === 'ab');

  step('A → B per Kartenklick');
  await page.clickMap(50.90, 6.97); await sleep(800);
  check('Start gesetzt, Marker da', await waitFor(`document.querySelectorAll('.marker-pin.start').length === 1`, 5000));
  await page.clickMap(50.76, 7.07);
  check('Route berechnet', await waitFor(HAS_ROUTE), await text('#stat-dist'));
  check('Mit Route ist der Satz weg', await ev(`getComputedStyle(document.querySelector('#tagline')).display === 'none'`));
  check('Name vorgeschlagen', /^Route \d+ km/.test(await ev(`${q('#route-name')}.value`)), await ev(`${q('#route-name')}.value`));
  check('Aufschlüsselung sichtbar', await ev(`!${q('#breakdown')}.hidden && document.querySelectorAll('#breakdown-legend li').length > 0`));
  const legendKm = await ev(`[...document.querySelectorAll('#breakdown-legend .km')].map(s => s.textContent)`);
  check('Keine Legendenzeile mit „0 km“', legendKm.length > 0 && !legendKm.includes('0 km'), legendKm.join(', '));
  check('Höhenprofil sichtbar', await ev(`!!${q('#elevation-chart')}.querySelector('svg')`));

  // Aufbau des Ergebnisses: drei Kacheln, Hinweise als Liste, Erklärtexte eingeklappt, Aktionen gebündelt
  const layout = await ev(`(() => {
    const tiles = [...document.querySelectorAll('.stats > div:not([hidden]) .k')].map(k => k.textContent);
    const facts = [...document.querySelectorAll('.facts > li')].map(li => li.id);
    const icon = getComputedStyle(document.querySelector('#daylight'), '::before').content;
    const dayCheck = !!document.querySelector('.stats + .day-check > #daylight');
    const more = [...document.querySelectorAll('details.more')];
    const block = document.querySelector('.route-actions');
    const order = [...block.querySelectorAll('h2, input, button')].filter(e => !e.closest('[hidden]')).map(e => e.id || e.tagName);
    const rowTop = id => document.getElementById(id).getBoundingClientRect().top;
    const fits = [...document.querySelectorAll('.stats > div')].every(d => d.scrollWidth <= d.clientWidth + 1);
    return { tiles, facts, icon, dayCheck, fits, more: more.length, closed: more.every(d => !d.open), order,
      oneRow: Math.abs(rowTop('btn-roadbook') - rowTop('btn-clear')) < 2,
      updown: document.querySelector('#stat-up').textContent + ' | ' + document.querySelector('#stat-down').textContent };
  })()`);
  check('Drei Kacheln ohne Abfahrt (keine „Ankunft“), Anstieg und Abstieg zusammen', layout.tiles.join('|') === 'Distanz|Höhenmeter|Reine Fahrzeit' && /^\d+ m \| \d+ m$/.test(layout.updown), `${layout.tiles.join('|')} – ${layout.updown}`);
  check('Kacheln ohne Überlauf', layout.fits);
  check('Hinweise als Liste mit Symbol', ['eurovelo-share', 'routing-fallback', 'station-hint', 'weather'].every(id => layout.facts.includes(id)), layout.facts.join(', '));
  check('Tageslicht direkt unter den Kacheln, mit Symbol', layout.dayCheck && /☀/.test(layout.icon), layout.icon);
  check('Erklärtexte eingeklappt', layout.more >= 2 && layout.closed, String(layout.more));
  check('Block „Route weiterverwenden“: Name, GPX, dann Roadbook … Löschen in einer Reihe',
    layout.order.join(',') === 'h-route-actions,route-name,btn-roadbook,btn-share-link,btn-clear' && layout.oneRow, layout.order.join(','));
  // Eingaben eingeklappt, Zusammenfassung mit „Ändern“; Stopps an einer Stelle
  const plan = `({ hidden: document.querySelector('#plan').hidden, summary: document.querySelector('#plan-summary').hidden ? null : document.querySelector('#plan-summary-text').textContent,
    button: document.querySelector('#btn-plan-edit').textContent, expanded: document.querySelector('#btn-plan-edit').getAttribute('aria-expanded') })`;
  let pl = await ev(plan);
  check('Nach dem Berechnen eingeklappt: eine Zeile mit Start, Ziel und Fahrrad', pl.hidden && /^A → B · .+ → .+ · Fahrrad$/.test(pl.summary || '') && pl.button === 'Ändern' && pl.expanded === 'false', JSON.stringify(pl));
  await ev(`document.querySelector('#btn-plan-edit').click(); true`);
  pl = await ev(plan);
  check('„Ändern“ klappt auf', !pl.hidden && pl.button === 'Einklappen' && pl.expanded === 'true', JSON.stringify(pl));
  await ev(`document.querySelector('#btn-plan-edit').click(); true`);
  check('„Einklappen“ klappt wieder zu', (await ev(plan)).hidden);
  const stopsSection = await ev(`(() => { const s = document.querySelector('.stops-section');
    return ['#supply-enabled', '#stops', '#water', '#along-chips'].every(sel => s.contains(document.querySelector(sel))) && s.querySelector('h2').textContent; })()`);
  check('„Stopps unterwegs“: Verpflegung, Stoppliste, Trinkwasser und „Entlang der Route“ zusammen', stopsSection === 'Stopps unterwegs', String(stopsSection));
  check('GPX-Export direkt unter Kacheln und Tageslicht, ohne Mehrtagestour-Angebot als Hauptaktion', await ev(`document.querySelector('.day-check').nextElementSibling?.id === 'btn-gpx'
    && document.querySelector('#btn-gpx').classList.contains('primary')`));
  await page.shot('1-ergebnis');
  await ev(`document.querySelector('.route-actions').scrollIntoView({ block: 'end' }); true`); await sleep(200);
  await page.shot('2-aktionen');

  await ev(`${q('#breakdown-switch [data-value=waytype]')}.click(); true`);
  check('Wegtyp-Schalter', await ev(`${q('#breakdown-switch [data-value=waytype]')}.getAttribute('aria-checked') === 'true' && ${q('#breakdown-hint')}.hidden`));
  await ev(`${q('#breakdown-switch [data-value=surface]')}.click(); true`);

  step('Entlang der Route: Café suchen und übernehmen');
  const cafeChip = `[...document.querySelectorAll('#along-chips button')].find(b => b.textContent.includes('Café'))`;
  await ev(`${cafeChip}.click(); true`);
  await waitFor(`!${q('#along-hint')}.textContent.includes('gesucht')`, 90000);
  const n = await ev(`document.querySelectorAll('#along-list li').length`);
  check('Café-Suche liefert Treffer', n > 0, `${n} – ${await text('#along-hint')}`);
  check('Chip gedrückt', await ev(`${cafeChip}.getAttribute('aria-pressed')`) === 'true');
  if (n > 0) {
    const name = await ev(`${q('#along-list li .name')}.textContent`);
    await ev(`${q('#along-list li .add')}.click(); true`);
    check('Als Zwischenstopp übernommen', await waitFor(`document.querySelector('.via-row input')?.value === ${JSON.stringify(name)}`, 10000), name);
    await waitFor(`!${q('#status')}.classList.contains('loading')`, 60000); await sleep(1500);
    check('Nicht mehr in der Trefferliste', !(await ev(`[...document.querySelectorAll('#along-list .name')].some(e => e.textContent === ${JSON.stringify(name)})`)));
    check('Zwischenstopp-Marker', await ev(`document.querySelectorAll('.marker-pin.manual, .via-pin').length`) >= 1);
  }

  step('Verpflegungsstopps');
  await departNextWednesday(page, '09:00');
  await ev(`{ const i = ${q('#supply-interval')}; i.value = 10; i.dispatchEvent(new Event('change')); ${q('#supply-enabled')}.click(); } true`);
  check('Optionen eingeblendet', await ev(`!${q('#supply-options')}.hidden`));
  check('Stopps geplant', await waitFor(`!${q('#stops')}.hidden && (document.querySelectorAll('#stop-list li').length || !${q('#stop-gaps')}.hidden)`, 120000));
  check('Stopp-Hinweis', !!(await text('#stop-gaps')), await text('#stop-gaps'));
  check('Stopp-Marker = Listenzeilen', await ev(`document.querySelectorAll('.stop-pin').length === document.querySelectorAll('#stop-list li').length`));
  await ev(`document.querySelector('#stop-list button.row')?.click(); true`);
  check('Stopp-Zeile öffnet den Stopp auf der Karte', await waitFor(`!!document.querySelector('.leaflet-popup .stop-popup')`, 5000));
  const label = await ev(`document.querySelector('.stop-pin')?.closest('.leaflet-marker-icon')?.getAttribute('aria-label') || ''`);
  check('Stopp-Marker benannt', /^Verpflegungsstopp 1: /.test(label), label);
  check('Zwischenstopp bleibt erhalten', await ev(`document.querySelectorAll('.via-row').length`) === (n > 0 ? 1 : 0));
  await page.shot('1-stopps');

  step('Tempo ändern → Fahrzeit neu');
  const timeBefore = await text('#stat-time');
  await ev(`${q('#btn-settings')}.click(); true`); await sleep(300);
  check('Einstellungsdialog offen', await ev(`${q('#settings-dialog')}.open`));
  await ev(`{ const r = ${q('#speed-range')}; r.value = 30; r.dispatchEvent(new Event('input')); } true`);
  check('Tempo-Anzeige', (await text('#speed-out')) === '30 km/h', await text('#speed-out'));
  await ev(`${q('#settings-dialog')}.close('save'); true`);
  await sleep(500);
  await waitFor(`!${q('#status')}.classList.contains('loading') || ${q('#status')}.hidden`, 90000); await sleep(1000);
  const timeAfter = await text('#stat-time');
  const toMin = s => (+(/(\d+) h/.exec(s)?.[1] || 0)) * 60 + +(/(\d+) min/.exec(s)?.[1] || 0);
  check('Fahrzeit nach Tempoänderung kürzer', toMin(timeAfter) < toMin(timeBefore), `${timeBefore} → ${timeAfter}`);
  check('Tooltip mit neuem Tempo', (await ev(`${q('#stat-time')}.title`)).startsWith('Ø 30 km/h'), await ev(`${q('#stat-time')}.title`));
  await ev(`${q('#supply-enabled')}.click(); true`);
  check('Stopps aus → Liste weg', await waitFor(`${q('#stops')}.hidden`, 30000));

  step('Löschen');
  await ev(`${q('#btn-clear')}.click(); true`); await sleep(500);
  check('Ergebnisse, Ziel und Zwischenstopps leer', await ev(`${q('#results')}.hidden && !${q('#end-input')}.value && !document.querySelectorAll('.via-row').length`));
  check('Café-Suche zurückgesetzt', await ev(`${q('#along-hint')}.hidden && !document.querySelectorAll('#along-list li').length`));

  step('Rundkurs');
  await ev(`${q('#mode-tabs [data-mode=loop]')}.click(); true`); await sleep(300);
  await ev(`{ const n = ${q('#distance-num')}; n.value = 25; n.dispatchEvent(new Event('change')); } true`);
  check('Distanz übernommen', (await text('#distance-out')) === '25 km', await text('#distance-out'));
  await ev(`${q('#btn-generate')}.click(); true`);
  check('Rundkurs erzeugt', await waitFor(`!${q('#results')}.hidden && ${q('#route-name')}.value.startsWith('Rundkurs')`, 120000),
    `${await text('#stat-dist')} – ${await ev(`${q('#route-name')}.value`)}`);
  check('Rundkurs: nur Start-Marker', await ev(`document.querySelectorAll('.marker-pin.start').length === 1 && document.querySelectorAll('.marker-pin.end').length === 0`));
  // Fingerabdruck des Wegs: Neu würfeln kann zufällig dieselbe Distanz (auf 0,1 km) ergeben
  const shape = `(async () => { const c = ${STATE}.route?.coords || [];
    return JSON.stringify([c.length, ...[0.2, 0.4, 0.6, 0.8, 1].map(f => c[Math.floor(f * (c.length - 1))]?.slice(0, 2))]); })()`;
  const before = await ev(shape);
  await ev(`${q('#btn-reroll')}.click(); true`);
  check('Neu würfeln: anderer Weg', await waitFor(`(async () => (await ${shape}) !== ${JSON.stringify(before)} && ${IDLE})()`, 120000),
    `${await text('#stat-dist')}`);
  await page.shot('2-rundkurs');

  step('Heimat als Start beim Laden');
  await ev(`localStorage.setItem('cyclerouter.home', JSON.stringify({lat: 50.94, lon: 6.96, label: 'Testheimat Köln'}));
    localStorage.setItem('cyclerouter.mode', '"ab"');
    history.replaceState(null, '', location.pathname); true`); // sonst stellt die Adresse (#v=1…) den Rundkurs wieder her
  await page.reload();
  check('Heimat als Start', (await ev(`${q('#start-input')}.value`)) === 'Testheimat Köln' && !(await ev(`${q('#btn-home')}.hidden`)));
}
