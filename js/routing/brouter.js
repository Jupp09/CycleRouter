import { classifyOsmTags, mergeSegments } from '../surfaces.js';
import { haversine } from '../utils.js';
import { routingNotice } from './notice.js';
import { sleep, withTimeout } from '../shared.js';

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

const PUBLIC = 'https://brouter.de/brouter';
/**
 * Eigener BRouter-Server über den CycloRouter-Server (server/brouterProxy.mjs, BROUTER_URL). Er wird zuerst
 * gefragt, brouter.de ist der Ausweich: bei Ausfall, Überlastung, fehlenden Kartendaten oder Profilen dort.
 * Ohne Server bzw. ohne BROUTER_URL antwortet der Weg mit 404 – dann gilt für die Sitzung nur brouter.de.
 */
const OWN = String(new URL('../../api/brouter', import.meta.url));
/** Nach einem Ausfall bzw. „ausgelastet“ des eigenen Servers so lange gleich brouter.de nehmen */
const OWN_PAUSE = 60 * 1000;

let ownCheck = null, ownPausedUntil = 0;

/** Ist ein eigener BRouter eingerichtet? Einmal je Sitzung gefragt (geteilt von allen Teilstücken). */
function ownAvailable() {
  if (Date.now() < ownPausedUntil) return Promise.resolve(false);
  ownCheck ??= fetch(OWN, { signal: AbortSignal.timeout(5000) })
    .then(res => (res.ok ? res.json() : null))
    .then(data => data?.enabled === true)
    .catch(() => { // Server gerade nicht erreichbar → später noch einmal fragen
      ownCheck = null;
      ownPausedUntil = Date.now() + OWN_PAUSE;
      return false;
    });
  return ownCheck;
}

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

/**
 * Suchparameter nur für den eigenen Server: BRouter sucht standardmäßig in zwei Durchgängen – zielgerichtet
 * (pass1coefficient 1,5, Gravel-Profil 4) und danach Dijkstra mit Kostengrenze, der die meiste Zeit kostet.
 * Ein einziger Durchgang mit 1,2 ist fast so genau. Gemessen auf dem eigenen Server (2 vCPU), 11/2026:
 * Köln → Koblenz Trekking 3,4 → 1,8 s, Gravel 9,9 → 7,1 s, Rennrad 4,4 → 2,8 s; Bremen → München 79 → 34 s.
 * Kosten der Route +0 bis 0,2 %. brouter.de behält die Standardsuche (keine Last- oder Ergebnisänderung dort).
 * Wirkt auch auf hochgeladene EuroVelo-Profile: URL-Parameter gehen der ersten Zuweisung im Profil vor.
 */
const OWN_SEARCH = { pass1coefficient: 1.2, pass2coefficient: -1 };
/**
 * Gravel sucht mit 1,2 auf langen Strecken zu breit (das Profil selbst setzt 4): Triest → Durrës (1070 km)
 * lief über 180 s in den Proxy-Timeout, mit 2 sind es 104 s, Triest → Split 33 s. Auf kurzen Strecken
 * ~30 % schneller, Kosten +0,1–0,5 % (Bremen → Hamburg, München → Augsburg, 11/2026).
 */
const OWN_SEARCH_BY_PROFILE = { gravel: { pass1coefficient: 2 } };
/**
 * Lange Teilstücke (eine lange A→B-Route ist ein einziges) sucht der eigene Server mit 1,4 statt 1,2: Eine Suche
 * läuft auf einem Kern, und die Breite der Suche wächst mit der Länge. Gemessen 11/2026 (2 vCPU, Kosten zu 1,2):
 * Bremen → München Trekking 34,9 → 10,4 s (+1,0 %), Rennrad 51,9 → 24,7 s (+0,6 %); Köln → Frankfurt Trekking
 * 7,0 → 4,2 s (+0,7 %), Rennrad 8,0 → 5,5 s (+0,2 %). 1,5 wäre noch schneller, aber bis +2,8 %; 2 ergab
 * bis zu 40 % mehr Anstieg. Unter 100 km Luftlinie dauert die Suche ohnehin nur wenige Sekunden.
 */
const LONG_LEG = 100_000;
const LONG_SEARCH = { pass1coefficient: 1.4 };

/** Suchparameter für den eigenen Server je Profil und Luftlinie des Teilstücks (erster bis letzter Punkt). */
export function ownSearch(profile, points) {
  const long = points.length > 1 && haversine(points[0], points.at(-1)) >= LONG_LEG;
  return { ...OWN_SEARCH, ...(long && LONG_SEARCH), ...OWN_SEARCH_BY_PROFILE[profile] };
}

