-- Equipes, torneio de oito jogadores e palpites. Aplicar depois de encounters.sql.
begin;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  metric text not null default 'sum' check (metric in ('sum','average')),
  unique(encounter_id, name)
);
create table if not exists public.team_players (
  team_id uuid not null references public.teams(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  primary key(team_id,player_id)
);
create table if not exists public.brackets (
  encounter_id uuid primary key references public.encounters(id) on delete cascade,
  seeds uuid[] not null,
  round_games uuid[] not null default array[null,null,null]::uuid[],
  check (cardinality(seeds)=8 and cardinality(round_games)=3)
);
create table if not exists public.predictions (
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  predicted_player_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(game_id,user_id)
);

alter table public.teams enable row level security;
alter table public.team_players enable row level security;
alter table public.brackets enable row level security;
alter table public.predictions enable row level security;

drop policy if exists teams_public_read on public.teams;
drop policy if exists teams_admin_all on public.teams;
create policy teams_public_read on public.teams for select to anon,authenticated using(true);
create policy teams_admin_all on public.teams for all to authenticated using((select public.is_admin())) with check((select public.is_admin()));
drop policy if exists team_players_public_read on public.team_players;
drop policy if exists team_players_admin_all on public.team_players;
create policy team_players_public_read on public.team_players for select to anon,authenticated using(true);
create policy team_players_admin_all on public.team_players for all to authenticated using((select public.is_admin())) with check((select public.is_admin()));
drop policy if exists brackets_public_read on public.brackets;
drop policy if exists brackets_admin_all on public.brackets;
create policy brackets_public_read on public.brackets for select to anon,authenticated using(true);
create policy brackets_admin_all on public.brackets for all to authenticated using((select public.is_admin())) with check((select public.is_admin()));
drop policy if exists predictions_own_read on public.predictions;
drop policy if exists predictions_admin_read on public.predictions;
drop policy if exists predictions_own_insert on public.predictions;
drop policy if exists predictions_own_update on public.predictions;
create policy predictions_own_read on public.predictions for select to authenticated using(user_id=auth.uid());
create policy predictions_admin_read on public.predictions for select to authenticated using((select public.is_admin()));
create policy predictions_own_insert on public.predictions for insert to authenticated with check(user_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.status='approved' and p.player_id is not null));
create policy predictions_own_update on public.predictions for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.status='approved' and p.player_id is not null));

grant select on public.teams,public.team_players,public.brackets to anon,authenticated;
grant insert,update,delete on public.teams,public.team_players,public.brackets to authenticated;
grant select,insert,update on public.predictions to authenticated;

create or replace function public.guard_team_change()
returns trigger language plpgsql security invoker set search_path=public as $$
declare target_encounter uuid;
begin
  if tg_table_name='team_players' then
    if tg_op='DELETE' then
      select encounter_id into target_encounter from public.teams where id=old.team_id;
    else
      select encounter_id into target_encounter from public.teams where id=new.team_id;
    end if;
    if tg_op in ('INSERT','UPDATE') then
      if not exists(select 1 from public.encounter_players where encounter_id=target_encounter and player_id=new.player_id) then
        raise exception 'Jogador não participa deste encontro';
      end if;
    end if;
  else
    if tg_op='DELETE' then target_encounter:=old.encounter_id; else target_encounter:=new.encounter_id; end if;
  end if;
  if exists(select 1 from public.encounters where id=target_encounter and status='closed') then
    raise exception 'Reabra o encontro antes de alterar equipes' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists teams_guard_change on public.teams;
create trigger teams_guard_change before insert or update or delete on public.teams for each row execute function public.guard_team_change();
drop trigger if exists team_players_guard_change on public.team_players;
create trigger team_players_guard_change before insert or update or delete on public.team_players for each row execute function public.guard_team_change();

create or replace function public.save_team(p_team_id uuid,p_encounter_id uuid,p_name text,p_metric text,p_player_ids uuid[])
returns public.teams language plpgsql security invoker set search_path=public as $$
declare result public.teams%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode='42501'; end if;
  if not exists(select 1 from public.encounters where id=p_encounter_id and status='open' for update) then raise exception 'Encontro encerrado ou inexistente'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 60 or p_metric not in ('sum','average') or coalesce(cardinality(p_player_ids),0)=0 then raise exception 'Equipe inválida'; end if;
  if (select count(distinct x.id) from unnest(p_player_ids) as x(id))<>cardinality(p_player_ids)
    or (select count(*) from public.encounter_players where encounter_id=p_encounter_id and player_id=any(p_player_ids))<>cardinality(p_player_ids) then
    raise exception 'Jogadores inválidos ou repetidos';
  end if;
  if p_team_id is null then
    insert into public.teams(encounter_id,name,metric) values(p_encounter_id,trim(p_name),p_metric) returning * into result;
  else
    update public.teams set name=trim(p_name),metric=p_metric where id=p_team_id and encounter_id=p_encounter_id returning * into result;
    if not found then raise exception 'Equipe não encontrada'; end if;
  end if;
  delete from public.team_players where team_id=result.id;
  insert into public.team_players(team_id,player_id) select result.id,x.id from unnest(p_player_ids) as x(id);
  return result;
