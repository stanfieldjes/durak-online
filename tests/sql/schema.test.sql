-- tests/sql/schema.test.sql
-- Behaviour tests for supabase/schema.sql, run against a throwaway Postgres.
-- Every check raises an exception on failure, so psql -v ON_ERROR_STOP=1 makes
-- the whole run fail loudly.

\set ON_ERROR_STOP on
\timing off

create or replace function ok(p_label text, p_cond boolean) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice '  ok  %', p_label;
end;
$$;

/** Run a statement and report whether it raised, so bad input can be tested. */
create or replace function raises(p_sql text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$$;

\echo '== usernames =='

do $$
declare id uuid;
begin
  -- Names in scripts other than Latin are ordinary names.
  perform test_player('Дурак');
  perform test_player('田中さん');
  perform test_player('Ægir');
  perform test_player('Ωμέγα');
  perform test_player('plain_name');
  perform ok('non-Latin names are accepted', true);

  id := gen_random_uuid();
  insert into auth.users (id) values (id);
  perform test_become(id);
  perform ok('a name of two characters is refused',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, 'ab')));
  perform ok('a name of 21 characters is refused',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, repeat('x', 21))));
  perform ok('a name of only punctuation is refused',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, '---')));
  perform ok('a name of only spaces is refused',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, '     ')));
  perform ok('a name with a newline in it is refused',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, E'ab\ncd')));
  perform ok('a name padded with spaces is refused',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, ' Дурак ')));
  perform ok('a duplicate name is refused',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, 'Дурак')));

  -- e-acute typed as one code point, and as e plus a combining accent. They
  -- look identical; the normalising index has to treat them as the same name.
  perform test_player(E'Caféx');
  perform ok('the same name in two Unicode forms collides',
    raises(format('insert into public.profiles (id, username) values (%L, %L)', id, E'Caféx')));
end
$$;

\echo '== profiles open at the starting rating =='

do $$
declare r numeric;
begin
  select rating into r from public.profiles where username = 'Дурак';
  perform ok('a new profile opens at 1000', r = 1000);
  perform ok('rating_start agrees with the column default', public.rating_start() = 1000);
end
$$;

\echo '== rating_changes =='

do $$
declare
  d numeric[];
  losses numeric[] := array[]::numeric[];
  gains  numeric[] := array[]::numeric[];
  n int;
  i int;
  level numeric[];
begin
  -- The documented amounts at a table of equally rated players.
  for n in 2..8 loop
    level := array_fill(1000::numeric, array[n]);
    d := public.rating_changes(level, 1);
    losses := losses || (-d[1]);
    gains := gains || d[2];

    perform ok(format('%sp: changes sum to zero', n),
      (select abs(sum(x)) < 0.000001 from unnest(d) x));

    for i in 2..n loop
      perform ok(format('%sp: every survivor is paid the same', n),
        abs(d[i] - d[2]) < 0.000001);
    end loop;
  end loop;

  perform ok('2p durak loses 12', abs(losses[1] - 12) < 0.000001);
  perform ok('3p durak loses 16', abs(losses[2] - 16) < 0.000001);
  perform ok('4p durak loses 18', abs(losses[3] - 18) < 0.000001);
  perform ok('5p durak loses 19.2', abs(losses[4] - 19.2) < 0.000001);
  perform ok('6p durak loses 20', abs(losses[5] - 20) < 0.000001);
  perform ok('7p durak loses 24*6/7', abs(losses[6] - 144.0/7) < 0.00001);
  perform ok('8p durak loses 21', abs(losses[7] - 21) < 0.000001);

  -- The property the whole decimal design exists to protect.
  for i in 2..7 loop
    perform ok(format('the durak pays more at %s players than at %s', i + 1, i),
      losses[i] > losses[i - 1]);
    perform ok(format('survivors are paid less at %s players than at %s', i + 1, i),
      gains[i] < gains[i - 1]);
  end loop;
end
$$;

