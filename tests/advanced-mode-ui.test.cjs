'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AdvancedModeUI = require('../advanced-mode-ui.js');
const presentations = require('../game-presentations.js');

class Element {
  constructor(tagName = 'DIV', name = '') {
    this.tagName = tagName;
    this.name = name;
    this.type = 'text';
    this.value = '';
    this.textContent = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.inert = false;
    this.open = false;
    this.required = false;
    this.children = [];
    this.fields = new Map();
    this.listeners = new Map();
    this.attributes = new Map();
  }
  querySelector(selector) { return this.fields.get(selector.match(/^\[name="([^"]+)"\]$/)?.[1]) || null; }
  replaceChildren(...children) {
    this.children = children;
    this.value = children[0]?.value || '';
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type, target = this) {
    for (const handler of this.listeners.get(type) || []) handler({ type, target, currentTarget: this, preventDefault() {} });
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  reset() {
    for (const panel of this.panels || []) {
      for (const control of panel.fields.values()) {
        control.value = control.defaultValue || '';
        control.checked = false;
      }
    }
  }
  checkValidity() {
    const panel = (this.panels || []).find((item) => !item.hidden);
    if (!panel || panel.disabled) return false;
    return [...panel.fields.values()].every((control) => control.disabled || !control.required || Boolean(control.value));
  }
}

function fixture(modeId, overrides = {}) {
  const nodes = new Map();
  const add = (id, tag = 'DIV') => { const node = new Element(tag); nodes.set(id, node); return node; };
  const scoreDialog = add('advancedScoreModal', 'DIALOG');
  const statusDialog = add('advancedStatusModal', 'DIALOG');
  scoreDialog.hidden = statusDialog.hidden = true;
  const scoreForm = add('advancedScoreForm', 'FORM');
  const statusForm = add('advancedStatusForm', 'FORM');
  const scoreSave = add('advancedScoreSaveButton', 'BUTTON');
  const statusSave = add('advancedStatusSaveButton', 'BUTTON');
  scoreSave.textContent = 'Salvar resultado';
  statusSave.textContent = 'Salvar situação';
  add('advancedScoreError');
  add('advancedStatusError');
  const selectNames = new Set(['p_game_id', 'p_player_id', 'p_player_a_id', 'p_player_b_id', 'p_starter_player_id', 'p_status',
    'dart_1_multiplier', 'dart_2_multiplier', 'dart_3_multiplier']);
  const requiredNames = new Set(['p_game_id', 'p_player_id', 'p_player_a_id', 'p_player_b_id', 'p_set_no', 'p_score_a', 'p_score_b',
    'p_value', 'p_leg_no', 'p_turn_no', 'dart_1_value', 'p_status']);
  const makePanel = (id, names, form) => {
    const panel = add(id, 'FIELDSET');
    panel.hidden = true;
    panel.disabled = true;
    for (const name of names) {
      const control = new Element(selectNames.has(name) ? 'SELECT' : 'INPUT', name);
      control.required = requiredNames.has(name);
      if (name === 'p_status' && id.startsWith('advanced-entry-')) {
        control.defaultValue = 'active';
      }
      if (name.endsWith('_multiplier')) control.defaultValue = '1';
      if (name === 'p_confirmed' || name === 'p_finalized') control.type = 'checkbox';
      panel.fields.set(name, control);
    }
    form.panels ||= [];
    form.panels.push(panel);
  };
  for (const descriptor of presentations.advanced) {
    makePanel(`advanced-entry-${descriptor.id}`, descriptor.entryFields, scoreForm);
  }
  makePanel('advanced-status-match', ['p_game_id', 'p_player_id', 'p_status', 'p_expected_version'], statusForm);
  makePanel('advanced-status-darts', ['p_game_id', 'p_leg_no', 'p_player_id', 'p_status'], statusForm);
  let confirmResult = false;
  const confirmCalls = [];
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => new Element(tag.toUpperCase()),
    defaultView: { confirm: (message) => { confirmCalls.push(message); return confirmResult; } },
  };
  const state = {
    games: [{ id: 'g1', encounter_id: 'e1', nome: 'Partida 1' }, { id: 'g2', encounter_id: 'e1', nome: 'Partida 2' }],
    players: [{ id: 'p1', nome: 'Ana' }, { id: 'p2', nome: 'Bia' }, { id: 'p3', nome: 'Caio' }],
    scores: [
      { game_id: 'g1', player_id: 'p1' }, { game_id: 'g1', player_id: 'p2' },
      { game_id: 'g2', player_id: 'p1' }, { game_id: 'g2', player_id: 'p3' },
    ],
    activeGameId: 'g1',
  };
  Object.assign(state, overrides.state || {});
  const encounter = { id: 'e1', game_type: modeId, status: 'active', rules_config: {
    ...(modeId === 'sinuca' ? { sets_to_win: 2 } : ['pebolim', 'tenis_mesa', 'truco'].includes(modeId)
      ? { sets_to_win: 2, points_to_win: 10, win_by: 2 } : modeId === 'dardos_501' ? { legs_to_win: 2 } : {}),
  } };
  const feeds = { get_match_results: [], get_mode_player_scores: [], get_darts_match_results: [] };
  const tables = { match_sets: [], match_player_status: [], darts_legs: [], darts_leg_players: [], darts_turns: [] };
  const calls = [];
  const reads = [];
  let readFailure = null;
  let writeFailure = null;
  let readGate = null;
  const client = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name.startsWith('get_')) {
        if (readGate) await readGate;
        if (readFailure) return { error: readFailure };
        return { data: feeds[name] || [] };
      }
      if (writeFailure) return { error: writeFailure };
      return { data: { saved: true } };
    },
    from(name) {
      return { select() { return { async eq(column, value) {
        reads.push([name, column, value]);
        return { data: tables[name] || [] };
      } }; } };
    },
  };
  const logic = {
    rankResults: (_, rows) => rows.map((row, index) => ({ ...row, rank: index + 1 })),
    evaluateMatchSet: (mode, a, b, rules) => ({ complete: mode === 'sinuca' ? a !== b
      : Math.max(a, b) >= rules.points_to_win && Math.abs(a - b) >= rules.win_by }),
    validateIndividualResult: (mode, raw, status, finalized) => {
      if (status !== 'active') return { value: null, status, finalized: true };
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) > 9223372036854775807n) throw new Error('Valor inválido');
      return { value: raw, status, finalized };
    },
    toDartsRpcThrows: (list) => list.map((dart) => ({ score: dart.value * dart.multiplier, is_double: dart.multiplier === 2 })),
    evaluateDartsTurn: (balance, list) => { if (balance < 1 || !list.length) throw new Error('Turno inválido'); return { balance, throws: list }; },
  };
  const toasts = [];
  let reloads = 0;
  let admin = true;
  const controller = AdvancedModeUI.create({ document, client, state, getActive: () => encounter,
    reload: async () => { reloads += 1; }, isAdmin: () => admin,
    showToast: (...args) => toasts.push(args), logic, presentations });
  const panel = (kind = 'score') => nodes.get(kind === 'score' ? `advanced-entry-${modeId}`
    : `advanced-status-${presentations.getAdvanced(modeId).kind}`);
  const form = (kind = 'score') => kind === 'score' ? scoreForm : statusForm;
  const control = (name, kind = 'score') => panel(kind).fields.get(name);
  const set = (name, value, kind = 'score', eventType = 'change') => {
    const item = control(name, kind);
    item.value = String(value);
    form(kind).emit(eventType, item);
  };
  const check = (name, checked, kind = 'score') => {
    const item = control(name, kind);
    item.checked = checked;
    form(kind).emit('change', item);
  };
  return { nodes, state, encounter, feeds, tables, calls, reads, confirmCalls, controller, panel, control, set, check,
    toasts, get reloads() { return reloads; }, setAdmin: (value) => { admin = value; },
    setConfirm: (value) => { confirmResult = value; }, setReadFailure: (error) => { readFailure = error; },
    setWriteFailure: (error) => { writeFailure = error; }, setReadGate: (promise) => { readGate = promise; } };
}

