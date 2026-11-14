-- Dardos 501: legs, ordem, saldo, bust e checkout dupla validados no servidor.
-- Aplicar depois de v18-special-scores.sql.
begin;

create table if not exists public.darts_legs (
  game_id uuid not null references public.games(id) on delete cascade,
  leg_no integer not null check (leg_no between 1 and 99),
  starter_player_id uuid not null,
  status text not null default 'active' check (status in ('active', 'complete', 'no_contest')),
  winner_player_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (game_id, leg_no),
  foreign key (game_id, starter_player_id) references public.scores(game_id, player_id) on delete cascade,
  check ((status = 'active' and winner_player_id is null and completed_at is null)
      or (status = 'complete' and winner_player_id is not null and completed_at is not null)
      or (status = 'no_contest' and winner_player_id is null and completed_at is not null))
);

-- A leg is invalid once its winning participant/game is deleted; cascade the leg
-- and its dependent turns instead of blocking the existing admin cleanup path.
alter table public.darts_legs drop constraint if exists darts_legs_game_id_winner_player_id_fkey;
alter table public.darts_legs drop constraint if exists darts_legs_winner_player_fk;
alter table public.darts_legs add constraint darts_legs_winner_player_fk
  foreign key (game_id, winner_player_id) references public.scores(game_id, player_id) on delete cascade;

create table if not exists public.darts_leg_players (
  game_id uuid not null,
  leg_no integer not null,
  player_id uuid not null,
  turn_order integer not null check (turn_order between 1 and 4),
  balance integer not null default 501 check (balance between 0 and 501),
  status text not null default 'active' check (status in ('active', 'DNF', 'DNS', 'won')),
  updated_at timestamptz not null default now(),
  primary key (game_id, leg_no, player_id),
  unique (game_id, leg_no, turn_order),
  foreign key (game_id, leg_no) references public.darts_legs(game_id, leg_no) on delete cascade,
  foreign key (game_id, player_id) references public.scores(game_id, player_id) on delete cascade
);
create index if not exists darts_leg_players_next_idx
  on public.darts_leg_players(game_id, leg_no, status, turn_order);

create table if not exists public.darts_turns (
  game_id uuid not null,
  leg_no integer not null,
  turn_no integer not null check (turn_no > 0),
  player_id uuid not null,
  throws jsonb not null check (
    case when jsonb_typeof(throws) = 'array' then jsonb_array_length(throws) between 1 and 3 else false end
  ),
  darts_thrown integer not null check (darts_thrown between 1 and 3),
  balance_before integer not null check (balance_before between 1 and 501),
  balance_after integer not null check (balance_after between 0 and 501),
  bust boolean not null,
  checkout boolean not null,
  created_at timestamptz not null default now(),
  primary key (game_id, leg_no, turn_no),
  foreign key (game_id, leg_no, player_id)
    references public.darts_leg_players(game_id, leg_no, player_id) on delete cascade,
  check (darts_thrown = jsonb_array_length(throws)),
  check (not (bust and checkout)),
  check (not bust or balance_after = balance_before),
  check (not checkout or balance_after = 0)
);
create index if not exists darts_turns_player_idx
  on public.darts_turns(game_id, leg_no, player_id, turn_no);

drop trigger if exists darts_legs_mark_activity on public.darts_legs;
create trigger darts_legs_mark_activity after insert or update or delete on public.darts_legs
  for each row execute function public.mark_multigame_ever_scored();
drop trigger if exists darts_leg_players_mark_activity on public.darts_leg_players;
create trigger darts_leg_players_mark_activity after insert or update or delete on public.darts_leg_players
  for each row execute function public.mark_multigame_ever_scored();
drop trigger if exists darts_turns_mark_activity on public.darts_turns;
create trigger darts_turns_mark_activity after insert or update or delete on public.darts_turns
  for each row execute function public.mark_multigame_ever_scored();

alter table public.darts_legs enable row level security;
alter table public.darts_leg_players enable row level security;
alter table public.darts_turns enable row level security;
drop policy if exists darts_legs_public_read on public.darts_legs;
create policy darts_legs_public_read on public.darts_legs
  for select to anon, authenticated using (true);
drop policy if exists darts_leg_players_public_read on public.darts_leg_players;
create policy darts_leg_players_public_read on public.darts_leg_players
  for select to anon, authenticated using (true);
drop policy if exists darts_turns_public_read on public.darts_turns;
create policy darts_turns_public_read on public.darts_turns
  for select to anon, authenticated using (true);
