import {
  applyMove,
  legalAttacks,
  legalDefenses,
  canPass,
  canTake,
  canAct,
  describe,
  roleOf,
  sameCard,
  cardId,
  newGame,
  SUIT_GLYPH,
  IllegalMove,
} from './durak.js';
import {
  getGame,
  getProfile,
  submitMove,
  finishGame,
  abandonGame,
  leaveTable,
  startGame,
  joinGame,
  watchGame,
  isStaleError,
} from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { formatRatingDelta, formatRating } from './elo.js';
import { $, show, setText, clear, toast, cardEl } from './ui.js';

const MAX_RETRIES = 3;
const CLEAR_MS = 420;

let game = null;      // the games row, with seats sorted by seat number
let state = null;     // the position
let mySeat = null;
let selected = null;  // card chosen from hand while defending
let unwatch = null;
let busy = false;
let settling = false;
let resultShown = false;

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function initGame() {
  $('#act-take').addEventListener('click', () => play({ type: 'take' }));
  $('#act-pass').addEventListener('click', () => play({ type: 'pass' }));
  $('#act-leave').addEventListener('click', onLeave);
  $('#waiting-leave').addEventListener('click', onLeaveWaiting);
  $('#copy-link').addEventListener('click', onCopyLink);
  $('#start-now').addEventListener('click', onStartNow);
  $('#result-again').addEventListener('click', () => { location.hash = '#/'; });
}

export async function enterGame(gameId) {
  reset();

  try {
    game = await getGame(gameId);
  } catch (error) {
    toast(readableError(error));
    location.hash = '#/';
    return;
  }
  if (!game) {
    toast('That table no longer exists.');
    location.hash = '#/';
    return;
  }

  mySeat = seatOf(session.user.id);
  if (mySeat === null) {
    // Arrived by shared link without a seat: take one if there is room.
    if (game.status !== 'waiting') {
      toast('That game has already started.');
      location.hash = '#/';
      return;
    }
    try {
      const seated = game.players.length;
      const willFill = seated + 1 >= game.max_players;
      await joinGame(gameId, willFill ? newGame(Number(game.seed), game.max_players) : null);
      game = await getGame(gameId);
      mySeat = seatOf(session.user.id);
    } catch (error) {
      toast(readableError(error));
      location.hash = '#/';
      return;
    }
  }

  unwatch = watchGame(gameId, async (event) => {
    if (event.kind === 'seats') {
      game = (await getGame(gameId)) ?? game;
    } else {
      // Realtime payloads carry no joined columns, so keep the ones we have.
      game = { ...game, ...event.row };
    }
    if (mySeat === null) mySeat = seatOf(session.user.id);
    await moveTo(game.state);
    await maybeSettle();
  });

  await moveTo(game.state);
  await maybeSettle();
}

export function leaveGame() {
  if (unwatch) unwatch();
  reset();
}

function reset() {
  if (unwatch) unwatch();
  unwatch = null;
  game = null;
  state = null;
  mySeat = null;
  selected = null;
  busy = false;
  settling = false;
  resultShown = false;
  show($('#result'), false);
  show($('#waiting'), false);
  show($('#felt'), false);
}

function seatOf(userId) {
  const found = (game?.players ?? []).find((p) => p.player_id === userId);
  return found ? found.seat : null;
}

function profileAt(seat) {
  return (game?.players ?? []).find((p) => p.seat === seat)?.profile ?? null;
}

/* ------------------------------------------------------------------ */
/* state transitions and animation                                     */
/* ------------------------------------------------------------------ */

/**
 * Adopt a new position, playing the round-end animation first if one is due.
 *
 * The cards leaving the table are the only moment in Durak where a pile of
 * cards moves somewhere, so it is worth showing rather than snapping.
 */
async function moveTo(next) {
  const previous = state;
  const ending = roundEnding(previous, next);

  if (ending && previous?.table?.length && !reducedMotion()) {
    await animateTableClear(ending);
  }

  state = next;
  render();
}

/** The 'beaten' or 'taken' entry appended since the last position, if any. */
function roundEnding(previous, next) {
  if (!previous?.log || !next?.log) return null;
  const fresh = next.log.slice(previous.log.length);
  return fresh.find((e) => e.t === 'beaten' || e.t === 'taken') ?? null;
}

/** Where the cards should fly to. */
function destinationFor(ending) {
  if (ending.t === 'beaten') return $('#discard');
  if (ending.seat === mySeat) return $('#my-hand');
  return document.querySelector(`.player[data-seat="${ending.seat}"]`);
}

