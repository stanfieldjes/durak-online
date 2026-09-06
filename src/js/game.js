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
  rankValue,
  newGame,
  HAND_SIZE,
  SUITS,
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
import { flyTableAway, flyDraw, flyDeal, clearEffects, reducedMotion } from './fx.js';
import { play as playSound, playRepeat, isMuted, toggleMuted } from './sound.js';
import { $, show, setText, clear, toast, cardEl } from './ui.js';

/** How long the finished table stays on screen before the scores appear. */
const RESULT_DELAY_MS = 2200;

let game = null;       // the games row, seats sorted
let confirmed = null;  // the last position the server acknowledged
let pending = [];      // moves applied locally but not yet acknowledged
let state = null;      // confirmed + pending, i.e. what the player sees
let mySeat = null;
let selected = null;
let unwatch = null;
let sending = false;
let resultShown = false;
let resultTimer = null;
let dealing = false;    // opening hands still flying out
let dealPlayed = false; // only deal once per visit to a table
let dealTimer = null;

export function initGame() {
  $('#act-take').addEventListener('click', () => play({ type: 'take' }));
  $('#act-pass').addEventListener('click', () => play({ type: 'pass' }));
  $('#act-leave').addEventListener('click', onLeave);
  $('#waiting-leave').addEventListener('click', onLeaveWaiting);
  $('#copy-link').addEventListener('click', onCopyLink);
  $('#start-now').addEventListener('click', onStartNow);
  $('#result-again').addEventListener('click', () => { location.hash = '#/'; });

  const mute = $('#act-mute');
  const paintMute = () => {
    setText(mute, isMuted() ? 'Sound off' : 'Sound on');
    mute.setAttribute('aria-pressed', String(isMuted()));
  };
  mute.addEventListener('click', () => {
    toggleMuted();
    paintMute();
  });
  paintMute();
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
      game = mergeRow(game, event.row);
    }
    if (mySeat === null) mySeat = seatOf(session.user.id);
    adopt(game.state);
    await maybeSettle();
  });

  adopt(game.state);
  await maybeSettle();
}

export function leaveGame() {
  if (unwatch) unwatch();
  reset();
}

function reset() {
  if (unwatch) unwatch();
  unwatch = null;
  clearTimeout(resultTimer);
  resultTimer = null;
  clearTimeout(dealTimer);
  dealTimer = null;
  dealing = false;
  dealPlayed = false;
  clearEffects();
  game = null;
  confirmed = null;
  pending = [];
  state = null;
  mySeat = null;
  selected = null;
  sending = false;
  resultShown = false;
  show($('#result'), false);
  show($('#waiting'), false);
  show($('#felt'), false);
}

/**
 * Realtime payloads carry only the `games` columns, with no joined seats, so
 * keep the ones already loaded rather than letting them be overwritten.
 */
function mergeRow(previous, row) {
  const players = row?.players?.length ? row.players : previous?.players;
  return { ...previous, ...row, players };
}

function seatOf(userId) {
  const found = (game?.players ?? []).find((p) => p.player_id === userId);
  return found ? found.seat : null;
}

function profileAt(seat) {
  return (game?.players ?? []).find((p) => p.seat === seat)?.profile ?? null;
}

function nameAt(seat) {
  return profileAt(seat)?.username ?? `Seat ${seat + 1}`;
}

/* ------------------------------------------------------------------ */
/* state: confirmed + pending                                          */
/* ------------------------------------------------------------------ */

/** Rebuild the visible position by replaying unacknowledged moves. */
function rebuild() {
  let next = confirmed;
  const kept = [];
  for (const move of pending) {
    try {
      next = applyMove(next, mySeat, move);
      kept.push(move);
    } catch {
      // Somebody else's move made ours impossible. Dropping it is correct.
    }
  }
  pending = kept;
  return next;
}

/** Take a new server position, replay anything still in flight, and draw it. */
function adopt(serverState) {
  const previous = state;
  confirmed = serverState;
  const next = rebuild();
  present(previous, next);
}

/** Apply locally without waiting for anything. */
function advanceLocally(move) {
  const previous = state;
  const next = applyMove(state, mySeat, move);
  pending.push(move);
  present(previous, next);
}

/**
 * Show a new position: fire the effects for whatever just happened, then
 * render immediately. Effects animate clones, so rendering does not wait.
 */
function present(previous, next) {
  // A position at version 0 is a table that has just been dealt.
  const opening = Boolean(next) && next.version === 0 && !next.finished && !dealPlayed;

  if (opening) {
    dealPlayed = true;
    dealing = true;
  } else {
    const events = newEvents(previous, next);
    if (previous && next && events.length) runEffects(previous, next, events);
  }

  state = next;
  render();
  if (opening) startDeal();
}

