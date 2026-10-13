# Pocket Notes · 口袋小抄

Node.js 手機小抄工具，無第三方執行依賴、無前端編譯步驟。桌面準備純文字內容，手機預設進入閱讀模式，每次一頁；點內容左半邊回上一頁，右半邊到下一頁。長文字可上下滑動，不會因滑動而誤翻頁。

## 本機啟動

需要 Node.js 22.9 以上（啟動指令使用 `--env-file-if-exists`）。

```sh
cp .env.example .env
npm start
```

開啟 <http://localhost:3000>。`npm run dev` 可在修改 server 時自動重啟。無需 `npm install` 即可執行；如需標準安裝流程，可用 `npm ci`。

## 使用方式

1. 編輯筆記名稱，新增、改名、刪除或上下移動頁面，每頁只放純文字。
2. 按「儲存筆記」，將整份筆記保存到 server。尚未儲存的修改會另外保留於目前瀏覽器的本機草稿。
3. **在要離線使用的手機與瀏覽器上**連網開啟，按「← 編輯」，再按 **Download 到這台裝置**。如果有未儲存的變更，Download 會先嘗試儲存。
4. 確認畫面出現已下載頁數與時間。開啟「開始閱讀」，之後斷網仍可重新開啟相同網址。
5. 更新筆記後，各手機需再按一次 Download，才會更新各自的離線版本。

閱讀模式可調字級、使用底部翻頁按鈕。桌面可用左右方向鍵、Esc 返回編輯。第一頁與最後一頁不循環。手機預設閱讀；`/?mode=edit` 直接編輯、`/?mode=read` 直接閱讀。可透過瀏覽器加入主畫面，主畫面捷徑預設閱讀。

手機閱讀只顯示內文，隱藏筆記名稱、頁面標題、上方頁碼與翻頁提示。底部保留一列 44px 的編輯入口、頁碼與字級調整；手機翻頁直接點內容左右半邊，桌面仍提供翻頁按鈕。

Download 是保存於瀏覽器的**離線快取**，不是下載檔案。另有「匯出備份」按鈕，可匯出整份筆記／尚未儲存草稿的 JSON；目前沒有 UI 匯入功能，可手動複製內文，或在停機時由管理者還原 server 資料檔。

## Server 架構

```text
手機／電腦
  ├─ HTTPS → Caddy :443 → Node.js 127.0.0.1:3000（PM2 管理）
  │                         └─ DATA_DIR/notebook.json
  └─ 斷網 → Service Worker → 介面快取 + Download 的完整筆記
```

- 一份共用筆記，最多 200 頁；每頁標題 100 字、內文 50,000 個 UTF-16 code units；API payload 上限 2 MiB。
- `GET /api/notebook` 讀取；`PUT /api/notebook` 儲存；`GET /healthz` 健康檢查。
- server 啟動時建立示範資料。資料檔損壞時停止啟動，避免覆寫原內容。
- JSON 寫入先存暫存檔，再 rename；請求序列化並檢查 `revision`。兩台裝置同時編輯時，後存者收到 409，不會覆蓋已存版本；先匯出自己的草稿，再重新載入整合。
- **PM2 必須使用單一 fork instance**。這份 JSON 檔設計不支援 cluster、多台 server 或多個 process 共用資料目錄。擴充時改用有交易支援的資料庫。
- 靜態檔採明確允許清單，資料目錄與 `.env` 不提供下載。文字用 `textContent` 呈現，不執行 HTML。
- Node 預設只監聽 loopback。Caddy 負責 TLS、壓縮與反向代理；關閉 Node 的對外 port。
- 收到 SIGINT／SIGTERM 時停止接收新連線、完成寫入後關閉；PM2 kill timeout 為 10 秒。

## PM2 + Caddy 部署

以下以 Linux、專案位於 `/srv/pocket-notes`、執行帳號 `notes` 為例；請替換路徑、帳號和網域。先安裝 Node.js 22.9+、PM2 與 Caddy。

1. 建立獨立的資料目錄，確保 PM2 執行帳號能讀寫，讓程式更新不會刪掉筆記：

   ```sh
   sudo install -d -o notes -g notes -m 700 /var/lib/pocket-notes
   cd /srv/pocket-notes
   cp .env.example .env
   ```

   在 `.env` 設定：

   ```dotenv
   HOST=127.0.0.1
   PORT=3000
   DATA_DIR=/var/lib/pocket-notes
   ```

   **已有資料時，啟動前先將原本 `data/notebook.json` 搬到新目錄**，並調整檔案權限。否則會在新目錄建立示範筆記。

