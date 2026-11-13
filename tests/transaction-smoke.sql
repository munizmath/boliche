-- Execute no SQL Editor depois de hardening-p0.sql. Todas as escritas são revertidas.
begin;

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select id::text from auth.users where raw_app_meta_data ->> 'role' = 'admin' limit 1),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin'),
  'amr', jsonb_build_array(jsonb_build_object('method', 'password'))
)::text, true);
set local role authenticated;

do $$
declare
  target_game uuid;
  all_updates jsonb;
  before_count integer;
  audit_count integer;
  last_change bigint;
begin
  if not public.is_admin() then
    raise exception 'A sessão simulada não obteve papel de administrador';
  end if;
  select game_id into target_game from public.scores limit 1;
  if target_game is null then
    raise exception 'Sem pontuações para o teste';
  end if;
  select count(*) into before_count from public.scores;
  select jsonb_agg(jsonb_build_object('player_id', player_id, 'pontos', 0, 'finalizado', true))
    into all_updates from public.scores where game_id = target_game;
  perform public.save_game_scores(target_game, all_updates);
  if (select status from public.games where id = target_game) <> 'final' then
    raise exception 'Partida não foi finalizada junto com os pontos';
  end if;
  if (select count(*) from public.scores) <> before_count then
    raise exception 'A importação criou ou removeu vínculos';
  end if;
  select count(*) into audit_count from public.score_changes;
  perform public.save_game_scores(target_game, all_updates);
  if (select count(*) from public.score_changes) <> audit_count then
    raise exception 'Importação repetida criou histórico redundante';
  end if;
  select max(id) into last_change from public.score_changes;
  perform public.undo_score_change(last_change);
  if (select status from public.games where id = target_game) <> 'partial' then
    raise exception 'Desfazer não restaurou status parcial';
  end if;
end;
$$;

select 'passed' as transaction_smoke;
rollback;