/** Antwort, die nur „zu viel los“ bedeutet – ein neuer Versuch oder ein anderer Dienst kann helfen. */
const BUSY_TEXT = /retry later|watchdog|timeout|timed out|too many|busy|overload/i;
const BUSY_STATUS = new Set([429, 502, 503, 504]);

/** Wartezeiten vor dem 2. und 3. Versuch, wenn BRouter ausgelastet ist */
const RETRY_DELAYS = [2000, 5000];

/** Punkt liegt abseits befahrbarer Wege – andere Server kämen zum selben Ergebnis. */
const NOT_ROUTABLE = /not mapped|no track found|position not/i;

function translateError(text, avoidFerries = false) {
  // Mit gesperrten Fähren heißt „kein Weg“ meist: Das Ziel (oder der Start) liegt auf einer Insel
  if (avoidFerries && /no track found/i.test(text)) {
    return 'Ohne Fähre wurde kein Weg gefunden – liegt ein Punkt auf einer Insel? Dann unter „Mehr Optionen“ „Fähren meiden“ ausschalten.';
  }
  if (NOT_ROUTABLE.test(text)) {
    return 'Ein Punkt liegt zu weit von einem befahrbaren Weg entfernt.';
  }
  if (BUSY_TEXT.test(text)) {
    return 'BRouter ist gerade ausgelastet – bitte gleich noch einmal versuchen.';
  }
  return 'BRouter-Fehler: ' + text.slice(0, 200);
}

// ---------- Angepasste Profile (EuroVelo-Bevorzugung, Fähren) ----------
// BRouter-Profile werten Radrouten-Relationen aus (`route_bicycle_icn` = international, d. h. EuroVelo).
// Die Standardprofile behandeln alle Radrouten gleich; für die Bevorzugung wird das Standardprofil
// angepasst – Wege abseits internationaler Radrouten werden um den Faktor teurer – und bei BRouter
// hochgeladen. Die Profil-Quelltexte liegen im Ordner /profiles, da brouter.de sie nicht per CORS ausliefert.

/**
 * Profile, in denen Fähren billiger sind als Straßen und die deshalb immer angepasst hochgeladen werden.
 * Gravel bewertet einen Meter Fähre mit 2, Haupt- und Nebenstraßen mit 3,6–4,8 (dazu Aufschläge für Verkehr
 * usw.): Triest → Durrës wurde so 739 km Fähre durch die Adria statt rund 900 km an der Küste entlang.
 * Trekking und Rennrad setzen 5,67 an (fastbike-verylowtraffic 11) und fahren dort über Land.
 */
const CHEAP_FERRIES = new Set(['gravel']);
/** Kostenfaktor für Fähren wie im Trekking-Profil: kurze Überfahrten bleiben möglich, lange nur bei sehr weitem Landweg. */
const FERRY_COST = 5.67;

/** Fähren im Gravel-Profil so teuer wie im Trekking-Profil machen. */
function patchFerries(src) {
  const out = src.replace(/^(\s*switch\s+highway=\s+switch\s+not\s+route=ferry\s+10000\s+)2\b/m, `$1${FERRY_COST}`);
  if (out === src) throw new Error('Profil lässt sich nicht anpassen (Fähren)');
  return out;
}

/**
 * „Fähren meiden“: Diese Profile haben dafür den Parameter `allow_ferries` (geht als URL-Parameter, ohne
 * Hochladen). Gravel und fastbike-verylowtraffic kennen ihn nicht – dort sperrt das hochgeladene Profil Fähren
 * (Kostenfaktor 10000 = nicht befahrbar).
 */
const FERRY_PARAM = new Set(['trekking', 'fastbike', 'fastbike-lowtraffic']);

/**
 * Quelltext des hochzuladenden Profils: Fähren korrigiert (nur `CHEAP_FERRIES`), EuroVelo bevorzugt (mit
 * `penalty`), Fähren gesperrt (`noFerries`).
 */
export function profileSource(src, name, penalty, noFerries = false) {
  if (CHEAP_FERRIES.has(name)) src = patchFerries(src);
  return penalty || noFerries ? patchProfile(src, penalty, noFerries) : src;
}

/** Aufschlag für Wege abseits von EuroVelo-Routen. Gemessen Köln→Koblenz: 1,5 → 80 %, 3 → 98 % auf EuroVelo. */
const EUROVELO_PENALTY = { prefer: 1.5, strong: 3 };
/**
 * Nationale Radfernwege (`ncn`) bekommen nur einen kleinen Teil des Aufschlags: In Deutschland ist EuroVelo
 * oft nur als Super-Relation über D-Routen erfasst (z. B. EV3 = D7 zwischen Bremen und Hamburg). BRouter
 * überträgt Super-Relationen nicht auf die Wege – diese Abschnitte sind für BRouter nur „national“.
 */
