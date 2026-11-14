const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp(client = null) {
  const elements = new Map();
  const rows = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '', innerHTML: '', style: {}, open: false, focus() {}, showModal() { this.open = true; }, close() { this.open = false; }, reset() {}, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const document = {
    getElementById: get,
    querySelectorAll: (selector) => selector === '[data-review-player]' ? rows : [],
    body: { classList: { contains: () => false } },
    createElement: () => ({ textContent: '', remove() {} }),
  };
  get('toastContainer').append = () => {};
  const context = vm.createContext({
    window: { SUPABASE_CONFIG: client ? { url: 'https://example.test', publishableKey: 'test' } : {}, supabase: client ? { createClient: () => client } : null, GamePresentations: require('../game-presentations.js'), location: { hash: '', search: '', href: 'https://example.test/boliche/' }, history: { replaceState() {} }, setTimeout: () => {}, confirm: () => true },
    document, URL, URLSearchParams, Intl, atob, console, navigator: {}, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'photo-id' },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
    .replace(/\nstart\(\);\s*$/, '\n');
  vm.runInContext(`${source}\nconst appRender = render;\nrender = () => {};\nrefreshAfterReconnect = async () => {};\nglobalThis.testApp = { state, loadData, renderApp: appRender, buildSuggestions, playersOnLane, updateReviewTable, updatePhotoConfirmState, captureReviewDraft, markRoundEdited, markReviewEdited, changeReviewContext, runOcr, drawOrientedPhoto, applyPhotoInteractionMode, canvasPoint, renderLeaderboard, renderCurrentGame, renderGames, renderLanes, renderPhotoOptions, removeGame, renderTeams, renderRecords, renderScoreHistory, loadMoreAuditHistory, shareResultCard, openShareModal, openPhotoModal, openTabletModal, openQuickScore, openStatsModal, confirmPhotoUpdate, submitAuth, submitProfile, prepareProfilePhoto, cleanupUnusedProfilePhotos, officialTotals, officialPosition, encounterGames, bracketRounds, bracketWinner, balancedLaneDraw, buildResultsExport, downloadResults, openEncounterModal, saveEncounter, renderEncounterRules, renderEncounterBar, renderGameSwitcher, selectEncounter, openGameModal, createGame, renderPlayerSelection, addPlayer, signOut, openRoundModal, renderRoundModal, renderRoundResults, saveRoundScores, clearRoundScore, undoRoundScoreChange, getGameMode, isRoundBased, configuredRoundMax, rankScoreRows, teamStandings, bowlingFrames, tabletStandingPins };`, context);
  vm.runInContext('testApp.start = start; testApp.initializeAdvancedModeUI = initializeAdvancedModeUI; testApp.renderAdvancedLeaderboard = renderAdvancedLeaderboard; testApp.probeAdvancedSchema = probeAdvancedSchema; testApp.isModeReady = isModeReady; testApp.selectableGameTypes = selectableGameTypes;', context);
  return { ...context.testApp, get, rows, document, context };
}

function installAdvancedTestModules(app, feeds, aggregateOfficial = () => ({ rows: [], missingGameIds: [] })) {
  app.state.advancedSchemaReady = true;
  const getFeed = (modeId, gameId) => feeds.get(`${modeId}:${gameId}`) || null;
  app.context.window.AdvancedGameModes = {
    rankResults: (_modeId, rows) => rows.map((row, index) => ({
      ...row, rank: row.finalized === true || row.match_complete === true ? index + 1 : null,
      eligible: row.finalized === true || row.match_complete === true,
    })),
    parseExactBigInt: (raw) => BigInt(raw),
  };
  app.context.window.AdvancedModeUI = {
    create: () => ({
      init() {},
      render() {},
      getRankingFeed: getFeed,
      refreshFeed: async (modeId, gameId) => {
        const feed = getFeed(modeId, gameId);
        if (!feed) throw new Error(`Feed ausente: ${gameId}`);
        return feed;
      },
    }),
  };
  app.context.window.AdvancedRanking = { aggregateOfficial };
  assert.equal(app.initializeAdvancedModeUI(), true);
}

test('novos jogos ficam indisponíveis até a última migração estar acessível', async () => {
  let deployed = false;
  const client = { rpc: async (name, args) => {
    assert.equal(name, 'get_darts_match_results');
    assert.equal(args.p_game_id, '00000000-0000-0000-0000-000000000000');
    return { data: [], error: deployed ? null : { message: 'Function not found' } };
  } };
  const app = loadApp(client);
  app.context.window.AdvancedGameModes = { rankResults: () => [] };
  app.context.window.AdvancedModeUI = { create: () => ({ init() {} }) };
  assert.equal(app.initializeAdvancedModeUI(), true);
  assert.equal(await app.probeAdvancedSchema(), false);
  assert.equal(app.isModeReady('pebolim'), false);
  assert.equal(app.selectableGameTypes().includes('pebolim'), false);
  deployed = true;
  assert.equal(await app.probeAdvancedSchema(), true);
  assert.equal(app.isModeReady('pebolim'), true);
  assert.equal(app.selectableGameTypes().includes('pebolim'), true);
});

function adminSession() {
  const payload = Buffer.from(JSON.stringify({ amr: [{ method: 'password' }] })).toString('base64url');
  return { access_token: `header.${payload}.signature`, user: { id: 'admin', app_metadata: { role: 'admin' } } };
}

test("boot inicializa o controller avançado antes de carregar e renderizar", async () => {
  let created = 0;
  let initialized = 0;
  const client = { auth: {
    onAuthStateChange() {},
    getSession: async () => ({ data: { session: null } }),
  } };
  const app = loadApp(client);
  app.context.window.AdvancedGameModes = { rankResults: () => [], parseExactBigInt: (raw) => BigInt(raw) };
  app.context.window.AdvancedModeUI = { create: () => {
    created += 1;
    return { init() { initialized += 1; }, render() {}, refreshFeed: async () => ({ rows: [], details: {} }) };
  } };
  app.context.bindEvents = () => {};
  app.context.loadProfile = async () => {};
  app.context.loadData = async () => {};
  app.context.subscribeRealtime = () => {};
  app.context.showProfileIfNeeded = () => {};
  await app.start();
  assert.equal(created, 1);
  assert.equal(initialized, 1);
});

test("ranking oficial delega métrica e empate ao AdvancedRanking, só com partidas finais", () => {
  const calls = [];
  const feeds = new Map([
    ["pebolim:g1", { rows: [{ player_id: "ana", status: "active", match_complete: true, sets_won: 1 }, { player_id: "bia", status: "active", match_complete: true, sets_won: 4 }], details: {} }],
    ["pebolim:g2", { rows: [{ player_id: "ana", status: "DNF", match_complete: true, sets_won: 2 }, { player_id: "bia", status: "active", match_complete: true, sets_won: 0 }], details: {} }],
    ["pebolim:g3", { rows: [{ player_id: "ana", status: "active", match_complete: false }], details: {} }],
  ]);
  const app = loadApp({});
  installAdvancedTestModules(app, feeds, (modeId, games, feedsByGame, metric) => {
    calls.push({ modeId, games: games.map((game) => game.id), feedIds: [...feedsByGame.keys()], metric });
    return { rows: [
      { player_id: "ana", rank: 1, displayValue: "2", eligible: true, games_count: 2, results_count: 2, metricLabel: "Total", unitLabel: "vitórias" },
      { player_id: "bia", rank: 1, displayValue: "2", eligible: true, games_count: 2, results_count: 2, metricLabel: "Total", unitLabel: "vitórias" },
    ], missingGameIds: [] };
  });
  app.state.activeEncounterId = "e";
  app.state.activeGameId = "g3";
  app.state.encounters = [{ id: "e", nome: "Pebolim", data: "2026-11-14", game_type: "pebolim", status: "active" }];
  app.state.games = [
    { id: "g1", encounter_id: "e", nome: "Final 1", status: "final" },
    { id: "g2", encounter_id: "e", nome: "Final 2", status: "final" },
    { id: "g3", encounter_id: "e", nome: "Em andamento", status: "partial" },
  ];
  app.state.players = [{ id: "ana", nome: "Ana" }, { id: "bia", nome: "Bia" }];
  app.state.scores = ["g1", "g2", "g3"].flatMap((game_id) => ["ana", "bia"].map((player_id) => ({ game_id, player_id, pontos: 0 })));
  app.state.teams = [{ id: "team", encounter_id: "e", name: "Dupla", metric: "sum" }];
  app.state.teamPlayers = [{ team_id: "team", player_id: "ana" }];
  app.get("rankingMode").value = "official";
  app.renderLeaderboard();
  const body = app.get("leaderboardBody").innerHTML;
  assert.deepEqual(calls[0], { modeId: "pebolim", games: ["g1", "g2"], feedIds: ["g1", "g2"], metric: "total" });
  assert.equal((body.match(/1º/g) || []).length, 2);
  assert.match(body, /Oficial/);
  assert.doesNotMatch(body, /DNF/);
  app.renderEncounterBar();
  assert.equal(app.get("updateScoreButton").hidden, true);
  assert.equal(app.teamStandings().length, 0);
  app.renderTeams();
  assert.match(app.get("teamsList").innerHTML, /indisponível para esta modalidade/);
});

test("ranking oficial passa average e games e exibe displayValue e unidade do agregador", () => {
  const metrics = [];
  const feeds = new Map([["dardos_501:g1", { rows: [{ player_id: "ana", match_complete: true, match_winner_player_id: "ana" }], details: {} }]]);
  const app = loadApp({});
  installAdvancedTestModules(app, feeds, (_modeId, _games, _feedsByGame, metric) => {
    metrics.push(metric);
    const average = metric === "average";
    return { rows: [{ player_id: "ana", rank: 1, displayValue: average ? "0.5" : "3",
      eligible: true, games_count: 3, results_count: 2,
      metricLabel: average ? "Média" : "Partidas", unitLabel: average ? "vitórias/partida" : "partidas" }], missingGameIds: [] };
  });
  app.state.activeEncounterId = "e";
  app.state.activeGameId = "g1";
  app.state.encounters = [{ id: "e", game_type: "dardos_501", status: "closed" }];
  app.state.games = [{ id: "g1", encounter_id: "e", nome: "Final", status: "final" }];
  app.state.players = [{ id: "ana", nome: "Ana" }];
  app.state.scores = [{ game_id: "g1", player_id: "ana", pontos: null }];
  app.get("rankingMode").value = "official";
  app.get("rankingMetric").value = "average";
  app.renderLeaderboard();
  assert.match(app.get("leaderboardBody").innerHTML, /0,5/);
  assert.match(app.get("leaderboardMeta").textContent, /Média/);
  assert.match(app.get("leaderboardMeta").textContent, /vitórias\/partida/);
  app.get("rankingMetric").value = "games";
  app.renderLeaderboard();
  assert.match(app.get("leaderboardBody").innerHTML, />3</);
  assert.match(app.get("leaderboardMeta").textContent, /Partidas/);
  assert.match(app.get("leaderboardMeta").textContent, /unidade: partidas/);
  assert.deepEqual(metrics, ["average", "games"]);
});

test("ranking atual usa somente jogo selecionado e confirma apenas finalized/match_complete true", () => {
  const calls = [];
  const feeds = new Map([["pinball:g-live", { rows: [{ player_id: "ana", status: "active", finalized: false, value_text: "0" }], details: {} }]]);
  const app = loadApp({});
  installAdvancedTestModules(app, feeds, (...args) => { calls.push(args); return { rows: [], missingGameIds: [] }; });
  app.state.activeEncounterId = "e";
  app.state.activeGameId = "g-live";
  app.state.encounters = [{ id: "e", game_type: "pinball", status: "active" }];
  app.state.games = [
    { id: "g-final", encounter_id: "e", nome: "Final", status: "final" },
    { id: "g-live", encounter_id: "e", nome: "Atual", status: "partial" },
  ];
  app.state.players = [{ id: "ana", nome: "Ana" }];
  app.state.scores = app.state.games.map((game) => ({ game_id: game.id, player_id: "ana", pontos: null }));
  app.get("rankingMode").value = "current";
  app.renderLeaderboard();
  assert.equal(calls.length, 0);
  assert.match(app.get("rankingTitle").textContent, /Atual/);
  assert.match(app.get("leaderboardMeta").textContent, /0\/1 resultados confirmados/);
  assert.match(app.get("leaderboardBody").innerHTML, /0/);
  const darts = loadApp({});
  const dartsFeeds = new Map([["dardos_501:d1", { rows: [{ player_id: "ana", match_complete: false, match_winner_player_id: null }], details: {} }]]);
  installAdvancedTestModules(darts, dartsFeeds);
  darts.state.activeEncounterId = "d";
  darts.state.activeGameId = "d1";
  darts.state.encounters = [{ id: "d", game_type: "dardos_501", status: "active" }];
  darts.state.games = [{ id: "d1", encounter_id: "d", nome: "Perna", status: "partial" }];
  darts.state.players = [{ id: "ana", nome: "Ana" }];
  darts.state.scores = [{ game_id: "d1", player_id: "ana", pontos: null }];
  darts.get("rankingMode").value = "current";
  darts.renderLeaderboard();
  assert.match(darts.get("leaderboardMeta").textContent, /0\/1 resultados confirmados/);
});

test("placar da partida exibe erro do feed e oferece retry explícito", async () => {
  let attempts = 0;
  let feed = null;
  let retry;
  const app = loadApp({});
  app.context.window.AdvancedGameModes = { rankResults: () => [], parseExactBigInt: (raw) => BigInt(raw) };
  app.context.window.AdvancedModeUI = { create: () => ({
    init() {}, render() {}, getRankingFeed: () => null,
    refreshFeed: async () => { attempts += 1; if (!feed) throw new Error("RPC indisponível"); return feed; },
  }) };
  app.context.window.AdvancedRanking = { aggregateOfficial: () => ({ rows: [], missingGameIds: [] }) };
  assert.equal(app.initializeAdvancedModeUI(), true);
  app.state.advancedSchemaReady = true;
  app.state.activeEncounterId = "e";
  app.state.activeGameId = "g";
  app.state.encounters = [{ id: "e", game_type: "pinball", status: "active" }];
  app.state.games = [{ id: "g", encounter_id: "e", nome: "Pinball 1", status: "partial" }];
  app.state.advancedFeedErrors.set("pinball:g", "RPC indisponível");
  app.get("currentGameBody").querySelectorAll = (selector) => selector === "[data-retry-advanced-current]"
    ? [{ addEventListener: (_event, handler) => { retry = handler; } }] : [];
  app.renderCurrentGame();
  assert.match(app.get("currentGameBody").innerHTML, /Resultados da partida indisponíveis/);
  assert.match(app.get("currentGameBody").innerHTML, /Tentar novamente/);
  feed = { rows: [], details: {} };
  await retry();
  assert.equal(attempts, 1);
  assert.equal(app.state.advancedFeeds.get("pinball:g"), feed);
  assert.equal(app.state.advancedFeedErrors.has("pinball:g"), false);
});

test("ranking oficial trata feed final inválido como erro recuperável sem loop de busca", () => {
  let attempts = 0;
  let retry;
  const feed = { rows: [{ player_id: "ana", finalized: false, value_text: "9" }], details: {} };
  const app = loadApp({});
  app.context.window.AdvancedGameModes = { rankResults: () => [], parseExactBigInt: (raw) => BigInt(raw) };
  app.context.window.AdvancedModeUI = { create: () => ({
    init() {}, render() {}, getRankingFeed: () => feed,
    refreshFeed: async () => { attempts += 1; return feed; },
  }) };
  app.context.window.AdvancedRanking = { aggregateOfficial: () => ({ rows: [], missingGameIds: ["g"] }) };
  assert.equal(app.initializeAdvancedModeUI(), true);
  app.state.advancedSchemaReady = true;
  app.state.activeEncounterId = "e";
  app.state.activeGameId = "g";
  app.state.encounters = [{ id: "e", game_type: "pinball", status: "closed" }];
  app.state.games = [{ id: "g", encounter_id: "e", nome: "Final", status: "final" }];
  app.state.players = [{ id: "ana", nome: "Ana" }];
  app.state.scores = [{ game_id: "g", player_id: "ana", pontos: null }];
  app.get("rankingMode").value = "official";
  app.get("leaderboardBody").querySelectorAll = (selector) => selector === "[data-retry-advanced-ranking]"
    ? [{ addEventListener: (_event, handler) => { retry = handler; } }] : [];
  app.renderLeaderboard();
  assert.match(app.get("rankingTitle").textContent, /indisponível/);
  assert.match(app.get("leaderboardBody").innerHTML, /Tentar novamente/);
  assert.equal(app.state.advancedFeedErrors.has("pinball:g"), true);
  assert.equal(attempts, 0);
  assert.equal(typeof retry, "function");
});

test("export inclui feeds e ranking avançado autoritativos e omite rankings/equipes legados", async () => {
  const feeds = new Map([
    ["pinball:g-final", { rows: [{ player_id: "ana", metric_key: "pinball_points", value_text: "9223372036854775807", status: "active", finalized: true }], details: { source: "mode_player_scores" } }],
    ["pinball:g-live", { rows: [{ player_id: "ana", metric_key: "pinball_points", value_text: "42", status: "active", finalized: false }], details: {} }],
  ]);
  const app = loadApp({});
  installAdvancedTestModules(app, feeds, (_modeId, games, feedsByGame, metric) => ({
    rows: games.filter((game) => feedsByGame.has(game.id)).map(() => ({
      player_id: "ana", rank: 1, displayValue: "9223372036854775807", eligible: true,
      games_count: 1, results_count: 1, metricLabel: "Total", unitLabel: "pontos",
    })), missingGameIds: [],
  }));
  app.state.activeEncounterId = "e";
  app.state.encounters = [{ id: "e", nome: "Pinball", data: "2026-11-14", status: "active", game_type: "pinball", rules_config: {} }];
  app.state.games = [
    { id: "g-final", encounter_id: "e", nome: "Final", status: "final" },
    { id: "g-live", encounter_id: "e", nome: "Atual", status: "partial" },
  ];
  app.state.players = [{ id: "ana", nome: "Ana" }];
  app.state.encounterPlayers = [{ encounter_id: "e", player_id: "ana" }];
  app.state.scores = app.state.games.map((game) => ({ game_id: game.id, player_id: "ana", pontos: null, finalizado: false }));
  app.state.teams = [{ id: "team", encounter_id: "e", name: "Equipe", metric: "sum" }];
  app.state.teamPlayers = [{ team_id: "team", player_id: "ana" }];
  const exported = await app.buildResultsExport();
  assert.equal(exported.rankings.length, 0);
  assert.equal(exported.team_rankings.length, 0);
  assert.equal(exported.advanced_results.length, 2);
  assert.equal(exported.advanced_results[0].rows[0].value_text, "9223372036854775807");
  assert.equal(exported.advanced_results[0].details.source, "mode_player_scores");
  assert.equal(exported.advanced_rankings[0].status, "official");
  assert.equal(exported.advanced_rankings[0].rows[0].value, "9223372036854775807");
  assert.equal(exported.advanced_rankings[0].rows[0].eligible, true);
  assert.doesNotMatch(JSON.stringify(exported), /user_id|auth_user|access_token/);
  const files = [];
  app.context.Blob = class { constructor(parts) { files.push(parts.join("")); } };
  app.context.URL = { createObjectURL: () => "blob:advanced", revokeObjectURL() {} };
  app.document.createElement = () => ({ click() {} });
  await app.downloadResults("csv");
  assert.match(files[0], /resultado_avancado/);
  assert.match(files[0], /9223372036854775807/);
  assert.match(files[0], /feed_avancado/);
});

function roundRow(playerId, points, finalized) {
  const pointsInput = { value: String(points) };
  const finalizedInput = { checked: Boolean(finalized) };
  return {
    dataset: { roundPlayer: playerId },
    pointsInput, finalizedInput,
    querySelector: (selector) => selector === '.round-points' ? pointsInput : selector === '.round-final' ? finalizedInput : null,
  };
}

function pagedClient(rows, ranges = []) {
  const client = {
    rpc: async () => ({ data: [], error: null }),
    from: (table) => {
      let offset = 0;
      let end = Number.POSITIVE_INFINITY;
      const query = {
        select: () => query,
        order: () => query,
        eq: () => query,
        not: () => query,
        limit: (count) => { end = offset + count; return query; },
        range: (first, last) => { offset = first; end = last + 1; ranges.push([table, first, last]); return query; },
        then: (resolve, reject) => Promise.resolve({ data: (rows[table] || []).slice(offset, end), error: null }).then(resolve, reject),
      };
      return query;
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
  return client;
}

test('troca de jogo agrupa encontros e muda o placar sem alterar a modalidade histórica', () => {
  const app = loadApp();
  app.state.encounters = [
    { id: 'b', nome: 'Boliche de sexta', data: '2026-11-13', status: 'active', game_type: 'boliche' },
    { id: 'q', nome: 'Quiz de sábado', data: '2026-11-14', status: 'active', game_type: 'quiz' },
  ];
  app.state.games = [{ id: 'b1', encounter_id: 'b', status: 'partial' }, { id: 'q1', encounter_id: 'q', status: 'partial' }];
  app.state.activeEncounterId = 'b';
  app.renderEncounterBar();
  assert.match(app.get('gameSwitchList').innerHTML, /Boliche de sexta/);
  assert.match(app.get('gameSwitchList').innerHTML, /Quiz de sábado/);
  assert.match(app.get('gameSwitchList').innerHTML, /data-select-encounter="q"/);
  app.selectEncounter('q');
  app.renderEncounterBar();
  assert.equal(app.state.activeGameId, 'q1');
  assert.equal(app.get('gameSwitchLabel').textContent, 'Quiz');
  assert.equal(app.state.encounters[0].game_type, 'boliche');
});

test('novo encontro aberto a partir de Quiz inicia com modalidade e rodadas prontas para editar', () => {
  const app = loadApp();
  app.state.session = adminSession();
  app.openEncounterModal(false, 'quiz');
  assert.equal(app.get('encounterModal').open, true);
  assert.equal(app.get('encounterGameType').value, 'quiz');
  assert.equal(app.get('encounterRoundCount').value, '3');
  assert.match(app.get('encounterRulesSummary').textContent, /Quiz/);
});

test('novo encontro não pré-seleciona todos os jogadores globais no roster', () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }];
  app.openEncounterModal(false, 'quiz');
  assert.equal((app.get('encounterPlayerSelection').innerHTML.match(/checked/g) || []).length, 0);
});

