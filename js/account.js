/**
 * Konto, Einstellungs-Abgleich und gespeicherte Routen – Schnittstelle zu server/accountApi.mjs.
 * Läuft die App ohne Server-Datenbank (statisch gehostet oder ohne DB_HOST), ist `account.enabled` false
 * und alle Konto-Funktionen bleiben ausgeblendet.
 *
 * Ohne Netz (`account.offline`): Der zuletzt angemeldete Nutzer, die Liste „Meine Routen“ und die gemerkten
 * Routen kommen aus dem Offline-Speicher (js/offlineStore.js). Gemerkt wird, was hier geöffnet wurde, dazu die
 * 20 zuletzt geänderten Routen (`prefetchRoutes`). Der Speicher wird geleert, sobald niemand mehr angemeldet
 * ist – auf einem geteilten Gerät soll nichts zurückbleiben. „Ohne Netz“ heißt: Der Server war nicht erreichbar
 * (status 0, auch nach Ablauf des Zeitlimits); eine Antwort mit Fehler zählt nicht dazu.
 */
import { offlineGet, offlinePut, offlineDelete, offlineKeys, offlineClear } from './offlineStore.js';
import { withTimeout } from './shared.js';

// Einstellungen, die zwischen Geräten abgeglichen werden – gemeinsam mit dem Server definiert (js/shared.js)
export { SYNC_KEYS } from './shared.js';

const API = new URL('../api/', import.meta.url);

export const account = { enabled: false, user: null, offline: false };

