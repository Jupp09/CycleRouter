/**
 * Roadbook: druckbare Übersicht der Route – je Tag Kennzahlen, Zeiten, Tageslicht, Anstiege, die Punkte unterwegs
 * (Verpflegungsstopps, Zwischenstopps, Trinkwasser) mit Ankunft und Öffnungszeiten und die Unterkunft am Tagesende.
 *
 * Gedruckt wird über den Druckdialog des Browsers (dort auch „Als PDF speichern“). Die Übersicht steht in
 * `#roadbook`, das auf dem Bildschirm nie sichtbar ist; solange `html.print-roadbook` gesetzt ist, zeigt der
 * Druck nur sie (css/style.css). Ohne Route druckt Strg+P die Seite wie bisher. Karte und Höhenprofil fehlen
 * bewusst (Kacheln drucken unzuverlässig), ebenso das Wetter (auf dem Papier schnell veraltet).
 *
 * Die installierte App auf iPhone/iPad hat keinen Druckdialog; dort zeigt der Knopf die Übersicht im Dialog
 * `#roadbook-dialog` (siehe `standalone` am Ende der Datei).
 */
import { STATE_LABELS } from '../stops.js';
import { STAY_TYPES, priceLabel, websiteOf } from '../stays.js';
import { stageStats, dayTimes, pausedTimeline } from '../timeline.js';
import { daylightNote } from '../sun.js';
import { findClimbs } from '../climbs.js';
import { locateOnRoute } from '../routeGeometry.js';
import { indexAtDistance, formatKm, formatM, formatDuration, formatClock, formatDayDate, formatDate } from '../utils.js';
import { account } from '../account.js';
import { state, departureDate, BIKE_LABELS, on } from './state.js';
import { $ } from './dom.js';
import { gpxName } from './exportView.js';

const km = m => (m / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = g => (g * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 });

