const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const context = { self: { addEventListener() {} }, URL };
vm.runInNewContext(`${worker}\nglobalThis.shellAssets = SHELL;`, context);

test('o cache PWA inclui as versões carregadas pela página', () => {
  const shell = new Set(context.shellAssets);
  const assets = [...html.matchAll(/<(script|link)\b([^>]+)>/g)]
    .filter((match) => match[1] === 'script' || /\brel="stylesheet"/.test(match[2]))
    .map((match) => match[2].match(/\b(?:src|href)="([^"]+)"/)?.[1])
    .filter((url) => url && !/^https?:\/\//.test(url));
  for (const asset of assets) {
    assert.ok(shell.has(`./${asset}`), `${asset} está fora do shell offline`);
    assert.ok(fs.existsSync(path.join(root, asset.split('?')[0])), `${asset} não existe`);
  }
  assert.ok(assets.some((asset) => asset.startsWith('styles.css?')));
  assert.ok(assets.some((asset) => asset.startsWith('jogatina-qr.js?')));
});
