/**
 * Typische Öffnungszeiten von Ketten: Fehlen bei einer Filiale die Öffnungszeiten, werden die häufigsten
 * Zeiten derselben Kette (Marke, sonst Name) aus allen in dieser Sitzung geladenen Kacheln übernommen –
 * nur bei ausreichend klarer Datenlage. Ein Supermarkt ohne Angaben ist so meist doch einschätzbar.
 */
import { parseOpeningHours } from './openingHours.js';
import { sessionPois } from './poiTiles.js';

const MIN_SAMPLES = 3;   // mindestens so viele Filialen mit Angaben
const MIN_SHARE = 0.4;   // und so viele davon mit genau diesen Zeiten

const normalizeHours = oh => oh.trim().replace(/\s*;\s*/g, '; ').replace(/\s+/g, ' ');

/** Kette einer Stelle: Marke (brand), sonst Name – nur für Läden, Gastronomie und Tankstellen. */
function chainKey(poi) {
  if (poi.type === 'water') return null;
  const name = (poi.tags.brand || poi.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return name ? `${poi.type}|${name}` : null;
}

/** Kette → {hours, count, total, chain} für Ketten mit eindeutigen typischen Zeiten. */
function typicalHours(pool) {
  const byChain = new Map(); // key → {label, counts: Map(hours → n), total}
  const seen = new Set();
  for (const p of pool) {
    const oh = p.tags.opening_hours;
    const key = chainKey(p);
    if (!oh || !key || seen.has(p.id) || !parseOpeningHours(oh)) continue; // nur verständliche Angaben
    seen.add(p.id);
    const c = byChain.get(key) || { label: p.tags.brand || p.name, counts: new Map(), total: 0 };
    const h = normalizeHours(oh);
    c.counts.set(h, (c.counts.get(h) || 0) + 1);
    c.total++;
    byChain.set(key, c);
  }
  const out = new Map();
  for (const [key, c] of byChain) {
    if (c.total < MIN_SAMPLES) continue;
    const [hours, count] = [...c.counts].sort((a, b) => b[1] - a[1])[0];
    if (count / c.total >= MIN_SHARE) out.set(key, { hours, count, total: c.total, chain: c.label });
  }
  return out;
}

/** Ergänzt Stellen ohne Öffnungszeiten um `typical`, sofern für ihre Kette typische Zeiten bekannt sind. */
export function withTypicalHours(pois) {
  const typical = typicalHours(sessionPois().concat(pois));
  return pois.map(p => {
    if (p.tags.opening_hours) return p;
    const t = typical.get(chainKey(p));
    return t ? { ...p, typical: t } : p;
  });
}