end $$;
revoke all on function public.save_team(uuid,uuid,text,text,uuid[]) from public,anon;
grant execute on function public.save_team(uuid,uuid,text,text,uuid[]) to authenticated;

create or replace function public.guard_bracket_change()
returns trigger language plpgsql security invoker set search_path=public as $$
declare target_encounter uuid;
begin
  if tg_op='DELETE' then target_encounter:=old.encounter_id; else target_encounter:=new.encounter_id; end if;
  if exists(select 1 from public.encounters where id=target_encounter and status='closed') then
    raise exception 'Reabra o encontro antes de alterar o torneio' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists brackets_guard_change on public.brackets;
create trigger brackets_guard_change before insert or update or delete on public.brackets for each row execute function public.guard_bracket_change();

create or replace function public.save_bracket(p_encounter_id uuid,p_seeds uuid[],p_round_games uuid[])
returns public.brackets language plpgsql security invoker set search_path=public as $$
declare result public.brackets%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode='42501'; end if;
  if not exists(select 1 from public.encounters where id=p_encounter_id and status='open' for update) then raise exception 'Encontro encerrado ou inexistente'; end if;
  if cardinality(p_seeds)<>8 or cardinality(p_round_games)<>3
    or (select count(distinct x.id) from unnest(p_seeds) as x(id))<>8
    or (select count(*) from public.encounter_players where encounter_id=p_encounter_id and player_id=any(p_seeds))<>8
    or (select count(distinct x.id) from unnest(p_round_games) as x(id) where x.id is not null)<>
       (select count(*) from unnest(p_round_games) as x(id) where x.id is not null)
    or exists(select 1 from unnest(p_round_games) as x(id) where x.id is not null and not exists(select 1 from public.games where id=x.id and encounter_id=p_encounter_id)) then
    raise exception 'Chave ou partidas inválidas';
  end if;
  insert into public.brackets(encounter_id,seeds,round_games) values(p_encounter_id,p_seeds,p_round_games)
    on conflict(encounter_id) do update set seeds=excluded.seeds,round_games=excluded.round_games returning * into result;
  return result;
end $$;
revoke all on function public.save_bracket(uuid,uuid[],uuid[]) from public,anon;
grant execute on function public.save_bracket(uuid,uuid[],uuid[]) to authenticated;

create or replace function public.guard_roster_competition()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if exists(select 1 from public.team_players tp join public.teams t on t.id=tp.team_id where t.encounter_id=old.encounter_id and tp.player_id=old.player_id)
    or exists(select 1 from public.brackets b where b.encounter_id=old.encounter_id and old.player_id=any(b.seeds)) then
    raise exception 'Remova o jogador da equipe ou da chave antes de tirá-lo do encontro';
  end if;
  return old;
end $$;
drop trigger if exists encounter_players_guard_competition on public.encounter_players;
create trigger encounter_players_guard_competition before delete on public.encounter_players for each row execute function public.guard_roster_competition();

create or replace function public.cleanup_player_competition()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  delete from public.brackets where old.id=any(seeds);
  delete from public.team_players where player_id=old.id;
  return old;
end $$;
drop trigger if exists players_cleanup_competition on public.players;
create trigger players_cleanup_competition before delete on public.players for each row execute function public.cleanup_player_competition();

create or replace function public.delete_encounter(p_encounter_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode='42501'; end if;
  if not exists(select 1 from public.encounters where id=p_encounter_id and status='open' for update) then
    raise exception 'Reabra o encontro antes de excluí-lo';
  end if;
  delete from public.brackets where encounter_id=p_encounter_id;
  delete from public.teams where encounter_id=p_encounter_id;
  delete from public.encounters where id=p_encounter_id;
end $$;
revoke all on function public.delete_encounter(uuid) from public,anon;
grant execute on function public.delete_encounter(uuid) to authenticated;

create or replace function public.guard_prediction()
returns trigger language plpgsql security invoker set search_path=public as $$
declare target_encounter uuid;
begin
  select encounter_id into target_encounter from public.games where id=new.game_id;
  if not exists(select 1 from public.encounters where id=target_encounter and status='open')
    or exists(select 1 from public.scores where game_id=new.game_id and pontos is not null)
    or not exists(select 1 from public.scores where game_id=new.game_id and player_id=new.predicted_player_id) then
    raise exception 'Palpites só podem ser feitos antes dos primeiros pontos, para participantes da partida' using errcode='42501';
  end if;
  if tg_op='UPDATE' and (new.game_id<>old.game_id or new.user_id<>old.user_id) then raise exception 'Palpite inválido'; end if;
  return new;
end $$;
drop trigger if exists predictions_guard on public.predictions;
create trigger predictions_guard before insert or update on public.predictions for each row execute function public.guard_prediction();

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='teams') then
    alter publication supabase_realtime add table public.teams;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='team_players') then
    alter publication supabase_realtime add table public.team_players;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='brackets') then
    alter publication supabase_realtime add table public.brackets;
  end if;
end $$;

commit;
