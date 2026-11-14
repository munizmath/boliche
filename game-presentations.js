(function attachGamePresentations(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GamePresentations = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createGamePresentations() {
  'use strict';

  // Adapter contract: adaptRankRow, adaptProgress and adaptEntry return the
  // labels and values needed by a mode-specific screen. Keep the legacy mode
  // fields and roundProgress shape stable for app.js consumers.
  const available = Object.freeze([
    Object.freeze({
      id: 'boliche', name: 'Boliche',
      summary: 'Partidas por pista, com frames, conferência da foto e placar ao vivo.',
      locationLabel: 'Pista', progressKind: 'lanes', roundBased: false,
      emptyHelp: 'Abra uma partida para distribuir os jogadores pelas pistas e lançar o placar.',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Pontos na partida', status: 'Situação' }),
      progress: Object.freeze({ title: 'Pistas em andamento', item: 'Pista', confirmed: 'confirmados', pending: 'pendentes' }),
      entry: Object.freeze({ action: 'Atualizar placar', title: 'Placar de boliche', value: 'Pontos', help: 'Confira os frames e confirme o total de cada jogador.' }),
    }),
    Object.freeze({
      id: 'quiz', name: 'Quiz',
      summary: 'Responda perguntas em rodadas e acompanhe os pontos de cada participante.',
      locationLabel: 'Estação', progressKind: 'rounds', roundBased: true,
      emptyHelp: 'Abra um quiz para organizar as rodadas e registrar os pontos de cada participante.',
      rankRow: Object.freeze({ rank: 'Posição no quiz', participant: 'Participante', value: 'Pontos no quiz', status: 'Resultado' }),
      progress: Object.freeze({ title: 'Rodadas do quiz', item: 'Rodada', confirmed: 'pontuações confirmadas', pending: 'pontuações pendentes' }),
      entry: Object.freeze({ action: 'Lançar pontos do quiz', title: 'Pontuação das respostas', value: 'Pontos por rodada', help: 'Registre a pontuação de cada participante nas rodadas do quiz.' }),
    }),
    Object.freeze({
      id: 'gincana', name: 'Gincana',
      summary: 'Some desafios por rodada e acompanhe resultados individuais e por equipe.',
      locationLabel: 'Estação', progressKind: 'rounds', roundBased: true,
      emptyHelp: 'Abra uma gincana para organizar os desafios e lançar pontos individuais ou por equipe.',
      rankRow: Object.freeze({ rank: 'Colocação na gincana', participant: 'Participante ou equipe', value: 'Pontos na gincana', status: 'Desempenho' }),
      progress: Object.freeze({ title: 'Desafios da gincana', item: 'Etapa', confirmed: 'resultados confirmados', pending: 'resultados pendentes' }),
      entry: Object.freeze({ action: 'Lançar resultado do desafio', title: 'Pontuação dos desafios', value: 'Pontos por desafio', help: 'Registre o resultado da etapa para participantes ou equipes.' }),
    }),
  ]);
  const ruleField = (name, min, max) => Object.freeze({ name, min, max });
  const setsRule = ruleField('sets_to_win', 1, 9);
  const pointsRule = ruleField('points_to_win', 1, 99);
  const advantageRule = ruleField('win_by', 1, 10);
  const matchEntryFields = Object.freeze(['p_game_id', 'p_set_no', 'p_player_a_id', 'p_player_b_id', 'p_score_a', 'p_score_b', 'p_confirmed', 'p_expected_version']);
  const individualEntryFields = Object.freeze(['p_game_id', 'p_player_id', 'p_value', 'p_status', 'p_finalized', 'p_expected_version']);
  const dartsEntryFields = Object.freeze(['p_game_id', 'p_leg_no', 'p_starter_player_id', 'p_turn_no', 'p_player_id', 'dart_1_value', 'dart_1_multiplier', 'dart_2_value', 'dart_2_multiplier', 'dart_3_value', 'dart_3_multiplier']);
  const matchStatusFields = Object.freeze(['p_game_id', 'p_player_id', 'p_status', 'p_expected_version']);
  const dartsStatusFields = Object.freeze(['p_game_id', 'p_leg_no', 'p_player_id', 'p_status']);
  const advancedDom = Object.freeze({
    rulesContainerId: 'advancedRulesSettings', rulesPanelPrefix: 'advanced-rules-',
    scoreDialogId: 'advancedScoreModal', scoreFormId: 'advancedScoreForm',
    entryPanelPrefix: 'advanced-entry-', saveButtonId: 'advancedScoreSaveButton',
    errorId: 'advancedScoreError', statusDialogId: 'advancedStatusModal',
    statusFormId: 'advancedStatusForm', statusPanelPrefix: 'advanced-status-',
    statusSaveButtonId: 'advancedStatusSaveButton',
  });

  // Preview descriptors are intentionally outside `available`: app.js must
  // connect reads, writes and eligibility before exposing these modes.
  const advanced = Object.freeze([
    Object.freeze({
      id: 'pebolim', name: 'Pebolim', kind: 'match', summary: 'Confrontos por sets; gols e vantagem seguem as regras do encontro.',
      locationLabel: 'Mesa', progressKind: 'sets', roundBased: false, rankMetric: 'sets_won', rankingDirection: 'desc',
      rulesFields: Object.freeze([setsRule, pointsRule, advantageRule]), entryFields: matchEntryFields, writeRpc: 'save_match_set', statusFields: matchStatusFields, statusRpc: 'save_match_player_status',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Sets vencidos', status: 'Situação' }),
      progress: Object.freeze({ title: 'Sets do confronto', item: 'Set', confirmed: 'sets confirmados', pending: 'sets pendentes' }),
      entry: Object.freeze({ action: 'Registrar set de pebolim', title: 'Gols do set', value: 'Gols', help: 'Informe os gols dos dois jogadores. Confirme o set apenas quando atingir alvo e vantagem.' }),
    }),
    Object.freeze({
      id: 'sinuca', name: 'Sinuca', kind: 'match', summary: 'Confrontos por frames, com vencedor em cada set confirmado.',
      locationLabel: 'Mesa', progressKind: 'sets', roundBased: false, rankMetric: 'sets_won', rankingDirection: 'desc',
      rulesFields: Object.freeze([setsRule]), entryFields: matchEntryFields, writeRpc: 'save_match_set', statusFields: matchStatusFields, statusRpc: 'save_match_player_status',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Sets vencidos', status: 'Situação' }),
      progress: Object.freeze({ title: 'Frames do confronto', item: 'Set', confirmed: 'sets confirmados', pending: 'sets pendentes' }),
      entry: Object.freeze({ action: 'Registrar frame de sinuca', title: 'Pontos do frame', value: 'Pontos', help: 'O set confirmado precisa ter placares diferentes para definir o vencedor.' }),
    }),
    Object.freeze({
      id: 'tenis_mesa', name: 'Tênis de mesa', kind: 'match', summary: 'Sets com alvo de pontos e vantagem configurados no encontro.',
      locationLabel: 'Mesa', progressKind: 'sets', roundBased: false, rankMetric: 'sets_won', rankingDirection: 'desc',
      rulesFields: Object.freeze([setsRule, pointsRule, advantageRule]), entryFields: matchEntryFields, writeRpc: 'save_match_set', statusFields: matchStatusFields, statusRpc: 'save_match_player_status',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Sets vencidos', status: 'Situação' }),
      progress: Object.freeze({ title: 'Sets da partida', item: 'Set', confirmed: 'sets confirmados', pending: 'sets pendentes' }),
      entry: Object.freeze({ action: 'Registrar set de tênis de mesa', title: 'Pontos do set', value: 'Pontos', help: 'Registre os pontos de cada jogador e confirme somente com a vantagem configurada.' }),
    }),
    Object.freeze({
      id: 'truco', name: 'Truco', kind: 'match', summary: 'Partidas por sets, com alvo e vantagem definidos para este encontro.',
      locationLabel: 'Mesa', progressKind: 'sets', roundBased: false, rankMetric: 'sets_won', rankingDirection: 'desc',
      rulesFields: Object.freeze([setsRule, pointsRule, advantageRule]), entryFields: matchEntryFields, writeRpc: 'save_match_set', statusFields: matchStatusFields, statusRpc: 'save_match_player_status',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Sets vencidos', status: 'Situação' }),
      progress: Object.freeze({ title: 'Sets da partida', item: 'Set', confirmed: 'sets confirmados', pending: 'sets pendentes' }),
      entry: Object.freeze({ action: 'Registrar set de truco', title: 'Pontos do set', value: 'Pontos', help: 'Defina alvo e vantagem nas regras antes de confirmar o resultado.' }),
    }),
    Object.freeze({
      id: 'pinball', name: 'Pinball', kind: 'individual', summary: 'Pontuação bruta por jogador; o maior total lidera.',
      locationLabel: 'Máquina', progressKind: 'results', roundBased: false, rankMetric: 'value_text', rankingDirection: 'desc',
      rulesFields: Object.freeze([]), entryFields: individualEntryFields, writeRpc: 'save_mode_player_score',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Pontos', status: 'Situação' }),
      progress: Object.freeze({ title: 'Resultados da partida', item: 'Jogador', confirmed: 'resultados confirmados', pending: 'resultados pendentes' }),
      entry: Object.freeze({ action: 'Registrar pontuação', title: 'Pontuação de pinball', value: 'Pontos brutos', help: 'Digite o total inteiro exato, sem separador de milhar.' }),
    }),
    Object.freeze({
      id: 'minigolfe', name: 'Minigolfe', kind: 'individual', summary: 'Número de tacadas por jogador; o menor total lidera.',
      locationLabel: 'Percurso', progressKind: 'results', roundBased: false, rankMetric: 'value_text', rankingDirection: 'asc',
      rulesFields: Object.freeze([]), entryFields: individualEntryFields, writeRpc: 'save_mode_player_score',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Tacadas', status: 'Situação' }),
      progress: Object.freeze({ title: 'Resultados da partida', item: 'Jogador', confirmed: 'resultados confirmados', pending: 'resultados pendentes' }),
      entry: Object.freeze({ action: 'Registrar tacadas', title: 'Tacadas no percurso', value: 'Tacadas', help: 'Informe o total inteiro de tacadas do jogador.' }),
    }),
    Object.freeze({
      id: 'tempo', name: 'Tempo', kind: 'individual', summary: 'Tempo decorrido em milissegundos; o menor valor lidera.',
      locationLabel: 'Percurso', progressKind: 'results', roundBased: false, rankMetric: 'value_text', rankingDirection: 'asc',
      rulesFields: Object.freeze([]), entryFields: individualEntryFields, writeRpc: 'save_mode_player_score',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Tempo (ms)', status: 'Situação' }),
      progress: Object.freeze({ title: 'Resultados da partida', item: 'Jogador', confirmed: 'resultados confirmados', pending: 'resultados pendentes' }),
      entry: Object.freeze({ action: 'Registrar tempo', title: 'Tempo decorrido', value: 'Milissegundos', help: 'Digite o tempo inteiro em milissegundos, sem separadores.' }),
    }),
    Object.freeze({
      id: 'dardos_501', name: 'Dardos 501', kind: 'darts', summary: 'Pernas de 501 pontos, com fechamento em dupla e placar por turno.',
      locationLabel: 'Alvo', progressKind: 'legs', roundBased: false, rankMetric: 'legs_won', rankingDirection: 'desc',
      rulesFields: Object.freeze([ruleField('legs_to_win', 1, 15)]), entryFields: dartsEntryFields, writeRpc: 'save_darts_turn', statusFields: dartsStatusFields, statusRpc: 'set_darts_player_status', startRpc: 'start_darts_leg',
      rankRow: Object.freeze({ rank: 'Posição', participant: 'Jogador', value: 'Legs vencidos', status: 'Situação' }),
      progress: Object.freeze({ title: 'Pernas da partida', item: 'Leg', confirmed: 'legs concluídos', pending: 'legs pendentes' }),
      entry: Object.freeze({ action: 'Registrar turno de dardos', title: 'Arremessos do turno', value: 'Pontos por dardo', help: 'Informe de um a três dardos. O fechamento exige uma dupla.' }),
    }),
  ]);
  const proposed = Object.freeze(advanced.map((mode) => mode.name));

  function get(id) {
    return available.find((mode) => mode.id === id) || null;
  }

  function getAdvanced(id) {
    return advanced.find((mode) => mode.id === id) || null;
  }

  function adaptRankRow(id, row = {}) {
    const mode = get(id) || getAdvanced(id);
    if (!mode) return null;
    return {
      rank: row.rank ?? row.position ?? null,
      participant: row.player ?? row.participant ?? row.nome ?? '',
      value: mode.rankMetric ? (row[mode.rankMetric] ?? null) : (row.total ?? row.points ?? row.pontos ?? null),
      status: row.status ?? (row.eligible === false ? 'Não elegível' : 'Classificado'),
      labels: mode.rankRow,
    };
  }

  function adaptProgress(id, item = {}) {
    const mode = get(id) || getAdvanced(id);
    if (!mode) return null;
    const labels = mode.progress;
    const number = item.round ?? item.step ?? item.index;
    const confirmed = Number(item.confirmed) || 0;
    const pending = Number(item.pending) || 0;
    const percent = Math.max(0, Math.min(100, Number(item.percent) || 0));
    return {
      title: labels.title,
      itemLabel: number == null ? labels.item : `${labels.item} ${number}`,
      confirmed,
      pending,
      percent,
      confirmedLabel: labels.confirmed,
      pendingLabel: labels.pending,
    };
  }

  function adaptEntry(id) {
    return (get(id) || getAdvanced(id))?.entry || null;
  }

  function roundProgress(roundScores, gameId, participantIds, roundCount) {
    const participants = new Set(participantIds);
    return Array.from({ length: Math.max(0, roundCount) }, (_, index) => {
      const round = index + 1;
      const rows = roundScores.filter((row) => row.game_id === gameId && Number(row.round_no) === round && participants.has(row.player_id));
      const informed = rows.filter((row) => (row.points ?? row.pontos) != null).length;
      const confirmed = rows.filter((row) => (row.points ?? row.pontos) != null && (row.finalized ?? row.finalizado) === true).length;
      return { round, participants: participants.size, informed, confirmed, pending: participants.size - confirmed, percent: participants.size ? Math.round(100 * confirmed / participants.size) : 0 };
    });
  }

  return Object.freeze({ available, proposed, advanced, advancedDom, get, getAdvanced, roundProgress, adaptRankRow, adaptProgress, adaptEntry });
});
