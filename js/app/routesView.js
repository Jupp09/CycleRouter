/**
 * Gespeicherte Routen (nur mit Server-Datenbank und Anmeldung): Route speichern, per Link teilen,
 * „Meine Routen“ und geteilte Links (?route=…) öffnen. Anmelden und Einstellungs-Abgleich: accountView.js.
 *
 * state.saved:      die geöffnete eigene gespeicherte Route {id, name, shareToken} – „Speichern“ aktualisiert sie.
 * state.loadedName: Name einer geöffneten gespeicherten oder geteilten Route (bleibt bei Neuberechnung erhalten).
 */
import { providers, withStats, trackRoute } from '../routing/index.js';
import {
  account, listRoutes, getRoute, createRoute, updateRoute, deleteRoute, shareRoute, unshareRoute, getSharedRoute, shareUrl,
} from '../account.js';
import { formatKm, formatM, formatDate } from '../utils.js';
import { state, on, emit, MODE_LABELS, originRoute, defaultName } from './state.js';
import { $, ui, isMobile, setStatus, flashStatus, ask, externalLink, linkButton, rowButton, span } from './dom.js';
import { map } from './mapView.js';
import { applyRouteSettings } from './controls.js';
import { run, showRoute, abortCalculation } from './pipeline.js';
import { setRoutePoints } from './waypoints.js';
import { searchAlong } from './alongView.js';

on('route', renderSaveActions);
// Angemeldet, abgemeldet, Konto gelöscht oder Sitzung abgelaufen (accountView.js bzw. refreshMyRoutes)
on('account', () => {
  if (!account.user) { state.saved = null; myRoutes = []; }
  renderSaveActions();
  refreshMyRoutes();
});

// ---------- Route ↔ Datenbank ----------

const round5 = v => Math.round(v * 1e5) / 1e5; // ~1 m genau

/**
 * Aktuelle Route für die Datenbank – ohne Verpflegungsstopps und Übernachtungen (die werden beim Öffnen
 * neu geplant; die gewählten Unterkünfte werden über `stayChoices` wieder übernommen).
 */
function serializeRoute(name) {
  const r = originRoute();
  const wp = p => ({
    lat: round5(p.lat), lon: round5(p.lon),
    ...(p.label && { label: p.label }), ...(p.manual && { manual: true }), ...(p.icon && { icon: p.icon }),
    ...(p.food && { food: true }), // fester Verpflegungs-Zwischenstopp
  });
  return {
    name, mode: state.mode, bike: state.bike, distance: Math.round(r.distance), ascent: Math.round(r.ascent),
    data: {
      v: 1, traffic: state.traffic, eurovelo: state.eurovelo, provider: state.provider,
      coords: r.coords.map(([lat, lon, ele]) => [round5(lat), round5(lon), ele == null ? null : Math.round(ele * 10) / 10]),
      segments: r.segments || [],
      waypoints: r.waypoints.filter(p => !p.stop && !p.stay && !p.anchor).map(wp),
      // Importierter Weg (auch mit Abstechern): beim Öffnen wieder als solcher behandeln, Stützpunkte entstehen neu
      ...((r.track || r.waypoints.some(p => p.trackAt)) && { track: true }),
      ...(state.multiDay && { multiDay: true, stayChoices: state.stayChoices }),
    },
  };
}

/** Gespeicherte oder geteilte Route öffnen – exakt wie gespeichert, ohne Neuberechnung. */
function restoreRoute(saved, { own }) {
  const d = saved.data;
  abortCalculation();
  searchAlong(null);
  applyRouteSettings({
    mode: saved.mode, bike: saved.bike, traffic: d.traffic, eurovelo: d.eurovelo,
    provider: providers[d.provider] ? d.provider : null,
  });

  const wps = d.waypoints.map(p => ({ ...p }));
  const last = wps.length - 1;
  // Rundkurs: Start und Ende müssen dasselbe Objekt sein, sonst wird er nicht als Rundkurs erkannt
  if (saved.mode === 'loop' && last > 1 && wps[0].lat === wps[last].lat && wps[0].lon === wps[last].lon) wps[last] = wps[0];
  state.saved = own ? { id: saved.id, name: saved.name, shareToken: saved.shareToken || null } : null;
  state.loadedName = saved.name;
  setRoutePoints(wps[0], saved.mode !== 'loop' && last > 0 ? wps[last] : null,
    saved.mode === 'ab' ? wps.slice(1, -1).filter(p => p.manual) : []);

  state.multiDay = !!d.multiDay;
  state.stayChoices = d.stayChoices || [];
  const r = d.track ? trackRoute(d.coords, wps, d.segments) : withStats({ coords: d.coords, segments: d.segments }, wps);
  state.track = d.track ? r : null;
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
  flashStatus(await copyText(url) ? 'Link kopiert – wer ihn öffnet, sieht die Route samt Start und Ziel (auch ohne Konto).' : 'Link erstellt – siehe unten.');
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
    // Sitzung abgelaufen → überall als abgemeldet anzeigen
    if (e.status === 401) { account.user = null; emit('account'); }
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

// ---------- Geteilter Link ----------

/** Geteilten Link (?route=…) öffnen – beim Start, nach dem Laden des Kontos (initAccount). */
export async function openSharedFromUrl() {
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
