const escapeXml = s => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const hours = s => s.poi.tags.opening_hours
  || (s.poi.typical ? `${s.poi.typical.hours} (typisch für ${s.poi.typical.chain})` : '');

export function toGpx(route, name) {
  const time = new Date().toISOString();
  const points = route.coords.map(([lat, lon, ele]) =>
    `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele != null ? `<ele>${ele.toFixed(1)}</ele>` : ''}</trkpt>`,
  ).join('\n');
  const wpts = (route.stops || []).map(s => {
    const name = `${s.typeLabel}${s.poi.name ? ': ' + s.poi.name : ''}`;
    return `  <wpt lat="${s.poi.lat.toFixed(6)}" lon="${s.poi.lon.toFixed(6)}">
    <name>${escapeXml(name)}</name>${hours(s) ? `
    <desc>${escapeXml(hours(s))}</desc>` : ''}
    <sym>${s.gpxSym}</sym>
  </wpt>
`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CycleRouter" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
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

export function downloadGpx(route, name) {
  const blob = new Blob([toGpx(route, name)], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') + '.gpx';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
