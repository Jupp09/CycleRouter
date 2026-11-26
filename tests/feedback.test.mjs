// Feedback geben (js/app/feedbackView.js → /api/feedback, hier die Attrappe aus lib/fakeAccount.mjs mit derselben
// Prüfung wie der Server): nur mit Server-Datenbank sichtbar, freiwillige Angaben nur per Häkchen, die Vorschau
// zeigt, was gesendet wird, Fehler bleiben im Dialog, Erfolg schließt ihn.
import { BONN, HAS_ROUTE } from './lib/app.mjs';

export const title = 'Feedback geben';

export default async function ({ app, page: newPage, check, step, sleep, accounts }) {
  step('Ohne Server-Datenbank kein Eintrag');
  const plain = await newPage();
  await plain.open(app, { view: BONN });
  await sleep(500);
  check('„Feedback geben“ ausgeblendet', await plain.ev(`document.querySelector('#feedback-entry').hidden`));

  step('Mit Datenbank: Dialog öffnen');
  const page = await newPage({ accounts: true, height: 950 });
  const { ev } = page;
  await page.open(app, { view: BONN });
  check('„Feedback geben“ sichtbar', await page.waitFor(`!document.querySelector('#feedback-entry').hidden`, 10000));
  await page.clickMap(50.94, 6.95); await sleep(800);
  await page.clickMap(50.73, 7.10);
  check('Route berechnet', await page.waitFor(HAS_ROUTE, 120000));
  await ev(`document.querySelector('#btn-feedback').click(); true`); await sleep(300);
  const opened = await ev(`(() => { const d = document.querySelector('#feedback-dialog');
    return { open: d.open, focus: document.activeElement?.id, kind: d.querySelector('#feedback-kind [aria-checked=true]')?.dataset.value,
      tech: d.querySelector('#feedback-tech').checked, route: d.querySelector('#feedback-route').checked,
      routeEnabled: !d.querySelector('#feedback-route').disabled }; })()`);
  check('Offen, Fokus im Textfeld, „Fehler“ vorgewählt', opened.open && opened.focus === 'feedback-text' && opened.kind === 'bug', JSON.stringify(opened));
  check('Zusätze standardmäßig aus, Routen-Link wählbar', !opened.tech && !opened.route && opened.routeEnabled, JSON.stringify(opened));

  step('Zu kurz: Hinweis, Dialog bleibt offen');
  await ev(`{ const t = document.querySelector('#feedback-text'); t.value = 'kurz'; t.dispatchEvent(new Event('input')); } true`);
  await ev(`document.querySelector('#btn-feedback-send').click(); true`); await sleep(300);
  check('Meldung „mindestens 10 Zeichen“', await ev(`document.querySelector('#feedback-dialog').open && /mindestens 10 Zeichen/.test(document.querySelector('#feedback-msg').textContent)`));
  check('Nichts gesendet', accounts.feedback.length === 0);

  step('Vorschau zeigt, was gesendet wird');
  await ev(`document.querySelector('#feedback-kind [data-value=idea]').click(); true`);
  await ev(`{ const t = document.querySelector('#feedback-text'); t.value = 'Bitte eine Höhenlinien-Karte anbieten.'; t.dispatchEvent(new Event('input')); } true`);
  await ev(`{ const e = document.querySelector('#feedback-email'); e.value = 'test@example.org'; e.dispatchEvent(new Event('input')); } true`);
  for (const id of ['#feedback-tech', '#feedback-route']) await ev(`{ const c = document.querySelector('${id}'); c.checked = true; c.dispatchEvent(new Event('input', { bubbles: true })); } true`);
  check('Hinweis verschwindet beim Weitertippen', await ev(`document.querySelector('#feedback-msg').hidden`));
  const preview = await ev(`document.querySelector('#feedback-preview-text').textContent`);
  check('Vorschau: Art, Nachricht, E-Mail, Browser, Route', /^Art: Vorschlag/.test(preview) && /Höhenlinien/.test(preview) && /E-Mail: test@example\.org/.test(preview)
    && /Browser: /.test(preview) && /Route: http.*#v=1/.test(preview), preview.slice(0, 160));
  await page.shot('1-feedback');

  step('Senden');
  await ev(`document.querySelector('#btn-feedback-send').click(); true`);
  check('Dialog schließt nach dem Senden', await page.waitFor(`!document.querySelector('#feedback-dialog').open`, 10000));
  const sent = accounts.feedback[0];
  check('Angekommen wie in der Vorschau', sent?.kind === 'idea' && sent.email === 'test@example.org' && /Höhenlinien/.test(sent.text)
    && /#v=1/.test(sent.route) && !!sent.tech?.browser, JSON.stringify(sent && { ...sent, tech: !!sent.tech, route: !!sent.route }));
  check('Keine Orte in den technischen Angaben', !/\d+\.\d{3,}/.test(JSON.stringify(sent?.tech?.errors ?? [])));
  check('Dank in der Statuszeile', /Danke/.test(await ev(`document.querySelector('#status').textContent`)));
  check('Formular danach leer, Häkchen aus', await ev(`!document.querySelector('#feedback-text').value && !document.querySelector('#feedback-tech').checked`));

  step('Ohne Route: Routen-Link nicht wählbar');
  await ev(`document.querySelector('#btn-clear')?.click(); true`); await sleep(500);
  await ev(`document.querySelector('#btn-feedback').click(); true`); await sleep(300);
  const noRoute = await ev(`({ disabled: document.querySelector('#feedback-route').disabled, hint: document.querySelector('#feedback-route-hint').textContent })`);
  check('Häkchen gesperrt mit Begründung', noRoute.disabled && /keine?n? Link|nicht als Link/.test(noRoute.hint), JSON.stringify(noRoute));
  const axe = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js')).text();
  await ev(axe + '; true');
  const violations = await ev(`axe.run(document.querySelector('#feedback-dialog'), { resultTypes: ['violations'] })
    .then(r => r.violations.map(v => v.id + ' (' + v.nodes.length + '×)'))`);
  check('axe: 0 Verstöße im Dialog', Array.isArray(violations) && !violations.length, JSON.stringify(violations));
  await ev(`document.querySelector('#feedback-dialog [data-close]').click(); true`);
  check('Kreuz schließt ohne Senden', !(await ev(`document.querySelector('#feedback-dialog').open`)) && accounts.feedback.length === 1);

  step('Zweiter Weg: über die Einstellungen');
  await ev(`document.querySelector('#btn-settings').click(); true`); await sleep(300);
  check('Abschnitt „Feedback“ in den Einstellungen', await ev(`!document.querySelector('#feedback-settings').hidden`));
  await ev(`document.querySelector('#btn-feedback-settings').click(); true`); await sleep(300);
  check('Feedback öffnet über den Einstellungen', await ev(`document.querySelector('#feedback-dialog').open && document.querySelector('#settings-dialog').open`));
  await ev(`document.querySelector('#feedback-dialog [data-close]').click(); true`);
  check('Danach wieder in den Einstellungen', await ev(`!document.querySelector('#feedback-dialog').open && document.querySelector('#settings-dialog').open`));
}
