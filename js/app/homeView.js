/**
 * Heimatadresse: Standard-Startort (Haus-Knopf am Startfeld) und Feld im Einstellungsdialog.
 *
 * Vorrat für die Heimatregion: Der Server (server/warmQueue.mjs) lädt Verpflegungsstellen im Umkreis von
 * 200 km um den Heimatort in seinen gemeinsamen Cache – für alle Nutzer. Übermittelt werden nur auf ~10 km
 * gerundete Koordinaten, nie die Adresse.
 */
import { attachSearch } from '../geocode.js';
import { storage, formatInt } from '../utils.js';
import { state, emit } from './state.js';
import { $, ui, flashStatus } from './dom.js';
import { map, updateMarkers } from './mapView.js';
import { setPoint } from './waypoints.js';

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

// ---------- Einstellungsdialog ----------

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

/** Dialog öffnen: Feld füllen und anzeigen, wie weit der Vorrat auf dem Server ist. */
export function openHomeSettings() {
  pendingHome = getHome();
  homeInput.value = pendingHome?.label || '';
  $('#btn-home-from-start').disabled = !state.start;
  showWarmStatus();
}

/**
 * Dialog gespeichert: Heimat übernehmen (leeres Feld = entfernen) und – falls noch kein Start gesetzt ist –
 * gleich als Start nutzen. → die neue Heimat, wenn sie sich spürbar (~10 km) geändert hat, sonst null.
 */
export function saveHomeSettings() {
  const before = getHome();
  const home = homeInput.value.trim() ? pendingHome : null;
  storage.set('home', home);
  syncHomeButton();
  if (home && !state.start) useHomeAsStart();
  const moved = home && (!before || round1(before.lat) !== round1(home.lat) || round1(before.lon) !== round1(home.lon));
  return moved ? home : null;
}

/** Neue Heimatregion sofort beim Server vormerken und – ohne Route im Blick – das Ergebnis melden. */
export async function warmNewHome(home) {
  const data = await sendHomeToServer(home, { force: true });
  if (data && !state.route) flashStatus(warmMessage(data));
}

// ---------- Vorrat auf dem Server ----------

const WARM_API = new URL('api/warm', document.baseURI);
const WARM_RESEND = 7 * 24 * 3600 * 1000;
const round1 = v => Math.round(v * 10) / 10; // 0,1° ≈ 10 km – genauer erfährt der Server den Heimatort nicht

/** Ruft /api/warm auf; null, wenn kein Server-Cache verfügbar ist (statisches Hosting). */
async function warmApi(method, home) {
  const lat = round1(home.lat), lon = round1(home.lon);
  try {
    const res = method === 'GET'
      ? await fetch(`${WARM_API}?lat=${lat}&lon=${lon}`)
      : await fetch(WARM_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lon }) });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return await res.json();
  } catch { return null; }
}

function warmMessage(d) {
  const have = `${formatInt(d.total - d.missing)} von ${formatInt(d.total)} Kacheln vorhanden`;
  const region = `Verpflegungsstellen im Umkreis von ${d.radiusKm} km um die Heimat`;
  if (!d.missing || d.status === 'complete') return `${region} sind auf dem Server vorrätig (${formatInt(d.total)} Kacheln).`;
  if (d.status === 'rate-limited') return `Vorladen der Heimatregion wurde heute schon zu oft angefordert – bitte morgen erneut speichern (${have}).`;
  if (d.status === 'full') return `Der Server lädt gerade viele Regionen vor – bitte später erneut speichern (${have}).`;
  if (d.queued) {
    const where = d.position > 1 ? `warten in der Warteschlange (Platz ${d.position})` : 'werden gerade im Hintergrund geladen';
    return `${region} ${where} – ${have}.`;
  }
  return `${region}: ${have}.`;
}

/** Heimatregion beim Server vormerken – höchstens einmal pro Woche, außer bei neuer Heimat. */
async function sendHomeToServer(home, { force = false } = {}) {
  const key = `${round1(home.lat)},${round1(home.lon)}`;
  const last = storage.get('homeWarm', null);
  if (!force && last?.key === key && Date.now() - last.t < WARM_RESEND) return null;
  const data = await warmApi('POST', home);
  if (data) storage.set('homeWarm', { key, t: Date.now() });
  return data;
}

async function showWarmStatus() {
  const el = $('#home-warm-hint');
  const home = getHome();
  el.hidden = true;
  if (!home) return;
  const data = await warmApi('GET', home);
  if (!data || getHome()?.label !== home.label) return; // Dialog inzwischen mit anderer Heimat gespeichert
  el.textContent = warmMessage(data);
  el.hidden = false;
}

// ---------- Start ----------

/** Beim Start: Heimat als Startort setzen (ohne Berechnung) und den Vorrat auf dem Server auffrischen. */
export function initHome() {
  syncHomeButton();
  const home = getHome();
  if (!home) return;
  state.start = { lat: home.lat, lon: home.lon, label: home.label };
  emit('start');
  ui.startInput.value = home.label;
  map.flyTo(home);
  updateMarkers();
  // z. B. wenn die Heimat gespeichert wurde, bevor der Server-Cache existierte – höchstens wöchentlich
  sendHomeToServer(home);
}
