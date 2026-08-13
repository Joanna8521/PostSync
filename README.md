# ⚡ Post Sync — 社群貼文收藏器

開源的 Chrome 擴充功能。在 **Facebook / Threads / X / Instagram / LinkedIn**
滑到一則覺得受用的貼文，按一下就存進**你自己 Google Drive**，並可同步進
Focus4ai 知識庫：

- **一篇一份 Google Doc**，檔名是 `日期_主題_發文者`，例如
  `20260813_我發現到現在還是一堆人不知道 AI 到底要怎麼開始_蕭上農`
- **圖片直接嵌在 Doc 裡**，不是存一條幾天後會失效的網址
- **文件開頭附原文連結**，隨時跳回去看留言
- **同一篇收第二次會先問你**，並附上先前那份的連結
- **最小權限**：只用 `drive.file` scope，只碰這個擴充自己建立的檔案，
  看不到你 Drive 裡的其他東西

## 怎麼用

兩種方式，都是自己按的：

**右鍵**（建議）——在貼文上按右鍵 →「⚡ 收這篇貼文」。
指哪篇收哪篇，沒有歧義；點在留言上也會收到整篇，不會只收到那則留言。
浮動按鈕因為版面或改版沒出來的時候，這條路還在。

**浮動按鈕** —— 捲動到一則貼文，右邊會浮出 **「⚡ 收這篇」**，
同時那一則會有一圈淡紫外框，告訴你按下去會收哪一篇。

快速鍵預設**沒有綁**（免得跟慣用的鍵打架）。要的話到
`chrome://extensions/shortcuts` 找 Post Sync 自己設一組。

擷取**一律是你自己按的**。沒有任何自動收集，也不會自己捲動頁面 ——
那一秒就會從「使用者閱讀」變成「自動化擷取」，帳號風險完全不同。

### 兩個目的地，各自獨立

| | 存什麼 | 給誰用 |
|---|---|---|
| **Google Drive** | 一篇一份 Doc，圖片嵌在裡面 | 給人看的 |
| **Focus4ai 知識庫** | Markdown，寫入就切片建索引 | 給檢索用的 |

一邊掛了不影響另一邊。只想用知識庫、不接 Drive 也可以。

## 安裝

<!-- INSTALL:START -->
拿到 `post-sync-v*.zip` 之後，三分鐘就能裝好。

1. **解壓縮**，會看到一個 `post-sync-extension` 資料夾。
   把它放到你放得住的地方（例如「文件」）。
   ⚠️ 安裝後**不能刪除或搬走它**，擴充是直接從這個資料夾執行的。

2. 打開 Chrome，網址列輸入 `chrome://extensions`，
   **右上角把「開發人員模式」打開**。

3. 按左上角**「載入未封裝項目」**，選取那個資料夾
   （選到裡面看得到 `manifest.json` 的那一層），按「選取」。

4. 裝好後會自動打開設定導覽頁，按 **「連接 Google」** 用自己的帳號授權。

5. 打開 facebook.com，捲到一則貼文，右邊會浮出「⚡ 收這篇」。

### 常見問題

- **選了資料夾卻說「資訊清單檔案遺失」**
  選錯層了。要選到裡面有 `manifest.json` 的那一層。

- **按了沒反應／看不到浮動按鈕**
  回到那個分頁按 `Cmd+R`（Windows 是 `F5`）重新整理。
  擴充需要頁面重新載入才會生效。還是不行就點擴充圖示按
  **「檢查目前分頁」**，它會直接告訴你偵測到幾則貼文。

- **Chrome 重開後跳出「停用開發人員模式擴充功能」**
  按「取消」就好，這是 Chrome 對未上架擴充的例行提醒。
<!-- INSTALL:END -->

manifest 內含固定的 `key`（公鑰），所以每個人載入後的擴充 ID 都相同：
`mbckgmofgjkmfjofljddhgbhglfhjbom`，共用同一個 OAuth client 才會成立。

## OAuth 設定（已完成，這裡留給重建時參考）

已設定好，用的是專屬於 Post Sync 的 GCP 專案 `postsync888`（專案編號 `607878852359`）。
Post Sync **不能**跟 Mesh Sync 共用 OAuth client —— 那組綁的是 Mesh Sync 的擴充 ID；
而且同意畫面是專案層級的，共用會讓使用者授權 Post Sync 時看到「Mesh Sync」。

要重建的話（Google 在 2025 年把「OAuth 同意畫面」搬進了「Google 驗證平台」，
選單位置跟舊教學不一樣，所以直接記網址）：

