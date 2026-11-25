import { CATEGORIES, segmentAt, segmentsFor } from './surfaces.js';
import { gradeAt } from './climbs.js';
import { formatNumber, indexAtDistance } from './utils.js';

const NS = 'http://www.w3.org/2000/svg';
const M = { top: 22, right: 10, bottom: 28, left: 42 };
const BAND = { gap: 3, height: 6 };
/** Länge, über die die Steigung des steilsten Abschnitts gemittelt wird (kürzer wäre vom Höhenrauschen geprägt) */
const STEEP_WINDOW = 500;

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

/**
 * Bereich der Höhenachse: {min, max, step}. Angepasst an die Daten, mit mindestens 20 m Spanne ab dem auf 10 m
 * abgerundeten Tiefstwert – sonst wird eine flache Strecke (Bremen: 1–5 m) zur Linie auf einer Achse von −40 bis
 * +40 m. Unter 0 nur, wenn die Route wirklich unter dem Meeresspiegel liegt (Niederlande).
 */
function heightAxis(coords) {
  // Schleife statt Math.min(...eles): Bei sehr langen Touren (über ~100 000 Punkte) wären das zu viele Argumente
  let lowest = Infinity, highest = -Infinity;
  for (const c of coords) {
    if (c[2] == null) continue;
    if (c[2] < lowest) lowest = c[2];
    if (c[2] > highest) highest = c[2];
  }
  let min = lowest, max = highest;
  if (max - min < 20) { min = Math.floor(min / 10) * 10; max = Math.max(min + 20, max); }
  const step = niceStep(max - min, 3);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  if (lowest >= 0) min = Math.max(0, min);
  return { min, max, step };
}

/** Profillinie als SVG-Pfad, höchstens ein Punkt pro Pixel; Lücken in den Höhen übernehmen den letzten Wert. */
function profilePath(coords, cum, x, y, width) {
  const stride = Math.max(1, Math.floor(coords.length / width));
  let path = '';
  let lastEle = coords.find(c => c[2] != null)?.[2];
  for (let i = 0; i < coords.length; i += stride) {
    lastEle = coords[i][2] ?? lastEle;
    path += `${path ? 'L' : 'M'}${x(cum[i]).toFixed(1)},${y(lastEle).toFixed(1)}`;
  }
  const last = coords.length - 1;
  return path + `L${x(cum[last]).toFixed(1)},${y(coords[last][2] ?? lastEle).toFixed(1)}`;
}

/** Zusammenhängende Abschnitte gleicher Kategorie (Untergrund, Wegtyp oder Steigung) in Bildkoordinaten. */
function categoryRuns(segments, kind, cum, x) {
  const runs = [];
  for (let k = 0; k < segments.length;) {
    const key = segments[k][kind];
    const from = segments[k].from;
    while (k < segments.length && segments[k][kind] === key) k++;
    runs.push({ key, x: x(cum[from]), width: Math.max(0.5, x(cum[segments[k - 1].to]) - x(cum[from])) });
  }
  return runs;
}

/**
 * Steigung: Fläche unter der Kurve je Klasse in Farbe und – je steiler, desto dichter – schraffiert, damit nicht
 * die Farbe allein die Steigung zeigt.
 */
function drawGradeFill(svg, area, runs, top, height) {
  const defs = el('defs', {}, svg);
  el('path', { d: area }, el('clipPath', { id: 'grade-area' }, defs));
  for (const [n, gap] of [[1, 9], [2, 6], [3, 3.5]]) {
    const p = el('pattern', { id: `grade-hatch-${n}`, patternUnits: 'userSpaceOnUse', width: gap, height: gap, patternTransform: 'rotate(45)' }, defs);
    el('line', { class: 'hatch', x1: 0, y1: 0, x2: 0, y2: gap }, p);
  }
  const fills = el('g', { 'clip-path': 'url(#grade-area)' }, svg);
  for (const run of runs) {
    const cat = CATEGORIES.grade[run.key];
    const box = { x: run.x, y: top, width: run.width, height };
    el('rect', { ...box, class: 'grade-fill', fill: cat.color }, fills);
    if (cat.pattern) el('rect', { ...box, fill: `url(#grade-hatch-${cat.pattern})` }, fills);
  }
}

const km = m => formatNumber(m / 1000, { maximumFractionDigits: 1 });

/** Höhen ohne Lücken: fehlende Werte übernehmen den letzten bekannten (bzw. den ersten, am Anfang). */
function filledElevations(coords) {
  let last = coords.find(c => c[2] != null)?.[2] ?? 0;
  return coords.map(c => (last = c[2] ?? last));
}

/**
 * Zusammenfassung für Screenreader: tiefster und höchster Punkt, steilster Anstieg über STEEP_WINDOW.
 * Ohne sie wäre das Profil nur mit der Maus lesbar.
 */
