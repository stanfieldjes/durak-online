/**
 * The chat at a table, as the page runs it.
 *
 * Who may read and write a table's chat is the database's business, and
 * tests/sql/schema.test.sql checks it there — a spectator is refused both
 * ways however the page behaves. What is checked here is the page's half:
 * that a line arriving twice is shown once, that what anyone types is shown
 * as text and never as markup, that a reconnect catches up on exactly what
 * it missed, that leaving a table leaves its chat too, and that game.js
 * never opens one for somebody watching.
 *
 * Like view.test.mjs, this runs on a copy of the scripts with the modules
 * that reach the network stubbed, and skips the parts that need a document
 * when jsdom is not installed.
 */

import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
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

let chat;
let db;
let window;

/** The chat's own markup, taken from the template so the two cannot drift. */
function chatMarkup() {
  const html = readFileSync(join(ROOT, 'src/templates/partials/game.html'), 'utf8');
  const aside = html.match(/<aside class="chat"[\s\S]*?<\/aside>/);
  assert.ok(aside, 'the table template has no chat panel');
  return aside[0];
}

before(async () => {
  if (!JSDOM) return;
  window = new JSDOM(
    `<!doctype html><body>${chatMarkup()}<div id="toast" hidden></div></body>`,
    { url: 'https://durak.test/' },
  ).window;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.innerWidth = window.innerWidth;
  globalThis.innerHeight = window.innerHeight;
  globalThis.addEventListener = window.addEventListener.bind(window);

  const dir = mkdtempSync(join(tmpdir(), 'durak-chat-'));
  cpSync(join(ROOT, 'src/js'), dir, { recursive: true });

  writeFileSync(join(dir, 'durak.js'),
    'export const SUIT_GLYPH = {};\nexport const SUIT_NAME = {};\nexport const MAX_PLAYERS = 8;\n');
  writeFileSync(join(dir, 'supabase.js'),
    'export const supabase = {};\nexport const readableError = (e) => String(e?.message ?? e);\n');
  writeFileSync(join(dir, 'auth.js'),
    'export const session = { user: { id: "me" }, profile: { id: "me", username: "Me" } };\n');
  // A pretend server: a list of rows, the reads and sends made against it,
  // and the realtime subscriptions, which a test drives by hand.
  writeFileSync(join(dir, 'db.js'), `
    export const CHAT_MAX_CHARS = 300;
    export const CHAT_HISTORY = 100;
    export const fake = { rows: [], reads: [], sent: [], watchers: [], profiles: {}, nextId: 1000 };
    export async function listMessages(gameId, { afterId = null } = {}) {
      fake.reads.push({ gameId, afterId });
      return fake.rows.filter((r) => r.game_id === gameId && (afterId === null || r.id > afterId));
    }
    export async function sendMessage(gameId, body) {
      fake.sent.push({ gameId, body });
      const row = { id: ++fake.nextId, game_id: gameId, player_id: 'me', body,
                    created_at: new Date().toISOString() };
      fake.rows.push(row);
      return row;
    }
    export function watchChat(gameId, onMessage, onStatus) {
      const watcher = { gameId, onMessage, onStatus, live: true };
      fake.watchers.push(watcher);
      return () => { watcher.live = false; };
    }
    export async function getProfile(id) { return fake.profiles[id] ?? null; }
    export async function getLeaderboard() { return []; }
  `);

  chat = await import(pathToFileURL(join(dir, 'chat.js')).href);
  db = await import(pathToFileURL(join(dir, 'db.js')).href);
  chat.initChat();
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const $ = (sel) => document.querySelector(sel);
const lines = () => [...document.querySelectorAll('#chat-log .chat__text')].map((el) => el.textContent);
const watcher = () => db.fake.watchers.at(-1);

const at = (minutes) => new Date(Date.UTC(2026, 8, 22, 18, minutes)).toISOString();
const row = (id, player, body, minute = id) =>
  ({ id, game_id: 'g1', player_id: player, body, created_at: at(minute) });

const seats = {
  me: { id: 'me', username: 'Me' },
  ann: { id: 'ann', username: 'Анна' },
  bo: { id: 'bo', username: 'bo' },
};
const lookup = (id) => seats[id] ?? null;

/** Open g1's chat over `rows`, and wait for the first read to land. */
async function enter(rows = []) {
  db.fake.rows = rows;
  db.fake.reads = [];
  db.fake.sent = [];
  chat.openChat('g1', { lookup });
  await flush();
}

function setOpen(want) {
  const toggle = $('#chat-toggle');
  if ((toggle.getAttribute('aria-expanded') === 'true') !== want) toggle.click();
}

beforeEach(() => {
  if (!JSDOM) return;
  chat.closeChat();
  setOpen(false);
});

test('the history arrives oldest first, and is shown as text, never markup', { skip: NO_DOM }, async () => {
  await enter([
    row(2, 'bo', '<img src=x onerror="alert(1)">'),
    row(1, 'ann', 'привет'),
  ]);
  assert.deepEqual(lines(), ['привет', '<img src=x onerror="alert(1)">']);
  assert.equal(document.querySelector('#chat-log img:not(.avatar img)'), null);
  assert.equal($('#chat').hidden, false);
  assert.equal($('#chat-empty').hidden, true);
});

test('an empty chat says who can see it', { skip: NO_DOM }, async () => {
  await enter([]);
  assert.equal($('#chat-empty').hidden, false);
  assert.match($('#chat-empty').textContent, /spectators/i);
});

test('a line that arrives both ways is shown once', { skip: NO_DOM }, async () => {
  const hello = row(1, 'ann', 'hello');
  await enter([hello]);
  watcher().onMessage({ ...hello });
  watcher().onMessage(row(2, 'bo', 'hi'));
  watcher().onMessage(row(2, 'bo', 'hi'));
  assert.deepEqual(lines(), ['hello', 'hi']);
});

test('lines that arrive out of order are put back in order', { skip: NO_DOM }, async () => {
  await enter([row(1, 'ann', 'one')]);
  watcher().onMessage(row(3, 'bo', 'three'));
  watcher().onMessage(row(2, 'ann', 'two'));
  assert.deepEqual(lines(), ['one', 'two', 'three']);
});

test('closed, the tab counts other people’s lines, not your own', { skip: NO_DOM }, async () => {
  await enter([row(1, 'ann', 'old news')]);
  assert.equal($('#chat-unread').hidden, true, 'history on the way in is not new');

  watcher().onMessage(row(2, 'ann', 'you there?'));
  watcher().onMessage(row(3, 'me', 'yes'));
  watcher().onMessage(row(4, 'bo', 'me too'));
  assert.equal($('#chat-unread').hidden, false);
  assert.equal($('#chat-unread').textContent, '2');
  assert.match($('#chat-toggle').getAttribute('aria-label'), /2 new messages/);

  setOpen(true);
  assert.equal($('#chat-unread').hidden, true, 'opening it reads them');
  watcher().onMessage(row(5, 'bo', 'seen live'));
  assert.equal($('#chat-unread').hidden, true, 'nothing is unread while it is open');
});

test('a reconnect reads only what came after the last read', { skip: NO_DOM }, async () => {
  await enter([row(1, 'ann', 'one'), row(2, 'bo', 'two')]);
  // Said while the connection was down: realtime will never deliver these.
  db.fake.rows.push(row(3, 'ann', 'three'), row(4, 'bo', 'four'));

  watcher().onStatus('SUBSCRIBED');
  await flush();

  assert.equal(db.fake.reads.at(-1).afterId, 2);
  assert.deepEqual(lines(), ['one', 'two', 'three', 'four']);
});

test('one player’s run of lines shares one name above it', { skip: NO_DOM }, async () => {
  await enter([
    row(1, 'ann', 'a', 0),
    row(2, 'ann', 'b', 1),
    row(3, 'bo', 'c', 1),
    row(4, 'bo', 'd', 9),   // long enough later to be named again
  ]);
  const names = [...document.querySelectorAll('#chat-log .chat__name')].map((el) => el.textContent);
  assert.deepEqual(names, ['Анна', 'bo', 'bo']);
  assert.ok(document.querySelectorAll('.chat__msg--mine').length === 0);
});

test('times follow the reader\'s locale, with no leading zero on the hour', { skip: NO_DOM }, async () => {
  // 06:05 in UTC. Whether that reads "6:05 AM" or "6:05" is the reader's
  // locale's business; "06:05" is nobody's.
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    await enter([{ id: 1, game_id: 'g1', player_id: 'ann', body: 'early',
                   created_at: '2026-09-22T06:05:00.000Z' }]);
    const shown = $('#chat-log .chat__time').textContent;
    assert.match(shown, /^6\D05(\s?[AaPp]\.?\s?[Mm]\.?)?$/, `unexpected time: ${shown}`);
    assert.equal(shown, new Date('2026-09-22T06:05:00Z').toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
    }), 'the 12- or 24-hour choice is the locale\'s');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('someone who has left the table is still named, by looking them up', { skip: NO_DOM }, async () => {
  db.fake.profiles.gone = { id: 'gone', username: 'Ghost' };
  await enter([row(1, 'gone', 'bye all')]);
  await flush();
  assert.equal($('#chat-log .chat__name').textContent, 'Ghost');
});

test('sending tidies the line, and your own shows at once', { skip: NO_DOM }, async () => {
  await enter([]);
  setOpen(true);
  $('#chat-input').value = '  good\tgame  ';
  $('#chat-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();

  assert.deepEqual(db.fake.sent.map((s) => s.body), ['good game']);
  assert.deepEqual(lines(), ['good game']);
  assert.equal($('#chat-input').value, '');
  assert.ok($('#chat-log .chat__msg').classList.contains('chat__msg--mine'));
});

test('length is counted in characters, the way the database counts it', { skip: NO_DOM }, async () => {
  await enter([]);
  setOpen(true);

  $('#chat-input').value = 'a'.repeat(301);
  $('#chat-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();
  assert.equal(db.fake.sent.length, 0, 'an over-long line never reaches the server');
  assert.equal($('#toast').hidden, false);

  // 300 emoji are 600 UTF-16 units, and still 300 characters.
  $('#chat-input').value = '🂡'.repeat(300);
  $('#chat-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();
  assert.equal(db.fake.sent.length, 1);

  $('#chat-input').value = '    ';
  $('#chat-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await flush();
  assert.equal(db.fake.sent.length, 1, 'a blank line is not sent');
});

test('leaving the table leaves its chat, and a late arrival is ignored', { skip: NO_DOM }, async () => {
  await enter([row(1, 'ann', 'hello')]);
  const old = watcher();
  chat.closeChat();

  assert.equal(old.live, false, 'the subscription is dropped');
  assert.equal($('#chat').hidden, true);
  assert.deepEqual(lines(), []);

  old.onMessage(row(2, 'ann', 'from the old table'));
  assert.deepEqual(lines(), []);
});

test('game.js never opens the chat for somebody watching', () => {
  // The database is what keeps spectators out; this is the page not asking.
  const source = readFileSync(join(ROOT, 'src/js/game.js'), 'utf8');
  const calls = [...source.matchAll(/openChat\(/g)];
  assert.equal(calls.length, 1, 'expected one place that opens the chat');
  const before = source.slice(Math.max(0, calls[0].index - 200), calls[0].index);
  assert.match(before, /if \(!spectating && mySeat !== null\) \{\s*$/);
  assert.match(source, /function reset\(\) \{[\s\S]*?closeChat\(\);/);
});