test('Quiz distribui participantes na estação virtual sem depender de pistas físicas', () => {
  const app = loadApp();
  app.state.encounters = [{ id: 'q', nome: 'Quiz', status: 'active', game_type: 'quiz', rules_config: { round_count: 2 } }];
  app.state.activeEncounterId = 'q';
  app.state.players = [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }, { id: 'global', nome: 'Fora do roster' }];
  app.state.encounterPlayers = [{ encounter_id: 'q', player_id: 'ana' }, { encounter_id: 'q', player_id: 'bia' }];
  app.state.lanes = [{ name: '__estacao_virtual__', capacity: 20 }, { name: 'Pista 1', capacity: 6 }];
  app.openGameModal();
  const html = app.get('playerSelection').innerHTML;
  assert.equal((html.match(/value="__estacao_virtual__" selected>Estação<\/option>/g) || []).length, 2);
  assert.doesNotMatch(html, /Pista 1|Estação __estacao_virtual__/);
  assert.doesNotMatch(html, /Fora do roster/);
  assert.equal(app.get('drawLanesButton').textContent, 'Distribuir na estação');
  assert.match(app.get('gamePlayerHelp').textContent, /estação virtual/);
});

test('cadastro de jogador aceita estação virtual em Quiz e exige pista física em Boliche', async () => {
  const inserted = [];
  let nextId = 0;
  const client = {
    from: (table) => {
      let row;
      const query = {
        insert: (value) => { row = value; inserted.push({ table, ...value }); return query; },
        select: () => query,
        single: async () => ({ data: { id: `player-${++nextId}`, ...row }, error: null }),
      };
      return query;
    },
  };
  const app = loadApp(client);
  app.state.encounters = [{ id: 'q', nome: 'Quiz', status: 'active', game_type: 'quiz' }];
  app.state.activeEncounterId = 'q';
  app.state.lanes = [{ name: '__estacao_virtual__', capacity: 20 }, { name: '1', capacity: 6 }];
  app.renderLanes();
  assert.match(app.get('playerLane').innerHTML, /value="__estacao_virtual__">Estação/);
  assert.doesNotMatch(app.get('playerLane').innerHTML, /value="1"/);
  assert.doesNotMatch(app.get('lanesList').innerHTML, /__estacao_virtual__/);
  app.get('playerName').value = 'Ana'; app.get('playerNickname').value = 'ANA';
  assert.equal(app.get('playerLane').value, '__estacao_virtual__');
  await app.addPlayer();
  assert.deepEqual(inserted, [{ table: 'players', nome: 'Ana', apelido_placar: 'ANA', pista: '__estacao_virtual__' }]);

  app.state.encounters = [{ id: 'b', nome: 'Boliche', status: 'active', game_type: 'boliche' }];
  app.state.activeEncounterId = 'b';
  app.renderLanes();
  app.get('playerName').value = 'Bruno'; app.get('playerNickname').value = 'BRU';
  app.get('playerLane').value = '__estacao_virtual__';
  await app.addPlayer();
  assert.equal(inserted.length, 1);
  app.get('playerLane').value = '1';
  await app.addPlayer();
  assert.deepEqual(inserted[1], { table: 'players', nome: 'Bruno', apelido_placar: 'BRU', pista: '1' });
});

test('Boliche oculta a estação reservada em seletores físicos e mostra rótulo humano nas classificações', () => {
  const app = loadApp();
  app.state.encounters = [{ id: 'b', nome: 'Boliche', status: 'active', game_type: 'boliche' }];
  app.state.activeEncounterId = 'b'; app.state.activeGameId = 'g';
  app.state.players = [{ id: 'ana', nome: 'Ana', apelido_placar: 'ANA', pista: '1' }, { id: 'bia', nome: 'Bia', apelido_placar: 'BIA', pista: '__estacao_virtual__' }];
  app.state.encounterPlayers = [{ encounter_id: 'b', player_id: 'ana' }, { encounter_id: 'b', player_id: 'bia' }];
  app.state.lanes = [{ name: '1', capacity: 6 }, { name: '__estacao_virtual__', capacity: 20 }];
  app.state.games = [{ id: 'g', encounter_id: 'b', nome: 'Partida', status: 'final' }];
  app.state.scores = [
    { game_id: 'g', player_id: 'ana', pista: '1', pontos: 100, finalizado: true },
    { game_id: 'g', player_id: 'bia', pista: '__estacao_virtual__', pontos: 110, finalizado: true },
  ];
  app.get('playerLane').value = '__estacao_virtual__';
  app.get('photoGame').value = 'g'; app.get('photoLane').value = '__estacao_virtual__';
  app.get('rankingLane').value = '__estacao_virtual__';

  app.renderPlayerSelection();
  assert.match(app.get('playerSelection').innerHTML, /value="1" selected>Pista 1<\/option>/);
  assert.doesNotMatch(app.get('playerSelection').innerHTML, /__estacao_virtual__/);
  app.renderLanes();
  assert.match(app.get('lanesList').innerHTML, /Pista 1/);
  assert.doesNotMatch(app.get('lanesList').innerHTML, /__estacao_virtual__/);
  assert.doesNotMatch(app.get('playerLane').innerHTML, /__estacao_virtual__/);
  app.renderPhotoOptions();
  assert.match(app.get('photoLane').innerHTML, /value="1"/);
  assert.doesNotMatch(app.get('photoLane').innerHTML, /__estacao_virtual__/);
  app.renderLeaderboard();
  assert.doesNotMatch(app.get('rankingLane').innerHTML, /__estacao_virtual__/);
  assert.equal(app.get('rankingLane').value, '');
  assert.match(app.get('leaderboardBody').innerHTML, /Estação/);
  assert.doesNotMatch(app.get('leaderboardBody').innerHTML, /__estacao_virtual__/);
  app.renderCurrentGame();
  assert.match(app.get('currentGameBody').innerHTML, /Estação/);
  assert.doesNotMatch(app.get('currentGameBody').innerHTML, /__estacao_virtual__/);
});

