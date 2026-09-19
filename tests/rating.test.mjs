/**
 * Rating model tests. Run with: node --test tests/rating.test.mjs
 *
 * The invariants that matter, in the order it would hurt to lose them:
 *
 *   1. Zero sum. No game creates or destroys points (the floor aside).
 *   2. Monotonic penalty. Being the durak costs strictly more at a bigger
 *      table. This is the one an integer model breaks, and the reason ratings
 *      are stored as decimals.
 *   3. Who you played counts. Losing to weaker players costs more.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  START,
  SCALE,
  K,
  FLOOR,
  PRECISION,
  quantise,
  expectedPair,
  expectedDurakChances,
  actualBlame,
  ratingChanges,
  formatRating,
  formatRatingDelta,
} from '../src/js/rating.js';

const EPS = 1e-9;
const level = (n) => Array(n).fill(START);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
/** Deltas are quantised, so their sum is only zero to that same precision. */
const net = (deltas) => quantise(sum(deltas));

/* ---- expectations ------------------------------------------------------ */

test('equal ratings expect an equal share of the blame', () => {
  for (let n = 2; n <= 8; n++) {
    const chances = expectedDurakChances(level(n));
    assert.equal(chances.length, n);
    for (const c of chances) assert.ok(Math.abs(c - 1 / n) < EPS);
  }
});

test('expectations always sum to one', () => {
  const tables = [
    [1000, 1200],
    [900, 1000, 1100],
    [1000, 1000, 1400, 700],
    [1200, 1150, 1100, 1050, 1000, 950, 900, 850],
  ];
  for (const ratings of tables) {
    assert.ok(Math.abs(sum(expectedDurakChances(ratings)) - 1) < EPS);
  }
});

test('the weaker player is likelier to be the durak', () => {
  const [strong, weak] = expectedDurakChances([1200, 900]);
  assert.ok(weak > strong);
});

test('two players reduce to the usual logistic pairing', () => {
  for (const [a, b] of [[1000, 1000], [1200, 900], [700, 1500]]) {
    const [chanceA] = expectedDurakChances([a, b]);
    // a's chance of being the durak is b's chance of finishing ahead.
    assert.ok(Math.abs(chanceA - expectedPair(b, a)) < EPS);
  }
});

test('a rating gap of SCALE is a ten to one expectation', () => {
  const [strong, weak] = expectedDurakChances([START + SCALE, START]);
  assert.ok(Math.abs(weak / strong - 10) < EPS);
});

test('expectations survive extreme ratings without overflow', () => {
  const chances = expectedDurakChances([100, 100000]);
  assert.ok(chances.every(Number.isFinite));
  assert.ok(Math.abs(sum(chances) - 1) < EPS);
});

/* ---- blame ------------------------------------------------------------- */

test('blame is one for the durak and none for anyone else', () => {
  assert.equal(actualBlame(4, 2, 2), 1);
  for (const seat of [0, 1, 3]) assert.equal(actualBlame(4, seat, 2), 0);
});

test('a draw spreads the blame evenly', () => {
  for (let seat = 0; seat < 5; seat++) {
    assert.ok(Math.abs(actualBlame(5, seat, -1) - 1 / 5) < EPS);
  }
});

/* ---- zero sum ---------------------------------------------------------- */

test('every table size is zero sum', () => {
  for (let n = 2; n <= 8; n++) {
    for (let durak = 0; durak < n; durak++) {
      assert.equal(net(ratingChanges(level(n), durak)), 0);
    }
  }
});

test('uneven ratings are zero sum', () => {
  const tables = [
    [[1000, 1200], 0],
    [[900, 1000, 1100], 2],
    [[1000, 1013, 1437, 762], 1],
    [[1200, 1150, 1100, 1050, 1000, 950, 900, 850], 5],
    [[1003, 999, 1001, 1002, 998, 1000, 997], 3],
  ];
  for (const [ratings, durak] of tables) {
    assert.equal(net(ratingChanges(ratings, durak)), 0);
  }
});

test('draws are zero sum', () => {
  for (let n = 2; n <= 8; n++) assert.equal(net(ratingChanges(level(n), -1)), 0);
  assert.equal(net(ratingChanges([1003, 999, 1001, 1002, 998, 1000, 997], -1)), 0);
});

test('a draw between equals moves nothing', () => {
  for (let n = 2; n <= 8; n++) {
    for (const delta of ratingChanges(level(n), -1)) assert.equal(delta, 0);
  }
});

test('a draw nudges toward whoever was favoured to lose', () => {
  const [strong, weak] = ratingChanges([1200, 900], -1);
  assert.ok(strong < 0, 'the favourite loses ground by drawing');
  assert.ok(weak > 0);
  assert.equal(quantise(strong + weak), 0);
});

/* ---- magnitudes -------------------------------------------------------- */

test('equal tables pay the documented amounts', () => {
  const expected = {
    2: [-12, 12],
    3: [-16, 8],
    4: [-18, 6],
    5: [-19.2, 4.8],
    6: [-20, 4],
    8: [-21, 3],
  };
  for (const [players, [durakDelta, survivorDelta]] of Object.entries(expected)) {
    const n = Number(players);
    const deltas = ratingChanges(level(n), 0);
    assert.ok(Math.abs(deltas[0] - durakDelta) < 1e-5, `durak at ${n}`);
    for (let seat = 1; seat < n; seat++) {
      assert.ok(Math.abs(deltas[seat] - survivorDelta) < 1e-5, `survivor at ${n}`);
    }
  }
});