function elevationSummary({ coords, cum, distance }) {
  const ele = filledElevations(coords);
  let lo = 0, hi = 0;
  for (let i = 1; i < ele.length; i++) {
    if (ele[i] < ele[lo]) lo = i;
    if (ele[i] > ele[hi]) hi = i;
  }
  const parts = [
    `Höhenprofil über ${km(distance)} km`,
    `tiefster Punkt ${Math.round(ele[lo])} m bei km ${km(cum[lo])}`,
    `höchster Punkt ${Math.round(ele[hi])} m bei km ${km(cum[hi])}`,
  ];
  // Zwei Zeiger: zu jedem Start i das erste j, das mindestens STEEP_WINDOW weiter liegt
  let best = null;
  for (let i = 0, j = 0; i < ele.length; i++) {
    while (j < ele.length && cum[j] - cum[i] < STEEP_WINDOW) j++;
    if (j === ele.length) break;
    const grade = (ele[j] - ele[i]) / (cum[j] - cum[i]);
    if (!best || grade > best.grade) best = { grade, from: cum[i] };
  }
  if (best && best.grade >= 0.01) {
    parts.push(`steilster Anstieg ${Math.round(best.grade * 100)} % auf ${STEEP_WINDOW} m ab km ${km(best.from)}`);
  }
  return parts.join(', ') + '.';
}

/**
 * Höhenprofil als SVG. `onHover` erhält den Punkt unter dem Mauszeiger bzw. an der Tastaturposition (oder null).
 * Umgekehrt zeigt `showAt(along)` eine Stelle, die auf der Karte unter der Maus ist (mapView.js).
 * Der Container ist ein Schieberegler (role="slider"): mit den Pfeiltasten in 1-%-Schritten, Bild ↑/↓ in
 * 10-%-Schritten, Pos1/Ende an Anfang/Ende. Die Position wird mit Höhe und Untergrund, Wegtyp bzw. Steigung angesagt.
 */