const NCN_SHARE = 0.15;
const PROFILE_TTL = 6 * 3600 * 1000; // hochgeladene Profile werden serverseitig irgendwann gelöscht

const sources = new Map();
const uploaded = new Map(); // `${server}|${profil}|${faktor}|${fähren}` → {id, t} (Profil-IDs gelten nur auf ihrem Server)

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
 * Benennt `costfactor` um und legt einen neuen darüber: abseits internationaler Radrouten mal `penalty`
 * (auf nationalen Radfernwegen nur ein kleiner Teil davon), mit `noFerries` Fähren gesperrt.
 */
function patchProfile(src, penalty, noFerries = false) {
  let expr = 'costfactor_base';
  const note = [];
  if (penalty) {
    const ncn = (1 + (penalty - 1) * NCN_SHARE).toFixed(3);
    expr = `multiply costfactor_base switch route_bicycle_icn=yes 1 switch route_bicycle_ncn=yes ${ncn} ${penalty}`;
    note.push('EuroVelo (internationale Radrouten) bevorzugen');
  }
  if (noFerries) {
    expr = `switch route=ferry 10000 ${expr}`;
    note.push('Fähren meiden');
  }
  const start = src.search(/^assign costfactor\b/m);
  if (start < 0) throw new Error('Profil lässt sich nicht anpassen');
  const offset = src.slice(start + 1).search(/^(assign |---context)/m);
  const end = offset < 0 ? src.length : start + 1 + offset;
  return src.slice(0, start)
    + src.slice(start, end).replace(/^assign costfactor\b/m, 'assign costfactor_base')
    + `# CycloRouter: ${note.join(', ')}\n`
    + `assign costfactor = ${expr}\n\n`
    + src.slice(end);
}

const uploading = new Map(); // `${server}|${profil}|${faktor}|${fähren}` → laufender Upload (Teilstücke fragen gleichzeitig an)

