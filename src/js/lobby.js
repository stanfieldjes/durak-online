import {
  createGame,
  joinGame,
  abandonGame,
  leaveTable,
  listOpenGames,
  listMyGames,
  listActiveGames,
  watchLobby,
} from './db.js';
import { readableError } from './supabase.js';
import { session, scoreOf } from './auth.js';
import { newGame, openSlots } from './durak.js';
import { formatScore } from './score.js';
import { $, show, setText, clear, toast, relativeTime, deltaClass } from './ui.js';

/**
 * How often a visible lobby re-reads the table list on its own. Realtime
 * covers nearly everything; this catches whatever a dropped connection missed.
 */
const LOBBY_POLL_MS = 20000;

let unwatch = null;
let refreshTimer = null;
let pollTimer = null;
let refreshSeq = 0;   // only the newest refresh gets to draw
let myTable = null;   // the waiting table I am sitting at, if any

export function initLobby() {
  $('#create-game').addEventListener('click', onCreate);
  $('#refresh-games').addEventListener('click', refresh);
}

function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 350); // coalesce bursts of row changes
}

/** Back in view or back online: the list may have changed while we were away. */
function onWake() {
  if (document.visibilityState === 'visible') refreshSoon();
}

export function enterLobby() {
  refresh();
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
    const [open, active, mine] = await Promise.all([
      listOpenGames(),
      listActiveGames(session.user.id),
      listMyGames(session.user.id),
    ]);
    if (seq !== refreshSeq) return; // a newer refresh started while this one was out
    renderActive(active);
    renderOpen(open);
    renderHistory(mine);
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

function renderOpen(games) {
  const list = $('#open-games');
  clear(list);

  const mine = games.find((g) => seatedIds(g).includes(session.user.id)) ?? null;
  const others = games.filter((g) => !seatedIds(g).includes(session.user.id));
  myTable = mine;

  renderMyTable(mine);
  show($('#no-games'), others.length === 0);

  for (const game of others) {
    const seated = game.players?.length ?? 0;
    const host = game.players?.find((p) => p.player_id === game.host_id)?.profile;
    const names = (game.players ?? [])
      .filter((p) => p.player_id !== game.host_id)
      .map((p) => p.profile?.username)
      .filter(Boolean);

    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'row__name';
    name.textContent = host?.username ?? 'Someone';

    const meta = document.createElement('span');
    meta.className = 'row__meta';
    meta.textContent = [
      formatScore(scoreOf(host)),
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
    list.append(li);
  }
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

function renderHistory(games) {
  const list = $('#recent-games');
  clear(list);
  show($('#no-history'), games.length === 0);

  for (const game of games) {
    const delta = game.score_delta?.[session.user.id];
    const numeric = delta === undefined || delta === null ? null : Number(delta);
    const opponents = (game.players ?? [])
      .filter((p) => p.player_id !== session.user.id)
      .map((p) => p.profile?.username ?? 'unknown');

    const li = document.createElement('li');

    const outcome = document.createElement('span');
    outcome.className = 'row__name';
    if (!game.durak_id) outcome.textContent = 'Draw';
    else outcome.textContent = game.durak_id === session.user.id ? 'Durak' : 'Got out';

    const meta = document.createElement('span');
    meta.className = 'row__meta';
    meta.textContent = `vs ${opponents.join(', ') || 'nobody'} · ${relativeTime(game.created_at)}`;

    const d = document.createElement('span');
    d.className = `delta ${deltaClass(numeric)}`;
    d.textContent = formatScore(numeric);

    li.append(outcome, meta, d);
    list.append(li);
  }
}