```bash
gcloud projects create postsync888 --name="Post Sync"
gcloud services enable drive.googleapis.com docs.googleapis.com --project=postsync888
```

1. <https://console.cloud.google.com/auth/overview?project=postsync888> →「開始使用」，
   應用程式名稱 `Post Sync`、目標對象選「外部」。
2. 「資料存取權」→ 新增範圍 `.../auth/drive.file`
   （**非敏感** scope，不需要 Google 審查，也沒有測試使用者 100 人上限）。
3. 「目標對象」→「發布應用程式」。不發布的話只有測試名單裡的帳號能用。
4. 「用戶端」→「建立用戶端」→ 應用程式類型選「**Chrome 擴充功能**」，
   項目 ID 填 `mbckgmofgjkmfjofljddhgbhglfhjbom`。
5. 把拿到的 client ID 填進 `extension/manifest.json` 的 `oauth2.client_id`。

> ⚠️ **同意畫面的「應用程式標誌」不要上傳。** 一旦上傳 logo，這個 app 就會被
> 歸入需要 Google **品牌驗證**的流程，而 `drive.file` 本來是非敏感 scope、
> 完全不需要審查。為了一張圖換來幾天到幾週的審查等待，不划算。
> 真的要上架商店再說，商店那邊的圖示是另一套，跟這裡無關。

`manifest.json` 的 `key`（公鑰）決定擴充 ID，而 Console 裡填的項目 ID 必須跟它一致，
不然會一路授權失敗、而且錯誤訊息不會告訴你原因。改動 `key` 之後用這段對一次：

```bash
python3 -c "import json,base64,hashlib;d=base64.b64decode(json.load(open('extension/manifest.json'))['key']);print(''.join(chr(ord('a')+int(c,16)) for c in hashlib.sha256(d).hexdigest()[:32]))"
```

## 圖片是怎麼真的進到 Doc 裡的

`fbcdn` 的圖片網址帶時效 token，存網址等於存一個幾天後變 404 的東西。
所以一定要讓 Doc 擁有自己的副本，做法有兩層：

1. **直接把原網址交給 Docs API 的 `insertInlineImage`** ——
   Google 會在插入的當下把圖抓下來存進文件，原網址之後失效也不影響。最快。
2. **被擋就自己下載** —— 擴充有這些圖床的 host 權限，帶得動簽章網址。
   下載後上傳到 Drive、開連結權限幾秒讓 Docs 抓走，抓完立刻收回權限並刪掉暫存檔。

一張一張處理，一張壞掉不會讓其他張跟著沒了。兩層都失敗才退回貼網址，
而且會在 Doc 裡明講「這些網址通常幾天後就會失效」，不會假裝收好了。

## Focus4ai 同步

在 popup 開啟「同步到 Focus4ai 知識庫」後，每次收錄除了寫進 Drive，
還會以 Markdown 寫進知識庫並**當場切片建索引**（走 `PUT /api/doc`，不需修改 Focus4ai）。

- **網址**填站台根位址（線上站台是 `https://app.focus4ai.com`）。
  注意 `focus4ai.com` 是官網、沒有 API，填了會被擋下來並說明原因。
- **資料夾**預設 `00_inbox/post-sync`。
- **local_only**：預設**不**標記。社群貼文多半是公開內容，標了就進不了檢索，
  等於白收。收私密社團的東西再打開這個開關。
  （這跟 Mesh Sync 相反 —— 那邊收的是自己的 AI 對話，常有客戶名與報價。）
- 站台有登入牆時，擴充會帶著你在同一個瀏覽器的登入 session；請先登入再同步。
  被導到登入頁時會明確報錯，不會謊報成功。

## 專案結構

```
extension/
├── manifest.json        # MV3，含固定 key（公鑰）與 oauth2 設定
├── popup.html           # 收藏對象切換、連線狀態、Focus4ai 設定、寫入紀錄
├── onboarding.html      # 安裝後自動打開的設定導覽
├── icons/
└── src/
    ├── adapters.js      # 各平台的錨點（唯一需要跟著平台改版調的地方）
    ├── naming.js        # 檔名主題（service worker 與測試共用）
    ├── extract.js       # DOM → 資料（純函式，可測）
    ├── content.js       # 浮動按鈕、展開全文、toast
    ├── background.js    # OAuth、Drive、圖片嵌入、Focus4ai、去重
    ├── popup.js
    ├── onboarding.js
    └── toast.css
tests/
├── run.html             # 抽取層：用瀏覽器直接打開就跑
└── live.html            # 浮動按鈕：假動態牆＋假的 chrome API，實際跑 content.js
```

