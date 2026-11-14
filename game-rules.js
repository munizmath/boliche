(function attachGameRules(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameRules = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createGameRules() {
  'use strict';

  const MODES = Object.freeze({
    boliche: Object.freeze({ id: 'boliche', label: 'Boliche', unit: 'pontos', allowsOCR: true, allowsTablet: true, rankingDirection: 'desc' }),
    quiz: Object.freeze({ id: 'quiz', label: 'Quiz', unit: 'pontos', allowsOCR: false, allowsTablet: false, rankingDirection: 'desc' }),
    gincana: Object.freeze({ id: 'gincana', label: 'Gincana', unit: 'pontos', allowsOCR: false, allowsTablet: false, rankingDirection: 'desc' }),
    pebolim: Object.freeze({ id: 'pebolim', label: 'Pebolim', unit: 'gols', allowsOCR: false, allowsTablet: false, rankingDirection: 'desc' }),
    sinuca: Object.freeze({ id: 'sinuca', label: 'Sinuca', unit: 'pontos', allowsOCR: false, allowsTablet: false, rankingDirection: 'desc' }),
    tenis_mesa: Object.freeze({ id: 'tenis_mesa', label: 'Tênis de mesa', unit: 'pontos', allowsOCR: false, allowsTablet: false, rankingDirection: 'desc' }),
    truco: Object.freeze({ id: 'truco', label: 'Truco', unit: 'pontos', allowsOCR: false, allowsTablet: false, rankingDirection: 'desc' }),
    pinball: Object.freeze({ id: 'pinball', label: 'Pinball', unit: 'pontos', allowsOCR: false, allowsTablet: false, rankingDirection: 'desc' }),
    minigolfe: Object.freeze({ id: 'minigolfe', label: 'Minigolfe', unit: 'tacadas', allowsOCR: false, allowsTablet: false, rankingDirection: 'asc' }),
    tempo: Object.freeze({ id: 'tempo', label: 'Tempo', unit: 'ms', allowsOCR: false, allowsTablet: false, rankingDirection: 'asc' }),
    dardos_501: Object.freeze({ id: 'dardos_501', label: 'Dardos 501', unit: 'pontos restantes', allowsOCR: false, allowsTablet: false, rankingDirection: 'asc' }),
  });

  const DART_SCORES = new Set([0, 25, 50]);
  const DOUBLE_SCORES = new Set([50]);
  for (let value = 1; value <= 20; value += 1) {
    DART_SCORES.add(value);
    DART_SCORES.add(value * 2);
    DART_SCORES.add(value * 3);
    DOUBLE_SCORES.add(value * 2);
  }

  function getMode(id) {
    if (!Object.prototype.hasOwnProperty.call(MODES, id)) {
      throw new RangeError(`Modalidade desconhecida: ${String(id)}`);
    }
    return MODES[id];
  }

  function isUnranked(row, rawValue) {
    const status = typeof row.status === 'string' ? row.status.trim().toUpperCase() : '';
    const valueStatus = typeof rawValue === 'string' ? rawValue.trim().toUpperCase() : '';
    return row.absent === true
      || row.present === false
      || row.finalized === false
      || row.finalizado === false
      || row.dnf === true
      || row.dns === true
      || ['ABSENT', 'MISSING', 'DNF', 'DNS'].includes(status)
      || ['ABSENT', 'MISSING', 'DNF', 'DNS'].includes(valueStatus);
  }

  function readMetric(row, metric) {
    if (Object.prototype.hasOwnProperty.call(row, metric)) return row[metric];
    if (metric === 'total') {
      for (const key of ['pontos', 'score', 'value']) {
        if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
      }
    }
    return undefined;
  }

  function parsePinballScore(value) {
    if (typeof value === 'bigint') {
      if (value < BigInt(0)) throw new RangeError('A pontuação não pode ser negativa.');
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('Pinball exige inteiro seguro, BigInt ou string decimal exata.');
      }
      return BigInt(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
    throw new TypeError('Pinball exige inteiro não negativo, BigInt ou string decimal exata.');
  }

  function parseNumericScore(value, modeId) {
    if (modeId === 'pinball') return parsePinballScore(value);
    let numeric = value;
    if (typeof numeric === 'string' && numeric.trim() !== '') {
      const source = numeric.trim();
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source)) {
        throw new TypeError('A pontuação deve ser um número finito não negativo.');
      }
      numeric = Number(source);
    }
    if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0) {
      throw new TypeError('A pontuação deve ser um número finito não negativo.');
    }
    if (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) {
      throw new RangeError('Inteiro fora da precisão segura; use string decimal exata para pinball.');
    }
    return numeric;
  }

  /**
   * Rank rows shaped as { total } (or { pontos } / { score }). A custom metric
   * reads that exact property. Rows marked absent, DNF, DNS, or not finalized
   * are returned last with rank:null. Equal eligible values share competition
   * rank (1, 1, 3). Pinball accepts BigInt or an exact decimal string.
   */
  function rankScores(modeId, rows, metric = 'total') {
    const mode = getMode(modeId);
    if (!Array.isArray(rows)) throw new TypeError('rows deve ser um array.');
    if (typeof metric !== 'string' || metric.trim() === '') throw new TypeError('metric deve ser uma string não vazia.');

    const ranked = rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new TypeError('Cada resultado deve ser um objeto.');
      }
      const raw = readMetric(row, metric);
      if (isUnranked(row, raw) || raw === null || raw === undefined) {
        return { row, index, eligible: false, value: null };
      }
      return { row, index, eligible: true, value: parseNumericScore(raw, modeId) };
    });

    ranked.sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (!left.eligible) return left.index - right.index;
      let comparison = 0;
      if (left.value < right.value) comparison = -1;
      else if (left.value > right.value) comparison = 1;
      if (mode.rankingDirection === 'desc') comparison *= -1;
      return comparison || left.index - right.index;
    });

    let previousValue;
    let previousRank = null;
    let eligibleCount = 0;
    return ranked.map(({ row, eligible, value }) => {
      if (!eligible) return { ...row, rank: null, eligible: false };
      eligibleCount += 1;
      const sameAsPrevious = previousRank !== null && value === previousValue;
      const rank = sameAsPrevious ? previousRank : eligibleCount;
      previousValue = value;
      previousRank = rank;
      return { ...row, rank, eligible: true };
    });
  }

  function readSetScore(value, side) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`A pontuação de ${side} deve ser um inteiro não negativo seguro.`);
    }
    return value;
  }

  function readTrucoConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new TypeError('Truco exige config com target e winBy explícitos.');
    }
    if (!Object.prototype.hasOwnProperty.call(config, 'target') || !Object.prototype.hasOwnProperty.call(config, 'winBy')) {
      throw new TypeError('Truco exige config com target e winBy explícitos.');
    }
    const { target, winBy } = config;
    if (!Number.isSafeInteger(target) || target < 1 || !Number.isSafeInteger(winBy) || winBy < 1) {
      throw new TypeError('A configuração de truco exige target e winBy inteiros positivos.');
    }
    return { target, winBy };
  }

  /**
   * Compare one completed set for pebolim/sinuca; a level score stays pending
   * because no tie-break is assumed. Tênis de mesa uses 11 and requires a lead
   * of 2. Truco requires config:{target,winBy}; no regional default is supplied.
   * Results include complete, winner ('a'|'b'|null), tie, leader, and score.
   */
  function evaluateSet(modeId, a, b, config) {
    const mode = getMode(modeId);
    if (!['pebolim', 'sinuca', 'tenis_mesa', 'truco'].includes(modeId)) {
      throw new RangeError(`${mode.label} não é avaliado como confronto por sets.`);
    }
    const scoreA = readSetScore(a, 'a');
    const scoreB = readSetScore(b, 'b');
    const leader = scoreA === scoreB ? null : (scoreA > scoreB ? 'a' : 'b');
    let complete = true;
    let winner = leader;

    if (modeId === 'tenis_mesa') {
      complete = Math.max(scoreA, scoreB) >= 11 && Math.abs(scoreA - scoreB) >= 2;
      if (!complete) winner = null;
    } else if (modeId === 'truco') {
      const { target, winBy } = readTrucoConfig(config);
      complete = Math.max(scoreA, scoreB) >= target && Math.abs(scoreA - scoreB) >= winBy;
      if (!complete) winner = null;
    } else if (scoreA === scoreB) {
      complete = false;
      winner = null;
    }

    return {
      mode: modeId,
      complete,
      winner,
      tie: complete && scoreA === scoreB,
      leader,
      score: { a: scoreA, b: scoreB },
    };
  }

  function normalizeDart(throwValue, index) {
    let score;
    let isDouble = false;

    if (typeof throwValue === 'number') {
      score = throwValue;
    } else if (throwValue && typeof throwValue === 'object' && !Array.isArray(throwValue)) {
      const hasValue = Object.prototype.hasOwnProperty.call(throwValue, 'value');
      const hasMultiplier = Object.prototype.hasOwnProperty.call(throwValue, 'multiplier');
      const hasScore = Object.prototype.hasOwnProperty.call(throwValue, 'score');
      const hasIsDouble = Object.prototype.hasOwnProperty.call(throwValue, 'isDouble');
      if (hasValue || hasMultiplier) {
        if (!hasValue || !hasMultiplier || hasScore || hasIsDouble) {
          throw new TypeError(`Dardo ${index + 1}: use somente {value,multiplier} ou {score,isDouble}.`);
        }
        const value = throwValue.value;
        const multiplier = throwValue.multiplier;
        if (!Number.isSafeInteger(value) || (value !== 0 && (value < 1 || value > 20) && value !== 25)) {
          throw new TypeError(`Dardo ${index + 1}: value deve ser 0, 1–20 ou 25.`);
        }
        if (![1, 2, 3].includes(multiplier) || (value === 25 && multiplier === 3) || (value === 0 && multiplier !== 1)) {
          throw new TypeError(`Dardo ${index + 1}: multiplier inválido.`);
        }
        score = value * multiplier;
        isDouble = multiplier === 2;
      } else if (hasScore) {
        score = throwValue.score;
        if (throwValue.isDouble !== undefined && typeof throwValue.isDouble !== 'boolean') {
          throw new TypeError(`Dardo ${index + 1}: isDouble deve ser booleano.`);
        }
        isDouble = throwValue.isDouble === true;
      } else {
        throw new TypeError(`Dardo ${index + 1}: use um número ou {score,isDouble} / {value,multiplier}.`);
      }
    } else {
      throw new TypeError(`Dardo ${index + 1}: formato inválido.`);
    }

    if (!Number.isSafeInteger(score) || !DART_SCORES.has(score)) {
      throw new RangeError(`Dardo ${index + 1}: pontuação impossível em um único lançamento.`);
    }
    if (isDouble && !DOUBLE_SCORES.has(score)) {
      throw new TypeError(`Dardo ${index + 1}: a pontuação informada não representa uma saída dupla.`);
    }
    return { score, isDouble };
  }

  /**
   * Apply 1–3 darts to a balance from 1 to 501. Throws may be legal numeric
   * scores or {score,isDouble}/{value,multiplier}; numeric scores cannot finish
   * a leg because they carry no double-out proof. Bust restores the turn-start
   * balance. A completed double checkout ends the leg immediately.
   */
  function evaluateDartsTurn(balance, throwsList) {
    if (!Number.isSafeInteger(balance) || balance < 1 || balance > 501) {
      throw new RangeError('balance deve ser um inteiro entre 1 e 501.');
    }
    if (!Array.isArray(throwsList) || throwsList.length < 1 || throwsList.length > 3) {
      throw new RangeError('throws deve conter de 1 a 3 lançamentos.');
    }
    const normalizedThrows = throwsList.map(normalizeDart);
    let remaining = balance;

    for (let index = 0; index < normalizedThrows.length; index += 1) {
      const dart = normalizedThrows[index];
      const nextBalance = remaining - dart.score;
      const bust = nextBalance < 0 || nextBalance === 1 || (nextBalance === 0 && !dart.isDouble);
      const won = nextBalance === 0 && dart.isDouble;
      if ((bust || won) && index !== normalizedThrows.length - 1) {
        throw new RangeError('Não pode haver lançamentos depois de bust ou fechamento.');
      }
      if (bust) {
        return {
          balance,
          bust: true,
          won: false,
          dartsThrown: index + 1,
          throws: normalizedThrows.slice(0, index + 1),
        };
      }
      remaining = nextBalance;
      if (won) {
        return {
          balance: 0,
          bust: false,
          won: true,
          dartsThrown: index + 1,
          throws: normalizedThrows.slice(0, index + 1),
        };
      }
    }

    return {
      balance: remaining,
      bust: false,
      won: false,
      dartsThrown: normalizedThrows.length,
      throws: normalizedThrows,
    };
  }

  function formatResult(modeId, value) {
    const mode = getMode(modeId);
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.status === 'string') return formatResult(modeId, value.status);
      if (Object.prototype.hasOwnProperty.call(value, 'value')) return formatResult(modeId, value.value);
      throw new TypeError('Resultado em objeto deve informar status ou value.');
    }
    if (typeof value === 'string') {
      const status = value.trim().toUpperCase();
      if (['DNF', 'DNS'].includes(status)) return status;
      if (['ABSENT', 'MISSING', 'AUSENTE'].includes(status)) return 'Ausente';
    }
    const parsed = parseNumericScore(value, modeId);
    const formatted = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(parsed);
    return `${formatted} ${mode.unit}`;
  }

  return Object.freeze({ getMode, rankScores, evaluateSet, evaluateDartsTurn, formatResult });
});
