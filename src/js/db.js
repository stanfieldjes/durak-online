import { supabase } from './supabase.js';
import { MAX_PLAYERS } from './durak.js';

/** How many finished games one page of the recent games list holds. */
export const RECENT_PER_PAGE = 10;

/** Where profile pictures live. Created by supabase/schema.sql. */
const AVATAR_BUCKET = 'avatars';

/* ---------------- profiles ---------------- */

const PROFILE_COLUMNS = 'id, username, avatar_url, rating, wins, losses, draws';

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createProfile(userId, username) {
  const { data, error } = await supabase
    .from('profiles')
    .insert({ id: userId, username })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Change your own name. The database decides what is allowed. */
export async function setUsername(name) {
  const { data, error } = await supabase.rpc('set_username', { p_name: name });
  if (error) throw error;
  return data;
}

/** Record where your picture lives, or pass null to remove it. */
export async function setAvatar(url) {
  const { data, error } = await supabase.rpc('set_avatar', { p_url: url });
  if (error) throw error;
  return data;
}

/** What a cropped picture is called, from what the canvas managed to encode. */
const EXTENSIONS = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

/**
 * Put a picture in the avatars bucket and return its public address.
 *
 * Takes the square that came out of the cropper rather than the file the
 * player picked, so the name has to be made up here — a Blob has no name of
 * its own. The path always begins with the player's own user id, because that
 * is what the storage policy checks: you may write inside your own folder and
 * nowhere else. The name after it changes on every upload so that a new
 * picture is never served from a cache of the old one, and the previous file
 * is removed once the new one is in place.
 */
export async function uploadAvatar(userId, blob) {
  const type = blob.type || 'image/png';
  const path = `${userId}/${Date.now()}.${EXTENSIONS[type] ?? 'png'}`;

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, blob, { contentType: type, upsert: false });
  if (error) throw error;

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  await removeOldAvatars(userId, path);
  return data.publicUrl;
}

/** Tidy up whatever this player uploaded before, so the bucket holds one file each. */
async function removeOldAvatars(userId, keepPath) {
  try {
    const { data } = await supabase.storage.from(AVATAR_BUCKET).list(userId);
    const stale = (data ?? [])
      .map((entry) => `${userId}/${entry.name}`)
      .filter((path) => path !== keepPath);
    if (stale.length) await supabase.storage.from(AVATAR_BUCKET).remove(stale);
  } catch {
    // A leftover file is untidy, not broken. Never fail an upload over it.
  }
}

