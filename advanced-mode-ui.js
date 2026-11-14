(function attachAdvancedModeUI(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdvancedModeUI = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createModule() {
  'use strict';

  const READ_RPC = Object.freeze({ match: 'get_match_results', individual: 'get_mode_player_scores', darts: 'get_darts_match_results' });
  const TABLES = Object.freeze({ match: ['match_sets', 'match_player_status'], individual: [], darts: ['darts_legs', 'darts_leg_players', 'darts_turns'] });
  // v19 runs leg creation and the first turn in one database transaction.
  const FIRST_DARTS_TURN_RPC = 'start_darts_leg_and_save_turn';
  const TERMINAL = new Set(['DNF', 'DNS']);

  // getActive() returns the current encounter ({id,game_type,status,rules_config}).
  // state exposes games, scores, players and activeGameId. This module never
  // subscribes to Realtime or changes state; call render/refreshFeed on updates.
  function create({ document, client, state, getActive, reload, isAdmin, showToast, logic, presentations }) {
    if (!document?.getElementById || !client?.rpc || !client?.from || !state || typeof getActive !== 'function'
        || typeof reload !== 'function' || typeof isAdmin !== 'function' || typeof showToast !== 'function'
        || !logic?.rankResults || !logic?.evaluateMatchSet || !logic?.validateIndividualResult
        || !logic?.evaluateDartsTurn || !logic?.toDartsRpcThrows || !presentations?.getAdvanced) {
      throw new TypeError('AdvancedModeUI.create requer document, client, state, getActive, reload, isAdmin, showToast, logic e presentations.');
    }

    const ids = presentations.advancedDom;
    const element = (id) => document.getElementById(id);
    const scoreDialog = element(ids.scoreDialogId);
    const statusDialog = element(ids.statusDialogId);
    const scoreForm = element(ids.scoreFormId);
    const statusForm = element(ids.statusFormId);
    const scoreSave = element(ids.saveButtonId);
    const statusSave = element(ids.statusSaveButtonId);
    const scoreError = element(ids.errorId);
    const statusError = element('advancedStatusError');
    if ([scoreDialog, statusDialog, scoreForm, statusForm, scoreSave, statusSave, scoreError, statusError].some((node) => !node)) {
      throw new Error('Diálogos avançados não encontrados no DOM.');
    }

    const feeds = new Map();
    const scoreSaveLabel = scoreSave.textContent;
    const statusSaveLabel = statusSave.textContent;
    const fetchVersions = new Map();
    const listeners = [];
    let active = null;
    let initialized = false;

    const modeOf = (id) => presentations.getAdvanced(id);
    const current = () => {
      const encounter = getActive();
      return encounter ? {
        id: encounter.id ?? encounter.encounterId,
        modeId: encounter.game_type ?? encounter.modeId,
        status: encounter.status,
        rules: encounter.rules_config ?? encounter.rulesConfig ?? {},
      } : null;
    };
    const keyOf = (modeId, gameId) => `${modeId}:${gameId}`;
    const field = (panel, name) => panel.querySelector(`[name="${name}"]`);
    const value = (panel, name) => field(panel, name)?.value ?? '';
    const setValue = (panel, name, next) => { const control = field(panel, name); if (control) control.value = next == null ? '' : String(next); };
    const gameFor = (gameId) => (state.games || []).find((game) => game.id === gameId);
    const playerIds = (gameId) => [...new Set((state.scores || []).filter((row) => row.game_id === gameId).map((row) => row.player_id))];
    const validGame = (gameId) => {
      const game = gameFor(gameId);
      return game && game.encounter_id === current()?.id ? game : null;
    };
    const integer = (raw, min, max, label) => {
      if (!/^(0|[1-9][0-9]*)$/.test(String(raw))) throw new Error(`${label}: informe um inteiro.`);
      const number = Number(raw);
      if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label}: valor fora do intervalo.`);
      return number;
    };
    const version = (raw) => raw === '' || raw == null ? null : integer(raw, 1, 2147483647, 'Versão');

    function announceError(message, view = active) {
      if (!view) return;
      const target = view.kind === 'score' ? scoreError : statusError;
      target.textContent = message;
      target.hidden = !message;
    }

    function setBusy(view, busy, label) {
      if (!view || active !== view) return;
      view.busy = busy;
      view.panel.disabled = busy;
      view.form.setAttribute('aria-busy', String(busy));
      view.save.textContent = busy ? label : view.originalSaveLabel;
      validate();
    }

    function fillSelect(select, rows, placeholder, preferred, preserveMissing = false) {
      if (!select) return;
      const old = preferred ?? select.value ?? '';
      const options = [{ value: '', label: placeholder }, ...rows];
      if (preserveMissing && old && !options.some((item) => item.value === old)) {
        options.push({ value: old, label: 'Seleção removida', disabled: true });
      }
      const nodes = options.map((item) => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        option.disabled = Boolean(item.disabled);
        return option;
      });
      select.replaceChildren(...nodes);
      select.value = options.some((item) => item.value === old) ? old : '';
    }

    function render(preferredGameId) {
      if (!active) return null;
      const view = active;
      const encounter = current();
      if (!encounter || encounter.id !== view.encounterId || encounter.modeId !== view.modeId) {
        view.conflict = true;
        announceError('O encontro selecionado mudou. Feche e abra o formulário novamente.', view);
        validate();
        return null;
      }
      const games = (state.games || []).filter((game) => game.encounter_id === encounter.id)
        .map((game) => ({ value: game.id, label: game.nome || 'Partida' }));
      const gameSelect = field(view.panel, 'p_game_id');
      const previousGameId = gameSelect?.value || '';
      // A state render (including Realtime) must never move an unsaved form to
      // another game. Explicit user changes go through onFieldEvent below.
      const nextGameId = view.dirty && preferredGameId != null && preferredGameId !== previousGameId
        ? previousGameId : preferredGameId;
      if (!view.dirty && nextGameId != null && nextGameId !== previousGameId) {
        resetContextFields(view, 'p_game_id');
        view.feedLoaded = false;
        view.baseSignature = null;
        view.feedRequest += 1;
        if (view.busy) setBusy(view, false);
      }
      fillSelect(gameSelect, games, 'Selecione a partida', nextGameId, true);
      const gameId = gameSelect?.value || '';
      const roster = playerIds(gameId).map((id) => {
        const player = (state.players || []).find((item) => item.id === id);
        return { value: id, label: player?.nome || 'Jogador' };
      });
      for (const name of ['p_player_a_id', 'p_player_b_id', 'p_player_id', 'p_starter_player_id']) {
        const select = field(view.panel, name);
        if (select) fillSelect(select, roster, name === 'p_starter_player_id' ? 'Perna já iniciada' : 'Selecione o jogador', undefined, true);
      }
      if (view.kind === 'score' && view.mode.kind === 'match' && roster.length === 2 && !view.dirty) {
        if (!value(view.panel, 'p_player_a_id')) setValue(view.panel, 'p_player_a_id', roster[0].value);
        if (!value(view.panel, 'p_player_b_id')) setValue(view.panel, 'p_player_b_id', roster[1].value);
      }
      if (!view.dirty && previousGameId !== gameId) rememberContext(view);
      validate();
      return view;
    }

    function resetContextFields(view, changedName) {
      const panel = view.panel;
      const entryNames = view.kind === 'score' ? view.mode.entryFields : view.mode.statusFields;
      let names;
      if (changedName === 'p_game_id') names = entryNames.filter((name) => name !== 'p_game_id');
      else if (changedName === 'p_set_no') names = ['p_score_a', 'p_score_b', 'p_confirmed', 'p_expected_version'];
      else if (changedName === 'p_player_id') names = view.kind === 'status'
        ? ['p_status', 'p_expected_version'] : view.mode.kind === 'darts'
          ? ['dart_1_value', 'dart_2_value', 'dart_3_value', 'dart_1_multiplier', 'dart_2_multiplier', 'dart_3_multiplier']
          : ['p_value', 'p_status', 'p_finalized', 'p_expected_version'];
      else if (changedName === 'p_player_a_id' || changedName === 'p_player_b_id') {
        names = ['p_score_a', 'p_score_b', 'p_confirmed', 'p_expected_version'];
      } else if (changedName === 'p_starter_player_id') {
        names = ['p_player_id', 'dart_1_value', 'dart_2_value', 'dart_3_value',
          'dart_1_multiplier', 'dart_2_multiplier', 'dart_3_multiplier'];
      }
      else names = view.kind === 'status'
        ? ['p_player_id', 'p_status']
        : ['p_starter_player_id', 'p_turn_no', 'p_player_id', 'dart_1_value', 'dart_2_value', 'dart_3_value',
          'dart_1_multiplier', 'dart_2_multiplier', 'dart_3_multiplier'];
      for (const name of names) {
        const control = field(panel, name);
        if (!control) continue;
        if (control.type === 'checkbox') control.checked = false;
        else control.value = name === 'p_status' && view.mode.kind === 'individual' ? 'active'
          : name.endsWith('_multiplier') ? '1' : '';
      }
      if (view.mode.kind === 'individual') syncIndividualStatus(view);
    }

    async function rpc(name, args) {
      const response = await client.rpc(name, args);
      if (response?.error) throw response.error;
      if (!response || !Object.hasOwn(response, 'data')) throw new Error(`Resposta inválida de ${name}.`);
      return response.data;
    }

    async function tableRows(table, gameId) {
      const response = await client.from(table).select('*').eq('game_id', gameId);
      if (response?.error) throw response.error;
      if (!Array.isArray(response?.data)) throw new Error(`Resposta inválida de ${table}.`);
      return response.data;
    }

    function getRankingFeed(modeId, gameId) {
      return feeds.get(keyOf(modeId, gameId)) || null;
    }

    function signature(view, feed) {
      const panel = view.panel;
      if (view.kind === 'status' && view.mode.kind === 'match') {
        const row = feed.details.match_player_status.find((item) => item.player_id === value(panel, 'p_player_id'));
        return row ? `status:${row.player_id}:${row.version}` : 'status:new';
      }
      if (view.kind === 'status') {
        const legNo = Number(value(panel, 'p_leg_no'));
        const row = feed.details.darts_leg_players.find((item) => item.player_id === value(panel, 'p_player_id') && Number(item.leg_no) === legNo);
        return row ? `darts-status:${legNo}:${row.player_id}:${row.status}:${row.balance}` : `darts-status:${legNo}:new`;
      }
      if (view.mode.kind === 'match') {
        const row = feed.details.match_sets.find((item) => Number(item.set_no) === Number(value(panel, 'p_set_no')));
        return row ? `set:${row.set_no}:${row.version}` : `set:${value(panel, 'p_set_no')}:new`;
      }
      if (view.mode.kind === 'individual') {
        const row = feed.rows.find((item) => item.player_id === value(panel, 'p_player_id'));
        return row ? `result:${row.player_id}:${row.version}` : `result:${value(panel, 'p_player_id')}:new`;
      }
      const legNo = Number(value(panel, 'p_leg_no'));
      const leg = feed.details.darts_legs.find((item) => Number(item.leg_no) === legNo);
      const turns = feed.details.darts_turns.filter((item) => Number(item.leg_no) === legNo);
      const players = feed.details.darts_leg_players.filter((item) => Number(item.leg_no) === legNo);
      return `turn:${legNo}:${leg?.status || 'new'}:${turns.length}:${players.map((item) => `${item.player_id}:${item.status}:${item.balance}`).join('|')}`;
    }

    function hydrate(view, feed) {
      if (active !== view || view.dirty || value(view.panel, 'p_game_id') !== feed.gameId) return;
      const panel = view.panel;
      if (view.kind === 'status' && view.mode.kind === 'match') {
        const row = feed.details.match_player_status.find((item) => item.player_id === value(panel, 'p_player_id'));
        setValue(panel, 'p_status', row?.status || '');
        setValue(panel, 'p_expected_version', row?.version);
      } else if (view.kind === 'status') {
        const lastLeg = feed.details.darts_legs.at(-1);
        if (!value(panel, 'p_leg_no') && lastLeg) setValue(panel, 'p_leg_no', lastLeg.leg_no);
      } else if (view.mode.kind === 'match') {
        const row = feed.details.match_sets.find((item) => Number(item.set_no) === Number(value(panel, 'p_set_no')));
        setValue(panel, 'p_score_a', row?.score_a);
        setValue(panel, 'p_score_b', row?.score_b);
        if (row) {
          setValue(panel, 'p_player_a_id', row.player_a_id);
          setValue(panel, 'p_player_b_id', row.player_b_id);
        }
        field(panel, 'p_confirmed').checked = Boolean(row?.confirmed);
        setValue(panel, 'p_expected_version', row?.version);
      } else if (view.mode.kind === 'individual') {
        const row = feed.rows.find((item) => item.player_id === value(panel, 'p_player_id'));
        setValue(panel, 'p_value', row?.value_text);
        setValue(panel, 'p_status', row?.status || 'active');
        field(panel, 'p_finalized').checked = Boolean(row?.finalized);
        setValue(panel, 'p_expected_version', row?.version);
        syncIndividualStatus(view);
      } else {
        const legs = feed.details.darts_legs;
        const latest = legs.at(-1);
        if (!value(panel, 'p_leg_no')) setValue(panel, 'p_leg_no', latest?.status === 'active' ? latest.leg_no : Number(latest?.leg_no || 0) + 1);
        const legNo = Number(value(panel, 'p_leg_no'));
        const turns = feed.details.darts_turns.filter((item) => Number(item.leg_no) === legNo);
        if (!value(panel, 'p_turn_no')) setValue(panel, 'p_turn_no', turns.length + 1);
      }
      view.baseSignature = signature(view, feed);
      rememberContext(view);
      validate();
    }

    function rememberContext(view) {
      view.contextValues = Object.fromEntries(['p_game_id', 'p_set_no', 'p_player_id', 'p_leg_no',
        'p_player_a_id', 'p_player_b_id', 'p_starter_player_id']
        .map((name) => [name, value(view.panel, name)]));
    }

    async function refreshFeed(modeId = current()?.modeId, gameId = active ? value(active.panel, 'p_game_id') : state.activeGameId) {
      const mode = modeOf(modeId);
      if (!mode || !gameId || !validGame(gameId)) throw new Error('Modalidade ou partida inválida.');
      const key = keyOf(modeId, gameId);
      const ticket = (fetchVersions.get(key) || 0) + 1;
      fetchVersions.set(key, ticket);
      const view = active && active.modeId === modeId && value(active.panel, 'p_game_id') === gameId ? active : null;
      const viewRequest = view ? ++view.feedRequest : null;
      const currentViewRead = () => view && active === view && view.feedRequest === viewRequest
        && value(view.panel, 'p_game_id') === gameId;
      if (view) setBusy(view, true, 'Carregando…');
      try {
        const [rows, ...tables] = await Promise.all([
          rpc(READ_RPC[mode.kind], { p_game_id: gameId }),
          ...TABLES[mode.kind].map((table) => tableRows(table, gameId)),
        ]);
        if (!Array.isArray(rows)) throw new Error('Feed de ranking inválido.');
        const details = Object.fromEntries(TABLES[mode.kind].map((table, index) => [table, tables[index]]));
        if (mode.kind === 'match') details.match_sets = [...details.match_sets].sort((a, b) => a.set_no - b.set_no);
        if (mode.kind === 'darts') {
          details.darts_legs = [...details.darts_legs].sort((a, b) => a.leg_no - b.leg_no);
          details.darts_leg_players = [...details.darts_leg_players].sort((a, b) => a.leg_no - b.leg_no || a.turn_order - b.turn_order);
          details.darts_turns = [...details.darts_turns].sort((a, b) => a.leg_no - b.leg_no || a.turn_no - b.turn_no);
        }
        const feed = Object.freeze({ modeId, gameId, rows: Object.freeze([...rows]), rankedRows: Object.freeze(logic.rankResults(modeId, rows)), details: Object.freeze(details) });
        if (ticket !== fetchVersions.get(key)) return feeds.get(key) || feed;
        feeds.set(key, feed);
        if (currentViewRead()) {
          view.feedLoaded = true;
          if (view.dirty && view.baseSignature !== signature(view, feed)) {
            view.conflict = true;
            announceError('O resultado mudou durante a edição. O rascunho foi mantido; feche e abra novamente para revisar.', view);
          } else if (!view.dirty) {
            hydrate(view, feed);
          }
        }
        return feed;
      } catch (error) {
        if (currentViewRead() && ticket === fetchVersions.get(key)) {
          view.feedLoaded = false;
          announceError(`Não foi possível carregar resultados: ${error.message || 'tente novamente'}.`, view);
        }
        throw error;
      } finally {
        if (currentViewRead() && ticket === fetchVersions.get(key)) setBusy(view, false);
      }
    }

    function requireWritable(view) {
      const encounter = current();
      if (!isAdmin() || !encounter || encounter.id !== view.encounterId || encounter.modeId !== view.modeId || encounter.status !== 'active') {
        throw new Error('O encontro precisa estar ativo e a conta precisa ser administradora.');
      }
      const gameId = value(view.panel, 'p_game_id');
      if (!validGame(gameId)) throw new Error('Escolha uma partida deste encontro.');
      return { gameId, roster: playerIds(gameId), rules: encounter.rules };
    }

    function buildScore(view) {
      const { gameId, roster, rules } = requireWritable(view);
      const panel = view.panel;
      if (view.mode.kind === 'match') {
        if (roster.length !== 2) throw new Error('O confronto precisa ter exatamente dois jogadores.');
        const playerA = value(panel, 'p_player_a_id');
        const playerB = value(panel, 'p_player_b_id');
        if (!roster.includes(playerA) || !roster.includes(playerB) || playerA === playerB) throw new Error('Escolha os dois jogadores do confronto.');
        const setNo = integer(value(panel, 'p_set_no'), 1, 99, 'Set');
        const scoreA = integer(value(panel, 'p_score_a'), 0, 1000000, 'Placar A');
        const scoreB = integer(value(panel, 'p_score_b'), 0, 1000000, 'Placar B');
        const confirmed = field(panel, 'p_confirmed').checked;
        const feed = getRankingFeed(view.modeId, gameId);
        const sets = feed?.details.match_sets || [];
        if (feed?.details.match_player_status.length) throw new Error('O confronto já tem uma situação terminal.');
        const existing = sets.find((row) => Number(row.set_no) === setNo);
        if (setNo > Math.max(0, ...sets.map((row) => Number(row.set_no))) + 1) throw new Error('Registre os sets em sequência.');
        if (sets.some((row) => row.player_a_id !== playerA || row.player_b_id !== playerB)) {
          throw new Error('Mantenha a ordem dos jogadores em todos os sets.');
        }
        for (let prior = 1; prior < setNo; prior += 1) {
          if (!sets.some((row) => Number(row.set_no) === prior && row.confirmed)) {
            throw new Error('Confirme os sets anteriores primeiro.');
          }
        }
        if (existing && sets.some((row) => Number(row.set_no) > setNo && row.confirmed)) {
          throw new Error('Corrija primeiro os sets confirmados posteriores.');
        }
        const wins = new Map();
        for (const row of sets) {
          if (Number(row.set_no) !== setNo && row.confirmed && row.winner_player_id) {
            wins.set(row.winner_player_id, (wins.get(row.winner_player_id) || 0) + 1);
          }
        }
        if ([...wins.values()].some((count) => count >= rules.sets_to_win)) throw new Error('O confronto já foi decidido.');
        if (confirmed && !logic.evaluateMatchSet(view.modeId, scoreA, scoreB, rules).complete) throw new Error('O set ainda não atingiu as regras para confirmação.');
        return { p_game_id: gameId, p_set_no: setNo, p_player_a_id: playerA, p_player_b_id: playerB,
          p_score_a: scoreA, p_score_b: scoreB, p_confirmed: confirmed, p_expected_version: version(value(panel, 'p_expected_version')) };
      }
      if (view.mode.kind === 'individual') {
        const playerId = value(panel, 'p_player_id');
        if (!roster.includes(playerId)) throw new Error('Escolha um jogador da partida.');
        const status = value(panel, 'p_status');
        const finalized = field(panel, 'p_finalized').checked;
        const raw = status === 'active' ? value(panel, 'p_value') : null;
        const result = logic.validateIndividualResult(view.modeId, raw, status, finalized);
        return { p_game_id: gameId, p_player_id: playerId, p_value: result.value, p_status: result.status,
          p_finalized: result.finalized, p_expected_version: version(value(panel, 'p_expected_version')) };
      }
      if (roster.length < 2 || roster.length > 4) throw new Error('A partida de dardos precisa ter de dois a quatro jogadores.');
      const legNo = integer(value(panel, 'p_leg_no'), 1, 99, 'Perna');
      const turnNo = integer(value(panel, 'p_turn_no'), 1, 2147483647, 'Turno');
      const playerId = value(panel, 'p_player_id');
      const starterId = value(panel, 'p_starter_player_id');
      if (!roster.includes(playerId) || (starterId && !roster.includes(starterId))) throw new Error('Escolha jogadores da partida.');
      const feed = getRankingFeed(view.modeId, gameId);
      const leg = feed?.details.darts_legs.find((item) => Number(item.leg_no) === legNo);
      const turns = (feed?.details.darts_turns || []).filter((item) => Number(item.leg_no) === legNo).sort((a, b) => a.turn_no - b.turn_no);
      if ((!leg && !starterId) || (leg && starterId && starterId !== leg.starter_player_id)) {
        throw new Error('Informe quem inicia uma nova perna ou escolha uma perna já iniciada.');
      }
      if (leg && leg.status !== 'active') throw new Error('Escolha uma perna ativa.');
      if (!leg && legNo !== Number(feed?.details.darts_legs.at(-1)?.leg_no || 0) + 1) {
        throw new Error('A nova perna precisa ser a próxima da partida.');
      }
      if (!leg && (feed?.details.darts_legs.some((item) => item.status === 'active')
          || feed?.rows.some((row) => row.match_complete))) throw new Error('A partida já tem uma perna ativa ou foi decidida.');
      if (turnNo !== turns.length + 1) throw new Error('O número do turno precisa ser o próximo da perna.');
      const lastPlayer = turns.at(-1)?.player_id;
      const firstPlayer = leg?.starter_player_id || starterId;
      const legPlayers = (feed?.details.darts_leg_players || []).filter((item) => Number(item.leg_no) === legNo && item.status === 'active');
      const lastOrder = legPlayers.find((item) => item.player_id === lastPlayer)?.turn_order
        ?? feed?.details.darts_leg_players.find((item) => Number(item.leg_no) === legNo && item.player_id === lastPlayer)?.turn_order;
      const nextPlayer = lastPlayer ? [...legPlayers].sort((a, b) =>
        Number(a.turn_order <= lastOrder) - Number(b.turn_order <= lastOrder) || a.turn_order - b.turn_order)[0] : null;
      const expectedPlayer = nextPlayer?.player_id || (lastPlayer ? null : firstPlayer);
      if (expectedPlayer && playerId !== expectedPlayer) throw new Error('Selecione o jogador da vez.');
      if (leg && !legPlayers.some((item) => item.player_id === playerId)) throw new Error('Jogador fora da perna ativa.');
      const throws = [];
      let missing = false;
      for (let index = 1; index <= 3; index += 1) {
        const raw = value(panel, `dart_${index}_value`);
        if (raw === '') { missing = true; continue; }
        if (missing) throw new Error('Preencha os dardos na ordem, sem lacunas.');
        throws.push({ value: integer(raw, 0, 25, `Dardo ${index}`), multiplier: integer(value(panel, `dart_${index}_multiplier`), 1, 3, 'Multiplicador') });
      }
      const playerRow = feed?.details.darts_leg_players.find((row) => row.player_id === playerId && Number(row.leg_no) === legNo);
      const balance = leg ? playerRow?.balance : 501;
      if (!Number.isInteger(balance)) throw new Error('Saldo de dardos indisponível; recarregue a partida.');
      const evaluated = logic.evaluateDartsTurn(balance, throws);
      const rpcThrows = logic.toDartsRpcThrows(evaluated.throws);
      const turn = { p_game_id: gameId, p_leg_no: legNo, p_turn_no: turnNo, p_player_id: playerId, p_throws: rpcThrows };
      return {
        firstTurn: leg ? null : { ...turn, p_starter_player_id: starterId },
        turn,
      };
    }

    function buildStatus(view) {
      const { gameId, roster, rules } = requireWritable(view);
      const playerId = value(view.panel, 'p_player_id');
      const status = value(view.panel, 'p_status');
      if (!roster.includes(playerId) || !TERMINAL.has(status)) throw new Error('Escolha jogador e situação DNF ou DNS.');
      if (view.mode.kind === 'match') {
        if (roster.length !== 2) throw new Error('O confronto precisa ter exatamente dois jogadores.');
        const feed = getRankingFeed(view.modeId, gameId);
        const sets = feed?.details.match_sets || [];
        if (feed?.details.match_player_status.some((row) => row.player_id !== playerId)) {
          throw new Error('O outro jogador já tem uma situação terminal.');
        }
        if (status === 'DNS' && sets.some((row) => row.confirmed)) {
          throw new Error('DNS só é permitido antes do primeiro set confirmado.');
        }
        const wins = new Map();
        for (const row of sets) {
          if (row.confirmed && row.winner_player_id) wins.set(row.winner_player_id, (wins.get(row.winner_player_id) || 0) + 1);
        }
        if ([...wins.values()].some((count) => count >= rules.sets_to_win)) throw new Error('O confronto já foi decidido.');
        return { p_game_id: gameId, p_player_id: playerId, p_status: status, p_expected_version: version(value(view.panel, 'p_expected_version')) };
      }
      const legNo = integer(value(view.panel, 'p_leg_no'), 1, 99, 'Perna');
      const feed = getRankingFeed(view.modeId, gameId);
      if (!feed?.details.darts_legs.some((leg) => Number(leg.leg_no) === legNo && leg.status === 'active')
          || !feed.details.darts_leg_players.some((row) => Number(row.leg_no) === legNo && row.player_id === playerId && row.status === 'active')) {
        throw new Error('Escolha um jogador de uma perna ativa.');
      }
      if (status === 'DNS' && feed.details.darts_turns.some((row) => Number(row.leg_no) === legNo && row.player_id === playerId)) {
        throw new Error('DNS só é permitido antes do primeiro turno do jogador.');
      }
      return { p_game_id: gameId, p_leg_no: legNo, p_player_id: playerId, p_status: status };
    }

    function syncIndividualStatus(view) {
      if (view.kind !== 'score' || view.mode.kind !== 'individual') return;
      const terminal = TERMINAL.has(value(view.panel, 'p_status'));
      const score = field(view.panel, 'p_value');
      score.disabled = terminal;
      score.required = !terminal;
      if (terminal) field(view.panel, 'p_finalized').checked = true;
    }

    function validate() {
      if (!active) return false;
      const view = active;
      let valid = false;
      if (!view.busy && !view.conflict && view.feedLoaded && isAdmin() && current()?.status === 'active') {
        try {
          if (view.kind === 'score') buildScore(view); else buildStatus(view);
          valid = typeof view.form.checkValidity === 'function' ? view.form.checkValidity() : true;
        } catch { valid = false; }
      }
      view.save.disabled = !valid;
      return valid;
    }

    function onFieldEvent(event) {
      if (!active || event.currentTarget !== active.form) return;
      const view = active;
      const name = event.target?.name;
      if (!name || (event.type === 'input' && event.target.tagName === 'SELECT')) return;
      const navigates = name === 'p_game_id'
        || (view.kind === 'score' && view.mode.kind === 'match' && name === 'p_set_no')
        || (view.kind === 'score' && view.mode.kind === 'match' && ['p_player_a_id', 'p_player_b_id'].includes(name))
        || (view.kind === 'score' && view.mode.kind === 'individual' && name === 'p_player_id')
        || (view.kind === 'status' && view.mode.kind === 'match' && name === 'p_player_id')
        || (view.mode.kind === 'darts' && ['p_leg_no', 'p_player_id'].includes(name))
        || (view.kind === 'score' && view.mode.kind === 'darts' && name === 'p_starter_player_id');
      if (navigates && event.type === 'input') { view.save.disabled = true; return; }
      if (navigates && value(view.panel, name) === view.contextValues[name]) {
        validate();
        return;
      }
      if (navigates && view.dirty) {
        const discard = document.defaultView?.confirm?.('Descartar as alterações não salvas deste resultado?') === true;
        if (!discard) {
          setValue(view.panel, name, view.contextValues[name]);
          validate();
          return;
        }
      }
      if (navigates) resetContextFields(view, name);
      if (name === 'p_game_id') {
        view.dirty = false; view.conflict = false; view.feedLoaded = false;
        view.feedRequest += 1;
        if (view.busy) setBusy(view, false);
        announceError('', view);
        render();
        rememberContext(view);
        const gameId = value(view.panel, 'p_game_id');
        if (gameId) refreshFeed(view.modeId, gameId).catch(() => {});
        return;
      }
      if (navigates) {
        view.dirty = false; view.conflict = false;
        announceError('', view);
        const feed = getRankingFeed(view.modeId, value(view.panel, 'p_game_id'));
        if (feed) hydrate(view, feed);
        else rememberContext(view);
      } else {
        view.dirty = true;
        if (name === 'p_status') syncIndividualStatus(view);
      }
      validate();
    }

    function hideDialog(dialog) {
      if (dialog.open) dialog.close();
      dialog.hidden = true;
      dialog.inert = true;
      dialog.setAttribute('inert', '');
    }

    function close({ force = false } = {}) {
      if (active?.saving && !force) return false;
      if (active?.dirty && !force
          && document.defaultView?.confirm?.('Descartar as alterações não salvas deste resultado?') !== true) return false;
      active = null;
      hideDialog(scoreDialog);
      hideDialog(statusDialog);
      for (const mode of presentations.advanced) {
        const panel = element(ids.entryPanelPrefix + mode.id);
        if (panel) { panel.hidden = true; panel.disabled = true; }
      }
      for (const kind of ['match', 'darts']) {
        const panel = element(ids.statusPanelPrefix + kind);
        if (panel) { panel.hidden = true; panel.disabled = true; }
      }
      scoreSave.disabled = true;
      statusSave.disabled = true;
      scoreSave.textContent = scoreSaveLabel;
      statusSave.textContent = statusSaveLabel;
      return true;
    }

    async function open(kind, { modeId = current()?.modeId, gameId = state.activeGameId } = {}) {
      init();
      const encounter = current();
      const mode = modeOf(modeId);
      if (!mode || !encounter || encounter.modeId !== modeId || encounter.status !== 'active' || !isAdmin()
          || (kind === 'status' && mode.kind === 'individual')) {
        showToast('Encontro ativo e acesso de administrador são necessários.', 'error');
        return null;
      }
      if (!close()) return null;
      const dialog = kind === 'score' ? scoreDialog : statusDialog;
      const form = kind === 'score' ? scoreForm : statusForm;
      const save = kind === 'score' ? scoreSave : statusSave;
      const panel = element((kind === 'score' ? ids.entryPanelPrefix + modeId : ids.statusPanelPrefix + mode.kind));
      if (!panel) throw new Error(`Painel de ${modeId} não encontrado.`);
      form.reset();
      panel.hidden = false;
      panel.disabled = false;
      dialog.hidden = false;
      dialog.inert = false;
      dialog.removeAttribute('inert');
      active = { kind, mode, modeId, encounterId: encounter.id, dialog, form, save, panel,
        originalSaveLabel: save.textContent, dirty: false, conflict: false, busy: false, feedLoaded: false,
        baseSignature: null, feedRequest: 0 };
      announceError('');
      dialog.showModal();
      render(gameId);
      rememberContext(active);
      const selectedGameId = value(panel, 'p_game_id');
      if (!selectedGameId) return null;
      const openedView = active;
      try {
        const feed = await refreshFeed(modeId, selectedGameId);
        return active === openedView && value(panel, 'p_game_id') === selectedGameId ? feed : null;
      }
      catch { return null; }
    }

    async function finishWrite(view, saved, gameId) {
      let updateError = null;
      try { await reload(); } catch (error) { updateError = error; }
      let feed = null;
      try { feed = await refreshFeed(view.modeId, gameId); } catch (error) { updateError ||= error; }
      close({ force: true });
      showToast(updateError ? 'Resultado salvo. Atualize a página para conferir o placar.' : 'Resultado salvo.', updateError ? 'error' : 'success');
      return { ok: true, data: saved, feed, refreshError: updateError };
    }

    async function submitScore() {
      const view = active;
      if (!view || view.kind !== 'score' || !validate()) return { ok: false, error: new Error('Resultado incompleto ou desatualizado.') };
      let payload;
      try { payload = buildScore(view); } catch (error) { return { ok: false, error }; }
      const gameId = value(view.panel, 'p_game_id');
      view.saving = true;
      setBusy(view, true, 'Salvando…');
      announceError('');
      try {
        let saved;
        if (view.mode.kind === 'darts') {
          saved = payload.firstTurn
            ? await rpc(view.mode.firstTurnRpc || FIRST_DARTS_TURN_RPC, payload.firstTurn)
            : await rpc(view.mode.writeRpc, payload.turn);
        } else saved = await rpc(view.mode.writeRpc, payload);
        return await finishWrite(view, saved, gameId);
      } catch (error) {
        if (active === view) {
          if (error.code === '40001') view.conflict = true;
          announceError(error.code === '40001' ? 'O resultado mudou. Seu rascunho foi mantido; feche e abra para revisar.' : `Não foi possível salvar: ${error.message || 'tente novamente'}.`, view);
          showToast('Não foi possível salvar o resultado.', 'error');
        }
        return { ok: false, error };
      } finally {
        view.saving = false;
        if (active === view) setBusy(view, false);
      }
    }

    async function submitStatus() {
      const view = active;
      if (!view || view.kind !== 'status' || !validate()) return { ok: false, error: new Error('Situação incompleta ou desatualizada.') };
      let payload;
      try { payload = buildStatus(view); } catch (error) { return { ok: false, error }; }
      const gameId = payload.p_game_id;
      view.saving = true;
      setBusy(view, true, 'Salvando…');
      announceError('');
      try {
        const saved = await rpc(view.mode.statusRpc, payload);
        return await finishWrite(view, saved, gameId);
      } catch (error) {
        if (active === view) {
          if (error.code === '40001') view.conflict = true;
          announceError(error.code === '40001' ? 'A situação mudou. Seu rascunho foi mantido; feche e abra para revisar.' : `Não foi possível salvar: ${error.message || 'tente novamente'}.`, view);
          showToast('Não foi possível salvar a situação.', 'error');
        }
        return { ok: false, error };
      } finally {
        view.saving = false;
        if (active === view) setBusy(view, false);
      }
    }

    function init() {
      if (initialized) return controller;
      for (const [form, kind] of [[scoreForm, 'score'], [statusForm, 'status']]) {
        const input = (event) => onFieldEvent(event);
        const change = (event) => onFieldEvent(event);
        const submit = (event) => { event.preventDefault(); (kind === 'score' ? submitScore() : submitStatus()); };
        for (const [eventName, handler] of [['input', input], ['change', change], ['submit', submit]]) {
          form.addEventListener(eventName, handler);
          listeners.push([form, eventName, handler]);
        }
        for (const button of form.querySelectorAll('[data-close-modal]')) {
          const onButtonClose = (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
          };
          button.addEventListener('click', onButtonClose, true);
          listeners.push([button, 'click', onButtonClose, true]);
        }
      }
      for (const dialog of [scoreDialog, statusDialog]) {
        const onCancel = (event) => {
          if (active?.dialog !== dialog) return;
          event.preventDefault();
          close();
        };
        const onClose = () => {
          if (active?.dialog === dialog && !close()) {
            // Defensive fallback for code that calls dialog.close() directly.
            // The cancel event and close() are the paths that guard before close.
            dialog.showModal();
            return;
          }
          dialog.hidden = true;
          dialog.inert = true;
          dialog.setAttribute('inert', '');
        };
        dialog.addEventListener('cancel', onCancel);
        dialog.addEventListener('close', onClose);
        listeners.push([dialog, 'cancel', onCancel]);
        listeners.push([dialog, 'close', onClose]);
      }
      initialized = true;
      return controller;
    }

    function destroy({ force = false } = {}) {
      if (!close({ force })) return false;
      for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
      listeners.length = 0;
      initialized = false;
      return true;
    }

    const controller = Object.freeze({
      init, render, openScore: (options) => open('score', options), openStatus: (options) => open('status', options),
      close, refreshFeed, getRankingFeed, submitScore, submitStatus, destroy,
    });
    return controller;
  }

  return Object.freeze({ create });
});
