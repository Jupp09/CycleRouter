/**
 * GPX-Export: auf Smartphones über das Teilen-Menü an eine App senden (z. B. Komoot), sonst herunterladen.
 * Am Desktop will man die Datei speichern, deshalb ist Teilen nur auf Mobilgeräten die Hauptfunktion.
 * exportGpx() nutzt auch die Tagesliste einer Mehrtagestour (stagesView.js) für einzelne Tage.
 * Dazu der FIT-Kurs für Radcomputer (exportFit, js/fit.js): gleiche Teilen-/Download-Logik.
 */
import { downloadGpx, canShareGpx, shareGpx } from '../gpx.js';
import { toFit } from '../fit.js';
import { computeStats, estimateTime, indexAtDistance } from '../utils.js';
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

// ---------- FIT-Kurs ----------

const FIT_TYPE = 'application/vnd.ant.fit';
const fitName = name => name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') + '.fit';

/**
 * FIT-Datei einer Route bzw. eines Abschnitts (`range` wie bei GPX). Die Zeiten des virtuellen Partners verteilen
 * die geschätzte reine Fahrzeit des Abschnitts (wie „Reine Fahrzeit“ im Ergebnis) über die Strecke.
 * @param {Route} r @param {{name: string, range?: {from: number, to: number}}} f
 */
function fitFile(r, f) {
  const i0 = f.range ? indexAtDistance(r, f.range.from) : 0;
  const i1 = f.range ? indexAtDistance(r, f.range.to) : r.coords.length - 1;
  const part = computeStats(r.coords.slice(i0, i1 + 1));
  const seconds = estimateTime(part.distance, part.ascent, state.bike);
  return new File([toFit(r, f.name, { range: f.range ?? null, seconds })], fitName(f.name), { type: FIT_TYPE });
}

function saveFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * FIT-Kurse ausgeben: `files` = [{name, range?}] wie bei exportGpx. Auf dem Handy über das Teilen-Menü
 * (z. B. an Garmin Connect oder die Wahoo-App), wo der Browser den Dateityp erlaubt, sonst als Downloads.
 */
export async function exportFit(files) {
  const r = state.route;
  if (!r) return;
  const list = files.map(f => fitFile(r, f));
  if (shareSupported && navigator.canShare?.({ files: list })) {
    try {
      await navigator.share({ files: list, title: files.length > 1 ? gpxName() : files[0].name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // Menü geschlossen
      console.warn('Teilen nicht möglich, lade herunter:', e);
    }
  }
  for (const [i, file] of list.entries()) {
    if (i) await new Promise(res => setTimeout(res, 400));
    saveFile(file);
  }
}

$('#btn-fit').addEventListener('click', () => exportFit([{ name: gpxName() }]));

setupGpxButton();
