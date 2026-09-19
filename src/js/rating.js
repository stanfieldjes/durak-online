/**
 * Rating model. Pure, so tests can hold it against the SQL in
 * supabase/schema.sql — the database is what actually applies ratings.
 *
 * Durak has exactly one loser per game, so the rating measures one thing: how
 * likely each player was to end up as that loser. Every game hands out exactly
 * one unit of blame. The durak carries all of it; everyone else carries none.
 * A draw splits it evenly.
 *
 * Expectation comes from the ratings at the table. A weaker player is likelier
 * to be left holding cards, so each seat is weighted by 10^(-rating / SCALE)
 * and the weights are normalised to sum to one. They are taken relative to the
 * strongest rating at the table rather than in absolute terms, which keeps the
 * exponent small and avoids overflow while giving identical ratios. At two
 * players this reduces exactly to the usual logistic pairing.
 *
 *     delta = -K x (actual blame - expected blame)
 *
 * At a table of n equally rated players, expectation is 1/n each:
 *
 *     2 players:  durak -12,     each survivor +12
 *     3 players:  durak -16,     each survivor +8
 *     4 players:  durak -18,     each survivor +6
 *     5 players:  durak -19.2,   each survivor +4.8
 *     6 players:  durak -20,     each survivor +4
 *     7 players:  durak -20.571, each survivor +3.428
 *     8 players:  durak -21,     each survivor +3
 *
 * Being the durak at a bigger table costs more, because the prior against it
 * was longer: an eight-handed table only expected you to lose an eighth of the
 * time. That penalty has to be strictly increasing in table size, and it is
 * the reason changes are kept as decimals rather than whole numbers. Rounding
 * the survivors to integers first and handing the durak the remainder breaks
 * it. In whole numbers the durak's loss would run
 *
 *     2p  3p  4p  5p  6p  7p  8p
 *     12  16  18  20  20  18  21
 *
 * which goes backwards at seven players and stalls between five and six. At
 * seven, six survivors each round 3.43 down to 3 — six roundings all in the
 * same direction, every one of them landing on the same player — so the durak
 * absorbs only -18, less than a five- or six-handed durak pays and no more
 * than a four-handed one.
 *
 * So ratings are stored as numeric(12,6) and deltas are applied exactly.
 * Rounding is a display concern and nothing else: see formatRating.
 *
 * The pool stays zero sum. Deltas are quantised to the six decimal places the
 * database stores, and the durak absorbs whatever that leaves over — the same
 * rule as before, running at a millionth of a point rather than a whole one,
 * far below anything the monotonicity above can notice.
 *
 * K and SCALE pull against each other. K is how much a game is worth; SCALE is
 * how quickly a rating gap turns into a lopsided expectation. Raising K makes
 * results move faster but adds noise; lowering SCALE makes gaps matter more
 * per game but squeezes the ladder into a narrower band, so large gaps stop
 * occurring at all. See README, "Rating".
 */

export const START = 1000;  // everyone opens here
export const SCALE = 400;   // sets how far apart the ladder spreads
export const K = 24;        // most a rating can move in one game
export const FLOOR = 100;   // ratings never go below this

/** Decimal places the database keeps: numeric(12,6). */
export const PRECISION = 6;

/**
 * Multiplier on the durak's loss. 1 keeps the pool zero sum: every point lost
 * is a point somebody else gained. Above 1 the extra is destroyed, so the
 * average rating drifts down over time.
 */
export const LOSS_BIAS = 1;

const QUANTUM = 10 ** PRECISION;

/**
 * Round to the precision the database stores, half away from zero.
 *
 * The `+ 0` at the end turns -0 back into 0. Rounding a small negative number
 * to nothing produces negative zero, which compares equal to zero but prints
 * as "-0" and has no counterpart in a Postgres numeric — so it is normalised
 * here rather than leaking into a delta or a stored rating.
 */
export function quantise(x) {
  const scaled = x * QUANTUM;
  return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / QUANTUM + 0;
}

/** Probability that `rating` finishes ahead of `opponent`, on the SCALE above. */
export function expectedPair(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / SCALE));
}

/**
 * Each seat's expected chance of being the durak, given the ratings at the
 * table. One probability per seat, summing to one.
 */
