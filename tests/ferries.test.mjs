// Fähren: Hinweis in den Ergebnissen, „Fähren meiden“, Gravel ohne billige Fähren (brouter.js CHEAP_FERRIES),
// verständliche Meldung, wenn eine Strecke zu lang für eine Berechnung am Stück ist (routing/index.js).
// Elbfähre Glückstadt → Wischhafen: 11,6 km mit 5,2 km Fähre, ohne Fähre ~125 km über Hamburg (brouter.de, 11/2026).
import { HAS_ROUTE, IDLE, STATE } from './lib/app.mjs';

export const title = 'Fähren: Hinweis, meiden, Gravel, zu lange Strecke';

const GLUECKSTADT = { lat: 53.7880, lon: 9.4167, label: 'Glückstadt' };
const WISCHHAFEN = { lat: 53.7640, lon: 9.3260, label: 'Wischhafen' };

/** Ein BRouter-Teilstück direkt berechnen: Länge, Fähren-km und ob ein Profil hochgeladen wurde */
const leg = (a, b, opts) => `(async () => {
  const { brouter } = await import('/js/routing/brouter.js');
  const { withStats } = await import('/js/routing/index.js');
  const { ferryCrossings } = await import('/js/surfaces.js');
  performance.clearResourceTimings();
  try {
    const pts = [${JSON.stringify(a)}, ${JSON.stringify(b)}];
    const r = withStats(await brouter.route(pts, ${JSON.stringify(opts)}, new AbortController().signal), pts);
    const ferry = ferryCrossings(r).reduce((s, f) => s + f.to - f.from, 0);
    const uploads = performance.getEntriesByType('resource').filter(e => e.name.endsWith('/profile')).length;
    return { km: Math.round(r.distance / 100) / 10, ferryKm: Math.round(ferry / 100) / 10, uploads };
  } catch (e) { return { error: e.message }; }
})()`;

