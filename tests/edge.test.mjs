// Grenzfälle der Fachlogik, direkt an den Modulen im Testbrowser (Zeitzone Europe/Berlin, ohne Routing):
// Zeitumstellung bei Mehrtagestouren und im Booking-Link, Öffnungszeiten über Mitternacht und mit offenem Ende,
// Höhenlücken in den Steigungen, Zeitlimits für einen hängenden Profil-Upload bei BRouter und die Konto-Schnittstelle.
import { BONN } from './lib/app.mjs';

export const title = 'Grenzfälle der Fachlogik';

const JS = '/js/';

export default async function ({ app, page: newPage, check, step }) {
  const page = await newPage({ height: 900 });
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Berlin' });
  await page.open(app, { view: BONN, storage: { bike: 'trekking' } });

  step('Zeitumstellung');
  const dst = await page.ev(`(async () => {
    const { dayTimes } = await import('${JS}timeline.js');
    const { computeStats } = await import('${JS}utils.js');
    const { priceLink } = await import('${JS}stays.js');
    const coords = []; for (let i = 0; i <= 1600; i++) coords.push([50 + i * 0.0009, 7, 50]);
    const r = { coords, ...computeStats(coords), stageStarts: [80000], segments: [],
      waypoints: [{ lat: 50, lon: 7 }, { lat: coords.at(-1)[0], lon: 7 }] };
    const hm = d => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const starts = dep => dayTimes(r, dep, 'trekking').map(d => d.start.getDate() + '. ' + hm(d.start));
    const booking = date => { const u = new URL(priceLink({ type: 'hotel', name: 'Test', tags: {} }, { date }));
      return u.searchParams.get('checkin') + ' → ' + u.searchParams.get('checkout'); };
    return { autumn: starts(new Date(2026, 9, 24, 9)), spring: starts(new Date(2026, 2, 28, 9)),
      bookingAutumn: booking(new Date(2026, 9, 25)), bookingSpring: booking(new Date(2026, 2, 29)) };
  })()`);
  check('Herbst: Tag 2 startet um 09:00', dst.autumn.join() === '24. 09:00,25. 09:00', dst.autumn.join(' | '));
  check('Frühjahr: Tag 2 startet um 09:00', dst.spring.join() === '28. 09:00,29. 09:00', dst.spring.join(' | '));
  check('Booking: Nacht der Zeitumstellung im Oktober geht bis zum nächsten Tag', dst.bookingAutumn === '2026-10-25 → 2026-10-26', dst.bookingAutumn);
  check('Booking: Nacht der Zeitumstellung im März', dst.bookingSpring === '2026-03-29 → 2026-03-30', dst.bookingSpring);

  step('Öffnungszeiten');
  const hours = await page.ev(`(async () => {
    const { openState } = await import('${JS}openingHours.js');
    const at = (d, h, m = 0) => new Date(2026, 10, d, h, m); // 13.11.2026 = Freitag
    return [
      openState('Fr 18:00-02:00', at(14, 1)), openState('Fr 18:00-02:00', at(15, 1)),
      openState('Su 10:00-24:00', at(15, 23, 40)), openState('Mo-Fr 08:00-12:00,14:00-18:00', at(16, 13)),
      openState('Mo-Fr 07:00-12:30+', at(16, 13)), openState('Mo-Fr 07:00-12:30+', at(16, 9)),
      openState('sunrise-sunset', at(16, 12)), openState('Mo-Fr 08:00-18:00 "nach Vereinbarung"', at(16, 12)),
      openState('Mo-Fr 08:00–18:00', at(16, 12)),
    ];
  })()`);
  check('Über Mitternacht: Samstag 01:00 offen, Sonntag 01:00 zu', hours[0] === 'open' && hours[1] === 'closed', hours.slice(0, 2).join());
  check('Bis 24:00 und Mittagspause', hours[2] === 'open' && hours[3] === 'closed', hours.slice(2, 4).join());
  check('Offenes Ende („12:30+“) ist unbekannt, nicht geschlossen', hours[4] === 'unknown' && hours[5] === 'unknown', hours.slice(4, 6).join());
  check('Unverständliches ist unbekannt, nie geschlossen', hours.slice(6).every(h => h === 'unknown'), hours.slice(6).join());

  step('Steigungen mit Höhenlücken');
  const climbs = await page.ev(`(async () => {
    const { gradeSegments, findClimbs } = await import('${JS}climbs.js');
    const { computeStats } = await import('${JS}utils.js');
    const mk = ele => { const coords = []; for (let i = 0; i <= 50; i++) coords.push([50 + i * 0.0009, 7, ele(i)]); return { coords, ...computeStats(coords) }; };
    const r = mk(i => (i % 10 === 5 ? null : 100 + i * 5)); // 5 km mit 5 %, jeder 10. Punkt ohne Höhe
    return { classes: [...new Set(gradeSegments(r).map(s => s.grade))], gain: Math.round(findClimbs(r)[0]?.gain ?? 0) };
  })()`);
  check('Einzelne Punkte ohne Höhe ergeben keine falschen Klassen', climbs.classes.join() === 'up3', climbs.classes.join());
  check('Anstieg trotzdem vollständig', climbs.gain >= 240, String(climbs.gain));

  step('Zeitlimits');
  // Hängender Upload des EuroVelo-Profils: brouter.de antwortet nicht, nur das signal beendet die Anfrage
  const upload = await page.ev(`(async () => {
    const real = window.fetch;
    window.fetch = (url, init = {}) => String(url).endsWith('/profile') && init.method === 'POST'
      ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)))
      : real(url, init);
    const { brouter } = await import('${JS}routing/brouter.js');
    const points = [{ lat: 50.73, lon: 7.10 }, { lat: 50.70, lon: 7.15 }];
    const run = async (eurovelo, signal) => { const t = performance.now();
      try { await brouter.route(points, { bike: 'trekking', traffic: 'normal', eurovelo }, signal); return { ok: true }; }
      catch (e) { return { name: e.name, busy: !!e.busy, s: Math.round((performance.now() - t) / 100) / 10 }; } };
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 500);
    const aborted = await run('prefer', ctrl.signal);
    const timedOut = await run('strong', new AbortController().signal);
    window.fetch = real;
    return { aborted, timedOut };
  })()`);
  check('Abbruch wartet nicht auf den hängenden Upload', upload.aborted.name === 'AbortError' && upload.aborted.s < 2, JSON.stringify(upload.aborted));
  check('Hängender Upload endet nach dem Zeitlimit als „ausgelastet“', upload.timedOut.busy && upload.timedOut.s >= 19 && upload.timedOut.s < 25, JSON.stringify(upload.timedOut));

  // Konto-Schnittstelle antwortet nicht (sehr schwaches Netz): nach 8 s gilt der gemerkte Offline-Stand
  const acc = await page.ev(`(async () => {
    const { offlinePut, offlineClear } = await import('${JS}offlineStore.js');
    await offlinePut('user', { user: { id: 7, username: 'langsam' } });
    const real = window.fetch;
    window.fetch = (url, init = {}) => String(url).includes('/api/account')
      ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)))
      : real(url, init);
    const { loadAccount, account } = await import('${JS}account.js');
    const t = performance.now();
    await loadAccount();
    const s = Math.round((performance.now() - t) / 100) / 10;
    window.fetch = real;
    const out = { s, offline: account.offline, user: account.user?.username };
    await offlineClear();
    return out;
  })()`);
  check('Konto: nach etwa 8 s offline mit dem gemerkten Nutzer', acc.offline && acc.user === 'langsam' && acc.s >= 7.5 && acc.s < 11, JSON.stringify(acc));
}
