/**
 * „Feedback geben“: Fehler melden, Vorschlag machen, Kritik äußern (server/feedbackApi.mjs, Tabelle feedback).
 *
 * Nur mit Server-Datenbank – also genau dann, wenn es Konten gibt (account.enabled); sonst bleibt der Eintrag
 * ausgeblendet. Freiwillig und standardmäßig aus: E-Mail, technische Angaben und der Link zur Route (darin stehen
 * Orte). „Was wird gesendet?“ zeigt vorher wörtlich, was mitgeht. Das Formular sendet selbst (submit wird
 * abgefangen): Der Dialog bleibt offen, bis der Server die Meldung angenommen hat, und ein Fehler steht darin.
 */
import { account, sendFeedback } from '../account.js';
import { recentProblems } from '../errorReport.js';
import { state, on } from './state.js';
import { $, $$, flashStatus } from './dom.js';
import { isTrackRoute } from './linkView.js';

const TEXT_MIN = 10, TEXT_MAX = 4000; // wie server/feedbackApi.mjs
const KIND_PLACEHOLDER = {
  bug: 'Was ist passiert, und was hättest du erwartet? Wenn möglich: welche Route, welche Einstellung.',
  idea: 'Was würde dir CycloRouter leichter oder besser machen?',
  critique: 'Was stört dich? Auch Kleinigkeiten helfen.',
};

const dialog = $('#feedback-dialog');
const text = $('#feedback-text'), email = $('#feedback-email'), withTech = $('#feedback-tech'), withRoute = $('#feedback-route');
let kind = 'bug';
let sending = false;

on('account', () => {
  $('#feedback-entry').hidden = !account.enabled;
  $('#feedback-settings').hidden = !account.enabled;
});
// Aus den Einstellungen: Feedback öffnet sich über dem Einstellungsdialog, der danach offen bleibt
$('#btn-feedback-settings').addEventListener('click', () => $('#btn-feedback').click());

/** Technische Angaben – ohne Orte; die Fehlermeldungen sind schon bereinigt (errorReport.js). */
function techInfo() {
  return {
    browser: navigator.userAgent,
    screen: `${screen.width}×${screen.height}, Fenster ${innerWidth}×${innerHeight}`,
    language: navigator.language,
    standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    errors: recentProblems(),
  };
}

/** Link zur angezeigten Route (linkView.js schreibt sie in den #-Teil der Adresse); null ohne teilbare Route. */
function routeLink() {
  return state.route && !isTrackRoute(state.route) && location.hash.startsWith('#v=') ? location.href : null;
}

function body() {
  return {
    kind, text: text.value.trim(), email: email.value.trim() || undefined,
    tech: withTech.checked ? techInfo() : undefined,
    route: withRoute.checked ? routeLink() ?? undefined : undefined,
  };
}

function renderKind() {
  for (const b of $$('#feedback-kind button')) b.setAttribute('aria-checked', String(b.dataset.value === kind));
  text.placeholder = KIND_PLACEHOLDER[kind];
}

function renderCount() {
  const n = text.value.trim().length;
  $('#feedback-text-hint').textContent = n < TEXT_MIN
    ? `Mindestens ${TEXT_MIN} Zeichen.`
    : `${n} von ${TEXT_MAX} Zeichen.`;
}

/** „Was wird gesendet?“ – genau der Inhalt der Anfrage, lesbar. */
function renderPreview() {
  const b = body();
  const lines = [`Art: ${{ bug: 'Fehler', idea: 'Vorschlag', critique: 'Kritik' }[b.kind]}`, `Nachricht: ${b.text || '–'}`];
  if (b.email) lines.push(`E-Mail: ${b.email}`);
  if (b.tech) {
    lines.push(`Browser: ${b.tech.browser}`, `Bildschirm: ${b.tech.screen}`, `Sprache: ${b.tech.language}`,
      `Installierte App: ${b.tech.standalone ? 'ja' : 'nein'}`);
    lines.push(b.tech.errors.length ? `Letzte Fehlermeldungen:\n  ${b.tech.errors.join('\n  ')}` : 'Letzte Fehlermeldungen: keine');
  }
  if (b.route) lines.push(`Route: ${b.route}`);
  if (account.user) lines.push(`Konto: ${account.user.username}`);
  $('#feedback-preview-text').textContent = lines.join('\n');
}

function showMessage(message) {
  const msg = $('#feedback-msg');
  msg.textContent = message;
  msg.hidden = !message;
}

$('#feedback-kind').addEventListener('click', e => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value) return;
  kind = value;
  renderKind();
  renderPreview();
});
for (const el of [text, email, withTech, withRoute]) el.addEventListener('input', () => { renderCount(); renderPreview(); });
// Ein alter Hinweis (zu kurz, Server nicht erreichbar) gilt nach einer Änderung nicht mehr
text.addEventListener('input', () => showMessage(''));
for (const b of $$('#feedback-dialog [data-close]')) b.addEventListener('click', () => dialog.close('cancel'));

$('#btn-feedback').addEventListener('click', () => {
  // Art und Text bleiben bis zum Senden stehen (versehentlich geschlossen → nichts verloren)
  const link = routeLink();
  withRoute.disabled = !link;
  if (!link) withRoute.checked = false;
  $('#feedback-route-hint').hidden = !!link;
  $('#feedback-route-hint').textContent = state.route
    ? 'Importierte GPX-Strecken lassen sich nicht als Link mitsenden.'
    : 'Ohne angezeigte Route gibt es keinen Link.';
  $('#feedback-account-note').textContent = account.user ? ` Du bist angemeldet; die Meldung wird deinem Konto zugeordnet.` : '';
  showMessage('');
  renderKind();
  renderCount();
  renderPreview();
  dialog.showModal();
  dialog.querySelector('.settings-body').scrollTop = 0;
  text.focus();
});

dialog.querySelector('form').addEventListener('submit', async e => {
  e.preventDefault(); // nicht gleich schließen – erst, wenn der Server die Meldung angenommen hat
  if (sending) return;
  const b = body();
  if (b.text.length < TEXT_MIN) {
    showMessage(`Bitte etwas ausführlicher beschreiben (mindestens ${TEXT_MIN} Zeichen).`);
    text.focus();
    return;
  }
  sending = true;
  const send = $('#btn-feedback-send');
  send.disabled = true;
  send.textContent = 'Wird gesendet …';
  try {
    await sendFeedback(b);
  } catch (err) {
    showMessage(err.status === 0 ? 'Gerade keine Verbindung zum Server – bitte später noch einmal senden.' : err.message);
    return;
  } finally {
    sending = false;
    send.disabled = false;
    send.textContent = 'Senden';
  }
  text.value = '';
  email.value = '';
  withTech.checked = withRoute.checked = false;
  dialog.close('sent');
  flashStatus('Danke für deine Rückmeldung!'); // flashStatus sagt es auch an
});
