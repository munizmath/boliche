(function attachAdvancedGameModes(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdvancedGameModes = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createAdvancedGameModes() {
  'use strict';

  const MAX_BIGINT = 9223372036854775807n;
  const MAX_SAFE_SCORE = 1000000;
  const MODE_IDS = Object.freeze([
    'pebolim', 'sinuca', 'tenis_mesa', 'truco',
    'pinball', 'minigolfe', 'tempo', 'dardos_501',
  ]);
  const MATCH_MODES = new Set(['pebolim', 'sinuca', 'tenis_mesa', 'truco']);
  const INDIVIDUAL_MODES = new Set(['pinball', 'minigolfe', 'tempo']);

  const INTEGRATION_CONTRACT = Object.freeze({
    migrations: Object.freeze([
      'v17-match-sets.sql', 'v18-special-scores.sql', 'v19-darts.sql',
    ]),
    availability: 'Backend-only until app.js/index consume these feeds and RPCs; no advanced mode is user-facing yet.',
    load: 'Load advanced-game-modes.js after game-rules.js and before app.js; use window.AdvancedGameModes or require().',
    rosters: 'Head-to-head encounters and games require exactly 2 participants; dardos_501 requires 2–4; these sizes are checked on creation and edit.',
    createEncounter: Object.freeze({
      rpc: 'create_advanced_encounter',
      rules: Object.freeze({
        pebolim: '{sets_to_win, points_to_win, win_by}',
        sinuca: '{sets_to_win}',
        tenis_mesa: '{sets_to_win, points_to_win, win_by}',
        truco: '{sets_to_win, points_to_win, win_by}',
        pinball: '{}', minigolfe: '{}', tempo: '{}', dardos_501: '{legs_to_win}',
      }),
    }),
    matches: Object.freeze({
      gameShape: 'Create exactly one two-player game per head-to-head match.',
      writeSet: 'save_match_set({p_game_id,p_set_no,p_player_a_id,p_player_b_id,p_score_a,p_score_b,p_confirmed,p_expected_version})',
      writeStatus: 'save_match_player_status({p_game_id,p_player_id,p_status,p_expected_version})',
      read: 'get_match_results({p_game_id}); sets are also readable from match_sets.',
      winner: 'Never send a winner. save_match_set computes and stores winner_player_id only on valid confirmation.',
    }),
    individual: Object.freeze({
      write: 'save_mode_player_score({p_game_id,p_player_id,p_value,p_status,p_finalized,p_expected_version})',
      read: 'get_mode_player_scores({p_game_id}); read metric_key, unit and value_text; parse value_text with parseExactBigInt.',
      statuses: 'active requires nonnegative bigint; DNF/DNS require null value and finalized=true.',
      precision: 'Send bigint values as decimal strings. RPC response and feed expose value_text as decimal text.',
      units: Object.freeze({ pinball: 'raw points', minigolfe: 'strokes', tempo: 'integer elapsed milliseconds' }),
      exportFields: Object.freeze({ pinball: 'pinball_points', minigolfe: 'minigolfe_strokes', tempo: 'tempo_elapsed_ms' }),
      rankingStatus: 'This feed is backend-only; standings are not user-facing or official until app.js consumes it. Do not rank from scores.pontos.',
      ordering: 'The helper orders pinball descending, minigolfe and tempo ascending; use it only after the app integration adopts this feed.',
    }),
    darts: Object.freeze({
      start: 'For each leg, call start_darts_leg_and_save_turn({p_game_id,p_leg_no,p_starter_player_id,p_turn_no:1,p_player_id:starter,p_throws}) so an invalid first turn rolls back the new leg.',
      atomicFirstTurnRpc: 'start_darts_leg_and_save_turn({p_game_id,p_leg_no,p_starter_player_id,p_turn_no,p_player_id,p_throws})',
      turn: 'save_darts_turn({p_game_id,p_leg_no,p_turn_no,p_player_id,p_throws})',
      throws: 'Pass evaluateDartsTurn(...).throws through toDartsRpcThrows; p_throws uses [{score,is_double}]. The server enforces order, bust, and double checkout.',
      status: 'set_darts_player_status({p_game_id,p_leg_no,p_player_id,p_status}) accepts DNF or DNS.',
      read: 'get_darts_match_results({p_game_id}); legs, balances, turns, and statuses have public read policies.',
      winner: 'Do not calculate or submit a winner in the client; the server confirms a leg on checkout or sole remaining player.',
    }),
    concurrency: 'For edits, send the version returned by the last read; null means create. SQLSTATE 40001 means reload before retry.',
  });

  function assertMode(mode) {
    if (!MODE_IDS.includes(mode)) throw new RangeError(`Modalidade avançada desconhecida: ${String(mode)}`);
    return mode;
  }

  function exactKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${label} deve ser um objeto.`);
    }
    const keys = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
      throw new TypeError(`${label} deve conter somente: ${wanted.join(', ')}.`);
    }
  }

  function boundedInteger(value, key, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${key} deve ser inteiro entre ${minimum} e ${maximum}.`);
    }
    return value;
  }

  function normalizeRules(mode, input) {
    assertMode(mode);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('rules_config deve ser objeto.');
    }
    if (mode === 'pebolim' || mode === 'tenis_mesa' || mode === 'truco') {
      exactKeys(input, ['sets_to_win', 'points_to_win', 'win_by'], 'rules_config');
      return Object.freeze({
        sets_to_win: boundedInteger(input.sets_to_win, 'sets_to_win', 1, 9),
        points_to_win: boundedInteger(input.points_to_win, 'points_to_win', 1, 99),
        win_by: boundedInteger(input.win_by, 'win_by', 1, 10),
      });
    }
    if (mode === 'sinuca') {
      exactKeys(input, ['sets_to_win'], 'rules_config');
      return Object.freeze({ sets_to_win: boundedInteger(input.sets_to_win, 'sets_to_win', 1, 9) });
    }
    if (mode === 'dardos_501') {
      exactKeys(input, ['legs_to_win'], 'rules_config');
      return Object.freeze({ legs_to_win: boundedInteger(input.legs_to_win, 'legs_to_win', 1, 15) });
    }
    exactKeys(input, [], 'rules_config');
    return Object.freeze({});
  }

  function parseExactBigInt(value) {
    let result;
    if (typeof value === 'bigint') {
      result = value;
    } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
      result = BigInt(value);
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      result = BigInt(value);
    } else {
      throw new TypeError('Use BigInt, inteiro seguro ou string decimal exata não negativa.');
    }
    if (result < 0n || result > MAX_BIGINT) throw new RangeError('Valor fora da faixa bigint do PostgreSQL.');
    return result;
  }

  function validateIndividualResult(mode, value, status = 'active', finalized = true) {
    assertMode(mode);
    if (!INDIVIDUAL_MODES.has(mode)) throw new RangeError(`${mode} não usa placar individual especial.`);
    if (!['active', 'DNF', 'DNS'].includes(status)) throw new TypeError('status deve ser active, DNF ou DNS.');
    if (typeof finalized !== 'boolean') throw new TypeError('finalized deve ser boolean.');
    if (status === 'active') {
      return Object.freeze({ value: parseExactBigInt(value).toString(), status, finalized });
    }
    if (value !== null && value !== undefined) throw new TypeError('DNF/DNS não aceita valor numérico.');
    if (!finalized) throw new TypeError('DNF/DNS precisa ser terminal.');
    return Object.freeze({ value: null, status, finalized: true });
  }

  function evaluateMatchSet(mode, scoreA, scoreB, rulesConfig) {
    assertMode(mode);
    if (!MATCH_MODES.has(mode)) throw new RangeError(`${mode} não é modalidade de sets.`);
    boundedInteger(scoreA, 'score_a', 0, MAX_SAFE_SCORE);
    boundedInteger(scoreB, 'score_b', 0, MAX_SAFE_SCORE);
    const rules = normalizeRules(mode, rulesConfig);
    const difference = Math.abs(scoreA - scoreB);
    let complete;
    if (mode === 'sinuca') {
      complete = difference > 0;
    } else {
      complete = Math.max(scoreA, scoreB) >= rules.points_to_win && difference >= rules.win_by;
    }
    return Object.freeze({
      mode,
      complete,
      winner: complete ? (scoreA > scoreB ? 'a' : 'b') : null,
      score: Object.freeze({ a: scoreA, b: scoreB }),
    });
  }

  function scoreValue(mode, value) {
    if (mode === 'pinball' || mode === 'minigolfe' || mode === 'tempo') return parseExactBigInt(value);
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Resultado deve ser inteiro não negativo seguro.');
    return BigInt(value);
  }

  function rankResults(mode, rows) {
    assertMode(mode);
    if (!Array.isArray(rows)) throw new TypeError('rows deve ser um array.');
    const metric = mode === 'dardos_501' ? 'legs_won' : (MATCH_MODES.has(mode) ? 'sets_won' : 'value_text');
    const direction = ['minigolfe', 'tempo'].includes(mode) ? 1 : -1;
    const ranked = rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('Cada resultado deve ser objeto.');
      const raw = row[metric] ?? (metric === 'value_text' ? row.value : undefined);
      const status = typeof row.status === 'string' ? row.status.toUpperCase() : '';
      const eligible = row.finalized !== false && row.finalizado !== false
        && !['DNF', 'DNS'].includes(status) && raw !== null && raw !== undefined;
      return { row, index, eligible, value: eligible ? scoreValue(mode, raw) : null };
    });
    ranked.sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (!left.eligible) return left.index - right.index;
      if (left.value === right.value) return left.index - right.index;
      const comparison = left.value < right.value ? -1 : 1;
      return direction === 1 ? comparison : -comparison;
    });
    let previous;
    let previousRank = null;
    let eligibleCount = 0;
    return ranked.map(({ row, eligible, value }) => {
      if (!eligible) return { ...row, rank: null, eligible: false };
      eligibleCount += 1;
      const rank = previousRank !== null && value === previous ? previousRank : eligibleCount;
      previous = value;
      previousRank = rank;
      return { ...row, rank, eligible: true };
    });
  }

  const DART_SCORES = new Set([0, 25, 50]);
  const DOUBLE_SCORES = new Set([50]);
  for (let value = 1; value <= 20; value += 1) {
    DART_SCORES.add(value);
    DART_SCORES.add(value * 2);
    DART_SCORES.add(value * 3);
    DOUBLE_SCORES.add(value * 2);
  }

  function normalizeDart(input, index) {
    let score;
    let isDouble = false;
    if (typeof input === 'number') {
      score = input;
    } else if (input && typeof input === 'object' && !Array.isArray(input)) {
      if (Object.hasOwn(input, 'value') || Object.hasOwn(input, 'multiplier')) {
        exactKeys(input, ['value', 'multiplier'], `dardo ${index + 1}`);
        if (!Number.isSafeInteger(input.value) || (input.value !== 0 && (input.value < 1 || input.value > 20) && input.value !== 25)
            || ![1, 2, 3].includes(input.multiplier)
            || (input.value === 25 && input.multiplier === 3)
            || (input.value === 0 && input.multiplier !== 1)) {
          throw new RangeError(`Dardo ${index + 1} inválido.`);
        }
        score = input.value * input.multiplier;
        isDouble = input.multiplier === 2;
      } else {
        exactKeys(input, ['score', 'isDouble'], `dardo ${index + 1}`);
        score = input.score;
        if (typeof input.isDouble !== 'boolean') throw new TypeError(`Dardo ${index + 1}: isDouble deve ser boolean.`);
        isDouble = input.isDouble;
      }
    } else {
      throw new TypeError(`Dardo ${index + 1} inválido.`);
    }
    if (!Number.isSafeInteger(score) || !DART_SCORES.has(score)) throw new RangeError(`Dardo ${index + 1}: pontuação impossível.`);
    if (isDouble) {
      if (!DOUBLE_SCORES.has(score)) throw new TypeError(`Dardo ${index + 1}: pontuação não é dupla.`);
    } else if (!(score === 0 || score === 25 || (score >= 1 && score <= 20)
        || (score >= 3 && score <= 60 && score % 3 === 0))) {
      throw new TypeError(`Dardo ${index + 1}: pontuação não representa single, tripla ou bull simples.`);
    }
    return Object.freeze({ score, isDouble });
  }

  function evaluateDartsTurn(balance, throwsList) {
    if (!Number.isSafeInteger(balance) || balance < 1 || balance > 501) throw new RangeError('balance deve estar entre 1 e 501.');
    if (!Array.isArray(throwsList) || throwsList.length < 1 || throwsList.length > 3) throw new RangeError('Informe de 1 a 3 dardos.');
    const normalized = throwsList.map(normalizeDart);
    let remaining = balance;
    for (let index = 0; index < normalized.length; index += 1) {
      const dart = normalized[index];
      const next = remaining - dart.score;
      const bust = next < 0 || next === 1 || (next === 0 && !dart.isDouble);
      const won = next === 0 && dart.isDouble;
      if ((bust || won) && index !== normalized.length - 1) throw new RangeError('Não pode haver dardos após bust ou checkout.');
      if (bust) return Object.freeze({ balance, bust: true, won: false, dartsThrown: index + 1, throws: normalized.slice(0, index + 1) });
      remaining = next;
      if (won) return Object.freeze({ balance: 0, bust: false, won: true, dartsThrown: index + 1, throws: normalized.slice(0, index + 1) });
    }
    return Object.freeze({ balance: remaining, bust: false, won: false, dartsThrown: normalized.length, throws: normalized });
  }

  function toDartsRpcThrows(throwsList) {
    if (!Array.isArray(throwsList) || throwsList.length < 1 || throwsList.length > 3) {
      throw new RangeError('Informe de 1 a 3 dardos.');
    }
    return throwsList.map((dart, index) => {
      const normalized = normalizeDart(dart, index);
      return Object.freeze({ score: normalized.score, is_double: normalized.isDouble });
    });
  }

  return Object.freeze({
    modes: MODE_IDS,
    integrationContract: INTEGRATION_CONTRACT,
    normalizeRules,
    parseExactBigInt,
    validateIndividualResult,
    evaluateMatchSet,
    rankResults,
    evaluateDartsTurn,
    toDartsRpcThrows,
  });
});