export function expectedDurakChances(ratings) {
  const n = ratings.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const strongest = Math.max(...ratings);
  const weights = ratings.map((r) => 10 ** ((strongest - r) / SCALE));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

/**
 * What actually happened, on the same scale: 1 for the durak, 0 for everyone
 * else. A draw is nobody's fault, so the blame is spread evenly and each seat
 * carries 1/n — which cancels exactly against expectation when ratings are
 * level, and otherwise nudges toward whoever was expected to lose.
 */
export function actualBlame(n, seat, durakSeat) {
  if (durakSeat === -1 || durakSeat === null || durakSeat === undefined) return 1 / n;
  return seat === durakSeat ? 1 : 0;
}

/**
 * Nudge deltas by one quantum at a time until they sum to zero again, moving
 * whichever entries were quantised furthest from their exact value. Used for
 * draws, where there is no durak to absorb the remainder.
 */
function balanceResidual(deltas, raw) {
  let residual = quantise(deltas.reduce((a, b) => a + b, 0));
  const step = 1 / QUANTUM;
  let guard = 0;
  while (residual !== 0 && guard++ < 100) {
    const dir = residual > 0 ? -step : step;
    let best = 0;
    let bestWant = -Infinity;
    for (let i = 0; i < deltas.length; i++) {
      const want = Math.sign(dir) * (raw[i] - deltas[i]);
      if (want > bestWant) {
        bestWant = want;
        best = i;
      }
    }
    deltas[best] = quantise(deltas[best] + dir);
    residual = quantise(residual + dir);
  }
}

/**
 * Rating changes for one finished game.
 *
 * @param {number[]} ratings   current rating per seat
 * @param {number}   durakSeat seat of the fool, or -1 for a draw
 * @returns {number[]}         change per seat, summing to zero
 */
export function ratingChanges(ratings, durakSeat, lossBias = LOSS_BIAS) {
  const n = ratings.length;
  const chances = expectedDurakChances(ratings);
  const raw = [];

  for (let seat = 0; seat < n; seat++) {
    const actual = actualBlame(n, seat, durakSeat);
    // Being the durak scores 1 against an expectation below 1, so the sign
    // comes out negative for them and positive for everyone else.
    let delta = -K * (actual - chances[seat]);
    if (seat === durakSeat && delta < 0) delta *= lossBias;
    raw.push(delta);
  }

  const deltas = raw.map(quantise);

  if (durakSeat >= 0 && durakSeat < n) {
    // The durak absorbs the quantisation remainder, which suits a game whose
    // whole point is that one player carries the loss. At six decimal places
    // the amount involved is a few millionths of a point.
    let survivors = 0;
    for (let seat = 0; seat < n; seat++) {
      if (seat !== durakSeat) survivors = quantise(survivors + deltas[seat]);
    }
    deltas[durakSeat] = quantise(-survivors);
  } else {
    balanceResidual(deltas, raw);
  }

  // Do not push anyone below the floor. This is the one case where the pool is
  // not zero sum: points are created rather than taken from someone else. From
  // START it takes a run of losses no real player will have, and the
  // alternative — a rating that keeps falling with nothing to climb back
  // from — is worse for a ladder among friends.
  for (let seat = 0; seat < n; seat++) {
    deltas[seat] = quantise(Math.max(FLOOR, ratings[seat] + deltas[seat]) - ratings[seat]);
  }

  return deltas;
}

/**
 * For display: ratings are whole numbers everywhere they are shown. The exact
 * value lives in the database; this is the only place it is rounded.
 */
export function formatRating(rating) {
  if (rating === null || rating === undefined) return '—';
  return String(Math.round(Number(rating)));
}

/**
 * For display: "+6", "+3.4", "−20.6", "0".
 *
 * Deltas keep one decimal place, trailing ".0" trimmed. Rounding them to whole
 * numbers like the ratings would leave a seven-player game showing six
 * survivors at +3 against a durak at −21, three points adrift. One decimal
 * brings that within a quarter of a point, which is close enough not to look
 * broken. It is not exact, and cannot be: no fixed number of decimal places
 * can represent a seventh.
 */
export function formatRatingDelta(delta) {
  if (delta === null || delta === undefined) return '—';
  const n = Math.round(Number(delta) * 10) / 10;
  if (n === 0) return '0';
  const body = Math.abs(n).toFixed(1).replace(/\.0$/, '');
  return (n > 0 ? '+' : '−') + body;
}

