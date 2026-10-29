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

-- Browser-data backups (logins/passwords/history), end-to-end encrypted by the app.
-- Each user can only touch files under their own <user id>/ folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('profile-backups', 'profile-backups', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "own profile backups" on storage.objects;
create policy "own profile backups" on storage.objects for all to authenticated
  using (bucket_id = 'profile-backups' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'profile-backups' and (storage.foldername(name))[1] = auth.uid()::text);

-- One PC at a time per profile. The PC that has a profile open refreshes beat_at
-- every 20s; a lock older than 90s is free (PC crashed or went offline).
-- "force" asks the holder to close (takeover_by); it releases after its backup.
create table if not exists public.profile_locks (
  user_id uuid references auth.users(id) on delete cascade not null default auth.uid(),
  profile_id text not null,
  device_id text not null,
  device_name text not null default '',
  beat_at timestamptz not null default now(),
  takeover_by text,
  primary key (user_id, profile_id)
);
alter table public.profile_locks enable row level security;
drop policy if exists "own profile locks" on public.profile_locks;
create policy "own profile locks" on public.profile_locks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.profile_lock(p_profile text, p_device text, p_name text, p_mode text)
returns json language plpgsql security invoker as $$
declare l public.profile_locks;
begin
  select * into l from public.profile_locks where user_id = auth.uid() and profile_id = p_profile for update;
  if p_mode = 'release' then
    delete from public.profile_locks where user_id = auth.uid() and profile_id = p_profile and device_id = p_device;
    return json_build_object('ok', true);
  end if;
  if p_mode = 'beat' then
    if l.device_id <> p_device then return json_build_object('ok', false, 'lost', true); end if;
    insert into public.profile_locks (user_id, profile_id, device_id, device_name)
    values (auth.uid(), p_profile, p_device, p_name)
    on conflict (user_id, profile_id) do update set beat_at = now();
    return json_build_object('ok', true, 'takeover', l.takeover_by is not null);
  end if;
  if l.device_id is null or l.device_id = p_device or l.beat_at < now() - interval '90 seconds' then
    insert into public.profile_locks (user_id, profile_id, device_id, device_name)
    values (auth.uid(), p_profile, p_device, p_name)
    on conflict (user_id, profile_id) do update
      set device_id = excluded.device_id, device_name = excluded.device_name, beat_at = now(), takeover_by = null;
    return json_build_object('ok', true);
  end if;
  if p_mode = 'force' then
    update public.profile_locks set takeover_by = p_device where user_id = auth.uid() and profile_id = p_profile;
  end if;
  return json_build_object('ok', false, 'device', l.device_name, 'age', extract(epoch from now() - l.beat_at)::int);
end $$;
