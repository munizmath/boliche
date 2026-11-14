(function attachGamePresentations(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GamePresentations = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createGamePresentations() {
  'use strict';

  // A presentation describes the screen, not the scoring rule. Only these
  // modes have a complete encounter, score entry and ranking flow today.
  const available = Object.freeze([
    Object.freeze({ id: 'boliche', name: 'Boliche', summary: 'Placar por partida, pistas, foto e tablet.', locationLabel: 'Pista', progressKind: 'lanes', roundBased: false, emptyHelp: 'Os participantes e as pistas ficam vinculados à partida.' }),
    Object.freeze({ id: 'quiz', name: 'Quiz', summary: 'Perguntas em rodadas com pontuação individual.', locationLabel: 'Estação', progressKind: 'rounds', roundBased: true, emptyHelp: 'Abra uma partida para registrar as rodadas do quiz.' }),
    Object.freeze({ id: 'gincana', name: 'Gincana', summary: 'Desafios em rodadas com pontuação individual e por equipe.', locationLabel: 'Estação', progressKind: 'rounds', roundBased: true, emptyHelp: 'Abra uma partida para registrar as rodadas da gincana.' }),
  ]);
  const proposed = Object.freeze(['Pebolim', 'Sinuca', 'Tênis de mesa', 'Truco', 'Pinball', 'Minigolfe', 'Tempo', 'Dardos 501']);

  function get(id) {
    return available.find((mode) => mode.id === id) || null;
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

  return Object.freeze({ available, proposed, get, roundProgress });
});
