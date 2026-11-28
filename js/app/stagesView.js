/**
 * Mehrtagestouren – nur auf Knopfdruck: Ist die Route deutlich länger als die Tagesetappe, bietet
 * „Als Mehrtagestour planen“ die Aufteilung an. Dann werden je Nacht Unterkünfte vorgeschlagen (Auswahl
 * per Liste) und die Route durch die gewählten geführt. Dazu die Einstellungen im Zahnrad-Dialog
 * (km pro Tag, Budget, Unterkunftsarten, Übernachtung am Ziel). Die Länge eines Tages lässt sich in einem
 * eigenen Fenster mit Schieberegler einstellen (Fahrzeit, Höhenmeter, Ankunft und Tageslicht laufen mit; die
 * Tage danach teilen sich den Rest, stageTargets in stays.js). Jeder Tag lässt sich einzeln als GPX ausgeben
 * und zeigt, ob er bei Tageslicht zu schaffen ist.
 */
import {
  STAY_TYPES, STAY_GROUPS, isMultiDayCandidate, priceLabel, priceLink, websiteOf,
  AVAILABILITY_LABEL, lastConfirmed, stageTargets, MIN_LAST_DAY, shelterFacts, SHELTER_NOTE,
} from '../stays.js';
import { stageStats, dayTimes } from '../timeline.js';
import { daylightNote } from '../sun.js';
import {
  storage, indexAtDistance, cumulativeAscent, estimateTime, formatKm, formatM, formatDuration, formatDayDate,
  formatClock, formatWeekday, osmNoteUrl, clampInt,
} from '../utils.js';
import { state, on, departureDate, originRoute } from './state.js';
import { $, $$, el, textLines, externalLink, linkButton, flashStatus, osmLinks, popupBox } from './dom.js';
import { map } from './mapView.js';
import { replanStops } from './pipeline.js';
import { setDeparture } from './supplyView.js';
import { exportGpx, exportFit, gpxName } from './exportView.js';
import { setSheet } from './sheetView.js';
import { checkpoint } from './history.js';

on('route', renderStages);
on('stages', renderStages);

/** GPX-Datei je Tag: Name „<Route> – Tag 2“, Abschnitt von der Vornacht bis zur nächsten Unterkunft. */
const dayFile = s => ({ name: `${gpxName()} – Tag ${s.day}`, range: { from: s.from, to: s.to } });
$('#btn-stages-gpx').addEventListener('click', () => {
  if (state.route?.stays) exportGpx(stageStats(state.route, state.bike).map(dayFile));
});
$('#btn-stages-fit').addEventListener('click', () => {
  if (state.route?.stays) exportFit(stageStats(state.route, state.bike).map(dayFile));
});

const FIT_LABEL = { ok: 'im Budget', maybe: 'evtl. im Budget', over: 'über Budget' };

// ---------- Etappen und Nächte ----------

/** Knopf, Zusammenfassung, Tagesliste mit Unterkunftswahl und Unterkunfts-Marker auf der Karte. */
function renderStages() {
  const box = $('#stages');
  const r = state.route;
  const origin = originRoute();
  const candidate = !!origin && isMultiDayCandidate(origin, state.stays.maxKm);
  box.hidden = !r || (!candidate && !state.multiDay);
  // Wird die Mehrtagestour angeboten, ist sie die Hauptaktion – „GPX exportieren“ tritt dann zurück
  const gpx = $('#btn-gpx');
  gpx.classList.add('primary');
  syncSheetActions(false);
  const plan = r?.stays;
  map.setStays(plan ? stayMarkers(plan) : []);
  if (box.hidden) return;

  renderMultiDayButton(origin, gpx);
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
  const times = dayTimes(r, start, state.bike);
  $('#stage-list').replaceChildren(...stats.map((s, i) => dayRow(r, plan, s, i, start, times[i])));
}

/** Marker der gewählten Unterkünfte für die Karte. */
function stayMarkers(plan) {
  return plan.nights.filter(n => n.chosen).map(n => ({
    id: n.chosen.poi.id, lat: n.chosen.poi.lat, lon: n.chosen.poi.lon, icon: STAY_TYPES[n.chosen.poi.type].icon, popup: stayPopup(n),
    title: `${n.end ? 'Übernachtung am Ziel' : `Nacht ${n.index + 1}`}: ${n.chosen.poi.name || STAY_TYPES[n.chosen.poi.type].label}`,
  }));
}

/**
 * Knopf „Als Mehrtagestour planen“ / „… aufheben“ samt Fehlerzeile. Wird die Mehrtagestour angeboten, ist sie die
 * Hauptaktion; „GPX exportieren“ (`gpx`) tritt dann zurück.
 */
