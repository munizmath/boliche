const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp(client = null) {
  const elements = new Map();
  const rows = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '', focus() {} });
    return elements.get(id);
  };
  const document = {
    getElementById: get,
    querySelectorAll: (selector) => selector === '[data-review-player]' ? rows : [],
    createElement: () => ({ textContent: '', remove() {} }),
  };
  get('toastContainer').append = () => {};
  const context = vm.createContext({
    window: { SUPABASE_CONFIG: client ? { url: 'https://example.test', publishableKey: 'test' } : {}, supabase: client ? { createClient: () => client } : null, location: { hash: '', search: '' }, setTimeout: () => {} },
    document, URLSearchParams, Intl, atob, console, crypto: { randomUUID: () => 'photo-id' },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
    .replace(/\nstart\(\);\s*$/, '\n');
  vm.runInContext(`${source}\nrender = () => {};\nglobalThis.testApp = { state, buildSuggestions, playersOnLane, updatePhotoConfirmState, canvasPoint, renderLeaderboard, renderCurrentGame, confirmPhotoUpdate, submitAuth, submitProfile, prepareProfilePhoto };`, context);
  return { ...context.testApp, get, rows, document, context };
}

test('OCR só sugere total da última coluna para jogadores vinculados à partida e pista', () => {
  const app = loadApp();
  app.state.players = [
    { id: 'ana', nome: 'Ana Horta', apelido_placar: 'ANA', pista: '1' },
    { id: 'bruno', nome: 'Bruno', apelido_placar: 'BRUNO', pista: '2' },
    { id: 'outro', nome: 'Outro', apelido_placar: 'OUTRO', pista: '1' },
  ];
  app.state.scores = [{ game_id: 'game', player_id: 'ana' }, { game_id: 'game', player_id: 'bruno' }];
  app.get('photoGame').value = 'game';
  app.get('photoLane').value = '1';
  const result = app.buildSuggestions('ANA 10 42 213\nBRUNO 16 200\nOUTRO 30 250');
  assert.equal(result.get('ana').value, 213);
  assert.equal(result.has('bruno'), false);
  assert.equal(result.has('outro'), false);
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

test('recorte converte coordenadas CSS para resolução interna do canvas', () => {
  const app = loadApp();
  const canvas = { width: 900, height: 600, getBoundingClientRect: () => ({ left: 10, top: 20, width: 450, height: 300 }) };
  app.document.getElementById = (id) => id === 'photoCanvas' ? canvas : app.get(id);
  const point = app.canvasPoint({ clientX: 235, clientY: 170 });
  assert.equal(point.x, 450);
  assert.equal(point.y, 300);
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

for (const existing of [false, true, 'stale']) {
  test(`${existing === 'stale' ? 'perfil recarregado após renovação de sessão troca' : existing ? 'perfil aprovado troca' : 'primeiro perfil envia'} foto e salva cadastro`, async () => {
    let upload;
    let write;
    const profile = { id: 'user-1', nome: 'Matheus', foto_path: 'user-1/photo-id.jpg', status: existing ? 'approved' : 'pending', player_id: existing ? 'player-1' : null };
    const query = {
      eq: () => query,
      select: () => query,
      single: async () => ({ data: profile, error: null }),
    };
    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }) },
      storage: { from: () => ({ upload: async (path, body, options) => { upload = { path, body, options }; return { error: null }; }, createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/photo.jpg' } }) }) },
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existing === 'stale' ? { ...profile, foto_path: 'user-1/old.jpg' } : null, error: null }) }) }),
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
