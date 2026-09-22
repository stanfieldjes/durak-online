/**
 * The chat at a table.
 *
 * One conversation per table, for the players sitting at it: in the waiting
 * room while it fills, across the felt while it is played, and over the
 * result for a "good game" once it is over. Spectators never get one. game.js
 * does not open the chat for them, and that is only manners — the database
 * is what actually keeps them out (see "Table chat" in README and in
 * schema.sql), so a page that opened it anyway would find it empty and every
 * message refused.
 *
 * It sits in a corner as a small tab that opens into a panel, so it never
 * takes room from the felt, which sizes itself to the window. Closed, the tab
 * counts what arrived since it was last open. Whether it is open is
 * remembered from one table to the next.
 *
 * Staying in sync works the way the table does. Realtime brings new lines as
 * they are said; every SUBSCRIBED (the first, and each rejoin after a dropped
 * connection) and every return to the tab re-reads whatever came after the
 * last line read, since realtime does not replay what it missed. Lines are
 * kept by id, so one that arrives both ways is shown once.
 */
import {
  listMessages,
  sendMessage,
  watchChat,
  getProfile,
  CHAT_MAX_CHARS,
  CHAT_HISTORY,
} from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { $, show, setText, clear, toast, avatarEl, markStanding, attachProfileCard } from './ui.js';

const OPEN_KEY = 'durak:chat-open';

/** Lines from one player this close together share one name above them. */
const RUN_MS = 2 * 60 * 1000;

/** Scrolled within this of the bottom counts as reading the latest line. */
const NEAR_BOTTOM_PX = 48;

/** The most lines kept on screen; older ones scroll away for good. */
const KEEP = CHAT_HISTORY * 2;

let gameId = null;
let profileOf = () => null;  // the seated players' profiles, from game.js
let messages = [];           // oldest first, by id
const seen = new Set();      // ids already shown
const lookedUp = new Map();  // player id -> profile, for anyone game.js no longer knows
const lookingUp = new Set();
let readThrough = null;      // the last id a read (not realtime) got to
let loaded = false;          // the first read has landed
let unwatch = null;
let gen = 0;                 // bumps on every open and close; stale callbacks check it
let catchingUp = false;
let catchUpAgain = false;
let sending = false;
let open = readOpen();
let unread = 0;

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveOpen(value) {
  try {
    localStorage.setItem(OPEN_KEY, value ? '1' : '0');
  } catch {
    /* private mode: it just is not remembered */
  }
}

export function initChat() {
  $('#chat-toggle').addEventListener('click', () => setOpen(!open, { focus: true }));
  $('#chat-form').addEventListener('submit', onSubmit);
  $('#chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false, { focus: true });
  });
  paintOpen();
}

/**
 * Join a table's chat. `lookup(playerId)` returns a seated player's profile,
 * so names and pictures match the ones on the felt.
 */
export function openChat(id, { lookup = () => null } = {}) {
  closeChat();
  const mine = gen;
  gameId = id;
  profileOf = lookup;

  show($('#chat'), true);
  paintOpen();
  render();

  unwatch = watchChat(
    id,
    (row) => {
      if (mine === gen) receive([row], { count: true });
    },
    (status) => {
      if (mine === gen && status === 'SUBSCRIBED') catchUp();
    }
  );
  catchUp();

  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);
}

/** Leave the table's chat: stop listening and forget what was said. */
export function closeChat() {
  gen++;
  if (unwatch) unwatch();
  unwatch = null;
  document.removeEventListener('visibilitychange', onWake);
  window.removeEventListener('online', onWake);

  gameId = null;
  profileOf = () => null;
  messages = [];
  seen.clear();
  readThrough = null;
  loaded = false;
  catchingUp = false;
  catchUpAgain = false;
  sending = false;
  unread = 0;

  const input = $('#chat-input');
  if (input) input.value = '';
  const send = $('#chat-send');
  if (send) send.disabled = false;
  clear($('#chat-log'));
  paintBadge();
  show($('#chat'), false);
}

function onWake() {
  if (document.visibilityState === 'visible') catchUp();
}

/** Read whatever came after the last line a read reached. */
async function catchUp() {
  if (!gameId) return;
  if (catchingUp) {
    catchUpAgain = true;
    return;
  }
  catchingUp = true;
  const mine = gen;
  const id = gameId;

  try {
    do {
      catchUpAgain = false;
      const rows = await listMessages(id, { afterId: readThrough });
      if (mine !== gen) return;
      if (rows.length) readThrough = rows[rows.length - 1].id;
      // The history found on the way in is not news; anything after it is.
      receive(rows, { count: loaded });
      loaded = true;
    } while (catchUpAgain);
  } catch {
    /* offline; the next SUBSCRIBED or return to the tab tries again */
  } finally {
    if (mine === gen) catchingUp = false;
  }
}

