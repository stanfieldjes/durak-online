-- Durak Online — schema, policies, and RPCs. Tables seat two to eight.
-- Paste the whole file into the Supabase SQL editor and run it once.
--
-- Design rule: the browser never writes to a table directly. Every write goes
-- through a SECURITY DEFINER function that re-checks the claim being made. In
-- particular a client can never set its own rating. Ratings are computed by
-- public.rating_changes() inside finish_game(), never sent by a client.
--
-- Safe to run more than once. Everything is either `if not exists` or an
-- idempotent alter, so an existing database is brought up to date rather than
-- rebuilt. Rows are never touched.

-- ------------------------------------------------------------- constants --

-- Where every player opens. Mirrors START in src/js/rating.js. It is a
-- function rather than a literal because both the column default and the
-- insert policy below need to agree with it.
create or replace function public.rating_start()
returns numeric language sql immutable parallel safe as $$
  select 1000::numeric;
$$;

-- ---------------------------------------------------------------- profiles --

create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  username   text unique not null,
  avatar_url text,
  rating     numeric(12,6) not null default public.rating_start(),
  wins       int  not null default 0,
  losses     int  not null default 0,   -- games ended as the durak
  draws      int  not null default 0,
  created_at timestamptz not null default now()
);

-- Columns added after the first release. An existing table keeps its rows.
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles
  add column if not exists rating numeric(12,6) not null default public.rating_start();

-- The old percentage-point score kept a running sum of each game's 1/n. The
-- rating replaces it outright and derives nothing from it, so it goes.
--
-- Postgres will not drop a column while anything still refers to it, and on a
-- database that ran the old schema two things do: the leaderboard view, which
-- selected it, and the insert policy, which required it to start at zero. Both
-- are rebuilt further down, so they are torn down here first — without this
-- the drop fails with "cannot drop column expected_duraks ... because other
-- objects depend on it" and takes the whole file down with it.
--
-- Not `drop ... cascade`: that would also remove anything else hanging off the
-- column without saying what, and a schema file should never silently delete
-- something it did not put there.
drop view if exists public.leaderboard;
drop policy if exists "create own profile" on public.profiles;
drop function if exists public.score(int, int, numeric);

alter table public.profiles drop column if exists expected_duraks;

-- Usernames may be in any script: Дурак and 田中 are names like any other.
-- The rule is only that a name is a sensible length, carries no control
-- characters, is not padded with spaces, and has at least one character in it
-- that is neither a space nor punctuation.
--
-- That last test is written as "not space and not punctuation" rather than the
-- more obvious [[:alnum:]] because character classes follow the database's
-- ctype. Under a UTF-8 locale [[:alpha:]] does match Cyrillic and CJK, but
-- under the C locale it matches ASCII only — so an alnum test would quietly
-- reject every non-English name on a database created that way. [[:space:]]
-- and [[:punct:]] are ASCII in the C locale and no wider than they should be
-- in a UTF-8 one, so a letter in any script passes either way.
--
-- Dropped by shape rather than by name, since a database created under the
-- old ASCII-only rule named its constraint automatically.
do $$
declare con_name text;
begin
  for con_name in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'profiles'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%username%'
  loop
    execute format('alter table public.profiles drop constraint %I', con_name);
  end loop;
end
$$;

alter table public.profiles add constraint profiles_username_check check (
  char_length(username) between 3 and 20
  and username = btrim(username)
  and username !~ '[[:cntrl:]]'
  and username ~ '[^[:space:][:punct:]]'
);

-- Two names that look the same should not both exist. Case folded, and
-- normalised to NFC first so that an accented letter typed as one code point
-- and the same letter typed as letter-plus-combining-mark collide rather than
-- sitting side by side on the leaderboard looking identical.
create unique index if not exists profiles_username_unique
  on public.profiles (lower(normalize(username, NFC)));

alter table public.profiles enable row level security;

-- Names, pictures and records are public; that is what a ladder is.
drop policy if exists "profiles are readable" on public.profiles;
create policy "profiles are readable"
  on public.profiles for select
  using (true);

