-- Supabase SQL Editor smoke to run after v16 + v17 + v18 + v19 are applied.
-- Run as the project SQL owner (normally postgres), selecting the whole file.
-- Synthetic IDs only. No COMMIT is present; successful execution ends in ROLLBACK.
-- If an assertion stops the script, run ROLLBACK; in the editor before retrying.
begin;

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',
  true
);
set local role authenticated;

do $preflight$
begin
  if exists (select 1 from public.lanes where name = '__mode_smoke__')
     or exists (select 1 from public.players where id in (
       '00000000-0000-4000-8000-000000000901'::uuid,
       '00000000-0000-4000-8000-000000000902'::uuid,
       '00000000-0000-4000-8000-000000000903'::uuid
     ))
     or exists (select 1 from public.encounters where request_id in (
       '00000000-0000-4000-8000-000000000911'::uuid,
       '00000000-0000-4000-8000-000000000912'::uuid,
       '00000000-0000-4000-8000-000000000913'::uuid,
       '00000000-0000-4000-8000-000000000914'::uuid,
       '00000000-0000-4000-8000-000000000915'::uuid,
       '00000000-0000-4000-8000-000000000916'::uuid
     )) then
    raise exception 'Smoke IDs já existem; não sobrescrevendo dados';
  end if;
end;
$preflight$;

insert into public.lanes(name) values ('__mode_smoke__');
insert into public.players(id, nome, apelido_placar, pista) values
  ('00000000-0000-4000-8000-000000000901', 'Smoke A', 'SMA', '__mode_smoke__'),
  ('00000000-0000-4000-8000-000000000902', 'Smoke B', 'SMB', '__mode_smoke__'),
  ('00000000-0000-4000-8000-000000000903', 'Smoke C', 'SMC', '__mode_smoke__');

do $smoke$
declare
  p1 constant uuid := '00000000-0000-4000-8000-000000000901';
  p2 constant uuid := '00000000-0000-4000-8000-000000000902';
  p3 constant uuid := '00000000-0000-4000-8000-000000000903';
  e public.encounters%rowtype;
  g public.games%rowtype;
  set_row public.match_sets%rowtype;
  turn_row public.darts_turns%rowtype;
  result_json jsonb;
  ranked_player uuid;
  caught boolean;
