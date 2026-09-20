/**
 * The shape of a rating over time.
 *
 * One line, one colour, no legend — there is only one thing on the chart and
 * the heading above it already says what. Everything that is not the line is
 * kept quiet: hairline gridlines, axis text in the same grey as the rest of
 * the interface, and a value written only at the end rather than at every
 * point. A number beside all fifty dots is not fifty times as informative.
 *
 * Built as an SVG with a fixed viewBox and a width of 100%, so it scales with
 * the panel without anything having to be measured or redrawn. The tooltip is
 * an HTML element laid over it, positioned in percentages of the same box,
 * which keeps the two in step at any size.
 */
import { START, formatRating, formatRatingDelta } from './rating.js';

const NS = 'http://www.w3.org/2000/svg';

const BOX = { w: 720, h: 260 };
// Room on the left for the value labels and on the right for the one written
// at the end of the line. Both are set larger on narrow screens, where the
// whole box is scaled down, so the margins allow for that size rather than
// the one they have on a desktop.
const PAD = { top: 20, right: 60, bottom: 32, left: 56 };

const PLOT = {
  w: BOX.w - PAD.left - PAD.right,
  h: BOX.h - PAD.top - PAD.bottom,
};

/** Dots at every game stop being readable past about this many. */
const DOTS_UP_TO = 30;

const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
};

/**
 * Round tick spacing to something a person would have chosen: 10, 20, 25, 50,
 * 100 and so on, rather than 17.3.
 */
function niceStep(span, count) {
  const rough = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(rough));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (power * step >= rough) return power * step;
  }
  return power * 10;
}

const shortDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * A rating over a run of games.
 *
 * @param {{at: string, rating: number, delta: number|null, players: number|null,
 *          durak: boolean}[]} points  oldest first; the first is the rating
 *          held before the first game shown, and carries no delta of its own
 * @returns {HTMLElement} the chart, ready to put on the page
 */