revoke all on public.darts_legs, public.darts_leg_players, public.darts_turns
  from public, anon, authenticated, service_role;
grant select on public.darts_legs, public.darts_leg_players, public.darts_turns to anon, authenticated;

-- Public live-feed state; mutations remain RPC-only under RLS and table grants.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'darts_legs') then
      alter publication supabase_realtime add table public.darts_legs;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'darts_leg_players') then
      alter publication supabase_realtime add table public.darts_leg_players;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'darts_turns') then
      alter publication supabase_realtime add table public.darts_turns;
    end if;
  end if;
end;
$$;

-- Extend v17's guarded legacy projection with server-computed darts legs.
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

  if tg_op = 'INSERT' then
    if new.pontos is not null or new.finalizado then
      raise exception 'A participação avançada começa sem pontos em scores'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if target_game_type in ('pinball', 'minigolfe', 'tempo') then
    if new.pontos is not null or new.finalizado then
      raise exception 'scores.pontos/finalizado não recebe resultado individual avançado'
        using errcode = '23514';
    end if;
    return new;
  elsif target_game_type in ('pebolim', 'sinuca', 'tenis_mesa', 'truco') then
    select count(*)::integer into participant_count from public.scores s where s.game_id = new.game_id;
    select count(*)::integer into terminal_count
      from public.match_player_status m where m.game_id = new.game_id;
    select count(*)::bigint into expected_points
      from public.match_sets m
     where m.game_id = new.game_id and m.confirmed and m.winner_player_id = new.player_id;
    select participant_count = 2 and (
      terminal_count = 1 or exists (
        select 1 from public.match_sets m
         where m.game_id = new.game_id and m.confirmed
         group by m.winner_player_id
        having count(*) >= (target_rules ->> 'sets_to_win')::integer
      )
    ) into expected_finalized;
  elsif target_game_type = 'dardos_501' then
    select count(*)::integer into participant_count from public.scores s where s.game_id = new.game_id;
    select count(*)::bigint into expected_points
      from public.darts_legs l
     where l.game_id = new.game_id and l.status = 'complete' and l.winner_player_id = new.player_id;
    select participant_count between 2 and 4 and exists (
      select 1 from public.darts_legs l
       where l.game_id = new.game_id and l.status = 'complete'
       group by l.winner_player_id
      having count(*) >= (target_rules ->> 'legs_to_win')::integer
    ) into expected_finalized;
  end if;

  if new.pontos is distinct from expected_points or new.finalizado is distinct from expected_finalized then
    raise exception 'scores diverge do resultado derivado de sets/legs confirmados'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_advanced_score_projection() from public, anon, authenticated, service_role;

-- Replace v18's conservative darts result with the confirmed-leg source.
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
    select count(*)::integer into participant_count from public.scores s where s.game_id = p_game_id;
    select participant_count between 2 and 4 and exists (
      select 1 from public.darts_legs l
       where l.game_id = p_game_id and l.status = 'complete'
       group by l.winner_player_id
      having count(*) >= (target_rules ->> 'legs_to_win')::integer
    ) into all_results_final;
    return case when all_results_final then 'final' else 'partial' end;
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
           ) into has_scores, all_results_final;
    return case when has_scores and all_results_final then 'final' else 'partial' end;
  end if;
end;
$$;
revoke all on function public.derived_game_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.derived_game_status(uuid) to anon, authenticated;

