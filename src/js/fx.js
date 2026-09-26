/**
 * Card movement.
 *
 * Every flight animates a *copy* of a card in a fixed overlay above the page,
 * never the real element. The table re-renders the instant a move lands, and
 * game.js holds the real card back while its copy travels: invisible in its
 * slot on the table, or left out of a hand until it arrives. The copy is
 * swapped for the real card on the same frame it lands.
 *
 * A flight's destination is looked up again on every frame rather than
 * measured once. Hands re-sort and the table re-centres whenever anyone plays,
 * and several players can play at once, so the spot a card is heading for can
 * move while it is in the air. Following it means the card always lands
 * exactly where the real one is.
 *
 * Flights are keyed by card. Starting a new flight for a card already in the
 * air picks it up from wherever it currently is, so a card is never in two
 * places at once and never jumps back to where it started.
 */

/** How long each kind of movement takes, in milliseconds. */
export const FLIGHT_MS = {
  play: 300,     // hand to table
  discard: 460,  // table to the beaten pile
  collect: 420,  // table to a hand
  draw: 360,     // stock to a hand
  reveal: 560,   // the trump turning face up off the top of the stock
};
/** How long your hand takes to make room for a card, or close up after one. */
export const SETTLE_MS = 220;
/** Gap between table cards leaving together, and between cards drawn in turn. */
export const CLEAR_GAP_MS = 55;
export const DRAW_GAP_MS = 85;
export const DEAL_GAP_MS = 90;
/** Roughly how long a whole deal should take, however many are playing. */
export const DEAL_TOTAL_MS = 2200;
/** The beat between the last card dealt and the trump being turned up. */
export const REVEAL_PAUSE_MS = 260;
/** The face-up trump sliding under the stock into its place. */
export const TRUMP_SLIDE_MS = 380;

let layer = null;
let frame = 0;
const flights = new Map(); // key -> flight

function surface() {
  if (layer && document.body.contains(layer)) return layer;
  layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Where an element visibly sits: its centre, its unrotated size, and its
 * rotation. getBoundingClientRect alone is not enough — for a rotated card
 * (the trump under the stock, a defence laid across an attack) it returns the
 * box around the rotated shape, which is bigger than the card. The centre of
 * that box is still the card's centre, though, since cards rotate about it.
 */
export function boxOf(el) {
  if (!el || !el.isConnected) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const w = el.offsetWidth || rect.width;
  const h = el.offsetHeight || rect.height;
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    w,
    h,
    angle: angleOf(el),
  };
}

function angleOf(el) {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/^matrix\(([^)]+)\)/);
  if (!m) return 0;
  const [a, b] = m[1].split(',').map(Number);
  return Math.round(Math.atan2(b, a) * (180 / Math.PI) * 100) / 100;
}

const resolve = (source) => (typeof source === 'function' ? source() : source) ?? null;
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Fly one card.
 *
 *   key       the card's id; a second flight for the same key replaces the first
 *   from      a box, or a function returning one, read when the flight launches
 *   to        a function returning the destination box, read on every frame
 *   face      the card's face element (from ui.cardEl), or null for a card back
 *   flip      'up' turns a back face-up on the way, 'down' turns a face over
 *   delay     ms before launching; the card stays where it is until then
 *   onLaunch  called as the card leaves (after `from` has been read)
 *   onLand    called on the frame the card arrives, with the box it landed in
 *   onCancel  called if the flight is replaced or cleared before it lands
 *
 * Returns false when motion is reduced, so the caller knows nothing will land.
 */
