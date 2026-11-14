-- Aplicar por último, após hardening-p0.sql, competition.sql, v14-game-types.sql
-- e v15-round-scores.sql (além do schema base e demais migrations anteriores).
-- Migração incremental e transacional; substitua COMMIT por ROLLBACK no ensaio.
begin;

-- Marca permanente, sem identificadores pessoais, do primeiro resultado multijogos.
alter table public.encounters
  add column if not exists multigame_ever_scored_at timestamptz,
  add column if not exists team_correction_reopened_at timestamptz;

update public.encounters e
   set multigame_ever_scored_at = coalesce(
     (select min(c.changed_at) from public.round_score_changes c
       join public.games g on g.id = c.game_id where g.encounter_id = e.id),
     (select min(c.changed_at) from public.score_changes c
       join public.games g on g.id = c.game_id where g.encounter_id = e.id),
     (select min(rs.created_at) from public.round_scores rs
       join public.games g on g.id = rs.game_id where g.encounter_id = e.id),
     clock_timestamp()
   )
 where e.game_type in ('quiz', 'gincana')
   and e.multigame_ever_scored_at is null
   and (
     exists (select 1 from public.round_scores rs join public.games g on g.id=rs.game_id where g.encounter_id=e.id)
     or exists (select 1 from public.round_score_changes c join public.games g on g.id=c.game_id where g.encounter_id=e.id)
     or exists (select 1 from public.score_changes c join public.games g on g.id=c.game_id where g.encounter_id=e.id)
     or exists (select 1 from public.scores s join public.games g on g.id=s.game_id
                 where g.encounter_id=e.id and (s.pontos is not null or s.finalizado))
     -- Prior audit has no encounter_id; fail closed if an older deletion left it orphaned.
     or exists (select 1 from public.round_score_changes c
                 where not exists (select 1 from public.games g where g.id=c.game_id))
   );

create or replace function public.guard_encounter_integrity_markers()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    if new.multigame_ever_scored_at is not null then
      raise exception 'A marca de resultado é gerenciada pelo banco' using errcode='42501';
    end if;
    new.team_correction_reopened_at := null;
    return new;
  end if;
  if old.multigame_ever_scored_at is not null
     and new.multigame_ever_scored_at is distinct from old.multigame_ever_scored_at then
    raise exception 'A marca de primeiro resultado é imutável' using errcode='42501';
  end if;
  if old.multigame_ever_scored_at is null
     and new.multigame_ever_scored_at is not null
     and pg_trigger_depth() <= 1 then
    raise exception 'A marca de resultado é gerenciada pelo banco' using errcode='42501';
  end if;
  if new.status = 'closed' then
    new.team_correction_reopened_at := null;
  elsif old.status = 'closed' and new.status = 'active' then
    new.team_correction_reopened_at := clock_timestamp();
  else
    new.team_correction_reopened_at := old.team_correction_reopened_at;
  end if;
  return new;
end;
$$;
drop trigger if exists encounters_integrity_markers on public.encounters;
create trigger encounters_integrity_markers
  before insert or update on public.encounters
  for each row execute function public.guard_encounter_integrity_markers();
revoke all on function public.guard_encounter_integrity_markers()
  from public, anon, authenticated, service_role;

create or replace function public.mark_multigame_ever_scored()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  target_game_id uuid;
  target_encounter_id uuid;
begin
  if tg_op='DELETE' then target_game_id:=old.game_id;
  else target_game_id:=new.game_id;
  end if;
  select g.encounter_id into target_encounter_id
    from public.games g where g.id=target_game_id;
  if not found then return null; end if;
  update public.encounters e
     set multigame_ever_scored_at=coalesce(e.multigame_ever_scored_at,clock_timestamp())
   where e.id=target_encounter_id and e.game_type <> 'boliche'
     and e.multigame_ever_scored_at is null;
  return null;
end;
$$;
drop trigger if exists round_scores_mark_multigame_scored on public.round_scores;
create trigger round_scores_mark_multigame_scored
  after insert or update of points, finalized on public.round_scores
  for each row execute function public.mark_multigame_ever_scored();
drop trigger if exists round_scores_mark_multigame_deleted on public.round_scores;
create trigger round_scores_mark_multigame_deleted
  after delete on public.round_scores
  for each row execute function public.mark_multigame_ever_scored();
revoke all on function public.mark_multigame_ever_scored()
  from public, anon, authenticated, service_role;

