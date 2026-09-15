/**
 * Durak rules engine — 2 to 4 players, podkidnoy (throw-in) variant, 36 cards.
 *
 * Pure and dependency-free on purpose: no DOM, no network, no imports.
 * The same file can be dropped into a Supabase Edge Function to validate
 * moves server-side. See README, "Trust model".
 *
 * Attacking is free-for-all. Once the opening card is down, ANY attacker may
 * throw in a matching rank at any moment — there is no order among them. Only
 * the very first card of a round is reserved for the primary attacker.
 *
 * How a round ends:
 *   - Defender beats everything: the table waits on a `clear` move, which
 *     browsers submit after a pause so everyone sees the defence (attackers
 *     can still throw in during it). Attackers may press Done (`pass`) to skip
 *     the rest of the pause; once every attacker has, the table clears.
 *   - Defender takes: attackers throw in what they like and press Done.
 *     Once all of them have, the defender picks the table up.
 *   - Defender takes and no more cards can go down: nobody has to press Done;
 *     the table waits on the same delayed `clear`, and Done skips it.
 *
 * An attacker with an empty hand counts as done without pressing anything,
 * but can still press Done to skip a pause. A pause is only ever skipped by
 * someone actually pressing it, so the last card is never whisked away
 * unseen just because everyone happens to be out of cards.
 *
 * Because several players can act at once, every position carries a `version`
 * that increments on each move. Writers submit the version they built on and
 * the database rejects the write if it has moved on. See submit_move() in
 * supabase/schema.sql.
 */

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const HAND_SIZE = 6;
export const MAX_SLOTS = 6;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export const SUIT_GLYPH = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
export const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

export class IllegalMove extends Error {}

export function rankValue(rank) {
  return RANKS.indexOf(rank);
}

export function cardId(card) {
  return card.r + card.s;
}

export function sameCard(a, b) {
  return Boolean(a && b && a.r === b.r && a.s === b.s);
}

/** Does `def` legally beat `atk`? */
export function beats(def, atk, trump) {
  if (def.s === atk.s) return rankValue(def.r) > rankValue(atk.r);
  return def.s === trump && atk.s !== trump;
}

/* ------------------------------------------------------------------ */
/* Deterministic shuffle                                               */
/* ------------------------------------------------------------------ */

/** mulberry32 — small seeded PRNG so a deal can be reproduced from its seed. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDeck(rng) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

/**
 * Build a fresh position for `playerCount` seats.
 * The bottom card of the stock sets trump and stays visible until drawn.
 */
