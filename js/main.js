import { providers, route, withStats } from './routing/index.js';
import {
  account, SYNC_KEYS, loadAccount, login, register, logout, deleteAccount, fetchSettings, pushSettings,
  listRoutes, getRoute, createRoute, updateRoute, deleteRoute, shareRoute, unshareRoute, getSharedRoute, shareUrl,
} from './account.js';
import { generateLoop, generateOneWay } from './generators.js';
import { createMap } from './map.js';
import { attachSearch, reverse } from './geocode.js';
import { createElevation } from './elevation.js';
import { downloadGpx, canShareGpx, shareGpx } from './gpx.js';
import { summarize, estimatedShare, longDistanceShare } from './surfaces.js';
import { addStops, STATE_LABELS, DWELL_MIN, arrivalAt, openingAt } from './stops.js';
import { PLACE_CATEGORIES, searchAlongRoute } from './placeSearch.js';
import {
  STAY_TYPES, STAY_GROUPS, isMultiDayCandidate, planStays, routeThroughStays, stageStats,
  priceLabel, priceLink, websiteOf, AVAILABILITY_LABEL, lastConfirmed,
} from './stays.js';
import { regionAt, regionLabel } from './regions.js';
import { holidayAt } from './holidays.js';
import {
  storage, newSeed, seededRandom, estimateTime, formatKm, formatM, formatDuration, haversine, debounce,
  DEFAULT_SPEED, setAverageSpeed, averageSpeed, onStorageSet,
} from './utils.js';

const $ = sel => document.querySelector(sel);
const MODE_LABELS = { ab: 'Route', distance: 'Strecke', loop: 'Rundkurs' };

const state = {
  bike: storage.get('bike', 'road'),
  traffic: storage.get('traffic', 'normal'),
  eurovelo: storage.get('eurovelo', 'off'), // 'off' | 'prefer' | 'strong'
  provider: storage.get('provider', 'brouter'),
  mode: storage.get('mode', 'ab'),
  distanceKm: storage.get('distanceKm', 60),
  direction: 'random',
  breakdown: storage.get('breakdown', 'surface'), // 'surface' | 'waytype'
  colorRoute: storage.get('colorRoute', true),
  supply: {
    enabled: storage.get('supplyEnabled', false),
    intervalKm: storage.get('supplyInterval', 30),
    departure: defaultDeparture(), // Wert eines datetime-local-Felds
  },
  start: null, // {lat, lon, label}
  end: null,
  vias: [], // A→B-Zwischenstopps: {lat, lon, label, manual: true, icon?} – lat null = noch nicht gewählt
  // Mehrtagestouren: Einstellungen (Zahnrad), ob die aktuelle Route aufgeteilt ist, gewählte Unterkünfte je Nacht
  stays: {
    maxKm: storage.get('stageMaxKm', 100),
    budget: storage.get('nightBudget', 80),
    groups: storage.get('stayTypes', ['hotel', 'guest_house', 'hostel', 'camp_site']),
    endStay: storage.get('endStay', true),
  },
  hiddenStays: storage.get('hiddenStays', []), // vom Nutzer ausgeblendete Unterkünfte (OSM-Kennungen)
  multiDay: false,
  stayChoices: [], // OSM-Kennung der gewählten Unterkunft je Nacht
  seed: newSeed(),
  route: null,
};

const ui = {
  startInput: $('#start-input'),
  endInput: $('#end-input'),
  range: $('#distance-range'),
  num: $('#distance-num'),
  distanceOut: $('#distance-out'),
  status: $('#status'),
  results: $('#results'),
  routeName: $('#route-name'),
};

