-- Migration 004 — rating changes now scale with how many players were at the
-- table.
--
-- Run this once in the Supabase SQL editor IF you already ran schema.sql or
-- an earlier migration. A fresh project only needs schema.sql.
--
-- No data changes: every existing rating stays exactly where it is. This
-- replaces only the scoring function, so it affects games settled from now on.
--
-- What changes: the model now scores each player on how likely they were to
-- end up the durak, rather than on how many opponents they outlasted. At a
-- table of n equally rated players that chance is 1/n, so:
--
--     2 players (50% each)   durak -20,  the winner   +20
--     3 players (33% each)   durak -26,  each survivor +13
--     4 players (25% each)   durak -30,  each survivor +10
--
-- Being the durak at a bigger table costs more, because you were less likely
-- to be it. Heads-up results are mathematically unchanged from before.

begin;

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
  k          constant numeric := 40;    -- keep in step with src/js/elo.js
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
  weights    numeric[];
  weight_total numeric;
  strongest  int;
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

  raw     := array_fill(0::numeric, array[n]);
  deltas  := array_fill(0, array[n]);
  weights := array_fill(0::numeric, array[n]);

  -- Each seat's expected chance of being the durak, mirroring
  -- expectedDurakChances() in src/js/elo.js: weight each seat by
  -- 10^(-rating / scale) and normalise so the chances sum to 1. Weights are
  -- taken relative to the strongest rating to keep the exponent small.
  strongest := ratings[1];
  for i in 2..n loop
    if ratings[i] > strongest then strongest := ratings[i]; end if;
  end loop;

  weight_total := 0;
  for i in 1..n loop
    weights[i] := power(10.0, (strongest - ratings[i]) / scale);
    weight_total := weight_total + weights[i];
  end loop;

  for i in 1..n loop
    expected := weights[i] / weight_total;

    -- What actually happened: 1 for the durak, 0 for everyone else. A draw
    -- spreads the blame evenly at 1/n.
    if p_durak_seat = -1 then
      actual := 1.0 / n;
    elsif seats[i] = p_durak_seat then
      actual := 1;
    else
      actual := 0;
    end if;

    raw[i] := k * (expected - actual);
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