test('modalidade avançada desconhecida fica somente para leitura sem pontuação genérica ou ações de boliche', async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; } };
  const app = loadApp(client);
  const builtins = require('../game-presentations.js');
  app.context.window.GamePresentations = {
    proposed: [],
    get: (id) => id === 'duelo_avancado'
      ? { id, name: 'Duelo Avançado', unit: 'pontos', roundBased: true, locationLabel: 'Arena', progressKind: 'rounds' }
      : builtins.get(id),
  };
  app.state.session = adminSession();
  app.state.encounters = [{ id: 'x', nome: 'Duelo', data: '2026-11-14', status: 'active', game_type: 'duelo_avancado' }];
  app.state.activeEncounterId = 'x'; app.state.activeGameId = 'g';
  app.state.games = [{ id: 'g', encounter_id: 'x', nome: 'Partida', status: 'partial' }];
  app.state.players = [{ id: 'ana', nome: 'Ana' }];
  app.state.encounterPlayers = [{ encounter_id: 'x', player_id: 'ana' }];
  app.state.scores = [{ game_id: 'g', player_id: 'ana', pista: 'A', pontos: 999, finalizado: true }];

  assert.equal(app.getGameMode().ready, false);
  assert.equal(app.getGameMode().preparing, true);
  app.renderLeaderboard(); app.renderCurrentGame(); app.renderGames(); app.renderEncounterBar();
  assert.match(app.get('leaderboardBody').innerHTML, /Modalidade .* em preparação/);
  assert.match(app.get('currentGameBody').innerHTML, /Modalidade em preparação/);
  assert.doesNotMatch(app.get('leaderboardBody').innerHTML, /Ana|999/);
  assert.doesNotMatch(app.get('currentGameBody').innerHTML, /Ana|999|Rodadas|Corrigir/);
  assert.match(app.get('gamesList').innerHTML, /somente leitura/);
  assert.doesNotMatch(app.get('gamesList').innerHTML, /999|data-edit-game|data-delete-game/);
  assert.equal(app.get('photoButton').hidden, true);
  assert.equal(app.get('tabletButton').hidden, true);
  assert.equal(app.get('updateScoreButton').hidden, true);
  assert.equal(app.get('newGameButton').disabled, true);
  assert.equal(app.get('editEncounterButton').disabled, true);

  app.openPhotoModal(); app.openTabletModal(); app.openQuickScore('ana'); app.openRoundModal();
  await app.createGame({ preventDefault() {} });
  await app.saveRoundScores({ preventDefault() {} });
  assert.equal(app.get('photoModal').open, false);
  assert.equal(app.get('tabletModal').open, false);
  assert.equal(app.get('roundModal').open, false);
  assert.equal(calls.length, 0);
});

test('quiz apresenta progresso por rodada no lugar da conclusão por pista', () => {
  const app = loadApp();
  app.state.encounters = [{ id: 'q', nome: 'Quiz', game_type: 'quiz', rules_config: { round_count: 2 } }];
  app.state.activeEncounterId = 'q'; app.state.activeGameId = 'g';
  app.state.games = [{ id: 'g', encounter_id: 'q', nome: 'Partida 1', status: 'partial' }];
  app.state.players = [{ id: 'a', nome: 'Ana', pista: '1' }, { id: 'b', nome: 'Bruno', pista: '1' }];
  app.state.scores = [{ game_id: 'g', player_id: 'a', pista: '1', pontos: 0, finalizado: false }, { game_id: 'g', player_id: 'b', pista: '1', pontos: null, finalizado: false }];
  app.state.roundScores = [{ game_id: 'g', player_id: 'a', round_no: 1, points: 0, finalized: true }, { game_id: 'g', player_id: 'b', round_no: 1, points: 8, finalized: false }];
  app.renderCurrentGame();
  assert.equal(app.get('laneProgress').hidden, true);
  assert.equal(app.get('roundProgress').hidden, false);
  assert.match(app.get('roundProgress').innerHTML, /Rodadas <strong>0\/2 concluídas/);
  assert.match(app.get('roundProgress').innerHTML, /Rodada 1 · 1\/2/);
  assert.match(app.get('currentGameEyebrow').textContent, /rodadas/);
});

test('OCR só sugere total alinhado à última coluna para jogadores vinculados à partida e pista', () => {
  const app = loadApp();
  app.state.players = [
    { id: 'ana', nome: 'Ana Horta', apelido_placar: 'ANA', pista: '1' },
    { id: 'bruno', nome: 'Bruno', apelido_placar: 'BRUNO', pista: '2' },
    { id: 'outro', nome: 'Outro', apelido_placar: 'OUTRO', pista: '1' },
  ];
  app.state.scores = [{ game_id: 'game', player_id: 'ana' }, { game_id: 'game', player_id: 'bruno' }];
  app.get('photoGame').value = 'game';
  app.get('photoLane').value = '1';
  const numeric = (text, x0, x1) => ({ text, bbox: { x0, x1 }, confidence: 85 });
  const result = app.buildSuggestions({ blocks: [{ paragraphs: [{ lines: [
    { text: 'ANA 10 42 213', words: [numeric('10', 130, 160), numeric('42', 200, 230), numeric('213', 850, 900)] },
    { text: 'BRUNO 16 200', words: [numeric('16', 200, 230), numeric('200', 850, 900)] },
    { text: 'OUTRO 30 250', words: [numeric('30', 200, 230), numeric('250', 850, 900)] },
  ] }] }] }, 1000);
  assert.equal(result.get('ana').value, 213);
  assert.equal(result.has('bruno'), false);
  assert.equal(result.has('outro'), false);
  assert.equal(app.buildSuggestions('ANA 10 42 213').size, 0);
  const ambiguous = app.buildSuggestions({ blocks: [{ paragraphs: [{ lines: [
    { text: 'ANA 10 42 213 7', words: [numeric('10', 130, 160), numeric('42', 200, 230), numeric('213', 750, 800), numeric('7', 900, 915)] },
  ] }] }] }, 1000);
  assert.equal(ambiguous.size, 0);
});

test('conferência manual explica quando há alteração válida', () => {
  const app = loadApp();
  let value = '213';
  let checked = true;
  const hint = { textContent: '' };
  const row = {
    dataset: { oldScore: '', oldFinal: 'false' },
    querySelector: (selector) => selector === '.review-score' ? { value } : selector === '.review-final' ? { checked } : hint,
  };
  app.rows.push(row);
  app.updatePhotoConfirmState();
  assert.match(app.get('photoConfirmHint').textContent, /prontas para salvar/);
  assert.equal(hint.textContent, '— → 213');
  value = '301';
  app.updatePhotoConfirmState();
  assert.match(app.get('photoConfirmHint').textContent, /Corrija as pontuações/);
  value = '213'; row.dataset.oldScore = '213'; row.dataset.oldFinal = 'true';
  app.updatePhotoConfirmState();
  assert.match(app.get('photoConfirmHint').textContent, /Preencha ou altere/);
  checked = false;
  app.updatePhotoConfirmState();
  assert.match(app.get('photoConfirmHint').textContent, /prontas para salvar/);
});

test('reimportar o mesmo total mantém a confirmação; total alterado exige nova confirmação', () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana Horta', apelido_placar: 'ANA', pista: '1' }];
  app.state.scores = [{ game_id: 'game-1', player_id: 'ana', pontos: 213, finalizado: true }];
  app.get('photoGame').value = 'game-1';
  app.get('photoLane').value = '1';
  app.updateReviewTable(new Map([['ana', { value: 213 }]]));
  assert.match(app.get('reviewTable').innerHTML, /class="review-final" type="checkbox" checked/);
  app.updateReviewTable(new Map([['ana', { value: 214 }]]));
  assert.doesNotMatch(app.get('reviewTable').innerHTML, /class="review-final" type="checkbox" checked/);
});

test('recorte converte coordenadas CSS para resolução interna do canvas', () => {
  const app = loadApp();
  const canvas = { width: 900, height: 600, getBoundingClientRect: () => ({ left: 10, top: 20, width: 450, height: 300 }) };
  app.document.getElementById = (id) => id === 'photoCanvas' ? canvas : app.get(id);
  const point = app.canvasPoint({ clientX: 235, clientY: 170 });
  assert.equal(point.x, 450);
  assert.equal(point.y, 300);
});

test('giro de 90 graus troca as dimensões e aplica contraste na leitura', () => {
  const app = loadApp();
  app.state.image = { naturalWidth: 1200, naturalHeight: 800 };
  app.state.photoRotation = 90;
  app.state.photoContrast = 150;
  const operations = [];
  const context = {
    translate: (...args) => operations.push(['translate', ...args]),
    rotate: (angle) => operations.push(['rotate', angle]),
    drawImage: () => operations.push(['drawImage', context.filter]),
    setTransform: () => {},
  };
  const canvas = { getContext: () => context };
  app.drawOrientedPhoto(canvas, 900);
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 900);
  assert.equal(operations.find(([name]) => name === 'rotate')[1], Math.PI / 2);
  assert.deepEqual(operations.find(([name]) => name === 'drawImage'), ['drawImage', 'contrast(150%)']);
});

test('imagem ampliada pode alternar entre mover e recortar no celular', () => {
  const app = loadApp();
  app.state.photoPanMode = true;
  app.applyPhotoInteractionMode();
  assert.equal(app.get('photoCanvas').style.touchAction, 'pan-x pan-y');
  assert.equal(app.get('photoPanButton').textContent, 'Recortar imagem');
  app.state.photoPanMode = false;
  app.applyPhotoInteractionMode();
  assert.equal(app.get('photoCanvas').style.touchAction, 'none');
  assert.equal(app.get('photoPanButton').textContent, 'Mover imagem');
});

test('importação usa RPC transacional e nunca cria vínculo de jogador', async () => {
  let call;
  const payload = Buffer.from(JSON.stringify({ amr: [{ method: 'password' }] })).toString('base64url');
  const session = { access_token: `a.${payload}.b`, user: { id: 'admin', app_metadata: { role: 'admin' } } };
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    rpc: async (name, payload) => { call = { name, payload }; return { error: new Error('simulated') }; },
    from: () => { throw new Error('importação não deve escrever diretamente nas tabelas'); },
  };
  const app = loadApp(client);
  app.get('photoGame').value = 'game-1';
  app.get('photoLane').value = '1';
  app.rows.push({
    dataset: { reviewPlayer: 'ana', oldScore: '', oldFinal: 'false' },
    querySelector: (selector) => selector === '.review-score' ? { value: '213' } : { checked: true },
  });
  await app.confirmPhotoUpdate({ preventDefault() {} });
  assert.equal(call.name, 'save_game_scores');
  assert.equal(call.payload.p_game_id, 'game-1');
  assert.equal(call.payload.p_updates[0].player_id, 'ana');
  assert.equal(call.payload.p_updates[0].pontos, 213);
});

