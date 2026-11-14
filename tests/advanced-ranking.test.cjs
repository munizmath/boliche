'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateOfficial } = require('../advanced-ranking.js');

const games = (...ids) => ids.map((id) => ({ id, status: 'final' }));
const feeds = (entries) => new Map(entries.map(([id, rows]) => [id, { rows }]));
const matchRows = (gameId, winner, participants) => participants.map(([player_id, status = 'active']) => ({
  game_id: gameId, player_id, status, winner_player_id: winner, match_complete: true,
}));
const dartsRows = (gameId, winner, participants) => participants.map(([player_id, status = 'active']) => ({
  game_id: gameId, player_id, status, match_winner_player_id: winner, match_complete: true,
}));
const result = (gameId, player_id, value_text, status = 'active', finalized = true) => ({
  game_id: gameId, player_id, value_text, status, finalized,
});

test('all four match modes count one win per final game, share ties and skip DNS', () => {
  const byGame = feeds([
    ['g1', matchRows('g1', 'p1', [['p1'], ['p2', 'DNF']])],
    ['g2', matchRows('g2', 'p2', [['p1'], ['p2']])],
    ['g3', matchRows('g3', 'p4', [['p3', 'DNS'], ['p4']])],
  ]);
  for (const mode of ['pebolim', 'sinuca', 'tenis_mesa', 'truco']) {
    const total = aggregateOfficial(mode, games('g1', 'g2', 'g3'), byGame, 'total');
    assert.deepEqual(total.missingGameIds, []);
    assert.deepEqual(total.rows.map(({ player_id, rank, displayValue, games_count }) =>
      [player_id, rank, displayValue, games_count]), [
      ['p1', 1, '1', 2], ['p2', 1, '1', 2], ['p4', 1, '1', 1],
    ]);
    assert.equal(total.rows[0].unitLabel, 'vitórias');
    const average = aggregateOfficial(mode, games('g1', 'g2', 'g3'), byGame, 'average');
    assert.deepEqual(average.rows.map(({ player_id, rank, displayValue }) => [player_id, rank, displayValue]), [
      ['p4', 1, '1'], ['p1', 2, '0.5'], ['p2', 2, '0.5'],
    ]);
    const played = aggregateOfficial(mode, games('g1', 'g2', 'g3'), byGame, 'games');
    assert.deepEqual(played.rows.map(({ player_id, rank, displayValue }) => [player_id, rank, displayValue]), [
      ['p1', 1, '2'], ['p2', 1, '2'], ['p4', 3, '1'],
    ]);
  }
});

test('darts counts match winners instead of legs and keeps DNF as zero-win play', () => {
  const byGame = feeds([
    ['d1', dartsRows('d1', 'p1', [['p1', 'won'], ['p2', 'DNF'], ['p3', 'DNS']])],
    ['d2', dartsRows('d2', 'p1', [['p1', 'won'], ['p2', 'active'], ['p3', 'active']])],
  ]);
  const total = aggregateOfficial('dardos_501', games('d1', 'd2'), byGame, 'total');
  assert.deepEqual(total.rows.map(({ player_id, displayValue, games_count }) => [player_id, displayValue, games_count]), [
    ['p1', '2', 2], ['p2', '0', 2], ['p3', '0', 1],
  ]);
  const best = aggregateOfficial('dardos_501', games('d1', 'd2'), byGame, 'best');
  assert.deepEqual(best.rows.map(({ player_id, rank, displayValue }) => [player_id, rank, displayValue]), [
    ['p1', 1, '1'], ['p2', 2, '0'], ['p3', 2, '0'],
  ]);
});

test('pinball aggregates signed-bigint-sized text without Number precision loss', () => {
  const byGame = feeds([
    ['p1', [result('p1', 'ana', '9007199254740993'), result('p1', 'bia', '9007199254740994')]],
    ['p2', [result('p2', 'ana', '9007199254740995'), result('p2', 'bia', null, 'DNF')]],
  ]);
  const total = aggregateOfficial('pinball', games('p1', 'p2'), byGame, 'total');
  assert.deepEqual(total.rows.map(({ player_id, rank, displayValue, games_count, results_count }) =>
    [player_id, rank, displayValue, games_count, results_count]), [
    ['ana', 1, '18014398509481988', 2, 2], ['bia', 2, '9007199254740994', 2, 1],
  ]);
  const average = aggregateOfficial('pinball', games('p1', 'p2'), byGame, 'average');
  assert.deepEqual(average.rows.map(({ player_id, displayValue }) => [player_id, displayValue]), [
    ['ana', '9007199254740994'], ['bia', '9007199254740994'],
  ]);
  assert.deepEqual(average.rows.map((row) => row.rank), [1, 1]);
  assert.equal(average.rows[0].unitLabel, 'pontos/resultado');
  const best = aggregateOfficial('pinball', games('p1', 'p2'), byGame, 'best');
  assert.equal(best.rows[0].displayValue, '9007199254740995');
});

