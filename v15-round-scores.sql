-- Aplicar depois de v14-game-types.sql e v13-throw-mode.sql.
-- A integração deve criar partidas pelo fluxo de encounters existente e salvar
-- encontros por create_multigame_encounter + activate_encounter. Salvar
-- quiz/gincana somente por save_round_score; limpar/desfazer com
-- clear_round_score e undo_round_score_change (parâmetro: id de auditoria).
-- Edite por edit_encounter_game e exclua por delete_encounter_game.
-- Leitura das rodadas é pública;
-- escrita direta em round_scores é revogada para manter o total consolidado.
-- save_game_scores, clear_game_score, undo_score_change e save_throw_score
-- permanecem disponíveis para boliche; gatilhos rejeitam qualquer escrita que
-- desalinhe rodadas ou tente criar score_details fora do boliche. Com max=0,
-- não há teto configurado por rodada; cada total e a soma do encontro ficam no
-- intervalo inteiro seguro do JS, incluindo rankings acumulados entre jogos.
begin;

create table if not exists public.round_scores (
  game_id uuid not null,
  player_id uuid not null,
  round_no integer not null check (round_no between 1 and 20),
  points bigint not null check (points >= 0),
  finalized boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id, round_no),
  constraint round_scores_score_fkey
    foreign key (game_id, player_id)
    references public.scores(game_id, player_id)
    on delete cascade
);

create index if not exists round_scores_player_game_idx
  on public.round_scores(player_id, game_id);

create table if not exists public.round_score_changes (
  id bigint generated always as identity primary key,
  -- Deliberately no FKs: keep audit evidence through game/player cascades.
  game_id uuid not null,
  player_id uuid not null,
  round_no integer not null,
  previous_points bigint,
  new_points bigint,
  previous_finalized boolean,
  new_finalized boolean,
  changed_at timestamptz not null default now(),
  actor_id uuid,
  check ((previous_points is null) = (previous_finalized is null)),
  check ((new_points is null) = (new_finalized is null))
);
create index if not exists round_score_changes_latest_idx
  on public.round_score_changes(game_id, player_id, round_no, id desc);

drop trigger if exists round_scores_updated_at on public.round_scores;
create trigger round_scores_updated_at
  before update on public.round_scores
  for each row execute function public.set_updated_at();

alter table public.round_scores enable row level security;
drop policy if exists round_scores_public_read on public.round_scores;
drop policy if exists round_scores_admin_write on public.round_scores;
create policy round_scores_public_read on public.round_scores
  for select to anon, authenticated using (true);
create policy round_scores_admin_write on public.round_scores
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.round_scores from public, anon, authenticated, service_role;
grant select on public.round_scores to anon, authenticated;

alter table public.round_score_changes enable row level security;
drop policy if exists round_score_changes_admin_read on public.round_score_changes;
create policy round_score_changes_admin_read on public.round_score_changes
  for select to authenticated using ((select public.is_admin()));
revoke all on public.round_score_changes from public, anon, authenticated, service_role;
grant select on public.round_score_changes to authenticated;

create or replace function public.record_round_score_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.round_score_changes
      (game_id, player_id, round_no, new_points, new_finalized, actor_id)
    values
      (new.game_id, new.player_id, new.round_no, new.points, new.finalized, auth.uid());
  elsif tg_op = 'UPDATE'
     and (new.points is distinct from old.points
       or new.finalized is distinct from old.finalized) then
    insert into public.round_score_changes
      (game_id, player_id, round_no, previous_points, new_points,
       previous_finalized, new_finalized, actor_id)
    values
      (new.game_id, new.player_id, new.round_no, old.points, new.points,
       old.finalized, new.finalized, auth.uid());
  elsif tg_op = 'DELETE' then
    insert into public.round_score_changes
      (game_id, player_id, round_no, previous_points, previous_finalized, actor_id)
    values
      (old.game_id, old.player_id, old.round_no, old.points, old.finalized, auth.uid());
  end if;
  return null;
end;
$$;

drop trigger if exists round_scores_record_change on public.round_scores;
create trigger round_scores_record_change
  after insert or update or delete on public.round_scores
  for each row execute function public.record_round_score_change();
revoke all on function public.record_round_score_change() from public, anon, authenticated, service_role;

