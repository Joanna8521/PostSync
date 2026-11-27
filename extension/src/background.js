// =====================================================
// Post Sync — Background Service Worker v1.0
//
// 收到的貼文往兩個目的地寫，而且兩邊互不影響：
//   Drive      給人看的：一個月一份 Doc，圖片直接嵌進去
//   Focus4ai   給檢索用的：Markdown 進知識庫，當場切片建索引
// 任何一邊成功就算成功。Drive 沒設定不該讓知識庫也寫不進去。
// =====================================================

// 檔名規則與預設值都跟 popup／content script 共用同一份，
// 兩邊各寫一份遲早會分岔：畫面顯示 A、實際寫進 B，而且不會有任何錯誤訊息
importScripts('i18n.js', 'naming.js', 'defaults.js', 'export_p2s.js');
const T = self.POST_SYNC_I18N.t;
// 命名層回傳的是訊息代碼（見 naming.js 檔頭），翻譯函式要注入一次。
self.POST_SYNC_NAME.setTranslator(T);
self.PostSyncExportP2S.setTranslator(T);
const { topicOf, docStem } = self.POST_SYNC_NAME;
const DEF = self.POST_SYNC_DEFAULTS;

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1';
const SEEN_CAP = 5000;

// ── 右鍵選單 ─────────────────────────────────────────
// 只在有 content script 的網域出現，不然使用者在每一個網頁上都會看到
// 一個按了沒反應的選項。

const MENU_ID = 'postsync-capture';

function menuPatterns() {
  const cs = chrome.runtime.getManifest().content_scripts || [];
  return cs.flatMap((c) => c.matches || []);
}

async function buildMenu() {
  const patterns = menuPatterns();
  // 重複註冊同一個 id 會丟錯，先清乾淨再建
  await new Promise((r) => chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    r();
  }));
  chrome.contextMenus.create({
    id: MENU_ID,
    title: T('menuCapture'),
    contexts: ['page', 'selection', 'link', 'image'],
    documentUrlPatterns: patterns,
  }, () => { void chrome.runtime.lastError; });

}

chrome.runtime.onInstalled.addListener((d) => {
  buildMenu();
  if (d.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// service worker 睡醒後選單還在（Chrome 自己持久化），但瀏覽器重開、
// 擴充重載這些時機要重建一次，不然選單會憑空消失
chrome.runtime.onStartup.addListener(buildMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  let type = null;
  if (info.menuItemId === MENU_ID) type = 'POSTSYNC_CONTEXT';
  if (!type) return;
  chrome.tabs.sendMessage(tab.id, { type }, () => {
    void chrome.runtime.lastError; // 這個分頁沒有 content script 就算了
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'POSTSYNC_CAPTURE') {
    handleCapture(msg.payload, !!msg.force, sender.tab && sender.tab.id).then(sendResponse);
    return true;
  }
  if (msg.type === 'POSTSYNC_CONNECT') {
    getToken(true)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  if (msg.type === 'POSTSYNC_F4_TEST') {
    testFocus4ai(msg.base).then(sendResponse);
    return true;
  }
  if (msg.type === 'POSTSYNC_P2S_COUNT') {
    chrome.storage.local.get(['psExport'])
      .then(({ psExport = [] }) => sendResponse({ ok: true, count: psExport.length }))
      .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  if (msg.type === 'POSTSYNC_P2S_EXPORT') {
    chrome.storage.local.get(['psExport'])
      .then(({ psExport = [] }) => {
        const E = self.PostSyncExportP2S;
        const mf = chrome.runtime.getManifest();
        const file = E.buildFile(psExport, mf.version);
        sendResponse({
          ok: true,
          count: file.records.length,
          name: E.fileName(new Date()),
          json: JSON.stringify(file, null, 2),
        });
      })
      .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  if (msg.type === 'POSTSYNC_P2S_CLEAR') {
    chrome.storage.local.set({ psExport: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  if (msg.type === 'POSTSYNC_STATUS') {
    if (!clientIdSet()) {
      sendResponse({ connected: false, reason: 'no_client_id' });
      return true;
    }
    getToken(false)
      .then(() => sendResponse({ connected: true }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'capture-post') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'POSTSYNC_HOTKEY' }, () => {
      void chrome.runtime.lastError; // 這個分頁沒有 content script 就算了
    });
  });
});

// ── 圖片位元組 ───────────────────────────────────────
// 一次收錄裡同一張圖只下載一次。Drive 的第二層路徑與知識庫的附件都要用到
// 位元組，各抓一次等於白抓一遍，而且圖床有速率限制。
function blobCache() {
  const cache = new Map();
  return function getBlob(url) {
    if (!cache.has(url)) {
      cache.set(url, (async () => {
        const res = await fetchT(url, {}, 30000);
        if (!res.ok) throw new Error(T('errDownload', String(res.status)));
        return res.blob();
      })());
    }
    return cache.get(url);
  };
}

// service worker 裡沒有 FileReader，自己把位元組轉成 base64。
// 一次 8000 個 byte：String.fromCharCode 一口氣吃太多會爆呼叫堆疊。
async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ── 逾時與錯誤 ───────────────────────────────────────
// 每一個等待都要有盡頭。沒有逾時的等待，使用者看到的是永遠轉圈，
// 而轉圈不帶任何資訊，他只能猜「是慢還是壞了」。

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(
        T('errTimeoutWhat', [what, String(Math.round(ms / 1000))]))), ms);
    }),
  ]);
}

