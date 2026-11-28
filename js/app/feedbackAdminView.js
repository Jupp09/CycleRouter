/**
 * „Feedback verwalten“ (nur für Konten in ADMIN_USERS, server/auth.mjs isAdmin): Rückmeldungen lesen, in der App
 * beantworten, als erledigt markieren und löschen (server/feedbackApi.mjs, /api/feedback/admin).
 *
 * Erreichbar über die Einstellungen; der Eintrag zeigt die Zahl offener Meldungen. Alles kommt vom Server und
 * wird mit textContent gesetzt (Texte der Nutzer, nie innerHTML). Nach jeder Änderung wird die Liste neu geladen –
 * sie ist kurz, und so stimmen Zähler und Filter immer.
 */
import { account, adminFeedbackList, adminFeedbackUpdate, adminFeedbackDelete } from '../account.js';
import { formatDate, formatClock } from '../utils.js';
import { on } from './state.js';
import { $, $$, el, ask } from './dom.js';

const KIND = { bug: 'Fehler', idea: 'Vorschlag', critique: 'Kritik' };
const dialog = $('#feedback-admin-dialog');
let filter = 'open';

/** Link aus der Benachrichtigungs-Mail (server/feedbackApi.mjs notifyText): öffnet die Verwaltung nach der Anmeldung */
const DEEP_LINK = '#feedback-verwalten';

on('account', () => {
  const admin = !!account.user?.admin && !account.offline;
  $('#btn-feedback-admin').hidden = !admin;
  if (admin) refreshCount();
  // Noch nicht angemeldet: den Link stehen lassen, die Anmeldung löst dieses Ereignis erneut aus
  if (location.hash === DEEP_LINK && account.user) {
    history.replaceState(null, '', location.pathname + location.search);
    if (admin) openAdmin();
  }
});

/** Zahl offener Meldungen am Eintrag in den Einstellungen. */
async function refreshCount() {
  try {
    const { counts } = await adminFeedbackList('open');
    $('#feedback-admin-count').textContent = counts.open ? `(${counts.open} offen)` : '';
  } catch { /* ohne Zahl */ }
}

const when = d => `${formatDate(new Date(d))} ${formatClock(new Date(d))}`;

function message(text, isError = false) {
  const m = $('#feedback-admin-msg');
  m.textContent = text;
  m.classList.toggle('error', isError);
}

/** Aktion ausführen, danach neu laden; Fehler stehen im Dialog. */
async function act(fn, done) {
  try {
    await fn();
    await load();
    message(done);
  } catch (e) {
    message(e.message, true);
  }
}

