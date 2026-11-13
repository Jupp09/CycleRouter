/**
 * Konto (nur mit Server-Datenbank, sonst ausgeblendet): Anmelden/Registrieren, Passwort, Konto löschen
 * im Einstellungsdialog und der Abgleich der Einstellungen zwischen Geräten. Gespeicherte Routen und
 * Teilen-Links: routesView.js – beide Seiten stimmen sich über das Ereignis 'account' ab.
 */
import {
  account, SYNC_KEYS, loadAccount, login, register, logout, deleteAccount, changePassword, logoutOthers,
  fetchSettings, pushSettings,
} from '../account.js';
import { storage, onStorageSet, debounce } from '../utils.js';
import { on, emit } from './state.js';
import { $ } from './dom.js';
import { openSharedFromUrl } from './routesView.js';

// Auch bei abgelaufener Sitzung, die routesView beim Laden von „Meine Routen“ bemerkt
on('account', () => renderAccount());

// ---------- Anmelden, Abmelden, Konto löschen (im Einstellungsdialog) ----------

function renderAccount(message = '', isError = false) {
  $('#account-box').hidden = !account.enabled;
  const loggedIn = !!account.user;
  $('#account-out').hidden = loggedIn;
  $('#account-in').hidden = !loggedIn;
  for (const id of ['#btn-delete-account', '#btn-change-password', '#btn-logout-others']) $(id).hidden = !loggedIn;
  $('#account-delete').hidden = true;
  $('#account-password').hidden = true;
  if (loggedIn) $('#account-name').textContent = account.user.username;
  if (!message && account.offline) message = 'Offline – Anmelden, Abgleich und Speichern gehen wieder, sobald das Netz da ist.';
  const msg = $('#account-msg');
  msg.textContent = message;
  msg.hidden = !message;
  msg.classList.toggle('error', isError);
}

async function authenticate(kind) {
  const username = $('#account-user').value.trim();
  const password = $('#account-pass').value;
  renderAccount(kind === 'login' ? 'Anmeldung …' : 'Konto wird angelegt …');
  try {
    await (kind === 'login' ? login : register)(username, password);
  } catch (e) {
    renderAccount(e.message, true);
    return;
  }
  $('#account-pass').value = '';
  emit('account'); // vor der Meldung – der Handler zeichnet den Kontobereich neu
  renderAccount(kind === 'login' ? 'Angemeldet.' : 'Konto angelegt – deine Einstellungen werden ab jetzt abgeglichen.');
  // Neues Konto: lokale Einstellungen hochladen; Anmeldung: Stand vom Konto übernehmen
  await syncSettings({ preferLocal: kind === 'register' });
}

/** Nach Abmelden oder Löschen: routesView verwirft Bezug zur gespeicherten Route und die Liste. */
function signedOut(message) {
  emit('account');
  renderAccount(message);
}

$('#btn-login').addEventListener('click', () => authenticate('login'));
$('#btn-register').addEventListener('click', () => authenticate('register'));
// Enter im Passwortfeld meldet an (statt den Einstellungsdialog abzuschicken)
for (const id of ['#account-user', '#account-pass']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); authenticate('login'); } });
}
$('#btn-logout').addEventListener('click', async () => {
  try { await logout(); } catch { account.user = null; }
  signedOut('Abgemeldet. Die Einstellungen bleiben auf diesem Gerät erhalten.');
});

// Passwort ändern: Felder einblenden, dann bestätigen. Der Server meldet danach alle anderen Geräte ab.
function showPasswordForm(show) {
  $('#account-password').hidden = !show;
  $('#btn-change-password').hidden = show;
  if (!show) { $('#account-pass-old').value = ''; $('#account-pass-new').value = ''; }
}
const sessionsText = n => (n === 1 ? '1 anderes Gerät wurde abgemeldet.' : n ? `${n} andere Geräte wurden abgemeldet.` : '');
$('#btn-change-password').addEventListener('click', () => { showPasswordForm(true); $('#account-pass-old').focus(); });
$('#btn-password-cancel').addEventListener('click', () => renderAccount());
for (const id of ['#account-pass-old', '#account-pass-new']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-password-confirm').click(); } });
}
$('#btn-password-confirm').addEventListener('click', async () => {
  let count;
  try {
    count = await changePassword($('#account-pass-old').value, $('#account-pass-new').value);
  } catch (e) {
    renderAccount(e.message, true);
    showPasswordForm(true);
    return;
  }
  renderAccount(`Passwort geändert. ${sessionsText(count)}`.trim());
});
$('#btn-logout-others').addEventListener('click', async () => {
  try {
    const count = await logoutOthers();
    renderAccount(count ? sessionsText(count) : 'Auf keinem anderen Gerät angemeldet.');
  } catch (e) { renderAccount(e.message, true); }
});

