// FIT-Kurs (js/fit.js, exportView.js): Abbiegehinweise einer echten BRouter-Route und der Export-Knopf.
// Aufbau und Kurspunkte im Einzelnen: tests/unit/fit.test.mjs; je Tag einer Mehrtagestour: multiday.test.mjs.
import { BONN, HAS_ROUTE, IDLE, STATE } from './lib/app.mjs';

export const title = 'FIT-Kurs mit Abbiegehinweisen';

export default async function ({ app, page: newPage, check, step }) {
  const page = await newPage();
  const { ev, waitFor } = page;
  await page.open(app, { view: BONN, storage: { bike: 'trekking', mode: 'ab' } });

  step('Route mit Abbiegehinweisen');
  await ev(`(async () => { const w = await import('/js/app/waypoints.js');
    w.setPoint('start', { lat: 50.73, lon: 7.10, label: 'Bonn' }); w.setPoint('end', { lat: 50.70, lon: 7.15, label: 'Bad Godesberg' }); return true; })()`);
  check('Route berechnet', await waitFor(`${HAS_ROUTE} && ${IDLE}`, 90000));
  const turns = await ev(`(async () => { const r = ${STATE}.route;
    return { n: r.turns?.length ?? 0, valid: (r.turns || []).every(t => t.i > 0 && t.i < r.coords.length - 1 && t.cmd >= 1 && t.cmd <= 18) }; })()`);
  check('BRouter liefert Abbiegehinweise (timode=1)', turns.n > 3 && turns.valid, JSON.stringify(turns));

  step('Export');
  check('Knopf unter „GPX exportieren“, als leiser Link', await ev(`(() => { const b = document.querySelector('#btn-fit');
    return !!b && b.classList.contains('link-btn') && !!(document.querySelector('#btn-gpx').compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })()`));
  await ev(`window.__dl = []; window.__blobs = new Map();
    const create = URL.createObjectURL; URL.createObjectURL = b => { const u = create(b); window.__blobs.set(u, b); return u; };
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push({ name: this.download, blob: window.__blobs.get(this.href) }); };
    document.querySelector('#route-name').value = 'Bonn nach Godesberg'; document.querySelector('#btn-fit').click(); true`);
  check('Datei heruntergeladen', await waitFor(`window.__dl.length === 1`, 5000) && await ev(`window.__dl[0].name`) === 'Bonn_nach_Godesberg.fit',
    await ev(`window.__dl[0]?.name`));
  const file = await ev(`window.__dl[0].blob.arrayBuffer().then(b => { const u = new Uint8Array(b), t = new TextDecoder('latin1').decode(u);
    return { size: u.length, sig: t.slice(8, 12), type: window.__dl[0].blob.type, name: t.includes('Bonn nach Godesberg'),
      turn: /Links|Rechts|Leicht|Scharf|Kreisel|halten/.test(t) }; })`);
  check('FIT-Kopf, Name und Abbiegungen enthalten', file.sig === '.FIT' && file.name && file.turn && file.size > 1000, JSON.stringify(file));
  check('Dateityp application/vnd.ant.fit', file.type === 'application/vnd.ant.fit', file.type);
}
