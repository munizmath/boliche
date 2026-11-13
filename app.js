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
  games: [],
  scores: [],
  profile: null,
  profiles: [],
  playerPhotos: new Map(),
  scoreChanges: [],
  session: null,
  recovering: /(?:^#|&)type=recovery(?:&|$)/.test(window.location.hash) || new URLSearchParams(window.location.search).get("type") === "recovery",
  activeGameId: null,
  activeEncounterId: null,
  editingEncounterId: null,
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
  editingPlayerId: null,
  editingLaneName: null,
  editingGameId: null,
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
const activeEncounter = () => state.encounters.find((encounter) => encounter.id === state.activeEncounterId);
const encounterGames = () => state.games.filter((game) => game.encounter_id === state.activeEncounterId);
const encounterPlayerIds = () => new Set(state.encounterPlayers.filter((row) => row.encounter_id === state.activeEncounterId).map((row) => row.player_id));
const encounterPlayers = () => state.players.filter((player) => encounterPlayerIds().has(player.id));
const encounterOpen = () => activeEncounter()?.status === "open";
const scoreLane = (score) => score?.pista || getPlayer(score?.player_id)?.pista || "";
const gameLaneForPlayer = (gameId, playerId) => scoreLane(state.scores.find((score) => score.game_id === gameId && score.player_id === playerId));
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
    state.players = []; state.lanes = []; state.encounters = []; state.encounterPlayers = []; state.games = []; state.scores = []; state.playerPhotos = new Map(); state.activeGameId = null;
    setConnection("Supabase não configurado", "error");
    $("demoBanner").hidden = false;
    $("demoBanner").innerHTML = "<strong>Supabase não configurado</strong><span>Configure a URL e a Publishable Key antes de usar o placar. Nenhum dado fictício será exibido.</span>";
    return;
  }
  setConnection("Sincronizando…", "muted");
  const [playersResult, lanesResult, encountersResult, rosterResult, gamesResult, scoresResult, teamsResult, teamPlayersResult, bracketsResult, predictionsResult, profilesResult, changesResult, publicPhotosResult] = await Promise.all([
    client.from("players").select("id,nome,apelido_placar,pista").order("nome"),
    client.from("lanes").select("name,capacity").order("name"),
    client.from("encounters").select("id,nome,data,status,closed_at,created_at").order("data", { ascending: false }),
    client.from("encounter_players").select("encounter_id,player_id"),
    client.from("games").select("id,nome,status,encounter_id,created_at,updated_at").order("created_at", { ascending: false }),
    client.from("scores").select("id,game_id,player_id,pista,pontos,finalizado,updated_at"),
    client.from("teams").select("id,encounter_id,name,metric"),
    client.from("team_players").select("team_id,player_id"),
    client.from("brackets").select("encounter_id,seeds,round_games"),
    isAuthenticated() ? client.from("predictions").select("game_id,user_id,predicted_player_id,created_at") : Promise.resolve({ data: [] }),
    isAdmin() ? client.rpc("list_registered_accounts") : Promise.resolve({ data: [] }),
    isAdmin() ? client.from("score_changes").select("id,score_id,game_id,player_id,previous_points,new_points,previous_finalized,new_finalized,changed_at,actor_id").order("id", { ascending: false }).limit(100) : Promise.resolve({ data: [] }),
    client.from("profiles").select("player_id,foto_path").eq("status", "approved").not("player_id", "is", null),
  ]);
  const error = playersResult.error || lanesResult.error || encountersResult.error || rosterResult.error || gamesResult.error || scoresResult.error || teamsResult.error || teamPlayersResult.error || bracketsResult.error || predictionsResult.error || profilesResult.error || changesResult.error || publicPhotosResult.error;
  if (error) throw error;
  state.players = playersResult.data || [];
  state.lanes = lanesResult.data || [];
  state.encounters = encountersResult.data || [];
  state.encounterPlayers = rosterResult.data || [];
  state.games = gamesResult.data || [];
  state.scores = scoresResult.data || [];
  state.teams = teamsResult.data || [];
  state.teamPlayers = teamPlayersResult.data || [];
  state.brackets = bracketsResult.data || [];
  state.predictions = predictionsResult.data || [];
  state.profiles = isAdmin() ? (profilesResult.data || []) : [];
  state.scoreChanges = isAdmin() ? (changesResult.data || []) : [];
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
  const requestedEncounterId = new URLSearchParams(window.location.search).get("encontro");
  state.activeEncounterId = state.encounters.some((item) => item.id === state.activeEncounterId)
    ? state.activeEncounterId
    : state.encounters.find((item) => item.id === requestedEncounterId)?.id || state.encounters.find((item) => item.status === "open")?.id || state.encounters[0]?.id || null;
  state.activeGameId = encounterGames().some((game) => game.id === state.activeGameId)
    ? state.activeGameId
    : (encounterGames().find((game) => game.status === "partial")?.id || encounterGames()[0]?.id || null);
  const latest = [...state.scores, ...state.games].map((item) => item.updated_at || item.created_at).filter(Boolean).sort().at(-1);
  setUpdated(latest || new Date().toISOString());
  setConnection("Sincronizado", "success");
}

