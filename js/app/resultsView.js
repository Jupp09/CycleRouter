/**
 * Ergebnis-Panel: Kennzahlen (Distanz, Höhenmeter, Fahrzeit), Tageslicht, Anteil auf Radfernwegen, Routenname,
 * Höhenprofil und die Aufschlüsselung nach Untergrund bzw. Wegtyp (samt Einfärbung der Routenlinie).
 */
import { summarize, estimatedShare, longDistanceShare } from '../surfaces.js';
import { storage, estimateTime, averageSpeed, haversine, formatKm, formatM, formatDuration } from '../utils.js';
import { fetchPoisNear } from '../poiTiles.js';
import { dayTimes } from '../timeline.js';
import { daylightNote, daylightToday } from '../sun.js';
import { state, on, defaultName, departureDate } from './state.js';
import { $, ui } from './dom.js';
import { elevation, drawRouteLine } from './mapView.js';
import { syncUi } from './controls.js';

on('route', r => {
  if (!r) {
    elevation.hide();
    ui.results.hidden = true;
    return;
  }
  elevation.show(r, state.breakdown);
  renderBreakdown();
  renderStats(r);
  renderDaylight(r);
  renderStation(r);
  // Name einer geöffneten gespeicherten/geteilten Route beibehalten
  ui.routeName.value = state.loadedName ?? defaultName(r);
  ui.results.hidden = false;
});

/**
 * Kurze Zusammenfassung für Screenreader, wenn eine Berechnung fertig ist (pipeline.js) –
 * z. B. „Route berechnet: 42 km, 310 m Anstieg, Fahrzeit ca. 2 h 5 min, 3 Verpflegungsstopps“.
 */
export function routeSummary(r) {
  const parts = [formatKm(r.distance), `${formatM(r.ascent)} Anstieg`, `Fahrzeit ca. ${formatDuration(estimateTime(r.distance, r.ascent, state.bike))}`];
  if (r.stops?.length) parts.push(`${r.stops.length} ${r.stops.length === 1 ? 'Verpflegungsstopp' : 'Verpflegungsstopps'}`);
  const nights = r.stays?.nights.filter(n => n.chosen).length;
  if (nights) parts.push(`${nights} ${nights === 1 ? 'Übernachtung' : 'Übernachtungen'}`);
  return `Route berechnet: ${parts.join(', ')}`;
}

function renderStats(r) {
  // Teilstücke vom Ausweichdienst (routing/index.js): offen sagen, dass die Route anders bewertet wurde
  const fb = $('#routing-fallback');
  fb.hidden = !r.fallback;
  if (r.fallback) {
    fb.textContent = `BRouter war ausgelastet – die Route wurde ganz oder teilweise mit ${r.fallback} berechnet. `
      + 'Valhalla bewertet Wege etwas anders, eine EuroVelo-Bevorzugung gibt es dort nicht. Spätere Berechnungen versuchen es wieder mit BRouter.';
  }
  $('#stat-dist').textContent = formatKm(r.distance);
  $('#stat-up').textContent = formatM(r.ascent);
  $('#stat-down').textContent = formatM(r.descent);
  $('#stat-time').textContent = formatDuration(estimateTime(r.distance, r.ascent, state.bike));
  $('#stat-time').title = `Ø ${averageSpeed(state.bike)} km/h in der Ebene, Anstiege zusätzlich – einstellbar unter Einstellungen`;

  const ld = longDistanceShare(r);
  const evEl = $('#eurovelo-share');
  // Anzeigen, wenn bevorzugt wurde oder die Route ohnehin nennenswert auf Radfernwegen verläuft
  evEl.hidden = ld == null || (state.eurovelo === 'off' && ld.longDistance / r.distance < 0.05);
  if (!ld) return;
  const pct = d => Math.round(d / r.distance * 100);
  evEl.textContent = `Auf Radfernwegen (EuroVelo/national): ${formatKm(ld.longDistance)} (${pct(ld.longDistance)} %)`
    + (ld.eurovelo ? `, davon direkt als EuroVelo erfasst: ${pct(ld.eurovelo)} %` : '');
  evEl.title = 'In Deutschland verläuft EuroVelo meist über nationale D-Routen und ist in OpenStreetMap oft nur über diese erfasst – '
    + 'deshalb werden beide zusammen gezählt.';
}

/**
 * Tageslicht bei Touren an einem Tag (Mehrtagestouren: je Tag in der Tagesliste, stagesView.js). Ist die Abfahrt
 * sichtbar festgelegt (Verpflegungsstopps oder Mehrtagestour), wird gegen sie geprüft; sonst nur der helle Tag heute.
 */
