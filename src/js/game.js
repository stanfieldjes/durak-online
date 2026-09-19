import {
  applyMove,
  legalAttacks,
  legalDefenses,
  canPass,
  canTake,
  canAct,
  canClear,
  openSlots,
  isQuickClear,
  describe,
  roleOf,
  sameCard,
  cardId,
  rankValue,
  newGame,
  ranksFor,
  makeRng,
  HAND_SIZE,
  MIN_PLAYERS,
  SUITS,
  SUIT_GLYPH,
  SUIT_NAME,
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
  getGameVersion,
  isStaleError,
  isTooEarlyError,
} from './db.js';
import { readableError } from './supabase.js';
import { session, scoreOf } from './auth.js';
import { formatScore } from './score.js';
import {
  fly,
  boxOf,
  clearEffects,
  reducedMotion,
  FLIGHT_MS,
  SETTLE_MS,
  CLEAR_GAP_MS,
  DRAW_GAP_MS,
  DEAL_GAP_MS,
  DEAL_TOTAL_MS,
} from './fx.js';
import { play as playSound, getVolume, setVolume, setSoundActive } from './sound.js';
import { initTableSize, tableShown, tableHidden } from './tablesize.js';
import { $, show, setText, clear, toast, cardEl, paintScore } from './ui.js';

/**
 * How long a finished round stays on the table before it clears itself.
 *
 * Two delays. The long one is for a beaten table that could still take more
 * cards: attackers can throw in while it shows. The short one is for a table
 * that cannot (six down, or a defender with nothing left to answer with),
 * where the pause is only a look at the cards.
 *
 * Both live on the games row (clear_delay_ms, quick_clear_delay_ms), and
 * submit_move() refuses a clear that comes sooner, so a stale or modified page
 * cannot cut them short. The fallbacks are only used before the migration.
 */
const FALLBACK_CLEAR_DELAY_MS = 10000;
const FALLBACK_QUICK_CLEAR_DELAY_MS = 2500;
const clearDelayMs = (position) =>
  position && isQuickClear(position)
    ? Number(game?.quick_clear_delay_ms ?? FALLBACK_QUICK_CLEAR_DELAY_MS)
    : Number(game?.clear_delay_ms ?? FALLBACK_CLEAR_DELAY_MS);

/** How long the finished table stays on screen before the scores appear. */
const RESULT_DELAY_MS = 2200;

/**
 * How often an open, visible table double-checks it has not missed a move.
 * Realtime normally makes this redundant; it is the safety net for a socket
 * that has died without saying so, which a sleeping laptop or a phone that
 * backgrounded the browser can both produce.
 */
const CHECK_IN_MS = 15000;

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
let spectating = false; // watching a game we are not seated at
let dealing = false;    // opening hands still flying out
let dealPlayed = false; // only deal once per visit to a table

let watchGen = 0;       // bumps on every (re)subscribe, so stale channel callbacks are ignored
let live = false;       // the current channel has confirmed SUBSCRIBED
let resyncing = false;
let resyncAgain = false;
let checkingIn = false;
let checkInTimer = null;
let closing = false;    // this browser asked to close or leave the table
let clearTimer = null;
let clearArmedFor = null; // the confirmed version the clear countdown belongs to
let promptBarFor = null;  // the version the prompt's countdown bar was started for

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
 * Cards whose on-screen copy is still travelling, by card id.
 *
 * The state always renders straight away; these sets only decide how a card
 * looks while its copy is in the air. Tracked by identity, never by position
 * in a hand, because hands re-sort and shrink under a card that is mid-flight.
 *
 *   landing     not shown in its new place until its copy lands: left out of
 *               a hand entirely (the hand makes room when it arrives), or held
 *               invisible in its slot on the table
 *   departing   drawn in the state, but still counted in the stock until its
 *               copy leaves (so the pile, and the trump under it, empty card
 *               by card rather than all at once)
 *   discarding  beaten in the state, but not yet counted on the beaten pile
 *   dealt       the opening deal's cards that have not landed yet
 */
const landing = new Set();
const departing = new Set();
const discarding = new Set();
const dealt = new Set();
let quietPartsQueued = false;

/** Most cards in one row of a hand; the rest wrap onto further rows. */
const ROW_SIZE = 6;
/**
 * How many opponents sit across the top of the table. On a big table the rest
 * carry on down the right-hand side, in seat order, so the row reads round
 * the table from your left.
 */
const TOP_ROW_SEATS = 4;

