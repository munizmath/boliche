-- Aplicar depois de encounters.sql, hardening-p0.sql e v13-throw-mode.sql.
-- Expande o schema sem recalcular o histórico: encontros existentes continuam boliche.
-- A integração pode criar encontros multijogos somente após v15-round-scores.sql;
-- manter create_encounter como o caminho legado de boliche.
begin;

alter table public.encounters
  add column if not exists game_type text default 'boliche';
alter table public.encounters
  add column if not exists rules_version integer default 1;
alter table public.encounters
  add column if not exists rules_config jsonb default '{}'::jsonb;

update public.encounters set game_type = 'boliche' where game_type is null;
update public.encounters set rules_version = 1 where rules_version is null;
update public.encounters set rules_config = '{}'::jsonb where rules_config is null;

alter table public.encounters alter column game_type set default 'boliche';
alter table public.encounters alter column game_type set not null;
alter table public.encounters alter column rules_version set default 1;
alter table public.encounters alter column rules_version set not null;
alter table public.encounters alter column rules_config set default '{}'::jsonb;
alter table public.encounters alter column rules_config set not null;

alter table public.scores alter column pontos type bigint using pontos::bigint;
alter table public.score_changes alter column previous_points type bigint using previous_points::bigint;
alter table public.score_changes alter column new_points type bigint using new_points::bigint;

-- Remove apenas o limite legado de boliche da coluna; a faixa será validada
-- por modalidade no gatilho abaixo. A regra NOT NULL quando finalizado permanece.
alter table public.scores drop constraint if exists scores_pontos_check;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'scores_points_nonnegative'
       and conrelid = 'public.scores'::regclass
  ) then
    alter table public.scores add constraint scores_points_nonnegative
      check (pontos is null or pontos >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'encounters_game_type_valid'
       and conrelid = 'public.encounters'::regclass
  ) then
    alter table public.encounters add constraint encounters_game_type_valid
      check (game_type in ('boliche', 'quiz', 'gincana'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'encounters_rules_version_valid'
       and conrelid = 'public.encounters'::regclass
  ) then
    alter table public.encounters add constraint encounters_rules_version_valid
      check (rules_version >= 1);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'encounters_rules_config_valid'
       and conrelid = 'public.encounters'::regclass
  ) then
    alter table public.encounters add constraint encounters_rules_config_valid
      check (
        (game_type = 'boliche' and rules_config = '{}'::jsonb)
        or (
          game_type in ('quiz', 'gincana')
          and case
            when jsonb_typeof(rules_config) is distinct from 'object' then false
            when rules_config - 'round_count' - 'max_points_per_round' <> '{}'::jsonb then false
            when jsonb_typeof(rules_config -> 'round_count') is distinct from 'number' then false
            when (rules_config ->> 'round_count') !~ '^([1-9]|1[0-9]|20)$' then false
            when jsonb_typeof(rules_config -> 'max_points_per_round') is distinct from 'number' then false
            when (rules_config ->> 'max_points_per_round') !~ '^(0|[1-9][0-9]{0,9})$' then false
            else (rules_config ->> 'max_points_per_round')::numeric <= 2147483647
          end
        )
      );
  end if;
end;
$$;

-- Keep the legacy RPC bowling-only, including when a request_id is reused.
create or replace function public.create_encounter(
  p_name text,
  p_date date,
  p_player_ids uuid[],
  p_request_id uuid
)
returns public.encounters
language plpgsql
security invoker
set search_path = public
as $$
declare
  result public.encounters%rowtype;
  requested_players uuid[] := coalesce(p_player_ids, array[]::uuid[]);
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80
     or p_date is null or p_request_id is null then
    raise exception 'Nome, data ou identificador inválidos' using errcode = '22023';
  end if;

  select * into result from public.encounters where request_id = p_request_id for update;
  if found then
    if result.game_type is distinct from 'boliche' then
      raise exception 'request_id pertence a um encontro que não é boliche'
        using errcode = '23505';
    end if;
    return result;
  end if;
  if exists (select 1 from unnest(requested_players) x(id) where x.id is null)
     or (select count(distinct x.id) from unnest(requested_players) x(id))
          <> cardinality(requested_players) then
    raise exception 'Participante repetido' using errcode = '22023';
  end if;
  if (select count(*) from public.players p where p.id = any(requested_players))
       <> cardinality(requested_players) then
    raise exception 'Participante não cadastrado' using errcode = '22023';
  end if;

  insert into public.encounters(nome, data, request_id, game_type, rules_version, rules_config)
  values (trim(p_name), p_date, p_request_id, 'boliche', 1, '{}'::jsonb)
  on conflict (request_id) do nothing
  returning * into result;
  if result.id is null then
    select * into result from public.encounters where request_id = p_request_id for update;
    if not found or result.game_type is distinct from 'boliche' then
      raise exception 'request_id pertence a um encontro que não é boliche'
        using errcode = '23505';
    end if;
    return result;
  end if;

  insert into public.encounter_players(encounter_id, player_id)
    select result.id, x.id from unnest(requested_players) x(id);
  return result;
end;
$$;
revoke all on function public.create_encounter(text, date, uuid[], uuid) from public, anon;
grant execute on function public.create_encounter(text, date, uuid[], uuid) to authenticated;

create or replace function public.guard_score_points_by_game_type()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_encounter_id uuid;
  target_game_type text;
begin
  select g.encounter_id into target_encounter_id
    from public.games g where g.id = new.game_id;
  -- The locked row supplies game_type after waiting on a concurrent rule edit.
  select e.game_type into target_game_type
    from public.encounters e
   where e.id = target_encounter_id
   for update;

  if target_game_type = 'boliche'
     and new.pontos is not null
     and new.pontos not between 0 and 300 then
    raise exception 'Pontuação de boliche deve estar entre 0 e 300'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists scores_game_type_points_guard on public.scores;
create trigger scores_game_type_points_guard
  before insert or update of game_id, pontos on public.scores
  for each row execute function public.guard_score_points_by_game_type();
revoke all on function public.guard_score_points_by_game_type() from public, anon, authenticated, service_role;

create or replace function public.guard_encounter_rules_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.game_type is distinct from old.game_type
     or new.rules_version is distinct from old.rules_version
     or new.rules_config is distinct from old.rules_config then
    if exists (
         select 1
           from public.games g
           join public.scores s on s.game_id = g.id
          where g.encounter_id = old.id
            and (s.pontos is not null or s.finalizado)
       )
       or exists (
         select 1
           from public.games g
           join public.score_changes c on c.game_id = g.id
          where g.encounter_id = old.id
       ) then
      raise exception 'Modalidade e regras não podem mudar após o primeiro resultado'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists encounters_rules_immutable on public.encounters;
create trigger encounters_rules_immutable
  before update on public.encounters
  for each row execute function public.guard_encounter_rules_immutable();
revoke all on function public.guard_encounter_rules_immutable() from public, anon, authenticated, service_role;

commit;
