-- Aplicar depois de v19-darts.sql. Corrige a ordem dos gatilhos de exclusão:
-- o CASCADE de scores pode apagar round_scores depois do scrub da partida.
begin;

-- A FK de encontros apaga encounter_players por CASCADE. O gatilho antigo
-- exige remoção prévia da equipe, impedindo a exclusão do encontro inteiro.
create or replace function public.guard_roster_competition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;
  if exists (
    select 1 from public.team_players tp
      join public.teams t on t.id = tp.team_id
     where t.encounter_id = old.encounter_id and tp.player_id = old.player_id
  ) or exists (
    select 1 from public.brackets b
     where b.encounter_id = old.encounter_id and old.player_id = any(b.seeds)
  ) then
    raise exception 'Remova o jogador da equipe ou da chave antes de tirá-lo do encontro';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_roster_competition()
  from public, anon, authenticated, service_role;

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
    -- Uma limpeza de rodada mantém a participação em scores; um CASCADE
    -- disparado pela exclusão da participação já não encontra essa linha.
    if not exists (
      select 1 from public.scores s
       where s.game_id = old.game_id and s.player_id = old.player_id
    ) then
      return null;
    end if;
    insert into public.round_score_changes
      (game_id, player_id, round_no, previous_points, previous_finalized, actor_id)
    values
      (old.game_id, old.player_id, old.round_no, old.points, old.finalized, auth.uid());
  end if;
  return null;
end;
$$;
revoke all on function public.record_round_score_change()
  from public, anon, authenticated, service_role;

create or replace function public.scrub_round_audit_after_score_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.round_score_changes c
   where c.game_id = old.game_id and c.player_id = old.player_id;
  return null;
end;
$$;
drop trigger if exists zz_round_audit_scrub_after_score_delete on public.scores;
create trigger zz_round_audit_scrub_after_score_delete
  after delete on public.scores
  for each row execute function public.scrub_round_audit_after_score_delete();
revoke all on function public.scrub_round_audit_after_score_delete()
  from public, anon, authenticated, service_role;

commit;