test('all eight descriptors open their score fieldset and read a ranking feed', async () => {
  for (const mode of presentations.advanced) {
    const f = fixture(mode.id);
    const feed = await f.controller.openScore();
    assert.equal(feed.modeId, mode.id);
    assert.equal(f.panel().hidden, false);
    assert.equal(f.nodes.get('advancedScoreModal').open, true);
    assert.equal(f.control('p_game_id').value, 'g1');
    assert.deepEqual(f.control('p_game_id').children.map((option) => option.value), ['', 'g1', 'g2']);
    assert.deepEqual(f.control('p_player_id')?.children.map((option) => option.value),
      mode.kind === 'match' ? undefined : ['', 'p1', 'p2']);
    assert.equal(f.controller.getRankingFeed(mode.id, 'g1'), feed);
    f.controller.destroy();
  }
});

test('match set validates rules, writes exact RPC payload and refreshes feed', async () => {
  const f = fixture('pebolim');
  await f.controller.openScore();
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  f.set('p_set_no', 1);
  f.set('p_score_a', 10);
  f.set('p_score_b', 9);
  f.check('p_confirmed', true);
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  f.set('p_score_b', 8);
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, false);
  const result = await f.controller.submitScore();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'save_match_set')[1], {
    p_game_id: 'g1', p_set_no: 1, p_player_a_id: 'p1', p_player_b_id: 'p2',
    p_score_a: 10, p_score_b: 8, p_confirmed: true, p_expected_version: null,
  });
  assert.equal(f.reloads, 1);
  assert.equal(f.nodes.get('advancedScoreModal').open, false);
});

