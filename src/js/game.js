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
import {
  flyTableAway,
  flyDraw,
  flyDeal,
  clearEffects,
  reducedMotion,
  TABLE_CLEAR_MS,
  TABLE_CLEAR_STAGGER_MS,
  DRAW_FLIGHT_MS,
  DRAW_STAGGER_MS,
} from './fx.js';
import { play as playSound, isMuted, toggleMuted, setSoundActive } from './sound.js';
import { $, show, setText, clear, toast, cardEl } from './ui.js';

/** How long the finished table stays on screen before the scores appear. */
const RESULT_DELAY_MS = 2200;

/** Dealing: gap between cards leaving the stock, and how long each is in the air. */
const DEAL_GAP_MS = 90;
const DEAL_FLIGHT_MS = 320;

let game = null;       // the games row, seats sorted
let confirmed = null;  // the last position the server acknowledged
let pending = [];      // moves applied locally but not yet acknowledged
let state = null;      // confirmed + pending, i.e. what the player sees
let mySeat = null;
let selected = null;
let unwatch = null;
let sending = false;
let settling = false;
let resultShown = false;
let resultTimer = null;
let dealing = false;    // opening hands still flying out
let dealPlayed = false; // only deal once per visit to a table
let dealTimers = [];

/**
 * How far into the position's log sound and animation have already reacted.
 *
 * present() can be called more than once for data that overlaps — our own
 * move gets applied locally, then confirmed by its own RPC response, then
 * echoed again by realtime, and those three arrivals are not guaranteed to
 * happen in a tidy order. Comparing two arbitrary state objects to decide
 * "is this new" is fragile under that kind of race. Counting log entries we
 * have already announced is not: every entry is reacted to exactly once,
 * ever, regardless of how many times present() runs or in what order.
 */
let announcedThrough = 0;

/**
 * Per-seat set of card ids currently hidden from display: they exist in
 * state.hands[seat] but their flight animation has not landed yet, so they
 * should not appear until it has. undefined/empty means nothing is hidden.
 *
 * Tracked by card identity rather than by "first N cards shown" on purpose.
 * Playing a move is not blocked by an animation elsewhere — a player can act
 * on an already-visible card while one of their own cards is still mid-air
 * from the previous round's refill — and that play splices the array,
 * shifting everything after it left. An index-based cap would let the still-
 * hidden card slide into a now-shorter "revealed" prefix and appear early.
 * An identity-based set is immune to that: removing an unrelated card from
 * the array never changes which specific cards are still marked hidden.
 */
let hidden = [];
let revealTimers = [];

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
  setSoundActive(true);

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
  setSoundActive(false);
  if (unwatch) unwatch();
  reset();
}

