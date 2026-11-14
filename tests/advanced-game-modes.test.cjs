const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const Modes = require('../advanced-game-modes.js');
const ROOT = path.join(__dirname, '..');

test('configura e valida regras explícitas para as quatro modalidades de confronto', () => {
  assert.deepEqual(Modes.normalizeRules('pebolim', {
    sets_to_win: 2, points_to_win: 5, win_by: 1,
  }), { sets_to_win: 2, points_to_win: 5, win_by: 1 });
  assert.deepEqual(Modes.normalizeRules('sinuca', { sets_to_win: 3 }), { sets_to_win: 3 });
  assert.deepEqual(Modes.normalizeRules('tenis_mesa', {
    sets_to_win: 3, points_to_win: 11, win_by: 2,
  }), { sets_to_win: 3, points_to_win: 11, win_by: 2 });
  assert.deepEqual(Modes.normalizeRules('truco', {
    sets_to_win: 1, points_to_win: 12, win_by: 2,
  }), { sets_to_win: 1, points_to_win: 12, win_by: 2 });
  assert.throws(() => Modes.normalizeRules('truco', { sets_to_win: 1 }), /somente/);
  assert.throws(() => Modes.normalizeRules('pebolim', {
    sets_to_win: 1, points_to_win: 5, win_by: 1, winner: 'client',
  }), /somente/);
  assert.throws(() => Modes.normalizeRules('tenis_mesa', {
    sets_to_win: 1, points_to_win: 11, win_by: 0,
  }), /inteiro entre/);
});

test('confrontos confirmam sets somente quando a regra do servidor estaria completa', () => {
  assert.deepEqual(Modes.evaluateMatchSet('pebolim', 5, 3, {
    sets_to_win: 1, points_to_win: 5, win_by: 1,
  }), { mode: 'pebolim', complete: true, winner: 'a', score: { a: 5, b: 3 } });
  assert.equal(Modes.evaluateMatchSet('pebolim', 5, 4, {
    sets_to_win: 1, points_to_win: 5, win_by: 2,
  }).complete, false);
  assert.equal(Modes.evaluateMatchSet('sinuca', 2, 2, { sets_to_win: 1 }).complete, false);
  assert.equal(Modes.evaluateMatchSet('sinuca', 3, 2, { sets_to_win: 1 }).winner, 'a');
  assert.equal(Modes.evaluateMatchSet('tenis_mesa', 11, 10, {
    sets_to_win: 3, points_to_win: 11, win_by: 2,
  }).complete, false);
  assert.equal(Modes.evaluateMatchSet('tenis_mesa', 12, 10, {
    sets_to_win: 3, points_to_win: 11, win_by: 2,
  }).winner, 'a');
  assert.equal(Modes.evaluateMatchSet('truco', 12, 11, {
    sets_to_win: 1, points_to_win: 12, win_by: 2,
  }).complete, false);
  assert.equal(Modes.evaluateMatchSet('truco', 13, 11, {
    sets_to_win: 1, points_to_win: 12, win_by: 2,
  }).winner, 'a');
});

test('pinball preserva inteiro bigint exato e modos de menor resultado classificam ascendente', () => {
  const exact = Modes.parseExactBigInt('9007199254740993');
  assert.equal(exact, 9007199254740993n);
  assert.equal(Modes.parseExactBigInt(exact).toString(), '9007199254740993');
  assert.throws(() => Modes.parseExactBigInt(9007199254740992), /string decimal exata/);
  assert.throws(() => Modes.parseExactBigInt('9223372036854775808'), /faixa bigint/);

  assert.deepEqual(Modes.rankResults('pinball', [
    { player: 'exato', value_text: '9007199254740993', finalized: true },
    { player: 'menor', value_text: '9007199254740992', finalized: true },
    { player: 'DNF', status: 'DNF', finalized: true },
  ]).map(({ player, rank }) => [player, rank]), [
    ['exato', 1], ['menor', 2], ['DNF', null],
  ]);
  assert.deepEqual(Modes.rankResults('minigolfe', [
    { player: '8 tacadas', value_text: '8', finalized: true },
    { player: '5 tacadas', value_text: '5', finalized: true },
  ]).map(({ player, rank }) => [player, rank]), [['5 tacadas', 1], ['8 tacadas', 2]]);
  assert.deepEqual(Modes.rankResults('tempo', [
    { player: '9s', value_text: '9000', finalized: true },
    { player: '8s', value_text: '8000', finalized: true },
    { player: 'DNS', status: 'DNS', finalized: true },
  ]).map(({ player, rank }) => [player, rank]), [['8s', 1], ['9s', 2], ['DNS', null]]);
});

