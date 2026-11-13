import { classifyOsmTags, mergeSegments } from '../surfaces.js';
import { haversine } from '../utils.js';
import { routingNotice, sleep } from './notice.js';
import { withTimeout } from '../shared.js';

/** Hochladen eines Profils: Ohne Zeitlimit hinge bei einem hängenden brouter.de jede Berechnung mit EuroVelo. */
const UPLOAD_TIMEOUT = 20000;

/** Auf `p` warten, aber bei Abbruch von `signal` sofort aufgeben (`p` selbst läuft für andere weiter). */
function abortable(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('Abgebrochen', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Abgebrochen', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const ENDPOINT = 'https://brouter.de/brouter';

const PROFILES = {
  road: { normal: 'fastbike', low: 'fastbike-lowtraffic', verylow: 'fastbike-verylowtraffic' },
  gravel: { normal: 'gravel', low: 'gravel', verylow: 'gravel' },
  trekking: { normal: 'trekking', low: 'trekking', verylow: 'trekking' }, // Trekking-/Alltagsrad
  ebike: { normal: 'trekking', low: 'trekking', verylow: 'trekking' },    // E-Bike: Trekking mit PARAMS
};

/**
 * Profilparameter je Fahrradtyp, die BRouter in der URL übernimmt (`profile:<name>=<wert>`; Wahrheitswerte als
 * 0/1 – „false“ beantwortet brouter.de nicht). Gilt auch für hochgeladene EuroVelo-Profile.
 * E-Bike: Höhenmeter nicht scheuen – der Motor nimmt die Steigung ab, statt Umwegen um Hügel lieber kürzer.
 * Gemessen Köln → Remagen: 70,0 statt 71,3 km, 890 statt 832 m Anstieg.
 */
const PARAMS = { ebike: { consider_elevation: 0 } };

/** Antwort, die nur „zu viel los“ bedeutet – ein neuer Versuch oder ein anderer Dienst kann helfen. */
const BUSY_TEXT = /retry later|watchdog|timeout|timed out|too many|busy|overload/i;
const BUSY_STATUS = new Set([429, 502, 503, 504]);

/** Wartezeiten vor dem 2. und 3. Versuch, wenn BRouter ausgelastet ist */
const RETRY_DELAYS = [2000, 5000];

function translateError(text) {
  if (/not mapped|no track found|position not/i.test(text)) {
    return 'Ein Punkt liegt zu weit von einem befahrbaren Weg entfernt.';
  }
  if (BUSY_TEXT.test(text)) {
    return 'BRouter ist gerade ausgelastet – bitte gleich noch einmal versuchen.';
  }
  return 'BRouter-Fehler: ' + text.slice(0, 200);
}

// ---------- EuroVelo-Bevorzugung über ein eigenes Profil ----------
// BRouter-Profile werten Radrouten-Relationen aus (`route_bicycle_icn` = international, d. h. EuroVelo).
// Die Standardprofile behandeln alle Radrouten gleich; für die Bevorzugung wird das Standardprofil
// angepasst – Wege abseits internationaler Radrouten werden um den Faktor teurer – und bei BRouter
// hochgeladen. Die Profil-Quelltexte liegen im Ordner /profiles, da brouter.de sie nicht per CORS ausliefert.

/** Aufschlag für Wege abseits von EuroVelo-Routen. Gemessen Köln→Koblenz: 1,5 → 80 %, 3 → 98 % auf EuroVelo. */
export const EUROVELO_PENALTY = { prefer: 1.5, strong: 3 };
/**
 * Nationale Radfernwege (`ncn`) bekommen nur einen kleinen Teil des Aufschlags: In Deutschland ist EuroVelo
 * oft nur als Super-Relation über D-Routen erfasst (z. B. EV3 = D7 zwischen Bremen und Hamburg). BRouter
 * überträgt Super-Relationen nicht auf die Wege – diese Abschnitte sind für BRouter nur „national“.
 */
const NCN_SHARE = 0.15;
const PROFILE_TTL = 6 * 3600 * 1000; // hochgeladene Profile werden serverseitig irgendwann gelöscht

const sources = new Map();
const uploaded = new Map(); // `${profil}|${faktor}` → {id, t}

function loadSource(name) {
  if (!sources.has(name)) {
    const p = fetch(new URL(`../../profiles/${name}.brf`, import.meta.url)).then(res => {
      if (!res.ok) throw new Error(`Profil ${name} nicht gefunden`);
      return res.text();
    });
    sources.set(name, p);
    p.catch(() => sources.delete(name));
  }
  return sources.get(name);
}

/**
 * Benennt `costfactor` um und multipliziert ihn abseits internationaler Radrouten mit `penalty`,
 * auf nationalen Radfernwegen nur mit einem kleinen Teil davon.
 */
export function patchProfile(src, penalty) {
  const ncn = (1 + (penalty - 1) * NCN_SHARE).toFixed(3);
  const start = src.search(/^assign costfactor\b/m);
  if (start < 0) throw new Error('Profil lässt sich nicht anpassen');
  const offset = src.slice(start + 1).search(/^(assign |---context)/m);
  const end = offset < 0 ? src.length : start + 1 + offset;
  return src.slice(0, start)
    + src.slice(start, end).replace(/^assign costfactor\b/m, 'assign costfactor_base')
    + `# CycloRouter: EuroVelo (internationale Radrouten) bevorzugen\n`
    + `assign costfactor = multiply costfactor_base switch route_bicycle_icn=yes 1 switch route_bicycle_ncn=yes ${ncn} ${penalty}\n\n`
    + src.slice(end);
}

const uploading = new Map(); // `${profil}|${faktor}` → laufender Upload (Teilstücke fragen gleichzeitig an)

async function customProfile(name, penalty, signal, force = false) {
  const key = `${name}|${penalty}`;
  const hit = uploaded.get(key);
  if (!force && hit && Date.now() - hit.t < PROFILE_TTL) return hit.id;
  if (!uploading.has(key)) {
    // Ohne signal: Der Upload gehört allen wartenden Teilstücken, nicht nur dem ersten
    const p = (async () => {
      const text = patchProfile(await loadSource(name), penalty);
      let res;
      try {
        res = await fetch(`${ENDPOINT}/profile`, { method: 'POST', body: text, signal: withTimeout(null, UPLOAD_TIMEOUT) });
      } catch {
        throw Object.assign(new Error('BRouter ist nicht erreichbar (Internetverbindung oder Server überlastet).'), { busy: true });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.profileid) {
        throw Object.assign(new Error('BRouter: EuroVelo-Profil konnte nicht hochgeladen werden' + (data.error ? ` (${data.error})` : '')),
          { busy: BUSY_STATUS.has(res.status) || BUSY_TEXT.test(String(data.error || '')) });
      }
      uploaded.set(key, { id: data.profileid, t: Date.now() });
      return data.profileid;
    })();
    uploading.set(key, p);
    p.catch(() => {}).finally(() => uploading.delete(key));
  }
  return abortable(uploading.get(key), signal);
}

/** Eine Anfrage → {ok, text, busy}. `busy`: ausgelastet bzw. nicht erreichbar (neuer Versuch sinnvoll). */
async function requestOnce(points, profile, signal, params = {}) {
  const lonlats = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const extra = Object.entries(params).map(([k, v]) => `&profile:${k}=${encodeURIComponent(v)}`).join('');
  const url = `${ENDPOINT}?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}${extra}&alternativeidx=0&format=geojson`;
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Unter Last bricht brouter.de Verbindungen auch einfach ab – wie „ausgelastet“ behandeln
    return { ok: false, busy: true, text: 'BRouter ist nicht erreichbar (Internetverbindung oder Server überlastet).' };
  }
  const text = await res.text();
  const ok = res.ok && text.trimStart().startsWith('{');
  return { ok, text, busy: !ok && (BUSY_STATUS.has(res.status) || BUSY_TEXT.test(text)) };
}

/**
 * Anfrage mit neuen Versuchen: brouter.de antwortet unter Last mit „retry later“ bzw. Timeouts. Nach 2 und
 * 5 s klappt es meist; erst danach gilt die Anfrage als gescheitert (und index.js weicht auf Valhalla aus).
 * `retries: false` (BRouter gerade als ausgelastet bekannt): nur ein Versuch.
 */
async function request(points, profile, signal, retries = true, params = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await requestOnce(points, profile, signal, params);
    if (r.ok || !r.busy || !retries || attempt >= RETRY_DELAYS.length) return r;
    routingNotice(`BRouter ist ausgelastet – neuer Versuch in ${RETRY_DELAYS[attempt] / 1000} s …`);
    await sleep(RETRY_DELAYS[attempt], signal);
  }
}