/** Eine Meldung: Kopf, Text, Angaben, Antwortfeld, Aktionen. */
function item(f) {
  const li = el('li', `feedback-item${f.done ? ' done' : ''}`);
  li.setAttribute('aria-labelledby', `fb-head-${f.id}`);
  const who = [f.username ? `Konto ${f.username}` : 'ohne Konto', f.email].filter(Boolean).join(' · ');
  const head = el('h3', 'feedback-head', `#${f.id} · ${KIND[f.kind] ?? f.kind} · ${when(f.createdAt)}${f.done ? ' · erledigt' : ''}`);
  head.id = `fb-head-${f.id}`;
  li.append(head, el('p', 'feedback-meta', who), el('blockquote', 'feedback-text', f.text));
  if (f.done && f.doneAt) {
    // Löschfrist wie in der Datenschutzerklärung (server/feedbackApi.mjs KEEP_DONE_MONTHS)
    const until = new Date(f.doneAt);
    until.setMonth(until.getMonth() + 12);
    li.append(el('p', 'hint', `Wird am ${formatDate(until)} automatisch gelöscht (12 Monate nach dem Erledigen).`));
  }

  const facts = [];
  if (f.email) {
    const a = el('a', '', `E-Mail an ${f.email}`);
    a.href = `mailto:${f.email}?subject=${encodeURIComponent(`Dein Feedback zu CycloRouter (#${f.id})`)}`;
    facts.push(a);
  }
  if (f.route) {
    const a = el('a', '', 'Route öffnen');
    a.href = f.route; a.target = '_blank'; a.rel = 'noopener';
    a.append(el('span', 'sr-only', ' (öffnet in neuem Tab)'));
    facts.push(a);
  }
  if (facts.length) { const p = el('p', 'feedback-links'); p.append(...facts); li.append(p); }
  if (f.tech) {
    const d = el('details', 'more');
    d.append(el('summary', '', 'Technische Angaben'), el('pre', '', [
      `Browser: ${f.tech.browser}`, `Bildschirm: ${f.tech.screen}`, `Sprache: ${f.tech.language}`,
      `Installierte App: ${f.tech.standalone ? 'ja' : 'nein'}`,
      ...(f.tech.errors?.length ? ['Letzte Fehlermeldungen:', ...f.tech.errors.map(e => `  ${e}`)] : ['Keine Fehlermeldungen']),
    ].join('\n')));
    li.append(d);
  }

  // Antwort: erscheint beim Absender in der App (Konto oder Kennzeichen seines Browsers)
  const id = `fb-reply-${f.id}`;
  const label = el('label', 'field-label', f.reply ? `Deine Antwort (${when(f.repliedAt)})` : 'Antwort');
  label.htmlFor = id;
  const reply = el('textarea');
  reply.id = id; reply.rows = 3; reply.maxLength = 4000; reply.value = f.reply ?? '';
  li.append(label, reply);
  if (!f.reachable) {
    li.append(el('p', 'hint', 'Ohne Konto und vor der Antwort-Funktion gesendet – eine Antwort erreicht den Absender nicht.'));
    reply.disabled = true;
  }

  const actions = el('div', 'settings-buttons');
  const save = el('button', 'primary', f.reply ? 'Antwort ändern' : 'Antwort senden');
  save.type = 'button';
  save.disabled = !f.reachable;
  save.addEventListener('click', () => act(() => adminFeedbackUpdate(f.id, { reply: reply.value, ...(reply.value.trim() ? { done: true } : {}) }),
    reply.value.trim() ? `Antwort auf #${f.id} gespeichert, Meldung erledigt.` : `Antwort auf #${f.id} zurückgezogen.`));
  const toggle = el('button', '', f.done ? 'Wieder öffnen' : 'Als erledigt markieren');
  toggle.type = 'button';
  toggle.addEventListener('click', () => act(() => adminFeedbackUpdate(f.id, { done: !f.done }),
    f.done ? `#${f.id} wieder offen.` : `#${f.id} erledigt.`));
  const del = el('button', 'danger', 'Löschen');
  del.type = 'button';
  del.addEventListener('click', async () => {
    if (await ask({ title: `Rückmeldung #${f.id} endgültig löschen?`, ok: 'Löschen', danger: true }) == null) return;
    act(() => adminFeedbackDelete(f.id), `#${f.id} gelöscht.`);
  });
  actions.append(save, toggle, del);
  li.append(actions);
  return li;
}

async function load() {
  for (const b of $$('#feedback-admin-filter button')) b.setAttribute('aria-checked', String(b.dataset.value === filter));
  const { counts, items } = await adminFeedbackList(filter);
  for (const b of $$('#feedback-admin-filter button')) {
    const n = b.dataset.value === 'all' ? counts.open + counts.done : counts[b.dataset.value];
    b.textContent = `${{ open: 'Offen', done: 'Erledigt', all: 'Alle' }[b.dataset.value]} (${n})`;
  }
  $('#feedback-admin-count').textContent = counts.open ? `(${counts.open} offen)` : '';
  const list = $('#feedback-admin-list');
  list.replaceChildren(...items.map(item));
  if (!items.length) list.append(el('li', 'hint', filter === 'open' ? 'Keine offenen Rückmeldungen.' : 'Keine Rückmeldungen.'));
}

$('#feedback-admin-filter').addEventListener('click', e => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value || value === filter) return;
  filter = value;
  message('');
  load().catch(err => message(err.message, true));
});

$('#btn-feedback-admin').addEventListener('click', openAdmin);

async function openAdmin() {
  if (dialog.open) return;
  filter = 'open';
  message('Wird geladen …');
  dialog.showModal();
  try {
    await load();
    message('');
  } catch (e) {
    message(e.message, true);
  }
}
for (const b of $$('#feedback-admin-dialog [data-close]')) b.addEventListener('click', () => dialog.close());
