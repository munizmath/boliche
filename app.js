/* global supabase, Tesseract */

const config = window.SUPABASE_CONFIG || {};
const isDemoMode = !config.url || !config.publishableKey;
const client = !isDemoMode && window.supabase
  ? window.supabase.createClient(config.url, config.publishableKey)
  : null;

const state = {
  players: [],
  games: [],
  scores: [],
  profile: null,
  session: null,
  activeGameId: null,
  lastUpdatedAt: null,
  crop: null,
  image: null,
  imageFile: null,
};

const $ = (id) => document.getElementById(id);
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[char]));
const normalize = (value = "") => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const fmtDate = (value) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const fmtTime = (value) => value ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const getPlayer = (id) => state.players.find((player) => player.id === id);
const getGame = (id) => state.games.find((game) => game.id === id);
const gameScores = (gameId) => state.scores.filter((score) => score.game_id === gameId);
const isAdmin = () => state.session?.user?.app_metadata?.role === "admin";
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
  if (open) modal.showModal();
  else modal.close();
}

async function loadData() {
  if (isDemoMode) {
    state.players = []; state.games = []; state.scores = []; state.activeGameId = null;
    setConnection("Supabase não configurado", "error");
    $("demoBanner").hidden = false;
    $("demoBanner").innerHTML = "<strong>Supabase não configurado</strong><span>Configure a URL e a Publishable Key antes de usar o placar. Nenhum dado fictício será exibido.</span>";
    return;
  }
  setConnection("Sincronizando…", "muted");
  const [playersResult, gamesResult, scoresResult] = await Promise.all([
    client.from("players").select("id,nome,apelido_placar,pista").order("nome"),
    client.from("games").select("id,nome,status,created_at,updated_at").order("created_at", { ascending: false }),
    client.from("scores").select("id,game_id,player_id,pontos,finalizado,updated_at"),
  ]);
  const error = playersResult.error || gamesResult.error || scoresResult.error;
  if (error) throw error;
  state.players = playersResult.data || [];
  state.games = gamesResult.data || [];
  state.scores = scoresResult.data || [];
  state.activeGameId = state.games.find((game) => game.status === "partial")?.id || state.games[0]?.id || null;
  const latest = [...state.scores, ...state.games].map((item) => item.updated_at || item.created_at).filter(Boolean).sort().at(-1);
  setUpdated(latest || new Date().toISOString());
  setConnection("Sincronizado", "success");
}

async function loadProfile() {
  state.profile = null;
  if (!client || !state.session) return;
  const { data, error } = await client.from("profiles").select("id,nome,foto_path,status").eq("id", state.session.user.id).maybeSingle();
  if (error) {
    console.error(error);
    return;
  }
  state.profile = data;
}

function openProfileModal() {
  if (!state.session) return;
  $("profileName").value = state.profile?.nome || state.session.user.user_metadata?.nome || "";
  $("profilePhoto").value = "";
  $("profilePhotoName").textContent = state.profile?.foto_path ? "Escolha outra foto para substituir a atual" : "JPG, PNG ou WebP · até 5 MB";
  $("profileError").hidden = true;
  setModal("profileModal", true);
}

function showProfileIfNeeded() {
  if (state.session && !state.profile) window.setTimeout(openProfileModal, 0);
}

