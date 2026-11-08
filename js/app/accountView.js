/**
 * Konto-Funktionen (nur mit Server-Datenbank, sonst ausgeblendet): Anmelden/Registrieren im
 * Einstellungsdialog, Routen speichern und per Link teilen, „Meine Routen“ und der Abgleich der
 * Einstellungen zwischen Geräten.
 *
 * state.saved:      die geöffnete eigene gespeicherte Route {id, name, shareToken} – „Speichern“ aktualisiert sie.
 * state.loadedName: Name einer geöffneten gespeicherten oder geteilten Route (bleibt bei Neuberechnung erhalten).
 */
import { providers, withStats } from '../routing/index.js';
import {
  account, SYNC_KEYS, loadAccount, login, register, logout, deleteAccount, fetchSettings, pushSettings,
  listRoutes, getRoute, createRoute, updateRoute, deleteRoute, shareRoute, unshareRoute, getSharedRoute, shareUrl,
} from '../account.js';
import { reverse } from '../geocode.js';
import { storage, onStorageSet, debounce, formatKm, formatM, formatDate } from '../utils.js';
import { state, on, emit, MODE_LABELS, originRoute, defaultName } from './state.js';
import { $, ui, isMobile, setStatus, flashStatus, ask, externalLink, linkButton, rowButton, span } from './dom.js';
import { map } from './mapView.js';
import { syncUi } from './controls.js';
import { run, showRoute, abortCalculation } from './pipeline.js';
import { renderVias } from './waypoints.js';
import { searchAlong } from './alongView.js';

on('route', renderSaveActions);

// ---------- Route ↔ Datenbank ----------

const round5 = v => Math.round(v * 1e5) / 1e5; // ~1 m genau
const pointLabel = p => p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

/**
 * Aktuelle Route für die Datenbank – ohne Verpflegungsstopps und Übernachtungen (die werden beim Öffnen
 * neu geplant; die gewählten Unterkünfte werden über `stayChoices` wieder übernommen).
 */
function serializeRoute(name) {
  const r = originRoute();
  const wp = p => ({
    lat: round5(p.lat), lon: round5(p.lon),
    ...(p.label && { label: p.label }), ...(p.manual && { manual: true }), ...(p.icon && { icon: p.icon }),
  });
  return {
    name, mode: state.mode, bike: state.bike, distance: Math.round(r.distance), ascent: Math.round(r.ascent),
    data: {
      v: 1, traffic: state.traffic, eurovelo: state.eurovelo, provider: state.provider,
      coords: r.coords.map(([lat, lon, ele]) => [round5(lat), round5(lon), ele == null ? null : Math.round(ele * 10) / 10]),
      segments: r.segments || [],
      waypoints: r.waypoints.filter(p => !p.stop && !p.stay).map(wp),
      ...(state.multiDay && { multiDay: true, stayChoices: state.stayChoices }),
    },
  };
}

/** Gespeicherte oder geteilte Route öffnen – exakt wie gespeichert, ohne Neuberechnung. */
function restoreRoute(saved, { own }) {
  const d = saved.data;
  abortCalculation();
  searchAlong(null);
  state.mode = saved.mode;
  state.bike = saved.bike;
  if (d.traffic) state.traffic = d.traffic;
  if (d.eurovelo) state.eurovelo = d.eurovelo;
  if (d.provider && providers[d.provider]) state.provider = d.provider;
  for (const k of ['mode', 'bike', 'traffic', 'eurovelo', 'provider']) storage.set(k, state[k]);

  const wps = d.waypoints.map(p => ({ ...p }));
  const last = wps.length - 1;
  // Rundkurs: Start und Ende müssen dasselbe Objekt sein, sonst wird er nicht als Rundkurs erkannt
  if (saved.mode === 'loop' && last > 1 && wps[0].lat === wps[last].lat && wps[0].lon === wps[last].lon) wps[last] = wps[0];
  state.start = wps[0];
  state.end = saved.mode !== 'loop' && last > 0 ? wps[last] : null;
  state.vias = saved.mode === 'ab' ? wps.slice(1, -1).filter(p => p.manual) : [];
  ui.startInput.value = pointLabel(state.start);
  ui.endInput.value = state.end ? pointLabel(state.end) : '';
  for (const [p, input] of [[state.start, ui.startInput], [state.end, ui.endInput]]) {
    if (p && !p.label) reverse(p).then(l => { p.label = l; input.value = l; });
  }

  state.saved = own ? { id: saved.id, name: saved.name, shareToken: saved.shareToken || null } : null;
  state.loadedName = saved.name;
  syncUi();
  renderVias();
  emit('start');
  state.multiDay = !!d.multiDay;
  state.stayChoices = d.stayChoices || [];
  const r = withStats({ coords: d.coords, segments: d.segments }, wps);
  showRoute(r);
  // Übernachtungen (mit den gespeicherten Unterkünften) und Stopps auf die gespeicherte Route aufsetzen
  if (state.multiDay || state.supply.enabled) run(async () => r, { fit: false, loadingText: 'Wird geplant …' });
  renderMyRoutes();
}

