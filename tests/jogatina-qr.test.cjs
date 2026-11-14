const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const qr = require('../jogatina-qr.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'jogatina-qr.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('toDataURL retorna Promise com QR SVG autossuficiente e determinístico', async () => {
  const url = 'https://jogatina.example/placar?encontro=quiz-42&nome=São%20João';
  const result = qr.toDataURL(url);
  assert.equal(typeof result.then, 'function');

  const dataUrl = await result;
  assert.match(dataUrl, /^data:image\/svg\+xml;charset=utf-8,/);
  const svg = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));
  assert.match(svg, /<svg[^>]+width="220" height="220"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<path/);
  assert.equal(await qr.toDataURL(url), dataUrl);
  assert.notEqual(await qr.toDataURL('https://jogatina.example/?encontro=outro'), dataUrl);
});

test('toDataURL rejeita conteúdo ausente e dados maiores que a capacidade QR', async () => {
  await assert.rejects(qr.toDataURL(''), /URL string is required/);
  await assert.rejects(qr.toDataURL(null), /URL string is required/);
  await assert.rejects(qr.toDataURL(`https://example.com/${'x'.repeat(5000)}`), /too big/i);
});

test('HTML carrega o gerador local e descreve o encontro selecionado', () => {
  assert.match(html, /<img id="shareQr"[^>]*>/);
  assert.match(html, /jogatina-qr\.js\?v=/);
  assert.ok(html.indexOf('jogatina-qr.js') < html.indexOf('app.js?v='));
  assert.match(html, /QR Code e o link abrem o encontro selecionado/);
  assert.doesNotMatch(html, /<img[^>]+src="share-qr\.png"/);
});

test('módulo grava sua cópia local no cache shell ativo para uso offline', async () => {
  let openedCache;
  const cachedUrls = [];
  const cacheStorage = {
    async keys() { return ['jogatina-shell-v22', 'jogatina-shell-v23', 'outro-cache']; },
    async open(name) {
      openedCache = name;
      return { async add(url) { cachedUrls.push(url); } };
    },
  };
  const documentObject = {
    currentScript: { src: 'https://jogatina.example/jogatina-qr.js?v=20261114-01' },
    location: { href: 'https://jogatina.example/' },
    getElementById() { return null; },
  };
  const windowObject = {
    document: documentObject,
    location: new URL('https://jogatina.example/'),
    caches: cacheStorage,
  };
  vm.runInNewContext(source, { window: windowObject, Promise, URL });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(openedCache, 'jogatina-shell-v23');
  assert.deepEqual(cachedUrls, ['https://jogatina.example/jogatina-qr.js?v=20261114-01']);
});

test('integração do diálogo atualiza o QR com o href do encontro selecionado', async () => {
  const dialog = {
    open: false,
    querySelector(selector) {
      assert.equal(selector, '.share-link');
      return link;
    },
  };
  const image = { dataset: {}, src: '', alt: '', hidden: false };
  const status = { hidden: true, textContent: '' };
  const link = { href: 'https://jogatina.example/?encontro=quiz-1', textContent: 'Quiz de sexta' };
  let observer;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(target, options) {
      assert.equal(target, dialog);
      assert.equal(options.attributes, true);
      assert.equal(options.attributeFilter.length, 1);
      assert.equal(options.attributeFilter[0], 'open');
    }
  }
  const documentObject = {
    defaultView: { MutationObserver: FakeMutationObserver },
    getElementById(id) {
      return { shareModal: dialog, shareQr: image, shareQrStatus: status }[id] || null;
    },
  };
  const windowObject = { document: documentObject, MutationObserver: FakeMutationObserver };
  vm.runInNewContext(source, { window: windowObject, Promise, Uint8Array, Uint32Array, TextEncoder });
  assert.equal(typeof windowObject.JogatinaQR.toDataURL, 'function');
  assert.match(await windowObject.JogatinaQR.toDataURL(link.href), /^data:image\/svg\+xml;charset=utf-8,/);

  dialog.open = true;
  observer.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(image.dataset.qrUrl, link.href, status.textContent);
  assert.match(image.src, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(image.alt, 'QR Code para abrir Quiz de sexta');
  assert.equal(image.hidden, false);
  assert.equal(status.hidden, true);

  link.href = 'https://jogatina.example/?encontro=gincana-2';
  link.textContent = 'Gincana de sábado';
  observer.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(image.dataset.qrUrl, link.href);
  assert.equal(image.alt, 'QR Code para abrir Gincana de sábado');
});
