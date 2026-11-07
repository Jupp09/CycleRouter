/**
 * Kleiner Parser für das OSM-Tag `opening_hours`.
 * Unterstützt die häufigen Formen („24/7“, „Mo-Fr 08:00-20:00; Sa 08:00-14:00; Su off“,
 * mehrere Zeitspannen, Spannen über Mitternacht, Feiertagsregeln „PH“). Schulferien (SH) werden ignoriert.
 * Alles andere (Monate, Wochen, sunrise, Kommentare …) ergibt `null` = unbekannt.
 */

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)';
const DAY_SPEC = new RegExp(`^(${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*)(?:\\s+|$)`);
const TIME = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/;

const cache = new Map();

/** → Array[7] (Mo…So) mit Zeitspannen [[startMin, endMin], …] oder null, wenn nicht verständlich. */
export function parseOpeningHours(value) {
  if (cache.has(value)) return cache.get(value);
  let week;
  try { week = parse(value); } catch { week = null; }
  cache.set(value, week);
  return week;
}

function parse(value) {
  const src = value.trim().replace(/\s*([-,])\s*/g, '$1');
  if (!src) return null;
  const week = Array.from({ length: 8 }, () => null); // 0–6 = Mo–So, 7 = Feiertag (PH)
  // Regeln: durch ";" oder "||" getrennt; „Mo-Fr 08:00-20:00, Sa 09:00-14:00“ ebenfalls als zwei Regeln
  const rules = src.split(/;|\|\|/).flatMap(r => r.split(new RegExp(`(?<=\\d|off|closed),(?=${DAY}\\b)`)));
  let any = false;

  for (let rule of rules) {
    rule = rule.trim();
    if (!rule) continue;
    let days = [0, 1, 2, 3, 4, 5, 6];
    const m = rule.match(DAY_SPEC);
    if (m) {
      days = expandDays(m[1]);
      rule = rule.slice(m[0].length).trim();
      if (!days.length) continue; // reine Schulferienregel (SH)
    }
    const ranges = parseTimes(rule);
    if (ranges === undefined) return null;
    for (const d of days) week[d] = ranges;
    any = true;
  }
  if (!any) return null;
  // Wochentage ohne Regel sind geschlossen; ohne PH-Regel bleibt der Feiertag offen (null)
  return week.map((r, i) => (i === 7 ? r : r || []));
}

function expandDays(spec) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-');
    if (a === 'PH') { out.add(7); continue; }
    if (a === 'SH') continue;
    const i = DAYS.indexOf(a), j = b ? DAYS.indexOf(b) : i;
    if (i < 0 || j < 0) continue;
    for (let k = i; ; k = (k + 1) % 7) { out.add(k); if (k === j) break; }
  }
  return [...out];
}

/** Zeitteil einer Regel → Spannen, [] für geschlossen, undefined wenn unverständlich. */
function parseTimes(text) {
  if (text === '24/7' || text === '') return text === '' ? undefined : [[0, 1440]];
  if (/^(off|closed)$/i.test(text)) return [];
  const ranges = [];
  for (const part of text.split(',')) {
    const m = part.match(TIME);
    if (!m) return undefined;
    const start = +m[1] * 60 + +m[2];
    let end = +m[3] * 60 + +m[4];
    if (end <= start) end += 1440; // über Mitternacht
    ranges.push([start, end]);
  }
  return ranges;
}

/** An Feiertagen gilt die PH-Regel, ohne eine solche die Sonntagsregel (in DE/AT/CH üblich). */
function openAt(week, date, holiday) {
  const weekday = (date.getDay() + 6) % 7;
  const day = holiday ? (week[7] ? 7 : 6) : weekday;
  const min = date.getHours() * 60 + date.getMinutes();
  const prev = (weekday + 6) % 7;
  return week[day].some(([s, e]) => min >= s && min < e)
    || week[prev].some(([, e]) => e > 1440 && min < e - 1440);
}

/** Enthält der Wert eine eigene Feiertagsregel (PH)? */
export const hasHolidayRule = value => !!(value && parseOpeningHours(value)?.[7]);

/**
 * Ist am Zeitpunkt `date` für mindestens `stayMin` Minuten geöffnet?
 * → 'open' | 'closed' | 'unknown'
 */
export function openState(value, date, stayMin = 15, holiday = false) {
  if (!value) return 'unknown';
  const week = parseOpeningHours(value);
  if (!week) return 'unknown';
  const leave = new Date(date.getTime() + stayMin * 60000);
  return openAt(week, date, holiday) && openAt(week, leave, holiday) ? 'open' : 'closed';
}