function animateTableClear(ending) {
  const slots = [...document.querySelectorAll('#slots .slot')];
  if (slots.length === 0) return Promise.resolve();

  const target = destinationFor(ending);
  const targetBox = target?.getBoundingClientRect();

  slots.forEach((slot, i) => {
    const box = slot.getBoundingClientRect();
    let dx = 0;
    let dy = ending.t === 'beaten' ? -140 : 140;
    if (targetBox && targetBox.width) {
      dx = targetBox.left + targetBox.width / 2 - (box.left + box.width / 2);
      dy = targetBox.top + targetBox.height / 2 - (box.top + box.height / 2);
    }
    slot.style.setProperty('--dx', `${Math.round(dx)}px`);
    slot.style.setProperty('--dy', `${Math.round(dy)}px`);
    slot.style.setProperty('--delay', `${i * 40}ms`);
    slot.classList.add(ending.t === 'beaten' ? 'slot--discarding' : 'slot--collected');
  });

  return new Promise((resolve) => setTimeout(resolve, CLEAR_MS));
}

/* ------------------------------------------------------------------ */
/* moves                                                               */
/* ------------------------------------------------------------------ */

/**
 * Apply a move locally, then try to write it.
 *
 * Attacking is free-for-all, so another player may have moved between our read
 * and our write. The database rejects that write rather than letting one of the
 * two cards vanish, and we replay the move against the fresh position. If the
 * move stopped being legal in the meantime, we say so instead of forcing it.
 */
async function play(move) {
  if (busy || !state || state.finished) return;
  if (!canAct(state, mySeat)) {
    toast('You cannot act right now.');
    return;
  }

  busy = true;
  selected = null;
  const restore = state;

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const base = state;
      let next;
      try {
        next = applyMove(base, mySeat, move);
      } catch (error) {
        if (attempt > 0) toast('Someone else moved first — that is no longer available.');
        else toast(error instanceof IllegalMove ? error.message : 'That move is not allowed.');
        state = base;
        return;
      }

      await moveTo(next); // optimistic, so the table responds immediately

      try {
        const row = await submitMove(game.id, next, base.version);
        game = { ...game, ...row, players: row.players ?? game.players };
        state = row.state;
        return;
      } catch (error) {
        if (!isStaleError(error)) {
          state = restore;
          toast(readableError(error));
          return;
        }
        const fresh = await getGame(game.id);
        if (fresh) {
          game = fresh;
          state = fresh.state;
        }
        render();
      }
    }
    toast('The table is busy — try that again.');
    state = restore;
  } finally {
    busy = false;
    render();
    await maybeSettle();
  }
}

/** Once the engine says the game is over, ask the database to settle ratings. */
async function maybeSettle() {
  if (!state?.finished) return;

  if (game.status === 'finished') {
    await showResult();
    return;
  }
  if (settling) return;

  settling = true;
  try {
    await finishGame(game.id, state.draw ? -1 : state.durak);
  } catch (error) {
    // Every client reports; whoever loses the race gets a harmless error.
    if (!/not in progress|already/i.test(error?.message ?? '')) console.warn(error);
  }
  game = (await getGame(game.id)) ?? game;
  if (game.status === 'finished') await showResult();
  else settling = false;
}

async function onLeave() {
  if (state && !state.finished && game.status === 'active') {
    const ok = confirm('Leaving an unfinished game makes you the durak. Leave?');
    if (!ok) return;
    try {
      await finishGame(game.id, mySeat);
    } catch (error) {
      toast(readableError(error));
    }
  }
  location.hash = '#/';
}

async function onLeaveWaiting() {
  try {
    if (game.host_id === session.user.id) await abandonGame(game.id);
    else await leaveTable(game.id);
  } catch {
    /* the table simply stays as it was */
  }
  location.hash = '#/';
}

async function onCopyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied. Send it to whoever you intend to beat.');
  } catch {
    toast(location.href);
  }
}

async function onStartNow(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    await startGame(game.id, newGame(Number(game.seed), game.players.length));
    game = (await getGame(game.id)) ?? game;
    await moveTo(game.state);
  } catch (error) {
    toast(readableError(error));
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  if (!game) return;

  const waiting = game.status === 'waiting' || !state;
  show($('#waiting'), waiting);
  show($('#felt'), !waiting);
  if (waiting) {
    renderWaiting();
    return;
  }

  renderOpponents();
  renderStock();
  renderSlots();
  renderHand();
  renderPrompt();
  renderActions();
}

