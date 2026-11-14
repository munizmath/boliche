/* global supabase, Tesseract */

const config = window.SUPABASE_CONFIG || {};
const isDemoMode = !config.url || !config.publishableKey;
const client = !isDemoMode && window.supabase
  ? window.supabase.createClient(config.url, config.publishableKey)
  : null;

const state = {
  players: [],
  lanes: [],
  encounters: [],
  encounterPlayers: [],
  teams: [],
  teamPlayers: [],
  brackets: [],
  predictions: [],
  predictionStandings: [],
  games: [],
  scores: [],
  advancedFeeds: new Map(),
  advancedSchemaReady: false,
  invalidAdvancedFeeds: new Set(),
  advancedFeedErrors: new Map(),
  roundScores: [],
  roundScoresAvailable: true,
  roundScoreChanges: [],
  roundScoreChangesAvailable: true,
  roundDraft: new Map(),
  roundConflict: false,
  roundGameId: null,
  roundNo: null,
  profile: null,
  profiles: [],
  playerPhotos: new Map(),
  scoreChanges: [],
  scoreDetails: [],
  scoreDetailsAvailable: true,
  throwChanges: [],
  auditHistoryOffsets: { scoreChanges: 100, roundScoreChanges: 100, throwChanges: 100 },
  auditHistoryHasMore: { scoreChanges: false, roundScoreChanges: false, throwChanges: false },
  auditAuthGeneration: 0,
  gameRequestContent: null,
  session: null,
  recovering: /(?:^#|&)type=recovery(?:&|$)/.test(window.location.hash) || new URLSearchParams(window.location.search).get("type") === "recovery",
  activeGameId: null,
  activeEncounterId: null,
  editingEncounterId: null,
  encounterRequestId: null,
  encounterRequestContent: null,
  gameRequestId: null,
  editingTeamId: null,
  lastUpdatedAt: null,
  crop: null,
  image: null,
  imageFile: null,
  imageUrl: null,
  photoRotation: 0,
  photoContrast: 100,
  photoZoom: 100,
  photoPanMode: false,
  previewBase: null,
  reviewDraft: new Map(),
  reviewViewKey: null,
  reviewConflict: false,
  photoRevision: 0,
  ocrRunId: 0,
  editingPlayerId: null,
  editingLaneName: null,
  editingGameId: null,
  tabletGameId: null,
  tabletPlayerId: null,
  tabletSelectedPins: [],
  activeArea: "placar",
  activeCompetition: "teams",
};

const $ = (id) => document.getElementById(id);
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[char]));
const normalize = (value = "") => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const fmtDate = (value) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const fmtTime = (value) => value ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const localIsoDate = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const getPlayer = (id) => state.players.find((player) => player.id === id);
const getGame = (id) => state.games.find((game) => game.id === id);
const gameScores = (gameId) => state.scores.filter((score) => score.game_id === gameId);
const scoreDetail = (gameId, playerId) => state.scoreDetails.find((detail) => detail.game_id === gameId && detail.player_id === playerId);
const throwValues = (gameId, playerId) => (scoreDetail(gameId, playerId)?.throws || []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 10);
const activeEncounter = () => state.encounters.find((encounter) => encounter.id === state.activeEncounterId);
const encounterGames = () => state.games.filter((game) => game.encounter_id === state.activeEncounterId);
const encounterPlayerIds = () => new Set(state.encounterPlayers.filter((row) => row.encounter_id === state.activeEncounterId).map((row) => row.player_id));
const encounterPlayers = () => state.players.filter((player) => encounterPlayerIds().has(player.id));
const encounterOpen = () => Boolean(activeEncounter() && activeEncounter().status !== "closed");
const encounterActive = () => activeEncounter()?.status === "active";
const scoreLane = (score) => score?.pista || getPlayer(score?.player_id)?.pista || "";
const gameLaneForPlayer = (gameId, playerId) => scoreLane(state.scores.find((score) => score.game_id === gameId && score.player_id === playerId));
const VIRTUAL_STATION_LANE = "__estacao_virtual__";
const isVirtualStationLane = (name) => name === VIRTUAL_STATION_LANE;
function displayLocation(name, includeType = true) {
  if (isVirtualStationLane(name)) return "Estação";
  if (!name) return "—";
  return includeType ? `${getGameMode().locationLabel} ${name}` : name;
}
function physicalLanes() { return state.lanes.filter((lane) => !isVirtualStationLane(lane.name)); }
function gameLocations() {
  if (getGameMode().locationLabel === "Pista") return physicalLanes();
  const station = state.lanes.find((lane) => isVirtualStationLane(lane.name));
  return [station || { name: VIRTUAL_STATION_LANE, capacity: 20 }];
}
function playerLocationOptions() {
  return ["quiz", "gincana"].includes(getGameMode().id) ? gameLocations() : physicalLanes();
}
const BUILTIN_MODES = {
  boliche: { id: "boliche", name: "Boliche", unit: "pontos", roundBased: false, locationLabel: "Pista" },
  bowling: { id: "bowling", name: "Boliche", unit: "pontos", roundBased: false, locationLabel: "Pista" },
  quiz: { id: "quiz", name: "Quiz", unit: "pontos", roundBased: true, locationLabel: "Estação" },
  gincana: { id: "gincana", name: "Gincana", unit: "pontos", roundBased: true, locationLabel: "Estação" },
};
const BUILTIN_GAME_TYPES = ["boliche", "quiz", "gincana"];
let advancedModeController = null;
let advancedFeedRequests = new Map();
function advancedPresentation(id) { return window.GamePresentations?.getAdvanced?.(id) || null; }
function advancedModeModulesReady(id) {
  return Boolean(advancedPresentation(id) && window.AdvancedModeUI?.create
    && window.AdvancedGameModes?.rankResults && window.GamePresentations?.advancedDom);
}
function selectableGameTypes() {
  return [...BUILTIN_GAME_TYPES, ...(window.GamePresentations?.advanced || [])
    .filter((mode) => state.advancedSchemaReady && advancedModeModulesReady(mode.id)).map((mode) => mode.id)];
}
function isModeReady(encounter = activeEncounter()) {
  const id = typeof encounter === "string" ? encounter : encounter?.game_type || "boliche";
  return Object.prototype.hasOwnProperty.call(BUILTIN_MODES, id)
    || Boolean(state.advancedSchemaReady && advancedModeController && advancedModeModulesReady(id));
}
async function probeAdvancedSchema() {
  if (!client?.rpc) { state.advancedSchemaReady = false; return false; }
  try {
    // v19 is installed after v16-v18. Its public read RPC is a safe capability check.
    const { error } = await client.rpc("get_darts_match_results", {
      p_game_id: "00000000-0000-0000-0000-000000000000",
    });
    state.advancedSchemaReady = !error;
  } catch {
    state.advancedSchemaReady = false;
  }
  return state.advancedSchemaReady;
}
function requireReadyMode(encounter = activeEncounter()) {
  if (isModeReady(encounter)) return true;
  showToast(`Modalidade ${getGameMode(encounter).name} em preparação. Esta tela está somente para leitura.`, "warning");
  return false;
}
function getGamePresentation(id = getGameMode().id) {
  return window.GamePresentations?.get?.(id) || advancedPresentation(id) || BUILTIN_MODES[id] || { id, name: id || "Modalidade", unit: "pontos", roundBased: false, locationLabel: "Local", progressKind: "preparing" };
}
function getGameMode(encounter = activeEncounter()) {
  const id = typeof encounter === "string" ? encounter : encounter?.game_type || "boliche";
  const fallback = BUILTIN_MODES[id] || { id, name: id || "Boliche", unit: "pontos", roundBased: false, locationLabel: "Local" };
  const configured = window.GameRules?.getMode?.(id) || {};
  const presentation = window.GamePresentations?.get?.(id) || advancedPresentation(id) || {};
  const mode = {
    ...fallback,
    ...configured,
    ...presentation,
    id: configured.id || id,
    name: configured.name || configured.label || configured.title || fallback.name,
    unit: configured.unit || configured.scoreUnit || fallback.unit,
    roundBased: presentation.roundBased ?? configured.roundBased ?? configured.hasRounds ?? fallback.roundBased,
    locationLabel: presentation.locationLabel || configured.locationLabel || configured.placeLabel || fallback.locationLabel,
  };
  return { ...mode, ready: isModeReady(encounter), preparing: !isModeReady(encounter), readOnly: !isModeReady(encounter) };
}
function initializeAdvancedModeUI() {
  if (advancedModeController) { advancedModeController.init?.(); return true; }
  const sampleMode = (window.GamePresentations?.advanced || []).find((mode) => advancedModeModulesReady(mode.id));
  if (!sampleMode || !client) return false;
  try {
    advancedModeController = window.AdvancedModeUI.create({
      document, client, state,
      getActive: () => activeEncounter(),
      reload: async () => { await loadData(); },
      isAdmin,
      showToast,
      logic: window.AdvancedGameModes,
      presentations: window.GamePresentations,
    });
    advancedModeController.init();
    for (const id of ["advancedScoreModal", "advancedStatusModal"]) {
      $(id)?.addEventListener?.("close", () => {
        const encounter = activeEncounter();
        if (!encounter || !advancedPresentation(encounter.game_type) || !state.activeGameId) return;
        refreshAdvancedFeed(encounter.game_type, state.activeGameId, true).catch(() => {});
      });
    }
    return true;
  } catch (error) {
    advancedModeController = null;
    console.error("Formulários avançados indisponíveis", error);
    return false;
  }
}
function advancedFeedKey(modeId, gameId) { return `${modeId}:${gameId}`; }
function invalidateAdvancedFeeds(gameId = null) {
  for (const game of state.games) {
    const modeId = state.encounters.find((encounter) => encounter.id === game.encounter_id)?.game_type;
    if (advancedPresentation(modeId) && (!gameId || game.id === gameId)) state.invalidAdvancedFeeds.add(advancedFeedKey(modeId, game.id));
  }
}
function getAdvancedFeed(modeId, gameId) {
  if (!modeId || !gameId) return null;
  const key = advancedFeedKey(modeId, gameId);
  if (state.invalidAdvancedFeeds.has(key)) return null;
  const feed = advancedModeController?.getRankingFeed?.(modeId, gameId)
    || state.advancedFeeds.get(key) || null;
  if (feed) state.advancedFeeds.set(key, feed);
  return feed;
}
function shouldRenderAdvancedFeed(modeId, gameId, encounterId) {
  return Boolean(encounterId && activeEncounter()?.id === encounterId
    && activeEncounter()?.game_type === modeId
    && state.games.some((game) => game.id === gameId && game.encounter_id === encounterId));
}
function refreshAdvancedFeed(modeId, gameId, force = false, renderAfter = true) {
  if (!advancedModeController || !advancedModeModulesReady(modeId) || !gameId) return Promise.resolve(null);
  const key = advancedFeedKey(modeId, gameId);
  const pending = advancedFeedRequests.get(key);
  const stale = state.invalidAdvancedFeeds.has(key);
  if (pending && !force && !stale) return pending;
  const cached = getAdvancedFeed(modeId, gameId);
  if (cached && !force && !stale) return Promise.resolve(cached);
  const encounterId = state.games.find((game) => game.id === gameId)?.encounter_id;
  const request = advancedModeController.refreshFeed(modeId, gameId).then((feed) => {
    if (!feed || !Array.isArray(feed.rows)) throw new Error("O feed retornou uma resposta inválida.");
    if (advancedFeedRequests.get(key) === request) {
      state.advancedFeeds.set(key, feed);
      state.invalidAdvancedFeeds.delete(key);
      state.advancedFeedErrors.delete(key);
      if (renderAfter && shouldRenderAdvancedFeed(modeId, gameId, encounterId)) render();
    }
    return feed;
  }).catch((error) => {
    if (advancedFeedRequests.get(key) === request) {
      state.advancedFeedErrors.set(key, error?.message || "Falha ao carregar o feed.");
      if (renderAfter && shouldRenderAdvancedFeed(modeId, gameId, encounterId)) render();
    }
    throw error;
  }).finally(() => {
    if (advancedFeedRequests.get(key) === request) advancedFeedRequests.delete(key);
  });
  advancedFeedRequests.set(key, request);
  return request;
}
function ensureActiveAdvancedFeed() {
  const modeId = activeEncounter()?.game_type;
  if (advancedPresentation(modeId) && state.activeGameId && !getAdvancedFeed(modeId, state.activeGameId)) {
    refreshAdvancedFeed(modeId, state.activeGameId).catch(() => {});
  }
}
function advancedRosterRows(game, feed = getAdvancedFeed(activeEncounter()?.game_type, game?.id)) {
  if (!game) return [];
  const modeId = state.encounters.find((encounter) => encounter.id === game.encounter_id)?.game_type;
  const mode = advancedPresentation(modeId);
  if (!mode) return [];
  const rows = [...(feed?.rows || [])];
  const existing = new Set(rows.map((row) => row.player_id));
  for (const score of gameScores(game.id)) {
    if (existing.has(score.player_id)) continue;
    const base = { game_id: game.id, player_id: score.player_id, status: "pending", finalized: false, version: null, pending: true };
    if (mode.kind === "match") rows.push({ ...base, sets_won: 0 });
    else if (mode.kind === "individual") rows.push({ ...base, metric_key: mode.rankMetric, unit: mode.unit, value_text: null });
    else rows.push({ ...base, legs_won: 0, leg_no: null, balance: 501, match_complete: false, match_winner_player_id: null });
  }
  return rows.map((row) => ({ ...row, player: getPlayer(row.player_id) })).filter((row) => row.player);
}
function advancedRankedRows(game, feed = getAdvancedFeed(activeEncounter()?.game_type, game?.id)) {
  if (!game) return [];
  const rows = advancedRosterRows(game, feed);
  const logic = window.AdvancedGameModes;
  if (!logic?.rankResults) return [];
  const modeId = state.encounters.find((encounter) => encounter.id === game.encounter_id)?.game_type;
  return logic.rankResults(modeId, rows);
}
function isAdvancedEncounter(encounter = activeEncounter()) { return Boolean(advancedPresentation(encounter?.game_type)); }
function advancedRankingMetric(modeId, requested = $("rankingMetric")?.value || "total") {
  return ["total", "average", "best", "games"].includes(requested) ? requested : "total";
}
function advancedRankingLabel(modeId, metric) {
  const mode = advancedPresentation(modeId);
  if ((mode?.kind === "match" || mode?.kind === "darts") && metric === "total") return "Vitórias";
  if ((mode?.kind === "match" || mode?.kind === "darts") && metric === "average") return "Média de vitórias";
  if ((mode?.kind === "match" || mode?.kind === "darts") && metric === "best") return "Melhor resultado";
  return ({ total: "Total", average: "Média", best: "Melhor resultado", games: "Partidas" })[metric] || "Total";
}
function isSpecialIndividualMode(encounter = activeEncounter()) {
  return ["pinball", "minigolfe", "tempo"].includes(encounter?.game_type);
}
function isLegacyScoreMode(encounter = activeEncounter()) {
  return Boolean(encounter && Object.prototype.hasOwnProperty.call(BUILTIN_MODES, encounter.game_type || "boliche"));
}
function isRoundBased(encounter = activeEncounter()) { return Boolean(getGameMode(encounter).roundBased); }
function historicalModeKey(encounter) {
  const mode = getGameMode(encounter);
  const family = ["boliche", "bowling"].includes(mode.id) ? "boliche" : mode.id;
  if (!mode.roundBased) return `${family}:${mode.unit}`;
  const rules = encounterRules(encounter);
  const ruleKey = JSON.stringify(Object.keys(rules).sort().map((key) => [key, rules[key]]));
  return `${family}:${mode.unit}:${encounter?.rules_version ?? 1}:${ruleKey}`;
}
function encounterRules(encounter = activeEncounter()) { return encounter?.rules_config && typeof encounter.rules_config === "object" ? encounter.rules_config : {}; }
function configuredRoundCount(encounter = activeEncounter()) {
  const value = encounterRules(encounter).round_count ?? encounterRules(encounter).rounds;
  return Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}
function configuredRoundMax(encounter = activeEncounter()) {
  const rules = encounterRules(encounter);
  const value = rules.max_points_per_round ?? rules.round_max;
  return value === null || value === undefined || value === "" ? 0 : (Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
}
function roundPoints(row) { return row?.points ?? row?.pontos ?? null; }
function roundFinalized(row) { return Boolean(row?.finalized ?? row?.finalizado); }
function roundScoreKey(gameId, roundNo, playerId) { return `${gameId}:${roundNo}:${playerId}`; }
function reconcileRoundDrafts(roundScores = state.roundScores) {
  const gameId = state.roundGameId || $("roundGame")?.value;
  const roundNo = Number(state.roundNo || $("roundNumber")?.value);
  let conflict = false;
  for (const draft of state.roundDraft.values()) {
    if (!draft.manual || draft.gameId !== gameId || Number(draft.roundNo) !== roundNo) continue;
    const fresh = roundScores.find((row) => roundScoreKey(row.game_id, row.round_no, row.player_id) === draft.key);
    const freshPoints = fresh ? String(roundPoints(fresh) ?? "") : "";
    const freshFinalized = roundFinalized(fresh);
    if ((!draft.dirtyPoints || freshPoints === String(draft.points ?? ""))
        && (!draft.dirtyFinalized || freshFinalized === Boolean(draft.finalized))) {
      state.roundDraft.delete(draft.key);
      continue;
    }
    if ((draft.dirtyPoints && freshPoints !== String(draft.basePoints ?? "") && freshPoints !== String(draft.points ?? ""))
        || (draft.dirtyFinalized && freshFinalized !== Boolean(draft.baseFinalized) && freshFinalized !== Boolean(draft.finalized))) conflict = true;
  }
  state.roundConflict = conflict;
}
function upsertRoundScoreLocal(gameId, roundNo, playerId, points, finalized) {
  const existingIndex = state.roundScores.findIndex((row) => row.game_id === gameId && Number(row.round_no) === Number(roundNo) && row.player_id === playerId);
  const saved = { game_id: gameId, round_no: Number(roundNo), player_id: playerId, points, finalized };
  if (existingIndex < 0) state.roundScores.push(saved);
  else state.roundScores[existingIndex] = { ...state.roundScores[existingIndex], ...saved };
}
function rankScoreRows(mode, rows, metric = "total", valueOf = (row) => row.total) {
  const ranker = window.GameRules?.rankScores;
  const modeId = typeof mode === "string" ? mode : mode?.id || "boliche";
  const metricValue = (row) => {
    if (row?.[metric] !== undefined && row?.[metric] !== null) return row[metric];
    if (metric === "total") return row?.points ?? row?.score?.pontos ?? valueOf(row);
    if (metric === "points") return row?.score?.pontos ?? row?.total ?? valueOf(row);
    if (metric === "average") return row?.average ?? valueOf(row);
    if (metric === "best") return row?.best ?? valueOf(row);
    if (metric === "games") return row?.gamesPlayed ?? row?.games_played ?? valueOf(row);
    return valueOf(row);
  };
  if (typeof ranker === "function") {
    try {
      const eligible = [];
      const ineligible = [];
      rows.forEach((row, index) => {
        const value = metricValue(row);
        if (value === null || value === undefined || !Number.isFinite(Number(value))) { ineligible.push(row); return; }
        eligible.push({ ...row, [metric]: Number(value), __rankScoreIndex: index });
      });
      const ranked = ranker(modeId, eligible, metric);
      if (Array.isArray(ranked)) {
        const ordered = [];
        const seen = new Set();
        ranked.forEach((row) => {
          const index = Number(row?.__rankScoreIndex);
          if (Number.isInteger(index) && rows[index] && !seen.has(index)) { ordered.push(rows[index]); seen.add(index); }
        });
        eligible.forEach((row) => {
          const index = row.__rankScoreIndex;
          if (!seen.has(index)) { ordered.push(rows[index]); seen.add(index); }
        });
        return [...ordered, ...ineligible.sort((a, b) => String(a.player?.nome || "").localeCompare(String(b.player?.nome || ""), "pt-BR"))];
      }
    } catch (error) { console.warn("GameRules.rankScores indisponível; usando classificação local", error); }
  }
  return [...rows].sort((a, b) => Number(metricValue(b) ?? -Infinity) - Number(metricValue(a) ?? -Infinity)
    || String(a.player?.nome || a.player_name || a.player_id || "").localeCompare(String(b.player?.nome || b.player_name || b.player_id || ""), "pt-BR"));
}
const isAdmin = () => {
  if (state.session?.user?.app_metadata?.role !== "admin") return false;
  try {
    const encoded = state.session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    return claims.amr?.some((method) => method.method === "password") === true;
  } catch {
    return false;
  }
};
const isAuthenticated = () => Boolean(state.session);

function bowlingFrames(throws = []) {
  const rolls = throws.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 10);
  const frames = [];
  let cursor = 0;
  let cumulative = 0;
  for (let frameNumber = 1; frameNumber <= 9; frameNumber++) {
    const first = rolls[cursor];
    if (first == null) {
      frames.push({ number: frameNumber, throws: [], marks: [], complete: false, score: null, cumulative });
      continue;
    }
    if (first === 10) {
      const second = rolls[cursor + 1];
      const third = rolls[cursor + 2];
      const complete = second != null && third != null;
      const score = complete ? 10 + second + third : null;
      if (complete) cumulative += score;
      frames.push({ number: frameNumber, throws: [first], marks: ["X"], complete, score, cumulative, cursor });
      cursor += 1;
      continue;
    }
    const second = rolls[cursor + 1];
    if (second == null) {
      frames.push({ number: frameNumber, throws: [first], marks: [String(first)], complete: false, score: null, cumulative, cursor });
      cursor += 1;
      continue;
    }
    const valid = first + second <= 10;
    const complete = valid;
    const score = complete ? first + second + (first + second === 10 && rolls[cursor + 2] != null ? rolls[cursor + 2] : 0) : null;
    if (complete && !(first + second === 10 && rolls[cursor + 2] == null)) cumulative += score;
    frames.push({ number: frameNumber, throws: [first, second], marks: [String(first), first + second === 10 ? "/" : String(second)], complete: complete && !(first + second === 10 && rolls[cursor + 2] == null), score: complete && !(first + second === 10 && rolls[cursor + 2] == null) ? score : null, cumulative, cursor });
    cursor += 2;
  }
  const first = rolls[cursor];
  const second = rolls[cursor + 1];
  const third = rolls[cursor + 2];
  let tenthComplete = false;
  let tenthScore = null;
  let tenthMarks = [];
  if (first != null) {
    tenthMarks.push(first === 10 ? "X" : String(first));
    if (first === 10) {
      if (second != null) tenthMarks.push(second === 10 ? "X" : String(second));
      if (third != null) tenthMarks.push(third === 10 ? "X" : String(third));
      tenthComplete = second != null && third != null;
      if (tenthComplete) tenthScore = first + second + third;
    } else if (second != null) {
      tenthMarks.push(first + second === 10 ? "/" : String(second));
      if (first + second === 10 && third != null) tenthMarks.push(third === 10 ? "X" : String(third));
      tenthComplete = first + second < 10 || third != null;
      if (tenthComplete) tenthScore = first + second + (first + second === 10 ? (third || 0) : 0);
    }
  }
  if (tenthComplete) cumulative += tenthScore;
  frames.push({ number: 10, throws: rolls.slice(cursor, cursor + 3), marks: tenthMarks, complete: tenthComplete, score: tenthScore, cumulative, cursor });
  const completeTotal = frames[9].complete ? cumulative : frames.filter((frame) => frame.complete).at(-1)?.cumulative || 0;
  const partial = frames.find((frame) => !frame.complete);
  const provisional = partial && partial.number === 10 ? partial.throws.reduce((sum, value) => sum + value, 0) : partial?.throws.reduce((sum, value) => sum + value, 0) || 0;
  return { rolls, frames, total: frames[9].complete ? cumulative : completeTotal + provisional, complete: frames[9].complete };
}

function tabletDetail() {
  return state.tabletGameId && state.tabletPlayerId ? scoreDetail(state.tabletGameId, state.tabletPlayerId) : null;
}

function tabletThrows() {
  return tabletDetail()?.throws?.map(Number) || [];
}

function tabletCurrentFrame() {
  const result = bowlingFrames(tabletThrows());
  return result.frames.find((frame) => !frame.complete) || result.frames[9];
}

function tabletStandingPins() {
  const frame = tabletCurrentFrame();
  if (!frame || frame.complete) return 0;
  if (!frame.throws.length) return 10;
  if (frame.number === 10 && frame.throws[0] === 10) return frame.throws.length === 1 ? 10 : 10;
  return Math.max(0, 10 - frame.throws[0]);
}