/**
 * Deal the opening hands one card at a time. The hands are held back until the
 * cards land, so the deal is something to watch rather than a decoration over
 * a table that already has everything on it.
 */
function startDeal() {
  playSound('start');

  requestAnimationFrame(() => {
    if (!state) return;
    const targets = [];
    for (let i = 0; i < state.playerCount; i++) {
      const seat = (mySeat + i) % state.playerCount;
      targets.push(seat === mySeat ? $('#my-hand') : seatPanel(seat));
    }

    const ms = flyDeal($('#deck-pile'), targets, HAND_SIZE, {
      gap: 55,
      onCard: () => playSound('draw'),
    });

    clearTimeout(dealTimer);
    dealTimer = setTimeout(() => {
      dealTimer = null;
      dealing = false;
      render();
    }, ms);
  });
}

function newEvents(previous, next) {
  if (!previous?.log || !next?.log) return [];
  if (next.log.length <= previous.log.length) return [];
  return next.log.slice(previous.log.length);
}

/* ------------------------------------------------------------------ */
/* effects                                                             */
/* ------------------------------------------------------------------ */

function runEffects(previous, next, events) {
  const ending = events.find((e) => e.t === 'beaten' || e.t === 'taken');

  if (events.some((e) => e.t === 'attack' || e.t === 'defend')) playSound('play');

  if (ending) {
    const slots = [...document.querySelectorAll('#slots .slot')];
    const collected = ending.t === 'taken';
    const target = collected
      ? (ending.seat === mySeat ? $('#my-hand') : seatPanel(ending.seat))
      : $('#discard');
    flyTableAway(slots, target, { collected });
    playSound('gather');
  }

  // Hands refilling from the stock: draw as many cards as each seat gained.
  const drawn = previous.deck.length - next.deck.length;
  if (drawn > 0) {
    const stock = $('#deck-pile');
    let total = 0;
    for (let seat = 0; seat < next.playerCount; seat++) {
      const gained = next.hands[seat].length - previous.hands[seat].length;
      if (gained <= 0) continue;
      total += gained;
      const target = seat === mySeat ? $('#my-hand') : seatPanel(seat);
      // Let the table finish clearing first, so the two do not overlap.
      const start = ending && !reducedMotion() ? 260 : 0;
      setTimeout(() => flyDraw(stock, target, gained), start);
    }
    if (total > 0) setTimeout(() => playRepeat('draw', total), ending ? 300 : 40);
  }
}

const seatPanel = (seat) => document.querySelector(`.player[data-seat="${seat}"]`);

/* ------------------------------------------------------------------ */
/* moves                                                               */
/* ------------------------------------------------------------------ */

/**
 * Play a move.
 *
 * The move lands on screen straight away and joins a queue that is drained in
 * the background, so the primary attacker can put down several cards in a row
 * without waiting for the network or for an animation to finish.
 */
function play(move) {
  if (!state || state.finished) return;
  if (!canAct(state, mySeat)) {
    toast('You cannot act right now.');
    return;
  }

  selected = null;
  try {
    advanceLocally(move);
  } catch (error) {
    toast(error instanceof IllegalMove ? error.message : 'That move is not allowed.');
    return;
  }
  drain();
}

/**
 * Send queued moves one at a time.
 *
 * Each write names the version it was built on, so if another player got there
 * first the database refuses it. We then re-read, replay whatever is still
 * legal, and carry on from there.
 */
async function drain() {
  if (sending || pending.length === 0 || !game) return;
  sending = true;

  try {
    while (pending.length > 0) {
      const move = pending[0];

      let next;
      try {
        next = applyMove(confirmed, mySeat, move);
      } catch {
        pending.shift(); // no longer legal against the confirmed position
        adopt(confirmed);
        continue;
      }

      try {
        const row = await submitMove(game.id, next, confirmed.version);
        game = mergeRow(game, row);
        pending.shift();
        confirmed = row.state;
        state = rebuild();
        render();
      } catch (error) {
        if (!isStaleError(error)) {
          pending = [];
          toast(readableError(error));
          const fresh = await getGame(game.id).catch(() => null);
          if (fresh) game = fresh;
          adopt(game.state);
          return;
        }
        const fresh = await getGame(game.id).catch(() => null);
        if (!fresh) return;
        const before = pending.length;
        game = fresh;
        adopt(fresh.state);
        if (pending.length < before) {
          toast('Someone else moved first — one of your cards did not land.');
        }
      }
    }
  } finally {
    sending = false;
    await maybeSettle();
  }
}

/**
 * Settle the game.
 *
 * The scoreboard is held back for a moment so the last exchange stays on
 * screen. That matters most when the defender beats the final attack and
 * empties their hand: the draw is something to watch, not something to be told
 * about after the fact.
 */