export function createElevation(container, { onHover }) {
  const section = container.closest('section');
  let route = null;
  let kind = 'surface';
  let pos = null;          // Tastaturposition in Metern (null = keine)
  let place = null;        // zeigt Cursor und Infofeld an einer Stelle der aktuellen Zeichnung
  let hideCursor = null;

  const summary = document.createElement('p');
  summary.id = `${container.id}-summary`;
  summary.className = 'sr-only';
  section.append(summary);
  Object.entries({
    role: 'slider', tabindex: '0', 'aria-label': 'Höhenprofil – mit Pfeiltasten abfahren',
    'aria-describedby': summary.id, 'aria-valuemin': '0',
  }).forEach(([k, v]) => container.setAttribute(k, v));

  function draw() {
    container.replaceChildren();
    place = hideCursor = null;
    if (!route) return;
    const { coords, cum, distance } = route;
    const W = container.clientWidth, H = container.clientHeight;
    if (W < 50 || H < 50) return;
    // Ränder wachsen mit der Grundschrift des Browsers, damit größere Achsenbeschriftungen Platz haben
    const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;
    const m = Object.fromEntries(Object.entries(M).map(([k, v]) => [k, Math.round(v * Math.max(1, scale))]));
    const w = W - m.left - m.right, h = H - m.top - m.bottom;
    if (w < 20 || h < 20) return;

    const { min, max, step: yStep } = heightAxis(coords);
    const x = d => m.left + (d / distance) * w;
    const y = e => m.top + h - ((e - min) / (max - min)) * h;

    // Die Zeichnung selbst ist für Screenreader stumm – Inhalt kommt über Zusammenfassung und Reglerwert
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, container);

    for (let v = min; v <= max + 1e-6; v += yStep) {
      el('line', { class: 'grid', x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }, svg);
      el('text', { class: 'axis', x: m.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = `${v} m`;
    }
    const xStep = niceStep(distance / 1000, Math.max(2, Math.floor(w / (90 * scale)))) * 1000;
    for (let d = 0; d <= distance; d += xStep) {
      el('text', { class: 'axis', x: x(d), y: H - 3, 'text-anchor': d === 0 ? 'start' : 'middle' }, svg).textContent = `${d / 1000} km`;
    }

    const path = profilePath(coords, cum, x, y, w);
    const area = `${path}L${x(distance)},${y(min)}L${x(0)},${y(min)}Z`;
    el('path', { class: 'area', d: area }, svg);

    const segments = segmentsFor(route, kind);
    const runs = categoryRuns(segments, kind, cum, x);
    if (kind === 'grade') drawGradeFill(svg, area, runs, m.top, h);
    el('path', { class: 'line', d: path }, svg);

    // Farbband unter dem Profil
    for (const run of runs) {
      el('rect', { x: run.x, y: m.top + h + BAND.gap, width: run.width, height: BAND.height, fill: CATEGORIES[kind][run.key].color }, svg);
    }

    const cursor = el('line', { class: 'cursor', y1: m.top, y2: m.top + h, visibility: 'hidden' }, svg);
    const tip = document.createElement('div');
    tip.className = 'elevation-tip';
    tip.hidden = true;
    tip.setAttribute('aria-hidden', 'true');
    container.append(tip);

    place = d => {
      const i = indexAtDistance(route, Math.min(distance, Math.max(0, d)));
      const [lat, lon, ele] = coords[i];
      cursor.setAttribute('x1', x(cum[i]));
      cursor.setAttribute('x2', x(cum[i]));
      cursor.setAttribute('visibility', 'visible');
      tip.hidden = false;
      const category = segments.length ? ' · ' + CATEGORIES[kind][segmentAt(segments, i)[kind]].label : '';
      const g = gradeAt(route, i);
      const grade = g == null ? '' : ` · ${formatNumber(Math.round(g * 100) || 0)} %`.replace('-', '−');
      tip.textContent = `${km(cum[i])} km · ${ele != null ? Math.round(ele) + ' m' : '–'}${category}${grade}`;
      const rect = svg.getBoundingClientRect();
      const half = tip.offsetWidth / 2 + 2;
      tip.style.left = `${Math.min(rect.width - half, Math.max(half, x(cum[i]) / W * rect.width))}px`;
      onHover({ lat, lon });
      return tip.textContent;
    };
    hideCursor = () => {
      cursor.setAttribute('visibility', 'hidden');
      tip.hidden = true;
      onHover(null);
    };

    svg.addEventListener('pointermove', e => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (W / rect.width);
      place(((px - m.left) / w) * distance);
    });
    svg.addEventListener('pointerleave', () => {
      if (pos != null && document.activeElement === container) place(pos);
      else hideCursor();
    });
    // Nach Größenänderung die Tastaturposition wieder anzeigen
    if (pos != null && document.activeElement === container) place(pos);
  }

  function moveTo(d) {
    if (!route || !place) return;
    pos = Math.min(route.distance, Math.max(0, d));
    const text = place(pos);
    container.setAttribute('aria-valuenow', (pos / 1000).toFixed(1));
    container.setAttribute('aria-valuetext', text.replaceAll(' · ', ', '));
  }

  container.addEventListener('keydown', e => {
    if (!route) return;
    const step = route.distance / 100;
    const delta = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 10 * step, PageDown: -10 * step }[e.key];
    let d;
    if (delta != null) d = (pos ?? 0) + delta;
    else if (e.key === 'Home') d = 0;
    else if (e.key === 'End') d = route.distance;
    else return;
    e.preventDefault();
    moveTo(d);
  });
  container.addEventListener('blur', () => hideCursor?.());

  // Nicht neu zeichnen, was schon so dasteht, und Größenänderungen je Bild sammeln: Die Pipeline zeigt die Route
  // nach jedem Schritt, und jedes Anzeigen ändert auch die Größe (ResizeObserver) – das waren bis zu 8 Zeichnungen
  // je Berechnung, auf einem Mittelklasse-Handy jeweils einige 10 ms, in denen die Seite nicht reagiert.
  // show() und setKind() zeichnen sofort (wer danach das Profil liest, sieht den neuen Stand).
  let frame = 0, drawn = null;
  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawIfChanged(); });
  }
  function drawIfChanged() {
    // Was das Profil zeichnet, nicht das Routenobjekt: Die Pipeline zeigt nach jedem Schritt ein neues, oft mit
    // derselben Linie (Feiertage, Regionen). Steigungen hängen nur an den Koordinaten.
    const now = { coords: route?.coords, segments: route?.segments, kind, w: container.clientWidth, h: container.clientHeight, font: getComputedStyle(document.documentElement).fontSize };
    if (drawn && Object.keys(now).every(k => now[k] === drawn[k])) return;
    drawn = now;
    draw();
  }
  new ResizeObserver(requestDraw).observe(container);

  return {
    show(r, k = kind) {
      const hasElevation = r.coords.some(c => c[2] != null);
      route = hasElevation ? r : null;
      kind = k;
      pos = null;
      section.hidden = !hasElevation;
      if (route) {
        summary.textContent = elevationSummary(route);
        container.setAttribute('aria-valuemax', (route.distance / 1000).toFixed(1));
        container.setAttribute('aria-valuenow', '0');
        container.setAttribute('aria-valuetext', 'Anfang der Route');
      }
      hideCursor?.(); // `pos` ist zurückgesetzt – auch wenn das Profil gleich bleibt und nicht neu gezeichnet wird
      drawIfChanged();
    },
    setKind(k) { kind = k; drawIfChanged(); },
    /** Stelle `along` (m) anzeigen – wenn die Maus über der Routenlinie auf der Karte ist oder sie angetippt wurde. */
    showAt(along) { place?.(along); },
    /** Anzeige von showAt beenden; eine Tastaturposition im Profil bleibt dann stehen. */
    clearAt() {
      if (pos != null && document.activeElement === container) place?.(pos);
      else hideCursor?.();
    },
    hide() {
      route = null; pos = null; section.hidden = true;
      cancelAnimationFrame(frame); frame = 0; drawn = null;
      draw();
    },
  };
}