async function fetchT(url, opts = {}, ms = 45000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(T('errTimeoutConn',
        [String(Math.round(ms / 1000)), new URL(url).host]));
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 有些例外的 str() 就是空字串，畫面上只剩「失敗：」，等於沒有訊息
function errMsg(e) {
  return (e && e.message) || (e && e.constructor && e.constructor.name) || T('errUnknown');
}

// ── OAuth ────────────────────────────────────────────

function clientIdSet() {
  const m = chrome.runtime.getManifest();
  const id = (m.oauth2 && m.oauth2.client_id) || '';
  return !!id && !id.startsWith('REPLACE_ME');
}

function getToken(interactive) {
  if (!clientIdSet()) {
    return Promise.reject(new Error(
      T('errNoClientId')
    ));
  }
  // getAuthToken 是 **Chrome 專屬**的：它靠 Chrome 內建的 Google 帳號整合，
  // Arc、Brave、Edge、Vivaldi 這些 Chromium 瀏覽器多半沒有實作。
  // 不講清楚的話，使用者只會看到「未知錯誤」而完全不知道是瀏覽器的問題。
  if (typeof chrome.identity?.getAuthToken !== 'function') {
    return Promise.reject(new Error(
      T('errNeedsChrome')
    ));
  }

  const p = new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        const raw = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
        // 非 Chrome 的 Chromium 有時有這個函式、呼叫卻一定失敗，
        // 訊息還很含糊。把可能的原因一起講出來。
        reject(new Error(
          `${raw || T('connNotConnected')}`
          + T('connNonChrome')
        ));
      } else {
        resolve(token);
      }
    });
  });
  // 授權視窗開了沒人理，callback 就永遠不會回來
  return interactive ? withTimeout(p, 120000, T('errGoogleAuth')) : p;
}

async function withAuthRetry(fn) {
  let token = await getToken(true);
  try {
    return await fn(token);
  } catch (e) {
    if (!e.auth) throw e;
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    token = await getToken(true);
    return fn(token);
  }
}

// 非 2xx 一律丟錯並帶上後端原因。共用層把錯誤吞掉的話，
// 每個呼叫端都得自己記得檢查，而那種事一定會漏。
async function api(token, method, url, body) {
  const res = await fetchT(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const e = new Error('AUTH_EXPIRED');
    e.auth = true;
    throw e;
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && j.error.message) || '';
    } catch (_) { /* 非 JSON 錯誤內文 */ }
    throw new Error(T('errGoogleApi',
      [String(res.status), detail || res.statusText || T('errUnknown')]));
  }
  return res.status === 204 ? null : res.json();
}

