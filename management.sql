-- Execute depois de hardening-p0.sql, antes de publicar a interface administrativa.

create table if not exists public.lanes (
  name text primary key check (length(trim(name)) between 1 and 20),
  created_at timestamptz not null default now()
);

insert into public.lanes (name)
select distinct pista from public.players where pista is not null
on conflict do nothing;

alter table public.lanes enable row level security;
drop policy if exists lanes_public_read on public.lanes;
drop policy if exists lanes_admin_insert on public.lanes;
drop policy if exists lanes_admin_update on public.lanes;
drop policy if exists lanes_admin_delete on public.lanes;
create policy lanes_public_read on public.lanes for select to anon, authenticated using (true);
create policy lanes_admin_insert on public.lanes for insert to authenticated with check ((select public.is_admin()));
create policy lanes_admin_update on public.lanes for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy lanes_admin_delete on public.lanes for delete to authenticated using ((select public.is_admin()));
grant select on public.lanes to anon, authenticated;
grant insert, update, delete on public.lanes to authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'players_pista_lane_fkey' and conrelid = 'public.players'::regclass) then
    alter table public.players add constraint players_pista_lane_fkey
      foreign key (pista) references public.lanes(name)
      on update cascade on delete restrict;
  end if;
end;
$$;

create or replace function public.edit_game(p_game_id uuid, p_name text, p_player_ids uuid[])
returns public.games
language plpgsql
security invoker
set search_path = public
as $$
declare
  edited public.games%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80
     or coalesce(cardinality(p_player_ids), 0) = 0
     or exists (select 1 from unnest(p_player_ids) as x(id) where x.id is null)
     or (select count(distinct id) from unnest(p_player_ids) as x(id)) <> cardinality(p_player_ids) then
    raise exception 'Nome ou participantes inválidos';
  end if;
  if (select count(*) from public.players where id = any(p_player_ids)) <> cardinality(p_player_ids) then
    raise exception 'Há participantes não cadastrados';
  end if;
  perform 1 from public.games where id = p_game_id for update;
  if not found then
    raise exception 'Partida não encontrada';
  end if;
  update public.games set nome = trim(p_name) where id = p_game_id returning * into edited;
  insert into public.scores (game_id, player_id, pontos, finalizado)
  select p_game_id, x.id, null, false from unnest(p_player_ids) as x(id)
  on conflict (game_id, player_id) do nothing;
  delete from public.scores where game_id = p_game_id and not (player_id = any(p_player_ids));
  select * into edited from public.games where id = p_game_id;
  return edited;
end;
$$;
revoke execute on function public.edit_game(uuid, text, uuid[]) from public, anon;
grant execute on function public.edit_game(uuid, text, uuid[]) to authenticated;

create or replace function public.clear_game_score(p_game_id uuid, p_player_id uuid)
returns public.scores
language plpgsql
security invoker
set search_path = public
as $$
declare
  cleared public.scores%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  update public.scores set pontos = null, finalizado = false
   where game_id = p_game_id and player_id = p_player_id
   returning * into cleared;
  if not found then
    raise exception 'Jogador não vinculado à partida';
  end if;
  return cleared;
end;
$$;
revoke execute on function public.clear_game_score(uuid, uuid) from public, anon;
grant execute on function public.clear_game_score(uuid, uuid) to authenticated;

create or replace function public.delete_player_cascade(p_player_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  update public.profiles set status = 'pending', player_id = null where player_id = p_player_id;
  delete from public.scores where player_id = p_player_id;
  delete from public.players where id = p_player_id;
  if not found then
    raise exception 'Jogador não encontrado';
  end if;
end;
$$;
revoke execute on function public.delete_player_cascade(uuid) from public, anon;
grant execute on function public.delete_player_cascade(uuid) to authenticated;

drop policy if exists profile_photos_delete_admin on storage.objects;
create policy profile_photos_delete_admin on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-photos' and (select public.is_admin()));

create or replace function public.delete_registered_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_user_id is null or p_user_id = auth.uid() then
    raise exception 'Não é possível excluir esta conta';
  end if;
  if exists (select 1 from auth.users where id = p_user_id and raw_app_meta_data ->> 'role' = 'admin') then
    raise exception 'A conta de administrador não pode ser excluída';
  end if;
  delete from auth.users where id = p_user_id;
  if not found then
    raise exception 'Conta não encontrada';
  end if;
end;
$$;
revoke execute on function public.delete_registered_user(uuid) from public, anon;
grant execute on function public.delete_registered_user(uuid) to authenticated;

create or replace function public.list_registered_accounts()
returns table (
  id uuid,
  email text,
  nome text,
  foto_path text,
  status text,
  player_id uuid,
  created_at timestamptz,
  is_admin_account boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, coalesce(p.nome, u.raw_user_meta_data ->> 'nome')::text,
           p.foto_path, p.status, p.player_id, u.created_at,
           (u.raw_app_meta_data ->> 'role' = 'admin')
      from auth.users u
      left join public.profiles p on p.id = u.id
     order by u.created_at desc;
end;
$$;
revoke execute on function public.list_registered_accounts() from public, anon;
grant execute on function public.list_registered_accounts() to authenticated;
