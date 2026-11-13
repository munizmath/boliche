-- Encontros, pista por partida e encerramento. Aplicar depois de management.sql.
-- Expansiva: mantém as chamadas antigas operantes até a interface nova ser publicada.
begin;

create table if not exists public.encounters (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 1 and 80),
  data date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

insert into public.encounters (id, nome, data)
values ('00000000-0000-4000-8000-000000000001', 'Encontro inicial', (now() at time zone 'America/Sao_Paulo')::date)
on conflict (id) do nothing;
update public.encounters
   set data = coalesce((select min(created_at at time zone 'America/Sao_Paulo')::date from public.games), data)
 where id = '00000000-0000-4000-8000-000000000001'
   and nome = 'Encontro inicial';

alter table public.games add column if not exists encounter_id uuid references public.encounters(id) on delete cascade;
update public.games set encounter_id = '00000000-0000-4000-8000-000000000001' where encounter_id is null;
alter table public.games alter column encounter_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.games alter column encounter_id set not null;
create index if not exists games_encounter_idx on public.games(encounter_id, created_at desc);

alter table public.scores add column if not exists pista text;
update public.scores s set pista = p.pista from public.players p where p.id = s.player_id and s.pista is null;
alter table public.scores alter column pista set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'scores_pista_valid' and conrelid = 'public.scores'::regclass) then
    alter table public.scores add constraint scores_pista_valid check (length(trim(pista)) between 1 and 20);
  end if;
end $$;
create index if not exists scores_game_lane_idx on public.scores(game_id, pista);

alter table public.lanes add column if not exists capacity integer not null default 4 check (capacity between 1 and 20);

create table if not exists public.encounter_players (
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  primary key (encounter_id, player_id)
);
insert into public.encounter_players (encounter_id, player_id)
select '00000000-0000-4000-8000-000000000001', id from public.players
on conflict do nothing;

alter table public.encounters enable row level security;
alter table public.encounter_players enable row level security;
drop policy if exists encounters_public_read on public.encounters;
drop policy if exists encounters_admin_insert on public.encounters;
drop policy if exists encounters_admin_update on public.encounters;
drop policy if exists encounters_admin_delete on public.encounters;
create policy encounters_public_read on public.encounters for select to anon, authenticated using (true);
create policy encounters_admin_insert on public.encounters for insert to authenticated with check ((select public.is_admin()));
create policy encounters_admin_update on public.encounters for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy encounters_admin_delete on public.encounters for delete to authenticated using ((select public.is_admin()));
drop policy if exists encounter_players_public_read on public.encounter_players;
drop policy if exists encounter_players_admin_insert on public.encounter_players;
drop policy if exists encounter_players_admin_delete on public.encounter_players;
create policy encounter_players_public_read on public.encounter_players for select to anon, authenticated using (true);
create policy encounter_players_admin_insert on public.encounter_players for insert to authenticated with check ((select public.is_admin()));
create policy encounter_players_admin_delete on public.encounter_players for delete to authenticated using ((select public.is_admin()));
grant select on public.encounters, public.encounter_players to anon, authenticated;
grant insert, update, delete on public.encounters, public.encounter_players to authenticated;

create or replace function public.default_score_lane()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.pista is null then
    select p.pista into new.pista from public.players p where p.id = new.player_id;
  end if;
  return new;
end $$;
drop trigger if exists scores_default_lane on public.scores;
create trigger scores_default_lane before insert on public.scores for each row execute function public.default_score_lane();

create or replace function public.guard_encounter_game()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (select 1 from public.encounters where id = old.encounter_id and status = 'closed') then
    raise exception 'Reabra o encontro antes de alterar partidas' using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (select 1 from public.encounters where id = new.encounter_id and status = 'closed') then
    raise exception 'Reabra o encontro antes de alterar partidas' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists games_guard_encounter on public.games;
create trigger games_guard_encounter before insert or update or delete on public.games
  for each row execute function public.guard_encounter_game();

create or replace function public.guard_encounter_score()
returns trigger language plpgsql security invoker set search_path = public as $$
declare old_encounter uuid; new_encounter uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select encounter_id into old_encounter from public.games where id = old.game_id;
    if exists (select 1 from public.encounters where id = old_encounter and status = 'closed') then
      raise exception 'Reabra o encontro antes de alterar pontos' using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select encounter_id into new_encounter from public.games where id = new.game_id;
    if exists (select 1 from public.encounters where id = new_encounter and status = 'closed') then
      raise exception 'Reabra o encontro antes de alterar pontos' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists scores_guard_encounter on public.scores;
