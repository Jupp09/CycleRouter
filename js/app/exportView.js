/**
 * GPX-Export: auf Smartphones über das Teilen-Menü an eine App senden (z. B. Komoot), sonst herunterladen.
 * Am Desktop will man die Datei speichern, deshalb ist Teilen nur auf Mobilgeräten die Hauptfunktion.
 */
import { downloadGpx, canShareGpx, shareGpx } from '../gpx.js';
import { state, defaultName } from './state.js';
import { $, ui, isMobile, linkButton } from './dom.js';

const shareSupported = isMobile && canShareGpx();
const gpxName = () => ui.routeName.value.trim() || defaultName(state.route);
const download = () => state.route && downloadGpx(state.route, gpxName());

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

$('#btn-gpx').addEventListener('click', async () => {
  if (!state.route) return;
  if (!shareSupported) { download(); return; }
  try {
    await shareGpx(state.route, gpxName());
  } catch (e) {
    // Teilen nicht möglich (ein Abbruch durch den Nutzer wirft nicht) → Datei speichern
    console.warn('Teilen nicht möglich, lade herunter:', e);
    download();
  }
});

setupGpxButton();