export default async function ({ app, page: newPage, check, step }) {
  const page = await newPage();
  const { ev, waitFor } = page;
  await page.open(app, { view: { center: [53.78, 9.37], zoom: 12 }, storage: { bike: 'trekking', mode: 'ab' } });

  step('Route mit Fähre: Hinweis');
  await ev(`(async () => { const w = await import('/js/app/waypoints.js');
    w.setPoint('start', ${JSON.stringify(GLUECKSTADT)}); w.setPoint('end', ${JSON.stringify(WISCHHAFEN)}); return true; })()`);
  check('Route berechnet', await waitFor(`${HAS_ROUTE} && ${IDLE}`, 90000));
  const withFerry = await ev(`(async () => ({ km: ${STATE}.route.distance / 1000,
    hint: document.querySelector('#ferry-share').hidden ? null : document.querySelector('#ferry-share').textContent }))()`);
  check('Kurz über die Elbe (unter 20 km)', withFerry.km < 20, `${withFerry.km} km`);
  check('Hinweis nennt die Überfahrt und „Fähren meiden“',
    /^Enthält eine Fährüberfahrt \(\d+,\d km ab km \d+\)/.test(withFerry.hint || '') && withFerry.hint.includes('Fähren meiden'), withFerry.hint);
  check('Symbol aus CSS, für Screenreader stumm', await ev(`getComputedStyle(document.querySelector('#ferry-share'), '::before').content.includes('⛴')`));

  step('Fähren meiden');
  await ev(`document.querySelector('#btn-plan-edit').click(); document.querySelector('#more-options').open = true; true`);
  await ev(`document.querySelector('#avoid-ferries').click(); true`);
  check('Neu berechnet: Umweg über Hamburg (über 80 km)', await waitFor(`${HAS_ROUTE} && ${IDLE} && parseFloat(document.querySelector('#stat-dist').textContent.replace('.', '').replace(',', '.')) > 80`, 120000),
    await ev(`(async () => ${STATE}.route.distance / 1000)()`));
  const avoided = await ev(`(async () => ({ hint: document.querySelector('#ferry-share').hidden,
    stored: localStorage.getItem('cyclerouter.avoidFerries'), link: location.hash,
    summary: (document.querySelector('#more-options').open = false, document.querySelector('#more-options summary').textContent) }))()`);
  check('Kein Fähren-Hinweis mehr', avoided.hint);
  check('Einstellung gespeichert (wird abgeglichen)', avoided.stored === 'true', avoided.stored);
  check('Routen-Link trägt sie (nf=1)', /[#&]nf=1(&|$)/.test(avoided.link), avoided.link);
  check('Zugeklappt nennt die Überschrift sie', avoided.summary.includes('Fähren meiden'), avoided.summary);

  step('Wieder erlauben');
  await ev(`document.querySelector('#more-options').open = true; document.querySelector('#avoid-ferries').click(); true`);
  check('Wieder mit Fähre (Teilstück aus dem Speicher)', await waitFor(`${HAS_ROUTE} && ${IDLE} && !document.querySelector('#ferry-share').hidden`, 30000));
  check('Einstellung zurückgesetzt', await ev(`localStorage.getItem('cyclerouter.avoidFerries')`) === 'false');

  step('Gravel: keine langen Fähren, Fähren meiden über das Profil');
  // Das Gravel-Profil bewertet Fähren billiger als Straßen: Split → Dubrovnik waren 194 von 197 km Fähre
  const gravel = await ev(leg({ lat: 43.5081, lon: 16.4402 }, { lat: 42.6507, lon: 18.0944 }, { bike: 'gravel', traffic: 'normal' }));
  check('Split → Dubrovnik über Land, ohne Fähre', !gravel.error && gravel.ferryKm === 0 && gravel.km > 220, JSON.stringify(gravel));
  check('Dafür angepasstes Profil hochgeladen', gravel.uploads === 1, JSON.stringify(gravel));
  const gravelNo = await ev(leg(GLUECKSTADT, WISCHHAFEN, { bike: 'gravel', traffic: 'normal', avoidFerries: true }));
  check('Gravel mit „Fähren meiden“: Elbe ohne Fähre', !gravelNo.error && gravelNo.ferryKm === 0 && gravelNo.km > 80, JSON.stringify(gravelNo));
  const trekNo = await ev(leg(GLUECKSTADT, WISCHHAFEN, { bike: 'trekking', traffic: 'normal', avoidFerries: true }));
  check('Trekking mit „Fähren meiden“: als Parameter, ohne Hochladen', !trekNo.error && trekNo.ferryKm === 0 && trekNo.uploads === 0, JSON.stringify(trekNo));

  step('Zu lange Strecke: Rat statt „ausgelastet“');
  // BRouter ausgelastet und Valhalla mit seiner 150-km-Grenze nachgestellt (keine echten Anfragen)
  const long = await ev(`(async () => {
    const real = window.fetch;
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/brouter') || u.includes('brouter.de')) return new Response('operation killed by thread-priority-watchdog', { status: 503 });
      if (u.includes('valhalla')) return new Response(JSON.stringify({ error_code: 154, error: 'Path distance exceeds the max distance limit' }), { status: 400 });
      return real(url, init);
    };
    try {
      const { route, providers } = await import('/js/routing/index.js');
      await route(providers.brouter, [{ lat: 53.55, lon: 9.99 }, { lat: 48.14, lon: 11.58 }],
        { bike: 'trekking', traffic: 'normal', eurovelo: 'off', retries: false }, new AbortController().signal);
      return 'keine Fehlermeldung';
    } catch (e) { return e.message; } finally { window.fetch = real; }
  })()`);
  check('Meldung rät zu Zwischenstopps', /zu lang, um sie am Stück zu berechnen \(\d+ km Luftlinie\)/.test(long) && long.includes('Zwischenstopps'), long);
}