test('valida resultados especiais e exige DNF/DNS terminal sem valor', () => {
  assert.deepEqual(Modes.validateIndividualResult('pinball', '9007199254740993'), {
    value: '9007199254740993', status: 'active', finalized: true,
  });
  assert.deepEqual(Modes.validateIndividualResult('tempo', null, 'DNS', true), {
    value: null, status: 'DNS', finalized: true,
  });
  assert.throws(() => Modes.validateIndividualResult('minigolfe', '1.5'), /string decimal/);
  assert.throws(() => Modes.validateIndividualResult('tempo', 12, 'DNF', true), /não aceita valor/);
  assert.throws(() => Modes.validateIndividualResult('tempo', null, 'DNS', false), /precisa ser terminal/);
});

test('dardos calcula bust, dupla final e payload snake_case para o RPC', () => {
  assert.deepEqual(Modes.evaluateDartsTurn(501, [60, 20, 1]), {
    balance: 420, bust: false, won: false, dartsThrown: 3,
    throws: [
      { score: 60, isDouble: false },
      { score: 20, isDouble: false },
      { score: 1, isDouble: false },
    ],
  });
  assert.equal(Modes.evaluateDartsTurn(40, [60]).bust, true);
  assert.equal(Modes.evaluateDartsTurn(3, [2]).bust, true);
  assert.equal(Modes.evaluateDartsTurn(39, [{ score: 40, isDouble: true }]).bust, true);
  assert.equal(Modes.evaluateDartsTurn(40, [{ score: 40, isDouble: true }]).won, true);
  assert.equal(Modes.evaluateDartsTurn(50, [{ value: 25, multiplier: 2 }]).won, true);
  assert.equal(Modes.evaluateDartsTurn(501, [{ score: 20, isDouble: false }]).balance, 481);
  assert.throws(() => Modes.evaluateDartsTurn(501, [{ score: 50, isDouble: false }]), /não representa single/);
  assert.throws(() => Modes.evaluateDartsTurn(501, [{ score: 40, isDouble: false }]), /não representa single/);
  assert.throws(() => Modes.evaluateDartsTurn(501, [{ score: 22, isDouble: false }]), /não representa single/);
  assert.deepEqual(Modes.toDartsRpcThrows([{ value: 20, multiplier: 3 }]), [
    { score: 60, is_double: false },
  ]);
  assert.throws(() => Modes.evaluateDartsTurn(501, [41]), /pontuação impossível/);
  assert.throws(() => Modes.evaluateDartsTurn(40, [{ score: 40, isDouble: true }, 1]), /após bust ou checkout/);
});

test('contrato de frontend aponta RPCs, feed textual e vencedor calculado no banco', () => {
  const contract = Modes.integrationContract;
  assert.deepEqual(contract.migrations, ['v17-match-sets.sql', 'v18-special-scores.sql', 'v19-darts.sql']);
  assert.match(contract.matches.writeSet, /save_match_set/);
  assert.match(contract.matches.winner, /Never send a winner/);
  assert.match(contract.availability, /Backend-only/);
  assert.match(contract.rosters, /exactly 2 participants/);
  assert.match(contract.individual.read, /get_mode_player_scores/);
  assert.match(contract.individual.precision, /decimal strings/);
  assert.equal(contract.individual.units.tempo, 'integer elapsed milliseconds');
  assert.equal(contract.individual.exportFields.tempo, 'tempo_elapsed_ms');
  assert.match(contract.individual.rankingStatus, /not user-facing or official until app\.js consumes it/);
  assert.match(contract.darts.turn, /save_darts_turn/);
  assert.match(contract.darts.atomicFirstTurnRpc, /start_darts_leg_and_save_turn/);
  assert.match(contract.darts.start, /rolls back the new leg/);
  assert.match(contract.darts.winner, /Do not calculate or submit a winner/);
});

