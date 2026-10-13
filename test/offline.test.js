const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');

// Exercise the real worker handlers with an in-memory implementation of Cache.
// This checks caching behavior; actual mobile browser lifecycle is a manual check.
async function worker() {
  const origin = 'https://notes.example.com';
  const handlers = {}, stores = new Map();
  let online = true, brokenAsset = false;
  let notebook = { title: '演講', revision: 1, pages: [{ id: 'a', title: '開場', content: '離線也能看\n第二行' }, { id: 'b', title: '結尾', content: '謝謝' }] };
  const key = input => new URL(typeof input === 'string' ? input : input.url, origin).pathname;
  class LocalRequest extends Request { constructor(url, options) { super(new URL(url, origin), options); } }
  const fetcher = async input => {
    if (!online) throw new TypeError('Network offline');
    const url = key(input);
    if (url === '/api/notebook') return Response.json(notebook);
    if (brokenAsset && url === '/app.js') return new Response('error', { status: 500 });
    return new Response('asset: ' + url);
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(input) { return store.get(key(input))?.clone(); },
        async put(input, response) { store.set(key(input), response.clone()); },
        async addAll(inputs) {
          const responses = await Promise.all(inputs.map(fetcher));
          if (responses.some(r => !r.ok)) throw new Error('Asset failed');
          inputs.forEach((input, i) => store.set(key(input), responses[i].clone()));
        }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  const self = { location: { origin }, addEventListener: (name, handler) => { handlers[name] = handler; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  vm.runInNewContext(await fs.readFile(require.resolve('../public/sw.js'), 'utf8'), { self, caches, fetch: fetcher, Response, Request: LocalRequest, URL, AbortSignal, Date });
  async function lifecycle(name) { let promise; handlers[name]({ waitUntil(p) { promise = p; } }); await promise; }
  async function message(type) {
    let promise, result;
    handlers.message({ data: { type }, ports: [{ postMessage(value) { result = value; } }], waitUntil(p) { promise = p; } });
    await promise; return result;
  }
  async function request(url, options) {
    let promise;
    handlers.fetch({ request: { url: new URL(url, origin).href, method: 'GET', mode: 'navigate', ...options }, respondWith(p) { promise = p; } });
    return promise;
  }
  return { lifecycle, message, request, stores, setOnline(value) { online = value; }, breakAsset() { brokenAsset = true; }, setNotebook(value) { notebook = value; } };
}

test('Download caches all pages and app shell for offline cold navigation', async () => {
  const w = await worker(); await w.lifecycle('install'); await w.lifecycle('activate');
  assert.equal((await w.message('STATUS')).info, null);
  const downloaded = await w.message('DOWNLOAD');
  assert.equal(downloaded.ok, true); assert.equal(downloaded.info.pages, 2);
  w.setOnline(false);
  assert.equal(await (await w.request('/?mode=read')).text(), 'asset: /');
  for (const asset of ['/app.js', '/styles.css', '/icon.svg', '/manifest.webmanifest']) assert.equal((await w.request(asset)).status, 200);
  const response = await w.request('/api/notebook');
  assert.equal(response.headers.get('X-Pocket-Offline'), '1');
  assert.equal((await response.json()).pages[0].content, '離線也能看\n第二行');
  assert.equal((await w.message('STATUS')).info.pages, 2);
});

test('failed refresh preserves previous snapshot; online reads do not silently replace it', async () => {
  const w = await worker(); await w.lifecycle('install');
  await w.message('DOWNLOAD');
  w.setNotebook({ title: '新的內容', revision: 2, pages: [{ id: 'new', title: '新頁', content: '新版' }] });
  assert.equal((await (await w.request('/api/notebook')).json()).revision, 2);
  assert.equal((await w.message('STATUS')).info.revision, 1);
  w.breakAsset();
  assert.equal((await w.message('DOWNLOAD')).ok, false);
  w.setOnline(false);
  assert.equal((await (await w.request('/api/notebook')).json()).revision, 1);
  assert.equal((await w.message('DOWNLOAD')).ok, false);
  assert.equal((await w.message('SNAPSHOT')).notebook.revision, 1);
});

test('without a Download there is no false claim of offline notes; writes never use cache', async () => {
  const w = await worker(); await w.lifecycle('install'); w.setOnline(false);
  assert.equal((await w.request('/api/notebook')).status, 503);
  assert.equal((await w.message('SNAPSHOT')).ok, false);
  assert.equal(await w.request('/api/notebook', { method: 'PUT' }), undefined);
  assert.equal(await w.request('https://other.example.com/'), undefined);
});

test('worker upgrade cleans old shell caches but keeps downloaded notes', async () => {
  const w = await worker(); await w.lifecycle('install'); await w.message('DOWNLOAD');
  w.stores.set('pocket-notes-shell-v0', new Map());
  w.stores.set('unrelated-app', new Map());
  await w.lifecycle('activate');
  assert.equal(w.stores.has('pocket-notes-shell-v0'), false);
  assert.equal(w.stores.has('unrelated-app'), true);
  assert.equal((await w.message('STATUS')).info.pages, 2);
});
