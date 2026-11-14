-- Placar individual para pinball, minigolfe e tempo. Aplicar depois de v17.
-- A leitura pública expõe bigint somente como texto decimal, nunca como JSON number.
begin;

create table if not exists public.mode_player_scores (
  game_id uuid not null,
  player_id uuid not null,
  value bigint,
  status text not null check (status in ('active', 'DNF', 'DNS')),
  finalized boolean not null default false,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id),
  foreign key (game_id, player_id) references public.scores(game_id, player_id) on delete cascade,
  check (
    (status = 'active' and value is not null and value >= 0)
    or (status in ('DNF', 'DNS') and value is null and finalized)
  )
);
create index if not exists mode_player_scores_status_idx
  on public.mode_player_scores(game_id, finalized, status);

create table if not exists public.mode_player_score_changes (
  id bigint generated always as identity primary key,
  game_id uuid not null,
  player_id uuid not null,
  previous_value_text text,
  previous_status text,
  previous_finalized boolean,
  new_value_text text,
  new_status text not null,
  new_finalized boolean not null,
  new_version integer not null,
  actor_id uuid,
  changed_at timestamptz not null default now(),
  foreign key (game_id, player_id) references public.scores(game_id, player_id) on delete cascade
);
create index if not exists mode_player_score_changes_latest_idx
  on public.mode_player_score_changes(game_id, player_id, id desc);

insert into public.advanced_game_activity(game_id)
select distinct m.game_id
  from public.mode_player_scores m
  join public.games g on g.id = m.game_id
  join public.encounters e on e.id = g.encounter_id
 where e.game_type in ('pinball', 'minigolfe', 'tempo')
on conflict (game_id) do nothing;

alter table public.mode_player_scores enable row level security;
alter table public.mode_player_score_changes enable row level security;
drop policy if exists mode_player_scores_public_read on public.mode_player_scores;
create policy mode_player_scores_public_read on public.mode_player_scores
  for select to anon, authenticated using (true);
drop policy if exists mode_player_score_changes_admin_read on public.mode_player_score_changes;
create policy mode_player_score_changes_admin_read on public.mode_player_score_changes
  for select to authenticated using ((select public.is_admin()));
revoke all on public.mode_player_scores, public.mode_player_score_changes
  from public, anon, authenticated, service_role;
grant select on public.mode_player_score_changes to authenticated;

-- Public live-feed scores; the exact bigint remains exposed only by the RPC as text.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'mode_player_scores') then
    alter publication supabase_realtime add table public.mode_player_scores;
  end if;
end;
$$;

create or replace function public.record_mode_player_score_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, auth
as $$
begin
  insert into public.mode_player_score_changes (
    game_id, player_id, previous_value_text, previous_status, previous_finalized,
    new_value_text, new_status, new_finalized, new_version, actor_id
  ) values (
    new.game_id, new.player_id,
    case when tg_op = 'UPDATE' then old.value::text end,
    case when tg_op = 'UPDATE' then old.status end,
    case when tg_op = 'UPDATE' then old.finalized end,
    new.value::text, new.status, new.finalized, new.version,
    (select u.id from auth.users u where u.id = auth.uid())
  );
  return new;
end;
$$;
revoke all on function public.record_mode_player_score_change() from public, anon, authenticated, service_role;
drop trigger if exists mode_player_scores_record_change on public.mode_player_scores;
create trigger mode_player_scores_record_change after insert or update on public.mode_player_scores
  for each row execute function public.record_mode_player_score_change();
drop trigger if exists mode_player_scores_mark_activity on public.mode_player_scores;
create trigger mode_player_scores_mark_activity after insert or update or delete on public.mode_player_scores
  for each row execute function public.mark_multigame_ever_scored();

-- Derive completion from authoritative mode rows. The compatibility scores
-- projection is never accepted as proof that a match/set/leg was completed.
create or replace function public.derived_game_status(p_game_id uuid)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  target_game_type text;
  target_rules jsonb;
  participant_count integer;
  terminal_count integer;
  has_scores boolean;
  all_results_final boolean;
