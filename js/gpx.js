const escapeXml = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const hours = s => s.poi.tags.opening_hours
  || (s.poi.typical ? `${s.poi.typical.hours} (typisch für ${s.poi.typical.chain})` : '');

export function toGpx(route, name) {
  const time = new Date().toISOString();
  const points = route.coords.map(([lat, lon, ele]) =>
    `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele != null ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`,
  ).join('\n');
  const vias = route.waypoints.filter(p => p.manual).map((p, i) =>
    `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">
    <name>${escapeXml(p.label || `Zwischenstopp ${i + 1}`)}</name>
    <sym>Flag, Blue</sym>
  </wpt>
`).join('');
  const wpts = vias + (route.stops || []).map(s => {
    const name = `${s.typeLabel}${s.poi.name ? ': ' + s.poi.name : ''}`;
    return `  <wpt lat="${s.poi.lat.toFixed(6)}" lon="${s.poi.lon.toFixed(6)}">
    <name>${escapeXml(name)}</name>${hours(s) ? `
    <desc>${escapeXml(hours(s))}</desc>` : ''}
    <sym>${s.gpxSym}</sym>
  </wpt>
`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CycloRouter" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${time}</time>
  </metadata>
${wpts}  <trk>
    <name>${escapeXml(name)}</name>
    <type>cycling</type>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

const GPX_TYPE = 'application/gpx+xml';
const fileName = name => name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') + '.gpx';

export function downloadGpx(route, name) {
  const blob = new Blob([toGpx(route, name)], { type: GPX_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Kann der Browser eine GPX-Datei über das Teilen-Menü des Systems weitergeben (z. B. an Komoot)?
 * Voraussetzungen: Web Share API mit Dateien (iOS Safari ≥ 15, Chrome/Edge u. a.), sichere Verbindung
 * (HTTPS oder localhost) und ein vom Browser erlaubter Dateityp – Chrome auf Android erlaubt z. B. kein GPX.
 */
export function canShareGpx() {
  if (!window.isSecureContext || !navigator.share || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File(['<gpx/>'], 'test.gpx', { type: GPX_TYPE })] });
  } catch {
    return false;
  }
}

/**
 * GPX über das Teilen-Menü weitergeben. → 'shared' | 'cancelled'.
 * Wirft, wenn das Teilen nicht möglich ist (der Aufrufer bietet dann den Download an).
 */
export async function shareGpx(route, name) {
  const file = new File([toGpx(route, name)], fileName(name), { type: GPX_TYPE });
  try {
    await navigator.share({ files: [file], title: name });
    return 'shared';
  } catch (e) {
    if (e.name === 'AbortError') return 'cancelled'; // Menü geschlossen, ohne zu teilen
    throw e;
  }
}
