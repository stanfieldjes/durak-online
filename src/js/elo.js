/**
 * Rating model. Pure, so tests can hold it against the SQL in
 * supabase/schema.sql — the database is what actually applies ratings.
 *
 * Durak has exactly one loser: the durak. Everyone else got out. That maps
 * onto a rating where losing hurts and winning is a modest bonus, because the
 * points the durak drops are split among all the survivors.
 *
 *   4 players, all rated equally:  durak −6,  each survivor +2
 *   3 players, all rated equally:  durak −6,  each survivor +3
 *   2 players, all rated equally:  durak −5,  the winner   +5
 *
 * Ratings and changes are whole numbers. Rounding each share separately would
 * not add back up, so the survivors take clean numbers and the durak absorbs
 * whatever is left over — which suits a game whose whole point is that one
 * player carries the loss.
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

/** Half away from zero, matching Postgres `round()` on numerics. */
export function roundHalfAway(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Nudge whole-number deltas until they sum to zero again, moving whichever
 * entries were rounded furthest from their exact value. Used for draws, where
 * there is no durak to absorb the remainder.
 */
function balanceResidual(deltas, raw) {
  let residual = deltas.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (residual !== 0 && guard++ < 100) {
    const step = residual > 0 ? -1 : 1;
    let best = 0;
    let bestWant = -Infinity;
    for (let i = 0; i < deltas.length; i++) {
      const want = step * (raw[i] - deltas[i]);
      if (want > bestWant) {
        bestWant = want;
        best = i;
      }
    }
    deltas[best] += step;
    residual += step;
  }
}

/**
 * Rating changes for one finished game.
 *
 * @param {number[]} ratings   current rating per seat
 * @param {number}   durakSeat seat of the fool, or -1 for a draw
 * @returns {number[]}         whole-number change per seat, summing to zero
 */
export function ratingChanges(ratings, durakSeat, lossBias = LOSS_BIAS) {
  const n = ratings.length;
  const raw = [];

  for (let seat = 0; seat < n; seat++) {
    const expected = expectedScore(ratings, seat);
    const actual = actualScore(n, seat, durakSeat);
    let delta = K * (actual - expected);
    if (seat === durakSeat && delta < 0) delta *= lossBias;
    raw.push(delta);
  }

  const deltas = raw.map(roundHalfAway);

  if (durakSeat >= 0 && durakSeat < n) {
    let survivors = 0;
    for (let seat = 0; seat < n; seat++) if (seat !== durakSeat) survivors += deltas[seat];
    deltas[durakSeat] = -survivors;
  } else {
    balanceResidual(deltas, raw);
  }

  // Do not push anyone below the floor.
  for (let seat = 0; seat < n; seat++) {
    deltas[seat] = Math.max(FLOOR, ratings[seat] + deltas[seat]) - ratings[seat];
  }

  return deltas;
}

/** For display: "+2", "−6", "0". */
export function formatRatingDelta(delta) {
  if (delta === null || delta === undefined) return '—';
  const n = Math.round(Number(delta));
  if (n === 0) return '0';
  return (n > 0 ? '+' : '\u2212') + Math.abs(n);
}

export function formatRating(rating) {
  if (rating === null || rating === undefined) return '—';
  return String(Math.round(Number(rating)));
}

/** For display: "24%" of games ended with this player holding the cards. */
export function formatDurakRate(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(Number(rate))}%`;
}
