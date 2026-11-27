/**
 * App-Zustand und kleine Ereignis-Drehscheibe.
 *
 * `state` ist die einzige Quelle für Einstellungen und die aktuelle Route. Einstellungen werden beim Start
 * aus dem Browser-Speicher gelesen (storage in utils.js); Änderungen schreibt das jeweilige Bedienelement
 * zurück. Die Ansichten (js/app/*View.js) melden sich über `on()` für Ereignisse an, statt sich gegenseitig
 * aufzurufen:
 *
 *   'route'  (route | null)  neue Route angezeigt bzw. Route gelöscht
 *   'start'  ()              Startort geändert (z. B. Feiertagshinweis zur Abfahrt aktualisieren)
 *   'stages' ()              Zustand der Mehrtagestour geändert (Suche läuft, Fehler, …)
 *   'account' ()             Anmeldestand geändert (angemeldet, abgemeldet, gelöscht, Sitzung abgelaufen)
 */
import { providers } from '../routing/index.js';
import { hasElevation } from '../climbs.js';
import { storage, newSeed, toDateTimeLocal } from '../utils.js';
import { BIKES, MODES } from '../shared.js';

export const MODE_LABELS = { ab: 'Route', distance: 'Strecke', loop: 'Rundkurs' };
// „Trekking“ statt „Fahrrad“: Neben Rennrad, Gravel und E-Bike sagte „Fahrrad“ nichts (alles sind Fahrräder)
export const BIKE_LABELS = { road: 'Rennrad', gravel: 'Gravel', trekking: 'Trekking', ebike: 'E-Bike' };

/** Wunschfahrzeit für Rundkurse in Minuten: 30 min bis 10 h in Viertelstunden (Regler, Link, Konto-Abgleich). */
export function clampDuration(min) {
  const v = Math.round(Number(min) / 15) * 15;
  return Number.isFinite(v) ? Math.min(600, Math.max(30, v)) : 120;
}

/** Wird der Rundkurs nach Fahrzeit statt nach Länge erzeugt? (Einstellung „Rundkurs nach“, nur im Modus Rundkurs) */
export function loopByTime() {
  return state.mode === 'loop' && state.loopBy === 'time';
}

/** Gespeicherte Auswahl sichtbarer Werte (Einstellungen) – unbekannte verwerfen, leer = alle. */
const visibleOf = (key, all) => {
  const v = storage.get(key, null);
  const list = Array.isArray(v) ? all.filter(x => v.includes(x)) : [];
  return list.length ? list : [...all];
};

export const state = {
  // Routing
  bike: storage.get('bike', 'road'),              // 'road' | 'gravel' | 'trekking' | 'ebike'
  traffic: storage.get('traffic', 'normal'),      // nur Rennrad mit BRouter
  eurovelo: storage.get('eurovelo', 'off'),       // 'off' | 'prefer' | 'strong'
  avoidFerries: storage.get('avoidFerries', false) === true, // Fähren meiden (alle Dienste)
  provider: storage.get('provider', 'brouter'),   // Schlüssel in providers
  mode: storage.get('mode', 'ab'),                // 'ab' | 'distance' | 'loop'
  distanceKm: storage.get('distanceKm', 60),      // Wunschdistanz für Distanz/Rundkurs
  // Rundkurs nach Länge oder nach reiner Fahrzeit (Einstellung); Wunschfahrzeit in Minuten (30 min bis 10 h)
  loopBy: storage.get('loopBy', 'distance') === 'time' ? 'time' : 'distance',
  durationMin: clampDuration(storage.get('durationMin', 120)),
  direction: 'random',                            // Himmelsrichtung in Grad oder 'random'
  seed: newSeed(),                                // „Neu würfeln“ erzeugt eine neue Saat

  // In den Umschaltern angezeigte Fahrradtypen und Routenarten (Einstellungen, übersichtlichere Oberfläche)
  visibleBikes: visibleOf('visibleBikes', BIKES),
  visibleModes: visibleOf('visibleModes', MODES),

  // Anzeige
  breakdown: storage.get('breakdown', 'surface'), // 'surface' | 'waytype' | 'grade' – siehe activeBreakdown()
  colorRoute: storage.get('colorRoute', true),

  // Verpflegungsstopps
  supply: {
    enabled: storage.get('supplyEnabled', false),
    intervalKm: storage.get('supplyInterval', 30),
    style: storage.get('supplyStyle', 'fast'),    // Pausenstil: 'fast' | 'relaxed' (STYLES in stops.js)
    departure: defaultDeparture(),                // Wert eines datetime-local-Felds; auch Start der Mehrtagestour
  },
  departureSet: false,                            // Abfahrt im Formular angegeben (nur diese Sitzung) – departureFixed()

  // Mehrtagestouren: Einstellungen (Zahnrad), ob die aktuelle Route aufgeteilt ist, gewählte Unterkünfte je Nacht
  stays: {
    maxKm: storage.get('stageMaxKm', 100),
    budget: storage.get('nightBudget', 80),
    groups: storage.get('stayTypes', ['hotel', 'guest_house', 'hostel', 'camp_site']),
    endStay: storage.get('endStay', true),
  },
  hiddenStays: storage.get('hiddenStays', []),    // vom Nutzer ausgeblendete Unterkünfte (OSM-Kennungen)
  multiDay: false,                                // nur auf Knopfdruck
  stayChoices: [],                                // OSM-Kennung der gewählten Unterkunft je Nacht
  stageKm: [],                                    // vom Nutzer angepasste Länge je Tag in km (null = frei), stays.js
  staysLoading: false,
  staysError: null,

  // Wegpunkte
  /** @type {Waypoint | null} */
  start: null,                                    // {lat, lon, label}
  /** @type {Waypoint | null} */
  end: null,
  /** @type {Waypoint[]} */
  vias: [],                                       // A→B-Zwischenstopps {lat, lon, label, manual: true, icon?}; lat null = noch offen

  // Aktuelle Route (siehe CLAUDE.md: route.origin / route.base) und Bezug zu einer gespeicherten Route
  /** @type {Route | null} */
  route: null,
  saved: null,                                    // geöffnete eigene gespeicherte Route {id, name, shareToken}
  loadedName: null,                               // Name einer geöffneten gespeicherten/geteilten Route
  /** @type {Route | null} */
  track: null,                                    // importierter Weg (GPX, trackRoute) – siehe activeTrack()
};

