/**
 * Kleine, zustandsarme Helfer für die ganze App: Geometrie, Routenkennzahlen, Fahrzeit, Formatierung
 * (immer de-DE) und der Zugriff auf den Browser-Speicher.
 */

// ---------- Geometrie ----------

const R = 6371008.8; // mittlerer Erdradius in m
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Luftlinie in Metern zwischen zwei {lat, lon} (genau, auch für große Entfernungen). */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Schnelle Näherung der Entfernung in m (ebene Projektion). Für kurze Strecken – Abstand eines Orts zur Route –
 * ausreichend genau und deutlich schneller als haversine, wenn tausende Punkte verglichen werden.
 */
export function approxDist(aLat, aLon, bLat, bLon) {
  const dy = (bLat - aLat) * 110540;
  const dx = (bLon - aLon) * 111320 * Math.cos((aLat + bLat) * Math.PI / 360);
  return Math.hypot(dx, dy);
}

/** Punkt in `dist` Metern Entfernung in Richtung `bearing` (Grad, 0 = Nord). */
export function destination(p, bearing, dist) {
  const d = dist / R, b = rad(bearing), lat1 = rad(p.lat), lon1 = rad(p.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lon: ((deg(lon2) + 540) % 360) - 180 };
}

// ---------- Zufall ----------

/** Deterministischer Zufallsgenerator (mulberry32) – gleiche Saat ergibt gleiche Rundkurs-Variante. */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newSeed = () => Math.floor(Math.random() * 2 ** 31);

// ---------- Routenkennzahlen ----------

/** Höhenänderungen unter dieser Schwelle (m) gelten als Messrauschen und werden nicht aufsummiert. */
const ELEVATION_THRESHOLD = 4;

/**
 * Höhenmeter mit Hysterese über [[lat, lon, ele], …] → {ascent, descent, cumAscent}.
 * `cumAscent[i]` ist der bis zur Koordinate i aufsummierte Anstieg (für Etappen- und Ankunftszeiten).
 */
function elevationProfile(coords) {
  let ascent = 0, descent = 0;
  let ref = coords.find(c => c[2] != null)?.[2];
  const cumAscent = [];
  for (const c of coords) {
    const e = c[2];
    if (e != null && ref != null) {
      if (e - ref >= ELEVATION_THRESHOLD) { ascent += e - ref; ref = e; }
      else if (ref - e >= ELEVATION_THRESHOLD) { descent += ref - e; ref = e; }
    }
    cumAscent.push(ascent);
  }
  return { ascent, descent, cumAscent };
}

/** Kumulierter Anstieg (m) je Routenkoordinate. */
export const cumulativeAscent = coords => elevationProfile(coords).cumAscent;

/** Kumulierte Distanzen (`cum`, m) sowie Gesamtlänge, Anstieg und Abstieg aus [[lat, lon, ele], …]. */
export function computeStats(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [la1, lo1] = coords[i - 1], [la2, lo2] = coords[i];
    cum.push(cum[i - 1] + haversine({ lat: la1, lon: lo1 }, { lat: la2, lon: lo2 }));
  }
  const { ascent, descent } = elevationProfile(coords);
  return { cum, distance: cum[cum.length - 1] || 0, ascent: Math.round(ascent), descent: Math.round(descent) };
}

/** Punkte entlang einer Route im Abstand von etwa `step` m (inkl. Endpunkt): [{lat, lon, along}] */
export function sampleRoute(r, step) {
  const out = [];
  let next = 0;
  r.coords.forEach((c, i) => {
    if (r.cum[i] >= next || i === r.coords.length - 1) {
      out.push({ lat: c[0], lon: c[1], along: r.cum[i] });
      next = r.cum[i] + step;
    }
  });
  return out;
}

/** Index der Routenkoordinate an Position `along` (m ab Start, binäre Suche in r.cum). */
export function indexAtDistance(r, along) {
  let lo = 0, hi = r.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] < along) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---------- Fahrzeit ----------

