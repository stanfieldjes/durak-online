/**
 * Who is top of the ladder and who is bottom.
 *
 * The leaderboard works this out for its own table, but a name is shown all
 * over the site — at the table, in the lobby, on the panel that follows the
 * pointer — and none of those places know anything about the standings of
 * players who are not in front of them. So the ends of the ladder are read
 * once and kept here, where anything drawing a name can ask.
 *
 * Nothing is stored on a profile. The ends are derived from the ratings every
 * time this is refreshed, so they move as results come in rather than having
 * to be maintained.
 */
import { getLeaderboard } from './db.js';
import { formatRating } from './rating.js';

/** Ids, not one id: a tie at either end belongs to everyone in it. */
let top = new Set();
let bottom = new Set();

let read = 0;

/**
 * How long a reading is treated as current. Every view that draws a name
 * asks on the way in, and with eight players a game finishing anywhere is
 * worth picking up quickly — but not once per table in the lobby list.
 */
const FRESH_MS = 15000;

export const isTop = (id) => Boolean(id) && top.has(id);
export const isBottom = (id) => Boolean(id) && bottom.has(id);

/**
 * Work out the ends from rows already in hand, so the leaderboard — which has
 * just fetched exactly this — does not send for them a second time.
 *
 * Compared on the rounded figure rather than the exact one, which is what the
 * place numbers beside them use: two players shown as 1013 are level as far
 * as anyone reading the table can tell, and it would be strange for one of
 * them to be gold over a difference nothing on the page displays.
 *
 * Nobody is at either end of a table of one, or of a table where everyone is
 * level — there is no lead to hold. `rows` arrives ordered by rating, best
 * first, which is how the leaderboard view is defined.
 */
export function setStandings(rows) {
  top = new Set();
  bottom = new Set();
  read = Date.now();
  if (!Array.isArray(rows) || rows.length < 2) return;

  const shown = (row) => formatRating(row.rating);
  const best = shown(rows[0]);
  const worst = shown(rows[rows.length - 1]);
  if (best === worst) return;

  for (const row of rows) {
    if (shown(row) === best) top.add(row.id);
    else if (shown(row) === worst) bottom.add(row.id);
  }
}

/**
 * Re-read the ladder, unless it was read a moment ago.
 *
 * Only ever decides a colour, so a failure is swallowed: a name in the
 * ordinary ink is a fine outcome, and a toast about it would be noise in the
 * middle of a game. `force` is for the moment a game ends, when the standings
 * have just changed and the answer from ten seconds ago is the stale one.
 *
 * The bottom is the bottom of the leaderboard as it is shown, which is capped
 * at the same number of rows the page lists.
 */
export async function refreshStandings({ force = false } = {}) {
  if (!force && Date.now() - read < FRESH_MS) return;
  try {
    setStandings(await getLeaderboard());
  } catch {
    read = Date.now();   // do not retry on every render
  }
}
