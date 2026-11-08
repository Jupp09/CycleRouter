# CycloRouter

Routenplaner für **Rennrad**, **Gravelbike** und **Fahrrad** (Trekking-/Alltagsrad) auf Basis von OpenStreetMap.

- **A → B** – Route zwischen Start und Ziel
- **Distanz** – Start + Wunschdistanz, das Ziel wird automatisch gewählt
- **Rundkurs** – Schleife mit Wunschdistanz zurück zum Start
- **GPX-Export** inkl. Höhendaten
- Höhenprofil, Höhenmeter, geschätzte Fahrzeit
- Aufschlüsselung nach **Untergrund** (Asphalt, Pflaster, Schotter …) und **Wegtyp** (Radweg, Hauptstraße, Wirtschaftsweg …) mit km und %, optional als Einfärbung der Route und als Farbband im Höhenprofil ([js/surfaces.js](js/surfaces.js))
- Marker verschiebbar – die Route wird neu berechnet
- **Mehrtagestouren** auf Knopfdruck (sobald die Route länger als die eingestellten km pro Tag ist): Tagesetappen, je Nacht wählbare Unterkunft (Hotel, Pension, Hostel, Zeltplatz aus OpenStreetMap) mit geschätztem Preis gegen das Budget pro Nacht und „Preis prüfen“-Link mit Datum ([js/stays.js](js/stays.js))
- „Neu würfeln" erzeugt eine andere Variante, optional mit Wunschrichtung
- **Barrierefrei bedienbar:** komplett per Tastatur (Pfeiltasten in den Umschaltern, Ortssuche mit Vorschlagsliste, alle Listen), Ansagen für Screenreader (Ergebnis, Statusmeldungen, Anzahl der Vorschläge), Höhenprofil mit Textzusammenfassung und per Pfeiltasten abfahrbar, deutlicher Fokusrahmen, ausreichende Kontraste in Hell und Dunkel; Schrift folgt der Grundschriftgröße des Browsers, Farben auch bei Rot-Grün-Schwäche unterscheidbar (unbefestigte Wege zusätzlich gestrichelt), Windows-Kontrastmodus und „Bewegung reduzieren“ werden berücksichtigt; geprüft mit axe-core

## Starten

Reine statische Seite ohne Build-Schritt. Sie muss über einen lokalen Webserver laufen (ES-Module funktionieren nicht über `file://`):

```sh
git clone https://github.com/Jupp09/CycleRouter.git
cd CycleRouter
npm start
```

Danach <http://localhost:8000> öffnen. Der Server ([server.mjs](server.mjs)) liefert immer den Projektordner aus. Ein anderer Port geht mit `PORT=8080`.

Alternativ geht jeder statische Server, er muss aber **im Projektordner** gestartet werden, sonst erscheint nur eine Dateiliste: `py -m http.server 8000`.

### Server-Cache für Verpflegungsstellen

Über `npm start` liefert der Server zusätzlich `POST /api/pois`: Supermärkte, Tankstellen und Trinkwasserstellen inkl. Öffnungszeiten werden je Kachel (≈ 11 × 7 km) im Ordner `cache/pois/` gespeichert. Gültigkeit 30 Tage (änderbar mit `POI_TTL_DAYS`). Danach wird der alte Stand sofort ausgeliefert und im Hintergrund erneuert. Overpass wird nur noch für noch nie geladene Gegenden abgefragt.

**Heimatregion auf Vorrat:** Speichert jemand in den Einstellungen eine Heimatadresse, lädt der Server alle Kacheln im Umkreis von 200 km (≈ 1.900 Kacheln) in den gemeinsamen Cache – sie stehen danach allen Nutzern des Servers zur Verfügung ([server/warmQueue.mjs](server/warmQueue.mjs)). Übermittelt werden nur auf ~10 km gerundete Koordinaten, nie die Adresse. Der Abruf läuft im Hintergrund nacheinander mit Pausen (Routenanfragen haben Vorrang), nahe Kacheln zuerst, und dauert je nach Overpass-Last etwa 30–90 Minuten. Die Warteschlange (`cache/warm-queue.json`) überlebt Neustarts. Schutz: höchstens 3 neue Regionen je Nutzer und Tag, 20 wartende Regionen insgesamt, nahe beieinander liegende Heimatorte (≤ 30 km) zählen als eine Region. Den Fortschritt zeigt der Einstellungsdialog.