export const brouter = {
  id: 'brouter',
  name: 'BRouter',
  supportsTraffic: true,
  supportsEurovelo: true,
  // index.js rechnet Teilstück für Teilstück und merkt sie sich (BRouter rechnet Wegpunkte ohnehin einzeln)
  perLeg: true,

  /**
   * points: [{lat, lon}, ...] → {coords: [[lat, lon, ele], ...], segments}.
   * Fehler tragen `busy: true`, wenn BRouter ausgelastet bzw. nicht erreichbar war.
   */
  async route(points, { bike, traffic, eurovelo = 'off', retries = true }, signal) {
    const base = PROFILES[bike][traffic] || PROFILES[bike].normal;
    const penalty = EUROVELO_PENALTY[eurovelo];
    const params = PARAMS[bike] || {};
    let profile = penalty ? await customProfile(base, penalty, signal) : base;
    let { ok, text, busy } = await request(points, profile, signal, retries, params);
    // Abgelaufenes eigenes Profil → einmal neu hochladen
    if (!ok && !busy && penalty && /profile/i.test(text)) {
      profile = await customProfile(base, penalty, signal, true);
      ({ ok, text, busy } = await request(points, profile, signal, retries, params));
    }
    if (!ok) throw Object.assign(new Error(translateError(text)), { busy });

    const feature = JSON.parse(text).features[0];
    const coords = feature.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, ele ?? null]);
    return { coords, segments: parseSegments(feature.properties.messages, coords) };
  },
};

