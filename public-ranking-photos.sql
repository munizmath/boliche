-- Publica apenas as fotos de perfis aprovados e vinculados a jogadores.
-- Execute depois de registration.sql e hardening-p0.sql.
begin;

alter table public.profiles enable row level security;
drop policy if exists profiles_read_public_approved on public.profiles;
create policy profiles_read_public_approved on public.profiles
  for select to anon, authenticated
  using (status = 'approved' and player_id is not null);
grant select on public.profiles to anon;

drop policy if exists profile_photos_select_public_approved on storage.objects;
create policy profile_photos_select_public_approved on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'profile-photos'
    and exists (
      select 1 from public.profiles p
      where p.foto_path = name
        and p.status = 'approved'
        and p.player_id is not null
    )
  );

commit;
