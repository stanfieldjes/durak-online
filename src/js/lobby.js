import {
  createGame,
  joinGame,
  abandonGame,
  leaveTable,
  listTables,
  listRecentGames,
  listMyTables,
  watchLobby,
  RECENT_PER_PAGE,
} from './db.js';
import { readableError } from './supabase.js';
import { session, ratingOf } from './auth.js';
import { newGame, openSlots } from './durak.js';
import { formatRating } from './rating.js';
import {
  $, show, setText, clear, toast, relativeTime, playerEl, avatarEl, paintDelta,
  attachProfileCard,
} from './ui.js';
import { refreshStandings } from './standing.js';

/**
 * How often a visible lobby re-reads the table list on its own. Realtime
 * covers nearly everything; this catches whatever a dropped connection missed.
 */
const LOBBY_POLL_MS = 20000;

let unwatch = null;
let refreshTimer = null;
let pollTimer = null;
let refreshSeq = 0;   // only the newest refresh gets to draw
let recentSeq = 0;    // the same, for the recent games list
let myTable = null;   // the waiting table I am sitting at, if any
let recentPage = 0;   // which page of finished games is on screen
let recentTotal = 0;

export function initLobby() {
  $('#create-game').addEventListener('click', onCreate);
  $('#recent-prev').addEventListener('click', () => turnTo(recentPage - 1));
  $('#recent-next').addEventListener('click', () => turnTo(recentPage + 1));
}

function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh();
    // Games finishing elsewhere change this list, but only while the reader is
    // looking at the newest page. Somebody paging back through the history
    // should not have the ground move under them.
    if (recentPage === 0) refreshRecent();
  }, 350); // coalesce bursts of row changes
}

/** Back in view or back online: the list may have changed while we were away. */
function onWake() {
  if (document.visibilityState === 'visible') refreshSoon();
}

export function enterLobby() {
  recentPage = 0;
  // A table finishing anywhere can change hands at either end of the ladder,
  // and the host names below are drawn in those colours.
  refreshStandings();
  refresh();
  refreshRecent();
  // Each SUBSCRIBED, including rejoins after a dropped connection, re-reads the
  // list, since realtime does not replay what it missed while disconnected.
  unwatch = watchLobby(refreshSoon, (status) => {
    if (status === 'SUBSCRIBED') refreshSoon();
  });
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, LOBBY_POLL_MS);
}

export function leaveLobby() {
  if (unwatch) unwatch();
  unwatch = null;
  clearTimeout(refreshTimer);
  clearInterval(pollTimer);
  pollTimer = null;
  refreshSeq++; // drop any refresh still in flight
  recentSeq++;
  document.removeEventListener('visibilitychange', onWake);
  window.removeEventListener('online', onWake);
}

async function onCreate(event) {
  // Opening a new table closes the one you host. Only worth asking about when
  // somebody else is already sitting at it.
  const hosting = myTable && myTable.host_id === session.user.id;
  const guests = hosting ? (myTable.players?.length ?? 1) - 1 : 0;
  if (guests > 0) {
    const who = guests === 1 ? 'the player' : `the ${guests} players`;
    if (!confirm(`Opening a new table closes the one you have open and sends ${who} sitting there back to the lobby. Continue?`)) {
      return;
    }
  }

  const btn = event.currentTarget;
  btn.disabled = true;
  setText(btn, 'Opening…');
  try {
    const game = await createGame();
    location.hash = `#/game/${game.id}`;
  } catch (error) {
    toast(readableError(error));
  } finally {
    btn.disabled = false;
    setText(btn, 'Open a table');
  }
}

async function onJoin(game, btn) {
  btn.disabled = true;
  setText(btn, 'Sitting down…');
  try {
    // Taking the last seat means dealing. The seed came from the server, so
    // the only thing we choose is nothing at all.
    const seated = game.players?.length ?? 0;
    const willFill = seated + 1 >= game.max_players;
    const state = willFill ? newGame(Number(game.seed), game.max_players) : null;
    await joinGame(game.id, state);
    location.hash = `#/game/${game.id}`;
  } catch (error) {
    toast(readableError(error));
    btn.disabled = false;
    setText(btn, 'Sit down');
    refresh();
  }
}

/** Close the table I host, or get up from one I joined, without going back to it. */
async function onCloseMine(game, btn) {
  const hosting = game.host_id === session.user.id;
  const guests = (game.players?.length ?? 1) - 1;
  if (hosting && guests > 0) {
    const who = guests === 1 ? 'The player' : `The ${guests} players`;
    if (!confirm(`Close this table? ${who} sitting there will be sent back to the lobby.`)) return;
  }

  btn.disabled = true;
  setText(btn, hosting ? 'Closing…' : 'Leaving…');
  try {
    if (hosting) await abandonGame(game.id);
    else await leaveTable(game.id);
    toast(hosting ? 'Table closed.' : 'You left the table.');
  } catch (error) {
    toast(readableError(error));
  }
  refresh();
}