function renderMultiDayButton(origin, gpx) {
  const { days } = stageTargets(origin.distance, state.stays.maxKm, state.stageKm);
  const btn = $('#btn-multiday');
  btn.disabled = !!state.staysLoading;
  btn.textContent = state.staysLoading
    ? `Unterkünfte für ${days - 1}+ Nächte werden gesucht …`
    : state.multiDay
      ? 'Mehrtagestour aufheben'
      : `Als Mehrtagestour planen (${days} Tage à ca. ${Math.round(origin.distance / days / 1000)} km)`;
  btn.className = state.multiDay && !state.staysLoading ? '' : 'primary';
  gpx.classList.toggle('primary', btn.className !== 'primary');
  syncSheetActions(!state.multiDay && !state.staysLoading);
  // Fehler direkt am Knopf anzeigen (die Statuszeile oben ist auf dem Handy oft nicht im Blick)
  const err = $('#stages-error');
  err.hidden = !state.staysError || state.staysLoading;
  err.textContent = state.staysError || '';
}

/**
 * Eine Tageszeile: Datum, Kennzahlen, Tageslicht, „Als GPX“, „Als FIT“, „Länge ändern“ und die Nacht danach.
 * @param {Route} r @param {any} plan @param {any} s Tag aus stageStats @param {number} i
 * @param {Date} start Abfahrt am ersten Tag @param {{start: Date, end: Date}} time Abfahrt und Ankunft dieses Tages
 */
function dayRow(r, plan, s, i, start, time) {
  const li = document.createElement('li');
  const day = document.createElement('div');
  day.className = 'day';
  const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
  day.innerHTML = '<span></span><small></small>';
  day.firstChild.textContent = `Tag ${s.day} · ${formatDayDate(date)}`;
  // „fest“: Länge vom Nutzer festgelegt (im Fenster „Länge ändern“ wieder freizugeben)
  day.lastChild.textContent = `${formatKm(s.distance)} · ${formatM(s.ascent)} ↑ · ca. ${formatDuration(s.time)}`
    + (plan.fixed[i] ? ' · fest' : '');
  const gpx = linkButton('Als GPX', () => exportGpx([dayFile(s)]));
  gpx.setAttribute('aria-label', `Tag ${s.day} als GPX exportieren`);
  const fit = linkButton('Als FIT', () => exportFit([dayFile(s)]));
  fit.setAttribute('aria-label', `Tag ${s.day} als FIT-Kurs exportieren`);
  const actions = el('div', 'day-links');
  actions.append(gpx, fit);
  // Der letzte Tag ist immer der Rest der Strecke – seine Länge ergibt sich aus den anderen
  if (i < plan.days - 1) {
    const edit = linkButton('Länge ändern', () => openStageDialog(plan, i));
    edit.classList.add('length-edit');
    edit.setAttribute('aria-label', `Länge von Tag ${s.day} ändern`);
    edit.disabled = !!state.staysLoading;
    actions.append(edit);
  }
  li.append(day);
  // Tageslicht: Sonnenaufgang am Start des Tages, Sonnenuntergang an seinem Ziel
  const light = daylightNote(time, r.coords[indexAtDistance(r, s.from)], r.coords[indexAtDistance(r, s.to)]);
  if (light) {
    li.append(el('small', 'sun' + (light.warn ? ' warn' : ''), light.text));
  }
  li.append(actions);
  // Nacht nach diesem Tag (bzw. am Ziel nach dem letzten Tag)
  const night = plan.nights[i];
  if (night) li.append(renderNight(night));
  return li;
}

// ---------- Fenster „Länge ändern“ ----------

/** Bereich des Schiebereglers (km): kürzester Tag; längster Tag – höchstens die Reststrecke minus den letzten Tag. */
const MIN_DAY_KM = 10;
const MAX_DAY_KM = 300;

/** Offenes Fenster: Tag, Längen der Tage bis dahin (km), Start des Tages (m) und Abfahrt – null, wenn zu. */
let dialogDay = null;

/**
 * Fenster für die Länge von Tag `i` (nicht der letzte – der ist immer der Rest). Alle Werte beziehen sich auf die
 * Route ohne Übernachtungen (zwischen den Unterkünften entlang der Route), denn darauf bezieht sich die Anpassung
 * in planStays; die echte Etappe weicht um den Weg zur Unterkunft ab, deshalb steht überall „ca.“.
 */
