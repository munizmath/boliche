const test = require('node:test');
const assert = require('node:assert/strict');
const presentations = require('../game-presentations.js');

test('catálogo distingue jogos disponíveis das modalidades ainda sem placar', () => {
  assert.deepEqual(presentations.available.map((mode) => mode.id), ['boliche', 'quiz', 'gincana']);
  assert.equal(presentations.get('pinball'), null);
  assert.equal(presentations.get('quiz').progressKind, 'rounds');
  assert.equal(presentations.get('boliche').progressKind, 'lanes');
});

test('progresso por rodada aceita zero e ignora outro encontro ou participante', () => {
  const rows = [
    { game_id: 'g', player_id: 'ana', round_no: 1, points: 0, finalized: true },
    { game_id: 'g', player_id: 'bia', round_no: 1, points: 8, finalized: false },
    { game_id: 'other', player_id: 'ana', round_no: 2, points: 9, finalized: true },
    { game_id: 'g', player_id: 'outsider', round_no: 2, points: 9, finalized: true },
  ];
  assert.deepEqual(presentations.roundProgress(rows, 'g', ['ana', 'bia'], 2), [
    { round: 1, participants: 2, informed: 2, confirmed: 1, pending: 1, percent: 50 },
    { round: 2, participants: 2, informed: 0, confirmed: 0, pending: 2, percent: 0 },
  ]);
});

test('adaptadores mantêm um contrato comum e comunicam o contexto de cada modalidade', () => {
  assert.deepEqual(presentations.adaptRankRow('quiz', {
    rank: 2, player: 'Ana', points: 18, eligible: true,
  }), {
    rank: 2,
    participant: 'Ana',
    value: 18,
    status: 'Classificado',
    labels: { rank: 'Posição no quiz', participant: 'Participante', value: 'Pontos no quiz', status: 'Resultado' },
  });
  assert.deepEqual(presentations.adaptProgress('gincana', {
    round: 3, confirmed: 4, pending: 1, percent: 80,
  }), {
    title: 'Desafios da gincana', itemLabel: 'Etapa 3', confirmed: 4, pending: 1,
    percent: 80, confirmedLabel: 'resultados confirmados', pendingLabel: 'resultados pendentes',
  });
  assert.equal(presentations.adaptEntry('quiz').action, 'Lançar pontos do quiz');
  assert.equal(presentations.adaptEntry('gincana').action, 'Lançar resultado do desafio');
  assert.notEqual(presentations.get('quiz').summary, presentations.get('gincana').summary);
  assert.equal(presentations.adaptRankRow('pinball', {}), null);
  assert.equal(presentations.adaptProgress('pinball', {}), null);
  assert.equal(presentations.adaptEntry('pinball'), null);
});
