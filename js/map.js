import { storage } from './utils.js';
import { CATEGORIES } from './surfaces.js';
import { groupNear } from './cluster.js';

const L = window.L;

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';

const cyclosm = (extra = {}) => L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
  // Ab Stufe 19 rendert der Server fast jede Kachel erst auf Anfrage (2–4 s je Kachel) – der Bildschirm
  // bliebe lange grau. Stufe 19 zeigt daher die Kacheln von 18 vergrößert (maxNativeZoom).
  maxNativeZoom: 18, maxZoom: 19, attribution: `${OSM_ATTR} · Stil: <a href="https://www.cyclosm.org">CyclOSM</a>`, ...extra,
});

/** Standard für neue Nutzer; wer einen Stil gewählt hat, behält ihn (storage 'baseLayer'). */
const DEFAULT_BASE = 'CyclOSM ruhig';

const BASE_LAYERS = {
  // Dieselben Kacheln, per CSS entsättigt (.tiles-calm in style.css): Auf dem bunten CyclOSM ging die Route
  // unter. Kein weiterer Dienst, keine weiteren Nutzungsbedingungen; der Browser teilt sich die Kacheln.
  'CyclOSM ruhig': cyclosm({ className: 'tiles-calm' }),
  'CyclOSM': cyclosm(),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: OSM_ATTR,
  }),
  'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: `${OSM_ATTR} · <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
  }),
  'Satellit': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Bilder &copy; Esri, Maxar, Earthstar Geographics',
  }),
};

const OVERLAYS = {
  'Radrouten (Waymarked Trails)': L.tileLayer('https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', {
    // Der Server liefert bis 18; auf Stufe 19 vergrößert statt ausgeblendet
    maxNativeZoom: 18, maxZoom: 19, opacity: 0.7, attribution: '<a href="https://cycling.waymarkedtrails.org">Waymarked Trails</a>',
  }),
};

// Kräftiges Magenta: kommt in CyclOSM/Topo/Satellit praktisch nicht vor und sticht daher heraus.
const ROUTE_COLOR = '#e6007e';

