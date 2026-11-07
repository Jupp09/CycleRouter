import { debounce } from './utils.js';

const PHOTON = 'https://photon.komoot.io';

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

export async function search(query, bias) {
  const params = new URLSearchParams({ q: query, limit: 6, lang: 'de' });
  if (bias) { params.set('lat', bias.lat.toFixed(4)); params.set('lon', bias.lon.toFixed(4)); }
  const res = await fetch(`${PHOTON}/api/?${params}`);
  if (!res.ok) throw new Error('Ortssuche fehlgeschlagen');
  return (await res.json()).features.map(toPlace);
}

/** Liefert eine lesbare Bezeichnung für einen Kartenpunkt; bei Fehlern die Koordinaten. */
export async function reverse(point) {
  const fallback = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  try {
    // Zeitlimit: hängt Photon, sollen die Felder nicht endlos „Ort wird ermittelt …“ zeigen
    const signal = AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined;
    const res = await fetch(`${PHOTON}/reverse?lat=${point.lat}&lon=${point.lon}&lang=de&limit=1`, { signal });
    const f = (await res.json()).features?.[0];
    if (!f) return fallback;
    const { title, detail } = describe(f.properties);
    return detail ? `${title}, ${detail.split(', ')[0]}` : title;
  } catch {
    return fallback;
  }
}

/** Autocomplete für ein Eingabefeld. Die Vorschlagsliste ist das <ul class="suggestions"> im selben Container. */
export function attachSearch(input, { onSelect, getBias }) {
  const list = input.parentElement.querySelector('.suggestions');
  let items = [], active = -1, requestId = 0;

  const close = () => { list.hidden = true; active = -1; };
  const choose = place => { input.value = place.label; close(); onSelect(place); };

  function render() {
    list.replaceChildren(...items.map((place, i) => {
      const li = document.createElement('li');
      li.className = i === active ? 'active' : '';
      li.textContent = place.label;
      if (place.detail) {
        const small = document.createElement('small');
        small.textContent = place.detail;
        li.append(small);
      }
      li.addEventListener('mousedown', e => { e.preventDefault(); choose(place); });
      return li;
    }));
    list.hidden = items.length === 0;
  }

  const lookup = debounce(async query => {
    const id = ++requestId;
    try {
      const results = await search(query, getBias());
      if (id !== requestId) return;
      items = results; active = -1; render();
    } catch { /* Suche ist optional – Kartenklick funktioniert weiterhin */ }
  }, 250);

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q.length < 3) { requestId++; items = []; close(); return; }
    lookup(q);
  });

  input.addEventListener('keydown', e => {
    if (list.hidden) {
      if (e.key === 'Enter' && items.length) choose(items[0]);
      return;
    }
    if (e.key === 'ArrowDown') { active = (active + 1) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(items[Math.max(active, 0)]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });

  input.addEventListener('blur', close);
  input.addEventListener('focus', () => { if (items.length && input.value.trim().length >= 3) render(); });
}