create or replace function public.recalculate_round_score(
  p_game_id uuid,
  p_player_id uuid,
  p_round_count integer
)
returns public.scores
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_score public.scores%rowtype;
  recorded_round_count integer;
  recorded_points bigint;
  all_rounds_finalized boolean;
begin
  select s.* into target_score
    from public.scores s
   where s.game_id = p_game_id and s.player_id = p_player_id
   for update;
  if not found then raise exception 'Resultado da partida não encontrado' using errcode = 'P0002'; end if;

  select count(*)::integer,
         coalesce(sum(rs.points), 0)::bigint,
         coalesce(bool_and(rs.finalized), false)
    into recorded_round_count, recorded_points, all_rounds_finalized
    from public.round_scores rs
   where rs.game_id = p_game_id and rs.player_id = p_player_id;

  update public.scores s
     set pontos = case when recorded_round_count = 0 then null else recorded_points end,
         finalizado = recorded_round_count = p_round_count and all_rounds_finalized
   where s.id = target_score.id
  returning s.* into target_score;
  return target_score;
end;
$$;
revoke all on function public.recalculate_round_score(uuid, uuid, integer)
  from public, anon, authenticated, service_role;

create or replace function public.guard_round_derived_score()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_game_id uuid;
  target_player_id uuid;
  target_encounter_id uuid;
  target_game_type text;
  target_rules_config jsonb;
  expected_round_count integer;
  recorded_round_count integer;
  recorded_points bigint;
  all_rounds_finalized boolean;
  expected_points bigint;
  expected_finalized boolean;
  excluded_score_id uuid;
  encounter_total numeric;
begin
  -- Deleting a score removes its round rows through the composite FK cascade.
  -- The delete remains atomic and each removed round is retained in the audit.
  if tg_op = 'DELETE' then return old; end if;

  target_game_id := new.game_id;
  target_player_id := new.player_id;
  select g.encounter_id into target_encounter_id
    from public.games g where g.id = target_game_id;
  if not found then
    raise exception 'Partida do resultado não encontrada' using errcode = '23503';
  end if;

  -- Read the type and config from the row lock itself. If a concurrent rule
  -- update won the lock first, this statement sees and validates the new rule.
  select e.game_type, e.rules_config
    into target_game_type, target_rules_config
    from public.encounters e
   where e.id = target_encounter_id
   for update;
  if not found then
    raise exception 'Encontro do resultado não encontrado' using errcode = '23503';
  end if;
  if target_game_type is null or target_game_type not in ('quiz', 'gincana') then return new; end if;

  if tg_op = 'UPDATE'
     and (new.game_id is distinct from old.game_id
       or new.player_id is distinct from old.player_id) then
    raise exception 'Vínculo do resultado multijogos não pode ser alterado'
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.encounter_players ep
     where ep.encounter_id = target_encounter_id
       and ep.player_id = target_player_id
  ) then
    raise exception 'Participante não pertence ao encontro'
      using errcode = '23514';
  end if;

  expected_round_count := (target_rules_config ->> 'round_count')::integer;
  select count(*)::integer,
         sum(rs.points),
         coalesce(bool_and(rs.finalized), false)
    into recorded_round_count, recorded_points, all_rounds_finalized
    from public.round_scores rs
   where rs.game_id = target_game_id
     and rs.player_id = target_player_id;

  if recorded_round_count = 0 then
    expected_points := null;
    expected_finalized := false;
  else
    expected_points := recorded_points;
    expected_finalized := recorded_round_count = expected_round_count
      and all_rounds_finalized;
  end if;

  if new.pontos is distinct from expected_points
     or new.finalizado is distinct from expected_finalized then
    raise exception 'scores deve corresponder à soma e conclusão de round_scores'
      using errcode = '23514';
  end if;

  excluded_score_id := case when tg_op = 'UPDATE' then old.id else null end;
  select coalesce(sum(s.pontos), 0)
    into encounter_total
    from public.scores s
    join public.games g on g.id = s.game_id
   where g.encounter_id = target_encounter_id
     and s.id is distinct from excluded_score_id;
  encounter_total := encounter_total + coalesce(new.pontos, 0);
  if encounter_total > 9007199254740991 then
    raise exception 'A soma do encontro excede o inteiro seguro do JavaScript'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists scores_rounds_consistency on public.scores;