function subscribeRealtime() {
  if (!client) return;
  client.channel("boliche-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "players" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, refreshFromRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, refreshFromRealtime)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setConnection("Ao vivo", "success");
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
  const admin = isAdmin();
  document.querySelectorAll(".admin-only").forEach((element) => {
    element.hidden = !admin;
  });
  $("authButton").textContent = state.session ? "Sair" : "Entrar";
  $("authButton").title = state.session?.user?.email || "Acesso do administrador";
  $("registerButton").hidden = isAuthenticated();
  $("profileButton").hidden = !isAuthenticated();
  const sidebarRole = $("sidebarRole");
  if (sidebarRole) sidebarRole.textContent = isAdmin() ? "Administrador" : (state.session ? "Participante" : "Visitante");
  const sidebarRoleNote = sidebarRole?.nextElementSibling;
  if (sidebarRoleNote) sidebarRoleNote.textContent = state.session ? (state.session.user?.email || "acesso autorizado") : "acompanha o encontro";
}

function render() {
  applyAuthUi();
  renderLeaderboard();
  renderCurrentGame();
  renderGames();
  renderPlayerSelection();
  renderPhotoOptions();
  if ($("playersModal").open) renderPlayers();
}

function renderLeaderboard() {
  const body = $("leaderboardBody");
  const finalGames = state.games.filter((game) => game.status === "final");
  const totals = state.players.map((player) => {
    const points = state.scores.filter((score) => score.player_id === player.id && finalGames.some((game) => game.id === score.game_id) && score.finalizado).reduce((sum, score) => sum + Number(score.pontos || 0), 0);
    const current = state.scores.find((score) => score.game_id === state.activeGameId && score.player_id === player.id);
    return { player, points, current };
  }).sort((a, b) => b.points - a.points || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
  let previousPoints = null;
  let previousPosition = 0;
  body.innerHTML = totals.map((item, index) => {
    const position = item.points === previousPoints ? previousPosition : index + 1;
    previousPoints = item.points;
    previousPosition = position;
    const situation = item.current?.finalizado ? "Final" : (item.current ? "Parcial" : "—");
    const chipClass = situation === "Final" ? "status-chip status-chip--final" : "status-chip status-chip--partial";
    return `<tr><td class="rank-cell">${position}</td><td><strong>${esc(item.player.nome)}</strong><small>${esc(item.player.apelido_placar || "sem apelido")}</small></td><td>${esc(item.player.pista || "—")}</td><td class="points-cell">${item.points.toLocaleString("pt-BR")}</td><td><span class="${chipClass}">${situation}</span></td></tr>`;
  }).join("");
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
    return;
  }
  const scores = gameScores(game.id).map((score) => ({ score, player: getPlayer(score.player_id) })).filter((item) => item.player).sort((a, b) => String(a.player.pista).localeCompare(String(b.player.pista)) || a.player.nome.localeCompare(b.player.nome, "pt-BR"));
  $("currentGameTitle").textContent = game.nome;
  $("currentGameStatus").textContent = game.status === "final" ? "Final" : "Parcial";
  $("currentGameStatus").className = `status-pill status-pill--${game.status === "final" ? "success" : "warning"}`;
  body.innerHTML = scores.length ? scores.map(({ score, player }) => `<div class="current-row"><div class="current-player"><strong>${esc(player.nome)}</strong><span>Pista ${esc(player.pista || "—")}</span></div><div class="current-score"><strong>${score.pontos == null ? "—" : Number(score.pontos).toLocaleString("pt-BR")}</strong><span class="status-chip ${score.finalizado ? "status-chip--final" : "status-chip--partial"}">${score.finalizado ? "Final" : "Pendente"}</span></div></div>`).join("") : `<div class="empty-state"><span>Partida sem participantes.</span></div>`;
}

function renderGames() {
  $("gameCount").textContent = `${state.games.length} ${state.games.length === 1 ? "partida" : "partidas"}`;
  $("gamesList").innerHTML = state.games.length ? state.games.map((game) => {
    const scores = gameScores(game.id);
    const done = scores.filter((score) => score.finalizado && score.pontos != null).length;
    const total = scores.length;
    return `<button class="game-card ${game.id === state.activeGameId ? "game-card--active" : ""}" type="button" data-game-id="${esc(game.id)}"><div class="game-card-top"><span class="eyebrow">${fmtDate(game.created_at)}</span><span class="status-pill status-pill--${game.status === "final" ? "success" : "warning"}">${game.status === "final" ? "Final" : "Parcial"}</span></div><h4>${esc(game.nome)}</h4><p>${done} de ${total} resultados confirmados</p><div class="game-progress"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div></button>`;
  }).join("") : `<div class="empty-state empty-state--wide"><strong>Nenhuma partida cadastrada</strong><span>O administrador pode abrir a primeira partida.</span></div>`;
  document.querySelectorAll("[data-game-id]").forEach((button) => button.addEventListener("click", () => { state.activeGameId = button.dataset.gameId; render(); }));
}

function renderPlayerSelection() {
  const container = $("playerSelection");
  container.innerHTML = state.players.map((player) => `<label class="selection-item"><input type="checkbox" value="${esc(player.id)}" checked /><span><strong>${esc(player.nome)}</strong><small>Pista ${esc(player.pista || "—")} · ${esc(player.apelido_placar || "sem apelido")}</small></span></label>`).join("");
  $("playerSelectionEmpty").hidden = state.players.length > 0;
}

function renderPlayers() {
  $("playersList").innerHTML = state.players.length ? state.players.map((player) => `<div class="player-row"><div><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")} · Pista ${esc(player.pista || "—")}</small></div><button class="text-button text-button--danger" type="button" data-delete-player="${esc(player.id)}">Remover</button></div>`).join("") : `<p class="empty-inline">Nenhum participante cadastrado.</p>`;
  document.querySelectorAll("[data-delete-player]").forEach((button) => button.addEventListener("click", () => removePlayer(button.dataset.deletePlayer)));
}

function renderPhotoOptions() {
  const gameSelect = $("photoGame");
  const laneSelect = $("photoLane");
  const currentGameValue = gameSelect.value || state.activeGameId || state.games[0]?.id || "";
  gameSelect.innerHTML = state.games.map((game) => `<option value="${esc(game.id)}">${esc(game.nome)} · ${game.status === "final" ? "final" : "parcial"}</option>`).join("");
  if (state.games.some((game) => game.id === currentGameValue)) gameSelect.value = currentGameValue;
  const lanes = [...new Set(state.players.map((player) => player.pista).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "pt-BR", { numeric: true }));
  const currentLane = laneSelect.value || lanes[0] || "";
  laneSelect.innerHTML = lanes.map((lane) => `<option value="${esc(lane)}">Pista ${esc(lane)}</option>`).join("");
  if (lanes.includes(currentLane)) laneSelect.value = currentLane;
  updateReviewTable();
}

function playersOnLane(lane = $("photoLane").value) {
  return state.players.filter((player) => String(player.pista) === String(lane));
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
    const finalizado = suggestion ? false : Boolean(old?.finalizado);
    const hint = suggestion?.hint || (old?.pontos != null ? `Atual: ${old.pontos}` : "Aguardando leitura");
    return `<div class="review-row" data-review-player="${esc(player.id)}"><div class="review-player"><strong>${esc(player.nome)}</strong><small>${esc(player.apelido_placar || "sem apelido")} · pista ${esc(player.pista || "—")}</small></div><div class="review-score-wrap"><input class="review-score" type="number" min="0" max="300" step="1" inputmode="numeric" placeholder="—" value="${value === "" ? "" : esc(value)}" aria-label="Pontos de ${esc(player.nome)}" /><small>${esc(hint)}</small></div><label class="review-confirm"><input class="review-final" type="checkbox" ${finalizado ? "checked" : ""} /> confirmar</label></div>`;
  }).join("") : `<div class="empty-state"><strong>Nenhum jogador nessa pista</strong><span>Cadastre o participante com o número da pista antes de importar.</span></div>`;
  $("confirmPhotoButton").disabled = !rows.length;
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
  showToast("Sessão encerrada.", "info");
  render();
}

