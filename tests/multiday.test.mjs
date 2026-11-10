// Mehrtagestour: Etappen, Unterkünfte, Preis-Links, Unterkunft wechseln, speichern und wieder öffnen.
import { register, saveRoute } from './lib/app.mjs';

export const title = 'Etappen und Unterkünfte (Bremen → Hamburg)';

export default async function ({ app, page: newPage, check, step, sleep }) {
  const page = await newPage({ accounts: true, height: 950 });
  const { ev, waitFor, text } = page;
  await page.open(app, { view: { center: [53.3, 9.4], zoom: 9 }, storage: { bike: 'trekking', mode: 'ab' } });

  step('Route und Aufteilung');
  await page.clickMap(53.064, 8.793); await sleep(800);
  await page.clickMap(53.553, 10.0067);
  await waitFor(`!document.querySelector('#results').hidden && document.querySelector('#stat-dist').textContent`, 120000);
  check('Bei 100 km/Tag: Knopf sichtbar (Route > 110 km)', await ev(`!document.querySelector('#stages').hidden`),
    `${await text('#stat-dist')} – „${await text('#btn-multiday')}“`);
  check('Nicht automatisch aufgeteilt', await ev(`document.querySelector('#stages-body').hidden`));

  await ev(`document.querySelector('#btn-settings').click(); document.querySelector('#stage-max').value = 50; document.querySelector('#night-budget').value = 70;
    document.querySelector('#settings-dialog button[value=save]').click(); true`);
  await sleep(500);
  check('Knopf zeigt neue Aufteilung', (await text('#btn-multiday')).includes('3 Tage'), await text('#btn-multiday'));
  await ev(`document.querySelector('#btn-multiday').click(); true`);
  check('Etappen geplant', await waitFor(`!document.querySelector('#stages-body').hidden && document.querySelectorAll('#stage-list > li').length >= 3`, 180000),
    await text('#stages-summary'));
  const pins = await ev(`document.querySelectorAll('.stay-pin').length`);
  check('Unterkunfts-Marker auf der Karte', pins >= 2, `${pins} Marker`);
  check('Knopf heißt jetzt „aufheben“', await text('#btn-multiday') === 'Mehrtagestour aufheben');
  const priceHref = await ev(`document.querySelector('#stage-list .links a')?.href`);
  check('Preis-Link mit Datum', /booking\.com.*checkin=\d{4}-\d{2}-\d{2}|google\.com\/search/.test(priceHref || ''), priceHref?.slice(0, 110));
  await page.shot('1-etappen');

  step('Unterkunft für Nacht 1 wechseln');
  const sel = await ev(`(() => { const s = document.querySelector('#stage-list select'); return { n: s.options.length, alt: s.options[1]?.value, altText: s.options[1]?.textContent }; })()`);
  if (check('Mehrere Unterkünfte zur Wahl', sel.n > 1, sel.n)) {
    await ev(`{ const s = document.querySelector('#stage-list select'); s.value = ${JSON.stringify(sel.alt)}; s.dispatchEvent(new Event('change')); } true`);
    // Während der Neuberechnung ist kurz die Route ohne Übernachtungen zu sehen und die Tagesliste ausgeblendet
    check('Andere Unterkunft gewählt → neu berechnet', await waitFor(`!document.querySelector('#stages-body').hidden && !document.querySelector('#status').classList.contains('loading')
      && document.querySelector('#stage-list select')?.value === ${JSON.stringify(sel.alt)}`, 120000), sel.altText);
  }

  step('GPX je Tag');
  // Downloads abfangen statt speichern: Dateiname und Inhalt (Blob) merken
  await ev(`window.__dl = []; window.__blobs = new Map();
    const create = URL.createObjectURL; URL.createObjectURL = b => { const u = create(b); window.__blobs.set(u, b); return u; };
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push({ name: this.download, blob: window.__blobs.get(this.href) }); };
    true`);
  const days = await ev(`document.querySelectorAll('#stage-list > li').length`);
  check('„Als GPX“ in jeder Tageszeile', await ev(`document.querySelectorAll('#stage-list .day-links button').length`) === days);
  const label = await ev(`document.querySelectorAll('#stage-list .day-links button')[1].getAttribute('aria-label')`);
  check('Name für Screenreader', label === 'Tag 2 als GPX exportieren', label);
  await ev(`document.querySelectorAll('#stage-list .day-links button')[1].click(); true`);
  check('Tag 2 einzeln exportiert', await waitFor(`window.__dl.length === 1`, 5000) && /_Tag_2\.gpx$/.test(await ev(`window.__dl[0].name`)),
    await ev(`window.__dl[0]?.name`));
  await ev(`window.__dl = []; document.querySelector('#btn-stages-gpx').click(); true`);
  check('„Alle Tage einzeln“: eine Datei je Tag', await waitFor(`window.__dl.length === ${days}`, 10000), await ev(`window.__dl.map(d => d.name).join(', ')`));
  const gpx = await ev(`(async () => {
    const { state } = await import('/js/app/state.js');
    const { stageStats } = await import('/js/timeline.js');
    const { haversine } = await import('/js/utils.js');
    const r = state.route, stats = stageStats(r, state.bike);
    const files = await Promise.all(window.__dl.map(async d => new DOMParser().parseFromString(await d.blob.text(), 'application/xml')));
    const pts = doc => [...doc.querySelectorAll('trkpt')].map(p => ({ lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon') }));
    const len = ps => ps.reduce((s, p, i) => s + (i ? haversine(ps[i - 1], p) : 0), 0);
    const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5;
    const days = files.map((doc, i) => ({ pts: pts(doc), names: [...doc.querySelectorAll('wpt > name')].map(n => n.textContent), want: stats[i].distance }));
    return {
      startOk: same(days[0].pts[0], { lat: r.coords[0][0], lon: r.coords[0][1] }),
      endOk: same(days.at(-1).pts.at(-1), { lat: r.coords.at(-1)[0], lon: r.coords.at(-1)[1] }),
      joinsOk: days.slice(1).every((d, i) => same(d.pts[0], days[i].pts.at(-1))),
      lengths: days.map(d => Math.round(len(d.pts) / 100) / 10 + '/' + Math.round(d.want / 100) / 10).join(' '),
      lengthsOk: days.every(d => Math.abs(len(d.pts) - d.want) < Math.max(200, d.want * 0.01)),
      total: Math.round(days.reduce((s, d) => s + len(d.pts), 0)), distance: Math.round(r.distance),
      nights: days.map(d => d.names.filter(n => n.startsWith('Nacht')).join(' + ')),
    };
  })()`);
  check('Tag 1 beginnt am Start, letzter Tag endet am Ziel', gpx.startOk && gpx.endOk);
  check('Jeder Tag beginnt, wo der vorige endet', gpx.joinsOk);
  check('Track-Länge je Tag passt zur Etappe', gpx.lengthsOk, gpx.lengths);
  check('Tage zusammen = Gesamtlänge', Math.abs(gpx.total - gpx.distance) < 50, `${gpx.total} m / ${gpx.distance} m`);
  check('Unterkunft am Ende von Tag 1 und am Anfang von Tag 2', /^Nacht 1/.test(gpx.nights[0]) && /^Nacht 1/.test(gpx.nights[1]), JSON.stringify(gpx.nights));
  check('Tag 1 ohne Unterkunft von Nacht 2', !gpx.nights[0].includes('Nacht 2'), gpx.nights[0]);

  step('Speichern und wieder öffnen');
  check('Konto angelegt', await register(page, 'md_test'));
  await ev(`document.querySelector('#settings-dialog').close(); true`);
  check('Gespeichert', await saveRoute(page, 'Bremen–Hamburg 3 Tage'));
  await ev(`document.querySelector('#btn-clear').click(); true`); await sleep(500);
  check('Nach „Löschen“ keine Etappen mehr', await ev(`document.querySelector('#stages').hidden && !document.querySelectorAll('.stay-pin').length`));
  await ev(`document.querySelector('#my-routes').open = true; document.querySelector('#my-routes-list li button.row').click(); true`);
  check('Gespeicherte Mehrtagestour wieder geöffnet', await waitFor(`!document.querySelector('#stages-body').hidden && document.querySelector('#stage-list select')`, 180000));
  if (sel.n > 1) check('Gewählte Unterkunft wiederhergestellt', await ev(`document.querySelector('#stage-list select').value`) === sel.alt);
  await page.shot('2-wieder');

  step('Aufheben');
  await waitFor(`!document.querySelector('#status').classList.contains('loading')`, 60000);
  await ev(`document.querySelector('#btn-multiday').click(); true`);
  check('Mehrtagestour aufgehoben', await waitFor(`document.querySelector('#stages-body').hidden && !document.querySelectorAll('.stay-pin').length`, 60000),
    `Knopf „${await text('#btn-multiday')}“`);
}
