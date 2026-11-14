-- Aplicar todas as migrações até v15-round-scores.sql antes do ensaio.
-- Usa somente dados sintéticos; todo o trabalho é revertido no fim.
begin;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',
  true
);
set local role authenticated;

do $$
declare
  p1 constant uuid := '00000000-0000-4000-8000-000000000411';
  p2 constant uuid := '00000000-0000-4000-8000-000000000412';
  p3 constant uuid := '00000000-0000-4000-8000-000000000413';
  p4 constant uuid := '00000000-0000-4000-8000-000000000414';
  p5 constant uuid := '00000000-0000-4000-8000-000000000415';
  quiz_request constant uuid := '00000000-0000-4000-8000-000000000421';
  quiz_game_request constant uuid := '00000000-0000-4000-8000-000000000422';
  bounded_request constant uuid := '00000000-0000-4000-8000-000000000431';
  bounded_game_request constant uuid := '00000000-0000-4000-8000-000000000432';
  unlimited_request constant uuid := '00000000-0000-4000-8000-000000000441';
  unlimited_game_request constant uuid := '00000000-0000-4000-8000-000000000442';
  unlimited_game_2_request constant uuid := '00000000-0000-4000-8000-000000000443';
  legacy public.encounters%rowtype;
  quiz public.encounters%rowtype;
  replayed public.encounters%rowtype;
  bounded public.encounters%rowtype;
  unlimited public.encounters%rowtype;
  quiz_game public.games%rowtype;
  legacy_game public.games%rowtype;
  bounded_game public.games%rowtype;
  unlimited_game public.games%rowtype;
  unlimited_game_2 public.games%rowtype;
  audit_before bigint;
  audit_after bigint;
  round_change_id bigint;
  round_audit_before bigint;
  round_audit_after bigint;
  quiz_score_id uuid;
  caught boolean;