create or replace function public.guard_encounter_rules_immutable()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  if new.game_type is distinct from old.game_type
     or new.rules_version is distinct from old.rules_version
     or new.rules_config is distinct from old.rules_config then
    if old.multigame_ever_scored_at is not null
       or exists (select 1 from public.games g join public.scores s on s.game_id=g.id
                   where g.encounter_id=old.id and (s.pontos is not null or s.finalizado))
       or exists (select 1 from public.games g join public.score_changes c on c.game_id=g.id
                   where g.encounter_id=old.id)
       or exists (select 1 from public.games g join public.round_score_changes c on c.game_id=g.id
                   where g.encounter_id=old.id) then
      raise exception 'Modalidade e regras não podem mudar após o primeiro resultado'
        using errcode='42501';
    end if;
  end if;
  return new;
end;
$$;

-- A exclusão direta de scores deixa de ser concedida. Os RPCs admin existentes
-- mantêm o fluxo verificado sob SECURITY DEFINER e search_path fixo.
alter table public.scores enable row level security;
drop policy if exists scores_admin_delete on public.scores;
revoke delete on public.scores from public, anon, authenticated;
alter function public.edit_game(uuid, text, uuid[]) security definer;
alter function public.edit_game(uuid, text, uuid[]) set search_path to pg_catalog, public;
alter function public.edit_encounter_game(uuid, text, jsonb) security definer;
alter function public.edit_encounter_game(uuid, text, jsonb) set search_path to pg_catalog, public;
alter function public.delete_encounter_game(uuid) security definer;
alter function public.delete_encounter_game(uuid) set search_path to pg_catalog, public;
alter function public.delete_player_cascade(uuid) security definer;
alter function public.delete_player_cascade(uuid) set search_path to pg_catalog, public;

-- Edição e exclusão de equipes passam pelos RPCs abaixo, evitando locks de linha
-- adquiridos antes do lock do encontro por DML direto do cliente.
revoke insert, update, delete on public.teams from public, anon, authenticated, service_role;
revoke insert, update, delete on public.team_players from public, anon, authenticated, service_role;

-- RPC CAS para limpeza: o cliente envia os valores que leu; concorrência falha fechada.
create or replace function public.clear_round_score_if_current(
  p_game_id uuid, p_player_id uuid, p_round_no integer,
  p_expected_points bigint, p_expected_finalized boolean
)
returns public.scores
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  target_encounter_id uuid;
  actual_points bigint;
  actual_finalized boolean;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode='42501';
  end if;
  if p_game_id is null or p_player_id is null or p_round_no is null
     or p_expected_points is null or p_expected_finalized is null then
    raise exception 'Resultado esperado inválido' using errcode='22023';
  end if;
  select g.encounter_id into target_encounter_id from public.games g where g.id=p_game_id;
  if not found then raise exception 'Partida não encontrada' using errcode='P0002'; end if;
  perform 1 from public.encounters e where e.id=target_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado' using errcode='P0002'; end if;
  perform 1 from public.games g where g.id=p_game_id and g.encounter_id=target_encounter_id for update;
  if not found then raise exception 'Partida não encontrada' using errcode='P0002'; end if;
  perform 1 from public.scores s where s.game_id=p_game_id and s.player_id=p_player_id for update;
  if not found then raise exception 'Jogador não vinculado à partida' using errcode='23503'; end if;
  select rs.points,rs.finalized into actual_points,actual_finalized
    from public.round_scores rs
   where rs.game_id=p_game_id and rs.player_id=p_player_id and rs.round_no=p_round_no
   for update;
  if not found or actual_points is distinct from p_expected_points
     or actual_finalized is distinct from p_expected_finalized then
    raise exception 'A rodada mudou em outro aparelho; atualize e confira novamente'
      using errcode='40001';
  end if;
  return public.clear_round_score(p_game_id,p_player_id,p_round_no);
end;
$$;
revoke all on function public.clear_round_score_if_current(uuid,uuid,integer,bigint,boolean) from public,anon;
grant execute on function public.clear_round_score_if_current(uuid,uuid,integer,bigint,boolean) to authenticated;