create or replace function public.refresh_darts_match_summary(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_legs_to_win integer;
  target_winner uuid;
begin
  select (e.rules_config ->> 'legs_to_win')::integer into target_legs_to_win
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id and e.game_type = 'dardos_501';
  if not found then raise exception 'Partida de dardos não encontrada' using errcode = 'P0002'; end if;

  select wins.player_id into target_winner
    from (
      select l.winner_player_id as player_id, count(*)::integer as legs_won
        from public.darts_legs l
       where l.game_id = p_game_id and l.status = 'complete'
       group by l.winner_player_id
    ) wins
   where wins.legs_won >= target_legs_to_win
   order by wins.player_id
   limit 1;

  update public.scores s
     set pontos = coalesce((
           select count(*)::bigint from public.darts_legs l
            where l.game_id = s.game_id and l.winner_player_id = s.player_id and l.status = 'complete'
         ), 0),
         finalizado = target_winner is not null
   where s.game_id = p_game_id;
  update public.games set status = case when target_winner is null then 'partial' else 'final' end
   where id = p_game_id;
end;
$$;
revoke all on function public.refresh_darts_match_summary(uuid) from public, anon, authenticated, service_role;

create or replace function public.start_darts_leg(
  p_game_id uuid, p_leg_no integer, p_starter_player_id uuid
)
returns public.darts_legs
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_status text;
  target_game_type text;
  target_legs_to_win integer;
  current_max_leg integer;
  participant_count integer;
  existing public.darts_legs%rowtype;
  result public.darts_legs%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if p_game_id is null or p_leg_no is null or p_leg_no not between 1 and 99 or p_starter_player_id is null then
    raise exception 'Leg inválido' using errcode = '22023';
  end if;
  select g.encounter_id, e.status, e.game_type,
         (e.rules_config ->> 'legs_to_win')::integer
    into target_encounter_id, target_status, target_game_type, target_legs_to_win
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id for update of e;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  if target_game_type <> 'dardos_501' then raise exception 'Partida não é dardos 501' using errcode = '22023'; end if;
  if target_status <> 'active' then raise exception 'O encontro precisa estar ativo' using errcode = '42501'; end if;
  perform 1 from public.games where id = p_game_id for update;
  perform 1 from public.scores where game_id = p_game_id order by player_id for update;
  select count(*)::integer into participant_count from public.scores where game_id = p_game_id;
  if participant_count not between 2 and 4
     or not exists (select 1 from public.scores where game_id = p_game_id and player_id = p_starter_player_id) then
    raise exception 'Dardos exige 2 a 4 participantes e starter pertencente à partida' using errcode = '23514';
  end if;
  select * into existing from public.darts_legs
   where game_id = p_game_id and leg_no = p_leg_no for update;
  if found then
    if existing.starter_player_id is distinct from p_starter_player_id then
      raise exception 'leg_no já foi usado com outro starter' using errcode = '23505';
    end if;
    return existing;
  end if;
  select coalesce(max(leg_no), 0) into current_max_leg from public.darts_legs where game_id = p_game_id;
  if p_leg_no <> current_max_leg + 1 then raise exception 'Legs devem ser iniciados em sequência' using errcode = '22023'; end if;
  if exists (select 1 from public.darts_legs where game_id = p_game_id and status = 'active') then
    raise exception 'Há um leg ativo nesta partida' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.darts_legs l
     where l.game_id = p_game_id and l.status = 'complete'
     group by l.winner_player_id having count(*) >= target_legs_to_win
  ) then raise exception 'A partida já foi decidida' using errcode = '23514'; end if;

  insert into public.darts_legs(game_id, leg_no, starter_player_id)
  values (p_game_id, p_leg_no, p_starter_player_id) returning * into result;
  insert into public.darts_leg_players(game_id, leg_no, player_id, turn_order)
  select p_game_id, p_leg_no, s.player_id,
         row_number() over (order by (s.player_id <> p_starter_player_id), s.player_id)::integer
    from public.scores s where s.game_id = p_game_id;
  return result;
end;
$$;
revoke all on function public.start_darts_leg(uuid, integer, uuid) from public, anon;
grant execute on function public.start_darts_leg(uuid, integer, uuid) to authenticated;

