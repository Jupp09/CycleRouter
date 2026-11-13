// Steigungen (js/climbs.js): Klassen und Anstiege für ein künstliches Profil, dann in der App: Umschalter
// „Steigung“, Legende, Schraffur im Höhenprofil, Liste der größten Anstiege mit Sprung auf der Karte,
// und ohne Höhen (importierter Weg) keine Steigung.
import { STATE, MAP, HAS_ROUTE } from './lib/app.mjs';

export const title = 'Steigungen';

const SWITCH = `[...document.querySelectorAll('#breakdown-switch button')].map(b => b.dataset.value + (b.hidden ? ':versteckt' : '') + (b.getAttribute('aria-checked') === 'true' ? ':gewählt' : '')).join()`;
const LEGEND = `[...document.querySelectorAll('#breakdown-legend li')].map(li => li.children[1].textContent)`;

export default async function ({ app, page: newPage, check, step, sleep }) {
  step('Künstliches Profil: 2 km flach, 1 km mit 8 %, 1 km flach, 1 km mit −8 %');
  let page = await newPage({ height: 950 });
  await page.open(app, { view: { center: [50.68, 7.23], zoom: 12 }, storage: { bike: 'trekking' } });
  const calc = await page.ev(`(async () => {
    const { computeStats } = await import('/js/utils.js');
    const { gradeSegments, findClimbs, gradeClass, hasElevation } = await import('/js/climbs.js');
    const { summarize } = await import('/js/surfaces.js');
    const coords = [];
    for (let i = 0, ele = 100; i <= 100; i++) { // alle 50 m ein Punkt
      coords.push([50 + i * 0.00044966, 7, ele]);
      ele += i >= 40 && i < 60 ? 4 : i >= 80 ? -4 : 0;
    }
    const r = { coords, ...computeStats(coords), segments: [] };
    const segs = gradeSegments(r), len = s => r.cum[s.to] - r.cum[s.from];
    const total = cls => Math.round(segs.filter(s => s.grade === cls).reduce((sum, s) => sum + len(s), 0));
    const flat = { coords: coords.map(c => [c[0], c[1], null]), ...computeStats(coords), segments: [] };
    return {
      classes: [-0.05, 0, 0.029, 0.03, 0.07, 0.12].map(gradeClass).join(),
      order: segs.map(s => s.grade).filter((g, i, a) => g !== a[i - 1]).join(),
      gapless: segs[0].from === 0 && segs.at(-1).to === coords.length - 1 && segs.every((s, i) => !i || s.from === segs[i - 1].to),
      up6: total('up6'), down: total('down'), flat: total('flat'),
      climbs: findClimbs(r).map(c => ({ from: Math.round(c.from), length: Math.round(c.length), gain: Math.round(c.gain), mean: +(c.mean * 100).toFixed(1), max: +(c.max * 100).toFixed(1) })),
      summary: summarize(r, 'grade').map(i => i.key).join(), sum: Math.round(summarize(r, 'grade').reduce((s, i) => s + i.distance, 0)), distance: Math.round(r.distance),
      noEle: [hasElevation(flat), gradeSegments(flat).length, findClimbs(flat).length].join(),
    }; })()`);
  check('Klassengrenzen', calc.classes === 'down,flat,flat,up3,up6,up6' || calc.classes === 'down,flat,flat,up3,up6,up10', calc.classes);
  check('Abfolge flach → Anstieg → flach → bergab, lückenlos', /^flat,(up3,)?up6,(up3,)?flat,down$/.test(calc.order) && calc.gapless, calc.order);
  check('Rund 1 km mit 6–10 % und 1 km bergab', Math.abs(calc.up6 - 900) < 200 && Math.abs(calc.down - 950) < 200, `${calc.up6} m / ${calc.down} m`);
  const c = calc.climbs[0];
  check('Ein Anstieg: ab km 2, 80 m auf rund 1 km, Ø 8 %', calc.climbs.length === 1 && Math.abs(c.from - 2000) < 200 && Math.abs(c.gain - 80) <= 6
    && Math.abs(c.length - 1000) < 250 && c.mean > 6 && c.mean < 9 && c.max >= 7.5 && c.max <= 8.5, JSON.stringify(calc.climbs));
  check('Zusammenfassung in fester Reihenfolge, Summe = Distanz', calc.summary === 'down,flat,up3,up6' || calc.summary === 'down,flat,up6', `${calc.summary}, ${calc.sum}/${calc.distance}`);
  check('Summe der Klassen = Distanz', calc.sum === calc.distance);
  check('Ohne Höhen: keine Steigung', calc.noEle === 'false,0,0', calc.noEle);

  step('Hügelige Route (Siebengebirge)');
  await page.clickMap(50.674, 7.194); await sleep(800);
  await page.clickMap(50.683, 7.277);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  check('Umschalter mit „Steigung“, Untergrund gewählt', await page.ev(SWITCH) === 'surface:gewählt,waytype,grade', await page.ev(SWITCH));
  check('Liste der Anstiege noch verborgen', await page.ev(`document.querySelector('#climbs').hidden`));

  await page.ev(`document.querySelector('#breakdown-switch [data-value=grade]').click(); true`);
  await sleep(500);
  const legend = await page.ev(LEGEND);
  check('Legende zeigt Steigungsklassen', legend.length >= 2 && legend.every(l => /^(Bergab|Flach|Steigung)/.test(l)), legend.join(' · '));
  const chart = await page.ev(`(() => { const q = s => document.querySelectorAll('#elevation-chart ' + s).length;
    return { fills: q('.grade-fill'), hatched: q('rect[fill^="url(#grade-hatch-"]'), patterns: q('pattern'), band: q('svg > rect') }; })()`);
  check('Höhenprofil: Fläche je Klasse gefärbt und Steigungen schraffiert', chart.fills >= 2 && chart.hatched >= 1 && chart.patterns === 3 && chart.band >= 2, JSON.stringify(chart));
  await page.ev(`document.querySelector('#elevation-chart').focus(); true`);
  await page.key('ArrowRight');
  const spoken = await page.ev(`document.querySelector('#elevation-chart').getAttribute('aria-valuetext')`);
  check('Position im Profil nennt die Steigungsklasse', /(Bergab|Flach|Steigung)/.test(spoken), spoken);

  const rows = await page.ev(`[...document.querySelectorAll('#climb-list li')].map(li => li.textContent)`);
  check('Größte Anstiege aufgelistet', rows.length >= 1 && rows.every(r => /^\d[\d.]* m ↑ auf [\d,]+ km/.test(r) && /Ø [\d,]+ %, bis [\d,]+ %/.test(r) && /km [\d,]+–[\d,]+$/.test(r)), rows[0]);
  await page.shot('1-steigung');
  const before = await page.ev(`(async () => { const m = ${MAP}; const c = m.center(); return c.lat.toFixed(4) + ',' + c.lon.toFixed(4); })()`);
  await page.ev(`document.querySelector('#climb-list li button').click(); true`);
  await sleep(1200);
  const after = await page.ev(`(async () => { const m = ${MAP}; const c = m.center(); return c.lat.toFixed(4) + ',' + c.lon.toFixed(4); })()`);
  check('Klick zeigt den Anstieg auf der Karte', before !== after, `${before} → ${after}`);
  const dashed = await page.ev(`[...document.querySelectorAll('#map .leaflet-overlay-pane path')].map(p => p.getAttribute('stroke')).filter((c, i, a) => a.indexOf(c) === i).length`);
  check('Routenlinie nach Steigung eingefärbt', dashed >= 4, `${dashed} Farben`);

  step('Einstellung bleibt, Zusammenfassung stimmt');
  const sum = await page.ev(`(async () => { const r = ${STATE}.route; const { summarize } = await import('/js/surfaces.js');
    return Math.round(summarize(r, 'grade').reduce((s, i) => s + i.distance, 0) - r.distance); })()`);
  check('Summe der Klassen = Distanz', sum === 0, sum);
  await page.reload();
  check('Nach dem Neuladen ist „Steigung“ gemerkt', await page.ev(`JSON.parse(localStorage.getItem('cyclerouter.breakdown'))`) === 'grade');

  step('Importierter Weg ohne Höhen');
  page = await newPage({ height: 950 });
  await page.open(app, { view: { center: [50.81, 7.015], zoom: 13 }, storage: { bike: 'trekking', breakdown: 'grade' } });
  const gpx = '<gpx><trk><name>Flach</name><trkseg>'
    + [[50.80, 7.00], [50.80, 7.03], [50.82, 7.03]].map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('') + '</trkseg></trk></gpx>';
  await page.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(gpx)}], 'flach.gpx'));
    const input = document.querySelector('#gpx-file'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
  check('Route angezeigt', await page.waitFor(HAS_ROUTE, 10000));
  check('„Steigung“ nicht angeboten, Untergrund gilt', await page.ev(SWITCH) === 'surface:gewählt,waytype,grade:versteckt', await page.ev(SWITCH));
  check('Einstellung „Steigung“ bleibt gespeichert', await page.ev(`JSON.parse(localStorage.getItem('cyclerouter.breakdown'))`) === 'grade');
}