async function customProfile(endpoint, name, penalty, noFerries, signal, force = false) {
  const key = `${endpoint}|${name}|${penalty ?? 1}|${noFerries ? 'ohne Fähren' : ''}`;
  const hit = uploaded.get(key);
  if (!force && hit && Date.now() - hit.t < PROFILE_TTL) return hit.id;
  if (!uploading.has(key)) {
    // Ohne signal: Der Upload gehört allen wartenden Teilstücken, nicht nur dem ersten
    const p = (async () => {
      const text = profileSource(await loadSource(name), name, penalty, noFerries);
      let res;
      try {
        res = await fetch(`${endpoint}/profile`, { method: 'POST', body: text, signal: withTimeout(null, UPLOAD_TIMEOUT) });
      } catch {
        throw Object.assign(new Error('BRouter ist nicht erreichbar (Internetverbindung oder Server überlastet).'), { busy: true });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.profileid) {
        throw Object.assign(new Error('BRouter: Profil konnte nicht hochgeladen werden' + (data.error ? ` (${data.error})` : '')),
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
async function requestOnce(endpoint, points, profile, signal, params = {}) {
  const lonlats = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const extra = Object.entries(params).map(([k, v]) => `&profile:${k}=${encodeURIComponent(v)}`).join('');
  // timode=1: Abbiegehinweise (voicehints) für den FIT-Kurs (js/fit.js); kostet BRouter kaum etwas
  const url = `${endpoint}?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}${extra}&alternativeidx=0&format=geojson&timode=1`;
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Unter Last bricht brouter.de Verbindungen auch einfach ab – wie „ausgelastet“ behandeln
    return { ok: false, busy: true, status: 0, text: 'BRouter ist nicht erreichbar (Internetverbindung oder Server überlastet).' };
  }
  const text = await res.text();
  const ok = res.ok && text.trimStart().startsWith('{');
  return { ok, text, status: res.status, busy: !ok && (BUSY_STATUS.has(res.status) || BUSY_TEXT.test(text)) };
}

/**
 * Anfrage mit neuen Versuchen: brouter.de antwortet unter Last mit „retry later“ bzw. Timeouts. Nach 2 und
 * 5 s klappt es meist; erst danach gilt die Anfrage als gescheitert (und index.js weicht auf Valhalla aus).
 * `retries: false` (BRouter gerade als ausgelastet bekannt): nur ein Versuch.
 */
async function request(endpoint, points, profile, signal, retries = true, params = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await requestOnce(endpoint, points, profile, signal, params);
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
   * points: [{lat, lon}, ...] → {coords: [[lat, lon, ele], ...], segments, server}.
   * Fehler tragen `busy: true`, wenn BRouter ausgelastet bzw. nicht erreichbar war.
   */
  async route(points, { bike, traffic, eurovelo = 'off', avoidFerries = false, retries = true }, signal) {
    const base = PROFILES[bike][traffic] || PROFILES[bike].normal;
    const penalty = EUROVELO_PENALTY[eurovelo];
    const noFerries = avoidFerries && !FERRY_PARAM.has(base); // sonst als URL-Parameter (s. u.)
    const custom = !!penalty || noFerries || CHEAP_FERRIES.has(base);
    const params = { ...PARAMS[bike], ...(avoidFerries && FERRY_PARAM.has(base) && { allow_ferries: 0 }) };
    /** Profil (ggf. hochgeladen) und Anfrage bei einem Server */
    const attempt = async (endpoint, retry) => {
      let profile = base;
      if (custom) {
        try {
          profile = await customProfile(endpoint, base, penalty, noFerries, signal);
        } catch (e) {
          // Nur die Fähren-Korrektur: Scheitert der Upload, lieber das Standardprofil als gar keine Route
          if (penalty || noFerries || e.name === 'AbortError' || e.busy) throw e;
          console.info(`BRouter: ${e.message} – rechne mit dem Standardprofil`);
        }
      }
      const p = endpoint === OWN ? { ...params, ...ownSearch(base, points) } : params;
      let r = await request(endpoint, points, profile, signal, retry, p);
      // Abgelaufenes hochgeladenes Profil → einmal neu hochladen
      if (!r.ok && !r.busy && profile !== base && /profile/i.test(r.text)) {
        profile = await customProfile(endpoint, base, penalty, noFerries, signal, true);
        r = await request(endpoint, points, profile, signal, retry, p);
      }
      return r;
    };

    let r = null, server = 'brouter.de';
    if (await abortable(ownAvailable(), signal)) {
      server = 'own';
      // Eigener Server ohne neue Versuche: Klappt es nicht, ist brouter.de schneller als Warten
      try {
        r = await attempt(OWN, false);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        r = { ok: false, busy: true, text: e.message }; // Upload gescheitert
      }
      if (!r.ok) {
        if (NOT_ROUTABLE.test(r.text)) throw new Error(translateError(r.text, avoidFerries));
        if (r.busy) ownPausedUntil = Date.now() + OWN_PAUSE;
        if (r.status === 404) ownCheck = Promise.resolve(false); // Weg abgeschaltet (BRouter selbst antwortet mit 400)
        // Sonst z. B. fehlende Kartendaten oder ein fehlendes Profil auf dem eigenen Server
        console.info(`Eigener BRouter: ${r.text.trim().slice(0, 120)} – rechne mit brouter.de`);
        r = null;
        server = 'brouter.de';
      }
    }
    r ??= await attempt(PUBLIC, retries);
    const { ok, text, busy } = r;
    if (!ok) throw Object.assign(new Error(translateError(text, avoidFerries)), { busy });

    const feature = JSON.parse(text).features[0];
    const coords = feature.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, ele ?? null]);
    // `server`: wer gerechnet hat – 'own' (eigener Server über /api/brouter) oder 'brouter.de' (resultsView zeigt es)
    const turns = parseTurns(feature.properties.voicehints, coords.length);
    return { coords, segments: parseSegments(feature.properties.messages, coords), server, ...(turns.length && { turns }) };
  },
};

/**
 * Befehle der BRouter-Abbiegehinweise (VoiceHint.java), die der FIT-Kurs zeigt: 1 geradeaus, 2 links,
 * 3 leicht links, 4 scharf links, 5 rechts, 6 leicht rechts, 7 scharf rechts, 8 links halten, 9 rechts halten,
 * 10–12 wenden, 14/15 Kreisverkehr (rechts-/linksherum), 17/18 Ausfahrt links/rechts. Nicht: 13 abseits der
 * Route, 16 Luftlinie, 100 Ziel.
 */
const TURN_COMMANDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17, 18]);

/**
 * voicehints ([punktindex, befehl, ausfahrt, abstand, winkel], mit timode=1) → [{i, cmd, exit, angle}];
 * nur Hinweise auf Punkten zwischen Anfang und Ende des Teilstücks.
 * @returns {Turn[]}
 */
export function parseTurns(hints, count) {
  if (!Array.isArray(hints)) return [];
  return hints.filter(h => Array.isArray(h) && Number.isInteger(h[0]) && h[0] > 0 && h[0] < count - 1 && TURN_COMMANDS.has(h[1]))
    .map(([i, cmd, exit, , angle]) => ({ i, cmd, exit: Number(exit) || 0, angle: Math.round(Number(angle) || 0) }));
}

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
