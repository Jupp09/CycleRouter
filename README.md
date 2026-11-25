# CycloRouter

Routenplaner für **Rennrad**, **Gravelbike**, **Trekking** (Trekking-, Touren- und Alltagsrad) und **E-Bike** (Pedelec bis 25 km/h) auf Basis von OpenStreetMap. In den Einstellungen lässt sich festlegen, welche Fahrradtypen und Routenarten die Umschalter zeigen.

- **A → B** – Route zwischen Start und Ziel
- **Distanz** – Start + Wunschdistanz, das Ziel wird automatisch gewählt
- **Rundkurs** – Schleife mit Wunschdistanz zurück zum Start; mit der Einstellung „Rundkurs nach: Fahrzeit“ stattdessen mit Wunschfahrzeit (z. B. 2 h reine Fahrzeit – die Länge ergibt sich aus Tempo und Anstiegen)
- **GPX-Export** inkl. Höhendaten
- **Route als Link, ohne Konto:** Die Adresse enthält die Route (hinter „#“, wird nie an den Server geschickt). „Link teilen“ kopiert sie bzw. öffnet am Handy das Teilen-Menü; wer den Link öffnet, bekommt dieselbe Route – auch denselben Rundkurs. Neuladen und Lesezeichen behalten die Route. Angemeldet erzeugt „Link teilen“ wie bisher den zurückziehbaren Konto-Link, der auch importierte GPX-Strecken kann
- **Offline-Start:** Die installierte App startet auch ohne Netz. Angemeldet zeigt „Meine Routen“ den zuletzt geladenen Stand; öffnen lassen sich die auf dem Gerät schon geöffneten Routen und die 20 zuletzt geänderten – mit Höhenprofil, Steigungen und Roadbook. Neue Routen, Ortssuche, Stopps, Wetter und der Kartenhintergrund brauchen Netz. Beim Abmelden wird das Gemerkte gelöscht
- **Karte:** Standard ist ein blasser CyclOSM-Stil („CyclOSM ruhig“), auf dem die Route deutlich heraussticht; CyclOSM in voller Farbe, OpenStreetMap, OpenTopoMap und Satellit bleiben wählbar. Eine neue Route füllt die Karte; Marker nennen im Tooltip, dass man sie ziehen kann
- **Aufgeräumtes Panel:** Oben ein Satz, worum es geht (bis zur ersten Route). Nach dem Berechnen klappen die Eingaben zu einer Zeile („A → B · Köln → Bonn · Trekking · Ändern“) zusammen, das Ergebnis steht oben. „Stopps unterwegs“ bündelt Verpflegungsstopps, Trinkwasser und „Entlang der Route finden“. Rückgängig, Wiederholen und „GPX“ (Datei öffnen) in der Kopfzeile; im Formular erst wohin, dann Fahrrad (als Auswahl mit eigener Überschrift), optional die Abfahrt – dann zeigt das Ergebnis gleich Ankunft und Tageslicht –, bei Distanz und Rundkurs zuletzt „Route erstellen“; Verkehr, EuroVelo und Routing-Dienst unter „Mehr Optionen“ (zugeklappt zeigt die Überschrift, was vom Standard abweicht)
- **Handy-Layout:** Die Karte füllt den Bildschirm, das Panel liegt als Blatt darüber (Stufen Kurz / Halb / Voll; am Griff ziehen oder ihn antippen). Halb offen sind Start und Ziel ohne Scrollen sichtbar; bei Distanz und Rundkurs bleibt „Route erstellen“ unten im Blatt stehen, auch wenn das Formular weiter reicht; nach dem Berechnen fährt das Blatt von selbst auf „Kurz“ (Distanz, Höhenmeter und Fahrzeit, bei zu wenig Tageslicht ein kurzer Hinweis, darüber das Höhenprofil), die Route liegt frei auf der Karte; „GPX“ und – solange angeboten – „Mehrtagestour planen“ stehen fest am unteren Rand des Blatts; „Details“ und „Ändern“ öffnen das Blatt ganz
- **Übersichtliches Ergebnis:** Distanz, Höhenmeter und reine Fahrzeit auf einen Blick, mit festgelegter Abfahrt auch die Ankunft (inkl. Pausen, bei späterem Tag mit Wochentag); direkt darunter, ob die Route an einem Tag zu schaffen ist – reicht das Tageslicht nicht, erscheint der Hinweis hervorgehoben zusammen mit „Als Mehrtagestour planen“; darunter die übrigen Hinweise (Radfernwege, Bahnhof am Ziel, Wetter, Wind) als Liste mit Symbolen, bei passendem Wind ein Knopf „Rundkurs gegen den Wind starten“; die Aufschlüsselung lässt Zeilen unter 50 m weg; „GPX exportieren“ direkt darunter; Roadbook, Teilen, Speichern und Löschen gebündelt unter „Route weiterverwenden“. Das Höhenprofil passt seine Achse an die Daten an (flache Strecken 0–20 m)
- **Roadbook drucken:** eine Übersicht zum Ausdrucken oder als PDF – je Tag Länge, Anstieg, Abfahrt und Ankunft, Tageslicht, das Höhenprofil des Tages (nach Steigung gefärbt und schraffiert, also auch schwarz-weiß lesbar), größte Anstiege, eine Tabelle der Verpflegungsstopps, Zwischenstopps und Trinkwasserstellen mit Ankunftszeit und Öffnungszeiten sowie die Unterkunft mit Preis, Telefon und Webseite. Die installierte App auf iPhone und iPad hat keinen Druckdialog; dort zeigt „Roadbook anzeigen“ die Übersicht am Bildschirm, gedruckt wird in Safari
- **GPX-Import:** eine vorhandene Strecke öffnen („GPX-Datei öffnen“ oder Datei auf die Karte ziehen) und Verpflegungsstopps, Trinkwasser, Unterkünfte und Wetter entlang davon planen. Die Datei wird im Browser gelesen und verlässt das Gerät nicht. Der importierte Weg bleibt erhalten: Nur die kurzen Abstecher zu Stopps, Unterkünften und Zwischenstopps werden berechnet. Untergrund und Wegtyp sind für den importierten Weg unbekannt; wer Start oder Ziel verschiebt und danach neu berechnet, bekommt eine gewöhnliche Route
- Höhenprofil, Höhenmeter, geschätzte Fahrzeit – Maus über die Routenlinie (am Handy: antippen) zeigt die Stelle im Höhenprofil mit km, Höhe, Untergrund und Steigung, und umgekehrt
- **Steigungen:** Aufschlüsselung nach Steigungsklassen (bergab, flach, 3–6 %, 6–10 %, über 10 %) – im Höhenprofil farbig und schraffiert, auf Wunsch auch auf der Routenlinie – und die Liste der größten Anstiege mit Höhenmetern, Länge und Steigung; ein Klick zeigt den Anstieg auf der Karte ([js/climbs.js](js/climbs.js))
- **Entlang der Route finden:** Café, Restaurant, Bäckerei, Supermarkt, Tankstelle, dazu **Fahrradladen, Reparaturstation, Luftpumpe** und **Bahnhöfe** (bis 3 km, als Ausstieg) – fürs E-Bike auch **Ladestationen**. Bei A → B nennt die App den nächsten Bahnhof am Ziel für die Rückfahrt
- **Tageslicht:** Sonnenauf- und -untergang am Start und Ziel, lokal berechnet ([js/sun.js](js/sun.js)). Mit festgelegter Abfahrt (Verpflegungsstopps oder Mehrtagestour) warnt die App, wenn ein Teil der Fahrt im Dunkeln liegt – geht die Fahrt über Nacht, mit Ankunftstag und den Dunkelstunden aller Nächte zusammen; bei Mehrtagestouren je Tag; sonst zeigt sie den hellen Tag heute
- **Wetter und Wind** entlang der Route zur geschätzten Ankunftszeit ([js/weather.js](js/weather.js), Daten von [Open-Meteo](https://open-meteo.com/)): Temperatur, Regenwahrscheinlichkeit und ob der Wind von vorn oder hinten kommt – als Zusammenfassung (bei Mehrtagestouren je Tag) und je Abschnitt von etwa 10 km. Ohne festgelegte Abfahrt gilt „jetzt“; die Vorhersage reicht 16 Tage. Bei Rundkurs und Distanz schlägt die App vor, die Route günstiger in den Wind zu legen (Rundkurs dorthin, woher der Wind kommt: Rückenwind auf dem Rückweg). Der Wind ändert die geschätzte Fahrzeit nicht. An Open-Meteo gehen nur auf 0,1° gerundete Orte
- Aufschlüsselung nach **Untergrund** (Asphalt, Pflaster, Schotter …) und **Wegtyp** (Radweg, Hauptstraße, Wirtschaftsweg …) mit km und %, optional als Einfärbung der Route und als Farbband im Höhenprofil ([js/surfaces.js](js/surfaces.js))
- Marker verschiebbar – die Route wird neu berechnet
- **Rückgängig und Wiederholen** (Knöpfe oder Strg+Z / Strg+Umschalt+Z) für Änderungen an Start, Ziel, Zwischenstopps und Markern, für „Löschen“, „Neu würfeln“ und das Öffnen einer Route – der vorige Stand kommt exakt und ohne Neuberechnung zurück
- **Mehrtagestouren** auf Knopfdruck (sobald die Route länger als die eingestellten km pro Tag ist): Tagesetappen, je Nacht wählbare Unterkunft (Hotel, Pension, Hostel, Zeltplatz aus OpenStreetMap; auf Wunsch auch Shelter – in den Einstellungen unter Unterkunftsarten zuschalten, nur in Dänemark, Schweden und Norwegen, wo man darin übernachten darf; mehrere Shelter eines Platzes zählen einmal, dazu Plätze, Feuerstelle, ob gebucht werden muss und „Infos & Buchung“, in Dänemark oft udinaturen.dk) mit geschätztem Preis gegen das Budget pro Nacht und „Preis prüfen“-Link mit Datum ([js/stays.js](js/stays.js)). Die Länge jedes Tages außer dem letzten lässt sich unter „Länge ändern“ in einem eigenen Fenster mit Schieberegler einstellen; beim Ziehen zeigt es Fahrzeit, Höhenmeter, Ankunft und ob das Tageslicht reicht. Der Tag und die Tage davor bleiben dann fest („Länge freigeben“ im selben Fenster hebt das auf), die Tage danach teilen sich den Rest gleichmäßig – reicht das nicht mit den eingestellten km pro Tag, kommt ein Tag dazu, bleibt deutlich weniger, fällt einer weg. Gespeicherte Routen behalten die Aufteilung. Jeder Tag lässt sich einzeln als GPX exportieren (Track von Unterkunft zu Unterkunft, mit den Wegpunkten dieses Tages), auf dem Handy alle Tage auf einmal über das Teilen-Menü
- **Verpflegung unterwegs** ([js/stops.js](js/stops.js)):
  - Alle *x* km ein Stopp mit Essen (Supermarkt, Kiosk, Bäckerei, Café, Restaurant, Tankstelle), der bei der geschätzten Ankunft geöffnet hat – mit Feiertagen am Ort und typischen Öffnungszeiten von Ketten. Die Route führt durch die Stopps.
  - **Pausenstil** in den Einstellungen: *Zügig* (Supermarkt und Tankstelle, 10 min je Stopp) oder *Gemütlich* (Café, Bäckerei, Restaurant, keine Tankstellen, 30 min je Stopp).
  - Öffentliche, kostenlose **Trinkwasserstellen** bis 400 m neben der Route werden immer angezeigt (Karte, Liste, GPX), aber nicht angefahren. Strecken über 50 km ohne Wasser werden gemeldet.
  - **Popups** zeigen die Öffnungszeiten aus OpenStreetMap (bzw. die typischen der Kette) und verlinken auf den OSM-Eintrag: *In OSM ansehen*, *Bearbeiten* (Editor auf openstreetmap.org, OSM-Konto nötig – z. B. um fehlende Öffnungszeiten nachzutragen) und *Fehler melden* (Hinweis ohne Konto).
  - **In die Route aufnehmen:** Wasserstellen und Orte aus „Entlang der Route finden“ lassen sich per Knopf als Zwischenstopp hinzufügen. Ein geplanter Verpflegungsstopp lässt sich mit 📌 als *festen* Zwischenstopp übernehmen. Er bleibt beim Neuplanen in der Route und zählt weiter als Stopp, damit nicht gleich daneben ein weiterer geplant wird.
- „Neu würfeln" erzeugt eine andere Variante, optional mit Wunschrichtung
- **Barrierefrei bedienbar:** komplett per Tastatur (Pfeiltasten in den Umschaltern, Ortssuche mit Vorschlagsliste, alle Listen), Ansagen für Screenreader (Ergebnis, Statusmeldungen, Anzahl der Vorschläge), Höhenprofil mit Textzusammenfassung und per Pfeiltasten abfahrbar, deutlicher Fokusrahmen, ausreichende Kontraste in Hell und Dunkel; Schrift folgt der Grundschriftgröße des Browsers, Farben auch bei Rot-Grün-Schwäche unterscheidbar (unbefestigte Wege zusätzlich gestrichelt; Start als heller Ring, Ziel dunkel mit Zielflagge statt grün und rot; Stopps mit unklaren Öffnungszeiten gestrichelt und mit „?“; aufklappbare Legende der Kartensymbole; nahe Stopps, Wasserstellen und Suchtreffer bei kleinem Maßstab zu einem Marker mit Anzahl zusammengefasst), Windows-Kontrastmodus und „Bewegung reduzieren“ werden berücksichtigt; geprüft mit axe-core

## Starten

Reine statische Seite ohne Build-Schritt. Sie muss über einen lokalen Webserver laufen (ES-Module funktionieren nicht über `file://`):

```sh
git clone https://github.com/Jupp09/CycleRouter.git
cd CycleRouter
npm start
```

Danach <http://localhost:8000> öffnen. Der Server ([server.mjs](server.mjs)) liefert immer den Projektordner aus. Ein anderer Port geht mit `PORT=8080`.

Alternativ geht jeder statische Server, er muss aber **im Projektordner** gestartet werden, sonst erscheint nur eine Dateiliste: `py -m http.server 8000`.

### Schneller Start

Der Server liefert die App-Dateien mit `ETag` aus. Ein wiederkehrender Browser fragt nur nach, ob sich etwas geändert hat, und bekommt meist ein leeres `304`; ein Update wirkt trotzdem sofort. In `index.html` setzt er `modulepreload`-Links für alle Module, damit der Browser sie gleichzeitig lädt statt Ebene für Ebene. Mit einem anderen statischen Server läuft die App weiter, nur ohne diese beiden Beschleuniger.

Wie lange die Schritte einer Berechnung dauern, steht nach jeder Route in der Browser-Konsole (`Berechnung: Grundroute … · Orte laden … · … · gesamt …`).

### Server-Cache für Verpflegungsstellen

Über `npm start` liefert der Server zusätzlich `POST /api/pois`: Supermärkte, Tankstellen und Trinkwasserstellen inkl. Öffnungszeiten werden je Kachel (≈ 11 × 7 km) im Ordner `cache/pois/` gespeichert. Gültigkeit 30 Tage (änderbar mit `POI_TTL_DAYS`). Danach wird der alte Stand sofort ausgeliefert und im Hintergrund erneuert. Overpass wird nur noch für noch nie geladene Gegenden abgefragt.

**Heimatregion auf Vorrat:** Speichert jemand in den Einstellungen eine Heimatadresse, lädt der Server alle Kacheln im Umkreis von 200 km (≈ 1.900 Kacheln) in den gemeinsamen Cache – sie stehen danach allen Nutzern des Servers zur Verfügung ([server/warmQueue.mjs](server/warmQueue.mjs)). Übermittelt werden nur auf ~10 km gerundete Koordinaten, nie die Adresse. Der Abruf läuft im Hintergrund nacheinander mit Pausen (Routenanfragen haben Vorrang), nahe Kacheln zuerst, und dauert je nach Overpass-Last etwa 30–90 Minuten. Die Warteschlange (`cache/warm-queue.json`) überlebt Neustarts. Schutz: höchstens 3 neue Regionen je Nutzer und Tag, 20 wartende Regionen insgesamt, nahe beieinander liegende Heimatorte (≤ 30 km) zählen als eine Region. Den Fortschritt zeigt der Einstellungsdialog.

**Vorrat entlang der Route:** Nach jeder berechneten Route meldet die App deren Kacheln an `POST /api/warm-route`. Der Server lädt dann im Hintergrund alle Datenebenen (Versorgung, Gastronomie, Unterkünfte, Fahrrad-Service und Bahnhöfe), die dort noch fehlen. So haben Verpflegungsstopps, „Entlang der Route finden“ und Mehrtagestouren beim nächsten Mal sofort Daten. Routen kommen in der Warteschlange vor Heimatregionen. Mehrere fehlende Ebenen derselben Kacheln fragt der Server mit einer einzigen Overpass-Abfrage ab.

**Schnelle Verpflegungsstopps:** Die Stopps warten nur auf Trinkwasser, Supermärkte und Tankstellen. Bäckereien, Cafés und Restaurants nimmt die App, soweit sie schon im Cache liegen; den Rest lädt der Server nach, und ein Hinweis weist darauf hin. Die Feiertagsprüfung (Länder und Bundesländer über Nominatim, höchstens eine Anfrage pro Sekunde) läuft im Hintergrund. Der Server merkt sich jeden abgefragten Punkt dauerhaft für alle Nutzer (`cache/regions.json`, [server/regions.mjs](server/regions.mjs)). Auf schon einmal befahrenen Strecken dauert die Prüfung damit Millisekunden statt Sekunden. Nur wenn an einem Fahrtag tatsächlich ein Feiertag gilt, werden die Stopps danach angepasst.

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

### Tests

`npm test` startet einen eigenen Testserver (Port 8765, ohne Datenbank) und Edge oder Chrome ohne Fenster und prüft die App im Browser: Routen, Verpflegung, Popups, Einstellungen, Mehrtagestouren, Tageslicht, Wetter, GPX-Import, Fahrrad-Service und Bahnhöfe, Steigungen, Rückgängig, Roadbook, Offline-Start, Grenzfälle der Fachlogik (Zeitumstellung, Öffnungszeiten, Zeitlimits), Zoomgrenzen der Kartenstile, Konten (mit einer Konto-Attrappe im Speicher), Tastaturbedienung und Barrierefreiheit (axe-core, hell und dunkel). `npm test -- keyboard a11y` führt nur einzelne Tests aus, `--shots` legt Screenshots in `tests/out/` ab. Nach jedem Lauf zeigt `tests/out/bericht.html` die Ergebnisse grafisch: je Test Dauer, Prüfungen, Screenshots und der Verlauf der letzten Läufe. Die Tests nutzen die echten Routing- und Kartendienste, brauchen also Internet und dauern einige Minuten.

`npm run check` ist die schnelle Prüfung ohne Browser und ohne Netz (wenige Sekunden): `npm run typecheck` prüft die Typen über die JSDoc-Angaben im Code ([jsconfig.json](jsconfig.json), TypeScript nur als Prüfwerkzeug – ausgeliefert werden weiter dieselben Dateien, ohne Build-Schritt), `npm run test:unit` führt die Unit-Tests in `tests/unit/` aus (Öffnungszeiten, Anstiege, Kacheln, Begrenzungen, BRouter-Weiterleitung, Konto-Eingaben …). Beides läuft bei jedem Push in GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

Nach einem Deploy prüft `npm run check:live` die Installation von außen (Standard: https://cyclorouter.de, sonst Adresse angeben, z. B. `npm run check:live -- http://localhost:8000`): private Dateien wie `.env` gesperrt, `index.html` kommt von Node (CSP, ein `modulepreload` je Modul wie lokal – sonst fehlt ein Deploy oder Neustart), genau ein HSTS-Header, Schnittstellen erreichbar, Anfragen fremder Seiten abgelehnt, Weiterleitung von http://.

### Fehlerberichte

Ungefangene Fehler im Browser meldet die App an den eigenen Server (`POST /api/client-error`, [js/errorReport.js](js/errorReport.js)); er schreibt sie ins Server-Log (Zeile „Browserfehler: …“, bei Plesk im Log der Node-App) und speichert nichts weiter, auch keine IP. Gesendet werden nur Meldung, Stack, Fundstelle, ob die installierte App läuft, und – vom Server – grob Browser und System. Adressen werden ohne Abfrage und #-Teil gemeldet (darin stehen die Routenpunkte), Zahlen mit drei oder mehr Nachkommastellen (Koordinaten) werden durch „…“ ersetzt. Höchstens 5 Berichte je Seitenaufruf, gleiche Fehler stehen je Stunde einmal im Log. Ohne den Node-Server (statischer Server) sendet die App nichts.

## Routing

| Dienst | Rennrad | Gravel | Trekking (Touren/Alltag) | E-Bike | Hinweise |
| --- | --- | --- | --- | --- | --- |
| **BRouter** (Standard) | `fastbike`, `fastbike-lowtraffic`, `fastbike-verylowtraffic` | `gravel` | `trekking` | `trekking` ohne Höhenmeter-Scheu (`profile:consider_elevation=0`) | kein Key nötig |
| **OpenRouteService** | `cycling-road` | `cycling-regular` | `cycling-regular` | `cycling-electric` | kostenloser API-Key ([Registrierung](https://openrouteservice.org/dev/#/signup)), Eingabe über das Zahnrad; Rundkurse nativ über `round_trip` |

**Wenn BRouter ausgelastet ist:** Die App versucht es nach 2 und 5 Sekunden erneut und zeigt das in der Statuszeile. Klappt es dann noch nicht, rechnet sie mit [Valhalla](https://valhalla1.openstreetmap.de) (öffentlicher Server der FOSSGIS, ohne Key) und weist im Ergebnis darauf hin – Valhalla bewertet Wege etwas anders und kennt keine EuroVelo-Bevorzugung. Routen werden Teilstück für Teilstück (zwischen zwei Wegpunkten) berechnet und für die Sitzung gemerkt; kommen Verpflegungsstopps oder Übernachtungen hinzu, werden nur die geänderten Teilstücke neu angefragt.

**Eigener BRouter-Server:** Mit `BROUTER_URL` in der `.env` (z. B. `https://brouter.example.org`) rechnet die App zuerst dort. BRouter selbst spricht nur `http://`; für eine verschlüsselte Verbindung kommt davor ein Reverse-Proxy mit Zertifikat (z. B. Caddy mit Let's Encrypt), und BRouter lauscht nur auf `localhost`. Der Browser fragt nicht direkt an, sondern über den CycloRouter-Server (`/api/brouter`, [server/brouterProxy.mjs](server/brouterProxy.mjs)) – so geht auch ein BRouter, der nur `http://` spricht, und der Rechner muss nur für den CycloRouter-Server erreichbar sein. `BROUTER_PARALLEL` gibt an, wie viele Anfragen gleichzeitig zu ihm gehen (Standard 1) – höchstens so viele, wie BRouter Threads hat, sonst bricht er überzählige nach 2 Sekunden ab. Ist der eigene Server weg, ausgelastet oder fehlen ihm Kartendaten oder ein Profil, rechnet die App mit brouter.de, danach wie oben mit Valhalla. Unter der Route steht, welcher Server gerechnet hat (bei beiden mit Anteilen nach Strecke). Beim eigenen Server sucht BRouter in einem statt zwei Durchgängen (`pass1coefficient=1.2`, `pass2coefficient=-1`): etwa doppelt so schnell, die Routen bleiben praktisch gleich (Kosten +0 bis 0,2 %). Auf dem eigenen Server müssen die Profile aus [profiles/](profiles/) liegen und eine `lookups.dat`, die zu ihnen passt.

Rundkurse und Distanz-Routen mit BRouter werden in [js/generators.js](js/generators.js) erzeugt: Wegpunkte auf einem Kreis bzw. ein Ziel in passender Luftlinie. Danach wird iterativ skaliert, bis die Länge höchstens 6 % von der Wunschdistanz abweicht – beim Rundkurs nach Fahrzeit die geschätzte reine Fahrzeit (Tempo plus Anstiege) von der Wunschzeit. Nach 5 Versuchen gilt der beste; vereinzelt liegt er dann weiter daneben.

## Aufbau

```text
index.html             Oberfläche
sw.js                  Service Worker: App-Dateien für den Offline-Start merken
css/style.css          Layout (hell/dunkel, mobil); Darstellung wählbar: System, Hell, Dunkel
js/main.js             Einstieg: lädt und startet die Module in js/app/

js/app/                Oberfläche und Ablauf
  state.js             App-Zustand, abgeleitete Werte, Ereignisse ('route', 'start', 'stages')
  dom.js               Elementzugriff, Statuszeile, Rückfrage-Dialog
  mapView.js           Karte, Höhenprofil, Routenlinie, Marker
  pipeline.js          Berechnung: Grundroute → Mehrtagestour → Verpflegungsstopps
  controls.js          Fahrrad, Modus, Dienst, Richtung, Distanz
  waypoints.js         Start/Ziel, Zwischenstopps, Kartenklick, Marker verschieben
  resultsView.js       Kennzahlen, Tageslicht, Untergrund/Wegtyp, Routenname
  weatherView.js       Wetter und Wind entlang der Route
  supplyView.js        Verpflegungsstopps, Trinkwasser, Regionen, Feiertage
  alongView.js         „Entlang der Route finden“
  stagesView.js        Mehrtagestouren, ihre Einstellungen und GPX je Tag
  exportView.js        GPX teilen/herunterladen
  roadbookView.js      Roadbook drucken
  importView.js        GPX-Datei öffnen
  history.js           Rückgängig und Wiederholen
  routesView.js        Gespeicherte Routen, „Meine Routen“, Teilen-Links
  linkView.js          Route als Link in der Adresse (ohne Konto)
  planView.js          Eingaben nach dem Berechnen einklappen
  sheetView.js         Handy: Panel als Blatt über der Karte
  accountView.js       Anmelden, Passwort, Konto löschen, Einstellungs-Abgleich
  homeView.js          Heimatadresse, Vorrat der Heimatregion auf dem Server
  settingsDialog.js    Einstellungsdialog
  theme.js             Darstellung: System (Standard), Hell oder Dunkel – nur auf diesem Gerät

js/map.js              Leaflet-Karte, Layer, Marker
js/geocode.js          Ortssuche (Photon, Nominatim als Ausweich)
js/routing/            BRouter-, ORS- und Valhalla-Anbindung (Valhalla als Ausweich), Teilstück-Cache
js/generators.js       Rundkurs- und Distanz-Generator
js/elevation.js        Höhenprofil (SVG)
js/gpx.js              GPX-Erzeugung, Teilen und Einlesen
js/surfaces.js         Untergrund- und Wegtyp-Kategorien
js/stops.js            Verpflegungsstopps planen, Trinkwasser an der Route
js/stays.js            Etappen und Unterkünfte für Mehrtagestouren
js/placeSearch.js      Orte entlang der Route (Kachel-Cache, sonst Photon)
js/poiTiles.js         Kachel-Cache im Browser (Speicher, IndexedDB, Server, Overpass)
js/poiSource.js        Overpass-Abfragen und Datenebenen (auch vom Server genutzt)
js/chainHours.js       Typische Öffnungszeiten von Ketten
js/timeline.js         Ankunftszeiten und Tagesetappen
js/sun.js              Sonnenauf- und -untergang, Tageslicht-Hinweise
js/cluster.js          Nahe Kartenmarker zusammenfassen (ohne Leaflet, testbar)
js/climbs.js           Steigungsklassen und größte Anstiege
js/weather.js          Wetter und Wind entlang der Route (Open-Meteo)
js/routeGeometry.js    Positionen auf/neben der Route, Wegpunkte einfügen
js/openingHours.js     opening_hours-Auswertung
js/holidays.js         Feiertage (date.nager.at)
js/regions.js          Land/Bundesland entlang der Route (Nominatim)
js/account.js          Konto-Schnittstelle (Client)
js/offlineStore.js     Datenbank im Browser: Kachel-Cache und Offline-Speicher fürs Konto
js/shared.js           Gemeinsame Konstanten und Helfer für Browser und Server
js/errorReport.js      Fehlerberichte an den eigenen Server (ohne Ortsangaben)

server.mjs             Server: App ausliefern, /api/pois, /api/warm, /api/brouter, /api/client-error, Konten
server/                POI-Cache, Datenauszug Europa, Vorrat-Warteschlange, BRouter-Weiterleitung, Fehlerberichte, Datenbank, Anmeldung, HTTP-Helfer
scripts/               Datenauszug Europa bauen (läuft wöchentlich in GitHub Actions), Prüfung einer Installation von außen
types/                 Typen für die Typprüfung (Routenobjekt, Leaflet als globale Variable) – werden nicht ausgeliefert
```

## Datenquellen

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende · Kartenstil [CyclOSM](https://www.cyclosm.org), [OpenTopoMap](https://opentopomap.org), Esri World Imagery · Radrouten-Overlay [Waymarked Trails](https://cycling.waymarkedtrails.org) · Routing [BRouter](https://brouter.de), [OpenRouteService](https://openrouteservice.org) · Suche [Photon](https://photon.komoot.io)

Alle Dienste sind öffentliche, kostenlose Server mit Nutzungsbeschränkungen. Sie eignen sich für den privaten Gebrauch, nicht für hohe Last.