create trigger scores_rounds_consistency
  before insert or update or delete on public.scores
  for each row execute function public.guard_round_derived_score();
revoke all on function public.guard_round_derived_score() from public, anon, authenticated, service_role;

create or replace function public.guard_score_details_game_type()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_game_type text;
  linked_game_id uuid;
  linked_player_id uuid;
begin
  select s.game_id, s.player_id into linked_game_id, linked_player_id
    from public.scores s where s.id = new.score_id for update;
  if not found
     or linked_game_id is distinct from new.game_id
     or linked_player_id is distinct from new.player_id then
    raise exception 'score_details deve corresponder ao score_id, game_id e player_id'
      using errcode = '23503';
  end if;

  select e.game_type into target_game_type
    from public.games g
    join public.encounters e on e.id = g.encounter_id
   where g.id = new.game_id
   for update of e;
  if target_game_type is distinct from 'boliche' then
    raise exception 'Detalhes de arremessos existem somente no boliche'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists score_details_bowling_only on public.score_details;
create trigger score_details_bowling_only
  before insert or update on public.score_details
  for each row execute function public.guard_score_details_game_type();
revoke all on function public.guard_score_details_game_type() from public, anon, authenticated, service_role;

create or replace function public.guard_throw_changes_game_type()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_game_type text;
begin
  select e.game_type into target_game_type
    from public.games g
    join public.encounters e on e.id = g.encounter_id
   where g.id = new.game_id
   for update of e;
  if target_game_type is distinct from 'boliche' then
    raise exception 'Histórico de arremessos existe somente no boliche'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists throw_changes_bowling_only on public.throw_changes;
create trigger throw_changes_bowling_only
  before insert on public.throw_changes
  for each row execute function public.guard_throw_changes_game_type();
revoke all on function public.guard_throw_changes_game_type() from public, anon, authenticated, service_role;

create or replace function public.create_multigame_encounter(
  p_name text,
  p_date date,
  p_player_ids uuid[],
  p_request_id uuid,
  p_game_type text,
  p_rules_config jsonb
)
returns public.encounters
language plpgsql
security invoker
set search_path = public
as $$
declare
  result public.encounters%rowtype;
  normalized_rules jsonb := coalesce(p_rules_config, '{}'::jsonb);
  requested_players uuid[] := coalesce(p_player_ids, array[]::uuid[]);
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80
     or p_date is null
     or p_request_id is null
     or p_game_type is null
     or p_game_type not in ('boliche', 'quiz', 'gincana') then
    raise exception 'Nome, data, identificador ou modalidade inválidos'
      using errcode = '22023';
  end if;
  if exists (select 1 from unnest(requested_players) x(id) where x.id is null)
     or (select count(distinct x.id) from unnest(requested_players) x(id))
          <> cardinality(requested_players) then
    raise exception 'Participante repetido ou inválido' using errcode = '22023';
  end if;
  if (select count(*) from public.players p where p.id = any(requested_players))
       <> cardinality(requested_players) then
    raise exception 'Participante não cadastrado' using errcode = '22023';
  end if;

  if p_game_type = 'boliche' then
    if normalized_rules <> '{}'::jsonb then
      raise exception 'Boliche não aceita configuração de rodadas nesta versão'
        using errcode = '22023';
    end if;
  elsif jsonb_typeof(normalized_rules) is distinct from 'object' then
    raise exception 'Regras exigem round_count de 1 a 20 e max_points_per_round inteiro não negativo'
      using errcode = '22023';
  elsif normalized_rules - 'round_count' - 'max_points_per_round' <> '{}'::jsonb then
    raise exception 'Regras exigem round_count de 1 a 20 e max_points_per_round inteiro não negativo'
      using errcode = '22023';
  elsif jsonb_typeof(normalized_rules -> 'round_count') is distinct from 'number'
     or (normalized_rules ->> 'round_count') !~ '^([1-9]|1[0-9]|20)$' then
    raise exception 'Regras exigem round_count de 1 a 20 e max_points_per_round inteiro não negativo'
      using errcode = '22023';
  elsif jsonb_typeof(normalized_rules -> 'max_points_per_round') is distinct from 'number'
     or (normalized_rules ->> 'max_points_per_round') !~ '^(0|[1-9][0-9]{0,9})$' then
    raise exception 'Regras exigem round_count de 1 a 20 e max_points_per_round inteiro não negativo'
      using errcode = '22023';
  elsif (normalized_rules ->> 'max_points_per_round')::numeric > 2147483647 then
    raise exception 'Regras exigem round_count de 1 a 20 e max_points_per_round inteiro não negativo'
      using errcode = '22023';
  end if;

  select * into result
    from public.encounters
   where request_id = p_request_id
   for update;
  if found then
    if result.nome is distinct from trim(p_name)
       or result.data is distinct from p_date
       or result.game_type is distinct from p_game_type
       or result.rules_version is distinct from 1
       or result.rules_config is distinct from normalized_rules
       or (select count(*) from public.encounter_players ep where ep.encounter_id = result.id)
            <> cardinality(requested_players)
       or exists (
         select 1 from public.encounter_players ep
          where ep.encounter_id = result.id
            and not (ep.player_id = any(requested_players))
       ) then
      raise exception 'request_id já foi usado com outro conteúdo'
        using errcode = '23505';
    end if;
    return result;
  end if;

  insert into public.encounters
    (nome, data, status, request_id, game_type, rules_version, rules_config)
  values
    (trim(p_name), p_date, 'preparing', p_request_id, p_game_type, 1, normalized_rules)
  on conflict (request_id) do nothing
  returning * into result;

  if result.id is null then
    select * into result from public.encounters where request_id = p_request_id for update;
    if result.id is null
       or result.nome is distinct from trim(p_name)
       or result.data is distinct from p_date
       or result.game_type is distinct from p_game_type
       or result.rules_version is distinct from 1
       or result.rules_config is distinct from normalized_rules
       or (select count(*) from public.encounter_players ep where ep.encounter_id = result.id)
            <> cardinality(requested_players)
       or exists (
         select 1 from public.encounter_players ep
          where ep.encounter_id = result.id
            and not (ep.player_id = any(requested_players))
       ) then
      raise exception 'request_id já foi usado com outro conteúdo'
        using errcode = '23505';
    end if;
    return result;
  end if;

  insert into public.encounter_players(encounter_id, player_id)
    select result.id, x.id from unnest(requested_players) x(id);
  return result;
