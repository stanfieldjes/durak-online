import {
  createGame,
  joinGame,
  listOpenGames,
  listMyGames,
  watchLobby,
} from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { newGame } from './durak.js';
import { formatScore } from './score.js';
import { scoreOf } from './auth.js';
import { CONFIG } from './config.js';
import { $, $$, show, setText, clear, toast, relativeTime, deltaClass } from './ui.js';

let unwatch = null;
let refreshTimer = null;

export function initLobby() {
  $('#create-game').addEventListener('click', onCreate);
  $('#refresh-games').addEventListener('click', refresh);

  const preferred = String(CONFIG.defaultPlayers ?? 4);
  const radio = $(`.seats-picker input[value="${preferred}"]`);
  if (radio) radio.checked = true;
}

export function enterLobby() {
  refresh();
  unwatch = watchLobby(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 350); // coalesce bursts of row changes
  });
}

export function leaveLobby() {
  if (unwatch) unwatch();
  unwatch = null;
  clearTimeout(refreshTimer);
}

function chosenSeats() {
  const picked = $$('.seats-picker input').find((r) => r.checked);
  return picked ? Number(picked.value) : 4;
}

async function onCreate(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  setText(btn, 'Opening…');
  try {
    const game = await createGame(chosenSeats());
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

export async function refresh() {
  if (!session.user) return;
  try {
    const [open, mine] = await Promise.all([listOpenGames(), listMyGames(session.user.id)]);
    renderOpen(open);
    renderHistory(mine);
  } catch (error) {
    toast(readableError(error));
  }
}

function seatedIds(game) {
  return (game.players ?? []).map((p) => p.player_id);
}

function renderOpen(games) {
  const list = $('#open-games');
  clear(list);

  const mine = games.find((g) => seatedIds(g).includes(session.user.id));
  const others = games.filter((g) => !seatedIds(g).includes(session.user.id));

  const notice = $('#my-open-game');
  if (mine) {
    clear(notice);
    const link = document.createElement('a');
    link.href = `#/game/${mine.id}`;
    link.dataset.link = '';
    link.textContent = 'Go back to it';
    notice.append(
      `You are already at a table (${mine.players.length} of ${mine.max_players} seated). `,
      link,
      '.'
    );
  }
  show(notice, Boolean(mine));
  show($('#no-games'), others.length === 0);

  for (const game of others) {
    const seated = game.players?.length ?? 0;
    const host = game.players?.find((p) => p.player_id === game.host_id)?.profile;

    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'row__name';
    name.textContent = host?.username ?? 'Someone';

    const meta = document.createElement('span');
    meta.className = 'row__meta';
    meta.textContent =
      `${formatScore(scoreOf(host))} · ${seated} of ${game.max_players} seated · ` +
      `opened ${relativeTime(game.created_at)}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--primary';
    btn.textContent = seated + 1 >= game.max_players ? 'Take the last seat' : 'Sit down';
    btn.addEventListener('click', () => onJoin(game, btn));

    li.append(name, meta, btn);
    list.append(li);
  }
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
