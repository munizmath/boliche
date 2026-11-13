const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp(client = null) {
  const elements = new Map();
  const rows = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '' });
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
    document, URLSearchParams, Intl, atob, console,
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
    .replace(/\nstart\(\);\s*$/, '\n');
  vm.runInContext(`${source}\nrender = () => {};\nglobalThis.testApp = { state, buildSuggestions, playersOnLane, updatePhotoConfirmState, canvasPoint, renderLeaderboard, renderCurrentGame, confirmPhotoUpdate, submitAuth };`, context);
  return { ...context.testApp, get, rows, document };
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

test('conferência manual habilita salvar somente alteração válida', () => {
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
  assert.equal(app.get('confirmPhotoButton').disabled, false);
  assert.equal(hint.textContent, '— → 213');
  value = '301';
  app.updatePhotoConfirmState();
  assert.equal(app.get('confirmPhotoButton').disabled, true);
  value = '213'; row.dataset.oldScore = '213'; row.dataset.oldFinal = 'true';
  app.updatePhotoConfirmState();
  assert.equal(app.get('confirmPhotoButton').disabled, true);
  checked = false;
  app.updatePhotoConfirmState();
  assert.equal(app.get('confirmPhotoButton').disabled, false);
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
  const client = {
    rpc: async (name, payload) => { call = { name, payload }; return { error: new Error('simulated') }; },
    from: () => { throw new Error('importação não deve escrever diretamente nas tabelas'); },
  };
  const app = loadApp(client);
  app.get('photoGame').value = 'game-1';
  app.rows.push({
    dataset: { reviewPlayer: 'ana' },
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
