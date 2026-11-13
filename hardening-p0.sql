-- Execute depois de schema.sql, registration.sql e admin-password-auth.sql.
-- A função de salvamento usa as permissões/RLS de quem chamou.

alter table public.profiles
  add column if not exists player_id uuid unique references public.players(id) on delete set null;

create or replace function public.guard_profile_status()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_admin() then
    if tg_op = 'INSERT' and new.status <> 'pending' then
      raise exception 'Somente o administrador pode aprovar perfis' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      raise exception 'Somente o administrador pode alterar o status do perfil' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and new.player_id is not null then
      raise exception 'Somente o administrador pode vincular jogadores' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.player_id is distinct from old.player_id then
      raise exception 'Somente o administrador pode vincular jogadores' using errcode = '42501';
    end if;
  end if;
  if new.status = 'approved' and new.player_id is null then
    if tg_op = 'INSERT' then
      raise exception 'Selecione o jogador correspondente antes de aprovar';
    elsif old.status is distinct from 'approved' then
      raise exception 'Selecione o jogador correspondente antes de aprovar';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_status on public.profiles;
create trigger guard_profile_status
  before insert or update on public.profiles
  for each row execute function public.guard_profile_status();

create or replace function public.sync_game_status()
returns trigger
language plpgsql
security invoker
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
    update public.games g
       set status = case
         when exists (select 1 from public.scores s where s.game_id = target_game)
          and not exists (
            select 1 from public.scores s
             where s.game_id = target_game and (not s.finalizado or s.pontos is null)
          ) then 'final'
         else 'partial'
       end
     where g.id = target_game;
  end loop;
  return null;
end;
$$;

drop trigger if exists scores_sync_game_status on public.scores;
create trigger scores_sync_game_status
  after insert or update or delete on public.scores
  for each row execute function public.sync_game_status();

create or replace function public.guard_game_status()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.status := case
    when exists (select 1 from public.scores s where s.game_id = new.id)
     and not exists (
       select 1 from public.scores s where s.game_id = new.id
         and (not s.finalizado or s.pontos is null)
     ) then 'final'
    else 'partial'
  end;
  return new;
end;
$$;

drop trigger if exists games_guard_status on public.games;
create trigger games_guard_status
  before insert or update on public.games
  for each row execute function public.guard_game_status();

-- Recalcula partidas já existentes sem alterar seus resultados.
update public.games set status = status;

create or replace function public.save_game_scores(p_game_id uuid, p_updates jsonb)
returns setof public.scores
language plpgsql
security invoker
set search_path = public
as $$
declare
  expected_count integer;
  updated_count integer;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  if jsonb_typeof(p_updates) is distinct from 'array'
     or jsonb_array_length(p_updates) = 0 then
    raise exception 'Informe ao menos uma pontuação';
  end if;
  expected_count := jsonb_array_length(p_updates);
  if exists (
    select 1 from jsonb_to_recordset(p_updates)
      as x(player_id uuid, pontos integer, finalizado boolean)
     where x.player_id is null or x.pontos is null
        or x.pontos not between 0 and 300 or x.finalizado is null
  ) then
    raise exception 'Pontuação inválida';
  end if;
  if (select count(distinct x.player_id)
        from jsonb_to_recordset(p_updates)
          as x(player_id uuid, pontos integer, finalizado boolean)) <> expected_count then
    raise exception 'Jogador repetido na importação';
  end if;
  if (select count(*) from public.scores s
       where s.game_id = p_game_id
         and s.player_id in (
           select x.player_id from jsonb_to_recordset(p_updates)
             as x(player_id uuid, pontos integer, finalizado boolean)
         )) <> expected_count then
    raise exception 'Jogador não vinculado à partida';
  end if;

  return query
    update public.scores s
       set pontos = x.pontos, finalizado = x.finalizado
      from jsonb_to_recordset(p_updates)
        as x(player_id uuid, pontos integer, finalizado boolean)
     where s.game_id = p_game_id and s.player_id = x.player_id
    returning s.*;
  get diagnostics updated_count = row_count;
  if updated_count <> expected_count then
    raise exception 'A atualização dos pontos não foi concluída';
  end if;
end;
$$;

revoke execute on function public.save_game_scores(uuid, jsonb) from public, anon;
grant execute on function public.save_game_scores(uuid, jsonb) to authenticated;

create table if not exists public.score_changes (
  id bigint generated always as identity primary key,
  score_id uuid not null references public.scores(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete restrict,
  previous_points integer,
  new_points integer,
  previous_finalized boolean not null,
  new_finalized boolean not null,
  changed_at timestamptz not null default now(),
  actor_id uuid
);

create index if not exists score_changes_game_time_idx on public.score_changes(game_id, changed_at desc);
alter table public.score_changes enable row level security;
drop policy if exists score_changes_admin_read on public.score_changes;
create policy score_changes_admin_read on public.score_changes
  for select to authenticated using ((select public.is_admin()));
revoke all on public.score_changes from public, anon, authenticated;
grant select on public.score_changes to authenticated;

create or replace function public.record_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pontos is distinct from old.pontos
     or new.finalizado is distinct from old.finalizado then
    insert into public.score_changes
      (score_id, game_id, player_id, previous_points, new_points,
       previous_finalized, new_finalized, actor_id)
    values
      (new.id, new.game_id, new.player_id, old.pontos, new.pontos,
       old.finalizado, new.finalizado, auth.uid());
  end if;
  return null;
end;
$$;

drop trigger if exists scores_record_change on public.scores;
create trigger scores_record_change
  after update on public.scores
  for each row execute function public.record_score_change();

create or replace function public.undo_score_change(p_change_id bigint)
returns public.scores
language plpgsql
security invoker
set search_path = public
as $$
declare
  change_row public.score_changes%rowtype;
  restored public.scores%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário' using errcode = '42501';
  end if;
  select * into change_row from public.score_changes where id = p_change_id;
  if not found then
    raise exception 'Alteração não encontrada';
  end if;
  -- Desfaz somente se ninguém alterou o mesmo resultado depois.
  if exists (select 1 from public.score_changes
              where score_id = change_row.score_id and id > change_row.id) then
    raise exception 'Há uma alteração mais recente para este resultado';
  end if;
  update public.scores
     set pontos = change_row.previous_points,
         finalizado = change_row.previous_finalized
   where id = change_row.score_id
     and pontos is not distinct from change_row.new_points
     and finalizado = change_row.new_finalized
   returning * into restored;
  if not found then
    raise exception 'O resultado mudou desde essa alteração';
  end if;
  return restored;
end;
$$;

revoke execute on function public.undo_score_change(bigint) from public, anon;
grant execute on function public.undo_score_change(bigint) to authenticated;
