const R = 6371008.8; // mittlerer Erdradius in m
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Luftlinie in Metern zwischen zwei {lat, lon}. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Punkt in `dist` Metern Entfernung in Richtung `bearing` (Grad, 0 = Nord). */
export function destination(p, bearing, dist) {
  const d = dist / R, b = rad(bearing), lat1 = rad(p.lat), lon1 = rad(p.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lon: ((deg(lon2) + 540) % 360) - 180 };
}

/** Deterministischer Zufallsgenerator (mulberry32). */
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

/**
 * Kumulierte Distanzen sowie Anstieg/Abstieg aus [[lat, lon, ele], ...].
 * Höhenmeter mit Hysterese, damit Messrauschen nicht aufsummiert wird.
 */
export function computeStats(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [la1, lo1] = coords[i - 1], [la2, lo2] = coords[i];
    cum.push(cum[i - 1] + haversine({ lat: la1, lon: lo1 }, { lat: la2, lon: lo2 }));
  }
  let ascent = 0, descent = 0;
  const THRESHOLD = 4;
  let ref = coords.find(c => c[2] != null)?.[2];
  for (const c of coords) {
    const e = c[2];
    if (e == null || ref == null) continue;
    if (e - ref >= THRESHOLD) { ascent += e - ref; ref = e; }
    else if (ref - e >= THRESHOLD) { descent += ref - e; ref = e; }
  }
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

/** Geschätzte Fahrzeit in Sekunden. */
export function estimateTime(distance, ascent, bike) {
  const speed = bike === 'gravel' ? 20 : 27;     // km/h in der Ebene
  const climbRate = bike === 'gravel' ? 1000 : 1200; // Höhenmeter, die ~1 h Zusatzzeit kosten
  return (distance / 1000 / speed + ascent / climbRate) * 3600;
}

export const formatKm = m => (m / 1000).toLocaleString('de-DE', { maximumFractionDigits: m < 100000 ? 1 : 0 }) + ' km';
export const formatM = m => Math.round(m).toLocaleString('de-DE') + ' m';
export function formatDuration(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
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
  },
};