test('minigolfe compares average fractions by BigInt and ranks lower values first', () => {
  const byGame = feeds([
    ['g1', [result('g1', 'a', '9007199254740993'), result('g1', 'b', '9007199254740993')]],
    ['g2', [result('g2', 'a', '9007199254740994'), result('g2', 'b', null, 'DNF')]],
  ]);
  const average = aggregateOfficial('minigolfe', games('g1', 'g2'), byGame, 'average');
  assert.deepEqual(average.rows.map(({ player_id, rank, displayValue, games_count, results_count }) =>
    [player_id, rank, displayValue, games_count, results_count]), [
    ['b', 1, '9007199254740993', 2, 1], ['a', 2, '9007199254740993.5', 2, 2],
  ]);
  const best = aggregateOfficial('minigolfe', games('g1', 'g2'), byGame, 'best');
  assert.deepEqual(best.rows.map((row) => row.rank), [1, 1]);
});

test('tempo shows repeating average as exact fraction and sorts ascending', () => {
  const byGame = feeds([
    ['t1', [result('t1', 'a', '1'), result('t1', 'b', '2')]],
    ['t2', [result('t2', 'a', '2'), result('t2', 'b', null, 'DNS')]],
    ['t3', [result('t3', 'a', '2'), result('t3', 'b', null, 'DNF')]],
  ]);
  const average = aggregateOfficial('tempo', games('t1', 't2', 't3'), byGame, 'average');
  assert.deepEqual(average.rows.map(({ player_id, rank, displayValue, games_count, results_count }) =>
    [player_id, rank, displayValue, games_count, results_count]), [
    ['a', 1, '5/3', 3, 3], ['b', 2, '2', 2, 1],
  ]);
  assert.equal(average.rows[0].unitLabel, 'ms/resultado');
  assert.equal(average.rows[0].metricLabel, 'Média');
});

test('special DNF-only player is unranked for numeric metrics but ranks by games', () => {
  const byGame = feeds([['g', [result('g', 'a', null, 'DNF'), result('g', 'b', '10')]]]);
  const total = aggregateOfficial('minigolfe', games('g'), byGame, 'total');
  assert.deepEqual(total.rows.map(({ player_id, rank, displayValue, games_count, results_count }) =>
    [player_id, rank, displayValue, games_count, results_count]), [
    ['b', 1, '10', 1, 1], ['a', null, '—', 1, 0],
  ]);
  const played = aggregateOfficial('minigolfe', games('g'), byGame, 'games');
  assert.deepEqual(played.rows.map(({ player_id, rank, displayValue }) => [player_id, rank, displayValue]), [
    ['a', 1, '1'], ['b', 1, '1'],
  ]);
  assert.equal(played.rows[0].unitLabel, 'partidas');
});

test('missing, stale or malformed feeds are listed for fetch and never counted as zero', () => {
  const finalGames = [...games('g1', 'g2', 'g3', 'g4'), { id: 'partial', status: 'partial' }, { id: 'g1', status: 'final' }];
  const byGame = feeds([
    ['g1', [result('g1', 'a', '5')]],
    ['g3', [result('g3', 'a', '8', 'active', false)]],
    ['g4', [result('other', 'a', '9')]],
  ]);
  const original = byGame.get('g1').rows[0].value_text;
  const aggregated = aggregateOfficial('tempo', finalGames, byGame, 'total');
  assert.deepEqual(aggregated.missingGameIds, ['g2', 'g3', 'g4']);
  assert.deepEqual(aggregated.rows.map(({ player_id, displayValue, games_count }) => [player_id, displayValue, games_count]), [
    ['a', '5', 1],
  ]);
  assert.equal(byGame.get('g1').rows[0].value_text, original);
  assert.equal(aggregateOfficial('tempo', games('g2'), new Map(), 'total').rows.length, 0);
});

test('ties use competition ranks 1, 1, 3 with stable player-id order', () => {
  const byGame = feeds([['g', [result('g', 'c', '3'), result('g', 'b', '5'), result('g', 'a', '5')]]]);
  const ranked = aggregateOfficial('pinball', games('g'), byGame, 'total');
  assert.deepEqual(ranked.rows.map(({ player_id, rank }) => [player_id, rank]), [
    ['a', 1], ['b', 1], ['c', 3],
  ]);
});

test('rejects unknown modes, metrics and input shapes', () => {
  assert.throws(() => aggregateOfficial('boliche', [], new Map(), 'total'), RangeError);
  assert.throws(() => aggregateOfficial('pinball', [], new Map(), 'median'), RangeError);
  assert.throws(() => aggregateOfficial('pinball', {}, new Map(), 'total'), TypeError);
  assert.throws(() => aggregateOfficial('pinball', [], {}, 'total'), TypeError);
  assert.throws(() => aggregateOfficial('pinball', [{ status: 'final' }], new Map(), 'total'), TypeError);
});