async function submitAuth(event) {
  event.preventDefault();
  if (!client) return;
  const { error } = await client.auth.signInWithPassword({ email: $("authEmail").value.trim(), password: $("authPassword").value });
  if (error) {
    $("authError").textContent = "Não foi possível entrar. Confira o e-mail e a senha.";
    $("authError").hidden = false;
    return;
  }
  setModal("authModal", false);
  await loadProfile();
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

async function submitProfile(event) {
  event.preventDefault();
  if (!client || !state.session) return;
  const errorElement = $("profileError");
  const file = $("profilePhoto").files?.[0];
  const nome = $("profileName").value.trim();
  errorElement.hidden = true;
  if (!file && !state.profile?.foto_path) {
    errorElement.textContent = "Adicione pelo menos uma foto para concluir o cadastro.";
    errorElement.hidden = false;
    return;
  }
  if (file && (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024)) {
    errorElement.textContent = "Escolha uma imagem JPG, PNG ou WebP de até 5 MB.";
    errorElement.hidden = false;
    return;
  }
  let fotoPath = state.profile?.foto_path;
  if (file) {
    const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    fotoPath = `${state.session.user.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await client.storage.from("profile-photos").upload(fotoPath, file, { contentType: file.type, upsert: false });
    if (uploadError) {
      errorElement.textContent = "Não foi possível enviar a foto. Tente novamente.";
      errorElement.hidden = false;
      return;
    }
  }
  const payload = { id: state.session.user.id, nome, foto_path: fotoPath, status: state.profile?.status || "pending" };
  const { data, error } = await client.from("profiles").upsert(payload).select("id,nome,foto_path,status").single();
  if (error) {
    if (file) await client.storage.from("profile-photos").remove([fotoPath]);
    errorElement.textContent = "Não foi possível salvar seu cadastro.";
    errorElement.hidden = false;
    return;
  }
  state.profile = data;
  setModal("profileModal", false);
  render();
  showToast("Perfil salvo e enviado para aprovação.", "success");
}

async function addPlayer() {
  const nome = $("playerName").value.trim();
  const apelido_placar = $("playerNickname").value.trim();
  const pista = $("playerLane").value.trim();
  if (!nome || !apelido_placar || !pista) return showToast("Preencha nome, apelido e pista.", "error");
  const row = { nome, apelido_placar, pista };
  if (!client) return showToast("Supabase não configurado.", "error");
  const { data, error } = await client.from("players").insert(row).select("id,nome,apelido_placar,pista").single();
  if (error) return showToast("Não foi possível cadastrar o participante.", "error");
  state.players.push(data);
  ["playerName", "playerNickname", "playerLane"].forEach((id) => $(id).value = "");
  renderPlayers(); renderPlayerSelection(); renderPhotoOptions();
  showToast(`${nome} foi cadastrado.`, "success");
}

async function removePlayer(id) {
  if (!window.confirm("Remover este participante? Pontuações já publicadas não serão apagadas.")) return;
  if (!client) return showToast("Supabase não configurado.", "error");
  const { error } = await client.from("players").delete().eq("id", id);
  if (error) return showToast("Não foi possível remover o participante.", "error");
  state.players = state.players.filter((player) => player.id !== id);
  render();
}

async function createGame(event) {
  event.preventDefault();
  const nome = $("gameName").value.trim();
  const playerIds = [...document.querySelectorAll("#playerSelection input:checked")].map((input) => input.value);
  if (!nome || !playerIds.length) return showToast("Informe um nome e selecione pelo menos um participante.", "error");
  if (!client) return showToast("Supabase não configurado.", "error");
  const { data, error } = await client.from("games").insert({ nome, status: "partial" }).select("id,nome,status,created_at,updated_at").single();
  if (error) return showToast("Não foi possível abrir a partida.", "error");
  const { data: insertedScores, error: scoresError } = await client.from("scores").insert(playerIds.map((player_id) => ({ game_id: data.id, player_id, pontos: null, finalizado: false }))).select("id,game_id,player_id,pontos,finalizado,updated_at");
  if (scoresError) { await client.from("games").delete().eq("id", data.id); return showToast("A partida foi desfeita porque os participantes não puderam ser vinculados.", "error"); }
  state.games.unshift(data); state.scores.push(...insertedScores);
  const game = data;
  state.activeGameId = game.id;
  setModal("gameModal", false); render(); showToast("Partida aberta.", "success");
}

function openGameModal() {
  $("gameName").value = `Partida ${state.games.length + 1}`;
  renderPlayerSelection(); setModal("gameModal", true);
}

function openPlayersModal() { renderPlayers(); setModal("playersModal", true); }

function openPhotoModal() {
  if (!state.games.length) return showToast("Abra uma partida antes de importar uma foto.", "error");
  resetPhotoState(); renderPhotoOptions(); setModal("photoModal", true);
}

function resetPhotoState() {
  state.crop = null; state.image = null; state.imageFile = null;
  $("photoInput").value = ""; $("canvasPlaceholder").hidden = false; $("photoCanvas").hidden = true; $("runOcrButton").disabled = true; $("confirmPhotoButton").disabled = true; $("ocrStatus").textContent = "Nenhuma imagem selecionada."; updateReviewTable();
}

function loadPhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  state.imageFile = file;
  const image = new Image();
  image.onload = () => {
    state.image = image;
    const canvas = $("photoCanvas");
    const scale = Math.min(1, 900 / image.naturalWidth);
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    canvas.hidden = false; $("canvasPlaceholder").hidden = true; drawCanvas(); $("runOcrButton").disabled = false; $("ocrStatus").textContent = "Imagem pronta. Recorte a região se quiser e leia as sugestões.";
  };
  image.src = URL.createObjectURL(file);
}

function drawCanvas() {
  const canvas = $("photoCanvas"); const context = canvas.getContext("2d");
  if (!state.image) return;
  context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(state.image, 0, 0, canvas.width, canvas.height);
  if (!state.crop) return;
  const { x, y, width, height } = state.crop;
  context.fillStyle = "rgba(18, 15, 12, .52)"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.clearRect(x, y, width, height); context.drawImage(state.image, x * state.image.naturalWidth / canvas.width, y * state.image.naturalHeight / canvas.height, width * state.image.naturalWidth / canvas.width, height * state.image.naturalHeight / canvas.height, x, y, width, height);
  context.strokeStyle = "#f4b86a"; context.lineWidth = 3; context.strokeRect(x, y, width, height);
}

function canvasPoint(event) {
  const rect = $("photoCanvas").getBoundingClientRect();
  return { x: Math.max(0, Math.min($("photoCanvas").width, event.clientX - rect.left)), y: Math.max(0, Math.min($("photoCanvas").height, event.clientY - rect.top)) };
}

function startCrop(event) {
  if (!state.image) return;
  const start = canvasPoint(event); state.crop = { x: start.x, y: start.y, width: 0, height: 0, startX: start.x, startY: start.y }; $("photoCanvas").setPointerCapture?.(event.pointerId);
}
function moveCrop(event) {
  if (!state.crop?.startX && state.crop?.startX !== 0) return;
  const point = canvasPoint(event); const startX = state.crop.startX; const startY = state.crop.startY;
  state.crop.x = Math.min(startX, point.x); state.crop.y = Math.min(startY, point.y); state.crop.width = Math.abs(point.x - startX); state.crop.height = Math.abs(point.y - startY); drawCanvas();
}
function endCrop() { if (state.crop && (state.crop.width < 12 || state.crop.height < 12)) state.crop = null; if (state.crop) { delete state.crop.startX; delete state.crop.startY; } drawCanvas(); }

async function runOcr() {
  if (!state.image || !window.Tesseract) return showToast("O leitor de texto não está disponível. Preencha a tabela manualmente.", "error");
  $("runOcrButton").disabled = true; $("confirmPhotoButton").disabled = true; $("ocrStatus").textContent = "Lendo a imagem… isso pode levar alguns segundos.";
  try {
    const source = getOcrCanvas();
    const result = await Tesseract.recognize(source, "por+eng", { logger: (info) => { if (info.status === "recognizing text") $("ocrStatus").textContent = `Lendo a imagem… ${Math.round((info.progress || 0) * 100)}%`; } });
    const suggestions = buildSuggestions(result.data.text || "");
    updateReviewTable(suggestions);
    $("ocrStatus").textContent = suggestions.size ? `OCR encontrou ${suggestions.size} sugestão(ões). Revise antes de confirmar.` : "OCR não encontrou associações confiáveis. Preencha a tabela manualmente.";
    $("confirmPhotoButton").disabled = false;
  } catch (error) {
    console.error(error); $("ocrStatus").textContent = "Não foi possível ler a foto. A conferência manual continua disponível."; updateReviewTable(); $("confirmPhotoButton").disabled = false;
  } finally { $("runOcrButton").disabled = false; }
}

function getOcrCanvas() {
  const source = document.createElement("canvas");
  const crop = state.crop && state.crop.width > 12 ? state.crop : { x: 0, y: 0, width: $("photoCanvas").width, height: $("photoCanvas").height };
  source.width = Math.round(crop.width * state.image.naturalWidth / $("photoCanvas").width); source.height = Math.round(crop.height * state.image.naturalHeight / $("photoCanvas").height);
  source.getContext("2d").drawImage(state.image, crop.x * state.image.naturalWidth / $("photoCanvas").width, crop.y * state.image.naturalHeight / $("photoCanvas").height, source.width, source.height, 0, 0, source.width, source.height);
  return source;
}

function buildSuggestions(text) {
  const suggestions = new Map(); const numbers = [...text.matchAll(/\b(?:[0-9]{1,3})\b/g)].map((match) => ({ value: Number(match[0]), index: match.index })).filter((item) => item.value <= 300);
  const used = new Set();
  playersOnLane().forEach((player, index) => {
    const aliases = [player.nome, player.apelido_placar].filter(Boolean).map(normalize);
    const textNormalized = normalize(text);
    const aliasIndex = aliases.map((alias) => textNormalized.indexOf(alias)).find((position) => position >= 0);
    let candidate = aliasIndex >= 0 ? numbers.find((item) => !used.has(item.index) && item.index >= aliasIndex) : numbers[index];
    if (!candidate || used.has(candidate.index)) return;
    used.add(candidate.index); suggestions.set(player.id, { value: candidate.value, hint: "Sugestão OCR · confira" });
  });
  return suggestions;
}

async function confirmPhotoUpdate(event) {
  event.preventDefault();
  const gameId = $("photoGame").value; const rows = [...document.querySelectorAll("[data-review-player]")];
  const updates = rows.map((row) => ({ player_id: row.dataset.reviewPlayer, pontos: row.querySelector(".review-score").value, finalizado: row.querySelector(".review-final").checked })).filter((row) => row.pontos !== "");
  if (!updates.length) return showToast("Preencha ao menos um total antes de confirmar.", "error");
  const timestamp = new Date().toISOString();
  if (!client) return showToast("Supabase não configurado.", "error");
  const payload = updates.map((update) => ({ game_id: gameId, player_id: update.player_id, pontos: Number(update.pontos), finalizado: update.finalizado }));
  const { data, error } = await client.from("scores").upsert(payload, { onConflict: "game_id,player_id" }).select("id,game_id,player_id,pontos,finalizado,updated_at");
  if (error) return showToast("Não foi possível salvar os pontos. Confira sua permissão de administrador.", "error");
  data.forEach((saved) => { const index = state.scores.findIndex((score) => score.game_id === saved.game_id && score.player_id === saved.player_id); if (index >= 0) state.scores[index] = saved; else state.scores.push(saved); });
  await updateGameStatus(gameId);
  state.activeGameId = gameId; setModal("photoModal", false); render(); showToast("Pontos confirmados e ranking atualizado.", "success");
}

async function updateGameStatus(gameId) {
  const game = getGame(gameId); const scores = gameScores(gameId);
  const final = scores.length > 0 && scores.every((score) => score.finalizado && score.pontos != null);
  game.status = final ? "final" : "partial"; game.updated_at = new Date().toISOString();
  if (!client) return;
  const { error } = await client.from("games").update({ status: game.status }).eq("id", gameId);
  if (error) console.error(error);
}

function initTheme() {
  const stored = localStorage.getItem("boliche-theme"); const dark = stored === "dark";
  document.documentElement.classList.toggle("dark", dark); $("themeToggle").textContent = dark ? "☀" : "◐";
  $("themeToggle").addEventListener("click", () => { const next = !document.documentElement.classList.contains("dark"); document.documentElement.classList.toggle("dark", next); localStorage.setItem("boliche-theme", next ? "dark" : "light"); $("themeToggle").textContent = next ? "☀" : "◐"; });
}

function bindEvents() {
  initTheme();
  $("authButton").addEventListener("click", openAuth); $("registerButton").addEventListener("click", openRegister); $("profileButton").addEventListener("click", openProfileModal); $("photoButton").addEventListener("click", openPhotoModal); $("newGameButton").addEventListener("click", openGameModal);
  $("gameForm").addEventListener("submit", createGame); $("authForm").addEventListener("submit", submitAuth); $("registerForm").addEventListener("submit", submitRegister); $("profileForm").addEventListener("submit", submitProfile); $("profilePhoto").addEventListener("change", () => { const file = $("profilePhoto").files?.[0]; if (file) $("profilePhotoName").textContent = file.name; }); $("playersForm").addEventListener("click", (event) => { if (event.target.id === "addPlayerButton") addPlayer(); });
  $("photoForm").addEventListener("submit", confirmPhotoUpdate); $("photoInput").addEventListener("change", loadPhoto); $("photoLane").addEventListener("change", () => updateReviewTable()); $("photoGame").addEventListener("change", () => updateReviewTable()); $("runOcrButton").addEventListener("click", runOcr); $("clearCropButton").addEventListener("click", () => { state.crop = null; drawCanvas(); });
  const canvas = $("photoCanvas"); canvas.addEventListener("pointerdown", startCrop); canvas.addEventListener("pointermove", moveCrop); canvas.addEventListener("pointerup", endCrop); canvas.addEventListener("pointercancel", endCrop);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()); });
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
  if (client) {
    const { data } = await client.auth.getSession(); state.session = data.session;
    await loadProfile();
    client.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      applyAuthUi();
      window.setTimeout(async () => { await loadProfile(); render(); showProfileIfNeeded(); }, 0);
    });
  }
  try { await loadData(); render(); showProfileIfNeeded(); subscribeRealtime(); } catch (error) { console.error(error); setConnection("Falha ao carregar", "error"); showToast("Não foi possível carregar o placar. Verifique o Supabase.", "error"); }
}

start();
