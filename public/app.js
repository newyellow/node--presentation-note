'use strict';
const $ = id => document.getElementById(id);
const DRAFT_KEY = 'pocket-notes-draft-v1';
let notebook, index = 0, dirty = false, saving = false, downloading = false;
let fontSize = 26, toastTimer, workerReady;

function storeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storeSet(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
function storeRemove(key) { try { localStorage.removeItem(key); } catch {} }
function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function ask(title, description, action = '確定') {
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-action').textContent = action;
  return new Promise(resolve => {
    $('confirm-dialog').addEventListener('close', () => resolve($('confirm-dialog').returnValue === 'confirm'), { once: true });
    $('confirm-dialog').showModal();
  });
}
function page() { return notebook.pages[index]; }
function updateNetwork() {
  $('network-label').textContent = navigator.onLine ? '已連線' : '離線模式';
  $('network-dot').classList.toggle('offline', !navigator.onLine);
  updateButtons();
}
function updateButtons() {
  const available = !!notebook;
  for (const id of ['notebook-title', 'page-title', 'page-content', 'add-page', 'export', 'open-reader']) $(id).disabled = !available || saving || downloading;
  $('save').disabled = !available || !dirty || saving || downloading || !navigator.onLine;
  $('save').textContent = saving ? '儲存中…' : '儲存筆記';
  $('download').disabled = !available || !workerReady || downloading || saving || !navigator.onLine;
  $('download').querySelector('span').textContent = downloading ? '下載中…' : 'Download 到這台裝置';
  $('reload').disabled = saving || downloading;
  $('delete-page').disabled = !available || notebook.pages.length === 1 || saving || downloading;
  $('add-page').disabled = !available || notebook.pages.length >= 200 || saving || downloading;
  $('move-up').disabled = !available || index === 0 || saving || downloading;
  $('move-down').disabled = !available || index === notebook.pages.length - 1 || saving || downloading;
  $('save-state').textContent = saving ? '正在保存到伺服器' : dirty ? (navigator.onLine ? '未儲存 · 本機草稿' : '離線 · 本機草稿') : '已儲存';
}
function rememberDraft() {
  dirty = true;
  if (!storeSet(DRAFT_KEY, JSON.stringify(notebook))) toast('瀏覽器無法保存本機草稿，請先匯出備份。');
  updateButtons();
}
function renderList() {
  $('page-list').replaceChildren();
  notebook.pages.forEach((item, i) => {
    const button = document.createElement('button');
    button.className = 'page-item' + (i === index ? ' active' : '');
    button.setAttribute('aria-current', i === index ? 'page' : 'false');
    const number = document.createElement('span'); number.className = 'number'; number.textContent = String(i + 1).padStart(2, '0');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = item.title || '未命名頁面';
    const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = '↗';
    button.append(number, name, mark); button.addEventListener('click', () => { index = i; render(); });
    $('page-list').append(button);
  });
  $('page-count').textContent = `${notebook.pages.length} 頁`;
}
function renderContent() {
  const p = page(); const position = `${String(index + 1).padStart(2, '0')} / ${String(notebook.pages.length).padStart(2, '0')}`;
  $('character-count').textContent = `${Array.from(p.content).length.toLocaleString()} 字 · 純文字`;
  $('editor-number').textContent = `PAGE ${String(index + 1).padStart(2, '0')}`;
  for (const prefix of ['preview', 'reader']) {
    $(`${prefix}-title`).textContent = p.title || '未命名頁面';
    $(`${prefix}-content`).textContent = p.content;
    $(`${prefix}-number`).textContent = position;
    $(`${prefix}-position`).textContent = position;
    $(`${prefix}-notebook`).textContent = notebook.title || '我的小抄';
    $(`${prefix}-prev`).disabled = index === 0;
    $(`${prefix}-next`).disabled = index === notebook.pages.length - 1;
  }
  $('reader-progress').style.width = `${(index + 1) / notebook.pages.length * 100}%`;
  $('reader-hint').textContent = index === notebook.pages.length - 1 ? '最後一頁 · 從容收尾' : '左側上一頁 · 右側下一頁';
}
function render() {
  index = Math.max(0, Math.min(index, notebook.pages.length - 1));
  $('notebook-title').value = notebook.title; $('page-title').value = page().title; $('page-content').value = page().content;
  renderList(); renderContent(); updateButtons();
  storeSet('pocket-notes-page', page().id);
}
function turn(direction) {
  if (!notebook) return;
  const next = index + direction;
  if (next < 0 || next >= notebook.pages.length) return;
  index = next; render(); $('reader-surface').scrollTop = 0;
}
function setReader(open) {
  if (!notebook) return;
  $('reader').hidden = !open; $('workspace').hidden = open; document.body.classList.toggle('reading', open);
  const url = new URL(location.href);
  if (open) url.searchParams.set('mode', 'read'); else url.searchParams.set('mode', 'edit');
  history.replaceState(null, '', url);
  if (open) { renderContent(); $('reader-surface').focus({ preventScroll: true }); }
  else $('open-reader').focus();
}
async function saveNotebook() {
  if (!dirty) return true;
  if (!navigator.onLine) { toast('目前離線。草稿保留在這台裝置，連線後可再儲存。'); return false; }
  if (!notebook.title.trim() || notebook.pages.some(p => !p.title.trim())) { toast('請填寫筆記名稱與每一頁的標題。'); return false; }
  saving = true; updateButtons();
  try {
    const response = await fetch('/api/notebook', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(notebook), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '儲存失敗，請稍後重試。');
    notebook = result; dirty = false; storeRemove(DRAFT_KEY); render(); toast('筆記已儲存。要更新手機離線版本，請再按 Download。');
    return true;
  } catch (error) { toast(error.message || '無法連線，草稿仍保留在這台裝置。'); return false; }
  finally { saving = false; updateButtons(); }
}
function workerMessage(type) {
  return new Promise(async (resolve, reject) => {
    let timer, channel;
    try {
      const registration = await workerReady;
      if (!registration.active) throw new Error('離線功能尚未準備好，請重新整理後再試。');
      channel = new MessageChannel();
      timer = setTimeout(() => { channel.port1.close(); reject(new Error('下載逾時，請確認連線後重試。')); }, 45000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); event.data.ok ? resolve(event.data) : reject(new Error(event.data.error)); };
      registration.active.postMessage({ type }, [channel.port2]);
    } catch (error) { clearTimeout(timer); channel?.port1.close(); reject(error); }
  });
}
function showDownloadInfo(info) {
  $('download-status').textContent = info ? `已下載 ${info.pages} 頁 · ${new Date(info.downloadedAt).toLocaleString('zh-TW', { hour12: false })} · 此裝置可離線閱讀` : '下載介面和所有頁面到這台裝置，沒有網路也不慌。';
}
async function downloadNotebook() {
  if (downloading || saving) return;
  if (!(await saveNotebook())) return;
  downloading = true; updateButtons();
  try {
    const result = await workerMessage('DOWNLOAD');
    showDownloadInfo(result.info);
    if (result.notebook) { notebook = result.notebook; render(); }
    const persistent = await navigator.storage?.persist?.().catch(() => false);
    toast(`下載完成，現在可離線開啟 ${result.info.pages} 頁。${persistent ? '' : '請保留此網站的瀏覽器資料。'}`);
  } catch (error) { toast(error.message || '下載失敗，請確認網路後重試。'); }
  finally { downloading = false; updateButtons(); }
}
function exportNotebook() {
  if (!notebook) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(notebook, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'pocket-notes-backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function loadNotebook({ restoreDraft = true } = {}) {
  try {
    const response = await fetch('/api/notebook', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('無法讀取筆記，請確認登入與伺服器狀態。');
    notebook = await response.json(); dirty = false;
    if (response.headers.get('X-Pocket-Offline')) toast('正在閱讀上次 Download 的離線版本。');
  } catch (error) {
    // A slow network may time out before the worker returns its fallback.
    if (workerReady) {
      try { notebook = (await workerMessage('SNAPSHOT')).notebook; dirty = false; } catch {}
    }
    if (!notebook && !storeGet(DRAFT_KEY)) { toast('尚無離線資料。請先連網開啟並按 Download。'); $('save-state').textContent = '讀取失敗'; return; }
    toast('無法連線，使用這台裝置保存的內容。');
  }
  if (restoreDraft) {
    try {
      const draft = JSON.parse(storeGet(DRAFT_KEY));
      if (draft && Array.isArray(draft.pages) && draft.pages.length) {
        const conflict = notebook && draft.revision !== notebook.revision;
        notebook = draft; dirty = true;
        toast(conflict ? '已還原本機草稿；伺服器有較新版本。請先匯出備份再重新載入。' : '已還原這台裝置上尚未儲存的草稿。');
      }
    } catch { toast('本機草稿無法讀取，請使用匯出備份還原內容。'); }
  }
  if (!notebook) return;
  index = Math.max(0, notebook.pages.findIndex(p => p.id === storeGet('pocket-notes-page')));
  render();
}

$('notebook-title').addEventListener('input', event => { notebook.title = event.target.value; rememberDraft(); renderContent(); });
$('page-title').addEventListener('input', event => { page().title = event.target.value; rememberDraft(); renderList(); renderContent(); });
$('page-content').addEventListener('input', event => { page().content = event.target.value; rememberDraft(); renderContent(); });
$('add-page').addEventListener('click', () => {
  const id = globalThis.crypto?.randomUUID?.() || `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  notebook.pages.push({ id, title: '新的一頁', content: '' }); index = notebook.pages.length - 1; rememberDraft(); render(); $('page-title').focus(); $('page-title').select();
});
$('delete-page').addEventListener('click', async () => {
  if (notebook.pages.length <= 1) return;
  const id = page().id;
  if (await ask('刪除這一頁？', `「${page().title}」的內容將從筆記中移除，儲存後會同步到伺服器。`, '刪除頁面')) {
    notebook.pages = notebook.pages.filter(p => p.id !== id); rememberDraft(); render();
  }
});
for (const [id, direction] of [['move-up', -1], ['move-down', 1]]) $(id).addEventListener('click', () => {
  const next = index + direction; if (next < 0 || next >= notebook.pages.length) return;
  [notebook.pages[index], notebook.pages[next]] = [notebook.pages[next], notebook.pages[index]];
  index = next; rememberDraft(); render();
});
for (const prefix of ['preview', 'reader']) {
  $(`${prefix}-prev`).addEventListener('click', () => turn(-1));
  $(`${prefix}-next`).addEventListener('click', () => turn(1));
}
$('open-reader').addEventListener('click', () => setReader(true));
$('close-reader').addEventListener('click', () => setReader(false));
$('save').addEventListener('click', saveNotebook);
$('download').addEventListener('click', downloadNotebook);
$('export').addEventListener('click', exportNotebook);
$('reload').addEventListener('click', async () => {
  if (dirty && !(await ask('重新載入最新筆記？', '這台裝置的未儲存草稿將被取代。需要保留時，請先取消並匯出備份。', '取代草稿'))) return;
  storeRemove(DRAFT_KEY); dirty = false; notebook = undefined; updateButtons();
  await loadNotebook({ restoreDraft: false });
});
function changeFont(amount) { fontSize = Math.max(18, Math.min(44, fontSize + amount)); $('reader').style.setProperty('--reader-font', `${fontSize}px`); storeSet('pocket-notes-font', String(fontSize)); }
$('font-smaller').addEventListener('click', () => changeFont(-2));
$('font-larger').addEventListener('click', () => changeFont(2));
// Measure motion AND scroll: a drag/scroll must not accidentally change pages.
let gesture;
$('reader-surface').addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) { gesture = undefined; return; }
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: $('reader-surface').scrollTop, time: Date.now(), moved: false };
});
$('reader-surface').addEventListener('pointermove', event => {
  if (gesture && (Math.abs(event.clientX - gesture.x) > 12 || Math.abs(event.clientY - gesture.y) > 12)) gesture.moved = true;
});
$('reader-surface').addEventListener('pointercancel', () => { gesture = undefined; });
$('reader-surface').addEventListener('pointerup', event => {
  const start = gesture; gesture = undefined;
  if (!start || event.pointerId !== start.id || start.moved || Date.now() - start.time > 500 || Math.abs($('reader-surface').scrollTop - start.scroll) > 5 || Math.abs(event.clientX - start.x) > 12 || Math.abs(event.clientY - start.y) > 12) return;
  if (window.getSelection()?.toString()) return;
  const rect = $('reader-surface').getBoundingClientRect(); turn(event.clientX < rect.left + rect.width / 2 ? -1 : 1);
});
document.addEventListener('keydown', event => {
  if ($('reader').hidden || $('confirm-dialog').open || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); turn(event.key === 'ArrowLeft' ? -1 : 1); }
  if (event.key === 'Escape') setReader(false);
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', updateNetwork); window.addEventListener('offline', updateNetwork);

async function init() {
  $('open-reader').disabled = true;
  const savedFont = Number(storeGet('pocket-notes-font')); if (savedFont >= 18 && savedFont <= 44) fontSize = savedFont; changeFont(0);
  updateNetwork();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    workerReady = navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(() => navigator.serviceWorker.ready);
    workerReady.then(async () => { updateButtons(); try { showDownloadInfo((await workerMessage('STATUS')).info); } catch {} }).catch(() => { workerReady = undefined; updateButtons(); $('download-status').textContent = '離線功能啟動失敗，請重新整理後重試。'; });
  } else {
    $('download-status').textContent = '離線下載需要 HTTPS 或 localhost，以及支援 Service Worker 的瀏覽器。';
  }
  await loadNotebook();
  const mode = new URL(location.href).searchParams.get('mode');
  if (notebook && (mode === 'read' || (mode !== 'edit' && matchMedia('(max-width: 700px)').matches))) setReader(true);
}
init();