test('migrações são incrementais, transacionais, mantêm RLS e não alteram v14/v15', () => {
  const v17 = fs.readFileSync(path.join(ROOT, 'v17-match-sets.sql'), 'utf8');
  const v18 = fs.readFileSync(path.join(ROOT, 'v18-special-scores.sql'), 'utf8');
  const v19 = fs.readFileSync(path.join(ROOT, 'v19-darts.sql'), 'utf8');
  const editorSmoke = fs.readFileSync(path.join(__dirname, 'advanced-game-modes-smoke.sql'), 'utf8');
  assert.match(v17, /depois de v16-multigame-integrity\.sql/i);
  assert.match(v17, /create or replace function public\.assert_encounter_game_assignments/i);
  assert.match(v17, /cardinality\(requested_players\) <> 2/);
  assert.match(v17, /cardinality\(requested_players\) not between 2 and 4/);
  assert.match(v17, /no máximo um participante pode ter DNF\/DNS/i);
  assert.match(v17, /O outro participante já tem status terminal/i);
  assert.match(v17, /advanced_mode_activity/);
  assert.match(v17, /encounters_advanced_rules_immutable/);
  assert.match(v17, /after insert or update or delete on public\.match_sets/i);
  assert.match(v17, /scores_advanced_roster_guard[\s\S]{0,160}update of game_id, player_id/i);
  assert.match(v17, /scores_advanced_projection_guard[\s\S]{0,200}update of game_id, player_id, pontos, finalizado/i);
  assert.match(v17, /app\.advanced_mode_privacy_delete/);
  assert.match(v17, /match_sets_winner_player_fk[\s\S]{0,160}on delete cascade/i);
  assert.match(v17, /alter publication supabase_realtime add table public\.match_sets/i);
  assert.match(v17, /alter publication supabase_realtime add table public\.match_player_status/i);
  assert.match(v17, /pg_publication_tables[\s\S]{0,180}match_sets/i);
  for (const [name, sql] of [['v17', v17], ['v18', v18], ['v19', v19]]) {
    assert.match(sql, /^begin;$/mi, `${name} inicia transação`);
    assert.match(sql, /^commit;$/mi, `${name} termina transação`);
    assert.match(sql, /enable row level security/i, `${name} ativa RLS`);
    assert.match(sql, /revoke all on public\./i, `${name} revoga DML direto`);
  }
  assert.match(v18, /value::text/);
  assert.match(v18, /returns jsonb/i);
  assert.match(v18, /derived_game_status/);
  assert.match(v18, /from public\.match_sets m[\s\S]{0,240}confirmed/i);
  assert.match(v18, /from public\.match_player_status m/i);
  assert.match(v18, /create or replace function public\.sync_game_status/);
  assert.match(v18, /create or replace function public\.guard_game_status/);
  assert.match(v18, /tempo = milissegundos inteiros decorridos/i);
  assert.match(v18, /new_value_text text/);
  assert.match(v18, /after insert or update or delete on public\.mode_player_scores/i);
  assert.match(v18, /alter publication supabase_realtime add table public\.mode_player_scores/i);
  assert.match(v18, /pg_publication_tables[\s\S]{0,180}mode_player_scores/i);
  assert.match(v19, /Jogador fora da vez/);
  assert.match(v19, /balance_after/);
  assert.match(v19, /checkout/);
  assert.doesNotMatch(v19, /jsonb_object_length\s*\(/i);
  assert.match(v19, /winner_player_fk[\s\S]{0,180}on delete cascade/i);
  assert.match(v19, /single, tripla ou bull simples/i);
  assert.match(v19, /from public\.darts_legs l[\s\S]{0,240}status = 'complete'/i);
  assert.match(v17, /create trigger scores_advanced_projection_guard[\s\S]{0,120}before insert or update of game_id, player_id, pontos, finalizado on public\.scores/i);
  assert.match(v19, /pg_publication_tables[\s\S]{0,180}darts_turns/i);
  assert.match(v19, /after insert or update or delete on public\.darts_turns/i);
  assert.match(v19, /create or replace function public\.start_darts_leg_and_save_turn/i);
  assert.match(v19, /p_turn_no is distinct from 1/);
  for (const table of ['darts_legs', 'darts_leg_players', 'darts_turns']) {
    assert.match(v19, new RegExp(`alter publication supabase_realtime add table public\\.${table}`, 'i'));
  }
  assert.doesNotMatch(`${v17}\n${v18}\n${v19}`, /actor_id\s+uuid\s+references\s+auth\.users/i);
  assert.match(`${v17}\n${v18}`, /foreign key \(game_id, player_id\)[\s\S]{0,120}on delete cascade/i);
  assert.match(editorSmoke, /^begin;$/mi);
  assert.match(editorSmoke, /^rollback;$/mi);
  assert.match(editorSmoke, /set local role authenticated/i);
  assert.match(editorSmoke, /ROLLBACK/i);
  assert.match(editorSmoke, /"score":50,"is_double":false/);
  assert.match(editorSmoke, /"score":40,"is_double":false/);
  assert.match(editorSmoke, /UPDATE direto falsificou placar individual/);
  assert.match(editorSmoke, /delete from public\.games where id = darts_game_id/i);
  assert.match(editorSmoke, /pebolim roster deve ter exatamente dois/i);
  assert.match(editorSmoke, /Roster mudou depois do primeiro resultado/i);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'v14-game-types.sql'), 'utf8'), /pebolim/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'v15-round-scores.sql'), 'utf8'), /pebolim/);
});

