-- Boliche dos Amigos / cadastro de usuários e fotos de perfil
-- Migração idempotente. Execute depois de schema.sql.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null check (length(trim(nome)) between 1 and 80),
  foto_path text not null check (length(trim(foto_path)) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_status_idx on public.profiles(status);

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

drop policy if exists profiles_read_own on public.profiles;
drop policy if exists profiles_read_admin on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;

create policy profiles_read_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy profiles_read_admin on public.profiles
  for select to authenticated using ((select public.is_admin()));
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

grant select, insert, update on public.profiles to authenticated;

insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', false)
on conflict (id) do update set public = false;

drop policy if exists profile_photos_insert_own on storage.objects;
drop policy if exists profile_photos_select_own on storage.objects;
drop policy if exists profile_photos_select_admin on storage.objects;
drop policy if exists profile_photos_update_own on storage.objects;
drop policy if exists profile_photos_delete_own on storage.objects;

create policy profile_photos_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy profile_photos_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy profile_photos_select_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-photos' and (select public.is_admin()));
create policy profile_photos_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy profile_photos_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
