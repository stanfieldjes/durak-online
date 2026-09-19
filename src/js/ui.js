import { SUIT_GLYPH, SUIT_NAME } from './durak.js';
import { formatRating, formatRatingDelta } from './rating.js';

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

/* ---------------- players ---------------- */

/**
 * The first character of a name, counted in characters rather than in code
 * units. `name[0]` would cut an emoji or any other astral character in half
 * and produce a lone surrogate, which renders as a replacement box.
 */
function initialOf(name) {
  const first = [...String(name ?? '')].find((c) => c.trim().length > 0);
  return (first ?? '?').toUpperCase();
}

/**
 * A stable colour per name, so a player without a picture still looks like
 * themselves everywhere they appear. Any spread of the name's characters
 * would do; this one is only asked to be deterministic and cheap.
 */
function hueOf(name) {
  let hash = 0;
  for (const ch of String(name ?? '')) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

/**
 * A player's picture, falling back to their initial on a colour of their own.
 *
 * The fallback is not only for players who have not set a picture: an <img>
 * that fails to load — a file deleted from storage, a phone with no signal —
 * swaps itself out for the initial too, so a broken image icon never appears
 * at the table.
 */
export function avatarEl(profile, { size = 'sm' } = {}) {
  const el = document.createElement('span');
  el.className = `avatar avatar--${size}`;
  el.setAttribute('aria-hidden', 'true');

  const name = profile?.username ?? '';
  const initial = () => {
    clear(el);
    el.classList.add('avatar--letter');
    el.style.setProperty('--avatar-hue', String(hueOf(name)));
    el.textContent = initialOf(name);
  };

  if (profile?.avatar_url) {
    const img = document.createElement('img');
    img.src = profile.avatar_url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', initial, { once: true });
    el.append(img);
  } else {
    initial();
  }
  return el;
}

/** A picture and a name together: how a player is shown everywhere but the felt. */
export function playerEl(profile, { size = 'sm', fallback = 'unknown' } = {}) {
  const el = document.createElement('span');
  el.className = 'player-chip';
  const name = document.createElement('span');
  name.className = 'player-chip__name';
  name.textContent = profile?.username ?? fallback;
  el.append(avatarEl(profile, { size }), name);
  return el;
}

/* ---------------- cards ---------------- */

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
  if (trump && card.s === trump) el.classList.add('card--trump');

  const rank = document.createElement('span');
  rank.className = 'card__rank';
  rank.textContent = card.r;

  const suit = document.createElement('span');
  suit.className = 'card__suit';
  suit.textContent = SUIT_GLYPH[card.s];

  el.append(rank, suit);
  el.setAttribute('aria-label', `${spellRank(card.r)} of ${SUIT_NAME[card.s]}`);
  // Lets card movement find this exact card again after a re-render.
  el.dataset.card = card.r + card.s;
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

/* ---------------- ratings ---------------- */

/**
 * Write a rating into an element. A rating is a position on a ladder rather
 * than a verdict, so it is not coloured: 900 is not a bad number, it is just
 * a number. Only the change from a game gets a colour — see paintDelta.
 */
export function paintRating(el, rating) {
  if (!el) return;
  el.textContent = formatRating(rating);
}

const DELTA_TONES = ['delta--up', 'delta--down', 'delta--flat'];

/** Write a rating change into an element and colour it by sign. */
export function paintDelta(el, delta) {
  if (!el) return;
  el.textContent = formatRatingDelta(delta);
  el.classList.remove(...DELTA_TONES);
  el.classList.add(deltaClass(delta));
}

function deltaClass(n) {
  if (n === null || n === undefined) return 'delta--flat';
  const value = Number(n);
  if (!value) return 'delta--flat';
  return value > 0 ? 'delta--up' : 'delta--down';
}
