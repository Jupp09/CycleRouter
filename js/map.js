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

const icon = cls => L.divIcon({ className: '', html: `<div class="marker-pin ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
const viaIcon = L.divIcon({ className: '', html: '<div class="marker-pin via"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });

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
  const hoverMarker = L.circleMarker([0, 0], { radius: 6, color: '#fff', weight: 2, fillColor: '#7c3aed', fillOpacity: 1 });

  return {
    /**
     * markers: [{point, kind: 'start'|'end'|'via', index}] – `index` wird beim Verschieben zurückgegeben.
     */
    setMarkers(markers) {
      markerLayer.clearLayers();
      for (const m of markers) {
        L.marker([m.point.lat, m.point.lon], {
          icon: m.kind === 'via' ? viaIcon : icon(m.kind),
          draggable: true,
          zIndexOffset: m.kind === 'via' ? 0 : 1000,
        })
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
      L.polyline(latlngs, { color: '#fff', weight: 9, opacity: 0.85, interactive: false }).addTo(routeLayer);
      if (!colorBy || !segments?.length) {
        L.polyline(latlngs, { color: '#7c3aed', weight: 5, opacity: 0.95, interactive: false }).addTo(routeLayer);
        return;
      }
      let run = null;
      const flush = () => run && L.polyline(latlngs.slice(run.from, run.to + 1), {
        color: CATEGORIES[colorBy][run.key].color, weight: 5, opacity: 1, interactive: false,
      }).addTo(routeLayer);
      for (const s of segments) {
        if (run && run.key === s[colorBy]) { run.to = s.to; continue; }
        flush();
        run = { key: s[colorBy], from: s.from, to: s.to };
      }
      flush();
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
