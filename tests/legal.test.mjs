// Impressum und Datenschutz: Links in der App, Auslieferung mit Angaben aus der .env (server/static.mjs), Barrierefreiheit.
// Der Testserver hat keine IMPRESSUM_*-Angaben – die Seiten zeigen dann markierte Hinweise statt leerer Stellen.
import { BONN } from './lib/app.mjs';

export const title = 'Impressum und Datenschutz';

export default async function ({ app, page: newPage, check, step }) {
  const page = await newPage();
  const { ev, waitFor } = page;
  await page.open(app, { view: BONN });

  step('Links in der App');
  const links = await ev(`[...document.querySelectorAll('.legal-links a')].map(a => ({ href: a.getAttribute('href'), text: a.textContent, target: a.target, visible: !!a.offsetParent }))`);
  check('Impressum und Datenschutz am Ende des Panels, in neuem Tab', links.length === 2 && links[0].href === 'impressum.html' && links[1].href === 'datenschutz.html'
    && links.every(l => l.target === '_blank' && l.visible && l.text.includes('neuem Tab')), JSON.stringify(links));
  check('Konto und Feedback verweisen auf ihren Abschnitt', await ev(`!!document.querySelector('#account-info a[href="datenschutz.html#konto"]')
    && !!document.querySelector('#feedback-dialog a[href="datenschutz.html#feedback"]')`));

  const axe = await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js')).text();
  for (const [path, heading] of [['impressum.html', 'Impressum'], ['datenschutz.html', 'Datenschutzerklärung']]) {
    step(path);
    await ev(`location.href = ${JSON.stringify(new URL(path, app).href)}; true`);
    check('Seite geladen', await waitFor(`location.pathname.endsWith(${JSON.stringify('/' + path)}) && document.readyState === 'complete' && !!document.querySelector('h1')`, 15000));
    const info = await ev(`({ h1: document.querySelector('h1').textContent, lang: document.documentElement.lang,
      missing: [...document.querySelectorAll('mark.missing')].map(m => m.textContent), raw: document.body.innerHTML.includes('{{'),
      mailto: document.querySelector('a[href^="mailto:"]')?.getAttribute('href'), back: document.querySelector('.back a')?.getAttribute('href') })`);
    check('Überschrift und Sprache', info.h1 === heading && info.lang === 'de', JSON.stringify(info));
    check('Ohne .env-Angaben: markierte Hinweise, keine rohen Platzhalter', info.missing.length >= 3 && !info.raw
      && info.missing.some(m => m.includes('IMPRESSUM_NAME')), info.missing.join(' | '));
    check('E-Mail-Link ohne Markup im Attribut', info.mailto === 'mailto:', String(info.mailto));
    check('Zurück zur App', info.back === './');
    await ev(axe + '; true');
    const violations = await ev(`axe.run(document, { resultTypes: ['violations'] }).then(r => r.violations.map(v => v.id))`);
    check('axe: 0 Verstöße', Array.isArray(violations) && !violations.length, JSON.stringify(violations));
  }
  const anchors = await ev(`[...document.querySelectorAll('nav a')].every(a => document.getElementById(a.getAttribute('href').slice(1)))`);
  check('Inhaltsverzeichnis: jeder Eintrag hat sein Ziel', anchors);
}
