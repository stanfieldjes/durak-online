/**
 * Score.
 *
 * A player's score is how much better they do than the table sizes they play
 * would predict, in percentage points. Pure, so tests can hold it against the
 * SQL in supabase/schema.sql — the database is what actually keeps the totals.
 *
 * At a table of n players, one of whom will be the durak, any given player's
 * chance of being it is 1/n. Adding that up across every game gives the number
 * of times they should have been the durak; comparing it to how often they
 * actually were gives the score:
 *
 *     score = (expected durak rate − actual durak rate) × 100
 *
 * Worked through the way it accumulates: seven games — two at two players,
 * one at three, four at four — expects
 *
 *     (2 × 1/2  +  1 × 1/3  +  4 × 1/4) / 7  =  2.333 / 7  =  33%
 *
 * A player who was actually the durak 30% of the time scores +3. One who was
 * the durak 48% of the time scores −15.
 *
 * Positive is good: it means being the fool less often than the tables you sat
 * at would predict. Playing bigger tables raises the bar rather than lowering
 * it, because a 4-player table only expects you to lose a quarter of the time.
 */

/** A seat's share of the blame at a table of `playerCount`. */
export function expectedDurakChance(playerCount) {
  const n = Number(playerCount);
  return n > 0 ? 1 / n : 0;
}

/**
 * @param {{ games: number, duraks: number, expectedDuraks: number }} record
 * @returns {number|null} whole percentage points, or null with no games played
 */
export function computeScore({ games, duraks, expectedDuraks }) {
  const played = Number(games) || 0;
  if (played <= 0) return null;
  const points = (100 * (Number(expectedDuraks) - Number(duraks))) / played;
  // Half away from zero, matching Postgres round() on numerics.
  return Math.sign(points) * Math.round(Math.abs(points));
}

/** Percentage of games ended as the durak. */
export function durakRate({ games, duraks }) {
  const played = Number(games) || 0;
  if (played <= 0) return null;
  return (100 * Number(duraks)) / played;
}

/** Percentage of games the table sizes expected them to be the durak. */
export function expectedRate({ games, expectedDuraks }) {
  const played = Number(games) || 0;
  if (played <= 0) return null;
  return (100 * Number(expectedDuraks)) / played;
}

/** For display: "+3", "−15", "0". */
export function formatScore(score) {
  if (score === null || score === undefined) return '—';
  const n = Math.round(Number(score));
  if (n === 0) return '0';
  return (n > 0 ? '+' : '\u2212') + Math.abs(n);
}

/** For display: "33%". */
export function formatRate(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(Number(rate))}%`;
}