// Trefferfläche größer als der sichtbare Punkt (.marker-hit zentriert ihn): mindestens 24 px (WCAG 2.5.8), Start,
// Ziel und Zwischenstopps 32 px – sie werden mit dem Finger gezogen, 22 px waren auf dem Handy zu knapp.
// Das Ziel trägt eine Zielflagge (style.css): Start und Ziel unterscheiden sich so nicht nur in der Farbe.
const FLAG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 22V3" fill="none"/><path d="M5 3h14l-3.5 5 3.5 5H5z"/></svg>';
const icon = cls => L.divIcon({
  className: 'marker-hit', html: `<div class="marker-pin ${cls}">${cls === 'end' ? FLAG : ''}</div>`, iconSize: [32, 32], iconAnchor: [16, 16],
});
const viaIcon = L.divIcon({ className: 'marker-hit', html: '<div class="marker-pin via"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
/** Manuell hinzugefügter Zwischenstopp: Nummer oder Kategorie-Symbol. */
const manualIcon = text => L.divIcon({
  className: 'marker-hit', iconSize: [32, 32], iconAnchor: [16, 16],
  html: `<div class="via-pin">${text}</div>`,
});
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Marker sind per Tastatur fokussierbar (Leaflet) – ohne Namen liest ein Screenreader nur „Schaltfläche“.
 * Leaflet setzt bei divIcon nur `title`; der zugängliche Name kommt zusätzlich als aria-label.
 */
function named(marker, name) {
  if (!name) return marker;
  // Bei jedem Hinzufügen: Leaflet baut das Element neu, wenn ein Marker die Karte verlässt und wiederkommt
  // (z. B. beim Zusammenfassen naher Marker, refreshPois)
  marker.on('add', () => marker.getElement()?.setAttribute('aria-label', name));
  return marker;
}
const DASH = { dashed: '8 12', dotted: '0 11' };
/** Ab dieser Zoomstufe zeigt die Karte jeden Ort einzeln (refreshPois). */
const CLUSTER_UNTIL = 13;
/** Marker, die sich näher kommen (px, Mitte zu Mitte), werden zusammengefasst – sie überdeckten sich sonst. */
const CLUSTER_PX = 34;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** „2 Verpflegungsstopps, 1 Trinkwasserstelle“ – für Namen und Tooltip eines zusammengefassten Markers. */
function clusterParts({ stop, water, search }) {
  return [stop && plural(stop, 'Verpflegungsstopp', 'Verpflegungsstopps'), water && plural(water, 'Trinkwasserstelle', 'Trinkwasserstellen'),
    search && plural(search, 'Suchtreffer', 'Suchtreffer')].filter(Boolean).join(', ');
}
const KIND_NAME = { start: 'Start', end: 'Ziel', via: 'Wegpunkt', manual: 'Zwischenstopp' };
/** Zusatz im Tooltip (nicht im aria-label: per Tastatur lässt sich ein Marker nicht ziehen). */
const DRAG_HINT = { start: 'ziehen zum Verschieben', end: 'ziehen zum Verschieben', via: 'ziehen, um die Route zu ändern', manual: 'ziehen zum Verschieben' };

/**
 * Legende der Kartensymbole als Leaflet-Steuerelement: ein <details> („Legende“), aufgeklappt gemerkt (nur auf
 * diesem Gerät). Die Symbole teilen sich die CSS-Regeln mit den Markern auf der Karte (style.css: `.stop-pin,
 * .pin-stop` usw.), tragen aber eigene Klassen – sonst zählten Code und Tests, die z. B. `.stop-pin` suchen, die
 * Legende mit. Statisches Markup ohne Daten aus OSM, daher innerHTML.
 */
function createLegend() {
  const Legend = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create('details', 'leaflet-control map-legend');
      box.open = !!storage.get('legendOpen', false);
      box.innerHTML = `<summary>Legende</summary><ul>
        <li><span class="legend-icon"><span class="pin-marker pin-start"></span></span>Start</li>
        <li><span class="legend-icon"><span class="pin-marker pin-end">${FLAG}</span></span>Ziel</li>
        <li><span class="legend-icon"><span class="pin-via">1</span></span>Zwischenstopp</li>
        <li><span class="legend-icon"><span class="pin-stop">🛒</span></span>Verpflegungsstopp (Symbol: Art)</li>
        <li><span class="legend-icon"><span class="pin-stop pin-warn">☕</span></span>Öffnungszeiten unklar oder evtl. zu</li>
        <li><span class="legend-icon"><span class="pin-water">💧</span></span>Trinkwasser</li>
        <li><span class="legend-icon"><span class="pin-stay">🏨</span></span>Unterkunft</li>
        <li><span class="legend-icon"><span class="pin-cluster">3</span></span>Mehrere Orte – antippen zum Vergrößern</li>
      </ul>`;
      for (const pin of box.querySelectorAll('.legend-icon')) pin.setAttribute('aria-hidden', 'true');
      box.addEventListener('toggle', () => storage.set('legendOpen', box.open));
      // Klicks und Scrollen in der Legende nicht an die Karte (sonst setzte ein Klick einen Wegpunkt)
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      return box;
    },
  });
  return new Legend({ position: 'topleft' });
}

/**
 * „Bewegung reduzieren“ im System: Kartensprünge (Route einpassen, zu einem Ort springen) ohne
 * Flug-Animation. Bei jedem Aufruf neu abgefragt, damit eine Änderung der Systemeinstellung sofort gilt.
 */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motion = () => ({ animate: !reduceMotion.matches });

/**
 * Orte mit Popup (Verpflegung, Wasser, Unterkunft, Suchtreffer): Aussehen je Art. `size` ist die Trefferfläche
 * in px, `hit` die vergrößerte Trefferfläche (.marker-hit), `lift` hebt das Popup über den Punkt, `z` stapelt
 * die Arten (Unterkünfte über Stopps über Suchtreffern über Wasser).
 */
const POI_KINDS = {
  stop: { pin: 'stop-pin', size: 28, lift: 14, z: 500 },
  water: { pin: 'water-pin', size: 32, lift: 11, z: 300, hit: true, icon: '💧' },
  stay: { pin: 'stay-pin', size: 30, lift: 15, z: 700 },
  search: { pin: 'search-pin', size: 24, lift: 12, z: 400 },
};

