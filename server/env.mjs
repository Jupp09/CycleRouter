// .env laden – als ERSTER Import von server.mjs, damit alle Module die Werte schon beim Laden sehen.
// Nötig, weil Hoster wie Phusion Passenger server.mjs direkt starten (ohne `npm start` bzw. --env-file).
// Bereits gesetzte Umgebungsvariablen (z. B. aus der Hoster-Konfiguration) haben Vorrang.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(ENV_FILE)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ENV_FILE);
  else console.warn('.env gefunden, aber diese Node-Version kann sie nicht laden (ab Node 20.12) – Variablen bitte beim Hoster setzen.');
}
