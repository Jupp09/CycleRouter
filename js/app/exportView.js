/**
 * GPX-Export: auf Smartphones über das Teilen-Menü an eine App senden (z. B. Komoot), sonst herunterladen.
 * Am Desktop will man die Datei speichern, deshalb ist Teilen nur auf Mobilgeräten die Hauptfunktion.
 * exportGpx() nutzt auch die Tagesliste einer Mehrtagestour (stagesView.js) für einzelne Tage.
 */
import { downloadGpx, canShareGpx, shareGpx } from '../gpx.js';
import { state, defaultName } from './state.js';
import { $, ui, isMobile, linkButton } from './dom.js';

const shareSupported = isMobile && canShareGpx();
/** Name der Route für Datei und Track (Feld „Name“ oder Vorschlag). */
export function gpxName() {
  return ui.routeName.value.trim() || defaultName(state.route);
}
const download = () => state.route && downloadGpx(state.route, gpxName());

/**
 * GPX-Dateien der aktuellen Route ausgeben: `files` = [{name, range?}] (range: Abschnitt in m, siehe toGpx).
 * Auf dem Handy alle in einem Teilen-Vorgang, sonst (oder wenn Teilen scheitert) als Downloads.
 */
export async function exportGpx(files) {
  const r = state.route;
  if (!r) return;
  if (shareSupported) {
    try {
      await shareGpx(r, files, files.length > 1 ? gpxName() : files[0].name);
      return;
    } catch (e) {
      // Teilen nicht möglich (ein Abbruch durch den Nutzer wirft nicht) → Dateien speichern
      console.warn('Teilen nicht möglich, lade herunter:', e);
    }
  }
  for (const [i, f] of files.entries()) {
    // Kleine Pause: Manche Browser verwerfen kurz hintereinander ausgelöste Downloads
    if (i) await new Promise(res => setTimeout(res, 400));
    downloadGpx(r, f.name, f.range);
  }
}

/** Beschriftung und Hinweis je nach Gerät. */
function setupGpxButton() {
  const btn = $('#btn-gpx');
  const hint = $('#gpx-hint');
  if (shareSupported) {
    btn.textContent = 'GPX teilen';
    btn.title = 'Über das Teilen-Menü an eine App senden, z. B. Komoot';
    hint.hidden = false;
    hint.replaceChildren('An eine Navigations-App senden (z. B. Komoot) oder ', linkButton('als Datei speichern', download), '.');
  } else if (isMobile) {
    // z. B. Chrome auf Android (erlaubt kein GPX beim Teilen) oder Aufruf ohne HTTPS
    hint.hidden = false;
    hint.textContent = window.isSecureContext
      ? 'Die Datei wird heruntergeladen. Zum Navigieren in der Download-Benachrichtigung bzw. im Download-Ordner öffnen und eine App wie Komoot wählen.'
      : 'Die Datei wird heruntergeladen. Direktes Teilen an Apps (z. B. Komoot) ist nur möglich, wenn CycloRouter über HTTPS aufgerufen wird.';
  }
}

$('#btn-gpx').addEventListener('click', () => exportGpx([{ name: gpxName() }]));

setupGpxButton();
