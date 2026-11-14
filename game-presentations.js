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
  const proposed = Object.freeze(['Pebolim', 'Sinuca', 'Tênis de mesa', 'Truco', 'Pinball', 'Minigolfe', 'Tempo', 'Dardos 501']);

  function get(id) {
    return available.find((mode) => mode.id === id) || null;
  }

  function adaptRankRow(id, row = {}) {
    const mode = get(id);
    if (!mode) return null;
    return {
      rank: row.rank ?? row.position ?? null,
      participant: row.player ?? row.participant ?? row.nome ?? '',
      value: row.total ?? row.points ?? row.pontos ?? null,
      status: row.status ?? (row.eligible === false ? 'Não elegível' : 'Classificado'),
      labels: mode.rankRow,
    };
  }

  function adaptProgress(id, item = {}) {
    const mode = get(id);
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
    return get(id)?.entry || null;
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

  return Object.freeze({ available, proposed, get, roundProgress, adaptRankRow, adaptProgress, adaptEntry });
});
