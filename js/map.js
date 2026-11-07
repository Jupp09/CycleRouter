import { storage } from './utils.js';
import { CATEGORIES } from './surfaces.js';

const L = window.L;

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';

const BASE_LAYERS = {
  'CyclOSM': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 20, attribution: `${OSM_ATTR} · Stil: <a href="https://www.cyclosm.org">CyclOSM</a>`,
  }),
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
    maxZoom: 18, opacity: 0.7, attribution: '<a href="https://cycling.waymarkedtrails.org">Waymarked Trails</a>',
  }),
};

// Kräftiges Magenta: kommt in CyclOSM/Topo/Satellit praktisch nicht vor und sticht daher heraus.
const ROUTE_COLOR = '#e6007e';

const icon = cls => L.divIcon({ className: '', html: `<div class="marker-pin ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
const viaIcon = L.divIcon({ className: '', html: '<div class="marker-pin via"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
/** Manuell hinzugefügter Zwischenstopp: Nummer oder Kategorie-Symbol. */
const manualIcon = text => L.divIcon({
  className: '', iconSize: [26, 26], iconAnchor: [13, 13],
  html: `<div class="via-pin">${text}</div>`,
});
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createMap(el, { onClick, onMarkerDrag }) {
  const view = storage.get('view', { center: [51.1657, 10.4515], zoom: 6 });
  const map = L.map(el, { zoomControl: false }).setView(view.center, view.zoom);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const baseName = storage.get('baseLayer', 'CyclOSM');
  (BASE_LAYERS[baseName] || BASE_LAYERS.CyclOSM).addTo(map);
  L.control.layers(BASE_LAYERS, OVERLAYS, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', e => storage.set('baseLayer', e.name));
  map.on('moveend', () => {
    const c = map.getCenter();
    storage.set('view', { center: [c.lat, c.lng], zoom: map.getZoom() });
  });
  map.on('click', e => onClick({ lat: e.latlng.lat, lon: e.latlng.lng }));

  const markerLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const stopLayer = L.layerGroup().addTo(map);
  const stopMarkers = new Map();
  const searchLayer = L.layerGroup().addTo(map);
  const searchMarkers = new Map();
  const hoverMarker = L.circleMarker([0, 0], { radius: 7, color: '#111827', weight: 3, fillColor: ROUTE_COLOR, fillOpacity: 1 });

  return {
    /**
     * markers: [{point, kind: 'start'|'end'|'via'|'manual', index, text?, title?}]
     * – `index` wird beim Verschieben zurückgegeben; 'manual' = vom Nutzer gesetzter Zwischenstopp.
     */
    setMarkers(markers) {
      markerLayer.clearLayers();
      for (const m of markers) {
        const marker = L.marker([m.point.lat, m.point.lon], {
          icon: m.kind === 'via' ? viaIcon : m.kind === 'manual' ? manualIcon(escapeHtml(m.text)) : icon(m.kind),
          draggable: true,
          zIndexOffset: m.kind === 'via' ? 0 : m.kind === 'manual' ? 600 : 1000,
          title: m.title || '',
        });
        marker
          .on('dragend', e => {
            const ll = e.target.getLatLng();
            onMarkerDrag(m.index, { lat: ll.lat, lon: ll.lng });
          })
          .addTo(markerLayer);
      }
    },

    /** colorBy: null für einfarbig, sonst 'surface' oder 'waytype' (Abschnitte in Kategorie-Farbe). */
    setRoute(coords, segments, colorBy) {
      routeLayer.clearLayers();
      if (!coords) return;
      const latlngs = coords.map(c => [c[0], c[1]]);
      // Dreilagig: dunkle Kontur + weißer Halo + farbige Linie – hebt sich auf hellen wie dunklen Karten ab.
      const line = { interactive: false, lineCap: 'round', lineJoin: 'round' };
      L.polyline(latlngs, { ...line, color: '#111827', weight: 12, opacity: 0.75 }).addTo(routeLayer);
      L.polyline(latlngs, { ...line, color: '#fff', weight: 9, opacity: 1 }).addTo(routeLayer);
      if (!colorBy || !segments?.length) {
        L.polyline(latlngs, { ...line, color: ROUTE_COLOR, weight: 6, opacity: 1 }).addTo(routeLayer);
        return;
      }
      let run = null;
      const flush = () => run && L.polyline(latlngs.slice(run.from, run.to + 1), {
        ...line, color: CATEGORIES[colorBy][run.key].color, weight: 6, opacity: 1,
      }).addTo(routeLayer);
      for (const s of segments) {
        if (run && run.key === s[colorBy]) { run.to = s.to; continue; }
        flush();
        run = { key: s[colorBy], from: s.from, to: s.to };
      }
      flush();
    },

    /** stops: [{id, lat, lon, icon, warn, popup: HTMLElement}] */
    setStops(stops = []) {
      stopLayer.clearLayers();
      stopMarkers.clear();
      for (const s of stops) {
        const marker = L.marker([s.lat, s.lon], {
          icon: L.divIcon({
            className: '', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14],
            html: `<div class="stop-pin${s.warn ? ' warn' : ''}">${s.icon}</div>`,
          }),
          zIndexOffset: 500,
        }).bindPopup(s.popup).addTo(stopLayer);
        stopMarkers.set(s.id, marker);
      }
    },

    /** Suchtreffer entlang der Route: [{id, lat, lon, icon, popup: HTMLElement}] */
    setSearchResults(results = []) {
      searchLayer.clearLayers();
      searchMarkers.clear();
      for (const s of results) {
        const marker = L.marker([s.lat, s.lon], {
          icon: L.divIcon({
            className: '', iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12],
            html: `<div class="search-pin">${s.icon}</div>`,
          }),
          zIndexOffset: 400,
        }).bindPopup(s.popup).addTo(searchLayer);
        searchMarkers.set(s.id, marker);
      }
    },

    openSearchResult(id) {
      const m = searchMarkers.get(id);
      if (!m) return;
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
      m.openPopup();
    },

    closePopup() { map.closePopup(); },

    openStop(id) {
      const m = stopMarkers.get(id);
      if (!m) return;
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 14));
      m.openPopup();
    },

    fitRoute(coords) {
      const bounds = L.latLngBounds(coords.map(c => [c[0], c[1]]));
      const mobile = window.matchMedia('(max-width: 800px)').matches;
      map.fitBounds(bounds, { padding: mobile ? [20, 20] : [50, 50] });
    },

    flyTo(point, zoom = 13) {
      map.setView([point.lat, point.lon], Math.max(map.getZoom(), zoom));
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