function stripMigrationTransaction(sql) {
  return sql.replace(/(^|\n)begin;\s*/i, '$1').replace(/\ncommit;\s*$/i, '\n');
}

function rollbackSmokeSql(playerA, playerB, lane) {
  return `
insert into public.lanes(name) values ('${lane}');
insert into public.players(id,nome,apelido_placar,pista) values
  ('${playerA}','Smoke A','SMA','${lane}'),
  ('${playerB}','Smoke B','SMB','${lane}');
do $smoke$
declare
  p1 constant uuid := '${playerA}';
  p2 constant uuid := '${playerB}';
  e public.encounters%rowtype;
  g public.games%rowtype;
  set_result public.match_sets%rowtype;
  turn_result public.darts_turns%rowtype;
  special_result jsonb;
  exact_value text;
  caught boolean;
begin
  if not public.valid_game_rules('pebolim','{"sets_to_win":1,"points_to_win":5,"win_by":1}'::jsonb)
     or not public.valid_game_rules('sinuca','{"sets_to_win":1}'::jsonb)
     or not public.valid_game_rules('tenis_mesa','{"sets_to_win":3,"points_to_win":11,"win_by":2}'::jsonb)
     or not public.valid_game_rules('truco','{"sets_to_win":1,"points_to_win":12,"win_by":2}'::jsonb)
     or not public.valid_game_rules('pinball','{}'::jsonb)
     or not public.valid_game_rules('minigolfe','{}'::jsonb)
     or not public.valid_game_rules('tempo','{}'::jsonb)
     or not public.valid_game_rules('dardos_501','{"legs_to_win":1}'::jsonb) then
    raise exception 'Validação SQL de uma modalidade falhou';
  end if;

  e := public.create_advanced_encounter(
    'Smoke pebolim', current_date, array[p1,p2], gen_random_uuid(), 'pebolim',
    '{"sets_to_win":1,"points_to_win":5,"win_by":1}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke confronto', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','${lane}'),
    jsonb_build_object('player_id',p2,'pista','${lane}')
  ), gen_random_uuid());
  update public.scores set pista='${lane}' where game_id=g.id and player_id=p1;
  set_result := public.save_match_set(g.id,1,p1,p2,5,3,true,null);
  if set_result.winner_player_id <> p1 or not set_result.confirmed then
    raise exception 'Set não foi confirmado com vencedor derivado';
  end if;
  if not exists (select 1 from public.get_match_results(g.id) r
                  where r.player_id=p1 and r.winner_player_id=p1 and r.match_complete) then
    raise exception 'Feed do confronto não derivou vencedor';
  end if;
  caught := false;
  begin
    insert into public.match_sets(game_id,set_no,player_a_id,player_b_id,score_a,score_b)
    values (g.id,2,p1,p2,1,0);
  exception when insufficient_privilege then caught := true;
  end;
  if not caught then raise exception 'DML direto em match_sets não foi bloqueado'; end if;

  e := public.create_advanced_encounter(
    'Smoke desistência', current_date, array[p1,p2], gen_random_uuid(), 'sinuca',
    '{"sets_to_win":1}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke desistência', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','${lane}'),
    jsonb_build_object('player_id',p2,'pista','${lane}')
  ), gen_random_uuid());
  perform public.save_match_player_status(g.id,p1,'DNF',null);
  caught := false;
  begin
    perform public.save_match_player_status(g.id,p2,'DNS',null);
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'Segundo status terminal foi aceito'; end if;
  caught := false;
  begin
    perform public.save_match_set(g.id,1,p1,p2,3,0,true,null);
  exception when check_violation then caught := true;
  end;
  if not caught then raise exception 'Set foi alterado depois do status terminal'; end if;
  if (select status from public.games where id=g.id) <> 'final'
     or not exists (select 1 from public.get_match_results(g.id) r
                     where r.player_id=p2 and r.winner_player_id=p2 and r.match_complete) then
    raise exception 'Forfeit não produziu jogo final com vencedor';
  end if;

  e := public.create_advanced_encounter(
    'Smoke pinball', current_date, array[p1,p2], gen_random_uuid(), 'pinball', '{}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke precisão', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','${lane}'),
    jsonb_build_object('player_id',p2,'pista','${lane}')
  ), gen_random_uuid());
  special_result := public.save_mode_player_score(g.id,p1,'9007199254740993'::bigint,'active',true,null);
  perform public.save_mode_player_score(g.id,p2,null,'DNS',true,null);
  select r.value_text into exact_value from public.get_mode_player_scores(g.id) r where r.player_id=p1;
  if exact_value <> '9007199254740993'
     or special_result ->> 'value_text' <> '9007199254740993'
     or special_result ->> 'metric_key' <> 'pinball_points'
     or special_result ->> 'unit' <> 'points' then
    raise exception 'Bigint perdeu precisão no retorno ou feed';
  end if;
  if not exists (select 1 from public.get_mode_player_scores(g.id) r where r.player_id=p2 and r.status='DNS') then
    raise exception 'DNS individual não persistiu';
  end if;
  if (select status from public.games where id=g.id) <> 'final' then
    raise exception 'Guard de hardening não finalizou jogo especial após DNF/DNS';
  end if;

  e := public.create_advanced_encounter(
    'Smoke minigolfe', current_date, array[p1,p2], gen_random_uuid(), 'minigolfe', '{}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke tacadas', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','${lane}'),
    jsonb_build_object('player_id',p2,'pista','${lane}')
  ), gen_random_uuid());
  perform public.save_mode_player_score(g.id,p1,18,'active',true,null);
  perform public.save_mode_player_score(g.id,p2,16,'active',true,null);
  if (select value_text from public.get_mode_player_scores(g.id) where player_id=p2) <> '16' then
    raise exception 'Resultado de minigolfe não persistiu';
  end if;

  e := public.create_advanced_encounter(
    'Smoke tempo', current_date, array[p1,p2], gen_random_uuid(), 'tempo', '{}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke milissegundos', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','${lane}'),
    jsonb_build_object('player_id',p2,'pista','${lane}')
  ), gen_random_uuid());
  perform public.save_mode_player_score(g.id,p1,95000,'active',true,null);
  perform public.save_mode_player_score(g.id,p2,94000,'active',true,null);
  if (select value_text from public.get_mode_player_scores(g.id) where player_id=p2) <> '94000' then
    raise exception 'Tempo em milissegundos não persistiu';
  end if;
  if (select metric_key from public.get_mode_player_scores(g.id) where player_id=p2) <> 'tempo_elapsed_ms'
     or (select unit from public.get_mode_player_scores(g.id) where player_id=p2) <> 'milliseconds' then
    raise exception 'Tempo não informou unidade/exportação explícita';
  end if;

  e := public.create_advanced_encounter(
    'Smoke dardos', current_date, array[p1,p2], gen_random_uuid(), 'dardos_501', '{"legs_to_win":1}'::jsonb
  );
  perform public.activate_encounter(e.id);
  g := public.create_encounter_game(e.id, 'Smoke leg', jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','${lane}'),
    jsonb_build_object('player_id',p2,'pista','${lane}')
  ), gen_random_uuid());
  caught := false;
  begin
    perform public.start_darts_leg_and_save_turn(g.id,1,p1,1,p1,'[{"score":50,"is_double":false}]'::jsonb);
  exception when invalid_parameter_value then caught := true;
  end;
  if not caught or exists (select 1 from public.darts_legs where game_id=g.id) then
    raise exception 'Falha na primeira jogada deixou leg vazio iniciado';
  end if;
  turn_result := public.start_darts_leg_and_save_turn(g.id,1,p1,1,p1,
    '[{"score":60,"is_double":false},{"score":60,"is_double":false},{"score":60,"is_double":false}]'::jsonb);
  if turn_result.balance_after <> 321 or turn_result.bust then raise exception 'Saldo inicial do leg incorreto'; end if;
  turn_result := public.save_darts_turn(g.id,1,2,p2,
    '[{"score":60,"is_double":false},{"score":60,"is_double":false},{"score":60,"is_double":false}]'::jsonb);
  if turn_result.balance_after <> 321 or turn_result.bust then raise exception 'Saldo do segundo jogador incorreto'; end if;
  perform public.save_darts_turn(g.id,1,3,p1,
    '[{"score":60,"is_double":false},{"score":60,"is_double":false},{"score":60,"is_double":false}]'::jsonb);
  perform public.save_darts_turn(g.id,1,4,p2,
    '[{"score":60,"is_double":false},{"score":60,"is_double":false},{"score":60,"is_double":false}]'::jsonb);
  turn_result := public.save_darts_turn(g.id,1,5,p1,
    '[{"score":60,"is_double":false},{"score":60,"is_double":false},{"score":60,"is_double":false}]'::jsonb);
  if not turn_result.bust or turn_result.balance_after <> 141 then raise exception 'Bust não restaurou o saldo'; end if;
  perform public.set_darts_player_status(g.id,1,p1,'DNF');
  if not exists (select 1 from public.get_darts_match_results(g.id) r
                  where r.player_id=p2 and r.match_winner_player_id=p2 and r.match_complete) then
    raise exception 'Forfeit de dardos não derivou vencedor no servidor';
  end if;
end;
$smoke$;
reset role;
rollback;
do $rollback$
begin
  if exists (select 1 from public.players where id in ('${playerA}','${playerB}')) then
    raise exception 'Dados sintéticos sobreviveram ao ROLLBACK';
  end if;
  if to_regclass('public.match_sets') is not null
     or to_regclass('public.mode_player_scores') is not null
     or to_regclass('public.darts_turns') is not null
     or to_regclass('public.advanced_mode_activity') is not null then
    raise exception 'Objetos de migração sobreviveram ao ROLLBACK';
  end if;
end;
$rollback$;
`;
}

