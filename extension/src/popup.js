// =====================================================
// Post Sync — popup
// 紀錄裡會出現「貼文作者的名字」，那是別人可以隨意填的東西。
// 所以這支檔案裡任何頁面來的字一律走 textContent，沒有一處 innerHTML。
// =====================================================

const $ = (id) => document.getElementById(id);
const DEF = self.POST_SYNC_DEFAULTS;
const I = self.POST_SYNC_I18N;
const t = I.t;

const SYNC_KEYS = [
  'enabled', 'profiles', 'activeProfileId', 'driveEnabled',
  'f4Enabled', 'f4Base', 'f4Folder', 'f4Private', 'albumEnabled',
  'p2sCollect',
];

let profiles = [];
let activeId = '';

function msg(text, ok) {
  const el = $('msg');
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

// ── 載入 ─────────────────────────────────────────────

async function load() {
  // 靜態文字先填，再填設定值。順序反過來的話會先看到一瞬間的空白介面。
  I.fill();

  const s = await chrome.storage.sync.get(SYNC_KEYS);

  $('enabled').checked = s.enabled !== false;
  $('driveEnabled').checked = s.driveEnabled !== false;
  $('albumEnabled').checked = s.albumEnabled !== false;
  $('f4Enabled').checked = !!s.f4Enabled;
  // 空欄位＋placeholder 等於叫人自己打一次。預設值直接填進去，
  // 要改的人反正會改，不用改的人少一個步驟。
  $('f4Base').value = s.f4Base || DEF.f4Base;
  $('f4Folder').value = s.f4Folder || DEF.f4Folder;
  $('f4Private').checked = !!s.f4Private;
  $('p2sCollect').checked = !!s.p2sCollect;

  profiles = Array.isArray(s.profiles) && s.profiles.length
    ? s.profiles
    : [{ id: 'default', name: t('defaultProfileName'),
         folderName: t('defaultFolderName') }];
  activeId = s.activeProfileId || profiles[0].id;
  if (!profiles.some((p) => p.id === activeId)) activeId = profiles[0].id;
  renderProfiles();

  const mf = chrome.runtime.getManifest();
  $('ver').textContent = mf.version_name || `v${mf.version}`;

  checkConn();
  renderLog();
  renderP2sCount();
}

function renderProfiles() {
  const sel = $('profile');
  sel.textContent = '';
  for (const p of profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name; // 使用者自己打的字，一律 textContent
    sel.appendChild(o);
  }
  sel.value = activeId;
  const cur = profiles.find((p) => p.id === activeId);
  $('folderName').value = (cur && cur.folderName) || '';
}

// ── 連線狀態 ─────────────────────────────────────────

function checkConn() {
  chrome.runtime.sendMessage({ type: 'POSTSYNC_STATUS' }, (res) => {
    if (chrome.runtime.lastError) return;
    const on = res && res.connected;
    $('dot').className = `dot${on ? ' on' : ''}`;
    if (on) {
      $('connText').textContent = t('connConnected');
      $('connect').textContent = t('btnReconnect');
    } else if (res && res.reason === 'no_client_id') {
      $('connText').textContent = t('connNoClientId');
      $('connect').textContent = t('btnConnectGoogle');
    } else {
      $('connText').textContent = t('connNotConnected');
      $('connect').textContent = t('btnConnectGoogle');
    }
  });
}

$('connect').addEventListener('click', () => {
  msg(t('connWaiting'), true);
  chrome.runtime.sendMessage({ type: 'POSTSYNC_CONNECT' }, (res) => {
    if (chrome.runtime.lastError) return msg(chrome.runtime.lastError.message, false);
    if (res && res.ok) {
      msg(t('connDone'), true);
      checkConn();
    } else {
      msg(`❌ ${(res && res.error) || t('connFailed')}`, false);
    }
  });
});

// ── profile ──────────────────────────────────────────

$('profile').addEventListener('change', () => {
  // 切走之前先把現在編到一半的資料夾名收起來，不然打的字會不見
  const cur = profiles.find((p) => p.id === activeId);
  if (cur) cur.folderName = $('folderName').value.trim();
  activeId = $('profile').value;
  renderProfiles();
});

$('addProfile').addEventListener('click', () => {
  const name = prompt(t('promptNewProfile'));
  if (!name || !name.trim()) return;
  const id = `p${Date.now()}`;
  profiles.push({ id, name: name.trim(), folderName: `Post Sync — ${name.trim()}` });
  activeId = id;
  renderProfiles();
  msg(t('profileAdded'), true);
});

// ── 儲存 ─────────────────────────────────────────────

// 人會直接複製整條網址過來，後面帶著路徑或斜線。不清洗的話，
// 拼出來的會是 https://站台/xxx/api/doc，錯誤訊息只說查不到，方向全錯。
function cleanBase(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return s.replace(/\/+$/, '');
  }
}

