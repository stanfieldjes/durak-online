-- Migration 005 — replace the Elo rating with a score.
--
-- Run this once in the Supabase SQL editor IF you already ran schema.sql or an
-- earlier migration. A fresh project only needs schema.sql.
--
-- Score is how much better a player does than the table sizes they play would
-- predict, in percentage points:
--
--     score = (expected durak rate - actual durak rate) x 100
--
-- At a table of n players one of them is the durak, so each seat carries 1/n
-- of the blame in advance. Adding that up across a player's games gives how
-- often they should have been the durak; comparing it to how often they were
-- gives the score. Positive means being the fool less often than the tables
-- they sat at predicted.
--
-- Existing history is preserved: expected_duraks is rebuilt from the finished
-- games already recorded, using the real seat count of each one, so everybody
-- keeps a meaningful score straight away rather than starting from nothing.

begin;

-- 1. Clear what depends on the old rating column.
drop policy if exists "create own profile" on public.profiles;
drop view if exists public.leaderboard;

-- 2. New column, then drop the rating.
alter table public.profiles
  add column if not exists expected_duraks numeric(12,6) not null default 0;

alter table public.profiles
  drop column if exists rating;

alter table public.games
  rename column rating_delta to score_delta;

-- 3. Rebuild expected_duraks from the games already played. Each finished
--    game contributes 1/(its seat count) to every player who sat at it.
with sizes as (
  select game_id, count(*)::numeric as seats
  from public.game_players
  group by game_id
)
update public.profiles p
   set expected_duraks = coalesce((
     select sum(1.0 / s.seats)
     from public.game_players gp
     join public.games g on g.id = gp.game_id and g.status = 'finished'
     join sizes s on s.game_id = gp.game_id
     where gp.player_id = p.id
   ), 0);

-- 4. Put the policy back, now guarding the new column instead of the rating.
create policy "create own profile"
  on public.profiles for insert
  with check (
    auth.uid() = id
    and wins = 0 and losses = 0 and draws = 0 and expected_duraks = 0
  );

-- 5. Score, and the ladder built on it.
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

-- 6. Settle games by updating records rather than moving ratings.
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

commit;