2. 以該執行帳號啟動 PM2：

   ```sh
   npm ci
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

   執行 `pm2 startup` 輸出的管理員指令，再 `pm2 save`。PM2 ecosystem 已設定 `cwd`、單一 process、ready signal、自動重啟、256 MB 記憶體重啟門檻與關機等待時間。

3. 修改專案的 `Caddyfile`：把 `notes.example.com` 換成你的網域，DNS 指到主機，允許 TCP 80/443。若你已經有 Caddy 設定，只將此網站區塊加入現有設定。

   這是共用筆記，**任何能存取網站的人都能讀寫**。私人用途請先啟用範例內的 `basic_auth`，用 `caddy hash-password` 產生密碼 hash；帳號密碼交給瀏覽器登入。Download 不會保存 Authorization header，但快取的筆記保留於該裝置。

   確認設定後，部署到你的 Caddy 設定位置，再執行：

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl reload caddy
   curl https://你的網域/healthz
   ```

   如有啟用 Basic Auth，使用 `curl -u owner https://你的網域/healthz`，讓 curl 提示輸入密碼。

4. 後續更新與診斷：

   ```sh
   npm ci
   npm test
   pm2 restart ecosystem.config.js --update-env
   pm2 logs pocket-notes
   pm2 status
   ```

   改 Node port 時也要同步修改 Caddy upstream。更換前端資產時，增加 `public/sw.js` 的 `SHELL` 版本；線上再次開啟後會安裝新 worker，但既有下載筆記保留。更新期間避免不相容的 API／資料格式變更。

## 離線條件

Service Worker 需要 **HTTPS**；本機 `localhost` 是開發例外。若暫時將 `HOST` 設成 `0.0.0.0`，手機直接使用 `http://區網IP:3000` 可以測閱讀與編輯，但不能測離線下載。正式部署仍使用 loopback，測手機離線時使用 Caddy 網域 HTTPS 或其他手機信任的 HTTPS 環境。[MDN Service Worker 文件](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

離線資料屬於目前瀏覽器、裝置與網域。無痕模式、清除網站資料、儲存空間不足、瀏覽器自動清理或更換網域，可能讓離線資料消失。Download 會嘗試要求持久儲存，但瀏覽器可能不核准；演講前應先切飛航模式、關掉 Wi-Fi、重新開啟網址驗證。[MDN 持久儲存文件](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)

線上讀取會抓 server 最新內容；離線才讀 Download 快照。一般線上瀏覽、儲存與草稿編輯**不會**偷偷更新離線快照。Download 失敗時保留上一份筆記快照。離線草稿不會自動上傳，重新連線後手動儲存。

## 備份

定期備份 `DATA_DIR/notebook.json`；server 採 rename 更新，因此可複製該檔備份。還原時先 `pm2 stop pocket-notes`，替換資料檔並確認權限，再 `pm2 start pocket-notes`。保留完整 JSON 格式及 revision。手機的 Download 不取代 server 備份。

## 驗證

```sh
npm run check
npm test
```

自動測試驗證 API、JSON 持久化、重啟、版本衝突、輸入限制、靜態檔隔離，以及 Service Worker 的快取、斷網重新導覽與失敗保留舊版。Worker 測試以記憶體 Cache 模擬；不等於真實手機瀏覽器驗證。

開發時也以本機 Chrome headless 的桌面與 390 × 844 手機尺寸實測：新增頁面、儲存、Download、觸控左右翻頁、邊界不循環、滑動不翻頁、純文字呈現，以及模擬斷網後離開頁面再重新開啟。實體手機與 Caddy／PM2 主機仍需依下列步驟驗收。

部署後手機驗收：新增多頁並儲存 → 手機連網 Download → 確認已下載時間 → 飛航模式且關 Wi-Fi → 關閉分頁再重開同網址 → 左右點按翻頁 → 上下捲動長文字 → 回到編輯後確認所有頁仍在。

部署設定參考：[PM2 ecosystem](https://pm2.keymetrics.io/docs/usage/application-declaration/)、[Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy)。