-- Núcleo privado comum aos saves diretos, CAS individual e batch.
-- Ordem de locks: encounter -> game -> score -> round_score.
create or replace function public.save_round_score_v16(
  p_game_id uuid,
  p_player_id uuid,
  p_round_no integer,
  p_points bigint,
  p_finalized boolean,
  p_compare_current boolean,
  p_expected_points bigint,
  p_expected_finalized boolean
)
returns public.scores
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  encounter_status text;
  target_game_type text;
  target_rules_config jsonb;
  expected_round_count integer;
  max_points_per_round integer;
  actual_points bigint;
  actual_finalized boolean;
  round_exists boolean;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_game_id is null or p_player_id is null or p_round_no is null
     or p_points is null or p_points < 0 or p_finalized is null
     or p_compare_current is null then
    raise exception 'Partida, participante, rodada ou pontos inválidos' using errcode = '22023';
  end if;

  select g.encounter_id into target_encounter_id from public.games g where g.id = p_game_id;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  select e.status, e.game_type, e.rules_config
    into encounter_status, target_game_type, target_rules_config
    from public.encounters e where e.id = target_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado' using errcode = 'P0002'; end if;
  if encounter_status <> 'active' then
    raise exception 'O encontro precisa estar ativo' using errcode = '42501';
  end if;
  if target_game_type not in ('quiz', 'gincana') then
    raise exception 'Rodadas são aceitas somente em quiz e gincana' using errcode = '22023';
  end if;
  perform 1 from public.games g
   where g.id = p_game_id and g.encounter_id = target_encounter_id for update;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;

  select (target_rules_config ->> 'round_count')::integer,
         (target_rules_config ->> 'max_points_per_round')::integer
    into expected_round_count, max_points_per_round;
  if p_round_no < 1 or p_round_no > expected_round_count
     or (max_points_per_round > 0 and p_points > max_points_per_round)
     or p_points::numeric > floor(9007199254740991::numeric / expected_round_count) then
    raise exception 'Rodada ou pontos fora das regras do encontro' using errcode = '22023';
  end if;

  perform 1 from public.scores s
   where s.game_id = p_game_id and s.player_id = p_player_id for update;
  if not found or not exists (
    select 1 from public.encounter_players ep
     where ep.encounter_id = target_encounter_id and ep.player_id = p_player_id
  ) then
    raise exception 'Jogador não vinculado à partida ou ao encontro' using errcode = '23503';
  end if;

  select rs.points, rs.finalized into actual_points, actual_finalized
    from public.round_scores rs
   where rs.game_id = p_game_id and rs.player_id = p_player_id and rs.round_no = p_round_no
   for update;
  round_exists := found;
  if p_compare_current then
    if (round_exists and (actual_points is distinct from p_expected_points
                          or actual_finalized is distinct from p_expected_finalized))
       or (not round_exists and (p_expected_points is not null or p_expected_finalized is not null)) then
      raise exception 'A rodada mudou em outro aparelho; atualize e confira novamente'
        using errcode = '40001';
    end if;
  elsif round_exists
     and (actual_points is distinct from p_points or actual_finalized is distinct from p_finalized) then
    raise exception 'Use save_round_score_if_current para substituir uma rodada existente'
      using errcode = '40001';
  end if;

  insert into public.round_scores as existing
    (game_id, player_id, round_no, points, finalized)
  values (p_game_id, p_player_id, p_round_no, p_points, p_finalized)
  on conflict (game_id, player_id, round_no) do update
     set points = excluded.points, finalized = excluded.finalized
   where existing.points is distinct from excluded.points
      or existing.finalized is distinct from excluded.finalized;
  return public.recalculate_round_score(p_game_id, p_player_id, expected_round_count);
