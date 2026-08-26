// =====================================================
// Post Sync — popup
// 紀錄裡會出現「貼文作者的名字」，那是別人可以隨意填的東西。
// 所以這支檔案裡任何頁面來的字一律走 textContent，沒有一處 innerHTML。
// =====================================================

const $ = (id) => document.getElementById(id);
const DEF = self.POST_SYNC_DEFAULTS;

const SYNC_KEYS = [
  'enabled', 'profiles', 'activeProfileId', 'driveEnabled',
  'f4Enabled', 'f4Base', 'f4Folder', 'f4Private',
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
  const s = await chrome.storage.sync.get(SYNC_KEYS);

  $('enabled').checked = s.enabled !== false;
  $('driveEnabled').checked = s.driveEnabled !== false;
  $('f4Enabled').checked = !!s.f4Enabled;
  // 空欄位＋placeholder 等於叫人自己打一次。預設值直接填進去，
  // 要改的人反正會改，不用改的人少一個步驟。
  $('f4Base').value = s.f4Base || DEF.f4Base;
  $('f4Folder').value = s.f4Folder || DEF.f4Folder;
  $('f4Private').checked = !!s.f4Private;

  profiles = Array.isArray(s.profiles) && s.profiles.length
    ? s.profiles
    : [{ id: 'default', name: '自用', folderName: 'Post Sync 貼文收藏' }];
  activeId = s.activeProfileId || profiles[0].id;
  if (!profiles.some((p) => p.id === activeId)) activeId = profiles[0].id;
  renderProfiles();

  const mf = chrome.runtime.getManifest();
  $('ver').textContent = mf.version_name || `v${mf.version}`;

  checkConn();
  renderLog();
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
      $('connText').textContent = '已連接 Google Drive';
      $('connect').textContent = '重新連接';
    } else if (res && res.reason === 'no_client_id') {
      $('connText').textContent = 'Drive 未設定（見 README）';
      $('connect').textContent = '連接 Google';
    } else {
      $('connText').textContent = '尚未連接 Google';
      $('connect').textContent = '連接 Google';
    }
  });
}