begin
  if not public.is_admin() then raise exception 'JWT sintético não foi reconhecido como admin'; end if;

  -- Se a instalação ainda tiver o seed histórico padrão, confirme o backfill.
  if exists (
    select 1 from public.encounters
     where id = '00000000-0000-4000-8000-000000000001'
  ) and not exists (
    select 1 from public.encounters
     where id = '00000000-0000-4000-8000-000000000001'
       and game_type = 'boliche'
       and rules_version = 1
       and rules_config = '{}'::jsonb
  ) then
    raise exception 'Backfill do encontro histórico para boliche falhou';
  end if;

  insert into public.lanes(name, capacity) values ('__mg_lane__', 20);
  insert into public.players(id, nome, apelido_placar, pista) values
    (p1, 'Quiz A', 'QA', '__mg_lane__'),
    (p2, 'Quiz B', 'QB', '__mg_lane__'),
    (p3, 'Gincana A', 'GA', '__mg_lane__'),
    (p4, 'Boliche legado', 'BL', '__mg_lane__'),
    (p5, 'Gincana sem teto', 'GS', '__mg_lane__');

  -- RPC legado continua criando encontros de boliche por padrão.
  legacy := public.create_encounter(
    'Boliche legado sintético', current_date, array[p4],
    '00000000-0000-4000-8000-000000000451'
  );
  if legacy.game_type <> 'boliche' or legacy.rules_version <> 1
     or legacy.rules_config <> '{}'::jsonb then
    raise exception 'create_encounter deixou de criar boliche';
  end if;
  perform public.activate_encounter(legacy.id);
  legacy_game := public.create_encounter_game(
    legacy.id, 'Partida legada',
    jsonb_build_array(jsonb_build_object('player_id', p4, 'pista', '__mg_lane__')),
    '00000000-0000-4000-8000-000000000452'
  );

  quiz := public.create_multigame_encounter(
    p_name => 'Quiz sintético', p_date => current_date,
    p_player_ids => array[p1, p2, p3], p_request_id => quiz_request,
    p_game_type => 'quiz',
    p_rules_config => '{"round_count":2,"max_points_per_round":0}'::jsonb
  );
  if quiz.game_type <> 'quiz' or quiz.rules_config ->> 'round_count' <> '2'
     or quiz.rules_config ->> 'max_points_per_round' <> '0' then
    raise exception 'Configuração do quiz não foi persistida';
  end if;
  replayed := public.create_multigame_encounter(
    p_name => 'Quiz sintético', p_date => current_date,
    p_player_ids => array[p1, p2, p3], p_request_id => quiz_request,
    p_game_type => 'quiz',
    p_rules_config => '{"round_count":2,"max_points_per_round":0}'::jsonb
  );
  if replayed.id <> quiz.id then
    raise exception 'Repetição do request_id criou outro encontro';
  end if;

  caught := false;
  begin
    perform public.create_encounter(
      'Colisão legada com quiz', current_date, array[p1], quiz_request
    );
  exception when unique_violation then caught := true;
  end;
  if not caught then
    raise exception 'create_encounter legado reutilizou request_id de modalidade nova';
  end if;

  caught := false;
  begin
    perform public.create_multigame_encounter(
      p_name => 'Outro conteúdo', p_date => current_date,
      p_player_ids => array[p1, p2, p3], p_request_id => quiz_request,
      p_game_type => 'quiz',
      p_rules_config => '{"round_count":2,"max_points_per_round":0}'::jsonb
    );
  exception when unique_violation then caught := true;
  end;
  if not caught then raise exception 'request_id reutilizado com outro conteúdo foi aceito'; end if;

  caught := false;
  begin
    perform public.create_multigame_encounter(
      p_name => 'Config inválida', p_date => current_date,
      p_player_ids => array[p1],
      p_request_id => '00000000-0000-4000-8000-000000000453',
      p_game_type => 'quiz',
      p_rules_config => '{"round_count":0,"max_points_per_round":10}'::jsonb
    );
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught then raise exception 'round_count zero foi aceito'; end if;

  quiz_game := public.create_encounter_game(
    quiz.id, 'Quiz de duas rodadas',
    jsonb_build_array(
      jsonb_build_object('player_id', p1, 'pista', '__mg_lane__'),
      jsonb_build_object('player_id', p2, 'pista', '__mg_lane__')
    ), quiz_game_request
  );
  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
      p_points => 301, p_finalized => true
    );
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'Encontro em preparação aceitou rodada'; end if;
  perform public.activate_encounter(quiz.id);

  -- Zero significa sem teto. 301 é válido no quiz e a conclusão espera todas as rodadas.
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
    p_points => 301, p_finalized => true
  );
  if not exists (
    select 1 from public.scores
     where game_id = quiz_game.id and player_id = p1
       and pontos = 301 and not finalizado
  ) then raise exception '301 no quiz não foi aceito ou finalizou cedo'; end if;
  select count(*) into audit_before from public.score_changes
   where game_id = quiz_game.id and player_id = p1;
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
    p_points => 301, p_finalized => true
  );
  select count(*) into audit_after from public.score_changes
   where game_id = quiz_game.id and player_id = p1;
  if audit_after <> audit_before then raise exception 'Repetição idempotente criou auditoria'; end if;
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 2,
    p_points => 0, p_finalized => true
  );
  if not exists (
    select 1 from public.scores
     where game_id = quiz_game.id and player_id = p1
       and pontos = 301 and finalizado
  ) then raise exception 'Soma ou conclusão de duas rodadas falhou'; end if;

  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p2, p_round_no => 1,
    p_points => 20, p_finalized => true
  );
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p2, p_round_no => 2,
    p_points => 30, p_finalized => true
  );
  if not exists (select 1 from public.games where id = quiz_game.id and status = 'final') then
    raise exception 'Status da partida não acompanhou a conclusão de todos';
  end if;

  -- Regravação substitui a rodada e não soma o valor anterior outra vez.
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
    p_points => 250, p_finalized => true
  );
  if not exists (
    select 1 from public.scores
     where game_id = quiz_game.id and player_id = p1
       and pontos = 250 and finalizado
  ) then raise exception 'Substituição da rodada somou duas vezes'; end if;

  select count(*) into round_audit_before from public.round_score_changes
   where game_id = quiz_game.id and player_id = p1 and round_no = 1;
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
    p_points => 250, p_finalized => true
  );
  select count(*) into round_audit_after from public.round_score_changes
   where game_id = quiz_game.id and player_id = p1 and round_no = 1;
  if round_audit_after <> round_audit_before then
    raise exception 'Repetição idempotente criou auditoria por rodada';
  end if;
  if not exists (
    select 1 from public.round_score_changes c
     where c.game_id = quiz_game.id and c.player_id = p1 and c.round_no = 1
       and c.previous_points = 301 and c.new_points = 250
       and c.previous_finalized and c.new_finalized
       and c.actor_id = auth.uid()
  ) then raise exception 'Auditoria anterior/novo/ator da rodada não foi registrada'; end if;

  select max(id) into round_change_id from public.round_score_changes
   where game_id = quiz_game.id and player_id = p1 and round_no = 1;
  perform public.undo_round_score_change(round_change_id);
  if not exists (
    select 1 from public.scores
     where game_id = quiz_game.id and player_id = p1 and pontos = 301 and finalizado
  ) then raise exception 'Desfazer alteração da rodada não restaurou o total'; end if;

  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
    p_points => 250, p_finalized => true
  );
  perform public.clear_round_score(quiz_game.id, p1, 2);
  if not exists (
    select 1 from public.scores
     where game_id = quiz_game.id and player_id = p1 and pontos = 250 and not finalizado
  ) then raise exception 'Limpeza de rodada não recalculou o resultado'; end if;
  select max(id) into round_change_id from public.round_score_changes
   where game_id = quiz_game.id and player_id = p1 and round_no = 2;
  if not exists (
    select 1 from public.round_score_changes c
     where c.id = round_change_id and c.previous_points = 0
       and c.new_points is null and c.previous_finalized and c.actor_id = auth.uid()
  ) then raise exception 'Limpeza não foi auditada'; end if;
  perform public.undo_round_score_change(round_change_id);
  if not exists (
    select 1 from public.scores
     where game_id = quiz_game.id and player_id = p1 and pontos = 250 and finalizado
  ) then raise exception 'Desfazer limpeza não restaurou a rodada'; end if;

  -- Regressão do UPSERT legado: renomear mantém linhas existentes e apenas
  -- acrescenta a participante nova, sem tentar INSERT conflitante em scores.
  perform public.edit_encounter_game(
    quiz_game.id, 'Quiz renomeado',
    jsonb_build_array(
      jsonb_build_object('player_id', p1, 'pista', '__mg_lane__'),
      jsonb_build_object('player_id', p2, 'pista', '__mg_lane__'),
      jsonb_build_object('player_id', p3, 'pista', '__mg_lane__')
    )
  );
  if not exists (
    select 1 from public.scores s
     where s.game_id = quiz_game.id and s.player_id = p1 and s.pontos = 250 and s.finalizado
  ) or (select count(*) from public.round_scores rs
         where rs.game_id = quiz_game.id and rs.player_id = p1) <> 2
     or not exists (
       select 1 from public.scores s
        where s.game_id = quiz_game.id and s.player_id = p3
          and s.pontos is null and not s.finalizado
     ) then
    raise exception 'edit_encounter_game não preservou resultados ou não inseriu apenas faltantes';
  end if;

  caught := false;
  begin
    update public.scores set pontos = 301, finalizado = false
     where game_id = quiz_game.id and player_id = p1;
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'UPDATE direto desalinhou scores e round_scores'; end if;

  caught := false;
  begin
    insert into public.scores(game_id, player_id, pista, pontos, finalizado)
    values (quiz_game.id, p3, '__mg_lane__', 301, false);
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'INSERT direto desalinhou scores e round_scores'; end if;

  caught := false;
  begin
    update public.round_scores set points = 999
     where game_id = quiz_game.id and player_id = p1 and round_no = 1;
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'DML direto em round_scores foi permitido'; end if;

  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => quiz_game.id, p_player_id => p4, p_round_no => 1,
      p_points => 10, p_finalized => true
    );
  exception when foreign_key_violation then caught := true;
  end;
  if not caught then raise exception 'Participante sem score na partida foi aceito'; end if;

  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 3,
      p_points => 10, p_finalized => true
    );
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught then raise exception 'Rodada acima da configuração foi aceita'; end if;

  caught := false;
  begin
    update public.encounters
       set rules_config = '{"round_count":3,"max_points_per_round":0}'::jsonb
     where id = quiz.id;
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'Regra mudou após o primeiro resultado'; end if;

  caught := false;
  begin
    update public.encounters set game_type = 'gincana' where id = quiz.id;
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'Modalidade mudou após o primeiro resultado'; end if;

  caught := false;
  begin
    perform public.edit_game(quiz_game.id, 'Chamada legada de edição', array[p1, p2, p3]);
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'edit_game legado aceitou quiz'; end if;

  select id into quiz_score_id from public.scores
   where game_id = quiz_game.id and player_id = p1;
  caught := false;
  begin
    insert into public.score_details(score_id, game_id, player_id, throws, pin_masks)
    values (quiz_score_id, quiz_game.id, p2, '[]'::jsonb, '[]'::jsonb);
  exception when foreign_key_violation then caught := true;
  end;
  if not caught then raise exception 'score_details aceitou vínculo score_id/game_id/player_id divergente'; end if;

  -- RPCs legadas não podem limpar, desfazer ou substituir o total derivado.
  caught := false;
  begin
    perform public.save_game_scores(
      quiz_game.id,
      jsonb_build_array(jsonb_build_object('player_id', p1, 'pontos', 300, 'finalizado', false))
    );
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'save_game_scores alterou total de quiz sem rodadas'; end if;

  caught := false;
  begin
    perform public.clear_game_score(quiz_game.id, p1);
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'clear_game_score limpou resultado de quiz'; end if;

  select max(id) into audit_before from public.score_changes
   where game_id = quiz_game.id and player_id = p1;
  caught := false;
  begin
    perform public.undo_score_change(audit_before);
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'undo_score_change desfez total sem desfazer rodadas'; end if;

  -- Mesmo com total coincidente, save_throw_score não pode criar score_details em quiz.
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
    p_points => 10, p_finalized => false
  );
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 2,
    p_points => 0, p_finalized => false
  );
  caught := false;
  begin
    perform public.save_throw_score(
      quiz_game.id, p1, '[10]'::jsonb, '[]'::jsonb, false, 'Teste modalidade'
    );
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'save_throw_score criou detalhes de boliche no quiz'; end if;
  if exists (select 1 from public.score_details where game_id = quiz_game.id)
     or exists (select 1 from public.throw_changes where game_id = quiz_game.id) then
    raise exception 'RPC de boliche deixou detalhes ou auditoria em quiz';
  end if;

  -- max_points_per_round positivo é um teto efetivo.
  bounded := public.create_multigame_encounter(
    p_name => 'Gincana limitada', p_date => current_date,
    p_player_ids => array[p3],
    p_request_id => bounded_request, p_game_type => 'gincana',
    p_rules_config => '{"round_count":1,"max_points_per_round":1000}'::jsonb
  );
  perform public.activate_encounter(bounded.id);
  bounded_game := public.create_encounter_game(
    bounded.id, 'Gincana limitada',
    jsonb_build_array(jsonb_build_object('player_id', p3, 'pista', '__mg_lane__')),
    bounded_game_request
  );
  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => bounded_game.id, p_player_id => p3, p_round_no => 1,
      p_points => 1001, p_finalized => true
    );
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught then raise exception 'Teto positivo por rodada foi ignorado'; end if;
  perform public.save_round_score(
    p_game_id => bounded_game.id, p_player_id => p3, p_round_no => 1,
    p_points => 1000, p_finalized => true
  );
  if not exists (select 1 from public.scores where game_id = bounded_game.id and pontos = 1000 and finalizado) then
    raise exception 'Limite inclusivo de pontos por rodada falhou';
  end if;

  perform public.set_encounter_closed(bounded.id, true);
  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => bounded_game.id, p_player_id => p3, p_round_no => 1,
      p_points => 500, p_finalized => true
    );
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'Encontro fechado aceitou gravação de rodada'; end if;
  perform public.set_encounter_closed(bounded.id, false);

  -- Exclusão por RPC mantém a cascata e o histórico sem bloquear a operação.
  perform public.delete_encounter_game(bounded_game.id);
  if exists (select 1 from public.round_scores where game_id = bounded_game.id)
     or not exists (select 1 from public.round_score_changes where game_id = bounded_game.id) then
    raise exception 'Cascade da partida bloqueou ou apagou o histórico de rodadas';
  end if;
  perform public.delete_encounter(bounded.id);
  if exists (select 1 from public.encounters where id = bounded.id) then
    raise exception 'Exclusão do encontro falhou após remover a partida';
  end if;

  -- Sem teto configurado, uma rodada aceita o maior inteiro seguro no JS.
  unlimited := public.create_multigame_encounter(
    p_name => 'Gincana sem teto', p_date => current_date,
    p_player_ids => array[p5],
    p_request_id => unlimited_request, p_game_type => 'gincana',
    p_rules_config => '{"round_count":1,"max_points_per_round":0}'::jsonb
  );
  perform public.activate_encounter(unlimited.id);
  unlimited_game := public.create_encounter_game(
    unlimited.id, 'Gincana sem teto',
    jsonb_build_array(jsonb_build_object('player_id', p5, 'pista', '__mg_lane__')),
    unlimited_game_request
  );
  perform public.save_round_score(
    p_game_id => unlimited_game.id, p_player_id => p5, p_round_no => 1,
    p_points => 9007199254740991, p_finalized => true
  );
  if not exists (
    select 1 from public.scores
     where game_id = unlimited_game.id and player_id = p5
       and pontos = 9007199254740991 and finalizado
  ) then raise exception 'Pontos sem teto ou limite bigint falhou'; end if;

  unlimited_game_2 := public.create_encounter_game(
    unlimited.id, 'Segunda partida sem teto',
    jsonb_build_array(jsonb_build_object('player_id', p5, 'pista', '__mg_lane__')),
    unlimited_game_2_request
  );
  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => unlimited_game_2.id, p_player_id => p5, p_round_no => 1,
      p_points => 1, p_finalized => true
    );
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'Soma de várias partidas excedeu o inteiro seguro'; end if;
  if exists (select 1 from public.round_scores where game_id = unlimited_game_2.id) then
    raise exception 'Falha de limite deixou rodada parcial gravada';
  end if;

  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => unlimited_game.id, p_player_id => p5, p_round_no => 1,
      p_points => 9007199254740992, p_finalized => true
    );
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught then raise exception 'RPC aceitou valor fora do inteiro seguro do JS'; end if;

  -- Boliche continua limitado a 300 tanto na escrita direta quanto na RPC antiga.
  caught := false;
  begin
    update public.scores set pontos = 301, finalizado = true
     where game_id = legacy_game.id and player_id = p4;
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'Banco aceitou 301 no boliche por UPDATE direto'; end if;

  caught := false;
  begin
    perform public.save_game_scores(
      legacy_game.id,
      jsonb_build_array(jsonb_build_object('player_id', p4, 'pontos', 301, 'finalizado', true))
    );
  exception when raise_exception then caught := true;
  end;
  if not caught then raise exception 'RPC legada aceitou 301 no boliche'; end if;
  perform public.edit_game(legacy_game.id, 'Boliche editado', array[p4]);
  if not exists (select 1 from public.games where id = legacy_game.id and nome = 'Boliche editado') then
    raise exception 'edit_game legado deixou de funcionar no boliche';
  end if;

  -- Usuário autenticado comum não pode publicar resultados.
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000098","role":"authenticated","app_metadata":{"role":"player"},"amr":[{"method":"password"}]}',
    true
  );
  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
      p_points => 20, p_finalized => true
    );
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'Usuário comum salvou rodada'; end if;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',
    true
  );

  -- Finaliza as rodadas para provar que encontro encerrado rejeita nova escrita.
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
    p_points => 10, p_finalized => true
  );
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 2,
    p_points => 0, p_finalized => true
  );
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p3, p_round_no => 1,
    p_points => 5, p_finalized => true
  );
  perform public.save_round_score(
    p_game_id => quiz_game.id, p_player_id => p3, p_round_no => 2,
    p_points => 6, p_finalized => true
  );
  perform public.set_encounter_closed(quiz.id, true);
  caught := false;
  begin
    perform public.save_round_score(
      p_game_id => quiz_game.id, p_player_id => p1, p_round_no => 1,
      p_points => 11, p_finalized => true
    );
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'Encontro fechado aceitou nova rodada'; end if;
end;
$$;

-- Visitantes leem rodadas; a RPC de escrita não está disponível para anon.
set local role anon;
select count(*) from public.round_scores;
do $$
declare caught boolean := false;
begin
  begin
    perform public.save_round_score(
      p_game_id => '00000000-0000-4000-8000-000000000422',
      p_player_id => '00000000-0000-4000-8000-000000000411',
      p_round_no => 1, p_points => 1, p_finalized => true
    );
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'anon executou save_round_score'; end if;
end;
$$;
reset role;

select 'multigame_smoke_passed' as resultado;
rollback;