create or replace function public.save_darts_turn(
  p_game_id uuid,
  p_leg_no integer,
  p_turn_no integer,
  p_player_id uuid,
  p_throws jsonb
)
returns public.darts_turns
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_encounter_status text;
  target_game_type text;
  leg public.darts_legs%rowtype;
  active_player public.darts_leg_players%rowtype;
  last_turn_no integer;
  last_turn_order integer;
  next_player_id uuid;
  next_balance integer;
  working_balance integer;
  thrown_score integer;
  thrown_double boolean;
  throw_item jsonb;
  canonical_throws jsonb := '[]'::jsonb;
  throw_count integer;
  throw_index integer := 0;
  bust boolean := false;
  checkout boolean := false;
  result public.darts_turns%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if p_game_id is null or p_leg_no is null or p_turn_no is null or p_player_id is null
     or case when jsonb_typeof(p_throws) = 'array'
             then jsonb_array_length(p_throws) not between 1 and 3
             else true end then
    raise exception 'Turno inválido: informe de 1 a 3 dardos' using errcode = '22023';
  end if;

  select g.encounter_id, e.status, e.game_type
    into target_encounter_id, target_encounter_status, target_game_type
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id for update of e;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  if target_game_type <> 'dardos_501' then raise exception 'Partida não é dardos 501' using errcode = '22023'; end if;
  if target_encounter_status <> 'active' then raise exception 'O encontro precisa estar ativo' using errcode = '42501'; end if;
  perform 1 from public.games where id = p_game_id for update;
  select * into leg from public.darts_legs
   where game_id = p_game_id and leg_no = p_leg_no for update;
  if not found or leg.status <> 'active' then raise exception 'Leg ativo não encontrado' using errcode = 'P0002'; end if;
  perform 1 from public.darts_leg_players
   where game_id = p_game_id and leg_no = p_leg_no order by turn_order for update;

  select coalesce(max(t.turn_no), 0) into last_turn_no
    from public.darts_turns t where t.game_id = p_game_id and t.leg_no = p_leg_no;
  if p_turn_no <> last_turn_no + 1 then raise exception 'turn_no mudou desde a leitura' using errcode = '40001'; end if;
  if last_turn_no > 0 then
    select lp.turn_order into last_turn_order
      from public.darts_turns t join public.darts_leg_players lp
        on lp.game_id = t.game_id and lp.leg_no = t.leg_no and lp.player_id = t.player_id
     where t.game_id = p_game_id and t.leg_no = p_leg_no and t.turn_no = last_turn_no;
  else
    last_turn_order := null;
  end if;
  select lp.player_id into next_player_id
    from public.darts_leg_players lp
   where lp.game_id = p_game_id and lp.leg_no = p_leg_no and lp.status = 'active'
   order by case when last_turn_order is null then 0
                 when lp.turn_order > last_turn_order then 0 else 1 end,
            lp.turn_order
   limit 1;
  if next_player_id is null or next_player_id <> p_player_id then
    raise exception 'Jogador fora da vez' using errcode = '23514';
  end if;
  select * into active_player from public.darts_leg_players
   where game_id = p_game_id and leg_no = p_leg_no and player_id = p_player_id for update;
  next_balance := active_player.balance;
  working_balance := next_balance;
  throw_count := jsonb_array_length(p_throws);

  for throw_item in select x.value from jsonb_array_elements(p_throws) with ordinality x(value, ord) order by x.ord loop
    throw_index := throw_index + 1;
    if jsonb_typeof(throw_item) is distinct from 'object' then
      raise exception 'Dardo % inválido; use {score,is_double}', throw_index using errcode = '22023';
    end if;
    if throw_item - 'score' - 'is_double' <> '{}'::jsonb
       or not (throw_item ? 'score' and throw_item ? 'is_double') then
      raise exception 'Dardo % inválido; use {score,is_double}', throw_index using errcode = '22023';
    end if;
    if jsonb_typeof(throw_item -> 'score') is distinct from 'number'
       or (throw_item ->> 'score') !~ '^(0|[1-9][0-9]?)$'
       or jsonb_typeof(throw_item -> 'is_double') is distinct from 'boolean' then
      raise exception 'Dardo % inválido; use {score,is_double}' , throw_index using errcode = '22023';
    end if;
    thrown_score := (throw_item ->> 'score')::integer;
    thrown_double := (throw_item ->> 'is_double')::boolean;
    if thrown_double then
      if not (thrown_score = 50 or (thrown_score between 2 and 40 and mod(thrown_score, 2) = 0)) then
        raise exception 'Dardo % não representa uma dupla', throw_index using errcode = '22023';
      end if;
    elsif not (
      thrown_score = 0 or thrown_score = 25
      or thrown_score between 1 and 20
      or (thrown_score between 3 and 60 and mod(thrown_score, 3) = 0)
    ) then
      raise exception 'Dardo % não representa single, tripla ou bull simples', throw_index using errcode = '22023';
    end if;

    canonical_throws := canonical_throws || jsonb_build_array(
      jsonb_build_object('score', thrown_score, 'is_double', thrown_double)
    );
    if bust or checkout then raise exception 'Não pode haver dardos após bust ou checkout' using errcode = '22023'; end if;
    if working_balance - thrown_score < 0 or working_balance - thrown_score = 1
       or (working_balance - thrown_score = 0 and not thrown_double) then
      bust := true;
      if throw_index <> throw_count then raise exception 'Não pode haver dardos após bust' using errcode = '22023'; end if;
    else
      working_balance := working_balance - thrown_score;
      if working_balance = 0 then
        checkout := true;
        if throw_index <> throw_count then raise exception 'Não pode haver dardos após checkout' using errcode = '22023'; end if;
      end if;
    end if;
  end loop;

  if bust then working_balance := next_balance; end if;
  insert into public.darts_turns (
    game_id, leg_no, turn_no, player_id, throws, darts_thrown,
    balance_before, balance_after, bust, checkout
  ) values (
    p_game_id, p_leg_no, p_turn_no, p_player_id, canonical_throws, throw_count,
    next_balance, working_balance, bust, checkout
  ) returning * into result;

  update public.darts_leg_players
     set balance = working_balance,
         status = case when checkout then 'won' else status end,
         updated_at = now()
   where game_id = p_game_id and leg_no = p_leg_no and player_id = p_player_id;
  if checkout then
    update public.darts_legs set status = 'complete', winner_player_id = p_player_id,
      completed_at = now() where game_id = p_game_id and leg_no = p_leg_no;
    perform public.refresh_darts_match_summary(p_game_id);
  end if;
  return result;
