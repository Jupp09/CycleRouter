# CycleRouter

Routenplaner für **Rennrad**, **Gravelbike** und **Fahrrad** (Trekking-/Alltagsrad) auf Basis von OpenStreetMap.

- **A → B** – Route zwischen Start und Ziel
- **Distanz** – Start + Wunschdistanz, das Ziel wird automatisch gewählt
- **Rundkurs** – Schleife mit Wunschdistanz zurück zum Start
- **GPX-Export** inkl. Höhendaten
- Höhenprofil, Höhenmeter, geschätzte Fahrzeit
- Aufschlüsselung nach **Untergrund** (Asphalt, Pflaster, Schotter …) und **Wegtyp** (Radweg, Hauptstraße, Wirtschaftsweg …) mit km und %, optional als Einfärbung der Route und als Farbband im Höhenprofil ([js/surfaces.js](js/surfaces.js))
- Marker verschiebbar – die Route wird neu berechnet
- „Neu würfeln" erzeugt eine andere Variante, optional mit Wunschrichtung

## Starten

Reine statische Seite ohne Build-Schritt. Sie muss über einen lokalen Webserver laufen (ES-Module funktionieren nicht über `file://`):

```sh
git clone https://github.com/Jupp09/CycleRouter.git
cd CycleRouter
npm start
```

Danach <http://localhost:8000> öffnen. Der Server ([server.mjs](server.mjs)) liefert immer den Projektordner aus. Ein anderer Port geht mit `PORT=8080`.

Alternativ geht jeder statische Server, er muss aber **im Projektordner** gestartet werden, sonst erscheint nur eine Dateiliste: `py -m http.server 8000`.

## Routing

| Dienst | Rennrad | Gravel | Fahrrad (Trekking/Alltag) | Hinweise |
|---|---|---|---|---|
| **BRouter** (Standard) | `fastbike`, `fastbike-lowtraffic`, `fastbike-verylowtraffic` | `gravel` | `trekking` | kein Key nötig |
| **OpenRouteService** | `cycling-road` | `cycling-regular` | `cycling-regular` | kostenloser API-Key ([Registrierung](https://openrouteservice.org/dev/#/signup)), Eingabe über das Zahnrad; Rundkurse nativ über `round_trip` |

Rundkurse und Distanz-Routen mit BRouter werden in [js/generators.js](js/generators.js) erzeugt: Wegpunkte auf einem Kreis bzw. ein Ziel in passender Luftlinie. Danach wird iterativ skaliert, bis die Länge höchstens 6 % von der Wunschdistanz abweicht.

## Aufbau

```
index.html             Oberfläche
css/style.css          Layout (hell/dunkel, mobil)
js/main.js             App-Zustand und Ereignisse
js/map.js              Leaflet-Karte, Layer, Marker
js/geocode.js          Ortssuche (Photon)
js/routing/            BRouter- und ORS-Anbindung
js/generators.js       Rundkurs- und Distanz-Generator
js/elevation.js        Höhenprofil (SVG)
js/gpx.js              GPX-Erzeugung
```

## Datenquellen

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende · Kartenstil [CyclOSM](https://www.cyclosm.org), [OpenTopoMap](https://opentopomap.org), Esri World Imagery · Radrouten-Overlay [Waymarked Trails](https://cycling.waymarkedtrails.org) · Routing [BRouter](https://brouter.de), [OpenRouteService](https://openrouteservice.org) · Suche [Photon](https://photon.komoot.io)

Alle Dienste sind öffentliche, kostenlose Server mit Nutzungsbeschränkungen. Sie eignen sich für den privaten Gebrauch, nicht für hohe Last.