// 使用者填的網址是任意主機，所以權限要當下才要，不預先索取整個網際網路。
// 沒有這一步的話，background 對那個站台的 fetch 會直接被擋掉，
// 而症狀是「按了說成功、知識庫裡什麼都沒有」——最難查的那種。
function ensureHostPermission(base, cb) {
  let origin;
  try {
    origin = new URL(base).origin;
  } catch (_) {
    return msg(t('msgBadUrlLike'), false);
  }
  chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
    if (chrome.runtime.lastError) return msg(`❌ ${chrome.runtime.lastError.message}`, false);
    if (!granted) {
      return msg(t('msgNoPerm', origin), false);
    }
    cb();
  });
}

$('save').addEventListener('click', () => {
  const cur = profiles.find((p) => p.id === activeId);
  if (cur) cur.folderName = $('folderName').value.trim();

  const f4Enabled = $('f4Enabled').checked;
  const f4Base = cleanBase($('f4Base').value);
  if (f4Enabled) {
    if (!f4Base) return msg(t('msgF4NeedsBase'), false);
    let host;
    try { host = new URL(f4Base).hostname; } catch (_) { host = ''; }
    if (/(^|\.)focus4ai\.com$/i.test(host) && !/^app\./i.test(host)) {
      return msg(t('msgF4WrongHost'), false);
    }
  }

  const store = async () => {
    await chrome.storage.sync.set({
      enabled: $('enabled').checked,
      driveEnabled: $('driveEnabled').checked,
      albumEnabled: $('albumEnabled').checked,
      profiles,
      activeProfileId: activeId,
      f4Enabled,
      f4Base,
      f4Folder: $('f4Folder').value.trim() || DEF.f4Folder,
      f4Private: $('f4Private').checked,
      p2sCollect: $('p2sCollect').checked,
    });
    $('f4Base').value = f4Base;
    msg(f4Enabled ? t('msgSavedTestHint') : t('msgSaved'), true);
  };

  // permissions.request 必須在使用者手勢裡呼叫，所以不能有任何 await 卡在前面
  if (f4Enabled && f4Base) ensureHostPermission(f4Base, store);
  else store();
});

// 「收了一篇才發現寫不進去」太慢了，設定完就要能當場確認
$('f4Test').addEventListener('click', () => {
  const base = cleanBase($('f4Base').value);
  if (!base) return msg(t('msgNeedBaseFirst'), false);
  msg(t('msgTesting'), true);
  ensureHostPermission(base, () => {
    chrome.runtime.sendMessage({ type: 'POSTSYNC_F4_TEST', base }, (res) => {
      if (chrome.runtime.lastError) return msg(`❌ ${chrome.runtime.lastError.message}`, false);
      if (res && res.ok) msg(t('msgTestOk', String(res.total)), true);
      else msg(`❌ ${(res && res.error) || t('msgTestFailed')}`, false);
    });
  });
});

// ── 診斷 ─────────────────────────────────────────────
// 「按了沒反應」的第一個檢查點：我改的這份程式，真的有在跑嗎？

