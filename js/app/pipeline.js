/**
 * Berechnungsablauf: Route berechnen bzw. erzeugen, anzeigen und schrittweise ergänzen.
 *
 *   Grundroute ─▶ (Mehrtagestour: Unterkünfte, Route durch sie) ─▶ (Verpflegungsstopps, Route durch sie)
 *                                                                  ─▶ (Feiertage angewendet, ggf. neu geplant)
 *
 * Nach jedem Schritt wird die Route angezeigt, sie ist also nutzbar, bevor die Suche nach Unterkünften
 * oder Stopps fertig ist. Jeder Schritt liefert eine *neue* Route, die die vorige behält (route.origin,
 * route.base – siehe CLAUDE.md). Eine neue Berechnung bricht die laufende ab; AbortError wird still
 * verschluckt.
 */
import { route, onRoutingNotice } from '../routing/index.js';
import { generateLoop, generateOneWay } from '../generators.js';
import { addStops, holidayContext, applyHolidays } from '../stops.js';
import { warmRoute } from '../poiTiles.js';
import { announce } from '../announce.js';
import { isMultiDayCandidate, planStays, routeThroughStays } from '../stays.js';
import { seededRandom } from '../utils.js';
import { state, emit, provider, routeOpts, departureDate, activeVias, originRoute } from './state.js';
import { setStatus } from './dom.js';
import { map, relayout, drawRouteLine, updateMarkers } from './mapView.js';
import { setPoint } from './waypoints.js';
import { routeSummary } from './resultsView.js';

let controller = null;

/**
 * Zeitmessung einer Berechnung je Schritt – erscheint in der Browser-Konsole, z. B.
 * „Berechnung: Grundroute 1,2 s · Orte laden 0,3 s · Stopps planen 0,05 s · Route durch Stopps 0,9 s … · gesamt 2,6 s“.
 * Grundlage, um zu entscheiden, wo sich Optimierung lohnt. Nur für fertige (nicht abgebrochene) Berechnungen.
 */
function stopwatch() {
  const t0 = performance.now();
  let last = t0;
  const parts = [];
  const sec = ms => `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: ms < 100 ? 2 : 1 })} s`;
  return {
    /** Abschnitt seit der letzten Marke abschließen. */
    mark(label) { const now = performance.now(); parts.push(`${label} ${sec(now - last)}`); last = now; },
    /** Parallel gelaufener Schritt mit eigener Dauer (z. B. Feiertagsprüfung). */
    add(label, ms) { parts.push(`${label} ${sec(ms)} (parallel)`); },
    done() { console.info(`Berechnung: ${[...parts, `gesamt ${sec(performance.now() - t0)}`].join(' · ')}`); },
  };
}

// Hinweise der Routing-Schicht (z. B. „BRouter ist ausgelastet – neuer Versuch in 2 s …“) während einer Berechnung zeigen
onRoutingNotice(text => { if (controller && !controller.signal.aborted) setStatus(text, 'loading'); });

/** Laufende Berechnung (inkl. Unterkunfts- und Stoppsuche) abbrechen. */
export function abortCalculation() {
  controller?.abort();
}

// ---------- Anzeige ----------

/**
 * Route auf Karte und im Panel zeigen. Karte und Marker werden hier gesetzt; alles Weitere (Kennzahlen,
 * Höhenprofil, Stopps, Etappen, Speichern …) erledigen die Ansichten über das Ereignis 'route'.
 */
export function showRoute(r, { fit = true } = {}) {
  state.route = r;
  drawRouteLine();
  updateMarkers();
  emit('route', r);
  relayout();
  if (fit) map.fitRoute(r.coords);
}

/** Route verwerfen – samt Bezug zu einer gespeicherten Route und Mehrtagesplanung. */
export function clearRoute() {
  abortCalculation();
  Object.assign(state, {
    route: null, saved: null, loadedName: null,
    multiDay: false, stayChoices: [], staysLoading: false, staysError: null,
  });
  map.setRoute(null);
  setStatus(null);
  emit('route', null);
  updateMarkers();
  relayout();
}

// ---------- Ablauf ----------

/**
 * Berechnung ausführen: `task(signal)` liefert die Grundroute; danach – je nach Einstellung – Mehrtagestour
 * und Verpflegungsstopps. Fehler eines Ergänzungsschritts lassen die bis dahin berechnete Route stehen.
 */
