// Serverstatus für Admins (statusView.js): nur für ADMIN_USERS (im Test-Fake das Konto „chef“), Inhalt aus
// statusReport() (server/status.mjs, hier mit Einträgen dieses Testprozesses), Routen-Meldung an /api/route-stats.
import { BONN, HAS_ROUTE, IDLE, register } from './lib/app.mjs';
import { noteBrouter, noteClientError, noteRoute, registerStatus } from '../server/status.mjs';

export const title = 'Serverstatus für Admins';

export default async function ({ app, page: newPage, check, step }) {
  // Zahlen, die die Statusseite zeigen soll (der Fake antwortet mit statusReport() dieses Prozesses)
  const now = Date.now();
  registerStatus('brouter', () => ({ enabled: true, parallel: 1, active: 1, waiting: 2, downUntil: null }));
  registerStatus('extract', () => ({ enabled: true, t: now - 3 * 86400000, cells: 4321, regions: 52, layers: ['supply'],
    counts: { supply: 1200000 }, updating: false, lastCheck: { at: now - 3600000, ok: true, note: 'aktuell' } }));
  noteBrouter(2500, 'ok'); noteBrouter(4000, 'ok'); noteBrouter(181000, 'gone');
  noteRoute({ ms: 3000, servers: ['own'], error: null });
  noteRoute({ ms: 9000, servers: ['own', 'valhalla'], error: null });
  noteRoute({ ms: 20000, servers: [], error: 'tooLong' });
  noteClientError({ kind: 'Fehler', message: 'TypeError: Testfehler', where: 'js/app/x.js:1:2', browser: 'Chrome 131, Windows' });

  step('Normales Konto');
  const other = await newPage({ accounts: true });
  await other.open(app, { view: BONN });
  check('Normales Konto angemeldet', await register(other, 'radler'));
  check('Kein Abschnitt „Verwaltung“', await other.ev(`document.querySelector('#admin-settings').hidden`));
  const forbidden = await other.ev(`fetch('api/admin/status').then(r => r.status)`);
  check('Schnittstelle lehnt ab (403)', forbidden === 403, String(forbidden));

  step('Admin öffnet den Serverstatus');
  const admin = await newPage({ accounts: true, height: 950 });
  await admin.open(app, { view: BONN });
  check('Admin angemeldet', await register(admin, 'chef'));
  check('Abschnitt „Verwaltung“ mit Feedback und Serverstatus', await admin.waitFor(`!document.querySelector('#admin-settings').hidden
    && !document.querySelector('#btn-feedback-admin').hidden && document.querySelector('#btn-status').closest('#admin-settings')`, 10000));
  await admin.ev(`document.querySelector('#btn-status').click(); true`);
  check('Dialog geladen', await admin.waitFor(`document.querySelector('#status-dialog').open
    && document.querySelectorAll('#status-content .status-section').length === 5`, 10000));
  const shown = await admin.ev(`(() => {
    const sec = t => [...document.querySelectorAll('#status-content .status-section')].find(s => s.querySelector('h3').textContent.startsWith(t));
    const cell = (t, row, col) => [...sec(t).querySelectorAll('tbody tr')].find(r => r.querySelector('th').textContent === row)?.children[col]?.textContent;
    return {
      heads: [...document.querySelectorAll('#status-content h3')].map(h => h.textContent),
      extract: sec('Datenauszug').textContent,
      live: sec('Eigener BRouter').querySelector('p').textContent,
      requests: cell('Eigener BRouter', 'Anfragen', 1), gone: cell('Eigener BRouter', 'abgebrochen (Browser wartete nicht mehr)', 1),
      longest: cell('Eigener BRouter', 'längste', 2),
      valhalla: cell('Routen', 'mit Valhalla (Ausweich)', 2), tooLong: cell('Routen', 'gescheitert: zu lang', 2),
      error: sec('Browserfehler').textContent,
    };
  })()`);
  check('Fünf Abschnitte', shown.heads.join('|') === 'Server|Datenauszug Europa|Eigener BRouter|Routen|Browserfehler (zuletzt gesehene zuerst)', shown.heads.join('|'));
  check('Auszug: Stand, Zellen, letzte Prüfung', /vor 3 Tagen/.test(shown.extract) && shown.extract.includes('4.321 Zellen aus 52 Regionen')
    && shown.extract.includes('aktuell'), shown.extract);
  check('BRouter live: belegt und wartend', shown.live === 'Gerade 1 von 1 Platz belegt, 2 wartend.', shown.live);
  check('BRouter: Anfragen und Abbrüche der letzten Stunde', shown.requests === '3' && shown.gone === '1', `${shown.requests} / ${shown.gone}`);
  check('BRouter: längste Dauer', shown.longest === '181 s', shown.longest);
  check('Routen: Valhalla-Anteil und zu lange Strecken', shown.valhalla === '1 (50 %)' && shown.tooLong === '1', `${shown.valhalla} / ${shown.tooLong}`);
  check('Browserfehler mit Zahl und Browser', shown.error.includes('1× TypeError: Testfehler') && shown.error.includes('Chrome 131 1×'), shown.error);

  noteBrouter(1000, 'ok');
  await admin.ev(`document.querySelector('#btn-status-refresh').click(); true`);
  check('Aktualisieren lädt neu', await admin.waitFor(`[...document.querySelectorAll('#status-content tbody tr')].find(r => r.querySelector('th').textContent === 'Anfragen')?.children[1].textContent === '4'`, 10000));
  const axe = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js')).text();
  await admin.ev(axe + '; true');
  const violations = await admin.ev(`axe.run(document.querySelector('#status-dialog'), { resultTypes: ['violations'] }).then(r => r.violations.map(v => v.id))`);
  check('axe: 0 Verstöße im Dialog', Array.isArray(violations) && !violations.length, JSON.stringify(violations));
  await admin.ev(`document.querySelector('#status-dialog [data-close]').click(); true`);
  check('Kreuz schließt', !(await admin.ev(`document.querySelector('#status-dialog').open`)));

  step('Routen-Meldung an den Server');
  const statuses = await admin.ev(`Promise.all([
    fetch('api/route-stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms: 1200, servers: ['brouter.de'] }) }).then(r => r.status),
    fetch('api/route-stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms: 1200, servers: ['x'] }) }).then(r => r.status),
    fetch('api/route-stats').then(r => r.status),
  ])`);
  check('Gültig 204, ungültig 400, GET 405', statuses.join() === '204,400,405', statuses.join());
  await admin.ev(`document.querySelector('#settings-dialog').close(); performance.clearResourceTimings();
    (async () => { const w = await import('/js/app/waypoints.js');
      w.setPoint('start', { lat: 50.73, lon: 7.10, label: 'Bonn' }); w.setPoint('end', { lat: 50.70, lon: 7.15, label: 'Bad Godesberg' }); })(); true`);
  check('Route berechnet', await admin.waitFor(`${HAS_ROUTE} && ${IDLE}`, 90000));
  check('App meldet die Grundroute (ohne Orte im Aufruf)', await admin.waitFor(`performance.getEntriesByType('resource').some(e => e.name.endsWith('/api/route-stats'))`, 10000));
}