/**
 * BRouter-Messages: je Zeile der Endpunkt eines Abschnitts (Mikrograd), seine Länge und die OSM-Tags.
 * Der Endpunkt wird in der Geometrie gesucht; gelingt das nicht, wird über die kumulierte Länge zugeordnet.
 */
function parseSegments(messages, coords) {
  if (!messages || messages.length < 2) return [];
  const [header, ...rows] = messages;
  const col = name => header.indexOf(name);
  const iLon = col('Longitude'), iLat = col('Latitude'), iDist = col('Distance'), iTags = col('WayTags');

  let cum = null;
  const indexAtDistance = d => {
    if (!cum) {
      cum = [0];
      for (let i = 1; i < coords.length; i++) {
        cum.push(cum[i - 1] + haversine({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat: coords[i][0], lon: coords[i][1] }));
      }
    }
    const i = cum.findIndex(c => c >= d);
    return i < 0 ? coords.length - 1 : i;
  };

  const segments = [];
  let from = 0, travelled = 0;
  for (const row of rows) {
    travelled += Number(row[iDist]);
    const lon = Number(row[iLon]), lat = Number(row[iLat]);
    let to = -1;
    for (let j = from + 1; j < coords.length; j++) {
      if (Math.abs(Math.round(coords[j][1] * 1e6) - lon) <= 1 && Math.abs(Math.round(coords[j][0] * 1e6) - lat) <= 1) { to = j; break; }
    }
    if (to < 0) to = Math.max(from + 1, indexAtDistance(travelled));
    if (to >= coords.length) break;
    segments.push({ from, to, ...classifyOsmTags(row[iTags]) });
    from = to;
  }
  if (segments.length) segments[segments.length - 1].to = coords.length - 1;
  return mergeSegments(segments);
}