/** So viele der zuletzt geänderten Routen werden für den Offline-Start vorgeladen. */
const PREFETCH = 20;
const READ_TIMEOUT = 8000, WRITE_TIMEOUT = 30000;
const routeKey = id => `route:${id}`;

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(new URL(path, API), {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Bei sehr schwachem Netz kommt oft weder Antwort noch Fehler – ohne Zeitlimit griffe der Offline-Stand
      // erst nach Minuten. Schreibende Anfragen dürfen länger dauern (eine lange Route hat einige MB).
      signal: withTimeout(null, method === 'GET' ? READ_TIMEOUT : WRITE_TIMEOUT),
    });
  } catch {
    throw Object.assign(new Error('Server nicht erreichbar.'), { status: 0 });
  }
  let data = null;
  if (res.headers.get('content-type')?.includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Fehler ${res.status}`), { status: res.status });
  return data;
}

/** Stand vom Server holen. Ohne Konto-Server bleibt alles deaktiviert. */
export async function loadAccount() {
  try {
    const data = await api('GET', 'account');
    account.enabled = !!data?.enabled;
    account.user = data?.user || null;
    account.offline = false;
    await rememberUser();
  } catch (e) {
    // Server nicht erreichbar: weiter als der zuletzt angemeldete Nutzer – nur lesend, aus dem Offline-Speicher
    const saved = e.status === 0 ? await offlineGet('user') : null;
    account.enabled = !!saved;
    account.user = saved?.user || null;
    account.offline = !!saved;
  }
  return account;
}

/** Angemeldeten Nutzer merken; ist niemand (mehr) angemeldet oder ein anderer, das Gemerkte löschen. */
async function rememberUser() {
  const saved = await offlineGet('user');
  if (!account.user || (saved && saved.user.id !== account.user.id)) await offlineClear();
  if (account.user) await offlinePut('user', { user: account.user });
}

/** Offline-Speicher leeren und den Offline-Zustand beenden (Abmelden, Konto gelöscht, Sitzung abgelaufen). */
export async function forgetOffline() {
  account.offline = false;
  await offlineClear();
}

export async function register(username, password) {
  account.user = (await api('POST', 'account/register', { username, password })).user;
  await rememberUser();
  return account.user;
}
export async function login(username, password) {
  account.user = (await api('POST', 'account/login', { username, password })).user;
  await rememberUser();
  return account.user;
}
export async function logout() {
  // Das Gemerkte zuerst löschen – auch wenn der Server gerade nicht erreichbar ist
  await forgetOffline();
  await api('POST', 'account/logout', {});
  account.user = null;
}
export async function deleteAccount(password) {
  await api('POST', 'account/delete', { password });
  account.user = null;
  await forgetOffline();
}

/** Passwort ändern – meldet alle anderen Geräte ab. → Anzahl beendeter Sitzungen */
export async function changePassword(password, newPassword) {
  return (await api('POST', 'account/password', { password, newPassword })).count;
}
/** Alle anderen Sitzungen beenden. → Anzahl */
export async function logoutOthers() {
  return (await api('POST', 'account/logout-others', {})).count;
}

export const fetchSettings =() => api('GET', 'settings');
export const pushSettings = data => api('PUT', 'settings', { data });

/**
 * Liste der gespeicherten Routen. Ohne Netz der gemerkte Stand – das Ergebnis trägt dann `offline: true`,
 * `t` (Zeitpunkt des Stands) und `cached` (Kennungen der Routen, die sich ohne Netz öffnen lassen).
 */
export async function listRoutes() {
  let routes;
  try {
    routes = (await api('GET', 'routes')).routes;
  } catch (e) {
    const saved = e.status === 0 ? await offlineGet('list') : null;
    if (!saved) throw e;
    account.offline = true;
    const keys = new Set(await offlineKeys());
    return Object.assign(saved.routes, { offline: true, t: saved.t, cached: new Set(saved.routes.filter(r => keys.has(routeKey(r.id))).map(r => r.id)) });
  }
  account.offline = false;
  await offlinePut('list', { t: Date.now(), routes });
  // Gemerkte Routen, die es nicht mehr gibt, entfernen
  const ids = new Set(routes.map(r => routeKey(r.id)));
  for (const key of await offlineKeys()) if (String(key).startsWith('route:') && !ids.has(key)) await offlineDelete(key);
  return routes;
}

/** Eine gespeicherte Route; `updatedAt` (aus der Liste) kennzeichnet den gemerkten Stand. Ohne Netz der gemerkte. */
export async function getRoute(id, updatedAt = null) {
  try {
    const route = await api('GET', `routes/${id}`);
    await offlinePut(routeKey(id), { updatedAt, route });
    return route;
  } catch (e) {
    if (e.status !== 0) throw e;
    const saved = await offlineGet(routeKey(id));
    if (!saved) throw Object.assign(new Error('Diese Route ist offline nicht verfügbar.'), { status: 0 });
    return saved.route;
  }
}

let prefetching = 0;
/**
 * Die zuletzt geänderten Routen der Liste im Hintergrund merken – eine nach der anderen, nur was neu oder
 * geändert ist. Ein neuer Aufruf (neue Liste) löst den laufenden ab; ein Fehler beendet das Vorladen still.
 */
export async function prefetchRoutes(routes) {
  const run = ++prefetching;
  const newest = [...routes].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, PREFETCH);
  for (const r of newest) {
    if (run !== prefetching || account.offline || !account.user) return;
    const saved = await offlineGet(routeKey(r.id));
    if (saved && saved.updatedAt === r.updatedAt) continue;
    try {
      await offlinePut(routeKey(r.id), { updatedAt: r.updatedAt, route: await api('GET', `routes/${r.id}`) });
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 300)); // den Server nicht mit 20 Anfragen auf einmal belasten
  }
}

export const createRoute = route => api('POST', 'routes', route);
/** Ändern: Der gemerkte Stand ist danach veraltet und wird verworfen (das Vorladen holt den neuen). */
export async function updateRoute(id, patch) {
  const result = await api('PATCH', `routes/${id}`, patch);
  await offlineDelete(routeKey(id));
  return result;
}
export async function deleteRoute(id) {
  const result = await api('DELETE', `routes/${id}`);
  await offlineDelete(routeKey(id));
  return result;
}
export const shareRoute = async id => (await api('POST', `routes/${id}/share`, {})).token;
export const unshareRoute = id => api('DELETE', `routes/${id}/share`);
export const getSharedRoute = token => api('GET', `shared/${encodeURIComponent(token)}`);

/** Link, über den eine geteilte Route geöffnet wird. */
export const shareUrl = token => {
  const u = new URL(location.href);
  u.search = `?route=${encodeURIComponent(token)}`;
  u.hash = '';
  return u.toString();
};
