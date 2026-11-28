// Mehrtagestour: Etappen, Unterkünfte, Preis-Links, Unterkunft wechseln, speichern und wieder öffnen.
import { register, saveRoute, departNextWednesday } from './lib/app.mjs';

export const title = 'Etappen und Unterkünfte (Bremen → Hamburg)';

export default async function (t) {
  await stagesAndStays(t);
  await nightsWithoutStay(t);
  await danishShelters(t);
}

/**
 * Shelter in Dänemark (amenity=shelter + shelter_type=lean_to): nur zugeschaltet, als Platz zusammengefasst,
 * mit Kurzinfo, Hinweis und Link zur Info-/Buchungsseite. Søhøjlandet zwischen Aarhus und Silkeborg hat viele.
 */
async function danishShelters({ app, page: newPage, check, step }) {
  step('Shelter in Dänemark');
  const page = await newPage({ height: 950 });
  await page.open(app, { view: { center: [56.15, 9.9], zoom: 10 }, storage: {
    bike: 'trekking', mode: 'ab', stageMaxKm: 30, stayTypes: ['shelter'], endStay: false } });
  check('Einstellungen: Shelter als eigene Unterkunftsart', await page.ev(`[...document.querySelectorAll('#stay-types label')].some(l => l.textContent.trim() === 'Shelter (DK, SE, NO)')`));
  await page.ev(`(async () => { const w = await import('/js/app/waypoints.js');
    w.setPoint('start', { lat: 56.1567, lon: 10.2108, label: 'Aarhus' }); w.setPoint('end', { lat: 56.1697, lon: 9.5451, label: 'Silkeborg' }); return true; })()`);
  await page.waitFor(`!document.querySelector('#results').hidden && document.querySelector('#stat-dist').textContent && !document.querySelector('#stages').hidden`, 120000);
  await page.ev(`document.querySelector('#btn-multiday').click(); true`);
  check('Etappen geplant', await page.waitFor(`!document.querySelector('#stages-body').hidden && !document.querySelector('#status').classList.contains('loading')
    && document.querySelectorAll('#stage-list > li').length >= 2`, 180000), await page.text('#stages-summary'));
  const r = await page.ev(`(async () => {
    const { state } = await import('/js/app/state.js');
    const nights = state.route.stays.nights.filter(n => n.chosen);
    return { types: nights.map(n => n.chosen.poi.type), counts: nights.map(n => n.chosen.poi.count),
      options: [...document.querySelectorAll('#stage-list select option')].map(o => o.textContent).slice(0, 3),
      meta: document.querySelector('#stage-list .night select + .meta')?.textContent || '',
      links: [...document.querySelectorAll('#stage-list .night .links a')].map(a => a.textContent + ' ' + a.href),
      pins: document.querySelectorAll('.stay-pin').length };
  })()`);
  // Bis der Datenauszug mit Sheltern neu gebaut ist (GitHub Actions nach Änderungen an poiSource.js; lokal
  // `npm run extract:update`), liefert er für Dänemark Unterkunfts-Kacheln ohne Shelter
  if (!r.types.length) {
    check('Datenauszug enthält noch keine Shelter – übersprungen (npm run extract:update)', true);
    return;
  }
  check('Jede Nacht ein Shelter', r.types.every(t => t === 'shelter'), JSON.stringify(r.types));
  check('Plätze zusammengefasst (Anzahl bekannt)', r.counts.every(n => n >= 1), JSON.stringify(r.counts));
  check('Auswahlliste mit Shelter-Symbol', r.options.length > 0 && r.options.every(o => o.startsWith('🛖')), r.options.join(' | '));
  check('Zeile nennt Shelter und Preis', /^Shelter · (kostenlos|ca\. 0–10 €|\d+ €)/.test(r.meta), r.meta);
  check('Kein „Preis prüfen“ bei Sheltern', r.links.every(l => !l.startsWith('Preis prüfen')), r.links.join(' | '));
  check('Marker auf der Karte', r.pins >= 1, `${r.pins}`);
  await page.ev(`(async () => { const { state } = await import('/js/app/state.js'); const { map } = await import('/js/app/mapView.js');
    map.openStay(state.route.stays.nights.find(n => n.chosen).chosen.poi.id); return true; })()`);
  const popup = await page.ev(`document.querySelector('.leaflet-popup-content')?.textContent || ''`);
  check('Popup: Hinweis zu Schlafsack und Isomatte', popup.includes('Schlafsack und Isomatte'), popup.slice(0, 160));
  await page.shot('3-shelter');
}