test('login administrativo carrega cadastros antes de abrir aprovações', async () => {
  const payload = Buffer.from(JSON.stringify({ amr: [{ method: 'password' }] })).toString('base64url');
  const session = { access_token: `a.${payload}.b`, user: { id: 'admin', email: 'admin@example.test', app_metadata: { role: 'admin' } } };
  const tables = [];
  const client = {
    auth: { signInWithPassword: async () => ({ data: { session }, error: null }) },
    rpc: async (name) => name === 'list_registered_accounts' ? { data: [{ id: 'admin', is_admin_account: true }], error: null } : { data: [], error: null },
    from: (name) => {
      tables.push(name);
      const query = {
        select: () => query,
        order: () => query,
        limit: () => query,
        eq: () => query,
        not: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return query;
    },
  };
  const app = loadApp(client);
  app.get('authEmail').value = 'admin@example.test';
  app.get('authPassword').value = 'secret';
  await app.submitAuth({ preventDefault() {} });
  assert.equal(app.state.profiles.length, 1);
  assert.ok(tables.includes('lanes'));
  assert.ok(tables.includes('score_changes'));
});

test('visitante vê foto aprovada ao lado do jogador no ranking', async () => {
  const player = { id: 'matheus-player', nome: 'Matheus Muniz', apelido_placar: 'MATHEUS', pista: '1' };
  const rows = {
    players: [player], lanes: [{ name: '1' }],
    encounters: [{ id: 'meet-1', nome: 'Encontro', status: 'active' }],
    encounter_players: [{ encounter_id: 'meet-1', player_id: player.id }],
    games: [{ id: 'game-1', encounter_id: 'meet-1', nome: 'Partida', status: 'final', created_at: '2026-11-13T20:00:00Z' }],
    scores: [{ id: 'score-1', game_id: 'game-1', player_id: player.id, pista: '1', pontos: 213, finalizado: true }],
    profiles: [{ player_id: player.id, foto_path: 'user-1/photo.jpg' }],
  };
  const filters = [];
  const client = {
    storage: { from: () => ({ createSignedUrl: async (path) => ({ data: { signedUrl: `https://example.test/${path}` }, error: null }) }) },
    rpc: async () => ({ data: [], error: null }),
    from: (table) => {
      const query = {
        select: () => query, order: () => query,
        eq: (...args) => { filters.push([table, ...args]); return query; },
        not: (...args) => { filters.push([table, ...args]); return query; },
        then: (resolve) => resolve({ data: rows[table] || [], error: null }),
      };
      return query;
    },
  };
  const app = loadApp(client);
  await app.loadData();
  app.renderLeaderboard();
  assert.deepEqual(filters.filter(([table]) => table === 'profiles'), [
    ['profiles', 'status', 'approved'], ['profiles', 'photo_public_opt_in', true], ['profiles', 'player_id', 'is', null],
  ]);
  assert.match(app.get('leaderboardBody').innerHTML, /<img class="ranking-avatar"[^>]+alt="Foto de Matheus Muniz"/);
  assert.match(app.get('leaderboardBody').innerHTML, /213/);
  assert.match(app.get('podium').innerHTML, /<span class="podium-medal">1º<\/span>/);
  assert.match(app.get('podium').innerHTML, /Foto de Matheus Muniz/);
});

test('cartão do resultado inclui o vencedor e salva PNG da classificação final', async () => {
  const app = loadApp();
  app.state.players = [{ id: 'matheus', nome: 'Matheus Muniz', pista: '2' }];
  app.state.encounters = [{ id: 'meet-1', nome: 'Encontro', status: 'open' }];
  app.state.encounterPlayers = [{ encounter_id: 'meet-1', player_id: 'matheus' }];
  app.state.activeEncounterId = 'meet-1';
  app.state.games = [{ id: 'game-1', encounter_id: 'meet-1', status: 'final' }];
  app.state.scores = [{ game_id: 'game-1', player_id: 'matheus', pista: '2', pontos: 213, finalizado: true }];
  const written = [];
  const context = {
    fillRect() {}, strokeRect() {},
    fillText: (text) => written.push(text),
  };
  let downloaded = false;
  app.document.createElement = (tag) => tag === 'canvas'
    ? { getContext: () => context, toBlob: (resolve) => resolve({}) }
    : tag === 'a' ? { click: () => { downloaded = true; }, remove() {} }
      : { textContent: '', remove() {} };
  app.document.body = { append() {} };
  app.context.navigator = {};
  app.context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  app.context.File = class { constructor(_parts, name) { this.name = name; } };
  await app.shareResultCard();
  assert.ok(written.includes('Matheus Muniz'));
  assert.ok(written.includes('213 pontos'));
  assert.equal(downloaded, true);
});

test('QR de compartilhamento codifica o encontro selecionado e não quebra sem o módulo da UI', async () => {
  const app = loadApp();
  app.context.window.location.href = 'https://example.test/boliche/#access_token=secret-access&refresh_token=secret-refresh';
  app.state.encounters = [{ id: 'quiz-1', nome: 'Quiz' }];
  app.state.activeEncounterId = 'quiz-1';
  const link = { href: '', textContent: '' };
  app.get('shareModal').querySelector = () => link;
  let generatedUrl = null;
  app.context.window.JogatinaQR = { toDataURL: async (url) => { generatedUrl = url; return 'data:image/png;base64,QR'; } };
  await app.openShareModal();
  assert.equal(new URL(generatedUrl).searchParams.get('encontro'), 'quiz-1');
  assert.equal(new URL(generatedUrl).hash, '');
  assert.doesNotMatch(generatedUrl, /access_token|refresh_token|secret-access|secret-refresh/);
  assert.equal(app.get('shareQr').src, 'data:image/png;base64,QR');
  assert.equal(app.get('shareQr').hidden, false);
  app.context.window.JogatinaQR = undefined;
  await app.openShareModal();
  assert.equal(app.get('shareQr').hidden, true);
});

test('gráfico do perfil autoescala e vitórias contam somente liderança isolada confirmada', () => {
  const app = loadApp();
  app.state.encounters = [{ id: 'e', game_type: 'boliche' }];
  app.state.activeEncounterId = 'e';
  app.state.players = [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }];
  app.state.games = [1, 2, 3].map((n) => ({ id: `g${n}`, encounter_id: 'e', status: 'final', created_at: `2026-11-1${n}` }));
  app.state.scores = [
    { game_id: 'g1', player_id: 'ana', pontos: 100, finalizado: true }, { game_id: 'g1', player_id: 'bia', pontos: 50000, finalizado: false },
    { game_id: 'g2', player_id: 'ana', pontos: 200, finalizado: true }, { game_id: 'g2', player_id: 'bia', pontos: 200, finalizado: true },
    { game_id: 'g3', player_id: 'ana', pontos: 50000000, finalizado: true }, { game_id: 'g3', player_id: 'bia', pontos: 100, finalizado: true },
  ];
  app.openStatsModal('ana');
  assert.match(app.get('statsSummary').innerHTML, /<strong>2<\/strong><span>vitórias/);
  const chart = app.get('statsEvolution').innerHTML;
  const coordinates = chart.match(/<polyline points="([^"]+)"/)[1].split(' ');
  const ys = coordinates.map((point) => Number(point.split(',')[1]));
  assert.ok(ys.every((y) => Number.isFinite(y) && y >= 20 && y <= 115));
  assert.ok(ys[2] < ys[0]);
});

test('ranking isola encontros e calcula média por partidas concluídas', () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana', pista: '1' }, { id: 'bruno', nome: 'Bruno', pista: '2' }];
  app.state.encounters = [{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }];
  app.state.encounterPlayers = ['a', 'b'].flatMap((encounter_id) => ['ana', 'bruno'].map((player_id) => ({ encounter_id, player_id })));
  app.state.games = [{ id: 'a1', encounter_id: 'a', status: 'final' }, { id: 'a2', encounter_id: 'a', status: 'final' }, { id: 'b1', encounter_id: 'b', status: 'final' }];
  app.state.scores = [
    { game_id: 'a1', player_id: 'ana', pista: '1', pontos: 100, finalizado: true },
    { game_id: 'a2', player_id: 'ana', pista: '2', pontos: 200, finalizado: true },
    { game_id: 'a1', player_id: 'bruno', pista: '1', pontos: 180, finalizado: true },
    { game_id: 'b1', player_id: 'bruno', pista: '2', pontos: 300, finalizado: true },
  ];
  app.state.activeEncounterId = 'a';
  let totals = app.officialTotals();
  assert.equal(totals.find((item) => item.player.id === 'ana').points, 300);
  assert.equal(totals.find((item) => item.player.id === 'ana').gamesPlayed, 2);
  assert.equal(totals.find((item) => item.player.id === 'bruno').points, 180);
  app.get('rankingMetric').value = 'average';
  totals = app.officialTotals();
  assert.equal(totals[0].player.id, 'bruno');
  assert.equal(totals[1].average, 150);
  assert.equal(app.officialTotals('2').find((item) => item.player.id === 'ana').points, 200);
  app.get('rankingMetric').value = 'best';
  assert.equal(app.officialTotals()[0].player.id, 'ana');
  app.get('rankingMetric').value = 'games';
  assert.equal(app.officialTotals()[0].gamesPlayed, 2);
  app.state.activeEncounterId = 'b';
  assert.equal(app.officialTotals()[0].points, 300);
});

test('recordes históricos somam encontros da mesma modalidade sem misturar quiz', () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana' }, { id: 'quiz-player', nome: 'Quiz Player' }];
  app.state.encounters = [
    { id: 'b1', nome: 'Boliche um', game_type: 'boliche' },
    { id: 'b2', nome: 'Boliche dois', game_type: 'boliche' },
    { id: 'q1', nome: 'Gincana separada', game_type: 'quiz' },
  ];
  app.state.activeEncounterId = 'b1';
  app.state.games = [
    { id: 'g1', nome: 'Partida um', encounter_id: 'b1', status: 'final', created_at: '2026-11-10' },
    { id: 'g2', nome: 'Partida dois', encounter_id: 'b2', status: 'final', created_at: '2026-11-11' },
    { id: 'g3', nome: 'Rodada de quiz', encounter_id: 'q1', status: 'final', created_at: '2026-11-12' },
  ];
  app.state.scores = [
    { game_id: 'g1', player_id: 'ana', pontos: 100, finalizado: true },
    { game_id: 'g2', player_id: 'ana', pontos: 150, finalizado: true },
    { game_id: 'g3', player_id: 'quiz-player', pontos: 999, finalizado: true },
  ];
  app.renderRecords();
  const output = app.get('groupRecords').innerHTML;
  assert.match(output, /Histórico de Boliche/);
  assert.match(output, /Boliche dois/);
  assert.match(output, /150 pontos/);
  assert.doesNotMatch(output, /Gincana separada|Quiz Player|999/);
});

test('recordes de quiz usam somente encontros com regras comparáveis', () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }];
  app.state.encounters = [
    { id: 'q1', nome: 'Quiz três rodadas', game_type: 'quiz', rules_version: 1, rules_config: { round_count: 3, max_points_per_round: 20 } },
    { id: 'q2', nome: 'Quiz vinte rodadas', game_type: 'quiz', rules_version: 1, rules_config: { round_count: 20, max_points_per_round: 20 } },
  ];
  app.state.activeEncounterId = 'q1';
  app.state.games = [
    { id: 'g1', nome: 'Jogo curto', encounter_id: 'q1', status: 'final' },
    { id: 'g2', nome: 'Jogo longo', encounter_id: 'q2', status: 'final' },
  ];
  app.state.scores = [
    { game_id: 'g1', player_id: 'ana', pontos: 30, finalizado: true },
    { game_id: 'g2', player_id: 'bia', pontos: 200, finalizado: true },
  ];
  app.renderRecords();
  assert.match(app.get('groupRecords').innerHTML, /30 pontos/);
  assert.doesNotMatch(app.get('groupRecords').innerHTML, /Quiz vinte rodadas|200 pontos/);
});

test('equipes empatadas compartilham a posição', () => {
  const app = loadApp();
  app.state.activeEncounterId = 'e';
  app.state.encounters = [{ id: 'e', game_type: 'boliche' }];
  app.state.players = [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }, { id: 'cai', nome: 'Caio' }];
  app.state.encounterPlayers = app.state.players.map((player) => ({ encounter_id: 'e', player_id: player.id }));
  app.state.teams = [{ id: 'a', encounter_id: 'e', name: 'A', metric: 'sum' }, { id: 'b', encounter_id: 'e', name: 'B', metric: 'sum' }, { id: 'c', encounter_id: 'e', name: 'C', metric: 'sum' }];
  app.state.teamPlayers = [{ team_id: 'a', player_id: 'ana' }, { team_id: 'b', player_id: 'bia' }, { team_id: 'c', player_id: 'cai' }];
  app.state.games = [{ id: 'g', encounter_id: 'e', status: 'final' }];
  app.state.scores = [{ game_id: 'g', player_id: 'ana', pontos: 100, finalizado: true }, { game_id: 'g', player_id: 'bia', pontos: 100, finalizado: true }, { game_id: 'g', player_id: 'cai', pontos: 80, finalizado: true }];
  app.renderTeams();
  assert.match(app.get('teamsList').innerHTML, /1º A/);
  assert.match(app.get('teamsList').innerHTML, /1º B/);
  assert.match(app.get('teamsList').innerHTML, /3º C/);
});

test('classificação de equipes aplica métrica comum, média por jogos confirmados e remove inelegíveis', () => {
  const app = loadApp();
  app.state.activeEncounterId = 'e';
  app.state.encounters = [{ id: 'e', game_type: 'boliche' }];
  app.state.players = ['ana', 'bia', 'caio', 'dora'].map((id) => ({ id, nome: id }));
  app.state.teams = [
    { id: 'b', encounter_id: 'e', name: 'B', metric: 'average' },
    { id: 'a', encounter_id: 'e', name: 'A', metric: 'average' },
    { id: 'c', encounter_id: 'e', name: 'Sem resultado', metric: 'average' },
  ];
  app.state.teamPlayers = [
    { team_id: 'a', player_id: 'ana' }, { team_id: 'a', player_id: 'bia' },
    { team_id: 'b', player_id: 'caio' }, { team_id: 'c', player_id: 'dora' },
  ];
  app.state.games = [{ id: 'g1', encounter_id: 'e', status: 'final' }, { id: 'g2', encounter_id: 'e', status: 'final' }];
  app.state.scores = [
    { game_id: 'g1', player_id: 'ana', pontos: 100, finalizado: true },
    { game_id: 'g2', player_id: 'ana', pontos: 200, finalizado: true },
    { game_id: 'g1', player_id: 'bia', pontos: 900, finalizado: false },
    { game_id: 'g1', player_id: 'caio', pontos: 150, finalizado: true },
    { game_id: 'g2', player_id: 'caio', pontos: 150, finalizado: true },
  ];
  app.renderTeams();
  assert.deepEqual(app.teamStandings().map((row) => [row.team.name, row.value, row.position, row.confirmedGames]), [['A', 150, 1, 2], ['B', 150, 1, 2]]);
  assert.match(app.get('teamsList').innerHTML, /1º A/);
  assert.match(app.get('teamsList').innerHTML, /1º B/);
  assert.match(app.get('teamsList').innerHTML, /150,0 de média/);
  assert.doesNotMatch(app.get('teamsList').innerHTML, /Sem resultado/);
});

test('métricas misturadas bloqueiam classificação e export até padronização explícita', async () => {
  const app = loadApp();
  app.state.activeEncounterId = 'e';
  app.state.encounters = [{ id: 'e', game_type: 'boliche' }];
  app.state.players = [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }];
  app.state.teams = [
    { id: 'a', encounter_id: 'e', name: 'A', metric: 'average' },
    { id: 'b', encounter_id: 'e', name: 'B', metric: 'sum' },
  ];
  app.state.teamPlayers = [{ team_id: 'a', player_id: 'ana' }, { team_id: 'b', player_id: 'bia' }];
  app.state.games = [{ id: 'g', encounter_id: 'e', status: 'final' }];
  app.state.scores = [
    { game_id: 'g', player_id: 'ana', pontos: 100, finalizado: true },
    { game_id: 'g', player_id: 'bia', pontos: 120, finalizado: true },
  ];
  assert.equal(app.teamStandings().length, 0);
  app.renderTeams();
  assert.match(app.get('teamsList').innerHTML, /Critérios diferentes entre equipes/);
  assert.equal((await app.buildResultsExport()).team_rankings.length, 0);
  app.state.teams[1].metric = 'average';
  assert.deepEqual(Array.from(app.teamStandings(), (row) => [row.team.name, row.value]), [['B', 120], ['A', 100]]);
});