export async function refresh() {
  if (!session.user) return;
  const seq = ++refreshSeq;
  try {
    const [tables, mine] = await Promise.all([
      listTables(),
      listMyTables(session.user.id),
    ]);
    if (seq !== refreshSeq) return; // a newer refresh started while this one was out
    renderTables(mergeTables(mine, tables));
  } catch (error) {
    if (seq === refreshSeq) toast(readableError(error));
  }
}

const isSeated = (game) => (game.players ?? []).some((p) => p.player_id === session.user.id);

/**
 * One list of every table worth looking at: those still filling up and those
 * being played, yours and everybody else's.
 *
 * Your own come first, so the table you are at is never somewhere down the
 * list, and they are read separately (listMyTables) so one of yours cannot
 * fall off the end of it either. Each table appears once, whichever read it
 * came from.
 */
export function mergeTables(mine, all) {
  const seen = new Set();
  const once = (games) => games.filter((game) => {
    if (!game || seen.has(game.id)) return false;
    seen.add(game.id);
    return true;
  });
  const yours = once([...mine, ...all.filter(isSeated)]);
  const theirs = once(all);
  return [...yours, ...theirs];
}

/**
 * Every table is drawn the same way — who opened it, and one line on how it
 * stands — whether you are sitting at it or not. The buttons are the only
 * thing that tells your tables from anybody else's.
 */
function renderTables(games) {
  const list = $('#open-games');
  clear(list);

  myTable = games.find((g) => g.status === 'waiting' && isSeated(g)) ?? null;
  show($('#no-games'), games.length === 0);

  for (const game of games) list.append(tableRow(game));
}

function tableRow(game) {
  const players = game.players ?? [];
  const playing = game.status === 'active';
  const host = players.find((p) => p.player_id === game.host_id)?.profile ?? null;
  const others = players
    .filter((p) => p.player_id !== game.host_id)
    .map((p) => p.profile?.username)
    .filter(Boolean);

  const li = document.createElement('li');
  // A table being played is marked down the left edge, whoever it belongs to.
  if (playing) li.classList.add('is-live');

  const name = document.createElement('span');
  name.className = 'row__name';
  name.append(playerEl(host, { size: 'sm', fallback: 'Someone' }));

  const meta = document.createElement('span');
  meta.className = 'row__meta';
  meta.textContent = [
    host ? `rated ${formatRating(ratingOf(host))}` : null,
    playing ? 'Playing now' : null,
    playing ? stillIn(game) : `${players.length} of ${game.max_players} seated`,
    others.length ? `with ${others.join(', ')}` : null,
    playing
      ? `last move ${relativeTime(game.updated_at ?? game.created_at)}`
      : `opened ${relativeTime(game.created_at)}`,
  ].filter(Boolean).join(' · ');

  const actions = document.createElement('span');
  actions.className = 'row__actions';
  actions.append(...buttonsFor(game));

  li.append(name, meta, actions);
  return li;
}

/** How many are playing, and how many of them are still holding cards. */
function stillIn(game) {
  const n = game.players?.length ?? 0;
  const out = game.state?.out;
  const left = Array.isArray(out) ? out.filter((isOut) => !isOut).length : n;
  return left === n ? `${n} players` : `${left} of ${n} still in`;
}

/** The one part of a row that depends on whether it is your table. */
function buttonsFor(game) {
  const seated = isSeated(game);

  if (game.status === 'waiting' && !seated) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--primary';
    const filling = (game.players?.length ?? 0) + 1 >= game.max_players;
    btn.textContent = filling ? 'Take the last seat' : 'Sit down';
    btn.addEventListener('click', () => onJoin(game, btn));
    return [btn];
  }

  if (game.status === 'waiting') {
    const hosting = game.host_id === session.user.id;
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'btn btn--quiet';
    leave.textContent = hosting ? 'Close the table' : 'Leave the table';
    leave.addEventListener('click', () => onCloseMine(game, leave));
    return [link(game, 'Go back to it'), leave];
  }

  if (!seated) return [link(game, 'Watch')];

  // Yours and being played. When the table is waiting on you, the button says
  // so and stands out; either way the details are in its tooltip.
  const me = game.players.find((p) => p.player_id === session.user.id);
  const status = statusFor(game.state, me?.seat);
  const rejoin = link(game, status.yourMove ? 'Your move' : 'Rejoin', status.yourMove);
  rejoin.title = status.text;
  return [rejoin];
}

function link(game, text, primary = false) {
  const a = document.createElement('a');
  a.href = `#/game/${game.id}`;
  a.dataset.link = '';
  a.className = primary ? 'btn btn--primary' : 'btn';
  a.textContent = text;
  return a;
}

