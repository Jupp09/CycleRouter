// Gleitende Zeitfenster für Begrenzungen (Anmeldeversuche, neue Konten, Overpass-Kontingent je IP).
// Jeder Eintrag zählt mit einem Gewicht (z. B. Anzahl Kacheln). Abgelaufene Einträge werden einzeln
// entfernt – nie die ganze Tabelle: Sonst könnte jemand mit vielen Adressen (IPv6) alle Zähler leeren,
// auch die eines laufenden Passwort-Angriffs.

const MAX_KEYS = 50_000; // Obergrenze gegen Speicherüberlauf; darüber fallen die ältesten Schlüssel weg

/** Begrenzer mit `max` Einheiten je `windowMs`. */
export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // schlüssel → [[zeitpunkt, gewicht]] (älteste zuerst)
  let lastSweep = Date.now();

  function used(key, now = Date.now()) {
    const list = hits.get(key);
    if (!list) return 0;
    while (list.length && now - list[0][0] >= windowMs) list.shift();
    if (!list.length) { hits.delete(key); return 0; }
    return list.reduce((sum, [, n]) => sum + n, 0);
  }

  /** Abgelaufenes in allen Schlüsseln entfernen – höchstens einmal je Fenster. */
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const key of hits.keys()) used(key, now);
  }

  return {
    /** Verbrauchte Einheiten im aktuellen Fenster */
    used: key => used(key),
    /** Ist das Limit erreicht? (zählt nicht mit) */
    reached: key => used(key) >= max,
    /** Passen noch `n` Einheiten hinein? (zählt nicht mit) */
    fits: (key, n) => used(key) + n <= max,
    /** `n` Einheiten zählen */
    add(key, n = 1) {
      const now = Date.now();
      sweep(now);
      const list = hits.get(key);
      if (list) list.push([now, n]);
      else {
        if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value);
        hits.set(key, [[now, n]]);
      }
    },
  };
}