export function ratingChart(points) {
  const wrap = document.createElement('figure');
  wrap.className = 'chart';

  if (!points || points.length < 2) {
    const empty = document.createElement('p');
    empty.className = 'chart__empty';
    empty.textContent = points?.length === 1
      ? 'One game so far — the line starts once there are two.'
      : 'No finished games yet. Your rating moves as soon as you play one.';
    wrap.append(empty);
    return wrap;
  }

  /* ---- scales ---- */

  const values = points.map((p) => p.rating);
  // The starting rating is on the chart whether or not the line reaches it,
  // so a run of good games reads as a climb away from it rather than as a
  // line hanging in space.
  const lo = Math.min(...values, START);
  const hi = Math.max(...values, START);
  const pad = Math.max(8, (hi - lo) * 0.12);

  const step = niceStep(hi - lo + pad * 2, 4);
  const yMin = Math.floor((lo - pad) / step) * step;
  const yMax = Math.ceil((hi + pad) / step) * step;

  const x = (i) => PAD.left + (points.length === 1 ? PLOT.w / 2 : (i / (points.length - 1)) * PLOT.w);
  const y = (v) => PAD.top + PLOT.h - ((v - yMin) / (yMax - yMin)) * PLOT.h;

  const svg = svgEl('svg', {
    class: 'chart__svg',
    viewBox: `0 0 ${BOX.w} ${BOX.h}`,
    role: 'img',
    'aria-label': `Rating over your last ${points.length - 1} games, `
      + `from ${formatRating(points[0].rating)} to ${formatRating(values.at(-1))}.`,
  });

  /* ---- gridlines and the value axis ---- */

  const grid = svgEl('g', { class: 'chart__grid' });
  for (let v = yMin; v <= yMax + 0.5; v += step) {
    grid.append(svgEl('line', { x1: PAD.left, x2: PAD.left + PLOT.w, y1: y(v), y2: y(v) }));
    const label = svgEl('text', { x: PAD.left - 10, y: y(v) + 4, 'text-anchor': 'end' });
    label.textContent = String(Math.round(v));
    grid.append(label);
  }
  svg.append(grid);

  /* ---- where everyone starts ---- */

  if (START > yMin && START < yMax) {
    const mark = svgEl('g', { class: 'chart__start' });
    mark.append(svgEl('line', { x1: PAD.left, x2: PAD.left + PLOT.w, y1: y(START), y2: y(START) }));
    // In the margin, tucked under the value it belongs to, rather than inside
    // the plot: anywhere on the plot is somewhere the line itself might go,
    // and a player who has hovered around their starting rating would find
    // the word struck through by their own results.
    const label = svgEl('text', { x: PAD.left - 10, y: y(START) + 16, 'text-anchor': 'end' });
    label.textContent = 'start';
    mark.append(label);
    svg.append(mark);
  }

  /* ---- the time axis ---- */

  // Games are evenly spaced along the line rather than placed by the clock:
  // eight friends play in bursts, and a true time axis would pile a fortnight
  // of games onto one pixel and leave the rest of the chart empty. The dates
  // still label the axis, so it reads as time; the tooltip gives the exact one.
  const ticks = axisTicks(points);
  const axis = svgEl('g', { class: 'chart__axis' });
  for (const { index, text } of ticks) {
    const label = svgEl('text', {
      x: x(index),
      y: PAD.top + PLOT.h + 20,
      'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
    });
    label.textContent = text;
    axis.append(label);
  }
  svg.append(axis);

  /* ---- the line ---- */

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.rating).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { class: 'chart__line', d }));

  if (points.length <= DOTS_UP_TO) {
    const dots = svgEl('g', { class: 'chart__dots' });
    points.forEach((p, i) => dots.append(svgEl('circle', { cx: x(i), cy: y(p.rating), r: 4 })));
    svg.append(dots);
  }

  /* ---- where it got to ---- */

  const lastX = x(points.length - 1);
  const lastY = y(values.at(-1));
  svg.append(svgEl('circle', { class: 'chart__end', cx: lastX, cy: lastY, r: 5 }));

  const endLabel = svgEl('text', {
    class: 'chart__end-label',
    x: Math.min(lastX + 10, BOX.w - 4),
    y: Math.min(Math.max(lastY + 4, PAD.top + 4), PAD.top + PLOT.h),
  });
  endLabel.textContent = formatRating(values.at(-1));
  svg.append(endLabel);

  /* ---- reading a point off it ---- */

  const cursor = svgEl('line', {
    class: 'chart__cursor',
    y1: PAD.top,
    y2: PAD.top + PLOT.h,
    x1: 0,
    x2: 0,
    hidden: 'hidden',
  });
  svg.append(cursor);

  const hit = svgEl('g', { class: 'chart__hit' });
  const band = PLOT.w / Math.max(1, points.length - 1);
  points.forEach((p, i) => {
    const rect = svgEl('rect', {
      x: x(i) - band / 2,
      y: PAD.top,
      width: band,
      height: PLOT.h,
    });
    rect.dataset.index = String(i);
    hit.append(rect);
  });
  svg.append(hit);

  wrap.append(svg);

  const tip = document.createElement('div');
  tip.className = 'chart__tip';
  tip.hidden = true;
  wrap.append(tip);

  const showPoint = (i) => {
    const p = points[i];
    tip.hidden = false;
    tip.textContent = '';

    const when = document.createElement('span');
    when.className = 'chart__tip-when';
    when.textContent = p.at ? shortDate(p.at) : '';

    const rating = document.createElement('span');
    rating.className = 'chart__tip-rating';
    rating.textContent = formatRating(p.rating);

    tip.append(when, rating);

    if (i > 0) {
      const line = document.createElement('span');
      line.className = 'chart__tip-line';
      const delta = document.createElement('span');
      delta.className = `chart__tip-delta ${p.delta > 0 ? 'delta--up' : p.delta < 0 ? 'delta--down' : 'delta--flat'}`;
      delta.textContent = formatRatingDelta(p.delta);
      line.append(delta);
      if (p.players) {
        const at = document.createElement('span');
        at.textContent = ` · ${p.players} players${p.durak ? ' · durak' : ''}`;
        line.append(at);
      }
      tip.append(line);
    } else {
      const line = document.createElement('span');
      line.className = 'chart__tip-line';
      line.textContent = 'before these games';
      tip.append(line);
    }

    // Percentages of the same viewBox the chart is drawn in, so the tooltip
    // sits over its point however wide the panel happens to be.
    tip.style.left = `${(x(i) / BOX.w) * 100}%`;
    tip.style.top = `${(y(p.rating) / BOX.h) * 100}%`;
    tip.classList.toggle('is-right', x(i) > BOX.w * 0.66);
    tip.classList.toggle('is-left', x(i) < BOX.w * 0.34);

    cursor.setAttribute('x1', x(i));
    cursor.setAttribute('x2', x(i));
    cursor.removeAttribute('hidden');
  };

  const hidePoint = () => {
    tip.hidden = true;
    cursor.setAttribute('hidden', 'hidden');
  };

  hit.addEventListener('pointermove', (event) => {
    const index = Number(event.target?.dataset?.index);
    if (Number.isInteger(index)) showPoint(index);
  });
  hit.addEventListener('pointerleave', hidePoint);
  wrap.addEventListener('pointerleave', hidePoint);

  return wrap;
}

/**
 * Up to four labels along the bottom. Dates repeat when a run of games was
 * played in one evening, which would print the same day four times, so the
 * labels fall back to game numbers when the dates cannot tell them apart.
 */
function axisTicks(points) {
  const last = points.length - 1;
  const wanted = Math.min(4, points.length);
  const indexes = [];
  for (let i = 0; i < wanted; i++) {
    indexes.push(Math.round((i / (wanted - 1 || 1)) * last));
  }
  const unique = [...new Set(indexes)];

  const dates = unique.map((index) => (points[index].at ? shortDate(points[index].at) : ''));
  if (new Set(dates.filter(Boolean)).size >= 2) {
    return unique.map((index, i) => ({ index, text: dates[i] }));
  }
  return unique.map((index) => ({ index, text: index === 0 ? 'first' : `game ${index}` }));
}
