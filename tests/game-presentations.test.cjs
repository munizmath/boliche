const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const presentations = require('../game-presentations.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

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
  assert.equal(presentations.adaptRankRow('corrida', {}), null);
  assert.equal(presentations.adaptProgress('corrida', {}), null);
  assert.equal(presentations.adaptEntry('corrida'), null);
});

test('oito descritores avançados preservam métricas exatas sem liberar o seletor', () => {
  const ids = ['pebolim', 'sinuca', 'tenis_mesa', 'truco', 'pinball', 'minigolfe', 'tempo', 'dardos_501'];
  assert.deepEqual(presentations.advanced.map((mode) => mode.id), ids);
  assert.deepEqual(presentations.proposed, presentations.advanced.map((mode) => mode.name));
  for (const id of ids) {
    assert.equal(presentations.get(id), null);
    assert.equal(presentations.getAdvanced(id).id, id);
    assert.equal(presentations.adaptEntry(id), presentations.getAdvanced(id).entry);
  }
  assert.equal(presentations.getAdvanced('quiz'), null);
  assert.equal(presentations.getAdvanced('minigolfe').rankingDirection, 'asc');
  assert.equal(presentations.getAdvanced('tempo').rankMetric, 'value_text');
  assert.equal(presentations.getAdvanced('dardos_501').rankMetric, 'legs_won');
  assert.match(presentations.getAdvanced('dardos_501').summary, /fechamento em dupla/);
  assert.equal(presentations.getAdvanced('pebolim').rankMetric, 'sets_won');
  assert.equal(presentations.adaptRankRow('pinball', { rank: 1, player: 'Ana', value_text: '9007199254740993' }).value, '9007199254740993');
  assert.equal(presentations.adaptRankRow('pinball', { total: 27 }).value, null);
  assert.equal(presentations.adaptRankRow('dardos_501', { legs_won: 2 }).value, 2);
  const selector = html.match(/<select id="encounterGameType"[\s\S]*?<\/select>/)?.[0] || '';
  assert.deepEqual([...selector.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]), ['boliche', 'quiz', 'gincana']);
});

function fieldset(id) {
  const match = html.match(new RegExp(`<fieldset\\b([^>]*)\\bid="${id}"([^>]*)>([\\s\\S]*?)<\\/fieldset>`));
  assert.ok(match, `campo ${id} deve existir`);
  assert.match(match[0].slice(0, match[0].indexOf('>') + 1), /\bdisabled\b/);
  assert.match(match[0].slice(0, match[0].indexOf('>') + 1), /\bhidden\b/);
  assert.match(match[3], /<legend>[^<]+<\/legend>/);
  return match[3];
}

function assertLabeledControls(markup, panelId) {
  const labels = new Set([...markup.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((match) => match[1]));
  const controls = [...markup.matchAll(/<(?:input|select)\b[^>]*>/g)].map((match) => match[0]).filter((tag) => !tag.includes('type="hidden"'));
  for (const control of controls) {
    const id = control.match(/\bid="([^"]+)"/)?.[1];
    assert.ok(id && labels.has(id), `${panelId}: ${id || control} precisa de rótulo`);
  }
}

