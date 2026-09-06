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

export function canPass(state, seat) {
  if (state.finished || state.out[seat]) return false;
  if (seat === state.defender) return false;
  return state.table.length > 0 && !state.passed[seat];
}

export function canTake(state, seat) {
  if (state.finished || state.taking) return false;
  return seat === state.defender && !state.out[seat] && state.table.length > 0;
}

/** Can this seat do anything at all right now? */
export function canAct(state, seat) {
  if (state.finished || state.out[seat]) return false;
  if (seat === state.defender) return !state.taking && openSlots(state) > 0;
  return legalAttacks(state, seat).length > 0 || canPass(state, seat);
}

/** Every seat currently allowed to move. Several at once is normal here. */
export function seatsToAct(state) {
  return activeSeats(state).filter((s) => canAct(state, s));
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
 * A card landing on the table gives every attacker a fresh chance to throw in.
 * Anyone with nothing legal to add is passed automatically, so a round never
 * stalls waiting on players who cannot do anything.
 */
function refreshPasses(state) {
  for (let seat = 0; seat < state.playerCount; seat++) {
    if (state.out[seat] || seat === state.defender) {
      state.passed[seat] = true;
      continue;
    }
    state.passed[seat] = legalAttacks(state, seat).length === 0;
  }
}

function allAttackersPassed(state) {
  return attackerSeats(state).every((s) => state.passed[s]);
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
      break;
    }

    default:
      throw new IllegalMove('Unknown move.');
  }

  state = maybeEndRound(state);
  state.version = prev.version + 1;
  return state;
}

function illegalAttackReason(state, seat) {
  if (seat === state.defender) return 'You are defending.';
  if (state.table.length === 0) return 'The opening card belongs to the attacker.';
  if (attackCapacity(state) <= 0) return 'There is no room for another card.';
  return 'You can only throw in a rank already on the table.';
}

/** A round closes once no attacker wants to add anything more. */
function maybeEndRound(state) {
  if (state.table.length === 0) return state;
  if (!allAttackersPassed(state)) return state;
  if (state.taking) return resolveTake(state);
  if (openSlots(state) === 0) return resolveBeaten(state);
  return state; // defender still owes an answer
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
  if (seat === state.defender) return 'defending';
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

  if (seat === state.defender) {
    if (state.taking) return 'You are taking. Waiting to see what else gets thrown in.';
    if (openSlots(state) > 0) return 'Beat what is in front of you, or take the cards.';
    return 'Everything is beaten. Waiting for the attackers.';
  }

  if (state.table.length === 0) {
    return seat === state.attacker
      ? 'Your attack — lead a card.'
      : 'Waiting for the attacker to lead.';
  }
  if (state.passed[seat]) return 'You are done for this round.';
  return 'Throw in a matching rank, or pass.';
}