/** Nächste volle Viertelstunde, als Wert für <input type="datetime-local">. */
function defaultDeparture() {
  const d = new Date(Math.ceil(Date.now() / 900000) * 900000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const formatClock = d => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const formatDay = d => d.toLocaleDateString('de-DE', { weekday: 'short' });

const provider = () => providers[state.provider];
const routeOpts = () => ({
  bike: state.bike, traffic: state.traffic,
  eurovelo: provider().supportsEurovelo ? state.eurovelo : 'off',
});

// ---------- Karte & Höhenprofil ----------

const map = createMap($('#map'), { onClick: handleMapClick, onMarkerDrag: handleMarkerDrag });
const elevation = createElevation($('#elevation-chart'), { onHover: p => map.showHover(p) });

function relayout() {
  requestAnimationFrame(() => map.invalidateSize());
}

// ---------- Anzeige ----------

function setStatus(text, kind) {
  ui.status.hidden = !text;
  ui.status.className = 'status' + (kind ? ' ' + kind : '');
  ui.status.textContent = text || '';
}

function syncUi() {
  for (const b of document.querySelectorAll('#bike-switch button')) b.setAttribute('aria-checked', b.dataset.value === state.bike);
  for (const t of document.querySelectorAll('#mode-tabs button')) t.setAttribute('aria-selected', t.dataset.mode === state.mode);
  for (const b of document.querySelectorAll('#breakdown-switch button')) b.setAttribute('aria-checked', b.dataset.value === state.breakdown);
  $('#color-route').checked = state.colorRoute;
  $('#supply-enabled').checked = state.supply.enabled;
  $('#supply-options').hidden = !state.supply.enabled;
  $('#supply-interval').value = state.supply.intervalKm;
  $('#departure').value = state.supply.departure;
  for (const n of document.querySelectorAll('[data-show]')) n.hidden = !n.dataset.show.split(' ').includes(state.mode);

  $('#traffic-field').hidden = state.bike !== 'road' || !provider().supportsTraffic;
  $('#traffic').value = state.traffic;
  $('#eurovelo-field').hidden = !provider().supportsEurovelo;
  $('#eurovelo').value = state.eurovelo;
  $('#provider').value = state.provider;
  $('#direction').value = state.direction;
  ui.range.value = state.distanceKm;
  ui.num.value = state.distanceKm;
  ui.distanceOut.textContent = `${state.distanceKm} km`;

  const hint = $('#provider-hint');
  hint.hidden = !(state.provider === 'ors' && state.bike === 'gravel');
  hint.textContent = 'OpenRouteService hat kein Gravel-Profil – es wird das allgemeine Fahrrad-Profil verwendet. Für echte Gravel-Routen BRouter wählen.';
}

const isLoop = r => r.waypoints.length > 2 && r.waypoints[0] === r.waypoints[r.waypoints.length - 1];

function updateMarkers() {
  const r = state.route;
  if (r && r.waypoints.length >= 2) {
    const wps = isLoop(r) ? r.waypoints.slice(0, -1) : r.waypoints;
    const last = r.waypoints.length - 1;
    // Verpflegungsstopps bekommen eigene Marker (nicht verschiebbar), `index` bleibt der Wegpunkt-Index
    let n = 0;
    map.setMarkers(wps.map((point, index) => {
      const kind = index === 0 ? 'start' : !isLoop(r) && index === last ? 'end' : point.manual ? 'manual' : 'via';
      return { point, index, kind, ...(kind === 'manual' && manualMarker(point, ++n)) };
    }).filter(m => !m.point.stop && !m.point.stay)); // Stopps und Unterkünfte haben eigene Marker
    return;
  }
  const markers = [];
  if (state.start) markers.push({ point: state.start, kind: 'start', index: 0 });
  if (state.mode === 'ab') {
    // Ohne Route (z. B. Ziel fehlt) Zwischenstopps trotzdem zeigen; verschieben ersetzt sie
    activeVias().forEach((v, i) => markers.push({ point: v, kind: 'manual', index: `via${i}`, ...manualMarker(v, i + 1) }));
    if (state.end) markers.push({ point: state.end, kind: 'end', index: 1 });
  }
  map.setMarkers(markers);
}

const manualMarker = (p, n) => ({ text: p.icon || String(n), title: p.label || `Zwischenstopp ${n}` });
const activeVias = () => state.vias.filter(v => v.lat != null);

function defaultName(r) {
  const from = state.start?.label?.split(',')[0];
  return `${MODE_LABELS[state.mode]} ${Math.round(r.distance / 1000)} km${from ? ' ab ' + from : ''}`;
}

function drawRouteLine() {
  const r = state.route;
  map.setRoute(r?.coords, r?.segments, state.colorRoute ? state.breakdown : null);
}

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
    dot.style.background = it.color;
    const label = document.createElement('span');
    label.textContent = it.label;
    const km = document.createElement('span');
    km.className = 'km';
    km.textContent = formatKm(it.distance);
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${Math.round(it.share * 100)} %`;
    li.append(dot, label, km, pct);
    return li;
  }));

  const hint = $('#breakdown-hint');
  const estimated = estimatedShare(r);
  hint.hidden = state.breakdown !== 'surface' || estimated < 0.01;
  hint.textContent = `${Math.round(estimated * 100)} % des Untergrunds ist in OpenStreetMap nicht explizit erfasst und aus Straßen- bzw. Wegtyp abgeleitet.`;
}

function stopPopup(s) {
  const el = document.createElement('div');
  el.className = 'stop-popup';
  const title = document.createElement('b');
  title.textContent = `${s.icon} ${s.poi.name || s.typeLabel}`;
  const lines = [
    `${s.typeLabel} · km ${(s.along / 1000).toFixed(1)}`,
    `Ankunft ca. ${formatDay(s.eta)} ${formatClock(s.eta)} – ${STATE_LABELS[s.state]}`,
  ];
  const hours = hoursText(s);
  if (hours) lines.push(hours);
  if (s.region) lines.push(regionLabel(s.region, homeCountry()));
  if (s.holiday) lines.push(`🎉 Feiertag: ${s.holiday.name}`);
  el.append(title, ...lines.map(t => { const d = document.createElement('div'); d.textContent = t; return d; }));
  const link = document.createElement('a');
  link.href = `https://www.openstreetmap.org/${s.poi.id}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'In OpenStreetMap ansehen';
  el.append(link);
  return el;
}

const isWarn = s => ['unknown', 'unlikely', 'seasonal', 'closed', 'openHoliday', 'openTypical', 'closedTypical'].includes(s.state);

/** Öffnungszeiten-Zeile: eigene Angabe oder – gekennzeichnet – die typischen Zeiten der Kette. */
function hoursText(s) {
  if (s.poi.tags.opening_hours) return `Öffnungszeiten: ${s.poi.tags.opening_hours}`;
  const t = s.poi.typical;
  if (t) return `Typische Öffnungszeiten ${t.chain} (${t.count} von ${t.total} Filialen in der Umgebung): ${t.hours}`;
  return '';
}

/** Land, in dem die Route beginnt – Regionen dort ohne Länderzusatz anzeigen. */
const homeCountry = () => state.route?.regions?.find(s => s.country)?.country || 'DE';

const formatDate = iso => new Date(iso + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

function renderRegions(r) {
  const regionsEl = $('#route-regions');
  const segs = (r.regions || []).filter(s => s.country);
  const home = homeCountry();
  // Grenzübertritte nur anzeigen, wenn es welche gibt
  regionsEl.hidden = segs.length < 2;
  regionsEl.textContent = segs.length < 2 ? '' : 'Route durch: ' + segs.map((s, i) =>
    `${regionLabel(s, home)}${i ? ` (ab km ${Math.round(s.from / 1000)})` : ''}`).join(' → ');

  const notes = $('#holiday-notes');
  const items = (r.holidays || []).map(h => {
    const li = document.createElement('li');
    const where = h.national && new Set(h.regions.map(s => s.country)).size === 1
      ? h.regions[0].countryName
      : h.regions.map(s => regionLabel(s, home)).join(', ');
    li.textContent = `🎉 ${formatDate(h.date)}: ${h.name} – Feiertag in ${where}. Läden haben meist geschlossen; Trinkwasser und Tankstellen werden bevorzugt.`;
    return li;
  });
  if (r.holidayCheck === false) {
    const li = document.createElement('li');
    li.textContent = 'Feiertage konnten nicht geprüft werden (Regionen bzw. Feiertagsdaten nicht erreichbar).';
    items.push(li);
  }
  notes.replaceChildren(...items);
  notes.hidden = !items.length;
}

/** Hinweis unter der Abfahrtszeit, wenn am Startort an diesem Tag ein Feiertag ist. */
let hintRequest = 0;
async function updateDepartureHint() {
  const el = $('#departure-hint');
  const id = ++hintRequest;
  const date = new Date(state.supply.departure);
  if (!state.supply.enabled || !state.start || isNaN(date)) { el.hidden = true; return; }
  try {
    const region = await regionAt(state.start);
    const h = await holidayAt(region, date);
    if (id !== hintRequest) return;
    el.hidden = !h;
    if (h) el.textContent = `🎉 ${formatDate(h.date)} ist ${h.name} – Feiertag in ${h.national ? region.countryName : regionLabel(region, region.country)}. Läden haben meist geschlossen.`;
  } catch (e) {
    console.warn(e);
    if (id === hintRequest) el.hidden = true;
  }
}

function renderStops() {
  const r = state.route;
  const stops = r?.stops || [];
  map.setStops(stops.map(s => ({
    id: s.poi.id, lat: s.poi.lat, lon: s.poi.lon, icon: s.icon, warn: isWarn(s), popup: stopPopup(s),
  })));

  const box = $('#stops');
  box.hidden = !r || !r.stops;
  if (box.hidden) return;
  renderRegions(r);

  $('#stop-list').replaceChildren(...stops.map(s => {
    const li = document.createElement('li');
    li.title = hoursText(s) || '';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = s.icon;
    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.poi.name || s.typeLabel;
    const detail = document.createElement('small');
    detail.textContent = `${s.poi.name ? s.typeLabel + ' · ' : ''}${STATE_LABELS[s.state]}${s.holiday ? ` · 🎉 ${s.holiday.name}` : ''}`;
    if (isWarn(s)) detail.className = 'warn';
    main.append(name, detail);
    const when = document.createElement('div');
    when.className = 'when';
    when.innerHTML = '<b></b><small></small>';
    when.firstChild.textContent = formatKm(s.along);
    when.lastChild.textContent = `ca. ${formatClock(s.eta)}`;
    li.append(ico, main, when);
    li.addEventListener('click', () => map.openStop(s.poi.id));
    return li;
  }));

  const gaps = $('#stop-gaps');
  const messages = [];
  if (!stops.length && !r.gaps.length) messages.push(`Die Route ist kürzer als ${state.supply.intervalKm} km – kein Stopp nötig.`);
  for (const g of r.gaps) {
    messages.push(`Zwischen km ${Math.round(g.from / 1000)} und ${Math.round(g.to / 1000)} wurde keine passende, geöffnete Verpflegungsstelle gefunden.`);
  }
  if (stops.length) messages.push(`Ankunftszeiten inkl. ${DWELL_MIN} min Pause je Stopp.`);
  gaps.hidden = !messages.length;
  gaps.className = 'hint' + (r.gaps.length ? ' warn' : '');
  gaps.textContent = messages.join(' ');
}

function showRoute(r, { fit = true } = {}) {
  state.route = r;
  drawRouteLine();
  updateMarkers();
  renderStops();
  refreshAlong();
  elevation.show(r, state.breakdown);
  renderBreakdown();
  relayout();

  $('#stat-dist').textContent = formatKm(r.distance);
  $('#stat-up').textContent = formatM(r.ascent);
  $('#stat-down').textContent = formatM(r.descent);
  $('#stat-time').textContent = formatDuration(estimateTime(r.distance, r.ascent, state.bike));
  $('#stat-time').title = `Ø ${averageSpeed(state.bike)} km/h in der Ebene, Anstiege zusätzlich – einstellbar unter Einstellungen`;
  const ld = longDistanceShare(r);
  const evEl = $('#eurovelo-share');
  // Anzeigen, wenn bevorzugt wurde oder die Route ohnehin nennenswert auf Radfernwegen verläuft
  evEl.hidden = ld == null || (state.eurovelo === 'off' && ld.longDistance / r.distance < 0.05);
  if (ld) {
    const pct = d => Math.round(d / r.distance * 100);
    evEl.textContent = `Auf Radfernwegen (EuroVelo/national): ${formatKm(ld.longDistance)} (${pct(ld.longDistance)} %)`
      + (ld.eurovelo ? `, davon direkt als EuroVelo erfasst: ${pct(ld.eurovelo)} %` : '');
    evEl.title = 'In Deutschland verläuft EuroVelo meist über nationale D-Routen und ist in OpenStreetMap oft nur über diese erfasst – '
      + 'deshalb werden beide zusammen gezählt.';
  }
  // Name einer geöffneten gespeicherten/geteilten Route beibehalten
  ui.routeName.value = state.loadedName ?? defaultName(r);
  renderSaveActions();
  renderStages();
  ui.results.hidden = false;

  if (fit) map.fitRoute(r.coords);
}

function clearRoute() {
  controller?.abort();
  state.route = null;
  state.saved = null;
  state.loadedName = null;
  state.multiDay = false;
  state.stayChoices = [];
  state.staysLoading = false;
  state.staysError = null;
  renderSaveActions();
  renderStages();
  map.setRoute(null);
  renderStops();
  searchAlong(null);
  elevation.hide();
  ui.results.hidden = true;
  setStatus(null);
  updateMarkers();
  relayout();
}

// ---------- Routenberechnung ----------

let controller = null;

async function run(task, { loadingText = 'Route wird berechnet …', fit = true } = {}) {
  controller?.abort();
  const ctrl = controller = new AbortController();
  state.staysLoading = false; // eine abgebrochene Unterkunftssuche darf den Knopf nicht gesperrt lassen
  setStatus(loadingText, 'loading');
  try {
    let r = await task(ctrl.signal);
    if (ctrl.signal.aborted) return;
    setStatus(null);
    showRoute(r, { fit });

    // Mehrtagestour (nur auf Wunsch): Unterkünfte suchen und die Route durch sie führen
    if (state.multiDay && isMultiDayCandidate(r, state.stays.maxKm)) {
      setStatus('Unterkünfte für die Übernachtungen werden gesucht …', 'loading');
      state.staysLoading = true;
      state.staysError = null;
      renderStages();
      try {
        r = await withStays(r, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setStatus(null);
        state.staysLoading = false;
        showRoute(r, { fit: false });
      } catch (e) {
        if (e.name === 'AbortError' || ctrl.signal.aborted) return;
        console.error(e);
        state.staysLoading = false;
        state.staysError = `Unterkünfte konnten nicht gesucht werden: ${e.message}`;
        setStatus(state.staysError, 'error');
        renderStages();
      } finally {
        if (controller === ctrl) state.staysLoading = false;
      }
    }
    if (!state.supply.enabled) return;

    // Route steht schon auf der Karte; Stopps werden nachgeladen und die Route dann durch sie geführt
    setStatus('Verpflegungsstopps werden gesucht … (die Route ist bereits nutzbar)', 'loading');
    try {
      const withStops = await withSupply(r, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setStatus(null);
      showRoute(withStops, { fit: false });
    } catch (e) {
      if (e.name === 'AbortError' || ctrl.signal.aborted) return;
      console.error(e);
      setStatus(e.message, 'error');
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    setStatus(e.message, 'error');
  }
}

/** Abfahrt (Datum/Uhrzeit aus den Verpflegungs-Einstellungen) – auch Start der Mehrtagestour. */
function departureDate() {
  const d = new Date(state.supply.departure || defaultDeparture());
  return isNaN(d) ? new Date() : d;
}

/** Route (ohne Stopps) um Verpflegungsstopps ergänzen. */
function withSupply(base, signal) {
  return addStops(base, {
    provider: provider(), opts: routeOpts(), bike: state.bike, signal,
    interval: state.supply.intervalKm * 1000,
    departure: departureDate(),
  });
}

/** Route ohne Übernachtungen und Stopps um Etappen und Unterkünfte ergänzen. */
async function withStays(origin, signal) {
  const plan = await planStays(origin, {
    maxKm: state.stays.maxKm, budget: state.stays.budget, groups: state.stays.groups,
    endStay: state.stays.endStay && state.mode !== 'loop', // Rundkurs endet zu Hause
    departure: departureDate(), choices: state.stayChoices, hidden: state.hiddenStays, signal,
  });
  state.stayChoices = plan.nights.map(n => n.chosen?.poi.id ?? null);
  return routeThroughStays(origin, plan, { provider: provider(), opts: routeOpts(), signal });
}

/** Grundroute ohne Übernachtungen und Verpflegungsstopps – Ausgangspunkt jeder Neuplanung. */
const originRoute = () => state.route?.origin || state.route?.base || state.route;

/** Übernachtungen und Stopps für die aktuelle Route neu planen, ohne die Route selbst neu zu erzeugen. */
function replanStops() {
  const base = originRoute();
  if (base) run(async () => base, { fit: false, loadingText: 'Wird neu geplant …' });
}

function calcAB() {
  if (!state.start || !state.end) { updateMarkers(); return; }
  run(signal => route(provider(), [state.start, ...activeVias(), state.end], routeOpts(), signal));
}

// ---------- Zwischenstopps ----------

/** Einfügeposition in `points`, an der der Umweg (Luftlinie) am kleinsten ist (nie vor Start/nach Ziel). */
function bestInsertIndex(points, p) {
  let best = 1, bestCost = Infinity;
  for (let i = 1; i < points.length; i++) {
    const cost = haversine(points[i - 1], p) + haversine(p, points[i]) - haversine(points[i - 1], points[i]);
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  return best;
}

/** Zwischenstopp hinzufügen – an der günstigsten Stelle der Route. */
function addVia(point, { label = '', icon = null } = {}) {
  const via = { lat: point.lat, lon: point.lon, label, icon, manual: true };
  if (!label) {
    reverse(via).then(l => { via.label = l; renderVias(); updateMarkers(); });
  }

  if (state.mode === 'ab') {
    state.vias = activeVias();
    if (state.start && state.end) {
      state.vias.splice(bestInsertIndex([state.start, ...state.vias, state.end], via) - 1, 0, via);
    } else {
      state.vias.push(via);
    }
    renderVias();
    calcAB();
    return;
  }

  // Distanz/Rundkurs: in die Wegpunkte der vorhandenen Route einfügen und neu berechnen
  const base = originRoute();
  if (!base || base.waypoints.length < 2) {
    setStatus('Bei diesem Rundkurs (OpenRouteService) lassen sich keine Zwischenstopps einfügen – bitte BRouter wählen.', 'error');
    return;
  }
  const wps = base.waypoints.filter(p => !p.stop && !p.stay);
  wps.splice(bestInsertIndex(wps, via), 0, via);
  run(signal => route(provider(), wps, routeOpts(), signal), { fit: false });
}

function removeVia(i) {
  state.vias.splice(i, 1);
  renderVias();
  calcAB();
}

function renderVias() {
  const list = $('#via-list');
  list.replaceChildren(...state.vias.map((via, i) => {
    const row = document.createElement('div');
    row.className = 'field via-row';
    const label = document.createElement('span');
    label.className = 'label';
    const num = document.createElement('i');
    num.className = 'num';
    num.textContent = via.icon || String(i + 1);
    label.append(num, ' Zwischenstopp');

    const search = document.createElement('div');
    search.className = 'search';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ort, Café, Bäckerei … suchen';
    input.autocomplete = 'off';
    input.value = via.label || '';
    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.title = remove.ariaLabel = 'Zwischenstopp entfernen';
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    remove.addEventListener('click', () => removeVia(i));
    const suggestions = document.createElement('ul');
    suggestions.className = 'suggestions';
    suggestions.hidden = true;
    search.append(input, remove, suggestions);
    row.append(label, search);

    attachSearch(input, {
      getBias: () => (via.lat != null ? via : state.start || map.center()),
      onSelect: place => {
        // Auswahl ersetzt den Stopp und sortiert ihn neu ein
        state.vias.splice(i, 1);
        addVia(place, { label: place.label });
      },
    });
    if (via.lat == null) requestAnimationFrame(() => input.focus());
    return row;
  }));
}

$('#btn-add-via').addEventListener('click', () => {
  if (state.vias.some(v => v.lat == null)) return; // erst den offenen Stopp ausfüllen
  state.vias.push({ lat: null, lon: null, label: '', manual: true });
  renderVias();
});

// ---------- Entlang der Route finden ----------

let alongCategory = null;
let alongController = null;
let alongResults = [];

function renderAlongChips() {
  $('#along-chips').replaceChildren(...Object.entries(PLACE_CATEGORIES).map(([key, c]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${c.icon} ${c.label}`;
    b.setAttribute('aria-pressed', String(key === alongCategory));
    b.addEventListener('click', () => searchAlong(key === alongCategory ? null : key));
    return b;
  }));
}

/** „bei Ankunft ca. 14:20 geöffnet“ – aus den Öffnungszeiten im Cache (sonst unbekannt). */
function openingText(res) {
  const when = `bei Ankunft ca. ${formatClock(res.eta)}`;
  const o = res.opening;
  if (o.state === 'unknown') return { text: `${when} · Öffnungszeiten unbekannt`, warn: false };
  const typical = o.typical ? ` (typisch für ${res.poi.typical.chain})` : '';
  return o.state === 'open'
    ? { text: `${when} geöffnet${typical}`, warn: o.typical }
    : { text: `${when} geschlossen${typical}`, warn: true };
}

function alongPopup(res) {
  const el = document.createElement('div');
  el.className = 'stop-popup';
  const title = document.createElement('b');
  title.textContent = `${PLACE_CATEGORIES[res.category].icon} ${res.name}`;
  const info = document.createElement('div');
  info.textContent = `km ${(res.along / 1000).toFixed(1)} · ${Math.round(res.offset / 50) * 50} m neben der Route`;
  el.append(title);
  if (res.detail) { const d = document.createElement('div'); d.className = 'muted'; d.textContent = res.detail; el.append(d); }
  const opening = document.createElement('div');
  opening.textContent = openingText(res).text;
  el.append(opening);
  if (res.opening.hours) {
    const h = document.createElement('div');
    h.className = 'muted';
    h.textContent = `Öffnungszeiten${res.opening.typical ? ' (typisch)' : ''}: ${res.opening.hours}`;
    el.append(h);
  }
  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = 'Als Zwischenstopp hinzufügen';
  add.addEventListener('click', () => addAlongResult(res));
  el.append(info, add);
  return el;
}

function addAlongResult(res) {
  map.closePopup();
  alongResults = alongResults.filter(r => r.id !== res.id);
  renderAlongResults();
  addVia(res, { label: res.name, icon: PLACE_CATEGORIES[res.category].icon });
}

function renderAlongResults() {
  map.setSearchResults(alongResults.map(r => ({
    id: r.id, lat: r.lat, lon: r.lon, icon: PLACE_CATEGORIES[r.category].icon, popup: alongPopup(r),
  })));
  $('#along-list').replaceChildren(...alongResults.map(r => {
    const li = document.createElement('li');
    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.name;
    const detail = document.createElement('small');
    const op = openingText(r);
    detail.textContent = `${op.text} · ${Math.round(r.offset / 50) * 50} m neben der Route`;
    if (op.warn) detail.className = 'warn';
    main.append(name, detail);
    const km = document.createElement('span');
    km.className = 'km';
    km.textContent = `km ${(r.along / 1000).toFixed(1)}`;
    const add = document.createElement('button');
    add.className = 'add';
    add.textContent = '+';
    add.title = 'Als Zwischenstopp hinzufügen';
    add.addEventListener('click', e => { e.stopPropagation(); addAlongResult(r); });
    li.append(main, km, add);
    li.addEventListener('click', () => map.openSearchResult(r.id));
    return li;
  }));
}

async function searchAlong(category) {
  alongController?.abort();
  alongCategory = category;
  alongResults = [];
  renderAlongChips();
  renderAlongResults();
  const hint = $('#along-hint');
  hint.hidden = !category;
  if (!category || !state.route) return;

  const ctrl = alongController = new AbortController();
  const c = PLACE_CATEGORIES[category];
  hint.textContent = `${c.label} entlang der Route werden gesucht …`;
  try {
    const found = await searchAlongRoute(state.route, category, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    // Bereits übernommene Zwischenstopps nicht erneut anbieten
    const added = state.route.waypoints.filter(p => p.manual);
    // Ankunftszeit (Abfahrt aus den Verpflegungs-Einstellungen) und Öffnungsstatus zu dieser Zeit
    const departure = new Date(state.supply.departure || defaultDeparture());
    const eta = arrivalAt(state.route, isNaN(departure) ? new Date() : departure, state.bike);
    alongResults = found.filter(r => !added.some(p => haversine(p, r) < 50)).map(r => {
      const t = eta(r.along);
      return { ...r, eta: t, opening: r.poi ? openingAt(r.poi, t) : { state: 'unknown', typical: false, hours: '' } };
    });
    hint.textContent = (alongResults.length
      ? `${alongResults.length} × ${c.label} bis 1 km neben der Route – mit „+“ als Zwischenstopp übernehmen.`
      : `Kein ${c.label} bis 1 km neben der Route gefunden.`)
      + (found.partial ? ' Einzelne Abschnitte konnten nicht durchsucht werden – ggf. erneut versuchen.' : '')
      + (found.source === 'photon' ? ' Öffnungszeiten für diesen Abschnitt werden gerade nachgeladen und stehen beim nächsten Mal zur Verfügung.' : '');
    renderAlongResults();
  } catch (e) {
    if (e.name !== 'AbortError') hint.textContent = e.message;
  }
}

renderAlongChips();

/** Nach einer Routenänderung die aktive Suche aktualisieren (km-Angaben, neue Abschnitte). */
const refreshAlong = debounce(() => { if (alongCategory && state.route) searchAlong(alongCategory); }, 500);

function generate() {
  if (!state.start) { setStatus('Bitte zuerst einen Startort wählen.', 'error'); return; }
  const bearing = state.direction === 'random' ? seededRandom(state.seed)() * 360 : Number(state.direction);
  const generator = state.mode === 'loop' ? generateLoop : generateOneWay;
  const target = state.distanceKm * 1000;
  run(signal => generator({
    provider: provider(), start: state.start, distance: target, bearing, seed: state.seed, opts: routeOpts(), signal,
    onProgress: i => setStatus(`Suche passende ${state.mode === 'loop' ? 'Schleife' : 'Strecke'} … (Versuch ${i})`, 'loading'),
  }).then(r => {
    if (state.mode === 'distance') setPoint('end', r.waypoints[r.waypoints.length - 1], { silent: true });
    return r;
  }));
}

/** Neu berechnen, nachdem sich Fahrrad, Verkehr oder Provider geändert haben. */
function recalc() {
  if (!state.route) return;
  if (state.mode === 'ab') calcAB(); else generate();
}

// ---------- Punkte setzen ----------

async function setPoint(which, point, { label, silent = false } = {}) {
  const input = which === 'start' ? ui.startInput : ui.endInput;
  const p = { lat: point.lat, lon: point.lon, label: label || '' };
  state[which] = p;
  if (which === 'start') updateDepartureHint();
  input.value = label || 'Ort wird ermittelt …';
  if (!label) reverse(p).then(l => { if (state[which] === p) { p.label = l; input.value = l; } });
  if (silent) return;

  if (state.mode === 'ab') {
    calcAB();
  } else {
    if (which === 'start' && state.route) clearRoute();
    updateMarkers();
  }
}

function handleMapClick(point) {
  if (state.mode === 'ab') {
    // Start und Ziel stehen → Klick fügt einen Zwischenstopp ein (Ziel lässt sich per Marker verschieben)
    if (state.start && state.end) addVia(point);
    else setPoint(state.start ? 'end' : 'start', point);
  } else {
    setPoint('start', point);
  }
}

function handleMarkerDrag(index, point) {
  // Zwischenstopp ohne berechnete Route (Ziel fehlt noch)
  if (typeof index === 'string' && index.startsWith('via')) {
    const via = activeVias()[Number(index.slice(3))];
    Object.assign(via, point, { label: '' });
    reverse(via).then(l => { via.label = l; renderVias(); });
    renderVias();
    updateMarkers();
    return;
  }
  const r = state.route;
  if (r && r.waypoints.length >= 2) {
    const loop = isLoop(r);
    const wps = r.waypoints.slice();
    const old = wps[index];
    // Verschobener Zwischenstopp bleibt Zwischenstopp, bekommt aber eine neue Bezeichnung
    wps[index] = old?.manual ? { ...old, ...point, label: '', icon: null } : point;
    if (old?.manual) {
      const moved = wps[index];
      reverse(moved).then(l => { moved.label = l; renderVias(); updateMarkers(); });
    }
    if (loop && index === 0) wps[wps.length - 1] = point;
    if (index === 0) setPoint('start', point, { silent: true });
    if (!loop && index === wps.length - 1) setPoint('end', point, { silent: true });
    // Start bleibt dasselbe Objekt am Anfang und Ende, damit der Rundkurs als solcher erkannt wird
    if (loop && index === 0) wps[0] = wps[wps.length - 1] = state.start;
    // Verpflegungsstopps werden für die geänderte Route neu gewählt
    const base = wps.filter(p => !p.stop && !p.stay);
    if (state.mode === 'ab' && !loop) {
      base[0] = state.start;
      base[base.length - 1] = state.end;
      state.vias = base.slice(1, -1);
      renderVias();
    }
    run(signal => route(provider(), base, routeOpts(), signal), { fit: false });
    return;
  }
  // Ohne bearbeitbare Wegpunkte (z. B. ORS-Rundkurs): Start/Ziel versetzen
  if (index === 0) {
    setPoint('start', point, { silent: state.mode !== 'ab' && !!r });
    if (state.mode !== 'ab' && r) generate();
  } else {
    setPoint('end', point);
  }
}

// ---------- Ereignisse ----------

attachSearch(ui.startInput, {
  getBias: () => map.center(),
  onSelect: place => { setPoint('start', place, { label: place.label }); if (state.mode !== 'ab' || !state.end) map.flyTo(place); },
});
attachSearch(ui.endInput, {
  getBias: () => state.start || map.center(),
  onSelect: place => { setPoint('end', place, { label: place.label }); if (!state.start) map.flyTo(place); },
});

$('#bike-switch').addEventListener('click', e => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value || value === state.bike) return;
  state.bike = value;
  storage.set('bike', value);
  syncUi();
  recalc();
});

$('#mode-tabs').addEventListener('click', e => {
  const mode = e.target.closest('button')?.dataset.mode;
  if (!mode || mode === state.mode) return;
  state.mode = mode;
  storage.set('mode', mode);
  syncUi();
  clearRoute();
  if (mode === 'ab') calcAB();
});

$('#traffic').addEventListener('change', e => {
  state.traffic = e.target.value;
  storage.set('traffic', state.traffic);
  recalc();
});

$('#eurovelo').addEventListener('change', e => {
  state.eurovelo = e.target.value;
  storage.set('eurovelo', state.eurovelo);
  recalc();
});

$('#provider').addEventListener('change', e => {
  state.provider = e.target.value;
  storage.set('provider', state.provider);
  syncUi();
  recalc();
});

$('#direction').addEventListener('change', e => { state.direction = e.target.value; });

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
$('#departure').addEventListener('change', e => {
  state.supply.departure = e.target.value || defaultDeparture();
  syncUi();
  updateDepartureHint();
  if (state.supply.enabled) replanStops();
});

function setDistance(km) {
  const v = Math.min(400, Math.max(5, Math.round(Number(km) || state.distanceKm)));
  state.distanceKm = v;
  storage.set('distanceKm', v);
  syncUi();
}
ui.range.addEventListener('input', () => setDistance(ui.range.value));
ui.num.addEventListener('change', () => setDistance(ui.num.value));

$('#btn-generate').addEventListener('click', generate);
$('#btn-reroll').addEventListener('click', () => { state.seed = newSeed(); generate(); });

$('#btn-swap').addEventListener('click', () => {
  [state.start, state.end] = [state.end, state.start];
  state.vias.reverse();
  renderVias();
  updateDepartureHint();
  ui.startInput.value = state.start?.label || '';
  ui.endInput.value = state.end?.label || '';
  calcAB();
});

$('#btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Standortbestimmung wird vom Browser nicht unterstützt.', 'error'); return; }
  setStatus('Standort wird ermittelt …', 'loading');
  navigator.geolocation.getCurrentPosition(
    pos => {
      setStatus(null);
      const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setPoint('start', p);
      map.flyTo(p);
    },
    () => setStatus('Standort konnte nicht ermittelt werden.', 'error'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// ---------- GPX: teilen (Smartphone, z. B. an Komoot) oder herunterladen ----------

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS meldet sich als Mac
// Teilen nur auf Smartphones/Tablets als Hauptfunktion – am Desktop will man die Datei speichern
const shareSupported = isMobile && canShareGpx();
const gpxName = () => ui.routeName.value.trim() || defaultName(state.route);

function setupGpxButton() {
  const btn = $('#btn-gpx');
  const hint = $('#gpx-hint');
  if (shareSupported) {
    btn.textContent = 'GPX teilen';
    btn.title = 'Über das Teilen-Menü an eine App senden, z. B. Komoot';
    // Alternative: Datei speichern
    hint.hidden = false;
    hint.replaceChildren('An eine Navigations-App senden (z. B. Komoot) oder ');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'link-btn inline';
    save.textContent = 'als Datei speichern';
    save.addEventListener('click', () => state.route && downloadGpx(state.route, gpxName()));
    hint.append(save, '.');
  } else if (isMobile) {
    // z. B. Chrome auf Android (erlaubt kein GPX beim Teilen) oder Aufruf ohne HTTPS
    hint.hidden = false;
    hint.textContent = window.isSecureContext
      ? 'Die Datei wird heruntergeladen. Zum Navigieren in der Download-Benachrichtigung bzw. im Download-Ordner öffnen und eine App wie Komoot wählen.'
      : 'Die Datei wird heruntergeladen. Direktes Teilen an Apps (z. B. Komoot) ist nur möglich, wenn CycloRouter über HTTPS aufgerufen wird.';
  }
}

$('#btn-gpx').addEventListener('click', async () => {
  if (!state.route) return;
  if (!shareSupported) { downloadGpx(state.route, gpxName()); return; }
  try {
    await shareGpx(state.route, gpxName());
  } catch (e) {
    console.warn('Teilen nicht möglich, lade herunter:', e);
    downloadGpx(state.route, gpxName());
  }
});

setupGpxButton();

// ---------- Mehrtagestouren ----------
// Nur auf Knopfdruck: Ist die Route deutlich länger als die Tagesetappe, bietet „Als Mehrtagestour planen“
// die Aufteilung an. Dann werden je Nacht Unterkünfte vorgeschlagen und die Route durch die gewählten geführt.

const fmtDayDate = d => d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const FIT_LABEL = { ok: 'im Budget', maybe: 'evtl. im Budget', over: 'über Budget' };

function stayPopup(night) {
  const { poi, price, fit, offset } = night.chosen;
  const el = document.createElement('div');
  el.className = 'stop-popup';
  const title = document.createElement('b');
  title.textContent = `${STAY_TYPES[poi.type].icon} ${poi.name || STAY_TYPES[poi.type].label}`;
  const lines = [
    `${night.end ? 'Übernachtung am Ziel' : `Nacht ${night.index + 1}`} · ${fmtDayDate(night.date)}`,
    `${STAY_TYPES[poi.type].label}${poi.tags.stars ? ` · ${poi.tags.stars}★` : ''} · ${(offset / 1000).toFixed(1)} km neben der Route`,
    `${priceLabel(price)} – ${FIT_LABEL[fit]}`,
  ];
  el.append(title, ...lines.map(t => { const d = document.createElement('div'); d.textContent = t; return d; }));
  el.append(stayLinks(night));
  return el;
}

function stayLinks(night) {
  const box = document.createElement('div');
  box.className = 'links';
  const link = (text, href) => {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
    box.append(a);
  };
  link('Preis prüfen', priceLink(night.chosen.poi, night));
  const web = websiteOf(night.chosen.poi);
  if (web && /^https?:\/\//i.test(web)) link('Webseite', web);
  // Fehler in OpenStreetMap melden: Hinweis („Note“) an der Stelle anlegen – Mapper vor Ort korrigieren ihn
  const { lat, lon } = night.chosen.poi;
  link('Fehler melden', `https://www.openstreetmap.org/note/new?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}#map=18/${lat.toFixed(5)}/${lon.toFixed(5)}`);
  return box;
}

/** Unterkunft nie wieder vorschlagen (z. B. existiert nicht, keine Übernachtung möglich) – wird mit dem Konto abgeglichen. */
function hideStay(night) {
  const poi = night.chosen.poi;
  state.hiddenStays = [...new Set([...state.hiddenStays, poi.id])];
  storage.set('hiddenStays', state.hiddenStays);
  delete state.stayChoices[night.index]; // nächstbeste Unterkunft für diese Nacht wählen
  flashStatus(`„${poi.name || STAY_TYPES[poi.type].label}“ wird nicht mehr vorgeschlagen.`);
  replanStops();
}

function optionLabel(o) {
  const t = STAY_TYPES[o.poi.type];
  const name = o.poi.name || t.label;
  return `${t.icon} ${name}${o.poi.tags.stars ? ` ${o.poi.tags.stars}★` : ''} · ${priceLabel(o.price)} · ${(o.offset / 1000).toFixed(1)} km`
    + `${o.fit === 'over' ? ' · über Budget' : ''}${o.open === 'season' ? ' · Saison prüfen' : ''}${o.stale ? ' · evtl. veraltet' : ''}`;
}

function renderStages() {
  const box = $('#stages');
  const r = state.route;
  const origin = originRoute();
  const candidate = !!origin && isMultiDayCandidate(origin, state.stays.maxKm);
  box.hidden = !r || (!candidate && !state.multiDay);
  const plan = r?.stays;
  map.setStays(plan ? plan.nights.filter(n => n.chosen).map(n => ({
    id: n.chosen.poi.id, lat: n.chosen.poi.lat, lon: n.chosen.poi.lon, icon: STAY_TYPES[n.chosen.poi.type].icon, popup: stayPopup(n),
  })) : []);
  if (box.hidden) return;

  const days = Math.max(2, Math.ceil(origin.distance / (state.stays.maxKm * 1000)));
  const btn = $('#btn-multiday');
  btn.disabled = !!state.staysLoading;
  btn.textContent = state.staysLoading
    ? `Unterkünfte für ${days - 1}+ Nächte werden gesucht …`
    : state.multiDay
      ? 'Mehrtagestour aufheben'
      : `Als Mehrtagestour planen (${days} Tage à ca. ${Math.round(origin.distance / days / 1000)} km)`;
  btn.className = state.multiDay && !state.staysLoading ? '' : 'primary';
  // Fehler direkt am Knopf anzeigen (die Statuszeile oben ist auf dem Handy oft nicht im Blick)
  const err = $('#stages-error');
  err.hidden = !state.staysError || state.staysLoading;
  err.textContent = state.staysError || '';
  $('#stages-body').hidden = !state.multiDay || !plan;
  if (!plan) return;

  $('#stage-departure').value = state.supply.departure;
  const stats = stageStats(r, state.bike);
  const chosen = plan.nights.filter(n => n.chosen);
  const sum = k => chosen.reduce((s, n) => s + n.chosen.price[k], 0);
  const missing = plan.nights.length - chosen.length;
  $('#stages-summary').textContent = `${stats.length} Tage · ${plan.nights.length} ${plan.nights.length === 1 ? 'Nacht' : 'Nächte'}`
    + (chosen.length ? ` · Übernachtungen geschätzt ${sum('min')}–${sum('max')} €` : '')
    + (missing ? ` · für ${missing} ${missing === 1 ? 'Nacht' : 'Nächte'} keine passende Unterkunft gefunden` : '');

  const start = departureDate();
  $('#stage-list').replaceChildren(...stats.map((s, i) => {
    const li = document.createElement('li');
    const day = document.createElement('div');
    day.className = 'day';
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    day.innerHTML = '<span></span><small></small>';
    day.firstChild.textContent = `Tag ${s.day} · ${fmtDayDate(date)}`;
    day.lastChild.textContent = `${formatKm(s.distance)} · ${formatM(s.ascent)} ↑ · ca. ${formatDuration(s.time)}`;
    li.append(day);
    // Nacht nach diesem Tag (bzw. am Ziel nach dem letzten Tag)
    const night = plan.nights[i];
    if (night) li.append(renderNight(night));
    return li;
  }));
}

function renderNight(night) {
  const box = document.createElement('div');
  box.className = 'night';
  const label = document.createElement('span');
  label.className = 'meta';
  label.textContent = night.end ? 'Übernachtung am Ziel' : `Übernachtung nach Tag ${night.index + 1}`;
  box.append(label);
  if (!night.options.length) {
    const none = document.createElement('span');
    none.className = 'meta over';
    none.textContent = 'Keine passende Unterkunft bis 3 km neben der Route – km pro Tag oder Unterkunftsarten anpassen.';
    box.append(none);
    return box;
  }
  const select = document.createElement('select');
  select.ariaLabel = label.textContent;
  for (const o of night.options) {
    const opt = document.createElement('option');
    opt.value = o.poi.id;
    opt.textContent = optionLabel(o);
    opt.selected = o === night.chosen;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    state.stayChoices[night.index] = select.value;
    replanStops(); // Route durch die neue Unterkunft führen, Stopps neu planen
  });
  const meta = document.createElement('span');
  const c = night.chosen;
  meta.className = 'meta' + (c.fit === 'over' || c.open === 'season' || c.stale ? ' over' : '');
  const year = lastConfirmed(c.poi);
  meta.textContent = `${STAY_TYPES[c.poi.type].label} · ${priceLabel(c.price)} – ${FIT_LABEL[c.fit]} (Budget ${state.stays.budget} €)`
    + (AVAILABILITY_LABEL[c.open] ? ` · ${AVAILABILITY_LABEL[c.open]}` : '')
    + (c.stale ? ` · Angaben von ${year} – evtl. veraltet, vorher prüfen` : '');
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'link-btn inline';
  show.textContent = 'Auf der Karte zeigen';
  show.addEventListener('click', () => map.openStay(night.chosen.poi.id));
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'link-btn inline';
  hide.textContent = 'Ausblenden';
  hide.title = 'Diese Unterkunft nicht mehr vorschlagen (z. B. existiert nicht oder bietet keine Übernachtung)';
  hide.addEventListener('click', () => hideStay(night));
  const links = stayLinks(night);
  links.prepend(show);
  links.append(hide);
  box.append(select, meta, links);
  return box;
}

$('#btn-multiday').addEventListener('click', () => {
  state.multiDay = !state.multiDay;
  state.staysError = null;
  if (!state.multiDay) state.stayChoices = [];
  renderStages(); // sofortige Rückmeldung am Knopf
  replanStops();
});
$('#stage-departure').addEventListener('change', e => {
  // gleiche Abfahrt wie bei den Verpflegungsstopps – bestimmt Datum der Nächte und Öffnungszeiten
  state.supply.departure = e.target.value || defaultDeparture();
  syncUi();
  updateDepartureHint();
  replanStops();
});

// Einstellungen (Zahnrad): km pro Tag, Budget, Unterkunftsarten, Übernachtung am Ziel
$('#stay-types').replaceChildren(...Object.entries(STAY_GROUPS).map(([key, g]) => {
  const label = document.createElement('label');
  label.className = 'check';
  label.innerHTML = `<input type="checkbox" value="${key}"> `;
  label.append(g.label);
  return label;
}));

function renderStaySettings() {
  $('#stage-max').value = state.stays.maxKm;
  $('#night-budget').value = state.stays.budget;
  $('#end-stay').checked = state.stays.endStay;
  for (const cb of document.querySelectorAll('#stay-types input')) cb.checked = state.stays.groups.includes(cb.value);
}

/** Werte aus dem Dialog übernehmen → true, wenn sich etwas geändert hat. */
function saveStaySettings() {
  const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);
  const next = {
    maxKm: clamp(Number($('#stage-max').value), 30, 300, state.stays.maxKm),
    budget: clamp(Number($('#night-budget').value), 10, 500, state.stays.budget),
    groups: [...document.querySelectorAll('#stay-types input:checked')].map(cb => cb.value),
    endStay: $('#end-stay').checked,
  };
  if (!next.groups.length) next.groups = state.stays.groups; // mindestens eine Art
  const changed = JSON.stringify(next) !== JSON.stringify(state.stays);
  state.stays = next;
  storage.set('stageMaxKm', next.maxKm);
  storage.set('nightBudget', next.budget);
  storage.set('stayTypes', next.groups);
  storage.set('endStay', next.endStay);
  return changed;
}

// ---------- Gespeicherte Routen und Teilen-Links (Konto) ----------
// state.saved: die geöffnete eigene gespeicherte Route {id, name, shareToken} – „Speichern“ aktualisiert sie.
// state.loadedName: Name einer geöffneten gespeicherten oder geteilten Route (bleibt bei Neuberechnung erhalten).

const round5 = v => Math.round(v * 1e5) / 1e5;
const pointLabel = p => p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

/**
 * Aktuelle Route für die Datenbank – ohne Verpflegungsstopps und Übernachtungen (die werden beim Öffnen
 * neu geplant; die gewählten Unterkünfte werden über `stayChoices` wieder übernommen).
 */
function serializeRoute(name) {
  const r = originRoute();
  const wp = p => ({
    lat: round5(p.lat), lon: round5(p.lon),
    ...(p.label && { label: p.label }), ...(p.manual && { manual: true }), ...(p.icon && { icon: p.icon }),
  });
  return {
    name, mode: state.mode, bike: state.bike, distance: Math.round(r.distance), ascent: Math.round(r.ascent),
    data: {
      v: 1, traffic: state.traffic, eurovelo: state.eurovelo, provider: state.provider,
      coords: r.coords.map(([lat, lon, ele]) => [round5(lat), round5(lon), ele == null ? null : Math.round(ele * 10) / 10]),
      segments: r.segments || [],
      waypoints: r.waypoints.filter(p => !p.stop && !p.stay).map(wp),
      ...(state.multiDay && { multiDay: true, stayChoices: state.stayChoices }),
    },
  };
}

/** Gespeicherte oder geteilte Route öffnen – exakt wie gespeichert, ohne Neuberechnung. */
function restoreRoute(saved, { own }) {
  const d = saved.data;
  controller?.abort();
  searchAlong(null);
  state.mode = saved.mode;
  state.bike = saved.bike;
  if (d.traffic) state.traffic = d.traffic;
  if (d.eurovelo) state.eurovelo = d.eurovelo;
  if (d.provider && providers[d.provider]) state.provider = d.provider;
  for (const k of ['mode', 'bike', 'traffic', 'eurovelo', 'provider']) storage.set(k, state[k]);

  const wps = d.waypoints.map(p => ({ ...p }));
  const last = wps.length - 1;
  // Rundkurs: Start und Ende müssen dasselbe Objekt sein, sonst wird er nicht als Rundkurs erkannt
  if (saved.mode === 'loop' && last > 1 && wps[0].lat === wps[last].lat && wps[0].lon === wps[last].lon) wps[last] = wps[0];
  state.start = wps[0];
  state.end = saved.mode !== 'loop' && last > 0 ? wps[last] : null;
  state.vias = saved.mode === 'ab' ? wps.slice(1, -1).filter(p => p.manual) : [];
  ui.startInput.value = pointLabel(state.start);
  ui.endInput.value = state.end ? pointLabel(state.end) : '';
  for (const [p, input] of [[state.start, ui.startInput], [state.end, ui.endInput]]) {
    if (p && !p.label) reverse(p).then(l => { p.label = l; input.value = l; });
  }

  state.saved = own ? { id: saved.id, name: saved.name, shareToken: saved.shareToken || null } : null;
  state.loadedName = saved.name;
  syncUi();
  renderVias();
  updateDepartureHint();
  state.multiDay = !!d.multiDay;
  state.stayChoices = d.stayChoices || [];
  const r = withStats({ coords: d.coords, segments: d.segments }, wps);
  showRoute(r);
  // Übernachtungen (mit den gespeicherten Unterkünften) und Stopps auf die gespeicherte Route aufsetzen
  if (state.multiDay || state.supply.enabled) run(async () => r, { fit: false, loadingText: 'Wird geplant …' });
  renderMyRoutes();
}

async function saveCurrentRoute({ asNew = false } = {}) {
  if (!state.route || !account.user) return null;
  const name = ui.routeName.value.trim() || defaultName(state.route);
  const payload = serializeRoute(name);
  try {
    if (state.saved && !asNew) {
      await updateRoute(state.saved.id, payload);
      state.saved.name = name;
      flashStatus(`„${name}“ aktualisiert.`);
    } else {
      const { id } = await createRoute(payload);
      state.saved = { id, name, shareToken: null };
      flashStatus(`„${name}“ gespeichert – auf allen deinen Geräten unter „Meine Routen“.`);
    }
    state.loadedName = name;
    renderSaveActions();
    refreshMyRoutes();
    return state.saved;
  } catch (e) {
    setStatus(e.message, 'error');
    return null;
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Teilen-Link erzeugen (speichert vorher den aktuellen Stand) und weitergeben bzw. kopieren. */
async function shareCurrentRoute() {
  const saved = await saveCurrentRoute();
  if (!saved) return;
  try {
    saved.shareToken = await shareRoute(saved.id);
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  const url = shareUrl(saved.shareToken);
  renderSaveActions();
  refreshMyRoutes();
  if (isMobile && navigator.share) {
    try { await navigator.share({ title: saved.name, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  flashStatus(await copyText(url) ? 'Link kopiert – wer ihn öffnet, sieht die Route (auch ohne Konto).' : 'Link erstellt – siehe unten.');
}

function renderSaveActions() {
  const loggedIn = account.enabled && !!account.user;
  const show = loggedIn && !!state.route;
  $('#save-actions').hidden = !show;
  $('#btn-save-route').textContent = state.saved ? 'Änderungen speichern' : 'Route speichern';

  const hint = $('#save-hint');
  hint.replaceChildren();
  hint.hidden = true;
  if (!state.route || !account.enabled) return;
  if (!loggedIn) {
    hint.hidden = false;
    hint.textContent = 'Zum Speichern und Teilen unter Einstellungen (Zahnrad) anmelden.';
    return;
  }
  if (!state.saved) return;
  hint.hidden = false;
  if (state.saved.shareToken) {
    const link = document.createElement('a');
    link.href = shareUrl(state.saved.shareToken);
    link.textContent = 'Teilen-Link';
    link.target = '_blank';
    link.rel = 'noopener';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'link-btn inline';
    revoke.textContent = 'zurückziehen';
    revoke.addEventListener('click', async () => {
      try {
        await unshareRoute(state.saved.id);
        state.saved.shareToken = null;
        flashStatus('Teilen-Link zurückgezogen – er funktioniert nicht mehr.');
        renderSaveActions();
        refreshMyRoutes();
      } catch (e) { setStatus(e.message, 'error'); }
    });
    hint.append(link, ' aktiv (', revoke, ') · ');
  }
  const asNew = document.createElement('button');
  asNew.type = 'button';
  asNew.className = 'link-btn inline';
  asNew.textContent = 'als neue Route speichern';
  asNew.addEventListener('click', () => saveCurrentRoute({ asNew: true }));
  hint.append(asNew);
}

$('#btn-save-route').addEventListener('click', () => saveCurrentRoute());
$('#btn-share-link').addEventListener('click', shareCurrentRoute);

// ---------- Meine Routen ----------

let myRoutes = [];
const fmtDate = s => new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

async function refreshMyRoutes() {
  const box = $('#my-routes');
  box.hidden = !(account.enabled && account.user);
  if (box.hidden) return;
  try {
    myRoutes = await listRoutes();
  } catch (e) {
    if (e.status === 401) { account.user = null; renderAccount(); renderSaveActions(); box.hidden = true; }
    return;
  }
  renderMyRoutes();
}

function renderMyRoutes() {
  $('#my-routes-count').textContent = myRoutes.length ? `(${myRoutes.length})` : '';
  $('#my-routes-empty').hidden = myRoutes.length > 0;
  $('#my-routes-list').replaceChildren(...myRoutes.map(r => {
    const li = document.createElement('li');
    if (state.saved?.id === r.id) li.className = 'current';
    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.name;
    const meta = document.createElement('small');
    meta.textContent = [formatKm(r.distance), `${formatM(r.ascent)} ↑`, MODE_LABELS[r.mode], fmtDate(r.updatedAt)]
      .join(' · ') + (r.shared ? ' · 🔗 geteilt' : '');
    main.append(name, meta);
    const tools = document.createElement('div');
    tools.className = 'tools';
    const tool = (icon, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = icon;
      b.title = b.ariaLabel = title;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      tools.append(b);
    };
    tool('✏️', 'Umbenennen', () => renameSaved(r));
    tool('🗑️', 'Löschen', () => deleteSaved(r));
    li.append(main, tools);
    li.addEventListener('click', () => openSaved(r.id));
    return li;
  }));
}

async function openSaved(id) {
  setStatus('Route wird geladen …', 'loading');
  try {
    const r = await getRoute(id);
    setStatus(null);
    restoreRoute(r, { own: true });
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

/**
 * Rückfrage im App-Stil (statt confirm()/prompt()). Mit `input` (Vorgabewert) als Eingabe → Text oder null;
 * sonst → true/null.
 */
function ask({ title, text = '', input = null, ok = 'OK', danger = false }) {
  const dlg = $('#ask-dialog');
  const field = $('#ask-input');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-text').hidden = !text;
  field.hidden = input == null;
  field.value = input ?? '';
  $('#ask-ok').textContent = ok;
  $('#ask-ok').className = danger ? 'danger' : 'primary';
  dlg.returnValue = '';
  dlg.showModal();
  if (input != null) { field.focus(); field.select(); }
  return new Promise(resolve => dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') resolve(null);
    else resolve(input != null ? field.value : true);
  }, { once: true }));
}

async function renameSaved(r) {
  const name = (await ask({ title: 'Route umbenennen', input: r.name, ok: 'Umbenennen' }))?.trim();
  if (!name || name === r.name) return;
  try {
    await updateRoute(r.id, { name });
    if (state.saved?.id === r.id) {
      state.saved.name = state.loadedName = ui.routeName.value = name;
    }
    refreshMyRoutes();
  } catch (e) { setStatus(e.message, 'error'); }
}

async function deleteSaved(r) {
  const sure = await ask({
    title: `„${r.name}“ löschen?`,
    text: r.shared ? 'Der Teilen-Link funktioniert danach nicht mehr.' : 'Das lässt sich nicht rückgängig machen.',
    ok: 'Löschen', danger: true,
  });
  if (!sure) return;
  try {
    await deleteRoute(r.id);
    if (state.saved?.id === r.id) { state.saved = null; renderSaveActions(); }
    refreshMyRoutes();
  } catch (e) { setStatus(e.message, 'error'); }
}

// ---------- Konto (im Einstellungsdialog) ----------

function renderAccount(message = '', isError = false) {
  $('#account-box').hidden = !account.enabled;
  const loggedIn = !!account.user;
  $('#account-out').hidden = loggedIn;
  $('#account-in').hidden = !loggedIn;
  $('#btn-delete-account').hidden = !loggedIn;
  $('#account-delete').hidden = true;
  if (loggedIn) $('#account-name').textContent = account.user.username;
  const msg = $('#account-msg');
  msg.textContent = message;
  msg.hidden = !message;
  msg.classList.toggle('error', isError);
}

async function authenticate(kind) {
  const username = $('#account-user').value.trim();
  const password = $('#account-pass').value;
  renderAccount(kind === 'login' ? 'Anmeldung …' : 'Konto wird angelegt …');
  try {
    await (kind === 'login' ? login : register)(username, password);
  } catch (e) {
    renderAccount(e.message, true);
    return;
  }
  $('#account-pass').value = '';
  renderAccount(kind === 'login' ? 'Angemeldet.' : 'Konto angelegt – deine Einstellungen werden ab jetzt abgeglichen.');
  renderSaveActions();
  // Neues Konto: lokale Einstellungen hochladen; Anmeldung: Stand vom Konto übernehmen
  await syncSettings({ preferLocal: kind === 'register' });
  refreshMyRoutes();
}

$('#btn-login').addEventListener('click', () => authenticate('login'));
$('#btn-register').addEventListener('click', () => authenticate('register'));
// Enter im Passwortfeld meldet an (statt den Einstellungsdialog abzuschicken)
for (const id of ['#account-user', '#account-pass']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); authenticate('login'); } });
}
$('#btn-logout').addEventListener('click', async () => {
  try { await logout(); } catch { account.user = null; }
  state.saved = null;
  myRoutes = [];
  renderAccount('Abgemeldet. Die Einstellungen bleiben auf diesem Gerät erhalten.');
  renderSaveActions();
  refreshMyRoutes();
});
$('#btn-delete-account').addEventListener('click', () => {
  $('#account-delete').hidden = false;
  $('#btn-delete-account').hidden = true;
  $('#account-delete-pass').focus();
});
$('#btn-delete-cancel').addEventListener('click', () => renderAccount());
$('#account-delete-pass').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
$('#btn-delete-confirm').addEventListener('click', async () => {
  try {
    await deleteAccount($('#account-delete-pass').value);
  } catch (e) {
    renderAccount(e.message, true);
    $('#account-delete').hidden = false;
    $('#btn-delete-account').hidden = true;
    return;
  }
  $('#account-delete-pass').value = '';
  state.saved = null;
  myRoutes = [];
  renderAccount('Konto und alle gespeicherten Routen wurden gelöscht.');
  renderSaveActions();
  refreshMyRoutes();
});

// ---------- Einstellungen zwischen Geräten abgleichen ----------
// Jede geänderte Einstellung (SYNC_KEYS) wird kurz danach ans Konto geschickt. Beim Öffnen der App und
// beim Anmelden gilt der Stand des Kontos; weicht er ab, wird er übernommen und die App einmal neu geladen
// (sie liest ihre Einstellungen beim Start).

let applyingRemote = false;
const localSyncSettings = () =>
  Object.fromEntries(SYNC_KEYS.map(k => [k, storage.get(k, null)]).filter(([, v]) => v !== null));
const pushLocalSettings = debounce(() => {
  if (account.user) pushSettings(localSyncSettings()).catch(() => {});
}, 1500);
onStorageSet(key => { if (!applyingRemote && SYNC_KEYS.includes(key)) pushLocalSettings(); });

async function syncSettings({ preferLocal = false } = {}) {
  if (!account.user) return;
  const remote = (await fetchSettings().catch(() => null))?.data;
  if (!remote || preferLocal) {
    await pushSettings(localSyncSettings()).catch(() => {});
    return;
  }
  const local = localSyncSettings();
  const changed = Object.keys(remote).filter(k => SYNC_KEYS.includes(k) && JSON.stringify(remote[k]) !== JSON.stringify(local[k] ?? null));
  if (!changed.length) {
    if (Object.keys(local).some(k => !(k in remote))) pushLocalSettings(); // neue lokale Einstellungen ergänzen
    return;
  }
  applyingRemote = true;
  for (const k of changed) storage.set(k, remote[k]);
  applyingRemote = false;
  const marker = JSON.stringify(remote);
  if (sessionStorage.getItem('cyclerouter.settingsApplied') !== marker) {
    sessionStorage.setItem('cyclerouter.settingsApplied', marker);
    location.reload();
  }
}

$('#btn-clear').addEventListener('click', () => {
  if (state.mode === 'ab') { state.end = null; ui.endInput.value = ''; state.vias = []; renderVias(); }
  clearRoute();
});

// ---------- Heimatadresse ----------

const homeInput = $('#home-input');
let pendingHome = null; // Auswahl im Einstellungsdialog, wird erst beim Speichern übernommen

const getHome = () => storage.get('home', null);
const syncHomeButton = () => { $('#btn-home').hidden = !getHome(); };

function useHomeAsStart() {
  const home = getHome();
  if (!home) return;
  setPoint('start', home, { label: home.label });
  if (state.mode !== 'ab' || !state.end) map.flyTo(home);
}

$('#btn-home').addEventListener('click', useHomeAsStart);

attachSearch(homeInput, {
  getBias: () => state.start || map.center(),
  onSelect: place => { pendingHome = { lat: place.lat, lon: place.lon, label: place.label }; },
});
$('#btn-home-from-start').addEventListener('click', () => {
  if (!state.start) return;
  pendingHome = { ...state.start };
  homeInput.value = state.start.label;
});
$('#btn-home-clear').addEventListener('click', () => {
  pendingHome = null;
  homeInput.value = '';
  homeInput.focus();
});

// ---------- Vorrat für die Heimatregion (Server) ----------
// Der Server (server.mjs) lädt Verpflegungsstellen im Umkreis von 200 km um den Heimatort in seinen
// gemeinsamen Cache. Übermittelt werden nur auf ~10 km gerundete Koordinaten – nie die Adresse.

const WARM_API = new URL('api/warm', document.baseURI);
const WARM_RESEND = 7 * 24 * 3600 * 1000;
const round1 = v => Math.round(v * 10) / 10;
const fmtInt = n => n.toLocaleString('de-DE');

/** Ruft /api/warm auf; null, wenn kein Server-Cache verfügbar ist (statisches Hosting). */
async function warmApi(method, home) {
  const lat = round1(home.lat), lon = round1(home.lon);
  try {
    const res = method === 'GET'
      ? await fetch(`${WARM_API}?lat=${lat}&lon=${lon}`)
      : await fetch(WARM_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lon }) });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

function warmMessage(d) {
  const have = `${fmtInt(d.total - d.missing)} von ${fmtInt(d.total)} Kacheln vorhanden`;
  const region = `Verpflegungsstellen im Umkreis von ${d.radiusKm} km um die Heimat`;
  if (!d.missing || d.status === 'complete') return `${region} sind auf dem Server vorrätig (${fmtInt(d.total)} Kacheln).`;
  if (d.status === 'rate-limited') return `Vorladen der Heimatregion wurde heute schon zu oft angefordert – bitte morgen erneut speichern (${have}).`;
  if (d.status === 'full') return `Der Server lädt gerade viele Regionen vor – bitte später erneut speichern (${have}).`;
  if (d.queued) {
    const where = d.position > 1 ? `warten in der Warteschlange (Platz ${d.position})` : 'werden gerade im Hintergrund geladen';
    return `${region} ${where} – ${have}.`;
  }
  return `${region}: ${have}.`;
}

/** Heimatregion beim Server vormerken – höchstens einmal pro Woche, außer bei neuer Heimat. */
async function sendHomeToServer(home, { force = false } = {}) {
  const key = `${round1(home.lat)},${round1(home.lon)}`;
  const last = storage.get('homeWarm', null);
  if (!force && last?.key === key && Date.now() - last.t < WARM_RESEND) return null;
  const data = await warmApi('POST', home);
  if (data) storage.set('homeWarm', { key, t: Date.now() });
  return data;
}

async function showWarmStatus() {
  const el = $('#home-warm-hint');
  const home = getHome();
  el.hidden = true;
  if (!home) return;
  const data = await warmApi('GET', home);
  if (!data || getHome()?.label !== home.label) return; // Dialog inzwischen mit anderer Heimat gespeichert
  el.textContent = warmMessage(data);
  el.hidden = false;
}

/** Kurzer Hinweis in der Statuszeile, der nach einigen Sekunden verschwindet (wenn nichts anderes läuft). */
function flashStatus(text) {
  setStatus(text);
  setTimeout(() => { if (ui.status.textContent === text) setStatus(null); }, 10000);
}

// ---------- Durchschnittsgeschwindigkeit ----------
// Gespeichert als km/h oder null (= Standard je Fahrradtyp). Grundlage für Fahrzeit und Ankunftszeiten.

const BIKE_LABELS = { road: 'Rennrad', gravel: 'Gravel', trekking: 'Fahrrad' };
const speedRange = $('#speed-range');
let pendingSpeed = null; // Auswahl im Dialog, null = Standard

function renderSpeed() {
  const value = pendingSpeed ?? DEFAULT_SPEED[state.bike];
  speedRange.value = value;
  $('#speed-out').textContent = pendingSpeed == null
    ? `${value} km/h (Standard ${BIKE_LABELS[state.bike]})`
    : `${value} km/h`;
  $('#speed-reset').hidden = pendingSpeed == null;
}

speedRange.addEventListener('input', () => { pendingSpeed = Number(speedRange.value); renderSpeed(); });
$('#speed-reset').addEventListener('click', () => { pendingSpeed = null; renderSpeed(); });

setAverageSpeed(storage.get('avgSpeed', null));

/** Fahrzeit und Ankunftszeiten nach geänderter Geschwindigkeit neu berechnen (Route bleibt gleich). */
function refreshTimes() {
  if (!state.route) return;
  if (state.supply.enabled) replanStops(); // Ankunftszeiten bestimmen Öffnungsstatus und Auswahl der Stopps
  else showRoute(state.route, { fit: false });
}

// ---------- Einstellungen ----------

const dialog = $('#settings-dialog');
$('#btn-settings').addEventListener('click', () => {
  $('#ors-key').value = storage.get('orsKey', '');
  pendingHome = getHome();
  homeInput.value = pendingHome?.label || '';
  $('#btn-home-from-start').disabled = !state.start;
  pendingSpeed = storage.get('avgSpeed', null);
  renderSpeed();
  renderStaySettings();
  showWarmStatus();
  dialog.showModal();
});
dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return;
  storage.set('orsKey', $('#ors-key').value.trim());

  const speedBefore = storage.get('avgSpeed', null);
  const speedChanged = pendingSpeed !== speedBefore;
  if (speedChanged) {
    storage.set('avgSpeed', pendingSpeed);
    setAverageSpeed(pendingSpeed);
  }
  const staysChanged = saveStaySettings();
  if (state.provider !== 'ors') { // bei ORS berechnet recalc() unten ohnehin neu
    if (staysChanged && state.multiDay && state.route) replanStops(); // Etappen/Unterkünfte neu planen
    else if (speedChanged) refreshTimes();
    else if (staysChanged) renderStages(); // z. B. Knopf „Als Mehrtagestour planen“ ein-/ausblenden
  }
  // Leeres Feld = Heimatadresse entfernen
  const before = getHome();
  const home = homeInput.value.trim() ? pendingHome : null;
  storage.set('home', home);
  syncHomeButton();
  if (home && !state.start) useHomeAsStart();
  if (state.provider === 'ors') recalc();

  const changed = home && (!before || round1(before.lat) !== round1(home.lat) || round1(before.lon) !== round1(home.lon));
  if (changed) {
    const data = await sendHomeToServer(home, { force: true });
    if (data && !state.route) flashStatus(warmMessage(data));
  }
});

syncUi();
syncHomeButton();

// Heimatadresse als Standard-Startort
const home = getHome();
if (home) {
  state.start = { lat: home.lat, lon: home.lon, label: home.label };
  updateDepartureHint();
  ui.startInput.value = home.label;
  map.flyTo(home);
  updateMarkers();
  // z. B. wenn die Heimat gespeichert wurde, bevor der Server-Cache existierte – höchstens wöchentlich
  sendHomeToServer(home);
}

// Konto: Status laden, Einstellungen abgleichen, „Meine Routen“, geteilten Link (?route=…) öffnen
async function openSharedFromUrl() {
  const token = new URLSearchParams(location.search).get('route');
  if (!token) return;
  history.replaceState(null, '', location.pathname); // Link nicht beim Neuladen erneut öffnen
  setStatus('Geteilte Route wird geladen …', 'loading');
  try {
    const r = await getSharedRoute(token);
    setStatus(null);
    restoreRoute(r, { own: false });
    map.fitRoute(state.route.coords);
    flashStatus(`Geteilte Route „${r.name}“${account.user ? ' – mit „Route speichern“ in deine Routen übernehmen.' : '.'}`);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

(async () => {
  await loadAccount();
  renderAccount();
  if (account.user) {
    await syncSettings();
    refreshMyRoutes();
  }
  renderSaveActions();
  await openSharedFromUrl();
})();