function renderWaiting() {
  const seated = game.players.length;
  setText(
    $('#waiting-count'),
    `${seated} of ${game.max_players} seated. The cards deal themselves when the last seat fills.`
  );

  const list = $('#seat-list');
  clear(list);
  for (let seat = 0; seat < game.max_players; seat++) {
    const profile = profileAt(seat);
    const li = document.createElement('li');
    li.className = profile ? 'seat seat--taken' : 'seat seat--empty';
    if (profile) {
      const name = document.createElement('span');
      name.className = 'seat__name';
      name.textContent = profile.username + (game.host_id === profile.id ? ' (host)' : '');
      const rating = document.createElement('span');
      rating.className = 'seat__rating';
      rating.textContent = formatRating(profile.rating);
      li.append(name, rating);
    } else {
      li.textContent = 'Empty';
    }
    list.append(li);
  }

  show($('#start-now'), game.host_id === session.user.id && seated >= 2 && seated < game.max_players);
}

function renderOpponents() {
  const box = $('#opponents');
  clear(box);

  const order = [];
  for (let i = 1; i < state.playerCount; i++) order.push((mySeat + i) % state.playerCount);

  for (const seat of order) {
    const profile = profileAt(seat);
    const panel = document.createElement('div');
    panel.className = 'player';
    panel.dataset.seat = String(seat);
    if (seat === state.defender) panel.classList.add('player--defending');
    if (seat === state.attacker) panel.classList.add('player--attacking');
    if (state.out[seat]) panel.classList.add('player--out');
    if (canAct(state, seat)) panel.classList.add('player--acting');

    const head = document.createElement('div');
    head.className = 'player__head';

    const name = document.createElement('span');
    name.className = 'player__name';
    name.textContent = profile?.username ?? `Seat ${seat + 1}`;

    const rating = document.createElement('span');
    rating.className = 'player__rating';
    rating.textContent = formatRating(profile?.rating);

    const role = document.createElement('span');
    role.className = 'player__role';
    role.textContent = state.out[seat]
      ? 'out'
      : state.passed[seat] && seat !== state.defender
        ? 'done'
        : roleOf(state, seat);

    head.append(name, rating, role);

    const fan = document.createElement('div');
    fan.className = 'fan fan--opponent';
    const count = state.hands[seat].length;
    for (let i = 0; i < Math.min(count, 8); i++) fan.append(cardEl(null, { faceDown: true }));

    const tally = document.createElement('span');
    tally.className = 'player__count';
    tally.textContent = count === 1 ? '1 card' : `${count} cards`;

    panel.append(head, fan, tally);
    box.append(panel);
  }
}

function renderStock() {
  // The trump card sits face up beside the stock for the whole game, so the
  // suit is never something anyone has to remember.
  const trumpBox = $('#trump-card');
  clear(trumpBox);
  const trumpCard = cardEl(state.trumpCard, { trump: state.trump });
  if (state.deck.length === 0) trumpCard.classList.add('card--drawn');
  trumpBox.append(trumpCard);

  const pile = $('#deck-pile');
  pile.dataset.empty = String(state.deck.length === 0);
  setText($('#deck-count'), String(state.deck.length));
  setText($('#trump-label'), `Trump ${SUIT_GLYPH[state.trump]}`);
  $('#trump-label').classList.toggle('is-red', state.trump === 'H' || state.trump === 'D');

  show($('#discard'), state.discard > 0);
  setText($('#discard-count'), String(state.discard));
}

function renderSlots() {
  const box = $('#slots');
  clear(box);

  state.table.forEach((slot, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'slot';
    wrap.append(cardEl(slot.atk, { trump: state.trump }));

    if (slot.def) {
      const def = cardEl(slot.def, { trump: state.trump });
      def.classList.add('card--defence');
      wrap.append(def);
    } else if (selected && legalDefenses(state, mySeat, index).some((c) => sameCard(c, selected))) {
      wrap.classList.add('slot--open', 'slot--target');
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'button');
      wrap.setAttribute('aria-label', 'Beat this card');
      const commit = () => play({ type: 'defend', card: selected, slot: index });
      wrap.addEventListener('click', commit);
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(); }
      });
    }

    box.append(wrap);
  });
}

