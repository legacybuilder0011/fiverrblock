-- Failure reports: when Start, the profile check or a backup fails on a PC, the
-- app adds one row (no IPs, no personal paths). Read them in the Supabase
-- dashboard: Table Editor -> app_failures, newest first.
create table if not exists public.app_failures (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade not null default auth.uid(),
  device_name text,
  app_version text,
  platform text,
  profile_id text,
  profile_name text,
  engine text,
  kind text not null,
  reason text,
  created_at timestamptz default now() not null
);
create index if not exists app_failures_user_time on public.app_failures(user_id, created_at desc);
alter table public.app_failures enable row level security;
drop policy if exists "own failures insert" on public.app_failures;
create policy "own failures insert" on public.app_failures for insert with check (auth.uid() = user_id);
drop policy if exists "own failures select" on public.app_failures;
create policy "own failures select" on public.app_failures for select using (auth.uid() = user_id);
