/**
 * Konto, Einstellungs-Abgleich und gespeicherte Routen – Schnittstelle zu server/accountApi.mjs.
 * Läuft die App ohne Server-Datenbank (statisch gehostet oder ohne DB_HOST), ist `account.enabled` false
 * und alle Konto-Funktionen bleiben ausgeblendet.
 */

const API = new URL('../api/', import.meta.url);

export const account = { enabled: false, user: null };

/** Einstellungen, die zwischen Geräten abgeglichen werden (wie SYNC_KEYS auf dem Server). Der ORS-Key bleibt lokal. */
export const SYNC_KEYS = ['home', 'bike', 'traffic', 'eurovelo', 'provider', 'breakdown', 'colorRoute',
  'supplyEnabled', 'supplyInterval', 'avgSpeed', 'mode', 'distanceKm',
  'stageMaxKm', 'nightBudget', 'stayTypes', 'endStay'];

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(new URL(path, API), {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
  } catch {
    account.enabled = false;
    account.user = null;
  }
  return account;
}

export async function register(username, password) {
  account.user = (await api('POST', 'account/register', { username, password })).user;
  return account.user;
}
export async function login(username, password) {
  account.user = (await api('POST', 'account/login', { username, password })).user;
  return account.user;
}
export async function logout() {
  await api('POST', 'account/logout', {});
  account.user = null;
}
export async function deleteAccount(password) {
  await api('POST', 'account/delete', { password });
  account.user = null;
}

export const fetchSettings = () => api('GET', 'settings');
export const pushSettings = data => api('PUT', 'settings', { data });

export const listRoutes = async () => (await api('GET', 'routes')).routes;
export const getRoute = id => api('GET', `routes/${id}`);
export const createRoute = route => api('POST', 'routes', route);
export const updateRoute = (id, patch) => api('PATCH', `routes/${id}`, patch);
export const deleteRoute = id => api('DELETE', `routes/${id}`);
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