async function stagesAndStays({ app, page: newPage, check, step, sleep }) {
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
  check('Mehrtagestour ist die Hauptaktion, GPX tritt zurück', await ev(`document.querySelector('#btn-multiday').classList.contains('primary')
    && !document.querySelector('#btn-gpx').classList.contains('primary')`));

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
  check('GPX wieder Hauptaktion', await ev(`document.querySelector('#btn-gpx').classList.contains('primary')`));
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
  check('„Als GPX“ in jeder Tageszeile', await ev(`document.querySelectorAll('#stage-list .day-links button[aria-label$="als GPX exportieren"]').length`) === days);
  const suns = await ev(`[...document.querySelectorAll('#stage-list .sun')].map(e => e.textContent)`);
  check('Tageslicht-Hinweis in jeder Tageszeile', suns.length === days && suns.every(x => /Sonnen(auf|unter)gang/.test(x)), suns[0]);
  // Bis die Mehrtagestour geladen ist, steht noch das Wetter der Route davor (eine Zeile) da
  await waitFor(`document.querySelector('#weather-summary').children.length === ${days}`, 20000);
  const weather = await ev(`[...document.querySelector('#weather-summary').children].map(e => e.textContent)`);
  check('Wetter je Tag', weather.length === days && weather.every((x, i) => x.startsWith('Tag ' + (i + 1) + ' · ') && x.includes(' °C · ')), JSON.stringify(weather));
  const label = await ev(`document.querySelectorAll('#stage-list .day-links button[aria-label$="als GPX exportieren"]')[1].getAttribute('aria-label')`);
  check('Name für Screenreader', label === 'Tag 2 als GPX exportieren', label);
  await ev(`document.querySelectorAll('#stage-list .day-links button[aria-label$="als GPX exportieren"]')[1].click(); true`);
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
  // FIT-Kurs je Tag (js/fit.js): Download mit FIT-Kopf, Kurspunkt der Unterkunft am Ende von Tag 1
  check('„Als FIT“ in jeder Tageszeile', await ev(`document.querySelectorAll('#stage-list .day-links button[aria-label$="als FIT-Kurs exportieren"]').length`) === days);
  await ev(`window.__dl = []; document.querySelector('#stage-list .day-links button[aria-label="Tag 1 als FIT-Kurs exportieren"]').click(); true`);
  check('Tag 1 als FIT', await waitFor(`window.__dl.length === 1`, 5000) && /_Tag_1\.fit$/.test(await ev(`window.__dl[0].name`)), await ev(`window.__dl[0]?.name`));
  const fitDay = await ev(`window.__dl[0].blob.arrayBuffer().then(b => { const t = new TextDecoder('latin1').decode(new Uint8Array(b));
    return { sig: t.slice(8, 12), night: t.includes('Nacht 1') }; })`);
  check('FIT-Datei mit Kopf und der Unterkunft als Kurspunkt', fitDay.sig === '.FIT' && fitDay.night, JSON.stringify(fitDay));
  await ev(`window.__dl = []; document.querySelector('#btn-stages-fit').click(); true`);
  check('„als FIT“: eine Datei je Tag', await waitFor(`window.__dl.length === ${days}`, 10000) && await ev(`window.__dl.every(d => d.name.endsWith('.fit'))`),
    await ev(`window.__dl.map(d => d.name).join(', ')`));

  step('Länge von Tag 2 im Fenster ändern');
  // Länge eines Tages auf der Route ohne Übernachtungen (darauf bezieht sich der Regler), dazu die Anpassung
  const split = `(async () => {
    const { state } = await import('/js/app/state.js');
    const p = state.route.stays, along = k => (k < 0 ? 0 : p.nights[k].chosen?.along ?? p.nights[k].target);
    return { days: p.days, day1: Math.round(along(0) / 1000), day2: Math.round((along(1) - along(0)) / 1000), fixed: p.fixed,
      stageKm: state.stageKm, choice1: state.stayChoices[0] };
  })()`;
  const edit = day => `#stage-list .length-edit[aria-label="Länge von Tag ${day} ändern"]`;
  /** Zustand des Fensters: offen, Titel, Regler und Vorschau */
  const dialog = `(() => { const d = document.querySelector('#stage-dialog'), r = document.querySelector('#stage-km'), t = s => document.querySelector(s).textContent;
    return { open: d.open, title: t('#stage-dialog-title'), value: +r.value, min: +r.min, max: +r.max, valuetext: r.getAttribute('aria-valuetext'),
      km: t('#stage-km-value'), time: t('#stage-time'), ascent: t('#stage-ascent'), arrival: t('#stage-arrival'),
      light: document.querySelector('#stage-daylight').hidden ? '' : t('#stage-daylight'), release: !document.querySelector('#stage-release').hidden,
      focus: document.activeElement === r }; })()`;
  const slide = km => ev(`(() => { const r = document.querySelector('#stage-km'); r.value = ${km}; r.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const press = value => ev(`document.querySelector('#stage-dialog button[value=${value}]').click(); true`);
  /** Minuten aus „ca. 3 h 45 min“ bzw. „ca. 45 min“ */
  const minutes = text => { const h = /(\d+) h/.exec(text), m = /(\d+) min/.exec(text); return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0); };
  const before = await ev(split);
  const edits = await ev(`[...document.querySelectorAll('#stage-list .length-edit')].map(b => b.getAttribute('aria-label'))`);
  check('„Länge ändern“ an allen Tagen außer dem letzten', edits.length === before.days - 1 && edits[1] === 'Länge von Tag 2 ändern', edits.join(' | '));
  check('Am Anfang nichts fest', !before.fixed.some(Boolean) && !(await ev(`document.querySelector('#stage-list').textContent.includes('· fest')`)),
    JSON.stringify(before));

  await ev(`document.querySelector('${edit(2)}').click(); true`);
  const opened = await ev(dialog);
  check('Fenster offen, Fokus auf dem Regler', opened.open && opened.focus, JSON.stringify(opened));
  check('Titel nennt Tag 2', opened.title.startsWith('Tag 2 · '), opened.title);
  check('Regler steht auf der jetzigen Länge', opened.value === before.day2 && opened.km === `${before.day2} km`, `${opened.value} / ${before.day2}`);
  check('Bereich: ab 10 km, nicht bis zum Ziel', opened.min === 10 && opened.max > before.day2 && opened.max < 130, `${opened.min}–${opened.max}`);
  check('Vorschau: Fahrzeit, Höhenmeter, Ankunft', /^ca\. .*min$|^ca\. \d+ h$/.test(opened.time) && /↑$/.test(opened.ascent) && /^ca\. .*\d\d:\d\d$/.test(opened.arrival),
    `${opened.time} · ${opened.ascent} · ${opened.arrival}`);
  check('Tageslicht im Fenster', /Sonnen|Dunkel|Tageslicht/.test(opened.light), opened.light);
  check('Regler für Screenreader mit Fahrzeit', opened.valuetext === `${before.day2} km, Fahrzeit ${opened.time}`, opened.valuetext);
  check('„Länge freigeben“ nur bei festem Tag', !opened.release);
  // Barrierefreiheit des offenen Fensters (a11y.test.mjs prüft keine Dialoge)
  await ev((await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js')).text()) + '; true');
  const axe = await ev(`axe.run(document.querySelector('#stage-dialog'), { resultTypes: ['violations'] })
    .then(r => r.violations.map(v => v.id + ': ' + v.nodes.length))`);
  check('Fenster ohne axe-Verstöße', !axe.length, axe.join(', '));
  await slide(before.day2 - 10);
  const slid = await ev(dialog);
  check('Ziehen: Länge und Fahrzeit laufen mit', slid.km === `${before.day2 - 10} km` && minutes(slid.time) < minutes(opened.time),
    `${opened.km} ${opened.time} → ${slid.km} ${slid.time}`);
  await page.shot('1a-fenster');
  await press('cancel');
  await sleep(300);
  check('Abbrechen ändert nichts', !(await ev(dialog)).open && !(await ev(split)).stageKm.length);

  await ev(`document.querySelector('${edit(2)}').click(); true`);
  await slide(before.day2 - 10);
  await press('ok');
  // Fertig neu geplant: Tag 1 und 2 stehen als „fest“ in der Liste
  const idle = `!document.querySelector('#stages-body').hidden && !document.querySelector('#status').classList.contains('loading')`;
  const fixedRows = `[...document.querySelectorAll('#stage-list > li .day small')].map(s => s.textContent.endsWith('· fest'))`;
  const replanned = `${idle} && ${fixedRows}.slice(0, 2).every(Boolean)`;
  check('Übernommen und neu geplant, Tag 1 und 2 fest', await waitFor(replanned, 120000));
  const after = await ev(split);
  check('Gewünschte Länge gemerkt', after.stageKm[1] === before.day2 - 10 && after.fixed[1], JSON.stringify(after.stageKm));
  check('Tag 2 kürzer als vorher', after.day2 <= before.day2 - 5, `${before.day2} → ${after.day2} km`);
  check('Tag 1 bleibt, wie er war, und gilt als fest', after.stageKm[0] === before.day1 && after.fixed[0] && after.day1 === before.day1,
    `${before.day1} → ${after.day1} km, ${JSON.stringify(after.stageKm)}`);
  check('Unterkunft von Nacht 1 bleibt', after.choice1 === before.choice1, `${before.choice1} → ${after.choice1}`);
  check('Tage gleich viele oder einer mehr', after.days === before.days || after.days === before.days + 1, `${before.days} → ${after.days}`);
  const undo = await ev(`document.querySelector('#btn-undo').getAttribute('aria-label')`);
  check('„Rückgängig“ nennt die Änderung', undo === `Rückgängig: Tag 2 auf ${before.day2 - 10} km geändert`, undo);
  await ev(`document.querySelector('#btn-undo').click(); true`); await sleep(300);
  const undone = await ev(split);
  check('Rückgängig: vorige Aufteilung sofort zurück', !undone.fixed.some(Boolean) && !undone.stageKm.length && undone.day2 === before.day2,
    JSON.stringify(undone));
  await ev(`document.querySelector('#btn-redo').click(); true`); await sleep(300);
  check('Wiederholen: Anpassung wieder da', (await ev(split)).stageKm[1] === before.day2 - 10);
  await page.shot('1b-tag-kuerzer');

  step('Speichern und wieder öffnen');
  check('Konto angelegt', await register(page, 'md_test'));
  await ev(`document.querySelector('#settings-dialog').close(); true`);
  check('Gespeichert', await saveRoute(page, 'Bremen–Hamburg 3 Tage'));
  await ev(`document.querySelector('#btn-clear').click(); true`); await sleep(500);
  check('Nach „Löschen“ keine Etappen mehr', await ev(`document.querySelector('#stages').hidden && !document.querySelectorAll('.stay-pin').length`));
  await ev(`document.querySelector('#my-routes').open = true; document.querySelector('#my-routes-list li button.row').click(); true`);
  check('Gespeicherte Mehrtagestour wieder geöffnet', await waitFor(`!document.querySelector('#stages-body').hidden && document.querySelector('#stage-list select')`, 180000));
  if (sel.n > 1) check('Gewählte Unterkunft wiederhergestellt', await ev(`document.querySelector('#stage-list select').value`) === sel.alt);
  await waitFor(replanned, 60000);
  check('Angepasste Länge von Tag 2 wiederhergestellt', (await ev(split)).stageKm[1] === before.day2 - 10, JSON.stringify((await ev(split)).stageKm));
  await page.shot('2-wieder');

  step('Länge freigeben');
  await ev(`document.querySelector('${edit(2)}').click(); true`);
  check('Fester Tag: „Länge freigeben“ im Fenster', (await ev(dialog)).release);
  await press('release');
  check('Tag 2 freigegeben, Tag 1 bleibt fest',
    await waitFor(`${idle} && document.querySelector('${edit(2)}') && (r => r[0] && !r[1])(${fixedRows})`, 120000));
  const one = await ev(split);
  check('Nur noch Tag 1 gemerkt', JSON.stringify(one.stageKm) === JSON.stringify([before.day1]), JSON.stringify(one.stageKm));
  await ev(`document.querySelector('${edit(1)}').click(); true`);
  await press('release');
  check('Alles freigegeben', await waitFor(`${idle} && document.querySelector('${edit(1)}') && !${fixedRows}.some(Boolean)`, 120000));
  const reset = await ev(split);
  check('Gleichmäßige Aufteilung wie am Anfang', !reset.stageKm.length && reset.days === before.days, JSON.stringify(reset));

  step('Aufheben');
  await waitFor(`!document.querySelector('#status').classList.contains('loading')`, 60000);
  await ev(`document.querySelector('#btn-multiday').click(); true`);
  check('Mehrtagestour aufgehoben', await waitFor(`document.querySelector('#stages-body').hidden && !document.querySelectorAll('.stay-pin').length`, 60000),
    `Knopf „${await text('#btn-multiday')}“`);
}

/**
 * Nächte ohne passende Unterkunft: Die Tagesgrenze liegt dann am Etappenziel. Sie muss auch die Route durch
 * die übrigen Unterkünfte und durch Verpflegungsstopps überstehen – früher verschmolzen solche Tage, sobald
 * Stopps eingeplant waren, und alle Ankunftszeiten danach stimmten nicht mehr.
 */
async function nightsWithoutStay({ app, page: newPage, check, step, sleep }) {
  const MAX_KM = 30;
  const result = {};
  for (const supply of [false, true]) {
    step(`Nächte ohne Unterkunft – ${supply ? 'mit' : 'ohne'} Verpflegungsstopps`);
    const page = await newPage({ height: 950 });
    // Nur Hostels: Zwischen Bremen und Hamburg gibt es nicht für jede Nacht eins
    await page.open(app, { view: { center: [53.3, 9.4], zoom: 9 }, storage: {
      bike: 'trekking', mode: 'ab', stageMaxKm: MAX_KM, stayTypes: ['hostel'], endStay: false,
      supplyEnabled: supply, supplyInterval: 25,
    } });
    await departNextWednesday(page);
    await page.clickMap(53.064, 8.793); await sleep(800);
    await page.clickMap(53.553, 10.0067);
    await page.waitFor(`!document.querySelector('#results').hidden && document.querySelector('#stat-dist').textContent`, 120000);
    await page.ev(`document.querySelector('#btn-multiday').click(); true`);
    const ready = `!document.querySelector('#stages-body').hidden && !document.querySelector('#status').classList.contains('loading')
      && document.querySelectorAll('#stage-list > li').length > 0` + (supply ? ` && !document.querySelector('#stops').hidden` : '');
    check('Etappen geplant', await page.waitFor(ready, 180000));
    await sleep(1500);
    const r = await page.ev(`(async () => {
      const { state } = await import('/js/app/state.js');
      const { stageStats } = await import('/js/timeline.js');
      const route = state.route, nights = route.stays.nights;
      return { nights: nights.length, open: nights.filter(n => !n.chosen).length, stops: route.stops?.length ?? 0,
        days: stageStats(route, state.bike).map((d, i) => ({ km: d.distance / 1000, stay: !!nights[i]?.chosen })),
        rows: document.querySelectorAll('#stage-list > li').length, summary: document.querySelector('#stages-summary').textContent };
    })()`);
    result[supply] = r;
    const kms = r.days.map(d => d.km.toFixed(1)).join(' · ');
    check('Testaufbau: mindestens eine Nacht ohne Unterkunft', r.open > 0, `${r.open} von ${r.nights}${supply ? `, ${r.stops} Stopps` : ''}`);
    check('Ein Tag mehr als Nächte', r.days.length === r.nights + 1, kms);
    check('Liste und Zusammenfassung passen dazu', r.rows === r.days.length && r.summary.startsWith(`${r.days.length} Tage`), r.summary);
    // Tage, die an einer Nacht ohne Unterkunft enden, halten die km pro Tag ein (die mit Unterkunft bestimmt diese)
    check(`Tage ohne Unterkunft am Ende höchstens ${MAX_KM * 1.25} km`, r.days.slice(0, -1).every(d => d.stay || d.km <= MAX_KM * 1.25), kms);
  }
  check('Mit und ohne Stopps gleich viele Tage', result[true].days.length === result[false].days.length,
    `${result[false].days.length} / ${result[true].days.length}`);
}