create trigger scores_guard_encounter before insert or update or delete on public.scores
  for each row execute function public.guard_encounter_score();

create or replace function public.guard_encounter_roster()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (select 1 from public.encounters where id = old.encounter_id and status = 'closed') then
    raise exception 'Reabra o encontro antes de alterar participantes' using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (select 1 from public.encounters where id = new.encounter_id and status = 'closed') then
    raise exception 'Reabra o encontro antes de alterar participantes' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists encounter_players_guard_closed on public.encounter_players;
create trigger encounter_players_guard_closed before insert or update or delete on public.encounter_players
  for each row execute function public.guard_encounter_roster();

create or replace function public.guard_closed_encounter()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if old.status = 'closed' then
    if tg_op = 'DELETE' then raise exception 'Reabra o encontro antes de excluí-lo' using errcode = '42501'; end if;
    if new.status = 'closed' and (new.nome is distinct from old.nome or new.data is distinct from old.data) then
      raise exception 'Reabra o encontro antes de editá-lo' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists encounters_guard_closed on public.encounters;
create trigger encounters_guard_closed before update or delete on public.encounters
  for each row execute function public.guard_closed_encounter();

create or replace function public.create_encounter(p_name text, p_date date, p_player_ids uuid[])
returns public.encounters language plpgsql security invoker set search_path = public as $$
declare result public.encounters%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 80 or p_date is null then raise exception 'Nome ou data inválidos'; end if;
  if (select count(distinct x.id) from unnest(coalesce(p_player_ids, array[]::uuid[])) as x(id)) <> coalesce(cardinality(p_player_ids),0) then
    raise exception 'Participante repetido';
  end if;
  if (select count(*) from public.players where id = any(coalesce(p_player_ids, array[]::uuid[]))) <> coalesce(cardinality(p_player_ids),0) then
    raise exception 'Participante não cadastrado';
  end if;
  insert into public.encounters(nome,data) values(trim(p_name),p_date) returning * into result;
  insert into public.encounter_players(encounter_id,player_id)
    select result.id, x.id from unnest(coalesce(p_player_ids, array[]::uuid[])) as x(id);
  return result;
end $$;
revoke all on function public.create_encounter(text,date,uuid[]) from public, anon;
grant execute on function public.create_encounter(text,date,uuid[]) to authenticated;

create or replace function public.save_encounter(p_encounter_id uuid, p_name text, p_date date, p_player_ids uuid[])
returns public.encounters language plpgsql security invoker set search_path = public as $$
declare result public.encounters%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 80 or p_date is null then raise exception 'Nome ou data inválidos'; end if;
  select * into result from public.encounters where id=p_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado'; end if;
  if result.status='closed' then raise exception 'Reabra o encontro para editá-lo'; end if;
  if (select count(distinct x.id) from unnest(coalesce(p_player_ids, array[]::uuid[])) as x(id)) <> coalesce(cardinality(p_player_ids),0) then raise exception 'Participante repetido'; end if;
  if (select count(*) from public.players where id = any(coalesce(p_player_ids, array[]::uuid[]))) <> coalesce(cardinality(p_player_ids),0) then raise exception 'Participante não cadastrado'; end if;
  if exists (select 1 from public.games g join public.scores s on s.game_id=g.id where g.encounter_id=p_encounter_id and not (s.player_id=any(coalesce(p_player_ids,array[]::uuid[])))) then
    raise exception 'Jogador com pontuação vinculada não pode sair do encontro';
  end if;
  update public.encounters set nome=trim(p_name), data=p_date where id=p_encounter_id returning * into result;
  delete from public.encounter_players where encounter_id=p_encounter_id and not (player_id=any(coalesce(p_player_ids,array[]::uuid[])));
  insert into public.encounter_players(encounter_id,player_id)
    select p_encounter_id,x.id from unnest(coalesce(p_player_ids,array[]::uuid[])) as x(id) on conflict do nothing;
  return result;
end $$;
revoke all on function public.save_encounter(uuid,text,date,uuid[]) from public, anon;
grant execute on function public.save_encounter(uuid,text,date,uuid[]) to authenticated;

create or replace function public.set_encounter_closed(p_encounter_id uuid, p_closed boolean)
returns public.encounters language plpgsql security invoker set search_path = public as $$
declare result public.encounters%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if p_closed is null then raise exception 'Informe se o encontro deve ser encerrado ou reaberto'; end if;
  select * into result from public.encounters where id=p_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado'; end if;
  if p_closed then
    if not exists(select 1 from public.games where encounter_id=p_encounter_id) or exists(select 1 from public.games where encounter_id=p_encounter_id and status<>'final') then
      raise exception 'Finalize todas as partidas antes de encerrar o encontro';
    end if;
  end if;
  update public.encounters set status=case when p_closed then 'closed' else 'open' end,
    closed_at=case when p_closed then now() else null end where id=p_encounter_id returning * into result;
  return result;