test('métrica de equipes fica única por encontro e novas equipes herdam o critério existente', async () => {
  const calls = [];
  const app = loadApp({ rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; } });
  app.state.activeEncounterId = 'e';
  app.state.encounters = [{ id: 'e', status: 'active' }];
  app.state.players = [{ id: 'bia', nome: 'Bia' }];
  app.state.teams = [{ id: 'team-a', encounter_id: 'e', name: 'A', metric: 'average' }];
  app.context.loadData = async () => {};
  app.context.openTeamsModal();
  assert.equal(app.get('teamMetric').value, 'average');
  assert.equal(app.get('teamMetric').disabled, true);
  app.get('teamMetric').value = 'sum';
  app.get('teamName').value = 'B';
  app.get('teamPlayerSelection').querySelectorAll = (selector) => selector === 'input:checked' ? [{ value: 'bia' }] : [];
  await app.context.saveTeam({ preventDefault() {} });
  assert.equal(calls[0].args.p_metric, 'average');
});

test('exclusão administrativa da partida usa RPC que bloqueia o encontro antes da cascata', async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; } };
  const app = loadApp(client);
  app.state.games = [{ id: 'g', nome: 'Partida teste' }];
  app.context.loadData = async () => {};
  await app.removeGame('g');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ name: 'delete_encounter_game', args: { p_game_id: 'g' } }]);
});

test('carrega tipo e regras dos encontros junto com os resultados por rodada', async () => {
  const rows = {
    players: [{ id: 'ana', nome: 'Ana', pista: 'A' }], lanes: [],
    encounters: [{ id: 'quiz-1', nome: 'Quiz', data: '2026-11-14', status: 'active', game_type: 'quiz', rules_version: 2, rules_config: { round_count: 3, max_points_per_round: 0 } }],
    encounter_players: [{ encounter_id: 'quiz-1', player_id: 'ana' }],
    games: [{ id: 'game-1', nome: 'Quiz 1', status: 'partial', encounter_id: 'quiz-1' }],
    scores: [{ game_id: 'game-1', player_id: 'ana', pontos: 0, finalizado: false }],
    round_scores: [{ game_id: 'game-1', player_id: 'ana', round_no: 1, points: 0, finalized: true }],
    round_score_changes: [{ id: 12, game_id: 'game-1', player_id: 'ana', round_no: 1, previous_points: null, new_points: 0 }],
  };
  const selects = {};
  const client = {
    rpc: async () => ({ data: [], error: null }),
    from: (table) => {
      const result = { data: rows[table] || [], error: null };
      const query = { select: (columns) => { selects[table] = columns; return query; }, order: () => query, eq: () => query, not: () => query, limit: () => query, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
      return query;
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
  const app = loadApp(client);
  app.state.session = adminSession();
  await app.loadData();
  assert.match(selects.encounters, /game_type.*rules_version.*rules_config/);
  assert.match(selects.round_scores, /round_no.*points.*finalized/);
  assert.equal(selects.round_score_changes, '*');
  assert.equal(app.state.encounters[0].game_type, 'quiz');
  assert.equal(app.state.encounters[0].rules_version, 2);
  assert.equal(app.state.roundScores[0].points, 0);
  assert.equal(app.state.roundScoreChanges[0].id, 12);
});

test('carregamento pagina tabelas acima do limite padrão de mil registros', async () => {
  const ranges = [];
  const scores = Array.from({ length: 1001 }, (_, index) => ({ id: `score-${index}`, game_id: 'g', player_id: `p-${index}`, pontos: index, finalizado: true }));
  const client = pagedClient({
    encounters: [{ id: 'e', nome: 'Encontro', status: 'active', game_type: 'boliche' }],
    games: [{ id: 'g', encounter_id: 'e', nome: 'Jogo', status: 'partial' }], scores,
  }, ranges);
  const app = loadApp(client);
  await app.loadData();
  assert.equal(app.state.scores.length, 1001);
  assert.ok(ranges.some(([table, first, last]) => table === 'scores' && first === 0 && last === 999));
  assert.ok(ranges.some(([table, first, last]) => table === 'scores' && first === 1000 && last === 1999));
});

test('histórico administrativo pagina além dos cem eventos e deixa eventos antigos acessíveis', async () => {
  const ranges = [];
  const changes = Array.from({ length: 130 }, (_, index) => {
    const id = 130 - index;
    return { id, score_id: 'score-ana', game_id: 'g', player_id: 'ana', previous_points: 0, new_points: id, previous_finalized: false, new_finalized: true, changed_at: '2026-11-14T12:00:00Z', actor_id: 'admin' };
  });
  const client = pagedClient({
    players: [{ id: 'ana', nome: 'Ana' }],
    encounters: [{ id: 'e', nome: 'Encontro', status: 'active', game_type: 'boliche' }],
    games: [{ id: 'g', encounter_id: 'e', nome: 'Jogo', status: 'partial' }],
    scores: [{ id: 'score-ana', game_id: 'g', player_id: 'ana', pontos: 1, finalizado: false }],
    score_changes: changes,
  }, ranges);
  const app = loadApp(client);
  app.state.session = adminSession();
  await app.loadData();
  assert.equal(app.state.scoreChanges.length, 100);
  app.renderScoreHistory();
  assert.match(app.get('scoreHistoryList').innerHTML, /Carregar alterações anteriores/);
  await app.loadMoreAuditHistory();
  assert.equal(app.state.scoreChanges.length, 130);
  assert.ok(ranges.some(([table, first]) => table === 'score_changes' && first === 100));
  assert.match(app.get('scoreHistoryList').innerHTML, /→ 1/);
  assert.doesNotMatch(app.get('scoreHistoryList').innerHTML, /Carregar alterações anteriores/);
});

test('reconcilia o cursor do histórico após novas alterações e não pula registros', async () => {
  const ranges = [];
  const oldChanges = Array.from({ length: 300 }, (_, index) => ({
    id: 300 - index, score_id: 'score-ana', game_id: 'g', player_id: 'ana',
    previous_points: 0, new_points: index, previous_finalized: false, new_finalized: true,
  }));
  const rows = {
    players: [{ id: 'ana', nome: 'Ana' }],
    encounters: [{ id: 'e', nome: 'Encontro', status: 'active', game_type: 'boliche' }],
    games: [{ id: 'g', encounter_id: 'e', nome: 'Jogo', status: 'partial' }],
    scores: [{ id: 'score-ana', game_id: 'g', player_id: 'ana', pontos: 1, finalizado: false }],
    score_changes: oldChanges,
  };
  const app = loadApp(pagedClient(rows, ranges));
  app.state.session = adminSession();
  await app.loadData();
  await app.loadMoreAuditHistory();
  await app.loadMoreAuditHistory();
  assert.equal(app.state.auditHistoryOffsets.scoreChanges, 300);
  rows.score_changes = [
    ...Array.from({ length: 120 }, (_, index) => ({ id: 420 - index, score_id: 'score-ana', game_id: 'g', player_id: 'ana', new_points: 500 + index })),
    ...oldChanges,
  ];
  await app.loadData();
  assert.equal(app.state.auditHistoryOffsets.scoreChanges, 100);
  const beforeNextPage = ranges.length;
  await app.loadMoreAuditHistory();
  assert.ok(ranges.slice(beforeNextPage).some(([table, first]) => table === 'score_changes' && first === 100));
  assert.equal(app.state.scoreChanges.length, 420);
  assert.ok(app.state.scoreChanges.some((change) => change.id === 320));
});

test('páginas de auditoria antigas somem após excluir score, jogador ou partida', async () => {
  const rows = {
    players: [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }],
    encounters: [{ id: 'e', nome: 'Encontro', status: 'active', game_type: 'boliche' }],
    games: [1, 2, 3, 4].map((n) => ({ id: `g${n}`, encounter_id: 'e', nome: `Jogo ${n}`, status: 'partial' })),
    scores: [
      { id: 's1', game_id: 'g1', player_id: 'ana', pontos: 1 },
      { id: 's2', game_id: 'g2', player_id: 'ana', pontos: 2 },
      { id: 's3', game_id: 'g3', player_id: 'bia', pontos: 3 },
      { id: 's4', game_id: 'g4', player_id: 'ana', pontos: 4 },
    ],
    score_changes: [
      { id: 1, score_id: 's1', game_id: 'g1', player_id: 'ana', new_points: 1 },
      { id: 2, score_id: 's2', game_id: 'g2', player_id: 'ana', new_points: 2 },
      { id: 3, score_id: 's3', game_id: 'g3', player_id: 'bia', new_points: 3 },
      { id: 4, score_id: 's4', game_id: 'g4', player_id: 'ana', new_points: 4 },
    ],
  };
  const app = loadApp(pagedClient(rows));
  app.state.session = adminSession();
  await app.loadData();
  assert.deepEqual(Array.from(app.state.scoreChanges, (row) => row.id), [4, 3, 2, 1]);
  rows.scores = rows.scores.filter((score) => score.id !== 's2');
  await app.loadData();
  assert.deepEqual(Array.from(app.state.scoreChanges, (row) => row.id), [4, 3, 1]);
  rows.players = rows.players.filter((player) => player.id !== 'bia');
  rows.scores = rows.scores.filter((score) => score.player_id !== 'bia');
  await app.loadData();
  assert.deepEqual(Array.from(app.state.scoreChanges, (row) => row.id), [4, 1]);
  rows.games = rows.games.filter((game) => game.id !== 'g4');
  rows.scores = rows.scores.filter((score) => score.game_id !== 'g4');
  await app.loadData();
  assert.deepEqual(Array.from(app.state.scoreChanges, (row) => row.id), [1]);
});

test('resposta atrasada do histórico administrativo é descartada depois do logout', async () => {
  let resolvePage;
  const client = {
    auth: { signOut: async () => ({ error: null }) },
    rpc: async () => ({ data: [], error: null }),
    from: (table) => {
      let ranged = false;
      const query = {
        select: () => query, order: () => query, limit: () => query,
        range: () => { ranged = true; return query; },
        then: (resolve) => ranged && table === 'score_changes'
          ? new Promise((done) => { resolvePage = done; }).then(resolve)
          : Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    },
  };
  const app = loadApp(client);
  app.state.session = adminSession();
  app.state.auditHistoryHasMore.scoreChanges = true;
  app.state.scoreChanges = [{ id: 1, game_id: 'g', player_id: 'ana' }];
  const pending = app.loadMoreAuditHistory();
  await Promise.resolve();
  assert.equal(typeof resolvePage, 'function');
  app.context.loadData = async () => {};
  await app.signOut();
  app.get('scoreHistoryList').innerHTML = 'signed out';
  resolvePage({ data: [{ id: 2, score_id: 's', game_id: 'g', player_id: 'ana' }], error: null });
  await pending;
  assert.equal(app.state.scoreChanges.length, 0);
  assert.equal(app.get('scoreHistoryList').innerHTML, 'signed out');
});

test('criação de quiz usa RPC multijogos com configuração explícita', async () => {
  let call;
  const client = { rpc: async (name, args) => { call = { name, args }; return { data: null, error: { message: 'mock sql ausente' } }; } };
  const app = loadApp(client);
  app.openEncounterModal(false);
  app.get('encounterName').value = 'Quiz de sábado';
  app.get('encounterDate').value = '2026-11-14';
  app.get('encounterGameType').value = 'quiz';
  app.get('encounterRoundCount').value = '3';
  app.get('encounterRoundMax').value = '';
  await app.saveEncounter({ preventDefault() {} });
  assert.equal(call.name, 'create_multigame_encounter');
  assert.equal(call.args.p_game_type, 'quiz');
  assert.deepEqual(JSON.parse(JSON.stringify(call.args.p_rules_config)), { round_count: 3, max_points_per_round: 0 });
  assert.equal(call.args.p_request_id, 'photo-id');
  assert.match(app.get('encounterFormError').textContent, /mock sql ausente/);
});

test('criar partida mantém request id em retry igual e troca ao mudar o conteúdo', async () => {
  const calls = [];
  let attempt = 0;
  const client = { rpc: async (name, args) => {
    calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
    attempt += 1;
    return attempt < 3 ? { data: null, error: { message: 'falha de rede simulada' } } : { data: { id: 'game-new' }, error: null };
  } };
  const app = loadApp(client);
  let generatedRequestId = 0;
  app.context.crypto.randomUUID = () => `request-${++generatedRequestId}`;
  app.state.encounters = [{ id: 'e', nome: 'Quiz', status: 'active', game_type: 'quiz' }];
  app.state.activeEncounterId = 'e';
  app.state.players = [{ id: 'ana', nome: 'Ana' }];
  app.state.encounterPlayers = [{ encounter_id: 'e', player_id: 'ana' }];
  app.context.loadData = async () => {};
  app.openGameModal();
  app.document.querySelectorAll = (selector) => selector === '#playerSelection input:checked' ? [{ value: 'ana' }] : [];
  app.get('playerSelection').querySelector = () => ({ value: '__estacao_virtual__' });
  app.get('gameName').value = 'Quiz 1';
  await app.createGame({ preventDefault() {} });
  await app.createGame({ preventDefault() {} });
  assert.equal(calls[0].args.p_request_id, calls[1].args.p_request_id);
  app.get('gameName').value = 'Quiz 1 atualizado';
  await app.createGame({ preventDefault() {} });
  assert.notEqual(calls[1].args.p_request_id, calls[2].args.p_request_id);
  assert.deepEqual(calls.map((call) => call.args.p_assignments), [[{ player_id: 'ana', pista: '__estacao_virtual__' }], [{ player_id: 'ana', pista: '__estacao_virtual__' }], [{ player_id: 'ana', pista: '__estacao_virtual__' }]]);
  assert.equal(app.state.activeGameId, 'game-new');
});

test('edição de encontro conserva modalidade e regras existentes', async () => {
  let call;
  const client = { rpc: async (name, args) => { call = { name, args }; return { data: null, error: { message: 'mock sql ausente' } }; } };
  const app = loadApp(client);
  app.state.encounters = [{ id: 'e', nome: 'Quiz', data: '2026-11-14', status: 'preparing', game_type: 'quiz', rules_version: 4, rules_config: { round_count: 5, max_points_per_round: 20 } }];
  app.state.activeEncounterId = 'e';
  app.openEncounterModal(true);
  assert.equal(app.get('encounterGameType').value, 'quiz');
  assert.equal(app.get('encounterGameType').disabled, true);
  assert.equal(app.get('encounterRoundCount').value, 5);
  app.get('encounterName').value = 'Quiz editado';
  await app.saveEncounter({ preventDefault() {} });
  assert.equal(call.name, 'save_encounter');
  assert.equal(call.args.p_encounter_id, 'e');
  assert.equal(Object.hasOwn(call.args, 'p_game_type'), false);
  assert.equal(Object.hasOwn(call.args, 'p_rules_config'), false);
});

test('GameRules recebe modeId e linhas com a métrica correta para total, média, empates e zero', () => {
  const app = loadApp();
  const calls = [];
  app.context.window.GameRules = {
    getMode: (id) => ({ id, name: 'Quiz', unit: 'pontos', roundBased: true }),
    rankScores: (modeId, rows, metric) => {
      calls.push({ modeId, metric, rows: rows.map((row) => ({ player_id: row.player_id, value: row[metric] })) });
      return [...rows].sort((a, b) => b[metric] - a[metric]);
    },
  };
  app.state.players = [
    { id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' },
    { id: 'caio', nome: 'Caio' }, { id: 'zero', nome: 'Zero' },
  ];
  app.state.encounters = [{ id: 'e', nome: 'Quiz', status: 'active', game_type: 'quiz', rules_config: { round_count: 2, max_points_per_round: 0 } }];
  app.state.activeEncounterId = 'e';
  app.state.encounterPlayers = app.state.players.map((player) => ({ encounter_id: 'e', player_id: player.id }));
  app.state.games = [{ id: 'g1', encounter_id: 'e', status: 'final' }, { id: 'g2', encounter_id: 'e', status: 'final' }];
  app.state.scores = [
    { game_id: 'g1', player_id: 'ana', pontos: 10, finalizado: true }, { game_id: 'g2', player_id: 'ana', pontos: 0, finalizado: true },
    { game_id: 'g1', player_id: 'bia', pontos: 8, finalizado: true }, { game_id: 'g1', player_id: 'caio', pontos: 8, finalizado: true },
    { game_id: 'g1', player_id: 'zero', pontos: 0, finalizado: true },
  ];
  app.get('rankingMetric').value = 'total';
  let totals = app.officialTotals();
  assert.equal(totals[0].player.id, 'ana');
  assert.equal(totals.find((row) => row.player.id === 'zero').points, 0);
  assert.equal(app.officialPosition(totals, totals.findIndex((row) => row.player.id === 'bia')), app.officialPosition(totals, totals.findIndex((row) => row.player.id === 'caio')));
  assert.equal(calls[0].modeId, 'quiz');
  assert.equal(calls[0].metric, 'total');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].rows.map((row) => row.value))), [10, 8, 8, 0]);
  app.get('rankingMetric').value = 'average';
  totals = app.officialTotals();
  assert.equal(totals[0].player.id, 'bia');
  assert.equal(totals[0].average, 8);
  assert.equal(totals[1].average, 8);
  assert.equal(calls.at(-1).metric, 'average');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).rows.map((row) => row.value))), [5, 8, 8, 0]);

  app.state.activeGameId = 'g1';
  app.renderCurrentGame();
  assert.equal(calls.at(-1).modeId, 'quiz');
  assert.equal(calls.at(-1).metric, 'total');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).rows.map((row) => row.value))), [10, 8, 8, 0]);
});

