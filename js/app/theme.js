/**
 * Darstellung: 'system' (Standard – hell oder dunkel wie im Betriebssystem), 'light' oder 'dark'.
 * Erzwungene Schemata setzen data-theme am <html>-Element; css/style.css hat die passenden Farbblöcke.
 * Gespeichert nur auf diesem Gerät (nicht mit dem Konto abgeglichen): Auf dem Handy will man oft etwas
 * anderes als am PC, und „System“ passt sich ohnehin jedem Gerät an.
 *
 * Beim Laden setzt ein kleines Skript in index.html das Schema schon vor dem ersten Zeichnen (gleiche Logik).
 */
import { storage } from '../utils.js';

export const THEMES = ['system', 'light', 'dark'];

// Farbe der Browser-/Statusleiste (theme-color) je Schema – wie --panel in css/style.css
const BAR_COLOR = { light: '#ffffff', dark: '#1b1a22' };

/** Gespeicherte Darstellung. */
export function savedTheme() {
  const t = storage.get('theme', 'system');
  return THEMES.includes(t) ? t : 'system';
}

/** Darstellung anwenden (ohne zu speichern – z. B. als Vorschau im Einstellungsdialog). */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  // Die beiden theme-color-Angaben gelten je nach System-Schema (media); bei erzwungenem Schema beide gleich
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    const own = m.media.includes('dark') ? 'dark' : 'light';
    m.content = BAR_COLOR[theme === 'system' ? own : theme];
  }
}

/** Darstellung speichern und anwenden. */
export function saveTheme(theme) {
  storage.set('theme', theme);
  applyTheme(theme);
}
