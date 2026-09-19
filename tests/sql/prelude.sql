-- tests/sql/prelude.sql
-- Enough of a Supabase to run supabase/schema.sql against a plain Postgres.
-- Only what schema.sql actually touches: the auth and storage schemas, the
-- two roles, the realtime publication, and an auth.uid() that reads a session
-- setting so a test can act as different players.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema if not exists auth;
create schema if not exists storage;

create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- The real one reads the JWT. This one reads a session setting instead, so a
-- test can say "now I am this player" with set_config().
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;

create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name      text,
  owner     uuid
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select string_to_array(name, '/');
$$;

create publication supabase_realtime;

-- Helpers the tests use.
create or replace function test_become(p_user uuid) returns void
language sql as $$
  select set_config('test.uid', coalesce(p_user::text, ''), false);
$$;

/**
 * Make a player: an auth user plus the profile row, created exactly the way
 * the browser creates it, so the insert policy and the username check are
 * both exercised rather than bypassed.
 */
create or replace function test_player(p_name text) returns uuid
language plpgsql as $$
declare id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (id, id::text || '@example.test');
  perform test_become(id);
  insert into public.profiles (id, username) values (id, p_name);
  return id;
end;
$$;
