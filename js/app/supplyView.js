/**
 * Verpflegungsstopps: Einstellungen (an/aus, Abstand, Abfahrt), Liste und Karten-Marker der Stopps,
 * durchfahrene Länder/Bundesländer und Feiertagshinweise – auch schon zur Abfahrt am Startort.
 */
import { STATE_LABELS, WARN_STATES, DWELL_MIN } from '../stops.js';
import { regionAt, regionLabel } from '../regions.js';
import { holidayAt } from '../holidays.js';
import { storage, formatKm, formatClock, formatWeekday, formatDayDate } from '../utils.js';
import { state, on, defaultDeparture } from './state.js';
import { $, textLines, externalLink, rowButton, span } from './dom.js';
import { map } from './mapView.js';
import { syncUi } from './controls.js';
import { replanStops } from './pipeline.js';

on('route', renderStops);
on('start', updateDepartureHint);

const isWarn = s => WARN_STATES.has(s.state);

/** Feiertag als „Sa., 08.11.“ (ISO-Datum; Mittag, damit keine Zeitzone den Tag verschiebt). */
const holidayDay = iso => formatDayDate(new Date(iso + 'T12:00'));

/** Land, in dem die Route beginnt – Regionen dort ohne Länderzusatz anzeigen. */
const homeCountry = () => state.route?.regions?.find(s => s.country)?.country || 'DE';

/** Öffnungszeiten-Zeile: eigene Angabe oder – gekennzeichnet – die typischen Zeiten der Kette. */
function hoursText(s) {
  if (s.poi.tags.opening_hours) return `Öffnungszeiten: ${s.poi.tags.opening_hours}`;
  const t = s.poi.typical;
  if (t) return `Typische Öffnungszeiten ${t.chain} (${t.count} von ${t.total} Filialen in der Umgebung): ${t.hours}`;
  return '';
}

function stopPopup(s) {
  const el = document.createElement('div');
  el.className = 'stop-popup';
  const title = document.createElement('b');
  title.textContent = `${s.icon} ${s.poi.name || s.typeLabel}`;
  const lines = [
    `${s.typeLabel} · km ${(s.along / 1000).toFixed(1)}`,
    `Ankunft ca. ${formatWeekday(s.eta)} ${formatClock(s.eta)} – ${STATE_LABELS[s.state]}`,
  ];
  const hours = hoursText(s);
  if (hours) lines.push(hours);
  if (s.region) lines.push(regionLabel(s.region, homeCountry()));
  if (s.holiday) lines.push(`🎉 Feiertag: ${s.holiday.name}`);
  el.append(title, ...textLines(lines), externalLink('In OpenStreetMap ansehen', `https://www.openstreetmap.org/${s.poi.id}`));
  return el;
}

/** Stopps auf Karte und in der Liste; Lücken ohne passende Stelle als Warnung. */
function renderStops() {
  const r = state.route;
  const stops = r?.stops || [];
  map.setStops(stops.map((s, i) => ({
    id: s.poi.id, lat: s.poi.lat, lon: s.poi.lon, icon: s.icon, warn: isWarn(s), popup: stopPopup(s),
    title: `Verpflegungsstopp ${i + 1}: ${s.poi.name || s.typeLabel}, km ${Math.round(s.along / 1000)}`,
  })));

  const box = $('#stops');
  box.hidden = !r || !r.stops;
  if (box.hidden) return;
  renderRegions(r);

  $('#stop-list').replaceChildren(...stops.map(s => {
    const li = document.createElement('li');
    const ico = span('ico', s.icon);
    ico.setAttribute('aria-hidden', 'true'); // Typ steht ohnehin im Text
    const main = span('main');
    const detail = document.createElement('small');
    detail.textContent = `${s.poi.name ? s.typeLabel + ' · ' : ''}${STATE_LABELS[s.state]}${s.holiday ? ` · 🎉 ${s.holiday.name}` : ''}`;
    if (isWarn(s)) detail.className = 'warn';
    main.append(span('name', s.poi.name || s.typeLabel), detail);
    const when = span('when');
    const km = document.createElement('b');
    km.textContent = formatKm(s.along);
    const clock = document.createElement('small');
    clock.textContent = `ca. ${formatClock(s.eta)}`;
    when.append(km, clock);
    // Ganze Zeile als Knopf: zeigt den Stopp auf der Karte (per Tastatur erreichbar)
    const row = rowButton([ico, main, when], () => map.openStop(s.poi.id));
    row.title = hoursText(s) || '';
    li.append(row);
    return li;
  }));

  const gaps = $('#stop-gaps');
  const messages = [];
  if (!stops.length && !r.gaps.length) messages.push(`Die Route ist kürzer als ${state.supply.intervalKm} km – kein Stopp nötig.`);
  for (const g of r.gaps) {
    messages.push(`Zwischen km ${Math.round(g.from / 1000)} und ${Math.round(g.to / 1000)} wurde keine passende, geöffnete Verpflegungsstelle gefunden.`);
  }
  if (stops.length) messages.push(`Ankunftszeiten inkl. ${DWELL_MIN} min Pause je Stopp.`);
  // Bäckereien/Cafés werden nicht abgewartet (siehe addStops) – beim nächsten Planen sind sie dabei
  if (r.foodPartial) messages.push('Bäckereien und Cafés werden für einen Teil der Strecke gerade nachgeladen und beim nächsten Planen berücksichtigt.');
  gaps.hidden = !messages.length;
  gaps.className = 'hint' + (r.gaps.length ? ' warn' : '');
  gaps.textContent = messages.join(' ');
}