end;
$$;

revoke all on function public.create_multigame_encounter(text, date, uuid[], uuid, text, jsonb)
  from public, anon;
grant execute on function public.create_multigame_encounter(text, date, uuid[], uuid, text, jsonb)
  to authenticated;

create or replace function public.save_round_score(
  p_game_id uuid,
  p_player_id uuid,
  p_round_no integer,
  p_points bigint,
  p_finalized boolean
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
  target_score public.scores%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_game_id is null or p_player_id is null or p_round_no is null
     or p_points is null or p_points < 0 or p_finalized is null then
    raise exception 'Partida, participante, rodada ou pontos inválidos'
      using errcode = '22023';
  end if;

  select g.encounter_id into target_encounter_id
    from public.games g where g.id = p_game_id;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;

  select e.status, e.game_type, e.rules_config
    into encounter_status, target_game_type, target_rules_config
    from public.encounters e
   where e.id = target_encounter_id
   for update;
  if not found then raise exception 'Encontro não encontrado' using errcode = 'P0002'; end if;
  if encounter_status <> 'active' then
    raise exception 'O encontro precisa estar ativo' using errcode = '42501';
  end if;
  if target_game_type not in ('quiz', 'gincana') then
    raise exception 'Rodadas são aceitas somente em quiz e gincana'
      using errcode = '22023';
  end if;

  perform 1 from public.games g
   where g.id = p_game_id and g.encounter_id = target_encounter_id
   for update;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;

  select (target_rules_config ->> 'round_count')::integer,
         (target_rules_config ->> 'max_points_per_round')::integer
    into expected_round_count, max_points_per_round;
  if p_round_no < 1 or p_round_no > expected_round_count
     or (max_points_per_round > 0 and p_points > max_points_per_round)
     or p_points::numeric > floor(9007199254740991::numeric / expected_round_count) then
    raise exception 'Rodada ou pontos fora das regras do encontro'
      using errcode = '22023';
  end if;

  select s.* into target_score
    from public.scores s
   where s.game_id = p_game_id and s.player_id = p_player_id
   for update;
  if not found
     or not exists (
       select 1 from public.encounter_players ep
        where ep.encounter_id = target_encounter_id and ep.player_id = p_player_id
     ) then
    raise exception 'Jogador não vinculado à partida ou ao encontro'
      using errcode = '23503';
  end if;

  insert into public.round_scores as existing
    (game_id, player_id, round_no, points, finalized)
  values (p_game_id, p_player_id, p_round_no, p_points, p_finalized)
  on conflict (game_id, player_id, round_no) do update
     set points = excluded.points,
         finalized = excluded.finalized
   where existing.points is distinct from excluded.points
      or existing.finalized is distinct from excluded.finalized;

  return public.recalculate_round_score(p_game_id, p_player_id, expected_round_count);
end;
$$;

revoke all on function public.save_round_score(uuid, uuid, integer, bigint, boolean)
  from public, anon;
grant execute on function public.save_round_score(uuid, uuid, integer, bigint, boolean)
  to authenticated;

create or replace function public.clear_round_score(
  p_game_id uuid,
  p_player_id uuid,
  p_round_no integer
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
  removed public.round_scores%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_game_id is null or p_player_id is null or p_round_no is null then
    raise exception 'Partida, participante ou rodada inválidos' using errcode = '22023';
  end if;

  select g.encounter_id into target_encounter_id
    from public.games g where g.id = p_game_id;
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
  expected_round_count := (target_rules_config ->> 'round_count')::integer;
  if p_round_no < 1 or p_round_no > expected_round_count then
    raise exception 'Rodada fora das regras do encontro' using errcode = '22023';
  end if;
  perform 1 from public.scores s
   where s.game_id = p_game_id and s.player_id = p_player_id for update;
  if not found or not exists (
    select 1 from public.encounter_players ep
     where ep.encounter_id = target_encounter_id and ep.player_id = p_player_id
  ) then
    raise exception 'Jogador não vinculado à partida ou ao encontro' using errcode = '23503';
  end if;

  delete from public.round_scores rs
   where rs.game_id = p_game_id and rs.player_id = p_player_id and rs.round_no = p_round_no
  returning rs.* into removed;
  if not found then raise exception 'Rodada não encontrada' using errcode = 'P0002'; end if;
  return public.recalculate_round_score(p_game_id, p_player_id, expected_round_count);
end;
$$;
revoke all on function public.clear_round_score(uuid, uuid, integer) from public, anon;
grant execute on function public.clear_round_score(uuid, uuid, integer) to authenticated;

create or replace function public.undo_round_score_change(p_change_id bigint)
returns public.scores
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  change_row public.round_score_changes%rowtype;
  target_encounter_id uuid;
  encounter_status text;
  target_game_type text;
  target_rules_config jsonb;
  expected_round_count integer;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_change_id is null then raise exception 'Identificador de auditoria inválido' using errcode = '22023'; end if;
  select * into change_row from public.round_score_changes where id = p_change_id;
  if not found then raise exception 'Alteração de rodada não encontrada' using errcode = 'P0002'; end if;

  select g.encounter_id into target_encounter_id
    from public.games g where g.id = change_row.game_id;
  if not found then raise exception 'Partida da alteração não existe mais' using errcode = 'P0002'; end if;
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
   where g.id = change_row.game_id and g.encounter_id = target_encounter_id for update;
  if not found then raise exception 'Partida da alteração não existe mais' using errcode = 'P0002'; end if;
  select * into change_row
    from public.round_score_changes
   where id = p_change_id
   for update;
  if not found then raise exception 'Alteração de rodada não encontrada' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.round_score_changes c
     where c.game_id = change_row.game_id
       and c.player_id = change_row.player_id
       and c.round_no = change_row.round_no
       and c.id > change_row.id
  ) then
    raise exception 'Há uma alteração mais recente para esta rodada' using errcode = '40001';
  end if;

  perform 1 from public.scores s
   where s.game_id = change_row.game_id and s.player_id = change_row.player_id for update;
  if not found or not exists (
    select 1 from public.encounter_players ep
     where ep.encounter_id = target_encounter_id and ep.player_id = change_row.player_id
  ) then
    raise exception 'Jogador não vinculado à partida ou ao encontro' using errcode = '23503';
  end if;
  expected_round_count := (target_rules_config ->> 'round_count')::integer;
  if change_row.round_no < 1 or change_row.round_no > expected_round_count then
    raise exception 'Rodada fora das regras do encontro' using errcode = '22023';
  end if;

  if change_row.new_points is null then
    if exists (
      select 1 from public.round_scores rs
       where rs.game_id = change_row.game_id
         and rs.player_id = change_row.player_id
         and rs.round_no = change_row.round_no
    ) then
      raise exception 'A rodada mudou desde a alteração selecionada' using errcode = '40001';
    end if;
  elsif not exists (
    select 1 from public.round_scores rs
     where rs.game_id = change_row.game_id
       and rs.player_id = change_row.player_id
       and rs.round_no = change_row.round_no
       and rs.points = change_row.new_points
       and rs.finalized = change_row.new_finalized
  ) then
    raise exception 'A rodada mudou desde a alteração selecionada' using errcode = '40001';
  end if;

  if change_row.previous_points is null then
    delete from public.round_scores rs
     where rs.game_id = change_row.game_id
       and rs.player_id = change_row.player_id
       and rs.round_no = change_row.round_no;
  else
    insert into public.round_scores as existing
      (game_id, player_id, round_no, points, finalized)
    values (
      change_row.game_id, change_row.player_id, change_row.round_no,
      change_row.previous_points, change_row.previous_finalized
    )
    on conflict (game_id, player_id, round_no) do update
       set points = excluded.points, finalized = excluded.finalized
     where existing.points is distinct from excluded.points
        or existing.finalized is distinct from excluded.finalized;
  end if;
  return public.recalculate_round_score(
    change_row.game_id, change_row.player_id, expected_round_count
  );
end;
$$;
revoke all on function public.undo_round_score_change(bigint) from public, anon;
grant execute on function public.undo_round_score_change(bigint) to authenticated;

create or replace function public.edit_game(
  p_game_id uuid,
  p_name text,
  p_player_ids uuid[]
)
returns public.games
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_encounter_id uuid;
  encounter_status text;
  target_game_type text;
  result public.games%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80
     or coalesce(cardinality(p_player_ids), 0) = 0
     or exists (select 1 from unnest(coalesce(p_player_ids, array[]::uuid[])) x(id) where x.id is null)
     or (select count(distinct x.id)
           from unnest(coalesce(p_player_ids, array[]::uuid[])) x(id))
          <> coalesce(cardinality(p_player_ids), 0) then
    raise exception 'Nome ou participantes inválidos' using errcode = '22023';
  end if;
  if (select count(*) from public.players p where p.id = any(p_player_ids))
       <> cardinality(p_player_ids) then
    raise exception 'Há participantes não cadastrados' using errcode = '23503';
  end if;

  select g.encounter_id into target_encounter_id
    from public.games g where g.id = p_game_id;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  select e.status, e.game_type into encounter_status, target_game_type
    from public.encounters e where e.id = target_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado' using errcode = 'P0002'; end if;
  if encounter_status = 'closed' then
    raise exception 'Reabra o encontro antes de editar partidas' using errcode = '42501';
  end if;
  if target_game_type is distinct from 'boliche' then
    raise exception 'Use edit_encounter_game para editar partidas de quiz ou gincana'
      using errcode = '42501';
  end if;
  perform 1 from public.games g
   where g.id = p_game_id and g.encounter_id = target_encounter_id for update;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;

  update public.games set nome = trim(p_name) where id = p_game_id returning * into result;
  insert into public.scores(game_id, player_id, pontos, finalizado)
  select p_game_id, x.id, null, false
    from unnest(p_player_ids) x(id)
   where not exists (
     select 1 from public.scores s
      where s.game_id = p_game_id and s.player_id = x.id
   );
  delete from public.scores s
   where s.game_id = p_game_id and not (s.player_id = any(p_player_ids));
  select * into result from public.games where id = p_game_id;
  return result;
end;
$$;
revoke all on function public.edit_game(uuid, text, uuid[]) from public, anon;
grant execute on function public.edit_game(uuid, text, uuid[]) to authenticated;

create or replace function public.edit_encounter_game(
  p_game_id uuid,
  p_name text,
  p_assignments jsonb
)
returns public.games
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_encounter_id uuid;
  encounter_status text;
  target_game_type text;
  result public.games%rowtype;
  expected_count integer;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if jsonb_typeof(p_assignments) is distinct from 'array'
     or length(trim(coalesce(p_name, ''))) not between 1 and 80
     or jsonb_array_length(p_assignments) = 0 then
    raise exception 'Nome ou participantes inválidos' using errcode = '22023';
  end if;

  -- Read the parent id first without locking; then take locks consistently as
  -- encounter -> game, matching save_round_score and its corrective RPCs.
  select g.encounter_id into target_encounter_id
    from public.games g where g.id = p_game_id;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  select e.status, e.game_type into encounter_status, target_game_type
    from public.encounters e where e.id = target_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado' using errcode = 'P0002'; end if;
  if encounter_status = 'closed' then
    raise exception 'Reabra o encontro antes de editar partidas' using errcode = '42501';
  end if;
  select g.* into result
    from public.games g
   where g.id = p_game_id and g.encounter_id = target_encounter_id
   for update;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;

  expected_count := jsonb_array_length(p_assignments);
  if (select count(distinct x.player_id)
        from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)) <> expected_count
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
        where x.player_id is null or x.pista is null
           or length(trim(x.pista)) not between 1 and 20
     )
     or (select count(*)
           from public.encounter_players ep
           join jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
             on x.player_id = ep.player_id
          where ep.encounter_id = target_encounter_id) <> expected_count
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
       left join public.lanes l on l.name = x.pista where l.name is null
     )
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
       join public.lanes l on l.name = x.pista
       group by x.pista, l.capacity having count(*) > l.capacity
     ) then
    raise exception 'Distribuição de pistas inválida ou acima da capacidade'
      using errcode = '22023';
  end if;

  if target_game_type in ('quiz', 'gincana') and exists (
    select 1 from public.scores s
     where s.game_id = p_game_id
       and not exists (
         select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
          where x.player_id = s.player_id
       )
       and (
         s.pontos is not null or s.finalizado
         or exists (
           select 1 from public.round_scores rs
            where rs.game_id = s.game_id and rs.player_id = s.player_id
         )
         or exists (
           select 1 from public.round_score_changes c
            where c.game_id = s.game_id and c.player_id = s.player_id
         )
       )
  ) then
    raise exception 'Participante com rodada registrada não pode sair da partida'
      using errcode = '42501';
  end if;

  update public.games set nome = trim(p_name) where id = p_game_id returning * into result;
  update public.scores s
     set pista = x.pista
    from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
   where s.game_id = p_game_id and s.player_id = x.player_id;

  -- Never attempt INSERT ... ON CONFLICT for existing rows: BEFORE INSERT
  -- guards run before conflict resolution and multigame rows carry derived data.
  insert into public.scores(game_id, player_id, pista, pontos, finalizado)
  select p_game_id, x.player_id, x.pista, null, false
    from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
   where not exists (
     select 1 from public.scores s
      where s.game_id = p_game_id and s.player_id = x.player_id
   );

  delete from public.scores s
   where s.game_id = p_game_id
     and not exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
        where x.player_id = s.player_id
     );
  select * into result from public.games where id = p_game_id;
  return result;
end;
$$;
revoke all on function public.edit_encounter_game(uuid, text, jsonb) from public, anon;
grant execute on function public.edit_encounter_game(uuid, text, jsonb) to authenticated;

create or replace function public.delete_encounter_game(p_game_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_encounter_id uuid;
  encounter_status text;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  select g.encounter_id into target_encounter_id
    from public.games g where g.id = p_game_id;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  select e.status into encounter_status
    from public.encounters e where e.id = target_encounter_id for update;
  if not found then raise exception 'Encontro não encontrado' using errcode = 'P0002'; end if;
  if encounter_status = 'closed' then
    raise exception 'Reabra o encontro antes de excluir partidas' using errcode = '42501';
  end if;
  perform 1 from public.games g
   where g.id = p_game_id and g.encounter_id = target_encounter_id for update;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  delete from public.games where id = p_game_id;
end;
$$;
revoke all on function public.delete_encounter_game(uuid) from public, anon;
grant execute on function public.delete_encounter_game(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'round_scores'
  ) then
    alter publication supabase_realtime add table public.round_scores;
  end if;
end;
$$;

commit;