// ---------- Ereignisse ----------

const listeners = new Map();

/** Für ein Ereignis anmelden (siehe Kopfkommentar). */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}

/** Ereignis an alle angemeldeten Ansichten melden – in Anmeldereihenfolge. */
export function emit(event, ...args) {
  for (const fn of listeners.get(event) || []) fn(...args);
}

// ---------- Abgeleitete Werte ----------

export function provider() {
  return providers[state.provider];
}

/** Optionen für provider.route(): Fahrradtyp, Verkehr, EuroVelo (nur wo der Dienst es kann), Fähren meiden. */
export function routeOpts() {
  return {
    bike: state.bike, traffic: state.traffic,
    eurovelo: provider().supportsEurovelo ? state.eurovelo : 'off',
    avoidFerries: state.avoidFerries,
  };
}

/** Nächste volle Viertelstunde, als Wert für <input type="datetime-local">. */
export function defaultDeparture() {
  return toDateTimeLocal(new Date(Math.ceil(Date.now() / 900000) * 900000));
}

/**
 * Gilt eine festgelegte Abfahrt? Dann rechnen Ankunft, Tageslicht, Wetter und Roadbook mit ihr, sonst mit „jetzt“
 * bzw. neutral (daylightToday), weil eine Warnung gegen „jetzt“ beim Planen am Abend nur stört. Festgelegt ist sie
 * mit Verpflegungsstopps, Mehrtagestour oder wenn sie im Formular angegeben wurde.
 */
export function departureFixed() {
  return state.supply.enabled || state.multiDay || state.departureSet;
}

/** Abfahrt als Date (aus den Verpflegungs-Einstellungen) – auch Start der Mehrtagestour. */
export function departureDate() {
  const d = new Date(state.supply.departure || defaultDeparture());
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Der importierte Weg, solange Start und Ziel noch seine sind: Dann führt eine A→B-Berechnung an ihm entlang
 * (calcAB in pipeline.js), statt ihn durch eine neu berechnete Route zu ersetzen.
 */
export function activeTrack() {
  const t = state.track;
  return t && state.mode === 'ab' && state.start === t.waypoints[0] && state.end === t.waypoints.at(-1) ? t : null;
}

/** Rundkurs? Erkennung über Objekt-Identität von erstem und letztem Wegpunkt (siehe CLAUDE.md). */
export function isLoop(r) {
  return r.waypoints.length > 2 && r.waypoints[0] === r.waypoints[r.waypoints.length - 1];
}

/** Zwischenstopps mit Koordinaten (ohne gerade erst angelegte, noch leere Zeilen). */
export function activeVias() {
  return state.vias.filter(v => v.lat != null);
}

/** Grundroute ohne Übernachtungen und Verpflegungsstopps – Ausgangspunkt jeder Neuplanung. */
export function originRoute() {
  return state.route?.origin || state.route?.base || state.route;
}

/**
 * Einteilung, nach der Balken, Höhenprofil und Kartenlinie gerade aufgeschlüsselt werden: die gewählte, soweit
 * die Route die Daten dafür hat – „Steigung“ braucht Höhen, Untergrund und Wegtyp die Abschnitte des
 * Routing-Dienstes. Fehlt das Gewählte, gilt das andere; die Einstellung selbst bleibt.
 */
export function activeBreakdown(r = state.route) {
  const surface = !!r?.segments?.length, grade = !!r && hasElevation(r);
  if (state.breakdown === 'grade') return grade || !surface ? 'grade' : 'surface';
  return surface || !grade ? state.breakdown : 'grade';
}

/** Vorschlag für den Routennamen, z. B. „Rundkurs 60 km ab Bremen“. */
export function defaultName(r) {
  const from = state.start?.label?.split(',')[0];
  return `${MODE_LABELS[state.mode]} ${Math.round(r.distance / 1000)} km${from ? ' ab ' + from : ''}`;
}
