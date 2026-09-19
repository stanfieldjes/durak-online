-- Durak Online — schema, policies, and RPCs. Tables seat four; the host can
-- start as soon as two are seated.
-- Paste the whole file into the Supabase SQL editor and run it once.
--
-- Design rule: the browser never writes to a table directly. Every write goes
-- through a SECURITY DEFINER function that re-checks the claim being made.
-- In particular a client can never set its own score. Scores are derived from
-- win and loss totals the database keeps itself, never sent by a client.

-- ---------------------------------------------------------------- profiles --

create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  username   text unique not null
             check (char_length(username) between 3 and 20
                    and username ~ '^[A-Za-z0-9_ -]+$'),
  wins       int  not null default 0,
  losses     int  not null default 0,   -- games ended as the durak
  draws      int  not null default 0,
  -- Running total of each game's 1/playerCount: how many times the table
  -- sizes played say this player should have been the durak.
  expected_duraks numeric(12,6) not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Names and records are public; that is what a ladder is.
drop policy if exists "profiles are readable" on public.profiles;
create policy "profiles are readable"
  on public.profiles for select
  using (true);

-- You may create your own profile row, once, with the defaults above.
drop policy if exists "create own profile" on public.profiles;
create policy "create own profile"
  on public.profiles for insert
  with check (
    auth.uid() = id
    and wins = 0 and losses = 0 and draws = 0 and expected_duraks = 0
  );

-- Deliberately no UPDATE policy: records move only inside finish_game().

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
  score_delta  jsonb,
  -- How long a finished round stays on the table before it may be cleared.
  clear_delay_ms int not null default 10000 check (clear_delay_ms between 0 and 60000),
  -- The same, when the table cannot take another card: just a look at it.
  quick_clear_delay_ms int not null default 2500 check (quick_clear_delay_ms between 0 and 60000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists games_status_created_idx
  on public.games (status, created_at desc);
create index if not exists games_host_idx on public.games (host_id);

-- Tables seat up to eight. `create table if not exists` above leaves an
-- existing games table alone, so a database created when the limit was four
-- keeps the old default and check until this runs. Safe to run repeatedly:
-- it drops whatever check is on max_players, whatever it was named, and puts
-- the current one back.
do $$
declare
  con_name text;
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
  seat      int  not null check (seat between 0 and 3),
  player_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (game_id, seat),
  unique (game_id, player_id)
);

create index if not exists game_players_player_idx on public.game_players (player_id);

alter table public.games enable row level security;
alter table public.game_players enable row level security;

-- Open and running tables are visible to everyone, so the lobby can list them
-- and anyone can watch a game in progress; finished games stay private to the
-- people who played them.
--
-- A running game's row carries the whole position, every hand included, so
-- anyone signed in can read the cards of a game they are watching. That is
-- deliberate — spectators are meant to see them — but it does mean a player
-- could open another table's position in devtools. See README, "Trust model".
drop policy if exists "read open or own games" on public.games;
create policy "read open or own games"
  on public.games for select
  using (
    status in ('waiting', 'active')
    or exists (
      select 1 from public.game_players gp
      where gp.game_id = games.id and gp.player_id = auth.uid()
    )
  );

-- Who is sitting where is not secret; the lobby needs it to show tables.
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

-- ------------------------------------------------------------- leaderboard --

-- Score: how much better a player does than the table sizes they play would
-- predict, in percentage points. See public.score() below.
create or replace function public.score(p_games int, p_duraks int, p_expected numeric)
returns int
language sql immutable
as $$
  select case
           when p_games <= 0 then 0
           else round(100.0 * (p_expected - p_duraks) / p_games)::int
         end;
$$;

drop view if exists public.leaderboard;
create view public.leaderboard
with (security_invoker = on) as
  select
    id,
    username,
    wins + losses + draws as games,
    losses as duraks,
    expected_duraks,
    round(100.0 * losses / nullif(wins + losses + draws, 0))::int as durak_rate,
    round(100.0 * expected_duraks / nullif(wins + losses + draws, 0))::int as expected_rate,
    public.score(wins + losses + draws, losses, expected_duraks) as score
  from public.profiles
  where wins + losses + draws > 0
  order by score desc, games desc, username;

-- --------------------------------------------------------------- functions --

