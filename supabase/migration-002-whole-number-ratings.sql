-- Migration 002 — whole-number ratings, and a ladder that shows only rating
-- and durak rate.
--
-- Run this once in the Supabase SQL editor IF you already ran schema.sql
-- before this change. A fresh project only needs schema.sql, which already
-- contains everything below.
--
-- Existing ratings are rounded to the nearest whole number. Nobody's standing
-- moves by more than half a point.
--
-- Order matters here. Postgres refuses to change a column's type while a
-- policy or a view still refers to it, so both are dropped first and rebuilt
-- afterwards. It is all one transaction, so a failure anywhere leaves the
-- database exactly as it was.

begin;

-- 1. Clear the things that depend on profiles.rating.
drop policy if exists "create own profile" on public.profiles;
drop view if exists public.leaderboard;

-- 2. Change the column.
alter table public.profiles
  alter column rating type int using round(rating)::int;

alter table public.profiles
  alter column rating set default 100;

-- 3. Put the policy back, unchanged apart from the column's new type.
create policy "create own profile"
  on public.profiles for insert
  with check (
    auth.uid() = id
    and rating = 100 and wins = 0 and losses = 0 and draws = 0
  );

-- 4. Rebuild the ladder.
-- The ladder answers one question: how good is this player, and how often do
-- they end up holding the cards. Nothing else belongs on it.
create view public.leaderboard
with (security_invoker = on) as
  select
    id,
    username,
    rating,
    round(100.0 * losses / nullif(wins + losses + draws, 0))::int as durak_rate
  from public.profiles
  where wins + losses + draws > 0
  order by rating desc, durak_rate asc, username;

-- 5. Replace the scoring function with the whole-number version.
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
  floor_at   constant int     := 0;
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
  ratings    int[];
  raw        numeric[];
  deltas     int[];
  expected   numeric;
  actual     numeric;
  survivors  int;
  residual   int;
  step       int;
  best       int;
  best_want  numeric;
  want       numeric;
  guard      int;
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

  raw    := array_fill(0::numeric, array[n]);
  deltas := array_fill(0, array[n]);

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

    raw[i] := k * (actual - expected);
    if seats[i] = p_durak_seat and raw[i] < 0 then
      raw[i] := raw[i] * loss_bias;
    end if;
    deltas[i] := round(raw[i])::int;
  end loop;

  -- Ratings are whole numbers, and rounding each share separately would not add
  -- back up. Survivors keep their clean numbers and the durak takes the
  -- remainder. On a draw there is nobody to absorb it, so nudge whichever
  -- entries were rounded furthest from their exact value.
  if p_durak_seat <> -1 then
    survivors := 0;
    for i in 1..n loop
      if seats[i] <> p_durak_seat then survivors := survivors + deltas[i]; end if;
    end loop;
    for i in 1..n loop
      if seats[i] = p_durak_seat then deltas[i] := -survivors; end if;
    end loop;
  else
    residual := 0;
    for i in 1..n loop residual := residual + deltas[i]; end loop;
    guard := 0;
    while residual <> 0 and guard < 100 loop
      guard := guard + 1;
      step := case when residual > 0 then -1 else 1 end;
      best := 1;
      best_want := -1000000;
      for i in 1..n loop
        want := step * (raw[i] - deltas[i]);
        if want > best_want then
          best_want := want;
          best := i;
        end if;
      end loop;
      deltas[best] := deltas[best] + step;
      residual := residual + step;
    end loop;
  end if;

  -- Nobody drops below the floor.
  for i in 1..n loop
    if ratings[i] + deltas[i] < floor_at then
      deltas[i] := floor_at - ratings[i];
    end if;
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

commit;
