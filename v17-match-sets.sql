-- Modalidades de confronto. Aplicar depois de v16-multigame-integrity.sql
-- (que deve suceder v15-round-scores.sql).
-- Todas as mutações são RPCs transacionais; vencedores são calculados aqui.
begin;

create or replace function public.json_integer_between(
  p_config jsonb, p_key text, p_min integer, p_max integer
)
returns boolean
language sql immutable security definer
set search_path = pg_catalog
as $$
  select case
    when jsonb_typeof(p_config -> p_key) is distinct from 'number' then false
    when (p_config ->> p_key) !~ '^(0|[1-9][0-9]{0,9})$' then false
    else (p_config ->> p_key)::numeric between p_min and p_max
  end;
$$;
revoke all on function public.json_integer_between(jsonb, text, integer, integer)
  from public, anon, authenticated, service_role;

create or replace function public.valid_game_rules(p_game_type text, p_rules_config jsonb)
returns boolean
language plpgsql immutable security definer
set search_path = pg_catalog, public
as $$
begin
  if p_game_type = 'boliche' then return p_rules_config = '{}'::jsonb; end if;
  if jsonb_typeof(p_rules_config) is distinct from 'object' then return false; end if;

  if p_game_type in ('quiz', 'gincana') then
    return p_rules_config - 'round_count' - 'max_points_per_round' = '{}'::jsonb
      and public.json_integer_between(p_rules_config, 'round_count', 1, 20)
      and public.json_integer_between(p_rules_config, 'max_points_per_round', 0, 2147483647);
  elsif p_game_type = 'pebolim' then
    return p_rules_config - 'sets_to_win' - 'points_to_win' - 'win_by' = '{}'::jsonb
      and public.json_integer_between(p_rules_config, 'sets_to_win', 1, 9)
      and public.json_integer_between(p_rules_config, 'points_to_win', 1, 99)
      and public.json_integer_between(p_rules_config, 'win_by', 1, 10);
  elsif p_game_type = 'sinuca' then
    return p_rules_config - 'sets_to_win' = '{}'::jsonb
      and public.json_integer_between(p_rules_config, 'sets_to_win', 1, 9);
  elsif p_game_type in ('tenis_mesa', 'truco') then
    return p_rules_config - 'sets_to_win' - 'points_to_win' - 'win_by' = '{}'::jsonb
      and public.json_integer_between(p_rules_config, 'sets_to_win', 1, 9)
      and public.json_integer_between(p_rules_config, 'points_to_win', 1, 99)
      and public.json_integer_between(p_rules_config, 'win_by', 1, 10);
  elsif p_game_type = 'dardos_501' then
    return p_rules_config - 'legs_to_win' = '{}'::jsonb
      and public.json_integer_between(p_rules_config, 'legs_to_win', 1, 15);
  elsif p_game_type in ('pinball', 'minigolfe', 'tempo') then
    return p_rules_config = '{}'::jsonb;
  end if;
  return false;
