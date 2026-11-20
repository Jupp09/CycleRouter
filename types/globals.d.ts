// Globale Typen für die Typprüfung (npm run typecheck, jsconfig.json). Nur für tsc – wird nie ausgeliefert.

/** Leaflet 1.9.4, als globales Skript von cdnjs geladen (index.html), nicht importiert. */
declare const L: any;

interface Window {
  L: any;
}

interface Navigator {
  /** Safari auf iPhone/iPad: true in der installierten App (Home-Bildschirm). */
  standalone?: boolean;
}

/** Orte aus dem Kachel-Cache; `complete` = false, wenn mit `cacheOnly` nicht alle Kacheln da waren (poiTiles.js). */
type PoiList = any[] & { complete?: boolean };

/** Treffer von „Entlang der Route finden“ (placeSearch.js): Herkunft und ob Abschnitte fehlen. */
type PlaceResults = any[] & { source?: 'cache' | 'photon'; partial?: boolean };

/** „Meine Routen“ (account.js listRoutes): ohne Netz mit Stand `t` und den gemerkten ids `cached`. */
type RouteList = any[] & { offline?: boolean; t?: number; cached?: Set<number> };

/** Meldung ins Log (Server: console.log oder still). */
type LogFn = (message: string) => void;
