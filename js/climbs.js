/**
 * Steigungen einer Route: Abschnitte nach Steigungsklasse (für Balken, Höhenprofil und Kartenlinie) und die
 * größten Anstiege. Grundlage sind die Höhen der Routenpunkte – ohne Höhen gibt es weder das eine noch das andere.
 */

/** Länge, über die die Steigung gemittelt wird (m). Kürzer wäre vom Rauschen der Höhendaten geprägt. */
const WINDOW = 200;
/** Ein Anstieg beginnt bei dieser Steigung … */
const CLIMB_START = 0.02;
/** … und endet, wenn sie länger als CLIMB_GAP (m) unter diesem Wert bleibt – kurze Flachstücke gehören dazu. */
const CLIMB_KEEP = 0.01, CLIMB_GAP = 300;
/** Kleinere Anstiege sind keine Erwähnung wert (m Höhengewinn). */
const CLIMB_MIN_GAIN = 20;

/** Steigungsklasse (Schlüssel in CATEGORIES.grade, surfaces.js) zu einer Steigung (0,05 = 5 %). */
export function gradeClass(g) {
  if (g < -0.03) return 'down';
  if (g < 0.03) return 'flat';
  if (g < 0.06) return 'up3';
  return g < 0.1 ? 'up6' : 'up10';
}

const cache = new WeakMap();

/** Je Routenpunkt die Höhe ohne Lücken und die über WINDOW gemittelte Steigung – je Route nur einmal berechnet. */
function profile(route) {
  let p = cache.get(route);
  if (p) return p;
  const { coords, cum } = route;
  if (!coords.some(c => c[2] != null)) {
    p = { ele: null, grade: null };
  } else {
    // Punkte ohne Höhe (kommt in GPX-Dateien vor): zwischen den Nachbarn mit Höhe interpolieren. Die letzte
    // Höhe fortzuschreiben ergäbe ein Plateau und danach einen Sprung – kurze falsche Klassen im Profil.
    const n = coords.length, ele = new Array(n);
    let a = -1;
    for (let i = 0; i < n; i++) {
      if (coords[i][2] == null) continue;
      for (let k = a + 1; k < i; k++) {
        ele[k] = a < 0 ? coords[i][2] : coords[a][2] + (coords[i][2] - coords[a][2]) * (cum[k] - cum[a]) / ((cum[i] - cum[a]) || 1);
      }
      ele[i] = coords[i][2];
      a = i;
    }
    for (let k = a + 1; k < n; k++) ele[k] = coords[a][2];
    const grade = new Array(coords.length);
    // Fenster um jeden Punkt: lo und hi wandern nur vorwärts
    for (let i = 0, lo = 0, hi = 0; i < coords.length; i++) {
      while (cum[i] - cum[lo] > WINDOW / 2) lo++;
      while (hi < coords.length - 1 && cum[hi] - cum[i] < WINDOW / 2) hi++;
      grade[i] = cum[hi] > cum[lo] ? (ele[hi] - ele[lo]) / (cum[hi] - cum[lo]) : 0;
    }
    p = { ele, grade };
  }
  cache.set(route, p);
  return p;
}

/** Hat die Route Höhen (sonst keine Steigungen)? */
export const hasElevation = route => !!profile(route).grade;

/**
 * Abschnitte gleicher Steigungsklasse: [{from, to, grade}] mit Indizes in route.coords, lückenlos von Anfang bis
 * Ende – aufgebaut wie route.segments, damit Balken, Profil und Kartenlinie sie genauso behandeln.
 */
export function gradeSegments(route) {
  const p = profile(route);
  if (p.segments || !p.grade) return p.segments || [];
  const out = [];
  for (let i = 0; i < p.grade.length - 1; i++) {
    const cls = gradeClass(p.grade[i]);
    const prev = out[out.length - 1];
    if (prev && prev.grade === cls) prev.to = i + 1;
    else out.push({ from: i, to: i + 1, grade: cls });
  }
  return (p.segments = out);
}

/**
 * Die bis zu `limit` größten Anstiege (nach Höhengewinn), in Reihenfolge der Route:
 * [{from, to (m ab Start), length (m), gain (m), mean, max (Steigung, 0,05 = 5 %)}].
 */
export function findClimbs(route, limit = 5) {
  const { ele, grade } = profile(route);
  if (!grade) return [];
  const { cum } = route;
  const climbs = [];
  const close = (start, end) => {
    const gain = ele[end] - ele[start], length = cum[end] - cum[start];
    if (gain < CLIMB_MIN_GAIN || length <= 0 || gain / length < CLIMB_START) return;
    let max = 0;
    for (let i = start; i <= end; i++) max = Math.max(max, grade[i]);
    climbs.push({ from: cum[start], to: cum[end], length, gain, mean: gain / length, max });
  };
  let start = -1, lastUp = -1;
  for (let i = 0; i < grade.length; i++) {
    if (start < 0) {
      if (grade[i] >= CLIMB_START) start = lastUp = i;
    } else if (grade[i] >= CLIMB_KEEP) {
      lastUp = i;
    } else if (cum[i] - cum[lastUp] > CLIMB_GAP) {
      close(start, lastUp);
      start = -1;
    }
  }
  if (start >= 0) close(start, lastUp);
  return climbs.sort((a, b) => b.gain - a.gain).slice(0, limit).sort((a, b) => a.from - b.from);
}
