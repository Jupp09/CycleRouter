/**
 * Route als Link, ohne Konto: Die Adresse trägt hinter „#“ alles, was zum Neuberechnen nötig ist – Modus,
 * Fahrrad, Verkehr, EuroVelo, Start, Ziel und Zwischenstopps (5 Nachkommastellen, kurzer Name, damit das
 * Öffnen keine Adresssuche braucht), bei Distanz/Rundkurs Länge, Richtung und Saat (derselbe Rundkurs),
 * Verpflegung mit Abstand, Mehrtagestour und den Routennamen. Beispiel:
 *
 *   #v=1&m=ab&b=trekking&s=50.94000,6.95000,Köln&w=50.85000,7.00000,Bäckerei,1&z=50.73000,7.10000,Bonn&f=30
 *
 * Bewusst nicht enthalten: die Abfahrtszeit (passt beim Empfänger selten), der Routing-Dienst (ORS braucht
 * einen eigenen Schlüssel) und die gewählten Unterkünfte (werden neu geplant). Importierte GPX-Strecken passen
 * nicht in eine Adresse; die teilt nur der Konto-Link (routesView.js).
 *
 * Der Teil hinter „#“ wird nie an den Server geschickt – die Orte landen in keinem Server-Log. Nach jeder
 * angezeigten Route wird die Adresse ersetzt (kein neuer Eintrag im Verlauf), so behalten Neuladen und
 * Lesezeichen die Route.
 */
import { MODES, BIKES } from '../shared.js';
import { clampInt } from '../utils.js';
import { account } from '../account.js';
import { state, on, defaultName, clampDuration } from './state.js';
import { $, ui, isMobile, setStatus, flashStatus } from './dom.js';
import { applyRouteSettings, syncUi } from './controls.js';
import { setRoutePoints } from './waypoints.js';
import { calcAB, generate } from './pipeline.js';

const VERSION = '1';
const TRAFFIC = ['normal', 'low', 'verylow'];
const EUROVELO = ['off', 'prefer', 'strong'];
const DIRECTIONS = ['random', '0', '45', '90', '135', '180', '225', '270', '315'];

/** Kurzer Name eines Orts (bis zum ersten Komma) – Kommas trennen im Link die Teile eines Punkts. */
const shortLabel = label => String(label || '').split(',')[0].trim().slice(0, 60);
const point = (p, food = false) => [p.lat.toFixed(5), p.lon.toFixed(5), shortLabel(p.label), food ? '1' : '']
  .join(',').replace(/,+$/, '');

/** Route aus einer importierten GPX-Strecke (auch mit Stopps oder Unterkünften darauf)? */
export const isTrackRoute = r => !!(r && (r.track || r.origin?.track || r.base?.track));

/** Link zur aktuellen Route oder null (keine Route, GPX-Strecke). */
function encodeLink() {
  const r = state.route;
  if (!r || !state.start || isTrackRoute(r)) return null;
  const q = new URLSearchParams({ v: VERSION, m: state.mode, b: state.bike });
  if (state.traffic !== 'normal') q.set('t', state.traffic);
  if (state.eurovelo !== 'off') q.set('e', state.eurovelo);
  q.set('s', point(state.start));
  if (state.mode === 'ab') {
    if (!state.end) return null;
    for (const v of state.vias) if (v.lat != null) q.append('w', point(v, v.food));
    q.set('z', point(state.end));
  } else {
    q.set('d', state.distanceKm);
    // Rundkurs nach Fahrzeit: Wunschzeit in Minuten (sonst erzeugte der Empfänger einen Rundkurs nach km)
    if (state.mode === 'loop' && state.loopBy === 'time') q.set('dt', String(state.durationMin));
    q.set('r', state.direction);
    q.set('x', String(state.seed));
  }
  if (state.supply.enabled) q.set('f', state.supply.intervalKm);
  if (state.multiDay) q.set('md', '1');
  const name = ui.routeName.value.trim();
  if (name && name !== defaultName(r)) q.set('n', name.slice(0, 120));
  return `${location.origin}${location.pathname}#${q}`;
}

/** Adresszeile auf den aktuellen Stand bringen (ohne Route bzw. bei GPX-Strecken ohne „#…“). */
function updateAddress() {
  const url = encodeLink() ?? location.pathname + location.search;
  if (new URL(url, location.href).href !== location.href) history.replaceState(null, '', url);
}

