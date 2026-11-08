// Auslieferung der App-Dateien (index.html, js/, css/ …) mit Zwischenspeicher, ETag/304 und Modul-Vorladen.
//
// - Jede Datei wird mit `Cache-Control: no-cache` und einem ETag ausgeliefert. Der Browser fragt bei jedem Start
//   nach („geändert?“) und bekommt meist nur ein leeres 304 – ein Update (git pull) wirkt trotzdem sofort.
// - index.html bekommt <link rel="modulepreload"> für alle Module, die js/main.js (direkt oder indirekt) statisch
//   importiert. Sonst entdeckt der Browser die Imports Ebene für Ebene und braucht je Ebene eine Runde zum Server.
//   Die Liste entsteht hier aus den Dateien selbst – niemand muss sie pflegen.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, dirname, relative, sep } from 'node:path';

const ENTRY = 'js/main.js';
/** So lange gilt die fertige index.html (samt Modulliste), bevor die Dateien erneut geprüft werden. */
const HTML_TTL = 2000;

/** Zwischenspeicher je Datei: {mtimeMs, size, body, etag} – geprüft wird bei jedem Abruf nur Datum und Größe. */
const files = new Map();

async function loadFile(file) {
  const st = await stat(file);
  if (!st.isFile()) throw Object.assign(new Error('Keine Datei'), { code: 'ENOENT' });
  const hit = files.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const body = await readFile(file);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, body, etag: etagOf(body) };
  files.set(file, entry);
  return entry;
}

const etagOf = body => `"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`;

/**
 * Passt der ETag aus If-None-Match? Apache/Plesk hängt beim Komprimieren an den ETag z. B. „-br“ oder „-gzip“
 * an und schickt ihn so zurück – diesen Zusatz ignorieren, sonst gäbe es hinter Plesk nie ein 304.
 */
function matches(header, etag) {
  if (!header) return false;
  const bare = etag.slice(1, -1);
  return header.split(',').some(t => {
    const v = t.trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(/-(br|gzip|deflate)$/, '');
    return v === bare || v === '*';
  });
}

// ---------- Modulliste für index.html ----------

/** Statische Imports eines Moduls (`import … from '…'`, `import '…'`, `export … from '…'`), ohne import(). */
const IMPORT = /(?:^|[;\s])(?:import|export)\s*(?:[\w*{}\s,$]+\s*from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;

/** Alle Module, die `entry` direkt oder indirekt importiert (Pfade relativ zu root, mit „/“). */
async function moduleGraph(root, entry) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    let text;
    try { text = (await loadFile(join(root, rel))).body.toString('utf8'); } catch { continue; }
    // Kommentare grob entfernen, damit Beispiele in JSDoc nicht als Import zählen
    text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(IMPORT)) {
      const dep = relative(root, join(root, dirname(rel), m[1])).split(sep).join('/');
      if (dep.startsWith('..') || !dep.startsWith('js/') || seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen];
}

let htmlCache = null; // {at, source, entry: {body, etag}}

/** index.html mit modulepreload-Links vor dem Modul-Skript (Ergebnis HTML_TTL lang gemerkt). */
async function indexHtml(root, file) {
  const now = Date.now();
  if (htmlCache && now - htmlCache.at < HTML_TTL && htmlCache.file === file) return htmlCache.entry;
  const source = await loadFile(file);
  const modules = await moduleGraph(root, ENTRY);
  const links = modules.map(m => `<link rel="modulepreload" href="${m}">`).join('\n  ');
  let html = source.body.toString('utf8');
  const tag = `<script type="module" src="${ENTRY}"></script>`;
  if (html.includes(tag)) html = html.replace(tag, `${links}\n  ${tag}`);
  const body = Buffer.from(html, 'utf8');
  const entry = { body, etag: etagOf(body), html };
  htmlCache = { at: now, file, entry };
  return entry;
}

/**
 * Datei ausliefern. `extraHeaders(html)` liefert zusätzliche Kopfzeilen für HTML (die CSP).
 * Wirft bei fehlender Datei (Aufrufer antwortet 404).
 */
export async function serveStatic(req, res, { root, file, type, extraHeaders }) {
  const isIndex = relative(root, file).split(sep).join('/') === 'index.html';
  const entry = isIndex ? await indexHtml(root, file) : await loadFile(file);
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: entry.etag };
  if (extname(file) === '.html') Object.assign(headers, extraHeaders?.(entry.html ?? entry.body.toString('utf8')));
  if (matches(req.headers['if-none-match'], entry.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : entry.body);
}
