const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC = path.join(__dirname, 'public');
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function validateNotebook(input) {
  if (!input || !Number.isInteger(input.revision) || input.revision < 0 ||
      typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100 ||
      !Array.isArray(input.pages) || !input.pages.length || input.pages.length > 200) {
    throw new ApiError(400, '需要筆記標題與 1–200 頁內容。');
  }
  const ids = new Set();
  const pages = input.pages.map(page => {
    if (!page || typeof page.id !== 'string' || !/^[\w-]{1,80}$/.test(page.id) || ids.has(page.id) ||
        typeof page.title !== 'string' || !page.title.trim() || page.title.length > 100 ||
        typeof page.content !== 'string' || page.content.length > 50000) {
      throw new ApiError(400, '頁面格式不正確；標題限 100 字、內文限 50,000 字，頁面 ID 不可重複。');
    }
    ids.add(page.id);
    return { id: page.id, title: page.title.trim(), content: page.content };
  });
  return { title: input.title.trim(), revision: input.revision, pages };
}

function initialNotebook() {
  return {
    title: '我的演講小抄', revision: 0, updatedAt: new Date().toISOString(),
    pages: [
      { id: randomUUID(), title: '開場 · 先深呼吸', content: '抬頭，微笑，停留兩秒。\n\n大家好，很高興今天能在這裡，\n和大家分享我的想法。\n\n先從一個簡單的問題開始：\n如果只能帶走一個重點，\n我希望大家記住什麼？' },
      { id: randomUUID(), title: '重點 · 三件小事', content: '一、說出核心想法\n用一句話，把最重要的事情說清楚。\n\n二、分享一個例子\n讓抽象的概念，變成具體的畫面。\n\n三、留一點空白\n慢慢說，給自己和聽眾思考的時間。' },
      { id: randomUUID(), title: '結尾 · 留下邀請', content: '回到今天最重要的那個想法。\n\n我們不需要一次做到完美，\n只需要從下一個小小的行動開始。\n\n謝謝大家。\n\n［停頓，抬頭，準備回答問題］' }
    ]
  };
}

async function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data') } = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  const filename = path.join(dataDir, 'notebook.json');
  let notebook;
  async function persist(value) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  try {
    notebook = JSON.parse(await fs.readFile(filename, 'utf8'));
    validateNotebook(notebook);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    notebook = initialNotebook();
    await persist(notebook);
  }
  let writes = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz' && req.method === 'GET') return json(200, { status: 'ok' });
      if (url.pathname === '/api/notebook') {
        if (req.method === 'GET') return json(200, notebook);
        if (req.method !== 'PUT') { res.setHeader('Allow', 'GET, PUT'); return json(405, { error: '不支援此操作。' }); }
        // JSON-only + no CORS, and reject cross-origin browser writes.
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, '不接受跨站儲存。');
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, '請使用 application/json。');
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BYTES) throw new ApiError(413, '筆記資料不可超過 2 MB。');
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ApiError(400, 'JSON 格式不正確。'); }
        const validated = validateNotebook(input);
        const operation = writes.then(async () => {
          if (validated.revision !== notebook.revision) throw new ApiError(409, '其他裝置已更新筆記。請先匯出草稿，再重新載入最新內容。');
          const next = { ...validated, revision: notebook.revision + 1, updatedAt: new Date().toISOString() };
          await persist(next);
          notebook = next;
          return next;
        });
        writes = operation.catch(() => {});
        return json(200, await operation);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: '不支援此操作。' });
      const asset = ASSETS.get(url.pathname);
      if (!asset) return json(404, { error: '找不到頁面。' });
      const body = await fs.readFile(path.join(PUBLIC, asset[0]));
      res.writeHead(200, {
        'Content-Type': asset[1], 'Content-Length': body.length,
        'Cache-Control': 'no-cache', ...(url.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {})
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (!error.status) console.error(error);
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : '伺服器暫時無法處理請求。' });
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, drain: () => writes };
}

if (require.main === module) {
  createApp().then(({ server, drain }) => {
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 3000);
    server.listen(port, host, () => {
      console.log(`Pocket Notes: http://${host}:${server.address().port}`);
      if (process.send) process.send('ready');
    });
    server.on('error', error => { console.error(error); process.exitCode = 1; });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const timer = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 9000).unref();
      server.close(async () => { await drain(); clearTimeout(timer); process.exit(0); });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { createApp, validateNotebook };