test('regra max_points_per_round igual a zero significa sem limite na tela e no formulário', () => {
  const app = loadApp();
  app.state.encounters = [{ id: 'e', nome: 'Quiz', status: 'active', game_type: 'quiz', rules_config: { round_count: 1, max_points_per_round: 0 } }];
  app.state.activeEncounterId = 'e';
  app.state.activeGameId = 'g';
  app.state.games = [{ id: 'g', encounter_id: 'e', status: 'partial', nome: 'Quiz' }];
  app.state.players = [{ id: 'ana', nome: 'Ana' }];
  app.state.scores = [{ game_id: 'g', player_id: 'ana', pontos: 0, finalizado: false }];
  app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  assert.equal(app.configuredRoundMax(), 0);
  app.renderRoundResults();
  assert.doesNotMatch(app.get('roundResults').innerHTML, /max="0"/);
  app.get('encounterGameType').value = 'quiz';
  app.get('encounterRoundCount').value = '1';
  app.get('encounterRoundMax').value = '0';
  app.renderEncounterRules();
  assert.match(app.get('encounterRulesSummary').textContent, /Sem limite/);
});

test('rascunho da rodada sobrevive a render e atualização Realtime com conflito', async () => {
  const rows = {
    players: [{ id: 'ana', nome: 'Ana', pista: 'A' }], lanes: [],
    encounters: [{ id: 'e', nome: 'Quiz', data: '2026-11-14', status: 'active', game_type: 'quiz', rules_version: 1, rules_config: { round_count: 2, max_points_per_round: 0 } }],
    encounter_players: [{ encounter_id: 'e', player_id: 'ana' }],
    games: [{ id: 'g', nome: 'Quiz', encounter_id: 'e', status: 'partial' }],
    scores: [{ game_id: 'g', player_id: 'ana', pontos: 4, finalizado: false }],
    round_scores: [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 5, finalized: false }],
    round_score_changes: [],
  };
  const client = {
    rpc: async () => ({ data: [], error: null }),
    from: (table) => {
      const result = { data: rows[table] || [], error: null };
      const query = { select: () => query, order: () => query, eq: () => query, not: () => query, limit: () => query, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
      return query;
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
  const app = loadApp(client);
  const session = adminSession();
  app.state.session = session;
  app.state.activeEncounterId = 'e'; app.state.activeGameId = 'g'; app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.encounters = [rows.encounters[0]];
  app.state.games = [rows.games[0]];
  app.state.players = rows.players;
  app.state.scores = [{ game_id: 'g', player_id: 'ana', pontos: 4, finalizado: false }];
  app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 4, finalized: false }];
  app.get('roundModal').open = true;
  app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  const row = roundRow('ana', 9, false);
  row.pointsInput.matches = (selector) => selector.includes('.round-points');
  row.pointsInput.closest = () => row;
  app.get('roundResults').querySelectorAll = () => [row];
  app.markRoundEdited({ target: row.pointsInput });
  await app.loadData();
  assert.equal(app.state.roundConflict, true);
  assert.equal(app.state.roundDraft.get('g:1:ana').points, '9');
  app.context.renderAreaNavigation = () => {}; app.context.renderCompetitionArea = () => {};
  app.context.renderLeaderboard = () => {}; app.context.renderEncounterBar = () => {};
  app.context.renderCurrentGame = () => {}; app.context.renderGames = () => {};
  app.context.renderTeams = () => {}; app.context.renderBracket = () => {};
  app.context.renderRecords = () => {}; app.context.renderPredictions = () => {};
  app.context.renderPlayerSelection = () => {}; app.context.renderPhotoOptions = () => {};
  app.renderApp();
  assert.equal(app.state.roundDraft.get('g:1:ana').points, '9');
  assert.match(app.get('roundResults').innerHTML, /value="9"/);
  assert.match(app.get('roundError').textContent, /rascunhos foram preservados/);
});

test('Realtime não recria rascunho nem reenvia pontuação intocada de outro jogador', async () => {
  const calls = [];
  const session = adminSession();
  const data = {
    players: [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }], lanes: [],
    encounters: [{ id: 'e', nome: 'Quiz', data: '2026-11-14', status: 'active', game_type: 'quiz', rules_version: 1, rules_config: { round_count: 1, max_points_per_round: 0 } }],
    encounter_players: [{ encounter_id: 'e', player_id: 'ana' }, { encounter_id: 'e', player_id: 'bia' }],
    games: [{ id: 'g', nome: 'Quiz', encounter_id: 'e', status: 'partial' }],
    scores: [{ game_id: 'g', player_id: 'ana', pontos: 27, finalizado: false }, { game_id: 'g', player_id: 'bia', pontos: 10, finalizado: false }],
    round_scores: [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 27, finalized: false }, { game_id: 'g', player_id: 'bia', round_no: 1, points: 10, finalized: false }],
  };
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    rpc: async (name, args) => {
      if (name === 'save_round_scores_batch_if_current') calls.push(args);
      return { data: [], error: null };
    },
    from: (table) => {
      const result = { data: data[table] || [], error: null };
      const query = { select: () => query, order: () => query, eq: () => query, not: () => query, limit: () => query, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
      return query;
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
  const app = loadApp(client);
  app.state.session = session;
  app.state.encounters = data.encounters; app.state.activeEncounterId = 'e';
  app.state.players = data.players; app.state.games = data.games; app.state.activeGameId = 'g';
  app.state.scores = data.scores; app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 10, finalized: false }, { game_id: 'g', player_id: 'bia', round_no: 1, points: 10, finalized: false }];
  app.get('roundModal').open = true; app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  const ana = roundRow('ana', 10, false);
  const bia = roundRow('bia', 12, false);
  for (const row of [ana, bia]) { row.dataset.basePoints = '10'; row.dataset.baseFinalized = 'false'; }
  bia.pointsInput.matches = (selector) => selector.includes('.round-points');
  bia.pointsInput.closest = () => bia;
  app.get('roundResults').querySelectorAll = () => [ana, bia];
  app.markRoundEdited({ target: bia.pointsInput });

  await app.loadData();
  app.renderRoundModal();
  assert.equal(app.state.roundConflict, false);
  assert.equal(app.state.roundDraft.has('g:1:ana'), false);
  assert.match(app.get('roundResults').innerHTML, /data-round-player="ana" data-base-points="27"[^>]*>.*value="27"/);
  assert.match(app.get('roundResults').innerHTML, /data-round-player="bia"[^>]*>.*value="12"/);

  app.context.loadData = async () => {};
  await app.saveRoundScores({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ p_game_id: 'g', p_round_no: 1, p_updates: [{ player_id: 'bia', points: 12, finalized: false, expected_points: 10, expected_finalized: false }] }]);
});

test('editar e voltar ao valor original não cria escrita após atualização remota', () => {
  const app = loadApp();
  app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 27, finalized: false }];
  app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  const row = roundRow('ana', 12, false);
  row.dataset.basePoints = '10'; row.dataset.baseFinalized = 'false';
  row.pointsInput.matches = (selector) => selector.includes('.round-points');
  row.pointsInput.closest = () => row;
  app.markRoundEdited({ target: row.pointsInput });
  assert.equal(app.state.roundDraft.has('g:1:ana'), true);
  row.pointsInput.value = '10';
  app.markRoundEdited({ target: row.pointsInput });
  assert.equal(app.state.roundDraft.has('g:1:ana'), false);
});

test('rascunho resolvido não reaparece após duas confirmações remotas', async () => {
  const calls = [];
  const session = adminSession();
  let resolvePhoto;
  const data = {
    players: [{ id: 'ana', nome: 'Ana' }, { id: 'bia', nome: 'Bia' }], lanes: [],
    encounters: [{ id: 'e', nome: 'Quiz', status: 'active', game_type: 'quiz', rules_config: { round_count: 1, max_points_per_round: 0 } }],
    encounter_players: [{ encounter_id: 'e', player_id: 'ana' }, { encounter_id: 'e', player_id: 'bia' }],
    games: [{ id: 'g', encounter_id: 'e', status: 'partial' }],
    scores: [{ game_id: 'g', player_id: 'ana', pontos: 10, finalizado: false }, { game_id: 'g', player_id: 'bia', pontos: 10, finalizado: false }],
    round_scores: [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 10, finalized: true }, { game_id: 'g', player_id: 'bia', round_no: 1, points: 10, finalized: false }],
    profiles: [{ player_id: 'ana', foto_path: 'ana.jpg' }],
  };
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    rpc: async (name, args) => { if (name === 'save_round_scores_batch_if_current') calls.push(args); return { data: null, error: null }; },
    from: (table) => {
      const result = { data: data[table] || [], error: null };
      const query = { select: () => query, order: () => query, eq: () => query, not: () => query, limit: () => query, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
      return query;
    },
    storage: { from: () => ({ createSignedUrl: () => new Promise((resolve) => { resolvePhoto = resolve; }) }) },
  };
  const app = loadApp(client);
  app.state.session = session; app.state.encounters = data.encounters; app.state.activeEncounterId = 'e';
  app.state.players = data.players; app.state.games = data.games; app.state.activeGameId = 'g';
  app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 10, finalized: false }, data.round_scores[1]];
  app.get('roundModal').open = true; app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  const ana = roundRow('ana', 10, true);
  const bia = roundRow('bia', 12, false);
  for (const row of [ana, bia]) { row.dataset.basePoints = '10'; row.dataset.baseFinalized = 'false'; }
  ana.finalizedInput.matches = (selector) => selector.includes('.round-final');
  ana.finalizedInput.closest = () => ana;
  bia.pointsInput.matches = (selector) => selector.includes('.round-points');
  bia.pointsInput.closest = () => bia;
  app.get('roundResults').querySelectorAll = () => [ana, bia];
  app.markRoundEdited({ target: ana.finalizedInput });
  app.markRoundEdited({ target: bia.pointsInput });

  const firstLoad = app.loadData();
  await new Promise(setImmediate);
  assert.equal(app.state.roundDraft.has('g:1:ana'), false);
  assert.match(app.get('roundResults').innerHTML, /data-round-player="ana"[^>]*data-base-finalized="true"/);
  resolvePhoto({ data: { signedUrl: 'https://example.test/ana.jpg' }, error: null });
  await firstLoad;
  ana.dataset.baseFinalized = 'true';

  data.round_scores[0] = { ...data.round_scores[0], finalized: false };
  const secondLoad = app.loadData();
  await new Promise(setImmediate);
  assert.equal(app.state.roundDraft.has('g:1:ana'), false);
  assert.match(app.get('roundResults').innerHTML, /data-round-player="ana"[^>]*data-base-finalized="false"/);
  resolvePhoto({ data: { signedUrl: 'https://example.test/ana.jpg' }, error: null });
  await secondLoad;
  ana.finalizedInput.checked = false; ana.dataset.baseFinalized = 'false';
  app.context.loadData = async () => {};
  await app.saveRoundScores({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ p_game_id: 'g', p_round_no: 1, p_updates: [{ player_id: 'bia', points: 12, finalized: false, expected_points: 10, expected_finalized: false }] }]);
});

