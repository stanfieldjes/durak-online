// tests/sudden-death.test.mjs
// A round that leaves nobody holding cards goes to sudden death, never a draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame,
  applyMove,
  availableMoves,
  activeSeats,
  describe,
  cardId,
  makeRng,
  deckSize,
  HAND_SIZE,
} from '../src/js/durak.js';

const c = (id) => ({ r: id.slice(0, -1), s: id.slice(-1) });

/**
 * A two-card endgame that is about to tie: the stock is gone, the attacker
 * holds one card and the defender holds the one card that beats it. Seats in
 * `out` have already got out.
 */
function brinkOfTie({ players = 2, seed = 1234, attacker = 0, defender = 1, out = [] } = {}) {
  const s = newGame(seed, players);
  s.deck = [];
  s.table = [];
  s.hands = Array.from({ length: players }, () => []);
  s.out = Array.from({ length: players }, (_, seat) => out.includes(seat));
  // Spades are never trump here, so the ten beats the nine on suit alone.
  s.trump = 'H';
  s.hands[attacker] = [c('9S')];
  s.hands[defender] = [c('10S')];
  s.attacker = attacker;
  s.defender = defender;
  s.taking = false;
  s.passed = s.out.map((isOut, seat) => isOut || seat === defender);
  return s;
}

/** Attack, beat it, clear the table: both hands empty on the same round. */
function playOutTie(s, attacker = s.attacker, defender = s.defender) {
  let next = applyMove(s, attacker, { type: 'attack', card: s.hands[attacker][0] });
  next = applyMove(next, defender, { type: 'defend', card: next.hands[defender][0], slot: 0 });
  return applyMove(next, attacker, { type: 'clear' });
}

test('a round that empties every hand starts sudden death instead of a draw', () => {
  const before = brinkOfTie();
  const s = playOutTie(before);

  assert.equal(s.finished, false);
  assert.equal(s.draw, false);
  assert.equal(s.suddenDeath, 1);
  assert.deepEqual(s.out, [false, false]);
  assert.equal(s.deck.length, 0, 'sudden death has no stock');
  assert.equal(s.table.length, 0);
  for (const hand of s.hands) assert.equal(hand.length, HAND_SIZE);

  // Nothing submit_move() checks has changed.
  assert.equal(s.seed, before.seed);
  assert.equal(s.trump, before.trump);
  assert.equal(s.playerCount, before.playerCount);
  assert.equal(s.version, before.version + 3);

  const last = s.log.at(-1);
  assert.deepEqual(last, { t: 'sudden-death', round: 1, seats: [0, 1] });
  assert.ok(!s.log.some((e) => e.t === 'out'), 'nobody is marked out for tying');
});

test('the sudden-death deal is twelve different cards', () => {
  const s = playOutTie(brinkOfTie());
  const ids = s.hands.flat().map(cardId);
  assert.equal(new Set(ids).size, ids.length);
});

/** Every card is somewhere: a hand, the table, the stock or the beaten pile. */
function cardsAccountedFor(s) {
  const onTable = s.table.reduce((n, slot) => n + (slot.def ? 2 : 1), 0);
  return s.hands.flat().length + onTable + s.deck.length + s.discard;
}

test('the sudden-death deal comes out of the same deck, so no card is counted twice', () => {
  for (const players of [2, 3, 4, 6, 8]) {
    const before = brinkOfTie({ players, attacker: 0, defender: 1, out: [] });
    // Everything not in the two last hands has been beaten already.
    before.out = before.out.map((_, seat) => seat > 1);
    before.discard = deckSize(players) - 2;
    assert.equal(cardsAccountedFor(before), deckSize(players), `${players}p before`);

    const s = playOutTie(before);
    assert.equal(s.suddenDeath, 1);
    assert.equal(cardsAccountedFor(s), deckSize(players), `${players}p after the deal`);
    assert.equal(s.discard, deckSize(players) - 2 * HAND_SIZE);
  }
});