export function fly({
  key,
  from,
  to,
  face = null,
  flip = null,
  duration = FLIGHT_MS.play,
  delay = 0,
  lift = 0,
  onLaunch,
  onLand,
  onCancel,
}) {
  if (reducedMotion()) return false;

  const previous = flights.get(key);
  if (previous) {
    // Carry on from wherever the card already is — mid-air, or still waiting
    // in the stock to be drawn.
    from = previous.piece ? previous.current : previous.from;
    drop(previous);
    previous.onCancel?.();
  }

  const now = performance.now();
  const flight = {
    key, from, to, face, flip, duration, lift,
    startAt: now + delay,
    onLaunch, onLand, onCancel,
    piece: null, origin: null, target: null, current: null, nw: 0, nh: 0,
  };
  flights.set(key, flight);
  if (!frame) frame = requestAnimationFrame(tick);
  return true;
}

/** True while the card with this key is in the air or waiting to launch. */
export function isFlying(key) {
  return flights.has(key);
}

function launch(flight) {
  const origin = resolve(flight.from) ?? resolve(flight.to);
  flight.onLaunch?.();
  if (!origin) return false;

  const piece = document.createElement('div');
  piece.className = 'fx-piece';

  const back = document.createElement('div');
  back.className = 'card card--back';
  const face = flight.face;
  if (face) {
    face.removeAttribute('id');
    face.removeAttribute('data-card');
    piece.append(face);
  }
  piece.append(back);

  surface().append(piece);
  flight.piece = piece;
  flight.back = back;
  flight.origin = origin;
  flight.target = origin;
  flight.current = origin;
  flight.nw = piece.offsetWidth || origin.w;
  flight.nh = piece.offsetHeight || origin.h;
  showSide(flight, flight.flip === 'up' || !face ? 'back' : 'face');
  return true;
}

function showSide(flight, side) {
  if (flight.side === side) return;
  flight.side = side;
  if (flight.face) flight.face.hidden = side !== 'face';
  flight.back.hidden = side !== 'back';
}

function drop(flight) {
  flight.piece?.remove();
  flights.delete(flight.key);
}

function tick(now) {
  frame = 0;
  const landed = [];

  // Reads first (layout), then writes (transforms on the overlay only), so a
  // dozen cards in the air never force layout more than once a frame.
  for (const flight of flights.values()) {
    if (now < flight.startAt) continue;
    if (!flight.piece && !launch(flight)) {
      landed.push(flight);
      continue;
    }
    flight.target = resolve(flight.to) ?? flight.target;
  }

  for (const flight of flights.values()) {
    if (!flight.piece) continue;
    const p = Math.min(1, Math.max(0, (now - flight.startAt) / flight.duration));
    const e = ease(p);
    const a = flight.origin;
    const b = flight.target;

    const box = {
      cx: lerp(a.cx, b.cx, e),
      cy: lerp(a.cy, b.cy, e) - flight.lift * Math.sin(Math.PI * p),
      w: lerp(a.w, b.w, e),
      h: lerp(a.h, b.h, e),
      angle: lerp(a.angle, b.angle, e),
    };
    flight.current = box;

    // Turning over: edge-on at the midpoint, the other side showing after it.
    let squeeze = 1;
    if (flight.flip && flight.face) {
      squeeze = Math.max(0.04, Math.abs(Math.cos(Math.PI * e)));
      const past = e >= 0.5;
      showSide(flight, (flight.flip === 'up') === past ? 'face' : 'back');
    }

    const sx = (box.w / flight.nw) * squeeze;
    const sy = box.h / flight.nh;
    flight.piece.style.transform =
      `translate(${box.cx - flight.nw / 2}px, ${box.cy - flight.nh / 2}px) ` +
      `rotate(${box.angle}deg) scale(${sx}, ${sy})`;

    if (p >= 1) landed.push(flight);
  }

  for (const flight of landed) {
    if (flights.get(flight.key) !== flight) continue;
    drop(flight);
    flight.onLand?.(flight.current ?? resolve(flight.to));
  }

  if (flights.size > 0 && !frame) frame = requestAnimationFrame(tick);
}

/** Stop everything at once, without landing anything. */
export function clearEffects() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  for (const flight of [...flights.values()]) {
    drop(flight);
    flight.onCancel?.();
  }
  flights.clear();
  if (layer) layer.replaceChildren();
}