export async function getLeaderboard(limit = 50) {
  const { data, error } = await supabase
    .from('leaderboard')
    .select('id, username, avatar_url, games, duraks, rating')
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/* ---------------- games ---------------- */

const GAME_COLUMNS = `
  id, status, host_id, max_players, seed, state, version, durak_id, rating_delta,
  created_at, updated_at, clear_delay_ms, quick_clear_delay_ms,
  players:game_players ( seat, player_id, profile:profiles ( ${PROFILE_COLUMNS} ) )
`;

/**
 * Seats in seat order, so index === seat number.
 *
 * Leaves the row untouched when it carries no seats at all. The RPCs return a
 * bare `games` row with no join, and manufacturing an empty array here used to
 * wipe the names and ratings off the table on every move.
 */
function withSortedSeats(game) {
  if (!game || !Array.isArray(game.players)) return game;
  return { ...game, players: [...game.players].sort((a, b) => a.seat - b.seat) };
}

/** Open a table. Every table seats eight; the host can start once two are seated. */
export async function createGame() {
  const { data, error } = await supabase.rpc('create_game', { p_max_players: MAX_PLAYERS });
  if (error) throw error;
  return data;
}

/**
 * Take a seat. When this is the final seat, `state` must be the opening
 * position dealt from the table's seed for the full player count.
 */
export async function joinGame(gameId, state = null) {
  const { data, error } = await supabase.rpc('join_game', { p_game: gameId, p_state: state });
  if (error) throw error;
  return data;
}

/** Host starts a partly filled table. */
export async function startGame(gameId, state) {
  const { data, error } = await supabase.rpc('start_game', { p_game: gameId, p_state: state });
  if (error) throw error;
  return data;
}

export async function getGame(gameId) {
  const { data, error } = await supabase
    .from('games')
    .select(GAME_COLUMNS)
    .eq('id', gameId)
    .maybeSingle();
  if (error) throw error;
  return withSortedSeats(data);
}

/**
 * Tables to show in the lobby: those waiting for players and those being
 * played right now, newest first. A running table cannot be joined, but it
 * can be watched.
 */
export async function listTables(limit = 30) {
  const { data, error } = await supabase
    .from('games')
    .select(GAME_COLUMNS)
    .in('status', ['waiting', 'active'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(withSortedSeats);
}

/**
 * One page of finished games — everybody's, not just yours.
 *
 * Ordered by when the game ended rather than when its table was opened, since
 * a long game started before a short one can finish after it. The count comes
 * back with the page so the pager knows how many there are in total.
 */
export async function listRecentGames({ page = 0, perPage = RECENT_PER_PAGE } = {}) {
  const from = Math.max(0, page) * perPage;
  const { data, error, count } = await supabase
    .from('games')
    .select(GAME_COLUMNS, { count: 'exact' })
    .eq('status', 'finished')
    .order('updated_at', { ascending: false })
    .range(from, from + perPage - 1);
  if (error) throw error;
  return { games: (data ?? []).map(withSortedSeats), total: count ?? 0 };
}

/**
 * Ids of the tables this player has sat at, most recent first.
 *
 * Two steps, because filtering a parent by a child column needs an inner join
 * that would also hide the other seats from the result.
 */
async function mySeatGameIds(userId) {
  const { data, error } = await supabase
    .from('game_players')
    .select('game_id')
    .eq('player_id', userId)
    .order('joined_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((s) => s.game_id);
}

/**
 * This player's finished games, oldest first, with what each one did to their
 * rating — the makings of the line on the account page.
 *
 * Asked for newest first and turned round afterwards, so that a player with
 * more games than the limit gets their recent ones rather than their first
 * ever. Only the seat count comes back from the join; the chart wants to know
 * how big the table was, not who was at it.
 */
export async function listMyRatingHistory(userId, limit = 100) {
  const ids = await mySeatGameIds(userId);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('games')
    .select('id, durak_id, rating_delta, updated_at, players:game_players ( seat )')
    .in('id', ids)
    .eq('status', 'finished')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? [])
    .map((game) => ({
      id: game.id,
      at: game.updated_at,
      delta: Number(game.rating_delta?.[userId] ?? 0),
      players: game.players?.length ?? null,
      durak: game.durak_id === userId,
    }))
    .reverse();
}

/**
 * How this player's last few finished games went, newest first: 'out' for a
 * game they got out of, 'durak' for one they were left holding the cards in
 * (conceding included), 'draw' for one nobody lost. What the hover panel
 * draws as its row of circles; see form.js.
 */
export async function listRecentResults(userId, limit = 5) {
  const ids = await mySeatGameIds(userId);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('games')
    .select('id, durak_id, updated_at')
    .in('id', ids)
    .eq('status', 'finished')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((game) => {
    if (!game.durak_id) return 'draw';
    return game.durak_id === userId ? 'durak' : 'out';
  });
}

/**
 * Tables this player is seated at that are not over yet — filling up or being
 * played — latest change first. Read separately from listTables() so a table
 * of your own is never missing from the lobby just because thirty newer ones
 * were opened since.
 */
export async function listMyTables(userId, limit = 10) {
  const ids = await mySeatGameIds(userId);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('games')
    .select(GAME_COLUMNS)
    .in('id', ids)
    .in('status', ['waiting', 'active'])
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(withSortedSeats);
}

/**
 * Send a move.
 *
 * `baseVersion` is the version the new position was built on. If another
 * player got there first the database refuses the write and the caller
 * re-applies against the fresh position — see game.js.
 */
export async function submitMove(gameId, state, baseVersion) {
  const { data, error } = await supabase.rpc('submit_move', {
    p_game: gameId,
    p_state: state,
    p_base_version: baseVersion,
  });
  if (error) throw error;
  return withSortedSeats(data);
}

export function isStaleError(error) {
  return /stale position|advance the position/i.test(error?.message ?? '');
}

/** The database refused a clear because the table has not been on show long enough. */
export function isTooEarlyError(error) {
  return /too early to clear/i.test(error?.message ?? '');
}

/**
 * Report the result. The database works out every rating change itself — the
 * client never sends a rating or a delta.
 */
export async function finishGame(gameId, durakSeat) {
  const { data, error } = await supabase.rpc('finish_game', {
    p_game: gameId,
    p_durak_seat: durakSeat,
  });
  if (error) throw error;
  return data;
}

export async function abandonGame(gameId) {
  const { error } = await supabase.rpc('abandon_game', { p_game: gameId });
  if (error) throw error;
}

export async function leaveTable(gameId) {
  const { error } = await supabase.rpc('leave_table', { p_game: gameId });
  if (error) throw error;
}

/**
 * Just the version and status of a table: a cheap way to ask "have I missed
 * anything?" without pulling the whole position.
 */
export async function getGameVersion(gameId) {
  const { data, error } = await supabase
    .from('games')
    .select('version, status')
    .eq('id', gameId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------------- table chat ---------------- */

/** Longest message, in characters. Mirrors game_messages_body_check. */
export const CHAT_MAX_CHARS = 300;

/** How much of a table's chat is kept on screen, and read on the way in. */
export const CHAT_HISTORY = 100;

const MESSAGE_COLUMNS = `id, game_id, player_id, body, created_at,
  profile:profiles ( ${PROFILE_COLUMNS} )`;

/**
 * A table's chat, oldest first. With `afterId`, only what came after it — the
 * catch-up read after a dropped connection.
 *
 * Only the players seated at the table get anything back; for anyone else the
 * row-level security policy makes the chat look empty.
 */
export async function listMessages(gameId, { afterId = null, limit = CHAT_HISTORY } = {}) {
  let query = supabase
    .from('game_messages')
    .select(MESSAGE_COLUMNS)
    .eq('game_id', gameId);
  if (afterId !== null) query = query.gt('id', afterId);
  // Newest first so the limit keeps the latest lines, then turned round.
  const { data, error } = await query.order('id', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []).reverse();
}

/** Say something at a table you are sitting at. The database checks the rest. */
export async function sendMessage(gameId, body) {
  const { data, error } = await supabase.rpc('send_message', { p_game: gameId, p_body: body });
  if (error) throw error;
  return data;
}

/* ---------------- realtime ---------------- */

/**
 * A fresh channel name per subscription.
 *
 * Leaving a channel and joining another with the same name straight away can
 * let the server's reply to the leave close the new join too, which leaves a
 * channel that looks subscribed and never delivers anything. The name has no
 * meaning for postgres_changes, so a unique one sidesteps that entirely.
 */
const channelName = (base) =>
  `${base}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;

/**
 * Watch one table. Fires on moves and on players sitting down, so a waiting
 * host sees the seats fill. Returns an unsubscribe function.
 *
 * Realtime does not replay changes that happened while the socket was down,
 * so `onStatus` hears every SUBSCRIBED (including each automatic rejoin after
 * a dropped connection) and the caller re-reads the table then.
 */
export function watchGame(gameId, onChange, onStatus) {
  const channel = supabase
    .channel(channelName(`game:${gameId}`))
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
      (payload) => onChange({ kind: 'game', row: payload.new })
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${gameId}` },
      () => onChange({ kind: 'seats' })
    )
    .subscribe((status, err) => onStatus?.(status, err));
  return () => supabase.removeChannel(channel);
}

/**
 * Watch one table's chat. Realtime applies the same policy as a read, so a
 * browser not seated at the table is sent nothing. Returns an unsubscribe
 * function; `onStatus` hears every SUBSCRIBED so the caller can catch up.
 */
export function watchChat(gameId, onMessage, onStatus) {
  const channel = supabase
    .channel(channelName(`chat:${gameId}`))
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'game_messages', filter: `game_id=eq.${gameId}` },
      (payload) => onMessage(payload.new)
    )
    .subscribe((status, err) => onStatus?.(status, err));
  return () => supabase.removeChannel(channel);
}

/** Watch the lobby. Returns an unsubscribe function. */
export function watchLobby(onChange, onStatus) {
  const channel = supabase
    .channel(channelName('lobby'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players' }, onChange)
    .subscribe((status, err) => onStatus?.(status, err));
  return () => supabase.removeChannel(channel);
}