begin
  select e.game_type, e.rules_config into target_game_type, target_rules
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id;
  if not found then return 'partial'; end if;

  if target_game_type in ('pebolim', 'sinuca', 'tenis_mesa', 'truco') then
    select count(*)::integer into participant_count from public.scores s where s.game_id = p_game_id;
    select count(*)::integer into terminal_count
      from public.match_player_status m where m.game_id = p_game_id;
    select participant_count = 2 and (
      terminal_count = 1 or exists (
        select 1 from public.match_sets m
         where m.game_id = p_game_id and m.confirmed
         group by m.winner_player_id
        having count(*) >= (target_rules ->> 'sets_to_win')::integer
      )
    ) into all_results_final;
    return case when all_results_final then 'final' else 'partial' end;
  elsif target_game_type = 'dardos_501' then
    -- v19 replaces this function after the authoritative darts tables exist.
    return 'partial';
  elsif target_game_type in ('pinball', 'minigolfe', 'tempo') then
    select count(*)::integer into participant_count from public.scores s where s.game_id = p_game_id;
    select participant_count > 0 and not exists (
      select 1 from public.scores s
      left join public.mode_player_scores m
        on m.game_id = s.game_id and m.player_id = s.player_id
       where s.game_id = p_game_id and (m.game_id is null or not m.finalized)
    ) into all_results_final;
    return case when all_results_final then 'final' else 'partial' end;
  else
    select exists (select 1 from public.scores s where s.game_id = p_game_id),
           not exists (
             select 1 from public.scores s
              where s.game_id = p_game_id and (not s.finalizado or s.pontos is null)
           )
      into has_scores, all_results_final;
  end if;
  return case when has_scores and all_results_final then 'final' else 'partial' end;
end;
$$;
revoke all on function public.derived_game_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.derived_game_status(uuid) to anon, authenticated;

create or replace function public.sync_game_status()
returns trigger
language plpgsql security invoker
set search_path = public
as $$
declare
  target_game uuid;
  target_games uuid[];
begin
  if tg_op = 'DELETE' then
    target_games := array[old.game_id];
  elsif tg_op = 'UPDATE' and old.game_id is distinct from new.game_id then
    target_games := array[old.game_id, new.game_id];
  else
    target_games := array[new.game_id];
  end if;
  foreach target_game in array target_games loop
    update public.games g set status = public.derived_game_status(target_game)
     where g.id = target_game;
  end loop;
  return null;
end;
$$;

create or replace function public.guard_game_status()
returns trigger
language plpgsql security invoker
set search_path = public
as $$
begin
  new.status := public.derived_game_status(new.id);
  return new;
end;
$$;