function openStageDialog(plan, i) {
  const origin = originRoute();
  const along = k => (k < 0 ? 0 : plan.nights[k].chosen?.along ?? plan.nights[k].target);
  const bases = Array.from({ length: i + 1 }, (_, k) => Math.round((along(k) - along(k - 1)) / 1000));
  const from = along(i - 1);
  // Abfahrt an Tag i wie in timeline(): Kalendertag weiterzählen, gleiche Uhrzeit (nicht + 24 h)
  const start = departureDate();
  const depart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, start.getHours(), start.getMinutes(), start.getSeconds());
  dialogDay = { i, bases, from, origin, depart, fixed: !!plan.fixed[i], asc: cumulativeAscent(origin.coords) };

  $('#stage-dialog-title').textContent = `Tag ${i + 1} · ${formatDayDate(depart)}`;
  const range = $('#stage-km');
  range.min = String(MIN_DAY_KM);
  range.max = String(Math.max(MIN_DAY_KM, Math.min(MAX_DAY_KM, Math.floor((origin.distance - from - MIN_LAST_DAY) / 1000))));
  range.value = String(bases[i]);
  $('#stage-release').hidden = !plan.fixed[i];
  updateStagePreview();
  const dlg = $('#stage-dialog');
  dlg.returnValue = '';
  dlg.showModal();
  range.focus();
}

/** Länge, Fahrzeit, Höhenmeter, Ankunft und Tageslicht für den eingestellten Wert – läuft beim Ziehen mit. */
function updateStagePreview() {
  const d = dialogDay;
  if (!d) return;
  const range = $('#stage-km');
  const km = Number(range.value);
  const to = Math.min(d.origin.distance, d.from + km * 1000);
  const i0 = indexAtDistance(d.origin, d.from), i1 = indexAtDistance(d.origin, to);
  const ascent = Math.max(0, Math.round((d.asc[i1] || 0) - (d.asc[i0] || 0)));
  const time = estimateTime(to - d.from, ascent, state.bike);
  const end = new Date(d.depart.getTime() + time * 1000);
  const sameDay = end.toDateString() === d.depart.toDateString();
  $('#stage-km-value').textContent = `${km} km`;
  $('#stage-time').textContent = `ca. ${formatDuration(time)}`;
  $('#stage-ascent').textContent = `${formatM(ascent)} ↑`;
  $('#stage-arrival').textContent = `ca. ${sameDay ? '' : `${formatWeekday(end)} `}${formatClock(end)}`;
  range.setAttribute('aria-valuetext', `${km} km, Fahrzeit ca. ${formatDuration(time)}`);
  // Tageslicht wie in der Tagesliste: Sonnenaufgang am Start des Tages, Sonnenuntergang am eingestellten Ziel
  const light = daylightNote({ start: d.depart, end }, d.origin.coords[i0], d.origin.coords[i1]);
  const note = $('#stage-daylight');
  note.hidden = !light;
  note.textContent = light?.text ?? '';
  note.classList.toggle('warn', !!light?.warn);
}

$('#stage-km').addEventListener('input', updateStagePreview);
$('#stage-dialog').addEventListener('close', () => {
  const d = dialogDay;
  dialogDay = null;
  if (!d) return;
  const action = $('#stage-dialog').returnValue;
  const km = Number($('#stage-km').value);
  // Unverändert übernommen: nichts tun (ein freier Tag soll dadurch nicht „fest“ werden)
  if (action === 'ok' && km !== d.bases[d.i]) setDayLength(d.i, km, d.bases);
  else if (action === 'release') setDayLength(d.i, null, d.bases);
});

/**
 * Länge von Tag `i` festlegen (km) oder freigeben (null) und neu planen. Beim Festlegen werden die Tage davor
 * auf ihrer jetzigen Länge (`bases`, km) festgehalten: Sonst teilten sich auch die früheren Tage die Strecke
 * neu, und schon gewählte Unterkünfte davor fielen weg. Die Unterkünfte ab dieser Nacht werden neu gewählt –
 * sonst hielten die alten die übrigen Tage auf ihrer bisherigen Länge fest.
 */
function setDayLength(i, km, bases) {
  checkpoint(km == null ? `Länge von Tag ${i + 1} freigegeben` : `Tag ${i + 1} auf ${km} km geändert`);
  const next = [...state.stageKm];
  if (km != null) for (let k = 0; k < i; k++) next[k] ??= bases[k];
  next[i] = km;
  while (next.length && next.at(-1) == null) next.pop();
  state.stageKm = next;
  state.stayChoices.length = Math.min(state.stayChoices.length, i);
  // Sofort sperren (kein Doppelklick auf alte Werte); während der Suche zeigt renderStages den Ladezustand
  for (const b of $$('#stage-list .length-edit')) b.disabled = true;
  replanStops();
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
    + (c.poi.type === 'shelter' && shelterFacts(c.poi) ? ` · ${shelterFacts(c.poi)}` : '')
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
  return `${t.icon} ${name}${o.poi.tags.stars ? ` ${o.poi.tags.stars}★` : ''}${o.poi.count > 1 ? ` (${o.poi.count})` : ''} · ${priceLabel(o.price)} · ${(o.offset / 1000).toFixed(1)} km`
    + `${o.fit === 'over' ? ' · über Budget' : ''}${o.open === 'season' ? ' · Saison prüfen' : ''}${o.stale ? ' · evtl. veraltet' : ''}`;
}