test('match status hydrates CAS version and writes DNF', async () => {
  const f = fixture('sinuca');
  f.tables.match_player_status = [{ game_id: 'g1', player_id: 'p1', status: 'DNS', version: 4 }];
  await f.controller.openStatus();
  f.set('p_player_id', 'p1', 'status');
  assert.equal(f.control('p_expected_version', 'status').value, '4');
  f.set('p_status', 'DNF', 'status');
  const result = await f.controller.submitStatus();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'save_match_player_status')[1], {
    p_game_id: 'g1', p_player_id: 'p1', p_status: 'DNF', p_expected_version: 4,
  });
});

test('match RPC prerequisites disable sets out of sequence and DNS after a confirmed set', async () => {
  const f = fixture('sinuca');
  f.tables.match_sets = [{ game_id: 'g1', set_no: 1, player_a_id: 'p1', player_b_id: 'p2',
    score_a: 5, score_b: 2, confirmed: false, version: 1 }];
  await f.controller.openScore();
  f.set('p_set_no', '2');
  f.set('p_score_a', '4');
  f.set('p_score_b', '1');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  f.controller.close();
  f.tables.match_sets[0].confirmed = true;
  await f.controller.openStatus();
  f.set('p_player_id', 'p1', 'status');
  f.set('p_status', 'DNS', 'status');
  assert.equal(f.nodes.get('advancedStatusSaveButton').disabled, true);
  f.set('p_status', 'DNF', 'status');
  assert.equal(f.nodes.get('advancedStatusSaveButton').disabled, false);
});