end;
$$;
revoke all on function public.save_darts_turn(uuid, integer, integer, uuid, jsonb) from public, anon;
grant execute on function public.save_darts_turn(uuid, integer, integer, uuid, jsonb) to authenticated;

-- Atomic first-turn RPC: a bad/missing first throw cannot leave an empty leg.
-- Identical retry of an already persisted first turn returns that row.
create or replace function public.start_darts_leg_and_save_turn(
  p_game_id uuid,
  p_leg_no integer,
  p_starter_player_id uuid,
  p_turn_no integer,
  p_player_id uuid,
  p_throws jsonb
)
returns public.darts_turns
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  existing public.darts_turns%rowtype;
  existing_starter uuid;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if p_turn_no is distinct from 1 or p_player_id is distinct from p_starter_player_id then
    raise exception 'A primeira jogada precisa ser o turno 1 do starter' using errcode = '22023';
  end if;

  select * into existing from public.darts_turns
   where game_id = p_game_id and leg_no = p_leg_no and turn_no = 1;
  if found then
    select l.starter_player_id into existing_starter from public.darts_legs l
     where l.game_id = p_game_id and l.leg_no = p_leg_no;
    if existing_starter is distinct from p_starter_player_id
       or existing.player_id is distinct from p_player_id or existing.throws is distinct from p_throws then
      raise exception 'A primeira jogada já foi gravada com conteúdo diferente' using errcode = '23505';
    end if;
    return existing;
  end if;

  perform public.start_darts_leg(p_game_id, p_leg_no, p_starter_player_id);
  -- Re-read after the game lock: concurrent identical retries return the first row.
  select * into existing from public.darts_turns
   where game_id = p_game_id and leg_no = p_leg_no and turn_no = 1;
  if found then
    select l.starter_player_id into existing_starter from public.darts_legs l
     where l.game_id = p_game_id and l.leg_no = p_leg_no;
    if existing_starter is distinct from p_starter_player_id
       or existing.player_id is distinct from p_player_id or existing.throws is distinct from p_throws then
      raise exception 'A primeira jogada já foi gravada com conteúdo diferente' using errcode = '23505';
    end if;
    return existing;
  end if;
  return public.save_darts_turn(p_game_id, p_leg_no, 1, p_player_id, p_throws);
