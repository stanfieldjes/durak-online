/**
 * Card movement effects.
 *
 * Everything here animates *clones* in a fixed overlay above the page, never
 * the real elements. That keeps animation completely separate from state: the
 * table can re-render the instant a move lands, while the previous cards are
 * still sliding away, so nobody ever has to wait for an animation to finish
 * before playing again.
 */

let layer = null;

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

const centreOf = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

/**
 * Copy a live element into the overlay at exactly the position it occupies.
 */
function cloneAt(el, box) {
  const copy = el.cloneNode(true);
  copy.classList.add('fx-piece');
  copy.style.left = `${box.left}px`;
  copy.style.top = `${box.top}px`;
  copy.style.width = `${box.width}px`;
  copy.style.height = `${box.height}px`;
  copy.removeAttribute('id');
  return copy;
}

function animate(copy, dx, dy, { duration, delay, spin, fade, scale }) {
  const move = copy.animate(
    [
      { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
      {
        transform: `translate(${dx}px, ${dy}px) rotate(${spin}deg) scale(${scale})`,
        opacity: fade,
      },
    ],
    { duration, delay, easing: 'cubic-bezier(0.35, 0, 0.2, 1)', fill: 'forwards' }
  );
  move.finished.catch(() => {}).then(() => copy.remove());
}

/**
 * Send the cards currently on the table to wherever they are going.
 * Call this BEFORE re-rendering; the clones survive the re-render.
 */
export function flyTableAway(slotEls, target, { collected = false } = {}) {
  if (reducedMotion() || slotEls.length === 0) return;
  const host = surface();
  const targetBox = target?.getBoundingClientRect();
  const to = targetBox?.width ? centreOf(targetBox) : null;

  slotEls.forEach((slot, i) => {
    const box = slot.getBoundingClientRect();
    if (!box.width) return;
    const from = centreOf(box);
    const dx = to ? to.x - from.x : 0;
    const dy = to ? to.y - from.y : -160;

    const copy = cloneAt(slot, box);
    host.append(copy);
    animate(copy, dx, dy, {
      duration: collected ? 340 : 400,
      delay: i * 45,
      spin: collected ? -8 : 10,
      fade: 0,
      scale: collected ? 0.5 : 0.65,
    });
  });
}

/**
 * Deal `count` face-down cards from the stock to a destination.
 * Used when hands refill, so the stock visibly empties over the game.
 */
export function flyDraw(stockEl, target, count) {
  if (reducedMotion() || count <= 0 || !stockEl || !target) return;
  const from = stockEl.getBoundingClientRect();
  const toBox = target.getBoundingClientRect();
  if (!from.width || !toBox.width) return;

  const host = surface();
  const start = centreOf(from);
  const end = centreOf(toBox);

  for (let i = 0; i < Math.min(count, 6); i++) {
    const copy = document.createElement('div');
    copy.className = 'card card--back fx-piece';
    copy.style.left = `${from.left}px`;
    copy.style.top = `${from.top}px`;
    copy.style.width = `${from.width}px`;
    copy.style.height = `${from.height}px`;
    host.append(copy);

    animate(copy, end.x - start.x, end.y - start.y, {
      duration: 320,
      delay: i * 70,
      spin: 6,
      fade: 0.15,
      scale: 0.85,
    });
  }
}

/**
 * Deal the opening hands: one card at a time, round by round, to each seat in
 * turn — the way a person deals rather than six cards appearing at once.
 *
 * Returns how long the whole thing takes, so the caller knows when the real
 * hands can be revealed. Returns 0 when there is nothing to animate.
 */
export function flyDeal(stockEl, targets, rounds, { gap = 55, onCard } = {}) {
  if (reducedMotion() || !stockEl || rounds <= 0) return 0;
  const from = stockEl.getBoundingClientRect();
  if (!from.width) return 0;

  const host = surface();
  const start = centreOf(from);
  let index = 0;

  for (let round = 0; round < rounds; round++) {
    for (const target of targets) {
      const box = target?.getBoundingClientRect();
      if (!box?.width) {
        index++;
        continue;
      }
      const end = centreOf(box);

      const copy = document.createElement('div');
      copy.className = 'card card--back fx-piece';
      copy.style.left = `${from.left}px`;
      copy.style.top = `${from.top}px`;
      copy.style.width = `${from.width}px`;
      copy.style.height = `${from.height}px`;
      host.append(copy);

      animate(copy, end.x - start.x, end.y - start.y, {
        duration: 300,
        delay: index * gap,
        spin: 10,
        fade: 0.2,
        scale: 0.85,
      });

      if (onCard) setTimeout(onCard, index * gap);
      index++;
    }
  }

  return index === 0 ? 0 : (index - 1) * gap + 300;
}

export function clearEffects() {
  if (layer) layer.replaceChildren();
}