/** A short line on where you stand at a table, and whether it is waiting on you. */
function statusFor(state, seat) {
  if (!state || seat === undefined) return { text: 'In progress', yourMove: false };
  if (state.out?.[seat]) return { text: 'You are out; the others are still playing', yourMove: false };

  if (seat === state.defender) {
    if (!state.taking && openSlots(state) > 0) return { text: 'Your move: defend', yourMove: true };
    return { text: 'You are defending', yourMove: false };
  }
  if (seat === state.attacker && state.table.length === 0) return { text: 'Your move: attack', yourMove: true };
  return { text: seat === state.attacker ? 'You are attacking' : 'You are throwing in', yourMove: false };
}

/* ------------------------------------------------------------------ */
/* recent games                                                        */
/* ------------------------------------------------------------------ */

function turnTo(page) {
  const lastPage = Math.max(0, Math.ceil(recentTotal / RECENT_PER_PAGE) - 1);
  const next = Math.min(Math.max(0, page), lastPage);
  if (next === recentPage) return;
  recentPage = next;
  refreshRecent();
}

async function refreshRecent() {
  if (!session.user) return;
  const seq = ++recentSeq;
  try {
    const { games, total } = await listRecentGames({ page: recentPage });
    if (seq !== recentSeq) return;

    // Games can be deleted, or the last one on a page can move to the page
    // before while somebody is looking at it. Rather than show an empty list,
    // step back to the last page that has anything on it.
    if (games.length === 0 && total > 0 && recentPage > 0) {
      recentPage = Math.max(0, Math.ceil(total / RECENT_PER_PAGE) - 1);
      refreshRecent();
      return;
    }

    recentTotal = total;
    renderRecent(games);
    renderPager();
  } catch (error) {
    if (seq === recentSeq) toast(readableError(error));
  }
}

/**
 * Every finished game on the site, not only your own: who was left holding
 * the cards, who else was at the table, and what the game did to your rating
 * if you were at it.
 */
function renderRecent(games) {
  const list = $('#recent-games');
  clear(list);
  show($('#no-history'), games.length === 0 && recentTotal === 0);

  for (const game of games) {
    const seats = game.players ?? [];
    const durak = seats.find((p) => p.player_id === game.durak_id)?.profile ?? null;
    const iPlayed = seats.some((p) => p.player_id === session.user.id);
    const raw = game.rating_delta?.[session.user.id];
    const mine = raw === undefined || raw === null ? null : Number(raw);

    const li = document.createElement('li');
    if (game.durak_id === session.user.id) li.classList.add('is-my-loss');
    else if (iPlayed) li.classList.add('is-mine');

    const who = document.createElement('span');
    who.className = 'history__who';
    if (!game.durak_id) {
      const draw = document.createElement('span');
      draw.className = 'history__draw';
      draw.textContent = 'Draw';
      who.append(draw);
    } else {
      // The picture and the name are one hover target, not two: they are one
      // person, and resting on the face of somebody you are trying to place
      // is at least as natural as resting on their name.
      const player = document.createElement('span');
      player.className = 'history__player';
      const name = document.createElement('span');
      name.className = 'history__name';
      name.textContent = game.durak_id === session.user.id
        ? 'You'
        : durak?.username ?? 'Someone';
      player.append(avatarEl(durak, { size: 'sm' }), name);
      attachProfileCard(player, durak);

      const verb = document.createElement('span');
      verb.className = 'history__verb';
      verb.textContent = game.durak_id === session.user.id ? 'were the durak' : 'was the durak';
      who.append(player, verb);
    }

    const others = seats
      .filter((p) => p.player_id !== game.durak_id)
      .map((p) => p.profile?.username ?? 'unknown');

    const meta = document.createElement('span');
    meta.className = 'row__meta history__meta';
    meta.textContent = [
      `${seats.length} players`,
      others.length ? `over ${others.join(', ')}` : null,
      relativeTime(game.updated_at ?? game.created_at),
    ].filter(Boolean).join(' · ');

    const delta = document.createElement('span');
    delta.className = 'delta history__delta';
    if (iPlayed) {
      paintDelta(delta, mine ?? 0);
    } else {
      // You were not at this table, so it did nothing to your rating.
      delta.classList.add('delta--flat');
      delta.textContent = 'n/a';
      delta.title = 'You were not at this table';
    }

    li.append(who, meta, delta);
    list.append(li);
  }
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(recentTotal / RECENT_PER_PAGE));
  show($('#recent-pager'), recentTotal > RECENT_PER_PAGE);
  setText($('#recent-page'), `Page ${recentPage + 1} of ${pages}`);
  $('#recent-prev').disabled = recentPage <= 0;
  $('#recent-next').disabled = recentPage >= pages - 1;
}
