/**
 * Who is top of the ladder.
 *
 * The leaderboard works this out for its own table, but a name is shown all
 * over the site — at the table, in the lobby, on the panel that follows the
 * pointer — and none of those places know anything about the standings of
 * players who are not in front of them. So the lead is read once and kept
 * here, where anything drawing a name can ask.
 *
 * Nothing is stored on a profile. The lead is derived from the ratings every
 * time this is refreshed, so it moves as results come in rather than having
 * to be maintained.
 */
import { getLeaderboard } from './db.js';

/** Ids, not one id: a tie at the top belongs to everyone in it. */
let top = new Set();

let read = 0;

/**
 * How long a reading is treated as current. Every view that draws a name
 * asks on the way in, and with eight players a game finishing anywhere is
 * worth picking up quickly — but not once per table in the lobby list.
 */
const FRESH_MS = 15000;

export const isTop = (id) => Boolean(id) && top.has(id);

/**
 * The rating as the page prints it. Must round the way formatRating does, or
 * two players shown the same number would be ordered by a difference nobody
 * can see.
 */
const shownRating = (row) => Math.round(Number(row?.rating ?? 0));

/**
 * The order the ladder is read in: the rating as it is shown, and then games
 * played.
 *
 * Ratings are compared rounded rather than exact because that is the figure
 * on the page — being placed above somebody over a hundredth of a point that
 * is displayed nowhere is not a placing anyone can check. That makes ties on
 * the visible number common, so games played settles them: the same rating
 * off more games is the better-established one.
 *
 * Note this is not the order the `leaderboard` view returns, which sorts on
 * the exact rating and so can put 1003.4-off-5-games above 1003.2-off-20.
 * Rows are sorted through here before they are placed or drawn.
 */
export function compareRank(a, b) {
  return (shownRating(b) - shownRating(a)) || ((b?.games ?? 0) - (a?.games ?? 0));
}

/** Leaderboard rows in ladder order. Does not disturb the array it is given. */
export const rankRows = (rows) => [...(rows ?? [])].sort(compareRank);

/**
 * Two players the ladder genuinely cannot separate: same rating on the page,
 * same number of games behind it. They share a place, and the gold with it —
 * there is nothing left to tell them apart by that anyone could check.
 */
export const rankTied = (a, b) => compareRank(a, b) === 0;

/**
 * Work out the lead from rows already in hand, so the leaderboard — which has
 * just fetched exactly this — does not send for them a second time.
 *
 * Nobody leads a table of one, or a table where every player is level on both
 * counts: there is no lead to hold.
 */
export function setStandings(rows) {
  top = new Set();
  read = Date.now();
  if (!Array.isArray(rows) || rows.length < 2) return;

  const ordered = rankRows(rows);
  const best = ordered[0];
  if (rankTied(best, ordered[ordered.length - 1])) return;

  for (const row of ordered) {
    if (!rankTied(row, best)) break;   // sorted, so the rest are below too
    top.add(row.id);
  }
}

/**
 * Re-read the ladder, unless it was read a moment ago.
 *
 * Only ever decides a colour, so a failure is swallowed: a name in the
 * ordinary ink is a fine outcome, and a toast about it would be noise in the
 * middle of a game. `force` is for the moment a game ends, when the standings
 * have just changed and the answer from ten seconds ago is the stale one.
 */
export async function refreshStandings({ force = false } = {}) {
  if (!force && Date.now() - read < FRESH_MS) return;
  try {
    setStandings(await getLeaderboard());
  } catch {
    read = Date.now();   // do not retry on every render
  }
}
