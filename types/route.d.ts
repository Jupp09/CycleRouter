// Das gemeinsame Routenobjekt aller Dienste (CLAUDE.md „Route object“) – nur für die Typprüfung.
// In JSDoc als {Route}, {Waypoint}, {Segment} nutzbar (globale Typen, kein Import nötig).

/** Koordinate [lat, lon, Höhe in m (fehlt bei Routen ohne Höhendaten)]. */
type Coord = [number, number, number?];

/** Abschnitt mit einheitlichem Untergrund/Wegtyp bzw. einer Steigungsklasse: Indizes in `coords`. */
interface Segment {
  from: number;
  to: number;
  surface?: string;
  waytype?: string;
  /** Untergrund nur geschätzt (aus dem Wegtyp, nicht aus OSM-`surface`) */
  estimated?: boolean;
  /** Steigungsklasse (climbs.js gradeSegments) */
  grade?: string;
}

/** Stelle eines Wegpunkts auf einem importierten GPX-Weg (trackRoute, shapeAnchors). */
interface TrackAt {
  coords: Coord[];
  segments: Segment[];
  i: number;
}

interface Waypoint {
  lat: number;
  lon: number;
  label?: string;
  /** vom Nutzer gesetzter Zwischenstopp */
  manual?: boolean;
  /** Symbol des Zwischenstopps (Kategorie, aus der er übernommen wurde) */
  icon?: string | null;
  /** zählt als Verpflegungsstopp (Intervall beginnt dort neu) */
  food?: boolean;
  /** geplanter Verpflegungsstopp (stops.js) */
  stop?: any;
  /** geplante Übernachtung (stays.js) */
  stay?: any;
  /** unsichtbarer Stützpunkt auf einem importierten Weg */
  anchor?: boolean;
  trackAt?: TrackAt;
  id?: string;
}

/** Abbiegehinweis von BRouter (js/routing/brouter.js parseTurns): Punkt in `coords`, Befehl, Ausfahrt im Kreisel, Winkel */
interface Turn {
  i: number;
  cmd: number;
  exit?: number;
  angle?: number;
}

interface Route {
  coords: Coord[];
  /** zurückgelegte Meter je Koordinate */
  cum: number[];
  /** Länge in m */
  distance: number;
  ascent: number;
  descent: number;
  waypoints: Waypoint[];
  segments?: Segment[];
  /** Name des Ausweichdiensts, falls Teilstücke nicht mit dem gewählten Dienst berechnet wurden */
  fallback?: string;
  /** Meter je BRouter-Server ({own, 'brouter.de'}) */
  servers?: Record<string, number>;
  /** Abbiegehinweise (nur BRouter), für den FIT-Kurs */
  turns?: Turn[];
  /** importierter GPX-Weg (trackRoute) */
  track?: boolean;
  /** Route ohne Übernachtungen und Stopps */
  origin?: Route;
  /** Route vor dem Einfügen der Stopps */
  base?: Route;
  stops?: any[];
  stays?: any;
  /** Abschnitte ohne Verpflegungsstopp {from, to} in m (stops.js) */
  gaps?: { from: number; to: number }[];
  stageStarts?: number[];
  water?: any[];
  waterGaps?: any[];
  regions?: any[];
  holidays?: any[];
  holidayCheck?: boolean | 'pending';
  foodPartial?: boolean;
  dwellMin?: number;
  name?: string;
}
