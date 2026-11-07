import { CATEGORIES, segmentAt } from './surfaces.js';

const NS = 'http://www.w3.org/2000/svg';
const M = { top: 22, right: 10, bottom: 28, left: 42 };
const BAND = { gap: 3, height: 6 };

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map(f => f * pow).find(s => s >= raw);
}

function indexAt(cum, d) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Höhenprofil als SVG. `onHover` erhält den Punkt unter dem Mauszeiger (oder null). */
export function createElevation(container, { onHover }) {
  const section = container.closest('section');
  let route = null;
  let kind = 'surface';

  function draw() {
    container.replaceChildren();
    if (!route) return;
    const { coords, cum, distance } = route;
    const W = container.clientWidth, H = container.clientHeight;
    if (W < 50 || H < 50) return;
    const w = W - M.left - M.right, h = H - M.top - M.bottom;

    const eles = coords.map(c => c[2]).filter(e => e != null);
    let min = Math.min(...eles), max = Math.max(...eles);
    if (max - min < 50) { const mid = (max + min) / 2; min = mid - 25; max = mid + 25; }
    const yStep = niceStep(max - min, 3);
    min = Math.floor(min / yStep) * yStep;
    max = Math.ceil(max / yStep) * yStep;

    const x = d => M.left + (d / distance) * w;
    const y = e => M.top + h - ((e - min) / (max - min)) * h;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` }, container);

    for (let v = min; v <= max + 1e-6; v += yStep) {
      el('line', { class: 'grid', x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }, svg);
      el('text', { class: 'axis', x: M.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = `${v} m`;
    }
    const xStep = niceStep(distance / 1000, Math.max(2, Math.floor(w / 90))) * 1000;
    for (let d = 0; d <= distance; d += xStep) {
      el('text', { class: 'axis', x: x(d), y: H - 3, 'text-anchor': d === 0 ? 'start' : 'middle' }, svg).textContent = `${d / 1000} km`;
    }

    // Auf höchstens einen Punkt pro Pixel reduzieren
    const stride = Math.max(1, Math.floor(coords.length / w));
    let path = '';
    let lastEle = eles[0];
    for (let i = 0; i < coords.length; i += stride) {
      lastEle = coords[i][2] ?? lastEle;
      path += `${path ? 'L' : 'M'}${x(cum[i]).toFixed(1)},${y(lastEle).toFixed(1)}`;
    }
    const last = coords.length - 1;
    path += `L${x(cum[last]).toFixed(1)},${y(coords[last][2] ?? lastEle).toFixed(1)}`;
    el('path', { class: 'area', d: `${path}L${x(distance)},${y(min)}L${x(0)},${y(min)}Z` }, svg);
    el('path', { class: 'line', d: path }, svg);

    // Farbband für Untergrund bzw. Wegtyp
    const segments = route.segments || [];
    for (let k = 0; k < segments.length;) {
      const key = segments[k][kind];
      const from = segments[k].from;
      while (k < segments.length && segments[k][kind] === key) k++;
      const to = segments[k - 1].to;
      el('rect', {
        x: x(cum[from]), y: M.top + h + BAND.gap, width: Math.max(0.5, x(cum[to]) - x(cum[from])), height: BAND.height,
        fill: CATEGORIES[kind][key].color,
      }, svg);
    }

    const cursor = el('line', { class: 'cursor', y1: M.top, y2: M.top + h, visibility: 'hidden' }, svg);
    const tip = document.createElement('div');
    tip.className = 'elevation-tip';
    tip.hidden = true;
    container.append(tip);

    svg.addEventListener('pointermove', e => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (W / rect.width);
      const d = Math.min(distance, Math.max(0, ((px - M.left) / w) * distance));
      const i = indexAt(cum, d);
      const [lat, lon, ele] = coords[i];
      cursor.setAttribute('x1', x(cum[i]));
      cursor.setAttribute('x2', x(cum[i]));
      cursor.setAttribute('visibility', 'visible');
      tip.hidden = false;
      const category = segments.length ? ' · ' + CATEGORIES[kind][segmentAt(segments, i)[kind]].label : '';
      tip.textContent = `${(cum[i] / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} km · ${ele != null ? Math.round(ele) + ' m' : '–'}${category}`;
      const half = tip.offsetWidth / 2 + 2;
      tip.style.left = `${Math.min(rect.width - half, Math.max(half, x(cum[i]) / W * rect.width))}px`;
      onHover({ lat, lon });
    });
    svg.addEventListener('pointerleave', () => {
      cursor.setAttribute('visibility', 'hidden');
      tip.hidden = true;
      onHover(null);
    });
  }

  new ResizeObserver(draw).observe(container);

  return {
    show(r, k = kind) {
      const hasElevation = r.coords.some(c => c[2] != null);
      route = hasElevation ? r : null;
      kind = k;
      section.hidden = !hasElevation;
      draw();
    },
    setKind(k) { kind = k; draw(); },
    hide() { route = null; section.hidden = true; draw(); },
  };
}