end;
$$;
revoke all on function public.valid_game_rules(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.valid_game_rules(text, jsonb) to public, anon, authenticated;

alter table public.encounters drop constraint if exists encounters_game_type_valid;
alter table public.encounters add constraint encounters_game_type_valid
  check (game_type in (
    'boliche', 'quiz', 'gincana', 'pebolim', 'sinuca', 'tenis_mesa', 'truco',
    'pinball', 'minigolfe', 'tempo', 'dardos_501'
  ));
alter table public.encounters drop constraint if exists encounters_rules_config_valid;
alter table public.encounters add constraint encounters_rules_config_valid
  check (public.valid_game_rules(game_type, rules_config));

-- Extend v16's common validator so unusable roster sizes fail on both create
-- and edit, before a game row or participants are changed.
create or replace function public.assert_encounter_game_assignments(
  p_encounter_id uuid, p_game_type text, p_assignments jsonb, p_require_virtual_station boolean
)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare expected_count integer;
begin
  if jsonb_typeof(p_assignments) is distinct from 'array' then
    raise exception 'Participantes inválidos' using errcode = '22023';
  end if;
  if jsonb_array_length(p_assignments) = 0
     or exists (
       select 1 from jsonb_array_elements(p_assignments) a(value)
        where jsonb_typeof(a.value) is distinct from 'object'
           or a.value - 'player_id' - 'pista' <> '{}'::jsonb
     ) then
    raise exception 'Participantes inválidos' using errcode = '22023';
  end if;
  expected_count := jsonb_array_length(p_assignments);
  if (p_game_type in ('pebolim', 'sinuca', 'tenis_mesa', 'truco') and expected_count <> 2)
     or (p_game_type = 'dardos_501' and expected_count not between 2 and 4) then
    raise exception 'Quantidade de participantes inválida para a modalidade' using errcode = '22023';
  end if;
  if (select count(distinct x.player_id)
        from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)) <> expected_count
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
        where x.player_id is null or x.pista is null or length(trim(x.pista)) not between 1 and 20
     )
     or (select count(*) from public.encounter_players ep
         join jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
           on x.player_id = ep.player_id where ep.encounter_id = p_encounter_id) <> expected_count
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
       left join public.lanes l on l.name = x.pista where l.name is null
     )
     or exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
       join public.lanes l on l.name = x.pista
       group by x.pista, l.capacity having count(*) > l.capacity
     ) then
    raise exception 'Distribuição de estações inválida ou acima da capacidade' using errcode = '22023';
  end if;
  if p_require_virtual_station and p_game_type in ('quiz', 'gincana')
     and exists (
       select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
        where x.pista is distinct from '__estacao_virtual__'
     ) then
    raise exception 'Quiz e Gincana usam a estação __estacao_virtual__' using errcode = '22023';
  end if;
  if p_game_type = 'boliche' and exists (
    select 1 from jsonb_to_recordset(p_assignments) x(player_id uuid, pista text)
     where x.pista = '__estacao_virtual__'
  ) then
    raise exception 'A estação virtual não pode ser usada em Boliche' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.assert_encounter_game_assignments(uuid, text, jsonb, boolean)
  from public, anon, authenticated, service_role;

-- RPC separado: preserva create_multigame_encounter e seus integrity guards do v16.
create or replace function public.create_advanced_encounter(
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
     or cardinality(requested_players) = 0
     or p_date is null or p_request_id is null
     or p_game_type not in (
       'pebolim', 'sinuca', 'tenis_mesa', 'truco', 'pinball', 'minigolfe', 'tempo', 'dardos_501'
     )
     or (p_game_type in ('pebolim', 'sinuca', 'tenis_mesa', 'truco', 'dardos_501')
         and cardinality(requested_players) < 2)
     or not public.valid_game_rules(p_game_type, normalized_rules) then
    raise exception 'Nome, data, modalidade ou configuração inválidos'
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

  select * into result from public.encounters where request_id = p_request_id for update;
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
          where ep.encounter_id = result.id and not (ep.player_id = any(requested_players))
       ) then
      raise exception 'request_id já foi usado com outro conteúdo' using errcode = '23505';
    end if;
    return result;
  end if;

  insert into public.encounters
    (nome, data, status, request_id, game_type, rules_version, rules_config)
  values (trim(p_name), p_date, 'preparing', p_request_id, p_game_type, 1, normalized_rules)
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
          where ep.encounter_id = result.id and not (ep.player_id = any(requested_players))
       ) then
      raise exception 'request_id já foi usado com outro conteúdo' using errcode = '23505';
    end if;
    return result;
  end if;
  insert into public.encounter_players(encounter_id, player_id)
    select result.id, x.id from unnest(requested_players) x(id);
  return result;
end;
$$;
revoke all on function public.create_advanced_encounter(text, date, uuid[], uuid, text, jsonb)
  from public, anon;
grant execute on function public.create_advanced_encounter(text, date, uuid[], uuid, text, jsonb)
  to authenticated;

create table if not exists public.match_sets (
  game_id uuid not null references public.games(id) on delete cascade,
  set_no integer not null check (set_no between 1 and 99),
  player_a_id uuid not null,
  player_b_id uuid not null,
  score_a integer not null check (score_a between 0 and 1000000),
  score_b integer not null check (score_b between 0 and 1000000),
  confirmed boolean not null default false,
  winner_player_id uuid,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (game_id, set_no),
  foreign key (game_id, player_a_id) references public.scores(game_id, player_id) on delete cascade,
  foreign key (game_id, player_b_id) references public.scores(game_id, player_id) on delete cascade,
  foreign key (winner_player_id) references public.players(id) on delete cascade,
  check (player_a_id <> player_b_id),
  check ((confirmed and winner_player_id is not null
          and winner_player_id in (player_a_id, player_b_id))
      or (not confirmed and winner_player_id is null))
);
alter table public.match_sets drop constraint if exists match_sets_winner_player_id_fkey;
alter table public.match_sets drop constraint if exists match_sets_winner_player_fk;
alter table public.match_sets add constraint match_sets_winner_player_fk
  foreign key (winner_player_id) references public.players(id) on delete cascade;
