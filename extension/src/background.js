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
importScripts('naming.js', 'defaults.js');
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
    title: '⚡ 收這篇貼文',
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

// ── 逾時與錯誤 ───────────────────────────────────────
// 每一個等待都要有盡頭。沒有逾時的等待，使用者看到的是永遠轉圈，
// 而轉圈不帶任何資訊，他只能猜「是慢還是壞了」。

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}逾時（${Math.round(ms / 1000)} 秒沒有回應）`)), ms);
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
      throw new Error(`連線逾時（${Math.round(ms / 1000)} 秒）：${new URL(url).host}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 有些例外的 str() 就是空字串，畫面上只剩「失敗：」，等於沒有訊息
function errMsg(e) {
  return (e && e.message) || (e && e.constructor && e.constructor.name) || '未知錯誤';
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
      '尚未設定 Google OAuth client_id。照 README 的「OAuth 設定」做一次，'
      + '把 client_id 填進 manifest.json；或先關掉 Drive、只用 Focus4ai 知識庫。'
    ));
  }
  // getAuthToken 是 **Chrome 專屬**的：它靠 Chrome 內建的 Google 帳號整合，
  // Arc、Brave、Edge、Vivaldi 這些 Chromium 瀏覽器多半沒有實作。
  // 不講清楚的話，使用者只會看到「未知錯誤」而完全不知道是瀏覽器的問題。
  if (typeof chrome.identity?.getAuthToken !== 'function') {
    return Promise.reject(new Error(
      'Drive 授權需要 Chrome 本身：這個瀏覽器（Arc／Brave／Edge…）沒有提供 '
      + 'Google 帳號整合。收錄功能與 Focus4ai 知識庫同步不受影響，'
      + '只有寫進 Drive 這一項要用 Chrome。'
    ));
  }

  const p = new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        const raw = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
        // 非 Chrome 的 Chromium 有時有這個函式、呼叫卻一定失敗，
        // 訊息還很含糊。把可能的原因一起講出來。
        reject(new Error(
          `${raw || '尚未連接 Google'}`
          + '（若你用的是 Arc／Brave／Edge，Drive 授權需要 Chrome 本身；'
          + '收錄與知識庫同步不受影響）'
        ));
      } else {
        resolve(token);
      }
    });
  });
  // 授權視窗開了沒人理，callback 就永遠不會回來
  return interactive ? withTimeout(p, 120000, 'Google 授權') : p;
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
    throw new Error(`Google API ${res.status}：${detail || res.statusText || '未知錯誤'}`);
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
    const m = 'Drive 與 Focus4ai 都沒有啟用，沒有地方可以寫。請點擴充圖示設定其中一個。';
    await logEntry({ ok: false, msg: m, time: Date.now() });
    badge(false);
    return { ok: false, error: m };
  }

  // 兩個目的地各自獨立：一邊掛了不能把另一邊也拖下水
  let drive = null;
  let driveError = '';
  if (wantDrive) {
    try {
      progress(tabId, '確認 Google 授權…');
      drive = await withAuthRetry((token) => writeDrive(token, p, tabId));
    } catch (e) {
      driveError = errMsg(e);
    }
  }

  let f4 = null;
  let f4Error = '';
  if (wantF4) {
    try {
      progress(tabId, '同步到知識庫…');
      f4 = await syncToFocus4ai(p, key, drive);
    } catch (e) {
      f4Error = errMsg(e);
    }
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
  if (drive) bits.push(`Drive「${drive.docName}」${drive.imgNote ? `（${drive.imgNote}）` : ''}`);
  else if (driveError) bits.push(`Drive 失敗：${driveError}`);
  else bits.push('Drive 未啟用');

  // 圖片張數要講出來——輪播有沒有翻完，看這個數字最快
  if (p.images && p.images.length) bits.push(`圖 ${p.images.length} 張`);
  if (f4) bits.push(`知識庫 ${f4.chunks} 片`);
  else if (f4Error) bits.push(`知識庫失敗：${f4Error}`);
  else bits.push('知識庫未啟用');

  await logEntry({
    ok,
    msg: `${(p.author || '未署名').slice(0, 20)}・${p.platformLabel}：${bits.join('・')}`,
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

async function writeDrive(token, p, tabId) {
  const profile = await activeProfile();
  progress(tabId, '確認 Drive 資料夾…');
  const folderId = await ensureFolder(token, profile);
  progress(tabId, `建立這篇的 Doc（${p.text.length.toLocaleString()} 字）…`);
  const doc = await createPostDoc(token, folderId, p);

  let imgNote = '';
  if (p.images && p.images.length) {
    progress(tabId, `嵌入 ${p.images.length} 張圖…`);
    imgNote = await insertImages(token, doc.docId, folderId, p.images, tabId);
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
    p = { id: 'default', name: '自用', folderName: 'Post Sync 貼文收藏' };
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
      throw new Error('指定的 ID 不是有效的資料夾（可能已刪除）');
    } catch (e) {
      if (e.auth) throw e;
      throw new Error(
        '無法存取你指定的資料夾。本擴充只有「自己建立的檔案」的權限，'
        + '請清空這個欄位讓它自動建立，再到 Google Drive 把該資料夾拖到你想要的位置（搬移後仍然有效）。'
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
  const name = String(profile.folderName || `Post Sync — ${profile.name}`).trim() || 'Post Sync 貼文收藏';
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
  const meta = `${p.author || '未署名'}・${p.platformLabel}${p.timeText ? `・${p.timeText}` : ''}・收錄於 ${dateTimeStr()}\n`;
  // 抓不到連結就明講。寫一個「https://www.facebook.com/」進去更糟——
  // 看起來像有連結，點下去卻回到動態牆首頁。
  const link = p.permalink
    ? `${p.permalink}\n\n`
    : `（這一則抓不到原文連結，於 ${p.pageUrl || '動態牆'} 收錄）\n\n`;
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

async function viaDrive(token, docId, folderId, url) {
  const res = await fetchT(url, {}, 30000);
  if (!res.ok) throw new Error(`下載失敗 ${res.status}`);
  const blob = await res.blob();
  // Docs API 對嵌入圖片的上限是 50MB / 2500 萬像素，超過就別浪費一次來回
  if (blob.size > 45 * 1024 * 1024) throw new Error('圖片過大');

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
  if (!up.ok) throw new Error(`上傳失敗 ${up.status}`);
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

async function insertImages(token, docId, folderId, urls, tabId) {
  const failed = [];
  let done = 0;
  for (const url of urls) {
    progress(tabId, `嵌入圖片 ${done + failed.length + 1}/${urls.length}…`);
    try {
      await insertOneImage(token, docId, url);
      done++;
      continue;
    } catch (_) { /* 第一層被擋，換第二層 */ }
    try {
      await viaDrive(token, docId, folderId, url);
      done++;
    } catch (e) {
      failed.push(url);
    }
  }

  if (failed.length) {
    // 失敗的不能安靜地消失，但也不能假裝那些網址還會活著
    const note = `（另有 ${failed.length} 張圖嵌入失敗，以下網址通常幾天後就會失效）\n${failed.join('\n')}\n`;
    try {
      const end = await docEnd(token, docId);
      await api(token, 'POST', `${DOCS}/documents/${docId}:batchUpdate`, {
        requests: [{ insertText: { location: { index: end }, text: note } }],
      });
    } catch (_) { /* 連註記都寫不進去就算了，回傳值還是會說 */ }
  }
  return failed.length ? `圖 ${done}/${urls.length}` : '';
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
    throw new Error(`網址格式不對：${base}`);
  }
  const has = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!has) {
    throw new Error(
      `缺少存取 ${origin} 的權限。請點擴充圖示 →「儲存設定」→ `
      + '在 Chrome 跳出的確認視窗按「允許」'
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
  if (!base) return { ok: false, error: '沒有填站台網址' };
  try {
    await ensureOrigin(base);
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  let res;
  try {
    res = await fetchT(`${base}/api/notes?limit=1`, { credentials: 'include' }, 20000);
  } catch (e) {
    return { ok: false, error: `連不上：${errMsg(e)}（網址對嗎？站台有在跑嗎？）` };
  }
  if (!res.ok) {
    return { ok: false, error: `站台回 ${res.status}${res.status === 404 ? '（這個網址沒有 /api，確認是站台不是官網）' : ''}` };
  }
  if (!isJson(res)) {
    return { ok: false, error: '回應不是 JSON，通常代表被導到登入頁。請先在這個瀏覽器登入該站台' };
  }
  const j = await res.json();
  return { ok: true, total: j.total };
}

async function syncToFocus4ai(p, key, drive) {
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
  // 社群貼文多半是公開內容，預設讓它可以被檢索用的模型讀到——
  // 這跟 Mesh Sync 相反（那邊收的是自己的對話，常有客戶名與報價）。
  // 要收私密社團的東西再把 popup 的開關打開。
  const out = [
    '---',
    `title: "${mdEscape(topicOf(p))}"`,
    `source: "${p.permalink}"`,
    `author: "${mdEscape(p.author || '未署名')}"`,
    `platform: ${p.platform}`,
    `captured: ${stamp}`,
    ...(p.timeText ? [`posted: "${mdEscape(p.timeText)}"`] : []),
    ...(s.f4Private ? ['privacy: local_only'] : []),
    'tags: [post-sync, 社群貼文]',
    '---',
    '',
    `# ${topicOf(p)}`,
    '',
    `- 作者：${p.author || '未署名'}・${p.platformLabel}${p.timeText ? `・${p.timeText}` : ''}`,
    `- 原文：${p.permalink || '（抓不到連結）'}`,
    `- 收錄：${stamp}`,
    // 知識庫存的是文字，圖片在 Drive 的那份文件裡。
    // 只寫「12 張」的話，人從知識庫翻到這篇時看得到數字卻找不到圖。
    // 不寫圖片網址是刻意的：臉書的圖床網址帶時效，寫進去幾天後
    // 會全部變成破圖，那比只有數字更糟。
    ...(p.images && p.images.length
      ? [drive && drive.docUrl
        ? `- 圖片：${p.images.length} 張 → [在 Drive 文件裡看](${drive.docUrl})`
        : `- 圖片：${p.images.length} 張（沒有寫進 Drive，所以這裡沒有圖）`]
      : []),
    '',
    cleanText(p.text),
    '',
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
    throw new Error(`Focus4ai ${res.status}：${detail || res.statusText || '寫入失敗'}`);
  }
  // 被導到登入頁時會拿到 200 + HTML。不擋的話會謊報成功，
  // 而使用者要過很久才發現知識庫裡什麼都沒有。
  if (!isJson(res)) {
    throw new Error('回應不是 JSON，通常代表被導到登入頁；請先在瀏覽器登入該站台再試');
  }
  const j = await res.json();
  return { path, chunks: j.chunks };
}

// ── 工具 ─────────────────────────────────────────────

function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/ /g, ' ')
    .replace(/[ --]/g, '')
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
