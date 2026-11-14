const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GameRules = require('../game-rules.js');

test('expõe catálogo de modalidades e limita OCR/tablet ao boliche', () => {
  const ids = ['boliche', 'quiz', 'gincana', 'pebolim', 'sinuca', 'tenis_mesa', 'truco', 'pinball', 'minigolfe', 'tempo', 'dardos_501'];
  const modes = ids.map((id) => GameRules.getMode(id));
  assert.deepEqual(modes.map((mode) => mode.id), ids);
  assert.equal(GameRules.getMode('boliche').allowsOCR, true);
  assert.equal(GameRules.getMode('boliche').allowsTablet, true);
  for (const mode of modes.filter(({ id }) => id !== 'boliche')) {
    assert.equal(mode.allowsOCR, false, `${mode.id} não deve permitir OCR`);
    assert.equal(mode.allowsTablet, false, `${mode.id} não deve permitir tablet`);
  }
  assert.equal(GameRules.getMode('tenis_mesa').label, 'Tênis de mesa');
  assert.equal(GameRules.getMode('minigolfe').unit, 'tacadas');
  assert.throws(() => GameRules.getMode('corrida'), /Modalidade desconhecida/);
  assert.throws(() => GameRules.getMode('toString'), /Modalidade desconhecida/);
});

test('também publica a mesma API UMD em window sem depender do DOM', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'game-rules.js'), 'utf8');
  const browserWindow = {};
  vm.runInNewContext(source, { window: browserWindow });
  assert.equal(typeof browserWindow.GameRules.rankScores, 'function');
  assert.equal(browserWindow.GameRules.getMode('quiz').label, 'Quiz');
});

test('rankings respeitam direção, empates competitivos e ausências inelegíveis', () => {
  const high = GameRules.rankScores('quiz', [
    { player: 'Ana', total: 9 },
    { player: 'Bia', total: 12 },
    { player: 'Caio', total: 12 },
    { player: 'Duda', total: 0, status: 'DNS' },
    { player: 'Eli', status: 'DNF' },
    { player: 'Fê', total: null },
    { player: 'Gui', total: 'DNF' },
  ]);
  assert.deepEqual(high.map(({ player, rank, eligible }) => [player, rank, eligible]), [
    ['Bia', 1, true], ['Caio', 1, true], ['Ana', 3, true],
    ['Duda', null, false], ['Eli', null, false], ['Fê', null, false], ['Gui', null, false],
  ]);

  const low = GameRules.rankScores('minigolfe', [
    { player: 'A', total: 4 }, { player: 'B', total: 3 }, { player: 'C', total: 3 },
  ]);
  assert.deepEqual(low.map(({ player, rank }) => [player, rank]), [['B', 1], ['C', 1], ['A', 3]]);
  assert.deepEqual(GameRules.rankScores('tempo', [{ total: 8 }, { total: 10 }]).map((row) => row.total), [8, 10]);
});

test('pinball compara inteiros acima de 2^53 exatamente', () => {
  const ranked = GameRules.rankScores('pinball', [
    { player: 'exato', total: '9007199254740993' },
    { player: 'menor', total: '9007199254740992' },
    { player: 'mesmo', total: BigInt('9007199254740993') },
  ]);
  assert.deepEqual(ranked.map(({ player, rank }) => [player, rank]), [
    ['exato', 1], ['mesmo', 1], ['menor', 3],
  ]);
  assert.throws(() => GameRules.rankScores('pinball', [{ total: 9007199254740992 }]), /inteiro seguro/);
  assert.equal(GameRules.formatResult('pinball', '9007199254740993'), '9.007.199.254.740.993 pontos');
});

test('métrica customizada lê o campo solicitado sem alterar as linhas de entrada', () => {
  const input = [{ total: 1, wins: 2 }, { total: 9, wins: 1 }];
  const ranked = GameRules.rankScores('pebolim', input, 'wins');
  assert.deepEqual(ranked.map(({ wins, rank }) => [wins, rank]), [[2, 1], [1, 2]]);
  assert.equal(Object.hasOwn(input[0], 'rank'), false);
});

