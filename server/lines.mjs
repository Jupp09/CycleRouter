// Zeilen eines Datenstroms (NDJSON, GeoJSON-Sequenzen) – getrennt wird nur an "\n".
// Nicht node:readline: das trennt auch an U+2028/U+2029, und JSON.stringify lässt diese Zeichen unmaskiert.
// In OSM-Namen kommen sie vor (z. B. ein polnischer Bäckername mit U+2028), dann zerschnitt readline den
// Datensatz und `npm run extract:update` scheiterte mit „Unterminated string in JSON“.

/**
 * @param {AsyncIterable<Buffer|string> | Iterable<Buffer|string>} stream
 * @returns {AsyncGenerator<string>} Zeilen ohne "\n" (ein "\r" am Ende wird entfernt)
 */
export async function* lines(stream) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of stream) {
    rest += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0, nl;
    while ((nl = rest.indexOf('\n', start)) !== -1) {
      yield trimCr(rest.slice(start, nl));
      start = nl + 1;
    }
    rest = rest.slice(start);
  }
  rest += decoder.decode();
  if (rest) yield trimCr(rest);
}

const trimCr = s => (s.endsWith('\r') ? s.slice(0, -1) : s);