async function loadProfile() {
  state.profile = null;
  if (!client || !state.session) return;
  const { data, error } = await client.from("profiles").select("id,nome,foto_path,status,player_id").eq("id", state.session.user.id).maybeSingle();
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
  client.channel("boliche-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "players" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "encounters" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "encounter_players" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "team_players" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "brackets" }, refreshFromRealtime)
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
async function refreshFromRealtime() {
  window.clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = window.setTimeout(async () => {
    try {
      await loadData();
      render();
      showToast("Placar atualizado em outro aparelho.", "info");
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
  $("encounterSelect").innerHTML = state.encounters.map((item) => `<option value="${esc(item.id)}">${esc(item.nome)} · ${esc(new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${item.data}T12:00:00Z`)))}</option>`).join("");
  $("encounterSelect").value = selected || "";
  $("encounterStatus").textContent = !activeEncounter() ? "Sem encontro" : activeEncounter().status === "closed" ? "Encerrado" : "Em andamento";
  $("encounterStatus").className = `status-pill status-pill--${!activeEncounter() ? "muted" : encounterOpen() ? "warning" : "success"}`;
  $("editEncounterButton").disabled = !encounterOpen();
  $("closeEncounterButton").disabled = !activeEncounter();
  $("closeEncounterButton").textContent = encounterOpen() ? "Encerrar encontro" : "Reabrir encontro";
  $("deleteEncounterButton").disabled = !encounterOpen();
  $("manageTeamsButton").disabled = !encounterOpen();
  $("manageBracketButton").disabled = !encounterOpen();
  if (document.body.classList.contains("tv-mode")) document.querySelector(".page-title h1").textContent = activeEncounter()?.nome || "Boliche dos Amigos";
  $("newGameButton").disabled = !encounterOpen();
  $("photoButton").disabled = !encounterOpen();
  document.querySelector(".intro-row h2").textContent = activeEncounter() ? `O ranking de ${activeEncounter().nome}, em um só lugar.` : "O ranking do encontro, em um só lugar.";
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
  $("encounterModalTitle").textContent = editing ? "Editar encontro" : "Novo encontro";
  $("encounterName").value = encounter?.nome || "";
  $("encounterDate").value = encounter?.data || localIsoDate();
  const roster = new Set(state.encounterPlayers.filter((row) => row.encounter_id === encounter?.id).map((row) => row.player_id));
  $("encounterPlayerSelection").innerHTML = state.players.map((player) => `<label class="selection-item"><input type="checkbox" value="${esc(player.id)}" ${!editing || roster.has(player.id) ? "checked" : ""} /><span><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")}</small></span></label>`).join("");
  $("encounterFormError").hidden = true;
  setModal("encounterModal", true);
}

async function saveEncounter(event) {
  event.preventDefault();
  const name = $("encounterName").value.trim();
  const date = $("encounterDate").value;
  const ids = [...$("encounterPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  const errorElement = $("encounterFormError");
  if (!name || !date) { errorElement.textContent = "Informe o nome e a data."; errorElement.hidden = false; return; }
  const editing = state.editingEncounterId;
  const { data, error } = await client.rpc(editing ? "save_encounter" : "create_encounter", editing
    ? { p_encounter_id: editing, p_name: name, p_date: date, p_player_ids: ids }
    : { p_name: name, p_date: date, p_player_ids: ids });
  if (error) { errorElement.textContent = error.message; errorElement.hidden = false; return; }
  setModal("encounterModal", false);
  await loadData();
  selectEncounter(data.id);
  showToast(editing ? "Encontro atualizado." : "Encontro criado.", "success");
}

async function toggleEncounterClosed() {
  const encounter = activeEncounter();
  if (!encounter) return;
  const closing = encounter.status === "open";
  if (!window.confirm(closing
    ? `Encerrar ${encounter.nome}? A classificação ficará congelada até a reabertura explícita.`
    : `Reabrir ${encounter.nome}? Pontuações e partidas poderão ser corrigidas novamente.`)) return;
  const { error } = await client.rpc("set_encounter_closed", { p_encounter_id: encounter.id, p_closed: closing });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast(closing ? "Encontro encerrado." : "Encontro reaberto.", "success");
}

function downloadResults(format) {
  const encounter = activeEncounter();
  if (!encounter) return showToast("Nenhum encontro para exportar.", "error");
  const games = encounterGames();
  const ids = new Set(games.map((game) => game.id));
  const scores = state.scores.filter((score) => ids.has(score.game_id));
  const teams = state.teams.filter((team) => team.encounter_id === encounter.id);
  const teamIds = new Set(teams.map((team) => team.id));
  const data = { encounter, players: encounterPlayers(), games, scores, teams,
    teamPlayers: state.teamPlayers.filter((row) => teamIds.has(row.team_id)),
    bracket: state.brackets.find((row) => row.encounter_id === encounter.id) || null };
  let content;
  let mime;
  if (format === "json") { content = JSON.stringify(data, null, 2); mime = "application/json"; }
  else {
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const header = ["tipo", "encontro_id", "encontro", "data", "partida_id", "partida", "status_partida", "jogador_id", "jogador", "pista", "pontos", "confirmado"];
    const prefix = [encounter.id, encounter.nome, encounter.data];
    const rows = [
      ...encounterPlayers().map((player) => ["jogador", ...prefix, "", "", "", player.id, player.nome, player.pista, "", ""]),
      ...games.map((game) => ["partida", ...prefix, game.id, game.nome, game.status, "", "", "", "", ""]),
      ...scores.map((score) => { const game = games.find((item) => item.id === score.game_id); return ["pontuacao", ...prefix, game?.id, game?.nome, game?.status, score.player_id, getPlayer(score.player_id)?.nome, scoreLane(score), score.pontos, score.finalizado]; }),
    ];
    content = [header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n"); mime = "text/csv;charset=utf-8";
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url; link.download = `boliche-${encounter.data}-${encounter.id.slice(0, 8)}.${format}`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const totals = new Map(officialTotals().map((item) => [item.player.id, item.points]));
  const ranked = teams.map((team) => {
    const members = state.teamPlayers.filter((row) => row.team_id === team.id).map((row) => getPlayer(row.player_id)).filter(Boolean);
    const sum = members.reduce((value, player) => value + (totals.get(player.id) || 0), 0);
    return { team, members, value: team.metric === "average" ? sum / (members.length || 1) : sum };
  }).sort((a, b) => b.value - a.value || a.team.name.localeCompare(b.team.name, "pt-BR"));
  $("teamsList").innerHTML = ranked.length ? ranked.map(({ team, members, value }, index) => `<div class="extra-row"><strong>${index + 1}º ${esc(team.name)}</strong><span>${value.toFixed(team.metric === "average" ? 1 : 0).replace(".", ",")} ${team.metric === "average" ? "de média" : "pontos"}</span><small>${esc(members.map((player) => player.nome).join(", "))}</small></div>`).join("") : `<p class="empty-inline">Nenhuma equipe neste encontro.</p>`;
}

function bracketWinner(gameId, first, second) {
  if (!gameId || !first || !second || getGame(gameId)?.status !== "final") return null;
  const scores = [first, second].map((id) => state.scores.find((score) => score.game_id === gameId && score.player_id === id && score.finalizado && score.pontos != null));
  if (scores.some((score) => !score) || scores[0].pontos === scores[1].pontos) return null;
  return scores[0].pontos > scores[1].pontos ? first : second;
}

function bracketRounds(bracket) {
  if (!bracket) return [];
  let entrants = bracket.seeds;
  return ["Quartas de final", "Semifinal", "Final"].map((name, round) => {
    const gameId = bracket.round_games[round];
    const matches = Array.from({ length: entrants.length / 2 }, (_, i) => ({ first: entrants[i * 2], second: entrants[i * 2 + 1], gameId }));
    entrants = matches.map((match) => bracketWinner(match.gameId, match.first, match.second));
    return { name, matches };
  });
}

function renderBracket() {
  const bracket = state.brackets.find((item) => item.encounter_id === state.activeEncounterId);
  if (!bracket) { $("bracketBoard").innerHTML = `<p class="empty-inline">Chave ainda não criada.</p>`; return; }
  const rounds = bracketRounds(bracket);
  $("bracketBoard").innerHTML = rounds.map(({ name, matches }) => `<div class="bracket-round"><strong>${name}</strong>${matches.map(({ first, second, gameId }) => {
    const winner = bracketWinner(gameId, first, second);
    return `<div class="extra-row"><span>${esc(getPlayer(first)?.nome || "A definir")} × ${esc(getPlayer(second)?.nome || "A definir")}</span><small>${esc(getGame(gameId)?.nome || "Escolha uma partida")} · ${winner ? `avança ${esc(getPlayer(winner)?.nome)}` : "aguardando resultado"}</small></div>`;
  }).join("")}</div>`).join("");
}

function renderRecords() {
  const finalGames = state.games.filter((game) => game.status === "final");
  const finalIds = new Set(finalGames.map((game) => game.id));
  const scores = state.scores.filter((score) => finalIds.has(score.game_id) && score.finalizado && score.pontos != null);
  const high = [...scores].sort((a, b) => b.pontos - a.pontos)[0];
  const byEncounterPlayer = new Map();
  scores.forEach((score) => {
    const key = `${getGame(score.game_id)?.encounter_id}:${score.player_id}`;
    if (!byEncounterPlayer.has(key)) byEncounterPlayer.set(key, []);
    byEncounterPlayer.get(key).push(score);
  });
  const bestAverage = [...byEncounterPlayer.entries()].map(([key, items]) => ({ player: getPlayer(key.split(":")[1]), encounter: state.encounters.find((item) => item.id === key.split(":")[0]), average: items.reduce((sum, item) => sum + item.pontos, 0) / items.length })).sort((a, b) => b.average - a.average)[0];
  const growth = [...byEncounterPlayer.values()].flatMap((items) => {
    const ordered = [...items].sort((a, b) => new Date(getGame(a.game_id)?.created_at) - new Date(getGame(b.game_id)?.created_at));
    return ordered.slice(1).map((score, index) => ({ score, diff: score.pontos - ordered[index].pontos }));
  }).sort((a, b) => b.diff - a.diff)[0];
  $("groupRecords").innerHTML = high ? `<div class="extra-row"><strong>Maior pontuação</strong><span>${high.pontos} · ${esc(getPlayer(high.player_id)?.nome)}</span></div><div class="extra-row"><strong>Melhor média em um encontro</strong><span>${bestAverage.average.toFixed(1).replace(".", ",")} · ${esc(bestAverage.player?.nome)}</span><small>${esc(bestAverage.encounter?.nome)}</small></div><div class="extra-row"><strong>Maior evolução</strong><span>${growth && growth.diff > 0 ? `+${growth.diff} · ${esc(getPlayer(growth.score.player_id)?.nome)}` : "Aguardando duas partidas"}</span></div>` : `<p class="empty-inline">Os recordes aparecerão após a primeira partida concluída.</p>`;
}

function renderPredictions() {
  const panel = $("predictionsSection");
  const game = getGame(state.activeGameId);
  const userId = state.session?.user?.id;
  const canPredict = Boolean(userId && state.profile?.status === "approved" && game && encounterOpen());
  panel.hidden = !canPredict;
  if (!canPredict) return;
  const scores = gameScores(game.id);
  const started = scores.some((score) => score.pontos != null);
  const existing = state.predictions.find((prediction) => prediction.game_id === game.id && prediction.user_id === userId);
  $("predictionHint").textContent = started ? "Os palpites desta partida estão encerrados." : `Quem vencerá ${game.nome}? Seu palpite pode mudar até o primeiro ponto.`;
  $("predictionPlayer").innerHTML = `<option value="">Escolha um jogador</option>${scores.map((score) => `<option value="${esc(score.player_id)}">${esc(getPlayer(score.player_id)?.nome || "Jogador")}</option>`).join("")}`;
  $("predictionPlayer").value = existing?.predicted_player_id || "";
  $("predictionPlayer").disabled = started;
  $("savePredictionButton").disabled = started;
  const own = state.predictions.filter((item) => item.user_id === userId && getGame(item.game_id)?.encounter_id === state.activeEncounterId && getGame(item.game_id)?.status === "final");
  const decided = own.filter((item) => {
    const points = gameScores(item.game_id).filter((score) => score.finalizado && score.pontos != null);
    return points.filter((score) => score.pontos === Math.max(...points.map((row) => row.pontos))).length === 1;
  });
  const hits = decided.filter((item) => {
    const points = gameScores(item.game_id);
    return points.some((score) => score.player_id === item.predicted_player_id && score.pontos === Math.max(...points.map((row) => row.pontos)));
  }).length;
  $("predictionAccuracy").textContent = decided.length ? `${hits}/${decided.length} palpites certos (${Math.round(100 * hits / decided.length)}%)` : "Nenhum palpite decidido";
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
  $("deleteBracketButton").hidden = !bracket;
  $("bracketError").hidden = true;
  setModal("bracketModal", true);
}

async function saveBracket(event) {
  event.preventDefault();
  const seeds = [...$("bracketPlayerSelection").querySelectorAll("input:checked")].map((input) => input.value);
  if (seeds.length !== 8) { $("bracketError").textContent = "Escolha exatamente oito jogadores."; $("bracketError").hidden = false; return; }
  const games = [0, 1, 2].map((round) => $(`bracketGame${round}`).value || null);
  if (new Set(games.filter(Boolean)).size !== games.filter(Boolean).length) { $("bracketError").textContent = "Escolha partidas diferentes para cada rodada."; $("bracketError").hidden = false; return; }
  const { error } = await client.rpc("save_bracket", { p_encounter_id: state.activeEncounterId, p_seeds: seeds, p_round_games: games });
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
  const { error } = await client.from("predictions").upsert({ game_id: state.activeGameId, user_id: state.session.user.id, predicted_player_id: playerId }, { onConflict: "game_id,user_id" });
  if (error) return showToast(error.message, "error");
  await loadData(); render(); showToast("Palpite salvo.", "success");
}

function render() {
  applyAuthUi();
  renderLeaderboard();
  renderEncounterBar();
  renderCurrentGame();
  renderGames();
  renderTeams(); renderBracket(); renderRecords(); renderPredictions();
  if (!$("gameModal").open) renderPlayerSelection();
  if (!$("photoModal").open) renderPhotoOptions();
  if ($("playersModal").open) renderPlayers();
  if ($("approvalsModal").open) renderApprovals();
  if ($("historyModal").open) renderScoreHistory();
}

function officialTotals(lane = "") {
  const finalGameIds = new Set(encounterGames().filter((game) => game.status === "final").map((game) => game.id));
  const metric = $("rankingMetric")?.value || "total";
  return (finalGameIds.size ? encounterPlayers() : []).map((player) => {
    const results = state.scores.filter((score) => score.player_id === player.id && finalGameIds.has(score.game_id) && score.finalizado && score.pontos != null && (!lane || scoreLane(score) === lane));
    const points = results.reduce((sum, score) => sum + Number(score.pontos), 0);
    const gamesPlayed = results.length;
    const current = state.scores.find((score) => score.game_id === state.activeGameId && score.player_id === player.id);
    return { player, points, gamesPlayed, average: gamesPlayed ? points / gamesPlayed : 0, current, lane: results.at(-1)?.pista || current?.pista || player.pista };
  }).filter((item) => item.gamesPlayed > 0).sort((a, b) => (metric === "average" ? b.average - a.average : b.points - a.points) || b.points - a.points || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
}

function officialPosition(totals, index) {
  const metric = $("rankingMetric")?.value || "total";
  return totals.findIndex((item) => (metric === "average" ? item.average : item.points) === (metric === "average" ? totals[index].average : totals[index].points)) + 1;
}

function renderLeaderboard() {
  const body = $("leaderboardBody");
  const finalGames = encounterGames().filter((game) => game.status === "final");
  const laneSelect = $("rankingLane");
  const selectedLane = laneSelect.value;
  const gameIds = new Set(encounterGames().map((game) => game.id));
  const lanes = [...new Set(state.scores.filter((score) => gameIds.has(score.game_id)).map(scoreLane).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  laneSelect.innerHTML = `<option value="">Todas as pistas</option>${lanes.map((lane) => `<option value="${esc(lane)}">Pista ${esc(lane)}</option>`).join("")}`;
  if (lanes.includes(selectedLane)) laneSelect.value = selectedLane;
  const totals = officialTotals(laneSelect.value);
  const metric = $("rankingMetric").value;
  $("rankingValueHeader").textContent = metric === "average" ? "Média" : "Pontos";
  $("rankingTitle").textContent = metric === "average" ? "Classificação por média" : "Classificação acumulada";
  const podium = $("podium");
  podium.hidden = totals.length === 0;
  podium.innerHTML = totals.slice(0, 3).map((item, index) => {
    const photoUrl = state.playerPhotos.get(item.player.id);
    return `<div class="podium-place podium-place--${index + 1}"><span class="podium-medal">${officialPosition(totals, index)}º</span>${photoUrl ? `<img class="podium-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(item.player.nome)}" loading="lazy" />` : `<span class="podium-avatar podium-avatar--empty" aria-hidden="true">${esc(item.player.nome.slice(0, 1))}</span>`}<strong>${metric === "average" ? item.average.toFixed(1).replace(".", ",") + " média" : item.points.toLocaleString("pt-BR") + " pontos"}</small></div>`;
  }).join("");
  let previousPoints = null;
  let previousPosition = 0;
  body.innerHTML = totals.map((item, index) => {
    const rankingValue = metric === "average" ? item.average : item.points;
    const position = rankingValue === previousPoints ? previousPosition : index + 1;
    previousPoints = rankingValue;
    previousPosition = position;
    const situation = item.current?.finalizado ? "Final" : (item.current ? "Parcial" : "—");
    const chipClass = situation === "Final" ? "status-chip status-chip--final" : "status-chip status-chip--partial";
    const photoUrl = state.playerPhotos.get(item.player.id);
    return `<tr><td class="rank-cell">${position}</td><td><div class="ranking-player">${photoUrl ? `<img class="ranking-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(item.player.nome)}" loading="lazy" />` : ""}<span><button class="player-stats-link" type="button" data-stats-player="${esc(item.player.id)}">${esc(item.player.nome)}</button><small>${esc(item.player.apelido_placar || "sem apelido")}</small></span></div></td><td>${esc(item.lane || "—")}</td><td>${item.gamesPlayed}</td><td class="points-cell">${metric === "average" ? item.average.toFixed(1).replace(".", ",") : item.points.toLocaleString("pt-BR")}</td><td><span class="${chipClass}">${situation}</span></td></tr>`;
  }).join("");
  body.querySelectorAll("[data-stats-player]").forEach((button) => button.addEventListener("click", () => openStatsModal(button.dataset.statsPlayer)));
  $("leaderboardEmpty").hidden = totals.length > 0;
  $("leaderboardMeta").textContent = finalGames.length ? `${finalGames.length} ${finalGames.length === 1 ? "partida finalizada" : "partidas finalizadas"}` : "Nenhuma partida finalizada";
}

function renderCurrentGame() {
  const game = getGame(state.activeGameId);
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
  const ranked = [...scores].sort((a, b) => (b.score.pontos ?? -1) - (a.score.pontos ?? -1) || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
  body.innerHTML = ranked.length ? ranked.map(({ score, player }) => {
    const position = score.pontos == null ? "—" : `${ranked.findIndex((item) => item.score.pontos === score.pontos) + 1}º`;
    const photoUrl = state.playerPhotos.get(player.id);
    return `<div class="current-row"><div class="current-player${photoUrl ? " current-player--with-photo" : ""}"><span class="provisional-rank">${position}</span>${photoUrl ? `<img class="ranking-avatar" src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" loading="lazy" />` : ""}<button class="player-stats-link current-stats-link" type="button" data-stats-player="${esc(player.id)}">${esc(player.nome)}</button><span>Pista ${esc(scoreLane(score) || "—")}</span></div><div class="current-score"><strong>${score.pontos == null ? "—" : Number(score.pontos).toLocaleString("pt-BR")}</strong><span class="status-chip ${score.finalizado ? "status-chip--final" : "status-chip--partial"}">${score.finalizado ? "Final" : "Pendente"}</span>${isAdmin() && encounterOpen() ? `<button class="text-button" type="button" data-quick-score="${esc(player.id)}">Corrigir</button>${score.pontos != null ? `<button class="text-button text-button--danger" type="button" data-clear-score="${esc(player.id)}">Limpar</button>` : ""}` : ""}</div></div>`;
  }).join("") : `<div class="empty-state"><span>Partida sem participantes.</span></div>`;
  body.querySelectorAll("[data-stats-player]").forEach((button) => button.addEventListener("click", () => openStatsModal(button.dataset.statsPlayer)));
  body.querySelectorAll("[data-quick-score]").forEach((button) => button.addEventListener("click", () => openQuickScore(button.dataset.quickScore)));
  body.querySelectorAll("[data-clear-score]").forEach((button) => button.addEventListener("click", () => clearScore(button.dataset.clearScore)));
  $("laneProgress").innerHTML = [...new Set(scores.map(({ score }) => scoreLane(score)))].map((lane) => {
    const laneScores = scores.filter(({ score }) => scoreLane(score) === lane);
    const confirmed = laneScores.filter(({ score }) => score.finalizado && score.pontos != null).length;
    return `<span class="status-pill status-pill--${confirmed === laneScores.length ? "success" : "warning"}">Pista ${esc(lane)}: ${confirmed}/${laneScores.length} confirmados</span>`;
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
  const finalGames = encounterGames().filter((game) => game.status === "final").sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const results = finalGames.map((game) => ({ game, score: state.scores.find((score) => score.game_id === game.id && score.player_id === playerId) })).filter((item) => item.score?.finalizado && item.score.pontos != null);
  const points = results.map((item) => Number(item.score.pontos));
  const wins = results.filter(({ game, score }) => Number(score.pontos) === Math.max(...gameScores(game.id).filter((item) => item.pontos != null).map((item) => Number(item.pontos)))).length;
  const totals = officialTotals();
  const playerIndex = totals.findIndex((item) => item.player.id === playerId);
  const position = playerIndex < 0 ? 0 : officialPosition(totals, playerIndex);
  const photoUrl = state.playerPhotos.get(playerId);
  $("statsTitle").textContent = player.nome;
  $("statsHero").innerHTML = `${photoUrl ? `<img src="${esc(photoUrl)}" alt="Foto de ${esc(player.nome)}" />` : `<span class="stats-avatar-empty" aria-hidden="true">${esc(player.nome.slice(0, 1))}</span>`}<div><strong>${position ? `${position}º no ranking` : "Ainda sem posição oficial"}</strong><span>${points.length} ${points.length === 1 ? "partida concluída" : "partidas concluídas"} neste encontro</span></div>`;
  $("statsSummary").innerHTML = `<div><strong>${points.length ? Math.max(...points) : "—"}</strong><span>recorde</span></div><div><strong>${points.length ? (points.reduce((sum, value) => sum + value, 0) / points.length).toFixed(1).replace(".", ",") : "—"}</strong><span>média</span></div><div><strong>${wins}</strong><span>vitórias</span></div>`;
  const coords = points.map((value, index) => `${points.length === 1 ? 240 : 20 + index * 440 / (points.length - 1)},${115 - value * .3}`);
  $("statsEvolution").innerHTML = points.length ? `<strong>Evolução por partida</strong><svg viewBox="0 0 480 140" role="img" aria-label="Pontuações: ${points.join(", ")}"><line x1="20" y1="115" x2="460" y2="115" stroke="currentColor" opacity=".25" /><polyline points="${coords.join(" ")}" fill="none" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${coords.map((point) => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="5" fill="var(--color-accent)" />`).join("")}</svg>` : "";
  $("statsGames").innerHTML = results.length ? results.map(({ game, score }) => `<div class="history-row"><div><strong>${esc(game.nome)}</strong><small>${fmtDate(game.created_at)}</small></div><span>${score.pontos} pontos</span></div>`).join("") : `<p class="empty-inline">Nenhuma partida finalizada para este jogador.</p>`;
  setModal("statsModal", true);
}

function renderGames() {
  const games = encounterGames();
  $("gameCount").textContent = `${games.length} ${games.length === 1 ? "partida" : "partidas"}`;
  $("gamesList").innerHTML = games.length ? games.map((game) => {
    const scores = gameScores(game.id);
    const done = scores.filter((score) => score.finalizado && score.pontos != null).length;
    const total = scores.length;
    return `<article class="game-card ${game.id === state.activeGameId ? "game-card--active" : ""}"><button class="game-card-select" type="button" data-game-id="${esc(game.id)}"><div class="game-card-top"><span class="eyebrow">${fmtDate(game.created_at)}</span><span class="status-pill status-pill--${game.status === "final" ? "success" : "warning"}">${game.status === "final" ? "Final" : "Parcial"}</span></div><h4>${esc(game.nome)}</h4><p>${done} de ${total} resultados confirmados</p><div class="game-progress"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div></button>${isAdmin() && encounterOpen() ? `<div class="game-card-actions"><button class="text-button" type="button" data-edit-game="${esc(game.id)}">Editar</button><button class="text-button text-button--danger" type="button" data-delete-game="${esc(game.id)}">Excluir</button></div>` : ""}</article>`;
  }).join("") : `<div class="empty-state empty-state--wide"><strong>Nenhuma partida cadastrada</strong><span>O administrador pode abrir a primeira partida.</span></div>`;
  document.querySelectorAll("[data-game-id]").forEach((button) => button.addEventListener("click", () => { state.activeGameId = button.dataset.gameId; render(); }));
  document.querySelectorAll("[data-edit-game]").forEach((button) => button.addEventListener("click", () => editGame(button.dataset.editGame)));
  document.querySelectorAll("[data-delete-game]").forEach((button) => button.addEventListener("click", () => removeGame(button.dataset.deleteGame)));
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
  $("reviewPendingNote").hidden = !hasChange;
}

function updateReviewTable(suggestions = new Map()) {
  const lane = $("photoLane").value;
  $("reviewLaneLabel").textContent = lane ? `Pista ${lane}` : "Selecione a pista";
  const gameId = $("photoGame").value;
  const rows = playersOnLane(lane);
  $("reviewTable").innerHTML = rows.length ? rows.map((player) => {
    const old = state.scores.find((score) => score.game_id === gameId && score.player_id === player.id);
    const suggestion = suggestions.get(player.id);
    const value = suggestion?.value ?? (old?.pontos ?? "");
    const finalizado = Boolean(old?.finalizado) && (!suggestion || Number(suggestion.value) === Number(old.pontos));
    return `<div class="review-row" data-review-player="${esc(player.id)}" data-old-score="${old?.pontos ?? ""}" data-old-final="${Boolean(old?.finalizado)}"><div class="review-player"><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")} · pista ${esc(scoreLane(old) || "—")}${suggestion ? ` · ${esc(suggestion.hint)}` : ""}</small></div><div class="review-score-wrap"><input class="review-score" type="number" min="0" max="300" step="1" inputmode="numeric" placeholder="—" value="${value === "" ? "" : esc(value)}" aria-label="Pontos de ${esc(player.nome)}" /><small></small></div><label class="review-confirm"><input class="review-final" type="checkbox" ${finalizado ? "checked" : ""} /> confirmar</label></div>`;
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

async function submitProfile(event) {
  event.preventDefault();
  const errorElement = $("profileError");
  const file = $("profileCamera").files?.[0] || $("profilePhoto").files?.[0];
  const nome = $("profileName").value.trim();
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
  if (!file && !state.profile?.foto_path) {
    errorElement.textContent = "Adicione pelo menos uma foto para concluir o cadastro.";
    errorElement.hidden = false;
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
    let currentProfile = state.profile;
    if (!currentProfile) {
      const { data: existing, error: readError } = await client.from("profiles").select("id,nome,foto_path,status,player_id").eq("id", state.session.user.id).maybeSingle();
      if (readError) throw new Error(`Não foi possível conferir o cadastro: ${readError.message || "tente novamente"}.`);
      currentProfile = existing;
    }
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
      ? client.from("profiles").update({ nome, foto_path: fotoPath }).eq("id", state.session.user.id)
      : client.from("profiles").insert({ id: state.session.user.id, nome, foto_path: fotoPath });
    const { data, error } = await query.select("id,nome,foto_path,status,player_id").single();
    if (error) {
      if (uploadedPath) {
        try { await client.storage.from("profile-photos").remove([uploadedPath]); } catch (cleanupError) { console.warn(cleanupError); }
      }
      throw new Error(`Não foi possível salvar o perfil: ${error.message || "tente novamente"}.`);
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
    showToast(data.status === "approved" ? "Perfil atualizado." : "Perfil salvo e enviado para aprovação.", "success");
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
  const { data, error } = await client.rpc("create_encounter_game", { p_encounter_id: state.activeEncounterId, p_name: nome, p_assignments: assignments });
  if (error) return showToast(`Não foi possível abrir a partida: ${error.message}`, "error");
  state.activeGameId = data.id;
  setModal("gameModal", false); await loadData(); render(); showToast("Partida aberta.", "success");
}

function drawLanes() {
  const checked = [...$("playerSelection").querySelectorAll(".game-player-check:checked")];
  const slots = state.lanes.flatMap((lane) => Array(lane.capacity).fill(lane.name));
  if (checked.length > slots.length) return showToast("Cadastre pistas ou aumente a capacidade antes de sortear.", "error");
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  checked.forEach((input, index) => { $("playerSelection").querySelector(`[data-player-lane="${input.value}"]`).value = slots[index]; });
  showToast("Pistas sorteadas para esta partida. Confira antes de salvar.", "success");
}

function openGameModal() {
  if (!encounterOpen()) return showToast("Reabra o encontro para criar partidas.", "error");
  state.editingGameId = null;
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
  const { error } = await client.from("games").delete().eq("id", id).select("id").single();
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
  const gameIds = new Set(encounterGames().map((game) => game.id));
  const changes = state.scoreChanges.filter((change) => gameIds.has(change.game_id));
  $("scoreHistoryList").innerHTML = changes.length ? changes.map((change, index) => {
    const player = getPlayer(change.player_id);
    const game = getGame(change.game_id);
    const actor = state.profiles.find((profile) => profile.id === change.actor_id)?.nome || (change.actor_id === state.session?.user?.id ? "Você" : "Administrador");
    const canUndo = encounterOpen() && !changes.slice(0, index).some((newer) => newer.score_id === change.score_id);
    return `<div class="history-row"><div><strong>${esc(player?.nome || "Jogador")}</strong><small>${esc(game?.nome || "Partida")} · ${fmtDate(change.changed_at)} · ${esc(actor)}</small><span>${change.previous_points ?? "—"} → ${change.new_points ?? "—"}${change.previous_finalized !== change.new_finalized ? ` · ${change.new_finalized ? "confirmado" : "pendente"}` : ""}</span></div>${canUndo ? `<button class="text-button" type="button" data-undo-change="${change.id}">Desfazer</button>` : ""}</div>`;
  }).join("") : `<p class="empty-inline">Nenhuma alteração registrada.</p>`;
  $("scoreHistoryList").querySelectorAll("[data-undo-change]").forEach((button) => button.addEventListener("click", () => undoScoreChange(Number(button.dataset.undoChange))));
}

async function undoScoreChange(id) {
  if (!window.confirm("Desfazer esta alteração de pontuação?")) return;
  const { error } = await client.rpc("undo_score_change", { p_change_id: id });
  if (error) return showToast("Não foi possível desfazer: o resultado pode ter sido alterado depois.", "error");
  await loadData(); render(); showToast("Alteração desfeita.", "success");
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
  try { await navigator.share({ title: "Boliche dos Amigos", url: shareUrl() }); }
  catch (error) { if (error.name !== "AbortError") showToast("Não foi possível compartilhar o link.", "error"); }
}

async function shareResultCard() {
  const totals = officialTotals();
  const finalGames = encounterGames().filter((game) => game.status === "final");
  if (!totals.length) return showToast("Finalize uma partida para gerar a imagem do resultado.", "error");
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = Math.max(1100, 500 + totals.length * 72 + 150);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6f4ef"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#bd8d52"; context.fillRect(0, 0, canvas.width, 18);
  context.fillStyle = "#2f312f"; context.font = "bold 62px Georgia"; context.fillText("Boliche dos Amigos", 80, 110);
  context.font = "28px Arial"; context.fillText("Classificação oficial do encontro", 80, 160);
  context.fillStyle = "#777a76"; context.font = "22px Arial";
  const lastGameDate = finalGames.map((game) => game.created_at).filter(Boolean).sort().at(-1);
  context.fillText(`${finalGames.length} ${finalGames.length === 1 ? "partida finalizada" : "partidas finalizadas"} · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(lastGameDate || Date.now()))}`, 80, 202);
  totals.slice(0, 3).forEach((item, index) => {
    const x = 80 + index * 315;
    context.fillStyle = index === 0 ? "#e9d5b8" : "#fbfaf7"; context.fillRect(x, 246, 295, 180);
    context.strokeStyle = "#d8d9d3"; context.strokeRect(x, 246, 295, 180);
    context.fillStyle = "#805928"; context.font = "bold 44px Georgia"; context.fillText(`${officialPosition(totals, index)}º`, x + 18, 302);
    context.fillStyle = "#2f312f"; context.font = "bold 24px Arial"; context.fillText(item.player.nome.slice(0, 19), x + 18, 350);
    context.font = "21px Arial"; context.fillText(`${item.points} pontos`, x + 18, 390);
  });
  context.fillStyle = "#805928"; context.font = "bold 22px Arial"; context.fillText("RANKING COMPLETO", 80, 475);
  totals.forEach((item, index) => {
    const y = 520 + index * 72;
    context.fillStyle = index % 2 ? "#f1eee8" : "#fbfaf7"; context.fillRect(80, y - 37, 925, 62);
    context.fillStyle = "#805928"; context.font = "bold 27px Georgia"; context.fillText(`${officialPosition(totals, index)}º`, 100, y);
    context.fillStyle = "#2f312f"; context.font = "bold 24px Arial"; context.fillText(item.player.nome.slice(0, 30), 180, y);
    context.font = "22px Arial"; context.textAlign = "right"; context.fillText(`${item.points} pontos`, 980, y); context.textAlign = "left";
  });
  context.fillStyle = "#777a76"; context.font = "21px Arial"; context.fillText("munizmath.github.io/boliche", 80, canvas.height - 70);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return showToast("Não foi possível gerar a imagem.", "error");
  const file = new File([blob], "resultado-boliche.png", { type: "image/png" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ title: "Resultado do Boliche dos Amigos", files: [file] }); return; }
    catch (error) { if (error.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = file.name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  showToast("Imagem do resultado salva no aparelho.", "success");
}

function openPhotoModal() {
  if (!encounterOpen()) return showToast("Reabra o encontro para atualizar os pontos.", "error");
  if (!encounterGames().length) return showToast("Abra uma partida antes de importar uma foto.", "error");
  resetPhotoState(); renderPhotoOptions(); setModal("photoModal", true);
}

function resetPhotoState() {
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
  $("runOcrButton").disabled = true; $("ocrStatus").textContent = "Lendo a imagem… isso pode levar alguns segundos.";
  try {
    const source = getOcrCanvas();
    const result = await Tesseract.recognize(source, "por+eng", { logger: (info) => { if (info.status === "recognizing text") $("ocrStatus").textContent = `Lendo a imagem… ${Math.round((info.progress || 0) * 100)}%`; } });
    const suggestions = buildSuggestions(result.data, source.width);
    updateReviewTable(suggestions);
    $("ocrStatus").textContent = suggestions.size ? `OCR encontrou ${suggestions.size} sugestão(ões). Revise antes de confirmar.` : "OCR não encontrou associações confiáveis. Preencha a tabela manualmente.";
    updatePhotoConfirmState();
  } catch (error) {
    console.error(error); $("ocrStatus").textContent = "Não foi possível ler a foto. Preencha os pontos manualmente."; updatePhotoConfirmState();
  } finally { $("runOcrButton").disabled = false; }
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
  document.documentElement.classList.toggle("dark", dark); $("themeToggle").textContent = dark ? "☀" : "◐";
  $("themeToggle").addEventListener("click", () => { const next = !document.documentElement.classList.contains("dark"); document.documentElement.classList.toggle("dark", next); localStorage.setItem("boliche-theme", next ? "dark" : "light"); $("themeToggle").textContent = next ? "☀" : "◐"; });
}

function bindEvents() {
  initTheme();
  $("encounterSelect").addEventListener("change", (event) => selectEncounter(event.target.value));
  $("newEncounterButton").addEventListener("click", () => openEncounterModal(false));
  $("editEncounterButton").addEventListener("click", () => openEncounterModal(true));
  $("closeEncounterButton").addEventListener("click", toggleEncounterClosed);
  $("deleteEncounterButton").addEventListener("click", deleteEncounter);
  $("encounterForm").addEventListener("submit", saveEncounter);
  $("exportCsvButton").addEventListener("click", () => downloadResults("csv"));
  $("exportJsonButton").addEventListener("click", () => downloadResults("json"));
  $("drawLanesButton").addEventListener("click", drawLanes);
  $("manageTeamsButton").addEventListener("click", openTeamsModal);
  $("teamForm").addEventListener("submit", saveTeam);
  $("cancelTeamEdit").addEventListener("click", openTeamsModal);
  $("manageBracketButton").addEventListener("click", openBracketModal);
  $("bracketForm").addEventListener("submit", saveBracket);
  $("deleteBracketButton").addEventListener("click", deleteBracket);
  $("shuffleBracketButton").addEventListener("click", () => {
    const grid = $("bracketPlayerSelection");
    const selected = [...grid.querySelectorAll("input:checked")].map((input) => input.closest("label"));
    for (let i = selected.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [selected[i], selected[j]] = [selected[j], selected[i]]; }
    selected.forEach((label) => grid.append(label));
  });
  $("savePredictionButton").addEventListener("click", savePrediction);
  $("tvModeButton").addEventListener("click", () => { const tv = document.body.classList.toggle("tv-mode"); $("tvModeButton").textContent = tv ? "Sair do telão" : "Modo telão"; document.querySelector(".page-title h1").textContent = tv ? activeEncounter()?.nome || "Boliche dos Amigos" : "Placar compartilhado"; });
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  window.addEventListener("online", refreshAfterReconnect);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAfterReconnect(); });
  if (client) window.setInterval(refreshAfterReconnect, 240000);
  $("recoveryForm").addEventListener("submit", submitRecovery);
  $("recoverySignOut").addEventListener("click", signOut);
  $("recoveryModal").addEventListener("cancel", (event) => event.preventDefault());
  $("authButton").addEventListener("click", openAuth); $("registerButton").addEventListener("click", openRegister); $("profileButton").addEventListener("click", openProfileModal); $("photoButton").addEventListener("click", openPhotoModal); $("newGameButton").addEventListener("click", openGameModal);
  $("gameForm").addEventListener("submit", createGame); $("authForm").addEventListener("submit", submitAuth); $("registerForm").addEventListener("submit", submitRegister); $("profileForm").addEventListener("submit", submitProfile); $("profilePhoto").addEventListener("change", profilePhotoSelected); $("profileCamera").addEventListener("change", profilePhotoSelected); $("playersForm").addEventListener("click", (event) => { if (event.target.id === "addPlayerButton") addPlayer(); }); $("cancelPlayerEditButton").addEventListener("click", cancelPlayerEdit);
  $("currentGameSelect").addEventListener("click", () => $("historico").scrollIntoView({ behavior: "smooth", block: "start" }));
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
  $("photoForm").addEventListener("submit", confirmPhotoUpdate); $("photoInput").addEventListener("change", loadPhoto); $("photoLane").addEventListener("change", () => updateReviewTable()); $("photoGame").addEventListener("change", renderPhotoOptions); $("reviewTable").addEventListener("input", updatePhotoConfirmState); $("runOcrButton").addEventListener("click", runOcr); $("clearCropButton").addEventListener("click", () => { state.crop = null; drawCanvas(); });
  $("rotatePhotoButton").addEventListener("click", () => { state.photoRotation = (state.photoRotation + 90) % 360; state.crop = null; updatePhotoPreview(); });
  $("photoPanButton").addEventListener("click", () => { state.photoPanMode = !state.photoPanMode; applyPhotoInteractionMode(); });
  $("photoZoom").addEventListener("input", (event) => { state.photoZoom = Number(event.target.value); $("photoCanvas").style.width = `${state.photoZoom}%`; state.photoPanMode = state.photoZoom > 100; applyPhotoInteractionMode(); });
  $("photoContrast").addEventListener("input", (event) => { state.photoContrast = Number(event.target.value); updatePhotoPreview(); });
  const canvas = $("photoCanvas"); canvas.addEventListener("pointerdown", startCrop); canvas.addEventListener("pointermove", moveCrop); canvas.addEventListener("pointerup", endCrop); canvas.addEventListener("pointercancel", endCrop);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !state.recovering) document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()); });
  $("authButton").insertAdjacentHTML("beforebegin", `<button id="playersButton" class="button button--quiet admin-only" type="button" hidden>Participantes</button>`); $("playersButton").addEventListener("click", openPlayersModal);
  document.querySelectorAll("[data-scroll-to]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.scrollTo;
    if (target === "importacao") return openPhotoModal();
    if (target === "participantes") return openPlayersModal();
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelectorAll(".nav-link").forEach((navLink) => {
      const active = navLink === button;
      navLink.classList.toggle("nav-link--active", active);
      if (active) navLink.setAttribute("aria-current", "page"); else navLink.removeAttribute("aria-current");
    });
  }));
  document.querySelectorAll(".modal-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
}

async function start() {
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('PWA indisponível', error));
  if (client) {
    client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") state.recovering = true;
      if (event === "SIGNED_OUT") {
        const interrupted = $("profileModal").open || $("photoModal").open;
        state.recovering = false;
        sessionStorage.removeItem("boliche-recovery-user");
        state.profile = null;
        state.profiles = [];
        state.playerPhotos = new Map();
        state.scoreChanges = [];
        ["approvalsModal", "historyModal", "playersModal", "gameModal", "photoModal", "profileModal"].forEach((id) => setModal(id, false));
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
