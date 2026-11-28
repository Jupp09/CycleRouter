// Impressum und Datenschutz: Angaben aus der .env einsetzen (server/static.mjs fillTemplate)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillTemplate, TEMPLATE_VARS } from '../../server/static.mjs';

const page = name => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const ENV = {
  IMPRESSUM_NAME: 'Erika <Muster>', IMPRESSUM_ADDRESS: 'Weg 1 | 12345 Ort', IMPRESSUM_EMAIL: 'e@example.org', HOSTER_LOG_DAYS: '7',
};

test('Werte maskiert, Anschrift zeilenweise, Pflichtangabe fehlt sichtbar', () => {
  const out = fillTemplate('<p>{{IMPRESSUM_NAME}}<br>{{IMPRESSUM_ADDRESS}}</p><p>{{HOSTER_LOG_DAYS}}</p>', { ...ENV, HOSTER_LOG_DAYS: ' ' });
  assert.equal(out, '<p>Erika &lt;Muster&gt;<br>Weg 1<br>12345 Ort</p><p><mark class="missing">[in der .env eintragen: HOSTER_LOG_DAYS]</mark></p>');
});

test('Attribute bekommen nur den Wert, freiwillige Blöcke nur mit Angabe', () => {
  const html = '<a href="mailto:{{IMPRESSUM_EMAIL}}">{{IMPRESSUM_EMAIL}}</a><!--wenn IMPRESSUM_PHONE--> Tel. {{IMPRESSUM_PHONE}}<!--/wenn-->';
  assert.equal(fillTemplate(html, ENV), '<a href="mailto:e@example.org">e@example.org</a>');
  assert.equal(fillTemplate(html, { ...ENV, IMPRESSUM_PHONE: '0123 45' }), '<a href="mailto:e@example.org">e@example.org</a> Tel. 0123 45');
  assert.match(fillTemplate(html, {}), /^<a href="mailto:">/, 'leerer Link statt Markup im Attribut');
  assert.equal(fillTemplate('<a title="{{IMPRESSUM_NAME}}">', ENV), '<a title="Erika &lt;Muster&gt;">');
});

test('Seiten: nur bekannte Platzhalter, vollständig ausgefüllt ohne Hinweis', () => {
  for (const name of ['impressum.html', 'datenschutz.html']) {
    const html = page(name);
    const used = [...html.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    assert.ok(used.length, name);
    for (const v of used) assert.ok(TEMPLATE_VARS.includes(v), `${name}: unbekannter Platzhalter ${v}`);
    const out = fillTemplate(html, { ...ENV, IMPRESSUM_PHONE: '1' });
    assert.ok(!out.includes('{{') && !out.includes('missing'), name);
    assert.ok(out.includes('Erika &lt;Muster&gt;'), name);
  }
});
