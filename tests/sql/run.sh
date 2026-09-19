#!/usr/bin/env bash
# tests/sql/run.sh
# Run supabase/schema.sql against a throwaway Postgres and check how it behaves.
#
# Needs a local postgres binary; nothing about this touches the real project.
# Everything lives under a temporary directory that is removed at the end.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
WORK="${WORK:-/var/tmp/durakpg}"
PORT="${PORT:-5433}"
# initdb refuses to run as root, so the cluster is owned by a plain user.
RUNAS="${RUNAS:-postgres}"

as_pg() { su "$RUNAS" -s /bin/bash -c "$1"; }
psql_run() {
  as_pg "$PGBIN/psql -h $WORK/run -p $PORT -U durak -d durak_test -v ON_ERROR_STOP=1 $*"
}

cleanup() {
  as_pg "$PGBIN/pg_ctl -D $WORK/data stop -m immediate" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
[ -n "${KEEP:-}" ] || trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/data" "$WORK/run" "$WORK/sql"
cp "$ROOT/supabase/schema.sql" "$WORK/sql/"
cp "$HERE"/*.sql "$WORK/sql/"
chown -R "$RUNAS" "$WORK"
chmod 700 "$WORK/data"

echo "Starting a throwaway Postgres..."
as_pg "$PGBIN/initdb -D $WORK/data -U durak --locale=C.utf8 --encoding=UTF8" >/dev/null
as_pg "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK/run -p $PORT -c listen_addresses=' -l $WORK/pg.log start" >/dev/null
sleep 1
as_pg "$PGBIN/createdb -h $WORK/run -p $PORT -U durak durak_test"

echo "Loading the Supabase stand-ins..."
psql_run -q -f "$WORK/sql/prelude.sql" 2>&1 | grep -v 'wal_level\|HINT' || true

echo "Running supabase/schema.sql..."
psql_run -q -f "$WORK/sql/schema.sql" >/dev/null

echo "Running it a second time, since it has to be safe to re-run..."
psql_run -q -f "$WORK/sql/schema.sql" >/dev/null

echo "Checking how it behaves..."
# psql prefixes every NOTICE with its own file and line; strip that so the
# checks read as a plain list.
psql_run -f "$WORK/sql/schema.test.sql" 2>&1 \
  | sed -E 's/^psql:[^ ]+ (NOTICE|ERROR):  ?//' \
  | grep -E '^( +ok |==|FAIL|All SQL)'

echo "Checking the SQL rating against the JavaScript..."
psql_run -tAq -f "$WORK/sql/rating.cases.sql" > "$WORK/sql-deltas.txt"
chmod a+r "$WORK/sql-deltas.txt"
node "$HERE/compare-rating.mjs" "$WORK/sql-deltas.txt"