function renderDaylight(r) {
  const el = $('#daylight');
  const first = r.coords[0], last = r.coords.at(-1);
  const note = r.stageStarts?.length ? null
    : state.supply.enabled || state.multiDay ? daylightNote(dayTimes(r, departureDate(), state.bike)[0], first, last)
    : daylightToday(first, estimateTime(r.distance, r.ascent, state.bike));
  el.hidden = !note;
  if (!note) return;
  el.textContent = note.text;
  el.classList.toggle('warn', note.warn);
}

/** So weit vom Ziel wird ein Bahnhof für die Rückfahrt noch genannt (m). */
const STATION_REACH = 2500;
let stationController = null;

/**
 * A→B: nächster Bahnhof am Ziel, für die Rückfahrt. Nur aus dem Kachel-Cache – die Zeile wartet nie auf Overpass.
 * Fehlen die Kacheln noch, lädt der Server sie im Hintergrund; dann wird ein paar Mal nachgesehen. Keine Ansage.
 */
async function renderStation(r, attempt = 0) {
  const el = $('#station-hint');
  stationController?.abort();
  if (!attempt) el.hidden = true;
  if (state.mode !== 'ab' || !state.end) return;
  const ctrl = stationController = new AbortController();
  const [lat, lon] = r.coords.at(-1), end = { lat, lon };
  let pois;
  try {
    pois = await fetchPoisNear([end], ctrl.signal, ['service'], { cacheOnly: true });
  } catch {
    return; // ohne Daten keine Zeile
  }
  if (ctrl.signal.aborted) return;
  const station = pois.filter(p => p.type === 'station').map(p => ({ p, d: haversine(end, p) }))
    .filter(x => x.d <= STATION_REACH).sort((a, b) => a.d - b.d)[0];
  if (station) {
    el.textContent = `Nächster Bahnhof am Ziel: ${station.p.name || 'Bahnhof'}, ${formatKm(station.d)}`;
    el.hidden = false;
  } else if (!pois.complete && attempt < STATION_RETRY.length) {
    const timer = setTimeout(() => { if (!ctrl.signal.aborted && state.route === r) renderStation(r, attempt + 1); }, STATION_RETRY[attempt]);
    ctrl.signal.addEventListener('abort', () => clearTimeout(timer));
  }
}
/** Wartezeiten bis zum nächsten Blick in den Cache (ms) – ein kalter Overpass-Abruf dauert oft 30 s und mehr. */
const STATION_RETRY = [5000, 15000, 40000];

/** Balken und Legende „Untergrund“ bzw. „Wegtyp“ mit km und Anteil. */
function renderBreakdown() {
  const r = state.route;
  const box = $('#breakdown');
  box.hidden = !r?.segments?.length;
  if (box.hidden) return;

  const items = summarize(r, state.breakdown);
  $('#breakdown-bar').replaceChildren(...items.map(it => {
    const span = document.createElement('span');
    span.style.flex = String(it.share);
    span.style.background = it.color;
    span.title = `${it.label}: ${formatKm(it.distance)}`;
    return span;
  }));
  $('#breakdown-legend').replaceChildren(...items.map(it => {
    const li = document.createElement('li');
    const dot = document.createElement('i');
    dot.style.setProperty('--c', it.color);
    if (it.dash) dot.className = it.dash;
    const cell = (cls, text) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; };
    li.append(dot, cell('', it.label), cell('km', formatKm(it.distance)), cell('pct', `${Math.round(it.share * 100)} %`));
    return li;
  }));

  // Untergrund fehlt in OSM oft und wird aus dem Wegtyp geschätzt – das offen sagen
  const hint = $('#breakdown-hint');
  const estimated = estimatedShare(r);
  hint.hidden = state.breakdown !== 'surface' || estimated < 0.01;
  hint.textContent = `${Math.round(estimated * 100)} % des Untergrunds ist in OpenStreetMap nicht explizit erfasst und aus Straßen- bzw. Wegtyp abgeleitet.`;
}

$('#breakdown-switch').addEventListener('click', e => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value || value === state.breakdown) return;
  state.breakdown = value;
  storage.set('breakdown', value);
  syncUi();
  renderBreakdown();
  drawRouteLine();
  elevation.setKind(value);
});

$('#color-route').addEventListener('change', e => {
  state.colorRoute = e.target.checked;
  storage.set('colorRoute', state.colorRoute);
  drawRouteLine();
});
