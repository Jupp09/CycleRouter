// Konto-API im Speicher – nur für die Browsertests, damit sie ohne MariaDB laufen.
// Fängt im Testbrowser die Aufrufe an /api/account…, /api/settings, /api/routes…, /api/shared/…, /api/feedback und
// /api/admin/status ab
// (DevTools Fetch.requestPaused) und beantwortet sie wie server/accountApi.mjs. Getestet wird so die
// Oberfläche; die echte Server-API mit SQL deckt das nicht ab.
//
// Angemeldet ist eine *Seite* (ein Testgerät), nicht ein Cookie: Die Sitzung hängt an der DevTools-Sitzung
// und übersteht so auch ein Neuladen. Alle Seiten mit demselben Store teilen sich Konten und Routen.
import { randomBytes, createHash } from 'node:crypto';
import { SYNC_KEYS, MODES, BIKES } from '../../js/shared.js';
import { cleanFeedback, cleanTokens, cleanAdminPatch } from '../../server/feedbackApi.mjs';
import { statusReport } from '../../server/status.mjs';

const sha256 = s => createHash('sha256').update(s).digest('hex');
/** Konten mit Verwaltungsrechten (auf dem Server: ADMIN_USERS). */
const ADMINS = ['chef'];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createAccountStore() {
  const users = new Map();     // username → {id, username, password, settings, settingsAt}
  const routes = new Map();    // id → {…, userId, data, shareToken}
  const sessions = new Map();  // sessionId der Seite → username
  const feedback = [];         // angenommene Rückmeldungen (wie Tabelle feedback), für die Prüfungen
  let nextUser = 1, nextRoute = 1, clock = Date.now();
  const now = () => new Date(clock += 1000).toISOString(); // streng steigend, damit die Reihenfolge eindeutig ist

  const listItem = r => ({
    id: r.id, name: r.name, mode: r.mode, bike: r.bike, distance: r.distance, ascent: r.ascent,
    shared: !!r.shareToken, shareToken: r.shareToken, createdAt: r.createdAt, updatedAt: r.updatedAt,
  });
  function cleanRoute(body, partial = false) {
    const out = {};
    if (!partial || 'name' in body) {
      out.name = String(body.name ?? '').trim().slice(0, 200);
      if (!out.name) throw new ApiError(400, 'Name fehlt');
    }
    if ((!partial || 'mode' in body) && !MODES.includes(out.mode = body.mode)) throw new ApiError(400, 'Ungültiger Modus');
    if ((!partial || 'bike' in body) && !BIKES.includes(out.bike = body.bike)) throw new ApiError(400, 'Ungültiger Fahrradtyp');
    for (const k of ['distance', 'ascent']) if (!partial || k in body) out[k] = Math.round(Number(body[k]));
    if (!partial || 'data' in body) {
      const d = body.data;
      if (!d || !Array.isArray(d.coords) || d.coords.length < 2 || !Array.isArray(d.waypoints)) throw new ApiError(400, 'Ungültige Routendaten');
      out.data = JSON.parse(JSON.stringify(d));
    }
    return out;
  }

  function handle(session, method, path, body, host, search = new URLSearchParams()) {
    const user = users.get(sessions.get(session)) || null;
    // Admin wie ADMIN_USERS auf dem Server: hier das Konto „chef“
    const pub = u => ({ id: u.id, username: u.username, admin: ADMINS.includes(u.username) });

    if (path === '/api/account' && method === 'GET') return [200, { enabled: true, user: user && pub(user) }];

    // Rückmeldungen: dieselben Prüfungen wie der Server (feedbackApi.mjs), Senden auch ohne Anmeldung
    const serverCheck = fn => { try { return fn(); } catch (e) { throw new ApiError(e.status, e.message); } };
    if (path === '/api/feedback' && method === 'POST') {
      const f = serverCheck(() => cleanFeedback(body, host));
      const token = randomBytes(16).toString('base64url');
      feedback.push({ ...f, id: feedback.length + 1, userId: user?.id ?? null, username: user?.username ?? null,
        tokenHash: sha256(token), done: false, reply: null, repliedAt: null, createdAt: now() });
      return [201, { ok: true, id: feedback.length, token }];
    }
    if (path === '/api/feedback/replies' && method === 'POST') {
      const tokens = cleanTokens(body.items);
      const mine = feedback.filter(f => f.reply && (tokens.some(t => t.id === f.id && t.hash === f.tokenHash) || (user && f.userId === user.id)));
      return [200, { replies: mine.map(f => ({ id: f.id, kind: f.kind, text: f.text.slice(0, 300), reply: f.reply, repliedAt: f.repliedAt })) }];
    }
    const am = path.match(/^\/api\/feedback\/admin(?:\/(\d+))?$/);
    if (am) {
      if (!user) throw new ApiError(401, 'Bitte anmelden.');
      if (!pub(user).admin) throw new ApiError(403, 'Kein Zugriff.');
      if (!am[1] && method === 'GET') {
        const status = search.get('status');
        const list = feedback.filter(f => status === 'all' || f.done === (status === 'done')).sort((a, b) => b.id - a.id);
        return [200, { counts: { open: feedback.filter(f => !f.done).length, done: feedback.filter(f => f.done).length },
          items: list.map(({ tokenHash, userId, ...f }) => ({ ...f, reachable: !!userId || !!tokenHash })) }];
      }
      const f = feedback.find(x => x.id === Number(am[1]));
      if (!f) throw new ApiError(404, 'Rückmeldung nicht gefunden.');
      if (method === 'PATCH') {
        const p = serverCheck(() => cleanAdminPatch(body));
        if ('done' in p) f.done = p.done;
        if ('reply' in p) Object.assign(f, { reply: p.reply, repliedAt: p.reply ? now() : null });
        return [200, { ok: true }];
      }
      if (method === 'DELETE') { feedback.splice(feedback.indexOf(f), 1); return [200, { ok: true }]; }
    }

    // Statusseite: die Zahlen dieses Testprozesses (server/status.mjs; der Test kann dort Einträge anlegen)
    if (path === '/api/admin/status' && method === 'GET') {
      if (!user) throw new ApiError(401, 'Bitte anmelden.');
      if (!pub(user).admin) throw new ApiError(403, 'Kein Zugriff.');
      return [200, statusReport()];
    }

    let m = path.match(/^\/api\/shared\/([A-Za-z0-9_-]{22})$/);
    if (m && method === 'GET') {
      const r = [...routes.values()].find(x => x.shareToken === m[1]);
      if (!r) throw new ApiError(404, 'Dieser Link ist ungültig oder wurde zurückgezogen.');
      return [200, { name: r.name, mode: r.mode, bike: r.bike, distance: r.distance, ascent: r.ascent, data: r.data, updatedAt: r.updatedAt }];
    }
    if (path === '/api/account/register' && method === 'POST') {
      const { username, password } = body;
      if (!username || String(password || '').length < 8) throw new ApiError(400, 'Benutzername und Passwort (mind. 8 Zeichen) nötig.');
      if (users.has(username)) throw new ApiError(409, 'Dieser Benutzername ist schon vergeben.');
      const u = { id: nextUser++, username, password, settings: null, settingsAt: null };
      users.set(username, u);
      sessions.set(session, username);
      return [201, { user: pub(u) }];
    }
    if (path === '/api/account/login' && method === 'POST') {
      const u = users.get(body.username);
      if (!u || u.password !== body.password) throw new ApiError(401, 'Benutzername oder Passwort falsch.');
      sessions.set(session, u.username);
      return [200, { user: pub(u) }];
    }
    if (path === '/api/account/logout' && method === 'POST') {
      sessions.delete(session);
      return [200, { ok: true }];
    }

    if (!user) throw new ApiError(401, 'Bitte anmelden.');
    const others = () => [...sessions].filter(([s, n]) => n === user.username && s !== session);

    if (path === '/api/account/delete' && method === 'POST') {
      if (body.password !== user.password) throw new ApiError(401, 'Passwort falsch.');
      users.delete(user.username);
      for (const [id, r] of routes) if (r.userId === user.id) routes.delete(id);
      for (const [s, n] of sessions) if (n === user.username) sessions.delete(s);
      return [200, { ok: true }];
    }
    if (path === '/api/account/password' && method === 'POST') {
      if (body.password !== user.password) throw new ApiError(401, 'Bisheriges Passwort falsch.');
      user.password = body.newPassword;
      const o = others();
      for (const [s] of o) sessions.delete(s);
      return [200, { ok: true, count: o.length }];
    }
    if (path === '/api/account/logout-others' && method === 'POST') {
      const o = others();
      for (const [s] of o) sessions.delete(s);
      return [200, { count: o.length }];
    }
    if (path === '/api/settings') {
      if (method === 'GET') return [200, user.settings ? { data: user.settings, updatedAt: user.settingsAt } : { data: null }];
      if (method === 'PUT') {
        user.settings = Object.fromEntries(SYNC_KEYS.filter(k => k in (body.data || {})).map(k => [k, body.data[k]]));
        user.settingsAt = now();
        return [200, { ok: true }];
      }
    }
    if (path === '/api/routes') {
      if (method === 'GET') {
        const list = [...routes.values()].filter(r => r.userId === user.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
        return [200, { routes: list.map(listItem) }];
      }
      if (method === 'POST') {
        const t = now();
        const r = { ...cleanRoute(body), id: nextRoute++, userId: user.id, shareToken: null, createdAt: t, updatedAt: t };
        routes.set(r.id, r);
        return [201, { id: r.id }];
      }
    }
    m = path.match(/^\/api\/routes\/(\d{1,10})(\/share)?$/);
    if (m) {
      const r = routes.get(Number(m[1]));
      if (!r || r.userId !== user.id) throw new ApiError(404, 'Route nicht gefunden');
      if (m[2] && method === 'POST') return [200, { token: r.shareToken ??= randomBytes(16).toString('base64url') }];
      if (m[2] && method === 'DELETE') { r.shareToken = null; return [200, { ok: true }]; }
      if (method === 'GET') return [200, { ...listItem(r), data: r.data }];
      if (method === 'PATCH') { Object.assign(r, cleanRoute(body, true), { updatedAt: now() }); return [200, { ok: true }]; }
      if (method === 'DELETE') { routes.delete(r.id); return [200, { ok: true }]; }
    }
    throw new ApiError(404, 'Unbekannte Anfrage');
  }

  return {
    /** Konto-Aufrufe dieser Seite ab jetzt hier beantworten (vor page.open aufrufen). */
    async attach(page) {
      page.on(async (method, p) => {
        if (method !== 'Fetch.requestPaused') return;
        // Netz gesperrt (page.setOffline): Die Anfrage scheitert wie ohne Verbindung, statt beantwortet zu werden
        if (page.offline) {
          await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
          return;
        }
        const { url, method: verb, postData, postDataEntries, hasPostData } = p.request;
        let raw = postDataEntries?.length
          ? Buffer.concat(postDataEntries.map(e => Buffer.from(e.bytes || '', 'base64'))).toString('utf8')
          : postData || '';
        // Große Körper (lange Routen) liefert der Browser nicht mit – dann einzeln abholen
        if (!raw && hasPostData && p.networkId) {
          raw = (await page.send('Network.getRequestPostData', { requestId: p.networkId }).catch(() => ({}))).postData || '';
        }
        let status, data;
        try {
          [status, data] = handle(page.sessionId, verb, new URL(url).pathname, raw ? JSON.parse(raw) : {}, new URL(url).host, new URL(url).searchParams);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          [status, data] = [e.status, { error: e.message }];
        }
        await page.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: status,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(JSON.stringify(data)).toString('base64'),
        }).catch(() => {}); // Seite inzwischen neu geladen
      });
      await page.send('Network.enable');
      await page.send('Fetch.enable', {
        patterns: ['account', 'settings', 'routes', 'shared', 'feedback', 'admin'].map(p => ({ urlPattern: `*/api/${p}*`, requestStage: 'Request' })),
      });
    },
    get userCount() { return users.size; },
    get feedback() { return feedback; },
  };
}