// ── 去重 ─────────────────────────────────────────────
// 用內容指紋，不是「日期＋標題」。同一天遇到兩篇同標題的貼文是常態，
// 用日期算 key 會把兩篇當成同一篇，而且發現的時候通常已經漏收很久了。

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function fingerprint(p) {
  // permalink 最準；抓不到就退回「作者＋內文前 200 字」
  const perma = (p.permalink || '').split('#')[0];
  const usable = perma && !/\/(home|feed)\/?$/.test(perma) && perma !== p.pageUrl;
  const basis = usable ? perma : `${p.author}|${(p.text || '').slice(0, 200)}`;
  return hashStr(`${p.platform}|${basis.replace(/\s+/g, '')}`);
}

async function checkSeen(key) {
  const { psSeen = {} } = await chrome.storage.local.get(['psSeen']);
  return psSeen[key] || null;
}

// persona-to-skill 匯入檔的素材。
//
// 跟 markSeen 分開存，因為那邊是去重索引、只留指紋跟連結，這邊要留原文。
// 而留原文是另一回事，所以它是一個預設關閉的開關：這支擴充的姿態是
// 「擷取一律是你自己按的」，那條姿態如果在背後默默累積內容就不成立了。
async function recordForExport(p) {
  const s = await chrome.storage.sync.get(['p2sCollect', 'p2sCap']);
  if (!s.p2sCollect) return;

  const rec = self.PostSyncExportP2S.toRecord(p);
  if (!rec) return;

  const { psExport = [] } = await chrome.storage.local.get(['psExport']);
  // 同一篇收第二次就覆蓋，不要在匯出檔裡出現兩份一樣的來源。
  const i = rec.url ? psExport.findIndex((r) => r.url === rec.url) : -1;
  if (i >= 0) psExport[i] = rec; else psExport.push(rec);

  const cap = Number(s.p2sCap) || DEF.p2sCap;
  if (psExport.length > cap) psExport.splice(0, psExport.length - cap);
  await chrome.storage.local.set({ psExport });
}

async function markSeen(key, entry) {
  const { psSeen = {} } = await chrome.storage.local.get(['psSeen']);
  psSeen[key] = entry;
  // 無限長大的 map 遲早把 storage 塞爆，砍掉最舊的那批
  const keys = Object.keys(psSeen);
  if (keys.length > SEEN_CAP) {
    keys.sort((a, b) => (psSeen[a].t || 0) - (psSeen[b].t || 0));
    keys.slice(0, keys.length - SEEN_CAP).forEach((k) => delete psSeen[k]);
  }
  await chrome.storage.local.set({ psSeen });
}

// ── 主流程 ───────────────────────────────────────────

function progress(tabId, text) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: 'POSTSYNC_PROGRESS', text }, () => {
      void chrome.runtime.lastError; // 分頁關了就算了
    });
  } catch (_) { /* 分頁不在了 */ }
}