test('individual scores preserve exact decimal text and CAS; DNF clears value', async () => {
  const f = fixture('pinball');
  f.feeds.get_mode_player_scores = [{ game_id: 'g1', player_id: 'p1', value_text: '9007199254740993', status: 'active', finalized: true, version: 2 }];
  await f.controller.openScore();
  f.set('p_player_id', 'p1');
  assert.equal(f.control('p_value').value, '9007199254740993');
  f.set('p_value', '9007199254740994');
  assert.equal((await f.controller.submitScore()).ok, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'save_mode_player_score')[1], {
    p_game_id: 'g1', p_player_id: 'p1', p_value: '9007199254740994', p_status: 'active', p_finalized: true, p_expected_version: 2,
  });
  const g = fixture('tempo');
  await g.controller.openScore();
  g.set('p_player_id', 'p2');
  g.set('p_status', 'DNF');
  assert.equal(g.control('p_value').disabled, true);
  assert.equal((await g.controller.submitScore()).ok, true);
  assert.deepEqual(g.calls.find(([name]) => name === 'save_mode_player_score')[1], {
    p_game_id: 'g1', p_player_id: 'p2', p_value: null, p_status: 'DNF', p_finalized: true, p_expected_version: null,
  });
});

test('Realtime refresh preserves dirty draft and disables stale CAS write', async () => {
  const f = fixture('minigolfe');
  f.feeds.get_mode_player_scores = [{ game_id: 'g1', player_id: 'p1', value_text: '42', status: 'active', finalized: false, version: 2 }];
  await f.controller.openScore();
  f.set('p_player_id', 'p1');
  f.set('p_value', '40');
  f.feeds.get_mode_player_scores = [{ game_id: 'g1', player_id: 'p1', value_text: '39', status: 'active', finalized: true, version: 3 }];
  const feed = await f.controller.refreshFeed('minigolfe', 'g1');
  assert.equal(feed.rows[0].version, 3);
  assert.equal(f.control('p_value').value, '40');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  assert.match(f.nodes.get('advancedScoreError').textContent, /rascunho/);
  assert.equal((await f.controller.submitScore()).ok, false);
  assert.equal(f.calls.some(([name]) => name === 'save_mode_player_score'), false);
});

test('context change requires explicit discard and restores selection on cancel', async () => {
  const f = fixture('pinball');
  await f.controller.openScore();
  f.set('p_player_id', 'p1');
  f.set('p_value', '1234');
  f.set('p_player_id', 'p2');
  assert.equal(f.control('p_player_id').value, 'p1');
  assert.equal(f.control('p_value').value, '1234');
  f.set('p_game_id', 'g2');
  assert.equal(f.control('p_game_id').value, 'g1');
  assert.equal(f.confirmCalls.length, 2);
  assert.match(f.confirmCalls[0], /Descartar as alterações não salvas/);
  f.setConfirm(true);
  f.set('p_player_id', 'p2');
  assert.equal(f.control('p_player_id').value, 'p2');
  assert.equal(f.control('p_value').value, '');
});

test('unchanged set event and Realtime render retain a dirty match draft', async () => {
  const f = fixture('pebolim');
  await f.controller.openScore();
  f.set('p_set_no', '1');
  f.set('p_score_a', '10');
  f.set('p_score_b', '8');
  f.set('p_set_no', '1');
  assert.equal(f.control('p_score_a').value, '10');
  assert.equal(f.control('p_score_b').value, '8');
  f.controller.render('g2');
  assert.equal(f.control('p_game_id').value, 'g1');
  assert.equal(f.control('p_score_a').value, '10');
  f.set('p_set_no', '2', 'score', 'input');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  f.set('p_set_no', '2');
  assert.equal(f.control('p_set_no').value, '1');
  assert.equal(f.control('p_score_a').value, '10');
  assert.equal(f.confirmCalls.length, 1);
  f.setConfirm(true);
  f.set('p_set_no', '2');
  assert.equal(f.control('p_score_a').value, '');
  assert.equal(f.control('p_score_b').value, '');
  assert.equal(f.control('p_expected_version').value, '');
});

