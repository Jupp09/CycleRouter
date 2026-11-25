// Hinweise der Routing-Schicht an die Oberfläche (ohne dass die Provider die UI kennen).

let handler = null;

/** Die Oberfläche meldet sich hier an (pipeline.js → Statuszeile). */
export function onRoutingNotice(fn) { handler = fn; }

/** Hinweis wie „BRouter ist ausgelastet – neuer Versuch in 2 s …“ */
export function routingNotice(text) { handler?.(text); }

