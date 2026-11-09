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
    check('Andere Unterkunft gewählt → neu berechnet', await waitFor(`document.querySelector('#stage-list select')?.value === ${JSON.stringify(sel.alt)}`, 120000), sel.altText);
  }

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