test('leg change cancels without loss and clears turn fields only after confirmation', async () => {
  const f = fixture('dardos_501');
  await f.controller.openScore();
  f.set('p_starter_player_id', 'p1');
  f.set('p_player_id', 'p1');
  f.set('dart_1_value', '20');
  f.set('dart_1_multiplier', '3');
  f.set('p_leg_no', '2');
  assert.equal(f.control('p_leg_no').value, '1');
  assert.equal(f.control('dart_1_value').value, '20');
  assert.equal(f.control('p_starter_player_id').value, 'p1');
  assert.equal(f.confirmCalls.length, 1);
  f.setConfirm(true);
  f.set('p_leg_no', '2');
  assert.equal(f.control('p_leg_no').value, '2');
  assert.equal(f.control('dart_1_value').value, '');
  assert.equal(f.control('p_starter_player_id').value, '');
  assert.equal(f.control('p_player_id').value, '');
  assert.equal(f.control('p_turn_no').value, '1');
});

test('darts refresh loads leg players and first turn uses one atomic RPC', async () => {
  const f = fixture('dardos_501');
  const feed = await f.controller.openScore();
  assert.deepEqual(Object.keys(feed.details), ['darts_legs', 'darts_leg_players', 'darts_turns']);
  assert.deepEqual(f.reads.map(([name]) => name), ['darts_legs', 'darts_leg_players', 'darts_turns']);
  f.set('p_starter_player_id', 'p1');
  f.set('p_player_id', 'p1');
  f.set('dart_1_value', '20');
  f.set('dart_1_multiplier', '3');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, false);
  assert.equal((await f.controller.submitScore()).ok, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'start_darts_leg_and_save_turn')[1], {
    p_game_id: 'g1', p_leg_no: 1, p_turn_no: 1, p_player_id: 'p1',
    p_throws: [{ score: 60, is_double: false }], p_starter_player_id: 'p1',
  });
  assert.equal(f.calls.some(([name]) => name === 'start_darts_leg' || name === 'save_darts_turn'), false);
});

test('darts turn supports four-player order and balance from leg players', async () => {
  const f = fixture('dardos_501', { state: { scores: ['p1', 'p2', 'p3', 'p4'].map((player_id) => ({ game_id: 'g1', player_id })),
    players: ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, nome: id })) } });
  f.tables.darts_legs = [{ game_id: 'g1', leg_no: 1, starter_player_id: 'p1', status: 'active' }];
  f.tables.darts_leg_players = ['p1', 'p2', 'p3', 'p4'].map((id, index) => ({ game_id: 'g1', leg_no: 1, player_id: id,
    turn_order: index + 1, status: 'active', balance: id === 'p2' ? 301 : 501 }));
  f.tables.darts_turns = [{ game_id: 'g1', leg_no: 1, turn_no: 1, player_id: 'p1' }];
  await f.controller.openScore();
  f.set('p_player_id', 'p3');
  f.set('dart_1_value', '20');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  f.set('p_player_id', 'p2');
  assert.equal(f.control('p_player_id').value, 'p3');
  assert.equal(f.control('dart_1_value').value, '20');
  f.setConfirm(true);
  f.set('p_player_id', 'p2');
  assert.equal(f.control('dart_1_value').value, '');
  f.set('dart_1_value', '20');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, false);
  assert.equal((await f.controller.submitScore()).ok, true);
  assert.equal(f.calls.find(([name]) => name === 'start_darts_leg_and_save_turn'), undefined);
  assert.equal(f.calls.find(([name]) => name === 'save_darts_turn')[1].p_turn_no, 2);
});

test('failed atomic first turn keeps draft without a separate leg-start write', async () => {
  const f = fixture('dardos_501');
  await f.controller.openScore();
  f.set('p_starter_player_id', 'p1');
  f.set('p_player_id', 'p1');
  f.set('dart_1_value', '20');
  f.setWriteFailure(new Error('network'));
  assert.equal((await f.controller.submitScore()).ok, false);
  assert.equal(f.control('dart_1_value').value, '20');
  assert.deepEqual(f.calls.filter(([name]) => !name.startsWith('get_')).map(([name]) => name),
    ['start_darts_leg_and_save_turn']);
  assert.deepEqual(f.tables.darts_legs, []);
});