test('regras e entradas têm painéis inertes, nomes de campos e limites SQL por modalidade', () => {
  assert.deepEqual(presentations.advancedDom, {
    rulesContainerId: 'advancedRulesSettings', rulesPanelPrefix: 'advanced-rules-',
    scoreDialogId: 'advancedScoreModal', scoreFormId: 'advancedScoreForm',
    entryPanelPrefix: 'advanced-entry-', saveButtonId: 'advancedScoreSaveButton',
    errorId: 'advancedScoreError', statusDialogId: 'advancedStatusModal',
    statusFormId: 'advancedStatusForm', statusPanelPrefix: 'advanced-status-',
    statusSaveButtonId: 'advancedStatusSaveButton',
  });
  assert.match(html, /<div id="advancedRulesSettings"[^>]*hidden/);
  assert.match(html, /<dialog id="advancedScoreModal"[^>]*hidden inert/);
  assert.match(html, /<button id="advancedScoreSaveButton"[^>]*disabled/);

  for (const mode of presentations.advanced) {
    const rulesMarkup = fieldset(`advanced-rules-${mode.id}`);
    const entryMarkup = fieldset(`advanced-entry-${mode.id}`);
    assertLabeledControls(rulesMarkup, `advanced-rules-${mode.id}`);
    assertLabeledControls(entryMarkup, `advanced-entry-${mode.id}`);
    assert.deepEqual([...rulesMarkup.matchAll(/\bname="([^"]+)"/g)].map((match) => match[1]), mode.rulesFields.map((field) => field.name), `${mode.id}: regras`);
    assert.deepEqual([...entryMarkup.matchAll(/\bname="([^"]+)"/g)].map((match) => match[1]), mode.entryFields, `${mode.id}: entrada`);
    for (const rule of mode.rulesFields) {
      const input = [...rulesMarkup.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes(`name="${rule.name}"`));
      assert.ok(input, `${mode.id}: ${rule.name}`);
      assert.match(input, new RegExp(`\\bmin="${rule.min}"`));
      assert.match(input, new RegExp(`\\bmax="${rule.max}"`));
      assert.match(input, /\brequired\b/);
    }
  }
});

test('contrato da entrada preserva a forma de cada RPC e IDs sem duplicação', () => {
  assert.deepEqual(presentations.advanced.map(({ id, kind, writeRpc }) => [id, kind, writeRpc]), [
    ['pebolim', 'match', 'save_match_set'], ['sinuca', 'match', 'save_match_set'],
    ['tenis_mesa', 'match', 'save_match_set'], ['truco', 'match', 'save_match_set'],
    ['pinball', 'individual', 'save_mode_player_score'], ['minigolfe', 'individual', 'save_mode_player_score'],
    ['tempo', 'individual', 'save_mode_player_score'], ['dardos_501', 'darts', 'save_darts_turn'],
  ]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('advancedScoreTitle') && ids.includes('advancedScoreHelp') && ids.includes('advancedScoreError'));
  assert.match(html, /aria-labelledby="advancedScoreTitle" aria-describedby="advancedScoreHelp"/);
  for (const id of ['pinball', 'minigolfe', 'tempo']) {
    const entryMarkup = fieldset(`advanced-entry-${id}`);
    assert.match(entryMarkup, /name="p_value" type="text" inputmode="numeric"/);
    assert.match(entryMarkup, /<option value="DNF">/);
    assert.match(entryMarkup, /<option value="DNS">/);
  }
  assert.match(fieldset('advanced-entry-dardos_501'), /name="dart_3_multiplier"/);
  assert.match(html, /<dialog id="advancedStatusModal"[^>]*hidden inert/);
  assert.match(html, /<button id="advancedStatusSaveButton"[^>]*disabled/);
  assert.match(html, /aria-labelledby="advancedStatusTitle" aria-describedby="advancedStatusHelp"/);
  assert.ok(ids.includes('advancedStatusTitle') && ids.includes('advancedStatusHelp') && ids.includes('advancedStatusError'));
  const match = presentations.getAdvanced('pebolim');
  const darts = presentations.getAdvanced('dardos_501');
  assert.equal(match.statusRpc, 'save_match_player_status');
  assert.equal(darts.statusRpc, 'set_darts_player_status');
  assert.equal(darts.startRpc, 'start_darts_leg');
  for (const mode of [match, darts]) {
    const statusMarkup = fieldset(`advanced-status-${mode.kind}`);
    assertLabeledControls(statusMarkup, `advanced-status-${mode.kind}`);
    assert.deepEqual([...statusMarkup.matchAll(/\bname="([^"]+)"/g)].map((item) => item[1]), mode.statusFields);
    assert.match(statusMarkup, /<option value="DNF">/);
    assert.match(statusMarkup, /<option value="DNS">/);
  }
});