/** Marker eines Ortes: {lat, lon, icon?, warn?, title?, popup: HTMLElement} */
function poiMarker(kind, p) {
  const { pin, size, lift, z, hit, icon: fixed } = POI_KINDS[kind];
  return named(L.marker([p.lat, p.lon], {
    icon: L.divIcon({
      className: hit ? 'marker-hit' : '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -lift],
      html: `<div class="${pin}${p.warn ? ' warn' : ''}">${fixed ?? p.icon}</div>`,
    }),
    zIndexOffset: z,
    title: p.title || '',
  }), p.title).bindPopup(p.popup);
}

/** Leaflet-Steuerelemente mit deutschen Texten; Kartenstil und Ausschnitt werden gemerkt. */
function addControls(map) {
  // Leaflets eigene Texte sind englisch; ein deutscher Screenreader läse sie mit deutscher Aussprache vor
  L.control.zoom({ position: 'topright', zoomInTitle: 'Vergrößern', zoomOutTitle: 'Verkleinern' }).addTo(map);
  map.attributionControl.setPrefix(String(map.attributionControl.options.prefix)
    .replace('A JavaScript library for interactive maps', 'JavaScript-Bibliothek für interaktive Karten'));
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const baseName = storage.get('baseLayer', DEFAULT_BASE);
  (BASE_LAYERS[baseName] || BASE_LAYERS[DEFAULT_BASE]).addTo(map);
  const layers = L.control.layers(BASE_LAYERS, OVERLAYS, { position: 'topright' }).addTo(map);
  const layersToggle = layers.getContainer().querySelector('.leaflet-control-layers-toggle');
  layersToggle.title = 'Kartenstil und Ebenen';
  layersToggle.setAttribute('aria-label', 'Kartenstil und Ebenen');
  map.on('baselayerchange', e => storage.set('baseLayer', e.name));
  map.on('moveend', () => {
    const c = map.getCenter();
    storage.set('view', { center: [c.lat, c.lng], zoom: map.getZoom() });
  });
}

/**
 * Popups per Tastatur: Öffnet ein per Tastatur fokussiertes Element das Popup (Listenzeile, Enter auf einem
 * Marker), wandert der Fokus hinein – sonst läge sein Inhalt hinter dem ganzen Panel und allen Markern in der
 * Tab-Reihenfolge, und niemand erführe, dass es aufging. Escape schließt es, der Fokus geht zurück zum Auslöser.
 * Mit Maus oder Finger (kein :focus-visible) bleibt der Fokus, wo er ist.
 */
function keyboardPopups(map, el) {
  let popupOpener = null;
  map.on('popupopen', e => {
    const box = e.popup.getElement();
    const close = box?.querySelector('.leaflet-popup-close-button');
    if (close) { close.setAttribute('aria-label', 'Schließen'); close.title = 'Schließen'; }
    const from = document.activeElement;
    popupOpener = from instanceof HTMLElement && from.matches(':focus-visible') ? from : null;
    const content = box?.querySelector('.leaflet-popup-content');
    if (!popupOpener || !content) return;
    content.tabIndex = -1;
    content.focus({ preventScroll: true });
  });
  map.on('popupclose', e => {
    const opener = popupOpener;
    popupOpener = null;
    const active = document.activeElement;
    const box = e.popup.getElement();
    if (opener?.isConnected && (!active || active === document.body || box?.contains(active))) opener.focus({ preventScroll: true });
  });
  // Leaflet fängt Escape nur ab, solange die Karte selbst den Fokus hat, nicht ein Element im Popup
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target instanceof Element && e.target.closest('.leaflet-popup')) {
      e.stopPropagation();
      map.closePopup();
    }
  });
}

/**
 * @param {HTMLElement} el
 * @param {{onClick: (p: {lat: number, lon: number}) => void, onMarkerDrag: Function,
 *   onRouteHover?: (p: {lat: number, lon: number} | null) => void}} handlers
 */