export function newGame(seed, playerCount) {
  const n = Number(playerCount);
  if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new IllegalMove(`Durak needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }

  const rng = makeRng(seed);
  const deck = createDeck(rng);
  const hands = Array.from({ length: n }, () => []);
  for (let i = 0; i < HAND_SIZE; i++) {
    for (let seat = 0; seat < n; seat++) hands[seat].push(deck.pop());
  }

  const trumpCard = deck[0];
  const trump = trumpCard.s;
  const attacker = openingSeat(hands, trump, n);

  const state = {
    v: 2,
    version: 0,
    seed,
    playerCount: n,
    trump,
    trumpCard,
    deck,
    hands,
    table: [], // [{ atk: card, def: card|null }]
    discard: 0, // count only; beaten cards never matter again
    attacker,
    defender: (attacker + 1) % n,
    taking: false,
    passed: Array(n).fill(false),
    out: Array(n).fill(false),
    finished: false,
    durak: null, // seat of the fool, or null on a draw
    draw: false,
    log: [{ t: 'deal', trump, players: n }],
  };

  refreshPasses(state);
  return state;
}

/** Lowest trump opens; seat 0 if nobody holds one. */
function openingSeat(hands, trump, n) {
  let best = null;
  for (let seat = 0; seat < n; seat++) {
    for (const c of hands[seat]) {
      if (c.s !== trump) continue;
      if (!best || rankValue(c.r) < best.value) best = { seat, value: rankValue(c.r) };
    }
  }
  return best ? best.seat : 0;
}

/* ------------------------------------------------------------------ */
/* Seats                                                               */
/* ------------------------------------------------------------------ */

export function activeSeats(state) {
  const seats = [];
  for (let s = 0; s < state.playerCount; s++) if (!state.out[s]) seats.push(s);
  return seats;
}

/** Next seat after `from` that is still holding cards. */
export function nextActive(state, from) {
  const n = state.playerCount;
  for (let step = 1; step <= n; step++) {
    const seat = (from + step) % n;
    if (!state.out[seat]) return seat;
  }
  return from;
}

/** Everyone who may throw cards in this round. */
export function attackerSeats(state) {
  return activeSeats(state).filter((s) => s !== state.defender);
}

/* ------------------------------------------------------------------ */
/* Legality                                                            */
/* ------------------------------------------------------------------ */

/** Ranks on the table — throw-ins must match one of them. */
export function tableRanks(state) {
  const set = new Set();
  for (const slot of state.table) {
    set.add(slot.atk.r);
    if (slot.def) set.add(slot.def.r);
  }
  return set;
}

export function openSlots(state) {
  return state.table.filter((s) => !s.def).length;
}

/** How many more cards may go down right now, across all attackers. */
export function attackCapacity(state) {
  const room = MAX_SLOTS - state.table.length;
  // Never put down more than the defender could answer.
  const defenderRoom = state.hands[state.defender].length - openSlots(state);
  return Math.max(0, Math.min(room, defenderRoom));
}

/**
 * Cards `seat` may put down right now.
 * The opening card of a round belongs to the primary attacker; after that
 * every attacker competes freely for the remaining slots.
 */
export function legalAttacks(state, seat) {
  if (state.finished || state.out[seat] || seat === state.defender) return [];
  if (attackCapacity(state) <= 0) return [];

  const hand = state.hands[seat];
  if (state.table.length === 0) {
    return seat === state.attacker ? hand.slice() : [];
  }
  const ranks = tableRanks(state);
  return hand.filter((c) => ranks.has(c.r));
}

export function legalDefenses(state, seat, slotIndex) {
  if (state.finished || state.taking) return [];
  if (seat !== state.defender || state.out[seat]) return [];
  const slot = state.table[slotIndex];
  if (!slot || slot.def) return [];
  return state.hands[seat].filter((c) => beats(c, slot.atk, state.trump));
}

/**
 * When an attacker gets a Done button:
 *   - during a pause before the table clears (see canClear), to skip it;
 *   - while the defender is taking and more cards could still go down, to say
 *     they have finished throwing in. An empty hand already counts as done.
 * Never while the defender still has attacks to answer.
 */
export function canPass(state, seat) {
  if (state.finished || state.out[seat]) return false;
  if (seat === state.defender || state.table.length === 0 || state.passed[seat]) return false;
  if (canClear(state)) return true;
  return state.taking && state.hands[seat].length > 0;
}

/**
 * Is the table ready to be cleared without anyone deciding anything?
 *
 * True when every attack is beaten, or when the defender is taking and no
 * more cards fit. Not a player's choice: browsers submit it on a timer (see
 * game.js), so the last card played stays visible for a moment first. Any
 * seat still in the game may submit it, and the version check guarantees it
 * applies once however many browsers try.
 */
export function canClear(state, seat) {
  if (state.finished || state.table.length === 0) return false;
  if (seat !== undefined && (!Number.isInteger(seat) || state.out[seat])) return false;
  if (state.taking) return attackCapacity(state) <= 0;
  return openSlots(state) === 0;
}

export function canTake(state, seat) {
  if (state.finished || state.taking) return false;
  if (seat !== state.defender || state.out[seat]) return false;
  // You take because you cannot answer an attack. Once every attack on the
  // table is beaten there is nothing outstanding, so the option closes until
  // somebody throws in another card.
  return state.table.length > 0 && openSlots(state) > 0;
}

/** Can this seat do anything at all right now? */
export function canAct(state, seat) {
  if (state.finished || state.out[seat]) return false;
  if (seat === state.defender) return !state.taking && openSlots(state) > 0;
  return legalAttacks(state, seat).length > 0 || canPass(state, seat);
}

/**
 * Every seat currently allowed to submit a move. Several at once is normal
 * here. Includes seats that may only submit the automatic `clear`, which
 * canAct() leaves out because it is not a decision anyone makes.
 */
export function seatsToAct(state) {
  return activeSeats(state).filter((s) => canAct(state, s) || canClear(state, s));
}

export function availableMoves(state, seat) {
  const moves = [];
  for (const card of legalAttacks(state, seat)) moves.push({ type: 'attack', card });
  state.table.forEach((slot, i) => {
    if (slot.def) return;
    for (const card of legalDefenses(state, seat, i)) moves.push({ type: 'defend', card, slot: i });
  });
  if (canTake(state, seat)) moves.push({ type: 'take' });
  if (canPass(state, seat)) moves.push({ type: 'pass' });
  if (canClear(state, seat)) moves.push({ type: 'clear' });
  return moves;
}

/* ------------------------------------------------------------------ */
/* Moves                                                               */
/* ------------------------------------------------------------------ */

const clone = (state) => JSON.parse(JSON.stringify(state));

function removeFromHand(hand, card) {
  const i = hand.findIndex((c) => sameCard(c, card));
  if (i === -1) throw new IllegalMove('That card is not in your hand.');
  return hand.splice(i, 1)[0];
}

/**
 * A card landing on the table gives every attacker a fresh chance to throw in,
 * so every earlier Done is forgotten.
 *
 * `passed` records only an actual press. Attackers are not passed just because
 * they hold no matching rank: a round ends when the attackers say it ends, not
 * when the engine decides for them. An empty hand is treated as done by
 * allAttackersDone() instead, so it never holds a take up, but it cannot on
 * its own cut short the pause before a table clears.
 */
function refreshPasses(state) {
  for (let seat = 0; seat < state.playerCount; seat++) {
    state.passed[seat] = state.out[seat] || seat === state.defender;
  }
}

function allAttackersDone(state) {
  return attackerSeats(state).every((s) => state.passed[s] || state.hands[s].length === 0);
}

/**
 * Apply a move and return the next position. Never mutates the input.
 * Throws IllegalMove with a message safe to show in the UI.
 */
export function applyMove(prev, seat, move) {
  if (prev.finished) throw new IllegalMove('This game is over.');
  if (!Number.isInteger(seat) || seat < 0 || seat >= prev.playerCount) {
    throw new IllegalMove('Unknown seat.');
  }
  if (prev.out[seat]) throw new IllegalMove('You are out of this game.');

  let state = clone(prev);

  switch (move.type) {
    case 'attack': {
      if (!legalAttacks(state, seat).some((c) => sameCard(c, move.card))) {
        throw new IllegalMove(illegalAttackReason(state, seat));
      }
      const card = removeFromHand(state.hands[seat], move.card);
      state.table.push({ atk: card, def: null });
      state.log.push({ t: 'attack', seat, card });
      refreshPasses(state);
      break;
    }

    case 'defend': {
      if (!legalDefenses(state, seat, move.slot).some((c) => sameCard(c, move.card))) {
        throw new IllegalMove('That card does not beat the attack.');
      }
      const card = removeFromHand(state.hands[seat], move.card);
      state.table[move.slot].def = card;
      state.log.push({ t: 'defend', seat, card, slot: move.slot });
      refreshPasses(state);
      break;
    }

    case 'take': {
      if (!canTake(state, seat)) throw new IllegalMove('You cannot take right now.');
      state.taking = true;
      state.log.push({ t: 'take', seat });
      refreshPasses(state);
      break;
    }

    case 'pass': {
      if (!canPass(state, seat)) throw new IllegalMove('You cannot pass right now.');
      state.passed[seat] = true;
      state.log.push({ t: 'pass', seat });
      // Everyone done during the pause over a beaten table: skip the rest of
      // it. (A take is settled by maybeEndRound below, the same as always.)
      if (!state.taking && openSlots(state) === 0 && allAttackersDone(state)) {
        return finishMove(prev, resolveBeaten(state));
      }
      break;
    }

    case 'clear': {
      if (!canClear(state, seat)) throw new IllegalMove('The table is not ready to clear.');
      // Logged without a seat: whichever browser's timer fires first, the
      // resulting position must be identical. The entry itself is how
      // submit_move() recognises a clear and holds it to the table's delay.
      state.log.push({ t: 'clear' });
      return finishMove(prev, state.taking ? resolveTake(state) : resolveBeaten(state));
    }

    default:
      throw new IllegalMove('Unknown move.');
  }

  state = maybeForcedEnd(state);
  if (!state.finished) state = maybeEndRound(state);
  return finishMove(prev, state);
}

function finishMove(prev, state) {
  state.version = prev.version + 1;
  return state;
}

/**
 * Can every open slot be matched to a distinct card in `hand` that beats it?
 *
 * Card count alone is not enough: holding exactly as many cards as there are
 * open slots proves nothing if two slots both need a heart and the hand holds
 * only one. This is bipartite matching — an augmenting-path search — but the
 * boards involved are tiny (at most six slots, six cards), so a plain
 * recursive search is instant and there is no need for anything cleverer.
 */
function canCoverAllSlots(hand, openAttacks, trump) {
  const claimedBy = new Array(hand.length).fill(-1); // hand index -> slot it currently covers

  function tryAssign(slotIndex, visited) {
    for (let h = 0; h < hand.length; h++) {
      if (visited[h] || !beats(hand[h], openAttacks[slotIndex], trump)) continue;
      visited[h] = true;
      if (claimedBy[h] === -1 || tryAssign(claimedBy[h], visited)) {
        claimedBy[h] = slotIndex;
        return true;
      }
    }
    return false;
  }

  for (let slot = 0; slot < openAttacks.length; slot++) {
    if (!tryAssign(slot, new Array(hand.length).fill(false))) return false;
  }
  return true;
}

/**
 * Is the position hopeless for the defender right now: stock empty, nobody
 * left to add another attack, and nothing they do avoids ending up the durak?
 * Exported so tests can check games against the same rule the engine itself
 * uses, rather than a hand-rolled approximation of it.
 *
 * Two separate ways to be hopeless here, and only one of them is about which
 * cards you hold:
 *
 * - Holding MORE cards than there are open attacks is hopeless on its own,
 *   no matter what those cards are. Beating an attack removes exactly one
 *   card; anything left over afterward means you are still holding cards
 *   once the attacker runs out, which is the whole definition of durak. There
 *   is nothing to check here — the arithmetic alone already decides it.
 *
 * - Holding EXACTLY as many cards as open attacks is where the specific
 *   cards start to matter: beating everything would empty your hand at the
 *   same moment as the attacker's, which is a draw. That is only reachable if
 *   some arrangement of your hand actually covers every open attack — hence
 *   the matching check, but only for this one exact-count case.
 */
export function isHopelessForDefender(state) {
  if (state.deck.length > 0) return false;

  const defender = state.defender;
  const others = [];
  for (let seat = 0; seat < state.playerCount; seat++) {
    if (seat !== defender && !state.out[seat]) others.push(seat);
  }
  if (others.length === 0) return false;
  if (!others.every((seat) => state.hands[seat].length === 0)) return false;

  const openAttacks = state.table.filter((slot) => !slot.def).map((slot) => slot.atk);
  if (openAttacks.length === 0) return false;

  const hand = state.hands[defender];
  if (hand.length > openAttacks.length) return true; // leftover cards either way — no need to check which ones
  return !canCoverAllSlots(hand, openAttacks, state.trump);
}

/**
 * Stop a round that cannot change the result.
 *
 * Once the stock is empty and every attacker has played their last card, the
 * defender is the only player left holding anything, and no one is coming to
 * add more attacks. Whatever they do next — defend or take — is already
 * certain to leave them holding cards while nobody else does, unless their
 * hand happens to exactly match the open attacks in both count and suit. See
 * isHopelessForDefender() for the two ways that can fail. When it does fail,
 * there is nothing left to ask them: they are the durak, without a "take"
 * click needed to confirm what the arithmetic already decided.
 */
function maybeForcedEnd(state) {
  if (state.finished || state.deck.length > 0) return state;

  const defender = state.defender;
  const others = [];
  for (let seat = 0; seat < state.playerCount; seat++) {
    if (seat !== defender && !state.out[seat]) others.push(seat);
  }
  if (others.length === 0) return state;
  if (!others.every((seat) => state.hands[seat].length === 0)) return state;

  if (!isHopelessForDefender(state)) return state;

  for (const seat of others) {
    state.out[seat] = true;
    state.log.push({ t: 'out', seat });
  }
  state.finished = true;
  state.draw = false;
  state.durak = defender;
  state.taking = false;
  state.passed = Array(state.playerCount).fill(true);
  state.log.push({ t: 'end', durak: defender, draw: false, forced: true });
  return state;
}

function illegalAttackReason(state, seat) {
  if (seat === state.defender) return 'You are defending.';
  if (state.table.length === 0) return 'The opening card belongs to the attacker.';
  if (attackCapacity(state) <= 0) return 'There is no room for another card.';
  return 'You can only throw in a rank already on the table.';
}

/**
 * A take closes as soon as every attacker is done. A beaten table closes when
 * every attacker presses Done (handled in the `pass` move) or when the pause
 * runs out (the `clear` move). See canClear().
 */
function maybeEndRound(state) {
  if (state.table.length === 0) return state;
  if (state.taking && allAttackersDone(state)) return resolveTake(state);
  return state;
}

/** Defender beat everything: the table is discarded and they attack next. */
function resolveBeaten(state) {
  state.discard += state.table.reduce((n, s) => n + (s.def ? 2 : 1), 0);
  const heldTheLine = state.defender;
  state.table = [];
  state.log.push({ t: 'beaten', seat: heldTheLine });
  refill(state);
  return advance(state, heldTheLine);
}

/** Defender takes the table and is skipped; the next player attacks. */
function resolveTake(state) {
  const defender = state.defender;
  for (const slot of state.table) {
    state.hands[defender].push(slot.atk);
    if (slot.def) state.hands[defender].push(slot.def);
  }
  state.table = [];
  state.log.push({ t: 'taken', seat: defender });
  refill(state);
  return advance(state, null);
}

/** Attacker draws first, then the other attackers in order, defender last. */
function refill(state) {
  const order = [];
  for (let i = 0; i < state.playerCount; i++) {
    const seat = (state.attacker + i) % state.playerCount;
    if (seat !== state.defender && !state.out[seat]) order.push(seat);
  }
  if (!state.out[state.defender]) order.push(state.defender);

  for (const seat of order) {
    while (state.hands[seat].length < HAND_SIZE && state.deck.length > 0) {
      state.hands[seat].push(state.deck.pop());
    }
  }
}

/**
 * Settle who is out, then hand the attack on.
 * `nextAttacker` is the seat that earned it (a defender who held), or null
 * when the defender took and so forfeits their turn to attack.
 */
function advance(state, nextAttacker) {
  const previousDefender = state.defender;

  if (state.deck.length === 0) {
    for (let seat = 0; seat < state.playerCount; seat++) {
      if (!state.out[seat] && state.hands[seat].length === 0) {
        state.out[seat] = true;
        state.log.push({ t: 'out', seat });
      }
    }
  }

  const remaining = activeSeats(state);
  if (remaining.length <= 1) {
    state.finished = true;
    state.draw = remaining.length === 0;
    state.durak = state.draw ? null : remaining[0];
    state.taking = false;
    state.passed = Array(state.playerCount).fill(true);
    state.log.push({ t: 'end', durak: state.durak, draw: state.draw });
    return state;
  }

  let attacker;
  if (nextAttacker !== null && !state.out[nextAttacker]) {
    attacker = nextAttacker; // the defender held, so they attack next
  } else {
    attacker = nextActive(state, previousDefender); // took, or went out
  }

  state.attacker = attacker;
  state.defender = nextActive(state, attacker);
  state.taking = false;
  refreshPasses(state);
  return state;
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

/**
 * Strip other players' hands down to counts.
 * Used by the Edge Function upgrade path described in the README.
 */
export function viewFor(state, seat) {
  const view = { ...state, hand: state.hands[seat], counts: state.hands.map((h) => h.length) };
  view.deckCount = state.deck.length;
  delete view.hands;
  delete view.deck;
  return view;
}

export function roleOf(state, seat) {
  if (state.out[seat]) return 'out';
  if (seat === state.defender) return state.taking ? 'taking' : 'defending';
  if (seat === state.attacker) return 'attacking';
  return 'throwing in';
}

export function describe(state, seat) {
  if (state.finished) {
    if (state.draw) return 'Draw. Nobody is the fool.';
    return state.durak === seat
      ? 'You are the durak.'
      : 'You got out — someone else is the fool.';
  }
  if (state.out[seat]) return 'You are out of cards. Waiting for the rest.';

  const full = attackCapacity(state) <= 0;

  if (seat === state.defender) {
    if (state.taking) {
      return full
        ? 'You are taking. The cards come to you in a moment.'
        : 'You are taking. Waiting to see what else gets thrown in.';
    }
    if (openSlots(state) > 0) return 'Beat what is in front of you, or take the cards.';
    return 'Everything is beaten. The table clears in a moment.';
  }

  if (state.table.length === 0) {
    return seat === state.attacker
      ? 'Your attack — lead a card.'
      : 'Waiting for the attacker to lead.';
  }

  const canThrow = legalAttacks(state, seat).length > 0;
  const done = state.passed[seat];
  if (state.taking) {
    if (full) {
      return done
        ? 'They are taking. Waiting for the other attackers, or a moment.'
        : 'They are taking. No room for more cards — press Done to hand them over now.';
    }
    if (done || state.hands[seat].length === 0) return 'They are taking. Waiting for the other attackers.';
    return canThrow
      ? 'They are taking — throw in anything that matches, then press Done.'
      : 'They are taking. Press Done when you are finished.';
  }
  if (openSlots(state) === 0) {
    if (done) return 'All beaten. Waiting for the other attackers, or the table clears in a moment.';
    return canThrow
      ? 'All beaten. Throw in a matching rank, or press Done to clear the table.'
      : 'All beaten. Press Done to clear the table, or it clears in a moment.';
  }
  return canThrow ? 'Throw in a matching rank, or wait for the defence.' : 'Waiting for the defender.';
}