test('darts status uses active leg and player', async () => {
  const f = fixture('dardos_501');
  f.tables.darts_legs = [{ game_id: 'g1', leg_no: 1, starter_player_id: 'p1', status: 'active' }];
  f.tables.darts_leg_players = [{ game_id: 'g1', leg_no: 1, player_id: 'p1', turn_order: 1, status: 'active', balance: 501 }];
  await f.controller.openStatus();
  f.set('p_player_id', 'p1', 'status');
  f.set('p_status', 'DNS', 'status');
  assert.equal((await f.controller.submitStatus()).ok, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'set_darts_player_status')[1], {
    p_game_id: 'g1', p_leg_no: 1, p_player_id: 'p1', p_status: 'DNS',
  });
});

test('darts DNS is disabled after the player has thrown a turn', async () => {
  const f = fixture('dardos_501');
  f.tables.darts_legs = [{ game_id: 'g1', leg_no: 1, starter_player_id: 'p1', status: 'active' }];
  f.tables.darts_leg_players = [{ game_id: 'g1', leg_no: 1, player_id: 'p1', turn_order: 1, status: 'active', balance: 481 }];
  f.tables.darts_turns = [{ game_id: 'g1', leg_no: 1, turn_no: 1, player_id: 'p1' }];
  await f.controller.openStatus();
  f.set('p_player_id', 'p1', 'status');
  f.set('p_status', 'DNS', 'status');
  assert.equal(f.nodes.get('advancedStatusSaveButton').disabled, true);
  f.set('p_status', 'DNF', 'status');
  assert.equal(f.nodes.get('advancedStatusSaveButton').disabled, false);
});

test('read errors leave save disabled and show error', async () => {
  const f = fixture('truco');
  f.setReadFailure(new Error('offline'));
  assert.equal(await f.controller.openScore(), null);
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  assert.match(f.nodes.get('advancedScoreError').textContent, /offline/);
  assert.equal(f.panel().disabled, false);
});

test('loading disables the fieldset and reports busy until feed arrives', async () => {
  const f = fixture('sinuca');
  let release;
  f.setReadGate(new Promise((resolve) => { release = resolve; }));
  const pending = f.controller.openScore();
  assert.equal(f.panel().disabled, true);
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  assert.equal(f.nodes.get('advancedScoreForm').attributes.get('aria-busy'), 'true');
  release();
  await pending;
  assert.equal(f.panel().disabled, false);
  assert.equal(f.nodes.get('advancedScoreForm').attributes.get('aria-busy'), 'false');
});

test('late feed from previous game cannot hydrate or enable the new game', async () => {
  const f = fixture('pebolim');
  let release;
  f.setReadGate(new Promise((resolve) => { release = resolve; }));
  const pending = f.controller.openScore();
  f.controller.render('g2');
  assert.equal(f.control('p_game_id').value, 'g2');
  assert.equal(f.nodes.get('advancedScoreForm').attributes.get('aria-busy'), 'false');
  release();
  assert.equal(await pending, null);
  assert.equal(f.control('p_game_id').value, 'g2');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  const feed = await f.controller.refreshFeed('pebolim', 'g2');
  assert.equal(feed.gameId, 'g2');
  assert.equal(f.controller.getRankingFeed('pebolim', 'g1').gameId, 'g1');
});

test('CAS conflict retains unsaved score and blocks retry', async () => {
  const f = fixture('pinball');
  await f.controller.openScore();
  f.set('p_player_id', 'p1');
  f.set('p_value', '77');
  const conflict = Object.assign(new Error('alterado'), { code: '40001' });
  f.setWriteFailure(conflict);
  assert.equal((await f.controller.submitScore()).ok, false);
  assert.equal(f.control('p_value').value, '77');
  assert.equal(f.nodes.get('advancedScoreSaveButton').disabled, true);
  assert.match(f.nodes.get('advancedScoreError').textContent, /rascunho/);
  assert.equal(f.calls.filter(([name]) => name === 'save_mode_player_score').length, 1);
  assert.equal((await f.controller.submitScore()).ok, false);
  assert.equal(f.calls.filter(([name]) => name === 'save_mode_player_score').length, 1);
});