begin
  caught := false;
  begin
    perform public.create_advanced_encounter(
      'Smoke darts inválido', current_date, array[p1],
      '00000000-0000-4000-8000-000000000917', 'dardos_501', '{"legs_to_win":1}'::jsonb
    );
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught then raise exception 'dardos roster deve ter pelo menos dois'; end if;

  -- Confirmed set; winner is database-derived and game status is synchronized.
  e := public.create_advanced_encounter(
    'Smoke pebolim', current_date, array[p1,p2,p3],
    '00000000-0000-4000-8000-000000000911', 'pebolim',
    '{"sets_to_win":1,"points_to_win":5,"win_by":1}'::jsonb
  );
  perform public.activate_encounter(e.id);
  if (select count(*) from public.encounter_players where encounter_id=e.id) <> 3 then
    raise exception 'Encontro de confronto não aceitou grupo com três jogadores';
  end if;
  caught := false;
  begin
    perform public.create_encounter_game(e.id, 'Smoke confronto inválido', jsonb_build_array(
      jsonb_build_object('player_id',p1,'pista','__mode_smoke__')
    ), '00000000-0000-4000-8000-000000000930');
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught then raise exception 'Partida de confronto aceitou somente um participante'; end if;
  caught := false;
  begin
    perform public.create_encounter_game(e.id, 'Smoke confronto inválido', jsonb_build_array(
      jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
      jsonb_build_object('player_id',p2,'pista','__mode_smoke__'),
      jsonb_build_object('player_id',p3,'pista','__mode_smoke__')
    ), '00000000-0000-4000-8000-000000000931');
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught then raise exception 'Partida de confronto aceitou três participantes'; end if;
  g := public.create_encounter_game(e.id, 'Smoke pebolim', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p2,'pista','__mode_smoke__')
  ), '00000000-0000-4000-8000-000000000921');
  update public.scores set pista='__mode_smoke__' where game_id=g.id and player_id=p1;
  set_row := public.save_match_set(g.id,1,p1,p2,5,3,true,null);
  if set_row.winner_player_id <> p1 or not set_row.confirmed
     or (select status from public.games where id=g.id) <> 'final'
     or not exists (select 1 from public.get_match_results(g.id) r
                     where r.winner_player_id=p1 and r.match_complete) then
    raise exception 'Confronto não confirmou set/vencedor/status final';
  end if;
  if (select multigame_ever_scored_at from public.encounters where id=e.id) is null then
    raise exception 'Marker imutável do encontro não foi gravado';
  end if;
  -- A per-game marker must not block another head-to-head game in this group.
  g := public.create_encounter_game(e.id, 'Smoke pebolim rodada 2', jsonb_build_array(
    jsonb_build_object('player_id',p2,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p3,'pista','__mode_smoke__')
  ), '00000000-0000-4000-8000-000000000933');
  if (select count(*) from public.scores where game_id=g.id) <> 2 then
    raise exception 'Segundo confronto do grupo não foi criado após resultado do primeiro';
  end if;
  set_row := public.save_match_set(g.id,1,p2,p3,5,4,true,null);
  if set_row.winner_player_id <> p2 or not set_row.confirmed
     or (select status from public.games where id=g.id) <> 'final' then
    raise exception 'Segundo confronto do grupo não aceitou pontuação após o primeiro resultado';
  end if;

  -- A single DNF wins by forfeit. A second terminal status and later set are rejected.
  e := public.create_advanced_encounter(
    'Smoke sinuca', current_date, array[p1,p2],
    '00000000-0000-4000-8000-000000000912', 'sinuca', '{"sets_to_win":1}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke sinuca', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p2,'pista','__mode_smoke__')
  ), '00000000-0000-4000-8000-000000000922');
  perform public.save_match_player_status(g.id,p1,'DNF',null);
  caught := false;
  begin
    perform public.save_match_player_status(g.id,p2,'DNS',null);
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'Segundo DNF/DNS foi aceito'; end if;
  caught := false;
  begin
    perform public.save_match_set(g.id,1,p1,p2,3,0,true,null);
  exception when check_violation then caught := true;
  end;
  if not caught or (select status from public.games where id=g.id) <> 'final'
     or not exists (select 1 from public.get_match_results(g.id) r
                     where r.winner_player_id=p2 and r.match_complete) then
    raise exception 'Forfeit não preservou vencedor único e status final';
  end if;

  -- Pinball uses exact bigint text and desc ranking in numeric space.
  e := public.create_advanced_encounter(
    'Smoke pinball', current_date, array[p1,p2],
    '00000000-0000-4000-8000-000000000913', 'pinball', '{}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke pinball', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p2,'pista','__mode_smoke__')
  ), '00000000-0000-4000-8000-000000000923');
  caught := false;
  begin
    update public.scores set pontos=1, finalizado=true
     where game_id=g.id and player_id=p1;
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'UPDATE direto falsificou placar individual'; end if;
  result_json := public.save_mode_player_score(g.id,p1,'9007199254740993'::bigint,'active',true,null);
  perform public.save_mode_player_score(g.id,p2,'9007199254740992'::bigint,'active',true,null);
  select r.player_id into ranked_player from public.get_mode_player_scores(g.id) r
   where r.status='active' and r.finalized order by r.value_text::numeric desc limit 1;
  if result_json ->> 'value_text' <> '9007199254740993'
     or result_json ->> 'metric_key' <> 'pinball_points'
     or result_json ->> 'unit' <> 'points'
     or ranked_player <> p1
     or (select status from public.games where id=g.id) <> 'final' then
    raise exception 'Pinball perdeu precisão, direção ou status final';
  end if;

  -- Minigolfe is strokes and ranks lower first.
  e := public.create_advanced_encounter(
    'Smoke minigolfe', current_date, array[p1,p2],
    '00000000-0000-4000-8000-000000000914', 'minigolfe', '{}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke minigolfe', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p2,'pista','__mode_smoke__')
  ), '00000000-0000-4000-8000-000000000924');
  perform public.save_mode_player_score(g.id,p1,18,'active',true,null);
  perform public.save_mode_player_score(g.id,p2,16,'active',true,null);
  select r.player_id into ranked_player from public.get_mode_player_scores(g.id) r
   where r.status='active' and r.finalized order by r.value_text::numeric asc limit 1;
  if ranked_player <> p2
     or (select metric_key from public.get_mode_player_scores(g.id) where player_id=p2) <> 'minigolfe_strokes'
     or (select unit from public.get_mode_player_scores(g.id) where player_id=p2) <> 'strokes'
     or (select status from public.games where id=g.id) <> 'final' then
    raise exception 'Minigolfe não preservou tacadas/direção/status';
  end if;

  -- Tempo is integer elapsed milliseconds; DNS is terminal and still closes the game.
  e := public.create_advanced_encounter(
    'Smoke tempo', current_date, array[p1,p2,p3],
    '00000000-0000-4000-8000-000000000915', 'tempo', '{}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke tempo', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p2,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p3,'pista','__mode_smoke__')
  ), '00000000-0000-4000-8000-000000000925');
  perform public.save_mode_player_score(g.id,p1,95000,'active',true,null);
  perform public.save_mode_player_score(g.id,p2,94000,'active',true,null);
  perform public.save_mode_player_score(g.id,p3,null,'DNS',true,null);
  select r.player_id into ranked_player from public.get_mode_player_scores(g.id) r
   where r.status='active' and r.finalized order by r.value_text::numeric asc limit 1;
  if ranked_player <> p2
     or (select metric_key from public.get_mode_player_scores(g.id) where player_id=p2) <> 'tempo_elapsed_ms'
     or (select unit from public.get_mode_player_scores(g.id) where player_id=p2) <> 'milliseconds'
     or not exists (select 1 from public.get_mode_player_scores(g.id) where player_id=p3 and status='DNS')
     or (select status from public.games where id=g.id) <> 'final' then
    raise exception 'Tempo não preservou ms inteiros, direção, DNS/status final';
  end if;

  -- Two-player 501 leg; server computes 501 -> 321 -> 141 -> double-out winner.
  e := public.create_advanced_encounter(
    'Smoke darts', current_date, array[p1,p2,p3],
    '00000000-0000-4000-8000-000000000916', 'dardos_501', '{"legs_to_win":1}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke darts', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
    jsonb_build_object('player_id',p2,'pista','__mode_smoke__')
  ), '00000000-0000-4000-8000-000000000926');
  caught := false;
  begin
    perform public.start_darts_leg_and_save_turn(g.id,1,p1,1,p1,'[{"score":50,"is_double":false}]'::jsonb);
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught or exists (select 1 from public.darts_legs where game_id=g.id) then
    raise exception 'Bull duplo aceito ou primeiro erro deixou leg vazio iniciado';
  end if;
  caught := false;
  begin
    perform public.start_darts_leg_and_save_turn(g.id,1,p1,1,p1,'[{"score":40,"is_double":false}]'::jsonb);
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught or exists (select 1 from public.darts_legs where game_id=g.id) then
    raise exception 'Duplo 20 aceito ou falha deixou leg vazio iniciado';
  end if;
  turn_row := public.start_darts_leg_and_save_turn(g.id,1,p1,1,p1,
    '[{"score":60,"is_double":false},{"score":60,"is_double":false},{"score":60,"is_double":false}]'::jsonb);
  caught := false;
  begin
    perform public.edit_encounter_game(g.id,'Smoke darts',jsonb_build_array(
      jsonb_build_object('player_id',p1,'pista','__mode_smoke__'),
      jsonb_build_object('player_id',p2,'pista','__mode_smoke__'),
      jsonb_build_object('player_id',p3,'pista','__mode_smoke__')
    ));
  exception when insufficient_privilege then caught := true;
  end;
  if not caught or exists (select 1 from public.scores where game_id=g.id and player_id=p3) then
    raise exception 'Roster mudou depois do primeiro resultado';
  end if;
  perform public.save_darts_turn(g.id,1,2,p2,'[{"score":0,"is_double":false}]'::jsonb);
  perform public.save_darts_turn(g.id,1,3,p1,
    '[{"score":60,"is_double":false},{"score":60,"is_double":false},{"score":60,"is_double":false}]'::jsonb);
  perform public.save_darts_turn(g.id,1,4,p2,'[{"score":0,"is_double":false}]'::jsonb);
  turn_row := public.save_darts_turn(g.id,1,5,p1,
    '[{"score":60,"is_double":false},{"score":57,"is_double":false},{"score":24,"is_double":true}]'::jsonb);
  if not turn_row.checkout or turn_row.balance_after <> 0
     or not exists (select 1 from public.get_darts_match_results(g.id) r
                     where r.player_id=p1 and r.match_winner_player_id=p1 and r.match_complete)
     or (select status from public.games where id=g.id) <> 'final' then
    raise exception 'Dardos não calculou checkout duplo/vencedor/status final';
  end if;

  -- Authenticated non-admin cannot write through mode RPCs.
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","app_metadata":{"role":"user"},"amr":[]}',
    true
  );
  caught := false;
  begin
    perform public.save_mode_player_score(g.id,p1,9007199254740993,'active',true,1);
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'RPC aceitou usuário não administrador'; end if;
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',
    true
  );