$('diag').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return msg(t('diagNoTab'), false);
    chrome.tabs.sendMessage(tabs[0].id, { type: 'POSTSYNC_DIAG' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        return msg(t('diagNoContent'), false);
      }
      const ok = res.posts > 0;
      const lines = [
        t('diagBuild', res.build || '?'),
        t('diagPlatform', [res.label, res.path]),
        t('diagSelector', res.selector),
        t('diagPostsFound', String(res.posts)) + (ok ? '' : t('diagStructDiffers')),
        res.hasActive ? t('diagLockedYes') : t('diagLockedNo'),
        res.enabled ? '' : t('diagFloatOff'),
      ].filter(Boolean);

      // 偵測到 0 則的時候，下一個問題一定是「那這頁到底長什麼樣」。
      // 候選錨點的數量直接列出來，省一趟來回。
      if (!ok && res.probe) {
        lines.push('', t('diagCandidates'));
        for (const [name, n] of Object.entries(res.probe)) {
          const count = n < 0 ? t('diagUnsupported') : String(n);
          lines.push(`  ${n > 0 ? '●' : '○'} ` + t('diagProbeRow', [name, count]));
        }
      }
      // 偵測到了卻沒鎖定：問題在「挑出畫面上那一則」，不在辨識。
      // 每一則的位置與否決理由直接列出來。
      if (res.picks) {
        lines.push('', t('diagEachPost', res.viewport), ...res.picks);
      }
      // 候選全落空時，直接把畫面中央往上的 DOM 路徑報出來——
      // 那就是「該拿什麼當錨點」的答案，不用再猜一輪
      if (!ok && res.sample) {
        lines.push('', t('diagActualDom'), ...res.sample);
      }
      // 「圖片沒收完」要能一眼看出死在哪一關：圖不在 DOM、尺寸被濾掉、
      // 被當成頭像、還是根本找不到翻頁鈕
      const m = res.media;
      if (m) {
        // 「多圖只收到 N 張」有兩種完全不同的原因：DOM 裡本來就只有 N 個
        // <img>（相簿型貼文最多鋪 5 張縮圖，其餘藏在「+7」後面、沒有節點），
        // 或有節點但被濾掉。不分開報的話會往錯的方向修。
        lines.push('', t('diagImages', [String(m.total), String(m.taken)]));
        if (m.moreOverlay) lines.push(t('diagMoreOverlay', m.moreOverlay));
        lines.push(t('diagPhotoLinks',
          [String(m.photoLinks), m.hasNext ? t('diagYes') : t('diagNo')]));
        if (m.imgs.length) lines.push(...m.imgs);
        if (!m.hasNext && m.btns.length) {
          lines.push(t('diagButtons'), ...m.btns);
        }
      }
      if (res.preview) lines.push('', t('diagPreview', res.preview));
      msg(lines.join('\n'), ok);
    });
  });
});

$('clearSeen').addEventListener('click', async () => {
  await chrome.storage.local.set({ psSeen: {} });
  msg(t('msgSeenCleared'), true);
});

// ── 紀錄 ─────────────────────────────────────────────

async function renderLog() {
  const { psLog = [] } = await chrome.storage.local.get(['psLog']);
  const box = $('log');
  box.textContent = '';
  if (!psLog.length) {
    const d = document.createElement('div');
    d.className = 'log-item t';
    d.textContent = t('logEmpty');
    box.appendChild(d);
    return;
  }
  for (const e of psLog.slice(0, 20)) {
    const d = document.createElement('div');
    d.className = `log-item${e.ok ? '' : ' bad'}`;

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${new Date(e.time).toLocaleString('zh-TW', { hour12: false })} `;
    d.appendChild(t);

    const body = document.createElement('span');
    body.textContent = `${e.ok ? '✅' : '❌'} ${e.msg}`; // 含貼文作者名，必須 textContent
    d.appendChild(body);

    if (e.docUrl) {
      d.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = e.docUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = t('linkOpen');
      d.appendChild(a);
    }
    box.appendChild(d);
  }
}


// ── persona-to-skill 匯入檔 ───────────────────────────
// 檔案不經過任何伺服器：background 把 JSON 字串交回來，這裡做成 blob 讓瀏覽器存檔。
// 這樣就不必跟使用者要 downloads 權限，權限清單上少一條要解釋的東西。

async function renderP2sCount() {
  chrome.runtime.sendMessage({ type: 'POSTSYNC_P2S_COUNT' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    $('p2sCount').textContent = res.count
      ? t('p2sCountSome', String(res.count))
      : t('p2sCountNone');
  });
}

$('p2sExport').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'POSTSYNC_P2S_EXPORT' }, (res) => {
    if (chrome.runtime.lastError) return msg(`❌ ${chrome.runtime.lastError.message}`, false);
    if (!res || !res.ok) return msg(`❌ ${(res && res.error) || t('msgP2sExportFailed')}`, false);
    if (!res.count) return msg(t('msgP2sEmpty'), false);
    const url = URL.createObjectURL(new Blob([res.json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = res.name;
    a.click();
    // 彈出視窗一關，blob 就跟著消失。下載已經開始了，但 URL 自己收掉比較乾淨。
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    msg(t('msgP2sExported', [String(res.count), res.name]), true);
  });
});

$('p2sClear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'POSTSYNC_P2S_CLEAR' }, (res) => {
    if (chrome.runtime.lastError) return msg(`❌ ${chrome.runtime.lastError.message}`, false);
    if (!res || !res.ok) return msg(`❌ ${(res && res.error) || t('msgP2sClearFailed')}`, false);
    renderP2sCount();
    msg(t('msgP2sCleared'), true);
  });
});

load();
