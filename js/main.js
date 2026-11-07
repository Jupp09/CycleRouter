import { providers, route } from './routing/index.js';
import { generateLoop, generateOneWay } from './generators.js';
import { createMap } from './map.js';
import { attachSearch, reverse } from './geocode.js';
import { createElevation } from './elevation.js';
import { downloadGpx, canShareGpx, shareGpx } from './gpx.js';
import { summarize, estimatedShare, longDistanceShare } from './surfaces.js';
import { addStops, STATE_LABELS, DWELL_MIN, arrivalAt, openingAt } from './stops.js';
import { PLACE_CATEGORIES, searchAlongRoute } from './placeSearch.js';
import { regionAt, regionLabel } from './regions.js';
import { holidayAt } from './holidays.js';
import {
  storage, newSeed, seededRandom, estimateTime, formatKm, formatM, formatDuration, haversine, debounce,
  DEFAULT_SPEED, setAverageSpeed, averageSpeed,
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
    }).filter(m => !m.point.stop));
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
  ui.routeName.value = defaultName(r);
  ui.results.hidden = false;

  if (fit) map.fitRoute(r.coords);
}

function clearRoute() {
  controller?.abort();
  state.route = null;
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
  setStatus(loadingText, 'loading');
  try {
    const r = await task(ctrl.signal);
    if (ctrl.signal.aborted) return;
    setStatus(null);
    showRoute(r, { fit });
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

/** Route (ohne Stopps) um Verpflegungsstopps ergänzen. */
function withSupply(base, signal) {
  const departure = new Date(state.supply.departure || defaultDeparture());
  return addStops(base, {
    provider: provider(), opts: routeOpts(), bike: state.bike, signal,
    interval: state.supply.intervalKm * 1000,
    departure: isNaN(departure) ? new Date() : departure,
  });
}

/** Stopps für die aktuelle Route neu planen (oder entfernen), ohne die Route selbst neu zu erzeugen. */
function replanStops() {
  const base = state.route?.base || state.route;
  if (base) run(async () => base, { fit: false, loadingText: 'Verpflegungsstopps werden gesucht …' });
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
  const base = state.route?.base || state.route;
  if (!base || base.waypoints.length < 2) {
    setStatus('Bei diesem Rundkurs (OpenRouteService) lassen sich keine Zwischenstopps einfügen – bitte BRouter wählen.', 'error');
    return;
  }
  const wps = base.waypoints.filter(p => !p.stop);
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
    const base = wps.filter(p => !p.stop);
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
      : 'Die Datei wird heruntergeladen. Direktes Teilen an Apps (z. B. Komoot) ist nur möglich, wenn CycleRouter über HTTPS aufgerufen wird.';
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
  showWarmStatus();
  dialog.showModal();
});
dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return;
  storage.set('orsKey', $('#ors-key').value.trim());

  const speedBefore = storage.get('avgSpeed', null);
  if (pendingSpeed !== speedBefore) {
    storage.set('avgSpeed', pendingSpeed);
    setAverageSpeed(pendingSpeed);
    if (state.provider !== 'ors') refreshTimes(); // bei ORS berechnet recalc() unten ohnehin neu
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