end;
$$;
revoke all on function public.save_round_score_v16(uuid, uuid, integer, bigint, boolean, boolean, bigint, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.save_round_score(
  p_game_id uuid, p_player_id uuid, p_round_no integer, p_points bigint, p_finalized boolean
)
returns public.scores
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.save_round_score_v16(
    p_game_id, p_player_id, p_round_no, p_points, p_finalized, false, null, null
  );
$$;
revoke all on function public.save_round_score(uuid, uuid, integer, bigint, boolean) from public, anon;
grant execute on function public.save_round_score(uuid, uuid, integer, bigint, boolean) to authenticated;

create or replace function public.save_round_score_if_current(
  p_game_id uuid,
  p_player_id uuid,
  p_round_no integer,
  p_points bigint,
  p_finalized boolean,
  p_expected_points bigint,
  p_expected_finalized boolean
)
returns public.scores
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.save_round_score_v16(
    p_game_id, p_player_id, p_round_no, p_points, p_finalized,
    true, p_expected_points, p_expected_finalized
  );
$$;
revoke all on function public.save_round_score_if_current(uuid, uuid, integer, bigint, boolean, bigint, boolean)
  from public, anon;
grant execute on function public.save_round_score_if_current(uuid, uuid, integer, bigint, boolean, bigint, boolean)
  to authenticated;

-- A RPC batch é uma única instrução transacional. A ordem UUID fixa os locks
-- de participantes; qualquer CAS divergente aborta o lote inteiro.
create or replace function public.save_round_scores_batch_if_current(
  p_game_id uuid,
  p_round_no integer,
  p_updates jsonb
)
returns setof public.scores
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  update_row record;
  saved_score public.scores%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_game_id is null or p_round_no is null
     or jsonb_typeof(p_updates) is distinct from 'array'
     or jsonb_array_length(p_updates) = 0 then
    raise exception 'Partida, rodada ou atualizações inválidas' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_updates) a(value)
     where jsonb_typeof(a.value) is distinct from 'object'
        or a.value - 'player_id' - 'points' - 'finalized'
                 - 'expected_points' - 'expected_finalized' <> '{}'::jsonb
        or not (a.value ? 'player_id')
        or not (a.value ? 'points')
        or not (a.value ? 'finalized')
        or not (a.value ? 'expected_points')
        or not (a.value ? 'expected_finalized')
        or jsonb_typeof(a.value -> 'player_id') is distinct from 'string'
        or jsonb_typeof(a.value -> 'points') is distinct from 'number'
        or jsonb_typeof(a.value -> 'finalized') is distinct from 'boolean'
        or jsonb_typeof(a.value -> 'expected_points') not in ('number', 'null')
        or jsonb_typeof(a.value -> 'expected_finalized') not in ('boolean', 'null')
  ) then
    raise exception 'Cada atualização exige jogador, pontos, confirmação e valores esperados'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_updates)
      as x(player_id uuid, points bigint, finalized boolean,
           expected_points bigint, expected_finalized boolean)
     where player_id is null or points is null or finalized is null
        or ((expected_points is null) is distinct from (expected_finalized is null))
  ) or (
    select count(distinct x.player_id)
      from jsonb_to_recordset(p_updates)
        as x(player_id uuid, points bigint, finalized boolean,
             expected_points bigint, expected_finalized boolean)
  ) <> jsonb_array_length(p_updates) then
    raise exception 'Participante repetido ou estado esperado inválido' using errcode = '22023';
  end if;

  for update_row in
    select x.player_id, x.points, x.finalized, x.expected_points, x.expected_finalized
      from jsonb_to_recordset(p_updates)
        as x(player_id uuid, points bigint, finalized boolean,
             expected_points bigint, expected_finalized boolean)
     order by x.player_id
  loop
    select * into saved_score
      from public.save_round_score_if_current(
        p_game_id, update_row.player_id, p_round_no, update_row.points,
        update_row.finalized, update_row.expected_points, update_row.expected_finalized
      );
    return next saved_score;
  end loop;
  return;
end;
$$;
revoke all on function public.save_round_scores_batch_if_current(uuid, integer, jsonb)
  from public, anon;
grant execute on function public.save_round_scores_batch_if_current(uuid, integer, jsonb)
  to authenticated;

-- Equipas: métrica comum no encontro; roster e métrica congelados após resultado.
create or replace function public.guard_team_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_status text;
  first_scored_at timestamptz;
  correction_reopened_at timestamptz;
begin
  -- Permite apenas a limpeza provocada por exclusão de pessoa/encontro.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;

  if tg_table_name = 'team_players' then
    if tg_op = 'UPDATE' and new.team_id is distinct from old.team_id then
      raise exception 'Vínculo de equipe não pode mudar de equipe' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then
      select t.encounter_id into target_encounter_id from public.teams t where t.id = old.team_id;
    else
      select t.encounter_id into target_encounter_id from public.teams t where t.id = new.team_id;
    end if;
  else
    if tg_op = 'UPDATE' and new.encounter_id is distinct from old.encounter_id then
      raise exception 'Equipe não pode mudar de encontro' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then target_encounter_id := old.encounter_id;
    else target_encounter_id := new.encounter_id;
    end if;
  end if;
  if target_encounter_id is null then
    raise exception 'Equipe não encontrada' using errcode = '23503';
  end if;

  select e.status, e.multigame_ever_scored_at, e.team_correction_reopened_at
    into target_status, first_scored_at, correction_reopened_at
    from public.encounters e where e.id = target_encounter_id for update;
  if not found then
    if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
    raise exception 'Encontro da equipe não encontrado' using errcode = '23503';
  end if;
  if target_status = 'closed' then
    raise exception 'Reabra o encontro antes de alterar equipes' using errcode = '42501';
  end if;
  if first_scored_at is not null and correction_reopened_at is null then
    raise exception 'Reabra explicitamente o encontro para corrigir equipes após pontuação'
      using errcode = '42501';
  end if;

  if tg_table_name = 'team_players' and tg_op in ('INSERT', 'UPDATE') then
    if not exists (
      select 1 from public.encounter_players ep
       where ep.encounter_id = target_encounter_id and ep.player_id = new.player_id
    ) then
      raise exception 'Jogador não participa deste encontro' using errcode = '23514';
    end if;
    if exists (
      select 1 from public.team_players tp
      join public.teams t on t.id = tp.team_id
       where t.encounter_id = target_encounter_id
         and tp.player_id = new.player_id and tp.team_id <> new.team_id
    ) then
      raise exception 'Jogador já pertence a outra equipe neste encontro' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_team_change() from public, anon, authenticated, service_role;