test('confirmar rodada preserva pontos remotos alterados durante autenticação', async () => {
  const calls = [];
  const session = adminSession();
  let app;
  const client = {
    auth: { getSession: async () => {
      app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 27, finalized: false }];
      return { data: { session }, error: null };
    } },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; },
  };
  app = loadApp(client);
  app.state.session = session;
  app.state.encounters = [{ id: 'e', game_type: 'quiz', status: 'active', rules_config: { round_count: 1, max_points_per_round: 0 } }];
  app.state.activeEncounterId = 'e'; app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 10, finalized: false }];
  app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  const row = roundRow('ana', 10, true);
  row.dataset.basePoints = '10'; row.dataset.baseFinalized = 'false';
  row.finalizedInput.matches = (selector) => selector.includes('.round-final');
  row.finalizedInput.closest = () => row;
  app.get('roundResults').querySelectorAll = () => [row];
  app.markRoundEdited({ target: row.finalizedInput });
  assert.equal(app.state.roundDraft.get('g:1:ana').dirtyPoints, false);
  assert.equal(app.state.roundDraft.get('g:1:ana').dirtyFinalized, true);
  app.context.loadData = async () => {};
  await app.saveRoundScores({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'save_round_scores_batch_if_current');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), { p_game_id: 'g', p_round_no: 1, p_updates: [{ player_id: 'ana', points: 27, finalized: true, expected_points: 27, expected_finalized: false }] });
});

test('salva zero com proteção de concorrência e ignora repetição idêntica', async () => {
  const calls = [];
  const session = adminSession();
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; },
  };
  const app = loadApp(client);
  app.state.session = session;
  app.state.encounters = [{ id: 'e', nome: 'Quiz', status: 'active', game_type: 'quiz', rules_config: { round_count: 2, max_points_per_round: 0 } }];
  app.state.activeEncounterId = 'e'; app.state.activeGameId = 'g'; app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.roundScores = [];
  const row = roundRow('ana', 0, true);
  app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  app.get('roundResults').querySelectorAll = () => [row];
  app.context.loadData = async () => {};
  await app.saveRoundScores({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'save_round_scores_batch_if_current');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), { p_game_id: 'g', p_round_no: 1, p_updates: [{ player_id: 'ana', points: 0, finalized: true, expected_points: null, expected_finalized: null }] });
  app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 0, finalized: true }];
  await app.saveRoundScores({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.match(app.get('roundError').textContent, /Nenhuma alteração nova/);
});

test('falha transacional mantém todos os rascunhos e não aplica pontuação local parcial', async () => {
  const calls = [];
  const session = adminSession();
  const client = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: { code: '23514', message: 'falha simulada' } }; },
  };
  const app = loadApp(client);
  app.state.session = session;
  app.state.encounters = [{ id: 'e', nome: 'Quiz', status: 'active', game_type: 'quiz', rules_config: { round_count: 1, max_points_per_round: 0 } }];
  app.state.activeEncounterId = 'e'; app.state.activeGameId = 'g'; app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.roundScores = [];
  app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  app.get('roundResults').querySelectorAll = () => [roundRow('ana', 0, true), roundRow('bia', 8, true)];
  app.context.loadData = async () => {};
  await app.saveRoundScores({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'save_round_scores_batch_if_current');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), {
    p_game_id: 'g', p_round_no: 1,
    p_updates: [
      { player_id: 'ana', points: 0, finalized: true, expected_points: null, expected_finalized: null },
      { player_id: 'bia', points: 8, finalized: true, expected_points: null, expected_finalized: null },
    ],
  });
  assert.equal(app.state.roundScores.length, 0);
  assert.equal(app.state.roundDraft.has('g:1:ana'), true);
  assert.equal(app.state.roundDraft.has('g:1:bia'), true);
  assert.match(app.get('roundError').textContent, /nenhum resultado foi aplicado localmente/);
});

test('modal de histórico oferece desfazer e limpar rodada com RPCs confirmadas', async () => {
  const calls = [];
  const session = adminSession();
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null }; } };
  const app = loadApp(client);
  app.state.session = session;
  app.state.players = [{ id: 'ana', nome: 'Ana' }];
  app.state.encounters = [{ id: 'e', nome: 'Quiz', status: 'active', game_type: 'quiz', rules_config: { round_count: 1, max_points_per_round: 0 } }];
  app.state.activeEncounterId = 'e'; app.state.activeGameId = 'g'; app.state.roundGameId = 'g'; app.state.roundNo = 1;
  app.state.games = [{ id: 'g', nome: 'Quiz', encounter_id: 'e', status: 'partial' }];
  app.state.scores = [{ game_id: 'g', player_id: 'ana', pontos: 5, finalizado: false }];
  app.state.scoreChanges = [{ id: 7, score_id: 'score-ana', game_id: 'g', player_id: 'ana', previous_points: 0, new_points: 5, previous_finalized: false, new_finalized: false, changed_at: '2026-11-14T11:00:00Z', actor_id: 'admin' }];
  app.state.roundScores = [{ game_id: 'g', player_id: 'ana', round_no: 1, points: 5, finalized: true }];
  app.state.roundScoreChanges = [{ id: 44, game_id: 'g', player_id: 'ana', round_no: 1, previous_points: 0, new_points: 5, changed_at: '2026-11-14T12:00:00Z', actor_id: 'admin' }];
  app.renderScoreHistory();
  const history = app.get('scoreHistoryList').innerHTML;
  assert.match(history, /data-undo-round-change="44"/);
  assert.doesNotMatch(history, /data-undo-change=/);
  assert.match(history, /Rodada 1/);
  assert.match(history, /unidade: pontos/);
  app.get('roundGame').value = 'g'; app.get('roundNumber').value = '1';
  app.get('roundResults').querySelectorAll = () => [roundRow('ana', 5, true)];
  app.renderRoundResults();
  assert.match(app.get('roundResults').innerHTML, /data-clear-round="ana"/);
  app.renderCurrentGame();
  assert.doesNotMatch(app.get('currentGameBody').innerHTML, /data-clear-round=/);
  app.context.loadData = async () => {};
  await app.clearRoundScore('ana');
  await app.undoRoundScoreChange(44);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map((call) => [call.name, call.args]))), [
    ['clear_round_score_if_current', { p_game_id: 'g', p_player_id: 'ana', p_round_no: 1, p_expected_points: 5, p_expected_finalized: true }],
    ['undo_round_score_change', { p_change_id: 44 }],
  ]);
});

test('OCR usa a pista gravada na partida mesmo após alterar a pista padrão do jogador', () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana', pista: '__estacao_virtual__' }];
  app.state.scores = [{ game_id: 'game', player_id: 'ana', pista: '1' }];
  assert.deepEqual(app.playersOnLane('1', 'game').map((player) => player.id), ['ana']);
  assert.equal(app.playersOnLane('2', 'game').length, 0);
});

test('chave eliminatória avança só com resultados finais e desempata pela ordem escolhida', () => {
  const app = loadApp();
  const seeds = ['a','b','c','d','e','f','g','h'];
  app.state.games = ['q','s','f'].map((id) => ({ id, status: 'final' }));
  app.state.scores = [
    ...seeds.map((id, index) => ({ game_id: 'q', player_id: id, pontos: index % 2 ? 100 : 200, finalizado: true })),
    ...['a','c','e','g'].map((id, index) => ({ game_id: 's', player_id: id, pontos: index % 2 ? 100 : 200, finalizado: true })),
    { game_id: 'f', player_id: 'a', pontos: 210, finalizado: true },
    { game_id: 'f', player_id: 'e', pontos: 200, finalizado: true },
  ];
  const rounds = app.bracketRounds({ seeds, round_games: ['q','s','f'] });
  assert.equal(JSON.stringify(rounds[1].matches.map((item) => [item.first,item.second])), JSON.stringify([['a','c'],['e','g']]));
  assert.equal(JSON.stringify(rounds[2].matches.map((item) => [item.first,item.second])), JSON.stringify([['a','e']]));
  assert.equal(app.bracketWinner('f','a','e'), 'a');
  app.state.scores.find((item) => item.game_id === 'f' && item.player_id === 'e').pontos = 210;
  assert.equal(app.bracketWinner('f','a','e'), 'a');
  assert.equal(app.bracketWinner('f','a','e','lower_seed'), 'e');
  app.state.games.find((game) => game.id === 'f').status = 'partial';
  assert.equal(app.bracketWinner('f','a','e'), null);
});

test('exportação inclui jogadores, partidas e pista histórica no CSV e no JSON', async () => {
  const app = loadApp();
  app.state.encounters = [{ id: 'meet-1', nome: 'Noite', data: '2026-11-13', game_type: 'quiz', rules_version: 1, rules_config: { round_count: 1, max_points_per_round: 0 } }];
  app.state.activeEncounterId = 'meet-1';
  app.state.players = [{ id: 'ana', nome: 'Ana', pista: '2' }];
  app.state.encounterPlayers = [{ encounter_id: 'meet-1', player_id: 'ana' }];
  app.state.games = [{ id: 'game-1', encounter_id: 'meet-1', nome: 'Partida', status: 'final' }];
  app.state.scores = [{ game_id: 'game-1', player_id: 'ana', pista: '__estacao_virtual__', pontos: 213, finalizado: true }];
  app.state.teams = [{ id: 'team-1', encounter_id: 'meet-1', name: 'Equipe A', metric: 'average' }];
  app.state.teamPlayers = [{ team_id: 'team-1', player_id: 'ana' }];
  app.state.roundScores = [{ game_id: 'game-1', player_id: 'ana', round_no: 1, points: 213, finalized: true }];
  app.state.predictions = [{ encounter_id: 'meet-1', user_id: 'private-auth-user-7d91', predicted_player_id: 'ana', created_at: '2026-11-13T12:00:00Z' }];
  app.state.predictionStandings = [{ player_id: 'ana', player_name: 'Ana', hits: 2, picks: 3 }];
  const exports = [];
  app.context.Blob = class { constructor(parts) { exports.push(parts.join('')); } };
  app.context.URL = { createObjectURL: () => 'blob:export', revokeObjectURL() {} };
  app.document.createElement = () => ({ click() {} });
  await app.downloadResults('csv');
  await app.downloadResults('json');
  assert.ok(exports[0].startsWith('\uFEFF'));
  const csvLines = exports[0].slice(1).split('\r\n');
  const csvHeader = csvLines[0].split(';').map((value) => value.replace(/^"|"$/g, ''));
  assert.equal(csvHeader[0], 'schema_version');
  assert.ok(csvHeader.includes('rules_config_json'));
  assert.ok(csvLines.some((line) => line.includes('"participante"') && line.includes('"Ana"')));
  assert.ok(csvLines.some((line) => line.includes('"partida"') && line.includes('"Partida"')));
  assert.ok(csvLines.some((line) => line.includes('"pontuacao"') && line.includes('"213"')));
  assert.ok(csvLines.some((line) => line.includes('"rodada"') && line.includes('"213"')));
  assert.ok(csvLines.some((line) => line.includes('"__estacao_virtual__"')));
  assert.ok(csvLines.some((line) => line.includes('"ranking"') && line.includes('"213"')));
  assert.ok(csvLines.some((line) => line.includes('"equipe"') && line.includes('"Equipe A"')));
  assert.ok(csvLines.some((line) => line.includes('"membro_equipe"') && line.includes('"Ana"')));
  assert.ok(csvLines.every((line) => line.split(';').length === csvHeader.length));
  const json = JSON.parse(exports[1]);
  assert.equal(json.schema_version, 4);
  assert.equal(json.encounters[0].rules_config.round_count, 1);
  assert.equal(json.scores[0].pista, '__estacao_virtual__');
  assert.equal(json.players[0].pista, '2');
  assert.equal(Object.hasOwn(json, 'predictions'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(json.prediction_standings)), [{ player_id: 'ana', player_name: 'Ana', hits: 2, picks: 3 }]);
  assert.doesNotMatch(JSON.stringify(json), /user_id|private-auth-user-7d91/);
  assert.equal(json.round_scores[0].points, 213);
  assert.equal(json.rankings[0].total, 213);
  assert.deepEqual(JSON.parse(JSON.stringify(json.teams)), [{ id: 'team-1', encounter_id: 'meet-1', name: 'Equipe A', metric: 'average' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(json.team_memberships)), [{ team_id: 'team-1', player_id: 'ana' }]);
  assert.equal(json.team_rankings[0].average, 213);
});

test('edição manual e confirmação sobrevivem a leituras OCR repetidas', () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana', apelido_placar: 'ANA', pista: '1' }];
  app.state.scores = [{ game_id: 'g', player_id: 'ana', pista: '1', pontos: 150, finalizado: true }];
  app.get('photoGame').value = 'g'; app.get('photoLane').value = '1';
  app.updateReviewTable();
  const score = { value: '120' }; const final = { checked: true };
  const row = { dataset: { reviewPlayer: 'ana', oldScore: '150', oldFinal: 'true', manualScore: 'false', manualFinal: 'false' }, querySelector: (selector) => selector === '.review-score' ? score : selector === '.review-final' ? final : { textContent: '' } };
  app.rows.push(row);
  app.markReviewEdited({ target: { value: '120', closest: () => row, matches: (selector) => selector === '.review-score' } });
  assert.equal(final.checked, false);
  app.updateReviewTable(new Map([['ana', { value: 110, hint: 'sugerido' }]]));
  assert.match(app.get('reviewTable').innerHTML, /value="120"/);
  assert.doesNotMatch(app.get('reviewTable').innerHTML, /class="review-final" type="checkbox" checked/);
  app.updateReviewTable(new Map([['ana', { value: 110 }]]));
  assert.match(app.get('reviewTable').innerHTML, /value="120"/);
});