async function handleCapture(p, force, tabId) {
  const key = fingerprint(p);
  if (!force) {
    const prev = await checkSeen(key);
    if (prev) return { ok: false, dup: true, prev };
  }

  const s = await chrome.storage.sync.get(['driveEnabled', 'f4Enabled', 'f4Base']);
  const wantDrive = s.driveEnabled !== false && clientIdSet();
  const wantF4 = !!s.f4Enabled && !!s.f4Base;

  if (!wantDrive && !wantF4) {
    const m = T('errNoTarget');
    await logEntry({ ok: false, msg: m, time: Date.now() });
    badge(false);
    return { ok: false, error: m };
  }

  // 兩個目的地各自獨立：一邊掛了不能把另一邊也拖下水。
  // 但圖片的位元組兩邊都要用，共用一份快取，同一張只下載一次。
  const getBlob = blobCache();
  let drive = null;
  let driveError = '';
  if (wantDrive) {
    try {
      progress(tabId, T('stepAuth'));
      drive = await withAuthRetry((token) => writeDrive(token, p, tabId, getBlob));
    } catch (e) {
      driveError = errMsg(e);
    }
  }

  let f4 = null;
  let f4Error = '';
  if (wantF4) {
    try {
      progress(tabId, T('stepF4'));
      f4 = await syncToFocus4ai(p, key, drive, getBlob, tabId);
    } catch (e) {
      f4Error = errMsg(e);
    }
  }

  // 兩個目的地都掛了也要記，因為匯入檔那條本來就不靠它們：
  // 它是本機下載，沒有伺服器也沒有驗證。
  try {
    await recordForExport(p);
  } catch (e) {
    // 匯出素材沒記到，不應該讓這一次收錄算失敗。這裡吞掉是刻意的：
    // 使用者要的是那篇貼文進 Drive 或知識庫，匯入檔是附帶的。
  }

  const ok = !!(drive || f4);
  if (ok) {
    await markSeen(key, {
      t: Date.now(),
      when: dateTimeStr(),
      docName: drive ? drive.docName : '',
      docUrl: drive ? drive.docUrl : '',
    });
  }

  // 「沒提到」會被當成「有做」。沒啟用的目的地也要明講，
  // 不然使用者以為兩邊都寫了，過很久才發現知識庫是空的。
  const bits = [];
  if (drive) {
    bits.push(T('bitDrive', [drive.docName,
      drive.imgNote ? T('bitDriveImgNote', drive.imgNote) : '']).trim());
  } else if (driveError) bits.push(T('bitDriveFailed', driveError));
  else bits.push(T('bitDriveOff'));

  // 圖片張數要講出來——輪播有沒有翻完，看這個數字最快
  if (p.images && p.images.length) bits.push(T('bitImages', String(p.images.length)));
  if (f4) bits.push(T('bitF4', String(f4.chunks)));
  else if (f4Error) bits.push(T('bitF4Failed', f4Error));
  else bits.push(T('bitF4Off'));

  await logEntry({
    ok,
    msg: T('logLine', [(p.author || T('noAuthor')).slice(0, 20),
                        p.platformLabel, bits.join('・')]),
    docUrl: drive ? drive.docUrl : '',
    time: Date.now(),
  });
  badge(ok);

  // 訊息在這裡組好，content script 只負責顯示。
  // 兩邊各拼一份的話，畫面說的跟紀錄寫的遲早會不一樣。
  if (!ok) return { ok: false, error: bits.join('・') };
  return { ok: true, bits, drive, driveError, f4, f4Error };
}

// ── Drive：一篇一份 Doc ───────────────────────────────
// 收進來的每一則都是獨立挑過的東西，混在同一份文件裡等於全部糊掉。
// 檔名用「日期_主題_平台」，在 Drive 的清單上一眼看得出是哪一篇。

async function writeDrive(token, p, tabId, getBlob) {
  const profile = await activeProfile();
  progress(tabId, T('stepFolder'));
  const folderId = await ensureFolder(token, profile);
  progress(tabId, T('stepCreateDoc', p.text.length.toLocaleString()));
  const doc = await createPostDoc(token, folderId, p);

  let imgNote = '';
  if (p.images && p.images.length) {
    progress(tabId, T('stepEmbed', String(p.images.length)));
    imgNote = await insertImages(token, doc.docId, folderId, p.images, tabId, getBlob);
  }
  return {
    docName: doc.name,
    docUrl: `https://docs.google.com/document/d/${doc.docId}/edit`,
    imgNote,
  };
}

async function activeProfile() {
  const s = await chrome.storage.sync.get(['profiles', 'activeProfileId']);
  const profiles = Array.isArray(s.profiles) ? s.profiles : [];
  let p = profiles.find((x) => x.id === s.activeProfileId) || profiles[0];
  if (!p) {
    p = { id: 'default', name: T('defaultProfileName'),
           folderName: T('defaultFolderName') };
    await chrome.storage.sync.set({ profiles: [p], activeProfileId: p.id });
  }
  return p;
}