export async function run(task, { loadingText = 'Route wird berechnet …', fit = true } = {}) {
  controller?.abort();
  const ctrl = controller = new AbortController();
  const { signal } = ctrl;
  state.staysLoading = false; // eine abgebrochene Unterkunftssuche darf den Knopf nicht gesperrt lassen
  setStatus(loadingText, 'loading');
  const watch = stopwatch();
  try {
    let r = await task(signal);
    if (signal.aborted) return;
    watch.mark('Grundroute');
    setStatus(null);
    showRoute(r, { fit });
    watch.mark('Anzeige');
    warmRoute(r); // Server lädt Orte entlang der Route vor (für Stopps, Suche, Mehrtagestour)

    // Mehrtagestour (nur auf Wunsch): Unterkünfte suchen und die Route durch sie führen
    if (state.multiDay && isMultiDayCandidate(r, state.stays.maxKm)) {
      setStatus('Unterkünfte für die Übernachtungen werden gesucht …', 'loading');
      state.staysLoading = true;
      state.staysError = null;
      emit('stages');
      try {
        r = await withStays(r, signal);
        if (signal.aborted) return;
        watch.mark('Unterkünfte');
        setStatus(null);
        state.staysLoading = false;
        showRoute(r, { fit: false });
      } catch (e) {
        if (e.name === 'AbortError' || signal.aborted) return;
        console.error(e);
        state.staysLoading = false;
        state.staysError = `Unterkünfte konnten nicht gesucht werden: ${e.message}`;
        setStatus(state.staysError, 'error');
        emit('stages');
      } finally {
        if (controller === ctrl) state.staysLoading = false;
      }
    }
    if (!state.supply.enabled) { announce(routeSummary(r)); watch.done(); return; }

    // Route steht schon auf der Karte; Stopps werden nachgeladen und die Route dann durch sie geführt
    setStatus('Verpflegungsstopps werden gesucht … (die Route ist bereits nutzbar)', 'loading');
    // Feiertagsprüfung parallel starten – sie ist langsam (Nominatim, 1 Anfrage/s), die Stopps warten nicht darauf
    const tHoliday = performance.now();
    const holidays = holidayContext(r, departureDate(), state.bike, signal);
    holidays.catch(() => {}); // ein Abbruch wird unten behandelt
    let holidayMs = null;
    holidays.then(() => { holidayMs = performance.now() - tHoliday; }, () => {});
    try {
      let withStops = await withSupply(r, signal, null, watch.mark);
      if (signal.aborted) return;
      setStatus(null);
      showRoute(withStops, { fit: false });
      watch.mark('Anzeige');
      announce(routeSummary(withStops)); // Screenreader: jetzt ist die Route mit Stopps fertig

      // Feiertage anwenden: meist ist keiner – dann bleiben die Stopps und bekommen nur ihre Regionen
      const ctx = await holidays;
      if (signal.aborted) return;
      watch.mark('Warten auf Feiertage');
      watch.add('Feiertagsprüfung', holidayMs ?? 0);
      const annotated = applyHolidays(withStops, ctx);
      if (annotated) { showRoute(annotated, { fit: false }); watch.done(); return; }
      setStatus('Feiertag auf der Strecke – Verpflegungsstopps werden angepasst …', 'loading');
      withStops = await withSupply(r, signal, ctx);
      if (signal.aborted) return;
      watch.mark('Neuplanung wegen Feiertag');
      setStatus(null);
      showRoute(withStops, { fit: false });
      announce(`Wegen eines Feiertags angepasst. ${routeSummary(withStops)}`);
      watch.done();
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) return;
      console.error(e);
      setStatus(e.message, 'error');
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    setStatus(e.message, 'error');
  }
}

/**
 * Route (mit oder ohne Übernachtungen, ohne Stopps) um Verpflegungsstopps ergänzen.
 * `holidays`: Ergebnis der Feiertagsprüfung (holidayContext) – ohne wird zunächst ohne Feiertage geplant.
 * `mark`: optional, Zeitmarke je Teilschritt (stopwatch).
 */
function withSupply(base, signal, holidays = null, mark = undefined) {
  return addStops(base, {
    provider: provider(), opts: routeOpts(), bike: state.bike, signal, holidays, mark,
    interval: state.supply.intervalKm * 1000, style: state.supply.style,
    departure: departureDate(),
  });
}

/** Route ohne Übernachtungen und Stopps um Etappen und Unterkünfte ergänzen; merkt sich die Auswahl je Nacht. */
async function withStays(origin, signal) {
  const plan = await planStays(origin, {
    maxKm: state.stays.maxKm, budget: state.stays.budget, groups: state.stays.groups,
    endStay: state.stays.endStay && state.mode !== 'loop', // Rundkurs endet zu Hause
    departure: departureDate(), choices: state.stayChoices, hidden: state.hiddenStays, signal,
  });
  state.stayChoices = plan.nights.map(n => n.chosen?.poi.id ?? null);
  return routeThroughStays(origin, plan, { provider: provider(), opts: routeOpts(), signal });
}

/** Übernachtungen und Stopps für die aktuelle Route neu planen, ohne die Route selbst neu zu erzeugen. */
export function replanStops() {
  const base = originRoute();
  if (base) run(async () => base, { fit: false, loadingText: 'Wird neu geplant …' });
}

// ---------- Einstiege je Modus ----------

/** A→B: Route über Start, Zwischenstopps und Ziel (ohne Ziel nur die Marker aktualisieren). */
export function calcAB() {
  if (!state.start || !state.end) { updateMarkers(); return; }
  run(signal => route(provider(), [state.start, ...activeVias(), state.end], routeOpts(), signal));
}

/** Distanz/Rundkurs: Route mit Wunschlänge in der gewählten (oder gewürfelten) Richtung erzeugen. */
export function generate() {
  if (!state.start) { setStatus('Bitte zuerst einen Startort wählen.', 'error'); return; }
  const bearing = state.direction === 'random' ? seededRandom(state.seed)() * 360 : Number(state.direction);
  const generator = state.mode === 'loop' ? generateLoop : generateOneWay;
  run(signal => generator({
    provider: provider(), start: state.start, distance: state.distanceKm * 1000, bearing, seed: state.seed,
    opts: routeOpts(), signal,
    onProgress: i => setStatus(`Suche passende ${state.mode === 'loop' ? 'Schleife' : 'Strecke'} … (Versuch ${i})`, 'loading'),
  }).then(r => {
    // Distanz-Modus: das gefundene Ende als Ziel eintragen
    if (state.mode === 'distance') setPoint('end', r.waypoints[r.waypoints.length - 1], { silent: true });
    return r;
  }));
}

/** Neu berechnen, nachdem sich Fahrrad, Verkehr, EuroVelo oder Dienst geändert haben. */
export function recalc() {
  if (!state.route) return;
  if (state.mode === 'ab') calcAB(); else generate();
}