-- ------------------------------------------------------------ lobby nudge --
--
-- The lobby learns about changes through realtime, and realtime respects RLS.
-- The moment a table stops being 'waiting', its games row becomes invisible to
-- everyone not sitting at it, so Supabase sends them nothing: the table would
-- stay in their lobby list until they refreshed.
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

-- ------------------------------------------------------------ create_game --
--
-- Always four seats. The parameter stays so a browser still running the old
-- page can call it, but whatever it asks for, the table seats four; the host
-- can start early once two people are seated.
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

-- Settle the game and update everyone's record.
--
-- p_durak_seat is the seat of the fool, or -1 for a draw. You may only name
-- someone else the durak if the stored position agrees; naming yourself is
-- always allowed, which is how conceding works.
--
-- Every seat's expected_duraks grows by 1/n for this game, where n is how many
-- people were at the table, and the durak's loss count grows by one. Score is
-- derived from those totals rather than stored, so it can never drift out of
-- step with the games behind it. See public.score() and src/js/score.js.
create or replace function public.finish_game(p_game uuid, p_durak_seat int)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  me         uuid := auth.uid();
  row        public.games;
  my_seat    int;
  n          int;
  finished   boolean;
  is_draw    boolean;
  claimed    int;
  seats      int[];
  ids        uuid[];
  share      numeric;
  before     int;
  after      int;
  i          int;
  durak_uuid uuid;
  payload    jsonb := '{}'::jsonb;
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

  select array_agg(gp.seat order by gp.seat),
         array_agg(gp.player_id order by gp.seat)
    into seats, ids
    from game_players gp
   where gp.game_id = p_game;

  n := array_length(seats, 1);
  if n is null or n < 2 then
    raise exception 'this table never had enough players';
  end if;
  perform 1 from profiles where id = any(ids) for update;

  -- One durak per game, so each seat carries 1/n of the blame in advance.
  share := 1.0 / n;

  for i in 1..n loop
    select public.score(wins + losses + draws, losses, expected_duraks)
      into before
      from profiles where id = ids[i];

    if p_durak_seat = -1 then
      update profiles
         set draws = draws + 1,
             expected_duraks = expected_duraks + share
       where id = ids[i];
    elsif seats[i] = p_durak_seat then
      update profiles
         set losses = losses + 1,
             expected_duraks = expected_duraks + share
       where id = ids[i];
    else
      update profiles
         set wins = wins + 1,
             expected_duraks = expected_duraks + share
       where id = ids[i];
    end if;

    select public.score(wins + losses + draws, losses, expected_duraks)
      into after
      from profiles where id = ids[i];

    payload := payload || jsonb_build_object(ids[i]::text, after - before);
  end loop;

  durak_uuid := null;
  if p_durak_seat <> -1 then
    for i in 1..n loop
      if seats[i] = p_durak_seat then durak_uuid := ids[i]; end if;
    end loop;
  end if;

  update games
     set status = 'finished', durak_id = durak_uuid, score_delta = payload
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

-- ----------------------------------------------------------------- grants --

revoke all on function public.create_game(int)                    from public;
revoke all on function public.join_game(uuid, jsonb)              from public;
revoke all on function public.start_game(uuid, jsonb)             from public;
revoke all on function public.submit_move(uuid, jsonb, int)       from public;
revoke all on function public.finish_game(uuid, int)              from public;
revoke all on function public.abandon_game(uuid)                  from public;
revoke all on function public.leave_table(uuid)                   from public;

grant execute on function public.create_game(int)                 to authenticated;
grant execute on function public.join_game(uuid, jsonb)           to authenticated;
grant execute on function public.start_game(uuid, jsonb)          to authenticated;
grant execute on function public.submit_move(uuid, jsonb, int)    to authenticated;
grant execute on function public.finish_game(uuid, int)           to authenticated;
grant execute on function public.abandon_game(uuid)               to authenticated;
grant execute on function public.leave_table(uuid)                to authenticated;

-- --------------------------------------------------------------- realtime --

-- Lets the browser subscribe to tables and seats. RLS still applies to the
-- stream, so you only receive rows you are allowed to read.
--
-- Adding a table that is already published is an error, and the SQL editor
-- runs this file as one transaction, so that error would roll back
-- everything above it. Add each table only if it is not there yet.
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
end
$$;