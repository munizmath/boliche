(function attachAdvancedRanking(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdvancedRanking = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createAdvancedRanking() {
  'use strict';

  const MAX_BIGINT = 9223372036854775807n;
  const MODES = Object.freeze({
    pebolim: { kind: 'match', unit: 'vitórias', lower: false },
    sinuca: { kind: 'match', unit: 'vitórias', lower: false },
    tenis_mesa: { kind: 'match', unit: 'vitórias', lower: false },
    truco: { kind: 'match', unit: 'vitórias', lower: false },
    pinball: { kind: 'individual', unit: 'pontos', lower: false, metricKey: 'pinball_points' },
    minigolfe: { kind: 'individual', unit: 'tacadas', lower: true, metricKey: 'minigolfe_strokes' },
    tempo: { kind: 'individual', unit: 'ms', lower: true, metricKey: 'tempo_elapsed_ms' },
    dardos_501: { kind: 'darts', unit: 'vitórias', lower: false },
  });
  const METRICS = new Set(['total', 'average', 'best', 'games']);

  function exactValue(raw) {
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
    const value = BigInt(raw);
    return value <= MAX_BIGINT ? value : null;
  }

  function gcd(left, right) {
    while (right) [left, right] = [right, left % right];
    return left;
  }

  // A finite decimal is shown in full. Repeating decimals stay as exact fractions.
  function averageText(total, count) {
    if (!count) return null;
    const divisor = gcd(total, BigInt(count));
    const numerator = total / divisor;
    const denominator = BigInt(count) / divisor;
    if (denominator === 1n) return numerator.toString();
    let rest = denominator;
    let twos = 0;
    let fives = 0;
    while (rest % 2n === 0n) { rest /= 2n; twos += 1; }
    while (rest % 5n === 0n) { rest /= 5n; fives += 1; }
    if (rest !== 1n) return `${numerator}/${denominator}`;
    const places = Math.max(twos, fives);
    const scaled = numerator * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives);
    const digits = scaled.toString().padStart(places + 1, '0');
    return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  }

  function validRows(mode, game, feed) {
    const rows = feed?.rows;
    if (!Array.isArray(rows) || !rows.length) return null;
    const ids = new Set();
    const winnerField = mode.kind === 'match' ? 'winner_player_id' : 'match_winner_player_id';
    let winner;
    for (const row of rows) {
      if (!row || typeof row.player_id !== 'string' || !row.player_id || ids.has(row.player_id)
          || (row.game_id != null && row.game_id !== game.id)) return null;
      ids.add(row.player_id);
      if (mode.kind === 'individual') {
        if (row.finalized !== true || !['active', 'DNF', 'DNS'].includes(row.status)
            || (row.metric_key != null && row.metric_key !== mode.metricKey)) return null;
        if (row.status === 'active' && exactValue(row.value_text) === null) return null;
        if (row.status !== 'active' && row.value_text != null) return null;
      } else {
        if (row.match_complete === false || typeof row[winnerField] !== 'string' || !row[winnerField]) return null;
        if (winner != null && winner !== row[winnerField]) return null;
        winner = row[winnerField];
      }
    }
    if (mode.kind !== 'individual' && !ids.has(winner)) return null;
    return rows;
  }

  function aggregateOfficial(modeId, finalGames, feedsByGame, metric = 'total') {
    const mode = MODES[modeId];
    if (!mode) throw new RangeError(`Modalidade avançada desconhecida: ${String(modeId)}`);
    if (!METRICS.has(metric)) throw new RangeError(`Métrica desconhecida: ${String(metric)}`);
    if (!Array.isArray(finalGames) || !(feedsByGame instanceof Map)) {
      throw new TypeError('Informe finalGames como array e feedsByGame como Map.');
    }
    const players = new Map();
    const missingGameIds = [];
    const seenGames = new Set();
    for (const game of finalGames) {
      if (!game || typeof game.id !== 'string' || !game.id) throw new TypeError('Partida finalizada sem id.');
      if (seenGames.has(game.id) || (game.status != null && game.status !== 'final')) continue;
      seenGames.add(game.id);
      const rows = validRows(mode, game, feedsByGame.get(game.id));
      if (!rows) { missingGameIds.push(game.id); continue; }
      const winnerField = mode.kind === 'match' ? 'winner_player_id' : 'match_winner_player_id';
      for (const row of rows) {
        if (row.status === 'DNS') continue;
        const played = players.get(row.player_id) || { player_id: row.player_id, games_count: 0, results_count: 0,
          total: 0n, best: null };
        if (mode.kind === 'individual') {
          // DNF is a participation, but has no numeric result or average divisor.
          if (row.status === 'active') {
            const value = exactValue(row.value_text);
            played.results_count += 1;
            played.total += value;
            if (played.best === null || (mode.lower ? value < played.best : value > played.best)) played.best = value;
          }
        } else {
          const value = row.player_id === row[winnerField] ? 1n : 0n;
          played.results_count += 1;
          played.total += value;
          if (played.best === null || value > played.best) played.best = value;
        }
        played.games_count += 1;
        players.set(row.player_id, played);
      }
    }

    const hasValue = (row) => metric === 'games' || row.results_count > 0;
    const compare = (left, right) => {
      if (hasValue(left) !== hasValue(right)) return hasValue(left) ? -1 : 1;
      if (!hasValue(left)) return 0;
      let difference;
      if (metric === 'games') difference = BigInt(left.games_count) - BigInt(right.games_count);
      else if (metric === 'average') difference = left.total * BigInt(right.results_count) - right.total * BigInt(left.results_count);
      else if (metric === 'best') difference = left.best - right.best;
      else difference = left.total - right.total;
      if (difference === 0n) return 0;
      const lower = metric !== 'games' && mode.lower;
      return (difference < 0n) === lower ? -1 : 1;
    };
    const sorted = [...players.values()].sort((left, right) => compare(left, right)
      || left.player_id.localeCompare(right.player_id));
    let previous = null;
    let previousRank = null;
    const rows = sorted.map((item, index) => {
      const eligible = hasValue(item);
      const rank = eligible ? previous && compare(previous, item) === 0 ? previousRank : index + 1 : null;
      if (eligible) { previous = item; previousRank = rank; }
      const displayValue = !eligible ? '—' : metric === 'games' ? String(item.games_count)
        : metric === 'average' ? averageText(item.total, item.results_count)
          : metric === 'best' ? item.best.toString() : item.total.toString();
      return Object.freeze({ player_id: item.player_id, rank, games_count: item.games_count,
        results_count: item.results_count, displayValue,
        metricLabel: { total: 'Total', average: 'Média', best: 'Melhor resultado', games: 'Partidas' }[metric],
        unitLabel: metric === 'games' ? 'partidas' : metric === 'average'
          ? `${mode.unit}/${mode.kind === 'individual' ? 'resultado' : 'partida'}` : mode.unit });
    });
    return Object.freeze({ rows: Object.freeze(rows), missingGameIds: Object.freeze(missingGameIds) });
  }

  return Object.freeze({ aggregateOfficial });
});