const dbUrl = process.env.BOLICHE_TEST_DATABASE_URL;
const psqlCheck = spawnSync('psql', ['--version'], { encoding: 'utf8' });
const canRunDatabaseSmoke = Boolean(dbUrl) && psqlCheck.status === 0;

test('smoke SQL aplica v17–v19 e reverte dados e DDL em transação', {
  skip: canRunDatabaseSmoke ? false : 'Configure BOLICHE_TEST_DATABASE_URL e instale psql; exige schema de teste no baseline v16.',
}, () => {
  const playerA = randomUUID();
  const playerB = randomUUID();
  const lane = `__adv_${randomUUID().slice(0, 12)}`;
  const migrations = ['v17-match-sets.sql', 'v18-special-scores.sql', 'v19-darts.sql']
    .map((file) => stripMigrationTransaction(fs.readFileSync(path.join(ROOT, file), 'utf8')))
    .join('\n');
  const sql = [
    'begin;',
    migrations,
    "select set_config('request.jwt.claims','{\"role\":\"authenticated\",\"app_metadata\":{\"role\":\"admin\"},\"amr\":[{\"method\":\"password\"}]}',true);",
    'set local role authenticated;',
    rollbackSmokeSql(playerA, playerB, lane),
  ].join('\n');
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', dbUrl], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replaceAll(dbUrl, '[database url]');
  assert.equal(result.status, 0, output);
});
