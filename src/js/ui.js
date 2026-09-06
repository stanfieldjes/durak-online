import { SUIT_GLYPH, SUIT_NAME, RANKS } from './durak.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(el, visible = true) {
  if (el) el.hidden = !visible;
}

export function setText(el, text) {
  if (el) el.textContent = text;
}

let toastTimer = null;

export function toast(message, ms = 3200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

/** Build a card element. `interactive` makes it a button. */
export function cardEl(card, { interactive = false, trump = null, faceDown = false } = {}) {
  const el = document.createElement(interactive ? 'button' : 'div');
  el.className = 'card';
  if (interactive) el.type = 'button';

  if (faceDown) {
    el.classList.add('card--back');
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  const isRed = card.s === 'H' || card.s === 'D';
  if (isRed) el.classList.add('card--red');
  if (trump && card.s === trump) el.classList.add('card--trump-mark');

  const rank = document.createElement('span');
  rank.className = 'card__rank';
  rank.textContent = card.r;

  const suit = document.createElement('span');
  suit.className = 'card__suit';
  suit.textContent = SUIT_GLYPH[card.s];

  el.append(rank, suit);
  el.setAttribute('aria-label', `${spellRank(card.r)} of ${SUIT_NAME[card.s]}`);
  return el;
}

function spellRank(r) {
  const words = { J: 'jack', Q: 'queen', K: 'king', A: 'ace' };
  return words[r] ?? r;
}

export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function deltaClass(n) {
  if (!n) return 'delta--flat';
  return n > 0 ? 'delta--up' : 'delta--down';
}

export { RANKS };