test('tênis de mesa só fecha com 11 pontos e vantagem mínima de dois', () => {
  assert.equal(GameRules.evaluateSet('tenis_mesa', 10, 10).complete, false);
  assert.equal(GameRules.evaluateSet('tenis_mesa', 11, 10).winner, null);
  assert.equal(GameRules.evaluateSet('tenis_mesa', 12, 10).winner, 'a');
  assert.equal(GameRules.evaluateSet('tenis_mesa', 10, 12).winner, 'b');
  assert.equal(GameRules.evaluateSet('tenis_mesa', 13, 12).complete, false);
});

test('truco exige configuração explícita e usa somente target/winBy fornecidos', () => {
  assert.throws(() => GameRules.evaluateSet('truco', 12, 10), /exige config/);
  assert.equal(GameRules.evaluateSet('truco', 12, 11, { target: 12, winBy: 2 }).complete, false);
  assert.deepEqual(GameRules.evaluateSet('truco', 13, 11, { target: 12, winBy: 2 }), {
    mode: 'truco', complete: true, winner: 'a', tie: false, leader: 'a', score: { a: 13, b: 11 },
  });
  assert.throws(() => GameRules.evaluateSet('truco', 12, 0, { target: 12 }), /target e winBy/);
});

test('sets simples identificam vencedor e deixam empate pendente sem inventar desempate', () => {
  assert.equal(GameRules.evaluateSet('pebolim', 5, 3).winner, 'a');
  assert.equal(GameRules.evaluateSet('sinuca', 2, 2).complete, false);
  assert.equal(GameRules.evaluateSet('sinuca', 2, 2).winner, null);
  assert.throws(() => GameRules.evaluateSet('quiz', 10, 8), /não é avaliado como confronto/);
  assert.throws(() => GameRules.evaluateSet('pebolim', -1, 2), /inteiro não negativo/);
});

test('dardos aplica redução, bust por excesso e bust ao deixar 1 ou fechar sem dupla', () => {
  assert.deepEqual(GameRules.evaluateDartsTurn(501, [60, 20, 1]), {
    balance: 420, bust: false, won: false, dartsThrown: 3,
    throws: [{ score: 60, isDouble: false }, { score: 20, isDouble: false }, { score: 1, isDouble: false }],
  });
  assert.deepEqual(GameRules.evaluateDartsTurn(40, [60]), {
    balance: 40, bust: true, won: false, dartsThrown: 1, throws: [{ score: 60, isDouble: false }],
  });
  assert.equal(GameRules.evaluateDartsTurn(3, [2]).bust, true);
  assert.equal(GameRules.evaluateDartsTurn(40, [40]).bust, true);
  assert.equal(GameRules.evaluateDartsTurn(40, [{ score: 40, isDouble: true }]).won, true);
  assert.equal(GameRules.evaluateDartsTurn(50, [{ value: 25, multiplier: 2 }]).won, true);
});

test('dardos valida saldo, quantidade e legalidade dos lançamentos', () => {
  assert.throws(() => GameRules.evaluateDartsTurn(0, [0]), /entre 1 e 501/);
  assert.throws(() => GameRules.evaluateDartsTurn(501, []), /de 1 a 3/);
  assert.throws(() => GameRules.evaluateDartsTurn(501, [1, 2, 3, 4]), /de 1 a 3/);
  assert.throws(() => GameRules.evaluateDartsTurn(501, [41]), /pontuação impossível/);
  assert.throws(() => GameRules.evaluateDartsTurn(40, [40, 1]), /depois de bust/);
  assert.throws(() => GameRules.evaluateDartsTurn(2, [{ score: 2, isDouble: false }, 1]), /depois de bust/);
  assert.throws(() => GameRules.evaluateDartsTurn(10, [{ value: 25, multiplier: 3 }]), /multiplier inválido/);
  assert.throws(() => GameRules.evaluateDartsTurn(10, [{ score: 4, multiplier: 2 }]), /somente/);
});

test('formata resultados numéricos, ausências e tempos na unidade declarada', () => {
  assert.equal(GameRules.formatResult('boliche', 213), '213 pontos');
  assert.equal(GameRules.formatResult('tempo', 95250), '95.250 ms');
  assert.equal(GameRules.formatResult('tempo', { status: 'DNF' }), 'DNF');
  assert.equal(GameRules.formatResult('tempo', 'dns'), 'DNS');
  assert.equal(GameRules.formatResult('tempo', 'absent'), 'Ausente');
  assert.equal(GameRules.formatResult('quiz', null), '—');
  assert.throws(() => GameRules.formatResult('quiz', 'não é número'), /número finito/);
});
