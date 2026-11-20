// Tageslicht: Sonnenauf- und -untergang (js/sun.js) und der Hinweis im Ergebnis – ohne festgelegte Abfahrt nur
// der helle Tag heute, mit Abfahrt (im Formular oder mit Verpflegungsstopps) die Warnung vor Fahrt im Dunkeln.
import { BONN, HAS_ROUTE, SUPPLY_DONE, departNextWednesday } from './lib/app.mjs';

export const title = 'Tageslicht';

const NOTE = `(() => { const el = document.querySelector('#daylight'); return { hidden: el.hidden, text: el.textContent, warn: el.classList.contains('warn') }; })()`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('Berechnung');
  let page = await newPage();
  await page.open(app, { view: BONN });
  // Bonn am 11.11.2026: 07:39–16:51 MEZ (übliche Tabellen: 07:38/16:51)
  const sun = await page.ev(`(async () => { const { sunTimes } = await import('/js/sun.js');
    const min = d => d.getUTCHours() * 60 + d.getUTCMinutes();
    const t = sunTimes(50.7374, 7.0982, new Date(2026, 10, 11)), s = sunTimes(53.55, 9.99, new Date(2026, 5, 21));
    return { rise: min(t.rise), set: min(t.set), summerRise: min(s.rise), summerSet: min(s.set), polar: sunTimes(69.65, 18.96, new Date(2026, 5, 21)) }; })()`);
  const near = (a, b) => Math.abs(a - b) <= 3;
  check('Bonn im November', near(sun.rise, 6 * 60 + 39) && near(sun.set, 15 * 60 + 51), JSON.stringify(sun));
  check('Hamburg zur Sommersonnenwende', near(sun.summerRise, 2 * 60 + 50) && near(sun.summerSet, 19 * 60 + 53));
  check('Polartag: keine Zeiten', sun.polar === null);

  step('Ohne festgelegte Abfahrt');
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  let note = await page.ev(NOTE);
  check('Heller Tag heute, keine Warnung', !note.hidden && /^Tageslicht heute am Start: \d\d:\d\d–\d\d:\d\d \(/.test(note.text) && !note.warn, note.text);
  await page.shot('1-ohne-abfahrt');

  step('Abfahrt im Formular, ohne Verpflegungsstopps');
  await page.ev(`(() => { const d = new Date(); d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7));
    const pad = n => String(n).padStart(2, '0');
    const el = document.querySelector('#plan-departure');
    el.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T12:00';
    el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check('Kachel „Ankunft“ erscheint', await page.waitFor(`!document.querySelector('#stat-arrival-tile').hidden`, 60000));
  note = await page.ev(NOTE);
  check('Hinweis rechnet mit der Abfahrt statt mit heute', !note.hidden && !note.text.startsWith('Tageslicht heute'), note.text);

  step('Abfahrt um 05:00');
  page = await newPage();
  await page.open(app, { view: BONN, storage: { bike: 'trekking', supplyEnabled: true, supplyInterval: 30 } });
  await departNextWednesday(page, '05:00');
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route mit Stopps', await page.waitFor(SUPPLY_DONE, 150000));
  note = await page.ev(NOTE);
  // Im Sommer geht die Sonne vor 05:00 auf – dann ist die Abfahrt schon hell
  const early = await page.ev(`(async () => (await import('/js/sun.js')).sunTimes(50.94, 6.95, new Date(document.querySelector('#departure').value)).rise.getHours() >= 5)()`);
  if (early) check('Warnung vor Sonnenaufgang', /^(Abfahrt 05:00, Sonnenaufgang \d\d:\d\d – etwa .+ im Dunkeln\.|Ankunft ca\. \d\d:\d\d vor Sonnenaufgang \(\d\d:\d\d\) – Fahrt im Dunkeln\.)$/.test(note.text) && note.warn, note.text);
  else check('Im Sommer: Abfahrt um 05:00 schon hell', !note.warn, note.text);
  await page.shot('2-vor-sonnenaufgang');

  step('Abfahrt um 12:00');
  await departNextWednesday(page, '12:00');
  check('Hinweis neu berechnet', await page.waitFor(`document.querySelector('#daylight').textContent.startsWith('Tageslicht ') && ${SUPPLY_DONE}`, 150000));
  note = await page.ev(NOTE);
  check('Ankunft vor Sonnenuntergang, keine Warnung', / – Ankunft ca\. \d\d:\d\d, .+ vor Sonnenuntergang\.$/.test(note.text) && !note.warn, note.text);
  const times = await page.ev(`(async () => { const { state, departureDate } = await import('/js/app/state.js');
    const { dayTimes } = await import('/js/timeline.js');
    const [d] = dayTimes(state.route, departureDate(), state.bike), last = state.route.stops.at(-1);
    return { end: d.end.getTime(), lastStop: last ? last.eta.getTime() : null, clock: d.end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) }; })()`);
  check('Ankunft im Hinweis = Ankunft am Ziel', note.text.includes(`Ankunft ca. ${times.clock}`), times.clock);
  check('Kachel „Ankunft“ mit derselben Zeit', await page.ev(`!document.querySelector('#stat-arrival-tile').hidden
    && document.querySelector('#stat-arrival').textContent`) === times.clock, times.clock);
  if (times.lastStop) check('Ankunft liegt nach dem letzten Stopp', times.end > times.lastStop);

  step('Abfahrt im Formular leeren, während Stopps an sind');
  const before = await page.ev(`document.querySelector('#departure').value`);
  await page.ev(`{ const el = document.querySelector('#plan-departure'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); } true`);
  const after = await page.ev(`({ form: document.querySelector('#plan-departure').value, supply: document.querySelector('#departure').value, status: document.querySelector('#status').textContent })`);
  check('Abfahrt bleibt, Formular zeigt sie wieder, Statuszeile sagt warum',
    after.supply === before && after.form === before && after.status.startsWith('Verpflegungsstopps brauchen eine Abfahrt'), JSON.stringify(after));
}
