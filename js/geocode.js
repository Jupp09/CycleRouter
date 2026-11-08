import { debounce } from './utils.js';
import { announce } from './announce.js';

/**
 * Ortssuche und Ortsbestimmung.
 * Primär Photon (komoot) – schnell, mit Vorschlägen beim Tippen. Ist Photon nicht erreichbar, wird auf
 * Nominatim (OpenStreetMap) ausgewichen. Dessen Nutzungsbedingungen verbieten Vorschläge beim Tippen
 * und erlauben höchstens eine Anfrage pro Sekunde – deshalb sucht die Ausweichlösung erst auf Enter.
 */

const PHOTON = 'https://photon.komoot.io';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON_TIMEOUT = 5000;
/** Nach einem Photon-Ausfall so lange direkt die Ausweichlösung nutzen, dann Photon erneut probieren. */
const PHOTON_RETRY_AFTER = 2 * 60 * 1000;

let photonDownSince = 0;
const photonDown = () => Date.now() - photonDownSince < PHOTON_RETRY_AFTER;

const timeout = ms => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

/** Photon aufrufen; markiert Photon bei Netzwerkfehlern/Zeitüberschreitung für eine Weile als ausgefallen. */
async function photon(path) {
  if (photonDown()) throw Object.assign(new Error('Photon nicht erreichbar'), { unavailable: true });
  let res;
  try {
    res = await fetch(`${PHOTON}${path}`, { signal: timeout(PHOTON_TIMEOUT) });
  } catch (e) {
    photonDownSince = Date.now();
    throw Object.assign(new Error('Photon nicht erreichbar'), { unavailable: true, cause: e });
  }
  if (res.status >= 500 || res.status === 429) {
    photonDownSince = Date.now();
    throw Object.assign(new Error(`Photon ${res.status}`), { unavailable: true });
  }
  if (!res.ok) throw new Error('Ortssuche fehlgeschlagen');
  return res.json();
}

// Nominatim: höchstens eine Anfrage pro Sekunde
let nominatimQueue = Promise.resolve();
let nominatimLast = 0;
function nominatim(path) {
  const p = nominatimQueue.then(async () => {
    const wait = nominatimLast + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      const res = await fetch(`${NOMINATIM}${path}`, { signal: timeout(10000) });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      return await res.json();
    } finally { nominatimLast = Date.now(); }
  });
  nominatimQueue = p.catch(() => {});
  return p;
}

function describe(p) {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const place = [p.postcode, p.city || p.town || p.village || p.county].filter(Boolean).join(' ');
  const title = p.name || street || place || 'Unbenannter Ort';
  const detail = [p.name ? street : '', place !== title ? place : '', p.country]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  return { title, detail };
}

const toPlace = f => {
  const { title, detail } = describe(f.properties);
  return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: title, detail };
};

/** Nominatim-Ergebnis in dasselbe Format wie Photon bringen. */
function fromNominatim(r) {
  const a = r.address || {};
  return describe({
    name: r.name,
    street: a.road || a.pedestrian || a.footway || a.cycleway,
    housenumber: a.house_number,
    postcode: a.postcode,
    city: a.city || a.town || a.village || a.municipality,
    county: a.county,
    country: a.country,
  });
}

/** Vorschläge beim Tippen (nur Photon). Wirft `unavailable`, wenn Photon nicht erreichbar ist. */
export async function search(query, bias) {
  const params = new URLSearchParams({ q: query, limit: 6, lang: 'de' });
  if (bias) { params.set('lat', bias.lat.toFixed(4)); params.set('lon', bias.lon.toFixed(4)); }
  return (await photon(`/api/?${params}`)).features.map(toPlace);
}

/** Ausweich-Suche über Nominatim – nur auf ausdrückliche Anforderung (Enter) aufrufen. */
export async function searchFallback(query, bias) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: 1, limit: 6, 'accept-language': 'de' });
  if (bias) {
    // Bevorzugter Bereich (±1°) – Treffer außerhalb bleiben möglich
    params.set('viewbox', [bias.lon - 1, bias.lat + 1, bias.lon + 1, bias.lat - 1].map(v => v.toFixed(3)).join(','));
  }
  const places = (await nominatim(`/search?${params}`)).map(r => {
    const { title, detail } = fromNominatim(r);
    return { lat: Number(r.lat), lon: Number(r.lon), label: title, detail };
  });
  // Nominatim liefert denselben Ort oft mehrfach (Gebäude, Haltestelle, Fläche) → gleicher Name und < 300 m = doppelt
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.003 && Math.abs(a.lon - b.lon) < 0.0045;
  return places.filter((p, i) => !places.slice(0, i).some(q => q.label === p.label && near(p, q)));
}