create or replace function public.get_mode_player_scores(p_game_id uuid)
returns table (
  game_id uuid,
  player_id uuid,
  metric_key text,
  unit text,
  value_text text,
  status text,
  finalized boolean,
  version integer,
  updated_at timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select m.game_id, m.player_id,
         case e.game_type
           when 'pinball' then 'pinball_points'
           when 'minigolfe' then 'minigolfe_strokes'
           when 'tempo' then 'tempo_elapsed_ms'
         end,
         case e.game_type
           when 'pinball' then 'points'
           when 'minigolfe' then 'strokes'
           when 'tempo' then 'milliseconds'
         end,
         m.value::text, m.status, m.finalized, m.version, m.updated_at
    from public.mode_player_scores m
    join public.games g on g.id = m.game_id
    join public.encounters e on e.id = g.encounter_id
   where m.game_id = p_game_id
     and e.game_type in ('pinball', 'minigolfe', 'tempo')
   order by m.player_id;
$$;
revoke all on function public.get_mode_player_scores(uuid) from public;
grant execute on function public.get_mode_player_scores(uuid) to anon, authenticated;
comment on function public.get_mode_player_scores(uuid) is
  'Feed explícito: metric_key e unit acompanham value_text; tempo_elapsed_ms significa duração inteira em milissegundos.';

create or replace function public.save_mode_player_score(
  p_game_id uuid,
  p_player_id uuid,
  p_value bigint,
  p_status text,
  p_finalized boolean,
  p_expected_version integer
)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_game_type text;
  target_encounter_status text;
  existing public.mode_player_scores%rowtype;
  result public.mode_player_scores%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if p_game_id is null or p_player_id is null or p_status is null
     or p_status not in ('active', 'DNF', 'DNS')
     or p_finalized is null then
    raise exception 'Resultado de modalidade inválido' using errcode = '22023';
  end if;
  if (p_status = 'active' and (p_value is null or p_value < 0))
     or (p_status in ('DNF', 'DNS') and (p_value is not null or not p_finalized)) then
    raise exception 'Informe valor não negativo ou status terminal DNF/DNS' using errcode = '22023';
  end if;

  select g.encounter_id, e.game_type, e.status
    into target_encounter_id, target_game_type, target_encounter_status
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id for update of e;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  if target_game_type not in ('pinball', 'minigolfe', 'tempo') then
    raise exception 'Resultado individual não aceito nesta modalidade' using errcode = '22023';
  end if;
  if target_encounter_status <> 'active' then
    raise exception 'O encontro precisa estar ativo' using errcode = '42501';
  end if;
  perform 1 from public.games where id = p_game_id for update;
  perform 1 from public.scores where game_id = p_game_id and player_id = p_player_id for update;
  if not found then raise exception 'Participante não pertence à partida' using errcode = '23503'; end if;

  select * into existing from public.mode_player_scores
   where game_id = p_game_id and player_id = p_player_id for update;
  if found then
    if p_expected_version is distinct from existing.version then
      raise exception 'O resultado mudou desde a leitura' using errcode = '40001';
    end if;
    update public.mode_player_scores
       set value = p_value, status = p_status, finalized = p_finalized,
           version = version + 1, updated_at = now()
     where game_id = p_game_id and player_id = p_player_id returning * into result;
  else
    if p_expected_version is not null then raise exception 'O resultado ainda não existe' using errcode = '40001'; end if;
    insert into public.mode_player_scores(game_id, player_id, value, status, finalized)
    values (p_game_id, p_player_id, p_value, p_status, p_finalized) returning * into result;
  end if;

  -- guard_game_status/derived_game_status consult the mode feed, including DNF/DNS.
  update public.games set status = status where id = p_game_id;

  -- Never return PostgreSQL bigint through JSON as a number: JavaScript would round it.
  return jsonb_build_object(
    'game_id', result.game_id,
    'player_id', result.player_id,
    'metric_key', case target_game_type
      when 'pinball' then 'pinball_points'
      when 'minigolfe' then 'minigolfe_strokes'
      when 'tempo' then 'tempo_elapsed_ms'
    end,
    'unit', case target_game_type
      when 'pinball' then 'points'
      when 'minigolfe' then 'strokes'
      when 'tempo' then 'milliseconds'
    end,
    'value_text', result.value::text,
    'status', result.status,
    'finalized', result.finalized,
    'version', result.version,
    'updated_at', result.updated_at
  );
end;
$$;
revoke all on function public.save_mode_player_score(uuid, uuid, bigint, text, boolean, integer)
  from public, anon;
grant execute on function public.save_mode_player_score(uuid, uuid, bigint, text, boolean, integer)
  to authenticated;

comment on table public.mode_player_scores is
  'bigint não negativo: pinball = pontos brutos, minigolfe = tacadas/strokes, tempo = milissegundos inteiros decorridos. Clientes leem texto via get_mode_player_scores.';
comment on function public.save_mode_player_score(uuid, uuid, bigint, text, boolean, integer) is
  'Grava pinball/minigolfe/tempo atomicamente com CAS; tempo é milissegundos inteiros decorridos; retorno usa metric_key, unit e value_text decimal.';

commit;