create index if not exists match_sets_player_idx
  on public.match_sets(game_id, winner_player_id, set_no);

create table if not exists public.match_player_status (
  game_id uuid not null,
  player_id uuid not null,
  status text not null check (status in ('DNF', 'DNS')),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id),
  foreign key (game_id, player_id) references public.scores(game_id, player_id) on delete cascade
);

-- Protect the legacy scores projection from direct PostgREST writes. Match
-- summaries must equal confirmed sets/forfeit state; individual modes keep this
-- legacy projection empty. Initial participant rows remain NULL/FALSE.
create or replace function public.guard_advanced_score_roster()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_game_type text;
  target_marker timestamptz;
  old_game_type text;
  old_marker timestamptz;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    select e.game_type, e.multigame_ever_scored_at
      into target_game_type, target_marker
      from public.games g join public.encounters e on e.id = g.encounter_id
     where g.id = old.game_id;
    if target_game_type in (
      'pebolim', 'sinuca', 'tenis_mesa', 'truco', 'pinball', 'minigolfe', 'tempo', 'dardos_501'
    ) and target_marker is not null then
      if current_setting('app.advanced_mode_privacy_delete', true) = 'on' and public.is_admin() then
        return old;
      end if;
      raise exception 'Participante com resultado avançado só pode ser removido pelo fluxo de privacidade ou da partida'
        using errcode = '42501';
    end if;
    return old;
  end if;

  select e.game_type, e.multigame_ever_scored_at
    into target_game_type, target_marker
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = new.game_id;
  if target_game_type not in (
    'pebolim', 'sinuca', 'tenis_mesa', 'truco', 'pinball', 'minigolfe', 'tempo', 'dardos_501'
  ) then return new; end if;

  if tg_op = 'UPDATE' and (old.game_id is distinct from new.game_id or old.player_id is distinct from new.player_id) then
    select e.game_type, e.multigame_ever_scored_at
      into old_game_type, old_marker
      from public.games g join public.encounters e on e.id = g.encounter_id
     where g.id = old.game_id;
    if old_marker is not null or target_marker is not null then
      raise exception 'Vínculo de participante não pode mudar depois do primeiro resultado avançado'
        using errcode = '42501';
    end if;
  elsif tg_op = 'INSERT' and target_marker is not null then
    raise exception 'Participantes não podem ser adicionados depois do primeiro resultado avançado'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_advanced_score_roster() from public, anon, authenticated, service_role;
drop trigger if exists scores_advanced_roster_guard on public.scores;
create trigger scores_advanced_roster_guard
  before insert or delete or update of game_id, player_id on public.scores
  for each row execute function public.guard_advanced_score_roster();

create or replace function public.guard_advanced_score_projection()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_game_type text;
  target_rules jsonb;
  participant_count integer;
  terminal_count integer;
  target_sets_to_win integer;
  expected_points bigint;
  expected_finalized boolean;
begin
  if tg_op = 'DELETE' then return old; end if;
  select e.game_type, e.rules_config into target_game_type, target_rules
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = new.game_id;
  if not found or target_game_type not in (
    'pebolim', 'sinuca', 'tenis_mesa', 'truco', 'pinball', 'minigolfe', 'tempo', 'dardos_501'
  ) then return new; end if;

  if tg_op = 'INSERT' or target_game_type in ('pinball', 'minigolfe', 'tempo', 'dardos_501') then
    if new.pontos is not null or new.finalizado then
      raise exception 'scores.pontos/finalizado não recebe resultado direto nesta modalidade'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select count(*)::integer into participant_count from public.scores s where s.game_id = new.game_id;
  select count(*)::integer into terminal_count
    from public.match_player_status m where m.game_id = new.game_id;
  select count(*)::bigint into expected_points
    from public.match_sets m
   where m.game_id = new.game_id and m.confirmed and m.winner_player_id = new.player_id;
  target_sets_to_win := (target_rules ->> 'sets_to_win')::integer;
  select participant_count = 2 and (
    terminal_count = 1 or exists (
      select 1 from public.match_sets m
       where m.game_id = new.game_id and m.confirmed
       group by m.winner_player_id having count(*) >= target_sets_to_win
    )
  ) into expected_finalized;
  if new.pontos is distinct from expected_points or new.finalizado is distinct from expected_finalized then
    raise exception 'scores diverge do resultado derivado de sets/status confirmados'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_advanced_score_projection() from public, anon, authenticated, service_role;