function reset() {
  if (unwatch) unwatch();
  unwatch = null;
  clearTimeout(resultTimer);
  resultTimer = null;
  dealTimers.forEach(clearTimeout);
  dealTimers = [];
  dealing = false;
  dealPlayed = false;
  announcedThrough = 0;
  revealTimers.forEach(clearTimeout);
  revealTimers = [];
  hidden = [];
  clearEffects();
  game = null;
  confirmed = null;
  pending = [];
  state = null;
  mySeat = null;
  selected = null;
  sending = false;
  settling = false;
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
 * render immediately. Effects animate clones, so rendering does not wait —
 * except for a hand a card is actively flying toward, which is held back by
 * `revealed` until the animation lands (see runEffects and release()).
 */
function present(previous, next) {
  // A position at version 0 is a table that has just been dealt.
  const opening = Boolean(next) && next.version === 0 && !next.finished && !dealPlayed;

  if (opening) {
    dealPlayed = true;
    dealing = true;
    announcedThrough = next.log.length; // the deal itself needs no reaction
  } else {
    const events = takeNewEvents(next);
    if (previous && next && events.length) runEffects(previous, next, events);
  }

  state = next;
  render();
  if (opening) startDeal();
}

/**
 * Log entries not yet reacted to. Consuming them advances `announcedThrough`
 * immediately, so calling this twice for the same data returns nothing the
 * second time — that is what makes sound and animation idempotent.
 */
function takeNewEvents(next) {
  if (!next?.log || next.log.length <= announcedThrough) return [];
  const events = next.log.slice(announcedThrough);
  announcedThrough = next.log.length;
  return events;
}

/**
 * Deal the opening hands one card at a time.
 *
 * Each card appears in its hand at the moment it lands, not before, so the deal
 * reads as cards arriving rather than as decoration over a table that already
 * has everything on it.
 */
function startDeal() {
  playSound('start');
  // Everyone's whole opening hand starts hidden; each card's own timer below
  // reveals it — by identity, in deal order — as its clone lands.
  hidden = state.hands.map((hand) => new Set(hand.map(cardId)));

  requestAnimationFrame(() => {
    if (!state) return;

    const order = [];
    for (let i = 0; i < state.playerCount; i++) order.push((mySeat + i) % state.playerCount);
    const targets = order.map((seat) => (seat === mySeat ? $('#my-hand') : seatPanel(seat)));

    const total = flyDeal($('#deck-pile'), targets, HAND_SIZE, {
      gap: DEAL_GAP_MS,
      flight: DEAL_FLIGHT_MS,
    });

    if (!total) {          // reduced motion, or nothing measurable to fly from
      hidden = [];
      dealing = false;
      render();
      return;
    }

    // hands[seat][round] is exactly the card dealt to that seat in that round
    // — newGame() deals one card per seat per round, in this same order.
    let index = 0;
    for (let round = 0; round < HAND_SIZE; round++) {
      for (const seat of order) {
        const id = cardId(state.hands[seat][round]);
        const at = index * DEAL_GAP_MS + DEAL_FLIGHT_MS;
        dealTimers.push(setTimeout(() => {
          hidden[seat]?.delete(id);
          render();
        }, at));
        index++;
      }
    }

    dealTimers.push(setTimeout(() => {
      hidden = [];
      dealing = false;
      render();
    }, total + 60));
  });
}

/* ------------------------------------------------------------------ */
/* effects                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hide the specific cards a seat just gained until their flight lands.
 *
 * The new cards are exactly the tail of `nextHand` beyond `previousHand`'s
 * length: a gain transition (taking the table, or refilling from the stock)
 * only ever appends, so this slice is reliable at the moment the transition
 * is detected, before anything else has a chance to touch the array.
 */
function holdBack(seat, previousHand, nextHand) {
  const arriving = nextHand.slice(previousHand.length);
  if (arriving.length === 0) return;
  if (!hidden[seat]) hidden[seat] = new Set();
  for (const card of arriving) hidden[seat].add(cardId(card));
}

/** Let a seat's hand show everything actually in it again. */
function release(seat) {
  hidden[seat] = undefined;
  render();
}

function runEffects(previous, next, events) {
  const ending = events.find((e) => e.t === 'beaten' || e.t === 'taken');
  const declaring = events.find((e) => e.t === 'take');

  if (events.some((e) => e.t === 'attack' || e.t === 'defend')) playSound('play');

  // "I'll take these" is a distinct moment from the table actually being
  // gathered up later, which is why it gets its own clip rather than reusing
  // the gather sound that plays once the round closes.
  if (declaring) playSound('takeDeclared');

  // How long the table-clear animation actually runs, if one is playing —
  // computed once here so both the reveal timer below and the draw delay
  // further down agree with each other and with fx.js, instead of each
  // guessing its own number.
  let tableClearMs = 0;

  if (ending) {
    const collected = ending.t === 'taken';
    const target = collected
      ? (ending.seat === mySeat ? $('#my-hand') : seatPanel(ending.seat))
      : $('#discard');

    if (collected) holdBack(ending.seat, previous.hands[ending.seat], next.hands[ending.seat]);

    const slots = [...document.querySelectorAll('#slots .slot')];
    flyTableAway(slots, target, { collected });
    playSound('gather');

    if (!reducedMotion()) {
      const duration = collected ? TABLE_CLEAR_MS.collected : TABLE_CLEAR_MS.discarded;
      tableClearMs = TABLE_CLEAR_STAGGER_MS * Math.max(slots.length - 1, 0) + duration;
    }

    if (collected) {
      if (tableClearMs > 0) revealTimers.push(setTimeout(() => release(ending.seat), tableClearMs));
      else release(ending.seat); // reduced motion: no flight to wait for
    }
  }

  // Hands refilling from the stock: draw as many cards as each seat gained.
  // The seat that just took the table is excluded here even if it also drew —
  // their whole gain that round is already accounted for by the pickup above,
  // and giving them a second, unrelated "drawing from the stock" animation on
  // top of it is exactly the double-counted look this guards against.
  const drawn = previous.deck.length - next.deck.length;
  if (drawn > 0) {
    const stock = $('#deck-pile');
    // Let the table finish clearing first, so the two kinds of flight do not
    // visually overlap.
    const start = tableClearMs;

    for (let seat = 0; seat < next.playerCount; seat++) {
      if (ending?.t === 'taken' && ending.seat === seat) continue;
      const gained = next.hands[seat].length - previous.hands[seat].length;
      if (gained <= 0) continue;

      holdBack(seat, previous.hands[seat], next.hands[seat]);
      const target = seat === mySeat ? $('#my-hand') : seatPanel(seat);

      if (reducedMotion()) {
        release(seat);
        continue;
      }
      setTimeout(() => flyDraw(stock, target, gained), start);
      const landsAt = start + DRAW_STAGGER_MS * Math.max(gained - 1, 0) + DRAW_FLIGHT_MS;
      revealTimers.push(setTimeout(() => release(seat), landsAt));
    }
  }
}

const seatPanel = (seat) => document.querySelector(`.player[data-seat="${seat}"]`);

/** What a seat's hand should currently show: everything not still mid-flight. */
function shownHand(seat) {
  const hand = state.hands[seat];
  const hideSet = hidden[seat];
  if (!hideSet || hideSet.size === 0) return hand;
  return hand.filter((card) => !hideSet.has(cardId(card)));
}

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
  if (!over || resultShown || resultTimer || settling) return;

  // Set synchronously, before any await below. The two awaits here yield
  // control back to the event loop, and this function can genuinely be
  // called again in that window — the drain loop's own cleanup and a
  // realtime echo of the same winning move both call it within milliseconds
  // of each other. Without a flag set before either await, a second call
  // would see resultTimer still unset and play the win/loss sound a second
  // time on top of the first.
  settling = true;

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
    const count = shownHand(seat).length;
    for (let i = 0; i < Math.min(count, 10); i++) fan.append(cardEl(null, { faceDown: true }));

    const tally = document.createElement('span');
    tally.className = 'player__count';
    tally.textContent = dealing && count === 0 ? '' : count === 1 ? '1 card' : `${count} cards`;

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

  const live = !dealing && !state.finished && !state.out[mySeat];
  const attacks = live ? legalAttacks(state, mySeat) : [];
  const defending = live && mySeat === state.defender && !state.taking;

  // Only the cards that have actually landed — during the opening deal, or
  // while a just-drawn or just-taken card is still mid-flight. Each newly
  // revealed card drops straight into its sorted place as it lands, rather
  // than the hand reshuffling itself all at once.
  const hand = [...shownHand(mySeat)].sort(byTrumpThenRank);

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

const PROMPT_TONES = ['is-dealing', 'is-waiting', 'is-attacking', 'is-defending', 'is-throwing', 'is-over'];

function renderPrompt() {
  const el = $('#prompt');
  setText(el, dealing ? 'Dealing…' : describe(state, mySeat));
  el.classList.remove(...PROMPT_TONES);
  el.classList.add(promptTone());
}

/** Which of the prompt's looks fits what the table currently wants. */
function promptTone() {
  if (dealing) return 'is-dealing';
  if (state.finished) return 'is-over';
  if (!canAct(state, mySeat)) return 'is-waiting';
  if (mySeat === state.defender) return 'is-defending';
  if (mySeat === state.attacker && state.table.length === 0) return 'is-attacking';
  return 'is-throwing';
}

function renderActions() {
  const live = !dealing && !state.finished && !state.out[mySeat];

  const defending = live && mySeat === state.defender && state.table.length > 0 && !state.taking;
  const takeable = canTake(state, mySeat);
  const take = $('#act-take');
  show(take, defending);
  take.disabled = !takeable;
  take.classList.toggle('btn--spent', defending && !takeable);
  take.classList.toggle('btn--danger', takeable);
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