test('seven players pay the exact sevenths that break an integer model', () => {
  const deltas = ratingChanges(level(7), 0);
  assert.ok(Math.abs(deltas[0] - -(K * 6) / 7) < 1e-5);
  for (let seat = 1; seat < 7; seat++) {
    assert.ok(Math.abs(deltas[seat] - K / 7) < 1e-5);
  }
});

test('the durak pays strictly more at every larger table', () => {
  const losses = [];
  for (let n = 2; n <= 8; n++) losses.push(-ratingChanges(level(n), 0)[0]);
  for (let i = 1; i < losses.length; i++) {
    assert.ok(
      losses[i] > losses[i - 1],
      `durak at ${i + 2} players (${losses[i]}) must cost more than at ${i + 1} (${losses[i - 1]})`,
    );
  }
});

test('survivors are paid strictly less at every larger table', () => {
  const gains = [];
  for (let n = 2; n <= 8; n++) gains.push(ratingChanges(level(n), 0)[1]);
  for (let i = 1; i < gains.length; i++) assert.ok(gains[i] < gains[i - 1]);
});

test('no single game moves a rating by more than K', () => {
  const tables = [level(2), level(8), [1400, 1000, 900, 700], [100, 2000]];
  for (const ratings of tables) {
    for (let durak = -1; durak < ratings.length; durak++) {
      for (const delta of ratingChanges(ratings, durak)) {
        assert.ok(Math.abs(delta) <= K + EPS);
      }
    }
  }
});

/* ---- who you played ---------------------------------------------------- */

test('losing to weaker players costs more than losing to stronger ones', () => {
  const againstWeak = ratingChanges([1200, 900, 900, 900], 0)[0];
  const againstStrong = ratingChanges([1200, 1500, 1500, 1500], 0)[0];
  assert.ok(againstWeak < againstStrong);
});

test('surviving a strong table pays more than surviving a weak one', () => {
  const strongTable = ratingChanges([1000, 1400, 1400, 1400], 3)[0];
  const weakTable = ratingChanges([1000, 700, 700, 700], 3)[0];
  assert.ok(strongTable > weakTable);
});

test('the favourite gains little and loses a lot', () => {
  const survives = ratingChanges([1600, 800, 800, 800], 1)[0];
  const loses = ratingChanges([1600, 800, 800, 800], 0)[0];
  assert.ok(survives > 0 && survives < 3, 'little to gain');
  assert.ok(loses < -20, 'plenty to lose');
});

/* ---- floor ------------------------------------------------------------- */

test('nobody is pushed below the floor', () => {
  const ratings = [FLOOR, FLOOR + 1, 1000, 1000];
  const deltas = ratingChanges(ratings, 0);
  ratings.forEach((r, seat) => assert.ok(r + deltas[seat] >= FLOOR));
});

test('a player already at the floor cannot fall further', () => {
  assert.equal(ratingChanges([FLOOR, 1000], 0)[0], 0);
});

/* ---- precision --------------------------------------------------------- */

test('deltas never carry more precision than the database stores', () => {
  const tables = [level(7), [1003, 999, 1001, 1002, 998, 1000, 997], [1234.5678, 900, 1100]];
  for (const ratings of tables) {
    for (let durak = -1; durak < ratings.length; durak++) {
      for (const delta of ratingChanges(ratings, durak)) {
        assert.equal(delta, quantise(delta));
        assert.ok((String(delta).split('.')[1] ?? '').length <= PRECISION);
      }
    }
  }
});

test('a long run of games keeps the pool constant', () => {
  let ratings = Array(7).fill(START);
  const opening = sum(ratings);
  let seed = 7;
  for (let game = 0; game < 500; game++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const deltas = ratingChanges(ratings, seed % ratings.length);
    ratings = ratings.map((r, i) => quantise(r + deltas[i]));
  }
  assert.ok(Math.abs(sum(ratings) - opening) < 1e-4);
});

/* ---- display ----------------------------------------------------------- */

test('ratings display as whole numbers', () => {
  assert.equal(formatRating(1000), '1000');
  assert.equal(formatRating(979.428571), '979');
  assert.equal(formatRating(1003.5), '1004');
  assert.equal(formatRating(null), '—');
});

test('deltas display with one decimal, trailing zero trimmed', () => {
  assert.equal(formatRatingDelta(6), '+6');
  assert.equal(formatRatingDelta(3.428571), '+3.4');
  assert.equal(formatRatingDelta(-20.571429), '−20.6');
  assert.equal(formatRatingDelta(-18), '−18');
  assert.equal(formatRatingDelta(0), '0');
  assert.equal(formatRatingDelta(null), '—');
});

test('one decimal keeps a seven-player game looking consistent', () => {
  // Seven is the awkward size: a seventh has no exact decimal form, so no
  // fixed precision makes the displayed numbers add up. What one decimal
  // buys is that the discrepancy is a fraction of a point rather than the
  // three whole points an integer display would be out by.
  const deltas = ratingChanges(level(7), 0);
  const shownGap = Math.abs(sum(deltas.map((d) => Math.round(d * 10) / 10)));
  const integerGap = Math.abs(sum(deltas.map((d) => Math.round(d))));
  assert.ok(shownGap < 0.25, `one decimal is ${shownGap} out`);
  assert.ok(integerGap >= 2.9, 'integers would be about three points out');
});