do $$
declare d numeric[];
begin
  -- Who you played counts.
  perform ok('losing to weaker players costs more',
    (public.rating_changes(array[1200, 900, 900, 900]::numeric[], 1))[1]
    < (public.rating_changes(array[1200, 1500, 1500, 1500]::numeric[], 1))[1]);

  perform ok('surviving a strong table pays more',
    (public.rating_changes(array[1000, 1400, 1400, 1400]::numeric[], 4))[1]
    > (public.rating_changes(array[1000, 700, 700, 700]::numeric[], 4))[1]);

  -- A draw between equals moves nothing; between unequals it nudges.
  d := public.rating_changes(array_fill(1000::numeric, array[5]), null);
  perform ok('a draw between equals moves nothing',
    (select bool_and(x = 0) from unnest(d) x));

  d := public.rating_changes(array[1200, 900]::numeric[], null);
  perform ok('a draw costs the favourite', d[1] < 0 and d[2] > 0);
  perform ok('a draw is still zero sum', d[1] + d[2] = 0);

  -- Uneven tables stay zero sum, including the awkward sizes.
  perform ok('an uneven seven-player table is zero sum',
    (select abs(sum(x)) < 0.000001
       from unnest(public.rating_changes(
         array[1003, 999, 1001, 1002, 998, 1000, 997]::numeric[], 4)) x));
  perform ok('an uneven seven-player draw is zero sum',
    (select abs(sum(x)) < 0.000001
       from unnest(public.rating_changes(
         array[1003, 999, 1001, 1002, 998, 1000, 997]::numeric[], null)) x));

  -- The floor.
  d := public.rating_changes(array[100, 1000]::numeric[], 1);
  perform ok('a player at the floor cannot fall further', d[1] = 0);
  perform ok('no change carries more than six decimal places',
    (select bool_and(x = round(x, 6))
       from unnest(public.rating_changes(array_fill(1000::numeric, array[7]), 1)) x));
end
$$;

\echo '== seats go up to eight =='