function parsePoint(text) {
  const [la, lo, label = '', food] = String(text ?? '').split(',');
  const lat = Number(la), lon = Number(lo);
  if (!la || !lo || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw new Error('Punkt');
  return { lat, lon, ...(label && { label }), food: food === '1' };
}


/**
 * Beim Start: Link aus der Adresse übernehmen und die Route berechnen → true, wenn einer da war.
 * Nach initHome() aufrufen (main.js), damit der Link die Heimatadresse als Start überschreibt.
 */
export function openLinkFromUrl() {
  const raw = location.hash.slice(1);
  if (!raw.startsWith('v=')) return false;
  const q = new URLSearchParams(raw);
  try {
    const mode = q.get('m'), bike = q.get('b');
    if (q.get('v') !== VERSION || !MODES.includes(mode) || !BIKES.includes(bike)) throw new Error('Kopf');
    const start = parsePoint(q.get('s'));
    delete start.food;
    const end = mode === 'ab' ? parsePoint(q.get('z')) : null;
    if (end) delete end.food;
    const vias = mode === 'ab' ? q.getAll('w').map(parsePoint).map(({ food, ...p }) => ({ label: '', ...p, manual: true, ...(food && { food: true }) })) : [];

    applyRouteSettings({ mode, bike, traffic: TRAFFIC.includes(q.get('t')) ? q.get('t') : 'normal', eurovelo: EUROVELO.includes(q.get('e')) ? q.get('e') : 'off' });
    if (mode !== 'ab') {
      state.distanceKm = clampInt(q.get('d'), 5, 400, state.distanceKm);
      // Nur für diese Route, nicht als eigene Einstellung gespeichert (wie die Verpflegung unten)
      if (mode === 'loop') {
        state.loopBy = q.has('dt') ? 'time' : 'distance';
        if (q.has('dt')) state.durationMin = clampDuration(q.get('dt'));
      }
      state.direction = DIRECTIONS.includes(q.get('r')) ? q.get('r') : 'random';
      state.seed = clampInt(q.get('x'), 0, 2 ** 31, state.seed);
    }
    // Verpflegung nur für diese Route, nicht als eigene Einstellung gespeichert
    state.supply.enabled = q.has('f');
    if (q.has('f')) state.supply.intervalKm = clampInt(q.get('f'), 10, 200, state.supply.intervalKm);
    state.multiDay = q.get('md') === '1';
    state.loadedName = q.get('n') || null;
    syncUi();
    setRoutePoints(start, end, vias);
    if (mode === 'ab') calcAB(); else generate();
  } catch {
    history.replaceState(null, '', location.pathname + location.search);
    setStatus('Dieser Link ist unvollständig – bitte Start und Ziel neu wählen.', 'error');
  }
  return true;
}

/** Link teilen (Handy: Teilen-Menü) bzw. in die Zwischenablage kopieren – ohne Konto. */
export async function shareLink() {
  const url = encodeLink();
  if (!url) return;
  updateAddress();
  const title = ui.routeName.value.trim() || defaultName(state.route);
  if (isMobile && navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    flashStatus('Link kopiert – wer ihn öffnet, sieht die Route (ohne Konto). Er steht auch in der Adresszeile.');
  } catch {
    flashStatus('Der Link zur Route steht in der Adresszeile – von dort kopieren.');
  }
}

/** Knopf „Link teilen“: angemeldet teilt routesView.js den Konto-Link, sonst gilt dieser Link. */
function renderShareButton() {
  const r = state.route;
  const server = account.enabled && !!account.user && !account.offline;
  const blocked = isTrackRoute(r) && !server;
  const btn = $('#btn-share-link');
  btn.disabled = !r || blocked;
  btn.title = server
    ? 'Link erzeugen, über den andere (oder dein Handy) die Route öffnen können – mit „zurückziehen“ wieder ungültig'
    : 'Link zur Route kopieren bzw. teilen – ohne Konto; er steht auch in der Adresszeile';
  const hint = $('#share-hint');
  hint.hidden = !(r && blocked);
  hint.textContent = account.enabled
    ? 'Importierte Strecken lassen sich mit Konto teilen (unter Einstellungen anmelden).'
    : 'Importierte Strecken passen nicht in einen Link – zum Weitergeben „GPX exportieren“.';
}

on('route', () => { updateAddress(); renderShareButton(); });
on('account', renderShareButton);
ui.routeName.addEventListener('input', () => { if (state.route) updateAddress(); });
