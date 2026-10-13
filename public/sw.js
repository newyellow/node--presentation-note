'use strict';
// Bump this version whenever app shell assets change.
const SHELL = 'pocket-notes-shell-v2';
const DATA = 'pocket-notes-download-v1';
const ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];
const SNAPSHOT = '/api/notebook';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('pocket-notes-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
async function snapshot() {
  const response = await (await caches.open(DATA)).match(SNAPSHOT);
  if (!response) throw new Error('尚未下載筆記，請先連網按 Download。');
  return response;
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname === SNAPSHOT) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { signal: AbortSignal.timeout(5000) });
        if (response.status < 500) return response;
      } catch {}
      try { return await snapshot(); }
      catch { return Response.json({ error: '無法連線且尚未下載離線筆記。' }, { status: 503 }); }
    })());
    return;
  }
  if (event.request.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname)) {
    event.respondWith((async () => (await (await caches.open(SHELL)).match('/')) || fetch(event.request))());
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith((async () => (await (await caches.open(SHELL)).match(url.pathname)) || fetch(event.request))());
  }
});
let downloading;
async function download() {
  // Fetch everything successfully before replacing the last usable snapshot.
  const response = await fetch(SNAPSHOT, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('筆記下載失敗，請確認連線或登入狀態。');
  const notebook = await response.json();
  if (!Array.isArray(notebook.pages) || !notebook.pages.length) throw new Error('筆記格式不正確。');
  const info = { downloadedAt: new Date().toISOString(), pages: notebook.pages.length, revision: notebook.revision };
  const cache = await caches.open(SHELL);
  // addAll atomically refreshes the complete shell before committing the data.
  await cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload', signal: AbortSignal.timeout(15000) })));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Pocket-Offline': '1', 'X-Pocket-Downloaded-At': info.downloadedAt };
  await (await caches.open(DATA)).put(SNAPSHOT, new Response(JSON.stringify(notebook), { headers }));
  return { ok: true, info, notebook };
}
self.addEventListener('message', event => {
  const port = event.ports[0]; if (!port) return;
  event.waitUntil((async () => {
    try {
      if (event.data.type === 'DOWNLOAD') {
        if (!downloading) downloading = download().finally(() => { downloading = undefined; });
        port.postMessage(await downloading);
      } else if (event.data.type === 'SNAPSHOT') {
        port.postMessage({ ok: true, notebook: await (await snapshot()).json() });
      } else if (event.data.type === 'STATUS') {
        const response = await (await caches.open(DATA)).match(SNAPSHOT);
        const notebook = response ? await response.clone().json() : undefined;
        port.postMessage({ ok: true, info: response ? { downloadedAt: response.headers.get('X-Pocket-Downloaded-At'), pages: notebook.pages.length, revision: notebook.revision } : null });
      }
    } catch (error) { port.postMessage({ ok: false, error: error.message || '下載失敗，請稍後重試。' }); }
  })());
});