function stayPopup(night) {
  const { poi, price, fit, offset } = night.chosen;
  const box = popupBox(`${STAY_TYPES[poi.type].icon} ${poi.name || STAY_TYPES[poi.type].label}`);
  box.append(...textLines([
    `${night.end ? 'Übernachtung am Ziel' : `Nacht ${night.index + 1}`} · ${formatDayDate(night.date)}`,
    `${STAY_TYPES[poi.type].label}${poi.tags.stars ? ` · ${poi.tags.stars}★` : ''} · ${(offset / 1000).toFixed(1)} km neben der Route`,
    `${priceLabel(price)} – ${FIT_LABEL[fit]}`,
    // Bei Unterkünften meist die Rezeptionszeiten – nur zeigen; fehlende sind keinen Hinweis wert
    ...(poi.tags.opening_hours ? [`Öffnungszeiten: ${poi.tags.opening_hours}`] : []),
    ...(poi.type === 'shelter' ? [shelterFacts(poi), SHELTER_NOTE].filter(Boolean) : []),
  ]), osmLinks(poi, bookingLinks(night))); // Preis/Webseite + In OSM ansehen, Bearbeiten, Fehler melden
  return box;
}

/** Preis prüfen und Webseite der gewählten Unterkunft → [Link]. */
function bookingLinks(night) {
  const { poi } = night.chosen;
  // Shelter: eine Seite für Infos und Buchung (oft udinaturen.dk), ohne Preissuche; ohne Seite und Namen kein Link
  if (poi.type === 'shelter') {
    const page = priceLink(poi, night);
    return page ? [externalLink('Infos & Buchung', page)] : [];
  }
  const links = [externalLink('Preis prüfen', priceLink(poi, night))];
  const web = websiteOf(poi);
  if (web && /^https?:\/\//i.test(web)) links.push(externalLink('Webseite', web));
  return links;
}

/** Links in der Etappenliste: Preis, Webseite und „Fehler melden“ (Hinweis in OpenStreetMap – Mapper vor Ort korrigieren ihn). */
function stayLinks(night) {
  const box = document.createElement('div');
  box.className = 'links';
  box.append(...bookingLinks(night), externalLink('Fehler melden', osmNoteUrl(night.chosen.poi)));
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

/**
 * Handy: die Hauptaktionen unten am Blatt (#sheet-actions) – GPX und, solange angeboten, die Mehrtagestour, dann
 * als Hauptaktion. Sie lösen die Knöpfe im Ergebnis aus; Beschriftung von dort („GPX teilen“ je nach Gerät).
 */
function syncSheetActions(offer) {
  $('#sheet-actions').hidden = !state.route;
  const gpx = $('#btn-sheet-gpx');
  gpx.textContent = $('#btn-gpx').textContent;
  gpx.className = offer ? '' : 'primary';
  $('#btn-sheet-multiday').hidden = !offer;
}
$('#btn-sheet-gpx').addEventListener('click', () => $('#btn-gpx').click());
$('#btn-sheet-multiday').addEventListener('click', () => {
  $('#btn-multiday').click();
  setSheet('full'); // die Tage und Unterkünfte erscheinen im Ergebnis
  $('#stages').scrollIntoView({ block: 'nearest' });
});

$('#btn-multiday').addEventListener('click', () => {
  state.multiDay = !state.multiDay;
  state.staysError = null;
  if (!state.multiDay) Object.assign(state, { stayChoices: [], stageKm: [] });
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
  for (const cb of $$('#stay-types input')) cb.checked = state.stays.groups.includes(cb.value);
}

/** Werte aus dem Dialog übernehmen und speichern → true, wenn sich etwas geändert hat. */
export function saveStaySettings() {
  const next = {
    maxKm: clampInt($('#stage-max').value, 30, 300, state.stays.maxKm),
    budget: clampInt($('#night-budget').value, 10, 500, state.stays.budget),
    groups: $$('#stay-types input:checked').map(cb => cb.value),
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