function renderHand() {
  const box = $('#my-hand');
  clear(box);

  const live = !busy && !state.finished && !state.out[mySeat];
  const attacks = live ? legalAttacks(state, mySeat) : [];
  const defending = live && mySeat === state.defender && !state.taking;

  const hand = [...state.hands[mySeat]].sort(byTrumpThenRank);

  for (const card of hand) {
    const canAttack = attacks.some((c) => sameCard(c, card));
    const openFor = defending
      ? state.table
          .map((slot, i) =>
            !slot.def && legalDefenses(state, mySeat, i).some((c) => sameCard(c, card)) ? i : -1
          )
          .filter((i) => i >= 0)
      : [];
    const playable = canAttack || openFor.length > 0;

    const el = cardEl(card, { interactive: true, trump: state.trump });
    el.disabled = !playable;
    // Unplayable cards are darkened rather than faded, because the hand
    // overlaps and stacked transparency reads as mud.
    el.classList.toggle('card--dim', !playable);
    el.classList.toggle('is-playable', playable);
    el.classList.toggle('is-selected', Boolean(selected && sameCard(selected, card)));

    if (playable) {
      el.addEventListener('click', () => {
        if (openFor.length === 1) {
          play({ type: 'defend', card, slot: openFor[0] });
        } else if (openFor.length > 1) {
          selected = sameCard(selected, card) ? null : card;
          render();
        } else {
          play({ type: 'attack', card });
        }
      });
    }

    box.append(el);
  }
}

function byTrumpThenRank(a, b) {
  const trump = state.trump;
  if ((a.s === trump) !== (b.s === trump)) return a.s === trump ? 1 : -1;
  if (a.s !== b.s) return a.s.localeCompare(b.s);
  return cardId(a).localeCompare(cardId(b));
}

function renderPrompt() {
  const el = $('#prompt');
  setText(el, describe(state, mySeat));
  el.classList.toggle('prompt--you', canAct(state, mySeat) && !state.finished);
}

function renderActions() {
  const live = !busy && !state.finished && !state.out[mySeat];
  show($('#act-take'), live && canTake(state, mySeat));
  show($('#act-pass'), live && canPass(state, mySeat));
}

/**
 * Draw the final scores.
 *
 * Safe to call more than once: it reads ratings from the server rather than
 * adjusting anything in place, so a repeated call cannot double the numbers.
 */
async function showResult() {
  if (resultShown) return;
  resultShown = true;

  // Always re-read the row. Realtime payloads carry no joined columns, so the
  // profiles attached to `game` may be whatever was loaded when the table
  // opened. Re-reading guarantees the ratings below are the settled ones.
  try {
    const fresh = await getGame(game.id);
    if (fresh) game = fresh;
  } catch {
    /* fall back to what we already have */
  }

  const deltas = game.rating_delta ?? {};
  const mine = deltas[session.user.id];
  const numeric = mine === undefined || mine === null ? null : Number(mine);

  let title;
  if (!game.durak_id) title = 'Draw.';
  else if (game.durak_id === session.user.id) title = 'You are the durak.';
  else title = 'You got out.';

  setText($('#result-title'), title);
  setText($('#result-elo'), numeric === null ? '' : `${formatRatingDelta(numeric)} rating`);

  // finish_game() has already written these ratings, so they are final. The
  // delta is shown beside them for context, NOT added to them — doing both is
  // what made the scoreboard read double the points that were actually moved.
  const list = $('#result-table');
  clear(list);
  for (const seatRow of game.players ?? []) {
    const d = deltas[seatRow.player_id];
    const value = d === undefined || d === null ? null : Number(d);
    const settled = Number(seatRow.profile?.rating ?? 0);

    const li = document.createElement('li');
    if (game.durak_id === seatRow.player_id) li.classList.add('is-durak');

    const name = document.createElement('span');
    name.textContent = seatRow.profile?.username ?? `Seat ${seatRow.seat + 1}`;

    const change = document.createElement('span');
    change.className = value === null ? '' : value >= 0 ? 'delta--up' : 'delta--down';
    change.textContent =
      value === null ? '—' : `${formatRating(settled)}  (${formatRatingDelta(value)})`;

    li.append(name, change);
    list.append(li);
  }

  // Refresh the header from the database rather than adding the delta locally.
  try {
    const fresh = await getProfile(session.user.id);
    if (fresh) {
      session.profile = fresh;
      setText($('#whoami-elo'), formatRating(fresh.rating));
    }
  } catch {
    /* the header just keeps the old number */
  }

  show($('#result'), true);
}
