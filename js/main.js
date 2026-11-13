/**
 * Einstieg der App. Die eigentliche Logik liegt in js/app/:
 *
 *   state.js          Zustand, abgeleitete Werte, Ereignisse ('route', 'start', 'stages', 'account')
 *   dom.js            Elementzugriff, Statuszeile, Rückfrage-Dialog
 *   mapView.js        Karte, Höhenprofil, Routenlinie, Marker
 *   pipeline.js       Berechnungsablauf (Grundroute → Mehrtagestour → Verpflegungsstopps)
 *   controls.js       Fahrrad, Modus, Dienst, Distanz …
 *   waypoints.js      Start/Ziel, Zwischenstopps, Kartenklick, Marker verschieben
 *   resultsView.js    Kennzahlen, Tageslicht, Untergrund/Wegtyp, Routenname
 *   weatherView.js    Wetter und Wind entlang der Route
 *   supplyView.js     Verpflegungsstopps, Regionen, Feiertage
 *   alongView.js      „Entlang der Route finden“
 *   stagesView.js     Mehrtagestouren
 *   exportView.js     GPX teilen/herunterladen
 *   importView.js     GPX-Datei öffnen
 *   history.js        Rückgängig und Wiederholen
 *   routesView.js     gespeicherte Routen, „Meine Routen“, Teilen-Links
 *   accountView.js    Anmelden, Passwort, Konto löschen, Einstellungs-Abgleich
 *   homeView.js       Heimatadresse und Vorrat auf dem Server
 *   settingsDialog.js Einstellungsdialog
 *
 * Die Module hängen beim Laden nur ihre Ereignis-Handler an; Aufrufe zwischen ihnen passieren erst in
 * diesen Handlern. Deshalb sind die gegenseitigen Importe (z. B. pipeline ↔ waypoints) unproblematisch.
 */
import { syncUi } from './app/controls.js';
import './app/waypoints.js';
import './app/resultsView.js';
import './app/weatherView.js';
import './app/supplyView.js';
import './app/alongView.js';
import './app/stagesView.js';
import './app/exportView.js';
import './app/importView.js';
import './app/history.js';
import './app/routesView.js';
import { initAccount } from './app/accountView.js';
import { initHome } from './app/homeView.js';
import './app/settingsDialog.js';

syncUi();
initHome();   // Heimatadresse als Standard-Startort
initAccount(); // Konto, Einstellungs-Abgleich, geteilter Link (?route=…)
