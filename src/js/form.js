/**
 * A player's form: how their last few games went, for the panel that opens
 * while the pointer rests on them.
 *
 * Nothing on a profile row says this, so it is read on demand, the first time
 * somebody's panel opens, and kept for a short while. Running the pointer
 * back and forth over the same few names at a table is then one read per
 * player rather than one per hover. The moment a game ends the whole lot is
 * dropped (forgetForm), since that is exactly when every seat's form changed.
 */
import { listRecentResults } from './db.js';

/** How many games the panel shows. */
export const FORM_GAMES = 5;

/** How long a reading is treated as current. */
const FRESH_MS = 30000;

const cache = new Map();   // player id -> { at, promise }

/**
 * The player's last FORM_GAMES results, newest first: 'out', 'draw' or
 * 'durak'. Fewer when they have not played that many; none when they have
 * played nothing.
 */
export function recentForm(playerId) {
  const held = cache.get(playerId);
  if (held && Date.now() - held.at < FRESH_MS) return held.promise;

  const promise = listRecentResults(playerId, FORM_GAMES);
  const entry = { at: Date.now(), promise };
  cache.set(playerId, entry);
  // A failed read is not kept, so the next hover asks again.
  promise.catch(() => {
    if (cache.get(playerId) === entry) cache.delete(playerId);
  });
  return promise;
}

/** Drop every reading: a game has just finished and moved somebody's form. */
export function forgetForm() {
  cache.clear();
}