create or replace function public.guard_common_team_metric()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare target_encounter_id uuid;
begin
  if tg_op = 'DELETE' then target_encounter_id := old.encounter_id;
  else target_encounter_id := new.encounter_id;
  end if;
  if exists (
    select 1 from public.teams t
     where t.encounter_id = target_encounter_id
     group by t.encounter_id
    having count(distinct t.metric) > 1
  ) then
    raise exception 'Todas as equipes do encontro devem usar a mesma métrica'
      using errcode = '23514';
  end if;
  return null;
end;
$$;
drop trigger if exists teams_common_metric_guard on public.teams;
create constraint trigger teams_common_metric_guard
  after insert or update or delete on public.teams
  deferrable initially deferred for each row
  execute function public.guard_common_team_metric();
revoke all on function public.guard_common_team_metric()
  from public, anon, authenticated, service_role;

create or replace function public.save_team(
  p_team_id uuid, p_encounter_id uuid, p_name text, p_metric text, p_player_ids uuid[]
)
returns public.teams
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result public.teams%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_encounter_id is null or p_metric is null or p_metric not in ('sum', 'average')
     or length(trim(coalesce(p_name, ''))) not between 1 and 60
     or coalesce(cardinality(p_player_ids), 0) = 0 then
    raise exception 'Equipe inválida' using errcode = '22023';
  end if;
  perform 1 from public.encounters e
   where e.id = p_encounter_id and e.status <> 'closed' for update;
  if not found then raise exception 'Encontro encerrado ou inexistente' using errcode = '42501'; end if;
  if (select count(distinct x.id) from unnest(p_player_ids) x(id)) <> cardinality(p_player_ids)
     or (select count(*) from public.encounter_players ep
          where ep.encounter_id = p_encounter_id and ep.player_id = any(p_player_ids))
          <> cardinality(p_player_ids) then
    raise exception 'Jogadores inválidos ou repetidos' using errcode = '22023';
  end if;
  if p_team_id is not null and not exists (
    select 1 from public.teams t where t.id = p_team_id and t.encounter_id = p_encounter_id
  ) then
    raise exception 'Equipe não encontrada' using errcode = 'P0002';
  end if;

  -- teams.metric permanece para compatibilidade; save_team trata-a como métrica do encontro.
  update public.teams t set metric = p_metric
   where t.encounter_id = p_encounter_id and t.metric is distinct from p_metric;
  if p_team_id is null then
    insert into public.teams(encounter_id, name, metric)
    values (p_encounter_id, trim(p_name), p_metric) returning * into result;
  else
    update public.teams t set name = trim(p_name), metric = p_metric
     where t.id = p_team_id and t.encounter_id = p_encounter_id
     returning * into result;
  end if;
  delete from public.team_players tp where tp.team_id = result.id;
  insert into public.team_players(team_id, player_id)
    select result.id, x.id from unnest(p_player_ids) x(id);
  return result;