async function ensureFolder(token, profile) {
  const { psFolders = {} } = await chrome.storage.local.get(['psFolders']);

  // drive.file 權限只看得到本擴充建立（或使用者授權過）的檔案，
  // 所以使用者手動貼的外部資料夾 ID 多半拿不到——要給看得懂的說明，不能只丟 404
  if (profile.folderId) {
    try {
      const f = await api(token, 'GET', `${DRIVE}/files/${profile.folderId}?fields=id,trashed,mimeType`);
      if (f && !f.trashed && f.mimeType === 'application/vnd.google-apps.folder') return profile.folderId;
      throw new Error(T('errFolderNotFolder'));
    } catch (e) {
      if (e.auth) throw e;
      throw new Error(
        T('errFolderNoAccess')
      );
    }
  }

  const cached = psFolders[profile.id];
  if (cached) {
    try {
      const f = await api(token, 'GET', `${DRIVE}/files/${cached}?fields=id,trashed`);
      if (f && !f.trashed) return cached;
    } catch (e) {
      if (e.auth) throw e; // 其他錯誤 → 資料夾不見了，往下重建
    }
  }
  const name = String(profile.folderName || `Post Sync — ${profile.name}`).trim()
    || T('defaultFolderName');
  const f = await api(token, 'POST', `${DRIVE}/files?fields=id`, {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  });
  psFolders[profile.id] = f.id;
  await chrome.storage.local.set({ psFolders });
  return f.id;
}

async function createPostDoc(token, folderId, p) {
  const topic = topicOf(p);
  const docName = docStem(p, ymd());

  const created = await api(token, 'POST', `${DRIVE}/files?fields=id`, {
    name: docName,
    mimeType: 'application/vnd.google-apps.document',
    parents: [folderId],
  });

  const title = `${topic}\n`;
  const meta = T('docByline', [p.author || T('noAuthor'), p.platformLabel,
                               p.timeText ? T('docTimeSuffix', p.timeText) : '',
                               dateTimeStr()]) + '\n';
  // 抓不到連結就明講。寫一個「https://www.facebook.com/」進去更糟——
  // 看起來像有連結，點下去卻回到動態牆首頁。
  const link = p.permalink
    ? `${p.permalink}\n\n`
    : T('docNoPermalink', p.pageUrl || T('docFeed')) + '\n\n';
  const body = `${cleanText(p.text)}\n\n`;
  const text = title + meta + link + body;
  const linkStart = 1 + title.length + meta.length;

  const requests = [
    { insertText: { location: { index: 1 }, text } },
    {
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 1 + title.length },
        paragraphStyle: { namedStyleType: 'TITLE' },
        fields: 'namedStyleType',
      },
    },
  ];
  if (p.permalink) {
    requests.push({
      updateTextStyle: {
        range: { startIndex: linkStart, endIndex: linkStart + p.permalink.length },
        textStyle: { link: { url: p.permalink } },
        fields: 'link',
      },
    });
  }
  await api(token, 'POST', `${DOCS}/documents/${created.id}:batchUpdate`, { requests });

  return { docId: created.id, name: docName };
}

async function docEnd(token, docId) {
  const doc = await api(token, 'GET', `${DOCS}/documents/${docId}?fields=body.content(endIndex)`);
  const content = (doc.body && doc.body.content) || [];
  const last = content[content.length - 1];
  return last ? last.endIndex - 1 : 1;
}

// ── 圖片：真的嵌進 Doc 裡 ────────────────────────────
//
// fbcdn 的網址帶時效 token，存網址等於存一個幾天後變 404 的東西，
// 所以一定要讓 Doc 擁有自己的副本。insertInlineImage 正是「Google 在插入
// 的當下把圖抓下來、存進文件」，之後原網址失效也不影響。
//
// 兩層，因為第一層不是我們能保證的事：
//   一、直接把原網址交給 Docs API——最快，但 Google 的抓取端可能被擋
//   二、被擋就自己下載 bytes（我們有 host 權限，帶得動簽章網址），
//       上傳到 Drive、開連結權限幾秒讓 Docs 抓走，抓完立刻收回並刪掉暫存檔
//   三、兩層都不行才退回貼網址，而且要講明它會失效，不能假裝收好了
//
// 一張一張處理：一張壞掉不該讓其他張跟著沒了。整段失敗也只回報一行字，
// 絕對不能讓已經寫好的內文跟著失敗。

