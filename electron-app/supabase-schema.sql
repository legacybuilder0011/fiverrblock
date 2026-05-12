-- ============================================================
-- Privacy Shield — Supabase Schema
-- Paste this into the SQL editor at:
--   https://supabase.com/dashboard/project/_/sql
-- Then click "Run". It creates the tables + permissions the
-- app needs for cross-device sync.
-- ============================================================

-- 1) Profiles table — one row per profile per user
create table if not exists public.profiles (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  profile_id text not null,
  data jsonb not null,
  updated_at timestamptz default now() not null,
  unique(user_id, profile_id)
);
create index if not exists profiles_user_idx on public.profiles(user_id);

-- 2) Proxy library
create table if not exists public.proxies (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  proxy_id text not null,
  data jsonb not null,
  updated_at timestamptz default now() not null,
  unique(user_id, proxy_id)
);
create index if not exists proxies_user_idx on public.proxies(user_id);

-- 3) Open profiles (auto-restore state) — single row per user
create table if not exists public.open_profiles (
  user_id uuid references auth.users(id) on delete cascade primary key,
  ids text[] default '{}'::text[] not null,
  updated_at timestamptz default now() not null
);

-- ============================================================
-- Row Level Security — each user only sees their own rows
-- ============================================================
alter table public.profiles enable row level security;
alter table public.proxies enable row level security;
alter table public.open_profiles enable row level security;

drop policy if exists "own profiles select" on public.profiles;
drop policy if exists "own profiles insert" on public.profiles;
drop policy if exists "own profiles update" on public.profiles;
drop policy if exists "own profiles delete" on public.profiles;
create policy "own profiles select" on public.profiles for select using (auth.uid() = user_id);
create policy "own profiles insert" on public.profiles for insert with check (auth.uid() = user_id);
create policy "own profiles update" on public.profiles for update using (auth.uid() = user_id);
create policy "own profiles delete" on public.profiles for delete using (auth.uid() = user_id);

drop policy if exists "own proxies select" on public.proxies;
drop policy if exists "own proxies insert" on public.proxies;
drop policy if exists "own proxies update" on public.proxies;
drop policy if exists "own proxies delete" on public.proxies;
create policy "own proxies select" on public.proxies for select using (auth.uid() = user_id);
create policy "own proxies insert" on public.proxies for insert with check (auth.uid() = user_id);
create policy "own proxies update" on public.proxies for update using (auth.uid() = user_id);
create policy "own proxies delete" on public.proxies for delete using (auth.uid() = user_id);

drop policy if exists "own open_profiles all" on public.open_profiles;
create policy "own open_profiles all" on public.open_profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