do $$
declare host uuid; g uuid; i int; p uuid;
begin
  select id into host from public.profiles where username = 'Дурак';
  perform test_become(host);
  g := (public.create_game(8)).id;

  for i in 1..7 loop
    p := test_player('seatmate' || i);
    insert into public.game_players (game_id, seat, player_id) values (g, i, p);
  end loop;

  perform ok('all eight seats can be filled',
    (select count(*) from public.game_players where game_id = g) = 8);
  perform ok('a ninth seat is refused',
    raises(format('insert into public.game_players (game_id, seat, player_id)
                   values (%L, 8, %L)', g, test_player('ninth'))));
end
$$;

\echo '== finish_game moves ratings =='

do $$
declare
  ids   uuid[];
  g     uuid;
  i     int;
  row   public.games;
  before numeric[];
  after  numeric[];
  total_before numeric;
  total_after  numeric;
  durak_seat int := 2;
begin
  ids := array[]::uuid[];
  for i in 1..4 loop
    ids := ids || test_player('settler' || i);
  end loop;

  perform test_become(ids[1]);
  g := (public.create_game(4)).id;
  for i in 2..4 loop
    insert into public.game_players (game_id, seat, player_id) values (g, i - 1, ids[i]);
  end loop;
  update public.games set status = 'active', state = '{"finished": false}'::jsonb where id = g;

  select array_agg(rating order by array_position(ids, id)),
         sum(rating)
    into before, total_before
    from public.profiles where id = any(ids);

  -- Seat 2 concedes, which is the one result a client may name for itself.
  perform test_become(ids[durak_seat + 1]);
  row := public.finish_game(g, durak_seat);

  select array_agg(rating order by array_position(ids, id)), sum(rating)
    into after, total_after
    from public.profiles where id = any(ids);

  perform ok('the game is marked finished', row.status = 'finished');
  perform ok('the durak is recorded', row.durak_id = ids[durak_seat + 1]);
  perform ok('the durak lost rating', after[durak_seat + 1] < before[durak_seat + 1]);
  perform ok('the durak lost 18 at a level four-player table',
    abs((before[durak_seat + 1] - after[durak_seat + 1]) - 18) < 0.000001);
  perform ok('the pool is unchanged', abs(total_after - total_before) < 0.000001);

  for i in 1..4 loop
    if i <> durak_seat + 1 then
      perform ok(format('survivor %s gained 6', i), abs(after[i] - before[i] - 6) < 0.000001);
    end if;
  end loop;

  perform ok('every seat has a delta recorded',
    (select count(*) from jsonb_object_keys(row.rating_delta)) = 4);
  perform ok('the recorded deltas sum to zero',
    (select abs(sum(value::numeric)) < 0.000001
       from jsonb_each_text(row.rating_delta)));
  perform ok('the recorded delta matches what the rating moved by',
    abs((row.rating_delta->>ids[1]::text)::numeric - (after[1] - before[1])) < 0.000001);

  perform ok('the durak has a loss recorded',
    (select losses from public.profiles where id = ids[durak_seat + 1]) = 1);
  perform ok('a survivor has a win recorded',
    (select wins from public.profiles where id = ids[1]) = 1);

  perform ok('finishing twice is harmless',
    (public.finish_game(g, durak_seat)).status = 'finished');
  perform ok('finishing twice did not move the rating again',
    (select rating from public.profiles where id = ids[1]) = after[1]);
end
$$;

\echo '== leaderboard =='

do $$
begin
  perform ok('the leaderboard only lists players who have played',
    (select count(*) from public.leaderboard) = 4);
  perform ok('the leaderboard is ordered by rating, best first',
    (select rating from public.leaderboard limit 1)
    = (select max(rating) from public.leaderboard));
  perform ok('the leaderboard carries games played',
    (select bool_and(games = 1) from public.leaderboard));
  perform ok('the leaderboard carries the picture',
    exists (select 1 from information_schema.columns
             where table_name = 'leaderboard' and column_name = 'avatar_url'));
end
$$;

\echo '== name and picture =='

do $$
declare me uuid; row public.profiles;
begin
  select id into me from public.profiles where username = 'settler1';
  perform test_become(me);

  row := public.set_username('Новое имя');
  perform ok('set_username changes the name', row.username = 'Новое имя');

  row := public.set_username('  Спасибо  ');
  perform ok('set_username trims what it is given', row.username = 'Спасибо');

  perform ok('set_username refuses a name in use',
    raises($q$select public.set_username('Дурак')$q$));
  perform ok('set_username refuses a name that is too short',
    raises($q$select public.set_username('aa')$q$));
  perform ok('the name did not change after a refusal',
    (select username from public.profiles where id = me) = 'Спасибо');

  row := public.set_avatar('https://example.test/a/b.png');
  perform ok('set_avatar records the address', row.avatar_url = 'https://example.test/a/b.png');
  row := public.set_avatar(null);
  perform ok('set_avatar can clear the picture', row.avatar_url is null);
  perform ok('set_avatar refuses a non-https address',
    raises($q$select public.set_avatar('http://example.test/a.png')$q$));
  perform ok('set_avatar refuses a javascript address',
    raises($q$select public.set_avatar('javascript:alert(1)')$q$));

  perform ok('set_username refuses an anonymous caller',
    raises($q$select test_become(null); select public.set_username('nobody')$q$));
end
$$;

\echo '== the avatars bucket =='

do $$
begin
  perform ok('the avatars bucket exists and is public',
    exists (select 1 from storage.buckets where id = 'avatars' and public));
  perform ok('anyone may read an avatar',
    exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'avatars are readable'));
  perform ok('you may only write inside your own folder',
    exists (select 1 from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and policyname = 'write own avatar'
               and qual is not distinct from null
               and with_check like '%foldername%'));
end
$$;

\echo '== row level security =='

do $$
begin
  perform ok('profiles have no update policy, so records move only in functions',
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'profiles' and cmd = 'UPDATE'));
  perform ok('games have no insert or update policy',
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'games'
                   and cmd in ('INSERT', 'UPDATE')));
  perform ok('a finished game is readable by everyone, for the recent games list',
    (select qual from pg_policies
      where schemaname = 'public' and tablename = 'games' and cmd = 'SELECT')
    like '%abandoned%');
end
$$;

\echo 'All SQL checks passed.'
