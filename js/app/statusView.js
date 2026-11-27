/**
 * „Serverstatus“ (nur für Konten in ADMIN_USERS): Betriebszahlen des Servers (GET /api/admin/status,
 * server/status.mjs) – Stand des Datenauszugs, eigener BRouter (Antwortzeiten, Abbrüche, Warteschlange), mit
 * welchem Dienst die Browser ihre Routen bekamen (Anteil Valhalla, zu lange Strecken) und die Browserfehler.
 * Bisher stand das nur im Server-Log. Erreichbar in den Einstellungen unter „Verwaltung“.
 */
import { account, adminStatus } from '../account.js';
import { formatDate, formatClock, formatNumber } from '../utils.js';
import { on } from './state.js';
import { $, $$, el } from './dom.js';

const dialog = $('#status-dialog');

on('account', () => {
  $('#admin-settings').hidden = !account.user?.admin || !!account.offline;
});

const when = t => `${formatDate(new Date(t))} ${formatClock(new Date(t))}`;
const sec = ms => (ms == null ? '–' : `${formatNumber(ms / 1000, { maximumFractionDigits: ms < 10000 ? 1 : 0 })} s`);
const pct = (n, total) => (total ? `${Math.round(n / total * 100)} %` : '–');

/** „3 Tage 4 h“, „2 h 10 min“, „5 min“ */
function ago(ms) {
  const min = Math.round(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (d) return `${d} ${d === 1 ? 'Tag' : 'Tagen'}${h % 24 ? ` ${h % 24} h` : ''}`; // „seit/vor 3 Tagen“
  if (h) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `${min} min`;
}

function section(title, ...children) {
  const s = el('section', 'status-section');
  s.append(el('h3', '', title), ...children);
  return s;
}

/** Tabelle: Zeilen = Kennzahlen, Spalten = Zeiträume (letzte Stunde, 24 h, 7 Tage) */
function table(caption, rows) {
  const t = el('table', 'status-table');
  const cap = el('caption', 'sr-only', caption);
  const head = el('tr');
  for (const h of ['Kennzahl', 'letzte Stunde', '24 h', '7 Tage']) {
    const th = el('th', '', h);
    th.scope = 'col';
    head.append(th);
  }
  head.firstChild.replaceChildren(el('span', 'sr-only', 'Kennzahl')); // Ecke: nur für Screenreader benannt, sichtbar leer
  const thead = el('thead'), tbody = el('tbody');
  thead.append(head);
  for (const [label, ...cells] of rows) {
    const tr = el('tr');
    const th = el('th', '', label);
    th.scope = 'row';
    tr.append(th, ...cells.map(c => el('td', '', String(c))));
    tbody.append(tr);
  }
  t.append(cap, thead, tbody);
  return t;
}

const WINDOWS = ['hour', 'day', 'week'];

function serverPart(s, now) {
  const p = el('p', '', `Läuft seit ${ago(now - s.startedAt)} (Start ${when(s.startedAt)}) · Prozess ${s.pid} · Node ${s.node} · `
    + `Speicher ${formatNumber(Math.round(s.rss / 1e6))} MB`);
  const since = el('p', 'hint', `Zahlen liegen seit ${when(s.dataSince)} vor (höchstens 7 Tage; über Neustarts hinweg gesichert).`);
  return section('Server', p, since);
}

function extractPart(x, now) {
  if (!x) return section('Datenauszug Europa', el('p', 'hint', 'Keine Angaben.'));
  if (!x.enabled) return section('Datenauszug Europa', el('p', '', 'Abgeschaltet (POI_EXTRACT_URL=off).'));
  const parts = [];
  if (x.t) {
    const age = now - x.t;
    const p = el('p', age > 10 * 86400000 ? 'warn' : '', `Stand vom ${formatDate(new Date(x.t))} (vor ${ago(age)}) · `
      + `${formatNumber(x.cells)} Zellen${x.regions ? ` aus ${x.regions} Regionen` : ''}`);
    parts.push(p);
    if (x.counts) {
      parts.push(el('p', 'hint', Object.entries(x.counts).map(([l, n]) => `${l} ${formatNumber(n)}`).join(' · ')));
    }
  } else {
    parts.push(el('p', 'warn', 'Noch kein Auszug vorhanden – Orte kommen von Overpass.'));
  }
  if (x.updating) parts.push(el('p', '', 'Wird gerade aktualisiert …'));
  if (x.lastCheck) {
    parts.push(el('p', x.lastCheck.ok ? '' : 'warn',
      `Zuletzt geprüft ${when(x.lastCheck.at)}: ${x.lastCheck.ok ? x.lastCheck.note : `fehlgeschlagen – ${x.lastCheck.note}`}`));
  } else {
    parts.push(el('p', 'hint', 'Seit dem Start noch nicht geprüft (erste Prüfung 1 min nach dem Start, dann alle 12 h).'));
  }
  return section('Datenauszug Europa', ...parts);
}

function brouterPart(b, stats) {
  if (!b?.enabled) return section('Eigener BRouter', el('p', '', 'Nicht eingerichtet (BROUTER_URL) – alle Routen rechnet brouter.de.'));
  const live = el('p', b.downUntil ? 'warn' : '', b.downUntil
    ? `Gerade nicht erreichbar – Anfragen gehen bis ${formatClock(new Date(b.downUntil))} an brouter.de.`
    : `Gerade ${b.active} von ${b.parallel} ${b.parallel === 1 ? 'Platz' : 'Plätzen'} belegt, ${b.waiting} wartend.`);
  const row = (label, key) => [label, ...WINDOWS.map(w => stats[w].outcomes[key] || 0)];
  const rows = [
    ['Anfragen', ...WINDOWS.map(w => stats[w].count)],
    row('beantwortet', 'ok'),
    row('abgelehnt (Punkt nicht erreichbar)', 'rejected'),
    row('Fehler von BRouter', 'error'),
    row('nicht erreichbar', 'unreachable'),
    row('Warteschlange voll', 'full'),
    row('abgebrochen (Browser wartete nicht mehr)', 'gone'),
    ['Dauer Median', ...WINDOWS.map(w => sec(stats[w].median))],
    ['Dauer 95 %', ...WINDOWS.map(w => sec(stats[w].p95))],
    ['längste', ...WINDOWS.map(w => sec(stats[w].max))],
  ];
  const note = el('p', 'hint', '„Abgebrochen“ heißt meist: Das Zeitlimit des Webservers vor der App (nginx) war erreicht, '
    + 'bevor BRouter fertig war – typisch für sehr lange Strecken. Der Browser rechnet dann mit brouter.de weiter.');
  return section('Eigener BRouter', live, table('Anfragen an den eigenen BRouter', rows), note);
}

function routesPart(stats) {
  const r = WINDOWS.map(w => stats[w]);
  const share = key => r.map(s => (s.servers[key] ? `${s.servers[key]} (${pct(s.servers[key], s.ok)})` : '0'));
  const failed = key => r.map(s => s.failed[key] || 0);
  const rows = [
    ['Grundrouten', ...r.map(s => s.count)],
    ['mit eigenem BRouter', ...share('own')],
    ['mit brouter.de', ...share('brouter.de')],
    ['mit Valhalla (Ausweich)', ...share('valhalla')],
    ['mit OpenRouteService', ...share('ors')],
    ['gescheitert: zu lang', ...failed('tooLong')],
    ['gescheitert: ausgelastet', ...failed('busy')],
    ['gescheitert: Punkt nicht erreichbar', ...failed('notRoutable')],
    ['gescheitert: sonstiges', ...failed('other')],
    ['Dauer Median', ...r.map(s => sec(s.median))],
  ];
  const note = el('p', 'hint', 'Von den Browsern gemeldet, je berechneter Grundroute (ohne Orte). Eine Route kann mehrere '
    + 'Dienste haben, wenn Teilstücke ausweichen mussten.');
  return section('Routen', table('Grundrouten nach Dienst', rows), note);
}

function errorsPart(list) {
  if (!list.length) return section('Browserfehler', el('p', 'hint', 'Keine Fehler gemeldet.'));
  const ul = el('ul', 'status-errors');
  for (const e of list) {
    const li = el('li');
    li.append(el('code', '', `${e.count}× ${e.kind === 'Promise' ? 'Promise: ' : ''}${e.message}`),
      el('p', 'hint', [e.where, `zuletzt ${when(e.last)}`, e.count > 1 ? `zuerst ${when(e.first)}` : '',
        e.browsers.map(b => `${b.name} ${b.n}×`).join(', ')].filter(Boolean).join(' · ')));
    ul.append(li);
  }
  return section('Browserfehler (zuletzt gesehene zuerst)', ul);
}

async function load() {
  const msg = $('#status-msg');
  msg.textContent = 'Wird geladen …';
  msg.classList.remove('error');
  try {
    const s = await adminStatus();
    $('#status-content').replaceChildren(serverPart(s.server, s.now), extractPart(s.extract, s.now),
      brouterPart(s.brouter, s.brouterStats), routesPart(s.routes), errorsPart(s.clientErrors));
    msg.textContent = `Stand ${formatClock(new Date(s.now))}`;
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  }
}

$('#btn-status').addEventListener('click', () => {
  dialog.showModal();
  load();
});
$('#btn-status-refresh').addEventListener('click', load);
for (const b of $$('#status-dialog [data-close]')) b.addEventListener('click', () => dialog.close());
