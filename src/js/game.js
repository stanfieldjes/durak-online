import {
  applyMove,
  legalAttacks,
  legalDefenses,
  canPass,
  canTake,
  canAct,
  seatsToAct,
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

let game = null;      // the games row, with seats sorted by seat number
let state = null;     // the position
let mySeat = null;
let selected = null;  // card chosen from hand while defending
let unwatch = null;
let busy = false;
let settling = false;

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
    state = game.state;
    render();
    await maybeSettle();
  });

  state = game.state;
  render();
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
/* moves                                                               */
/* ------------------------------------------------------------------ */

/**
 * Apply a move locally, then try to write it.
 *
 * Attacking is free-for-all, so another player may have moved between our read
 * and our write. The database rejects that write rather than letting one of the
 * two cards vanish, and we replay the move against the fresh position. If the
 * move stopped being legal in the meantime — someone took the last slot — we
 * say so instead of forcing it through.
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
        if (attempt > 0) {
          toast('Someone else moved first — that is no longer available.');
        } else {
          toast(error instanceof IllegalMove ? error.message : 'That move is not allowed.');
        }
        state = base;
        return;
      }

      state = next; // optimistic, so the card leaves your hand immediately
      render();

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
  if (!state?.finished || settling) return;
  if (game.status === 'finished') {
    showResult();
    return;
  }
  settling = true;
  try {
    await finishGame(game.id, state.draw ? -1 : state.durak);
  } catch (error) {
    // Every client reports; whoever loses the race gets a harmless error.
    if (!/not in progress|already/i.test(error?.message ?? '')) {
      console.warn(error);
    }
  }
  game = (await getGame(game.id)) ?? game;
  if (game.status === 'finished') showResult();
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
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Send it to whoever you intend to beat.');
  } catch {
    toast(url);
  }
}

async function onStartNow(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  try {
    const count = game.players.length;
    await startGame(game.id, newGame(Number(game.seed), count));
    game = (await getGame(game.id)) ?? game;
    state = game.state;
    render();
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
        ? 'passed'
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
  const trumpBox = $('#trump-card');
  clear(trumpBox);
  if (state.deck.length > 0) trumpBox.append(cardEl(state.trumpCard, { trump: state.trump }));

  const pile = $('#deck-pile');
  pile.dataset.empty = String(state.deck.length === 0);
  setText($('#deck-count'), String(state.deck.length));
  setText($('#trump-label'), `Trump ${SUIT_GLYPH[state.trump]}`);

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

function showResult() {
  const box = $('#result');
  const deltas = game.rating_delta ?? {};
  const mine = deltas[session.user.id];
  const numeric = mine === undefined || mine === null ? null : Number(mine);

  let title;
  if (!game.durak_id) title = 'Draw.';
  else if (game.durak_id === session.user.id) title = 'You are the durak.';
  else title = 'You got out.';

  setText($('#result-title'), title);
  setText($('#result-elo'), numeric === null ? '' : `${formatRatingDelta(numeric)} rating`);

  const list = $('#result-table');
  clear(list);
  for (const seatRow of game.players ?? []) {
    const profile = seatRow.profile;
    const d = deltas[seatRow.player_id];
    const value = d === undefined || d === null ? null : Number(d);

    const li = document.createElement('li');
    if (game.durak_id === seatRow.player_id) li.classList.add('is-durak');

    const name = document.createElement('span');
    name.textContent = profile?.username ?? `Seat ${seatRow.seat + 1}`;

    const change = document.createElement('span');
    change.className = value === null ? '' : value >= 0 ? 'delta--up' : 'delta--down';
    change.textContent = value === null
      ? '—'
      : `${formatRating((profile?.rating ?? 0) + value)}  (${formatRatingDelta(value)})`;

    li.append(name, change);
    list.append(li);
  }

  if (session.profile && numeric !== null) {
    session.profile.rating = Number(session.profile.rating) + numeric;
    setText($('#whoami-elo'), formatRating(session.profile.rating));
  }

  show(box, true);
}