end;
$$;
revoke all on function public.save_team(uuid, uuid, text, text, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.save_team(uuid, uuid, text, text, uuid[]) to authenticated;

-- A trilha por jogador é removida com a pessoa e com a partida. O marcador acima
-- continua no encontro, sem PII, para preservar o bloqueio das regras.
create or replace function public.scrub_round_audit_after_player_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.round_score_changes c where c.player_id = old.id;
  return null;
end;
$$;
drop trigger if exists zz_round_audit_scrub_after_player_delete on public.players;
create trigger zz_round_audit_scrub_after_player_delete
  after delete on public.players
  for each row execute function public.scrub_round_audit_after_player_delete();
revoke all on function public.scrub_round_audit_after_player_delete()
  from public, anon, authenticated, service_role;

create or replace function public.scrub_round_audit_after_game_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.round_score_changes c where c.game_id = old.id;
  return null;
end;
$$;
drop trigger if exists zz_round_audit_scrub_after_game_delete on public.games;
create trigger zz_round_audit_scrub_after_game_delete
  after delete on public.games
  for each row execute function public.scrub_round_audit_after_game_delete();
revoke all on function public.scrub_round_audit_after_game_delete()
  from public, anon, authenticated, service_role;

-- Protege a estação reservada de manutenção direta pela tela de pistas.
create or replace function public.guard_virtual_station_lane()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' and old.name = '__estacao_virtual__' then
    raise exception 'A estação virtual é reservada para Quiz e Gincana'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.name = '__estacao_virtual__'
     and (new.name is distinct from old.name or new.capacity is distinct from 20) then
    raise exception 'A estação virtual não pode ser renomeada nem ter sua capacidade alterada'
      using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.name = '__estacao_virtual__'
     and new.capacity is distinct from 20 then
    raise exception 'A estação virtual deve ter capacidade 20' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.name is distinct from '__estacao_virtual__'
     and new.name = '__estacao_virtual__' then
    raise exception 'O nome da estação virtual é reservado' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists lanes_virtual_station_guard on public.lanes;
create trigger lanes_virtual_station_guard
  before insert or update or delete on public.lanes
  for each row execute function public.guard_virtual_station_lane();
revoke all on function public.guard_virtual_station_lane()
  from public, anon, authenticated, service_role;

-- Estação virtual única; nunca altera nem renomeia pistas de boliche existentes.
insert into public.lanes(name, capacity)
values ('__estacao_virtual__', 20)
on conflict (name) do nothing;
do $$
begin
  if not exists (
    select 1 from public.lanes where name='__estacao_virtual__' and capacity=20
  ) then
    raise exception 'A pista reservada __estacao_virtual__ precisa ter capacidade 20';
  end if;
end;
$$;

create or replace function public.guard_multigame_virtual_station()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare target_game_type text;
begin
  select e.game_type into target_game_type
    from public.games g join public.encounters e on e.id=g.encounter_id
   where g.id=new.game_id for update of e;
  if target_game_type = 'boliche' and new.pista = '__estacao_virtual__' then
    raise exception 'A estação virtual não pode ser usada em Boliche' using errcode='23514';
  end if;
  if target_game_type in ('quiz','gincana')
     and new.pista is distinct from '__estacao_virtual__' then
    raise exception 'Quiz e Gincana usam a estação __estacao_virtual__'
      using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists scores_multigame_virtual_station on public.scores;
create trigger scores_multigame_virtual_station
  before insert or update of game_id, pista on public.scores
  for each row execute function public.guard_multigame_virtual_station();
revoke all on function public.guard_multigame_virtual_station()
  from public, anon, authenticated, service_role;

create or replace function public.assert_encounter_game_assignments(
  p_encounter_id uuid, p_game_type text, p_assignments jsonb, p_require_virtual_station boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare expected_count integer;
begin
  if jsonb_typeof(p_assignments) is distinct from 'array' then
    raise exception 'Participantes inválidos' using errcode='22023';
  end if;
  if jsonb_array_length(p_assignments)=0
     or exists (
       select 1 from jsonb_array_elements(p_assignments) a(value)
        where jsonb_typeof(a.value) is distinct from 'object'
           or a.value - 'player_id' - 'pista' <> '{}'::jsonb
     ) then
    raise exception 'Participantes inválidos' using errcode='22023';
  end if;
  expected_count := jsonb_array_length(p_assignments);
  if (select count(distinct x.player_id)
        from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)) <> expected_count
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
        where x.player_id is null or x.pista is null
           or length(trim(x.pista)) not between 1 and 20
     )
     or (select count(*) from public.encounter_players ep
         join jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
           on x.player_id=ep.player_id where ep.encounter_id=p_encounter_id) <> expected_count
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
       left join public.lanes l on l.name=x.pista where l.name is null
     )
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
       join public.lanes l on l.name=x.pista
       group by x.pista,l.capacity having count(*)>l.capacity
     ) then
    raise exception 'Distribuição de estações inválida ou acima da capacidade'
      using errcode='22023';
  end if;
  if p_require_virtual_station and p_game_type in ('quiz','gincana')
     and exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
        where x.pista is distinct from '__estacao_virtual__'
     ) then
    raise exception 'Quiz e Gincana usam a estação __estacao_virtual__'
      using errcode='22023';
  end if;
  if p_game_type = 'boliche' and exists (
    select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
     where x.pista = '__estacao_virtual__'
  ) then
    raise exception 'A estação virtual não pode ser usada em Boliche' using errcode='22023';
  end if;
end;
$$;
revoke all on function public.assert_encounter_game_assignments(uuid,text,jsonb,boolean)
  from public, anon, authenticated, service_role;

