-- Aplicar depois de public-ranking-photos.sql. Expande o esquema existente.
begin;

alter table public.profiles
  add column if not exists photo_public_opt_in boolean not null default false;

-- A foto deve continuar na pasta privada do dono. Perfis legados são preservados;
-- o caminho é verificado sempre que a foto for alterada.
create or replace function public.guard_profile_photo_owner()
returns trigger language plpgsql security invoker set search_path = public as $$
declare photo_changed boolean;
begin
  photo_changed := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then photo_changed := new.foto_path is distinct from old.foto_path; end if;
  if photo_changed and split_part(new.foto_path, '/', 1) <> new.id::text then
    raise exception 'A foto deve estar na pasta privada do perfil' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_photo_owner on public.profiles;
create trigger profiles_guard_photo_owner before insert or update on public.profiles
  for each row execute function public.guard_profile_photo_owner();

drop policy if exists profiles_read_public_approved on public.profiles;
create policy profiles_read_public_approved on public.profiles
  for select to anon, authenticated
  using (status = 'approved' and player_id is not null and photo_public_opt_in);

drop policy if exists profile_photos_select_public_approved on storage.objects;
create policy profile_photos_select_public_approved on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'profile-photos'
    and exists (
      select 1 from public.profiles p
      where p.foto_path = name
        and split_part(name, '/', 1) = p.id::text
        and p.status = 'approved'
        and p.player_id is not null
        and p.photo_public_opt_in
    )
  );

-- Retorna apenas arquivos da pasta do próprio usuário que não são referenciados.
-- O cliente usa a resposta para apagar imagens antigas após salvar o perfil.
create or replace function public.unreferenced_profile_photos(p_paths text[])
returns text[] language sql security definer set search_path = public, storage as $$
  select coalesce(array_agg(candidate.path), array[]::text[])
  from unnest(coalesce(p_paths, array[]::text[])) as candidate(path)
  where auth.uid() is not null
    and split_part(candidate.path, '/', 1) = auth.uid()::text
    and not exists (select 1 from public.profiles p where p.foto_path = candidate.path);
$$;
revoke all on function public.unreferenced_profile_photos(text[]) from public, anon;
grant execute on function public.unreferenced_profile_photos(text[]) to authenticated;

commit;