async function insertOneImage(token, docId, uri) {
  const at = await docEnd(token, docId);
  await api(token, 'POST', `${DOCS}/documents/${docId}:batchUpdate`, {
    requests: [
      { insertInlineImage: { location: { index: at }, uri } },
      { insertText: { location: { index: at + 1 }, text: '\n' } },
    ],
  });
}

async function viaDrive(token, docId, folderId, url, getBlob) {
  // 位元組走共用快取：知識庫那條可能已經抓過同一張了
  const blob = getBlob ? await getBlob(url) : await (await fetchT(url, {}, 30000)).blob();
  // Docs API 對嵌入圖片的上限是 50MB / 2500 萬像素，超過就別浪費一次來回
  if (blob.size > 45 * 1024 * 1024) throw new Error(T('errImageTooBig'));

  const boundary = `postsync${Math.random().toString(36).slice(2)}`;
  const meta = { name: `postsync-tmp-${Date.now()}`, parents: [folderId] };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(meta),
    `\r\n--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--\r\n`,
  ]);
  const up = await fetchT(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    90000,
  );
  if (!up.ok) throw new Error(T('errUpload', String(up.status)));
  const fileId = (await up.json()).id;

  try {
    // Docs 的抓取端要讀得到才能複製，所以開一下連結權限。
    // 幾秒後就收回，而且 Doc 那時已經有自己的副本了。
    await api(token, 'POST', `${DRIVE}/files/${fileId}/permissions?fields=id`, {
      role: 'reader', type: 'anyone',
    });
    await insertOneImage(token, docId, `https://drive.google.com/uc?export=view&id=${fileId}`);
  } finally {
    // 這裡失敗只是留一個暫存檔，不值得讓整張圖算失敗
    try { await api(token, 'DELETE', `${DRIVE}/files/${fileId}`); } catch (_) { /* 之後手動清 */ }
  }
}

async function insertImages(token, docId, folderId, urls, tabId, getBlob) {
  const failed = [];
  let done = 0;
  for (const url of urls) {
    progress(tabId, T('stepEmbedOne',
      [String(done + failed.length + 1), String(urls.length)]));
    try {
      await insertOneImage(token, docId, url);
      done++;
      continue;
    } catch (_) { /* 第一層被擋，換第二層 */ }
    try {
      await viaDrive(token, docId, folderId, url, getBlob);
      done++;
    } catch (e) {
      failed.push(url);
    }
  }

  if (failed.length) {
    // 失敗的不能安靜地消失，但也不能假裝那些網址還會活著
    const note = T('docImagesFailed',
      [String(failed.length), failed.join('\n')]) + '\n';
    try {
      const end = await docEnd(token, docId);
      await api(token, 'POST', `${DOCS}/documents/${docId}:batchUpdate`, {
        requests: [{ insertText: { location: { index: end }, text: note } }],
      });
    } catch (_) { /* 連註記都寫不進去就算了，回傳值還是會說 */ }
  }
  return failed.length ? T('bitImagesPartial', [String(done), String(urls.length)]) : '';
}

// ── Focus4ai 知識庫 ──────────────────────────────────
// Drive 是給人看的，知識庫是給檢索用的。

function isJson(res) {
  return (res.headers.get('content-type') || '').includes('application/json');
}