// Löschen in zwei Schritten: erst das Passwortfeld zeigen, dann bestätigen
$('#btn-delete-account').addEventListener('click', () => {
  $('#account-delete').hidden = false;
  $('#btn-delete-account').hidden = true;
  $('#account-delete-pass').focus();
});
$('#btn-delete-cancel').addEventListener('click', () => renderAccount());
$('#account-delete-pass').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
$('#btn-delete-confirm').addEventListener('click', async () => {
  try {
    await deleteAccount($('#account-delete-pass').value);
  } catch (e) {
    renderAccount(e.message, true);
    $('#account-delete').hidden = false;
    $('#btn-delete-account').hidden = true;
    return;
  }
  $('#account-delete-pass').value = '';
  signedOut('Konto und alle gespeicherten Routen wurden gelöscht.');
});

// ---------- Einstellungen zwischen Geräten abgleichen ----------
// Jede geänderte Einstellung (SYNC_KEYS) wird kurz danach ans Konto geschickt. Beim Öffnen der App und
// beim Anmelden gilt der Stand des Kontos; weicht er ab, wird er übernommen und die App einmal neu geladen
// (sie liest ihre Einstellungen beim Start). Der ORS-Schlüssel gehört nicht zu SYNC_KEYS und bleibt im Browser.

let applyingRemote = false;
const localSyncSettings = () =>
  Object.fromEntries(SYNC_KEYS.map(k => [k, storage.get(k, null)]).filter(([, v]) => v !== null));
const pushLocalSettings = debounce(() => {
  if (account.user) pushSettings(localSyncSettings()).catch(() => {});
}, 1500);
onStorageSet(key => { if (!applyingRemote && SYNC_KEYS.includes(key)) pushLocalSettings(); });

async function syncSettings({ preferLocal = false } = {}) {
  if (!account.user) return;
  const remote = (await fetchSettings().catch(() => null))?.data;
  if (!remote || preferLocal) {
    await pushSettings(localSyncSettings()).catch(() => {});
    return;
  }
  const local = localSyncSettings();
  const changed = Object.keys(remote).filter(k => SYNC_KEYS.includes(k) && JSON.stringify(remote[k]) !== JSON.stringify(local[k] ?? null));
  if (!changed.length) {
    if (Object.keys(local).some(k => !(k in remote))) pushLocalSettings(); // neue lokale Einstellungen ergänzen
    return;
  }
  applyingRemote = true;
  for (const k of changed) storage.set(k, remote[k]);
  applyingRemote = false;
  // Merker verhindert eine Neulade-Schleife, falls sich der Stand trotzdem nicht übernehmen lässt
  const marker = JSON.stringify(remote);
  if (sessionStorage.getItem('cyclerouter.settingsApplied') !== marker) {
    sessionStorage.setItem('cyclerouter.settingsApplied', marker);
    location.reload();
  }
}

// ---------- Start ----------

/** Beim Start: Kontostatus laden, Einstellungen abgleichen, „Meine Routen“ und einen geteilten Link öffnen. */
export async function initAccount() {
  await loadAccount();
  renderAccount(); // gleich zeigen, nicht erst nach dem Abgleich
  if (account.user && !account.offline) await syncSettings();
  emit('account'); // Kontobereich, Speichern-Knöpfe, „Meine Routen“
  await openSharedFromUrl();
}

// Netz weg oder wieder da: Kontostand neu bestimmen – offline der gemerkte Nutzer und seine gemerkten Routen
for (const type of ['online', 'offline']) {
  window.addEventListener(type, async () => {
    const before = account.offline;
    await loadAccount();
    if (before && !account.offline && account.user) await syncSettings();
    emit('account');
  });
}
