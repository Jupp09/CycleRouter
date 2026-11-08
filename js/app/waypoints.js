/**
 * Wegpunkte: Start und Ziel (Suche, Kartenklick, Standort, Tauschen), manuelle Zwischenstopps und das
 * Verschieben von Markern auf der Karte.
 *
 * Zwischenstopps im A→B-Modus liegen in `state.vias`; bei Distanz und Rundkurs werden sie direkt in die
 * Wegpunkte der vorhandenen Route eingefügt. Ohne Bezeichnung wird sie per Rückwärtssuche nachgetragen.
 */
import { route } from '../routing/index.js';
import { attachSearch, reverse } from '../geocode.js';
import { haversine } from '../utils.js';
import { state, emit, provider, routeOpts, isLoop, activeVias, originRoute } from './state.js';
import { $, ui, setStatus } from './dom.js';
import { map, setMapHandlers, updateMarkers } from './mapView.js';
import { run, calcAB, generate, clearRoute } from './pipeline.js';

// ---------- Start und Ziel ----------

/**
 * Start oder Ziel setzen. Ohne `label` wird die Adresse nachgeschlagen. `silent`: nur übernehmen, nicht
 * neu berechnen (z. B. wenn die Route den Punkt ohnehin schon enthält).
 */
export async function setPoint(which, point, { label, silent = false } = {}) {
  const input = which === 'start' ? ui.startInput : ui.endInput;
  const p = { lat: point.lat, lon: point.lon, label: label || '' };
  state[which] = p;
  if (which === 'start') emit('start');
  input.value = label || 'Ort wird ermittelt …';
  if (!label) reverse(p).then(l => { if (state[which] === p) { p.label = l; input.value = l; } });
  if (silent) return;

  if (state.mode === 'ab') {
    calcAB();
  } else {
    // Distanz/Rundkurs werden erst auf Knopfdruck erzeugt; eine alte Route passt nicht mehr zum Start
    if (which === 'start' && state.route) clearRoute();
    updateMarkers();
  }
}

attachSearch(ui.startInput, {
  getBias: () => map.center(),
  onSelect: place => { setPoint('start', place, { label: place.label }); if (state.mode !== 'ab' || !state.end) map.flyTo(place); },
});
attachSearch(ui.endInput, {
  getBias: () => state.start || map.center(),
  onSelect: place => { setPoint('end', place, { label: place.label }); if (!state.start) map.flyTo(place); },
});

$('#btn-swap').addEventListener('click', () => {
  [state.start, state.end] = [state.end, state.start];
  state.vias.reverse();
  renderVias();
  emit('start');
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

// „Löschen“: Route verwerfen; im A→B-Modus auch Ziel und Zwischenstopps (der Start bleibt)
$('#btn-clear').addEventListener('click', () => {
  if (state.mode === 'ab') { state.end = null; ui.endInput.value = ''; state.vias = []; renderVias(); }
  clearRoute();
});

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

/** Zwischenstopp hinzufügen – an der günstigsten Stelle der Route – und neu berechnen. */
export function addVia(point, { label = '', icon = null } = {}) {
  const via = { lat: point.lat, lon: point.lon, label, icon, manual: true };
  if (!label) reverse(via).then(l => { via.label = l; renderVias(); updateMarkers(); });

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

/** Eingabezeilen der Zwischenstopps (A→B), je mit eigener Ortssuche und Entfernen-Knopf. */
export function renderVias() {
  $('#via-list').replaceChildren(...state.vias.map((via, i) => {
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

// Neue, noch leere Zeile – erst wenn die vorige ausgefüllt ist
$('#btn-add-via').addEventListener('click', () => {
  if (state.vias.some(v => v.lat == null)) return;
  state.vias.push({ lat: null, lon: null, label: '', manual: true });
  renderVias();
});

// ---------- Karte: Klick und Marker verschieben ----------

/** A→B: erst Start, dann Ziel, danach fügt jeder Klick einen Zwischenstopp ein. Sonst: Klick = Start. */
function handleMapClick(point) {
  if (state.mode === 'ab') {
    if (state.start && state.end) addVia(point);
    else setPoint(state.start ? 'end' : 'start', point);
  } else {
    setPoint('start', point);
  }
}

/** Marker verschoben: `index` ist der Wegpunkt-Index der Route oder 'via<n>' (Zwischenstopp ohne Route). */
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
    // Übernachtungen und Verpflegungsstopps werden für die geänderte Route neu gewählt
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

setMapHandlers({ onClick: handleMapClick, onMarkerDrag: handleMarkerDrag });