- `key.pem`（專案根目錄、不進 git）：打包 .crx 時才需要的私鑰。
  載入未封裝不需要它。

## 測試

用瀏覽器直接打開這兩個檔，全綠才算過。改過 `src/` 之後記得在網址後面加
`?v=2` 之類的參數，不然瀏覽器會拿快取裡的舊檔，你會看到「改了沒反應」。

**`tests/run.html`** —— 抽取層。釘住的是那種**壞了不會有任何畫面告訴你**的事：

- 留言被當成貼文（臉書的**留言**才是 `role="article"`，貼文是 `div[aria-labelledby]`）
- 整個動態牆被當成「一則超大貼文」
- 臉書的反爬混淆字元被收進內文、作者、檔名
- 作者名黏著「已驗證帳號」「追蹤」「分享對象：所有人」
- 右鍵點在留言上，收到的是那則留言而不是整篇
- 頭像被當成內容圖片
- permalink 帶著追蹤參數 → 同一篇每次指紋都不同 → 去重整個失效
- 平台改版讓內文容器落空 → 安靜地收到一份空的
- 作者名或時間戳變成檔名 → 整個資料夾看起來都一樣

**`tests/live.html`** —— 浮動按鈕。假的動態牆＋假的 `chrome` API，
實際把 `content.js` 跑起來，左下角面板會報出：content script 有沒有注入、
偵測到幾則貼文、按鈕的 `display`／`z-index`／座標、有沒有跑出畫面。
「按鈕沒出現」的時候先看這一頁，能分辨是程式的問題還是環境的問題。

**`python3 tools/check_permissions.py`** —— 權限涵蓋度。改過 `manifest.json`
之後跑一次。

match pattern 寫錯**不會有任何錯誤訊息**：Chrome 只是安靜地不注入 content
script、或安靜地擋掉 background 的 fetch，而症狀看起來完全像別的問題
（「這個平台沒反應」「圖片收不到」）。所以這支腳本自己實作一遍 Chrome 的
比對規則，拿真實的網址形狀去對：

- content script 的 matches 有沒有涵蓋各平台真正的網址形狀
  （臉書的 `/photo/?fbid=`、Threads 新舊兩個網域、X 與 twitter.com…）
- host_permissions 有沒有涵蓋四個圖床與三個 Google API
- 反過來，有沒有**多要**權限——宣告了卻沒有任何程式會用到的，
  只會拖慢商店審查

## 已知限制

- **手機上沒有浮動按鈕。** iOS／Android 都不允許在臉書 App 裡注入 UI。
  行動端要另外走 Safari Web Extension（可以，但要 Xcode 與開發者帳號）
  或 iOS 捷徑＋OCR，而後者需要 Focus4ai 先提供一條**帶 token** 的寫入 API ——
  目前的寫入靠瀏覽器 session（`credentials: 'include'`），手機捷徑沒有 session。
- **X 的長推文可能只收到截斷版。** X 的「Show more」是一條連結，
  按下去會直接跳走，所以程式不點它。收到截斷內容好過整個跳頁。
- **LinkedIn 是盡力而為。** 它不把 permalink 放在 DOM 上，靠 `data-urn` 組，
  版面改動也比其他平台頻繁。
- **平台改版可能讓抓取失準。** 錨點全部集中在 `src/adapters.js`，
  改一個檔就好。抓不到內文時畫面上會明講，不會安靜地收一份空的。
- **上架 Chrome Web Store 需要說明用途。** 宣告了 facebook.com 這類
  host permission 會被審查問「為什麼需要」。要降低審查摩擦的話，
  可以改成 `optional_host_permissions` ＋ `chrome.scripting.registerContentScripts`
  動態註冊，讓使用者逐個平台自己開。

## 隱私

- 擷取動作**全部由使用者手動觸發**（按浮動按鈕或快速鍵），不會自動上傳任何內容。
- 資料只寫進使用者自己的 Google Drive 與自己指定的 Focus4ai 站台；
  本擴充沒有任何自己的伺服器。
- `drive.file` scope 之下，擴充只能看到、修改它自己建立的資料夾與文件。
- 圖片走第二層路徑時會短暫開啟「知道連結的人可讀」，插入完成後立刻收回並刪除暫存檔。

## License

MIT
