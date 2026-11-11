// Wetter entlang der Route (js/weather.js, Open-Meteo): Gegenwind-Rechnung, Zusammenfassung und Abschnittsliste,
// „Abfahrt jetzt“ ohne festgelegte Abfahrt, Hinweis jenseits der Vorhersage, Vorschlag zur Lage eines Rundkurses.
import { STATE, BONN, HAS_ROUTE, SUPPLY_DONE, IDLE, departNextWednesday } from './lib/app.mjs';

export const title = 'Wetter und Wind';

const BOX = `(() => { const q = s => document.querySelector(s); return {
  hidden: q('#weather').hidden, summary: [...q('#weather-summary').children].map(p => p.textContent),
  rows: [...q('#weather-list').children].map(li => li.textContent), details: !q('#weather-details').hidden,
  link: q('#weather a')?.href }; })()`;
const LOADED = `!document.querySelector('#weather').hidden && !document.querySelector('#weather-details').hidden`;
const SUMMARY = /^-?\d+(–-?\d+)? °C · (trocken|Regen möglich \(\d+ %\)|Regen wahrscheinlich ab ca\. \d\d:\d\d \(\d+ %\)) · ((Gegen|Rücken)wind auf \d+ % der Strecke, im Mittel \d+ km\/h|Seitenwind|schwacher Wind|kaum Wind)( · Böen bis \d+ km\/h)?$/;
const ROW = /^km \d+–\d+ · \d\d:\d\d · -?\d+ °C · Regen \d+ %( \([\d,]+ mm\))? · ((Gegen|Rücken|Seiten)wind \d+ km\/h|schwacher Wind|kaum Wind)$/;

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('Gegenwind-Rechnung');
  let page = await newPage();
  await page.open(app, { view: BONN });
  const w = await page.ev(`(async () => { const { headwind, windLabel } = await import('/js/weather.js');
    return { north: headwind(20, 0, 0), south: headwind(20, 0, 180), east: headwind(20, 0, 90),
      labels: [windLabel({ head: 12, wind: 14 }), windLabel({ head: -8, wind: 9 }), windLabel({ head: 1, wind: 20 }), windLabel({ head: 1, wind: 10 }), windLabel({ head: 1, wind: 6 })] }; })()`);
  check('Nordwind: von vorn, von hinten, von der Seite', Math.abs(w.north - 20) < 0.01 && Math.abs(w.south + 20) < 0.01 && Math.abs(w.east) < 0.01, JSON.stringify(w));
  check('Bezeichnungen', w.labels.join('|') === 'Gegenwind 12 km/h|Rückenwind 8 km/h|Seitenwind 20 km/h|schwacher Wind|kaum Wind', w.labels.join('|'));

  step('Vorschlag zur Lage (Rechnung)');
  const adv = await page.ev(`(async () => { const { windAdvice } = await import('/js/weather.js');
    // Zwei Hälften je 10 km; Wind aus Nordwest (315°)
    const s = (head1, head2, wind = 20, dir = 315) => [{ from: 0, to: 10000, wind, dir, head: head1 }, { from: 10000, to: 20000, wind, dir, head: head2 }];
    const show = a => (a ? a.direction + ' ' + a.target + ' ' + a.from : null);
    return { loop: show(windAdvice(s(-15, 15), 'loop')), loopFine: show(windAdvice(s(15, -15), 'loop')), weak: show(windAdvice(s(-6, 6, 8), 'loop')),
      oneWay: show(windAdvice(s(15, 15), 'distance')), oneWayFine: show(windAdvice(s(-15, -15), 'distance')), ab: show(windAdvice(s(15, 15), 'ab')),
      turning: show(windAdvice([{ from: 0, to: 10000, wind: 20, dir: 0, head: -15 }, { from: 10000, to: 20000, wind: 20, dir: 180, head: 15 }], 'loop')) }; })()`);
  check('Rundkurs mit Gegenwind auf dem Rückweg: dorthin legen, woher der Wind kommt', adv.loop === '315 Nordwesten Nordwesten', adv.loop);
  check('Start + Distanz mit Gegenwind: Ziel mit dem Wind', adv.oneWay === '135 Südosten Nordwesten', adv.oneWay);
  check('Kein Vorschlag bei Rückenwind, schwachem oder drehendem Wind und bei A → B',
    [adv.loopFine, adv.weak, adv.oneWayFine, adv.ab, adv.turning].every(x => x === null), JSON.stringify(adv));

  step('Ohne festgelegte Abfahrt');
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  check('Wetter geladen', await page.waitFor(LOADED, 20000));
  let box = await page.ev(BOX);
  const now = box.summary[0]?.match(/^Wetter bei Abfahrt jetzt \(\d\d:\d\d\): (.+)$/);
  check('Zusammenfassung „Abfahrt jetzt“', box.summary.length === 1 && !!now && SUMMARY.test(now[1]), box.summary[0]);
  check('Abschnitte (etwa alle 10 km)', box.rows.length >= 2 && box.rows.every(x => ROW.test(x)), `${box.rows.length}: ${box.rows[0]}`);
  check('Quellenangabe', box.link === 'https://open-meteo.com/', box.link);
  await page.ev(`document.querySelector('#weather-details').open = true`);
  await page.shot('1-wetter');

  step('Mit Abfahrt am Mittwoch');
  page = await newPage();
  await page.open(app, { view: BONN, storage: { bike: 'trekking', supplyEnabled: true, supplyInterval: 30 } });
  await departNextWednesday(page, '10:00');
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route mit Stopps', await page.waitFor(SUPPLY_DONE, 150000));
  check('Wetter geladen', await page.waitFor(LOADED, 20000));
  box = await page.ev(BOX);
  const wed = box.summary[0]?.match(/^Wetter bei Abfahrt Mi\.? 10:00: (.+)$/);
  check('Zusammenfassung mit Abfahrt', !!wed && SUMMARY.test(wed[1]), box.summary[0]);
  const requests = await page.ev(`performance.getEntriesByType('resource').filter(e => e.name.includes('open-meteo')).length`);
  check('Sparsam: höchstens 2 Anfragen trotz mehrfacher Anzeige', requests >= 1 && requests <= 2, requests);

  step('Abfahrt jenseits der Vorhersage');
  await page.ev(`(() => { const d = document.querySelector('#departure'), n = new Date(); n.setDate(n.getDate() + 20);
    const pad = x => String(x).padStart(2, '0');
    d.value = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()) + 'T10:00';
    d.dispatchEvent(new Event('change')); return true; })()`);
  check('Hinweis statt Wetter', await page.waitFor(`/^Eine Wettervorhersage gibt es ab dem \\d\\d\\.\\d\\d\\.\\d{4}/.test(document.querySelector('#weather-summary').textContent)
    && document.querySelector('#weather-details').hidden`, 30000), (await page.ev(BOX)).summary[0]);

  step('Rundkurs nach Süden bei Nordwind (Wetter im Test fest vorgegeben)');
  page = await newPage();
  await page.open(app, { view: BONN, storage: { bike: 'trekking', mode: 'loop' } });
  // Open-Meteo durch gleichmäßigen Nordwind mit 25 km/h ersetzen – der Vorschlag hängt sonst vom echten Wetter ab
  await page.ev(`(() => { const real = window.fetch;
    window.fetch = (url, opts) => {
      if (!String(url).includes('open-meteo')) return real(url, opts);
      const q = new URL(url).searchParams, n = q.get('latitude').split(',').length, time = [];
      for (let t = Date.parse(q.get('start_date') + 'T00:00Z'); t <= Date.parse(q.get('end_date') + 'T23:00Z'); t += 3600000) time.push(new Date(t).toISOString().slice(0, 16));
      const fill = v => time.map(() => v);
      const loc = { hourly: { time, temperature_2m: fill(12), precipitation_probability: fill(0), precipitation: fill(0),
        wind_speed_10m: fill(25), wind_direction_10m: fill(0), wind_gusts_10m: fill(35) } };
      return Promise.resolve(new Response(JSON.stringify(n > 1 ? Array(n).fill(loc) : loc)));
    }; return true; })()`);
  await page.clickMap(50.83, 7.02); await sleep(800);
  await page.ev(`{ const n = document.querySelector('#distance-num'); n.value = 25; n.dispatchEvent(new Event('change'));
    const d = document.querySelector('#direction'); d.value = '180'; d.dispatchEvent(new Event('change'));
    document.querySelector('#btn-generate').click(); } true`);
  check('Rundkurs erzeugt', await page.waitFor(`${HAS_ROUTE} && ${IDLE} && !!document.querySelector('#weather-summary').textContent.includes('Wetter bei Abfahrt')`, 120000));
  const centre = `(async () => { const s = ${STATE}, c = s.route.coords; return c.reduce((sum, p) => sum + p[0], 0) / c.length - s.start.lat; })()`;
  const south = await page.ev(centre);
  const advice = await page.ev(`(() => { const p = document.querySelector('#weather-advice'); return p ? { text: p.firstChild.textContent, button: p.querySelector('button').textContent } : null; })()`);
  check('Runde liegt südlich vom Start', south < 0, south.toFixed(4));
  check('Vorschlag: Rundkurs nach Norden', advice?.text === 'Der Wind kommt aus Norden. Liegt der Rundkurs in dieser Richtung, hast du ihn auf dem Rückweg im Rücken. '
    && advice.button === 'Rundkurs Richtung Norden legen', JSON.stringify(advice));
  await page.shot('2-vorschlag');
  await page.ev(`document.querySelector('#weather-advice button').click(); true`);
  await sleep(1000);
  check('Neu erzeugt, Vorschlag weg', await page.waitFor(`${HAS_ROUTE} && ${IDLE} && !document.querySelector('#weather-advice')`, 120000));
  const north = await page.ev(centre);
  check('Richtung „Norden“ gewählt, Runde liegt jetzt nördlich', await page.ev(`document.querySelector('#direction').value`) === '0' && north > 0, north.toFixed(4));
}