$('connect').addEventListener('click', () => {
  msg('等待 Google 授權視窗…', true);
  chrome.runtime.sendMessage({ type: 'POSTSYNC_CONNECT' }, (res) => {
    if (chrome.runtime.lastError) return msg(chrome.runtime.lastError.message, false);
    if (res && res.ok) {
      msg('✅ 已連接', true);
      checkConn();
    } else {
      msg(`❌ ${(res && res.error) || '連接失敗'}`, false);
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
  const name = prompt('新的收藏對象名稱（例如：客戶 A、選書、產業觀察）');
  if (!name || !name.trim()) return;
  const id = `p${Date.now()}`;
  profiles.push({ id, name: name.trim(), folderName: `Post Sync — ${name.trim()}` });
  activeId = id;
  renderProfiles();
  msg('新增了，記得按「儲存設定」', true);
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
    return msg('❌ 網址格式不對，要像 https://app.focus4ai.com', false);
  }
  chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
    if (chrome.runtime.lastError) return msg(`❌ ${chrome.runtime.lastError.message}`, false);
    if (!granted) {
      return msg(`❌ 沒有取得存取 ${origin} 的權限，知識庫同步不會運作`, false);
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
    if (!f4Base) return msg('❌ 開了知識庫同步就要填站台網址', false);
    let host;
    try { host = new URL(f4Base).hostname; } catch (_) { host = ''; }
    if (/(^|\.)focus4ai\.com$/i.test(host) && !/^app\./i.test(host)) {
      return msg('❌ focus4ai.com 是官網、沒有 API。線上站台請填 https://app.focus4ai.com', false);
    }
  }

  const store = async () => {
    await chrome.storage.sync.set({
      enabled: $('enabled').checked,
      driveEnabled: $('driveEnabled').checked,
      profiles,
      activeProfileId: activeId,
      f4Enabled,
      f4Base,
      f4Folder: $('f4Folder').value.trim() || DEF.f4Folder,
      f4Private: $('f4Private').checked,
    });
    $('f4Base').value = f4Base;
    msg(f4Enabled ? '✅ 已儲存，建議按一次「測試知識庫」確認寫得進去' : '✅ 已儲存', true);
  };

  // permissions.request 必須在使用者手勢裡呼叫，所以不能有任何 await 卡在前面
  if (f4Enabled && f4Base) ensureHostPermission(f4Base, store);
  else store();
});

// 「收了一篇才發現寫不進去」太慢了，設定完就要能當場確認
$('f4Test').addEventListener('click', () => {
  const base = cleanBase($('f4Base').value);
  if (!base) return msg('❌ 先填站台網址', false);
  msg('⏳ 測試中…', true);
  ensureHostPermission(base, () => {
    chrome.runtime.sendMessage({ type: 'POSTSYNC_F4_TEST', base }, (res) => {
      if (chrome.runtime.lastError) return msg(`❌ ${chrome.runtime.lastError.message}`, false);
      if (res && res.ok) msg(`✅ 連得上，知識庫目前有 ${res.total} 份文件`, true);
      else msg(`❌ ${(res && res.error) || '測試失敗'}`, false);
    });
  });
});

// ── 診斷 ─────────────────────────────────────────────
// 「按了沒反應」的第一個檢查點：我改的這份程式，真的有在跑嗎？

$('diag').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return msg('❌ 找不到目前分頁', false);
    chrome.tabs.sendMessage(tabs[0].id, { type: 'POSTSYNC_DIAG' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        return msg('❌ 這個分頁沒有 Post Sync（不是支援的平台，或頁面要重新整理一次）', false);
      }
      const ok = res.posts > 0;
      const lines = [
        `版本：${res.build || '?'}`,
        `平台：${res.label}　頁面：${res.path}`,
        `錨點 ${res.selector}`,
        `→ 偵測到 ${res.posts} 則貼文${ok ? '' : '　⚠️ 這一頁的結構不一樣'}`,
        res.hasActive ? '目前鎖定：有' : '目前鎖定：無（捲動一下）',
        res.enabled ? '' : '⚠️ 浮動按鈕已關閉',
      ].filter(Boolean);

      // 偵測到 0 則的時候，下一個問題一定是「那這頁到底長什麼樣」。
      // 候選錨點的數量直接列出來，省一趟來回。
      if (!ok && res.probe) {
        lines.push('', '這一頁的候選錨點：');
        for (const [name, n] of Object.entries(res.probe)) {
          lines.push(`  ${n > 0 ? '●' : '○'} ${name}：${n < 0 ? '不支援' : n}`);
        }
      }
      // 偵測到了卻沒鎖定：問題在「挑出畫面上那一則」，不在辨識。
      // 每一則的位置與否決理由直接列出來。
      if (res.picks) {
        lines.push('', `視窗 ${res.viewport}　偵測到的每一則：`, ...res.picks);
      }
      // 候選全落空時，直接把畫面中央往上的 DOM 路徑報出來——
      // 那就是「該拿什麼當錨點」的答案，不用再猜一輪
      if (!ok && res.sample) {
        lines.push('', '畫面中央往上的實際結構：', ...res.sample);
      }
      // 「圖片沒收完」要能一眼看出死在哪一關：圖不在 DOM、尺寸被濾掉、
      // 被當成頭像、還是根本找不到翻頁鈕
      const m = res.media;
      if (m) {
        // 「多圖只收到 N 張」有兩種完全不同的原因：DOM 裡本來就只有 N 個
        // <img>（相簿型貼文最多鋪 5 張縮圖，其餘藏在「+7」後面、沒有節點），
        // 或有節點但被濾掉。不分開報的話會往錯的方向修。
        lines.push('', `圖片：DOM 裡 ${m.total} 個 <img>，過濾後收 ${m.taken} 張`);
        if (m.moreOverlay) {
          lines.push(`⚠️ 看到「${m.moreOverlay}」疊圖 —— 相簿型貼文，`
            + '其餘的圖根本不在 DOM 裡，不是被濾掉');
        }
        lines.push(`/photo 連結：${m.photoLinks} 個`
          + `　翻頁鈕：${m.hasNext ? '有' : '無'}`);
        if (m.imgs.length) lines.push(...m.imgs);
        if (!m.hasNext && m.btns.length) {
          lines.push('這一則裡的按鈕：', ...m.btns);
        }
      }
      if (res.preview) lines.push('', `預覽：${res.preview}`);
      msg(lines.join('\n'), ok);
    });
  });
});

$('clearSeen').addEventListener('click', async () => {
  await chrome.storage.local.set({ psSeen: {} });
  msg('✅ 去重紀錄已清空，之前收過的會被當成新的', true);
});

// ── 紀錄 ─────────────────────────────────────────────

async function renderLog() {
  const { psLog = [] } = await chrome.storage.local.get(['psLog']);
  const box = $('log');
  box.textContent = '';
  if (!psLog.length) {
    const d = document.createElement('div');
    d.className = 'log-item t';
    d.textContent = '還沒有收過任何貼文';
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
      a.textContent = '開啟 ↗';
      d.appendChild(a);
    }
    box.appendChild(d);
  }
}

load();
