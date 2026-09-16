/**
 * How big the table is.
 *
 * Everything on the felt is sized from one number, --table-scale on <html>:
 * card size, and the felt's width (62.5rem at a scale of 1). Until the player
 * chooses a size, the table is fitted to the window: as wide as there is
 * room for, and no taller than the window below where the felt starts.
 *
 * Dragging the grip in the felt's bottom-right corner sets a size, which is
 * remembered. Double-clicking the grip (or Home, from the keyboard) goes back
 * to fitting the window.
 *
 * Fitting prefers height (the whole table visible without scrolling) but
 * never goes below FIT_MIN_SCALE for it.
 */

const STORAGE_KEY = 'durak:table-scale';
const MIN_SCALE = 0.6;
/* Fitting the window never shrinks the table below this: on a short screen a
   little scrolling is better than cards too small to read. Dragging the
   corner can still go down to MIN_SCALE. */
const FIT_MIN_SCALE = 0.85;
const MAX_SCALE = 2.2;
const KEY_STEP = 0.05;
const BOTTOM_MARGIN = 16; // px left clear below the felt when fitting

let felt = null;
let grip = null;
let scale = 1;
let chosen = readChosen();
let fitted = false;
let drag = null;
let resizeTimer = null;

function readChosen() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveChosen(value) {
  chosen = value;
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value.toFixed(3));
  } catch {
    /* private mode: the size just is not remembered */
  }
}

const visible = () => Boolean(felt && !felt.hidden && felt.offsetParent !== null);

/** The biggest scale at which the felt still fits across the window. */
function widestScale() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const room = felt.parentElement?.clientWidth || window.innerWidth;
  return room / (62.5 * rem);
}

function limit(value) {
  return Math.min(Math.max(value, MIN_SCALE), Math.max(MIN_SCALE, Math.min(MAX_SCALE, widestScale())));
}

function apply(value) {
  scale = limit(value);
  document.documentElement.style.setProperty('--table-scale', scale.toFixed(3));
  if (grip) {
    const percent = Math.round(scale * 100);
    grip.setAttribute('aria-valuenow', String(percent));
    grip.setAttribute('aria-valuetext', `${percent}%`);
  }
}

/**
 * The scale that makes the felt fill the window. The felt's height is close
 * to a straight line in the scale (cards grow, text does not), so measuring
 * it at two scales is enough to solve for the one that fits. Both
 * measurements happen in the same task, so neither is ever painted.
 */
function fitScale() {
  const wide = limit(MAX_SCALE);
  const a = Math.max(MIN_SCALE, Math.min(0.8, wide * 0.75));
  const b = Math.min(1.2, wide);
  if (b - a < 0.05) return wide;

  apply(a);
  const heightA = felt.offsetHeight;
  apply(b);
  const heightB = felt.offsetHeight;
  const perUnit = (heightB - heightA) / (b - a);
  if (perUnit <= 0) return wide;

  const top = felt.getBoundingClientRect().top + window.scrollY;
  const room = window.innerHeight - top - BOTTOM_MARGIN;
  let fits = Math.min(wide, Math.max(MIN_SCALE, a + (room - heightA) / perUnit));

  // Not quite a straight line (opponents' cards stop growing once they reach
  // their cap, or once their panel is full), so check the answer and correct
  // it, erring small rather than spilling below the window.
  for (let i = 0; i < 4; i++) {
    apply(fits);
    const over = felt.offsetHeight - room;
    if (over <= 0 && over > -8) break;
    if (over <= 0 && fits >= wide) break;
    fits = Math.min(wide, Math.max(MIN_SCALE, fits - over / perUnit - (over > 0 ? 0.005 : 0)));
  }
  apply(fits);
  if (felt.offsetHeight > room && fits > MIN_SCALE) fits = Math.max(MIN_SCALE, fits - (felt.offsetHeight - room) / perUnit - 0.01);
  return Math.min(wide, Math.max(FIT_MIN_SCALE, fits));
}

function settle() {
  if (!visible()) return;
  apply(chosen ?? fitScale());
}

export function initTableSize(feltEl, gripEl) {
  felt = feltEl;
  grip = gripEl;

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const box = felt.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, width: box.width, height: box.height, scale };
    felt.classList.add('is-resizing');
  });

  grip.addEventListener('pointermove', (event) => {
    if (!drag) return;
    // The felt is centred, so moving the corner right by dx widens it by 2dx.
    // Follow whichever direction the pointer has moved further in.
    const across = (drag.width + 2 * (event.clientX - drag.x)) / drag.width;
    const down = (drag.height + (event.clientY - drag.y)) / drag.height;
    const factor = Math.abs(across - 1) > Math.abs(down - 1) ? across : down;
    apply(drag.scale * factor);
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    felt.classList.remove('is-resizing');
    saveChosen(scale);
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  grip.addEventListener('dblclick', () => {
    saveChosen(null);
    settle();
  });

  grip.addEventListener('keydown', (event) => {
    let next = null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = scale + KEY_STEP;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = scale - KEY_STEP;
    else if (event.key === 'Home') {
      event.preventDefault();
      saveChosen(null);
      settle();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    apply(next);
    saveChosen(scale);
  });

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(settle, 120);
  });
}

/** The felt has just been drawn: size it, once per visit to a table. */
export function tableShown() {
  if (fitted || !visible()) return;
  fitted = true;
  settle();
}

/** Leaving a table: the next one is sized afresh when it appears. */
export function tableHidden() {
  fitted = false;
}
