/**
 * The lobby's list of tables.
 *
 * Every table not yet over is in one list and drawn one way, whether you are
 * sitting at it or not. The buttons are the only difference: a seat to take,
 * a game to watch, or a way back to your own table and out of it. Your own
 * tables come first, and none of them appears twice however many reads it
 * turned up in.
 *
 * Runs on a copy of the scripts with the data layer and session stubbed, and
 * skips itself without jsdom, like view.test.mjs.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  // Reported by the skip reason below rather than per test.
}
const NO_DOM = JSDOM ? false : 'needs jsdom: run `npm install` first';

let lobby;
let db;
let auth;

before(async () => {
  if (!JSDOM) return;
  const partial = readFileSync(join(ROOT, 'src/templates/partials/lobby.html'), 'utf8');
  const window = new JSDOM(`<!doctype html><body>${partial}<div id="toast" hidden></div></body>`,
    { url: 'https://durak.test/' }).window;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.innerWidth = window.innerWidth;
  globalThis.innerHeight = window.innerHeight;
  globalThis.addEventListener = window.addEventListener.bind(window);

  const dir = mkdtempSync(join(tmpdir(), 'durak-lobby-'));
  cpSync(join(ROOT, 'src/js'), dir, { recursive: true });

  writeFileSync(join(dir, 'durak.js'), `
    export const SUIT_GLYPH = {};
    export const SUIT_NAME = {};
    export const MAX_PLAYERS = 8;
    export const newGame = () => ({});
    export const openSlots = (s) => s.table.filter((slot) => !slot.def).length;
  `);
  writeFileSync(join(dir, 'supabase.js'),
    'export const supabase = {};\nexport const readableError = (e) => String(e?.message ?? e);\n');
  writeFileSync(join(dir, 'auth.js'), `
    export const session = { user: { id: 'me' }, profile: null };
    export const ratingOf = (profile) => profile?.rating ?? null;
  `);
  writeFileSync(join(dir, 'db.js'), `
    export const RECENT_PER_PAGE = 10;
    export const fake = { tables: [], mine: [] };
    export async function listTables() { return fake.tables; }
    export async function listMyTables() { return fake.mine; }
    export async function listRecentGames() { return { games: [], total: 0 }; }
    export async function getLeaderboard() { return []; }
    export async function createGame() {}
    export async function joinGame() {}
    export async function abandonGame() {}
    export async function leaveTable() {}
    export function watchLobby() { return () => {}; }
  `);

  lobby = await import(pathToFileURL(join(dir, 'lobby.js')).href);
  db = await import(pathToFileURL(join(dir, 'db.js')).href);
  auth = await import(pathToFileURL(join(dir, 'auth.js')).href);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

const person = (id) => ({ id, username: id === 'me' ? 'Me' : id, rating: 1000 });
const seat = (id, n) => ({ seat: n, player_id: id, profile: person(id) });

function table(id, { host, others = [], status = 'waiting', max = 8, state = null } = {}) {
  return {
    id, status, host_id: host, max_players: max, state,
    created_at: '2026-09-22T20:00:00Z', updated_at: '2026-09-22T20:05:00Z',
    players: [host, ...others].map(seat),
  };
}

const playing = (opts) => table(opts.id, {
  ...opts,
  status: 'active',
  state: { out: [false, false, false], attacker: 1, defender: 2, taking: false, table: [], ...opts.state },
});

/** Draw the lobby from these reads and describe every row in it. */
async function draw({ tables = [], mine = [] }) {
  db.fake.tables = tables;
  db.fake.mine = mine;
  await lobby.refresh();
  await flush();
  return [...document.querySelectorAll('#open-games > li')].map((li) => ({
    li,
    parts: [...li.children].map((el) => el.className),
    host: li.querySelector('.row__name').textContent,
    meta: li.querySelector('.row__meta').textContent,
    buttons: [...li.querySelectorAll('.row__actions .btn')].map((b) => b.textContent),
  }));
}

test('there is one list of tables, and nothing else lists them', { skip: NO_DOM }, () => {
  assert.equal(document.querySelectorAll('.tables').length, 1);
  assert.equal(document.querySelector('#active-games'), null);
  assert.equal(document.querySelector('#my-open-game'), null);
});

