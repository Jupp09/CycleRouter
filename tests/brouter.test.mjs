// Eigener BRouter über /api/brouter (server/brouterProxy.mjs) und brouter.de als Ausweich (js/routing/brouter.js).
// Ohne TEST_BROUTER_URL: Der Weg antwortet mit 404, danach geht alles direkt an brouter.de.
// Mit TEST_BROUTER_URL=http://… (npm test -- brouter): Teilstücke und Profil-Uploads laufen über den eigenen
// Server; was dort fehlt (Profil, Kartendaten), rechnet brouter.de.
import { HAS_ROUTE, IDLE } from './lib/app.mjs';

export const title = 'Eigener BRouter, Ausweich brouter.de';

const POINTS = `[{ lat: 50.73, lon: 7.10 }, { lat: 50.70, lon: 7.15 }]`;
/** Teilstück berechnen und zählen, welche Server dafür angefragt wurden */
const leg = opts => `(async () => {
  const { brouter } = await import('/js/routing/brouter.js');
  performance.clearResourceTimings();
  try {
    const r = await brouter.route(${POINTS}, ${JSON.stringify(opts)}, new AbortController().signal);
    // Nur Anfragen für dieses Teilstück (lonlats=7.1…) und Uploads – nicht die Prüfanfragen des Tests oben
    const urls = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('lonlats=7.1') || u.endsWith('/profile'));
    return { ok: r.coords.length > 10, own: urls.filter(u => u.includes('/api/brouter')).map(u => new URL(u).pathname),
      pub: urls.filter(u => u.includes('brouter.de')).length };
  } catch (e) { return { error: e.message }; }
})()`;

export default async function ({ app, page: newPage, check, step }) {
  const page = await newPage();
  await page.open(app);

  step('Eigener Server eingerichtet?');
  const probe = await page.ev(`fetch('/api/brouter').then(async r => ({ status: r.status, ...(await r.json()) }))`);
  const own = probe.enabled === true;
  check(own ? 'Weg meldet eigenen BRouter' : 'Ohne BROUTER_URL: 404', own ? probe.status === 200 : probe.status === 404, JSON.stringify(probe));
  const bad = await page.ev(`fetch('/api/brouter?lonlats=1&profile=../x').then(r => r.status)`);
  check('Ungültige Anfrage abgelehnt', own ? bad === 400 : bad === 404, String(bad));

  step('Teilstück Fahrrad');
  const trek = await page.ev(leg({ bike: 'trekking', traffic: 'normal' }));
  check('Route berechnet', trek.ok, JSON.stringify(trek));
  if (own) check('Über den eigenen Server, ohne brouter.de', trek.own.length === 1 && trek.pub === 0, JSON.stringify(trek));
  else check('Direkt bei brouter.de', trek.pub === 1 && trek.own.length === 0, JSON.stringify(trek));

  step('EuroVelo-Profil');
  const ev = await page.ev(leg({ bike: 'trekking', traffic: 'normal', eurovelo: 'prefer' }));
  check('Route mit hochgeladenem Profil', ev.ok, JSON.stringify(ev));
  if (own) check('Upload beim eigenen Server', ev.own.includes('/api/brouter/profile'), JSON.stringify(ev));

  if (own) {
    step('Profilparameter kommen beim eigenen Server an');
    // E-Bike-Parameter (brouter.js PARAMS): Ohne Höhenmeter-Kosten sinken die Kosten der Route Köln → Koblenz
    // (brouter.de: 103611 → 103346). Früher kodierte der Weiterleiter `profile:` zu `profile%3A`, und BRouter
    // überging den Parameter still – E-Bike-Routen waren dann normale Trekking-Routen.
    const cost = extra => page.ev(`fetch('/api/brouter?lonlats=6.95,50.94|7.59,50.36&profile=trekking${extra}')
      .then(r => r.json()).then(d => Number(d.features[0].properties.cost))`);
    const [plain, ebike] = [await cost(''), await cost('&profile:consider_elevation=0')];
    check('consider_elevation=0 kommt an (Kosten sinken)', plain > 0 && ebike > 0 && ebike < plain, `${plain} / ${ebike}`);
  }

  step('Rennrad, wenig Verkehr');
  // Fehlt das Profil auf dem eigenen Server, springt brouter.de ein – berechnet wird die Route in jedem Fall
  const road = await page.ev(leg({ bike: 'road', traffic: 'low' }));
  check('Route berechnet', road.ok, JSON.stringify(road));

  step('Anzeige, wer gerechnet hat');
  await page.ev(`(async () => { const w = await import('/js/app/waypoints.js');
    w.setPoint('start', { lat: 50.73, lon: 7.10, label: 'Bonn' }); w.setPoint('end', { lat: 50.70, lon: 7.15, label: 'Bad Godesberg' }); return true; })()`);
  check('Route in der App', await page.waitFor(`${HAS_ROUTE} && ${IDLE}`, 90000));
  const line = await page.ev(`(() => { const el = document.querySelector('#routing-server'); return el.hidden ? '(versteckt)' : el.textContent; })()`);
  check(own ? 'Hinweis nennt den CycloRouter-Server' : 'Hinweis nennt brouter.de',
    own ? /CycloRouter-Server/.test(line) : line === 'Berechnet mit BRouter auf brouter.de', line);

  step('Punkt abseits jeder Straße');
  const sea = await page.ev(`(async () => {
    const { brouter } = await import('/js/routing/brouter.js');
    performance.clearResourceTimings();
    try { await brouter.route([{ lat: 54.5, lon: 5.0 }, { lat: 54.6, lon: 5.1 }], { bike: 'trekking', traffic: 'normal' }, new AbortController().signal); return { ok: true }; }
    catch (e) { return { message: e.message, busy: !!e.busy,
      pub: performance.getEntriesByType('resource').filter(e => e.name.includes('brouter.de')).length }; }
  })()`);
  check('Verständliche Meldung, nicht „ausgelastet“', !sea.ok && !sea.busy && /zu weit|BRouter-Fehler/.test(sea.message), JSON.stringify(sea));
}