export function createMap(el, { onClick, onMarkerDrag, onRouteHover = () => {} }) {
  const view = storage.get('view', { center: [51.1657, 10.4515], zoom: 6 });
  // Auch Zoomen per Mausrad/Knopf springt dann, statt zu animieren (gilt ab dem nächsten Laden der Seite)
  const calm = reduceMotion.matches ? { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false } : {};
  const map = L.map(el, { zoomControl: false, ...calm }).setView(view.center, view.zoom);
  // Die Karte ist fokussierbar (Leaflet: Pfeiltasten verschieben, +/− zoomt) – mit Namen und Bedienhinweis
  // (#map-help in index.html), sonst läse ein Screenreader beim Fokus nur den ganzen Inhalt vor
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Karte');
  el.setAttribute('aria-describedby', 'map-help');
  addControls(map);
  map.on('click', e => onClick({ lat: e.latlng.lat, lon: e.latlng.lng }));
  keyboardPopups(map, el);

  const markerLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const stayLayer = L.layerGroup().addTo(map);
  // Verpflegung, Trinkwasser und Suchtreffer liegen gemeinsam in poiLayer: Auf kleinen Zoomstufen fasst
  // refreshPois nahe Marker zu einem zusammen (sie überdeckten sich sonst, v. a. in Städten). Start, Ziel und
  // Zwischenstopps bleiben immer einzeln – sie werden gezogen; Unterkünfte sind wenige und liegen weit auseinander.
  const poiLayer = L.layerGroup().addTo(map);
  /** Marker je Art: id → Marker */
  const markersOf = { stop: new Map(), water: new Map(), search: new Map(), stay: new Map() };
  const poiSources = { stop: markersOf.stop, water: markersOf.water, search: markersOf.search };

  /** Orte einer Art ersetzen; Unterkünfte liegen in stayLayer (nie zusammengefasst), die übrigen in poiLayer. */
  function setPois(kind, items) {
    const markers = markersOf[kind];
    const layer = kind === 'stay' ? stayLayer : poiLayer;
    for (const m of markers.values()) layer.removeLayer(m);
    markers.clear();
    for (const p of items) {
      const marker = poiMarker(kind, p);
      markers.set(p.id, marker);
      if (kind === 'stay') marker.addTo(stayLayer);
    }
    if (kind !== 'stay') refreshPois();
  }

  /** Zu einem Ort springen und sein Popup öffnen – auch wenn er gerade in einem zusammengefassten Marker steckt. */
  function openPoi(kind, id, zoom) {
    const m = markersOf[kind].get(id);
    if (!m) return;
    map.setView(m.getLatLng(), Math.max(map.getZoom(), zoom), motion());
    if (kind !== 'stay') reveal(m);
    m.openPopup();
  }

  function refreshPois() {
    const zoom = map.getZoom();
    const items = Object.entries(poiSources).flatMap(([kind, markers]) => [...markers.values()].map(m => ({ kind, m })));
    // Ab CLUSTER_UNTIL alles einzeln; ein Marker mit offenem Popup immer, sonst schlösse das Zusammenfassen sein Popup
    const groups = groupNear(items, it => map.project(it.m.getLatLng(), zoom), zoom < CLUSTER_UNTIL ? CLUSTER_PX : 0,
      it => it.m.isPopupOpen());
    // Einzelne Marker nur hinzufügen bzw. entfernen, wenn sich etwas ändert – ein Marker, der schon da ist,
    // behält so seinen Fokus und sein Popup
    const single = new Set(groups.filter(g => g.length === 1).map(g => g[0].m));
    for (const layer of poiLayer.getLayers()) if (!single.has(layer)) poiLayer.removeLayer(layer);
    for (const m of single) if (!poiLayer.hasLayer(m)) poiLayer.addLayer(m);
    for (const g of groups) if (g.length > 1) clusterMarker(g).addTo(poiLayer);
  }

  /** Zusammengefasster Marker: Anzahl, je Art gezählt (data-*); Klick bzw. Enter zoomt auf die Orte. */
  function clusterMarker(group) {
    const counts = { stop: 0, water: 0, search: 0 };
    for (const it of group) counts[it.kind]++;
    const bounds = L.latLngBounds(group.map(it => it.m.getLatLng()));
    const name = `${group.length} Orte zusammengefasst: ${clusterParts(counts)} – zum Vergrößern antippen`;
    const marker = named(L.marker(bounds.getCenter(), {
      icon: L.divIcon({
        className: 'marker-hit', iconSize: [36, 36], iconAnchor: [18, 18],
        html: `<div class="cluster-pin" data-stop="${counts.stop}" data-water="${counts.water}" data-search="${counts.search}">${group.length}</div>`,
      }),
      zIndexOffset: 600,
      title: name,
    }), name);
    const zoomIn = () => {
      // Per Tastatur: Nach dem Zoomen gibt es diesen Marker nicht mehr – der Fokus geht an die Karte statt verloren
      if (marker.getElement() === document.activeElement) map.once('zoomend', () => el.focus({ preventScroll: true }));
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: CLUSTER_UNTIL + 1, ...motion() });
    };
    marker.on('click', zoomIn);
    // Enter: Leaflet macht aus Enter nur bei Markern mit Popup einen Klick (bindPopup hört auf keypress) –
    // dieser Marker hat keins
    marker.on('keypress', e => { if (e.originalEvent.key === 'Enter') zoomIn(); });
    return marker;
  }

  /** Marker sichtbar machen, auch wenn er gerade in einem zusammengefassten steckt (Popup aus einer Liste öffnen). */
  function reveal(m) {
    if (!poiLayer.hasLayer(m)) poiLayer.addLayer(m);
  }

  map.on('zoomend', refreshPois);
  // Nicht interaktiv: Er sitzt genau unter dem Mauszeiger und würde der Routenlinie sonst die Maus wegnehmen
  // Weiß gefüllt: In Routenfarbe ginge er auf der Linie unter, auf der er sitzt
  const hoverMarker = L.circleMarker([0, 0], { radius: 8, color: '#111827', weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false });
  const legend = createLegend();

  return {
    /** Legende der Marker oben links – nur solange eine Route angezeigt wird (vorher gibt es nichts zu erklären). */
    showLegend(on) {
      if (on) legend.addTo(map);
      else legend.remove();
    },

    /**
     * markers: [{point, kind: 'start'|'end'|'via'|'manual', index, text?, title?}]
     * – `index` wird beim Verschieben zurückgegeben; 'manual' = vom Nutzer gesetzter Zwischenstopp.
     */
    setMarkers(markers) {
      markerLayer.clearLayers();
      for (const m of markers) {
        const name = m.title || KIND_NAME[m.kind];
        const marker = named(L.marker([m.point.lat, m.point.lon], {
          icon: m.kind === 'via' ? viaIcon : m.kind === 'manual' ? manualIcon(escapeHtml(m.text)) : icon(m.kind),
          draggable: true,
          zIndexOffset: m.kind === 'via' ? 0 : m.kind === 'manual' ? 600 : 1000,
          title: `${name} – ${DRAG_HINT[m.kind]}`,
        }), name);
        marker
          .on('dragend', e => {
            const ll = e.target.getLatLng();
            onMarkerDrag(m.index, { lat: ll.lat, lon: ll.lng });
          })
          .addTo(markerLayer);
      }
    },

    /** colorBy: null für einfarbig, sonst 'surface', 'waytype' oder 'grade' (`segments` in Kategorie-Farbe, vgl. segmentsFor). */
    setRoute(coords, segments, colorBy) {
      routeLayer.clearLayers();
      if (!coords) return;
      const latlngs = coords.map(c => [c[0], c[1]]);
      // Dreilagig: dunkle Kontur + weißer Halo + farbige Linie – hebt sich auf hellen wie dunklen Karten ab.
      const line = { interactive: false, lineCap: 'round', lineJoin: 'round' };
      L.polyline(latlngs, { ...line, color: '#111827', weight: 12, opacity: 0.75 }).addTo(routeLayer);
      L.polyline(latlngs, { ...line, color: '#fff', weight: 9, opacity: 1 }).addTo(routeLayer);
      // Zuoberst eine unsichtbare, breite Trefferfläche: Maus darüber bzw. Antippen zeigt die Stelle im
      // Höhenprofil. Der Klick geht nicht an die Karte – ein Zwischenstopp genau auf der Route brächte nichts.
      const hit = () => L.polyline(latlngs, { lineCap: 'round', lineJoin: 'round', weight: 20, opacity: 0, className: 'route-hit' })
        .on('mousemove click', e => { L.DomEvent.stopPropagation(e); onRouteHover({ lat: e.latlng.lat, lon: e.latlng.lng }); })
        .on('mouseout', () => onRouteHover(null));
      if (!colorBy || !segments?.length) {
        L.polyline(latlngs, { ...line, color: ROUTE_COLOR, weight: 6, opacity: 1 }).addTo(routeLayer);
        hit().addTo(routeLayer);
        return;
      }
      let run = null;
      const flush = () => {
        if (!run) return;
        const cat = CATEGORIES[colorBy][run.key];
        // Gestrichelt/gepunktet: In den Lücken scheint der weiße Halo durch. Mit runden Enden wird jeder
        // Strich um die Linienbreite länger – daher die kurzen Strich- und langen Lückenwerte.
        L.polyline(latlngs.slice(run.from, run.to + 1), {
          ...line, color: cat.color, weight: 6, opacity: 1, dashArray: DASH[cat.dash],
        }).addTo(routeLayer);
      };
      for (const s of segments) {
        if (run && run.key === s[colorBy]) { run.to = s.to; continue; }
        flush();
        run = { key: s[colorBy], from: s.from, to: s.to };
      }
      flush();
      hit().addTo(routeLayer);
    },

    /** Verpflegungsstopps: [{id, lat, lon, icon, warn, title?, popup: HTMLElement}] */
    setStops(stops = []) { setPois('stop', stops); },
    /** Trinkwasser an der Route (nur angezeigt, kleiner als die Stopps): [{id, lat, lon, warn, title, popup}] */
    setWater(points = []) { setPois('water', points); },
    /** Gewählte Unterkünfte einer Mehrtagestour: [{id, lat, lon, icon, title?, popup}] */
    setStays(stays = []) { setPois('stay', stays); },
    /** Suchtreffer entlang der Route: [{id, lat, lon, icon, title?, popup}] */
    setSearchResults(results = []) { setPois('search', results); },

    openStop(id) { openPoi('stop', id, 14); },
    openWater(id) { openPoi('water', id, 15); },
    openStay(id) { openPoi('stay', id, 14); },
    openSearchResult(id) { openPoi('search', id, 15); },

    closePopup() { map.closePopup(); },

    /** `bottom`: unten von Blatt und Höhenprofil verdeckte Höhe (px, nur Handy) – dort nicht hineinlegen. */
    fitRoute(coords, { bottom = 0 } = {}) {
      const bounds = L.latLngBounds(coords.map(c => [c[0], c[1]]));
      const mobile = window.matchMedia('(max-width: 800px)').matches;
      const pad = mobile ? 20 : 50;
      // Kurze Routen nicht bis in die höchste Stufe einpassen. Viertelstufen nur hier: Mit ganzen Stufen
      // (jede verdoppelt den Maßstab) füllte die Route je nach Lage nur 50–100 % der Karte. Plus/Minus rasten
      // danach wieder auf ganze Stufen ein; Kacheln werden dazwischen höchstens um 2^0,25 ≈ 1,19 vergrößert.
      map.options.zoomSnap = 0.25;
      map.fitBounds(bounds, { paddingTopLeft: [pad, pad], paddingBottomRight: [pad, pad + bottom], maxZoom: 16, ...motion() });
      map.options.zoomSnap = 1;
    },

    /** Ausschnitt auf ein Stück der Route einpassen (z. B. einen Anstieg). */
    fitSection(coords) {
      map.fitBounds(L.latLngBounds(coords.map(c => [c[0], c[1]])), { padding: [40, 40], maxZoom: 16, ...motion() });
    },

    flyTo(point, zoom = 13) {
      map.setView([point.lat, point.lon], Math.max(map.getZoom(), zoom), motion());
    },

    showHover(point) {
      if (!point) { hoverMarker.remove(); return; }
      hoverMarker.setLatLng([point.lat, point.lon]).addTo(map);
    },

    center() {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng };
    },

    invalidateSize() { map.invalidateSize(); },
  };
}