drop trigger if exists scores_advanced_projection_guard on public.scores;
create trigger scores_advanced_projection_guard
  before insert or update of game_id, player_id, pontos, finalizado on public.scores
  for each row execute function public.guard_advanced_score_projection();

-- Keep the existing privacy deletion route while marking only that trusted
-- SECURITY DEFINER path to the roster trigger. Cascading game/encounter deletes
-- are accepted by trigger depth and need no bypass flag.
create or replace function public.delete_player_cascade(p_player_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  affected_encounter_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  for affected_encounter_id in
    select affected.id from (
      select ep.encounter_id as id
        from public.encounter_players ep where ep.player_id = p_player_id
      union
      select g.encounter_id as id
        from public.games g join public.scores s on s.game_id = g.id
       where s.player_id = p_player_id
    ) affected order by affected.id
  loop
    perform 1 from public.encounters e where e.id = affected_encounter_id for update;
  end loop;
  update public.profiles set status = 'pending', player_id = null where player_id = p_player_id;
  perform set_config('app.advanced_mode_privacy_delete', 'on', true);
  delete from public.scores where player_id = p_player_id;
  perform set_config('app.advanced_mode_privacy_delete', 'off', true);
  delete from public.players where id = p_player_id;
  if not found then raise exception 'Jogador não encontrado' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.delete_player_cascade(uuid) from public, anon, service_role;
grant execute on function public.delete_player_cascade(uuid) to authenticated;

create table if not exists public.match_set_changes (
  id bigint generated always as identity primary key,
  game_id uuid not null,
  set_no integer not null,
  player_a_id uuid not null,
  player_b_id uuid not null,
  previous_score_a integer,
  previous_score_b integer,
  previous_confirmed boolean,
  previous_winner_player_id uuid,
  new_score_a integer not null,
  new_score_b integer not null,
  new_confirmed boolean not null,
  new_winner_player_id uuid,
  new_version integer not null,
  actor_id uuid,
  changed_at timestamptz not null default now(),
  foreign key (game_id, set_no) references public.match_sets(game_id, set_no) on delete cascade,
  foreign key (game_id, player_a_id) references public.scores(game_id, player_id) on delete cascade,
  foreign key (game_id, player_b_id) references public.scores(game_id, player_id) on delete cascade
);
create index if not exists match_set_changes_latest_idx
  on public.match_set_changes(game_id, set_no, id desc);

create table if not exists public.match_player_status_changes (
  id bigint generated always as identity primary key,
  game_id uuid not null,
  player_id uuid not null,
  previous_status text,
  new_status text not null,
  new_version integer not null,
  actor_id uuid,
  changed_at timestamptz not null default now(),
  foreign key (game_id, player_id) references public.scores(game_id, player_id) on delete cascade
);

-- Durable, non-PII evidence that an advanced encounter ever stored a result.
-- It deliberately does not reference result rows, so deleting those rows cannot clear it.
create table if not exists public.advanced_mode_activity (
  encounter_id uuid primary key references public.encounters(id) on delete cascade,
  first_activity_at timestamptz not null default now()
);
alter table public.advanced_mode_activity enable row level security;
revoke all on public.advanced_mode_activity from public, anon, authenticated, service_role;

-- Extends v16's canonical marker function; existing round_scores trigger remains intact.
create or replace function public.mark_multigame_ever_scored()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_game_id uuid;
  target_encounter_id uuid;
  target_game_type text;
  game_found boolean;
begin
  target_game_id := case when tg_op = 'DELETE' then old.game_id else new.game_id end;
  select e.id, e.game_type into target_encounter_id, target_game_type
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = target_game_id
   for update of e;
  game_found := found;
  if game_found and target_game_type <> 'boliche' then
    update public.encounters
       set multigame_ever_scored_at = coalesce(multigame_ever_scored_at, clock_timestamp())
     where id = target_encounter_id and multigame_ever_scored_at is null;
  end if;
  if game_found and target_game_type in (
    'pebolim', 'sinuca', 'tenis_mesa', 'truco', 'pinball', 'minigolfe', 'tempo', 'dardos_501'
  ) then
    insert into public.advanced_mode_activity(encounter_id)
    values (target_encounter_id) on conflict (encounter_id) do nothing;
  end if;
  return null;
end;
$$;
revoke all on function public.mark_multigame_ever_scored() from public, anon, authenticated, service_role;
drop trigger if exists match_sets_mark_activity on public.match_sets;
create trigger match_sets_mark_activity after insert or update or delete on public.match_sets
  for each row execute function public.mark_multigame_ever_scored();
drop trigger if exists match_player_status_mark_activity on public.match_player_status;
create trigger match_player_status_mark_activity after insert or update or delete on public.match_player_status
  for each row execute function public.mark_multigame_ever_scored();

-- Extra guard supplements v16's quiz/gincana marker and remains after result deletion.
create or replace function public.guard_advanced_rules_immutable()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if new.game_type is distinct from old.game_type
     or new.rules_version is distinct from old.rules_version
     or new.rules_config is distinct from old.rules_config then
    if exists (
      select 1 from public.advanced_mode_activity a where a.encounter_id = old.id
    ) then
      raise exception 'Modalidade e regras não podem mudar depois de resultado avançado armazenado'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_advanced_rules_immutable() from public, anon, authenticated, service_role;
drop trigger if exists encounters_advanced_rules_immutable on public.encounters;
create trigger encounters_advanced_rules_immutable before update on public.encounters
  for each row execute function public.guard_advanced_rules_immutable();

alter table public.match_sets enable row level security;
alter table public.match_player_status enable row level security;
alter table public.match_set_changes enable row level security;
alter table public.match_player_status_changes enable row level security;
drop policy if exists match_sets_public_read on public.match_sets;
create policy match_sets_public_read on public.match_sets
  for select to anon, authenticated using (true);
drop policy if exists match_player_status_public_read on public.match_player_status;
create policy match_player_status_public_read on public.match_player_status
  for select to anon, authenticated using (true);
drop policy if exists match_set_changes_admin_read on public.match_set_changes;
create policy match_set_changes_admin_read on public.match_set_changes
  for select to authenticated using ((select public.is_admin()));
drop policy if exists match_player_status_changes_admin_read on public.match_player_status_changes;
create policy match_player_status_changes_admin_read on public.match_player_status_changes
  for select to authenticated using ((select public.is_admin()));
revoke all on public.match_sets, public.match_player_status,
  public.match_set_changes, public.match_player_status_changes
  from public, anon, authenticated, service_role;
grant select on public.match_sets, public.match_player_status to anon, authenticated;
grant select on public.match_set_changes, public.match_player_status_changes to authenticated;

-- Public live-feed rows; RLS continues to control who may read the row contents.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'match_sets') then
      alter publication supabase_realtime add table public.match_sets;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'match_player_status') then
      alter publication supabase_realtime add table public.match_player_status;
    end if;
  end if;
