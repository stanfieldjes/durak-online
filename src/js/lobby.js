import {
  createGame,
  joinGame,
  abandonGame,
  leaveTable,
  listTables,
  listRecentGames,
  listActiveGames,
  watchLobby,
  RECENT_PER_PAGE,
} from './db.js';
import { readableError } from './supabase.js';
import { session, ratingOf } from './auth.js';
import { newGame, openSlots } from './durak.js';
import { formatRating } from './rating.js';
import {
  $, show, setText, clear, toast, relativeTime, playerEl, avatarEl, paintDelta,
} from './ui.js';

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
  $('#refresh-games').addEventListener('click', () => { refresh(); refreshRecent(); });
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
    const [tables, active] = await Promise.all([
      listTables(),
      listActiveGames(session.user.id),
    ]);
    if (seq !== refreshSeq) return; // a newer refresh started while this one was out
    renderActive(active);
    renderTables(tables);
  } catch (error) {
    if (seq === refreshSeq) toast(readableError(error));
  }
}

/**
 * Games you are in that are still going, so leaving the page (or closing the
 * tab) never strands you: one click takes you back to the table.
 */
function renderActive(games) {
  const list = $('#active-games');
  clear(list);
  show($('#active-section'), games.length > 0);

  for (const game of games) {
    const me = game.players?.find((p) => p.player_id === session.user.id);
    const state = game.state;
    const opponents = (game.players ?? [])
      .filter((p) => p.player_id !== session.user.id)
      .map((p) => p.profile?.username ?? 'unknown');

    const status = statusFor(state, me?.seat);

    const li = document.createElement('li');
    if (status.yourMove) li.classList.add('is-your-move');

    const name = document.createElement('span');
    name.className = 'row__name';
    name.textContent = `vs ${opponents.join(', ') || 'nobody'}`;

    const meta = document.createElement('span');
    meta.className = 'row__meta';
    meta.textContent = [status.text, `last move ${relativeTime(game.updated_at ?? game.created_at)}`].join(' · ');

    const link = document.createElement('a');
    link.href = `#/game/${game.id}`;
    link.dataset.link = '';
    link.className = status.yourMove ? 'btn btn--primary' : 'btn';
    link.textContent = 'Rejoin';

    li.append(name, meta, link);
    list.append(li);
  }
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

function seatedIds(game) {
  return (game.players ?? []).map((p) => p.player_id);
}

/**
 * Every table worth looking at: those still filling up, which you can sit
 * down at, and those being played right now, which you can watch.
 *
 * Tables you are sitting at yourself are left out — an open one of those is
 * shown on its own above, and a running one under "Your games in progress" —
 * so no table appears twice.
 */
function renderTables(games) {
  const list = $('#open-games');
  clear(list);

  const seated = (game) => seatedIds(game).includes(session.user.id);
  myTable = games.find((g) => g.status === 'waiting' && seated(g)) ?? null;
  const others = games.filter((g) => !seated(g));

  renderMyTable(myTable);
  show($('#no-games'), others.length === 0);

  for (const game of others) {
    list.append(game.status === 'waiting' ? openTableRow(game) : liveTableRow(game));
  }
}

/** A table still filling up: who is there, and a seat to take. */
function openTableRow(game) {
  const seated = game.players?.length ?? 0;
  const host = game.players?.find((p) => p.player_id === game.host_id)?.profile;
  const names = (game.players ?? [])
    .filter((p) => p.player_id !== game.host_id)
    .map((p) => p.profile?.username)
    .filter(Boolean);

  const li = document.createElement('li');

  const name = document.createElement('span');
  name.className = 'row__name';
  name.append(playerEl(host, { size: 'sm', fallback: 'Someone' }));

  const meta = document.createElement('span');
  meta.className = 'row__meta';
  meta.textContent = [
    host ? `rated ${formatRating(ratingOf(host))}` : null,
    `${seated} of ${game.max_players} seated`,
    names.length ? `with ${names.join(', ')}` : null,
    `opened ${relativeTime(game.created_at)}`,
  ].filter(Boolean).join(' · ');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--primary';
  btn.textContent = seated + 1 >= game.max_players ? 'Take the last seat' : 'Sit down';
  btn.addEventListener('click', () => onJoin(game, btn));

  li.append(name, meta, btn);
  return li;
}

/** A table being played: who is at it, and a way in to watch. */
function liveTableRow(game) {
  const names = (game.players ?? []).map((p) => p.profile?.username ?? 'unknown');
  const state = game.state;
  const left = state ? state.out.filter((isOut) => !isOut).length : names.length;

  const li = document.createElement('li');
  li.classList.add('is-live');

  const name = document.createElement('span');
  name.className = 'row__name';
  name.textContent = names.join(', ') || 'A game';

  const meta = document.createElement('span');
  meta.className = 'row__meta';
  meta.textContent = [
    'Playing now',
    left === names.length ? `${names.length} players` : `${left} of ${names.length} still in`,
    `last move ${relativeTime(game.updated_at ?? game.created_at)}`,
  ].join(' · ');

  const link = document.createElement('a');
  link.href = `#/game/${game.id}`;
  link.dataset.link = '';
  link.className = 'btn';
  link.textContent = 'Watch';

  li.append(name, meta, link);
  return li;
}

/** The table I am already sitting at: go back to it, or close / leave it from here. */
function renderMyTable(game) {
  const box = $('#my-open-game');
  clear(box);
  show(box, Boolean(game));
  if (!game) return;

  const hosting = game.host_id === session.user.id;
  const seated = game.players?.length ?? 0;

  const text = document.createElement('span');
  text.textContent = hosting
    ? `Your table is open (${seated} of ${game.max_players} seated).`
    : `You are sitting at a table (${seated} of ${game.max_players} seated).`;

  const link = document.createElement('a');
  link.href = `#/game/${game.id}`;
  link.dataset.link = '';
  link.className = 'btn';
  link.textContent = 'Go back to it';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--quiet';
  btn.textContent = hosting ? 'Close the table' : 'Leave the table';
  btn.addEventListener('click', () => onCloseMine(game, btn));

  box.append(text, link, btn);
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
      who.append(avatarEl(durak, { size: 'sm' }));
      const name = document.createElement('span');
      name.className = 'history__name';
      name.textContent = game.durak_id === session.user.id
        ? 'You'
        : durak?.username ?? 'Someone';
      const verb = document.createElement('span');
      verb.className = 'history__verb';
      verb.textContent = game.durak_id === session.user.id ? 'were the durak' : 'was the durak';
      who.append(name, verb);
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
