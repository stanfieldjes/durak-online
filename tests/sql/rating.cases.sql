-- tests/sql/rating.cases.sql
-- Dump public.rating_changes() over a spread of tables, so the JavaScript can
-- be held against it. One line per case:
--
--     <ratings, comma separated>|<durak index, or empty for a draw>|<deltas>
--
-- The cases are deterministic: level tables at every size, lopsided tables,
-- near-ties (where rounding is most likely to disagree), tables against the
-- floor, and a pseudo-random spread.

\pset tuples_only on
\pset format unaligned

with cases as (
  -- Every table size, level ratings, each seat taking a turn as the durak,
  -- plus the draw.
  select array_fill(1000::numeric, array[n]) as ratings, d as durak
    from generate_series(2, 8) n,
         lateral generate_series(1, n) d
  union all
  select array_fill(1000::numeric, array[n]), null
    from generate_series(2, 8) n

  -- Lopsided tables: a favourite among weak players and the reverse.
  union all
  select r.ratings, d
    from (values
      (array[1600, 800, 800, 800]::numeric[]),
      (array[800, 1600, 1600, 1600]::numeric[]),
      (array[1000, 1400]::numeric[]),
      (array[100, 2000]::numeric[]),
      (array[100, 100, 100]::numeric[]),
      (array[2400, 1000, 600, 300, 1800, 950, 1050]::numeric[]),
      (array[1200, 1150, 1100, 1050, 1000, 950, 900, 850]::numeric[])
    ) as r(ratings),
    lateral generate_series(1, array_length(r.ratings, 1)) d

  -- Near-ties, where the sixth decimal place is most likely to disagree.
  union all
  select r.ratings, d
    from (values
      (array[1000.000001, 1000, 999.999999]::numeric[]),
      (array[1003, 999, 1001, 1002, 998, 1000, 997]::numeric[]),
      (array[1000.5, 1000.5, 1000.5, 1000.4]::numeric[])
    ) as r(ratings),
    lateral generate_series(1, array_length(r.ratings, 1)) d
  union all
  select r.ratings, null
    from (values
      (array[1000.000001, 1000, 999.999999]::numeric[]),
      (array[1003, 999, 1001, 1002, 998, 1000, 997]::numeric[]),
      (array[1200, 900]::numeric[]),
      (array[2400, 1000, 600, 300, 1800, 950, 1050]::numeric[])
    ) as r(ratings)

  -- A deterministic spread: ratings built from a simple recurrence so the
  -- same cases come out on every run.
  union all
  select
    (select array_agg(round((400 + ((g * 7919 + i * 104729) % 2200))::numeric, 6))
       from generate_series(1, 2 + (g % 7)) i) as ratings,
    1 + (g % (2 + (g % 7))) as durak
    from generate_series(1, 240) g
)
select
  array_to_string(ratings, ',')
  || '|' || coalesce(durak::text, '')
  || '|' || array_to_string(public.rating_changes(ratings, durak), ',')
from cases;