create or replace function public.create_encounter_game(
  p_encounter_id uuid, p_name text, p_assignments jsonb, p_request_id uuid
)
returns public.games
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result public.games%rowtype;
  target_game_type text;
  target_status text;
  request_encounter_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode='42501';
  end if;
  if p_request_id is null or length(trim(coalesce(p_name,''))) not between 1 and 80 then
    raise exception 'Nome ou identificador inválido' using errcode='22023';
  end if;

  -- Repetição idêntica retorna a partida. Reutilização com outro conteúdo falha.
  select g.encounter_id into request_encounter_id
    from public.games g where g.request_id=p_request_id;
  if found then
    if request_encounter_id is distinct from p_encounter_id then
      raise exception 'request_id já foi usado com outro conteúdo' using errcode='23505';
    end if;
    perform 1 from public.encounters e where e.id=p_encounter_id for update;
    if not found then raise exception 'Encontro não encontrado' using errcode='P0002'; end if;
    select g.* into result from public.games g
     where g.request_id=p_request_id for update;
    if not found or result.encounter_id is distinct from p_encounter_id
       or result.nome is distinct from trim(p_name) then
      raise exception 'request_id já foi usado com outro conteúdo' using errcode='23505';
    end if;
    select e.game_type into target_game_type
      from public.encounters e where e.id=p_encounter_id;
    perform public.assert_encounter_game_assignments(
      p_encounter_id,target_game_type,p_assignments,false
    );
    if (select count(*) from public.scores s where s.game_id=result.id)
         <> jsonb_array_length(p_assignments)
       or exists (
         select 1 from public.scores s where s.game_id=result.id
          and not exists (
            select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
             where x.player_id=s.player_id and x.pista=s.pista
          )
       ) then
      raise exception 'request_id já foi usado com outro conteúdo' using errcode='23505';
    end if;
    return result;
  end if;

  select e.status,e.game_type into target_status,target_game_type
    from public.encounters e where e.id=p_encounter_id for update;
  if not found or target_status='closed' then
    raise exception 'Encontro inexistente ou encerrado' using errcode='42501';
  end if;
  perform public.assert_encounter_game_assignments(
    p_encounter_id,target_game_type,p_assignments,true
  );
  insert into public.games(nome,encounter_id,request_id)
  values(trim(p_name),p_encounter_id,p_request_id)
  on conflict(request_id) do nothing
  returning * into result;

  if result.id is null then
    select g.* into result from public.games g
     where g.request_id=p_request_id for update;
    if not found or result.encounter_id is distinct from p_encounter_id
       or result.nome is distinct from trim(p_name) then
      raise exception 'request_id já foi usado com outro conteúdo' using errcode='23505';
    end if;
    select e.game_type into target_game_type from public.encounters e where e.id=p_encounter_id;
    perform public.assert_encounter_game_assignments(
      p_encounter_id,target_game_type,p_assignments,false
    );
    if (select count(*) from public.scores s where s.game_id=result.id)
         <> jsonb_array_length(p_assignments)
       or exists (
         select 1 from public.scores s where s.game_id=result.id
          and not exists (
            select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text)
             where x.player_id=s.player_id and x.pista=s.pista
          )
       ) then
      raise exception 'request_id já foi usado com outro conteúdo' using errcode='23505';
    end if;
    return result;
  end if;

  insert into public.scores(game_id,player_id,pista,pontos,finalizado)
    select result.id,x.player_id,x.pista,null,false
      from jsonb_to_recordset(p_assignments) x(player_id uuid,pista text);
  return result;
end;
$$;
revoke all on function public.create_encounter_game(uuid,text,jsonb,uuid) from public,anon;
grant execute on function public.create_encounter_game(uuid,text,jsonb,uuid) to authenticated;


-- Exclusão de pessoa é uma solicitação de privacidade, inclusive em encontro
-- fechado; DML direto em scores segue revogado e só RPCs admin/parent cascades chegam aqui.
create or replace function public.guard_encounter_score()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  old_encounter_id uuid;
  new_encounter_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select g.encounter_id into old_encounter_id from public.games g where g.id=old.game_id;
    perform 1 from public.encounters e where e.id=old_encounter_id for update;
    if tg_op='UPDATE' and exists (
      select 1 from public.encounters e where e.id=old_encounter_id and e.status='closed'
    ) then
      raise exception 'Reabra o encontro antes de alterar pontos' using errcode='42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select g.encounter_id into new_encounter_id from public.games g where g.id=new.game_id;
    perform 1 from public.encounters e where e.id=new_encounter_id for update;
    if exists (
      select 1 from public.encounters e where e.id=new_encounter_id and e.status='closed'
    ) then
      raise exception 'Reabra o encontro antes de alterar pontos' using errcode='42501';
    end if;
    if exists (
      select 1 from public.encounters e where e.id=new_encounter_id and e.status='preparing'
    ) and (new.pontos is not null or new.finalizado) then
      raise exception 'Inicie o encontro antes de registrar pontos' using errcode='42501';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_encounter_score() from public, anon, authenticated, service_role;