end;
$smoke$;

-- Simulate authorized cleanup as the SQL owner. Audit rows are scrubbed by FKs;
-- encounter markers remain and still prevent changing the rules.
reset role;
do $cleanup$
declare
  game_ids uuid[];
  encounter_ids uuid[];
  darts_game_id uuid;
  match_game_id uuid;
  second_match_game_id uuid;
  target_id uuid;
  caught boolean;
begin
  select array_agg(g.id order by g.id) into game_ids
    from public.games g where g.request_id in (
      '00000000-0000-4000-8000-000000000921'::uuid,
      '00000000-0000-4000-8000-000000000922'::uuid,
      '00000000-0000-4000-8000-000000000923'::uuid,
      '00000000-0000-4000-8000-000000000924'::uuid,
      '00000000-0000-4000-8000-000000000925'::uuid,
      '00000000-0000-4000-8000-000000000926'::uuid,
      '00000000-0000-4000-8000-000000000933'::uuid
    );
  select array_agg(e.id order by e.id) into encounter_ids
    from public.encounters e where e.request_id in (
      '00000000-0000-4000-8000-000000000911'::uuid,
      '00000000-0000-4000-8000-000000000912'::uuid,
      '00000000-0000-4000-8000-000000000913'::uuid,
      '00000000-0000-4000-8000-000000000914'::uuid,
      '00000000-0000-4000-8000-000000000915'::uuid,
      '00000000-0000-4000-8000-000000000916'::uuid
    );
  if cardinality(game_ids) <> 7 or cardinality(encounter_ids) <> 6 then
    raise exception 'Smoke não criou todos os jogos/encontros';
  end if;

  -- Deleting the scored darts game exercises game -> scores/legs/turns cascades.
  select g.id into darts_game_id from public.games g
   where g.request_id = '00000000-0000-4000-8000-000000000926'::uuid;
  delete from public.games where id = darts_game_id;
  if exists (select 1 from public.darts_legs where game_id = darts_game_id)
     or exists (select 1 from public.darts_turns where game_id = darts_game_id)
     or exists (select 1 from public.scores where game_id = darts_game_id) then
    raise exception 'Exclusão da partida pontuada não limpou legs/turnos/scores';
  end if;

  -- Delete the confirmed-set winner through the authorized privacy RPC.
  select g.id into match_game_id from public.games g
   where g.request_id = '00000000-0000-4000-8000-000000000921'::uuid;
  select g.id into second_match_game_id from public.games g
   where g.request_id = '00000000-0000-4000-8000-000000000933'::uuid;
  -- Delete game 1's result, then prove its per-game history still freezes roster
  -- edits while game 2 in the same encounter completed its own confirmed set.
  delete from public.match_sets where game_id = match_game_id;
  update public.scores set pontos = 0, finalizado = false where game_id = match_game_id;
  if not exists (select 1 from public.advanced_game_activity where game_id = match_game_id)
     or not exists (select 1 from public.advanced_game_activity where game_id = second_match_game_id) then
    raise exception 'Marker por partida não preservou os dois confrontos do grupo';
  end if;
  caught := false;
  begin
    perform public.edit_encounter_game(match_game_id, 'Smoke pebolim', jsonb_build_array(
      jsonb_build_object('player_id','00000000-0000-4000-8000-000000000901'::uuid,'pista','__mode_smoke__'),
      jsonb_build_object('player_id','00000000-0000-4000-8000-000000000903'::uuid,'pista','__mode_smoke__')
    ));
  exception when insufficient_privilege then caught := true;
  end;
  if not caught
     or exists (select 1 from public.scores where game_id = match_game_id and player_id = '00000000-0000-4000-8000-000000000903'::uuid)
     or not exists (select 1 from public.scores where game_id = second_match_game_id and player_id = '00000000-0000-4000-8000-000000000903'::uuid) then
    raise exception 'Roster de jogo pontuado mudou ou o segundo jogo não persistiu';
  end if;

  perform public.delete_player_cascade('00000000-0000-4000-8000-000000000901'::uuid);
  if exists (select 1 from public.players where id = '00000000-0000-4000-8000-000000000901'::uuid)
     or exists (select 1 from public.match_sets where game_id = match_game_id)
     or exists (select 1 from public.match_set_changes where game_id = match_game_id) then
    raise exception 'Exclusão do vencedor não limpou set/auditoria';
  end if;

  -- Game deletion cascades the remaining scores and scrubs their audits.
  delete from public.games where id = any(game_ids);

  if exists (select 1 from public.match_set_changes where game_id = any(game_ids))
     or exists (select 1 from public.match_player_status_changes where game_id = any(game_ids))
     or exists (select 1 from public.mode_player_score_changes where game_id = any(game_ids)) then
    raise exception 'Auditoria identificável não foi limpa com resultados/jogos';
  end if;
  if (select count(*) from public.advanced_mode_activity where encounter_id = any(encounter_ids)) <> 6
     or (select count(*) from public.encounters
          where id = any(encounter_ids) and multigame_ever_scored_at is not null) <> 6 then
    raise exception 'Marker não sobreviveu à exclusão dos dados de resultado';
  end if;
  if exists (select 1 from public.advanced_game_activity where game_id = any(game_ids)) then
    raise exception 'Marker por partida não foi removido com a exclusão da partida';
  end if;

  foreach target_id in array encounter_ids loop
    caught := false;
    begin
      update public.encounters set rules_version = rules_version + 1 where id = target_id;
    exception when insufficient_privilege then caught := true;
    end;
    if not caught then raise exception 'Regras mudaram depois de resultado e exclusão'; end if;
  end loop;
end;
$cleanup$;

rollback;