function el(tag, text = '', cls = '') {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** Öffnungszeiten eines Orts: eigene Angabe oder – gekennzeichnet – die typischen Zeiten der Kette. */
const hoursOf = poi => poi.tags.opening_hours || (poi.typical ? `${poi.typical.hours} (typisch für ${poi.typical.chain})` : '');

/**
 * Punkte unterwegs in Reihenfolge der Strecke: [{along, eta, kind, name, note}]. `eta` fehlt, wenn die Abfahrt
 * nicht festgelegt ist (dann gibt es auch keine geplanten Stopps).
 */
function waypointsOf(r, at) {
  const items = [];
  for (const s of r.stops || []) {
    items.push({ along: s.along, eta: s.eta, kind: s.typeLabel, name: s.poi.name || s.typeLabel,
      note: [STATE_LABELS[s.state], hoursOf(s.poi)].filter(Boolean).join(' · ') });
  }
  for (const w of r.water || []) {
    items.push({ along: w.along, eta: w.eta, kind: 'Trinkwasser', name: w.poi.name || 'Trinkwasserstelle',
      note: `${STATE_LABELS[w.state]} · ${formatM(w.offset)} neben der Route` });
  }
  const along = locateOnRoute(r, r.waypoints);
  r.waypoints.forEach((p, i) => {
    if (!p.manual) return;
    items.push({ along: along[i], eta: at?.(along[i]), kind: p.food ? 'Fester Verpflegungsstopp' : 'Zwischenstopp', name: p.label || 'Zwischenstopp', note: '' });
  });
  return items.sort((a, b) => a.along - b.along);
}

function dayBlock(r, stat, times, items, night, fixed, last, top) {
  const block = el('section', '', 'rb-day');
  const head = el(`h${top + 1}`,`${times ? `Tag ${stat.day} · ${formatDayDate(times.start)}` : `Tag ${stat.day}`}`);
  block.append(head, el('p', `${formatKm(stat.distance)} · ${formatM(stat.ascent)} Anstieg · Fahrzeit ca. ${formatDuration(stat.time)} · km ${km(stat.from)}–${km(stat.to)}`, 'rb-facts'));
  if (fixed) {
    block.append(el('p', `Abfahrt ${formatClock(times.start)} · Ankunft ca. ${formatClock(times.end)}${r.stops?.length ? ' (mit Pausen an den Stopps)' : ''}`));
    const light = daylightNote(times, r.coords[indexAtDistance(r, stat.from)], r.coords[indexAtDistance(r, stat.to)]);
    if (light) block.append(el('p', light.text, light.warn ? 'rb-warn' : ''));
  }
  const climbs = findClimbs(r, 50).filter(c => c.from >= stat.from && c.from < stat.to).sort((a, b) => b.gain - a.gain).slice(0, 3)
    .sort((a, b) => a.from - b.from);
  if (climbs.length) {
    block.append(el('p', 'Größte Anstiege: ' + climbs.map(c => `km ${km(c.from)}–${km(c.to)} (${formatM(c.gain)}, Ø ${pct(c.mean)} %)`).join(' · ')));
  }

  const rows = items.filter(it => it.along >= stat.from && (it.along < stat.to || (last && it.along <= stat.to)));
  if (rows.length) {
    const table = el('table');
    const tr = el('tr');
    for (const h of ['km', 'Ankunft', 'Art', 'Name', 'Öffnungszeiten / Hinweis']) { const th = el('th', h); th.scope = 'col'; tr.append(th); }
    table.append(el('caption', `Punkte unterwegs an Tag ${stat.day}`, 'sr-only'), tr);
    for (const it of rows) {
      const row = el('tr');
      row.append(el('td', km(it.along)), el('td', it.eta ? formatClock(it.eta) : '–'), el('td', it.kind), el('td', it.name), el('td', it.note));
      table.append(row);
    }
    block.append(table);
  } else {
    block.append(el('p', 'Keine Stopps an diesem Tag geplant.', 'rb-muted'));
  }

  const inDay = g => g.from < stat.to && g.to > stat.from;
  for (const g of (r.gaps || []).filter(inDay)) {
    block.append(el('p', `Zwischen km ${Math.round(g.from / 1000)} und ${Math.round(g.to / 1000)} wurde keine passende, geöffnete Verpflegungsstelle gefunden.`, 'rb-warn'));
  }
  for (const g of (r.waterGaps || []).filter(inDay)) {
    block.append(el('p', `Keine öffentliche Trinkwasserstelle zwischen km ${Math.round(g.from / 1000)} und ${Math.round(g.to / 1000)}.`, 'rb-warn'));
  }

  if (night) {
    const c = night.chosen;
    const stay = el('div', '', 'rb-stay');
    stay.append(el(`h${top + 2}`, night.end ? 'Übernachtung am Ziel' : `Übernachtung nach Tag ${stat.day}`));
    if (!c) {
      stay.append(el('p', 'Keine Unterkunft gewählt.'));
    } else {
      const t = c.poi.tags;
      const place = [t['addr:postcode'], t['addr:city'] || t['addr:place']].filter(Boolean).join(' ');
      stay.append(el('p', `${c.poi.name || STAY_TYPES[c.poi.type].label} · ${STAY_TYPES[c.poi.type].label}${place ? ' · ' + place : ''}`, 'rb-name'));
      stay.append(el('p', [`Preis ${priceLabel(c.price)} (Schätzung)`, t.phone || t['contact:phone'], websiteOf(c.poi)].filter(Boolean).join(' · ')));
    }
    block.append(stay);
  }
  return block;
}

/**
 * Übersicht für die aktuelle Route in `box` aufbauen → true, wenn es etwas zu zeigen gibt. `top` ist die Ebene
 * der obersten Überschrift (Routenname): 1 im Druck, 2 im Dialog unter dessen eigener Überschrift.
 */
export function buildRoadbook(box = $('#roadbook'), top = 1) {
  const r = state.route;
  if (!r) { box.replaceChildren(); return false; }
  // Zeiten nur, wenn die Abfahrt sichtbar festgelegt ist (Verpflegungsstopps oder Mehrtagestour)
  const fixed = state.supply.enabled || state.multiDay;
  const departure = departureDate();
  const stats = stageStats(r, state.bike);
  const times = fixed ? dayTimes(r, departure, state.bike) : null;
  const items = waypointsOf(r, fixed ? pausedTimeline(r, departure, state.bike) : null);
  const nights = r.stays?.nights || [];

  const header = el('header');
  header.append(el(`h${top}`, gpxName()));
  const period = !fixed ? '' : stats.length > 1 ? `${formatDayDate(times[0].start)} – ${formatDayDate(times.at(-1).start)}` : formatDayDate(times[0].start);
  header.append(el('p', [BIKE_LABELS[state.bike], formatKm(r.distance), `${formatM(r.ascent)} Anstieg`,
    `Fahrzeit ca. ${formatDuration(stats.reduce((sum, s) => sum + s.time, 0))}`, stats.length > 1 ? `${stats.length} Tage` : '', period]
    .filter(Boolean).join(' · '), 'rb-facts'));
  if (r.dwellMin && r.stops?.length) header.append(el('p', `Ankunftszeiten inkl. ${r.dwellMin} min Pause je Stopp.`, 'rb-muted'));

  box.replaceChildren(header,
    ...stats.map((s, i) => dayBlock(r, s, times?.[i], items, nights[i], fixed, i === stats.length - 1, top)),
    el('footer', `Erstellt mit CycloRouter am ${formatDate(new Date())}. Daten © OpenStreetMap-Mitwirkende. Öffnungszeiten und Preise ohne Gewähr.`));
  return true;
}

const root = document.documentElement;
// Auch bei Strg+P: mit Route das Roadbook, ohne Route die Seite wie bisher
window.addEventListener('beforeprint', () => root.classList.toggle('print-roadbook', buildRoadbook()));
window.addEventListener('afterprint', () => root.classList.remove('print-roadbook'));

// Die installierte App auf iPhone/iPad (vom Home-Bildschirm, navigator.standalone gibt es nur dort) hat keinen
// Druckdialog: window.print() tut nichts, ohne Fehler (auf dem iPhone geprüft). Dort zeigt der Knopf das Roadbook
// im Dialog, gebaut in #roadbook-view; #roadbook bleibt für den Druck unberührt direkt unter <body>.
// Die App hat ihren eigenen Speicher, getrennt von Safari: Die Route kommt nur über einen Link oder „Meine
// Routen“ dorthin, das sagt der Hinweis.
const standalone = navigator.standalone === true;
const button = $('#btn-roadbook'), dialog = $('#roadbook-dialog'), view = $('#roadbook-view');
if (standalone) {
  button.textContent = 'Roadbook anzeigen';
  button.title = 'Übersicht: je Tag Zeiten, Stopps mit Öffnungszeiten und Unterkunft – drucken lässt sie sich in Safari';
}
dialog.addEventListener('close', () => view.replaceChildren());
// Stopps, Unterkünfte und Feiertage kommen oft erst nach dem Öffnen: dann neu bauen
on('route', r => {
  if (!dialog.open) return;
  if (r) buildRoadbook(view, 2); else dialog.close();
});

button.addEventListener('click', () => {
  if (standalone) {
    if (!buildRoadbook(view, 2)) return;
    $('#roadbook-hint').textContent = account.enabled
      ? 'Drucken und als PDF sichern geht nur in Safari. Dorthin kommt die Route über „Link teilen“ oder über „Meine Routen“, wenn du in Safari angemeldet bist.'
      : 'Drucken und als PDF sichern geht nur in Safari; dort muss die Route neu geplant werden.';
    dialog.showModal();
    dialog.scrollTop = 0;
    return;
  }
  if (!buildRoadbook()) return;
  root.classList.add('print-roadbook');
  window.print();
});
