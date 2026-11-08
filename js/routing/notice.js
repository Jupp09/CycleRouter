// Kleine Helfer der Routing-Schicht: Hinweise an die Oberfläche (ohne dass die Provider die UI kennen)
// und abbrechbares Warten zwischen zwei Versuchen.

let handler = null;

/** Die Oberfläche meldet sich hier an (pipeline.js → Statuszeile). */
export function onRoutingNotice(fn) { handler = fn; }

/** Hinweis wie „BRouter ist ausgelastet – neuer Versuch in 2 s …“ */
export function routingNotice(text) { handler?.(text); }

/** `ms` warten; bricht mit AbortError ab, sobald `signal` abgebrochen wird. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Abgebrochen', 'AbortError'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Abgebrochen', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
