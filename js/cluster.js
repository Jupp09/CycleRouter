/**
 * Nahe Kartenmarker zusammenfassen (map.js, refreshPois) – ohne Leaflet, damit es sich ohne Browser testen lässt.
 * Gierig in der gegebenen Reihenfolge: Jeder Punkt kommt in die erste Gruppe, deren erster Punkt näher als
 * `radius` liegt, sonst beginnt er eine neue. Die Reihenfolge bestimmt also, wer eine Gruppe „anführt“ –
 * map.js gibt Verpflegungsstopps zuerst, dann Trinkwasser, dann Suchtreffer.
 */

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => {x: number, y: number}} pointOf Lage in Pixeln auf der aktuellen Zoomstufe
 * @param {number} radius Abstand (px), unter dem zusammengefasst wird
 * @param {(item: T) => boolean} [alone] Punkte, die immer einzeln bleiben (z. B. mit offenem Popup)
 * @returns {T[][]} Gruppen; eine Gruppe mit einem Punkt ist ein einzelner Marker
 */
export function groupNear(items, pointOf, radius, alone = () => false) {
  /** @type {{x: number, y: number, single: boolean, members: T[]}[]} */
  const groups = [];
  for (const item of items) {
    const p = pointOf(item);
    const single = alone(item);
    const g = !single && groups.find(g => !g.single && Math.hypot(g.x - p.x, g.y - p.y) < radius);
    if (g) g.members.push(item);
    else groups.push({ x: p.x, y: p.y, single, members: [item] });
  }
  return groups.map(g => g.members);
}