-- You may create your own profile row, once, at the opening rating.
drop policy if exists "create own profile" on public.profiles;
create policy "create own profile"
  on public.profiles for insert
  with check (
    auth.uid() = id
    and wins = 0 and losses = 0 and draws = 0
    and rating = public.rating_start()
  );

-- Deliberately no UPDATE policy. Records move only inside finish_game(), and
-- a name or picture changes only through set_username() / set_avatar().

-- ------------------------------------------------------------------- games --

create table if not exists public.games (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'waiting'
               check (status in ('waiting', 'active', 'finished', 'abandoned')),
  host_id      uuid not null references public.profiles(id) on delete cascade,
  max_players  int  not null default 8 check (max_players between 2 and 8),
  seed         bigint not null,
  state        jsonb,
  version      int  not null default 0,   -- mirrors state->>'version'
  durak_id     uuid references public.profiles(id),
  -- Each player's rating change for this game, keyed by profile id. Decimals:
  -- see the header of src/js/rating.js for why they are not whole numbers.
  rating_delta jsonb,
  -- How long a finished round stays on the table before it may be cleared.
  clear_delay_ms int not null default 10000 check (clear_delay_ms between 0 and 60000),
  -- The same, when the table cannot take another card: just a look at it.
  quick_clear_delay_ms int not null default 2500 check (quick_clear_delay_ms between 0 and 60000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.games add column if not exists rating_delta jsonb;
alter table public.games drop column if exists score_delta;

create index if not exists games_status_created_idx
  on public.games (status, created_at desc);
-- The recent-games feed is every finished game newest first, and a game's
-- last update is the moment it finished. A long game started before a short
-- one can finish after it, so created_at is the wrong order for that list.
create index if not exists games_finished_idx
  on public.games (status, updated_at desc);
create index if not exists games_host_idx on public.games (host_id);

-- Tables seat up to eight. `create table if not exists` leaves an existing
-- games table alone, so a database created when the limit was four keeps the
-- old default and check until this runs.
do $$
declare con_name text;
begin
  for con_name in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'games'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%max_players%'
  loop
    execute format('alter table public.games drop constraint %I', con_name);
  end loop;
end
$$;

alter table public.games
  add constraint games_max_players_check check (max_players between 2 and 8);
alter table public.games alter column max_players set default 8;

-- Tables still waiting for players were opened under the old limit.
update public.games set max_players = 8
 where status = 'waiting' and max_players < 8;

-- One row per seat. Seats are numbered from 0 and match the engine's arrays.
create table if not exists public.game_players (
  game_id   uuid not null references public.games(id) on delete cascade,
  seat      int  not null,
  player_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (game_id, seat),
  unique (game_id, player_id)
);

-- Eight seats, not four. games.max_players has allowed eight for a while, but
-- this check was left at 0..3, so seats five to eight could not be inserted
-- and a table above four players failed the moment the fifth player sat down.
do $$
declare con_name text;
begin
  for con_name in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'game_players'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%seat%'
  loop
    execute format('alter table public.game_players drop constraint %I', con_name);
  end loop;
end
$$;

alter table public.game_players
  add constraint game_players_seat_check check (seat between 0 and 7);

create index if not exists game_players_player_idx on public.game_players (player_id);

alter table public.games enable row level security;
alter table public.game_players enable row level security;

-- Open, running and finished tables are all visible to everyone: the lobby
-- lists the first, anyone may watch the second, and the recent-games feed
-- shows the third to every player whether or not they were at the table.
--
-- A running game's row carries the whole position, every hand included, so
-- anyone signed in can read the cards of a game they are watching. That is
-- deliberate — spectators are meant to see them — but it does mean a player
-- could open another table's position in devtools. A finished game's position
-- gives nothing away, since the game is over. See README, "Trust model".
drop policy if exists "read open or own games" on public.games;
create policy "read open or own games"
  on public.games for select
  using (
    status <> 'abandoned'
    or exists (
      select 1 from public.game_players gp
      where gp.game_id = games.id and gp.player_id = auth.uid()
    )
  );

-- Who sat where is not secret; the lobby and the feed both need it.
drop policy if exists "seats are readable" on public.game_players;
create policy "seats are readable"
  on public.game_players for select
  using (true);

-- No insert/update/delete policies anywhere. All writes are in the functions.

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists games_touch_updated_at on public.games;
create trigger games_touch_updated_at
  before update on public.games
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ rating --

/*
  Rating changes for one finished game. A direct mirror of ratingChanges() in
  src/js/rating.js — that file's header is the explanation, and
  tests/sync.test.mjs holds the two against each other.

  p_ratings is one rating per seat, in seat order. p_durak_index is the
  position of the durak in that array, counting from one, or NULL for a draw.
  The result is one change per seat, in the same order, summing to zero.

  The probability arithmetic is done in double precision rather than numeric
  so that it matches JavaScript exactly, since the browser shows a delta the
  moment a game ends and the database has to arrive at the same number. Only
  the rounding to six decimal places is done as numeric.
*/
create or replace function public.rating_changes(p_ratings numeric[], p_durak_index int)
returns numeric[]
language plpgsql immutable
as $$
declare
  -- Mirrors K, SCALE and FLOOR in src/js/rating.js.
  k        constant float8  := 24;
  scale    constant float8  := 400;
  floor_at constant numeric := 100;
  step     constant numeric := 0.000001;   -- one unit of numeric(12,6)

  n          int := coalesce(array_length(p_ratings, 1), 0);
  strongest  float8;
  weights    float8[] := array[]::float8[];
  total      float8 := 0;
  raw        float8[] := array[]::float8[];
  deltas     numeric[] := array[]::numeric[];
  actual     float8;
  survivors  numeric := 0;
  residual   numeric;
  dir        numeric;
  want       numeric;
  best       int;
  best_want  numeric;
  guard      int := 0;
  is_durak   boolean := p_durak_index is not null and p_durak_index between 1 and n;
  i          int;
begin
  if n = 0 then return array[]::numeric[]; end if;
  if n = 1 then return array[0::numeric]; end if;

  -- Weights are taken relative to the strongest rating at the table, which
  -- keeps the exponent small and the arithmetic away from overflow while
  -- giving exactly the same ratios.
  select max(r)::float8 into strongest from unnest(p_ratings) as r;

  for i in 1..n loop
    weights[i] := power(10::float8, (strongest - p_ratings[i]::float8) / scale);
    total := total + weights[i];
  end loop;

  for i in 1..n loop
    if is_durak then
      actual := case when i = p_durak_index then 1 else 0 end;
    else
      actual := 1::float8 / n;              -- a draw is nobody's fault
    end if;
    raw[i] := -k * (actual - weights[i] / total);
    deltas[i] := round(raw[i]::numeric, 6);
  end loop;

  if is_durak then
    -- The durak absorbs the rounding remainder, which suits a game whose whole
    -- point is that one player carries the loss. At six decimal places the
    -- amount involved is a few millionths of a point.
    for i in 1..n loop
      if i <> p_durak_index then survivors := survivors + deltas[i]; end if;
    end loop;
    deltas[p_durak_index] := -survivors;
  else
    -- A draw has no durak to absorb it, so nudge whichever entries were
    -- rounded furthest from their exact value until the total is zero again.
    select sum(d) into residual from unnest(deltas) as d;
    while residual <> 0 and guard < 100 loop
      guard := guard + 1;
      dir := case when residual > 0 then -step else step end;
      best := 1;
      best_want := null;
      for i in 1..n loop
        want := sign(dir) * (raw[i]::numeric - deltas[i]);
        if best_want is null or want > best_want then
          best_want := want;
          best := i;
        end if;
      end loop;
      deltas[best] := deltas[best] + dir;
      residual := residual + dir;
    end loop;
  end if;

  -- Do not push anyone below the floor. This is the one case where the pool is
  -- not zero sum: points are created rather than taken from someone else.
  for i in 1..n loop
    deltas[i] := greatest(floor_at, p_ratings[i] + deltas[i]) - p_ratings[i];
  end loop;

  return deltas;
end;
$$;

-- ------------------------------------------------------------- leaderboard --

drop view if exists public.leaderboard;
create view public.leaderboard
with (security_invoker = on) as
  select
    id,
    username,
    avatar_url,
    wins + losses + draws as games,
    losses as duraks,
    rating
  from public.profiles
  where wins + losses + draws > 0
  order by rating desc, games desc, username;

-- --------------------------------------------------------------- functions --

-- ------------------------------------------------------------ lobby nudge --
--
-- The lobby learns about changes through realtime, and realtime respects RLS.
-- The moment a table stops being 'waiting', its games row can become invisible
-- to people not sitting at it, so Supabase sends them nothing and the table
-- would stay in their lobby list until they refreshed.
--
-- Seats are readable by everyone, though. Touching the table's seat rows puts
-- an UPDATE on the wire that every lobby receives, and the lobby re-reads its
-- list. Nothing about the seats actually changes.
create or replace function public.nudge_lobby(p_game uuid)
returns void
language sql security definer set search_path = public
as $$
  update game_players set joined_at = joined_at where game_id = p_game;
$$;

revoke all on function public.nudge_lobby(uuid) from public, anon, authenticated;
-- Deliberately not granted to anyone: only the functions below call it.

-- --------------------------------------------------------- name & picture --

-- Change your own name. The check constraint above decides what is allowed;
-- this only tidies the input and turns a collision into a readable message.
create or replace function public.set_username(p_name text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  name text := btrim(coalesce(p_name, ''));
  row  public.profiles;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  update profiles set username = name where id = me returning * into row;
  if not found then
    raise exception 'finish creating your profile first';
  end if;
  return row;
exception
  when unique_violation then
    raise exception 'somebody is already using that name';
  when check_violation then
    raise exception 'a name needs 3 to 20 characters and at least one letter or digit';
end;
$$;

-- Set or clear your own picture. The file itself lives in the `avatars`
-- storage bucket, which only lets you write under your own user id; this
-- records where it ended up. NULL removes it.
create or replace function public.set_avatar(p_url text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  me  uuid := auth.uid();
  row public.profiles;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if p_url is not null and p_url !~ '^https://' then
    raise exception 'a picture address must be https';
  end if;
  if p_url is not null and char_length(p_url) > 500 then
    raise exception 'that address is too long';
  end if;

  update profiles set avatar_url = p_url where id = me returning * into row;
  if not found then
    raise exception 'finish creating your profile first';
  end if;
  return row;
end;
$$;

-- ------------------------------------------------------------ create_game --
create or replace function public.create_game(p_max_players int default 8)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  me  uuid := auth.uid();
  row public.games;
  stale_id uuid;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from profiles where id = me) then
    raise exception 'finish creating your profile first';
  end if;
  if p_max_players < 2 or p_max_players > 8 then
    raise exception 'a table seats between two and eight players';
  end if;

  -- One open table per host: opening a new one closes the old.
  for stale_id in
    update games set status = 'abandoned'
     where host_id = me and status = 'waiting'
    returning id
  loop
    perform public.nudge_lobby(stale_id);
  end loop;

  insert into games (host_id, max_players, seed)
  values (me, p_max_players, floor(random() * 2147483646)::bigint)
  returning * into row;

  insert into game_players (game_id, seat, player_id) values (row.id, 0, me);

  return row;
end;
$$;

-- Sit down at a waiting table. When the seat you take is the last one, you
-- also deal: p_state is the opening position, built from the stored seed for
-- the full player count.
create or replace function public.join_game(p_game uuid, p_state jsonb default null)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  row   public.games;
  taken int;
  seat  int;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  select * into row from games where id = p_game for update;
  if not found then
    raise exception 'no such game';
  end if;
  if row.status <> 'waiting' then
    raise exception 'that table is no longer open';
  end if;
  if exists (select 1 from game_players where game_id = p_game and player_id = me) then
    raise exception 'you are already at this table';
  end if;

  select count(*) into taken from game_players where game_id = p_game;
  if taken >= row.max_players then
    raise exception 'that table is full';
  end if;

  seat := taken;
  insert into game_players (game_id, seat, player_id) values (p_game, seat, me);
  taken := taken + 1;

  -- Taking the final seat starts the game.
  if taken = row.max_players then
    if p_state is null or jsonb_typeof(p_state) <> 'object' then
      raise exception 'the last player to sit down must deal';
    end if;
    perform public.assert_opening(p_state, row.seed, taken);
    update games
       set state = p_state, status = 'active', version = 0
     where id = p_game
    returning * into row;
  end if;

  return row;
end;
$$;

-- ------------------------------------------------------------- start_game --
create or replace function public.start_game(p_game uuid, p_state jsonb)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  row   public.games;
  taken int;
begin
  select * into row from games where id = p_game for update;
  if not found then
    raise exception 'no such game';
  end if;
  if row.host_id <> me then
    raise exception 'only the host can start the game';
  end if;
  if row.status <> 'waiting' then
    raise exception 'that table has already started';
  end if;

  select count(*) into taken from game_players where game_id = p_game;
  if taken < 2 then
    raise exception 'you need at least two players';
  end if;

  perform public.assert_opening(p_state, row.seed, taken);

  update games
     set state = p_state, status = 'active', version = 0, max_players = taken
   where id = p_game
  returning * into row;

  perform public.nudge_lobby(p_game);
  return row;
end;
$$;

-- Shared sanity check on a submitted opening position.
create or replace function public.assert_opening(p_state jsonb, p_seed bigint, p_count int)
returns void
language plpgsql immutable set search_path = public
as $$
begin
  if (p_state->>'seed')::bigint is distinct from p_seed then
    raise exception 'opening position does not match this table''s seed';
  end if;
  if (p_state->>'playerCount')::int is distinct from p_count then
    raise exception 'opening position is dealt for the wrong number of players';
  end if;
  if coalesce((p_state->>'version')::int, -1) <> 0 then
    raise exception 'an opening position must be at version 0';
  end if;
end;
$$;

-- Record a move.
--
-- Attacking is free-for-all, so two players really can submit at the same
-- instant. p_base_version is the version the caller built on; if the position
-- has moved since, the write is refused and the caller re-applies against the
-- fresh state. Without this, one of the two cards would vanish.
create or replace function public.submit_move(
  p_game uuid, p_state jsonb, p_base_version int
)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  me        uuid := auth.uid();
  row       public.games;
  my_seat   int;
  defender  int;
  attacker  int;
  table_len int;
  log_len   int;
  open_len  int;
  room      int;
  delay_ms  int;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  select * into row from games where id = p_game for update;
  if not found then
    raise exception 'no such game';
  end if;
  if row.status <> 'active' then
    raise exception 'this game is not in progress';
  end if;

  select seat into my_seat from game_players
   where game_id = p_game and player_id = me;
  if my_seat is null then
    raise exception 'you are not seated at this table';
  end if;

  if row.version <> p_base_version then
    raise exception 'stale position';   -- somebody moved first; retry
  end if;
  if coalesce((p_state->>'version')::int, -1) <> row.version + 1 then
    raise exception 'a move must advance the position by exactly one';
  end if;

  if coalesce((row.state->'out'->my_seat)::text, 'false') = 'true' then
    raise exception 'you are out of this game';
  end if;

  attacker  := (row.state->>'attacker')::int;
  defender  := (row.state->>'defender')::int;
  table_len := jsonb_array_length(row.state->'table');

  -- The rules live in the engine, but this much is cheap to enforce here:
  -- the opening card of a round belongs to the primary attacker.
  if my_seat <> defender and table_len = 0 and my_seat <> attacker then
    raise exception 'the opening card belongs to the attacker';
  end if;

  if (p_state->>'seed')::bigint is distinct from row.seed
     or p_state->>'trump' is distinct from row.state->>'trump'
     or (p_state->>'playerCount')::int is distinct from (row.state->>'playerCount')::int then
    raise exception 'the deal cannot change mid-game';
  end if;

  -- A clear (the table emptying itself after a round) must wait until the
  -- position has been on show long enough. updated_at is when that position
  -- was written, so one slow or modified browser cannot cut the pause short
  -- for everyone. The engine marks a clear by making {"t":"clear"} the first
  -- new log entry.
  --
  -- If the table cannot take another card (six down, or the defender has
  -- nothing left to answer with) nobody can throw in, so only the short
  -- quick_clear_delay_ms applies. Mirrors isQuickClear() in durak.js.
  log_len := coalesce(jsonb_array_length(row.state->'log'), 0);
  if p_state->'log'->log_len->>'t' = 'clear' then
    select count(*) into open_len
      from jsonb_array_elements(row.state->'table') slot
     where coalesce(jsonb_typeof(slot->'def'), 'null') = 'null';
    -- While defending, the defender's hand limits the table; once taking,
    -- only the six-card limit does. Mirrors attackCapacity() in durak.js.
    room := case
      when coalesce((row.state->>'taking')::boolean, false) then 6 - table_len
      else least(
        6 - table_len,
        coalesce(jsonb_array_length(row.state->'hands'->defender), 0) - open_len
      )
    end;
    delay_ms := case when room <= 0 then row.quick_clear_delay_ms else row.clear_delay_ms end;
    if now() < row.updated_at + delay_ms * interval '1 millisecond' then
      raise exception 'too early to clear the table';
    end if;
  end if;

  update games
     set state = p_state, version = row.version + 1
   where id = p_game
  returning * into row;

  return row;
end;
$$;

-- Settle the game and move everyone's rating.
--
-- p_durak_seat is the seat of the fool, or -1 for a draw. You may only name
-- someone else the durak if the stored position agrees; naming yourself is
-- always allowed, which is how conceding works.
--
-- The ratings at the table decide what the result was worth, and
-- public.rating_changes() turns that into one change per seat. The changes
-- always sum to zero, so nothing is created or destroyed, and the whole thing
-- happens in one transaction with the row being marked finished. A client
-- never sends a rating or any part of one.
create or replace function public.finish_game(p_game uuid, p_durak_seat int)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  me          uuid := auth.uid();
  row         public.games;
  my_seat     int;
  n           int;
  finished    boolean;
  is_draw     boolean;
  claimed     int;
  seats       int[];
  ids         uuid[];
  ratings     numeric[];
  deltas      numeric[];
  durak_index int := null;
  durak_uuid  uuid := null;
  payload     jsonb := '{}'::jsonb;
  i           int;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  select * into row from games where id = p_game for update;
  if not found then
    raise exception 'no such game';
  end if;
  if row.status = 'finished' then
    return row;                         -- every client reports; first one wins
  end if;
  if row.status <> 'active' then
    raise exception 'this game is not in progress';
  end if;

  select seat into my_seat from game_players
   where game_id = p_game and player_id = me;
  if my_seat is null then
    raise exception 'you are not seated at this table';
  end if;

  finished := coalesce((row.state->>'finished')::boolean, false);
  is_draw  := coalesce((row.state->>'draw')::boolean, false);

  if finished then
    claimed := case when is_draw then -1 else (row.state->>'durak')::int end;
    if claimed is distinct from p_durak_seat then
      raise exception 'that is not the result of this game';
    end if;
  elsif p_durak_seat <> my_seat then
    raise exception 'you can only concede on your own behalf';
  else
    is_draw := false;                   -- a concession is not a draw
  end if;

  -- Seat order throughout, so index i in every array is the same player.
  select array_agg(gp.seat order by gp.seat),
         array_agg(gp.player_id order by gp.seat)
    into seats, ids
    from game_players gp
   where gp.game_id = p_game;

  n := array_length(seats, 1);
  if n is null or n < 2 then
    raise exception 'this table never had enough players';
  end if;

  -- Lock every profile before reading the ratings the changes are computed
  -- from, so two tables finishing at the same instant cannot both work from
  -- the same stale rating for a player who was at both.
  perform 1 from profiles where id = any(ids) for update;

  select array_agg(p.rating order by array_position(ids, p.id))
    into ratings
    from profiles p
   where p.id = any(ids);

  if p_durak_seat <> -1 then
    for i in 1..n loop
      if seats[i] = p_durak_seat then
        durak_index := i;
        durak_uuid := ids[i];
      end if;
    end loop;
  end if;

  deltas := public.rating_changes(ratings, durak_index);

  for i in 1..n loop
    if p_durak_seat = -1 then
      update profiles set draws = draws + 1, rating = rating + deltas[i]
       where id = ids[i];
    elsif seats[i] = p_durak_seat then
      update profiles set losses = losses + 1, rating = rating + deltas[i]
       where id = ids[i];
    else
      update profiles set wins = wins + 1, rating = rating + deltas[i]
       where id = ids[i];
    end if;

    payload := payload || jsonb_build_object(ids[i]::text, deltas[i]);
  end loop;

  update games
     set status = 'finished', durak_id = durak_uuid, rating_delta = payload
   where id = p_game
  returning * into row;

  return row;
end;
$$;

-- ----------------------------------------------------------- abandon_game --
--
-- The host closes a table that has not started, however many people are
-- sitting at it. They are sent back to the lobby by their own browsers, which
-- see the status change. Records are untouched.
create or replace function public.abandon_game(p_game uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me  uuid := auth.uid();
  row public.games;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  select * into row from games where id = p_game for update;
  if not found then
    raise exception 'no such game';
  end if;
  if row.host_id <> me then
    raise exception 'only the host can close this table';
  end if;
  if row.status = 'abandoned' then
    return;                              -- already closed; nothing to do
  end if;
  if row.status <> 'waiting' then
    raise exception 'that table has already started';
  end if;

  update games set status = 'abandoned' where id = p_game;
  perform public.nudge_lobby(p_game);
end;
$$;

-- ------------------------------------------------------------ leave_table --
create or replace function public.leave_table(p_game uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  row public.games;
begin
  select * into row from games where id = p_game for update;
  if not found or row.status <> 'waiting' then
    return;
  end if;
  if row.host_id = auth.uid() then
    update games set status = 'abandoned' where id = p_game;
    perform public.nudge_lobby(p_game);
    return;
  end if;
  -- A deleted seat already reaches every lobby, so no nudge is needed here.
  delete from game_players where game_id = p_game and player_id = auth.uid();
end;
$$;

-- ------------------------------------------------------------- table chat --
--
-- Every table has a chat of its own, for the people sitting at it: in the
-- waiting room while it fills, across the felt while it is played, and for a
-- few minutes after it ends. Spectators get none of it — they can neither
-- read it nor write to it — so the table can talk without the stands
-- listening, and the stands cannot heckle.
--
-- That is enforced here rather than by the page hiding a box. Reading is
-- limited by the select policy below, and realtime applies the same policy to
-- the stream, so a spectator's browser is never sent a message at all.
-- Writing goes through send_message(), like every other write.
--
-- A player who gets up from a waiting table loses sight of its chat along
-- with the seat; what they said stays for the people still sitting there.
create table if not exists public.game_messages (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  player_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  -- Counted in characters, like names, so the limit means the same in any
  -- script. One line: the box is a single-line input, and a control
  -- character has no business in a chat line.
  constraint game_messages_body_check check (
    char_length(body) between 1 and 300
    and body = btrim(body)
    and body !~ '[[:cntrl:]]'
  )
);

create index if not exists game_messages_game_idx
  on public.game_messages (game_id, id);

alter table public.game_messages enable row level security;

drop policy if exists "seated players read their table's chat" on public.game_messages;
create policy "seated players read their table's chat"
  on public.game_messages for select
  using (
    exists (
      select 1 from public.game_players gp
      where gp.game_id = game_messages.game_id and gp.player_id = auth.uid()
    )
  );

-- Deliberately no insert, update or delete policy: send_message() is the one
-- way in, and nothing edits or removes a line once it is said.

create or replace function public.send_message(p_game uuid, p_body text)
returns public.game_messages
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  msg    text := btrim(coalesce(p_body, ''));
  g      public.games;
  recent int;
  row    public.game_messages;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  select * into g from games where id = p_game;
  if not found then
    raise exception 'no such game';
  end if;
  if not exists (
    select 1 from game_players where game_id = p_game and player_id = me
  ) then
    raise exception 'only the players at this table can use its chat';
  end if;
  if g.status = 'abandoned' then
    raise exception 'that table was closed';
  end if;
  -- Long enough after the last card for a "good game"; not a message board.
  if g.status = 'finished' and g.updated_at < now() - interval '15 minutes' then
    raise exception 'this game is over';
  end if;

  if char_length(msg) = 0 then
    raise exception 'say something first';
  end if;
  if char_length(msg) > 300 then
    raise exception 'a message can be at most 300 characters';
  end if;
  if msg ~ '[[:cntrl:]]' then
    raise exception 'a message has to be one line of text';
  end if;

  -- Enough for a conversation, not enough to bury the table in a flood.
  select count(*) into recent
    from game_messages
   where game_id = p_game and player_id = me
     and created_at > now() - interval '10 seconds';
  if recent >= 8 then
    raise exception 'you are sending messages too quickly';
  end if;

  insert into game_messages (game_id, player_id, body)
  values (p_game, me, msg)
  returning * into row;

  return row;
end;
$$;

-- ----------------------------------------------------------------- grants --

revoke all on function public.create_game(int)                    from public;
revoke all on function public.join_game(uuid, jsonb)              from public;
revoke all on function public.start_game(uuid, jsonb)             from public;
revoke all on function public.submit_move(uuid, jsonb, int)       from public;
revoke all on function public.finish_game(uuid, int)              from public;
revoke all on function public.abandon_game(uuid)                  from public;
revoke all on function public.leave_table(uuid)                   from public;
revoke all on function public.set_username(text)                  from public;
revoke all on function public.set_avatar(text)                    from public;
revoke all on function public.send_message(uuid, text)            from public;

grant execute on function public.create_game(int)                 to authenticated;
grant execute on function public.join_game(uuid, jsonb)           to authenticated;
grant execute on function public.start_game(uuid, jsonb)          to authenticated;
grant execute on function public.submit_move(uuid, jsonb, int)    to authenticated;
grant execute on function public.finish_game(uuid, int)           to authenticated;
grant execute on function public.abandon_game(uuid)               to authenticated;
grant execute on function public.leave_table(uuid)                to authenticated;
grant execute on function public.set_username(text)               to authenticated;
grant execute on function public.set_avatar(text)                 to authenticated;
grant execute on function public.send_message(uuid, text)         to authenticated;

-- --------------------------------------------------------------- avatars --

/*
  Profile pictures live in a public storage bucket, one folder per player,
  named with their user id. Anyone may look; you may only write inside your
  own folder, which is what stops one player replacing another's picture.

  Storage lives in a schema this file may not own, depending on how the
  project was created. If that is the case the block below says so and changes
  nothing — see README, "Profile pictures", for the three clicks that do the
  same thing from the Storage tab.
*/
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatars', 'avatars', true, 2097152,
          array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  on conflict (id) do update
     set public = true,
         file_size_limit = 2097152,
         allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  execute 'drop policy if exists "avatars are readable" on storage.objects';
  execute $p$
    create policy "avatars are readable" on storage.objects
      for select using (bucket_id = 'avatars')
  $p$;

  execute 'drop policy if exists "write own avatar" on storage.objects';
  execute $p$
    create policy "write own avatar" on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $p$;

  execute 'drop policy if exists "replace own avatar" on storage.objects';
  execute $p$
    create policy "replace own avatar" on storage.objects
      for update to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $p$;

  execute 'drop policy if exists "remove own avatar" on storage.objects';
  execute $p$
    create policy "remove own avatar" on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
      )
  $p$;
exception when others then
  raise notice 'Skipped the avatars bucket (%). Create it from the Storage tab instead — see README, "Profile pictures".', sqlerrm;
end
$$;

-- --------------------------------------------------------------- realtime --

-- Lets the browser subscribe to tables, seats and table chat. RLS still
-- applies to the stream, so you only receive rows you are allowed to read —
-- which is what keeps a table's chat away from the people watching it.
--
-- Adding a table that is already published is an error, and the SQL editor
-- runs this file as one transaction, so that error would roll back everything
-- above it. Add each table only if it is not there yet.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_players'
  ) then
    alter publication supabase_realtime add table public.game_players;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_messages'
  ) then
    alter publication supabase_realtime add table public.game_messages;
  end if;
end
$$;