end $$;
revoke all on function public.set_encounter_closed(uuid,boolean) from public, anon;
grant execute on function public.set_encounter_closed(uuid,boolean) to authenticated;

create or replace function public.delete_encounter(p_encounter_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if not exists(select 1 from public.encounters where id=p_encounter_id and status='open' for update) then
    raise exception 'Reabra o encontro antes de excluí-lo';
  end if;
  delete from public.encounters where id=p_encounter_id;
end $$;
revoke all on function public.delete_encounter(uuid) from public, anon;
grant execute on function public.delete_encounter(uuid) to authenticated;

create or replace function public.create_encounter_game(p_encounter_id uuid, p_name text, p_assignments jsonb)
returns public.games language plpgsql security invoker set search_path = public as $$
declare result public.games%rowtype; expected_count integer;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 80 or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments)=0 then
    raise exception 'Nome ou participantes inválidos';
  end if;
  if not exists(select 1 from public.encounters where id=p_encounter_id and status='open') then raise exception 'Encontro inexistente ou encerrado'; end if;
  expected_count := jsonb_array_length(p_assignments);
  if (select count(distinct x.player_id) from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)) <> expected_count
     or exists(select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) where x.player_id is null or x.pista is null or length(trim(x.pista)) not between 1 and 20)
     or (select count(*) from public.encounter_players ep join jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) on x.player_id=ep.player_id where ep.encounter_id=p_encounter_id) <> expected_count
     or exists(select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) left join public.lanes l on l.name=x.pista where l.name is null)
     or exists(select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) join public.lanes l on l.name=x.pista group by x.pista,l.capacity having count(*)>l.capacity) then
    raise exception 'Distribuição de pistas inválida ou acima da capacidade';
  end if;
  insert into public.games(nome,encounter_id) values(trim(p_name),p_encounter_id) returning * into result;
  insert into public.scores(game_id,player_id,pista,pontos,finalizado)
    select result.id,x.player_id,x.pista,null,false from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text);
  return result;
end $$;
revoke all on function public.create_encounter_game(uuid,text,jsonb) from public, anon;
grant execute on function public.create_encounter_game(uuid,text,jsonb) to authenticated;

create or replace function public.edit_encounter_game(p_game_id uuid, p_name text, p_assignments jsonb)
returns public.games language plpgsql security invoker set search_path = public as $$
declare result public.games%rowtype; expected_count integer;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 80 or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments)=0 then raise exception 'Nome ou participantes inválidos'; end if;
  select * into result from public.games where id=p_game_id for update;
  if not found or not exists(select 1 from public.encounters where id=result.encounter_id and status='open') then raise exception 'Partida inexistente ou encontro encerrado'; end if;
  expected_count := jsonb_array_length(p_assignments);
  if (select count(distinct x.player_id) from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)) <> expected_count
     or exists(select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) where x.player_id is null or x.pista is null or length(trim(x.pista)) not between 1 and 20)
     or (select count(*) from public.encounter_players ep join jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) on x.player_id=ep.player_id where ep.encounter_id=result.encounter_id) <> expected_count
     or exists(select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) left join public.lanes l on l.name=x.pista where l.name is null)
     or exists(select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) join public.lanes l on l.name=x.pista group by x.pista,l.capacity having count(*)>l.capacity) then
    raise exception 'Distribuição de pistas inválida ou acima da capacidade';
  end if;
  update public.games set nome=trim(p_name) where id=p_game_id returning * into result;
  insert into public.scores(game_id,player_id,pista,pontos,finalizado)
    select p_game_id,x.player_id,x.pista,null,false from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
    on conflict(game_id,player_id) do update set pista=excluded.pista;
  delete from public.scores s where s.game_id=p_game_id and not exists(select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text) where x.player_id=s.player_id);
  select * into result from public.games where id=p_game_id;
  return result;
end $$;
revoke all on function public.edit_encounter_game(uuid,text,jsonb) from public, anon;
grant execute on function public.edit_encounter_game(uuid,text,jsonb) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='encounters') then
    alter publication supabase_realtime add table public.encounters;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='encounter_players') then
    alter publication supabase_realtime add table public.encounter_players;
  end if;
end $$;

commit;
