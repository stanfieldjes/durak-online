import { supabase } from './supabase.js';

/* ---------------- profiles ---------------- */

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, wins, losses, draws, expected_duraks')
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

export async function getLeaderboard(limit = 50) {
  const { data, error } = await supabase
    .from('leaderboard')
    .select('id, username, games, duraks, expected_duraks, durak_rate, expected_rate, score')
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/* ---------------- games ---------------- */

const GAME_COLUMNS = `
  id, status, host_id, max_players, seed, state, version, durak_id, score_delta, created_at,
  players:game_players ( seat, player_id, profile:profiles ( id, username, wins, losses, draws, expected_duraks ) )
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

/** Open a table. Every table seats four; the host can start once two are seated. */
export async function createGame() {
  const { data, error } = await supabase.rpc('create_game', { p_max_players: 4 });
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

export async function listOpenGames() {
  const { data, error } = await supabase
    .from('games')
    .select(GAME_COLUMNS)
    .eq('status', 'waiting')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []).map(withSortedSeats);
}

export async function listMyGames(userId, limit = 10) {
  // Two steps, because filtering a parent by a child column needs an inner join
  // that would also hide the other seats from the result.
  const { data: seats, error: seatError } = await supabase
    .from('game_players')
    .select('game_id')
    .eq('player_id', userId)
    .limit(200);
  if (seatError) throw seatError;

  const ids = (seats ?? []).map((s) => s.game_id);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('games')
    .select(GAME_COLUMNS)
    .in('id', ids)
    .eq('status', 'finished')
    .order('created_at', { ascending: false })
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

/**
 * Report the result. The database recalculates every rating itself — the
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

/** Watch the lobby. Returns an unsubscribe function. */
export function watchLobby(onChange, onStatus) {
  const channel = supabase
    .channel(channelName('lobby'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players' }, onChange)
    .subscribe((status, err) => onStatus?.(status, err));
  return () => supabase.removeChannel(channel);
}