end;
$$;
revoke all on function public.start_darts_leg_and_save_turn(uuid, integer, uuid, integer, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.start_darts_leg_and_save_turn(uuid, integer, uuid, integer, uuid, jsonb)
  to authenticated;

create or replace function public.set_darts_player_status(
  p_game_id uuid, p_leg_no integer, p_player_id uuid, p_status text
)
returns public.darts_leg_players
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target_encounter_id uuid;
  target_encounter_status text;
  target_game_type text;
  leg public.darts_legs%rowtype;
  player_row public.darts_leg_players%rowtype;
  active_count integer;
  remaining_player_id uuid;
  result public.darts_leg_players%rowtype;
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário' using errcode = '42501'; end if;
  if p_game_id is null or p_leg_no is null or p_player_id is null or p_status is null
     or p_status not in ('DNF', 'DNS') then
    raise exception 'Status de dardos inválido' using errcode = '22023';
  end if;
  select g.encounter_id, e.status, e.game_type
    into target_encounter_id, target_encounter_status, target_game_type
    from public.games g join public.encounters e on e.id = g.encounter_id
   where g.id = p_game_id for update of e;
  if not found then raise exception 'Partida não encontrada' using errcode = 'P0002'; end if;
  if target_game_type <> 'dardos_501' then raise exception 'Partida não é dardos 501' using errcode = '22023'; end if;
  if target_encounter_status <> 'active' then raise exception 'O encontro precisa estar ativo' using errcode = '42501'; end if;
  perform 1 from public.games where id = p_game_id for update;
  select * into leg from public.darts_legs
   where game_id = p_game_id and leg_no = p_leg_no for update;
  if not found or leg.status <> 'active' then raise exception 'Leg ativo não encontrado' using errcode = 'P0002'; end if;
  perform 1 from public.darts_leg_players
   where game_id = p_game_id and leg_no = p_leg_no order by turn_order for update;
  select * into player_row from public.darts_leg_players
   where game_id = p_game_id and leg_no = p_leg_no and player_id = p_player_id for update;
  if not found or player_row.status <> 'active' then raise exception 'Jogador não está ativo neste leg' using errcode = '23514'; end if;
  if p_status = 'DNS' and exists (
    select 1 from public.darts_turns where game_id = p_game_id and leg_no = p_leg_no and player_id = p_player_id
  ) then raise exception 'DNS só pode ser registrado antes do primeiro turno do jogador' using errcode = '23514'; end if;

  update public.darts_leg_players set status = p_status, updated_at = now()
   where game_id = p_game_id and leg_no = p_leg_no and player_id = p_player_id
   returning * into result;
  select count(*)::integer into active_count from public.darts_leg_players
   where game_id = p_game_id and leg_no = p_leg_no and status = 'active';
  if active_count = 0 then
    update public.darts_legs set status = 'no_contest', completed_at = now()
     where game_id = p_game_id and leg_no = p_leg_no;
  elsif active_count = 1 then
    select player_id into remaining_player_id from public.darts_leg_players
     where game_id = p_game_id and leg_no = p_leg_no and status = 'active' for update;
    update public.darts_leg_players set status = 'won', updated_at = now()
     where game_id = p_game_id and leg_no = p_leg_no and player_id = remaining_player_id;
    update public.darts_legs set status = 'complete', winner_player_id = remaining_player_id,
      completed_at = now() where game_id = p_game_id and leg_no = p_leg_no;
  end if;
  if active_count <= 1 then perform public.refresh_darts_match_summary(p_game_id); end if;
  return result;
end;
$$;
revoke all on function public.set_darts_player_status(uuid, integer, uuid, text) from public, anon;
grant execute on function public.set_darts_player_status(uuid, integer, uuid, text) to authenticated;

create or replace function public.get_darts_match_results(p_game_id uuid)
returns table (
  game_id uuid,
  player_id uuid,
  legs_won integer,
  leg_no integer,
  status text,
  balance integer,
  match_winner_player_id uuid,
  match_complete boolean
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  with cfg as (
    select (e.rules_config ->> 'legs_to_win')::integer as target
      from public.games g join public.encounters e on e.id = g.encounter_id
     where g.id = p_game_id and e.game_type = 'dardos_501'
  ), wins as (
    select s.player_id, count(l.winner_player_id)::integer as legs_won
      from public.scores s cross join cfg
      left join public.darts_legs l on l.game_id = s.game_id
       and l.winner_player_id = s.player_id and l.status = 'complete'
     where s.game_id = p_game_id group by s.player_id
  ), outcome as (
    select (select w.player_id from wins w cross join cfg c where w.legs_won >= c.target limit 1) as winner,
           exists (select 1 from wins w cross join cfg c where w.legs_won >= c.target) as complete
  ), latest as (
    select max(l.leg_no) as leg_no from public.darts_legs l where l.game_id = p_game_id
  )
  select p_game_id, w.player_id, w.legs_won, latest.leg_no,
         coalesce(lp.status, 'active'), coalesce(lp.balance, 501), outcome.winner, outcome.complete
    from wins w cross join latest cross join outcome
    left join public.darts_leg_players lp on lp.game_id = p_game_id
      and lp.leg_no = latest.leg_no and lp.player_id = w.player_id
   order by w.player_id;
$$;
revoke all on function public.get_darts_match_results(uuid) from public;
grant execute on function public.get_darts_match_results(uuid) to anon, authenticated;

comment on table public.darts_turns is
  'Histórico append-only: ordem, saldo, bust e checkout são validados por save_darts_turn.';
comment on function public.get_darts_match_results(uuid) is
  'Feed público com legs ganhos e vencedor calculados a partir de legs confirmados no servidor.';

commit;
