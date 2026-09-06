/**
 * Entry point: hash router plus view lifecycle.
 *
 * Routes:
 *   #/                 lobby (or the sign-in panel when signed out)
 *   #/game/:id         a table
 *   #/leaderboard      ranks
 */
import { $, $$, show, toast } from './ui.js';
import { loadSession, onAuthChange, initAuthView, renderWhoami, session } from './auth.js';
import { initLobby, enterLobby, leaveLobby } from './lobby.js';
import { initGame, enterGame, leaveGame } from './game.js';
import { enterLeaderboard } from './leaderboard.js';
import { initSound } from './sound.js';

let current = null;

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'game' && parts[1]) return { name: 'game', id: parts[1] };
  if (parts[0] === 'leaderboard') return { name: 'leaderboard' };
  return { name: 'lobby' };
}

function showPanel(name) {
  $$('[data-route]').forEach((panel) => show(panel, panel.dataset.route === name));
  $$('.nav a').forEach((a) => {
    const target = a.getAttribute('href').replace(/^#/, '') || '/';
    const here = location.hash.replace(/^#/, '') || '/';
    a.classList.toggle('is-on', target === here);
  });
}

function teardown() {
  if (current === 'lobby') leaveLobby();
  if (current === 'game') leaveGame();
  current = null;
}

async function route() {
  const target = parseRoute();

  if (!session.user) {
    teardown();
    showPanel('auth');
    current = 'auth';
    return;
  }

  if (current === target.name && target.name !== 'game') return;
  teardown();

  switch (target.name) {
    case 'game':
      showPanel('game');
      current = 'game';
      await enterGame(target.id);
      break;
    case 'leaderboard':
      showPanel('leaderboard');
      current = 'leaderboard';
      await enterLeaderboard();
      break;
    default:
      showPanel('lobby');
      current = 'lobby';
      enterLobby();
  }
}

async function boot() {
  try {
    await loadSession();
  } catch (error) {
    console.error(error);
    toast('Cannot reach Supabase. Check the credentials in config.json.');
  }

  initSound();
  initAuthView(() => { location.hash = '#/'; route(); });
  initLobby();
  initGame();
  renderWhoami();

  onAuthChange(() => {
    renderWhoami();
    current = null;
    route();
  });

  window.addEventListener('hashchange', route);

  show($('#boot'), false);
  show($('#app'), true);
  await route();
}

boot();
