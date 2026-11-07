import { providers, route } from './routing/index.js';
import { generateLoop, generateOneWay } from './generators.js';
import { createMap } from './map.js';
import { attachSearch, reverse } from './geocode.js';
import { createElevation } from './elevation.js';
import { downloadGpx } from './gpx.js';
import { summarize, estimatedShare } from './surfaces.js';
import { storage, newSeed, seededRandom, estimateTime, formatKm, formatM, formatDuration } from './utils.js';

const $ = sel => document.querySelector(sel);
const MODE_LABELS = { ab: 'Route', distance: 'Strecke', loop: 'Rundkurs' };

const state = {
  bike: storage.get('bike', 'road'),
  traffic: storage.get('traffic', 'normal'),
  provider: storage.get('provider', 'brouter'),
  mode: storage.get('mode', 'ab'),
  distanceKm: storage.get('distanceKm', 60),
  direction: 'random',
  breakdown: storage.get('breakdown', 'surface'), // 'surface' | 'waytype'
  colorRoute: storage.get('colorRoute', true),
  start: null, // {lat, lon, label}
  end: null,
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

const provider = () => providers[state.provider];
const routeOpts = () => ({ bike: state.bike, traffic: state.traffic });

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
  for (const n of document.querySelectorAll('[data-show]')) n.hidden = !n.dataset.show.split(' ').includes(state.mode);

  $('#traffic-field').hidden = state.bike !== 'road' || !provider().supportsTraffic;
  $('#traffic').value = state.traffic;
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
    map.setMarkers(wps.map((point, index) => ({
      point, index, kind: index === 0 ? 'start' : !isLoop(r) && index === last ? 'end' : 'via',
    })));
    return;
  }
  const markers = [];
  if (state.start) markers.push({ point: state.start, kind: 'start', index: 0 });
  if (state.end && state.mode === 'ab') markers.push({ point: state.end, kind: 'end', index: 1 });
  map.setMarkers(markers);
}

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

function showRoute(r, { fit = true } = {}) {
  state.route = r;
  drawRouteLine();
  updateMarkers();
  elevation.show(r, state.breakdown);
  renderBreakdown();
  relayout();

  $('#stat-dist').textContent = formatKm(r.distance);
  $('#stat-up').textContent = formatM(r.ascent);
  $('#stat-down').textContent = formatM(r.descent);
  $('#stat-time').textContent = formatDuration(estimateTime(r.distance, r.ascent, state.bike));
  ui.routeName.value = defaultName(r);
  ui.results.hidden = false;

  if (fit) map.fitRoute(r.coords);
}

function clearRoute() {
  controller?.abort();
  state.route = null;
  map.setRoute(null);
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
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    setStatus(e.message, 'error');
  }
}

function calcAB() {
  if (!state.start || !state.end) { updateMarkers(); return; }
  run(signal => route(provider(), [state.start, state.end], routeOpts(), signal));
}

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
  if (state.mode === 'ab') setPoint(state.start ? 'end' : 'start', point);
  else setPoint('start', point);
}

function handleMarkerDrag(index, point) {
  const r = state.route;
  if (r && r.waypoints.length >= 2) {
    const loop = isLoop(r);
    const wps = r.waypoints.slice();
    wps[index] = point;
    if (loop && index === 0) wps[wps.length - 1] = point;
    if (index === 0) setPoint('start', point, { silent: true });
    if (!loop && index === wps.length - 1) setPoint('end', point, { silent: true });
    // Start bleibt dasselbe Objekt am Anfang und Ende, damit der Rundkurs als solcher erkannt wird
    if (loop && index === 0) wps[0] = wps[wps.length - 1] = state.start;
    run(signal => route(provider(), wps, routeOpts(), signal), { fit: false });
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

$('#btn-gpx').addEventListener('click', () => {
  if (state.route) downloadGpx(state.route, ui.routeName.value.trim() || defaultName(state.route));
});

$('#btn-clear').addEventListener('click', () => {
  if (state.mode === 'ab') { state.end = null; ui.endInput.value = ''; }
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

// ---------- Einstellungen ----------

const dialog = $('#settings-dialog');
$('#btn-settings').addEventListener('click', () => {
  $('#ors-key').value = storage.get('orsKey', '');
  pendingHome = getHome();
  homeInput.value = pendingHome?.label || '';
  $('#btn-home-from-start').disabled = !state.start;
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  storage.set('orsKey', $('#ors-key').value.trim());
  // Leeres Feld = Heimatadresse entfernen
  const home = homeInput.value.trim() ? pendingHome : null;
  storage.set('home', home);
  syncHomeButton();
  if (home && !state.start) useHomeAsStart();
  if (state.provider === 'ors') recalc();
});

syncUi();
syncHomeButton();

// Heimatadresse als Standard-Startort
const home = getHome();
if (home) {
  state.start = { lat: home.lat, lon: home.lon, label: home.label };
  ui.startInput.value = home.label;
  map.flyTo(home);
  updateMarkers();
}