export function initGame() {
  initTableSize($('#felt'), $('#table-grip'));
  $('#act-take').addEventListener('click', () => play({ type: 'take' }));
  $('#act-pass').addEventListener('click', () => play({ type: 'pass' }));
  $('#act-leave').addEventListener('click', onLeave);
  $('#waiting-leave').addEventListener('click', onLeaveWaiting);
  $('#copy-link').addEventListener('click', onCopyLink);
  $('#start-now').addEventListener('click', onStartNow);
  $('#result-again').addEventListener('click', () => { location.hash = '#/'; });

  const slider = $('#act-volume');
  const icon = $('#volume-icon');
  const paintVolume = () => {
    const level = getVolume();
    slider.value = String(Math.round(level * 100));
    // The track fills up to the handle, which needs the current value as a
    // percentage since CSS cannot read an input's value on its own.
    slider.style.setProperty('--fill', `${Math.round(level * 100)}%`);
    icon.textContent = level === 0 ? '\u2715' : '\u266A';
    icon.classList.toggle('is-silent', level === 0);
  };
  slider.addEventListener('input', () => {
    setVolume(Number(slider.value) / 100);
    paintVolume();
  });
  // A card sound on release gives an immediate sense of the new level.
  slider.addEventListener('change', () => playSound('play'));
  paintVolume();
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
  if (game.status === 'abandoned') {
    toast('That table was closed.');
    location.hash = '#/';
    return;
  }
  if (mySeat === null) {
    // Not our game: a table already being played is one we can watch.
    if (game.status === 'active') {
      spectating = true;
      toast('Watching. Every hand is face up.');
    } else if (game.status !== 'waiting') {
      toast('That game has already finished.');
      location.hash = '#/';
      return;
    }
  }

  if (mySeat === null && !spectating) {
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

  adopt(game.state);
  startWatching(gameId);

  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('focus', onWake);
  window.addEventListener('online', onWake);
  checkInTimer = setInterval(() => checkIn(), CHECK_IN_MS);

  await maybeSettle();
}

/* ------------------------------------------------------------------ */
/* staying in sync                                                     */
/* ------------------------------------------------------------------ */

/**
 * Subscribe to the table, replacing any previous subscription.
 *
 * Every SUBSCRIBED — the first one, and each automatic rejoin after the
 * connection dropped — triggers a full re-read. Realtime does not replay what
 * happened while it was disconnected, and even the first subscribe leaves a
 * gap between enterGame's getGame() and the channel going live.
 */
function startWatching(gameId) {
  if (unwatch) unwatch();
  live = false;
  const gen = ++watchGen;

  unwatch = watchGame(
    gameId,
    async (event) => {
      if (gen !== watchGen || !game) return;
      if (event.kind === 'seats') {
        const fresh = await getGame(gameId).catch(() => null);
        if (gen !== watchGen || !game || !fresh) return;
        game = isOlder(fresh) ? { ...game, players: fresh.players } : fresh;
      } else {
        if (isOlder(event.row)) return; // arrived after something newer
        game = mergeRow(game, event.row);
      }
      if (mySeat === null) mySeat = seatOf(session.user.id);
      adopt(game.state);
      await maybeSettle();
    },
    (status, err) => {
      if (gen !== watchGen) return;
      if (status === 'SUBSCRIBED') {
        live = true;
        resync();
      } else {
        // CHANNEL_ERROR and TIMED_OUT are retried by the library on its own;
        // onWake() starts over if it is still down when the player looks again.
        live = false;
        if (err) console.warn('Realtime:', status, err);
      }
    }
  );
}

/** The tab came back into view, the window got focus, or the network returned. */
function onWake() {
  if (document.visibilityState !== 'visible' || !game) return;
  checkIn({ rewatch: true });
}

/**
 * Ask the database whether the table has moved on without us, and catch up
 * if it has. Cheap: one row, two columns.
 */
async function checkIn({ rewatch = false } = {}) {
  if (!game || checkingIn || document.visibilityState !== 'visible') return;

  if (!live && rewatch) {
    startWatching(game.id); // its SUBSCRIBED will resync
    return;
  }
  if (sending) return; // our own write is about to report back anyway

  checkingIn = true;
  const id = game.id;
  try {
    const head = await getGameVersion(id);
    if (!head || !game || game.id !== id) return;
    const ours = confirmed?.version ?? game.version ?? 0;
    // Seats filling does not move the version, so a waiting table always re-reads.
    const moved = head.version !== ours || head.status !== game.status;
    if (moved || game.status === 'waiting') await resync();
  } catch {
    /* offline; the next wake or check-in tries again */
  } finally {
    checkingIn = false;
  }
}

/**
 * Re-read the whole table and adopt it.
 *
 * If more than one move was missed, the position is swapped in without sound
 * or animation: the effects are written to explain a single step, and
 * replaying a dozen of them at once after someone returns to the tab would
 * be noise rather than information.
 */
async function resync() {
  if (!game) return;
  if (resyncing) {
    resyncAgain = true;
    return;
  }
  resyncing = true;
  const gen = watchGen;
  const id = game.id;

  try {
    do {
      resyncAgain = false;
      const fresh = await getGame(id).catch(() => null);
      if (gen !== watchGen || !game || game.id !== id || !fresh) return;

      if (isOlder(fresh)) {
        game = { ...game, players: fresh.players };
        continue;
      }

      const before = confirmed?.version;
      game = fresh;
      if (mySeat === null) mySeat = seatOf(session.user.id);
      const jumped = before !== undefined && fresh.state && fresh.state.version > before + 1;
      adopt(fresh.state, { quiet: jumped });
      await maybeSettle();
    } while (resyncAgain);
  } finally {
    resyncing = false;
  }

  drain(); // anything queued while we were out of touch
}

/** True when a row from the server is behind the one we already hold. */
function isOlder(row) {
  return Boolean(game && row && typeof row.version === 'number' && row.version < (game.version ?? 0));
}

export function leaveGame() {
  setSoundActive(false);
  if (unwatch) unwatch();
  reset();
}

function reset() {
  if (unwatch) unwatch();
  unwatch = null;
  watchGen++;
  closing = false;
  live = false;
  resyncing = false;
  resyncAgain = false;
  checkingIn = false;
  clearInterval(checkInTimer);
  checkInTimer = null;
  document.removeEventListener('visibilitychange', onWake);
  window.removeEventListener('focus', onWake);
  window.removeEventListener('online', onWake);
  clearTimeout(resultTimer);
  resultTimer = null;
  cancelClear();
  promptBarFor = null;
  stopMotion();
  tableHidden();
  spectating = false;
  dealPlayed = false;
  announcedThrough = 0;
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

/**
 * Take a new server position, replay anything still in flight, and draw it.
 *
 * Positions older than the one already confirmed are ignored. Our own RPC
 * response, its realtime echo, and a resync read can arrive in any order,
 * and none of them should be able to wind the table backwards.
 */
function adopt(serverState, { quiet = false } = {}) {
  if (confirmed && serverState && serverState.version < confirmed.version) return;
  const previous = state;
  confirmed = serverState;
  const next = rebuild();
  present(previous, next, { quiet });
}

/** Apply locally without waiting for anything. */
function advanceLocally(move) {
  const previous = state;
  const next = applyMove(state, mySeat, move);
  pending.push(move);
  present(previous, next);
}

/**
 * Show a new position.
 *
 * Card movement is worked out from the two positions, not from the log: every
 * card that is somewhere else now than it was on screen a moment ago flies
 * from the old place to the new one. That makes it impossible for the
 * animation to disagree with the state — a beaten table can only fly to the
 * beaten pile, because that is where the state says the cards went.
 *
 * The movement is planned before rendering (its starting points are elements
 * about to be replaced) and launched after (its destinations are elements the
 * render creates). Nothing waits on it: the new position is live at once.
 */
function present(previous, next, { quiet = false } = {}) {
  // A dropped local move can leave the log shorter than what we already
  // reacted to. Wind the marker back, or the real version of those events
  // (say, the table clearing a second later) would arrive silently.
  if (next?.log && next.log.length < announcedThrough) announcedThrough = next.log.length;

  // A position at version 0 is a table that has just been dealt.
  const opening = !quiet && Boolean(next) && next.version === 0 && !next.finished && !dealPlayed;

  let flights = [];
  if (quiet) {
    // Catching up after a gap: mark everything as already announced, and
    // settle every card where it is rather than replaying a dozen moves.
    dealPlayed = true;
    stopMotion();
    if (next?.log) announcedThrough = next.log.length;
  } else if (opening) {
    dealPlayed = true;
    announcedThrough = next.log.length; // the deal itself needs no reaction
    flights = planDeal(next);
    dealing = flights.length > 0;
    playSound('start');
  } else {
    const events = takeNewEvents(next);
    if (events.length) playEventSounds(events);
    if (previous && next) flights = planMoves(previous, next);
  }

  state = next;
  render();
  for (const flight of flights) fly(flight);
}

/**
 * Log entries not yet reacted to. Consuming them advances `announcedThrough`
 * immediately, so calling this twice for the same data returns nothing the
 * second time — that is what keeps sounds from repeating.
 */
function takeNewEvents(next) {
  if (!next?.log || next.log.length <= announcedThrough) return [];
  const events = next.log.slice(announcedThrough);
  announcedThrough = next.log.length;
  return events;
}

/**
 * Sounds for moments rather than cards. A card landing on the table plays its
 * own sound as it arrives (see planMoves), so the click lines up with the card.
 */
function playEventSounds(events) {
  // "I'll take these" is a distinct moment from the table actually being
  // gathered up later, which is why it gets its own clip.
  if (events.some((e) => e.t === 'take')) playSound('takeDeclared');
  if (events.some((e) => e.t === 'beaten' || e.t === 'taken')) playSound('gather');
}

/* ------------------------------------------------------------------ */
/* card movement                                                       */
/* ------------------------------------------------------------------ */

/** Throw away every flight in progress and show every card where it is. */
function stopMotion() {
  clearEffects();
  landing.clear();
  departing.clear();
  discarding.clear();
  dealt.clear();
  dealing = false;
}

/** Where every card is: in the stock, a seat's hand, or on the table. Missing means beaten. */
function whereCards(s) {
  const at = new Map();
  for (const card of s.deck) at.set(cardId(card), { in: 'stock', card });
  s.hands.forEach((hand, seat) => {
    for (const card of hand) at.set(cardId(card), { in: 'hand', seat, card });
  });
  for (const slot of s.table) {
    at.set(cardId(slot.atk), { in: 'table', card: slot.atk });
    if (slot.def) at.set(cardId(slot.def), { in: 'table', card: slot.def });
  }
  return at;
}

/**
 * Work out which cards moved between two positions and how each should fly.
 *
 * The only journeys a card makes in Durak are stock to hand, hand to table,
 * and table to a hand or the beaten pile, and those are the only ones drawn.
 * Anything else (there should be nothing else) simply appears in place.
 *
 * Order on screen: plays go at once; a clearing table goes next, card by card;
 * refills follow once the table is empty, dealt in the engine's own order —
 * attackers first, the defender last.
 */
function planMoves(previous, next) {
  if (previous.playerCount !== next.playerCount || previous.seed !== next.seed) return [];

  const before = whereCards(previous);
  const after = whereCards(next);
  const plays = [];
  const leaving = [];
  const drawn = new Set();

  for (const [id, was] of before) {
    const now = after.get(id) ?? { in: 'discard', card: was.card };
    if (was.in === now.in && was.seat === now.seat) continue;

    if (was.in === 'hand' && now.in === 'table') plays.push({ id, card: now.card, seat: was.seat });
    else if (was.in === 'table' && now.in !== 'stock') leaving.push({ id, card: was.card, to: now });
    else if (was.in === 'stock' && now.in === 'hand') drawn.add(id);
  }

  if (reducedMotion()) {
    if (plays.length) playSound('play');
    return [];
  }

  const flights = [];
  const trump = next.trump;

  for (const { id, card, seat } of plays) {
    const mine = seat === mySeat;
    markArriving(id);
    flights.push({
      key: id,
      from: mine ? boxOf(handCardEl(id)) : opponentHandBox(seat),
      to: () => boxOf(tableCardEl(id)),
      face: cardEl(card, { trump }),
      flip: mine ? null : 'up',
      duration: FLIGHT_MS.play,
      lift: 18,
      onLand: (box) => {
        landed(id, box);
        playSound('play');
      },
    });
  }

  let tableEmptyAt = 0;
  leaving.forEach(({ id, card, to }, i) => {
    const delay = i * CLEAR_GAP_MS;
    const toMe = to.in === 'hand' && to.seat === mySeat;
    const duration = to.in === 'hand' ? FLIGHT_MS.collect : FLIGHT_MS.discard;
    tableEmptyAt = Math.max(tableEmptyAt, delay + duration);

    if (to.in === 'hand') markArriving(id);
    else discarding.add(id);

    flights.push({
      key: id,
      from: boxOf(tableCardEl(id)),
      to: to.in === 'hand' ? handTarget(to.seat) : () => boxOf($('#discard .pile')),
      face: cardEl(card, { trump }),
      flip: toMe ? null : 'down',
      duration,
      delay,
      lift: 10,
      onLand: (box) => landed(id, box),
    });
  });

  // Refill in the engine's order, each seat's new cards in the order drawn.
  let k = 0;
  const pause = tableEmptyAt > 0 ? tableEmptyAt + 80 : 0;
  for (const seat of refillOrder(previous)) {
    for (const card of next.hands[seat]) {
      const id = cardId(card);
      if (!drawn.has(id)) continue;
      flights.push(drawFlight(card, seat, previous.trumpCard, pause + k * DRAW_GAP_MS));
      k++;
    }
  }

  return flights;
}

/** The opening deal: one card at a time, round by round, starting with you. */
function planDeal(next) {
  if (reducedMotion()) return [];
  // Dealt round by round starting with you, or from seat 0 when watching.
  const first = spectating ? 0 : mySeat;
  const order = [];
  for (let i = 0; i < next.playerCount; i++) order.push((first + i) % next.playerCount);

  const flights = [];
  let k = 0;
  // A big table deals four dozen cards, so the gap between them closes up to
  // keep the whole deal about as long as a small table's.
  const cards = next.playerCount * HAND_SIZE;
  const gap = Math.min(DEAL_GAP_MS, Math.round(DEAL_TOTAL_MS / cards));
  // hands[seat][round] is exactly the card dealt to that seat in that round
  // — newGame() deals one card per seat per round.
  for (let round = 0; round < HAND_SIZE; round++) {
    for (const seat of order) {
      const card = next.hands[seat][round];
      if (!card) continue;
      dealt.add(cardId(card));
      flights.push(drawFlight(card, seat, next.trumpCard, k * gap));
      k++;
    }
  }
  return flights;
}

/** A card leaving the stock for a hand. It stays counted in the stock until it leaves. */
function drawFlight(card, seat, trumpCard, delay) {
  const id = cardId(card);
  const mine = seat === mySeat;
  // The very last card drawn is the trump lying face up across the bottom of
  // the stock, so it leaves from there, already showing, and turns upright.
  const isTrump = sameCard(card, trumpCard);
  markArriving(id);
  departing.add(id);

  return {
    key: id,
    from: () => (isTrump && boxOf($('#trump-card .card'))) || stockTopBox(),
    to: handTarget(seat),
    face: mine || isTrump ? cardEl(card, { trump: state?.trump ?? trumpCard.s }) : null,
    flip: isTrump ? (mine ? null : 'down') : mine ? 'up' : null,
    duration: FLIGHT_MS.draw,
    delay,
    lift: 12,
    onLaunch: () => {
      departing.delete(id);
      refreshQuietParts();
    },
    onLand: (box) => landed(id, box),
    onCancel: () => {
      departing.delete(id);
      dealt.delete(id);
      refreshQuietParts();
    },
  };
}

/** Mark a card as on its way, so it is not shown in its new place until it lands. */
function markArriving(id) {
  landing.add(id);
}

/**
 * A card's copy has arrived at `box`. On the table, the real card is already
 * in its slot and is simply revealed. In your hand it is added now, sliding
 * from where its copy landed into its sorted place while the others move over
 * to make room.
 */
function landed(id, box) {
  landing.delete(id);
  discarding.delete(id);
  for (const el of document.querySelectorAll(`[data-card="${id}"].is-landing`)) {
    el.classList.remove('is-landing');
  }

  const finishedDeal = dealt.delete(id) && dealing && dealt.size === 0;
  if (finishedDeal) dealing = false;

  const inMyHand = Boolean(state?.hands[mySeat]?.some((card) => cardId(card) === id));
  if (state && (inMyHand || finishedDeal)) {
    renderHand({ arrivals: inMyHand && box ? new Map([[id, box]]) : null });
  }
  if (finishedDeal) {
    renderPrompt();
    renderActions();
  }
  refreshQuietParts();
}

/**
 * Redraw the parts of the table that only count cards — opponents' fans, the
 * stock, the beaten pile — without touching your own hand, so a card landing
 * elsewhere can never swallow a click on one of yours. Batched to once per
 * frame, and still ahead of that frame's paint.
 */
function refreshQuietParts() {
  if (quietPartsQueued) return;
  quietPartsQueued = true;
  queueMicrotask(() => {
    quietPartsQueued = false;
    if (!state || !game || game.status === 'waiting') return;
    renderOpponents();
    renderStock();
  });
}

/** Attacker first, then the other attackers in order, defender last — as refill() does. */
function refillOrder(s) {
  const order = [];
  for (let i = 0; i < s.playerCount; i++) {
    const seat = (s.attacker + i) % s.playerCount;
    if (seat !== s.defender) order.push(seat);
  }
  order.push(s.defender);
  return order;
}

const seatPanel = (seat) => document.querySelector(`.player[data-seat="${seat}"]`);
const handCardEl = (id) => document.querySelector(`#my-hand [data-card="${id}"]`);
const tableCardEl = (id) => document.querySelector(`#slots [data-card="${id}"]`);

/**
 * The middle of a fan, sized as one of its cards. Arrivals aim here rather
 * than at a particular spot: where a card goes in an opponent's hand is not
 * something the rest of the table gets to see, and in your own hand the card
 * finds its place once it has arrived.
 */
function fanCentreBox(fan) {
  if (!fan || !fan.isConnected) return null;
  const rect = fan.getBoundingClientRect();
  const style = getComputedStyle(fan);
  const w = parseFloat(style.minWidth);
  const h = parseFloat(style.minHeight);
  if (!w || !h) return null;
  return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, w, h, angle: 0 };
}

/** Where cards arriving in a seat's hand head for, looked up afresh each frame. */
function handTarget(seat) {
  if (seat === mySeat) return () => fanCentreBox($('#my-hand'));
  return () => opponentHandBox(seat);
}

/**
 * The middle of an opponent's hand: where their cards arrive and leave from.
 * The whole block of rows, not one row, so a card flies to the middle of the
 * hand however many rows it has grown to.
 */
function opponentHandBox(seat) {
  const panel = seatPanel(seat);
  return fanCentreBox(panel?.querySelector('.hand-rows')) ?? boxOf(panel);
}

/** The card on top of the stock, which is the one that gets drawn. */
function stockTopBox() {
  return boxOf($('#deck-pile')?.lastElementChild) ?? boxOf($('#trump-card .card')) ?? boxOf($('#stock'));
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
  if (!state || state.finished || spectating) return;
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
/**
 * Queued card moves (attack, defend, take). A Done or the automatic clear
 * that gets dropped because the table cleared anyway is not worth a message.
 */
const playerMoves = () => pending.filter((m) => m.type !== 'clear' && m.type !== 'pass').length;

/* ------------------------------------------------------------------ */
/* clearing a finished round                                           */
/* ------------------------------------------------------------------ */

/**
 * Start (or keep) the countdown to clearing the table.
 *
 * Every browser at the table runs this, and every one whose seat is still in
 * the game submits the clear when its timer runs out. Whichever lands first
 * wins; the rest fail the version check and quietly drop theirs. Throwing in
 * a card, or anyone else's clear arriving, changes the version and cancels
 * the countdown.
 */
function scheduleClear() {
  const s = confirmed;
  if (!s || !canClear(s)) {
    cancelClear();
    return;
  }
  if (clearArmedFor === s.version) return;

  cancelClear();
  clearArmedFor = s.version;
  if (mySeat !== null && canClear(s, mySeat)) {
    clearTimer = setTimeout(fireClear, clearDelayMs(s));
  }
}

function cancelClear() {
  clearTimeout(clearTimer);
  clearTimer = null;
  clearArmedFor = null;
}

function fireClear() {
  clearTimer = null;
  if (!confirmed || confirmed.version !== clearArmedFor || !canClear(confirmed, mySeat)) return;

  // One of our own moves is still on its way. It will change the version if
  // it lands; check back shortly in case it gets dropped instead.
  if (pending.length > 0) {
    clearTimer = setTimeout(fireClear, 400);
    return;
  }

  try {
    advanceLocally({ type: 'clear' });
  } catch {
    return;
  }
  drain();
}

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
        // By identity, not shift(): if the realtime echo of this very move
        // landed first, rebuild() has already dropped it from the queue, and
        // shift() would throw away the *next* move without ever sending it.
        const sent = pending.indexOf(move);
        if (sent !== -1) pending.splice(sent, 1);
        if (!confirmed || row.state.version >= confirmed.version) confirmed = row.state;
        present(state, rebuild());
      } catch (error) {
        if (isTooEarlyError(error)) {
          // Our countdown finished before the database's did (a clock hiccup,
          // or a delay changed mid-round). Put the table back and try again
          // shortly; the version check still guarantees it clears only once.
          pending = pending.filter((m) => m.type !== 'clear');
          adopt(confirmed);
          clearTimeout(clearTimer);
          clearTimer = setTimeout(fireClear, 1000);
          continue;
        }
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
        const before = playerMoves();
        game = fresh;
        adopt(fresh.state);
        if (playerMoves() < before) {
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

  // A spectator has no seat, so no business writing the result. Whoever is
  // playing settles it; we just wait for the row to say so.
  if (!spectating && game.status !== 'finished' && state?.finished) {
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

/**
 * The host closes the table for everyone; anyone else just gets up.
 *
 * Guests find out through the status change arriving over realtime (or the
 * next check-in), and render() sends them back to the lobby.
 */
async function onLeaveWaiting() {
  if (!game || closing) return;
  const hosting = game.host_id === session.user.id;
  const guests = (game.players?.length ?? 1) - 1;

  if (hosting && guests > 0) {
    const who = guests === 1 ? 'The player' : `The ${guests} players`;
    if (!confirm(`Close this table? ${who} sitting here will be sent back to the lobby.`)) return;
  }

  closing = true;
  render();
  try {
    if (hosting) await abandonGame(game.id);
    else await leaveTable(game.id);
  } catch (error) {
    closing = false;
    render();
    toast(readableError(error)); // most likely the game started a moment ago
    return;
  }
  toast(hosting ? 'Table closed.' : 'You left the table.');
  location.hash = '#/';
}

/** Someone else closed the table we are sitting at. Back to the lobby. */
function tableClosed() {
  if (closing) return; // we closed it ourselves; onLeaveWaiting is handling it
  closing = true;
  toast(game.host_id === session.user.id ? 'This table was closed.' : 'The host closed this table.');
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
  if (game.status === 'abandoned') {
    tableClosed();
    return;
  }

  const waiting = game.status === 'waiting' || !state;
  show($('#waiting'), waiting);
  show($('#felt'), !waiting);
  if (waiting) {
    renderWaiting();
    return;
  }

  scheduleClear();
  renderOpponents();
  renderStock();
  renderSlots();
  // A spectator has no hand of their own and nothing to press.
  show($('#my-hand'), !spectating);
  show($('#act-take'), false);
  if (!spectating) renderHand();
  renderPrompt();
  renderActions();
  tableShown();
}

function renderWaiting() {
  const seated = game.players.length;
  const hosting = game.host_id === session.user.id;
  setText(
    $('#waiting-count'),
    hosting
      ? `${seated} of ${game.max_players} seated. Start whenever two or more are here, or the cards deal themselves when every seat fills.`
      : `${seated} of ${game.max_players} seated. The host can start once two are here, or the cards deal themselves when every seat fills.`
  );

  const leave = $('#waiting-leave');
  setText(leave, closing ? (hosting ? 'Closing…' : 'Leaving…') : hosting ? 'Close the table' : 'Leave the table');
  leave.disabled = closing;

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
      paintScore(rating, scoreOf(profile));
      li.append(name, rating);
    } else {
      li.textContent = 'Empty';
    }
    list.append(li);
  }

  renderDeckPreview(seated);

  show($('#start-now'), game.host_id === session.user.id && seated >= 2 && seated < game.max_players);
}

/**
 * The deck this table would play with, one card per rank it holds.
 *
 * The deck is cut to the table, so the row grows as people sit down: eights
 * up at two players, and a rank lower with every arrival, to the full pack at
 * eight. The suits are for show — a deck has all four of each rank — so they
 * are picked from the table's own seed, which keeps them from reshuffling
 * themselves every time the list redraws and shows everyone the same row.
 */
function renderDeckPreview(seated) {
  const players = Math.max(seated, MIN_PLAYERS);
  const ranks = ranksFor(players);

  const box = $('#deck-preview-cards');
  clear(box);
  const suitFor = makeRng(Number(game.seed) + players);
  for (const rank of ranks) {
    box.append(cardEl({ r: rank, s: SUITS[Math.floor(suitFor() * SUITS.length)] }));
  }

  const count = ranks.length * SUITS.length;
  setText(
    $('#deck-preview-note'),
    seated < MIN_PLAYERS
      ? `${count} cards, ${ranks[0]} up — one more rank for every player who sits down.`
      : `${count} cards, ${ranks[0]} up, six each and ${count - players * HAND_SIZE} in the stock.`
  );
}

function renderOpponents() {
  const top = $('#opponents');
  const rest = $('#opponents-side');
  clear(top);
  clear(rest);

  // Playing: everyone but you, starting with the player to your left.
  // Watching: every seat in its own order, since none of them is yours.
  const order = [];
  if (spectating) {
    for (let seat = 0; seat < state.playerCount; seat++) order.push(seat);
  } else {
    for (let i = 1; i < state.playerCount; i++) order.push((mySeat + i) % state.playerCount);
  }

  // Four across the top either way. The rest go down the right while you are
  // playing, because the bottom of the table is your own hand; while watching
  // there is no hand down there, so they line up along the bottom instead.
  const acrossTop = Math.min(order.length, TOP_ROW_SEATS);
  top.style.setProperty('--seats', String(Math.max(acrossTop, 1)));
  rest.style.setProperty('--seats', String(Math.max(acrossTop, 1)));
  const overflow = order.length > acrossTop;
  $('#felt').classList.toggle('felt--wrapped', overflow && !spectating);
  $('#felt').classList.toggle('felt--watching', spectating);
  rest.classList.toggle('opponents--side', !spectating);
  rest.classList.toggle('opponents--bottom', spectating);

  // Seats run clockwise around the table, the way play does, so the defender
  // is always the next seat round from the attacker on screen as well as in
  // the rules. Along the top that is simply left to right, and down the
  // right-hand side it is top to bottom — but the bottom row has to run back
  // the other way, right to left, to close the ring.
  order.forEach((seat, i) => {
    const panel = opponentPanel(seat);
    if (i < acrossTop) {
      top.append(panel);
      return;
    }
    if (spectating) {
      // Naming a column that comes before the last one sends grid's automatic
      // placement onto a new row, so the row has to be named as well or the
      // seats come out as a staircase instead of a line.
      panel.style.gridRow = '1';
      panel.style.gridColumn = String(acrossTop - (i - acrossTop));
    }
    rest.append(panel);
  });
}

/** One opponent's panel: who they are, what they are doing, and their cards. */
function opponentPanel(seat) {
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
  paintScore(rating, scoreOf(profile));

  const role = document.createElement('span');
  role.className = 'player__role';
  role.textContent = state.out[seat]
    ? 'out'
    : state.passed[seat] && seat !== state.defender
      ? 'done'
      : roleOf(state, seat);

  head.append(name, rating, role);

  // Only cards that have arrived count; one still in the air joins when it lands.
  const hand = state.hands[seat];
  const count = hand.length - hand.filter((card) => landing.has(cardId(card))).length;

  const tally = document.createElement('span');
  tally.className = 'player__count';
  tally.textContent = dealing && count === 0 ? '' : count === 1 ? '1 card' : `${count} cards`;

  panel.append(head, handRows(handIsOpen(seat) ? shownCards(seat) : count), tally);
  return panel;
}

/**
 * A hand laid out in rows of at most six cards, so a big hand grows downward
 * instead of running past the panel it sits in.
 *
 * Pass a number for face-down backs, or an array of cards to show them face
 * up (a spectator's view, and the durak's hand once the game is over).
 */
function handRows(cards) {
  const list = typeof cards === 'number'
    ? Array.from({ length: cards }, () => null)
    : cards;

  const box = document.createElement('div');
  box.className = 'hand-rows';

  // An empty hand still leaves one row's worth of space, so a panel does not
  // jump about as its last cards are played.
  for (let i = 0; i < Math.max(list.length, 1); i += ROW_SIZE) {
    const fan = document.createElement('div');
    fan.className = 'fan fan--opponent';
    for (const card of list.slice(i, i + ROW_SIZE)) {
      fan.append(card ? cardEl(card, { trump: state.trump }) : cardEl(null, { faceDown: true }));
    }
    box.append(fan);
  }
  return box;
}

/**
 * Whose cards are face up: everybody's while spectating, and the durak's from
 * the moment the game is decided, so the table sees what they were left
 * holding rather than a row of backs.
 */
function handIsOpen(seat) {
  if (spectating) return true;
  return Boolean(state?.finished) && state.durak === seat;
}

/** A seat's cards that have actually arrived, in the same order as your own hand. */
function shownCards(seat) {
  return state.hands[seat]
    .filter((card) => !landing.has(cardId(card)))
    .sort(byTrumpThenRank);
}

function renderStock() {
  // Cards already drawn stay here until they actually leave.
  const inStock = state.deck.length + departing.size;
  const trumpShowing = state.deck.length > 0 || departing.has(cardId(state.trumpCard));
  const backs = Math.max(0, inStock - (trumpShowing ? 1 : 0));

  const trumpBox = $('#trump-card');
  const trumpEl = trumpBox.firstElementChild;
  if (!trumpShowing) clear(trumpBox);
  else if (trumpEl?.dataset.card !== cardId(state.trumpCard)) {
    clear(trumpBox);
    trumpBox.append(cardEl(state.trumpCard, { trump: state.trump }));
  }

  // Drawing takes the top card, which is the last one in the stack.
  const pile = $('#deck-pile');
  while (pile.children.length > backs) pile.lastElementChild.remove();
  while (pile.children.length < backs) pile.append(cardEl(null, { faceDown: true }));
  [...pile.children].forEach((card, i) => {
    // 1 is the bottom card's place, 0 the top card's edge; the rest share the
    // distance between them evenly. A last single card stays where the bottom
    // card lies, on the trump.
    const along = backs > 1 ? 1 - i / (backs - 1) : 1;
    card.style.left = `calc(var(--card-w) * var(--stack-span) * ${along.toFixed(4)})`;
  });

  const stock = $('#stock');
  stock.title = inStock === 1 ? '1 card left' : `${inStock} cards left`;

  // Once the stock is gone, so is the trump card. An empty place shows the
  // trump suit instead, so it is never lost in the endgame.
  const empty = inStock === 0;
  const spot = $('#deck-empty');
  show(spot, empty);
  setText(spot, SUIT_GLYPH[state.trump]);
  spot.classList.toggle('is-red', state.trump === 'H' || state.trump === 'D');
  spot.title = `Trump: ${SUIT_NAME[state.trump]}`;

  // The beaten pile keeps its place from the start, so there is always
  // somewhere visible for a beaten table to go — and it counts cards as they
  // arrive, not before.
  const beaten = Math.max(0, state.discard - discarding.size);
  $('#discard .pile').dataset.empty = String(beaten === 0);
  setText($('#discard-count'), beaten === 0 ? '' : String(beaten));
}

function renderSlots() {
  const box = $('#slots');
  clear(box);

  state.table.forEach((slot, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'slot';
    const atk = cardEl(slot.atk, { trump: state.trump });
    atk.classList.toggle('is-landing', landing.has(cardId(slot.atk)));
    wrap.append(atk);

    if (slot.def) {
      const def = cardEl(slot.def, { trump: state.trump });
      def.classList.add('card--defence');
      def.classList.toggle('is-landing', landing.has(cardId(slot.def)));
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

function renderHand({ arrivals = null } = {}) {
  if (spectating) return; // no hand of our own to draw
  const box = $('#my-hand');
  const before = cardBoxes(box);
  clear(box);

  const live = !dealing && !state.finished && !state.out[mySeat];
  const attacks = live ? legalAttacks(state, mySeat) : [];
  const defending = live && mySeat === state.defender && !state.taking;

  // Only cards that have arrived. One still in the air is added when it lands,
  // and the hand makes room for it then (see landed()).
  const hand = state.hands[mySeat]
    .filter((card) => !landing.has(cardId(card)))
    .sort(byTrumpThenRank);

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

  settleHand(box, before, arrivals);
}

/** Where each card in a fan currently shows, by card id, as centre and width. */
function cardBoxes(fan) {
  const boxes = new Map();
  if (reducedMotion()) return boxes;
  for (const el of fan.children) {
    if (!el.dataset.card) continue;
    const r = el.getBoundingClientRect();
    boxes.set(el.dataset.card, { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width });
  }
  return boxes;
}

/**
 * Slide your cards from where they were to where they now are, so a card
 * leaving or arriving pushes the others aside instead of making them jump.
 * An arriving card starts from where its copy landed and grows into place.
 */
function settleHand(fan, before, arrivals) {
  if (reducedMotion() || (before.size === 0 && !arrivals)) return;
  for (const el of fan.children) {
    const id = el.dataset.card;
    const arrival = arrivals?.get(id);
    const from = arrival ?? before.get(id);
    if (!from) continue;

    const r = el.getBoundingClientRect();
    const dx = from.cx - (r.left + r.width / 2);
    let dy = from.cy - (r.top + r.height / 2);
    // A card lifted by hover or selection is not a move; only a change of row is.
    if (!arrival && Math.abs(dy) < 24) dy = 0;
    const scale = from.w && r.width ? from.w / r.width : 1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01) continue;

    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        { transform: 'translate(0, 0) scale(1)' },
      ],
      { duration: SETTLE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
    );
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
  setText(el, dealing ? 'Dealing…' : spectating ? watchingText() : describe(state, mySeat));
  el.classList.remove(...PROMPT_TONES);
  el.classList.add(promptTone());

  // A bar under the prompt runs down while a finished round is on show, so
  // attackers can see how long they have left to throw in.
  const counting = clearArmedFor !== null && Boolean(state) && canClear(state);
  if (counting && promptBarFor !== clearArmedFor) {
    el.classList.remove('is-clearing');
    void el.offsetWidth; // restart the animation for a new countdown
    el.style.setProperty('--clear-ms', `${clearDelayMs(confirmed)}ms`);
    promptBarFor = clearArmedFor;
  }
  if (!counting) promptBarFor = null;
  el.classList.toggle('is-clearing', counting);
}

/** What the table is doing, told from the stands rather than from a seat. */
function watchingText() {
  if (state.finished) {
    if (state.draw) return 'Draw. Nobody is the fool.';
    return `${nameAt(state.durak)} is the durak.`;
  }
  const defender = nameAt(state.defender);
  if (state.taking) return `${defender} is taking the cards.`;
  if (state.table.length === 0) return `${nameAt(state.attacker)} leads.`;
  if (openSlots(state) === 0) return `${defender} beat everything. The table clears in a moment.`;
  return `${defender} is defending.`;
}

/** Which of the prompt's looks fits what the table currently wants. */
function promptTone() {
  if (dealing) return 'is-dealing';
  if (state.finished) return 'is-over';
  if (spectating) return 'is-waiting';
  if (!canAct(state, mySeat)) return 'is-waiting';
  if (mySeat === state.defender) return 'is-defending';
  if (mySeat === state.attacker && state.table.length === 0) return 'is-attacking';
  return 'is-throwing';
}

function renderActions() {
  if (spectating) {
    show($('#act-take'), false);
    show($('#act-pass'), false);
    return;
  }
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

  const deltas = game.score_delta ?? {};
  const mine = deltas[session.user.id];
  const numeric = mine === undefined || mine === null ? null : Number(mine);

  // The position never reached an ending of its own, so somebody walked out.
  const conceded = !state?.finished && game.status === 'finished';

  // The position's own verdict comes first, because the row is only settled
  // once a player writes it: a spectator, who never writes anything, would
  // otherwise be told the game was a draw while the cards say otherwise.
  const decided = Boolean(state?.finished) && !conceded;
  const durakSeat = decided
    ? state.durak
    : (game.players ?? []).find((p) => p.player_id === game.durak_id)?.seat;
  const noDurak = decided ? state.draw || state.durak === null : !game.durak_id;
  const mySeatLost = decided ? state.durak === mySeat : game.durak_id === session.user.id;

  let title;
  if (conceded && game.durak_id && game.durak_id !== session.user.id) {
    title = `${nameAt(durakSeat)} left the game.`;
  } else if (noDurak) {
    title = 'Draw.';
  } else if (spectating) {
    title = `${nameAt(durakSeat)} is the durak.`;
  } else if (mySeatLost) {
    title = 'You are the durak.';
  } else {
    title = 'You got out.';
  }

  setText($('#result-title'), title);

  const figure = $('#result-elo');
  paintScore(figure, numeric);
  setText(figure, numeric === null ? '' : `${formatScore(numeric)} score`);

  const list = $('#result-table');
  clear(list);
  for (const seatRow of game.players ?? []) {
    const d = deltas[seatRow.player_id];
    const value = d === undefined || d === null ? null : Number(d);
    const settled = scoreOf(seatRow.profile);

    const li = document.createElement('li');
    const lost = decided ? seatRow.seat === durakSeat : game.durak_id === seatRow.player_id;
    if (lost) li.classList.add('is-durak');

    const name = document.createElement('span');
    name.className = 'result__name';
    name.textContent = seatRow.profile?.username ?? `Seat ${seatRow.seat + 1}`;

    // The score and this game's change to it are coloured independently:
    // someone can sit at +12 overall and still have just lost 4.
    const total = document.createElement('span');
    total.className = 'result__score';
    paintScore(total, settled);

    const change = document.createElement('span');
    change.className = 'result__change';
    paintScore(change, value);
    change.textContent = value === null ? '(—)' : `(${formatScore(value)})`;

    li.append(name, total, change);
    list.append(li);
  }

  try {
    const fresh = await getProfile(session.user.id);
    if (fresh) {
      session.profile = fresh;
      paintScore($('#whoami-elo'), scoreOf(fresh));
    }
  } catch {
    /* the header keeps its old number */
  }

  show($('#result'), true);
}