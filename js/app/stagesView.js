/**
 * Mehrtagestouren – nur auf Knopfdruck: Ist die Route deutlich länger als die Tagesetappe, bietet
 * „Als Mehrtagestour planen“ die Aufteilung an. Dann werden je Nacht Unterkünfte vorgeschlagen (Auswahl
 * per Liste) und die Route durch die gewählten geführt. Dazu die Einstellungen im Zahnrad-Dialog
 * (km pro Tag, Budget, Unterkunftsarten, Übernachtung am Ziel).
 */
import {
  STAY_TYPES, STAY_GROUPS, isMultiDayCandidate, priceLabel, priceLink, websiteOf, osmNoteLink,
  AVAILABILITY_LABEL, lastConfirmed,
} from '../stays.js';
import { stageStats } from '../timeline.js';
import { storage, formatKm, formatM, formatDuration, formatDayDate } from '../utils.js';
import { state, on, departureDate, originRoute } from './state.js';
import { $, textLines, externalLink, linkButton, flashStatus } from './dom.js';
import { map } from './mapView.js';
import { replanStops } from './pipeline.js';
import { setDeparture } from './supplyView.js';

on('route', renderStages);
on('stages', renderStages);

const FIT_LABEL = { ok: 'im Budget', maybe: 'evtl. im Budget', over: 'über Budget' };

// ---------- Etappen und Nächte ----------

/** Knopf, Zusammenfassung, Tagesliste mit Unterkunftswahl und Unterkunfts-Marker auf der Karte. */
export function renderStages() {
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
    day.firstChild.textContent = `Tag ${s.day} · ${formatDayDate(date)}`;
    day.lastChild.textContent = `${formatKm(s.distance)} · ${formatM(s.ascent)} ↑ · ca. ${formatDuration(s.time)}`;
    li.append(day);
    // Nacht nach diesem Tag (bzw. am Ziel nach dem letzten Tag)
    const night = plan.nights[i];
    if (night) li.append(renderNight(night));
    return li;
  }));
}

/** Eine Nacht: Auswahlliste der Unterkünfte, Preis/Budget/Saison und Links. */
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

  const c = night.chosen;
  const meta = document.createElement('span');
  meta.className = 'meta' + (c.fit === 'over' || c.open === 'season' || c.stale ? ' over' : '');
  meta.textContent = `${STAY_TYPES[c.poi.type].label} · ${priceLabel(c.price)} – ${FIT_LABEL[c.fit]} (Budget ${state.stays.budget} €)`
    + (AVAILABILITY_LABEL[c.open] ? ` · ${AVAILABILITY_LABEL[c.open]}` : '')
    + (c.stale ? ` · Angaben von ${lastConfirmed(c.poi)} – evtl. veraltet, vorher prüfen` : '');

  const links = stayLinks(night);
  links.prepend(linkButton('Auf der Karte zeigen', () => map.openStay(c.poi.id)));
  links.append(linkButton('Ausblenden', () => hideStay(night),
    'Diese Unterkunft nicht mehr vorschlagen (z. B. existiert nicht oder bietet keine Übernachtung)'));
  box.append(select, meta, links);
  return box;
}

/** Eintrag der Auswahlliste, z. B. „🏨 Hotel Post 3★ · ca. 70–110 € · 0,8 km“. */
function optionLabel(o) {
  const t = STAY_TYPES[o.poi.type];
  const name = o.poi.name || t.label;
  return `${t.icon} ${name}${o.poi.tags.stars ? ` ${o.poi.tags.stars}★` : ''} · ${priceLabel(o.price)} · ${(o.offset / 1000).toFixed(1)} km`
    + `${o.fit === 'over' ? ' · über Budget' : ''}${o.open === 'season' ? ' · Saison prüfen' : ''}${o.stale ? ' · evtl. veraltet' : ''}`;
}

function stayPopup(night) {
  const { poi, price, fit, offset } = night.chosen;
  const el = document.createElement('div');
  el.className = 'stop-popup';
  const title = document.createElement('b');
  title.textContent = `${STAY_TYPES[poi.type].icon} ${poi.name || STAY_TYPES[poi.type].label}`;
  el.append(title, ...textLines([
    `${night.end ? 'Übernachtung am Ziel' : `Nacht ${night.index + 1}`} · ${formatDayDate(night.date)}`,
    `${STAY_TYPES[poi.type].label}${poi.tags.stars ? ` · ${poi.tags.stars}★` : ''} · ${(offset / 1000).toFixed(1)} km neben der Route`,
    `${priceLabel(price)} – ${FIT_LABEL[fit]}`,
  ]), stayLinks(night));
  return el;
}

/** Preis prüfen, Webseite und „Fehler melden“ (Hinweis in OpenStreetMap – Mapper vor Ort korrigieren ihn). */
function stayLinks(night) {
  const { poi } = night.chosen;
  const box = document.createElement('div');
  box.className = 'links';
  box.append(externalLink('Preis prüfen', priceLink(poi, night)));
  const web = websiteOf(poi);
  if (web && /^https?:\/\//i.test(web)) box.append(externalLink('Webseite', web));
  box.append(externalLink('Fehler melden', osmNoteLink(poi)));
  return box;
}

/** Unterkunft nie wieder vorschlagen (z. B. existiert nicht, keine Übernachtung möglich) – wird mit dem Konto abgeglichen. */
function hideStay(night) {
  const { poi } = night.chosen;
  state.hiddenStays = [...new Set([...state.hiddenStays, poi.id])];
  storage.set('hiddenStays', state.hiddenStays);
  delete state.stayChoices[night.index]; // nächstbeste Unterkunft für diese Nacht wählen
  flashStatus(`„${poi.name || STAY_TYPES[poi.type].label}“ wird nicht mehr vorgeschlagen.`);
  replanStops();
}

$('#btn-multiday').addEventListener('click', () => {
  state.multiDay = !state.multiDay;
  state.staysError = null;
  if (!state.multiDay) state.stayChoices = [];
  renderStages(); // sofortige Rückmeldung am Knopf
  replanStops();
});

// Gleiche Abfahrt wie bei den Verpflegungsstopps – bestimmt Datum der Nächte und Öffnungszeiten
$('#stage-departure').addEventListener('change', e => setDeparture(e.target.value, { replan: true }));

// ---------- Einstellungen (Zahnrad-Dialog) ----------

$('#stay-types').replaceChildren(...Object.entries(STAY_GROUPS).map(([key, g]) => {
  const label = document.createElement('label');
  label.className = 'check';
  label.innerHTML = `<input type="checkbox" value="${key}"> `; // key: feste Schlüssel aus STAY_GROUPS
  label.append(g.label);
  return label;
}));

/** Dialogfelder aus dem Zustand füllen. */
export function renderStaySettings() {
  $('#stage-max').value = state.stays.maxKm;
  $('#night-budget').value = state.stays.budget;
  $('#end-stay').checked = state.stays.endStay;
  for (const cb of document.querySelectorAll('#stay-types input')) cb.checked = state.stays.groups.includes(cb.value);
}

/** Werte aus dem Dialog übernehmen und speichern → true, wenn sich etwas geändert hat. */
export function saveStaySettings() {
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
