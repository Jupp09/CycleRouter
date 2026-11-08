// Sicherheits-Header für alle Antworten und die Content-Security-Policy (CSP) für index.html.
import { createHash } from 'node:crypto';
import { isHttps } from './auth.mjs';

/**
 * Dienste, die der Browser direkt anspricht (siehe js/map.js, js/routing/, js/poiSource.js, js/geocode.js,
 * js/regions.js, js/holidays.js). **Ein neuer externer Dienst muss hier eingetragen werden**, sonst
 * blockiert der Browser die Anfrage (Fehler „Content-Security-Policy“ in der Konsole).
 */
const CONNECT = [
  'https://brouter.de', 'https://api.openrouteservice.org',
  'https://overpass-api.de', 'https://overpass.kumi.systems',
  'https://photon.komoot.io', 'https://nominatim.openstreetmap.org', 'https://date.nager.at',
];
/** Kartenkacheln (BASE_LAYERS/OVERLAYS in js/map.js); cdnjs für die Bilder aus leaflet.css */
const IMAGES = [
  'https://*.tile-cyclosm.openstreetmap.fr', 'https://tile.openstreetmap.org', 'https://*.tile.opentopomap.org',
  'https://server.arcgisonline.com', 'https://tile.waymarkedtrails.org', 'https://cdnjs.cloudflare.com',
];
const CDN = 'https://cdnjs.cloudflare.com';

/**
 * SHA-256 jedes Inline-Skripts (in index.html nur das Theme-Skript) – erlaubt genau diese, kein anderes.
 * Wird bei jeder Auslieferung aus der Datei berechnet, passt also nach einem `git pull` ohne Neustart.
 * Der HTML-Parser macht aus CRLF ein LF, bevor der Browser hasht (Windows-Checkout) – daher normalisieren.
 */
function inlineScriptHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64')}'`);
}

/**
 * CSP für eine HTML-Seite. Schützt vor eingeschleustem Code (XSS): Skripte nur von hier, von cdnjs (mit
 * SRI in index.html) und die gehashten Inline-Skripte; Daten nur von den bekannten Diensten; keine
 * Einbettung in fremde Seiten (Clickjacking).
 */
export function contentSecurityPolicy(html, req) {
  return [
    "default-src 'self'",
    `script-src 'self' ${CDN} ${inlineScriptHashes(html).join(' ')}`,
    `style-src 'self' ${CDN}`,
    `img-src 'self' data: blob: ${IMAGES.join(' ')}`,
    `connect-src 'self' ${CONNECT.join(' ')}`,
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isHttps(req) ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** Header für jede Antwort (Dateien und API). */
export function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');         // Dateityp nicht erraten (z. B. JSON als Skript)
  res.setHeader('X-Frame-Options', 'DENY');                   // ältere Browser ohne frame-ancestors
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // Nominatim/Photon sehen nur die Domain
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // HSTS: Der Browser nutzt danach ein Jahr lang nur noch HTTPS (kein Abfangen über ein erstes http://)
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
