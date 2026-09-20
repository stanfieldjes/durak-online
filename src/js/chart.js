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

const BOX = { w: 720, h: 240 };
// Room on the left for the value labels and on the right for the one written
// at the end of the line. Both are set larger on narrow screens, where the
// whole box is scaled down, so the margins allow for that size rather than
// the one they have on a desktop. Little at the bottom: the time axis carries
// no labels, since the dates meant nothing next to a run of games played in
// bursts — the tooltip gives the exact one for the game under the pointer.
const PAD = { top: 20, right: 60, bottom: 14, left: 56 };

const PLOT = {
  w: BOX.w - PAD.left - PAD.right,
  h: BOX.h - PAD.top - PAD.bottom,
};

/**
 * How big a point is, given how much room each one has.
 *
 * Every point carries a result in its colour, so unlike an ordinary line
 * chart none of them can be dropped once the run gets long — a hundred games
 * still has to show a hundred outcomes. They shrink instead, down to a floor
 * where a dot is still a dot.
 */
function dotRadius(count) {
  const gap = PLOT.w / Math.max(1, count - 1);
  return Math.max(2, Math.min(4, gap / 2.6));
}

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

  // Unlabelled: 1000 is already written on the axis beside it, and the line
  // needs no caption to say which side of it is better.
  if (START > yMin && START < yMax) {
    const mark = svgEl('g', { class: 'chart__start' });
    mark.append(svgEl('line', { x1: PAD.left, x2: PAD.left + PLOT.w, y1: y(START), y2: y(START) }));
    svg.append(mark);
  }

  /* ---- the line ---- */

  // White, so it reads as one continuous thing and leaves colour to mean one
  // thing only: what happened in a game. Games are evenly spaced along it
  // rather than placed by the clock — eight friends play in bursts, and a
  // true time axis would pile a fortnight onto one pixel and leave the rest
  // of the chart empty.
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.rating).toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { class: 'chart__line', d }));

  /* ---- and what each game did ---- */

  // Green for a game got out of, red for one lost. The first point is the
  // rating held before any of them, which was nothing either way.
  const r = dotRadius(points.length);
  const dots = svgEl('g', { class: 'chart__dots' });
  points.forEach((p, i) => {
    dots.append(svgEl('circle', {
      class: i === 0 ? 'chart__dot chart__dot--none' : p.delta < 0 ? 'chart__dot chart__dot--durak' : 'chart__dot chart__dot--out',
      cx: x(i),
      cy: y(p.rating),
      r: i === points.length - 1 ? r + 1 : r,
    }));
  });
  svg.append(dots);

  /* ---- where it got to ---- */

  const lastX = x(points.length - 1);
  const lastY = y(values.at(-1));

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

    // Two lines. What the game did and what it left you on, then the details
    // of which game it was — the first line is what the chart is about, the
    // second is only there to place it.
    const main = document.createElement('span');
    main.className = 'chart__tip-main';

    if (i > 0) {
      const delta = document.createElement('span');
      delta.className = `chart__tip-delta ${p.delta > 0 ? 'delta--up' : p.delta < 0 ? 'delta--down' : 'delta--flat'}`;
      delta.textContent = formatRatingDelta(p.delta);

      const arrow = document.createElement('span');
      arrow.className = 'chart__tip-arrow';
      arrow.textContent = '→';

      main.append(delta, arrow);
    }

    const rating = document.createElement('span');
    rating.className = 'chart__tip-rating';
    rating.textContent = formatRating(p.rating);
    main.append(rating);

    const meta = document.createElement('span');
    meta.className = 'chart__tip-meta';
    // No need to say "durak": a rating only ever goes down for one reason.
    meta.textContent = i === 0
      ? 'initial rating'
      : [p.at ? shortDate(p.at) : null, p.players ? `${p.players} players` : null]
        .filter(Boolean).join(' · ');

    tip.append(main, meta);

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