test('atualização Realtime sinaliza conflito sem substituir a conferência local', async () => {
  const rows = {
    players: [{ id: 'ana', nome: 'Ana', pista: '1' }], lanes: [{ name: '1', capacity: 6 }],
    encounters: [{ id: 'e', nome: 'Encontro', status: 'active' }], encounter_players: [{ encounter_id: 'e', player_id: 'ana' }],
    games: [{ id: 'g', encounter_id: 'e', status: 'partial' }],
    scores: [{ game_id: 'g', player_id: 'ana', pista: '1', pontos: 110, finalizado: false }],
  };
  const client = {
    rpc: async () => ({ data: [], error: null }),
    from: (table) => {
      const query = { select: () => query, order: () => query, eq: () => query, not: () => query, then: (resolve) => resolve({ data: rows[table] || [], error: null }) };
      return query;
    },
  };
  const app = loadApp(client);
  app.get('photoModal').open = true; app.get('photoGame').value = 'g'; app.get('photoLane').value = '1';
  app.state.reviewViewKey = JSON.stringify(['g', '1']);
  const input = { value: '120' }; const final = { checked: true };
  app.rows.push({ dataset: { reviewPlayer: 'ana', oldScore: '100', oldFinal: 'false', manualScore: 'true', manualFinal: 'true' }, querySelector: (selector) => selector === '.review-score' ? input : selector === '.review-final' ? final : { textContent: '' } });
  await app.loadData();
  assert.equal(input.value, '120');
  assert.equal(final.checked, true);
  assert.equal(app.state.reviewConflict, true);
  assert.match(app.get('photoConfirmHint').textContent, /outro aparelho/);
});

test('resposta antiga do OCR não substitui foto ou leitura posterior', async () => {
  const app = loadApp();
  app.state.players = [{ id: 'ana', nome: 'Ana', apelido_placar: 'ANA', pista: '1' }];
  app.state.scores = [{ game_id: 'g', player_id: 'ana', pista: '1', pontos: null, finalizado: false }];
  app.get('photoGame').value = 'g'; app.get('photoLane').value = '1'; app.get('photoModal').open = true;
  app.state.image = { naturalWidth: 100, naturalHeight: 100 };
  app.context.getOcrCanvas = () => ({ width: 1000 });
  const resolvers = [];
  const engine = { recognize: () => new Promise((resolve) => resolvers.push(resolve)) };
  app.context.Tesseract = engine; app.context.window.Tesseract = engine;
  const first = app.runOcr();
  const second = app.runOcr();
  resolvers[1]({ data: { text: 'ANA 120' } }); await second;
  assert.match(app.get('reviewTable').innerHTML, /value="120"/);
  resolvers[0]({ data: { text: 'ANA 110' } }); await first;
  assert.match(app.get('reviewTable').innerHTML, /value="120"/);
});

test('sorteio distribui oito jogadores em 4+4 com capacidade seis', () => {
  const app = loadApp();
  const assignments = app.balancedLaneDraw(Array.from({ length: 8 }, (_, index) => String(index)), [{ name: '1', capacity: 6 }, { name: '2', capacity: 6 }]);
  assert.equal(assignments.length, 8);
  assert.equal(new Set(assignments.map((row) => row.player_id)).size, 8);
  assert.equal(assignments.filter((row) => row.pista === '1').length, 4);
  assert.equal(assignments.filter((row) => row.pista === '2').length, 4);
  assert.equal(app.balancedLaneDraw(['a', 'b', 'c'], [{ name: '1', capacity: 2 }]), null);
});

test('chave de quatro usa semifinal e final sem antecipar resultados pendentes', () => {
  const app = loadApp();
  app.state.games = [{ id: 's', status: 'final' }, { id: 'f', status: 'partial' }];
  app.state.scores = ['a', 'b', 'c', 'd'].map((id, index) => ({ game_id: 's', player_id: id, pontos: index % 2 ? 90 : 100, finalizado: true }));
  let rounds = app.bracketRounds({ seeds: ['a', 'b', 'c', 'd'], round_games: ['s', 'f'], tiebreak_rule: 'higher_seed' });
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].name, 'Semifinal');
  assert.equal(rounds[1].matches[0].first, 'a');
  assert.equal(rounds[1].matches[0].second, 'c');
  assert.equal(app.bracketWinner('f', 'a', 'c'), null);
});

test('exportação protege texto de fórmulas e conserva zero', async () => {
  const app = loadApp();
  app.state.encounters = [{ id: 'e', nome: '=IMPORTXML("x")', data: '2026-11-13' }];
  app.state.players = [{ id: 'p', nome: '+SUM(1)', pista: '1' }];
  app.state.encounterPlayers = [{ encounter_id: 'e', player_id: 'p' }];
  app.state.games = [{ id: 'g', encounter_id: 'e', nome: 'Partida', status: 'final' }];
  app.state.scores = [{ game_id: 'g', player_id: 'p', pista: '1', pontos: 0, finalizado: true }];
  const written = [];
  app.context.Blob = class { constructor(parts) { written.push(parts.join('')); } };
  app.context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  app.document.createElement = () => ({ click() {} });
  await app.downloadResults('csv');
  assert.match(written[0], /"'=IMPORTXML/);
  assert.match(written[0], /"'\+SUM\(1\)"/);
  assert.match(written[0], /"0";"true"/);
  assert.equal((await app.buildResultsExport()).rankings[0].average, 0);
});

test('limpeza remove só foto antiga não referenciada após confirmar perfil', async () => {
  const removed = [];
  const client = {
    storage: { from: () => ({ list: async () => ({ data: [{ id: 'old', name: 'old.jpg' }, { id: 'new', name: 'new.jpg' }], error: null }), remove: async (paths) => { removed.push(...paths); return { error: null }; } }) },
    rpc: async (_name, args) => ({ data: args.p_paths, error: null }),
  };
  const app = loadApp(client);
  const result = await app.cleanupUnusedProfilePhotos('user', 'user/new.jpg');
  assert.equal(result, null);
  assert.deepEqual(removed, ['user/old.jpg']);
});

test('usuário pode autorizar a foto pública sem enviar nova imagem', async () => {
  let payload;
  const saved = { id: 'user', nome: 'Ana', foto_path: 'user/photo.jpg', status: 'approved', player_id: 'p', photo_public_opt_in: true, updated_at: '2026-11-13T12:00:00Z' };
  const query = { eq: () => query, select: () => query, single: async () => ({ data: saved, error: null }) };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user' } } }, error: null }) },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/photo' } }), list: async () => ({ data: [{ id: '1', name: 'photo.jpg' }], error: null }) }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: saved, error: null }) }) }), update: (value) => { payload = value; return query; } }),
  };
  const app = loadApp(client);
  app.context.console = { ...console, error() {} };
  app.state.session = { user: { id: 'user' } };
  app.state.profile = { ...saved, photo_public_opt_in: false };
  app.get('profileName').value = 'Ana'; app.get('profilePhotoPublic').checked = true;
  await app.submitProfile({ preventDefault() {} });
  assert.equal(payload.photo_public_opt_in, true);
  assert.equal(payload.foto_path, 'user/photo.jpg');
  assert.equal(app.get('profileError').hidden, true);
});

test('falha ao salvar foto nova preserva a antiga e limpa só o novo envio', async () => {
  const removed = [];
  const query = { eq: () => query, select: () => query, single: async () => ({ data: null, error: { code: 'PGRST116', message: 'No rows' } }) };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user' } } }, error: null }) },
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async (paths) => { removed.push(...paths); return { error: null }; } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { foto_path: 'user/old.jpg', updated_at: '2026-11-13T12:00:00Z' }, error: null }) }) }), update: () => query }),
  };
  const app = loadApp(client);
  app.state.session = { user: { id: 'user' } };
  app.state.profile = { foto_path: 'user/old.jpg' };
  app.context.console = { ...console, error() {} };
  app.get('profileName').value = 'Ana'; app.get('profilePhoto').files = [{ name: 'nova.jpg', type: 'image/jpeg', size: 100 }];
  await app.submitProfile({ preventDefault() {} });
  assert.deepEqual(removed, ['user/photo-id.jpg']);
  assert.equal(app.state.profile.foto_path, 'user/old.jpg');
  assert.match(app.get('profileError').textContent, /outro aparelho/);
});

for (const existing of [false, true, 'stale']) {
  test(`${existing === 'stale' ? 'perfil recarregado após renovação de sessão troca' : existing ? 'perfil aprovado troca' : 'primeiro perfil envia'} foto e salva cadastro`, async () => {
    let upload;
    let write;
    const profile = { id: 'user-1', nome: 'Matheus', foto_path: 'user-1/photo-id.jpg', status: existing ? 'approved' : 'pending', player_id: existing ? 'player-1' : null, updated_at: '2026-11-13T12:00:00Z' };
    const query = {
      eq: () => query,
      select: () => query,
      single: async () => ({ data: profile, error: null }),
    };
    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }) },
      storage: { from: () => ({ upload: async (path, body, options) => { upload = { path, body, options }; return { error: null }; }, createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/photo.jpg' } }), list: async () => ({ data: [], error: null }) }) },
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existing ? { ...profile, foto_path: 'user-1/old.jpg' } : null, error: null }) }) }),
        insert: (payload) => { write = { method: 'insert', payload }; return query; },
        update: (payload) => { write = { method: 'update', payload }; return query; },
      }),
    };
    const app = loadApp(client);
    app.state.session = { user: { id: 'user-1' } };
    if (existing === true) app.state.profile = { ...profile, foto_path: 'user-1/old.jpg' };
    const file = { name: 'foto.jpg', type: 'image/jpeg', size: 100 };
    app.get(existing ? 'profileCamera' : 'profilePhoto').files = [file];
    app.get('profileName').value = 'Matheus';
    await app.submitProfile({ preventDefault() {} });
    assert.equal(upload.path, 'user-1/photo-id.jpg');
    assert.equal(upload.body, file);
    assert.equal(upload.options.contentType, 'image/jpeg');
    assert.equal(write.method, existing ? 'update' : 'insert');
    assert.equal(write.payload.status, undefined);
    assert.equal(write.payload.foto_path, upload.path);
    assert.equal(app.state.profile.status, profile.status);
    assert.equal(app.get('profileSubmitButton').disabled, false);
    assert.equal(app.get('profileError').hidden, true);
  });
}

test('foto escolhida sem nome mostra orientação antes de tentar upload', async () => {
  const app = loadApp({ storage: { from: () => { throw new Error('não deve enviar'); } } });
  app.state.session = { user: { id: 'user-1' } };
  app.get('profilePhoto').files = [{ name: 'foto.jpg', type: 'image/jpeg', size: 100 }];
  await app.submitProfile({ preventDefault() {} });
  assert.equal(app.get('profileError').hidden, false);
  assert.match(app.get('profileError').textContent, /Informe seu nome/);
});

test('foto grande do celular é reduzida para JPEG antes do upload', async () => {
  const app = loadApp();
  const blob = { size: 180000, type: 'image/jpeg' };
  app.context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  app.context.Image = class {
    naturalWidth = 3200;
    naturalHeight = 2400;
    set src(_value) { this.onload(); }
  };
  app.document.createElement = () => ({
    getContext: () => ({ fillRect() {}, drawImage() {} }),
    toBlob: (callback) => callback(blob),
  });
  const result = await app.prepareProfilePhoto({ name: 'camera.heic', type: 'image/heic', size: 8 * 1024 * 1024 });
  assert.equal(result.body, blob);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.extension, 'jpg');
});

test('confirmar foto sem pontuação explica o que falta e não chama o banco', async () => {
  const app = loadApp({ rpc: () => { throw new Error('não deve salvar'); } });
  app.get('photoGame').value = 'game-1';
  app.get('photoLane').value = '1';
  app.rows.push({
    dataset: { reviewPlayer: 'ana', oldScore: '', oldFinal: 'false' },
    querySelector: (selector) => selector === '.review-score' ? { value: '' } : { checked: false },
  });
  await app.confirmPhotoUpdate({ preventDefault() {} });
  assert.equal(app.get('photoError').hidden, false);
  assert.match(app.get('photoError').textContent, /foto sozinha não publica/);
});

test('sessão expirada informa que é preciso entrar novamente antes do upload', async () => {
  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: new Error('refresh token invalid') }) },
    storage: { from: () => { throw new Error('não deve enviar'); } },
  };
  const app = loadApp(client);
  app.context.console = { ...console, error() {} };
  app.state.session = { user: { id: 'user-1' } };
  app.get('profilePhoto').files = [{ name: 'foto.jpg', type: 'image/jpeg', size: 100 }];
  app.get('profileName').value = 'Matheus';
  await app.submitProfile({ preventDefault() {} });
  assert.equal(app.get('profileError').hidden, false);
  assert.match(app.get('profileError').textContent, /sessão expirou/);
});

test('scorecard calcula jogo perfeito e preenche os dez frames', () => {
  const app = loadApp();
  const result = app.bowlingFrames(Array(12).fill(10));
  assert.equal(result.complete, true);
  assert.equal(result.total, 300);
  assert.equal(result.frames.length, 10);
  assert.equal(result.frames[9].cumulative, 300);
});

test('scorecard preserva lançamento parcial e calcula spare completo', () => {
  const app = loadApp();
  const partial = app.bowlingFrames([10, 4]);
  assert.equal(partial.complete, false);
  assert.equal(partial.frames[0].marks[0], 'X');
  const spare = app.bowlingFrames([5, 5, 5, ...Array(17).fill(0)]);
  assert.equal(spare.complete, true);
  assert.equal(spare.frames[0].score, 15);
  assert.equal(spare.total, 20);
});