/** Add lines not already shown, in id order, and draw them. */
function receive(rows, { count = false, toBottom = false } = {}) {
  let added = 0;
  for (const row of rows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    messages.push(row);
    added++;
    if (count && !open && row.player_id !== session.user?.id) unread++;
  }
  if (!added) return;

  messages.sort((a, b) => a.id - b.id);
  if (messages.length > KEEP) messages = messages.slice(-KEEP);
  render({ toBottom });
}

/**
 * Who said it: the seat's own profile where the table still has one, then
 * whatever came with the line, then a lookup for someone who has since got up.
 */
function authorOf(message) {
  const id = message.player_id;
  const known = profileOf(id) ?? message.profile ?? lookedUp.get(id);
  if (!known) lookUp(id);
  return known ?? null;
}

function lookUp(id) {
  if (!id || lookingUp.has(id)) return;
  lookingUp.add(id); // never asked twice, even after a failure
  const mine = gen;
  getProfile(id)
    .then((profile) => {
      if (!profile) return;
      lookedUp.set(id, profile);
      if (mine === gen) render();
    })
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* drawing                                                             */
/* ------------------------------------------------------------------ */

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;

/**
 * Redraw the conversation. Stays at the bottom if the reader was there, and
 * leaves them alone if they had scrolled up to read something older.
 */
function render({ toBottom = false } = {}) {
  const log = $('#chat-log');
  const stick = toBottom || nearBottom(log);
  clear(log);

  let previous = null;
  for (const message of messages) {
    log.append(messageEl(message, previous));
    previous = message;
  }

  show($('#chat-empty'), messages.length === 0);
  if (stick) log.scrollTop = log.scrollHeight;
  paintBadge();
}

function messageEl(message, previous) {
  const mine = message.player_id === session.user?.id;
  const run = Boolean(previous)
    && previous.player_id === message.player_id
    && Date.parse(message.created_at) - Date.parse(previous.created_at) < RUN_MS;

  const li = document.createElement('li');
  li.className = 'chat__msg';
  if (mine) li.classList.add('chat__msg--mine');

  if (!run) {
    const profile = authorOf(message);
    const head = document.createElement('div');
    head.className = 'chat__head';

    const who = document.createElement('span');
    who.className = 'chat__who';
    const name = document.createElement('span');
    name.className = 'chat__name';
    name.textContent = profile?.username ?? 'Someone';
    markStanding(name, profile?.id);
    who.append(avatarEl(profile, { size: 'xs' }), name);
    attachProfileCard(who, profile);

    const time = document.createElement('time');
    time.className = 'chat__time';
    time.dateTime = message.created_at;
    time.textContent = clockTime(message.created_at);

    head.append(who, time);
    li.append(head);
  }

  // Always text, never markup: whatever anyone types is shown as typed.
  const text = document.createElement('p');
  text.className = 'chat__text';
  text.textContent = message.body;
  li.append(text);
  return li;
}

function clockTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function paintOpen() {
  const toggle = $('#chat-toggle');
  show($('#chat-body'), open);
  toggle?.setAttribute('aria-expanded', String(open));
  $('#chat')?.classList.toggle('is-open', open);
}

function paintBadge() {
  const badge = $('#chat-unread');
  const toggle = $('#chat-toggle');
  show(badge, unread > 0);
  setText(badge, unread > 9 ? '9+' : String(unread));
  toggle?.setAttribute(
    'aria-label',
    unread > 0 ? `Table chat, ${unread} new ${unread === 1 ? 'message' : 'messages'}` : 'Table chat'
  );
}

function setOpen(next, { focus = false } = {}) {
  open = next;
  saveOpen(next);
  paintOpen();
  if (open) {
    unread = 0;
    paintBadge();
    const log = $('#chat-log');
    log.scrollTop = log.scrollHeight;
    if (focus) $('#chat-input').focus();
  } else if (focus) {
    $('#chat-toggle').focus();
  }
}

/* ------------------------------------------------------------------ */
/* sending                                                             */
/* ------------------------------------------------------------------ */

/**
 * What the database will accept, tidied the same way: one line, no padding.
 * Length is counted in characters, as the database counts it — an input's
 * maxlength counts UTF-16 units and would cut an emoji-heavy line short.
 */
export function tidyMessage(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

async function onSubmit(event) {
  event.preventDefault();
  if (!gameId || sending) return;

  const input = $('#chat-input');
  const body = tidyMessage(input.value);
  if (!body) return;
  if ([...body].length > CHAT_MAX_CHARS) {
    toast(`A message can be at most ${CHAT_MAX_CHARS} characters.`);
    return;
  }

  const mine = gen;
  const button = $('#chat-send');
  sending = true;
  button.disabled = true;
  try {
    const row = await sendMessage(gameId, body);
    if (mine !== gen) return;
    input.value = '';
    // The realtime echo of this line will arrive too, and be ignored by id.
    receive([{ ...row, profile: row.profile ?? session.profile }], { toBottom: true });
  } catch (error) {
    if (mine === gen) toast(readableError(error));
  } finally {
    if (mine === gen) {
      sending = false;
      button.disabled = false;
      input.focus();
    }
  }
}