// ---------- Speichern und Teilen ----------

/** Speichern (bzw. die geöffnete eigene Route aktualisieren) → gespeicherte Route oder null. */
async function saveCurrentRoute({ asNew = false } = {}) {
  if (!state.route || !account.user) return null;
  const name = ui.routeName.value.trim() || defaultName(state.route);
  const payload = serializeRoute(name);
  try {
    if (state.saved && !asNew) {
      await updateRoute(state.saved.id, payload);
      state.saved.name = name;
      flashStatus(`„${name}“ aktualisiert.`);
    } else {
      const { id } = await createRoute(payload);
      state.saved = { id, name, shareToken: null };
      flashStatus(`„${name}“ gespeichert – auf allen deinen Geräten unter „Meine Routen“.`);
    }
    state.loadedName = name;
    renderSaveActions();
    refreshMyRoutes();
    return state.saved;
  } catch (e) {
    setStatus(e.message, 'error');
    return null;
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Teilen-Link erzeugen (speichert vorher den aktuellen Stand) und weitergeben bzw. kopieren. */
async function shareCurrentRoute() {
  const saved = await saveCurrentRoute();
  if (!saved) return;
  try {
    saved.shareToken = await shareRoute(saved.id);
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  const url = shareUrl(saved.shareToken);
  renderSaveActions();
  refreshMyRoutes();
  if (isMobile && navigator.share) {
    try { await navigator.share({ title: saved.name, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  flashStatus(await copyText(url) ? 'Link kopiert – wer ihn öffnet, sieht die Route (auch ohne Konto).' : 'Link erstellt – siehe unten.');
}

async function revokeShareLink() {
  try {
    await unshareRoute(state.saved.id);
    state.saved.shareToken = null;
    flashStatus('Teilen-Link zurückgezogen – er funktioniert nicht mehr.');
    renderSaveActions();
    refreshMyRoutes();
  } catch (e) { setStatus(e.message, 'error'); }
}

/** Knöpfe „Route speichern“/„Teilen“ und die Zeile darunter (Teilen-Link, als neue Route speichern). */
function renderSaveActions() {
  const loggedIn = account.enabled && !!account.user;
  $('#save-actions').hidden = !(loggedIn && state.route);
  $('#btn-save-route').textContent = state.saved ? 'Änderungen speichern' : 'Route speichern';

  const hint = $('#save-hint');
  hint.replaceChildren();
  hint.hidden = true;
  if (!state.route || !account.enabled) return;
  if (!loggedIn) {
    hint.hidden = false;
    hint.textContent = 'Zum Speichern und Teilen unter Einstellungen (Zahnrad) anmelden.';
    return;
  }
  if (!state.saved) return;
  hint.hidden = false;
  if (state.saved.shareToken) {
    hint.append(externalLink('Teilen-Link', shareUrl(state.saved.shareToken)), ' aktiv (',
      linkButton('zurückziehen', revokeShareLink), ') · ');
  }
  hint.append(linkButton('als neue Route speichern', () => saveCurrentRoute({ asNew: true })));
}

$('#btn-save-route').addEventListener('click', () => saveCurrentRoute());
$('#btn-share-link').addEventListener('click', shareCurrentRoute);

// ---------- Meine Routen ----------

let myRoutes = [];

async function refreshMyRoutes() {
  const box = $('#my-routes');
  box.hidden = !(account.enabled && account.user);
  if (box.hidden) return;
  try {
    myRoutes = await listRoutes();
  } catch (e) {
    // Sitzung abgelaufen → als abgemeldet anzeigen
    if (e.status === 401) { account.user = null; renderAccount(); renderSaveActions(); box.hidden = true; }
    return;
  }
  renderMyRoutes();
}

function renderMyRoutes() {
  $('#my-routes-count').textContent = myRoutes.length ? `(${myRoutes.length})` : '';
  $('#my-routes-empty').hidden = myRoutes.length > 0;
  $('#my-routes-list').replaceChildren(...myRoutes.map(r => {
    const li = document.createElement('li');
    const current = state.saved?.id === r.id;
    if (current) li.className = 'current';
    const meta = document.createElement('small');
    meta.textContent = [formatKm(r.distance), `${formatM(r.ascent)} ↑`, MODE_LABELS[r.mode], formatDate(new Date(r.updatedAt))]
      .join(' · ') + (r.shared ? ' · 🔗 geteilt' : '');
    // Name und Angaben als Knopf „öffnen“ – vorher ein anklickbares <li>, das per Tastatur nicht erreichbar war
    const open = rowButton([span('name', r.name), meta], () => openSaved(r.id));
    if (current) open.setAttribute('aria-current', 'true');
    const tools = document.createElement('div');
    tools.className = 'tools';
    const tool = (icon, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = icon;
      b.title = title;
      b.setAttribute('aria-label', `„${r.name}“ ${title.toLowerCase()}`);
      b.addEventListener('click', fn);
      tools.append(b);
    };
    tool('✏️', 'Umbenennen', () => renameSaved(r));
    tool('🗑️', 'Löschen', () => deleteSaved(r));
    li.append(open, tools);
    return li;
  }));
}

async function openSaved(id) {
  setStatus('Route wird geladen …', 'loading');
  try {
    const r = await getRoute(id);
    setStatus(null);
    restoreRoute(r, { own: true });
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

async function renameSaved(r) {
  const name = (await ask({ title: 'Route umbenennen', input: r.name, ok: 'Umbenennen' }))?.trim();
  if (!name || name === r.name) return;
  try {
    await updateRoute(r.id, { name });
    if (state.saved?.id === r.id) {
      state.saved.name = state.loadedName = ui.routeName.value = name;
    }
    refreshMyRoutes();
  } catch (e) { setStatus(e.message, 'error'); }
}

async function deleteSaved(r) {
  const sure = await ask({
    title: `„${r.name}“ löschen?`,
    text: r.shared ? 'Der Teilen-Link funktioniert danach nicht mehr.' : 'Das lässt sich nicht rückgängig machen.',
    ok: 'Löschen', danger: true,
  });
  if (!sure) return;
  try {
    await deleteRoute(r.id);
    if (state.saved?.id === r.id) { state.saved = null; renderSaveActions(); }
    refreshMyRoutes();
  } catch (e) { setStatus(e.message, 'error'); }
}

// ---------- Anmelden, Abmelden, Konto löschen (im Einstellungsdialog) ----------

function renderAccount(message = '', isError = false) {
  $('#account-box').hidden = !account.enabled;
  const loggedIn = !!account.user;
  $('#account-out').hidden = loggedIn;
  $('#account-in').hidden = !loggedIn;
  $('#btn-delete-account').hidden = !loggedIn;
  $('#account-delete').hidden = true;
  if (loggedIn) $('#account-name').textContent = account.user.username;
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
  renderAccount(kind === 'login' ? 'Angemeldet.' : 'Konto angelegt – deine Einstellungen werden ab jetzt abgeglichen.');
  renderSaveActions();
  // Neues Konto: lokale Einstellungen hochladen; Anmeldung: Stand vom Konto übernehmen
  await syncSettings({ preferLocal: kind === 'register' });
  refreshMyRoutes();
}

/** Nach Abmelden oder Löschen: Bezug zur gespeicherten Route und die Liste verwerfen. */
function signedOut(message) {
  state.saved = null;
  myRoutes = [];
  renderAccount(message);
  renderSaveActions();
  refreshMyRoutes();
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

/** Geteilten Link (?route=…) öffnen. */
async function openSharedFromUrl() {
  const token = new URLSearchParams(location.search).get('route');
  if (!token) return;
  history.replaceState(null, '', location.pathname); // Link nicht beim Neuladen erneut öffnen
  setStatus('Geteilte Route wird geladen …', 'loading');
  try {
    const r = await getSharedRoute(token);
    setStatus(null);
    restoreRoute(r, { own: false });
    map.fitRoute(state.route.coords);
    flashStatus(`Geteilte Route „${r.name}“${account.user ? ' – mit „Route speichern“ in deine Routen übernehmen.' : '.'}`);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

/** Beim Start: Kontostatus laden, Einstellungen abgleichen, „Meine Routen“ und einen geteilten Link öffnen. */
export async function initAccount() {
  await loadAccount();
  renderAccount();
  if (account.user) {
    await syncSettings();
    refreshMyRoutes();
  }
  renderSaveActions();
  await openSharedFromUrl();
}