test('every browser arrives at the same sudden-death deal', () => {
  const a = playOutTie(brinkOfTie({ seed: 98765 }));
  const b = playOutTie(brinkOfTie({ seed: 98765 }));
  assert.deepEqual(a, b);

  const other = playOutTie(brinkOfTie({ seed: 98766 }));
  assert.notDeepEqual(a.hands, other.hands, 'a different table gets a different deal');
});

test('players already out stay out and are dealt nothing', () => {
  const s = playOutTie(brinkOfTie({ players: 4, attacker: 1, defender: 3, out: [0, 2] }));
  assert.equal(s.suddenDeath, 1);
  assert.deepEqual(s.out, [true, false, true, false]);
  assert.deepEqual(s.hands.map((h) => h.length), [0, HAND_SIZE, 0, HAND_SIZE]);
  assert.deepEqual(activeSeats(s), [1, 3]);
  assert.ok([1, 3].includes(s.attacker));
  assert.ok([1, 3].includes(s.defender));
  assert.notEqual(s.attacker, s.defender);
});

test('the lowest trump among the new hands leads', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = playOutTie(brinkOfTie({ seed }));
    let lowest = null;
    s.hands.forEach((hand, seat) => {
      for (const card of hand) {
        if (card.s !== s.trump) continue;
        const v = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(card.r);
        if (!lowest || v < lowest.v) lowest = { seat, v };
      }
    });
    if (lowest) assert.equal(s.attacker, lowest.seat, `seed ${seed}`);
  }
});

test('a tie in sudden death deals another round', () => {
  const first = playOutTie(brinkOfTie({ seed: 555 }));

  // Rig the new round to tie again.
  const rigged = structuredClone(first);
  rigged.hands = [[c('9S')], [c('10S')]];
  rigged.attacker = 0;
  rigged.defender = 1;
  rigged.passed = [false, true];

  const second = playOutTie(rigged);
  assert.equal(second.finished, false);
  assert.equal(second.suddenDeath, 2);
  assert.deepEqual(second.log.at(-1), { t: 'sudden-death', round: 2, seats: [0, 1] });
  assert.notDeepEqual(second.hands, first.hands, 'round two is a new shuffle');
});

test('the prompt says it is sudden death', () => {
  const s = playOutTie(brinkOfTie());
  assert.match(describe(s, s.attacker), /^Sudden death\. /);

  const four = playOutTie(brinkOfTie({ players: 4, attacker: 1, defender: 3, out: [0, 2] }));
  assert.match(describe(four, 0), /sudden death/i);
});

test('random games always end with a durak and never a draw', () => {
  let suddenDeaths = 0;
  for (let g = 1; g <= 300; g++) {
    const players = 2 + (g % 7);
    let s = newGame(g * 7919, players);
    const rng = makeRng(g);
    for (let steps = 0; !s.finished; steps++) {
      assert.ok(steps < 5000, `game ${g} did not finish`);
      const options = [];
      for (let seat = 0; seat < s.playerCount; seat++) {
        for (const move of availableMoves(s, seat)) options.push([seat, move]);
      }
      assert.ok(options.length > 0, `game ${g} has nobody able to move`);
      // Mostly defend rather than take, which is what makes ties happen.
      const keep = options.filter(([, m]) => m.type !== 'take' && m.type !== 'clear');
      const pool = keep.length && rng() < 0.85 ? keep : options;
      const [seat, move] = pool[Math.floor(rng() * pool.length)];
      s = applyMove(s, seat, move);
      assert.equal(cardsAccountedFor(s), deckSize(players), `game ${g} lost or gained a card`);
    }
    assert.equal(s.draw, false, `game ${g}`);
    assert.ok(Number.isInteger(s.durak), `game ${g} has a durak`);
    if (s.suddenDeath) suddenDeaths++;
  }
  assert.ok(suddenDeaths > 0, 'the run should include at least one sudden death');
});