async function maybeSettle() {
  const over = state?.finished || game?.status === 'finished';
  if (!over || resultShown || resultTimer) return;

  if (game.status !== 'finished' && state?.finished) {
    try {
      await finishGame(game.id, state.draw ? -1 : state.durak);
    } catch (error) {
      if (!/not in progress|already/i.test(error?.message ?? '')) console.warn(error);
    }
    game = (await getGame(game.id)) ?? game;
  }

  if (state?.finished) playSound(state.durak === mySeat ? 'loss' : 'win');
  else playSound(game.durak_id === session.user.id ? 'loss' : 'win');

  render();
  resultTimer = setTimeout(() => {
    resultTimer = null;
    showResult();
  }, reducedMotion() ? 400 : RESULT_DELAY_MS);
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
    adopt(game.state);
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
  box.dataset.count = String(order.length);

  for (const seat of order) {
    const profile = profileAt(seat);
    const panel = document.createElement('div');
    panel.className = 'player';
    panel.dataset.seat = String(seat);
    if (seat === state.defender) panel.classList.add('player--defending');
    if (seat === state.attacker) panel.classList.add('player--attacking');
    if (seat === state.defender && state.taking) panel.classList.add('player--taking');
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
    const count = dealing ? 0 : state.hands[seat].length;
    for (let i = 0; i < Math.min(count, 10); i++) fan.append(cardEl(null, { faceDown: true }));

    const tally = document.createElement('span');
    tally.className = 'player__count';
    tally.textContent = dealing ? '' : count === 1 ? '1 card' : `${count} cards`;

    panel.append(head, fan, tally);
    box.append(panel);
  }
}

function renderStock() {
  const trumpBox = $('#trump-card');
  clear(trumpBox);
  if (state.deck.length > 0) {
    trumpBox.append(cardEl(state.trumpCard, { trump: state.trump }));
  }

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
  if (dealing) return; // the cards are still on their way

  const live = !state.finished && !state.out[mySeat];
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

/**
 * Hand order: lowest on the left, highest on the right, trumps held apart at
 * the right-hand end where they are easy to find and hard to play by accident.
 */
function byTrumpThenRank(a, b) {
  const trump = state.trump;
  const aTrump = a.s === trump;
  const bTrump = b.s === trump;
  if (aTrump !== bTrump) return aTrump ? 1 : -1;

  const byRank = rankValue(a.r) - rankValue(b.r);
  if (byRank !== 0) return byRank;
  return SUITS.indexOf(a.s) - SUITS.indexOf(b.s);
}

function renderPrompt() {
  const el = $('#prompt');
  if (dealing) {
    setText(el, 'Dealing…');
    el.classList.remove('prompt--you');
    return;
  }
  setText(el, describe(state, mySeat));
  el.classList.toggle('prompt--you', canAct(state, mySeat) && !state.finished);
}

function renderActions() {
  const live = !dealing && !state.finished && !state.out[mySeat];

  const defending = live && mySeat === state.defender && state.table.length > 0 && !state.taking;
  const takeable = canTake(state, mySeat);
  const take = $('#act-take');
  show(take, defending);
  take.disabled = !takeable;
  take.classList.toggle('btn--spent', defending && !takeable);
  take.title = takeable ? '' : 'Everything is beaten — you do not have to take.';

  show($('#act-pass'), live && canPass(state, mySeat));
}

/* ------------------------------------------------------------------ */
/* result                                                              */
/* ------------------------------------------------------------------ */

async function showResult() {
  if (resultShown) return;
  resultShown = true;

  try {
    const fresh = await getGame(game.id);
    if (fresh) game = fresh;
  } catch {
    /* fall back to what we have */
  }

  const deltas = game.rating_delta ?? {};
  const mine = deltas[session.user.id];
  const numeric = mine === undefined || mine === null ? null : Number(mine);

  // The position never reached an ending of its own, so somebody walked out.
  const conceded = !state?.finished && game.status === 'finished';
  const durakSeat = (game.players ?? []).find((p) => p.player_id === game.durak_id)?.seat;

  let title;
  if (conceded && game.durak_id && game.durak_id !== session.user.id) {
    title = `${nameAt(durakSeat)} left the game.`;
  } else if (!game.durak_id) {
    title = 'Draw.';
  } else if (game.durak_id === session.user.id) {
    title = 'You are the durak.';
  } else {
    title = 'You got out.';
  }

  setText($('#result-title'), title);

  const figure = $('#result-elo');
  setText(figure, numeric === null ? '' : `${formatRatingDelta(numeric)} rating`);
  figure.classList.toggle('delta--down', numeric !== null && numeric < 0);
  figure.classList.toggle('delta--up', numeric !== null && numeric > 0);

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

  try {
    const fresh = await getProfile(session.user.id);
    if (fresh) {
      session.profile = fresh;
      setText($('#whoami-elo'), formatRating(fresh.rating));
    }
  } catch {
    /* the header keeps its old number */
  }

  show($('#result'), true);
}