/** Durchfahrene Länder/Bundesländer (nur bei Grenzübertritt) und Feiertage unterwegs. */
function renderRegions(r) {
  const regionsEl = $('#route-regions');
  const segs = (r.regions || []).filter(s => s.country);
  const home = homeCountry();
  regionsEl.hidden = segs.length < 2;
  // Grenzen ohne Feiertag nur grob bestimmt (±10 km, siehe regionsAlong) → „ab ca. km …“
  regionsEl.textContent = segs.length < 2 ? '' : 'Route durch: ' + segs.map((s, i) =>
    `${regionLabel(s, home)}${i ? ` (ab ${s.approx ? 'ca. ' : ''}km ${Math.round(s.from / 1000)})` : ''}`).join(' → ');

  const notes = $('#holiday-notes');
  const items = (r.holidays || []).map(h => {
    const li = document.createElement('li');
    // Landesweit in nur einem Land → Ländername; sonst die betroffenen Regionen
    const where = h.national && new Set(h.regions.map(s => s.country)).size === 1
      ? h.regions[0].countryName
      : h.regions.map(s => regionLabel(s, home)).join(', ');
    li.textContent = `🎉 ${holidayDay(h.date)}: ${h.name} – Feiertag in ${where}. Läden haben meist geschlossen; Trinkwasser und Tankstellen werden bevorzugt.`;
    return li;
  });
  const note = text => { const li = document.createElement('li'); li.textContent = text; items.push(li); };
  if (r.holidayCheck === 'pending') note('Feiertage entlang der Route werden noch geprüft …');
  if (r.holidayCheck === false) note('Feiertage konnten nicht geprüft werden (Regionen bzw. Feiertagsdaten nicht erreichbar).');
  notes.replaceChildren(...items);
  notes.hidden = !items.length;
}

let hintRequest = 0;
/** Hinweis unter der Abfahrtszeit, wenn am Startort an diesem Tag ein Feiertag ist. */
export async function updateDepartureHint() {
  const el = $('#departure-hint');
  const id = ++hintRequest; // nur die jüngste Anfrage darf den Hinweis setzen
  const date = new Date(state.supply.departure);
  if (!state.supply.enabled || !state.start || isNaN(date)) { el.hidden = true; return; }
  try {
    const region = await regionAt(state.start);
    const h = await holidayAt(region, date);
    if (id !== hintRequest) return;
    el.hidden = !h;
    if (h) el.textContent = `🎉 ${holidayDay(h.date)} ist ${h.name} – Feiertag in ${h.national ? region.countryName : regionLabel(region, region.country)}. Läden haben meist geschlossen.`;
  } catch (e) {
    console.warn(e);
    if (id === hintRequest) el.hidden = true;
  }
}

/** Neue Abfahrtszeit (auch aus der Mehrtagestour) übernehmen und Stopps/Unterkünfte neu planen. */
export function setDeparture(value, { replan }) {
  state.supply.departure = value || defaultDeparture();
  syncUi();
  updateDepartureHint();
  if (replan) replanStops();
}

$('#supply-enabled').addEventListener('change', e => {
  state.supply.enabled = e.target.checked;
  storage.set('supplyEnabled', state.supply.enabled);
  syncUi();
  updateDepartureHint();
  replanStops();
});
$('#supply-interval').addEventListener('change', e => {
  const v = Math.min(200, Math.max(10, Math.round(Number(e.target.value) || state.supply.intervalKm)));
  state.supply.intervalKm = v;
  storage.set('supplyInterval', v);
  syncUi();
  if (state.supply.enabled) replanStops();
});
$('#departure').addEventListener('change', e => setDeparture(e.target.value, { replan: state.supply.enabled }));