**Vorrat entlang der Route:** Nach jeder berechneten Route meldet die App deren Kacheln an `POST /api/warm-route`. Der Server lädt dann im Hintergrund alle Datenebenen (Versorgung, Gastronomie, Unterkünfte), die dort noch fehlen. So haben Verpflegungsstopps, „Entlang der Route finden“ und Mehrtagestouren beim nächsten Mal sofort Daten. Routen kommen in der Warteschlange vor Heimatregionen. Mehrere fehlende Ebenen derselben Kacheln fragt der Server mit einer einzigen Overpass-Abfrage ab.

**Schnelle Verpflegungsstopps:** Die Stopps warten nur auf Trinkwasser, Supermärkte und Tankstellen. Bäckereien und Cafés nimmt die App, soweit sie schon im Cache liegen; den Rest lädt der Server nach, und ein Hinweis weist darauf hin. Die Feiertagsprüfung (Länder und Bundesländer über Nominatim, höchstens eine Anfrage pro Sekunde) läuft im Hintergrund. Nur wenn an einem Fahrtag tatsächlich ein Feiertag gilt, werden die Stopps danach angepasst.

**Datenauszug Europa:** Für ganz Europa muss der Server Overpass gar nicht mehr fragen. Ein GitHub-Workflow ([.github/workflows/poi-extract.yml](.github/workflows/poi-extract.yml)) lädt jeden Montag die OpenStreetMap-Auszüge aller europäischen Länder von [Geofabrik](https://download.geofabrik.de/europe.html), insgesamt gut 30 GB. Er filtert mit `osmium` die benötigten Orte heraus (Versorgung, Gastronomie, Unterkünfte) und veröffentlicht das Ergebnis als Release `poi-data`. Der Server lädt dieses Paket kurz nach dem Start und danach alle 12 Stunden, sobald es einen neuen Stand gibt. Er prüft die Prüfsumme und legt es in `cache/extract/` ab. Einstellbar ist das über `POI_EXTRACT_URL` (`off` = abschalten); sofort aktualisieren geht mit `npm run extract:update`. Gegenden außerhalb des Auszugs (z. B. am Rand Europas) lädt der Server weiter bei Overpass. Lokal bauen lässt sich das Paket mit `npm run extract:build` (Linux/macOS mit `curl` und `osmium-tool`).

Eine beliebige Region lässt sich auch manuell vorab laden, z. B. 60 km um einen Ort:

```sh
npm run warm -- 53.07 8.80 60
```

Ohne diesen Server (statisch gehostet) fragt der Browser direkt bei Overpass an. Bäckereien und Cafés lädt er dann selbst im Hintergrund nach.

### Konten, gespeicherte Routen und Teilen-Links (optional, MariaDB oder MySQL)

Mit einer Datenbank – **MariaDB ab 10.5** oder **MySQL ab 8.0.16**, beide getestet (MariaDB 11.4, MySQL 8.4) – bietet der Server Benutzerkonten (Benutzername + Passwort). Damit lassen sich:

- **Routen speichern** („Meine Routen“) und auf jedem Gerät exakt so wieder öffnen, wie sie gespeichert wurden,
- **Teilen-Links** erzeugen – wer den Link öffnet, sieht die Route auch ohne Konto; Links lassen sich zurückziehen,
- **Einstellungen** (Heimatadresse, Fahrradtyp, Geschwindigkeit, Verpflegung …) zwischen Geräten abgleichen. Der ORS-API-Key bleibt nur auf dem jeweiligen Gerät.

Einrichtung:

```sql
CREATE DATABASE cyclerouter CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'cyclerouter'@'localhost' IDENTIFIED BY 'ein-sicheres-passwort';
-- Nur die Rechte, die der Server braucht (Tabellen anlegen, lesen, schreiben) – kein ALL, kein FILE
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON cyclerouter.* TO 'cyclerouter'@'localhost';
```

Dann `.env.example` nach `.env` kopieren, die Zugangsdaten eintragen und `npm install` sowie `npm start` ausführen. Die Tabellen legt der Server beim Start selbst an ([server/db.mjs](server/db.mjs)). Ohne `DB_HOST` läuft CycloRouter wie gewohnt ohne Konten.

MySQL 8 meldet Benutzer standardmäßig per `caching_sha2_password` an. Läuft die Datenbank auf demselben Rechner, funktioniert das automatisch. Bei einer Datenbank auf einem anderen Rechner `DB_SSL=true` (oder `skip-verify` bei selbst signiertem Zertifikat) setzen. Bei Verbindungsproblemen nennt die Startmeldung des Servers die Ursache und die passende Einstellung.

Sicherheit: Passwörter werden mit scrypt gehasht (verbreitete Passwörter werden abgelehnt), Sitzungen laufen über ein HttpOnly-Cookie (in der Datenbank nur als Hash), ändernde Anfragen müssen JSON sein und von derselben Seite kommen, fehlgeschlagene Anmeldungen werden je IP und je Benutzername begrenzt. „Passwort ändern“ und „Auf allen anderen Geräten abmelden“ beenden fremde Sitzungen. Gespeicherte Routen dürfen je Konto zusammen höchstens 50 MB belegen. Der Server sendet eine Content-Security-Policy und weitere Sicherheits-Header, Leaflet wird mit Integritätsprüfung (SRI) geladen.

Für den Betrieb im Internet ist **HTTPS Pflicht** (z. B. über einen Reverse-Proxy wie Caddy oder nginx). Dann `PUBLIC_URL=https://…` setzen: Das Cookie ist damit immer `Secure`, und der Server sendet HSTS. Hinter einem Proxy (z. B. Plesk/Passenger) einmal mit `DEBUG_IP=1` starten und im Log prüfen, ob die echten Nutzer-IPs erkannt werden – alle Begrenzungen hängen daran (siehe [.env.example](.env.example)).

## Routing

| Dienst | Rennrad | Gravel | Fahrrad (Trekking/Alltag) | Hinweise |
|---|---|---|---|---|
| **BRouter** (Standard) | `fastbike`, `fastbike-lowtraffic`, `fastbike-verylowtraffic` | `gravel` | `trekking` | kein Key nötig |
| **OpenRouteService** | `cycling-road` | `cycling-regular` | `cycling-regular` | kostenloser API-Key ([Registrierung](https://openrouteservice.org/dev/#/signup)), Eingabe über das Zahnrad; Rundkurse nativ über `round_trip` |

**Wenn BRouter ausgelastet ist:** Die App versucht es nach 2 und 5 Sekunden erneut und zeigt das in der Statuszeile. Klappt es dann noch nicht, rechnet sie mit [Valhalla](https://valhalla1.openstreetmap.de) (öffentlicher Server der FOSSGIS, ohne Key) und weist im Ergebnis darauf hin – Valhalla bewertet Wege etwas anders und kennt keine EuroVelo-Bevorzugung. Routen werden Teilstück für Teilstück (zwischen zwei Wegpunkten) berechnet und für die Sitzung gemerkt; kommen Verpflegungsstopps oder Übernachtungen hinzu, werden nur die geänderten Teilstücke neu angefragt.

Rundkurse und Distanz-Routen mit BRouter werden in [js/generators.js](js/generators.js) erzeugt: Wegpunkte auf einem Kreis bzw. ein Ziel in passender Luftlinie. Danach wird iterativ skaliert, bis die Länge höchstens 6 % von der Wunschdistanz abweicht.

## Aufbau

```
index.html             Oberfläche
css/style.css          Layout (hell/dunkel, mobil); Darstellung wählbar: System, Hell, Dunkel
js/main.js             Einstieg: lädt und startet die Module in js/app/

js/app/                Oberfläche und Ablauf
  state.js             App-Zustand, abgeleitete Werte, Ereignisse ('route', 'start', 'stages')
  dom.js               Elementzugriff, Statuszeile, Rückfrage-Dialog
  mapView.js           Karte, Höhenprofil, Routenlinie, Marker
  pipeline.js          Berechnung: Grundroute → Mehrtagestour → Verpflegungsstopps
  controls.js          Fahrrad, Modus, Dienst, Richtung, Distanz
  waypoints.js         Start/Ziel, Zwischenstopps, Kartenklick, Marker verschieben
  resultsView.js       Kennzahlen, Untergrund/Wegtyp, Routenname
  supplyView.js        Verpflegungsstopps, Regionen, Feiertage
  alongView.js         „Entlang der Route finden“
  stagesView.js        Mehrtagestouren und ihre Einstellungen
  exportView.js        GPX teilen/herunterladen
  accountView.js       Konto, gespeicherte Routen, Teilen-Links, Einstellungs-Abgleich
  homeView.js          Heimatadresse, Vorrat der Heimatregion auf dem Server
  settingsDialog.js    Einstellungsdialog
  theme.js             Darstellung: System (Standard), Hell oder Dunkel – nur auf diesem Gerät

js/map.js              Leaflet-Karte, Layer, Marker
js/geocode.js          Ortssuche (Photon, Nominatim als Ausweich)
js/routing/            BRouter-, ORS- und Valhalla-Anbindung (Valhalla als Ausweich), Teilstück-Cache
js/generators.js       Rundkurs- und Distanz-Generator
js/elevation.js        Höhenprofil (SVG)
js/gpx.js              GPX-Erzeugung und Teilen
js/surfaces.js         Untergrund- und Wegtyp-Kategorien
js/stops.js            Verpflegungsstopps planen
js/stays.js            Etappen und Unterkünfte für Mehrtagestouren
js/placeSearch.js      Orte entlang der Route (Kachel-Cache, sonst Photon)
js/poiTiles.js         Kachel-Cache im Browser (Speicher, IndexedDB, Server, Overpass)
js/poiSource.js        Overpass-Abfragen und Datenebenen (auch vom Server genutzt)
js/chainHours.js       Typische Öffnungszeiten von Ketten
js/timeline.js         Ankunftszeiten und Tagesetappen
js/routeGeometry.js    Positionen auf/neben der Route, Wegpunkte einfügen
js/openingHours.js     opening_hours-Auswertung
js/holidays.js         Feiertage (date.nager.at)
js/regions.js          Land/Bundesland entlang der Route (Nominatim)
js/account.js          Konto-Schnittstelle (Client)
js/shared.js           Gemeinsame Konstanten für Browser und Server

server.mjs             Server: App ausliefern, /api/pois, /api/warm, Konten
server/                POI-Cache, Datenauszug Europa, Vorrat-Warteschlange, Datenbank, Anmeldung, HTTP-Helfer
scripts/               Datenauszug Europa bauen (läuft wöchentlich in GitHub Actions)
```

## Datenquellen

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende · Kartenstil [CyclOSM](https://www.cyclosm.org), [OpenTopoMap](https://opentopomap.org), Esri World Imagery · Radrouten-Overlay [Waymarked Trails](https://cycling.waymarkedtrails.org) · Routing [BRouter](https://brouter.de), [OpenRouteService](https://openrouteservice.org) · Suche [Photon](https://photon.komoot.io)

Alle Dienste sind öffentliche, kostenlose Server mit Nutzungsbeschränkungen. Sie eignen sich für den privaten Gebrauch, nicht für hohe Last.
