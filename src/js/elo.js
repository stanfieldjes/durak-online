/**
 * Rating model. Pure, so tests can hold it against the SQL in
 * supabase/schema.sql — the database is what actually applies ratings.
 *
 * Durak has exactly one loser per game, so the rating scores one thing: how
 * likely each player was to end up as that loser. Actual outcome is 1 for the
 * durak and 0 for everyone else; expected is the chance the ratings gave them
 * of being the durak. At a table of n equally rated players that chance is
 * exactly 1/n, which is where the lobby-size scaling comes from:
 *
 *   2 players:  1/2 expected  ->  durak −20,  the winner   +20
 *   3 players:  1/3 expected  ->  durak −27,  each survivor +13
 *   4 players:  1/4 expected  ->  durak −30,  each survivor +10
 *
 * Being the durak at a 4-player table is a worse result than at a 2-player
 * table, because you only had a 25% chance of it rather than 50%, so it costs
 * more. The survivors' side falls out of the same arithmetic: the durak's loss
 * is split among more people, so each individual gain is smaller.
 *
 * Both sides always sum to zero — the durak's expected chance and everyone
 * else's add up to 1 by construction, so no points are created or destroyed.
 *
 * Ratings and changes are whole numbers. Rounding each share separately would
 * not add back up, so the survivors take clean numbers and the durak absorbs
 * whatever is left over — which suits a game whose whole point is that one
 * player carries the loss.
 *
 * K and SCALE pull against each other. K is how much a game is worth; SCALE is
 * how quickly a rating gap turns into a lopsided expectation. Raising K makes
 * results move faster but adds noise; lowering SCALE makes gaps matter more
 * per game but squeezes the ladder into a narrower band, so large gaps stop
 * occurring at all. See README, "Rating".
 */

export const START = 500;   // everyone opens here
export const SCALE = 200;   // sets how far apart the ladder spreads
export const K = 40;        // most a rating can move in one game
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
 * Each seat's expected chance of being the durak, given the ratings at the
 * table. Returns one probability per seat, summing to exactly 1.
 *
 * A weaker player is likelier to be left holding cards, so weight each seat by
 * 10^(−rating / SCALE) and normalise. The weights are taken relative to the
 * strongest rating at the table rather than in absolute terms, which keeps the
 * exponent small and avoids overflow at extreme ratings while giving
 * identical ratios.
 *
 * At two players this reduces exactly to the usual logistic pairing, so
 * heads-up results are unchanged from the previous model.
 */
export function expectedDurakChances(ratings) {
  const n = ratings.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const strongest = Math.max(...ratings);
  const weights = ratings.map((r) => Math.pow(10, (strongest - r) / SCALE));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

/**
 * What actually happened, on the same scale: 1 for the durak, 0 for everyone
 * else. A draw is nobody's fault, so the blame is spread evenly and each seat
 * carries 1/n — which cancels exactly against expectation when ratings are
 * level, and otherwise nudges toward whoever was expected to lose.
 */
export function actualDurakScore(n, seat, durakSeat) {
  if (durakSeat === -1 || durakSeat === null) return 1 / n;
  return seat === durakSeat ? 1 : 0;
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
  const chances = expectedDurakChances(ratings);
  const raw = [];

  for (let seat = 0; seat < n; seat++) {
    const expected = chances[seat];
    const actual = actualDurakScore(n, seat, durakSeat);
    // Being the durak scores 1 against an expectation below 1, so the sign
    // comes out negative for them and positive for everyone else.
    let delta = K * (expected - actual);
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