create or replace function public.guard_encounter_roster()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  -- A exclusão de players apaga suas associações mesmo em encontros fechados.
  if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
  if tg_op in ('UPDATE','DELETE') then
    perform 1 from public.encounters e where e.id=old.encounter_id for update;
    if exists (select 1 from public.encounters e where e.id=old.encounter_id and e.status='closed') then
      raise exception 'Reabra o encontro antes de alterar participantes' using errcode='42501';
    end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform 1 from public.encounters e where e.id=new.encounter_id for update;
    if exists (select 1 from public.encounters e where e.id=new.encounter_id and e.status='closed') then
      raise exception 'Reabra o encontro antes de alterar participantes' using errcode='42501';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_encounter_roster() from public, anon, authenticated, service_role;

create or replace function public.guard_bracket_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare target_encounter_id uuid;
begin
  if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
  if tg_op='UPDATE' and new.encounter_id is distinct from old.encounter_id then
    raise exception 'Chave não pode mudar de encontro' using errcode='42501';
  end if;
  if tg_op='DELETE' then target_encounter_id:=old.encounter_id;
  else target_encounter_id:=new.encounter_id;
  end if;
  if exists (select 1 from public.encounters e where e.id=target_encounter_id and e.status='closed') then
    raise exception 'Reabra o encontro antes de alterar o torneio' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_bracket_change() from public, anon, authenticated, service_role;

create or replace function public.delete_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare target_encounter_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode='42501';
  end if;
  select t.encounter_id into target_encounter_id
    from public.teams t where t.id=p_team_id;
  if not found then raise exception 'Equipe não encontrada' using errcode='P0002'; end if;
  perform 1 from public.encounters e
   where e.id=target_encounter_id and e.status<>'closed' for update;
  if not found then raise exception 'Reabra o encontro antes de excluir equipes' using errcode='42501'; end if;
  delete from public.teams t where t.id=p_team_id and t.encounter_id=target_encounter_id;
  if not found then raise exception 'Equipe não encontrada' using errcode='P0002'; end if;
end;
$$;
revoke all on function public.delete_team(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_team(uuid) to authenticated;

-- Excluir a equipe pelo RPC mantém a ordem encounter -> team. A UI deve trocar
-- o DELETE PostgREST por rpc('delete_team', {p_team_id: id}) nesta release.

-- Exclusão do encontro usa apenas a cascata FK. Excluir teams antes do parent
-- acionava a trava de elenco em dados já pontuados.
create or replace function public.delete_encounter(p_encounter_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare target_status text;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode='42501';
  end if;
  select e.status into target_status
    from public.encounters e where e.id=p_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado' using errcode='P0002'; end if;
  if target_status='closed' then
    raise exception 'Reabra o encontro antes de excluí-lo' using errcode='42501';
  end if;
  delete from public.encounters e where e.id=p_encounter_id;
end;
$$;
revoke all on function public.delete_encounter(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_encounter(uuid) to authenticated;

-- sync_game_status atualiza somente o status depois de uma exclusão autorizada
-- de score. Permita esse update nested mesmo quando fechado; alterações diretas
-- ou mudanças de nome/vínculo continuam sujeitas ao bloqueio normal.
create or replace function public.guard_encounter_game()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op='UPDATE' and (
       new.encounter_id is distinct from old.encounter_id
       or new.request_id is distinct from old.request_id
     ) then
    raise exception 'A partida não pode mudar de encontro ou identificador' using errcode='42501';
  end if;
  if tg_op='UPDATE'
     and pg_trigger_depth()>1
     and new.encounter_id is not distinct from old.encounter_id
     and new.request_id is not distinct from old.request_id
     and new.nome is not distinct from old.nome
     and exists (
       select 1 from public.encounters e
        where e.id=old.encounter_id and e.status='closed'
     ) then
    return new;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    perform 1 from public.encounters e where e.id=old.encounter_id for update;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform 1 from public.encounters e where e.id=new.encounter_id for update;
  end if;
  if tg_op in ('UPDATE','DELETE') and exists (
    select 1 from public.encounters e where e.id=old.encounter_id and e.status='closed'
  ) then
    raise exception 'Reabra o encontro antes de alterar partidas' using errcode='42501';
  end if;
  if tg_op in ('INSERT','UPDATE') and exists (
    select 1 from public.encounters e where e.id=new.encounter_id and e.status='closed'
  ) then
    raise exception 'Reabra o encontro antes de alterar partidas' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_encounter_game() from public, anon, authenticated, service_role;

commit;
