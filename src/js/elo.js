/**
 * Rating model. Pure, so tests can hold it against the SQL in
 * supabase/schema.sql — the database is what actually applies ratings.
 *
 * Durak has exactly one loser: the durak. Everyone else got out. That maps
 * onto a rating where losing hurts and winning is a modest bonus, because the
 * points the durak drops are split among all the survivors.
 *
 *   4 players, all rated equally:  durak −5.0,  each survivor +1.7
 *   3 players, all rated equally:  durak −5.0,  each survivor +2.5
 *   2 players, all rated equally:  durak −5.0,  the winner   +5.0
 *
 * The scale is asymmetric in the same direction. At a 4-player table, being
 * the durak a quarter of the time settles you at exactly 100. Dropping to 40%
 * costs about 35 points; improving to 10% gains about 35. Getting much worse
 * keeps costing; getting much better runs into a ceiling near 160.
 *
 * With two players there is one loser and one winner, so anything the loser
 * drops the winner must pick up. Asymmetry there is only possible by destroying
 * points, which is what LOSS_BIAS does — see README, "Rating".
 */

export const START = 100;   // everyone opens here
export const SCALE = 200;   // sets how far apart the ladder spreads
export const K = 10;        // most a rating can move in one game
export const FLOOR = 0;     // ratings never go below this

/**
 * Multiplier on the durak's loss. 1 keeps the pool zero sum: every point lost
 * is a point somebody else gained. Above 1 the extra is destroyed, so average
 * rating drifts down over time.
 */
export const LOSS_BIAS = 1;

/**
 * Probability that `rating` finishes ahead of `opponent`, on the SCALE above.
 */
export function expectedPair(rating, opponent) {
  return 1 / (1 + Math.pow(10, (opponent - rating) / SCALE));
}

/**
 * Expected score for one seat: how many of the others it should outlast,
 * as a fraction. Averaged pairwise, which is the usual multiplayer extension.
 */
export function expectedScore(ratings, seat) {
  const n = ratings.length;
  if (n < 2) return 0.5;
  let total = 0;
  for (let j = 0; j < n; j++) {
    if (j !== seat) total += expectedPair(ratings[seat], ratings[j]);
  }
  return total / (n - 1);
}

/**
 * Actual score. The durak outlasted nobody. Everyone else outlasted the durak
 * and drew with each other, which is worth (1 + 0.5(n−2)) / (n−1).
 */
export function actualScore(n, seat, durakSeat) {
  if (durakSeat === -1 || durakSeat === null) return 0.5; // nobody was the fool
  if (seat === durakSeat) return 0;
  return (1 + 0.5 * (n - 2)) / (n - 1);
}

/**
 * Rating changes for one finished game.
 *
 * @param {number[]} ratings   current rating per seat
 * @param {number}   durakSeat seat of the fool, or -1 for a draw
 * @returns {number[]}         change per seat, to two decimals
 */
export function ratingChanges(ratings, durakSeat, lossBias = LOSS_BIAS) {
  const n = ratings.length;
  const deltas = [];

  for (let seat = 0; seat < n; seat++) {
    const expected = expectedScore(ratings, seat);
    const actual = actualScore(n, seat, durakSeat);
    let delta = K * (actual - expected);
    if (seat === durakSeat && delta < 0) delta *= lossBias;
    deltas.push(round2(delta));
  }

  // Do not push anyone below the floor.
  for (let seat = 0; seat < n; seat++) {
    const floored = Math.max(FLOOR, round2(ratings[seat] + deltas[seat]));
    deltas[seat] = round2(floored - ratings[seat]);
  }

  return deltas;
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}

/** For display: "+1.7", "−5", "0". */
export function formatRatingDelta(delta) {
  if (delta === null || delta === undefined) return '—';
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return '0';
  const sign = rounded > 0 ? '+' : '\u2212';
  return sign + Math.abs(rounded);
}

/** For display: ratings are stored precise but read better as whole numbers. */
export function formatRating(rating) {
  if (rating === null || rating === undefined) return '—';
  return String(Math.round(rating));
}