test('the list comes first, with no heading, and opening a table is underneath it', { skip: NO_DOM }, () => {
  const panel = document.querySelector('.panel--lobby');
  const first = panel.firstElementChild;
  assert.ok(first.contains(document.querySelector('#open-games')), 'the tables are first on the page');
  assert.equal(first.querySelector('h1, h2, h3'), null, 'no heading over the tables');
  assert.equal(document.querySelector('#refresh-games'), null, 'no refresh button');

  const list = document.querySelector('#open-games');
  const open = document.querySelector('#create-game');
  assert.ok(list.compareDocumentPosition(open) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'Open a table comes after the list');
});

test('your tables are in the same list, first, and each appears once', { skip: NO_DOM }, async () => {
  const hosting = table('mine-open', { host: 'me', others: ['ann'] });
  // Seat 1 is defending an empty table: in the game, but not waited on.
  const inGame = playing({ id: 'mine-live', host: 'bo', others: ['me', 'cy'], state: { attacker: 0, defender: 1 } });
  const open = table('theirs-open', { host: 'ann' });
  const live = playing({ id: 'theirs-live', host: 'cy', others: ['dee', 'eve'] });

  const rows = await draw({
    tables: [open, hosting, live, inGame],   // the general read includes yours too
    mine: [inGame, hosting],
  });

  assert.equal(rows.length, 4, 'no table twice');
  assert.deepEqual(rows.map((r) => r.buttons), [
    ['Rejoin'],
    ['Go back to it', 'Close the table'],
    ['Sit down'],
    ['Watch'],
  ]);
});

test('every row has the same parts in the same order', { skip: NO_DOM }, async () => {
  const rows = await draw({
    tables: [
      table('a', { host: 'me' }),
      table('b', { host: 'ann' }),
      playing({ id: 'c', host: 'bo', others: ['me', 'cy'] }),
      playing({ id: 'd', host: 'cy', others: ['dee', 'eve'] }),
    ],
  });
  for (const row of rows) assert.deepEqual(row.parts, ['row__name', 'row__meta', 'row__actions']);
});

test('a table looks the same to someone at it and someone not; only the buttons change', { skip: NO_DOM }, async () => {
  const cases = [
    table('w', { host: 'ann', others: ['bo', 'me'] }),
    playing({ id: 'p', host: 'ann', others: ['bo', 'me'] }),
  ];
  for (const game of cases) {
    auth.session.user.id = 'me';
    const [seated] = await draw({ tables: [game] });
    auth.session.user.id = 'stranger';
    const [outside] = await draw({ tables: [game] });
    auth.session.user.id = 'me';

    assert.equal(seated.host, outside.host, `${game.id}: who opened it`);
    assert.equal(seated.meta, outside.meta, `${game.id}: the line about it`);
    assert.equal(seated.li.className, outside.li.className, `${game.id}: the row's marking`);
    assert.notDeepEqual(seated.buttons, outside.buttons, `${game.id}: the buttons`);
  }
});

test('a table you joined but do not host lets you leave rather than close it', { skip: NO_DOM }, async () => {
  const [row] = await draw({ tables: [table('j', { host: 'ann', others: ['me'] })] });
  assert.deepEqual(row.buttons, ['Go back to it', 'Leave the table']);
});

test('a game waiting on you says so on its button', { skip: NO_DOM }, async () => {
  // Seat 1 is the attacker with nothing on the table: the opening card is theirs.
  const [row] = await draw({
    tables: [playing({ id: 'm', host: 'ann', others: ['me', 'bo'] })],
  });
  const button = row.li.querySelector('.row__actions .btn');
  assert.equal(button.textContent, 'Your move');
  assert.ok(button.classList.contains('btn--primary'));
  assert.equal(button.title, 'Your move: attack');
});

test('a full table offers the last seat', { skip: NO_DOM }, async () => {
  const [row] = await draw({ tables: [table('f', { host: 'ann', others: ['bo'], max: 3 })] });
  assert.deepEqual(row.buttons, ['Take the last seat']);
});

test('with nothing open anywhere, it says so', { skip: NO_DOM }, async () => {
  const rows = await draw({ tables: [], mine: [] });
  assert.equal(rows.length, 0);
  assert.equal(document.querySelector('#no-games').hidden, false);
});
