/**
 * Who is on the site right now, and when everybody else last was — the
 * lobby's Players section.
 *
 * Two sources, because they answer different questions:
 *
 * - Online is Realtime Presence. Every signed-in browser announces itself on
 *   one channel for as long as the page is open, on any view — a player at a
 *   table is as online as one in the lobby — and the server drops anyone
 *   whose connection goes. It is exact and instant, and it forgets everything
 *   the moment somebody leaves.
 * - Last online is `profiles.last_seen_at`, which that same open page moves to
 *   now once a minute (HEARTBEAT_MS). Presence cannot say when somebody left;
 *   this can, to within a minute.
 *
 * A tab left in the background stops counting as online after IDLE_MS and
 * stops moving its last-seen time; both start again the moment it is looked
 * at. It keeps watching the whole time, so the list is already right when it
 * comes back.
 *
 * Names, pictures and ratings come from the profiles, read fresh whenever the
 * set of people online changes and whenever the lobby asks, so a panel shows
 * the rating as it is now rather than as it was when somebody arrived.
 */
import { joinPresence, getPlayers, touchLastSeen } from './db.js';

const IDLE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const FETCH_DELAY_MS = 250;   // people arriving together are read together

let presence = null;
let me = null;
let tracked = false;          // counted as online by this browser's own say-so
let onlineIds = new Set();
let everyone = [];            // every profile, from the last read
let split = { online: [], offline: [] };
let fetchSeq = 0;
let fetchTimer = null;
let idleTimer = null;
let heartbeat = null;
const listeners = new Set();

/** Start announcing this player. Calling it again for the same player does nothing. */
export function startPresence(userId) {
  if (presence && me === userId) return;
  stopPresence();
  me = userId;
  tracked = true;
  presence = joinPresence(userId, onSync);
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', touch);
  startHeartbeat();
  scheduleFetch(0);
}

export function stopPresence() {
  clearTimeout(idleTimer);
  clearTimeout(fetchTimer);
  stopHeartbeat();
  fetchSeq++;
  document.removeEventListener('visibilitychange', onVisibility);
  removeEventListener('pagehide', touch);
  if (presence) presence.leave();
  presence = null;
  me = null;
  tracked = false;
  onlineIds = new Set();
  everyone = [];
  publish();
}

/**
 * Everybody, in two groups: `online` best rated first, and `offline` most
 * recently seen first, each row carrying `last_seen_at`.
 */
export function playerList() {
  return split;
}

/** Hear every change to the list. Returns a function that stops listening. */
export function onPlayersChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-read the profiles behind the list, for ratings and times that moved since. */
export function refreshPlayers() {
  if (presence) scheduleFetch(0);
}

/* ---------------- presence ---------------- */

function onSync(ids) {
  onlineIds = new Set(ids);
  // Regroup straight away with what is known, then read again: somebody who
  // just left has a newer last-seen time than the one on screen, and somebody
  // who just signed up is not in the list at all yet.
  publish();
  scheduleFetch(FETCH_DELAY_MS);
}

function onVisibility() {
  clearTimeout(idleTimer);
  if (!presence) return;
  if (document.visibilityState === 'visible') {
    tracked = true;
    presence.track();
    startHeartbeat();
    publish();
  } else {
    // Leaving the tab is itself a moment the player was here.
    touch();
    idleTimer = setTimeout(() => {
      tracked = false;
      stopHeartbeat();
      presence?.untrack();
      publish();
    }, IDLE_MS);
  }
}

/* ---------------- last seen ---------------- */

function touch() {
  if (me) touchLastSeen().catch(() => {});   // a missed minute is not worth a toast
}

function startHeartbeat() {
  stopHeartbeat();
  touch();
  heartbeat = setInterval(touch, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = null;
}

/* ---------------- the list ---------------- */

function scheduleFetch(delay) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(load, delay);
}

async function load() {
  const seq = ++fetchSeq;
  try {
    const rows = await getPlayers();
    if (seq !== fetchSeq) return;   // something changed again while this was out
    everyone = rows;
    publish();
  } catch {
    // The list keeps what it had. The next change reads again.
  }
}

/**
 * Online is whoever presence lists, and always you while this page counts
 * you: presence takes a moment to report back after joining, and you should
 * not start out on the offline side of your own lobby.
 */
function isOnline(id) {
  return onlineIds.has(id) || (tracked && id === me);
}

function publish() {
  const online = everyone.filter((p) => isOnline(p.id)).sort(byRating);
  const offline = everyone.filter((p) => !isOnline(p.id)).sort(byLastSeen);
  split = { online, offline };
  for (const listener of listeners) listener(split);
}

/** Best rated first, then by name, so the order holds still between reads. */
function byRating(a, b) {
  return (Number(b.rating) || 0) - (Number(a.rating) || 0)
    || String(a.username).localeCompare(String(b.username));
}

/** Most recently seen first; anybody with no time at all goes last. */
function byLastSeen(a, b) {
  const at = (p) => (p.last_seen_at ? Date.parse(p.last_seen_at) : -Infinity);
  return at(b) - at(a) || String(a.username).localeCompare(String(b.username));
}