/** Standard-Durchschnittsgeschwindigkeit in der Ebene (km/h) je Fahrradtyp. */
export const DEFAULT_SPEED = { road: 27, gravel: 20, trekking: 18 };
export const SPEED_MIN = 10, SPEED_MAX = 35;
/** Höhenmeter, die etwa eine Stunde Zusatzzeit kosten, je Fahrradtyp. */
const CLIMB_RATE = { road: 1200, gravel: 1000, trekking: 800 };

let speedSetting = null; // vom Nutzer eingestellt (km/h) oder null = Standard je Fahrradtyp

/** Eigene Durchschnittsgeschwindigkeit setzen (null = Standard je Fahrradtyp). */
export function setAverageSpeed(kmh) {
  speedSetting = Number.isFinite(kmh) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, kmh)) : null;
}

/** Durchschnittsgeschwindigkeit in der Ebene, die der Fahrzeit zugrunde liegt. */
export const averageSpeed = bike => speedSetting ?? DEFAULT_SPEED[bike] ?? 20;

/** Geschätzte Fahrzeit in Sekunden: Strecke mit Durchschnittstempo, Anstiege als Zuschlag. */
export function estimateTime(distance, ascent, bike) {
  return (distance / 1000 / averageSpeed(bike) + ascent / (CLIMB_RATE[bike] ?? 1000)) * 3600;
}

// ---------- Formatierung (de-DE) ----------

export const formatKm = m => (m / 1000).toLocaleString('de-DE', { maximumFractionDigits: m < 100000 ? 1 : 0 }) + ' km';
export const formatM = m => Math.round(m).toLocaleString('de-DE') + ' m';
export const formatInt = n => n.toLocaleString('de-DE');
export function formatDuration(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
/** „14:20“ */
export const formatClock = d => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
/** „Sa.“ */
export const formatWeekday = d => d.toLocaleDateString('de-DE', { weekday: 'short' });
/** „Sa., 08.11.“ */
export const formatDayDate = d => d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
/** „08.11.2026“ */
export const formatDate = d => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Wert für <input type="datetime-local"> (Ortszeit, Minutengenau). */
export function toDateTimeLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Sonstiges ----------

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- Browser-Speicher ----------
// Alle Einstellungen laufen über `storage`: Präfix „cyclerouter.“, JSON, privater Modus wird abgefangen.
// Der Präfix bleibt trotz Umbenennung in „CycloRouter“, sonst gingen gespeicherte Einstellungen verloren.

const storageListeners = [];

// ---------- OpenStreetMap-Links ----------
// `id` wie in poiSource.js/placeSearch.js: 'node/123', 'way/45', 'relation/6'.

/** Objekt auf openstreetmap.org ansehen. */
export const osmUrl = id => `https://www.openstreetmap.org/${id}`;

/** Objekt im Editor auf openstreetmap.org öffnen (z. B. Öffnungszeiten nachtragen) – braucht ein OSM-Konto. */
export function osmEditUrl(id) {
  const [type, num] = id.split('/');
  return `https://www.openstreetmap.org/edit?${new URLSearchParams({ [type]: num })}`;
}

/** Hinweis („Note“) an dieser Stelle melden – ohne OSM-Konto; Mapper vor Ort korrigieren ihn. */
export function osmNoteUrl({ lat, lon }) {
  const la = lat.toFixed(5), lo = lon.toFixed(5);
  return `https://www.openstreetmap.org/note/new?lat=${la}&lon=${lo}#map=18/${la}/${lo}`;
}

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('cyclerouter.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('cyclerouter.' + key, JSON.stringify(value)); } catch { /* z. B. privater Modus */ }
    for (const fn of storageListeners) fn(key, value);
  },
};

/** Benachrichtigung bei jeder gespeicherten Einstellung (z. B. für den Abgleich mit dem Konto). */
export const onStorageSet = fn => storageListeners.push(fn);
