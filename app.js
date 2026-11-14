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
  session: null,
  recovering: /(?:^#|&)type=recovery(?:&|$)/.test(window.location.hash) || new URLSearchParams(window.location.search).get("type") === "recovery",
  activeGameId: null,
  activeEncounterId: null,
  editingEncounterId: null,
  encounterRequestId: null,
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
const BUILTIN_MODES = {
  boliche: { id: "boliche", name: "Boliche", unit: "pontos", roundBased: false, locationLabel: "Pista" },
  bowling: { id: "bowling", name: "Boliche", unit: "pontos", roundBased: false, locationLabel: "Pista" },
  quiz: { id: "quiz", name: "Quiz", unit: "pontos", roundBased: true, locationLabel: "Estação" },
  gincana: { id: "gincana", name: "Gincana", unit: "pontos", roundBased: true, locationLabel: "Estação" },
};
function getGameMode(encounter = activeEncounter()) {
  const id = typeof encounter === "string" ? encounter : encounter?.game_type || "boliche";
  const fallback = BUILTIN_MODES[id] || { id, name: id || "Boliche", unit: "pontos", roundBased: false, locationLabel: "Local" };
  const configured = window.GameRules?.getMode?.(id);
  if (!configured) return fallback;
  return {
    ...fallback,
    ...configured,
    id: configured.id || id,
    name: configured.name || configured.label || configured.title || fallback.name,
    unit: configured.unit || configured.scoreUnit || fallback.unit,
    roundBased: configured.roundBased ?? configured.hasRounds ?? fallback.roundBased,
    locationLabel: configured.locationLabel || configured.placeLabel || fallback.locationLabel,
  };
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
  let [playersResult, lanesResult, encountersResult, rosterResult, gamesResult, scoresResult, scoreDetailsResult, throwChangesResult, teamsResult, teamPlayersResult, bracketsResult, predictionsResult, standingsResult, profilesResult, changesResult, publicPhotosResult, roundScoresResult, roundScoreChangesResult] = await Promise.all([
    client.from("players").select("id,nome,apelido_placar,pista").order("nome"),
    client.from("lanes").select("name,capacity").order("name"),
    client.from("encounters").select("id,nome,data,status,closed_at,prediction_closes_at,created_at,game_type,rules_version,rules_config").order("data", { ascending: false }),
    client.from("encounter_players").select("encounter_id,player_id"),
    client.from("games").select("id,nome,status,encounter_id,created_at,updated_at").order("created_at", { ascending: false }),
    client.from("scores").select("id,game_id,player_id,pista,pontos,finalizado,updated_at"),
    client.from("score_details").select("score_id,game_id,player_id,throws,pin_masks,updated_at"),
    isAdmin() ? client.from("throw_changes").select("id,score_id,game_id,player_id,previous_throws,new_throws,reason,changed_at,actor_id").order("id", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
    client.from("teams").select("id,encounter_id,name,metric"),
    client.from("team_players").select("team_id,player_id"),
    client.from("brackets").select("encounter_id,seeds,round_games,tiebreak_rule"),
    isAuthenticated() ? client.from("predictions").select("encounter_id,user_id,predicted_player_id,created_at") : Promise.resolve({ data: [] }),
    client.rpc("prediction_standings"),
    isAdmin() ? client.rpc("list_registered_accounts") : Promise.resolve({ data: [] }),
    isAdmin() ? client.from("score_changes").select("id,score_id,game_id,player_id,previous_points,new_points,previous_finalized,new_finalized,changed_at,actor_id").order("id", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
    client.from("profiles").select("player_id,foto_path").eq("status", "approved").eq("photo_public_opt_in", true).not("player_id", "is", null),
    client.from("round_scores").select("game_id,player_id,round_no,points,finalized"),
    isAdmin() ? client.from("round_score_changes").select("*").order("id", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
  ]);
  const migrationMissing = (result) => result?.error && ["42P01", "PGRST205"].includes(result.error.code);
  const optionalMigrationError = (result) => migrationMissing(result) ? null : result?.error;
  if (encountersResult.error && ["42703", "PGRST204"].includes(encountersResult.error.code)) {
    const legacyEncounters = await client.from("encounters").select("id,nome,data,status,closed_at,prediction_closes_at,created_at").order("data", { ascending: false });
    if (!legacyEncounters.error) encountersResult = { ...legacyEncounters, data: (legacyEncounters.data || []).map((item) => ({ ...item, game_type: "boliche", rules_version: null, rules_config: {} })) };
  }
  const error = playersResult.error || lanesResult.error || encountersResult.error || rosterResult.error || gamesResult.error || scoresResult.error || optionalMigrationError(scoreDetailsResult) || optionalMigrationError(throwChangesResult) || teamsResult.error || teamPlayersResult.error || bracketsResult.error || predictionsResult.error || standingsResult.error || profilesResult.error || changesResult.error || publicPhotosResult.error || optionalMigrationError(roundScoresResult) || optionalMigrationError(roundScoreChangesResult);
  if (error) throw error;
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
  state.roundScoreChanges = isAdmin() && !migrationMissing(roundScoreChangesResult) ? (roundScoreChangesResult.data || []) : [];
  state.roundScoreChangesAvailable = !migrationMissing(roundScoreChangesResult);
  state.scoreDetails = migrationMissing(scoreDetailsResult) ? [] : (scoreDetailsResult.data || []);
  state.scoreDetailsAvailable = !migrationMissing(scoreDetailsResult);
  state.throwChanges = migrationMissing(throwChangesResult) ? [] : (throwChangesResult.data || []);
  if ($("photoModal")?.open && state.reviewConflict) updatePhotoConfirmState();
  state.teams = teamsResult.data || [];
  state.teamPlayers = teamPlayersResult.data || [];
  state.brackets = bracketsResult.data || [];
  state.predictions = predictionsResult.data || [];
  state.predictionStandings = standingsResult.data || [];
  state.profiles = isAdmin() ? (profilesResult.data || []) : [];
  state.scoreChanges = isAdmin() ? (changesResult.data || []) : [];
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
    state.session = null;
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
  const selected = state.activeEncounterId;
  $("encounterSelect").innerHTML = state.encounters.map((item) => `<option value="${esc(item.id)}">${esc(item.nome)} · ${esc(getGameMode(item).name)} · ${esc(new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${item.data}T12:00:00Z`)))}</option>`).join("");
  $("encounterSelect").value = selected || "";
  $("encounterStatus").textContent = !activeEncounter() ? "Sem encontro" : activeEncounter().status === "closed" ? "Encerrado" : activeEncounter().status === "preparing" ? "Preparação" : "Ativo";
  $("encounterStatus").className = `status-pill status-pill--${!activeEncounter() ? "muted" : encounterOpen() ? "warning" : "success"}`;
  $("editEncounterButton").disabled = !encounterOpen();
  $("startEncounterButton").hidden = !isAdmin() || activeEncounter()?.status !== "preparing";
  $("closeEncounterButton").disabled = !activeEncounter() || activeEncounter()?.status === "preparing";
  $("closeEncounterButton").textContent = encounterOpen() ? "Encerrar encontro" : "Reabrir encontro";
  $("deleteEncounterButton").disabled = !encounterOpen();
  $("manageTeamsButton").disabled = !encounterOpen();
  $("manageBracketButton").disabled = !encounterOpen();
  if (document.body.classList.contains("tv-mode")) document.querySelector(".page-title h1").textContent = activeEncounter()?.nome || "Jogatina dos Amigos";
  $("newGameButton").disabled = !encounterOpen();
  $("photoButton").disabled = !encounterActive();
  if ($("tabletButton")) $("tabletButton").disabled = !encounterActive();
  if ($("updateScoreButton")) $("updateScoreButton").disabled = !encounterActive() || !state.activeGameId;
  const bowling = ["boliche", "bowling"].includes(getGameMode().id);
  if ($("photoButton")) $("photoButton").hidden = !bowling;
  if ($("tabletButton")) $("tabletButton").hidden = !bowling;
  document.querySelectorAll('[data-score-action="photo"], [data-score-action="tablet"], [data-admin-action="photo"], [data-admin-action="tablet"]').forEach((button) => { button.hidden = !bowling; });
  if ($("updateScoreButton")) $("updateScoreButton").textContent = isRoundBased() ? "Atualizar rodadas" : "Atualizar placar";
  const updateMenu = $("scoreUpdateMenu");
  if (updateMenu && !bowling) updateMenu.hidden = true;
}

function selectEncounter(id) {
  if (!state.encounters.some((item) => item.id === id)) return;
  state.activeEncounterId = id;
  state.activeGameId = encounterGames().find((game) => game.status === "partial")?.id || encounterGames()[0]?.id || null;
  const url = new URL(window.location.href);
  url.searchParams.set("encontro", id);
  window.history.replaceState(null, "", url);
  render();
}

function openEncounterModal(editing = false) {
  const encounter = editing ? activeEncounter() : null;
  if (editing && !encounterOpen()) return showToast("Reabra o encontro para editá-lo.", "error");
  state.editingEncounterId = encounter?.id || null;
  state.encounterRequestId = editing ? null : crypto.randomUUID();
  $("encounterModalTitle").textContent = editing ? "Editar encontro" : "Novo encontro";
  $("encounterName").value = encounter?.nome || "";
  $("encounterDate").value = encounter?.data || localIsoDate();
  const gameType = $("encounterGameType");
  if (gameType) { gameType.value = encounter?.game_type || "boliche"; gameType.disabled = Boolean(editing); }
  const rules = encounterRules(encounter);
  const roundCount = $("encounterRoundCount");
  const roundMax = $("encounterRoundMax");
  if (roundCount) { roundCount.value = editing ? (rules.round_count ?? rules.rounds ?? "") : ""; roundCount.disabled = Boolean(editing); }
  if (roundMax) { const configuredMax = rules.max_points_per_round ?? rules.round_max; roundMax.value = editing && Number(configuredMax) > 0 ? configuredMax : ""; roundMax.disabled = Boolean(editing); }
  renderEncounterRules();
  const roster = new Set(state.encounterPlayers.filter((row) => row.encounter_id === encounter?.id).map((row) => row.player_id));
  $("encounterPlayerSelection").innerHTML = state.players.map((player) => `<label class="selection-item"><input type="checkbox" value="${esc(player.id)}" ${!editing || roster.has(player.id) ? "checked" : ""} /><span><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")}</small></span></label>`).join("");
  $("encounterFormError").hidden = true;
  setModal("encounterModal", true);
}

function renderEncounterRules() {
  const gameType = $("encounterGameType")?.value || "boliche";
  const mode = getGameMode(gameType);
  const settings = $("encounterRoundSettings");
  if (settings) settings.hidden = !mode.roundBased;
  const count = $("encounterRoundCount")?.value;
  const max = $("encounterRoundMax")?.value;
  const version = state.editingEncounterId ? activeEncounter()?.rules_version : null;
  const summary = mode.roundBased
    ? `${mode.name}: maior total vence, somando ${count || "—"} rodadas. ${max === "" || Number(max) === 0 ? "Sem limite de pontos por rodada." : `Máximo de ${max} ${mode.unit} por rodada.`}${version ? ` Regras v${version}.` : ""}`
    : `${mode.name}: maior pontuação vence. Unidade: ${mode.unit}.${version ? ` Regras v${version}.` : ""}`;
  if ($("encounterRulesSummary")) $("encounterRulesSummary").textContent = summary;
}

async function saveEncounter(event) {
  event.preventDefault();
  const name = $("encounterName").value.trim();
  const date = $("encounterDate").value;
  const ids = [...$("encounterPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  const errorElement = $("encounterFormError");
  if (!name || !date) { errorElement.textContent = "Informe o nome e a data."; errorElement.hidden = false; return; }
  const editing = state.editingEncounterId;
  const gameType = editing ? activeEncounter()?.game_type || "boliche" : $("encounterGameType")?.value || "boliche";
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
  const legacyBowling = ["boliche", "bowling"].includes(gameType);
  const rpcName = editing ? "save_encounter" : legacyBowling ? "create_encounter" : "create_multigame_encounter";
  const args = editing
    ? { p_encounter_id: editing, p_name: name, p_date: date, p_player_ids: ids }
    : legacyBowling
      ? { p_name: name, p_date: date, p_player_ids: ids, p_request_id: state.encounterRequestId }
      : { p_name: name, p_date: date, p_player_ids: ids, p_request_id: state.encounterRequestId, p_game_type: gameType, p_rules_config: rulesConfig };
  const { data, error } = await client.rpc(rpcName, args);
  if (error) { errorElement.textContent = error.message; errorElement.hidden = false; return; }
  setModal("encounterModal", false);
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
      state.session = data?.session || null;
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
    for (const update of updates) {
      const { error } = await client.rpc("save_round_score_if_current", {
        p_game_id: gameId, p_player_id: update.playerId, p_round_no: roundNo,
        p_points: update.points, p_finalized: update.finalized,
        p_expected_points: update.expectedPoints, p_expected_finalized: update.expectedFinalized,
      });
      if (error) {
        const message = `Falha após ${saved} resultado(s): ${error.message || "não foi possível salvar a rodada"}.`;
        if (saved || error.code === "40001") {
          try { await loadData(); render(); }
          catch (refreshError) { console.error(refreshError); }
        }
        return fail(message);
      }
      saved += 1;
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
  const gameId = $("roundGame")?.value || state.roundGameId;
  const roundNo = Number($("roundNumber")?.value || state.roundNo);
  const player = getPlayer(playerId);
  if (!gameId || !Number.isInteger(roundNo) || !state.roundScores.some((row) => row.game_id === gameId && Number(row.round_no) === roundNo && row.player_id === playerId)) return;
  if (!window.confirm(`Limpar a pontuação de ${player?.nome || "este jogador"} na rodada ${roundNo}? O banco recalculará o total do jogo.`)) return;
  const { error } = await client.rpc("clear_round_score", { p_game_id: gameId, p_player_id: playerId, p_round_no: roundNo });
  if (error) {
    if ($("roundError")) { $("roundError").textContent = error.message || "Não foi possível limpar esta rodada."; $("roundError").hidden = false; }
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
  const encounter = activeEncounter();
  if (!encounter || encounter.status !== "preparing") return;
  if (!window.confirm(`Iniciar ${encounter.nome}? Os palpites serão encerrados e as pontuações poderão ser registradas.`)) return;
  const { error } = await client.rpc("activate_encounter", { p_encounter_id: encounter.id });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast("Encontro iniciado.", "success");
}

function downloadResults(format) {
  if (!state.encounters.length) return showToast("Nenhum encontro para exportar.", "error");
  const data = buildResultsExport();
  let content;
  let mime;
  if (format === "json") { content = JSON.stringify(data, null, 2); mime = "application/json"; }
  else {
    const quote = (value) => {
      const raw = String(value ?? "");
      const safe = /^[\s]*[=+@\-\t\r]/.test(raw) && !/^-?\d+(?:[.,]\d+)?$/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = ["tipo", "encontro_id", "encontro", "data", "partida_id", "partida", "status_partida", "jogador_id", "jogador", "pista", "pontos", "confirmado", "posicao", "pontos_total", "media", "melhor", "partidas", "modalidade", "rules_version", "unidade", "rodada", "pontos_rodada"];
    const modeFields = (encounter) => {
      const mode = getGameMode(encounter);
      return [mode.name, encounter?.rules_version ?? "", mode.unit];
    };
    const rows = [
      ...data.encounters.map((encounter) => ["encontro", encounter.id, encounter.nome, encounter.data, "", "", "", "", "", "", "", "", "", "", "", "", "", ...modeFields(encounter)]),
      ...data.participations.map((row) => { const encounter = data.encounters.find((item) => item.id === row.encounter_id); const player = getPlayer(row.player_id); return ["participante", encounter?.id, encounter?.nome, encounter?.data, "", "", "", row.player_id, player?.nome, player?.pista, "", "", "", "", "", "", "", ...modeFields(encounter)]; }),
      ...data.games.map((game) => { const encounter = data.encounters.find((item) => item.id === game.encounter_id); return ["partida", encounter?.id, encounter?.nome, encounter?.data, game.id, game.nome, game.status, "", "", "", "", "", "", "", "", "", "", ...modeFields(encounter)]; }),
      ...data.scores.map((score) => { const game = getGame(score.game_id); const encounter = data.encounters.find((item) => item.id === game?.encounter_id); return ["pontuacao", encounter?.id, encounter?.nome, encounter?.data, game?.id, game?.nome, game?.status, score.player_id, getPlayer(score.player_id)?.nome, score.pista, score.pontos, score.finalizado, "", "", "", "", "", ...modeFields(encounter)]; }),
      ...data.round_scores.map((score) => { const game = getGame(score.game_id); const encounter = data.encounters.find((item) => item.id === game?.encounter_id); const participation = data.scores.find((item) => item.game_id === score.game_id && item.player_id === score.player_id); return ["rodada", encounter?.id, encounter?.nome, encounter?.data, game?.id, game?.nome, game?.status, score.player_id, getPlayer(score.player_id)?.nome, participation?.pista || "", "", score.finalized, "", "", "", "", "", ...modeFields(encounter), score.round_no, roundPoints(score)]; }),
      ...data.rankings.map((row) => { const encounter = data.encounters.find((item) => item.id === row.encounter_id); return ["ranking", encounter?.id, encounter?.nome, encounter?.data, "", "", "", row.player_id, getPlayer(row.player_id)?.nome, "", "", "", row.position, row.total, row.average?.toFixed(2).replace(".", ","), row.best, row.games_played, ...modeFields(encounter)]; }),
    ];
    content = `\uFEFF${[header, ...rows].map((row) => row.map(quote).join(";")).join("\r\n")}`; mime = "text/csv;charset=utf-8";
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url; link.download = `jogatina-resultados-${localIsoDate()}.${format}`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildResultsExport() {
  const rankings = state.encounters.flatMap((encounter) => {
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
  return { schema_version: 2, exported_at: new Date().toISOString(), encounters: state.encounters.map((encounter) => ({ ...encounter, game_type: encounter.game_type || "boliche", mode_name: getGameMode(encounter).name, unit: getGameMode(encounter).unit })), players: state.players, participations: state.encounterPlayers, games: state.games, scores: state.scores, round_scores: state.roundScores, rankings };
}

async function deleteEncounter() {
  const encounter = activeEncounter();
  if (!encounter || !encounterOpen()) return showToast("Reabra o encontro antes de excluí-lo.", "error");
  if (!window.confirm(`Excluir permanentemente ${encounter.nome}, suas partidas, pontuações, equipes, palpites e torneio?`)) return;
  const { error } = await client.rpc("delete_encounter", { p_encounter_id: encounter.id });
  if (error) return showToast(error.message, "error");
  state.activeEncounterId = null;
  await loadData(); render(); showToast("Encontro excluído.", "success");
}

function renderTeams() {
  const teams = state.teams.filter((team) => team.encounter_id === state.activeEncounterId);
  const finalGameIds = new Set(encounterGames().filter((game) => game.status === "final").map((game) => game.id));
  const totals = new Map(encounterPlayers().map((player) => [player.id, state.scores.filter((score) => score.player_id === player.id && finalGameIds.has(score.game_id) && score.finalizado && score.pontos != null).reduce((sum, score) => sum + Number(score.pontos), 0)]));
  const ranked = teams.map((team) => {
    const members = state.teamPlayers.filter((row) => row.team_id === team.id).map((row) => getPlayer(row.player_id)).filter(Boolean);
    const sum = members.reduce((value, player) => value + (totals.get(player.id) || 0), 0);
    return { team, members, value: team.metric === "average" ? sum / (members.length || 1) : sum };
  }).sort((a, b) => b.value - a.value || a.team.name.localeCompare(b.team.name, "pt-BR"));
  let position = 0;
  $("teamsList").innerHTML = ranked.length ? ranked.map(({ team, members, value }, index) => {
    if (!index || value !== ranked[index - 1].value) position = index + 1;
    return `<div class="extra-row"><strong>${position}º ${esc(team.name)}</strong><span>${value.toFixed(team.metric === "average" ? 1 : 0).replace(".", ",")} ${team.metric === "average" ? "de média" : "pontos"}</span><small>${esc(members.map((player) => player.nome).join(", "))}</small></div>`;
  }).join("") : `<p class="empty-inline">Nenhuma equipe neste encontro.</p>`;
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
  if (!encounterOpen()) return showToast("Reabra o encontro para editar equipes.", "error");
  state.editingTeamId = null;
  $("teamForm").reset();
  $("cancelTeamEdit").hidden = true;
  $("teamPlayerSelection").innerHTML = encounterPlayers().map((player) => `<label class="selection-item"><input type="checkbox" value="${esc(player.id)}" /><span>${esc(player.nome)}</span></label>`).join("");
  renderTeamEditor(); setModal("teamsModal", true);
}

function editTeam(id) {
  const team = state.teams.find((item) => item.id === id);
  if (!team) return;
  state.editingTeamId = id;
  $("teamName").value = team.name;
  $("teamMetric").value = team.metric;
  const members = new Set(state.teamPlayers.filter((row) => row.team_id === id).map((row) => row.player_id));
  $("teamPlayerSelection").querySelectorAll("input").forEach((input) => { input.checked = members.has(input.value); });
  $("cancelTeamEdit").hidden = false;
}

async function saveTeam(event) {
  event.preventDefault();
  const playerIds = [...$("teamPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  if (!playerIds.length) { $("teamError").textContent = "Escolha pelo menos um jogador."; $("teamError").hidden = false; return; }
  const { error } = await client.rpc("save_team", { p_team_id: state.editingTeamId, p_encounter_id: state.activeEncounterId, p_name: $("teamName").value.trim(), p_metric: $("teamMetric").value, p_player_ids: playerIds });
  if (error) { $("teamError").textContent = error.message; $("teamError").hidden = false; return; }
  await loadData(); render(); openTeamsModal(); showToast("Equipe salva.", "success");
}

async function deleteTeam(id) {
  const team = state.teams.find((item) => item.id === id);
  if (!team || !window.confirm(`Excluir a equipe ${team.name}?`)) return;
  const { error } = await client.from("teams").delete().eq("id", id);
  if (error) return showToast(error.message, "error");
  await loadData(); render(); renderTeamEditor(); showToast("Equipe excluída.", "success");
}

function openBracketModal() {
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
  const seeds = [...$("bracketPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  if (![4, 8].includes(seeds.length)) { $("bracketError").textContent = "Escolha quatro ou oito jogadores."; $("bracketError").hidden = false; return; }
  const games = Array.from({ length: seeds.length === 4 ? 2 : 3 }, (_, round) => $(`bracketGame${round}`).value || null);
  if (new Set(games.filter(Boolean)).size !== games.filter(Boolean).length) { $("bracketError").textContent = "Escolha partidas diferentes para cada rodada."; $("bracketError").hidden = false; return; }
  const { error } = await client.rpc("save_bracket", { p_encounter_id: state.activeEncounterId, p_seeds: seeds, p_round_games: games, p_tiebreak_rule: $("bracketTieRule").value });
  if (error) { $("bracketError").textContent = error.message; $("bracketError").hidden = false; return; }
  setModal("bracketModal", false); await loadData(); render(); showToast("Chave salva.", "success");
}

async function deleteBracket() {
  if (!window.confirm("Excluir a chave eliminatória deste encontro?")) return;
  const { error } = await client.from("brackets").delete().eq("encounter_id", state.activeEncounterId);
  if (error) return showToast(error.message, "error");
  setModal("bracketModal", false); await loadData(); render(); showToast("Chave excluída.", "success");
}

async function savePrediction() {
  const playerId = $("predictionPlayer").value;
  if (!playerId) return showToast("Escolha quem você acha que vai vencer.", "error");
  const { error } = await client.from("predictions").upsert({ encounter_id: state.activeEncounterId, user_id: state.session.user.id, predicted_player_id: playerId }, { onConflict: "encounter_id,user_id" });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast("Palpite salvo.", "success");
}

async function savePredictionDeadline() {
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

function renderLeaderboard() {
  const body = $("leaderboardBody");
  const finalGames = encounterGames().filter((game) => game.status === "final");
  const laneSelect = $("rankingLane");
  const selectedLane = laneSelect?.value || "";
  const gameMode = getGameMode();
  const gameIds = new Set(encounterGames().map((game) => game.id));
  const lanes = [...new Set(state.scores.filter((score) => gameIds.has(score.game_id)).map(scoreLane).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  if (laneSelect) {
    laneSelect.innerHTML = `<option value="">Todos os locais</option>${lanes.map((lane) => `<option value="${esc(lane)}">${esc(gameMode.locationLabel)} ${esc(lane)}</option>`).join("")}`;
    if (lanes.includes(selectedLane)) laneSelect.value = selectedLane;
  }
  const mode = $("rankingMode")?.value || "official";
  const metric = $("rankingMetric")?.value || "total";
  const podium = $("podium");
  const currentGame = getGame(state.activeGameId);
  let currentItems = currentGame ? gameScores(currentGame.id).map((score) => ({ score, player: getPlayer(score.player_id) })).filter((item) => item.player && (!selectedLane || scoreLane(item.score) === selectedLane)) : [];
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
    return `<tr><td class="rank-cell">${position}</td><td><div class="ranking-player">${photoUrl ? `<img class="ranking-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" loading="lazy" />` : ""}<span><button class="player-stats-link" type="button" data-stats-player="${esc(player.id)}">${esc(player.nome)}</button><small>${esc(player.apelido_placar || "sem apelido")}</small></span></div></td><td>${esc(lane || "—")}</td><td>${isCurrent ? "—" : item.gamesPlayed}</td><td class="points-cell">${points}</td><td><span class="${chipClass}">${situation}</span></td></tr>`;
  }).join("");
  body.querySelectorAll("[data-stats-player]").forEach((button) => button.addEventListener("click", () => openStatsModal(button.dataset.statsPlayer)));
  $("leaderboardEmpty").hidden = items.length > 0;
  $("leaderboardMeta").textContent = `${isCurrent ? (currentGame ? `${currentItems.filter((item) => item.score.pontos != null).length}/${currentItems.length} totais informados pelo banco` : "Nenhuma partida aberta") : finalGames.length ? `${finalGames.length} ${finalGames.length === 1 ? "partida finalizada" : "partidas finalizadas"}` : "Nenhuma partida finalizada"} · ${gameMode.name} · unidade: ${gameMode.unit}`;
}

function renderCurrentGame() {
  const game = getGame(state.activeGameId);
  const gameMode = getGameMode();
  const body = $("currentGameBody");
  if (!game) {
    $("currentGameTitle").textContent = "Nenhuma partida aberta";
    $("currentGameStatus").textContent = "Aguardando";
    $("currentGameStatus").className = "status-pill status-pill--muted";
    body.innerHTML = `<div class="empty-state"><span class="empty-icon">⌁</span><strong>Abra uma partida para começar</strong><span>Os participantes e as pistas ficam vinculados a ela.</span></div>`;
    $("laneProgress").innerHTML = "";
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
    const location = `${gameMode.locationLabel} ${scoreLane(score) || "—"}`;
    return `<div class="current-row"><div class="current-player${photoUrl ? " current-player--with-photo" : ""}"><span class="provisional-rank">${position}</span>${photoUrl ? `<img class="ranking-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" loading="lazy" />` : ""}<button class="player-stats-link current-stats-link" type="button" data-stats-player="${esc(player.id)}">${esc(player.nome)}</button><span>${isRoundBased() ? esc(location) : `Pista ${esc(scoreLane(score) || "—")}`}</span></div><div class="current-score"><strong>${score.pontos == null ? "—" : Number(score.pontos).toLocaleString("pt-BR")}${isRoundBased() && score.pontos != null ? ` ${esc(gameMode.unit)}` : ""}</strong><span class="status-chip ${score.finalizado ? "status-chip--final" : "status-chip--partial"}">${score.finalizado ? "Final" : "Pendente"}</span>${scoreActions}</div></div>`;
  }).join("") : `<div class="empty-state"><span>Partida sem participantes.</span></div>`;
  body.querySelectorAll("[data-stats-player]").forEach((button) => button.addEventListener("click", () => openStatsModal(button.dataset.statsPlayer)));
  body.querySelectorAll("[data-quick-score]").forEach((button) => button.addEventListener("click", () => openQuickScore(button.dataset.quickScore)));
  body.querySelectorAll("[data-clear-score]").forEach((button) => button.addEventListener("click", () => clearScore(button.dataset.clearScore)));
  $("laneProgress").innerHTML = [...new Set(scores.map(({ score }) => scoreLane(score)))].map((lane) => {
    const laneScores = scores.filter(({ score }) => scoreLane(score) === lane);
    const informed = laneScores.filter(({ score }) => score.pontos != null).length;
    const confirmed = laneScores.filter(({ score }) => score.finalizado && score.pontos != null).length;
    const pending = laneScores.length - confirmed;
    const percent = Math.round(100 * confirmed / laneScores.length);
    return `<div class="lane-progress-card"><strong>${esc(gameMode.locationLabel)} ${esc(lane || "—")} · ${confirmed}/${laneScores.length} confirmados</strong><small>${laneScores.length} participantes · ${informed} informados · ${pending} pendentes · ${percent}% concluído</small><progress max="100" value="${percent}" aria-label="Conclusão de ${esc(gameMode.locationLabel)} ${esc(lane || "—")}"></progress></div>`;
  }).join("");
}

async function clearScore(playerId) {
  const player = getPlayer(playerId);
  if (!window.confirm(`Limpar os pontos de ${player?.nome || "este jogador"} nesta partida? O ranking será recalculado.`)) return;
  const { error } = await client.rpc("clear_game_score", { p_game_id: state.activeGameId, p_player_id: playerId });
  if (error) return showToast("Não foi possível limpar os pontos.", "error");
  await loadData(); render(); showToast("Pontuação limpa; a partida voltou a parcial.", "success");
}

function openQuickScore(playerId) {
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
  const player = getPlayer(playerId);
  if (!player) return;
  const mode = getGameMode();
  const finalGames = encounterGames().filter((game) => game.status === "final").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const results = finalGames.map((game) => ({ game, score: state.scores.find((score) => score.game_id === game.id && score.player_id === playerId) })).filter((item) => item.score?.finalizado && item.score.pontos != null);
  const points = results.map((item) => Number(item.score.pontos));
  const wins = results.filter(({ game, score }) => Number(score.pontos) === Math.max(...gameScores(game.id).filter((item) => item.pontos != null).map((item) => Number(item.pontos)))).length;
  const totals = officialTotals();
  const playerIndex = totals.findIndex((item) => item.player.id === playerId);
  const position = playerIndex < 0 ? 0 : officialPosition(totals, playerIndex);
  const photoUrl = state.playerPhotos.get(playerId);
  $("statsTitle").textContent = player.nome;
  $("statsHero").innerHTML = `${photoUrl ? `<img src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" />` : `<span class="stats-avatar-empty" aria-hidden="true">${esc(player.nome.slice(0, 1))}</span>`}<div><strong>${position ? `${position}º no ranking` : "Ainda sem posição oficial"}</strong><span>${points.length} ${points.length === 1 ? "partida concluída" : "partidas concluídas"} neste encontro · ${esc(mode.name)} · ${esc(mode.unit)}</span></div>`;
  $("statsSummary").innerHTML = `<div><strong>${points.length ? Math.max(...points) : "—"}</strong><span>recorde (${esc(mode.unit)})</span></div><div><strong>${points.length ? (points.reduce((sum, value) => sum + value, 0) / points.length).toFixed(1).replace(".", ",") : "—"}</strong><span>média (${esc(mode.unit)})</span></div><div><strong>${wins}</strong><span>vitórias</span></div>`;
  const coords = points.map((value, index) => `${points.length === 1 ? 240 : 20 + index * 440 / (points.length - 1)},${115 - value * .3}`);
  $("statsEvolution").innerHTML = points.length ? `<strong>Evolução por partida</strong><svg viewBox="0 0 480 140" role="img" aria-label="Pontuações: ${points.join(", ")}"><line x1="20" y1="115" x2="460" y2="115" stroke="currentColor" opacity=".25" /><polyline points="${coords.join(" ")}" fill="none" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${coords.map((point) => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="5" fill="var(--color-accent)" />`).join("")}</svg>` : "";
  $("statsGames").innerHTML = results.length ? results.map(({ game, score }) => `<div class="history-row"><div><strong>${esc(game.nome)}</strong><small>${fmtDate(game.created_at)} · ${esc(mode.name)}</small></div><span>${score.pontos} ${esc(mode.unit)}</span></div>`).join("") : `<p class="empty-inline">Nenhuma partida finalizada para este jogador.</p>`;
  setModal("statsModal", true);
}

function renderGames() {
  const allGames = encounterGames();
  const gameMode = getGameMode();
  const filter = $("gameHistoryFilter")?.value || "all";
  const search = normalize($("gameHistorySearch")?.value || "");
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
  document.querySelectorAll("[data-game-id]").forEach((button) => button.addEventListener("click", () => { state.activeGameId = button.dataset.gameId; render(); }));
  document.querySelectorAll("[data-edit-game]").forEach((button) => button.addEventListener("click", () => editGame(button.dataset.editGame)));
  document.querySelectorAll("[data-delete-game]").forEach((button) => button.addEventListener("click", () => removeGame(button.dataset.deleteGame)));
}

function openTabletModal(gameId = state.activeGameId, playerId = null) {
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
  $("tabletPlayerMeta").textContent = player ? `Pista ${gameLaneForPlayer(state.tabletGameId, player.id) || "—"} · ${score?.finalizado ? "confirmado" : "em lançamento"}` : "Escolha um jogador";
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
  container.innerHTML = players.map((player) => `<label class="selection-item"><input class="game-player-check" type="checkbox" value="${esc(player.id)}" checked /><span><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")}</small></span><select class="game-player-lane" data-player-lane="${esc(player.id)}" aria-label="Pista de ${esc(player.nome)}">${state.lanes.map((lane) => `<option value="${esc(lane.name)}" ${lane.name === player.pista ? "selected" : ""}>Pista ${esc(lane.name)}</option>`).join("")}</select></label>`).join("");
  $("playerSelectionEmpty").hidden = players.length > 0;
}

function renderPlayers() {
  $("playersList").innerHTML = state.players.length ? state.players.map((player) => `<div class="player-row"><div><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")} · Pista ${esc(player.pista || "—")}</small></div><div class="player-row-actions"><button class="text-button" type="button" data-edit-player="${esc(player.id)}">Editar</button><button class="text-button text-button--danger" type="button" data-delete-player="${esc(player.id)}">Remover</button></div></div>`).join("") : `<p class="empty-inline">Nenhum participante cadastrado.</p>`;
  document.querySelectorAll("[data-edit-player]").forEach((button) => button.addEventListener("click", () => editPlayer(button.dataset.editPlayer)));
  document.querySelectorAll("[data-delete-player]").forEach((button) => button.addEventListener("click", () => removePlayer(button.dataset.deletePlayer)));
  renderLanes();
}

function renderLanes() {
  const laneSelect = $("playerLane");
  const selected = laneSelect.value;
  laneSelect.innerHTML = `<option value="">Selecione a pista</option>${state.lanes.map((lane) => `<option value="${esc(lane.name)}">${esc(lane.name)}</option>`).join("")}`;
  if (state.lanes.some((lane) => lane.name === selected)) laneSelect.value = selected;
  $("lanesList").innerHTML = state.lanes.length ? state.lanes.map((lane) => `<div class="lane-row"><strong>Pista ${esc(lane.name)} · até ${lane.capacity} jogadores</strong><div class="player-row-actions"><button class="text-button" type="button" data-edit-lane="${esc(lane.name)}">Editar</button><button class="text-button text-button--danger" type="button" data-delete-lane="${esc(lane.name)}">Excluir</button></div></div>`).join("") : `<p class="empty-inline">Nenhuma pista cadastrada.</p>`;
  $("lanesList").querySelectorAll("[data-edit-lane]").forEach((button) => button.addEventListener("click", () => editLane(button.dataset.editLane)));
  $("lanesList").querySelectorAll("[data-delete-lane]").forEach((button) => button.addEventListener("click", () => removeLane(button.dataset.deleteLane)));
}

function editLane(name) {
  state.editingLaneName = name;
  $("laneName").value = name;
  $("laneCapacity").value = state.lanes.find((lane) => lane.name === name)?.capacity || 4;
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
  $("playerLane").value = state.lanes[0]?.name || "";
}

function renderPhotoOptions() {
  const gameSelect = $("photoGame");
  const laneSelect = $("photoLane");
  const games = encounterGames();
  const currentGameValue = gameSelect.value || state.activeGameId || games[0]?.id || "";
  gameSelect.innerHTML = games.map((game) => `<option value="${esc(game.id)}">${esc(game.nome)} · ${game.status === "final" ? "final" : "parcial"}</option>`).join("");
  if (games.some((game) => game.id === currentGameValue)) gameSelect.value = currentGameValue;
  const lanes = [...new Set(gameScores(gameSelect.value).map(scoreLane).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "pt-BR", { numeric: true }));
  const currentLane = laneSelect.value || lanes[0] || "";
  laneSelect.innerHTML = lanes.map((lane) => `<option value="${esc(lane)}">Pista ${esc(lane)}</option>`).join("");
  if (lanes.includes(currentLane)) laneSelect.value = currentLane;
  updateReviewTable();
}

function playersOnLane(lane = $("photoLane").value, gameId = $("photoGame").value) {
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
  $("reviewLaneLabel").textContent = lane ? `Pista ${lane}` : "Selecione a pista";
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
  if (client) await client.auth.signOut();
  state.session = null;
  state.profile = null;
  state.profiles = [];
  state.scoreChanges = [];
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
  state.session = data.session;
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
  state.session = data.session;
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
    state.session = authData.session;
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
  if (!nome || !apelido_placar || !pista) return showToast("Preencha nome, apelido e pista.", "error");
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
  const nome = $("gameName").value.trim();
  const playerIds = [...document.querySelectorAll("#playerSelection input:checked")].map((input) => input.value);
  if (!nome || !playerIds.length) return showToast("Informe um nome e selecione pelo menos um participante.", "error");
  if (!encounterOpen()) return showToast("Reabra o encontro para alterar partidas.", "error");
  if (!client) return showToast("Supabase não configurado.", "error");
  const assignments = playerIds.map((player_id) => ({ player_id, pista: $("playerSelection").querySelector(`[data-player-lane="${player_id}"]`)?.value || "" }));
  if (assignments.some((item) => !item.pista)) return showToast("Escolha a pista de cada participante.", "error");
  const overCapacity = state.lanes.find((lane) => assignments.filter((item) => item.pista === lane.name).length > lane.capacity);
  if (overCapacity) return showToast(`A pista ${overCapacity.name} aceita até ${overCapacity.capacity} jogadores.`, "error");
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
  const { data, error } = await client.rpc("create_encounter_game", { p_encounter_id: state.activeEncounterId, p_name: nome, p_assignments: assignments, p_request_id: state.gameRequestId });
  if (error) return showToast(`Não foi possível abrir a partida: ${error.message}`, "error");
  state.activeGameId = data.id;
  setModal("gameModal", false); await loadData(); render(); showToast("Partida aberta.", "success");
}

function drawLanes() {
  const checked = [...$("playerSelection").querySelectorAll(".game-player-check:checked")];
  const assignments = balancedLaneDraw(checked.map((input) => input.value), state.lanes);
  if (!assignments) return showToast("Cadastre pistas ou aumente a capacidade antes de sortear.", "error");
  assignments.forEach(({ player_id, pista }) => { $("playerSelection").querySelector(`[data-player-lane="${player_id}"]`).value = pista; });
  showToast("Pistas sorteadas para esta partida. Confira antes de salvar.", "success");
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
  if (!encounterOpen()) return showToast("Reabra o encontro para criar partidas.", "error");
  state.editingGameId = null;
  state.gameRequestId = crypto.randomUUID();
  $("gameSubmitButton").textContent = "Abrir partida";
  $("gameModalTitle").textContent = "Nova partida";
  $("gameName").value = `Partida ${encounterGames().length + 1}`;
  renderPlayerSelection(); setModal("gameModal", true);
}

function editGame(id) {
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
  $("scoreHistoryList").innerHTML = `<p class="section-meta">${esc(activeEncounter()?.nome || "Encontro")} · ${esc(mode.name)} · unidade: ${esc(mode.unit)}</p>${rows.length ? rows.join("") : `<p class="empty-inline">Nenhuma alteração registrada.</p>`}`;
  $("scoreHistoryList").querySelectorAll("[data-undo-change]").forEach((button) => button.addEventListener("click", () => undoScoreChange(Number(button.dataset.undoChange))));
  $("scoreHistoryList").querySelectorAll("[data-undo-round-change]").forEach((button) => button.addEventListener("click", () => undoRoundScoreChange(button.dataset.undoRoundChange)));
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

const shareUrl = () => `${window.location.origin}${window.location.pathname}${state.activeEncounterId ? `?encontro=${encodeURIComponent(state.activeEncounterId)}` : ""}`;
function openShareModal() {
  const link = $("shareModal").querySelector(".share-link");
  link.href = shareUrl();
  link.textContent = activeEncounter() ? `Link de ${activeEncounter().nome}` : "Link do placar";
  setModal("shareModal", true);
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
    state.session = authData?.session || null;
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
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !state.recovering) document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()); });
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('PWA indisponível', error));
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
        state.roundDraft.clear(); state.roundConflict = false;
        ["approvalsModal", "historyModal", "playersModal", "gameModal", "photoModal", "profileModal", "tabletModal", "teamsModal", "bracketModal", "roundModal"].forEach((id) => setModal(id, false));
        if (interrupted) showToast("Sua sessão terminou. Entre novamente para salvar.", "error");
      }
      state.session = session;
      applyAuthUi();
      window.setTimeout(async () => {
        await loadProfile();
        if (event === "TOKEN_REFRESHED") {
          try { await loadData(); } catch (error) { console.error(error); }
        }
        render(); showProfileIfNeeded();
      }, 0);
    });
    const { data } = await client.auth.getSession(); state.session = data.session;
    if (data.session?.user?.id === sessionStorage.getItem("boliche-recovery-user")) state.recovering = true;
    await loadProfile();
  }
  try { await loadData(); render(); showProfileIfNeeded(); subscribeRealtime(); } catch (error) { console.error(error); setConnection("Falha ao carregar", "error"); showToast("Não foi possível carregar o placar. Verifique o Supabase.", "error"); }
}

start();