function tabletSetPins(count) {
  const standing = tabletStandingPins();
  if (count > standing) return;
  state.tabletSelectedPins = Array.from({ length: count }, (_, index) => index + 1);
  renderTablet();
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  $("toastContainer").append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function setConnection(label, type = "muted") {
  const element = $("connectionStatus");
  element.textContent = label;
  element.className = `status-pill status-pill--${type}`;
}

function setUpdated(value = new Date().toISOString()) {
  state.lastUpdatedAt = value;
  $("lastUpdated").textContent = `Atualizado às ${fmtTime(value)}`;
}

function setModal(id, open) {
  const modal = $(id);
  if (open && !modal.open) modal.showModal();
  else if (!open && modal.open) modal.close();
}

function setSession(session) {
  if (state.session !== session) state.auditAuthGeneration++;
  state.session = session;
}

function liveAuditRows(rows, kind) {
  const gameIds = new Set(state.games.map((game) => String(game.id)));
  const playerIds = new Set(state.players.map((player) => String(player.id)));
  const scoreByPair = new Map(state.scores.map((score) => [`${score.game_id}:${score.player_id}`, score]));
  return (rows || []).filter((row) => {
    if (!gameIds.has(String(row.game_id)) || !playerIds.has(String(row.player_id))) return false;
    const score = scoreByPair.get(`${row.game_id}:${row.player_id}`);
    if (!score) return false;
    if (kind !== "roundScoreChanges" && row.score_id != null && score.id != null && String(row.score_id) !== String(score.id)) return false;
    return true;
  });
}

async function loadData() {
  if (isDemoMode) {
    state.players = []; state.lanes = []; state.encounters = []; state.encounterPlayers = []; state.games = []; state.scores = []; state.roundScores = []; state.playerPhotos = new Map(); state.activeGameId = null;
    setConnection("Supabase não configurado", "error");
    $("demoBanner").hidden = false;
    $("demoBanner").innerHTML = "<strong>Supabase não configurado</strong><span>Configure a URL e a Publishable Key antes de usar o placar. Nenhum dado fictício será exibido.</span>";
    return;
  }
  setConnection("Sincronizando…", "muted");
  if ($("roundModal")?.open) captureRoundDraft();
  const fetchAll = async (queryFactory) => {
    const firstQuery = queryFactory();
    if (typeof firstQuery.range !== "function") return firstQuery;
    const data = [];
    for (let offset = 0; ; offset += 1000) {
      const { data: page, error } = await queryFactory().range(offset, offset + 999);
      if (error) return { data: null, error };
      data.push(...(page || []));
      if ((page || []).length < 1000) return { data, error: null };
    }
  };
  const previousAudit = {
    scoreChanges: state.scoreChanges,
    roundScoreChanges: state.roundScoreChanges,
    throwChanges: state.throwChanges,
    offsets: { ...state.auditHistoryOffsets },
    hasMore: { ...state.auditHistoryHasMore },
  };
  const auditRequestGeneration = state.auditAuthGeneration;
  const auditRequestUserId = isAdmin() ? state.session?.user?.id : null;
  let [playersResult, lanesResult, encountersResult, rosterResult, gamesResult, scoresResult, scoreDetailsResult, throwChangesResult, teamsResult, teamPlayersResult, bracketsResult, predictionsResult, standingsResult, profilesResult, changesResult, publicPhotosResult, roundScoresResult, roundScoreChangesResult] = await Promise.all([
    fetchAll(() => client.from("players").select("id,nome,apelido_placar,pista").order("nome").order("id")),
    fetchAll(() => client.from("lanes").select("name,capacity").order("name")),
    fetchAll(() => client.from("encounters").select("id,nome,data,status,closed_at,prediction_closes_at,created_at,game_type,rules_version,rules_config").order("data", { ascending: false }).order("id")),
    fetchAll(() => client.from("encounter_players").select("encounter_id,player_id").order("encounter_id").order("player_id")),
    fetchAll(() => client.from("games").select("id,nome,status,encounter_id,created_at,updated_at").order("created_at", { ascending: false }).order("id")),
    fetchAll(() => client.from("scores").select("id,game_id,player_id,pista,pontos,finalizado,updated_at").order("game_id").order("player_id")),
    fetchAll(() => client.from("score_details").select("score_id,game_id,player_id,throws,pin_masks,updated_at").order("score_id")),
    isAdmin() ? client.from("throw_changes").select("id,score_id,game_id,player_id,previous_throws,new_throws,reason,changed_at,actor_id").order("id", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
    fetchAll(() => client.from("teams").select("id,encounter_id,name,metric").order("id")),
    fetchAll(() => client.from("team_players").select("team_id,player_id").order("team_id").order("player_id")),
    fetchAll(() => client.from("brackets").select("encounter_id,seeds,round_games,tiebreak_rule").order("encounter_id")),
    isAuthenticated() ? fetchAll(() => client.from("predictions").select("encounter_id,user_id,predicted_player_id,created_at").order("encounter_id").order("user_id")) : Promise.resolve({ data: [] }),
    client.rpc("prediction_standings"),
    isAdmin() ? client.rpc("list_registered_accounts") : Promise.resolve({ data: [] }),
    isAdmin() ? client.from("score_changes").select("id,score_id,game_id,player_id,previous_points,new_points,previous_finalized,new_finalized,changed_at,actor_id").order("id", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
    fetchAll(() => client.from("profiles").select("player_id,foto_path").eq("status", "approved").eq("photo_public_opt_in", true).not("player_id", "is", null).order("player_id")),
    fetchAll(() => client.from("round_scores").select("game_id,player_id,round_no,points,finalized").order("game_id").order("round_no").order("player_id")),
    isAdmin() ? client.from("round_score_changes").select("*").order("id", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
  ]);
  const migrationMissing = (result) => result?.error && ["42P01", "PGRST205"].includes(result.error.code);
  const optionalMigrationError = (result) => migrationMissing(result) ? null : result?.error;
  if (encountersResult.error && ["42703", "PGRST204"].includes(encountersResult.error.code)) {
    const legacyEncounters = await fetchAll(() => client.from("encounters").select("id,nome,data,status,closed_at,prediction_closes_at,created_at").order("data", { ascending: false }).order("id"));
    if (!legacyEncounters.error) encountersResult = { ...legacyEncounters, data: (legacyEncounters.data || []).map((item) => ({ ...item, game_type: "boliche", rules_version: null, rules_config: {} })) };
  }
  const error = playersResult.error || lanesResult.error || encountersResult.error || rosterResult.error || gamesResult.error || scoresResult.error || optionalMigrationError(scoreDetailsResult) || optionalMigrationError(throwChangesResult) || teamsResult.error || teamPlayersResult.error || bracketsResult.error || predictionsResult.error || standingsResult.error || profilesResult.error || changesResult.error || publicPhotosResult.error || optionalMigrationError(roundScoresResult) || optionalMigrationError(roundScoreChangesResult);
  if (error) throw error;
  const canApplyAudit = Boolean(auditRequestUserId && isAdmin()
    && auditRequestGeneration === state.auditAuthGeneration
    && auditRequestUserId === state.session?.user?.id);
  if ($("photoModal")?.open) {
    captureReviewDraft();
    for (const row of document.querySelectorAll("[data-review-player]")) {
      const fresh = (scoresResult.data || []).find((score) => score.game_id === $("photoGame").value && score.player_id === row.dataset.reviewPlayer);
      if (String(fresh?.pontos ?? "") !== row.dataset.oldScore || Boolean(fresh?.finalizado) !== (row.dataset.oldFinal === "true")) state.reviewConflict = true;
    }
  }
  const incomingRoundScores = migrationMissing(roundScoresResult) ? [] : (roundScoresResult.data || []);
  if ($("roundModal")?.open) reconcileRoundDrafts(incomingRoundScores);
  state.players = playersResult.data || [];
  state.lanes = lanesResult.data || [];
  state.encounters = encountersResult.data || [];
  state.encounterPlayers = rosterResult.data || [];
  state.games = gamesResult.data || [];
  state.scores = scoresResult.data || [];
  state.roundScores = incomingRoundScores;
  state.roundScoresAvailable = !migrationMissing(roundScoresResult);
  const mergeAudit = (fresh, old, key, kind) => {
    const byId = new Map();
    [...(fresh || []), ...(old || [])].forEach((row) => byId.set(String(row[key]), row));
    return liveAuditRows([...byId.values()], kind).sort((a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));
  };
  state.roundScoreChanges = canApplyAudit && !migrationMissing(roundScoreChangesResult) ? mergeAudit(roundScoreChangesResult.data, previousAudit.roundScoreChanges, "id", "roundScoreChanges") : [];
  state.roundScoreChangesAvailable = !migrationMissing(roundScoreChangesResult);
  state.scoreDetails = migrationMissing(scoreDetailsResult) ? [] : (scoreDetailsResult.data || []);
  state.scoreDetailsAvailable = !migrationMissing(scoreDetailsResult);
  state.throwChanges = canApplyAudit && !migrationMissing(throwChangesResult) ? mergeAudit(throwChangesResult.data, previousAudit.throwChanges, "id", "throwChanges") : [];
  if ($("photoModal")?.open && state.reviewConflict) updatePhotoConfirmState();
  state.teams = teamsResult.data || [];
  state.teamPlayers = teamPlayersResult.data || [];
  state.brackets = bracketsResult.data || [];
  state.predictions = predictionsResult.data || [];
  state.predictionStandings = standingsResult.data || [];
  state.profiles = isAdmin() ? (profilesResult.data || []) : [];
  state.scoreChanges = canApplyAudit ? mergeAudit(changesResult.data, previousAudit.scoreChanges, "id", "scoreChanges") : [];
  if (canApplyAudit) {
    state.auditHistoryOffsets = {
      scoreChanges: (changesResult.data || []).length,
      roundScoreChanges: migrationMissing(roundScoreChangesResult) ? 100 : (roundScoreChangesResult.data || []).length,
      throwChanges: migrationMissing(throwChangesResult) ? 100 : (throwChangesResult.data || []).length,
    };
    state.auditHistoryHasMore = {
      scoreChanges: (changesResult.data || []).length >= 100,
      roundScoreChanges: !migrationMissing(roundScoreChangesResult) && (roundScoreChangesResult.data || []).length >= 100,
      throwChanges: !migrationMissing(throwChangesResult) && (throwChangesResult.data || []).length >= 100,
    };
  } else {
    state.scoreChanges = []; state.roundScoreChanges = []; state.throwChanges = [];
    state.auditHistoryOffsets = { scoreChanges: 100, roundScoreChanges: 100, throwChanges: 100 };
    state.auditHistoryHasMore = { scoreChanges: false, roundScoreChanges: false, throwChanges: false };
  }
  const requestedEncounterId = new URLSearchParams(window.location.search).get("encontro");
  state.activeEncounterId = state.encounters.some((item) => item.id === state.activeEncounterId)
    ? state.activeEncounterId
    : state.encounters.find((item) => item.id === requestedEncounterId)?.id || state.encounters.find((item) => item.status === "active")?.id || state.encounters[0]?.id || null;
  state.activeGameId = encounterGames().some((game) => game.id === state.activeGameId)
    ? state.activeGameId
    : (encounterGames().find((game) => game.status === "partial")?.id || encounterGames()[0]?.id || null);
  // Update the form before any further await; a delayed photo URL cannot leave
  // stale controls in the DOM for another Realtime event or a save action.
  if ($("roundModal")?.open) renderRoundModal(false);
  const publicPhotos = publicPhotosResult.data || [];
  const signedPhotos = await Promise.all(publicPhotos.map(async (profile) => {
    const { data, error: photoError } = await client.storage.from("profile-photos").createSignedUrl(profile.foto_path, 300);
    if (photoError) console.warn("Foto pública indisponível", photoError);
    return [profile.player_id, data?.signedUrl || null];
  }));
  state.playerPhotos = new Map(signedPhotos.filter(([, url]) => url));
  if (isAdmin()) {
    await Promise.all(state.profiles.map(async (profile) => {
      if (!profile.foto_path) return;
      const { data } = await client.storage.from("profile-photos").createSignedUrl(profile.foto_path, 300);
      profile.photoUrl = data?.signedUrl || null;
    }));
  }
  const latest = [...state.scores, ...state.games].map((item) => item.updated_at || item.created_at).filter(Boolean).sort().at(-1);
  setUpdated(latest || new Date().toISOString());
  setConnection("Sincronizado", "success");
  invalidateAdvancedFeeds();
}

async function loadProfile() {
  state.profile = null;
  if (!client || !state.session) return;
  const { data, error } = await client.from("profiles").select("id,nome,foto_path,status,player_id,photo_public_opt_in").eq("id", state.session.user.id).maybeSingle();
  if (error) {
    console.error(error);
    return;
  }
  if (data?.foto_path) {
    const { data: signed } = await client.storage.from("profile-photos").createSignedUrl(data.foto_path, 300);
    data.photoUrl = signed?.signedUrl || null;
  }
  state.profile = data;
}

function openProfileModal() {
  if (!state.session || state.recovering) return;
  $("profileName").value = state.profile?.nome || state.session.user.user_metadata?.nome || "";
  $("profilePhoto").value = "";
  $("profileCamera").value = "";
  $("profilePhotoName").textContent = state.profile?.foto_path ? "Escolha outra foto para substituir a atual" : "Fotos grandes serão reduzidas para envio";
  $("profilePhotoPublic").checked = Boolean(state.profile?.photo_public_opt_in);
  $("profileCurrent").hidden = !state.profile?.foto_path;
  $("profileCurrentStatus").textContent = state.profile?.foto_path
    ? `Foto salva no perfil · ${state.profile.status === "approved" ? "cadastro aprovado" : state.profile.status === "rejected" ? "cadastro recusado" : "aguardando aprovação"}`
    : "";
  $("profileCurrentPhoto").hidden = !state.profile?.photoUrl;
  if (state.profile?.photoUrl) $("profileCurrentPhoto").src = state.profile.photoUrl;
  $("profileError").hidden = true;
  setModal("profileModal", true);
}

function showProfileIfNeeded() {
  if (state.recovering) return showRecoveryIfNeeded();
  if (state.session && !state.profile) window.setTimeout(openProfileModal, 0);
}

function showRecoveryIfNeeded() {
  if (!state.recovering || !state.session) return;
  sessionStorage.setItem("boliche-recovery-user", state.session.user.id);
  setModal("profileModal", false);
  $("recoveryError").hidden = true;
  setModal("recoveryModal", true);
}

async function submitRecovery(event) {
  event.preventDefault();
  const errorElement = $("recoveryError");
  const password = $("recoveryPassword").value;
  if (password !== $("recoveryPasswordConfirm").value) {
    errorElement.textContent = "As senhas não conferem.";
    errorElement.hidden = false;
    return;
  }
  const button = $("recoverySubmit");
  button.disabled = true;
  errorElement.hidden = true;
  try {
    const { error } = await client.auth.updateUser({ password });
    if (error) {
      errorElement.textContent = error.message || "Não foi possível salvar a senha. Solicite um novo link e tente novamente.";
      errorElement.hidden = false;
      return;
    }
    const email = state.session?.user?.email || "";
    const { error: signOutError } = await client.auth.signOut();
    if (signOutError) {
      errorElement.textContent = "Senha salva, mas a sessão não foi encerrada. Clique em Sair e entre com a nova senha.";
      errorElement.hidden = false;
      return;
    }
    setSession(null);
    state.recovering = false;
    sessionStorage.removeItem("boliche-recovery-user");
    $("recoveryForm").reset();
    setModal("recoveryModal", false);
    $("authEmail").value = email;
    render();
    setModal("authModal", true);
    showToast("Senha salva. Entre novamente com a nova senha.", "success");
  } catch (error) {
    console.error(error);
    errorElement.textContent = "Não foi possível salvar a senha. Tente novamente.";
    errorElement.hidden = false;
  } finally {
    button.disabled = false;
  }
}

let hasSubscribed = false;
let refreshInFlight = false;
async function refreshAfterReconnect() {
  if (document.hidden || refreshInFlight || !client) return;
  refreshInFlight = true;
  try {
    await loadData();
    render();
  } catch (error) {
    console.error(error);
    setConnection("Reconectando…", "warning");
  } finally {
    refreshInFlight = false;
  }
}

function subscribeRealtime() {
  if (!client) return;
  let channel = client.channel("boliche-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "players" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "encounters" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "encounter_players" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "team_players" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "brackets" }, refreshFromRealtime);
  if (state.advancedSchemaReady) {
    for (const table of ["match_sets", "match_player_status", "mode_player_scores", "darts_legs", "darts_leg_players", "darts_turns"]) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, refreshFromRealtime);
    }
  }
  if (state.scoreDetailsAvailable) channel = channel
    .on("postgres_changes", { event: "*", schema: "public", table: "score_details" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "throw_changes" }, refreshFromRealtime);
  if (state.roundScoresAvailable) channel = channel
    .on("postgres_changes", { event: "*", schema: "public", table: "round_scores" }, refreshFromRealtime);
  if (isAdmin() && state.roundScoreChangesAvailable) channel = channel
    .on("postgres_changes", { event: "*", schema: "public", table: "round_score_changes" }, refreshFromRealtime);
  channel
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setConnection("Ao vivo", "success");
        if (hasSubscribed) refreshAfterReconnect();
        hasSubscribed = true;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setConnection("Reconectando…", "warning");
    });
}

let realtimeRefreshTimer;
let realtimeToastTimer;
async function refreshFromRealtime() {
  window.clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = window.setTimeout(async () => {
    try {
      await loadData();
      render();
      if (!realtimeToastTimer) {
        showToast("Placar atualizado em outro aparelho.", "info");
        realtimeToastTimer = window.setTimeout(() => { realtimeToastTimer = null; }, 3000);
      }
    } catch (error) {
      setConnection("Erro de sincronização", "error");
      console.error(error);
    }
  }, 250);
}

function applyAuthUi() {
  const admin = isAdmin() && !state.recovering;
  document.querySelectorAll(".admin-only").forEach((element) => {
    element.hidden = !admin;
  });
  $("authButton").textContent = state.session ? "Sair" : "Entrar";
  $("accountMenuLabel").textContent = state.session ? "Conta" : "Entrar";
  $("authButton").title = state.session?.user?.email || "Acesso do administrador";
  $("registerButton").hidden = isAuthenticated();
  $("profileButton").hidden = !isAuthenticated() || state.recovering;
  $("profileButton").textContent = state.profile?.foto_path ? "Meu cadastro ✓" : "Meu cadastro";
  const sidebarRole = $("sidebarRole");
  if (sidebarRole) sidebarRole.textContent = state.recovering ? "Recuperação de acesso" : (isAdmin() ? "Administrador" : (state.session ? "Participante" : "Visitante"));
  const sidebarRoleNote = sidebarRole?.nextElementSibling;
  if (sidebarRoleNote) sidebarRoleNote.textContent = state.session ? (state.session.user?.email || "acesso autorizado") : "acompanha o encontro";
}

function renderEncounterBar() {
  const modeReady = isModeReady();
  const selected = state.activeEncounterId;
  $("encounterSelect").innerHTML = state.encounters.map((item) => `<option value="${esc(item.id)}">${esc(item.nome)} · ${esc(getGameMode(item).name)} · ${esc(new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${item.data}T12:00:00Z`)))}</option>`).join("");
  $("encounterSelect").value = selected || "";
  const currentModeName = activeEncounter() ? getGameMode().name : "Escolher";
  $("gameSwitchLabel").textContent = currentModeName;
  $("gameSwitchButton").setAttribute("aria-label", activeEncounter() ? `Trocar jogo. Atual: ${currentModeName}` : "Escolher jogo");
  renderGameSwitcher();
  $("encounterStatus").textContent = !activeEncounter() ? "Sem encontro" : !modeReady ? "Modalidade em preparação · somente leitura" : activeEncounter().status === "closed" ? "Encerrado" : activeEncounter().status === "preparing" ? "Preparação" : "Ativo";
  $("encounterStatus").className = `status-pill status-pill--${!activeEncounter() || !modeReady ? "muted" : encounterOpen() ? "warning" : "success"}`;
  $("editEncounterButton").disabled = !encounterOpen() || !modeReady;
  $("startEncounterButton").hidden = !isAdmin() || activeEncounter()?.status !== "preparing";
  $("startEncounterButton").disabled = !modeReady;
  $("closeEncounterButton").disabled = !activeEncounter() || activeEncounter()?.status === "preparing" || !modeReady;
  $("closeEncounterButton").textContent = encounterOpen() ? "Encerrar encontro" : "Reabrir encontro";
  $("deleteEncounterButton").disabled = !encounterOpen() || !modeReady;
  $("manageTeamsButton").disabled = !encounterOpen() || !modeReady || isAdvancedEncounter();
  $("manageBracketButton").disabled = !encounterOpen() || !modeReady || isSpecialIndividualMode();
  if (document.body.classList.contains("tv-mode")) document.querySelector(".page-title h1").textContent = activeEncounter()?.nome || "Jogatina dos Amigos";
  $("newGameButton").disabled = !encounterOpen() || !modeReady;
  $("photoButton").disabled = !encounterActive() || !modeReady;
  if ($("tabletButton")) $("tabletButton").disabled = !encounterActive() || !modeReady;
  if ($("updateScoreButton")) {
    $("updateScoreButton").disabled = !isAdmin() || state.recovering || !encounterActive() || !state.activeGameId || !modeReady;
    $("updateScoreButton").hidden = !isAdmin() || state.recovering || !modeReady || isAdvancedEncounter();
  }
  const bowling = ["boliche", "bowling"].includes(getGameMode().id);
  if ($("photoButton")) $("photoButton").hidden = !bowling || !modeReady;
  if ($("tabletButton")) $("tabletButton").hidden = !bowling || !modeReady;
  document.querySelectorAll('[data-score-action="photo"], [data-score-action="tablet"], [data-admin-action="photo"], [data-admin-action="tablet"]').forEach((button) => { button.hidden = !bowling || !modeReady; });
  if ($("updateScoreButton")) $("updateScoreButton").textContent = isRoundBased() ? "Atualizar rodadas" : "Atualizar placar";
  const updateMenu = $("scoreUpdateMenu");
  if (updateMenu && (!bowling || !modeReady)) updateMenu.hidden = true;
}

function renderGameSwitcher() {
  const list = $("gameSwitchList");
  list.innerHTML = selectableGameTypes().map((id) => {
    const mode = getGamePresentation(id);
    const encounters = state.encounters.filter((item) => (item.game_type || "boliche") === id);
    const selected = activeEncounter()?.game_type === id;
    const supported = isModeReady(id);
    return `<section class="game-choice${selected ? " game-choice--selected" : ""}" aria-label="${esc(mode.name)}"><div class="game-choice-heading"><strong>${esc(mode.name)}</strong><span>${encounters.length} ${encounters.length === 1 ? "encontro" : "encontros"}</span></div><p>${esc(mode.summary || "Placar do encontro.")}</p><div class="game-choice-encounters">${encounters.length ? encounters.map((encounter) => `<button type="button" data-select-encounter="${esc(encounter.id)}" ${encounter.id === state.activeEncounterId ? 'aria-current="true"' : ""}>${esc(encounter.nome)}<small>${encounter.status === "closed" ? "Encerrado" : encounter.status === "preparing" ? "Preparação" : "Em andamento"}</small></button>`).join("") : `<span class="empty-inline">Nenhum encontro de ${esc(mode.name)}.</span>`}</div>${isAdmin() && supported ? `<button class="game-choice-create" type="button" data-create-game-type="${id}">+ Novo encontro de ${esc(mode.name)}</button>` : !supported ? `<small>Modalidade em preparação</small>` : ""}</section>`;
  }).join("");
  const supportedNames = new Set((window.GamePresentations?.advanced || [])
    .filter((mode) => isModeReady(mode.id)).map((mode) => mode.name));
  const proposals = (window.GamePresentations?.proposed || []).filter((name) => !supportedNames.has(name));
  $("gameProposalsList").textContent = proposals.join(" · ");
  const proposalsPanel = $("gameProposalsList").closest?.("details");
  if (proposalsPanel) proposalsPanel.hidden = proposals.length === 0;
}

function selectEncounter(id) {
  if (!state.encounters.some((item) => item.id === id)) return;
  if (activeEncounter()?.id !== id && advancedModeController?.close?.() === false) return;
  state.activeEncounterId = id;
  state.activeGameId = encounterGames().find((game) => game.status === "partial")?.id || encounterGames()[0]?.id || null;
  const url = new URL(window.location.href);
  url.searchParams.set("encontro", id);
  window.history.replaceState(null, "", url);
  render();
}
function selectGame(id) {
  if (!encounterGames().some((game) => game.id === id)) return;
  if (state.activeGameId !== id && isAdvancedEncounter() && advancedModeController?.close?.() === false) return;
  state.activeGameId = id;
  render();
}

function openEncounterModal(editing = false, preferredGameType = "boliche") {
  if (advancedModeController?.close?.() === false) return;
  const encounter = editing ? activeEncounter() : null;
  if (editing && !requireReadyMode(encounter)) return;
  if (!editing && !isModeReady(preferredGameType)) return showToast("Esta modalidade está em preparação e ainda não pode ser criada.", "warning");
  if (editing && !encounterOpen()) return showToast("Reabra o encontro para editá-lo.", "error");
  state.editingEncounterId = encounter?.id || null;
  state.encounterRequestId = editing ? null : crypto.randomUUID();
  state.encounterRequestContent = null;
  $("encounterModalTitle").textContent = editing ? "Editar encontro" : "Novo encontro";
  $("encounterName").value = encounter?.nome || "";
  $("encounterDate").value = encounter?.data || localIsoDate();
  const gameType = $("encounterGameType");
  if (gameType) {
    const selectedType = encounter?.game_type || preferredGameType;
    gameType.innerHTML = selectableGameTypes().map((id) => `<option value="${esc(id)}">${esc(getGameMode(id).name)}</option>`).join("");
    gameType.value = selectedType;
  }
  if (gameType) { gameType.value = encounter?.game_type || preferredGameType; gameType.disabled = Boolean(editing); }
  const rules = encounterRules(encounter);
  const roundCount = $("encounterRoundCount");
  const roundMax = $("encounterRoundMax");
  if (roundCount) { roundCount.value = editing ? (rules.round_count ?? rules.rounds ?? "") : "3"; roundCount.disabled = Boolean(editing); }
  if (roundMax) { const configuredMax = rules.max_points_per_round ?? rules.round_max; roundMax.value = editing && Number(configuredMax) > 0 ? configuredMax : ""; roundMax.disabled = Boolean(editing); }
  renderEncounterRules();
  const roster = new Set(state.encounterPlayers.filter((row) => row.encounter_id === encounter?.id).map((row) => row.player_id));
  $("encounterPlayerSelection").innerHTML = state.players.map((player) => `<label class="selection-item"><input type="checkbox" value="${esc(player.id)}" ${editing && roster.has(player.id) ? "checked" : ""} /><span><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")}</small></span></label>`).join("");
  $("encounterFormError").hidden = true;
  setModal("encounterModal", true);
}

function renderEncounterRules() {
  const gameType = $("encounterGameType")?.value || "boliche";
  const mode = getGameMode(gameType);
  const settings = $("encounterRoundSettings");
  if (settings) settings.hidden = !mode.roundBased;
  const advancedSettings = $("advancedRulesSettings");
  const advancedMode = advancedPresentation(gameType);
  if (advancedSettings) advancedSettings.hidden = !advancedMode;
  for (const descriptor of window.GamePresentations?.advanced || []) {
    const panel = $(`advanced-rules-${descriptor.id}`);
    if (!panel) continue;
    const selected = descriptor.id === gameType && Boolean(advancedMode);
    panel.hidden = !selected;
    panel.disabled = !selected || Boolean(state.editingEncounterId);
    if (selected) {
      const stored = state.editingEncounterId ? encounterRules(activeEncounter()) : {};
      for (const rule of descriptor.rulesFields || []) {
        const input = panel.querySelector?.(`[name="${rule.name}"]`);
        if (input && !input.value) input.value = String(stored[rule.name] ?? rule.min);
      }
    }
  }
  const count = $("encounterRoundCount")?.value;
  const max = $("encounterRoundMax")?.value;
  const version = state.editingEncounterId ? activeEncounter()?.rules_version : null;
  const summary = mode.roundBased
    ? `${mode.name}: maior total vence, somando ${count || "—"} rodadas. ${max === "" || Number(max) === 0 ? "Sem limite de pontos por rodada." : `Máximo de ${max} ${mode.unit} por rodada.`}${version ? ` Regras v${version}.` : ""}`
    : advancedMode ? `${mode.summary} ${advancedMode.rulesFields?.length ? "Configure as regras antes de criar o encontro." : "Sem regras adicionais."}`
    : `${mode.name}: maior pontuação vence. Unidade: ${mode.unit}.${version ? ` Regras v${version}.` : ""}`;
  if ($("encounterRulesSummary")) $("encounterRulesSummary").textContent = summary;
}