/** Liefert eine lesbare Bezeichnung für einen Kartenpunkt; bei Fehlern die Koordinaten. */
export async function reverse(point) {
  const fallback = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  const short = ({ title, detail }) => (detail ? `${title}, ${detail.split(', ')[0]}` : title);
  try {
    const f = (await photon(`/reverse?lat=${point.lat}&lon=${point.lon}&lang=de&limit=1`)).features?.[0];
    return f ? short(describe(f.properties)) : fallback;
  } catch (e) {
    if (!e.unavailable) return fallback;
  }
  // Photon ausgefallen → Nominatim (Einzelabfrage, erlaubt)
  try {
    const r = await nominatim(`/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=de&lat=${point.lat}&lon=${point.lon}`);
    return r?.address ? short(fromNominatim(r)) : fallback;
  } catch {
    return fallback;
  }
}

let listSeq = 0;

/**
 * Autocomplete für ein Eingabefeld. Die Vorschlagsliste ist das <ul class="suggestions"> im selben Container.
 * Barrierefrei nach dem Combobox-Muster: Das Feld meldet, ob Vorschläge offen sind und welcher markiert ist
 * (aria-activedescendant); die Anzahl der Vorschläge wird angesagt.
 */
export function attachSearch(input, { onSelect, getBias }) {
  const list = input.parentElement.querySelector('.suggestions');
  let items = [], active = -1, requestId = 0;
  let notice = ''; // Hinweiszeile statt Vorschlägen (z. B. Photon ausgefallen)

  list.id ||= `suggestions-${++listSeq}`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Vorschläge');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  const close = () => {
    list.hidden = true; active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const choose = place => { input.value = place.label; close(); onSelect(place); };

  function render() {
    const rows = items.map((place, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.className = i === active ? 'active' : '';
      li.textContent = place.label;
      if (place.detail) {
        const small = document.createElement('small');
        small.textContent = place.detail;
        li.append(small);
      }
      li.addEventListener('mousedown', e => { e.preventDefault(); choose(place); });
      return li;
    });
    if (notice) {
      const li = document.createElement('li');
      li.className = 'notice';
      li.setAttribute('role', 'option');
      li.textContent = notice;
      li.addEventListener('mousedown', e => { e.preventDefault(); fallbackSearch(); });
      rows.push(li);
    }
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /** Ergebnis ansagen (nur nach einer Suche, nicht bei jedem Pfeiltasten-Schritt). */
  const speak = () => announce(items.length
    ? `${items.length} ${items.length === 1 ? 'Vorschlag' : 'Vorschläge'} – mit Pfeiltasten auswählen`
    : notice || 'Keine Vorschläge');

  const showNotice = text => { items = []; notice = text; active = -1; render(); speak(); };

  async function fallbackSearch() {
    const q = input.value.trim();
    if (q.length < 3) return;
    const id = ++requestId;
    showNotice('Suche über OpenStreetMap (Nominatim) …');
    try {
      const results = await searchFallback(q, getBias());
      if (id !== requestId) return;
      items = results; notice = results.length ? '' : 'Nichts gefunden.'; active = -1; render(); speak();
    } catch {
      if (id === requestId) showNotice('Ortssuche gerade nicht erreichbar – Ort bitte auf der Karte anklicken.');
    }
  }

  const FALLBACK_HINT = 'Vorschläge gerade nicht verfügbar – Enter drücken (oder hier klicken), um zu suchen.';

  const lookup = debounce(async query => {
    const id = ++requestId;
    try {
      const results = await search(query, getBias());
      if (id !== requestId) return;
      items = results; notice = ''; active = -1; render(); speak();
    } catch (e) {
      if (id === requestId && e.unavailable) showNotice(FALLBACK_HINT);
    }
  }, 250);

  input.addEventListener('input', () => {
    const q = input.value.trim();
    notice = '';
    if (q.length < 3) { requestId++; items = []; close(); return; }
    if (photonDown()) { showNotice(FALLBACK_HINT); return; }
    lookup(q);
  });

  input.addEventListener('keydown', e => {
    // Ohne Vorschläge (Photon ausgefallen): Enter startet die Ausweich-Suche
    if (e.key === 'Enter' && !items.length && input.value.trim().length >= 3 && (notice || photonDown())) {
      e.preventDefault();
      fallbackSearch();
      return;
    }
    if (list.hidden || !items.length) {
      if (e.key === 'Enter' && items.length) choose(items[0]);
      if (e.key === 'Escape') close();
      return;
    }
    if (e.key === 'ArrowDown') { active = (active + 1) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(items[Math.max(active, 0)]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });

  input.addEventListener('blur', close);
  input.addEventListener('focus', () => { if ((items.length || notice) && input.value.trim().length >= 3) render(); });
}