function mdEscape(s) {
  return String(s || '').replace(/"/g, "'").replace(/\n/g, ' ').trim();
}

// 使用者填的網址是任意主機，權限是 optional 的、要在 popup 當下跟使用者要。
// 沒要到就發不出請求，而瀏覽器只會丟一句 `Failed to fetch`——那句話對使用者
// 完全沒有資訊，他會去查網路、查站台，就是不會想到權限。先擋下來講清楚。
async function ensureOrigin(base) {
  let origin;
  try {
    origin = new URL(base).origin;
  } catch (_) {
    throw new Error(T('errBadUrl', base));
  }
  const has = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!has) {
    throw new Error(
      T('errNoHostPerm', origin)
    );
  }
  return origin;
}

async function readDoc(base, path) {
  const url = `${base}/api/doc?path=${encodeURIComponent(path)}`;
  try {
    const res = await fetchT(url, { credentials: 'include' }, 20000);
    if (res.ok && isJson(res)) return (await res.json()).content || '';
  } catch (_) { /* 404＝還沒有這個檔，正常 */ }
  return '';
}

// 一篇一份，跟 Drive 那邊對齊。檔名相同但其實是不同貼文的時候
// （同一天、開頭又剛好一樣）要換一個路徑，不能把兩篇疊進同一個檔——
// 那是「用日期＋標題算 id」的老坑，疊進去之後兩篇都救不回來。
// 唯讀的連線測試。收了一篇才發現寫不進去太慢，設定完就要能當場確認。
// 三種失敗要分得出來：連不上、被導到登入頁、路徑不對。
async function testFocus4ai(rawBase) {
  const base = String(rawBase || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: T('errNoBase') };
  try {
    await ensureOrigin(base);
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  let res;
  try {
    res = await fetchT(`${base}/api/notes?limit=1`, { credentials: 'include' }, 20000);
  } catch (e) {
    return { ok: false, error: T('errF4Unreachable', errMsg(e)) };
  }
  if (!res.ok) {
    return { ok: false, error: T('errF4Status',
      [String(res.status), res.status === 404 ? T('errF4Is404') : '']) };
  }
  if (!isJson(res)) {
    return { ok: false, error: T('errF4NotJsonLogin') };
  }
  const j = await res.json();
  return { ok: true, total: j.total };
}

// 把圖片存進知識庫自己的副本。
//
// 不在 Markdown 裡寫圖床網址是刻意的：臉書與 IG 的網址帶時效簽章，
// 幾天後會全部變 404，而且壞掉時不會有任何提示——那比只寫「12 張」更糟。
// 知識庫端存的是自己的副本（同內容不存兩份，型別看檔頭），我們只要把
// 位元組送過去，它回一段可以直接貼進內文的 markdown。
//
// 一張失敗不能拖垮整篇：收得到幾張算幾張，回報時說清楚。
async function uploadAssets(base, notePath, urls, getBlob, tabId) {
  const md = [];
  const failed = [];
  for (let i = 0; i < urls.length; i++) {
    progress(tabId, T('stepF4Image', [String(i + 1), String(urls.length)]));
    try {
      const blob = await getBlob(urls[i]);
      if (blob.size > 8 * 1024 * 1024) throw new Error(T('errTooBig8mb'));
      const res = await fetchT(`${base}/api/doc/asset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path: notePath, b64: await toBase64(blob) }),
      }, 60000);
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).detail || ''; } catch (_) { /* 非 JSON */ }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      if (!isJson(res)) throw new Error(T('errF4NotJsonShort'));
      const j = await res.json();
      if (j && j.markdown) md.push(j.markdown);
      else throw new Error(T('errF4NoMarkdown'));
    } catch (e) {
      failed.push(errMsg(e));
    }
  }
  return { md, failed };
}

async function syncToFocus4ai(p, key, drive, getBlob, tabId) {
  const s = await chrome.storage.sync.get(['f4Base', 'f4Folder', 'f4Private']);
  const base = String(s.f4Base).replace(/\/+$/, '');
  await ensureOrigin(base); // 沒權限就先講清楚，不要讓瀏覽器丟一句 Failed to fetch
  const folder = String(s.f4Folder || DEF.f4Folder).replace(/^\/+|\/+$/g, '');
  const stem = docStem(p, ymd());

  let path = `${folder}/${stem}.md`;
  let existing = await readDoc(base, path);
  if (existing && (!p.permalink || !existing.includes(p.permalink))) {
    path = `${folder}/${stem}_${key.slice(-4)}.md`;
    existing = await readDoc(base, path);
  }
  const url = `${base}/api/doc?path=${encodeURIComponent(path)}`;

  const stamp = dateTimeStr();

  // 先把圖存進知識庫（它的 save 會自己建 _assets/，所以筆記還不存在也沒關係），
  // 這樣內文可以一次寫好，不用寫兩遍再重建一次索引。
  let assetMd = [];
  let imgLine = '';
  if (p.images && p.images.length && getBlob) {
    const r = await uploadAssets(base, path, p.images, getBlob, tabId);
    assetMd = r.md;
    if (r.failed.length) {
      imgLine = T('mdImagesStored', [String(assetMd.length), String(p.images.length),
        T('mdImagesSomeFailed', [String(r.failed.length), r.failed[0]])]);
    } else if (assetMd.length) {
      imgLine = T('mdImagesCount', String(assetMd.length));
    }
  }
  // 一張都沒存成、或知識庫還不支援附件時，至少讓人從這裡找得到圖
  if (!assetMd.length && p.images && p.images.length) {
    imgLine = drive && drive.docUrl
      ? T('mdImagesInDrive', [String(p.images.length), drive.docUrl])
      : T('mdImagesNotStored', String(p.images.length));
  }
  // 社群貼文多半是公開內容，預設讓它可以被檢索用的模型讀到——
  // 這跟 Mesh Sync 相反（那邊收的是自己的對話，常有客戶名與報價）。
  // 要收私密社團的東西再把 popup 的開關打開。
  const out = [
    '---',
    `title: "${mdEscape(topicOf(p))}"`,
    `source: "${p.permalink}"`,
    `author: "${mdEscape(p.author || T('noAuthor'))}"`,
    `platform: ${p.platform}`,
    `captured: ${stamp}`,
    ...(p.timeText ? [`posted: "${mdEscape(p.timeText)}"`] : []),
    ...(s.f4Private ? ['privacy: local_only'] : []),
    `tags: [${T('mdTags')}]`,
    '---',
    '',
    `# ${topicOf(p)}`,
    '',
    T('mdAuthorLine', [p.author || T('noAuthor'), p.platformLabel,
                       p.timeText ? T('docTimeSuffix', p.timeText) : '']),
    T('mdSourceLine', p.permalink || T('mdNoPermalink')),
    T('mdCollectedLine', stamp),
    ...(imgLine ? [imgLine] : []),
    '',
    cleanText(p.text),
    '',
    ...(assetMd.length ? [...assetMd, ''] : []),
  ].join('\n');

  const res = await fetchT(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // 站台有登入牆時要帶著使用者自己的 session
    body: JSON.stringify({ content: out }),
  }, 30000);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch (_) { /* 非 JSON */ }
    throw new Error(T('errF4Write',
      [String(res.status), detail || res.statusText || T('errF4WriteFailed')]));
  }
  // 被導到登入頁時會拿到 200 + HTML。不擋的話會謊報成功，
  // 而使用者要過很久才發現知識庫裡什麼都沒有。
  if (!isJson(res)) {
    throw new Error(T('errF4NotJsonLogin'));
  }
  const j = await res.json();
  return { path, chunks: j.chunks };
}

// ── 工具 ─────────────────────────────────────────────

function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/ /g, ' ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')  // 寫跳脫形式：字面上的控制字元會讓整個檔被當成 binary，grep 從此靜音
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function dateTimeStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function badge(ok) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#10704a' : '#dc2626' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
}

async function logEntry(entry) {
  const { psLog = [] } = await chrome.storage.local.get(['psLog']);
  psLog.unshift(entry);
  if (psLog.length > 50) psLog.splice(50);
  await chrome.storage.local.set({ psLog });
}
