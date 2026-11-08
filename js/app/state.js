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
 */
import { providers } from '../routing/index.js';
import { storage, newSeed, toDateTimeLocal } from '../utils.js';

export const MODE_LABELS = { ab: 'Route', distance: 'Strecke', loop: 'Rundkurs' };
export const BIKE_LABELS = { road: 'Rennrad', gravel: 'Gravel', trekking: 'Fahrrad' };

export const state = {
  // Routing
  bike: storage.get('bike', 'road'),              // 'road' | 'gravel' | 'trekking'
  traffic: storage.get('traffic', 'normal'),      // nur Rennrad mit BRouter
  eurovelo: storage.get('eurovelo', 'off'),       // 'off' | 'prefer' | 'strong'
  provider: storage.get('provider', 'brouter'),   // Schlüssel in providers
  mode: storage.get('mode', 'ab'),                // 'ab' | 'distance' | 'loop'
  distanceKm: storage.get('distanceKm', 60),      // Wunschdistanz für Distanz/Rundkurs
  direction: 'random',                            // Himmelsrichtung in Grad oder 'random'
  seed: newSeed(),                                // „Neu würfeln“ erzeugt eine neue Saat

  // Anzeige
  breakdown: storage.get('breakdown', 'surface'), // 'surface' | 'waytype'
  colorRoute: storage.get('colorRoute', true),

  // Verpflegungsstopps
  supply: {
    enabled: storage.get('supplyEnabled', false),
    intervalKm: storage.get('supplyInterval', 30),
    departure: defaultDeparture(),                // Wert eines datetime-local-Felds; auch Start der Mehrtagestour
  },

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
  staysLoading: false,
  staysError: null,

  // Wegpunkte
  start: null,                                    // {lat, lon, label}
  end: null,
  vias: [],                                       // A→B-Zwischenstopps {lat, lon, label, manual: true, icon?}; lat null = noch offen

  // Aktuelle Route (siehe CLAUDE.md: route.origin / route.base) und Bezug zu einer gespeicherten Route
  route: null,
  saved: null,                                    // geöffnete eigene gespeicherte Route {id, name, shareToken}
  loadedName: null,                               // Name einer geöffneten gespeicherten/geteilten Route
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

/** Optionen für provider.route(): Fahrradtyp, Verkehr, EuroVelo (nur wo der Dienst es kann). */
export function routeOpts() {
  return {
    bike: state.bike, traffic: state.traffic,
    eurovelo: provider().supportsEurovelo ? state.eurovelo : 'off',
  };
}

/** Nächste volle Viertelstunde, als Wert für <input type="datetime-local">. */
export function defaultDeparture() {
  return toDateTimeLocal(new Date(Math.ceil(Date.now() / 900000) * 900000));
}

/** Abfahrt als Date (aus den Verpflegungs-Einstellungen) – auch Start der Mehrtagestour. */
export function departureDate() {
  const d = new Date(state.supply.departure || defaultDeparture());
  return isNaN(d) ? new Date() : d;
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

/** Vorschlag für den Routennamen, z. B. „Rundkurs 60 km ab Bremen“. */
export function defaultName(r) {
  const from = state.start?.label?.split(',')[0];
  return `${MODE_LABELS[state.mode]} ${Math.round(r.distance / 1000)} km${from ? ' ab ' + from : ''}`;
}