end;
$$;

create or replace function public.record_match_set_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, auth
as $$
begin
  insert into public.match_set_changes (
    game_id, set_no, player_a_id, player_b_id,
    previous_score_a, previous_score_b, previous_confirmed,
    previous_winner_player_id, new_score_a, new_score_b, new_confirmed,
    new_winner_player_id, new_version, actor_id
  ) values (
    new.game_id, new.set_no, new.player_a_id, new.player_b_id,
    case when tg_op = 'UPDATE' then old.score_a end,
    case when tg_op = 'UPDATE' then old.score_b end,
    case when tg_op = 'UPDATE' then old.confirmed end,
    case when tg_op = 'UPDATE' then old.winner_player_id end,
    new.score_a, new.score_b, new.confirmed, new.winner_player_id,
    new.version,
    (select u.id from auth.users u where u.id = auth.uid())
  );
  return new;
end;
$$;
revoke all on function public.record_match_set_change() from public, anon, authenticated, service_role;
drop trigger if exists match_sets_record_change on public.match_sets;
create trigger match_sets_record_change after insert or update on public.match_sets
  for each row execute function public.record_match_set_change();

create or replace function public.record_match_player_status_change()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, auth
as $$
begin
  insert into public.match_player_status_changes (
    game_id, player_id, previous_status, new_status, new_version, actor_id
  ) values (
    new.game_id, new.player_id,
    case when tg_op = 'UPDATE' then old.status end,
    new.status, new.version,
    (select u.id from auth.users u where u.id = auth.uid())
  );
  return new;
