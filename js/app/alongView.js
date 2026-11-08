/**
 * „Entlang der Route finden“: Kategorie wählen (Café, Bäckerei …), Treffer bis 1 km neben der Route
 * mit Ankunftszeit und Öffnungsstatus anzeigen und auf Wunsch als Zwischenstopp übernehmen.
 */
import { PLACE_CATEGORIES, searchAlongRoute } from '../placeSearch.js';
import { openingAt } from '../stops.js';
import { arrivalAt } from '../timeline.js';
import { haversine, debounce, formatClock } from '../utils.js';
import { announce } from '../announce.js';
import { state, on, departureDate } from './state.js';
import { $, rowButton, span, popupButton, listAction } from './dom.js';
import { map } from './mapView.js';
import { addVia } from './waypoints.js';

let alongCategory = null;   // aktive Kategorie oder null
let alongController = null; // laufende Suche
let alongResults = [];

/** Nach einer Routenänderung die aktive Suche aktualisieren (km-Angaben, neue Abschnitte). */
const refreshAlong = debounce(() => { if (alongCategory && state.route) searchAlong(alongCategory); }, 500);

on('route', r => { if (r) refreshAlong(); else searchAlong(null); });

const offsetText = res => `${Math.round(res.offset / 50) * 50} m neben der Route`;

function renderAlongChips() {
  $('#along-chips').replaceChildren(...Object.entries(PLACE_CATEGORIES).map(([key, c]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${c.icon} ${c.label}`;
    b.setAttribute('aria-pressed', String(key === alongCategory));
    b.addEventListener('click', () => searchAlong(key === alongCategory ? null : key, { spoken: true }));
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
  el.append(title);
  const line = (text, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text; el.append(d); };
  if (res.detail) line(res.detail, 'muted');
  line(openingText(res).text);
  if (res.opening.hours) line(`Öffnungszeiten${res.opening.typical ? ' (typisch)' : ''}: ${res.opening.hours}`, 'muted');
  line(`km ${(res.along / 1000).toFixed(1)} · ${offsetText(res)}`);
  el.append(popupButton('Als Zwischenstopp hinzufügen', () => addAlongResult(res)));
  return el;
}

function addAlongResult(res) {
  map.closePopup();
  alongResults = alongResults.filter(r => r.id !== res.id);
  renderAlongResults();
  // Alle Kategorien sind Verpflegung – der Ort zählt bei der Stopp-Planung als Stopp
  addVia(res, { label: res.name, icon: PLACE_CATEGORIES[res.category].icon, food: true });
}

function renderAlongResults() {
  map.setSearchResults(alongResults.map(r => ({
    id: r.id, lat: r.lat, lon: r.lon, icon: PLACE_CATEGORIES[r.category].icon, popup: alongPopup(r),
    title: `${PLACE_CATEGORIES[r.category].label}: ${r.name}, km ${(r.along / 1000).toFixed(1)}`,
  })));
  $('#along-list').replaceChildren(...alongResults.map(r => {
    const li = document.createElement('li');
    const main = span('main');
    const detail = document.createElement('small');
    const op = openingText(r);
    detail.textContent = `${op.text} · ${offsetText(r)}`;
    if (op.warn) detail.className = 'warn';
    main.append(span('name', r.name), detail);
    const km = span('km', `km ${(r.along / 1000).toFixed(1)}`);
    // Zeile zeigt den Ort auf der Karte, „+“ übernimmt ihn – zwei getrennte Knöpfe (keine Knöpfe ineinander)
    const row = rowButton([main, km], () => map.openSearchResult(r.id));
    li.append(row, listAction('+', `${r.name} als Zwischenstopp hinzufügen`, () => addAlongResult(r)));
    return li;
  }));
}

/**
 * Suche für eine Kategorie starten; `null` beendet die Suche und entfernt die Treffer.
 * `spoken`: Ergebnis für Screenreader ansagen (nur wenn der Nutzer selbst gesucht hat, nicht beim
 * automatischen Aktualisieren nach einer Routenänderung).
 */
export async function searchAlong(category, { spoken = false } = {}) {
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
    const eta = arrivalAt(state.route, departureDate(), state.bike);
    alongResults = found.filter(r => !added.some(p => haversine(p, r) < 50)).map(r => {
      const t = eta(r.along);
      return { ...r, eta: t, opening: r.poi ? openingAt(r.poi, t) : { state: 'unknown', typical: false, hours: '' } };
    });
    const summary = alongResults.length
      ? `${alongResults.length} × ${c.label} bis 1 km neben der Route – mit „+“ als Zwischenstopp übernehmen.`
      : `Kein ${c.label} bis 1 km neben der Route gefunden.`;
    hint.textContent = summary
      + (found.partial ? ' Einzelne Abschnitte konnten nicht durchsucht werden – ggf. erneut versuchen.' : '')
      + (found.source === 'photon' ? ' Öffnungszeiten für diesen Abschnitt werden gerade nachgeladen und stehen beim nächsten Mal zur Verfügung.' : '');
    renderAlongResults();
    if (spoken) announce(summary);
  } catch (e) {
    if (e.name !== 'AbortError') { hint.textContent = e.message; if (spoken) announce(e.message, { urgent: true }); }
  }
}

renderAlongChips();