async function saveEncounter(event) {
  event.preventDefault();
  if (state.editingEncounterId && !requireReadyMode()) return;
  const name = $("encounterName").value.trim();
  const date = $("encounterDate").value;
  const ids = [...$("encounterPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  const errorElement = $("encounterFormError");
  if (!name || !date) { errorElement.textContent = "Informe o nome e a data."; errorElement.hidden = false; return; }
  const editing = state.editingEncounterId;
  const gameType = editing ? activeEncounter()?.game_type || "boliche" : $("encounterGameType")?.value || "boliche";
  if (!isModeReady(gameType)) { errorElement.textContent = "Modalidade em preparação. O encontro ficará somente para leitura até a integração dos formulários."; errorElement.hidden = false; return; }
  let rulesConfig = editing ? encounterRules(activeEncounter()) : {};
  if (!editing && isRoundBased(gameType)) {
    const roundCountValue = $("encounterRoundCount")?.value?.trim() || "";
    const roundMaxValue = $("encounterRoundMax")?.value?.trim() || "";
    if (!/^\d+$/.test(roundCountValue) || Number(roundCountValue) < 1 || Number(roundCountValue) > 20) {
      errorElement.textContent = "Informe de 1 a 20 rodadas."; errorElement.hidden = false; return;
    }
    if (roundMaxValue !== "" && (!/^\d+$/.test(roundMaxValue) || !Number.isSafeInteger(Number(roundMaxValue)) || Number(roundMaxValue) > 2147483647)) {
      errorElement.textContent = "O limite por rodada deve ser um inteiro de 0 a 2.147.483.647."; errorElement.hidden = false; return;
    }
    rulesConfig = { round_count: Number(roundCountValue), max_points_per_round: roundMaxValue === "" ? 0 : Number(roundMaxValue) };
  }
  const advancedMode = advancedPresentation(gameType);
  if (!editing && advancedMode) {
    const panel = $(`advanced-rules-${gameType}`);
    const rawRules = Object.fromEntries((advancedMode.rulesFields || []).map((rule) => {
      const raw = panel?.querySelector?.(`[name="${rule.name}"]`)?.value;
      return [rule.name, raw === "" || raw == null ? rule.min : Number(raw)];
    }));
    try { rulesConfig = window.AdvancedGameModes.normalizeRules(gameType, rawRules); }
    catch (error) { errorElement.textContent = error.message || "Confira as regras da modalidade."; errorElement.hidden = false; return; }
    if (["pebolim", "sinuca", "tenis_mesa", "truco"].includes(gameType) && ids.length < 2) {
      errorElement.textContent = "O encontro precisa ter pelo menos dois participantes para organizar confrontos."; errorElement.hidden = false; return;
    }
    if (gameType === "dardos_501" && ids.length < 2) {
      errorElement.textContent = "O encontro precisa ter pelo menos dois participantes para organizar partidas de dardos."; errorElement.hidden = false; return;
    }
  }
  const legacyBowling = ["boliche", "bowling"].includes(gameType);
  const rpcName = editing ? "save_encounter" : advancedMode ? "create_advanced_encounter" : legacyBowling ? "create_encounter" : "create_multigame_encounter";
  const args = editing
    ? { p_encounter_id: editing, p_name: name, p_date: date, p_player_ids: ids }
    : legacyBowling
      ? { p_name: name, p_date: date, p_player_ids: ids, p_request_id: state.encounterRequestId }
      : { p_name: name, p_date: date, p_player_ids: ids, p_request_id: state.encounterRequestId, p_game_type: gameType, p_rules_config: rulesConfig };
  if (!editing && advancedMode) {
    const content = JSON.stringify({ name, date, ids: [...ids].sort(), gameType, rulesConfig });
    if (state.encounterRequestContent !== null && state.encounterRequestContent !== content) state.encounterRequestId = crypto.randomUUID();
    state.encounterRequestContent = content;
    args.p_request_id = state.encounterRequestId;
  }
  const { data, error } = await client.rpc(rpcName, args);
  if (error) { errorElement.textContent = error.message; errorElement.hidden = false; return; }
  setModal("encounterModal", false);
  state.encounterRequestContent = null;
  await loadData();
  selectEncounter(data.id);
  showToast(editing ? "Encontro atualizado." : "Encontro criado.", "success");
}

function updateRoundDraftFromRow(row, gameId, roundNo) {
  const playerId = row.dataset.roundPlayer;
  const pointsInput = row.querySelector(".round-points");
  const finalizedInput = row.querySelector(".round-final");
  if (!playerId || !pointsInput || !finalizedInput) return;
  const key = roundScoreKey(gameId, roundNo, playerId);
  const existing = state.roundScores.find((item) => roundScoreKey(item.game_id, item.round_no, item.player_id) === key);
  const prior = state.roundDraft.get(key);
  const points = pointsInput.value;
  const finalized = Boolean(finalizedInput.checked);
  const basePoints = prior?.dirtyPoints ? prior.basePoints : row.dataset.basePoints !== undefined ? (row.dataset.basePoints === "" ? null : row.dataset.basePoints) : (existing ? roundPoints(existing) : null);
  const baseFinalized = prior?.dirtyFinalized ? prior.baseFinalized : row.dataset.baseFinalized !== undefined ? row.dataset.baseFinalized === "true" : roundFinalized(existing);
  const dirtyPoints = String(points) !== String(basePoints ?? "");
  const dirtyFinalized = finalized !== Boolean(baseFinalized);
  if (!dirtyPoints && !dirtyFinalized) { state.roundDraft.delete(key); return; }
  state.roundDraft.set(key, { key, gameId, roundNo, points, finalized, manual: true, dirtyPoints, dirtyFinalized, basePoints, baseFinalized });
}

function captureRoundDraft(gameIdOverride = null, roundNoOverride = null) {
  const gameId = gameIdOverride || $("roundGame")?.value || state.roundGameId;
  const roundNo = Number(roundNoOverride || $("roundNumber")?.value || state.roundNo);
  if (!gameId || !Number.isInteger(roundNo) || roundNo < 1) return;
  $("roundResults")?.querySelectorAll("[data-round-player]").forEach((row) => updateRoundDraftFromRow(row, gameId, roundNo));
}

function markRoundEdited(event) {
  const input = event.target;
  if (!input?.matches?.(".round-points, .round-final")) return;
  const row = input.closest("[data-round-player]");
  if (!row) return;
  const gameId = $("roundGame")?.value || state.roundGameId;
  const roundNo = Number($("roundNumber")?.value || state.roundNo);
  const playerId = row.dataset.roundPlayer;
  if (!gameId || !playerId || !Number.isInteger(roundNo)) return;
  updateRoundDraftFromRow(row, gameId, roundNo);
  if ($("roundError")) $("roundError").hidden = true;
}

function openRoundModal(gameId = state.activeGameId, roundNo = state.roundNo) {
  if (!requireReadyMode()) return;
  if (!isAdmin()) return showToast("Entre como administrador para registrar resultados.", "error");
  if (!encounterActive()) return showToast("Inicie ou reabra o encontro para registrar rodadas.", "error");
  if (!isRoundBased()) return showToast("Este encontro não usa pontuação por rodadas.", "error");
  const games = encounterGames();
  state.roundGameId = games.some((game) => game.id === gameId) ? gameId : games[0]?.id || null;
  const configuredCount = configuredRoundCount();
  state.roundNo = Number.isInteger(Number(roundNo)) && Number(roundNo) > 0 && Number(roundNo) <= configuredCount ? Number(roundNo) : 1;
  reconcileRoundDrafts(state.roundScores);
  renderRoundModal();
  setModal("roundModal", true);
}

function renderRoundModal(capture = true) {
  if (!isModeReady()) return;
  if (capture && $("roundModal")?.open) captureRoundDraft(state.roundGameId, state.roundNo);
  const gameSelect = $("roundGame");
  const games = encounterGames();
  if (gameSelect) {
    gameSelect.innerHTML = games.map((game) => `<option value="${esc(game.id)}">${esc(game.nome)}</option>`).join("");
    if (games.some((game) => game.id === state.roundGameId)) gameSelect.value = state.roundGameId;
  }
  const roundSelect = $("roundNumber");
  const count = configuredRoundCount();
  if (roundSelect?.tagName === "SELECT") {
    roundSelect.innerHTML = count
      ? Array.from({ length: count }, (_, index) => `<option value="${index + 1}">Rodada ${index + 1}</option>`).join("")
      : `<option value="">Regras sem quantidade de rodadas</option>`;
  } else if (roundSelect) {
    roundSelect.min = "1"; roundSelect.max = String(count || ""); roundSelect.step = "1";
  }
  if (roundSelect) roundSelect.value = count ? String(state.roundNo || 1) : "";
  if ($("roundGame")) state.roundGameId = $("roundGame").value || state.roundGameId;
  if ($("roundNumber")) state.roundNo = Number($("roundNumber").value) || null;
  renderRoundResults();
}

function renderRoundResults() {
  const gameId = $("roundGame")?.value || state.roundGameId;
  const roundNo = Number($("roundNumber")?.value || state.roundNo);
  state.roundGameId = gameId || null;
  state.roundNo = Number.isInteger(roundNo) ? roundNo : null;
  const mode = getGameMode();
  const game = getGame(gameId);
  const max = configuredRoundMax();
  const rulesCount = configuredRoundCount();
  const rows = game ? gameScores(game.id).map((score) => ({ score, player: getPlayer(score.player_id) })).filter((item) => item.player) : [];
  const results = $("roundResults");
  if (results) results.innerHTML = rows.length && rulesCount && roundNo
    ? rows.map(({ score, player }) => {
      const key = roundScoreKey(game.id, roundNo, player.id);
      const existing = state.roundScores.find((item) => item.game_id === game.id && Number(item.round_no) === roundNo && item.player_id === player.id);
      const draft = state.roundDraft.get(key);
      const value = draft?.dirtyPoints ? draft.points : existing ? String(roundPoints(existing) ?? "") : "";
      const finalized = draft?.dirtyFinalized ? draft.finalized : roundFinalized(existing);
      const gameTotal = score.pontos == null ? "aguardando banco" : `${Number(score.pontos).toLocaleString("pt-BR")} ${mode.unit}`;
      const clearButton = existing && isAdmin() && encounterActive() ? `<button class="text-button text-button--danger" type="button" data-clear-round="${esc(player.id)}">Limpar rodada</button>` : "";
      return `<div class="round-result-row" data-round-player="${esc(player.id)}" data-base-points="${esc(existing ? String(roundPoints(existing) ?? "") : "")}" data-base-finalized="${roundFinalized(existing)}"><div class="round-result-player"><strong>${esc(player.nome)}</strong><small>Total do jogo: ${esc(gameTotal)}</small></div><label>Pontos da rodada ${roundNo}<input class="round-points" type="number" min="0"${max > 0 ? ` max="${max}"` : ""} step="1" inputmode="numeric" value="${value === "" ? "" : esc(value)}" aria-label="Pontos da rodada ${roundNo} de ${esc(player.nome)}" /></label><label class="round-confirm"><input class="round-final" type="checkbox" ${finalized ? "checked" : ""} /> Confirmar</label>${clearButton}</div>`;
    }).join("")
    : `<p class="empty-inline">${!rulesCount ? "Configure a quantidade de rodadas para este encontro." : !game ? "Crie uma partida e vincule participantes antes de lançar resultados." : "Nenhum participante vinculado à partida."}</p>`;
  const error = $("roundError");
  if (error) {
    if (state.roundConflict) {
      error.textContent = "Os resultados mudaram em outro aparelho. Seus rascunhos foram preservados; confira antes de salvar.";
      error.hidden = false;
    } else if (!error.hidden && /mudaram em outro aparelho/.test(error.textContent)) error.hidden = true;
  }
  const button = $("roundSaveButton");
  if (button) button.disabled = !isAdmin() || !encounterActive() || !rulesCount || !gameId || !roundNo;
}

async function saveRoundScores(event) {
  event?.preventDefault?.();
  if (!requireReadyMode()) return;
  captureRoundDraft();
  const errorElement = $("roundError");
  const fail = (message) => { if (errorElement) { errorElement.textContent = message; errorElement.hidden = false; } };
  const gameId = $("roundGame")?.value || state.roundGameId;
  const roundNo = Number($("roundNumber")?.value || state.roundNo);
  const max = configuredRoundMax();
  const resultRows = [...($("roundResults")?.querySelectorAll("[data-round-player]") || [])];
  if (!gameId || !Number.isInteger(roundNo) || roundNo < 1 || roundNo > configuredRoundCount()) return fail("Escolha uma partida e uma rodada válida.");
  if (!resultRows.length) return fail("Não há participantes para salvar nesta rodada.");
  if (!resultRows.some((row) => state.roundDraft.get(roundScoreKey(gameId, roundNo, row.dataset.roundPlayer))?.manual)) return fail("Nenhuma alteração nova nesta rodada.");
  if (!client) return fail("Supabase não configurado.");
  const button = $("roundSaveButton");
  if (button) { button.disabled = true; button.textContent = "Salvando…"; }
  let saved = 0;
  try {
    if (client.auth?.getSession) {
      const { data, error: authError } = await client.auth.getSession();
      setSession(data?.session || null);
      if (authError || !isAdmin()) return fail("Sua sessão de administrador expirou. Entre novamente para salvar resultados.");
    } else if (!isAdmin()) return fail("Entre como administrador para salvar resultados.");
    if (($("roundGame")?.value || state.roundGameId) !== gameId
        || Number($("roundNumber")?.value || state.roundNo) !== roundNo) return fail("A partida ou rodada mudou. Confira os resultados e salve novamente.");
    reconcileRoundDrafts(state.roundScores);
    if (state.roundConflict && !window.confirm("Os resultados mudaram em outro aparelho. Salvar somente os campos que você editou sobre os valores atuais?")) return;
    const updates = [];
    for (const row of [...($("roundResults")?.querySelectorAll("[data-round-player]") || [])]) {
      const playerId = row.dataset.roundPlayer;
      const key = roundScoreKey(gameId, roundNo, playerId);
      const draft = state.roundDraft.get(key);
      if (!draft?.manual) continue;
      const existing = state.roundScores.find((item) => item.game_id === gameId && Number(item.round_no) === roundNo && item.player_id === playerId);
      const existingPoints = roundPoints(existing);
      const raw = String(draft.dirtyPoints ? draft.points : existingPoints ?? "").trim();
      if (raw === "") return fail("Informe os pontos antes de salvar a rodada.");
      const points = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(points) || (max > 0 && points > max)) {
        return fail(max > 0 ? `Use pontos inteiros entre 0 e ${max}.` : "Use pontos inteiros não negativos.");
      }
      const finalized = draft.dirtyFinalized ? Boolean(draft.finalized) : roundFinalized(existing);
      if (existing && existingPoints != null && Number(existingPoints) === points && roundFinalized(existing) === finalized) continue;
      updates.push({ playerId, points, finalized, key,
        expectedPoints: existingPoints ?? null,
        expectedFinalized: existing ? roundFinalized(existing) : null });
    }
    if (!updates.length) return fail("Nenhuma alteração nova nesta rodada.");
    const { error } = await client.rpc("save_round_scores_batch_if_current", {
      p_game_id: gameId,
      p_round_no: roundNo,
      p_updates: updates.map((update) => ({
        player_id: update.playerId, points: update.points, finalized: update.finalized,
        expected_points: update.expectedPoints, expected_finalized: update.expectedFinalized,
      })),
    });
    if (error) {
      const message = error.code === "40001"
        ? "Lote não salvo: algum resultado mudou em outro aparelho. Seus rascunhos foram preservados; atualize e confira antes de tentar novamente."
        : `Lote não salvo; nenhum resultado foi aplicado localmente. ${error.message || "Os rascunhos foram preservados; tente novamente."}`;
      if (error.code === "40001") {
        try { await loadData(); render(); }
        catch (refreshError) { console.error(refreshError); }
      }
      return fail(message);
    }
    saved = updates.length;
    for (const update of updates) {
      upsertRoundScoreLocal(gameId, roundNo, update.playerId, update.points, update.finalized);
      state.roundDraft.delete(update.key);
    }
    state.roundConflict = false;
    state.activeGameId = gameId;
    setModal("roundModal", false);
    try {
      await loadData(); render();
      showToast(`${saved} resultado(s) da rodada salvos. O total do jogo é atualizado pelo banco.`, "success");
    } catch (refreshError) {
      console.error(refreshError);
      showToast(`${saved} resultado(s) salvos. A atualização da tela falhou; recarregue os dados.`, "warning");
    }
  } catch (error) {
    console.error(error);
    if (saved) {
      try { await loadData(); render(); }
      catch (refreshError) { console.error(refreshError); }
    }
    fail(`Falha após ${saved} resultado(s): ${error.message || "verifique a conexão e tente novamente"}.`);
  } finally {
    if (button) { button.disabled = false; button.textContent = "Salvar rodada"; }
  }
}

async function clearRoundScore(playerId) {
  if (!requireReadyMode()) return;
  const gameId = $("roundGame")?.value || state.roundGameId;
  const roundNo = Number($("roundNumber")?.value || state.roundNo);
  const player = getPlayer(playerId);
  const current = state.roundScores.find((row) => row.game_id === gameId && Number(row.round_no) === roundNo && row.player_id === playerId);
  if (!gameId || !Number.isInteger(roundNo) || !current) return;
  if (!window.confirm(`Limpar a pontuação de ${player?.nome || "este jogador"} na rodada ${roundNo}? O banco recalculará o total do jogo.`)) return;
  const { error } = await client.rpc("clear_round_score_if_current", {
    p_game_id: gameId, p_player_id: playerId, p_round_no: roundNo,
    p_expected_points: roundPoints(current) ?? null, p_expected_finalized: roundFinalized(current),
  });
  if (error) {
    if ($("roundError")) { $("roundError").textContent = error.code === "40001" ? "Esta rodada mudou em outro aparelho. Atualize os dados antes de tentar limpar novamente." : error.message || "Não foi possível limpar esta rodada."; $("roundError").hidden = false; }
    return;
  }
  state.roundDraft.delete(roundScoreKey(gameId, roundNo, playerId));
  state.roundScores = state.roundScores.filter((row) => !(row.game_id === gameId && Number(row.round_no) === roundNo && row.player_id === playerId));
  $("roundResults")?.querySelectorAll("[data-round-player]").forEach((row) => {
    if (row.dataset.roundPlayer !== playerId) return;
    const pointsInput = row.querySelector(".round-points");
    const finalizedInput = row.querySelector(".round-final");
    if (pointsInput) pointsInput.value = "";
    if (finalizedInput) finalizedInput.checked = false;
  });
  state.roundConflict = false;
  try { await loadData(); render(); showToast("Pontuação da rodada limpa; total atualizado pelo banco.", "success"); }
  catch (refreshError) { console.error(refreshError); showToast("Rodada limpa, mas a tela não atualizou. Recarregue a página.", "error"); }
}

async function toggleEncounterClosed() {
  if (!requireReadyMode()) return;
  const encounter = activeEncounter();
  if (!encounter) return;
  const closing = encounter.status === "active";
  if (closing) {
    const pending = encounterGames().filter((game) => game.status !== "final");
    if (pending.length || !encounterGames().length) {
      showToast(pending.length ? `Finalize as partidas pendentes: ${pending.map((game) => game.nome).join(", ")}.` : "Crie e finalize uma partida antes de encerrar.", "error");
      return;
    }
  }
  if (!window.confirm(closing
    ? `Encerrar ${encounter.nome}? A classificação ficará congelada até a reabertura explícita.`
    : `Reabrir ${encounter.nome}? Pontuações e partidas poderão ser corrigidas novamente.`)) return;
  const { error } = await client.rpc("set_encounter_closed", { p_encounter_id: encounter.id, p_closed: closing });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast(closing ? "Encontro encerrado." : "Encontro reaberto.", "success");
}

async function startEncounter() {
  if (!requireReadyMode()) return;
  const encounter = activeEncounter();
  if (!encounter || encounter.status !== "preparing") return;
  if (!window.confirm(`Iniciar ${encounter.nome}? Os palpites serão encerrados e as pontuações poderão ser registradas.`)) return;
  const { error } = await client.rpc("activate_encounter", { p_encounter_id: encounter.id });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast("Encontro iniciado.", "success");
}

async function downloadResults(format) {
  if (!state.encounters.length) return showToast("Nenhum encontro para exportar.", "error");
  let data;
  try { data = await buildResultsExport(); }
  catch (error) { showToast("Exportação incompleta: " + (error?.message || "não foi possível carregar resultados avançados") + ".", "error"); return; }
  let content;
  let mime;
  if (format === "json") { content = JSON.stringify(data, null, 2); mime = "application/json"; }
  else {
    const quote = (value) => {
      const raw = String(value ?? "");
      const safe = /^[\s]*[=+@\-\t\r]/.test(raw) && !/^-?\d+(?:[.,]\d+)?$/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = [
      "schema_version", "tipo", "encontro_id", "encontro", "data", "partida_id", "partida", "status_partida",
      "jogador_id", "jogador", "pista", "pontos", "confirmado", "posicao", "pontos_total", "media", "melhor",
      "partidas", "modalidade", "rules_version", "unidade", "rodada", "pontos_rodada", "team_id", "equipe",
      "metrica_equipe", "membro_jogador_id", "membro", "rules_config_json", "metric_key", "value_text",
      "status_resultado", "finalizado", "match_complete", "criterio_ranking", "unidade_resultado", "feed_json",
    ];
    const records = [];
    const add = (type, fields = {}) => records.push({ schema_version: data.schema_version, tipo: type, ...fields });
    const modeFields = (encounter) => { const mode = getGameMode(encounter); return { modalidade: mode.name, rules_version: encounter?.rules_version ?? "", unidade: mode.unit }; };
    data.encounters.forEach((encounter) => add("encontro", { encontro_id: encounter.id, encontro: encounter.nome, data: encounter.data, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter.rules_config || {}) }));
    data.participations.forEach((row) => { const encounter = data.encounters.find((item) => item.id === row.encounter_id); const player = data.players.find((item) => item.id === row.player_id); add("participante", { encontro_id: row.encounter_id, encontro: encounter?.nome, data: encounter?.data, jogador_id: row.player_id, jogador: player?.nome, pista: player?.pista, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.games.forEach((game) => { const encounter = data.encounters.find((item) => item.id === game.encounter_id); add("partida", { encontro_id: encounter?.id, encontro: encounter?.nome, data: encounter?.data, partida_id: game.id, partida: game.nome, status_partida: game.status, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.scores.forEach((score) => { const game = data.games.find((item) => item.id === score.game_id); const encounter = data.encounters.find((item) => item.id === game?.encounter_id); add("pontuacao", { encontro_id: encounter?.id, encontro: encounter?.nome, data: encounter?.data, partida_id: game?.id, partida: game?.nome, status_partida: game?.status, jogador_id: score.player_id, jogador: data.players.find((item) => item.id === score.player_id)?.nome, pista: score.pista, pontos: score.pontos, confirmado: score.finalizado, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.round_scores.forEach((score) => { const game = data.games.find((item) => item.id === score.game_id); const encounter = data.encounters.find((item) => item.id === game?.encounter_id); const participation = data.scores.find((item) => item.game_id === score.game_id && item.player_id === score.player_id); add("rodada", { encontro_id: encounter?.id, encontro: encounter?.nome, data: encounter?.data, partida_id: game?.id, partida: game?.nome, status_partida: game?.status, jogador_id: score.player_id, jogador: data.players.find((item) => item.id === score.player_id)?.nome, pista: participation?.pista || "", confirmado: score.finalized, rodada: score.round_no, pontos_rodada: roundPoints(score), ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.rankings.forEach((row) => { const encounter = data.encounters.find((item) => item.id === row.encounter_id); add("ranking", { encontro_id: encounter?.id, encontro: encounter?.nome, data: encounter?.data, jogador_id: row.player_id, jogador: data.players.find((item) => item.id === row.player_id)?.nome, posicao: row.position, pontos_total: row.total, media: row.average?.toFixed(2).replace(".", ","), melhor: row.best, partidas: row.games_played, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.team_rankings.forEach((row) => { const encounter = data.encounters.find((item) => item.id === row.encounter_id); add("ranking_equipe", { encontro_id: encounter?.id, encontro: encounter?.nome, data: encounter?.data, posicao: row.position, pontos_total: row.total, media: row.average?.toFixed(2).replace(".", ","), partidas: row.games_played, team_id: row.team_id, equipe: row.team_name, metrica_equipe: row.metric, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.teams.forEach((team) => { const encounter = data.encounters.find((item) => item.id === team.encounter_id); add("equipe", { encontro_id: encounter?.id, encontro: encounter?.nome, data: encounter?.data, team_id: team.id, equipe: team.name, metrica_equipe: team.metric, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.team_memberships.forEach((membership) => { const team = data.teams.find((item) => item.id === membership.team_id); const encounter = data.encounters.find((item) => item.id === team?.encounter_id); const player = data.players.find((item) => item.id === membership.player_id); add("membro_equipe", { encontro_id: encounter?.id, encontro: encounter?.nome, data: encounter?.data, team_id: team?.id, equipe: team?.name, metrica_equipe: team?.metric, jogador_id: player?.id, jogador: player?.nome, membro_jogador_id: player?.id, membro: player?.nome, ...modeFields(encounter), rules_config_json: JSON.stringify(encounter?.rules_config || {}) }); });
    data.advanced_results.forEach((result) => {
      const encounter = data.encounters.find((item) => item.id === result.encounter_id);
      const game = data.games.find((item) => item.id === result.game_id);
      add("feed_avancado", { encontro_id: encounter?.id, encontro: encounter?.nome, partida_id: game?.id, partida: game?.nome,
        status_partida: game?.status, metric_key: result.metric_key, unidade_resultado: result.unit,
        feed_json: JSON.stringify({ rows: result.rows, details: result.details }), ...modeFields(encounter) });
      result.rows.forEach((row) => add("resultado_avancado", { encontro_id: encounter?.id, encontro: encounter?.nome,
        partida_id: game?.id, partida: game?.nome, status_partida: game?.status, jogador_id: row.player_id,
        jogador: data.players.find((player) => player.id === row.player_id)?.nome, metric_key: row.metric_key || result.metric_key,
        value_text: row.value_text ?? "", status_resultado: row.status ?? "", finalizado: row.finalized ?? "",
        match_complete: row.match_complete ?? "", criterio_ranking: result.metric_key, unidade_resultado: result.unit,
        feed_json: JSON.stringify(row), ...modeFields(encounter) }));
    });
    data.advanced_rankings.forEach((ranking) => {
      const encounter = data.encounters.find((item) => item.id === ranking.encounter_id);
      add("ranking_avancado_status", { encontro_id: encounter?.id, encontro: encounter?.nome,
        status_partida: ranking.status, criterio_ranking: ranking.metric_label, unidade_resultado: ranking.unit,
        feed_json: JSON.stringify({ missing_game_ids: ranking.missing_game_ids }), ...modeFields(encounter) });
      ranking.rows.forEach((row) => add("ranking_avancado", { encontro_id: encounter?.id, encontro: encounter?.nome,
        jogador_id: row.player_id, jogador: row.player_name, posicao: row.position, value_text: row.value,
        status_resultado: row.status, criterio_ranking: row.metric_label, unidade_resultado: row.unit,
        feed_json: JSON.stringify(row), ...modeFields(encounter) }));
    });
    content = `\uFEFF${[header, ...records.map((record) => header.map((key) => record[key] ?? ""))].map((row) => row.map(quote).join(";")).join("\r\n")}`; mime = "text/csv;charset=utf-8";
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url; link.download = `jogatina-resultados-${localIsoDate()}.${format}`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function buildResultsExport() {
  const advancedGames = state.games.filter((game) => {
    const encounter = state.encounters.find((item) => item.id === game.encounter_id);
    return advancedPresentation(encounter?.game_type);
  });
  const feedFailures = [];
  await Promise.all(advancedGames.map(async (game) => {
    const encounter = state.encounters.find((item) => item.id === game.encounter_id);
    if (getAdvancedFeed(encounter.game_type, game.id)) return;
    try { await refreshAdvancedFeed(encounter.game_type, game.id, false, false); }
    catch (error) { feedFailures.push((game.nome || game.id) + ": " + (error?.message || "feed indisponível")); }
  }));
  for (const game of advancedGames) {
    const encounter = state.encounters.find((item) => item.id === game.encounter_id);
    if (!getAdvancedFeed(encounter.game_type, game.id) && !feedFailures.some((item) => item.startsWith((game.nome || game.id) + ":"))) {
      feedFailures.push((game.nome || game.id) + ": feed indisponível");
    }
  }
  if (feedFailures.length) throw new Error(feedFailures.join("; "));

  const rankings = state.encounters.flatMap((encounter) => {
    if (advancedPresentation(encounter.game_type)) return [];
    const finalIds = new Set(state.games.filter((game) => game.encounter_id === encounter.id && game.status === "final").map((game) => game.id));
    const rows = state.encounterPlayers.filter((item) => item.encounter_id === encounter.id).map((item) => {
      const scores = state.scores.filter((score) => score.player_id === item.player_id && finalIds.has(score.game_id) && score.finalizado && score.pontos != null);
      const total = scores.reduce((sum, score) => sum + Number(score.pontos), 0);
      return { encounter_id: encounter.id, player_id: item.player_id, total, average: scores.length ? total / scores.length : null, best: scores.length ? Math.max(...scores.map((score) => Number(score.pontos))) : null, games_played: scores.length };
    }).filter((item) => item.games_played);
    const mode = getGameMode(encounter);
    const ranked = rankScoreRows(mode, rows, "total");
    return ranked.map((row) => ({ ...row, game_type: encounter.game_type || "boliche", rules_version: encounter.rules_version ?? null, unit: mode.unit, position: ranked.findIndex((other) => other.total === row.total) + 1 }));
  });
  const team_rankings = state.encounters.flatMap((encounter) => advancedPresentation(encounter.game_type) ? [] : teamStandings(encounter.id).map((row) => ({
    encounter_id: encounter.id, team_id: row.team.id, team_name: row.team.name, metric: row.metric,
    total: row.metric === "average" ? row.value * row.confirmedGames : row.value,
    average: row.metric === "average" ? row.value : row.value / row.confirmedGames,
    games_played: row.confirmedGames, position: row.position,
  })));
  const encounters = state.encounters.map((encounter) => ({
    id: encounter.id, nome: encounter.nome, data: encounter.data, status: encounter.status, closed_at: encounter.closed_at ?? null,
    prediction_closes_at: encounter.prediction_closes_at ?? null, created_at: encounter.created_at ?? null, game_type: encounter.game_type || "boliche",
    rules_version: encounter.rules_version ?? null, rules_config: encounter.rules_config && typeof encounter.rules_config === "object" ? encounter.rules_config : {},
    mode_name: getGameMode(encounter).name, unit: getGameMode(encounter).unit,
  }));
  const advanced_results = advancedGames.map((game) => {
    const encounter = state.encounters.find((item) => item.id === game.encounter_id);
    const mode = advancedPresentation(encounter.game_type);
    const feed = getAdvancedFeed(encounter.game_type, game.id);
    return {
      encounter_id: encounter.id, game_id: game.id, game_name: game.nome,
      game_status: game.status, game_type: encounter.game_type,
      metric_key: mode.rankMetric || (mode.kind === "match" ? "match_wins" : mode.kind === "darts" ? "match_wins" : "value_text"),
      unit: mode.unit, rows: feed.rows, details: feed.details || {},
    };
  });
  const advanced_rankings = state.encounters.filter((encounter) => advancedPresentation(encounter.game_type)).map((encounter) => {
    const modeId = encounter.game_type;
    const mode = advancedPresentation(modeId);
    const finalGames = state.games.filter((game) => game.encounter_id === encounter.id && game.status === "final");
    const metric = advancedRankingMetric(modeId);
    if (!finalGames.length) return { encounter_id: encounter.id, game_type: modeId, status: "no_final_games", metric, metric_label: advancedRankingLabel(modeId, metric), unit: mode.unit, rows: [], missing_game_ids: [] };
    if (!window.AdvancedRanking?.aggregateOfficial) return { encounter_id: encounter.id, game_type: modeId, status: "unavailable", metric, metric_label: advancedRankingLabel(modeId, metric), unit: mode.unit, rows: [], missing_game_ids: finalGames.map((game) => game.id) };
    const feedsByGame = new Map(finalGames.map((game) => [game.id, getAdvancedFeed(modeId, game.id)]).filter(([, feed]) => feed));
    const aggregate = window.AdvancedRanking.aggregateOfficial(modeId, finalGames, feedsByGame, metric);
    const missingIds = [...new Set(aggregate.missingGameIds || [])];
    const aggregateRows = aggregate.rows || [];
    const metricLabel = aggregateRows.find((row) => row.metricLabel)?.metricLabel || advancedRankingLabel(modeId, metric);
    const unit = aggregateRows.find((row) => row.unitLabel)?.unitLabel || mode.unit;
    if (missingIds.length) return { encounter_id: encounter.id, game_type: modeId, status: "incomplete", metric, metric_label: metricLabel, unit, rows: [], missing_game_ids: missingIds };
    const sourceRows = new Map();
    for (const game of finalGames) for (const row of feedsByGame.get(game.id)?.rows || []) sourceRows.set(row.player_id, row);
    const rows = aggregateRows.map((row) => {
      const source = sourceRows.get(row.player_id);
      return { player_id: row.player_id, player_name: getPlayer(row.player_id)?.nome || null,
        position: row.rank, value: row.displayValue, eligible: row.rank != null,
        games_count: row.games_count, results_count: row.results_count,
        status: row.rank != null ? "Oficial" : source?.status || "Pendente",
        result_status: source?.status || null, metric_label: row.metricLabel || metricLabel,
        unit: row.unitLabel || unit };
    });
    const included = new Set(rows.map((row) => row.player_id));
    for (const game of finalGames) for (const score of state.scores.filter((item) => item.game_id === game.id)) {
      if (included.has(score.player_id)) continue;
      const player = getPlayer(score.player_id);
      if (player) rows.push({ player_id: player.id, player_name: player.nome, position: null, value: "—", eligible: false, games_count: 0, results_count: 0, status: "Pendente", result_status: null, metric_label: metricLabel, unit });
      included.add(score.player_id);
    }
    return { encounter_id: encounter.id, game_type: modeId, status: "official", metric, metric_label: metricLabel, unit, rows, missing_game_ids: [] };
  });
  return {
    schema_version: 4, exported_at: new Date().toISOString(), encounters,
    players: state.players.map((player) => ({ id: player.id, nome: player.nome, apelido_placar: player.apelido_placar ?? null, pista: player.pista ?? null })),
    participations: state.encounterPlayers.map((row) => ({ encounter_id: row.encounter_id, player_id: row.player_id })),
    games: state.games.map((game) => ({ id: game.id, nome: game.nome, status: game.status, encounter_id: game.encounter_id, created_at: game.created_at ?? null, updated_at: game.updated_at ?? null })),
    scores: state.scores.map((score) => ({ id: score.id ?? null, game_id: score.game_id, player_id: score.player_id, pista: score.pista ?? null, pontos: score.pontos ?? null, finalizado: Boolean(score.finalizado), updated_at: score.updated_at ?? null })),
    score_details: state.scoreDetails.map((detail) => ({ score_id: detail.score_id, game_id: detail.game_id, player_id: detail.player_id, throws: detail.throws ?? [], pin_masks: detail.pin_masks ?? [], updated_at: detail.updated_at ?? null })),
    round_scores: state.roundScores.map((score) => ({ game_id: score.game_id, player_id: score.player_id, round_no: score.round_no, points: roundPoints(score), finalized: roundFinalized(score) })),
    teams: state.teams.map((team) => ({ id: team.id, encounter_id: team.encounter_id, name: team.name, metric: team.metric })),
    team_memberships: state.teamPlayers.map((row) => ({ team_id: row.team_id, player_id: row.player_id })),
    brackets: state.brackets.map((bracket) => ({ encounter_id: bracket.encounter_id, seeds: bracket.seeds || [], round_games: bracket.round_games || [], tiebreak_rule: bracket.tiebreak_rule || "higher_seed" })),
    prediction_standings: state.predictionStandings.map((row) => ({ player_id: row.player_id, player_name: row.player_name, hits: row.hits, picks: row.picks })),
    rankings, team_rankings, advanced_results, advanced_rankings,
  };
}

async function deleteEncounter() {
  if (!requireReadyMode()) return;
  const encounter = activeEncounter();
  if (!encounter || !encounterOpen()) return showToast("Reabra o encontro antes de excluí-lo.", "error");
  if (!window.confirm(`Excluir permanentemente ${encounter.nome}, suas partidas, pontuações, equipes, palpites e torneio?`)) return;
  const { error } = await client.rpc("delete_encounter", { p_encounter_id: encounter.id });
  if (error) return showToast(error.message, "error");
  state.activeEncounterId = null;
  await loadData(); render(); showToast("Encontro excluído.", "success");
}

function renderTeams() {
  if (!isModeReady()) { $("teamsList").innerHTML = `<p class="empty-inline">Modalidade em preparação · classificação de equipes somente para leitura.</p>`; return; }
  if (isAdvancedEncounter()) { $("teamsList").innerHTML = `<p class="empty-inline">Classificação de equipes indisponível para esta modalidade.</p>`; return; }
  if (isSpecialIndividualMode()) { $("teamsList").innerHTML = `<p class="empty-inline">Classificação de equipes indisponível para esta modalidade.</p>`; return; }
  const ranked = teamStandings(state.activeEncounterId);
  const metric = encounterTeamMetric(state.activeEncounterId);
  if (metric == null) { $("teamsList").innerHTML = `<p class="empty-inline">Critérios diferentes entre equipes. Padronize a métrica para liberar a classificação.</p>`; return; }
  $("teamsList").innerHTML = ranked.length ? ranked.map(({ team, members, value, position }) =>
    `<div class="extra-row"><strong>${position}º ${esc(team.name)}</strong><span>${value.toFixed(metric === "average" ? 1 : 0).replace(".", ",")} ${metric === "average" ? "de média" : "pontos"}</span><small>${esc(members.map((player) => player.nome).join(", "))}</small></div>`
  ).join("") : `<p class="empty-inline">Nenhuma equipe elegível neste encontro.</p>`;
}

function encounterTeamMetric(encounterId = state.activeEncounterId) {
  const teams = state.teams.filter((team) => team.encounter_id === encounterId).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!teams.length) return "sum";
  const metrics = new Set(teams.map((team) => team.metric === "average" ? "average" : "sum"));
  return metrics.size === 1 ? [...metrics][0] : null;
}

function teamStandings(encounterId = state.activeEncounterId) {
  const encounter = state.encounters.find((item) => item.id === encounterId);
  if (isAdvancedEncounter(encounter)) return [];
  const teams = state.teams.filter((team) => team.encounter_id === encounterId);
  const metric = encounterTeamMetric(encounterId);
  if (metric == null) return [];
  const finalGameIds = new Set(state.games.filter((game) => game.encounter_id === encounterId && game.status === "final").map((game) => game.id));
  const standings = teams.map((team) => {
    const playerIds = new Set(state.teamPlayers.filter((row) => row.team_id === team.id).map((row) => row.player_id));
    const members = [...playerIds].map(getPlayer).filter(Boolean);
    const confirmed = state.scores.filter((score) => playerIds.has(score.player_id) && finalGameIds.has(score.game_id) && score.finalizado && score.pontos != null);
    const points = confirmed.reduce((sum, score) => sum + Number(score.pontos), 0);
    const value = metric === "average" ? (confirmed.length ? points / confirmed.length : null) : (confirmed.length ? points : null);
    return { team, members, value, confirmedGames: confirmed.length, metric };
  }).filter((row) => row.value != null)
    .sort((a, b) => b.value - a.value || a.team.name.localeCompare(b.team.name, "pt-BR"));
  let position = 0;
  standings.forEach((row, index) => {
    if (!index || row.value !== standings[index - 1].value) position = index + 1;
    row.position = position;
  });
  return standings;
}

function bracketWinner(gameId, first, second, rule = "higher_seed") {
  if (!gameId || !first || !second || getGame(gameId)?.status !== "final") return null;
  const scores = [first, second].map((id) => state.scores.find((score) => score.game_id === gameId && score.player_id === id && score.finalizado && score.pontos != null));
  if (scores.some((score) => !score)) return null;
  if (scores[0].pontos === scores[1].pontos) return rule === "lower_seed" ? second : first;
  return scores[0].pontos > scores[1].pontos ? first : second;
}

function bracketRounds(bracket) {
  if (!bracket) return [];
  let entrants = bracket.seeds;
  const names = bracket.seeds.length === 4 ? ["Semifinal", "Final"] : ["Quartas de final", "Semifinal", "Final"];
  return names.map((name, round) => {
    const gameId = bracket.round_games[round];
    const matches = Array.from({ length: entrants.length / 2 }, (_, i) => ({ first: entrants[i * 2], second: entrants[i * 2 + 1], gameId }));
    entrants = matches.map((match) => bracketWinner(match.gameId, match.first, match.second, bracket.tiebreak_rule));
    return { name, matches };
  });
}

function renderBracket() {
  if (!isModeReady()) { $("bracketBoard").innerHTML = `<p class="empty-inline">Modalidade em preparação · chave somente para leitura.</p>`; return; }
  if (isSpecialIndividualMode()) { $("bracketBoard").innerHTML = `<p class="empty-inline">Torneio eliminatório indisponível para esta modalidade.</p>`; return; }
  const bracket = state.brackets.find((item) => item.encounter_id === state.activeEncounterId);
  if (!bracket) { $("bracketBoard").innerHTML = `<p class="empty-inline">Chave ainda não criada.</p>`; return; }
  const rounds = bracketRounds(bracket);
  $("bracketBoard").innerHTML = rounds.map(({ name, matches }) => `<div class="bracket-round"><strong>${name}</strong>${matches.map(({ first, second, gameId }) => {
    const winner = bracketWinner(gameId, first, second, bracket.tiebreak_rule);
    return `<div class="extra-row"><span>${esc(getPlayer(first)?.nome || "A definir")} × ${esc(getPlayer(second)?.nome || "A definir")}</span><small>${esc(getGame(gameId)?.nome || "Escolha uma partida")} · ${winner ? `avança ${esc(getPlayer(winner)?.nome)}` : "aguardando resultado"}</small></div>`;
  }).join("")}</div>`).join("") + (rounds.at(-1)?.matches?.[0] && bracketWinner(rounds.at(-1).matches[0].gameId, rounds.at(-1).matches[0].first, rounds.at(-1).matches[0].second, bracket.tiebreak_rule) ? `<p class="section-meta">Campeão: ${esc(getPlayer(bracketWinner(rounds.at(-1).matches[0].gameId, rounds.at(-1).matches[0].first, rounds.at(-1).matches[0].second, bracket.tiebreak_rule))?.nome)}</p>` : "");
}

function renderRecords() {
  const encounter = activeEncounter();
  const mode = getGameMode(encounter);
  if (!mode.ready) { $("groupRecords").innerHTML = `<p class="empty-inline">Modalidade em preparação · recordes ficam ocultos até a integração dos formulários.</p>`; return; }
  if (isSpecialIndividualMode(encounter)) { $("groupRecords").innerHTML = `<p class="empty-inline">Recordes históricos indisponíveis para esta modalidade até a integração do feed oficial.</p>`; return; }
  const matchingEncounters = state.encounters.filter((item) => historicalModeKey(item) === historicalModeKey(encounter));
  const matchingEncounterIds = new Set(matchingEncounters.map((item) => item.id));
  const finalGames = state.games.filter((game) => game.status === "final" && matchingEncounterIds.has(game.encounter_id));
  const finalIds = new Set(finalGames.map((game) => game.id));
  const scores = state.scores.filter((score) => finalIds.has(score.game_id) && score.finalizado && score.pontos != null);
  const highValue = scores.length ? Math.max(...scores.map((score) => Number(score.pontos))) : null;
  const highRows = highValue == null ? [] : scores.filter((score) => Number(score.pontos) === highValue);
  const byEncounterPlayer = new Map();
  scores.forEach((score) => {
    const game = getGame(score.game_id);
    const key = `${game?.encounter_id}:${score.player_id}`;
    if (!byEncounterPlayer.has(key)) byEncounterPlayer.set(key, { player: getPlayer(score.player_id), encounter: matchingEncounters.find((item) => item.id === game?.encounter_id), items: [] });
    byEncounterPlayer.get(key).items.push(score);
  });
  const perEncounterPlayer = [...byEncounterPlayer.values()].map(({ player, encounter: recordEncounter, items }) => ({ player, encounter: recordEncounter, items, average: items.reduce((sum, item) => sum + Number(item.pontos), 0) / items.length, total: items.reduce((sum, item) => sum + Number(item.pontos), 0) }));
  const bestAverageValue = perEncounterPlayer.length ? Math.max(...perEncounterPlayer.map((item) => item.average)) : null;
  const bestAverage = perEncounterPlayer.filter((item) => item.average === bestAverageValue);
  const biggestTotalValue = perEncounterPlayer.length ? Math.max(...perEncounterPlayer.map((item) => item.total)) : null;
  const biggestTotal = perEncounterPlayer.filter((item) => item.total === biggestTotalValue);
  const growthRows = [...byEncounterPlayer.values()].flatMap(({ items, encounter: recordEncounter }) => {
    const ordered = [...items].sort((a, b) => new Date(getGame(a.game_id)?.created_at) - new Date(getGame(b.game_id)?.created_at));
    return ordered.slice(1).map((score, index) => ({ score, encounter: recordEncounter, diff: Number(score.pontos) - Number(ordered[index].pontos) }));
  });
  const growthValue = growthRows.length ? Math.max(...growthRows.map((item) => item.diff)) : null;
  const growth = growthValue == null ? [] : growthRows.filter((item) => item.diff === growthValue);
  const wins = new Map();
  finalGames.forEach((game) => {
    const results = scores.filter((score) => score.game_id === game.id);
    const highest = results.length ? Math.max(...results.map((score) => Number(score.pontos))) : null;
    const leaders = highest == null ? [] : results.filter((score) => Number(score.pontos) === highest);
    if (leaders.length === 1) wins.set(leaders[0].player_id, (wins.get(leaders[0].player_id) || 0) + 1);
  });
  const winHigh = wins.size ? Math.max(...wins.values()) : null;
  const winLeaders = winHigh == null ? [] : [...wins].filter(([, count]) => count === winHigh);
  const recordNames = (rows) => rows.map((row) => {
    const game = getGame(row.game_id);
    const recordEncounter = matchingEncounters.find((item) => item.id === game?.encounter_id);
    return `${esc(getPlayer(row.player_id)?.nome || "Jogador")} · ${esc(recordEncounter?.nome || "Encontro")}${game?.nome ? ` · ${esc(game.nome)}` : ""}`;
  }).join(", ");
  const encounterPlayerNames = (rows) => rows.map((row) => `${esc(row.player?.nome || "Jogador")} · ${esc(row.encounter?.nome || "Encontro")}`).join(", ");
  const appearanceByPlayer = new Map();
  scores.forEach((score) => appearanceByPlayer.set(score.player_id, (appearanceByPlayer.get(score.player_id) || 0) + 1));
  const appearanceTop = appearanceByPlayer.size ? Math.max(...appearanceByPlayer.values()) : null;
  const appearanceRows = appearanceTop == null ? [] : [...appearanceByPlayer].filter(([, count]) => count === appearanceTop);
  $("groupRecords").innerHTML = scores.length ? `<p class="section-meta">Histórico de ${esc(mode.name)} · unidade: ${esc(mode.unit)} · ${matchingEncounters.length} ${matchingEncounters.length === 1 ? "encontro" : "encontros"} compatíveis</p><div class="extra-row"><strong>Maior pontuação em uma partida</strong><span>${highValue} ${esc(mode.unit)} · ${recordNames(highRows)}</span></div><div class="extra-row"><strong>Maior total em um encontro</strong><span>${biggestTotalValue} ${esc(mode.unit)} · ${encounterPlayerNames(biggestTotal)}</span></div><div class="extra-row"><strong>Melhor média em um encontro</strong><span>${bestAverageValue.toFixed(1).replace(".", ",")} ${esc(mode.unit)} · ${encounterPlayerNames(bestAverage)}</span></div><div class="extra-row"><strong>Maior evolução</strong><span>${growth.length && growthValue > 0 ? `+${growthValue} ${esc(mode.unit)} · ${growth.map(({ score, encounter: recordEncounter }) => `${esc(getPlayer(score.player_id)?.nome || "Jogador")} · ${esc(recordEncounter?.nome || "Encontro")}`).join(", ")}` : "Aguardando duas partidas no mesmo encontro"}</span></div><div class="extra-row"><strong>Mais vitórias isoladas</strong><span>${winLeaders.length ? `${winHigh} · ${winLeaders.map(([id]) => esc(getPlayer(id)?.nome || "Jogador")).join(", ")}` : "Nenhuma vitória isolada"}</span></div><div class="extra-row"><strong>Mais participações</strong><span>${appearanceRows.length ? `${appearanceTop} · ${appearanceRows.map(([id]) => esc(getPlayer(id)?.nome || "Jogador")).join(", ")}` : "—"}</span></div><small>Somente partidas finais e pontos confirmados de encontros com modalidade e regras comparáveis. Empates permanecem compartilhados; vitórias contam apenas quando há líder isolado.</small>` : `<p class="empty-inline">${encounter ? `Ainda não há resultados finais de ${esc(mode.name)} (${esc(mode.unit)}).` : "Selecione um encontro para ver os recordes."}</p>`;
}

function renderPredictions() {
  const panel = $("predictionsSection");
  const encounter = activeEncounter();
  if (encounter && !isModeReady(encounter)) { panel.hidden = true; return; }
  if (isSpecialIndividualMode(encounter)) {
    panel.hidden = false;
    $("predictionHint").textContent = "Palpites indisponíveis para esta modalidade.";
    $("predictionPlayer").hidden = true; $("savePredictionButton").hidden = true;
    $("predictionBoard").innerHTML = `<p class="empty-inline">Classificação de palpites indisponível para esta modalidade.</p>`;
    $("predictionAccuracy").textContent = "";
    return;
  }
  const userId = state.session?.user?.id;
  const canPredict = Boolean(userId && state.profile?.status === "approved");
  panel.hidden = !encounter;
  if (panel.hidden) return;
  const started = encounter.status !== "preparing" || (encounter.prediction_closes_at && Date.now() >= new Date(encounter.prediction_closes_at).getTime());
  const existing = state.predictions.find((prediction) => prediction.encounter_id === encounter.id && prediction.user_id === userId);
  $("predictionHint").textContent = started ? "Palpites deste encontro encerrados." : canPredict ? `Quem vencerá ${encounter.nome}? Seu palpite pode mudar até o início ou prazo definido.` : "Entre com um cadastro aprovado para registrar um palpite.";
  $("predictionPlayer").innerHTML = `<option value="">Escolha um jogador</option>${encounterPlayers().map((player) => `<option value="${esc(player.id)}">${esc(player.nome)}</option>`).join("")}`;
  $("predictionPlayer").value = existing?.predicted_player_id || "";
  $("predictionPlayer").hidden = !canPredict;
  $("savePredictionButton").hidden = !canPredict;
  $("predictionPlayer").disabled = started;
  $("savePredictionButton").disabled = started;
  const ownStanding = state.predictionStandings.find((row) => row.player_id === state.profile?.player_id);
  $("predictionAccuracy").textContent = ownStanding ? `${ownStanding.hits}/${ownStanding.picks} palpites certos` : "Nenhum palpite decidido";
  $("predictionBoard").innerHTML = state.predictionStandings.map((row, index) => `<div class="extra-row"><strong>${index + 1}º ${esc(row.player_name)}</strong><span>${row.hits}/${row.picks} acertos</span></div>`).join("") || `<p class="empty-inline">Classificação recreativa após o primeiro encontro encerrado.</p>`;
  const deadlineInput = $("predictionDeadline");
  deadlineInput.disabled = encounter.status !== "preparing";
  $("savePredictionDeadline").disabled = deadlineInput.disabled;
  if (document.activeElement !== deadlineInput) deadlineInput.value = encounter.prediction_closes_at ? new Date(encounter.prediction_closes_at).toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(" ", "T") : "";
}

function renderTeamEditor() {
  const teams = state.teams.filter((team) => team.encounter_id === state.activeEncounterId);
  $("teamEditorList").innerHTML = teams.map((team) => `<div class="extra-row"><strong>${esc(team.name)}</strong><small>${team.metric === "average" ? "Média" : "Soma"} · ${esc(state.teamPlayers.filter((row) => row.team_id === team.id).map((row) => getPlayer(row.player_id)?.nome).filter(Boolean).join(", "))}</small><div><button class="text-button" type="button" data-edit-team="${esc(team.id)}">Editar</button><button class="text-button text-button--danger" type="button" data-delete-team="${esc(team.id)}">Excluir</button></div></div>`).join("");
  $("teamEditorList").querySelectorAll("[data-edit-team]").forEach((button) => button.addEventListener("click", () => editTeam(button.dataset.editTeam)));
  $("teamEditorList").querySelectorAll("[data-delete-team]").forEach((button) => button.addEventListener("click", () => deleteTeam(button.dataset.deleteTeam)));
}

function openTeamsModal() {
  if (!requireReadyMode()) return;
  if (isAdvancedEncounter()) return showToast("Equipes indisponíveis para esta modalidade.", "warning");
  if (!encounterOpen()) return showToast("Reabra o encontro para editar equipes.", "error");
  state.editingTeamId = null;
  $("teamForm").reset();
  const teams = state.teams.filter((team) => team.encounter_id === state.activeEncounterId);
  const commonMetric = encounterTeamMetric();
  $("teamMetric").value = commonMetric || "sum";
  $("teamMetric").disabled = teams.length > 0 && commonMetric != null;
  $("cancelTeamEdit").hidden = true;
  $("teamPlayerSelection").innerHTML = encounterPlayers().map((player) => `<label class="selection-item"><input type="checkbox" value="${esc(player.id)}" /><span>${esc(player.nome)}</span></label>`).join("");
  renderTeamEditor(); setModal("teamsModal", true);
}

function editTeam(id) {
  const team = state.teams.find((item) => item.id === id);
  if (!team) return;
  state.editingTeamId = id;
  $("teamName").value = team.name;
  const teams = state.teams.filter((item) => item.encounter_id === state.activeEncounterId);
  const commonMetric = encounterTeamMetric();
  $("teamMetric").value = commonMetric || (team.metric === "average" ? "average" : "sum");
  $("teamMetric").disabled = teams.length > 1 && commonMetric != null;
  const members = new Set(state.teamPlayers.filter((row) => row.team_id === id).map((row) => row.player_id));
  $("teamPlayerSelection").querySelectorAll("input").forEach((input) => { input.checked = members.has(input.value); });
  $("cancelTeamEdit").hidden = false;
}

async function saveTeam(event) {
  if (!requireReadyMode()) return;
  if (isAdvancedEncounter()) return showToast("Equipes indisponíveis para esta modalidade.", "warning");
  event.preventDefault();
  const playerIds = [...$("teamPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  if (!playerIds.length) { $("teamError").textContent = "Escolha pelo menos um jogador."; $("teamError").hidden = false; return; }
  const teams = state.teams.filter((team) => team.encounter_id === state.activeEncounterId);
  const commonMetric = encounterTeamMetric();
  if (teams.length && commonMetric == null && !state.editingTeamId) { $("teamError").textContent = "Padronize a métrica das equipes existentes antes de criar outra."; $("teamError").hidden = false; return; }
  const metric = teams.length && commonMetric != null && (!state.editingTeamId || teams.length > 1) ? commonMetric : $("teamMetric").value;
  const { error } = await client.rpc("save_team", { p_team_id: state.editingTeamId, p_encounter_id: state.activeEncounterId, p_name: $("teamName").value.trim(), p_metric: metric, p_player_ids: playerIds });
  if (error) { $("teamError").textContent = error.message; $("teamError").hidden = false; return; }
  await loadData(); render(); openTeamsModal(); showToast("Equipe salva.", "success");
}

async function deleteTeam(id) {
  if (!requireReadyMode()) return;
  const team = state.teams.find((item) => item.id === id);
  if (!team || !window.confirm(`Excluir a equipe ${team.name}?`)) return;
  const { error } = await client.rpc("delete_team", { p_team_id: id });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); renderTeamEditor(); showToast("Equipe excluída.", "success");
}

function openBracketModal() {
  if (!requireReadyMode()) return;
  if (isSpecialIndividualMode()) return showToast("Torneios indisponíveis para esta modalidade.", "warning");
  if (!encounterOpen()) return showToast("Reabra o encontro para editar o torneio.", "error");
  const bracket = state.brackets.find((item) => item.encounter_id === state.activeEncounterId);
  const selected = new Set(bracket?.seeds || []);
  const players = [...(bracket?.seeds || []).map(getPlayer).filter(Boolean), ...encounterPlayers().filter((player) => !selected.has(player.id))];
  $("bracketPlayerSelection").innerHTML = players.map((player) => `<label class="selection-item"><input type="checkbox" value="${esc(player.id)}" ${selected.has(player.id) ? "checked" : ""} /><span>${esc(player.nome)}</span></label>`).join("");
  const options = `<option value="">Escolha a partida</option>${encounterGames().map((game) => `<option value="${esc(game.id)}">${esc(game.nome)} · ${game.status === "final" ? "final" : "parcial"}</option>`).join("")}`;
  [0, 1, 2].forEach((round) => { $(`bracketGame${round}`).innerHTML = options; $(`bracketGame${round}`).value = bracket?.round_games[round] || ""; });
  $("bracketTieRule").value = bracket?.tiebreak_rule || "higher_seed";
  updateBracketRoundLabels();
  $("deleteBracketButton").hidden = !bracket;
  $("bracketError").hidden = true;
  setModal("bracketModal", true);
}

function updateBracketRoundLabels() {
  const count = $("bracketPlayerSelection").querySelectorAll("input:checked").length;
  $("bracketRound0").firstChild.textContent = count === 4 ? "Semifinal" : "Quartas de final";
  $("bracketRound1").firstChild.textContent = count === 4 ? "Final" : "Semifinal";
  $("bracketRound2").hidden = count === 4;
}

async function saveBracket(event) {
  event.preventDefault();
  if (!requireReadyMode()) return;
  if (isSpecialIndividualMode()) return showToast("Torneios indisponíveis para esta modalidade.", "warning");
  const seeds = [...$("bracketPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  if (![4, 8].includes(seeds.length)) { $("bracketError").textContent = "Escolha quatro ou oito jogadores."; $("bracketError").hidden = false; return; }
  const games = Array.from({ length: seeds.length === 4 ? 2 : 3 }, (_, round) => $(`bracketGame${round}`).value || null);
  if (new Set(games.filter(Boolean)).size !== games.filter(Boolean).length) { $("bracketError").textContent = "Escolha partidas diferentes para cada rodada."; $("bracketError").hidden = false; return; }
  const { error } = await client.rpc("save_bracket", { p_encounter_id: state.activeEncounterId, p_seeds: seeds, p_round_games: games, p_tiebreak_rule: $("bracketTieRule").value });
  if (error) { $("bracketError").textContent = error.message; $("bracketError").hidden = false; return; }
  setModal("bracketModal", false); await loadData(); render(); showToast("Chave salva.", "success");
}

async function deleteBracket() {
  if (!requireReadyMode()) return;
  if (isSpecialIndividualMode()) return showToast("Torneios indisponíveis para esta modalidade.", "warning");
  if (!window.confirm("Excluir a chave eliminatória deste encontro?")) return;
  const { error } = await client.from("brackets").delete().eq("encounter_id", state.activeEncounterId);
  if (error) return showToast(error.message, "error");
  setModal("bracketModal", false); await loadData(); render(); showToast("Chave excluída.", "success");
}

async function savePrediction() {
  if (!requireReadyMode()) return;
  const playerId = $("predictionPlayer").value;
  if (!playerId) return showToast("Escolha quem você acha que vai vencer.", "error");
  const { error } = await client.from("predictions").upsert({ encounter_id: state.activeEncounterId, user_id: state.session.user.id, predicted_player_id: playerId }, { onConflict: "encounter_id,user_id" });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast("Palpite salvo.", "success");
}

async function savePredictionDeadline() {
  if (!requireReadyMode()) return;
  const value = $("predictionDeadline").value;
  const deadline = value ? new Date(value).toISOString() : null;
  const { error } = await client.rpc("set_prediction_deadline", { p_encounter_id: state.activeEncounterId, p_deadline: deadline });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast("Prazo dos palpites atualizado.", "success");
}

const AREA_TITLES = { placar: "Placar", historico: "Histórico", competicoes: "Competições", admin: "Administração" };

function setActiveArea(area, { scroll = true } = {}) {
  const requested = AREA_TITLES[area] ? area : "placar";
  const next = requested === "admin" && !isAdmin() ? "placar" : requested;
  state.activeArea = next;
  document.querySelectorAll("[data-area]").forEach((element) => { element.hidden = element.dataset.area !== next; });
  document.querySelectorAll("[data-area-target]").forEach((button) => {
    const active = button.dataset.areaTarget === next;
    button.classList.toggle("nav-link--active", active);
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  const title = $("pageTitle");
  if (title && !document.body.classList.contains("tv-mode")) title.textContent = AREA_TITLES[next];
  closeMobileMoreMenu();
  if (scroll) window.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" });
}

function renderAreaNavigation() {
  setActiveArea(state.activeArea || "placar", { scroll: false });
}

function renderCompetitionArea() {
  const selected = state.activeCompetition || "teams";
  document.querySelectorAll("[data-competition-panel]").forEach((panel) => { panel.hidden = panel.dataset.competitionPanel !== selected; });
  document.querySelectorAll("[data-competition-tab]").forEach((button) => {
    const active = button.dataset.competitionTab === selected;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function closeMobileMoreMenu() {
  const menu = $("mobileMoreMenu");
  if (!menu) return;
  menu.hidden = true;
  $("mobileMoreButton")?.setAttribute("aria-expanded", "false");
}

function render() {
  if (activeEncounter() && !isModeReady()) ["gameModal", "photoModal", "tabletModal", "roundModal", "teamsModal", "bracketModal", "encounterModal"].forEach((id) => { if ($(id)?.open) setModal(id, false); });
  applyAuthUi();
  if (!isAdmin() && state.activeArea === "admin") state.activeArea = "placar";
  renderAreaNavigation();
  renderCompetitionArea();
  renderLeaderboard();
  renderEncounterBar();
  renderCurrentGame();
  renderGames();
  if ($("tabletModal")?.open) renderTablet();
  renderTeams(); renderBracket(); renderRecords(); renderPredictions();
  if (!$("gameModal").open) renderPlayerSelection();
  if (!$("photoModal").open) renderPhotoOptions();
  if ($("playersModal").open) renderPlayers();
  if ($("approvalsModal").open) renderApprovals();
  if ($("historyModal").open) renderScoreHistory();
  if ($("roundModal")?.open) renderRoundModal();
  if (isAdvancedEncounter() && isModeReady()) {
    advancedModeController?.render?.();
    ensureActiveAdvancedFeed();
  }
}

function officialTotals(lane = "") {
  const finalGameIds = new Set(encounterGames().filter((game) => game.status === "final").map((game) => game.id));
  const metric = $("rankingMetric")?.value || "total";
  const rows = (finalGameIds.size ? encounterPlayers() : []).map((player) => {
    const results = state.scores.filter((score) => score.player_id === player.id && finalGameIds.has(score.game_id) && score.finalizado && score.pontos != null && (!lane || scoreLane(score) === lane));
    const points = results.reduce((sum, score) => sum + Number(score.pontos), 0);
    const gamesPlayed = results.length;
    const current = state.scores.find((score) => score.game_id === state.activeGameId && score.player_id === player.id);
    return { player, points, gamesPlayed, average: gamesPlayed ? points / gamesPlayed : null, best: gamesPlayed ? Math.max(...results.map((score) => Number(score.pontos))) : null, current, lane: results.at(-1)?.pista || current?.pista || player.pista };
  }).filter((item) => item.gamesPlayed > 0);
  return isRoundBased() ? rankScoreRows(getGameMode(), rows, metric, (item) => rankingValue(item, metric))
    : rows.sort((a, b) => rankingValue(b, metric) - rankingValue(a, metric) || b.points - a.points || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
}

function rankingValue(item, metric = $("rankingMetric")?.value || "total") {
  return metric === "average" ? item.average : metric === "best" ? item.best : metric === "games" ? item.gamesPlayed : item.points;
}

function officialPosition(totals, index) {
  const metric = $("rankingMetric")?.value || "total";
  return totals.findIndex((item) => rankingValue(item, metric) === rankingValue(totals[index], metric)) + 1;
}

function formatAdvancedValue(modeId, row) {
  const mode = advancedPresentation(modeId);
  if (row?.displayValue != null && row.displayValue !== "") {
    const exact = String(row.displayValue);
    if (/^-?\d+$/.test(exact)) {
      try { return BigInt(exact).toLocaleString("pt-BR"); } catch { return exact; }
    }
    if (/^-?\d+\.\d+$/.test(exact)) {
      const [integer, fraction] = exact.split(".");
      try { return BigInt(integer).toLocaleString("pt-BR") + "," + fraction; } catch { return exact.replace(".", ","); }
    }
    return exact.replace(".", ",");
  }
  const field = mode?.rankMetric;
  const raw = field ? row?.[field] : null;
  if (raw == null || raw === "") return "—";
  if (modeId === "pinball" || modeId === "minigolfe" || modeId === "tempo") {
    try { return window.AdvancedGameModes.parseExactBigInt(String(raw)).toLocaleString("pt-BR"); }
    catch { return "—"; }
  }
  return Number(raw).toLocaleString("pt-BR");
}

function advancedResultStatus(modeId, row) {
  const status = String(row?.status || "").toUpperCase();
  if (status === "DNF") return "Não concluiu (DNF)";
  if (status === "DNS") return "Não iniciou (DNS)";
  if (row?.pending) return "Aguardando registro";
  if (modeId === "dardos_501") return row?.match_complete ? "Final" : row?.leg_no ? `Perna ${row.leg_no} · ${row.balance ?? 501} restantes` : "Aguardando perna";
  if (modeId === "pebolim" || modeId === "sinuca" || modeId === "tenis_mesa" || modeId === "truco") return row?.match_complete ? "Final" : "Parcial";
  return row?.finalized ? "Final" : "Pendente";
}

function renderAdvancedLeaderboard() {
  const modeId = activeEncounter()?.game_type;
  const mode = advancedPresentation(modeId);
  const game = getGame(state.activeGameId);
  const view = $("rankingMode")?.value === "current" ? "current" : "official";
  const requestedMetric = $("rankingMetric")?.value || "total";
  const metric = advancedRankingMetric(modeId, requestedMetric);
  const laneSelect = $("rankingLane");
  const laneLabel = laneSelect?.closest?.("label");
  if (laneLabel) laneLabel.hidden = true;
  if (laneSelect) { laneSelect.innerHTML = `<option value="">Todos os locais</option>`; laneSelect.value = ""; }
  const metricSelect = $("rankingMetric");
  if (metricSelect) metricSelect.disabled = false;
  const criterionLabel = advancedRankingLabel(modeId, metric);
  $("rankingUnitLabel").textContent = `${mode.name} · ${criterionLabel}`;
  $("rankingTitle").textContent = view === "current"
    ? `Classificação da partida${game ? ` · ${game.nome}` : ""}`
    : `Classificação oficial acumulada · ${mode.name}`;
  $("podium").hidden = true; $("podium").innerHTML = "";
  $("leaderboardEmpty").hidden = true;
  const headers = document.querySelectorAll(".score-table thead th");
  if (headers[0]) headers[0].textContent = mode.rankRow?.rank || "Posição";
  if (headers[1]) headers[1].textContent = mode.rankRow?.participant || "Participante";
  if (headers[2]) headers[2].textContent = "Situação";
  if (headers[3]) headers[3].textContent = "—";
  if (headers[4]) headers[4].textContent = mode.rankRow?.value || mode.unit;
  if (headers[5]) headers[5].textContent = mode.rankRow?.status || "Resultado";
  const renderRows = (ranked, confirmed, meta) => {
    $("leaderboardBody").innerHTML = ranked.length ? ranked.map((row) => {
    const player = row.player || getPlayer(row.player_id);
    const name = player?.nome || "Jogador";
    const photoUrl = state.playerPhotos.get(row.player_id);
    const position = row.rank == null ? "—" : `${row.rank}º`;
    const status = row.official
      ? row.rank != null ? "Oficial" : advancedResultStatus(modeId, row)
      : advancedResultStatus(modeId, row);
    const value = formatAdvancedValue(modeId, row);
    return `<tr><td class="rank-cell">${position}</td><td><div class="ranking-player">${photoUrl ? `<img class="ranking-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(name)}" loading="lazy" />` : ""}<span>${esc(name)}</span></div></td><td>—</td><td>—</td><td class="points-cell">${esc(value)}</td><td><span class="status-chip ${status === "Final" ? "status-chip--final" : "status-chip--partial"}">${esc(status)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="6">Nenhum participante vinculado a esta partida.</td></tr>`;
    $("leaderboardEmpty").hidden = ranked.length > 0;
    $("leaderboardMeta").textContent = meta || `${confirmed}/${ranked.length} resultados confirmados · ${mode.name} · ${criterionLabel}`;
  };
  const notice = (title, message, error = false, retry = null) => {
    $("rankingTitle").textContent = title;
    $("leaderboardMeta").textContent = message;
    $("leaderboardBody").innerHTML = `<tr><td colspan="6">${esc(message)}${retry ? ` <button type="button" data-retry-advanced-ranking> Tentar novamente</button>` : ""}</td></tr>`;
    $("leaderboardBody").querySelectorAll?.("[data-retry-advanced-ranking]").forEach((button) => button.addEventListener("click", retry));
    $("leaderboardEmpty").hidden = !error;
  };
  if (view === "current") {
    if (!game) { notice("Classificação da partida", `Selecione uma partida de ${mode.name}.`, true); return; }
    const feed = getAdvancedFeed(modeId, game.id);
    if (!feed) {
      const error = state.advancedFeedErrors.get(advancedFeedKey(modeId, game.id));
      if (error) {
        notice("Resultados da partida indisponíveis", `Não foi possível carregar o placar de ${game.nome}: ${error}`, true,
          () => refreshAdvancedFeed(modeId, game.id, true).catch(() => {}));
      } else {
        refreshAdvancedFeed(modeId, game.id).catch(() => {});
        notice("Carregando placar da partida", `Carregando resultados de ${game.nome}…`);
      }
      return;
    }
    const ranked = advancedRankedRows(game, feed);
    const confirmed = ranked.filter((row) => mode.kind === "individual"
      ? row.finalized === true
      : row.match_complete === true).length;
    renderRows(ranked, confirmed, `${confirmed}/${ranked.length} resultados confirmados nesta partida · ${mode.name} · ${criterionLabel}`);
    return;
  }

  const finalGames = encounterGames().filter((item) => item.status === "final");
  if (!finalGames.length) { notice("Classificação oficial acumulada", `Nenhuma partida finalizada de ${mode.name}.`, true); return; }
  const rankingModule = window.AdvancedRanking;
  if (!rankingModule?.aggregateOfficial) {
    notice("Classificação oficial indisponível", "O agregador oficial da modalidade não está carregado.", true);
    return;
  }
  const feedsByGame = new Map(finalGames.map((item) => [item.id, getAdvancedFeed(modeId, item.id)]).filter(([, feed]) => feed));
  let aggregate;
  try { aggregate = rankingModule.aggregateOfficial(modeId, finalGames, feedsByGame, metric); }
  catch (error) {
    notice("Classificação oficial indisponível", `Não foi possível calcular o ranking: ${error?.message || "erro no feed"}.`, true);
    return;
  }
  const missingIds = [...new Set(aggregate?.missingGameIds || [])];
  if (missingIds.length) {
    const errors = missingIds.map((id) => state.advancedFeedErrors.get(advancedFeedKey(modeId, id))).filter(Boolean);
    const invalidLoadedIds = missingIds.filter((id) => feedsByGame.has(id));
    if (invalidLoadedIds.length) {
      invalidLoadedIds.forEach((id) => state.advancedFeedErrors.set(advancedFeedKey(modeId, id), "Feed carregado sem resultado final válido."));
    }
    if (errors.length || invalidLoadedIds.length) {
      const message = errors[0] || "Um feed carregado não confirmou resultado final.";
      notice("Classificação oficial indisponível", `Não foi possível carregar todos os feeds finais: ${message}`, true,
        () => missingIds.forEach((id) => refreshAdvancedFeed(modeId, id, true).catch(() => {})));
    } else {
      const encounterId = activeEncounter()?.id;
      missingIds.forEach((id) => refreshAdvancedFeed(modeId, id, false, false)
        .then(() => { if (activeEncounter()?.id === encounterId) renderLeaderboard(); })
        .catch(() => { if (activeEncounter()?.id === encounterId) renderLeaderboard(); }));
      notice("Carregando classificação oficial", `Buscando resultados de ${missingIds.length} partida(s) finalizada(s)…`);
    }
    return;
  }

  const latestFeedRows = new Map();
  for (const finalGame of finalGames) for (const row of feedsByGame.get(finalGame.id)?.rows || []) {
    latestFeedRows.set(row.player_id, row);
  }
  const rows = [...(aggregate?.rows || [])].map((row) => {
    const source = latestFeedRows.get(row.player_id);
    return { ...row, player: getPlayer(row.player_id), official: true, status: source?.status,
      finalized: source?.finalized, match_complete: source?.match_complete };
  });
  const present = new Set(rows.map((row) => row.player_id));
  for (const finalGame of finalGames) for (const score of gameScores(finalGame.id)) {
    if (present.has(score.player_id)) continue;
    const player = getPlayer(score.player_id);
    if (player) { rows.push({ player_id: player.id, player, rank: null, displayValue: "—", eligible: false, pending: true, finalized: false, match_complete: false }); present.add(player.id); }
  }
  const confirmed = finalGames.reduce((sum, finalGame) => sum
    + (feedsByGame.get(finalGame.id)?.rows || []).filter((row) => mode.kind === "individual"
      ? row.finalized === true : row.match_complete === true).length, 0);
  const aggregateRow = (aggregate?.rows || []).find((row) => row.displayValue != null);
  const aggregateMetricLabel = aggregateRow?.metricLabel || advancedRankingLabel(modeId, metric);
  const aggregateUnitLabel = aggregateRow?.unitLabel || mode.unit;
  $("rankingUnitLabel").textContent = `${mode.name} · ${aggregateMetricLabel} (${aggregateUnitLabel})`;
  renderRows(rows, confirmed, `${confirmed} resultados confirmados · ${finalGames.length} partidas finalizadas · critério: ${aggregateMetricLabel} · unidade: ${aggregateUnitLabel}`);
}

function renderLeaderboard() {
  const body = $("leaderboardBody");
  const finalGames = encounterGames().filter((game) => game.status === "final");
  const laneSelect = $("rankingLane");
  const selectedLane = laneSelect?.value || "";
  const gameMode = getGameMode();
  $("rankingUnitLabel").textContent = `${gameMode.name} · ${gameMode.unit}`;
  if (!gameMode.ready) {
    const message = `Modalidade ${gameMode.name} em preparação. Classificação em somente leitura até a integração dos formulários.`;
    if (laneSelect) { laneSelect.innerHTML = `<option value="">Todos os locais</option>`; laneSelect.value = ""; }
    $("rankingTitle").textContent = "Modalidade em preparação";
    $("podium").hidden = true; $("podium").innerHTML = "";
    $("leaderboardEmpty").hidden = true;
    $("leaderboardMeta").textContent = message;
    body.innerHTML = `<tr><td colspan="6">${esc(message)}</td></tr>`;
    return;
  }
  if (isAdvancedEncounter()) { renderAdvancedLeaderboard(); return; }
  const laneLabel = laneSelect?.closest?.("label");
  if (laneLabel) laneLabel.hidden = false;
  const gameIds = new Set(encounterGames().map((game) => game.id));
  const observedLanes = [...new Set(state.scores.filter((score) => gameIds.has(score.game_id)).map(scoreLane).filter(Boolean))];
  const lanes = observedLanes.filter((lane) => isRoundBased() ? isVirtualStationLane(lane) : !isVirtualStationLane(lane))
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  if (laneSelect) {
    laneSelect.innerHTML = `<option value="">Todos os locais</option>${lanes.map((lane) => `<option value="${esc(lane)}">${esc(displayLocation(lane))}</option>`).join("")}`;
    laneSelect.value = lanes.includes(selectedLane) ? selectedLane : "";
  }
  const activeLane = laneSelect?.value || "";
  const mode = $("rankingMode")?.value || "official";
  const metric = $("rankingMetric")?.value || "total";
  const podium = $("podium");
  const currentGame = getGame(state.activeGameId);
  let currentItems = currentGame ? gameScores(currentGame.id).map((score) => ({ score, player: getPlayer(score.player_id) })).filter((item) => item.player && (!activeLane || scoreLane(item.score) === activeLane)) : [];
  currentItems = isRoundBased() ? rankScoreRows(gameMode, currentItems, "total", (item) => item.score.pontos)
    : currentItems.sort((a, b) => (b.score.pontos ?? -1) - (a.score.pontos ?? -1) || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
  const totals = officialTotals(laneSelect?.value || "");
  const items = mode === "current" ? currentItems : totals;
  const isCurrent = mode === "current";
  const rankingTitle = $("rankingTitle");
  const valueHeader = $("rankingValueHeader");
  if (valueHeader) valueHeader.textContent = isCurrent ? `${gameMode.unit}` : metric === "average" ? `Média (${gameMode.unit})` : metric === "best" ? `Melhor (${gameMode.unit})` : metric === "games" ? "Partidas" : `Total (${gameMode.unit})`;
  if (rankingTitle) rankingTitle.textContent = `${isCurrent ? `Partida atual${currentGame ? ` · ${currentGame.nome}` : ""}` : metric === "average" ? "Classificação por média" : metric === "best" ? "Melhor partida" : metric === "games" ? "Participações" : "Classificação acumulada"} · ${gameMode.name}`;
  const tableHeaders = document.querySelectorAll(".score-table thead th");
  if (tableHeaders[2]) tableHeaders[2].textContent = gameMode.locationLabel;
  const encounterClosed = activeEncounter()?.status === "closed";
  podium.hidden = isCurrent || !encounterClosed || totals.length === 0;
  podium.innerHTML = totals.slice(0, 3).map((item, index) => {
    const photoUrl = state.playerPhotos.get(item.player.id);
    return `<div class="podium-place podium-place--${index + 1}"><span class="podium-medal">${officialPosition(totals, index)}º</span>${photoUrl ? `<img class="podium-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(item.player.nome)}" loading="lazy" />` : `<span class="podium-avatar podium-avatar--empty" aria-hidden="true">${esc(item.player.nome.slice(0, 1))}</span>`}<strong>${esc(item.player.nome)}</strong><small>${metric === "average" ? item.average.toFixed(1).replace(".", ",") + ` ${gameMode.unit} de média` : rankingValue(item, metric).toLocaleString("pt-BR") + (metric === "games" ? " partidas" : ` ${gameMode.unit}`)}</small></div>`;
  }).join("");
  let previousValue = null;
  let previousPosition = 0;
  body.innerHTML = items.map((item, index) => {
    const player = isCurrent ? item.player : item.player;
    const score = isCurrent ? item.score : item.current;
    const value = isCurrent ? score?.pontos : rankingValue(item, metric);
    const position = value == null ? "—" : value === previousValue ? previousPosition : index + 1;
    previousValue = value;
    previousPosition = position;
    const situation = isCurrent ? (score?.finalizado ? "Final" : (score?.pontos != null ? "Pendente" : "Sem pontos")) : (item.current?.finalizado ? "Final" : (item.current ? "Parcial" : "—"));
    const chipClass = situation === "Final" ? "status-chip status-chip--final" : "status-chip status-chip--partial";
    const photoUrl = state.playerPhotos.get(player.id);
    const lane = isCurrent ? scoreLane(score) : item.lane;
    const points = value == null ? "—" : isCurrent ? Number(value).toLocaleString("pt-BR") : metric === "average" ? item.average.toFixed(1).replace(".", ",") : value.toLocaleString("pt-BR");
    return `<tr><td class="rank-cell">${position}</td><td><div class="ranking-player">${photoUrl ? `<img class="ranking-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" loading="lazy" />` : ""}<span><button class="player-stats-link" type="button" data-stats-player="${esc(player.id)}">${esc(player.nome)}</button><small>${esc(player.apelido_placar || "sem apelido")}</small></span></div></td><td>${esc(displayLocation(lane, false))}</td><td>${isCurrent ? "—" : item.gamesPlayed}</td><td class="points-cell">${points}</td><td><span class="${chipClass}">${situation}</span></td></tr>`;
  }).join("");
  body.querySelectorAll("[data-stats-player]").forEach((button) => button.addEventListener("click", () => openStatsModal(button.dataset.statsPlayer)));
  $("leaderboardEmpty").hidden = items.length > 0;
  $("leaderboardMeta").textContent = `${isCurrent ? (currentGame ? `${currentItems.filter((item) => item.score.pontos != null).length}/${currentItems.length} totais informados pelo banco` : "Nenhuma partida aberta") : finalGames.length ? `${finalGames.length} ${finalGames.length === 1 ? "partida finalizada" : "partidas finalizadas"}` : "Nenhuma partida finalizada"} · ${gameMode.name} · unidade: ${gameMode.unit}`;
}

function renderRoundProgress(game, scores) {
  const rounds = window.GamePresentations?.roundProgress?.(state.roundScores, game.id, scores.map(({ score }) => score.player_id), configuredRoundCount()) || [];
  const complete = rounds.filter((round) => round.participants > 0 && round.confirmed === round.participants).length;
  const wasOpen = $("roundProgress").querySelector("details")?.open || false;
  $("roundProgress").innerHTML = `<details class="round-progress-details" ${wasOpen ? "open" : ""}><summary>Rodadas <strong>${complete}/${rounds.length} concluídas</strong></summary><div class="round-progress-grid">${rounds.map((round) => `<div class="round-progress-card"><strong>Rodada ${round.round} · ${round.confirmed}/${round.participants}</strong><small>${round.informed} informados · ${round.pending} pendentes</small><progress max="100" value="${round.percent}" aria-label="Conclusão da rodada ${round.round}"></progress></div>`).join("")}</div></details>`;
  $("laneProgress").innerHTML = "";
}

function renderLaneProgress(scores, gameMode) {
  $("roundProgress").innerHTML = "";
  const physicalScores = scores.filter(({ score }) => !isVirtualStationLane(scoreLane(score)));
  $("laneProgress").innerHTML = [...new Set(physicalScores.map(({ score }) => scoreLane(score)))].map((lane) => {
    const laneScores = physicalScores.filter(({ score }) => scoreLane(score) === lane);
    const informed = laneScores.filter(({ score }) => score.pontos != null).length;
    const confirmed = laneScores.filter(({ score }) => score.finalizado && score.pontos != null).length;
    const pending = laneScores.length - confirmed;
    const percent = Math.round(100 * confirmed / laneScores.length);
    return `<div class="lane-progress-card"><strong>${esc(displayLocation(lane))} · ${confirmed}/${laneScores.length} confirmados</strong><small>${laneScores.length} participantes · ${informed} informados · ${pending} pendentes · ${percent}% concluído</small><progress max="100" value="${percent}" aria-label="Conclusão de ${esc(displayLocation(lane))}"></progress></div>`;
  }).join("");
}

function renderAdvancedCurrentGame(game, modeId) {
  const mode = advancedPresentation(modeId);
  const body = $("currentGameBody");
  $("laneProgress").hidden = true; $("roundProgress").hidden = true;
  $("laneProgress").innerHTML = ""; $("roundProgress").innerHTML = "";
  $("currentGameEyebrow").textContent = `${mode.name} · resultados da partida`;
  if (!game) {
    $("currentGameTitle").textContent = "Nenhuma partida aberta";
    $("currentGameStatus").textContent = "Aguardando";
    $("currentGameStatus").className = "status-pill status-pill--muted";
    body.innerHTML = `<div class="empty-state"><strong>Nenhuma partida selecionada</strong><span>Abra uma partida para registrar e acompanhar os resultados de ${esc(mode.name)}.</span></div>`;
    return;
  }
  $("currentGameTitle").textContent = game.nome;
  $("currentGameStatus").textContent = game.status === "final" ? "Final" : "Parcial";
  $("currentGameStatus").className = `status-pill status-pill--${game.status === "final" ? "success" : "warning"}`;
  const feed = getAdvancedFeed(modeId, game.id);
  if (!feed) {
    const error = state.advancedFeedErrors.get(advancedFeedKey(modeId, game.id));
    if (error) {
      body.innerHTML = `<div class="empty-state"><strong>Resultados da partida indisponíveis</strong><span>${esc(error)}</span><button class="text-button" type="button" data-retry-advanced-current>Tentar novamente</button></div>`;
      body.querySelectorAll("[data-retry-advanced-current]").forEach((button) => button.addEventListener("click", () =>
        refreshAdvancedFeed(modeId, game.id, true).catch(() => {})));
      return;
    }
    refreshAdvancedFeed(modeId, game.id).catch(() => {});
    body.innerHTML = `<div class="empty-state"><strong>Carregando ${esc(mode.name)}</strong><span>Buscando resultados e detalhes desta partida.</span></div>`;
    return;
  }
  const ranked = advancedRankedRows(game, feed);
  const roster = advancedRosterRows(game, feed);
  const adminActions = isAdmin() && encounterActive()
    ? `<div class="current-score"><button class="text-button" type="button" data-advanced-score="${esc(game.id)}">${esc(mode.entry?.action || "Registrar resultado")}</button>${mode.statusRpc ? `<button class="text-button" type="button" data-advanced-status="${esc(game.id)}">Registrar DNF/DNS</button>` : ""}</div>` : "";
  let detail = "";
  if (mode.kind === "match") {
    const sets = feed.details.match_sets || [];
    const statuses = feed.details.match_player_status || [];
    detail = sets.length ? `<div class="extras-list">${sets.map((set) => {
      const first = getPlayer(set.player_a_id)?.nome || "Jogador A";
      const second = getPlayer(set.player_b_id)?.nome || "Jogador B";
      return `<div class="extra-row"><strong>${esc(mode.progress?.item || "Set")} ${set.set_no}${set.confirmed ? " · confirmado" : " · pendente"}</strong><span>${esc(first)} ${set.score_a} × ${set.score_b} ${esc(second)}</span></div>`;
    }).join("")}</div>` : `<p class="empty-inline">Nenhum set registrado.</p>`;
    if (statuses.length) detail += `<p class="section-meta">${statuses.map((row) => `${esc(getPlayer(row.player_id)?.nome || "Jogador")}: ${esc(row.status)}`).join(" · ")}</p>`;
  } else if (mode.kind === "individual") {
    detail = `<div class="extras-list">${ranked.map((row) => `<div class="extra-row"><strong>${esc(row.player?.nome || "Jogador")}</strong><span>${esc(formatAdvancedValue(modeId, row))} ${esc(mode.unit)} · ${esc(advancedResultStatus(modeId, row))}</span></div>`).join("")}</div>`;
  } else {
    const legs = feed.details.darts_legs || [];
    const turns = feed.details.darts_turns || [];
    const legPlayers = feed.details.darts_leg_players || [];
    detail = legs.length ? legs.map((leg) => {
      const players = legPlayers.filter((row) => Number(row.leg_no) === Number(leg.leg_no));
      const turnsForLeg = turns.filter((row) => Number(row.leg_no) === Number(leg.leg_no));
      return `<section class="extras-list"><strong>Perna ${leg.leg_no} · ${esc(leg.status)}</strong><div>${players.map((row) => `<div class="extra-row"><span>${esc(getPlayer(row.player_id)?.nome || "Jogador")}${row.status !== "active" ? ` · ${esc(row.status)}` : ""}</span><strong>${row.balance} restantes</strong></div>`).join("")}</div>${turnsForLeg.map((turn) => {
        const throws = Array.isArray(turn.throws) ? turn.throws.map((dart) => `${dart.score}${dart.is_double ? " (D)" : ""}`).join(" · ") : "";
        return `<small>${turn.turn_no}. ${esc(getPlayer(turn.player_id)?.nome || "Jogador")} · ${esc(throws)}</small>`;
      }).join("")}</section>`;
    }).join("") : `<p class="empty-inline">Nenhuma perna iniciada.</p>`;
  }
  const table = ranked.length ? `<div class="extras-list">${ranked.map((row) => `<div class="current-row"><div class="current-player"><span class="provisional-rank">${row.rank == null ? "—" : `${row.rank}º`}</span><strong>${esc(row.player?.nome || "Jogador")}</strong><span>${esc(advancedResultStatus(modeId, row))}</span></div><div class="current-score"><strong>${esc(formatAdvancedValue(modeId, row))}</strong></div></div>`).join("")}</div>` : `<p class="empty-inline">Nenhum participante vinculado a esta partida.</p>`;
  body.innerHTML = `${adminActions}${table}${detail}`;
  body.querySelectorAll("[data-advanced-score]").forEach((button) => button.addEventListener("click", () => advancedModeController?.openScore?.({ modeId, gameId: button.dataset.advancedScore })));
  body.querySelectorAll("[data-advanced-status]").forEach((button) => button.addEventListener("click", () => advancedModeController?.openStatus?.({ modeId, gameId: button.dataset.advancedStatus })));
  $("laneProgress").innerHTML = ""; $("roundProgress").innerHTML = "";
  $("currentGameEyebrow").textContent = `${mode.name} · ${roster.length} participantes · placar da partida`;
}

function renderCurrentGame() {
  const game = getGame(state.activeGameId);
  const gameMode = getGameMode();
  const presentation = getGamePresentation(gameMode.id);
  const hasRounds = presentation.progressKind === "rounds";
  const body = $("currentGameBody");
  if (!gameMode.ready) {
    const message = `Modalidade ${gameMode.name} em preparação. Esta tela está somente para leitura até a integração dos formulários.`;
    $("currentGameEyebrow").textContent = "somente leitura";
    $("currentGameTitle").textContent = game?.nome || gameMode.name;
    $("currentGameStatus").textContent = "Somente leitura";
    $("currentGameStatus").className = "status-pill status-pill--muted";
    $("laneProgress").hidden = true; $("roundProgress").hidden = true;
    $("laneProgress").innerHTML = ""; $("roundProgress").innerHTML = "";
    body.innerHTML = `<div class="empty-state"><strong>Modalidade em preparação</strong><span>${esc(message)}</span></div>`;
    return;
  }
  if (isAdvancedEncounter()) { renderAdvancedCurrentGame(game, gameMode.id); return; }
  $("currentGameEyebrow").textContent = hasRounds ? "rodadas do encontro · ao vivo" : "operação da partida · ao vivo";
  $("laneProgress").hidden = hasRounds;
  $("roundProgress").hidden = !hasRounds;
  if (!game) {
    $("currentGameTitle").textContent = "Nenhuma partida aberta";
    $("currentGameStatus").textContent = "Aguardando";
    $("currentGameStatus").className = "status-pill status-pill--muted";
    body.innerHTML = `<div class="empty-state"><span class="empty-icon">⌁</span><strong>Abra uma partida para começar</strong><span>${esc(presentation.emptyHelp || (isRoundBased() ? "Os participantes, as rodadas e a estação virtual ficam vinculados a ela." : "Os participantes e as pistas ficam vinculados a ela."))}</span></div>`;
    $("laneProgress").innerHTML = "";
    $("roundProgress").innerHTML = "";
    return;
  }
  const scores = gameScores(game.id).map((score) => ({ score, player: getPlayer(score.player_id) })).filter((item) => item.player).sort((a, b) => String(scoreLane(a.score)).localeCompare(String(scoreLane(b.score))) || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
  $("currentGameTitle").textContent = game.nome;
  $("currentGameStatus").textContent = game.status === "final" ? "Final" : "Parcial";
  $("currentGameStatus").className = `status-pill status-pill--${game.status === "final" ? "success" : "warning"}`;
  const ranked = isRoundBased() ? rankScoreRows(gameMode, scores, "total", (item) => item.score.pontos)
    : [...scores].sort((a, b) => (b.score.pontos ?? -1) - (a.score.pontos ?? -1) || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
  body.innerHTML = ranked.length ? ranked.map(({ score, player }) => {
    const position = score.pontos == null ? "—" : `${ranked.findIndex((item) => item.score.pontos === score.pontos) + 1}º`;
    const photoUrl = state.playerPhotos.get(player.id);
    const scoreActions = isAdmin() && encounterActive() ? (isRoundBased()
      ? `<button class="text-button" type="button" data-quick-score="${esc(player.id)}">Rodadas</button>`
      : `<button class="text-button" type="button" data-quick-score="${esc(player.id)}">Corrigir</button>${score.pontos != null ? `<button class="text-button text-button--danger" type="button" data-clear-score="${esc(player.id)}">Limpar</button>` : ""}`) : "";
    const location = displayLocation(scoreLane(score));
    return `<div class="current-row"><div class="current-player${photoUrl ? " current-player--with-photo" : ""}"><span class="provisional-rank">${position}</span>${photoUrl ? `<img class="ranking-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" loading="lazy" />` : ""}<button class="player-stats-link current-stats-link" type="button" data-stats-player="${esc(player.id)}">${esc(player.nome)}</button><span>${esc(location)}</span></div><div class="current-score"><strong>${score.pontos == null ? "—" : Number(score.pontos).toLocaleString("pt-BR")}${isRoundBased() && score.pontos != null ? ` ${esc(gameMode.unit)}` : ""}</strong><span class="status-chip ${score.finalizado ? "status-chip--final" : "status-chip--partial"}">${score.finalizado ? "Final" : "Pendente"}</span>${scoreActions}</div></div>`;
  }).join("") : `<div class="empty-state"><span>Partida sem participantes.</span></div>`;
  body.querySelectorAll("[data-stats-player]").forEach((button) => button.addEventListener("click", () => openStatsModal(button.dataset.statsPlayer)));
  body.querySelectorAll("[data-quick-score]").forEach((button) => button.addEventListener("click", () => openQuickScore(button.dataset.quickScore)));
  body.querySelectorAll("[data-clear-score]").forEach((button) => button.addEventListener("click", () => clearScore(button.dataset.clearScore)));
  if (hasRounds) renderRoundProgress(game, scores);
  else renderLaneProgress(scores, gameMode);
}

async function clearScore(playerId) {
  if (!requireReadyMode()) return;
  const player = getPlayer(playerId);
  if (!window.confirm(`Limpar os pontos de ${player?.nome || "este jogador"} nesta partida? O ranking será recalculado.`)) return;
  const { error } = await client.rpc("clear_game_score", { p_game_id: state.activeGameId, p_player_id: playerId });
  if (error) return showToast("Não foi possível limpar os pontos.", "error");
  await loadData(); render(); showToast("Pontuação limpa; a partida voltou a parcial.", "success");
}

function openQuickScore(playerId) {
  if (!requireReadyMode()) return;
  const player = getPlayer(playerId);
  if (!player) return;
  if (isRoundBased()) return openRoundModal(state.activeGameId);
  openPhotoModal();
  $("photoGame").value = state.activeGameId;
  renderPhotoOptions();
  $("photoLane").value = gameLaneForPlayer(state.activeGameId, playerId);
  updateReviewTable();
  const row = [...$("reviewTable").querySelectorAll("[data-review-player]")].find((item) => item.dataset.reviewPlayer === playerId);
  row?.querySelector(".review-score")?.focus();
}

function openStatsModal(playerId) {
  if (!requireReadyMode()) return;
  const player = getPlayer(playerId);
  if (!player) return;
  const mode = getGameMode();
  const finalGames = encounterGames().filter((game) => game.status === "final").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const results = finalGames.map((game) => ({ game, score: state.scores.find((score) => score.game_id === game.id && score.player_id === playerId) })).filter((item) => item.score?.finalizado && item.score.pontos != null);
  const points = results.map((item) => Number(item.score.pontos));
  const wins = results.reduce((count, { game, score }) => {
    const eligible = gameScores(game.id).filter((item) => item.finalizado && item.pontos != null);
    const best = eligible.length ? Math.max(...eligible.map((item) => Number(item.pontos))) : null;
    const leaders = eligible.filter((item) => Number(item.pontos) === best);
    return count + Number(leaders.length === 1 && leaders[0].player_id === playerId && Number(score.pontos) === best);
  }, 0);
  const totals = officialTotals();
  const playerIndex = totals.findIndex((item) => item.player.id === playerId);
  const position = playerIndex < 0 ? 0 : officialPosition(totals, playerIndex);
  const photoUrl = state.playerPhotos.get(playerId);
  $("statsTitle").textContent = player.nome;
  $("statsHero").innerHTML = `${photoUrl ? `<img src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" />` : `<span class="stats-avatar-empty" aria-hidden="true">${esc(player.nome.slice(0, 1))}</span>`}<div><strong>${position ? `${position}º no ranking` : "Ainda sem posição oficial"}</strong><span>${points.length} ${points.length === 1 ? "partida concluída" : "partidas concluídas"} neste encontro · ${esc(mode.name)} · ${esc(mode.unit)}</span></div>`;
  $("statsSummary").innerHTML = `<div><strong>${points.length ? Math.max(...points) : "—"}</strong><span>recorde (${esc(mode.unit)})</span></div><div><strong>${points.length ? (points.reduce((sum, value) => sum + value, 0) / points.length).toFixed(1).replace(".", ",") : "—"}</strong><span>média (${esc(mode.unit)})</span></div><div><strong>${wins}</strong><span>vitórias</span></div>`;
  const minPoint = points.length ? Math.min(...points) : 0;
  const maxPoint = points.length ? Math.max(...points) : 0;
  const spread = maxPoint - minPoint;
  const padding = spread ? spread * 0.08 : Math.max(Math.abs(maxPoint) * 0.05, 1);
  const chartMin = minPoint - padding;
  const chartMax = maxPoint + padding;
  const coords = points.map((value, index) => {
    const x = points.length === 1 ? 240 : 20 + index * 440 / (points.length - 1);
    const y = 115 - ((value - chartMin) / (chartMax - chartMin)) * 95;
    return `${x},${y}`;
  });
  $("statsEvolution").innerHTML = points.length ? `<strong>Evolução por partida</strong><svg viewBox="0 0 480 140" role="img" aria-label="Pontuações: ${points.join(", ")}"><line x1="20" y1="115" x2="460" y2="115" stroke="currentColor" opacity=".25" /><polyline points="${coords.join(" ")}" fill="none" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${coords.map((point) => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="5" fill="var(--color-accent)" />`).join("")}</svg>` : "";
  $("statsGames").innerHTML = results.length ? results.map(({ game, score }) => `<div class="history-row"><div><strong>${esc(game.nome)}</strong><small>${fmtDate(game.created_at)} · ${esc(mode.name)}</small></div><span>${score.pontos} ${esc(mode.unit)}</span></div>`).join("") : `<p class="empty-inline">Nenhuma partida finalizada para este jogador.</p>`;
  setModal("statsModal", true);
}

function renderGames() {
  const allGames = encounterGames();
  const gameMode = getGameMode();
  const filter = $("gameHistoryFilter")?.value || "all";
  const search = normalize($("gameHistorySearch")?.value || "");
  if (!gameMode.ready) {
    const games = allGames.filter((game) => !search || normalize(`${game.nome} ${game.status}`).includes(search));
    const message = `Modalidade ${gameMode.name} em preparação · somente leitura`;
    $("gameCount").textContent = `${games.length} de ${allGames.length} partidas · ${message}`;
    $("gamesList").innerHTML = games.length ? `<div class="games-grid">${games.map((game) => `<article class="game-card ${game.id === state.activeGameId ? "game-card--active" : ""}"><button class="game-card-select" type="button" data-game-id="${esc(game.id)}"><div class="game-card-top"><span class="eyebrow">${message}</span><span class="status-pill status-pill--muted">${game.status === "final" ? "Finalizada" : "Em andamento"}</span></div><h4>${esc(game.nome)}</h4><p>Resultados disponíveis quando os formulários da modalidade estiverem integrados.</p></button></article>`).join("")}</div>` : `<div class="empty-state empty-state--wide"><strong>${message}</strong><span>Não há partidas para exibir.</span></div>`;
    document.querySelectorAll("[data-game-id]").forEach((button) => button.addEventListener("click", () => selectGame(button.dataset.gameId)));
    return;
  }
  const games = allGames.filter((game) => {
    const scores = gameScores(game.id).filter((score) => score.pontos != null);
    const top = scores.length ? Math.max(...scores.map((score) => Number(score.pontos))) : null;
    const leaders = top == null ? 0 : scores.filter((score) => Number(score.pontos) === top).length;
    const matchesFilter = filter === "live" ? game.status !== "final" : filter === "final" ? game.status === "final" : filter === "winner" ? game.status === "final" && scores.length > 0 && leaders === 1 : filter === "tie" ? game.status === "final" && scores.length > 0 && leaders > 1 : true;
    return matchesFilter && (!search || normalize(`${game.nome} ${game.status}`).includes(search));
  });
  $("gameCount").textContent = `${games.length} de ${allGames.length} ${allGames.length === 1 ? "partida" : "partidas"} · ${gameMode.name} · ${gameMode.unit}`;
  const renderGroup = (title, group) => {
    if (!group.length) return "";
    return `<div class="games-group"><div class="games-group-heading"><strong>${title}</strong><span>${group.length}</span></div><div class="games-grid">${group.map((game) => {
    const scores = gameScores(game.id);
    const done = scores.filter((score) => score.finalizado && score.pontos != null).length;
    const total = scores.length;
    const resultValues = scores.filter((score) => score.pontos != null).map((score) => Number(score.pontos));
    const tieCount = resultValues.length ? resultValues.filter((value) => value === Math.max(...resultValues)).length : 0;
    return `<article class="game-card ${game.id === state.activeGameId ? "game-card--active" : ""}"><button class="game-card-select" type="button" data-game-id="${esc(game.id)}"><div class="game-card-top"><span class="eyebrow">${fmtDate(game.created_at)} · ${esc(gameMode.name)}</span><span class="status-pill status-pill--${game.status === "final" ? "success" : "warning"}">${game.status === "final" ? tieCount > 1 ? "Empate" : "Final" : "Parcial"}</span></div><h4>${esc(game.nome)}</h4><p>${done} de ${total} resultados confirmados · total em ${esc(gameMode.unit)}</p><div class="game-progress"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div></button>${isAdmin() && encounterOpen() ? `<div class="game-card-actions"><button class="text-button" type="button" data-edit-game="${esc(game.id)}">Editar</button><button class="text-button text-button--danger" type="button" data-delete-game="${esc(game.id)}">Excluir</button></div>` : ""}</article>`;
    }).join("")}</div></div>`;
  };
  const live = games.filter((game) => game.status !== "final");
  const finished = games.filter((game) => game.status === "final");
  $("gamesList").innerHTML = games.length ? `${renderGroup("Em andamento", live)}${renderGroup("Finalizadas recentemente", finished)}` : `<div class="empty-state empty-state--wide"><strong>Nenhuma partida encontrada</strong><span>Ajuste o filtro ou abra uma nova partida.</span></div>`;
  document.querySelectorAll("[data-game-id]").forEach((button) => button.addEventListener("click", () => selectGame(button.dataset.gameId)));
  document.querySelectorAll("[data-edit-game]").forEach((button) => button.addEventListener("click", () => editGame(button.dataset.editGame)));
  document.querySelectorAll("[data-delete-game]").forEach((button) => button.addEventListener("click", () => removeGame(button.dataset.deleteGame)));
}

function openTabletModal(gameId = state.activeGameId, playerId = null) {
  if (!requireReadyMode()) return;
  if (!["boliche", "bowling"].includes(getGameMode().id)) return showToast("O registro por tablet está disponível apenas no boliche.", "error");
  if (!isAdmin()) return showToast("Entre como administrador para lançar os frames.", "error");
  if (!encounterActive()) return showToast("Inicie ou reabra o encontro para lançar pontos.", "error");
  if (!state.scoreDetailsAvailable) return showToast("Aplique v13-throw-mode.sql para habilitar o tablet.", "error");
  const game = getGame(gameId);
  if (!game) return showToast("Escolha uma partida antes de abrir o tablet.", "error");
  state.tabletGameId = game.id;
  const scores = gameScores(game.id);
  state.tabletPlayerId = playerId || scores.find((score) => !score.finalizado)?.player_id || scores[0]?.player_id || null;
  state.tabletSelectedPins = [];
  renderTablet();
  setModal("tabletModal", true);
}

function renderTablet() {
  if (!isModeReady()) { setModal("tabletModal", false); return; }
  const gameSelect = $("tabletGame");
  const playerSelect = $("tabletPlayer");
  if (!gameSelect || !playerSelect) return;
  const games = encounterGames();
  const gameValue = state.tabletGameId;
  gameSelect.innerHTML = games.map((game) => `<option value="${esc(game.id)}">${esc(game.nome)} · ${game.status === "final" ? "final" : "parcial"}</option>`).join("");
  gameSelect.value = games.some((game) => game.id === gameValue) ? gameValue : games[0]?.id || "";
  if (gameSelect.value !== state.tabletGameId) state.tabletGameId = gameSelect.value || null;
  const players = gameScores(state.tabletGameId).map((score) => getPlayer(score.player_id)).filter(Boolean);
  const playerValue = state.tabletPlayerId;
  playerSelect.innerHTML = players.map((player) => `<option value="${esc(player.id)}">${esc(player.nome)}</option>`).join("");
  playerSelect.value = players.some((player) => player.id === playerValue) ? playerValue : players[0]?.id || "";
  if (playerSelect.value !== state.tabletPlayerId) state.tabletPlayerId = playerSelect.value || null;
  const player = getPlayer(state.tabletPlayerId);
  const score = gameScores(state.tabletGameId).find((item) => item.player_id === state.tabletPlayerId);
  const result = bowlingFrames(tabletThrows());
  $("tabletPlayerMeta").textContent = player ? `${displayLocation(gameLaneForPlayer(state.tabletGameId, player.id) || "—")} · ${score?.finalizado ? "confirmado" : "em lançamento"}` : "Escolha um jogador";
  $("tabletScoreTotal").textContent = result.total.toLocaleString("pt-BR");
  $("tabletScoreStatus").textContent = result.complete ? "Partida completa" : `${result.rolls.length} arremesso${result.rolls.length === 1 ? "" : "s"}`;
  const currentFrame = tabletCurrentFrame();
  $("tabletTurnLabel").textContent = result.complete ? "Todos os frames confirmados" : `Frame ${currentFrame.number} · ${currentFrame.throws.length ? "2º" : "1º"} arremesso`;
  $("tabletScoreboard").innerHTML = result.frames.map((frame) => `<div class="frame-cell ${frame.complete ? "frame-cell--complete" : "frame-cell--current"}"><span>${frame.number}</span><strong>${frame.marks.join(" ") || "·"}</strong><small>${frame.complete ? frame.cumulative : "—"}</small></div>`).join("");
  const standing = tabletStandingPins();
  const selected = new Set(state.tabletSelectedPins);
  $("tabletPinRack").innerHTML = Array.from({ length: 10 }, (_, index) => index + 1).map((pin) => `<button class="pin-button ${pin <= standing ? "pin-button--available" : "pin-button--disabled"} ${selected.has(pin) ? "pin-button--selected" : ""}" type="button" data-pin="${pin}" ${pin > standing ? "disabled" : ""} aria-label="Pino ${pin}">${pin}</button>`).join("");
  $("tabletKeypad").innerHTML = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => `<button class="keypad-button" type="button" data-pins-value="${value}" ${value > standing ? "disabled" : ""}>${value === 10 ? "X" : value}</button>`).join("");
  $("tabletUndoButton").disabled = !result.rolls.length;
  $("tabletRegisterButton").disabled = !state.tabletSelectedPins.length && state.tabletSelectedPins.length !== 0;
  $("tabletRegisterButton").textContent = result.complete ? "Confirmar partida" : "Registrar arremesso";
  $("tabletThrowLog").innerHTML = result.rolls.length ? result.rolls.map((value, index) => `<span>${index + 1}. ${value === 10 ? "X" : value}</span>`).join("") : "Nenhum arremesso registrado";
  $("tabletReason").value = $("tabletReason").value || "Lançamento no tablet";
}

function selectTabletPins(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) return;
  tabletSetPins(count);
}

function toggleTabletPin(pin) {
  if (state.tabletSelectedPins.includes(pin)) state.tabletSelectedPins = state.tabletSelectedPins.filter((value) => value !== pin);
  else if (state.tabletSelectedPins.length < tabletStandingPins()) state.tabletSelectedPins = [...state.tabletSelectedPins, pin];
  renderTablet();
}

async function saveTabletThrow() {
  if (!requireReadyMode()) return;
  if (!state.tabletGameId || !state.tabletPlayerId) return;
  const count = state.tabletSelectedPins.length;
  if (count > tabletStandingPins()) return showToast("A quantidade de pinos excede o que resta no frame.", "error");
  const detail = tabletDetail();
  const throws = [...tabletThrows(), count];
  const complete = bowlingFrames(throws).complete;
  const reason = $("tabletReason").value.trim() || "Lançamento no tablet";
  const { error } = await client.rpc("save_throw_score", { p_game_id: state.tabletGameId, p_player_id: state.tabletPlayerId, p_throws: throws, p_pin_masks: [...(detail?.pin_masks || []), state.tabletSelectedPins], p_finalized: complete, p_reason: reason });
  if (error) return showToast(error.message.includes("function") || error.code === "42883" ? "Aplique v13-throw-mode.sql no Supabase para usar o tablet." : error.message, "error");
  state.tabletSelectedPins = [];
  await loadData(); render();
  showToast(complete ? "Partida confirmada para este jogador." : "Arremesso registrado.", "success");
}

async function undoTabletThrow() {
  if (!requireReadyMode()) return;
  const throws = tabletThrows();
  if (!throws.length) return;
  const detail = tabletDetail();
  const nextThrows = throws.slice(0, -1);
  const nextMasks = (detail?.pin_masks || []).slice(0, -1);
  const { error } = await client.rpc("save_throw_score", { p_game_id: state.tabletGameId, p_player_id: state.tabletPlayerId, p_throws: nextThrows, p_pin_masks: nextMasks, p_finalized: false, p_reason: "Desfazer último arremesso" });
  if (error) return showToast("Não foi possível desfazer o arremesso.", "error");
  state.tabletSelectedPins = [];
  await loadData(); render();
  showToast("Último arremesso desfeito.", "success");
}

function renderPlayerSelection() {
  const container = $("playerSelection");
  const players = encounterPlayers();
  const location = getGameMode().locationLabel;
  const advanced = isAdvancedEncounter();
  const locations = gameLocations();
  $("drawLanesButton").hidden = advanced;
  $("drawLanesButton").textContent = location === "Pista" ? "Sortear pistas" : "Distribuir na estação";
  $("gamePlayerHelp").textContent = advanced
    ? ["pebolim", "sinuca", "tenis_mesa", "truco"].includes(getGameMode().id) ? "Selecione exatamente os dois participantes do confronto." : getGameMode().id === "dardos_501" ? "Selecione de dois a quatro participantes da partida." : "Selecione os participantes da partida."
    : location === "Pista" ? "Escolha a divisão real das pistas" : "Distribua os participantes na estação virtual";
  $("gameLocationHelp").textContent = advanced ? "O local físico não altera os resultados desta modalidade." : location === "Pista" ? "Respeita a capacidade de cada pista; você pode ajustar depois." : "Respeita a capacidade da estação virtual; você pode ajustar depois.";
  container.innerHTML = players.map((player) => `<label class="selection-item"><input class="game-player-check" type="checkbox" value="${esc(player.id)}" checked /><span><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")}</small></span>${advanced ? `<small>${esc(location)}</small>` : `<select class="game-player-lane" data-player-lane="${esc(player.id)}" aria-label="${esc(location)} de ${esc(player.nome)}">${locations.map((item) => `<option value="${esc(item.name)}" ${item.name === player.pista || locations.length === 1 ? "selected" : ""}>${esc(displayLocation(item.name))}</option>`).join("")}</select>`}</label>`).join("");
  $("playerSelectionEmpty").hidden = players.length > 0;
}

function renderPlayers() {
  $("playersList").innerHTML = state.players.length ? state.players.map((player) => `<div class="player-row"><div><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")} · ${isVirtualStationLane(player.pista) ? "Estação" : `Pista ${esc(player.pista || "—")}`}</small></div><div class="player-row-actions"><button class="text-button" type="button" data-edit-player="${esc(player.id)}">Editar</button><button class="text-button text-button--danger" type="button" data-delete-player="${esc(player.id)}">Remover</button></div></div>`).join("") : `<p class="empty-inline">Nenhum participante cadastrado.</p>`;
  document.querySelectorAll("[data-edit-player]").forEach((button) => button.addEventListener("click", () => editPlayer(button.dataset.editPlayer)));
  document.querySelectorAll("[data-delete-player]").forEach((button) => button.addEventListener("click", () => removePlayer(button.dataset.deletePlayer)));
  renderLanes();
}

function renderLanes() {
  const laneSelect = $("playerLane");
  const selected = laneSelect.value;
  const locations = playerLocationOptions();
  const stationMode = ["quiz", "gincana"].includes(getGameMode().id);
  laneSelect.innerHTML = `<option value="">Selecione ${stationMode ? "a estação" : "a pista"}</option>${locations.map((lane) => `<option value="${esc(lane.name)}">${esc(displayLocation(lane.name))}</option>`).join("")}`;
  laneSelect.value = locations.some((lane) => lane.name === selected) ? selected : (stationMode ? locations[0]?.name || "" : "");
  const lanes = physicalLanes();
  $("lanesList").innerHTML = lanes.length ? lanes.map((lane) => `<div class="lane-row"><strong>Pista ${esc(lane.name)} · até ${lane.capacity} jogadores</strong><div class="player-row-actions"><button class="text-button" type="button" data-edit-lane="${esc(lane.name)}">Editar</button><button class="text-button text-button--danger" type="button" data-delete-lane="${esc(lane.name)}">Excluir</button></div></div>`).join("") : `<p class="empty-inline">Nenhuma pista cadastrada.</p>`;
  $("lanesList").querySelectorAll("[data-edit-lane]").forEach((button) => button.addEventListener("click", () => editLane(button.dataset.editLane)));
  $("lanesList").querySelectorAll("[data-delete-lane]").forEach((button) => button.addEventListener("click", () => removeLane(button.dataset.deleteLane)));
}

function editLane(name) {
  if (isVirtualStationLane(name)) return showToast("A estação virtual é reservada para Quiz e Gincana.", "error");
  state.editingLaneName = name;
  $("laneName").value = name;
  $("laneCapacity").value = physicalLanes().find((lane) => lane.name === name)?.capacity || 4;
  $("saveLaneButton").textContent = "Salvar pista";
  $("cancelLaneEditButton").hidden = false;
  $("laneName").focus();
}

function cancelLaneEdit() {
  state.editingLaneName = null;
  $("laneName").value = "";
  $("laneCapacity").value = "4";
  $("saveLaneButton").textContent = "Adicionar pista";
  $("cancelLaneEditButton").hidden = true;
}

async function saveLane() {
  const name = $("laneName").value.trim();
  if (isVirtualStationLane(name) || isVirtualStationLane(state.editingLaneName)) return showToast("A estação virtual é reservada para Quiz e Gincana.", "error");
  if (!name || name.length > 20) return showToast("Informe uma pista com até 20 caracteres.", "error");
  const capacity = Number($("laneCapacity").value);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) return showToast("A capacidade deve ser de 1 a 20 jogadores.", "error");
  const editing = state.editingLaneName;
  const query = editing ? client.from("lanes").update({ name, capacity }).eq("name", editing) : client.from("lanes").insert({ name, capacity });
  const { error } = await query;
  if (error) return showToast("Não foi possível salvar a pista. Confira se o nome já existe.", "error");
  cancelLaneEdit(); await loadData(); render();
  showToast(editing ? "Pista atualizada." : "Pista adicionada.", "success");
}

async function removeLane(name) {
  if (isVirtualStationLane(name)) return showToast("A estação virtual é reservada para Quiz e Gincana.", "error");
  if (!window.confirm(`Excluir a pista ${name}? Realoque seus jogadores antes de excluir.`)) return;
  const { error } = await client.from("lanes").delete().eq("name", name).select("name").single();
  if (error) return showToast("A pista ainda tem jogadores. Realoque-os antes de excluir.", "error");
  await loadData(); render(); showToast("Pista excluída.", "success");
}

function editPlayer(id) {
  const player = getPlayer(id);
  if (!player) return;
  state.editingPlayerId = id;
  $("playerName").value = player.nome;
  $("playerNickname").value = player.apelido_placar;
  $("playerLane").value = player.pista;
  $("addPlayerButton").textContent = "Salvar";
  $("cancelPlayerEditButton").hidden = false;
  $("playerName").focus();
}

function cancelPlayerEdit() {
  state.editingPlayerId = null;
  ["playerName", "playerNickname", "playerLane"].forEach((id) => $(id).value = "");
  $("addPlayerButton").textContent = "Adicionar";
  $("cancelPlayerEditButton").hidden = true;
  $("playerLane").value = playerLocationOptions()[0]?.name || "";
}

function renderPhotoOptions() {
  const gameSelect = $("photoGame");
  const laneSelect = $("photoLane");
  const games = encounterGames();
  const currentGameValue = gameSelect.value || state.activeGameId || games[0]?.id || "";
  gameSelect.innerHTML = games.map((game) => `<option value="${esc(game.id)}">${esc(game.nome)} · ${game.status === "final" ? "final" : "parcial"}</option>`).join("");
  if (games.some((game) => game.id === currentGameValue)) gameSelect.value = currentGameValue;
  const lanes = [...new Set(gameScores(gameSelect.value).map(scoreLane).filter((lane) => lane && !isVirtualStationLane(lane)))].sort((a, b) => String(a).localeCompare(String(b), "pt-BR", { numeric: true }));
  const currentLane = laneSelect.value || lanes[0] || "";
  laneSelect.innerHTML = lanes.map((lane) => `<option value="${esc(lane)}">${esc(displayLocation(lane))}</option>`).join("");
  laneSelect.value = lanes.includes(currentLane) ? currentLane : lanes[0] || "";
  updateReviewTable();
}

function playersOnLane(lane = $("photoLane").value, gameId = $("photoGame").value) {
  if (isVirtualStationLane(lane)) return [];
  const linkedIds = new Set(gameScores(gameId).filter((score) => String(scoreLane(score)) === String(lane)).map((score) => score.player_id));
  return state.players.filter((player) => linkedIds.has(player.id));
}

const reviewKey = (gameId, lane, playerId) => JSON.stringify([gameId, lane, playerId]);
function captureReviewDraft() {
  if (!state.reviewViewKey) return;
  const [gameId, lane] = JSON.parse(state.reviewViewKey);
  for (const row of document.querySelectorAll("[data-review-player]")) {
    state.reviewDraft.set(reviewKey(gameId, lane, row.dataset.reviewPlayer), {
      score: row.querySelector(".review-score").value,
      finalized: row.querySelector(".review-final").checked,
      manualScore: row.dataset.manualScore === "true",
      manualFinal: row.dataset.manualFinal === "true",
    });
  }
}

function markReviewEdited(event) {
  const row = event.target.closest("[data-review-player]");
  if (!row) return;
  if (event.target.matches(".review-score")) {
    row.dataset.manualScore = "true";
    if (row.dataset.oldFinal === "true" && event.target.value !== row.dataset.oldScore && row.querySelector(".review-final").checked) {
      row.querySelector(".review-final").checked = false;
      row.dataset.manualFinal = "true";
    }
  }
  if (event.target.matches(".review-final")) row.dataset.manualFinal = "true";
  captureReviewDraft();
  updatePhotoConfirmState();
}

function changeReviewContext(event) {
  state.ocrRunId++;
  const [oldGameId, oldLane] = state.reviewViewKey ? JSON.parse(state.reviewViewKey) : [null, null];
  captureReviewDraft();
  const dirty = [...state.reviewDraft.entries()].some(([key, draft]) => {
    const [gameId, lane] = JSON.parse(key);
    if (gameId !== oldGameId || lane !== oldLane) return false;
    const old = state.scores.find((score) => score.game_id === gameId && score.player_id === JSON.parse(key)[2]);
    return draft.manualScore || draft.manualFinal || draft.score !== String(old?.pontos ?? "") || draft.finalized !== Boolean(old?.finalizado);
  });
  if (dirty && !window.confirm("Há alterações não salvas nesta conferência. Descartá-las e trocar de partida ou pista?")) {
    $("photoGame").value = oldGameId || "";
    $("photoLane").value = oldLane || "";
    return;
  }
  for (const key of state.reviewDraft.keys()) {
    const [gameId, lane] = JSON.parse(key);
    if (gameId === oldGameId && lane === oldLane) state.reviewDraft.delete(key);
  }
  state.reviewViewKey = null;
  state.reviewConflict = false;
  if (event.target.id === "photoGame") renderPhotoOptions(); else updateReviewTable();
}

function updatePhotoConfirmState() {
  const rows = [...document.querySelectorAll("[data-review-player]")];
  const values = rows.map((row) => row.querySelector(".review-score").value);
  let hasChange = false;
  rows.forEach((row) => {
    const value = row.querySelector(".review-score").value;
    const finalizado = row.querySelector(".review-final").checked;
    const old = row.dataset.oldScore;
    const oldFinal = row.dataset.oldFinal === "true";
    const hint = row.querySelector(".review-score-wrap small");
    hint.textContent = value === "" ? (old === "" ? "Sem pontuação" : `Atual: ${old}`) : `${old === "" ? "—" : old} → ${value}`;
    if (value !== "" && (value !== old || finalizado !== oldFinal)) hasChange = true;
  });
  const valid = values.every((value) => value === "" || (/^\d+$/.test(value) && Number(value) <= 300));
  $("photoConfirmHint").textContent = !rows.length
    ? "Nenhum jogador desta pista está vinculado à partida. Confira a pista e os participantes."
    : !valid ? "Corrija as pontuações: use números inteiros de 0 a 300."
    : !hasChange ? "Preencha ou altere ao menos uma pontuação na conferência. Selecionar a foto não publica pontos automaticamente."
    : "Há pontuações prontas para salvar. Confira os totais antes de confirmar.";
  if (state.reviewConflict) $("photoConfirmHint").textContent += " Os resultados mudaram em outro aparelho; revise antes de salvar.";
  $("reviewPendingNote").hidden = !hasChange;
}

function updateReviewTable(suggestions = new Map()) {
  const lane = $("photoLane").value;
  $("reviewLaneLabel").textContent = lane ? displayLocation(lane) : "Selecione a pista";
  const gameId = $("photoGame").value;
  const viewKey = JSON.stringify([gameId, lane]);
  if (state.reviewViewKey === viewKey) captureReviewDraft();
  state.reviewViewKey = viewKey;
  const rows = playersOnLane(lane);
  $("reviewTable").innerHTML = rows.length ? rows.map((player) => {
    const old = state.scores.find((score) => score.game_id === gameId && score.player_id === player.id);
    const suggestion = suggestions.get(player.id);
    const draft = state.reviewDraft.get(reviewKey(gameId, lane, player.id));
    const value = draft?.manualScore ? draft.score : suggestion?.value ?? draft?.score ?? old?.pontos ?? "";
    const suggestionChangesScore = suggestion && Number(suggestion.value) !== Number(old?.pontos);
    const finalizado = draft?.manualFinal || draft?.manualScore ? draft.finalized : suggestionChangesScore ? false : draft?.finalized ?? Boolean(old?.finalizado);
    return `<div class="review-row" data-review-player="${esc(player.id)}" data-old-score="${old?.pontos ?? ""}" data-old-final="${Boolean(old?.finalizado)}" data-manual-score="${Boolean(draft?.manualScore)}" data-manual-final="${Boolean(draft?.manualFinal)}"><div class="review-player"><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")} · pista ${esc(scoreLane(old) || "—")}${suggestion && !draft?.manualScore ? ` · ${esc(suggestion.hint)}` : ""}</small></div><div class="review-score-wrap"><input class="review-score" type="number" min="0" max="300" step="1" inputmode="numeric" placeholder="—" value="${value === "" ? "" : esc(value)}" aria-label="Pontos de ${esc(player.nome)}" /><small></small></div><label class="review-confirm"><input class="review-final" type="checkbox" ${finalizado ? "checked" : ""} /> confirmar</label></div>`;
  }).join("") : `<div class="empty-state"><strong>Nenhum jogador nessa pista</strong><span>Cadastre o participante com o número da pista antes de importar.</span></div>`;
  updatePhotoConfirmState();
}

function openAuth() {
  if (state.session) return signOut();
  if (isDemoMode) {
    showToast("Configure o Supabase antes de autenticar.", "error");
    return;
  }
  $("authError").hidden = true;
  setModal("authModal", true);
}

async function signOut() {
  if (advancedModeController?.close?.() === false) return;
  if (client) await client.auth.signOut();
  setSession(null);
  state.profile = null;
  state.profiles = [];
  state.scoreChanges = [];
  state.roundScoreChanges = [];
  state.throwChanges = [];
  state.auditHistoryOffsets = { scoreChanges: 100, roundScoreChanges: 100, throwChanges: 100 };
  state.auditHistoryHasMore = { scoreChanges: false, roundScoreChanges: false, throwChanges: false };
  state.recovering = false;
  sessionStorage.removeItem("boliche-recovery-user");
  setModal("recoveryModal", false);
  ["approvalsModal", "historyModal", "playersModal", "gameModal", "photoModal", "profileModal"].forEach((id) => setModal(id, false));
  showToast("Sessão encerrada.", "info");
  try { await loadData(); } catch (error) { console.error(error); }
  render();
}

async function submitAuth(event) {
  event.preventDefault();
  if (!client) return;
  const { data, error } = await client.auth.signInWithPassword({ email: $("authEmail").value.trim(), password: $("authPassword").value });
  if (error) {
    $("authError").textContent = "Não foi possível entrar. Confira o e-mail e a senha.";
    $("authError").hidden = false;
    return;
  }
  setSession(data.session);
  setModal("authModal", false);
  await loadProfile();
  try { await loadData(); } catch (loadError) { console.error(loadError); showToast("Sessão iniciada, mas a lista não atualizou. Recarregue a página.", "error"); }
  render();
  showProfileIfNeeded();
  showToast(isAdmin() ? "Sessão de administrador iniciada." : "Sessão iniciada.", "success");
}

function openRegister() {
  if (!client) return showToast("Supabase não configurado.", "error");
  $("registerError").hidden = true;
  $("registerForm").reset();
  setModal("registerModal", true);
}

async function submitRegister(event) {
  event.preventDefault();
  if (!client) return;
  const nome = $("registerName").value.trim();
  const email = $("registerEmail").value.trim();
  const password = $("registerPassword").value;
  const confirmation = $("registerPasswordConfirm").value;
  if (password !== confirmation) {
    $("registerError").textContent = "As senhas não conferem.";
    $("registerError").hidden = false;
    return;
  }
  const { data, error } = await client.auth.signUp({ email, password, options: { data: { nome } } });
  if (error) {
    $("registerError").textContent = error.message?.includes("rate limit") ? "O envio de e-mails do Supabase atingiu o limite. Aguarde ou configure SMTP próprio." : "Não foi possível criar a conta. Confira os dados e tente novamente.";
    $("registerError").hidden = false;
    return;
  }
  setModal("registerModal", false);
  setSession(data.session);
  await loadProfile();
  render();
  if (data.session) showProfileIfNeeded();
  else showToast("Conta criada. Confirme o e-mail para concluir seu perfil com uma foto.", "success");
}

async function prepareProfilePhoto(file) {
  const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const maxSize = 5 * 1024 * 1024;
  if (extensions[file.type] && file.size <= maxSize) {
    return { body: file, contentType: file.type, extension: extensions[file.type] };
  }
  if (!file.type.startsWith("image/") && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new Error("Escolha uma imagem JPG, PNG, WebP ou HEIC.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Não foi possível abrir esta foto. Escolha uma imagem JPG, PNG ou WebP."));
      image.src = objectUrl;
    });
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Não foi possível preparar a foto neste navegador.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const body = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (body && body.size <= maxSize) return { body, contentType: "image/jpeg", extension: "jpg" };
    }
    throw new Error("A foto ainda está muito grande. Escolha outra imagem.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function profilePhotoSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const otherId = event.target.id === "profileCamera" ? "profilePhoto" : "profileCamera";
  $(otherId).value = "";
  $("profilePhotoName").textContent = `${event.target.id === "profileCamera" ? "Foto capturada" : "Foto escolhida"}: ${file.name}`;
  $("profileError").hidden = true;
}

async function cleanupUnusedProfilePhotos(userId, currentPath) {
  const bucket = client.storage.from("profile-photos");
  const paths = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: files, error: listError } = await bucket.list(userId, { limit: 1000, offset });
    if (listError) return listError;
    paths.push(...(files || []).filter((file) => file.id).map((file) => `${userId}/${file.name}`).filter((path) => path !== currentPath));
    if (!files || files.length < 1000) break;
  }
  if (!paths.length) return null;
  const { data: unused, error: checkError } = await client.rpc("unreferenced_profile_photos", { p_paths: paths });
  if (checkError) return checkError;
  if (!unused?.length) return null;
  for (let index = 0; index < unused.length; index += 100) {
    const { error: removeError } = await bucket.remove(unused.slice(index, index + 100));
    if (removeError) return removeError;
  }
  return null;
}

async function submitProfile(event) {
  event.preventDefault();
  const errorElement = $("profileError");
  const file = $("profileCamera").files?.[0] || $("profilePhoto").files?.[0];
  const nome = $("profileName").value.trim();
  const photoPublic = $("profilePhotoPublic").checked;
  errorElement.hidden = true;
  if (!client || !state.session) {
    errorElement.textContent = "Sua sessão terminou. Entre novamente para salvar o perfil.";
    errorElement.hidden = false;
    return;
  }
  if (!nome) {
    errorElement.textContent = "Informe seu nome antes de salvar o perfil.";
    errorElement.hidden = false;
    $("profileName").focus();
    return;
  }
  const button = $("profileSubmitButton");
  button.disabled = true;
  button.textContent = "Salvando…";
  let uploadedPath = null;
  try {
    const { data: authData, error: authError } = await client.auth.getSession();
    if (authError || !authData?.session) throw new Error("Sua sessão expirou. Entre novamente para salvar a foto.");
    setSession(authData.session);
    const { data: currentProfile, error: readError } = await client.from("profiles").select("id,nome,foto_path,status,player_id,photo_public_opt_in,updated_at").eq("id", state.session.user.id).maybeSingle();
    if (readError) throw new Error(`Não foi possível conferir o cadastro: ${readError.message || "tente novamente"}.`);
    if (!file && !currentProfile?.foto_path) throw new Error("Adicione pelo menos uma foto para concluir o cadastro.");
    let fotoPath = currentProfile?.foto_path;
    if (file) {
      const prepared = await prepareProfilePhoto(file);
      const randomId = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), (part) => part.toString(16).padStart(2, "0")).join("");
      fotoPath = `${state.session.user.id}/${randomId}.${prepared.extension}`;
      button.textContent = "Enviando foto…";
      const { error: uploadError } = await client.storage.from("profile-photos").upload(fotoPath, prepared.body, { contentType: prepared.contentType, upsert: false });
      if (uploadError) throw new Error(`Não foi possível enviar a foto: ${uploadError.message || "verifique sua conexão e tente novamente"}.`);
      uploadedPath = fotoPath;
    }
    button.textContent = "Salvando perfil…";
    const query = currentProfile
      ? client.from("profiles").update({ nome, foto_path: fotoPath, photo_public_opt_in: photoPublic }).eq("id", state.session.user.id).eq("updated_at", currentProfile.updated_at)
      : client.from("profiles").insert({ id: state.session.user.id, nome, foto_path: fotoPath, photo_public_opt_in: photoPublic });
    const { data, error } = await query.select("id,nome,foto_path,status,player_id,photo_public_opt_in,updated_at").single();
    if (error) {
      if (uploadedPath) {
        try {
          const { error: cleanupError } = await client.storage.from("profile-photos").remove([uploadedPath]);
          if (cleanupError) console.warn("Nova foto ainda não referenciada; limpeza pendente", cleanupError);
        } catch (cleanupError) { console.warn("Nova foto ainda não referenciada; limpeza pendente", cleanupError); }
      }
      throw new Error(`Não foi possível salvar o perfil: ${error.code === "PGRST116" ? "o perfil mudou em outro aparelho; recarregue e tente novamente" : error.message || "tente novamente"}.`);
    }
    state.profile = data;
    if (data.foto_path) {
      try {
        const { data: signed } = await client.storage.from("profile-photos").createSignedUrl(data.foto_path, 300);
        state.profile.photoUrl = signed?.signedUrl || null;
      } catch (previewError) {
        console.warn("Foto salva, mas a prévia não carregou.", previewError);
      }
    }
    setModal("profileModal", false);
    render();
    if (data.status === "approved") refreshAfterReconnect();
    let cleanupError = null;
    try { cleanupError = await cleanupUnusedProfilePhotos(state.session.user.id, data.foto_path); }
    catch (error) { cleanupError = error; }
    if (cleanupError) console.warn("Perfil salvo; falha ao remover fotos antigas", cleanupError);
    showToast(cleanupError ? "Perfil salvo, mas fotos antigas ainda precisam ser removidas." : data.status === "approved" ? "Perfil atualizado." : "Perfil salvo e enviado para aprovação.", cleanupError ? "warning" : "success");
  } catch (error) {
    console.error(error);
    errorElement.textContent = error.message || "Não foi possível salvar seu perfil. Tente novamente.";
    errorElement.hidden = false;
    showToast(errorElement.textContent, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Salvar perfil";
  }
}

async function addPlayer() {
  const nome = $("playerName").value.trim();
  const apelido_placar = $("playerNickname").value.trim();
  const pista = $("playerLane").value.trim();
  const stationMode = ["quiz", "gincana"].includes(getGameMode().id);
  if (!nome || !apelido_placar || !pista) return showToast(`Preencha nome, apelido e ${stationMode ? "estação" : "pista"}.`, "error");
  if (!playerLocationOptions().some((location) => location.name === pista)) return showToast(stationMode ? "Selecione a estação virtual para este cadastro." : "Jogadores de boliche devem ficar associados a uma pista física.", "error");
  const row = { nome, apelido_placar, pista };
  if (!client) return showToast("Supabase não configurado.", "error");
  const editing = Boolean(state.editingPlayerId);
  const query = editing
    ? client.from("players").update(row).eq("id", state.editingPlayerId)
    : client.from("players").insert(row);
  const { data, error } = await query.select("id,nome,apelido_placar,pista").single();
  if (error) return showToast(editing ? "Não foi possível salvar o participante." : "Não foi possível cadastrar o participante.", "error");
  if (editing) state.players = state.players.map((player) => player.id === data.id ? data : player);
  else state.players.push(data);
  cancelPlayerEdit();
  renderPlayers(); renderPlayerSelection(); renderPhotoOptions();
  showToast(editing ? `${nome} foi atualizado.` : `${nome} foi cadastrado.`, "success");
}

async function removePlayer(id) {
  const player = getPlayer(id);
  if (!window.confirm(`Excluir ${player?.nome || "este jogador"}? Suas pontuações, alterações e posição no ranking serão removidas permanentemente.`)) return;
  if (!client) return showToast("Supabase não configurado.", "error");
  const { error } = await client.rpc("delete_player_cascade", { p_player_id: id });
  if (error) return showToast("Não foi possível remover o participante.", "error");
  await loadData(); render(); showToast("Jogador e pontuações excluídos.", "success");
}

async function createGame(event) {
  event.preventDefault();
  if (!requireReadyMode()) return;
  const nome = $("gameName").value.trim();
  const playerIds = [...document.querySelectorAll("#playerSelection input:checked")].map((input) => input.value);
  if (!nome || !playerIds.length) return showToast("Informe um nome e selecione pelo menos um participante.", "error");
  if (!encounterOpen()) return showToast("Reabra o encontro para alterar partidas.", "error");
  if (!client) return showToast("Supabase não configurado.", "error");
  const modeId = activeEncounter()?.game_type || "boliche";
  const advanced = Boolean(advancedPresentation(modeId));
  const matchMode = ["pebolim", "sinuca", "tenis_mesa", "truco"].includes(modeId);
  if (matchMode && playerIds.length !== 2) return showToast("Confrontos por sets precisam de exatamente dois participantes.", "error");
  if (modeId === "dardos_501" && (playerIds.length < 2 || playerIds.length > 4)) return showToast("Dardos 501 precisa de dois a quatro participantes.", "error");
  const assignments = playerIds.map((player_id) => ({ player_id, pista: advanced ? VIRTUAL_STATION_LANE : $("playerSelection").querySelector(`[data-player-lane="${player_id}"]`)?.value || "" }));
  if (advanced && playerIds.length > 20) return showToast("A estação aceita até 20 participantes.", "error");
  if (assignments.some((item) => !item.pista)) return showToast("Escolha a pista de cada participante.", "error");
  const locations = gameLocations();
  if (assignments.some((item) => !locations.some((lane) => lane.name === item.pista))) return showToast(isRoundBased() ? "Selecione a estação virtual para todos os participantes." : "Selecione uma pista física para cada participante.", "error");
  const overCapacity = locations.find((lane) => assignments.filter((item) => item.pista === lane.name).length > lane.capacity);
  if (overCapacity) return showToast(isVirtualStationLane(overCapacity.name)
    ? `A estação aceita até ${overCapacity.capacity} participantes.`
    : `A pista ${overCapacity.name} aceita até ${overCapacity.capacity} participantes.`, "error");
  if (state.editingGameId) {
    const gameId = state.editingGameId;
    const removedWithScores = gameScores(gameId).some((score) => !playerIds.includes(score.player_id) && score.pontos != null);
    if (removedWithScores && !window.confirm("Remover jogadores desta partida apagará suas pontuações e o histórico de alterações. Continuar?")) return;
    const { error } = await client.rpc("edit_encounter_game", { p_game_id: gameId, p_name: nome, p_assignments: assignments });
    if (error) return showToast(`Não foi possível salvar a partida: ${error.message}`, "error");
    state.editingGameId = null;
    setModal("gameModal", false); await loadData(); render(); showToast("Partida atualizada.", "success");
    return;
  }
  const contentKey = JSON.stringify({ encounter_id: state.activeEncounterId, name: nome, assignments: [...assignments].sort((a, b) => a.player_id.localeCompare(b.player_id)) });
  if (state.gameRequestContent !== null && state.gameRequestContent !== contentKey) state.gameRequestId = crypto.randomUUID();
  state.gameRequestContent = contentKey;
  const { data, error } = await client.rpc("create_encounter_game", { p_encounter_id: state.activeEncounterId, p_name: nome, p_assignments: assignments, p_request_id: state.gameRequestId });
  if (error) return showToast(`Não foi possível abrir a partida: ${error.message}`, "error");
  state.activeGameId = data.id;
  setModal("gameModal", false); await loadData(); render(); showToast("Partida aberta.", "success");
}

function drawLanes() {
  if (isAdvancedEncounter()) return showToast("A modalidade não usa distribuição por pistas.", "info");
  const checked = [...$("playerSelection").querySelectorAll(".game-player-check:checked")];
  const locations = gameLocations();
  const assignments = balancedLaneDraw(checked.map((input) => input.value), locations);
  if (!assignments) return showToast(isRoundBased()
    ? `A estação virtual aceita até ${locations.find((lane) => isVirtualStationLane(lane.name))?.capacity || 20} participantes.`
    : "Cadastre pistas ou ajuste a capacidade antes de distribuir os participantes.", "error");
  assignments.forEach(({ player_id, pista }) => { $("playerSelection").querySelector(`[data-player-lane="${player_id}"]`).value = pista; });
  showToast(isRoundBased() ? "Participantes distribuídos na estação virtual. Confira antes de salvar." : "Pistas sorteadas para esta partida. Confira antes de salvar.", "success");
}

function balancedLaneDraw(playerIds, lanes) {
  if (!lanes.length || playerIds.length > lanes.reduce((sum, lane) => sum + lane.capacity, 0)) return null;
  const shuffled = [...playerIds];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const occupancy = new Map(lanes.map((lane) => [lane.name, 0]));
  return shuffled.map((player_id) => {
    const eligible = lanes.filter((lane) => occupancy.get(lane.name) < lane.capacity);
    const least = Math.min(...eligible.map((lane) => occupancy.get(lane.name)));
    const choices = eligible.filter((lane) => occupancy.get(lane.name) === least);
    const lane = choices[Math.floor(Math.random() * choices.length)];
    occupancy.set(lane.name, occupancy.get(lane.name) + 1);
    return { player_id, pista: lane.name };
  });
}

function openGameModal() {
  if (advancedModeController?.close?.() === false) return;
  if (!requireReadyMode()) return;
  if (!encounterOpen()) return showToast("Reabra o encontro para criar partidas.", "error");
  state.editingGameId = null;
  state.gameRequestId = crypto.randomUUID();
  state.gameRequestContent = null;
  $("gameSubmitButton").textContent = "Abrir partida";
  $("gameModalTitle").textContent = "Nova partida";
  $("gameName").value = `Partida ${encounterGames().length + 1}`;
  renderPlayerSelection(); setModal("gameModal", true);
}

function editGame(id) {
  if (!requireReadyMode()) return;
  const game = getGame(id);
  if (!game) return;
  state.editingGameId = id;
  $("gameModalTitle").textContent = "Editar partida";
  $("gameSubmitButton").textContent = "Salvar partida";
  $("gameName").value = game.nome;
  renderPlayerSelection();
  const linked = new Set(gameScores(id).map((score) => score.player_id));
  $("playerSelection").querySelectorAll("input").forEach((input) => input.checked = linked.has(input.value));
  gameScores(id).forEach((score) => { const select = $("playerSelection").querySelector(`[data-player-lane="${score.player_id}"]`); if (select) select.value = scoreLane(score); });
  setModal("gameModal", true);
}

async function removeGame(id) {
  if (!requireReadyMode()) return;
  const game = getGame(id);
  if (!window.confirm(`Excluir ${game?.nome || "esta partida"}? Todos os pontos e o histórico desta partida serão removidos permanentemente; o ranking será recalculado.`)) return;
  const { error } = await client.rpc("delete_encounter_game", { p_game_id: id });
  if (error) return showToast("Não foi possível excluir a partida.", "error");
  await loadData(); render(); showToast("Partida e resultados excluídos.", "success");
}

function openPlayersModal() { cancelPlayerEdit(); cancelLaneEdit(); renderPlayers(); setModal("playersModal", true); }

function renderApprovals() {
  $("approvalsList").innerHTML = state.profiles.length ? state.profiles.map((profile) => {
    const linked = state.profiles.filter((item) => item.id !== profile.id).map((item) => item.player_id).filter(Boolean);
    const candidates = state.players.filter((player) => !linked.includes(player.id));
    const exactMatches = candidates.filter((player) => normalize(player.nome) === normalize(profile.nome || ""));
    const suggestedId = profile.player_id || (exactMatches.length === 1 ? exactMatches[0].id : null);
    const options = candidates.map((player) => `<option value="${esc(player.id)}" ${player.id === suggestedId ? "selected" : ""}>${esc(player.nome)} · pista ${esc(player.pista)}</option>`).join("");
    const name = profile.nome || "Sem nome";
    const label = profile.is_admin_account ? "Administrador" : !profile.foto_path ? "Aguardando perfil com foto" : profile.status === "approved" ? "Aprovado" : profile.status === "rejected" ? "Recusado" : "Pendente";
    const actions = profile.is_admin_account ? "" : `<div class="approval-actions">${profile.foto_path ? `<button class="button button--primary" type="button" data-approve="${esc(profile.id)}">Aprovar</button><button class="button button--quiet" type="button" data-reject="${esc(profile.id)}">Recusar</button><button class="text-button" type="button" data-edit-account="${esc(profile.id)}">Editar nome</button>` : ""}<button class="text-button text-button--danger" type="button" data-delete-account="${esc(profile.id)}">Excluir conta</button></div>`;
    return `<div class="approval-row" data-profile-id="${esc(profile.id)}">${profile.photoUrl ? `<img src="${esc(profile.photoUrl)}" alt="Foto de ${esc(name)}" />` : `<span class="approval-no-photo">Sem foto</span>`}<div><strong>${esc(name)}</strong><small>${esc(profile.email || "Sem e-mail")} · ${label}</small></div><select aria-label="Jogador vinculado a ${esc(name)}" ${profile.foto_path && !profile.is_admin_account ? "" : "disabled"}><option value="">Selecione o jogador existente</option>${options}</select>${actions}</div>`;
  }).join("") : `<p class="empty-inline">Nenhum cadastro recebido.</p>`;
  $("approvalsList").querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => setProfileApproval(button.dataset.approve, "approved")));
  $("approvalsList").querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", () => setProfileApproval(button.dataset.reject, "rejected")));
  $("approvalsList").querySelectorAll("[data-edit-account]").forEach((button) => button.addEventListener("click", () => editAccountName(button.dataset.editAccount)));
  $("approvalsList").querySelectorAll("[data-delete-account]").forEach((button) => button.addEventListener("click", () => deleteAccount(button.dataset.deleteAccount)));
}

async function setProfileApproval(id, status) {
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile?.foto_path) return showToast("A conta precisa concluir o perfil com uma foto.", "error");
  const row = [...$("approvalsList").querySelectorAll("[data-profile-id]")].find((item) => item.dataset.profileId === id);
  const playerId = status === "approved" ? row?.querySelector("select")?.value : null;
  if (status === "approved" && !playerId) return showToast("Selecione o jogador existente antes de aprovar.", "error");
  const { error } = await client.from("profiles").update({ status, player_id: playerId }).eq("id", id);
  if (error) return showToast("Não foi possível atualizar a aprovação.", "error");
  await loadData(); render();
  showToast(status === "approved" ? "Cadastro aprovado e vinculado ao jogador." : "Cadastro recusado.", "success");
}

async function editAccountName(id) {
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile?.foto_path) return;
  const name = window.prompt("Nome do cadastro", profile.nome || "")?.trim();
  if (name == null) return;
  if (!name || name.length > 80) return showToast("Informe um nome com até 80 caracteres.", "error");
  const { error } = await client.from("profiles").update({ nome: name }).eq("id", id);
  if (error) return showToast("Não foi possível atualizar o nome.", "error");
  await loadData(); render(); showToast("Nome do cadastro atualizado.", "success");
}

async function deleteAccount(id) {
  const account = state.profiles.find((item) => item.id === id);
  if (!account || account.is_admin_account || id === state.session?.user?.id) return;
  if (!window.confirm(`Excluir permanentemente a conta ${account.email || account.nome || id}? O acesso será removido; o jogador e seus pontos continuarão até serem excluídos separadamente.`)) return;
  const bucket = client.storage.from("profile-photos");
  for (;;) {
    const { data, error } = await bucket.list(id, { limit: 1000 });
    if (error) return showToast("Não foi possível listar as fotos da conta.", "error");
    const files = (data || []).filter((item) => item.id).map((item) => `${id}/${item.name}`);
    if (!files.length) break;
    const { error: removeError } = await bucket.remove(files);
    if (removeError) return showToast("Não foi possível remover as fotos. A conta foi mantida.", "error");
  }
  const { error } = await client.rpc("delete_registered_user", { p_user_id: id });
  if (error) return showToast("Fotos removidas, mas a conta não pôde ser excluída. Tente novamente ou use o painel Auth.", "error");
  await loadData(); render(); showToast("Conta excluída.", "success");
}

function openApprovalsModal() { renderApprovals(); setModal("approvalsModal", true); }

function renderScoreHistory() {
  const mode = getGameMode();
  const gameIds = new Set(encounterGames().map((game) => game.id));
  const changes = state.scoreChanges.filter((change) => gameIds.has(change.game_id));
  const throwChanges = state.throwChanges.filter((change) => gameIds.has(change.game_id));
  const roundChanges = state.roundScoreChanges.filter((change) => gameIds.has(change.game_id));
  const scoreRows = changes.map((change, index) => {
    const player = getPlayer(change.player_id);
    const game = getGame(change.game_id);
    const actor = state.profiles.find((profile) => profile.id === change.actor_id)?.nome || (change.actor_id === state.session?.user?.id ? "Você" : "Administrador");
    const canUndo = !isRoundBased() && encounterActive() && !changes.slice(0, index).some((newer) => newer.score_id === change.score_id);
    return `<div class="history-row"><div><strong>${esc(player?.nome || "Jogador")}</strong><small>${esc(game?.nome || "Partida")} · ${fmtDate(change.changed_at)} · ${esc(actor)} · ${esc(mode.name)} · ${esc(mode.unit)}</small><span>${change.previous_points ?? "—"} → ${change.new_points ?? "—"}${change.previous_finalized !== change.new_finalized ? ` · ${change.new_finalized ? "confirmado" : "pendente"}` : ""}</span></div>${canUndo ? `<button class="text-button" type="button" data-undo-change="${change.id}">Desfazer</button>` : ""}</div>`;
  });
  const throwRows = throwChanges.map((change) => {
    const player = getPlayer(change.player_id);
    const game = getGame(change.game_id);
    const actor = state.profiles.find((profile) => profile.id === change.actor_id)?.nome || (change.actor_id === state.session?.user?.id ? "Você" : "Administrador");
    return `<div class="history-row"><div><strong>${esc(player?.nome || "Jogador")}</strong><small>${esc(game?.nome || "Partida")} · ${fmtDate(change.changed_at)} · ${esc(actor)}</small><span>Arremessos: ${change.previous_throws?.length || 0} → ${change.new_throws?.length || 0} · ${esc(change.reason || "Correção")}</span></div></div>`;
  });
  const roundRows = state.roundScores.filter((row) => gameIds.has(row.game_id)).map((row) => {
    const game = getGame(row.game_id);
    const player = getPlayer(row.player_id);
    const value = roundPoints(row);
    return `<div class="history-row"><div><strong>${esc(player?.nome || "Jogador")}</strong><small>${esc(game?.nome || "Partida")} · ${mode.name} · Rodada ${esc(row.round_no)}</small><span>${value == null ? "Sem pontuação" : `${esc(value)} ${esc(mode.unit)}`} · ${roundFinalized(row) ? "confirmado" : "pendente"}</span></div></div>`;
  });
  const roundChangeRows = roundChanges.map((change, index) => {
    const player = getPlayer(change.player_id);
    const game = getGame(change.game_id);
    const roundNo = change.round_no ?? change.p_round_no ?? "—";
    const actor = state.profiles.find((profile) => profile.id === change.actor_id)?.nome || (change.actor_id === state.session?.user?.id ? "Você" : "Administrador");
    const previous = change.previous_points ?? change.old_points ?? "—";
    const next = change.new_points ?? change.points ?? change.p_points ?? "—";
    const key = `${change.game_id}:${roundNo}:${change.player_id}`;
    const canUndo = isAdmin() && encounterActive() && change.id != null && !roundChanges.slice(0, index).some((newer) => `${newer.game_id}:${newer.round_no ?? newer.p_round_no ?? "—"}:${newer.player_id}` === key);
    return `<div class="history-row"><div><strong>${esc(player?.nome || "Jogador")}</strong><small>${esc(game?.nome || "Partida")} · ${mode.name} · Rodada ${esc(roundNo)} · ${fmtDate(change.changed_at)} · ${esc(actor)}</small><span>${esc(previous)} → ${esc(next)} ${esc(mode.unit)}${change.previous_finalized !== undefined && change.previous_finalized !== change.new_finalized ? ` · ${change.new_finalized ? "confirmado" : "pendente"}` : ""}</span></div>${canUndo ? `<button class="text-button" type="button" data-undo-round-change="${esc(change.id)}">Desfazer</button>` : ""}</div>`;
  });
  const rows = [...scoreRows, ...throwRows, ...roundRows, ...roundChangeRows];
  const canLoadMore = isAdmin() && Object.values(state.auditHistoryHasMore).some(Boolean);
  $("scoreHistoryList").innerHTML = `<p class="section-meta">${esc(activeEncounter()?.nome || "Encontro")} · ${esc(mode.name)} · unidade: ${esc(mode.unit)}</p>${rows.length ? rows.join("") : `<p class="empty-inline">Nenhuma alteração registrada.</p>`}${canLoadMore ? `<button class="button button--quiet" type="button" data-load-audit-history>Carregar alterações anteriores</button>` : ""}`;
  $("scoreHistoryList").querySelectorAll("[data-undo-change]").forEach((button) => button.addEventListener("click", () => undoScoreChange(Number(button.dataset.undoChange))));
  $("scoreHistoryList").querySelectorAll("[data-undo-round-change]").forEach((button) => button.addEventListener("click", () => undoRoundScoreChange(button.dataset.undoRoundChange)));
  $("scoreHistoryList").querySelectorAll("[data-load-audit-history]").forEach((button) => button.addEventListener("click", loadMoreAuditHistory));
}

async function loadMoreAuditHistory() {
  if (!isAdmin() || !client) return;
  const auditRequestUserId = state.session?.user?.id;
  const auditRequestGeneration = state.auditAuthGeneration;
  const pages = [
    { key: "scoreChanges", table: "score_changes", columns: "id,score_id,game_id,player_id,previous_points,new_points,previous_finalized,new_finalized,changed_at,actor_id" },
    { key: "roundScoreChanges", table: "round_score_changes", columns: "*" },
    { key: "throwChanges", table: "throw_changes", columns: "id,score_id,game_id,player_id,previous_throws,new_throws,reason,changed_at,actor_id" },
  ].filter((page) => state.auditHistoryHasMore[page.key]);
  const results = await Promise.all(pages.map(async (page) => {
    const offset = state.auditHistoryOffsets[page.key] || 100;
    const result = await client.from(page.table).select(page.columns).order("id", { ascending: false }).range(offset, offset + 99);
    return { ...page, offset, ...result };
  }));
  if (!isAdmin() || state.auditAuthGeneration !== auditRequestGeneration || state.session?.user?.id !== auditRequestUserId) return;
  const error = results.find((result) => result.error);
  if (error) {
    showToast(`Não foi possível carregar o histórico anterior: ${error.error.message || "erro de leitura"}.`, "error");
    return;
  }
  for (const result of results) {
    const keyField = "id";
    const stateField = result.key;
    const byId = new Map(state[stateField].map((row) => [String(row[keyField]), row]));
    (result.data || []).forEach((row) => byId.set(String(row[keyField]), row));
    state[stateField] = liveAuditRows([...byId.values()], stateField).sort((a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));
    state.auditHistoryOffsets[stateField] = result.offset + (result.data || []).length;
    if ((result.data || []).length < 100) state.auditHistoryHasMore[stateField] = false;
  }
  renderScoreHistory();
}

async function undoScoreChange(id) {
  if (!window.confirm("Desfazer esta alteração de pontuação?")) return;
  const { error } = await client.rpc("undo_score_change", { p_change_id: id });
  if (error) return showToast("Não foi possível desfazer: o resultado pode ter sido alterado depois.", "error");
  await loadData(); render(); showToast("Alteração desfeita.", "success");
}

async function undoRoundScoreChange(id) {
  const rawId = String(id ?? "");
  if (!rawId || !window.confirm("Desfazer a última alteração desta pontuação por rodada? O total do jogo será recalculado pelo banco.")) return;
  const numericId = Number(rawId);
  const changeId = /^\d+$/.test(rawId) && Number.isSafeInteger(numericId) ? numericId : rawId;
  const { error } = await client.rpc("undo_round_score_change", { p_change_id: changeId });
  if (error) return showToast(`Não foi possível desfazer: ${error.message || "a rodada pode ter sido alterada depois"}.`, "error");
  await loadData(); render(); showToast("Alteração da rodada desfeita.", "success");
}

function openHistoryModal() { renderScoreHistory(); setModal("historyModal", true); }

const shareUrl = () => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (state.activeEncounterId) url.searchParams.set("encontro", state.activeEncounterId);
  return url.toString();
};
async function openShareModal() {
  const link = $("shareModal").querySelector(".share-link");
  const url = shareUrl();
  link.href = url;
  link.textContent = activeEncounter() ? `Link de ${activeEncounter().nome}` : "Link do placar";
  setModal("shareModal", true);
  const qr = $("shareQr");
  if (qr) {
    qr.hidden = true;
    if (typeof window.JogatinaQR?.toDataURL === "function") {
      try {
        const imageData = await window.JogatinaQR.toDataURL(url);
        if (imageData && shareUrl() === url) { qr.src = imageData; qr.hidden = false; }
      } catch (error) { console.warn("QR do encontro indisponível", error); }
    }
  }
}
async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(shareUrl());
    showToast("Link do placar copiado.", "success");
  } catch {
    showToast("Abra o link exibido e copie o endereço do navegador.", "error");
  }
}

async function shareScoreboard() {
  if (!navigator.share) return copyShareLink();
  try { await navigator.share({ title: "Jogatina dos Amigos", url: shareUrl() }); }
  catch (error) { if (error.name !== "AbortError") showToast("Não foi possível compartilhar o link.", "error"); }
}

async function shareResultCard() {
  const totals = [...officialTotals()].sort((a, b) => b.points - a.points || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
  const totalPosition = (index) => totals.findIndex((item) => item.points === totals[index].points) + 1;
  const finalGames = encounterGames().filter((game) => game.status === "final");
  if (!totals.length) return showToast("Finalize uma partida para gerar a imagem do resultado.", "error");
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = Math.max(1100, 500 + totals.length * 72 + 150);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6f4ef"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#bd8d52"; context.fillRect(0, 0, canvas.width, 18);
  context.fillStyle = "#2f312f"; context.font = "bold 62px Georgia"; context.fillText("Jogatina dos Amigos", 80, 110);
  context.font = "28px Arial"; context.fillText("Classificação oficial do encontro", 80, 160);
  context.fillStyle = "#777a76"; context.font = "22px Arial";
  const lastGameDate = finalGames.map((game) => game.created_at).filter(Boolean).sort().at(-1);
  context.fillText(`${finalGames.length} ${finalGames.length === 1 ? "partida finalizada" : "partidas finalizadas"} · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(lastGameDate || Date.now()))}`, 80, 202);
  totals.slice(0, 3).forEach((item, index) => {
    const x = 80 + index * 315;
    context.fillStyle = index === 0 ? "#e9d5b8" : "#fbfaf7"; context.fillRect(x, 246, 295, 180);
    context.strokeStyle = "#d8d9d3"; context.strokeRect(x, 246, 295, 180);
    context.fillStyle = "#805928"; context.font = "bold 44px Georgia"; context.fillText(`${totalPosition(index)}º`, x + 18, 302);
    context.fillStyle = "#2f312f"; context.font = "bold 24px Arial"; context.fillText(item.player.nome.slice(0, 19), x + 18, 350);
    context.font = "21px Arial"; context.fillText(`${item.points} pontos`, x + 18, 390);
  });
  context.fillStyle = "#805928"; context.font = "bold 22px Arial"; context.fillText("RANKING COMPLETO", 80, 475);
  totals.forEach((item, index) => {
    const y = 520 + index * 72;
    context.fillStyle = index % 2 ? "#f1eee8" : "#fbfaf7"; context.fillRect(80, y - 37, 925, 62);
    context.fillStyle = "#805928"; context.font = "bold 27px Georgia"; context.fillText(`${totalPosition(index)}º`, 100, y);
    context.fillStyle = "#2f312f"; context.font = "bold 24px Arial"; context.fillText(item.player.nome.slice(0, 30), 180, y);
    context.font = "22px Arial"; context.textAlign = "right"; context.fillText(`${item.points} pontos`, 980, y); context.textAlign = "left";
  });
  context.fillStyle = "#777a76"; context.font = "21px Arial"; context.fillText("munizmath.github.io/boliche", 80, canvas.height - 70);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return showToast("Não foi possível gerar a imagem.", "error");
  const file = new File([blob], "resultado-jogatina.png", { type: "image/png" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ title: "Resultado da Jogatina dos Amigos", files: [file] }); return; }
    catch (error) { if (error.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = file.name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  showToast("Imagem do resultado salva no aparelho.", "success");
}

function openPhotoModal() {
  if (!requireReadyMode()) return;
  if (!["boliche", "bowling"].includes(getGameMode().id)) return showToast("A atualização por foto está disponível apenas no boliche.", "error");
  if (!encounterActive()) return showToast("Inicie ou reabra o encontro para atualizar os pontos.", "error");
  if (!encounterGames().length) return showToast("Abra uma partida antes de importar uma foto.", "error");
  resetPhotoState(); renderPhotoOptions(); setModal("photoModal", true);
}

function resetPhotoState() {
  state.photoRevision++;
  state.ocrRunId++;
  state.reviewDraft.clear();
  state.reviewViewKey = null;
  state.reviewConflict = false;
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = null;
  state.crop = null; state.image = null; state.imageFile = null; state.previewBase = null;
  state.photoRotation = 0; state.photoContrast = 100; state.photoZoom = 100; state.photoPanMode = false;
  $("photoZoom").value = "100"; $("photoContrast").value = "100";
  $("photoZoom").disabled = true; $("photoContrast").disabled = true; $("rotatePhotoButton").disabled = true; $("photoPanButton").disabled = true;
  $("photoCanvas").style.width = "100%";
  applyPhotoInteractionMode();
  $("photoError").hidden = true;
  $("photoInput").value = ""; $("canvasPlaceholder").hidden = false; $("photoCanvas").hidden = true; $("runOcrButton").disabled = true; $("ocrStatus").textContent = "Foto opcional: você também pode preencher os pontos manualmente."; updateReviewTable();
}

function loadPhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  state.photoRevision++;
  state.ocrRunId++;
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageFile = file;
  const image = new Image();
  const imageUrl = URL.createObjectURL(file);
  state.imageUrl = imageUrl;
  image.onload = () => {
    if (state.imageUrl !== imageUrl) return;
    URL.revokeObjectURL(imageUrl); state.imageUrl = null;
    state.image = image;
    state.crop = null;
    updatePhotoPreview();
    $("photoCanvas").hidden = false; $("canvasPlaceholder").hidden = true;
    $("runOcrButton").disabled = false; $("rotatePhotoButton").disabled = false; $("photoPanButton").disabled = false;
    $("photoZoom").disabled = false; $("photoContrast").disabled = false;
    $("ocrStatus").textContent = "Imagem pronta. Ajuste, recorte e leia as sugestões.";
  };
  image.onerror = () => { if (state.imageUrl !== imageUrl) return; URL.revokeObjectURL(imageUrl); state.imageUrl = null; $("ocrStatus").textContent = "Não foi possível abrir a foto. Preencha os pontos manualmente."; };
  image.src = imageUrl;
}

function drawOrientedPhoto(canvas, maxSide) {
  const rotated = state.photoRotation % 180 !== 0;
  const sourceWidth = rotated ? state.image.naturalHeight : state.image.naturalWidth;
  const sourceHeight = rotated ? state.image.naturalWidth : state.image.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(state.photoRotation * Math.PI / 180);
  context.filter = `contrast(${state.photoContrast}%)`;
  context.drawImage(state.image, -state.image.naturalWidth * scale / 2, -state.image.naturalHeight * scale / 2, state.image.naturalWidth * scale, state.image.naturalHeight * scale);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.filter = "none";
}

function updatePhotoPreview() {
  if (!state.image) return;
  const base = document.createElement("canvas");
  drawOrientedPhoto(base, 900);
  state.previewBase = base;
  const canvas = $("photoCanvas");
  canvas.width = base.width; canvas.height = base.height;
  drawCanvas();
}

function applyPhotoInteractionMode() {
  $("photoCanvas").style.touchAction = state.photoPanMode ? "pan-x pan-y" : "none";
  $("photoPanButton").textContent = state.photoPanMode ? "Recortar imagem" : "Mover imagem";
  $("photoPanButton").setAttribute("aria-pressed", String(state.photoPanMode));
  $("photoToolsHint").textContent = state.photoPanMode ? "Deslize a imagem ampliada; toque em Recortar imagem para selecionar a área" : "Arraste sobre nomes e totais para recortar";
}

function drawCanvas() {
  const canvas = $("photoCanvas"); const context = canvas.getContext("2d");
  if (!state.previewBase) return;
  context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(state.previewBase, 0, 0);
  if (!state.crop) return;
  const { x, y, width, height } = state.crop;
  context.fillStyle = "rgba(18, 15, 12, .52)"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.clearRect(x, y, width, height); context.drawImage(state.previewBase, x, y, width, height, x, y, width, height);
  context.strokeStyle = "#f4b86a"; context.lineWidth = 3; context.strokeRect(x, y, width, height);
}

function canvasPoint(event) {
  const canvas = $("photoCanvas");
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const offsetX = (rect.width - canvas.width * scale) / 2;
  const offsetY = (rect.height - canvas.height * scale) / 2;
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left - offsetX) / scale)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top - offsetY) / scale)),
  };
}

function startCrop(event) {
  if (!state.image || state.photoPanMode) return;
  const start = canvasPoint(event); state.crop = { x: start.x, y: start.y, width: 0, height: 0, startX: start.x, startY: start.y }; $("photoCanvas").setPointerCapture?.(event.pointerId);
}
function moveCrop(event) {
  if (state.photoPanMode || (!state.crop?.startX && state.crop?.startX !== 0)) return;
  const point = canvasPoint(event); const startX = state.crop.startX; const startY = state.crop.startY;
  state.crop.x = Math.min(startX, point.x); state.crop.y = Math.min(startY, point.y); state.crop.width = Math.abs(point.x - startX); state.crop.height = Math.abs(point.y - startY); drawCanvas();
}
function endCrop() { if (state.crop && (state.crop.width < 12 || state.crop.height < 12)) state.crop = null; if (state.crop) { delete state.crop.startX; delete state.crop.startY; } drawCanvas(); }

async function runOcr() {
  if (!requireReadyMode()) return;
  if (!state.image || !window.Tesseract) return showToast("O leitor de texto não está disponível. Preencha a tabela manualmente.", "error");
  const revision = state.photoRevision;
  const runId = ++state.ocrRunId;
  const gameId = $("photoGame").value;
  const lane = $("photoLane").value;
  $("runOcrButton").disabled = true; $("ocrStatus").textContent = "Lendo a imagem… isso pode levar alguns segundos.";
  try {
    const source = getOcrCanvas();
    const result = await Tesseract.recognize(source, "por+eng", { logger: (info) => { if (runId === state.ocrRunId && revision === state.photoRevision && info.status === "recognizing text") $("ocrStatus").textContent = `Lendo a imagem… ${Math.round((info.progress || 0) * 100)}%`; } });
    if (runId !== state.ocrRunId || revision !== state.photoRevision || gameId !== $("photoGame").value || lane !== $("photoLane").value || !$('photoModal').open) return;
    const suggestions = buildSuggestions(result.data, source.width);
    updateReviewTable(suggestions);
    $("ocrStatus").textContent = suggestions.size ? `OCR encontrou ${suggestions.size} sugestão(ões). Revise antes de confirmar.` : "OCR não encontrou associações confiáveis. Preencha a tabela manualmente.";
    updatePhotoConfirmState();
  } catch (error) {
    if (runId !== state.ocrRunId || revision !== state.photoRevision) return;
    console.error(error); $("ocrStatus").textContent = "Não foi possível ler a foto. Preencha os pontos manualmente."; updatePhotoConfirmState();
  } finally { if (runId === state.ocrRunId) $("runOcrButton").disabled = !state.image; }
}

function getOcrCanvas() {
  const source = document.createElement("canvas");
  drawOrientedPhoto(source, 1800);
  const crop = state.crop && state.crop.width > 12 ? state.crop : { x: 0, y: 0, width: $("photoCanvas").width, height: $("photoCanvas").height };
  if (crop.x === 0 && crop.y === 0 && crop.width === $("photoCanvas").width && crop.height === $("photoCanvas").height) return source;
  const scaleX = source.width / $("photoCanvas").width;
  const scaleY = source.height / $("photoCanvas").height;
  const clipped = document.createElement("canvas");
  clipped.width = Math.max(1, Math.round(crop.width * scaleX));
  clipped.height = Math.max(1, Math.round(crop.height * scaleY));
  clipped.getContext("2d").drawImage(source, crop.x * scaleX, crop.y * scaleY, crop.width * scaleX, crop.height * scaleY, 0, 0, clipped.width, clipped.height);
  return clipped;
}

function buildSuggestions(ocr, imageWidth = 0) {
  const suggestions = new Map();
  const players = playersOnLane();
  const structuredLines = typeof ocr === "object" && ocr?.blocks?.flatMap((block) => block.paragraphs?.flatMap((paragraph) => paragraph.lines || []) || []) || [];
  const lines = structuredLines.length ? structuredLines : String(typeof ocr === "string" ? ocr : ocr?.text || "").split(/\r?\n/).map((text) => ({ text }));
  const candidates = [];
  lines.forEach((line) => {
    const normalizedLine = normalize(line.text || "");
    const matches = players.filter((player) => [player.nome, player.apelido_placar]
      .filter(Boolean).some((alias) => normalizedLine.includes(normalize(alias))));
    if (matches.length !== 1) return;
    const words = (line.words || []).filter((word) => word.bbox && /^\d{1,3}$/.test(word.text?.trim() || "") && Number(word.text) <= 300).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (!words.length) {
      const values = [...String(line.text || "").matchAll(/\b\d{1,3}\b/g)].map((match) => Number(match[0])).filter((value) => value <= 300);
      if (values.length === 1) candidates.push({ playerId: matches[0].id, value: values[0], reliable: true, x: null });
      return;
    }
    const last = words.at(-1);
    const previous = words.at(-2);
    const gap = previous ? last.bbox.x0 - previous.bbox.x1 : Infinity;
    const allEarlierValues = words.slice(0, -1).map((word) => Number(word.text));
    const afterLast = (line.words || []).some((word) => word.bbox?.x0 > last.bbox.x1 && /[\p{L}\d]/u.test(word.text || ""));
    const plausible = Number(last.text) >= Math.max(0, ...allEarlierValues)
      && !afterLast && last.confidence >= 40
      && (imageWidth ? last.bbox.x0 >= imageWidth * .68 && gap >= imageWidth * .035 : gap >= 25);
    if (plausible) candidates.push({ playerId: matches[0].id, value: Number(last.text), x: (last.bbox.x0 + last.bbox.x1) / 2, gap });
  });
  const positioned = candidates.filter((item) => item.x != null);
  const aligned = positioned.length >= 2 && positioned.every((item) => Math.abs(item.x - positioned[0].x) <= imageWidth * .07);
  const candidateCounts = new Map();
  candidates.forEach((item) => candidateCounts.set(item.playerId, (candidateCounts.get(item.playerId) || 0) + 1));
  candidates.forEach((item) => {
    if (candidateCounts.get(item.playerId) !== 1) return;
    if (item.x != null && !aligned && item.gap < imageWidth * .08) return;
    suggestions.set(item.playerId, { value: item.value, hint: "Total final sugerido · confira" });
  });
  return suggestions;
}

async function confirmPhotoUpdate(event) {
  event.preventDefault();
  if (!requireReadyMode()) return;
  const errorElement = $("photoError");
  errorElement.hidden = true;
  const fail = (message) => { errorElement.textContent = message; errorElement.hidden = false; showToast(message, "error"); };
  const gameId = $("photoGame").value;
  const lane = $("photoLane").value;
  if (!gameId || !lane) return fail("Selecione uma partida e uma pista com participantes.");
  const rows = [...document.querySelectorAll("[data-review-player]")];
  if (!rows.length) return fail("Nenhum jogador desta pista está vinculado à partida.");
  const all = rows.map((row) => ({
    player_id: row.dataset.reviewPlayer,
    pontos: row.querySelector(".review-score").value.trim(),
    finalizado: row.querySelector(".review-final").checked,
    previous: row.dataset.oldScore,
    previousFinal: row.dataset.oldFinal === "true",
  }));
  if (all.some((item) => item.pontos !== "" && (!/^\d+$/.test(item.pontos) || Number(item.pontos) > 300))) {
    return fail("Use pontos inteiros entre 0 e 300.");
  }
  const updates = all.filter((item) => item.pontos !== "" && (item.pontos !== item.previous || item.finalizado !== item.previousFinal));
  if (!updates.length) return fail("Preencha ou altere ao menos uma pontuação na tabela. A foto sozinha não publica resultados.");
  if (state.reviewConflict && !window.confirm("Os resultados desta pista mudaram em outro aparelho. Salvar sua conferência sobre os valores atuais?")) return;
  if (!client) return fail("Supabase não configurado.");
  const button = $("confirmPhotoButton");
  button.disabled = true;
  button.textContent = "Salvando…";
  try {
    const { data: authData, error: authError } = await client.auth.getSession();
    setSession(authData?.session || null);
    if (authError || !isAdmin()) return fail("Sua sessão de administrador expirou. Entre novamente com a senha para salvar os pontos.");
    const payload = updates.map((item) => ({ player_id: item.player_id, pontos: Number(item.pontos), finalizado: item.finalizado }));
    const { error } = await client.rpc("save_game_scores", { p_game_id: gameId, p_updates: payload });
    if (error) return fail(`Não foi possível salvar os pontos: ${error.message || "tente novamente"}.`);
    state.activeGameId = gameId;
    setModal("photoModal", false);
    try {
      await loadData(); render(); showToast("Pontos salvos. O ranking oficial muda quando a partida termina.", "success");
    } catch (refreshError) {
      console.error(refreshError);
      showToast("Pontos salvos, mas a tela não atualizou. Recarregue a página.", "error");
    }
  } catch (error) {
    console.error(error);
    fail(error.message || "Não foi possível salvar. Verifique a conexão e tente novamente.");
  } finally {
    button.disabled = false;
    button.textContent = "Confirmar atualização";
  }
}

function initTheme() {
  const stored = localStorage.getItem("boliche-theme"); const dark = stored === "dark";
  document.documentElement.classList.toggle("dark", dark); $("themeToggle").textContent = dark ? "Tema claro" : "Tema escuro";
  $("themeToggle").addEventListener("click", () => { const next = !document.documentElement.classList.contains("dark"); document.documentElement.classList.toggle("dark", next); localStorage.setItem("boliche-theme", next ? "dark" : "light"); $("themeToggle").textContent = next ? "Tema claro" : "Tema escuro"; });
}

function initTopbarMenu() {
  const topbar = document.querySelector(".topbar"); const trigger = $("brandMenuButton");
  const positionSubmenu = (item) => { const button = item.querySelector(".topbar-menu-trigger"); if (!button) return; const rect = button.getBoundingClientRect(); item.style.setProperty("--submenu-left", `${Math.max(4, Math.min(rect.left, window.innerWidth - 180))}px`); item.style.setProperty("--submenu-top", `${rect.bottom + 4}px`); };
  const positionOpenSubmenus = () => document.querySelectorAll(".topbar-menu-item.is-open").forEach(positionSubmenu);
  const closeSubmenus = () => document.querySelectorAll(".topbar-menu-item.is-open").forEach((item) => { item.classList.remove("is-open"); item.querySelector(".topbar-menu-trigger")?.setAttribute("aria-expanded", "false"); });
  const closeMenus = () => { closeSubmenus(); closeMobileMoreMenu(); $("scoreUpdateMenu")?.setAttribute("hidden", ""); $("updateScoreButton")?.setAttribute("aria-expanded", "false"); };
  trigger.addEventListener("click", () => setActiveArea("placar"));
  document.querySelectorAll(".topbar-menu-trigger").forEach((button) => { button.addEventListener("click", (event) => { event.stopPropagation(); const item = button.closest(".topbar-menu-item"); const open = !item.classList.contains("is-open"); closeSubmenus(); item.classList.toggle("is-open", open); button.setAttribute("aria-expanded", String(open)); if (open) positionSubmenu(item); }); button.addEventListener("focus", () => positionSubmenu(button.closest(".topbar-menu-item"))); });
  document.querySelectorAll(".topbar-submenu button").forEach((button) => button.addEventListener("click", closeSubmenus));
  document.addEventListener("click", (event) => { if (!event.target.closest(".topbar") && !event.target.closest(".context-menu") && !event.target.closest("#mobileMoreMenu")) closeMenus(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeMenus(); } });
  window.addEventListener("resize", positionOpenSubmenus); topbar.addEventListener("scroll", positionOpenSubmenus);
}

function bindEvents() {
  initTheme();
  initTopbarMenu();
  $("encounterSelect").addEventListener("change", (event) => selectEncounter(event.target.value));
  $("gameSwitchButton").addEventListener("click", () => { renderGameSwitcher(); setModal("gameSwitchModal", true); });
  $("gameSwitchList").addEventListener("click", (event) => {
    const encounterButton = event.target.closest("[data-select-encounter]");
    if (encounterButton) {
      setModal("gameSwitchModal", false);
      state.activeArea = "placar";
      selectEncounter(encounterButton.dataset.selectEncounter);
      return;
    }
    const createButton = event.target.closest("[data-create-game-type]");
    if (createButton && isAdmin() && selectableGameTypes().includes(createButton.dataset.createGameType)) {
      setModal("gameSwitchModal", false);
      openEncounterModal(false, createButton.dataset.createGameType);
    }
  });
  $("encounterGameType")?.addEventListener("change", renderEncounterRules);
  $("encounterRoundCount")?.addEventListener("input", renderEncounterRules);
  $("encounterRoundMax")?.addEventListener("input", renderEncounterRules);
  $("newEncounterButton").addEventListener("click", () => openEncounterModal(false));
  $("editEncounterButton").addEventListener("click", () => openEncounterModal(true));
  $("closeEncounterButton").addEventListener("click", toggleEncounterClosed);
  $("deleteEncounterButton").addEventListener("click", deleteEncounter);
  $("encounterForm").addEventListener("submit", saveEncounter);
  $("startEncounterButton").addEventListener("click", startEncounter);
  $("exportCsvButton").addEventListener("click", () => downloadResults("csv"));
  $("exportJsonButton").addEventListener("click", () => downloadResults("json"));
  $("drawLanesButton").addEventListener("click", drawLanes);
  $("manageTeamsButton").addEventListener("click", openTeamsModal);
  $("teamForm").addEventListener("submit", saveTeam);
  $("cancelTeamEdit").addEventListener("click", openTeamsModal);
  $("manageBracketButton").addEventListener("click", openBracketModal);
  $("bracketForm").addEventListener("submit", saveBracket);
  $("bracketPlayerSelection").addEventListener("change", updateBracketRoundLabels);
  $("savePredictionDeadline").addEventListener("click", savePredictionDeadline);
  $("deleteBracketButton").addEventListener("click", deleteBracket);
  $("shuffleBracketButton").addEventListener("click", () => {
    const grid = $("bracketPlayerSelection");
    const selected = [...grid.querySelectorAll("input:checked")].map((input) => input.closest("label"));
    for (let i = selected.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [selected[i], selected[j]] = [selected[j], selected[i]]; }
    selected.forEach((label) => grid.append(label));
  });
  $("savePredictionButton").addEventListener("click", savePrediction);
  const toggleTvMode = () => { const tv = document.body.classList.toggle("tv-mode"); if (!tv) document.body.classList.remove("tv-provisional"); $("tvExitButton").hidden = !tv; $("tvRankingToggle").hidden = !tv; $("tvRankingToggle").textContent = "Classificação provisória"; document.querySelector(".page-title h1").textContent = tv ? activeEncounter()?.nome || "Jogatina dos Amigos" : "Placar"; };
  $("tvModeButton").addEventListener("click", toggleTvMode);
  $("tvExitButton").addEventListener("click", toggleTvMode);
  $("tvRankingToggle").addEventListener("click", () => { const provisional = document.body.classList.toggle("tv-provisional"); $("tvRankingToggle").textContent = provisional ? "Classificação oficial" : "Classificação provisória"; });
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  window.addEventListener("online", refreshAfterReconnect);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAfterReconnect(); });
  if (client) window.setInterval(refreshAfterReconnect, 240000);
  $("recoveryForm").addEventListener("submit", submitRecovery);
  $("recoverySignOut").addEventListener("click", signOut);
  $("recoveryModal").addEventListener("cancel", (event) => event.preventDefault());
  $("authButton").addEventListener("click", openAuth); $("registerButton").addEventListener("click", openRegister); $("profileButton").addEventListener("click", openProfileModal); $("photoButton").addEventListener("click", openPhotoModal); $("newGameButton").addEventListener("click", openGameModal);
  $("tabletButton").addEventListener("click", () => openTabletModal());
  $("roundGame")?.addEventListener("change", (event) => { captureRoundDraft(state.roundGameId, state.roundNo); state.roundGameId = event.target.value; reconcileRoundDrafts(state.roundScores); renderRoundModal(false); });
  $("roundNumber")?.addEventListener("change", (event) => { captureRoundDraft(state.roundGameId, state.roundNo); state.roundNo = Number(event.target.value) || null; reconcileRoundDrafts(state.roundScores); renderRoundResults(); });
  $("roundResults")?.addEventListener("input", markRoundEdited);
  $("roundResults")?.addEventListener("change", markRoundEdited);
  $("roundResults")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-clear-round]");
    if (button) clearRoundScore(button.dataset.clearRound);
  });
  $("roundSaveButton")?.form?.addEventListener("submit", saveRoundScores);
  $("tabletGame").addEventListener("change", (event) => { state.tabletGameId = event.target.value; state.tabletPlayerId = null; state.tabletSelectedPins = []; renderTablet(); });
  $("tabletPlayer").addEventListener("change", (event) => { state.tabletPlayerId = event.target.value; state.tabletSelectedPins = []; renderTablet(); });
  $("tabletPinRack").addEventListener("click", (event) => { const button = event.target.closest("[data-pin]"); if (button) toggleTabletPin(Number(button.dataset.pin)); });
  $("tabletKeypad").addEventListener("click", (event) => { const button = event.target.closest("[data-pins-value]"); if (button) selectTabletPins(button.dataset.pinsValue); });
  $("tabletStrikeButton").addEventListener("click", () => tabletSetPins(10));
  $("tabletSpareButton").addEventListener("click", () => tabletSetPins(tabletStandingPins()));
  $("tabletRegisterButton").addEventListener("click", saveTabletThrow);
  $("tabletUndoButton").addEventListener("click", undoTabletThrow);
  $("gameForm").addEventListener("submit", createGame); $("authForm").addEventListener("submit", submitAuth); $("registerForm").addEventListener("submit", submitRegister); $("profileForm").addEventListener("submit", submitProfile); $("profilePhoto").addEventListener("change", profilePhotoSelected); $("profileCamera").addEventListener("change", profilePhotoSelected); $("playersForm").addEventListener("click", (event) => { if (event.target.id === "addPlayerButton") addPlayer(); }); $("cancelPlayerEditButton").addEventListener("click", cancelPlayerEdit);
  $("currentGameSelect").addEventListener("click", () => setActiveArea("historico"));
  $("saveLaneButton").addEventListener("click", saveLane);
  $("cancelLaneEditButton").addEventListener("click", cancelLaneEdit);
  $("approvalsButton").addEventListener("click", openApprovalsModal);
  $("historyButton").addEventListener("click", openHistoryModal);
  $("shareButton").addEventListener("click", openShareModal);
  $("copyShareButton").addEventListener("click", copyShareLink);
  $("nativeShareButton").addEventListener("click", shareScoreboard);
  $("shareResultButton").addEventListener("click", shareResultCard);
  $("rankingLane").addEventListener("change", renderLeaderboard);
  $("rankingMetric").addEventListener("change", renderLeaderboard);
  $("rankingMode")?.addEventListener("change", renderLeaderboard);
  $("gameHistoryFilter").addEventListener("change", renderGames);
  $("gameHistorySearch").addEventListener("input", renderGames);
  $("photoForm").addEventListener("submit", confirmPhotoUpdate); $("photoInput").addEventListener("change", loadPhoto); $("photoLane").addEventListener("change", changeReviewContext); $("photoGame").addEventListener("change", changeReviewContext); $("reviewTable").addEventListener("input", markReviewEdited); $("reviewTable").addEventListener("change", markReviewEdited); $("runOcrButton").addEventListener("click", runOcr); $("clearCropButton").addEventListener("click", () => { state.crop = null; drawCanvas(); });
  $("rotatePhotoButton").addEventListener("click", () => { state.photoRotation = (state.photoRotation + 90) % 360; state.crop = null; updatePhotoPreview(); });
  $("photoPanButton").addEventListener("click", () => { state.photoPanMode = !state.photoPanMode; applyPhotoInteractionMode(); });
  $("photoZoom").addEventListener("input", (event) => { state.photoZoom = Number(event.target.value); $("photoCanvas").style.width = `${state.photoZoom}%`; state.photoPanMode = state.photoZoom > 100; applyPhotoInteractionMode(); });
  $("photoContrast").addEventListener("input", (event) => { state.photoContrast = Number(event.target.value); updatePhotoPreview(); });
  const canvas = $("photoCanvas"); canvas.addEventListener("pointerdown", startCrop); canvas.addEventListener("pointermove", moveCrop); canvas.addEventListener("pointerup", endCrop); canvas.addEventListener("pointercancel", endCrop);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || state.recovering) return;
    const dialogs = [...document.querySelectorAll("dialog[open]")];
    const advancedDialog = dialogs.find((dialog) => ["advancedScoreModal", "advancedStatusModal"].includes(dialog.id));
    if (advancedDialog) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      advancedModeController?.close?.();
      return;
    }
    dialogs.forEach((dialog) => dialog.close());
  });
  $("playersButton").addEventListener("click", openPlayersModal);
  document.querySelectorAll("[data-area-target]").forEach((button) => button.addEventListener("click", () => setActiveArea(button.dataset.areaTarget)));
  document.querySelectorAll("[data-competition-tab]").forEach((button) => button.addEventListener("click", () => { state.activeCompetition = button.dataset.competitionTab; renderCompetitionArea(); }));
  $("mobileMoreButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("mobileMoreMenu");
    const open = menu.hidden;
    menu.hidden = !open;
    $("mobileMoreButton").setAttribute("aria-expanded", String(open));
  });
  document.querySelectorAll("[data-mobile-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.mobileAction;
    if (action === "share") $("shareButton")?.click();
    if (action === "theme") $("themeToggle")?.click();
    if (action === "auth") $("accountMenuButton")?.click();
    closeMobileMoreMenu();
  }));
  $("updateScoreButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isRoundBased()) return openRoundModal();
    const menu = $("scoreUpdateMenu");
    const open = menu.hidden;
    menu.hidden = !open;
    $("updateScoreButton").setAttribute("aria-expanded", String(open));
  });
  document.querySelectorAll("[data-score-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.scoreAction;
    if (isRoundBased()) openRoundModal(); else if (action === "tablet") openTabletModal(); else openPhotoModal();
    $("scoreUpdateMenu").hidden = true;
    $("updateScoreButton").setAttribute("aria-expanded", "false");
  }));
  const adminActions = { newEncounter: "newEncounterButton", editEncounter: "editEncounterButton", startEncounter: "startEncounterButton", closeEncounter: "closeEncounterButton", deleteEncounter: "deleteEncounterButton", newGame: "newGameButton", players: "playersButton", approvals: "approvalsButton", photo: "photoButton", tablet: "tabletButton", history: "historyButton", exportCsv: "exportCsvButton", exportJson: "exportJsonButton" };
  document.querySelectorAll("[data-admin-action]").forEach((button) => button.addEventListener("click", () => $(adminActions[button.dataset.adminAction])?.click()));
  document.querySelectorAll(".modal-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
}

async function start() {
  bindEvents();
  initializeAdvancedModeUI();
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("PWA indisponível", error));
  if (client) {
    client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") state.recovering = true;
      if (event === "SIGNED_OUT") {
        const interrupted = $("profileModal").open || $("photoModal").open || $("roundModal")?.open;
        state.recovering = false;
        sessionStorage.removeItem("boliche-recovery-user");
        state.profile = null;
        state.profiles = [];
        state.playerPhotos = new Map();
        state.scoreChanges = [];
        state.roundScoreChanges = [];
        state.throwChanges = [];
        state.auditHistoryOffsets = { scoreChanges: 100, roundScoreChanges: 100, throwChanges: 100 };
        state.auditHistoryHasMore = { scoreChanges: false, roundScoreChanges: false, throwChanges: false };
        state.roundDraft.clear(); state.roundConflict = false;
        ["approvalsModal", "historyModal", "playersModal", "gameModal", "photoModal", "profileModal", "tabletModal", "teamsModal", "bracketModal", "roundModal"].forEach((id) => setModal(id, false));
        if (interrupted) showToast("Sua sessão terminou. Entre novamente para salvar.", "error");
      }
      setSession(session);
      applyAuthUi();
      window.setTimeout(async () => {
        await loadProfile();
        if (event === "TOKEN_REFRESHED") {
          try { await loadData(); } catch (error) { console.error(error); }
        }
        render(); showProfileIfNeeded();
      }, 0);
    });
    const { data } = await client.auth.getSession(); setSession(data.session);
    if (data.session?.user?.id === sessionStorage.getItem("boliche-recovery-user")) state.recovering = true;
    await loadProfile();
  }
  await probeAdvancedSchema();
  try { await loadData(); render(); showProfileIfNeeded(); subscribeRealtime(); } catch (error) { console.error(error); setConnection("Falha ao carregar", "error"); showToast("Não foi possível carregar o placar. Verifique o Supabase.", "error"); }
}

start();