end;
$$;
revoke all on function public.record_match_player_status_change() from public, anon, authenticated, service_role;
drop trigger if exists match_player_status_record_change on public.match_player_status;
create trigger match_player_status_record_change after insert or update on public.match_player_status
  for each row execute function public.record_match_player_status_change();

create or replace function public.refresh_match_score(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_rules jsonb;
  sets_to_win integer;
  completed boolean;
  terminal_count integer;
begin
  select g.encounter_id, e.rules_config
    into target_encounter_id, target_rules
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  sets_to_win := (target_rules ->> 'sets_to_win')::integer;

  select count(*)::integer into terminal_count
    from public.match_player_status where game_id = p_game_id;
  if terminal_count > 1 then
    raise exception 'Confronto sem vencedor: no máximo um participante pode ter DNF/DNS'
      using errcode = '23514';
  end if;

  select exists (
    select 1 from (
      select ms.winner_player_id, count(*)::integer as won
        from public.match_sets ms
       where ms.game_id = p_game_id and ms.confirmed
       group by ms.winner_player_id
    ) w where w.won >= sets_to_win
  ) or terminal_count = 1 into completed;

  update public.scores s
     set pontos = coalesce((
           select count(*)::bigint from public.match_sets ms
            where ms.game_id = s.game_id and ms.winner_player_id = s.player_id and ms.confirmed
         ), 0),
         finalizado = completed
   where s.game_id = p_game_id;
  update public.games set status = case when completed then 'final' else 'partial' end
   where id = p_game_id;
end;
$$;
revoke all on function public.refresh_match_score(uuid) from public, anon, authenticated, service_role;

create or replace function public.save_match_set(
  p_game_id uuid,
  p_set_no integer,
  p_player_a_id uuid,
  p_player_b_id uuid,
  p_score_a integer,
  p_score_b integer,
  p_confirmed boolean,
  p_expected_version integer
)
returns public.match_sets
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_game_type text;
  target_rules jsonb;
  target_status text;
  target_sets_to_win integer;
  target_points_to_win integer;
  target_win_by integer;
  winner_id uuid;
  existing public.match_sets%rowtype;
  result public.match_sets%rowtype;
  max_set_no integer;
  participant_count integer;
  set_exists boolean := false;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if p_game_id is null or p_set_no not between 1 and 99
     or p_player_a_id is null or p_player_b_id is null or p_player_a_id = p_player_b_id
     or p_score_a is null or p_score_b is null
     or p_score_a not between 0 and 1000000 or p_score_b not between 0 and 1000000
     or p_confirmed is null then
    raise exception 'Set inválido' using errcode = '22023';
  end if;

  select g.encounter_id, e.game_type, e.rules_config, e.status
    into target_encounter_id, target_game_type, target_rules, target_status
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id for update of e;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  if target_status <> 'active' then raise exception 'O encontro precisa estar ativo' using errcode = '42501'; end if;
  if target_game_type not in ('pebolim', 'sinuca', 'tenis_mesa', 'truco') then
    raise exception 'Sets não são aceitos nesta modalidade' using errcode = '22023';
  end if;
  perform 1 from public.games g where g.id = p_game_id for update;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;

  perform 1 from public.scores s where s.game_id = p_game_id order by s.player_id for update;
  select count(*)::integer into participant_count from public.scores s where s.game_id = p_game_id;
  if participant_count <> 2
     or not exists (select 1 from public.scores where game_id = p_game_id and player_id = p_player_a_id)
     or not exists (select 1 from public.scores where game_id = p_game_id and player_id = p_player_b_id) then
    raise exception 'Uma partida por sets deve conter exatamente os dois participantes informados' using errcode = '23514';
  end if;
  if exists (select 1 from public.match_player_status where game_id = p_game_id) then
    raise exception 'A partida já tem desistência terminal' using errcode = '23514';
  end if;

  select * into existing from public.match_sets
   where game_id = p_game_id and set_no = p_set_no for update;
  set_exists := found;
  select coalesce(max(set_no), 0) into max_set_no from public.match_sets where game_id = p_game_id;
  if p_set_no > max_set_no + 1 then raise exception 'Não é permitido saltar um set' using errcode = '22023'; end if;
  if set_exists then
    if p_expected_version is distinct from existing.version then
      raise exception 'O set mudou desde a leitura' using errcode = '40001';
    end if;
    if existing.player_a_id is distinct from p_player_a_id
       or existing.player_b_id is distinct from p_player_b_id then
      raise exception 'A ordem dos participantes do set não pode mudar' using errcode = '23514';
    end if;
    if exists (select 1 from public.match_sets later where later.game_id = p_game_id
                and later.set_no > p_set_no and later.confirmed) then
      raise exception 'Corrija primeiro os sets confirmados posteriores' using errcode = '40001';
    end if;
  elsif p_expected_version is not null then
    raise exception 'O set ainda não existe' using errcode = '40001';
  end if;
  if exists (select 1 from public.match_sets any_set where any_set.game_id = p_game_id
              and (any_set.player_a_id <> p_player_a_id or any_set.player_b_id <> p_player_b_id)) then
    raise exception 'Os participantes devem permanecer na mesma ordem em todos os sets' using errcode = '23514';
  end if;
  if exists (
    select 1 from generate_series(1, p_set_no - 1) n
     where not exists (select 1 from public.match_sets prior
                        where prior.game_id = p_game_id and prior.set_no = n and prior.confirmed)
  ) then raise exception 'Confirme os sets anteriores primeiro' using errcode = '23514'; end if;

  target_sets_to_win := (target_rules ->> 'sets_to_win')::integer;
  target_points_to_win := coalesce((target_rules ->> 'points_to_win')::integer, 0);
  target_win_by := coalesce((target_rules ->> 'win_by')::integer, 1);
  if exists (
    select 1 from public.match_sets prior
     where prior.game_id = p_game_id and prior.confirmed and prior.set_no <> p_set_no
     group by prior.winner_player_id having count(*) >= target_sets_to_win
  ) then raise exception 'A partida já foi decidida' using errcode = '23514'; end if;

  if p_confirmed then
    if target_game_type = 'sinuca' then
      if p_score_a = p_score_b then raise exception 'Sinuca exige vencedor no set confirmado' using errcode = '22023'; end if;
    elsif greatest(p_score_a, p_score_b) < target_points_to_win
       or abs(p_score_a - p_score_b) < target_win_by then
      raise exception 'Placar ainda não atingiu alvo e vantagem configurados' using errcode = '22023';
    end if;
    winner_id := case when p_score_a > p_score_b then p_player_a_id else p_player_b_id end;
  else
    winner_id := null;
  end if;

  if set_exists then
    update public.match_sets
       set score_a = p_score_a, score_b = p_score_b, confirmed = p_confirmed,
           winner_player_id = winner_id, version = existing.version + 1, updated_at = now()
     where game_id = p_game_id and set_no = p_set_no returning * into result;
  else
    insert into public.match_sets
      (game_id, set_no, player_a_id, player_b_id, score_a, score_b, confirmed, winner_player_id)
    values (p_game_id, p_set_no, p_player_a_id, p_player_b_id,
            p_score_a, p_score_b, p_confirmed, winner_id)
    returning * into result;
  end if;
  perform public.refresh_match_score(p_game_id);
  return result;
end;
$$;
revoke all on function public.save_match_set(uuid, integer, uuid, uuid, integer, integer, boolean, integer)
  from public, anon;
grant execute on function public.save_match_set(uuid, integer, uuid, uuid, integer, integer, boolean, integer)
  to authenticated;

create or replace function public.save_match_player_status(
  p_game_id uuid, p_player_id uuid, p_status text, p_expected_version integer
)
returns public.match_player_status
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_game_type text;
  target_rules jsonb;
  target_status text;
  target_sets_to_win integer;
  existing public.match_player_status%rowtype;
  result public.match_player_status%rowtype;
  participant_count integer;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if p_game_id is null or p_player_id is null or p_status is null
     or p_status not in ('DNF', 'DNS') then
    raise exception 'Status de participante inválido' using errcode = '22023';
  end if;
  select g.encounter_id, e.game_type, e.rules_config, e.status
    into target_encounter_id, target_game_type, target_rules, target_status
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id for update of e;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  if target_status <> 'active' then raise exception 'O encontro precisa estar ativo' using errcode = '42501'; end if;
  if target_game_type not in ('pebolim', 'sinuca', 'tenis_mesa', 'truco') then
    raise exception 'Status de confronto não aceito nesta modalidade' using errcode = '22023';
  end if;
  target_sets_to_win := (target_rules ->> 'sets_to_win')::integer;
  perform 1 from public.games where id = p_game_id for update;
  perform 1 from public.scores where game_id = p_game_id order by player_id for update;
  select count(*)::integer into participant_count from public.scores where game_id = p_game_id;
  if participant_count <> 2 or not exists (
    select 1 from public.scores where game_id = p_game_id and player_id = p_player_id
  ) then raise exception 'Participante ou confronto inválido' using errcode = '23514'; end if;
  if exists (
    select 1 from public.match_sets where game_id = p_game_id and confirmed
     group by winner_player_id having count(*) >= target_sets_to_win
  ) then raise exception 'A partida já foi decidida' using errcode = '23514'; end if;
  if exists (
    select 1 from public.match_player_status
     where game_id = p_game_id and player_id <> p_player_id
  ) then raise exception 'O outro participante já tem status terminal' using errcode = '23514'; end if;
  if p_status = 'DNS' and exists (
    select 1 from public.match_sets where game_id = p_game_id and confirmed
  ) then raise exception 'DNS só pode ser registrado antes do primeiro set confirmado' using errcode = '23514'; end if;

  select * into existing from public.match_player_status
   where game_id = p_game_id and player_id = p_player_id for update;
  if found then
    if p_expected_version is distinct from existing.version then
      raise exception 'O status mudou desde a leitura' using errcode = '40001';
    end if;
    update public.match_player_status set status = p_status, version = version + 1, updated_at = now()
     where game_id = p_game_id and player_id = p_player_id returning * into result;
  else
    if p_expected_version is not null then raise exception 'O status ainda não existe' using errcode = '40001'; end if;
    insert into public.match_player_status(game_id, player_id, status)
    values (p_game_id, p_player_id, p_status) returning * into result;
  end if;
  perform public.refresh_match_score(p_game_id);
  return result;
end;
$$;
revoke all on function public.save_match_player_status(uuid, uuid, text, integer) from public, anon;
grant execute on function public.save_match_player_status(uuid, uuid, text, integer) to authenticated;

create or replace function public.get_match_results(p_game_id uuid)
returns table (
  game_id uuid, player_id uuid, status text, sets_won integer,
  winner_player_id uuid, match_complete boolean
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  with game_config as (
    select e.game_type, (e.rules_config ->> 'sets_to_win')::integer as target
      from public.games g join public.encounters e on e.id = g.encounter_id
     where g.id = p_game_id and e.game_type in ('pebolim', 'sinuca', 'tenis_mesa', 'truco')
  ), wins as (
    select s.player_id,
           count(ms.winner_player_id)::integer as sets_won,
           mps.status
      from public.scores s
      cross join game_config c
      left join public.match_sets ms on ms.game_id = s.game_id
       and ms.winner_player_id = s.player_id and ms.confirmed
      left join public.match_player_status mps on mps.game_id = s.game_id and mps.player_id = s.player_id
     where s.game_id = p_game_id
     group by s.player_id, mps.status
  ), status_count as (
    select count(*)::integer as terminal_count from wins where status in ('DNF', 'DNS')
  ), outcome as (
    select case
      when sc.terminal_count = 1 then (select w2.player_id from wins w2 where w2.status is null)
      when sc.terminal_count > 1 then null::uuid
      else (select w3.player_id from wins w3 cross join game_config c where w3.sets_won >= c.target)
    end as winner_player_id,
    (sc.terminal_count = 1)
      or (sc.terminal_count = 0 and exists (
        select 1 from wins w cross join game_config c where w.sets_won >= c.target
      )) as match_complete
    from status_count sc
  )
  select p_game_id, w.player_id, coalesce(w.status, 'active'), w.sets_won,
         o.winner_player_id, o.match_complete
    from wins w cross join outcome o;
$$;
revoke all on function public.get_match_results(uuid) from public;
grant execute on function public.get_match_results(uuid) to anon, authenticated;

comment on table public.match_sets is
  'Sets confirmados por RPC; winner_player_id é sempre calculado no servidor a partir de rules_config.';
comment on function public.get_match_results(uuid) is
  'Feed público de partidas por sets; winner_player_id e match_complete são derivados no servidor.';

commit;
