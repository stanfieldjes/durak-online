import {
  createGame,
  joinGame,
  abandonGame,
  leaveTable,
  listTables,
  listRecentGames,
  listMyTables,
  watchLobby,
  RECENT_BATCH,
} from './db.js';
import { readableError } from './supabase.js';
import { session, ratingOf } from './auth.js';
import { newGame, openSlots } from './durak.js';
import { formatRating } from './rating.js';
import {
  $, show, setText, clear, toast, relativeTime, playerEl, avatarEl, paintDelta,
  attachProfileCard, attachHoverCard,
} from './ui.js';
import { refreshStandings } from './standing.js';
import { playerList, onPlayersChange, refreshPlayers } from './presence.js';

/**
 * How often a visible lobby re-reads the table list on its own. Realtime
 * covers nearly everything; this catches whatever a dropped connection missed.
 */
const LOBBY_POLL_MS = 20000;

/**
 * Older games are read once the history is scrolled to within this many
 * rows of the bottom, so the next ones are usually there before they are
 * reached.
 */
const RECENT_LOOKAHEAD_ROWS = 4;

let unwatch = null;
let unwatchPlayers = null;
let playersTimer = null;
let playerTimes = [];   // offline captions, retimed in place: { el, at }
let refreshTimer = null;
let pollTimer = null;
let refreshSeq = 0;   // only the newest refresh gets to draw
let myTable = null;   // the waiting table I am sitting at, if any

// The history list. Rows are added at either end and never redrawn wholesale,
// which is what keeps the reader's place in it while it grows.
let recentGames = [];           // on screen, newest first
const recentRows = new Map();   // game id -> { li, time, at }
let recentDone = false;         // nothing older left to read
let loadingOlder = false;
let recentEpoch = 0;            // bumped on reset, so late reads are dropped
let recentSeq = 0;              // only the newest refresh gets to draw

export function initLobby() {
  $('#create-game').addEventListener('click', onCreate);
  $('#recent-games').addEventListener('scroll', maybeLoadOlder, { passive: true });
}

/**
 * Re-read the lobby, a moment after whatever prompted it, so a burst of
 * changes is one read.
 *
 * The tables are re-read every time: a move anywhere changes how a running
 * table stands. The history and the players are re-read only when a game has
 * finished, or when the lobby may have missed something (back in view, back
 * online, a dropped connection) — a move changes neither, and moves arrive
 * every second or two while anybody is playing. Re-reading both on each one
 * is what made the lobby slow on a phone.
 */
let refreshEverything = false;

function refreshSoon(everything = false) {
  if (everything) refreshEverything = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const all = refreshEverything;
    refreshEverything = false;
    refresh();
    if (!all) return;
    // A game finishing moves ratings, which the players' panels show.
    refreshPlayers();
    // Games finishing elsewhere arrive at the top of the history. Somebody
    // scrolled down through it keeps their place (refreshRecent).
    refreshRecent();
  }, 350); // coalesce bursts of row changes
}

/** A row changed somewhere. Only a game reaching its end touches the history. */
function onLobbyChange(payload) {
  refreshSoon(payload?.table === 'games' && payload?.new?.status === 'finished');
}

/** Back in view or back online: anything may have changed while we were away. */
function onWake() {
  if (document.visibilityState === 'visible') refreshSoon(true);
}

