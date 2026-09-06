-- Durak Online — schema, policies, and RPCs. 2 to 4 players.
-- Paste the whole file into the Supabase SQL editor and run it once.
--
-- Design rule: the browser never writes to a table directly. Every write goes
-- through a SECURITY DEFINER function that re-checks the claim being made.
-- In particular a client can never set its own rating — finish_game computes
-- every rating from values already in the database.

-- ---------------------------------------------------------------- profiles --

create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  username   text unique not null
             check (char_length(username) between 3 and 20
                    and username ~ '^[A-Za-z0-9_ -]+$'),
  rating     numeric(7,2) not null default 100,
  wins       int  not null default 0,
  losses     int  not null default 0,
  draws      int  not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Names and ratings are public; that is what a ladder is.
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
    and rating = 100 and wins = 0 and losses = 0 and draws = 0
  );

-- Deliberately no UPDATE policy: ratings move only inside finish_game().

-- ------------------------------------------------------------------- games --

create table if not exists public.games (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'waiting'
               check (status in ('waiting', 'active', 'finished', 'abandoned')),
  host_id      uuid not null references public.profiles(id) on delete cascade,
  max_players  int  not null default 2 check (max_players between 2 and 4),
  seed         bigint not null,
  state        jsonb,
  version      int  not null default 0,   -- mirrors state->>'version'
  durak_id     uuid references public.profiles(id),
  rating_delta jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists games_status_created_idx
  on public.games (status, created_at desc);
create index if not exists games_host_idx on public.games (host_id);

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

-- Open tables are visible to everyone so the lobby can list them; otherwise
-- you only see games you are sitting at.
drop policy if exists "read open or own games" on public.games;
create policy "read open or own games"
  on public.games for select
  using (
    status = 'waiting'
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

create or replace view public.leaderboard
with (security_invoker = on) as
  select id, username, rating, wins, losses, draws
  from public.profiles
  where wins + losses + draws > 0
  order by rating desc, wins desc;

-- --------------------------------------------------------------- functions --

-- Open a table for 2 to 4. One waiting table per player, and the seed is
-- issued here so nobody can shop for a deal they like.
create or replace function public.create_game(p_max_players int default 2)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  me  uuid := auth.uid();
  row public.games;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if p_max_players < 2 or p_max_players > 4 then
    raise exception 'a table seats 2 to 4 players';
  end if;
  if not exists (select 1 from profiles where id = me) then
    raise exception 'finish creating your profile first';
  end if;

  update games set status = 'abandoned'
   where host_id = me and status = 'waiting';

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

-- Host may start a partly filled table, as long as two people are seated.
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

  update games
     set state = p_state, version = row.version + 1
   where id = p_game
  returning * into row;

  return row;
end;
$$;

-- Settle the game and move every rating.
--
-- p_durak_seat is the seat of the fool, or -1 for a draw. You may only name
-- someone else the durak if the stored position agrees; naming yourself is
-- always allowed, which is how conceding works.
--
-- Scoring, mirroring src/js/elo.js:
--   expected_i = mean over j<>i of 1 / (1 + 10^((r_j - r_i) / scale))
--   actual_i   = 0 for the durak, (1 + 0.5(n-2))/(n-1) for everyone else,
--                0.5 for everyone on a draw
--   delta_i    = k * (actual_i - expected_i)
-- Both sides sum to n/2, so the pool is zero sum at loss_bias = 1.
create or replace function public.finish_game(p_game uuid, p_durak_seat int)
returns public.games
language plpgsql security definer set search_path = public
as $$
declare
  k          constant numeric := 10;    -- keep in step with src/js/elo.js
  scale      constant numeric := 200;
  floor_at   constant numeric := 0;
  loss_bias  constant numeric := 1;     -- >1 destroys points; see README
  me         uuid := auth.uid();
  row        public.games;
  my_seat    int;
  n          int;
  finished   boolean;
  is_draw    boolean;
  claimed    int;
  seats      int[];
  ids        uuid[];
  ratings    numeric[];
  deltas     numeric[];
  expected   numeric;
  actual     numeric;
  d          numeric;
  i          int;
  j          int;
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

  -- Seats in order, with their current ratings locked for the transaction.
  select array_agg(gp.seat order by gp.seat),
         array_agg(gp.player_id order by gp.seat),
         array_agg(p.rating order by gp.seat)
    into seats, ids, ratings
    from game_players gp
    join profiles p on p.id = gp.player_id
   where gp.game_id = p_game;

  n := array_length(seats, 1);
  if n is null or n < 2 then
    raise exception 'this table never had enough players';
  end if;
  perform 1 from profiles where id = any(ids) for update;

  deltas := array_fill(0::numeric, array[n]);

  for i in 1..n loop
    expected := 0;
    for j in 1..n loop
      if i <> j then
        expected := expected + 1.0 / (1.0 + power(10.0, (ratings[j] - ratings[i]) / scale));
      end if;
    end loop;
    expected := expected / (n - 1);

    if p_durak_seat = -1 then
      actual := 0.5;
    elsif seats[i] = p_durak_seat then
      actual := 0;
    else
      actual := (1 + 0.5 * (n - 2)) / (n - 1);
    end if;

    d := k * (actual - expected);
    if seats[i] = p_durak_seat and d < 0 then
      d := d * loss_bias;
    end if;
    d := round(d, 2);

    -- Nobody drops below the floor.
    if ratings[i] + d < floor_at then
      d := round(floor_at - ratings[i], 2);
    end if;
    deltas[i] := d;
  end loop;

  for i in 1..n loop
    if p_durak_seat = -1 then
      update profiles set rating = rating + deltas[i], draws = draws + 1
       where id = ids[i];
    elsif seats[i] = p_durak_seat then
      update profiles set rating = rating + deltas[i], losses = losses + 1
       where id = ids[i];
    else
      update profiles set rating = rating + deltas[i], wins = wins + 1
       where id = ids[i];
    end if;
    payload := payload || jsonb_build_object(ids[i]::text, deltas[i]);
  end loop;

  durak_uuid := null;
  if p_durak_seat <> -1 then
    for i in 1..n loop
      if seats[i] = p_durak_seat then durak_uuid := ids[i]; end if;
    end loop;
  end if;

  update games
     set status = 'finished', durak_id = durak_uuid, rating_delta = payload
   where id = p_game
  returning * into row;

  return row;
end;
$$;

-- Withdraw a table nobody has joined. Ratings are untouched.
create or replace function public.abandon_game(p_game uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  taken int;
begin
  select count(*) into taken from game_players where game_id = p_game;
  update games
     set status = 'abandoned'
   where id = p_game
     and host_id = auth.uid()
     and status = 'waiting'
     and taken <= 1;
end;
$$;

-- Leave a table you joined but that has not started.
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
    return;
  end if;
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
alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.game_players;
