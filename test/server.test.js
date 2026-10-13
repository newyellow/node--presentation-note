const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function setup(t, dataDir) {
  const dir = dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-notes-test-'));
  const app = await createApp({ dataDir: dir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.drain();
    if (!dataDir) await fs.rm(dir, { recursive: true, force: true });
  });
  const put = (data, options = {}) => fetch(`${base}/api/notebook`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...options.headers }, body: typeof data === 'string' ? data : JSON.stringify(data) });
  return { ...app, base, dir, put };
}

test('serves app assets and refuses filesystem access', async t => {
  const { base } = await setup(t);
  for (const route of ['/', '/app.js', '/styles.css', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/healthz']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const route of ['/server.js', '/data/notebook.json', '/.env', '/.git/config', '/%2e%2e/server.js']) assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(base + '/api/notebook', { method: 'DELETE' })).status, 405);
});

test('create, reorder, delete and unicode content survive server restart', async t => {
  const { base, put, dir, server } = await setup(t);
  const current = await (await fetch(base + '/api/notebook')).json();
  current.title = '測試小抄';
  current.pages = [{ id: 'second', title: '第二頁', content: '你好\n\n<script>alert("plain text")</script> 🎤' }, { id: 'first', title: '第一頁', content: '' }];
  const response = await put(current);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.pages, current.pages);
  await new Promise(resolve => server.close(resolve));
  const restarted = await setup(t, dir);
  assert.deepEqual(await (await fetch(restarted.base + '/api/notebook')).json(), saved);
  saved.pages.splice(0, 1);
  const deleted = await restarted.put(saved);
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).pages.length, 1);
});

test('serializes concurrent writes and prevents stale device overwrite', async t => {
  const { base, put } = await setup(t);
  const current = await (await fetch(base + '/api/notebook')).json();
  const responses = await Promise.all([put({ ...current, title: '裝置 A' }), put({ ...current, title: '裝置 B' })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await (await fetch(base + '/api/notebook')).json()).revision, 1);
  assert.equal((await put(current)).status, 409);
});

test('rejects malformed, oversized and cross-site writes without changing data', async t => {
  const { base, put } = await setup(t);
  const current = await (await fetch(base + '/api/notebook')).json();
  assert.equal((await put('{')).status, 400);
  assert.equal((await put({ ...current, pages: [] })).status, 400);
  assert.equal((await put({ ...current, pages: [current.pages[0], current.pages[0]] })).status, 400);
  assert.equal((await put({ ...current, title: ' ' })).status, 400);
  assert.equal((await put({ ...current, pages: [{ ...current.pages[0], content: 'a'.repeat(50001) }] })).status, 400);
  assert.equal((await put(current, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await put(current, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await put(' '.repeat(2 * 1024 * 1024 + 1))).status, 413);
  assert.deepEqual(await (await fetch(base + '/api/notebook')).json(), current);
});

test('fails startup on corrupt data rather than replacing notes with defaults', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-notes-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, 'notebook.json'), '{ broken');
    await assert.rejects(createApp({ dataDir: dir }));
    assert.equal(await fs.readFile(path.join(dir, 'notebook.json'), 'utf8'), '{ broken');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