export function enterLobby() {
  resetRecent();
  // A table finishing anywhere can change hands at either end of the ladder,
  // and the host names below are drawn in those colours.
  refreshStandings();
  refresh();
  refreshRecent();
  renderPlayers(playerList());
  unwatchPlayers = onPlayersChange(renderPlayers);
  refreshPlayers();
  // "3m ago" has to become "4m ago" without anything else happening.
  playersTimer = setInterval(retimePlayers, 30000);
  // Realtime does not replay what it missed while disconnected, so every
  // rejoin re-reads everything. The first SUBSCRIBED only has the moment
  // since the reads above to cover, which is the tables' business alone:
  // re-reading the history and the players then as well read each of them
  // twice on the way into the lobby.
  let subscribedBefore = false;
  unwatch = watchLobby(onLobbyChange, (status) => {
    if (status !== 'SUBSCRIBED') return;
    refreshSoon(subscribedBefore);
    subscribedBefore = true;
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
  if (unwatchPlayers) unwatchPlayers();
  unwatchPlayers = null;
  clearInterval(playersTimer);
  playersTimer = null;
  clearTimeout(refreshTimer);
  refreshEverything = false;
  clearInterval(pollTimer);
  pollTimer = null;
  refreshSeq++; // drop any refresh still in flight
  recentEpoch++;
  document.removeEventListener('visibilitychange', onWake);
  window.removeEventListener('online', onWake);
}

/* ------------------------------------------------------------------ */
/* players                                                             */
/* ------------------------------------------------------------------ */

/**
 * Everybody, as a row of pictures: who is online on the left, then everyone
 * else, most recently seen first, under a caption saying how long ago that
 * was — written the same way as the times in the history. No names: resting
 * on a picture opens the same panel as anywhere else on the site, which has
 * the name, the rating and their last five games.
 */
function renderPlayers({ online, offline }) {
  const list = $('#players');
  if (!list) return;
  clear(list);
  playerTimes = [];

  for (const profile of online) list.append(playerTile(profile, true));
  if (online.length && offline.length) {
    const rule = document.createElement('li');
    rule.className = 'players__rule';
    rule.setAttribute('aria-hidden', 'true');
    list.append(rule);
  }
  for (const profile of offline) list.append(playerTile(profile, false));
}

function playerTile(profile, online) {
  const li = document.createElement('li');
  li.className = online ? 'players__item is-online' : 'players__item';

  const face = document.createElement('span');
  face.className = 'players__face';
  face.setAttribute('role', 'img');
  face.append(avatarEl(profile, { size: 'md' }));
  attachProfileCard(face, profile);

  const when = document.createElement('span');
  when.className = 'players__when';
  const name = profile.username ?? 'unknown';
  if (online) {
    when.textContent = 'online';
    face.setAttribute('aria-label', `${name}, online`);
  } else if (profile.last_seen_at) {
    when.textContent = relativeTime(profile.last_seen_at);
    face.setAttribute('aria-label', `${name}, last online ${when.textContent}`);
    playerTimes.push({ el: when, face, name, at: profile.last_seen_at });
  } else {
    when.textContent = '—';
    face.setAttribute('aria-label', name);
  }

  li.append(face, when);
  return li;
}

/** Bring every "last online" caption up to date, without redrawing a thing. */
function retimePlayers() {
  for (const { el, face, name, at } of playerTimes) {
    el.textContent = relativeTime(at);
    face.setAttribute('aria-label', `${name}, last online ${el.textContent}`);
  }
}

/* ------------------------------------------------------------------ */
/* tables                                                              */
/* ------------------------------------------------------------------ */

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

/**
 * Every finished game on the site, not only your own, newest first, in one
 * list that shows ten and scrolls. The first read fills it; older games are
 * read as the reader scrolls toward the bottom (maybeLoadOlder), and games
 * finishing elsewhere are added at the top (refreshRecent).
 *
 * A row is the faces of who was at the table and how long ago it ended,
 * nothing else, so every row lines up with every other. The durak comes first
 * and is ringed in red, which puts the loser of every game in the same place
 * down the list. Resting on a row opens a panel with the result and what the
 * game did to each player's rating.
 */

/** Empty the list, ready for a fresh first read. */
function resetRecent() {
  recentEpoch++;
  recentSeq++;
  recentGames = [];
  recentRows.clear();
  recentDone = false;
  loadingOlder = false;
  const list = $('#recent-games');
  clear(list);
  list.scrollTop = 0;
  show($('#no-history'), false);
}

/**
 * Read the newest games and put any that are not on screen yet at the top.
 *
 * Nothing already there is redrawn, so a row being hovered stays put. If the
 * reader has scrolled down, the list is moved by exactly the height that was
 * added above them, so what they were looking at does not jump. Every row's
 * "3m ago" is brought up to date on the way through.
 */
async function refreshRecent() {
  if (!session.user) return;
  const seq = ++recentSeq;
  const epoch = recentEpoch;
  try {
    const games = await listRecentGames();
    if (seq !== recentSeq || epoch !== recentEpoch) return;

    if (recentGames.length === 0) {
      appendRecent(games);
      recentDone = games.length < RECENT_BATCH;
      show($('#no-history'), games.length === 0);
      maybeLoadOlder();
      return;
    }

    const fresh = games.filter((game) => !recentRows.has(game.id));
    // A whole batch of games nobody has seen means more finished while the
    // list was away than one read can bridge. Rather than leave a hole in the
    // middle of the history, start it again from the top.
    if (fresh.length === RECENT_BATCH) {
      resetRecent();
      refreshRecent();
      return;
    }

    prependRecent(fresh.filter((game) => endedAt(game) > endedAt(recentGames[0])));
    retimeRecent();
  } catch (error) {
    if (seq === recentSeq) toast(readableError(error));
  }
}

/** Read the next older games once the reader is near the bottom of the list. */
function maybeLoadOlder() {
  const list = $('#recent-games');
  if (!list || loadingOlder || recentDone || recentGames.length === 0) return;
  const row = list.firstElementChild?.offsetHeight || 44;
  const left = list.scrollHeight - list.scrollTop - list.clientHeight;
  if (left <= row * RECENT_LOOKAHEAD_ROWS) loadOlder();
}

async function loadOlder() {
  const epoch = recentEpoch;
  loadingOlder = true;
  try {
    const oldest = recentGames[recentGames.length - 1];
    const games = await listRecentGames({ before: endedAt(oldest) });
    if (epoch !== recentEpoch) return;   // reset or left while this was out
    appendRecent(games.filter((game) => !recentRows.has(game.id)));
    recentDone = games.length < RECENT_BATCH;
  } catch (error) {
    if (epoch === recentEpoch) toast(readableError(error));
  } finally {
    if (epoch === recentEpoch) loadingOlder = false;
  }
  // Still near the bottom (a tall screen, or a fast flick): keep going.
  if (epoch === recentEpoch) maybeLoadOlder();
}

function endedAt(game) {
  return game?.updated_at ?? game?.created_at;
}

function appendRecent(games) {
  const list = $('#recent-games');
  for (const game of games) {
    recentGames.push(game);
    list.append(historyRow(game));
  }
}

function prependRecent(games) {
  if (games.length === 0) return;
  const list = $('#recent-games');
  const before = list.scrollHeight;
  recentGames = [...games, ...recentGames];
  list.prepend(...games.map(historyRow));
  if (list.scrollTop > 0) list.scrollTop += list.scrollHeight - before;
}

/** Bring every row's "3m ago" up to date. */
function retimeRecent() {
  for (const { time, at } of recentRows.values()) time.textContent = relativeTime(at);
}

/** The durak first, then everyone else in seat order. */
function facesInOrder(game) {
  const seats = game.players ?? [];
  const durak = seats.filter((p) => p.player_id === game.durak_id);
  const rest = seats.filter((p) => p.player_id !== game.durak_id);
  return [...durak, ...rest];
}

function nameOf(seat) {
  return seat?.profile?.username ?? 'unknown';
}

function historyRow(game) {
  const me = session.user.id;
  const seats = game.players ?? [];
  const iPlayed = seats.some((p) => p.player_id === me);
  const at = game.updated_at ?? game.created_at;

  const li = document.createElement('li');
  // Your own games are still marked down the left edge: green if you got out,
  // red if you were the durak.
  if (game.durak_id === me) li.classList.add('is-my-loss');
  else if (iPlayed) li.classList.add('is-mine');

  const faces = document.createElement('span');
  faces.className = 'history__faces';
  for (const seat of facesInOrder(game)) {
    const face = avatarEl(seat.profile, { size: 'sm' });
    if (seat.player_id === game.durak_id) face.classList.add('is-durak');
    faces.append(face);
  }

  const when = document.createElement('time');
  when.className = 'history__time';
  when.dateTime = at;
  when.textContent = relativeTime(at);

  li.append(faces, when);
  recentRows.set(game.id, { li, time: when, at });
  li.setAttribute('aria-label', describeGame(game));
  attachHoverCard(li, (panel) => fillGameCard(panel, game));
  return li;
}

/** The whole row in words, for a screen reader: the faces carry no names. */
function describeGame(game) {
  const seats = game.players ?? [];
  const at = relativeTime(game.updated_at ?? game.created_at);
  if (!game.durak_id) return `Draw between ${seats.map(nameOf).join(', ')}, ${at}`;
  const durak = seats.find((p) => p.player_id === game.durak_id);
  const others = seats.filter((p) => p.player_id !== game.durak_id).map(nameOf);
  const who = game.durak_id === session.user.id ? 'You were' : `${nameOf(durak)} was`;
  return `${who} the durak, with ${others.join(', ')}, ${at}`;
}

/** "Sep 26, 9:14 PM" in the reader's own way of writing it. */
function whenExactly(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The panel for one finished game: when it ended, and a line per player
 * with what the game did to their rating — best off at the top, the durak
 * at the bottom in red, the way the result screen reads.
 */
function fillGameCard(panel, game) {
  panel.classList.add('pcard--game');
  const me = session.user.id;
  const deltas = game.rating_delta ?? {};
  const deltaOf = (seat) => {
    const raw = deltas[seat.player_id];
    return raw === undefined || raw === null ? null : Number(raw);
  };

  // Only when it ended. Who the durak was is already on the panel, in bold
  // red at the bottom.
  const head = document.createElement('div');
  head.className = 'pcard__head';

  const when = document.createElement('span');
  when.className = 'pcard__when';
  when.textContent = whenExactly(game.updated_at ?? game.created_at);

  head.append(when);

  const rows = document.createElement('ul');
  rows.className = 'pcard__results';

  const ordered = [...(game.players ?? [])].sort((a, b) => {
    const aDurak = a.player_id === game.durak_id;
    const bDurak = b.player_id === game.durak_id;
    if (aDurak !== bDurak) return aDurak ? 1 : -1;
    return (deltaOf(b) ?? 0) - (deltaOf(a) ?? 0) || a.seat - b.seat;
  });

  for (const seat of ordered) {
    const row = document.createElement('li');
    row.className = 'pcard__result';
    if (seat.player_id === game.durak_id) row.classList.add('is-durak');
    if (seat.player_id === me) row.classList.add('is-me');

    const name = document.createElement('span');
    name.className = 'pcard__result-name';
    name.textContent = nameOf(seat);

    const change = document.createElement('span');
    change.className = 'delta pcard__result-delta';
    const delta = deltaOf(seat);
    if (delta === null) {
      change.classList.add('delta--flat');
      change.textContent = '–';
    } else {
      paintDelta(change, delta);
    }

    row.append(avatarEl(seat.profile, { size: 'xs' }), name, change);
    rows.append(row);
  }

  panel.append(head, rows);
}