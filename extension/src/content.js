// =====================================================
// Post Sync — Content Script v1.0
//
// 做一件事：認出「目前畫面上的那一則貼文」，讓使用者按一下收走。
// 觸發一律是人按的（浮動按鈕或快速鍵），沒有任何自動收集、
// 也不會自己捲動——那一秒就從「使用者閱讀」變成「自動化擷取」，
// 帳號風險完全不同，這條線不能越。
//
// 安全原則：頁面資料一律用 textContent 塞進 DOM，不走 innerHTML。
// =====================================================

(function () {
  'use strict';

  const NS = self.POST_SYNC;
  const EX = self.POST_SYNC_EXTRACT; // 抽取層，見 src/extract.js
  // POST_SYNC_HOST 只有 tests/live.html 會設：file:// 的 location.hostname 是
  // 空字串，不給接縫的話測試頁永遠走不到這一行以下。正式環境沒有人設它。
  const ad = NS && NS.adapterFor(self.POST_SYNC_HOST || location.hostname);
  if (!ad || !EX) return; // 認不出的網域整個不啟動

  // 診斷用：頁面上看得到這個屬性，就代表 content script 真的有被注入
  document.documentElement.dataset.postSync = `1.0.0/${ad.id}`;

  let enabled = true;
  const WATCH = ['enabled'];
  chrome.storage.sync.get(WATCH, (r) => {
    enabled = r.enabled !== false;
    if (!enabled) hideBtn();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'sync') return;
    if (ch.enabled) {
      enabled = ch.enabled.newValue !== false;
      if (!enabled) hideBtn();
      else schedule();
    }
  });

  // ── 貼文清單 ──────────────────────────────────────
  // 留言在臉書也是 role="article"，巢狀命中要濾掉，只留最外層那一層。

  let posts = [];

  function refreshPosts() {
    posts = EX.outermost(ad, document);
  }

  // ── 目前這一則 ────────────────────────────────────
  // 「畫面上那一篇」＝ 蓋住視窗垂直中線、且可見面積最大的那一則。

  let active = null;

  function pickActive() {
    const mid = window.innerHeight / 2;
    let best = null;
    let bestArea = 0;
    for (const el of posts) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 60 || r.top > window.innerHeight - 40) continue;
      if (r.height < 80) continue; // 太矮的多半是佔位或廣告殼
      const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      if (visible <= 0) continue;
      // 跨過中線的優先，其次才比可見面積
      const score = (r.top <= mid && r.bottom >= mid) ? visible + 100000 : visible;
      if (score > bestArea) {
        bestArea = score;
        best = el;
      }
    }
    setActive(best);
  }

  function setActive(el) {
    if (el === active) {
      position();
      return;
    }
    if (active) active.classList.remove('postsync-active');
    active = el;
    if (active) active.classList.add('postsync-active');
    position();
  }

  // ── 浮動按鈕 ──────────────────────────────────────

  let btn = null;

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'postsync-btn';
    btn.textContent = '⚡ 收這篇';
    btn.title = '把這則貼文存進 Post Sync';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      capture(active);
    });
    document.body.appendChild(btn);
    return btn;
  }

  function hideBtn() {
    if (btn) btn.style.display = 'none';
    if (active) active.classList.remove('postsync-active');
    active = null;
  }

  function position() {
    if (!enabled || !active) {
      if (btn) btn.style.display = 'none';
      return;
    }
    const b = ensureBtn();
    b.style.display = 'block';
    const r = active.getBoundingClientRect();
    const w = b.offsetWidth || 96;
    const h = b.offsetHeight || 32;
    // 預設貼在貼文右邊「外面」，不擋內容；視窗不夠寬才收進來
    let left = r.right + 10;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w - 10);
    const top = Math.min(Math.max(r.top + 10, 64), window.innerHeight - h - 16);
    b.style.left = `${Math.round(left)}px`;
    b.style.top = `${Math.round(top)}px`;
  }

  // ── 排程：捲動用 rAF、DOM 變動用 debounce ──────────
  // 無限捲動的動態牆每秒都在改 DOM，每次變動都重掃 role="article"
  // 會把整頁拖慢，所以掃描與定位分開節流。

  let ticking = false;
  function schedule() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!enabled) return;
      pickActive();
    });
  }

  let listTimer = null;
  const mo = new MutationObserver(() => {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => {
      refreshPosts();
      schedule();
    }, 400);
  });

  // 捲動要用「捕獲階段掛在 document 上」，不能只聽 window。
  // 臉書的動態牆是在一個內層容器裡捲的，那種 scroll 事件不會冒泡到 window，
  // 只聽 window 的話貼文一直在動、程式卻完全不知道，按鈕就永遠不出現。
  document.addEventListener('scroll', schedule, { passive: true, capture: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('wheel', schedule, { passive: true });
  mo.observe(document.body, { childList: true, subtree: true });
  refreshPosts();
  schedule();

  // 動態牆是慢慢長出來的，document_idle 當下常常一則都還沒有。
  // 補幾次重試，讓使用者不用先捲一下才看得到按鈕。
  [400, 1200, 2500, 5000].forEach((ms) => setTimeout(() => {
    refreshPosts();
    schedule();
  }, ms));

  // ── 展開「查看更多」 ──────────────────────────────
  // 不展開就只收到半篇，而且不會有任何錯誤訊息——三個月後翻到才會發現。
  //
  // 絕對不點 <a href>：X 的「Show more」是連結，按下去會直接跳走，
  // 貼文就從畫面上消失了。收到截斷的內容也好過整個跳頁。

  // 按鈕的「標籤」要把 aria-label 一起看。反過來說，判斷「這是不是展開鈕」
  // 只能用嚴格比對——IG 的「⋯」按鈕裡有一個 <title>更多選項</title>，
  // 而 SVG 的 title 會被算進 textContent。
  function labelOf(el) {
    return `${el.getAttribute('aria-label') || ''} ${(el.textContent || '')}`
      .replace(/\s+/g, ' ').trim();
  }

  // needSize：一般情況要求按鈕有實際尺寸（避免按到藏起來的東西）。
  // 但整則被平台摺疊時，裡面每個元素的 rect 都是 0×0，這時候不能用尺寸判斷。
  function clickable(el, needSize = true) {
    if (el.closest('a[href]')) return false;
    if (el.tagName === 'A' && el.getAttribute('href')) return false;
    // 誤按選單／檢舉／取消追蹤是會造成真實後果的，寧可少展開也不能按錯
    if (NS.MENU_DENY.test(labelOf(el))) return false;
    if (!needSize) return true;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function moreButtons(root) {
    // 臉書會把捲出畫面的貼文摺疊成佔位（content-visibility），
    // 整則高度變成 0，裡面每個元素的 rect 也都是 0×0。
    // 這時候還照尺寸過濾的話，「查看更多」會全部被當成看不見的東西丟掉，
    // 於是收到的是半篇——而且不會有任何錯誤訊息。
    const collapsed = root.getBoundingClientRect().height < 4;
    const out = [];
    for (const el of root.querySelectorAll('[role="button"], button, span[dir="auto"]')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 12) continue;
      if (!ad.more.test(t)) continue; // 錨定比對，不是「包含」
      if (!clickable(el, !collapsed)) continue;
      // 巢狀貼文（＝留言）裡的「更多」不干我們的事
      if (el.closest(ad.post) !== root) continue;
      out.push(el);
    }
    return out;
  }

  // 誤觸的最後一道防線：我們按下去之後如果冒出對話框（檢舉、選單…），
  // 立刻用 Esc 收掉並停止展開，不要把那個畫面留在使用者面前。
  function dialogCount() {
    return document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
  }

  async function dismissDialog() {
    for (const target of [document.activeElement || document.body, document.body]) {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
      }));
    }
    await sleep(250);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function expandAll(root) {
    const before = dialogCount();
    // 很長的貼文可能要按兩三次才全開，但也要有盡頭，不能無限迴圈
    for (let i = 0; i < 3; i++) {
      const btns = moreButtons(root);
      if (!btns.length) return i;
      for (const b of btns) {
        b.click();
        await sleep(220);
        if (dialogCount() > before) {
          await dismissDialog();
          return i; // 按到不該按的東西就收手，剩下的展開不做了
        }
      }
      await sleep(300);
    }
    return 3;
  }

  // ── 輪播 ──────────────────────────────────────────
  // IG 的多圖貼文一次只把當下那張放進 DOM，不翻過去就只收得到第一張。
  // 這是「把使用者已經打開的這一則看完」，不是自動巡覽，所以只在按下收錄
  // 之後、只在這一則裡面走，而且有次數上限。

  // IG 的輪播箭頭只有滑鼠移上去才出現。沒有這一步，nextButton 永遠找不到
  // 那顆按鈕，於是輪播根本沒翻頁——症狀就是「只收到兩張圖」。
  function hover(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(r.height / 2, 200);
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') && self.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      }));
    }
  }

  function nextButton(root) {
    if (!ad.next) return null;
    for (const b of root.querySelectorAll('button, [role="button"]')) {
      // aria-label 要嚴格比對整串；「下一張」不能寫成包含比對，
      // 不然「下一步」「更多選項」那類東西都會被當成翻頁鈕
      const aria = (b.getAttribute('aria-label') || '').trim();
      const txt = (b.textContent || '').trim();
      if (!ad.next.test(aria) && !ad.next.test(txt)) continue;
      if (!clickable(b)) continue;
      return b;
    }
    return null;
  }

  // 剛翻過去的那一張常常還在載入：版面寬高是 0、naturalWidth 也還是 0，
  // 這時候去讀就會整張漏掉——「照片沒收完」多半是這個，不是選擇器的問題。
  async function waitImages(root, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const imgs = [...root.querySelectorAll('img')];
      if (imgs.length && imgs.every((i) => i.complete)) return;
      await sleep(150);
    }
  }

  async function collectCarousel(root) {
    await waitImages(root);
    const seen = new Set(EX.images(ad, root));
    if (!ad.next) return [...seen];

    let dry = 0;
    // IG 的輪播上限是 20 張，多留幾步當緩衝，但一定要有盡頭
    for (let i = 0; i < 24; i++) {
      if (!document.contains(root)) break; // 平台把整個節點換掉了
      hover(root);
      await sleep(120);
      const btn = nextButton(root);
      if (!btn) break;
      btn.click();
      await sleep(350);
      await waitImages(root);

      const before = seen.size;
      EX.images(ad, root).forEach((u) => seen.add(u));
      // 到最後一張時按鈕通常還在、只是沒作用。連續兩次沒有新圖才收手——
      // 只判一次的話，中間夾一張影片（拿不到 img）就會提早停，
      // 後面的照片全部漏掉。
      if (seen.size === before) {
        dry++;
        if (dry >= 2) break;
      } else {
        dry = 0;
      }
    }
    return [...seen];
  }

  // ── 收錄 ──────────────────────────────────────────

  let busy = false;

  async function capture(root, force) {
    if (busy) return;
    if (!root || !document.contains(root)) {
      toast('❌ 這一則已經不在畫面上了，捲一下再試', null, 5000);
      return;
    }
    busy = true;
    if (btn) btn.disabled = true;
    try {
      toast('⏳ 展開全文…', null, 0, true);
      await expandAll(root);
      const data = EX.extract(ad, root);
      if (ad.next) {
        toast('⏳ 翻過輪播收圖…', null, 0, true);
        data.images = await collectCarousel(root);
      }
      if (!data.text || data.text.length < 5) {
        toast('❌ 抓不到這一則的內文（平台可能改版了）', null, 8000);
        return;
      }
      await send(data, force);
    } catch (e) {
      toast(`❌ ${(e && e.message) || '未知錯誤'}`, null, 8000);
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  // 只負責送出與等回應，不碰畫面（好讓別的呼叫端自己決定要怎麼顯示）。
  // 背景服務可能被瀏覽器休眠而讓回呼永遠不來，不設看門狗就是無盡轉圈。
  // 重載擴充之後，已經開著的分頁裡跑的還是舊版 content script，它跟新的
  // 背景服務已經斷線（chrome.runtime 直接變成 undefined）。這件事在開發期間
  // 每次按 ⟳ 都會發生，不該讓使用者看到一句 JS 原始錯誤然後不知道要做什麼。
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  const DEAD_MSG = '擴充剛剛更新過，這個分頁還連著舊版。按 Cmd+R（Windows 是 F5）重新整理這一頁就好。';

  function sendOne(data, force) {
    return new Promise((resolve) => {
      if (!extAlive()) return resolve({ ok: false, error: DEAD_MSG });
      const wd = setTimeout(
        () => resolve({ ok: false, error: '超過三分鐘沒有回應' }),
        180000,
      );
      chrome.runtime.sendMessage(
        { type: 'POSTSYNC_CAPTURE', payload: data, force: !!force },
        (res) => {
          clearTimeout(wd);
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: chrome.runtime.lastError.message });
          }
          resolve(res || { ok: false, error: '沒有回應' });
        },
      );
    });
  }

  function send(data, force) {
    return new Promise((resolve) => {
      toast(`⏳ 準備寫入…（${data.text.length.toLocaleString()} 字・${data.images.length} 張圖）`, null, 0, true);
      sendOne(data, force).then((res) => {
        if (res && res.error && !res.dup && !res.ok) {
          toast(`❌ ${res.error}`, null, 10000);
          return resolve();
        }
        if (res && res.dup) {
          dupToast(data, res.prev);
          return resolve();
        }
        if (res && res.ok) {
          // 訊息由 background 組好，這裡只負責顯示。
          // 成功的訊息看過就好，不要一直杵在畫面上擋東西；
          // 想點「開啟 Doc」的話滑鼠移過去就會停止倒數。
          toast(`✅ 已收錄\n${(res.bits || []).join('\n')}`,
            res.drive && res.drive.docUrl, 9000);
        } else {
          toast(`❌ 寫入失敗：${(res && res.error) || '未知錯誤'}`, null, 10000);
        }
        resolve();
      });
    });
  }

  // ── 右鍵選單 ──────────────────────────────────────
  // 主要入口。右鍵點在哪一篇上就是哪一篇，沒有「它到底鎖到哪則」的歧義，
  // 而且浮動按鈕萬一沒出來（平台改版、版面特殊）這條路還在。
  //
  // contextMenus 的回呼不會告訴你點到哪個元素，所以自己記下最後右鍵的目標。
  // 用捕獲階段，頁面自己攔掉 contextmenu 事件時才不會漏記。

  let lastRightClicked = null;
  let lastPoint = null;
  document.addEventListener('contextmenu', (ev) => {
    lastRightClicked = ev.target;
    lastPoint = { x: ev.clientX, y: ev.clientY };
  }, true);

  // 後備：DOM 上往上找不到（點到浮層、絕對定位的元素、被 portal 搬走的節點），
  // 就改用座標去命中——視覺上點在哪一則裡面，就是哪一則。
  function postAtPoint(pt) {
    if (!pt) return null;
    refreshPosts();
    for (const el of posts) {
      const r = el.getBoundingClientRect();
      if (pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom) return el;
    }
    return null;
  }

  // 「找不到」這三個字本身沒有資訊。認不出貼文的時候，唯一有用的證據是
  // 「從點到的地方往上，這條路上有什麼」——照著它就知道該換哪個錨點，
  // 不用叫使用者去開 DevTools 貼一堆東西回來。
  const TELL_ATTRS = [
    'role', 'aria-posinset', 'data-pagelet', 'data-ad-preview',
    'aria-labelledby', 'aria-describedby', 'data-visualcompletion', 'data-testid',
  ];

  // 臉書的 class 是亂數（x1i10hfl），列出來只是雜訊；
  // LinkedIn 的 class 反而是語意化的，而且是唯一認得出貼文的東西。
  // 所以不是「要不要看 class」，是「這個 class 看起來有沒有意義」。
  function usefulClasses(el) {
    return [...(el.classList || [])]
      .filter((c) => c.includes('-') && c.length > 6 && !/^x[0-9a-z]{5,}$/.test(c))
      .slice(0, 2);
  }

  function describe(el) {
    if (!el || !el.tagName) return '（沒抓到右鍵的目標）';
    const bits = [`<${el.tagName.toLowerCase()}>`];
    for (const a of TELL_ATTRS) {
      const v = el.getAttribute(a);
      if (v) bits.push(`${a}="${v.slice(0, 14)}"`);
    }
    const cls = usefulClasses(el);
    if (cls.length) bits.push(`.${cls.join('.')}`);
    return bits.join(' ');
  }

  // 往上爬，只列出「身上有辨識屬性」的那幾層。全部列出來會有三十層 div，
  // 看不出重點；有屬性的那幾層才是可以拿來當錨點的候選。
  function ancestry(el, max = 12) {
    const out = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && out.length < max && depth < 40) {
      if (TELL_ATTRS.some((a) => cur.getAttribute(a)) || usefulClasses(cur).length) {
        const h = Math.round(cur.getBoundingClientRect().height);
        out.push(`  ↑${depth} ${describe(cur)} h=${h}`);
      }
      cur = cur.parentElement;
      depth++;
    }
    return out.length ? out : ['  （往上 40 層都沒有任何辨識屬性）'];
  }

  // ── 訊息 ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'POSTSYNC_CONTEXT') {
      const el = (lastRightClicked && EX.outermostOf(ad, lastRightClicked))
        || postAtPoint(lastPoint)
        || active;
      if (el) {
        capture(el);
      } else {
        // 三條路都沒中：把現場證據直接寫在畫面上，不要叫人去開 Console。
        // 往上的那條路徑就是「該拿什麼當錨點」的答案。
        refreshPosts();
        toast(
          `❌ 認不出這是哪一則貼文\n`
          + `・這一頁 ${ad.post} 只找到 ${posts.length} 個\n`
          + `・你點的是 ${describe(lastRightClicked)}\n`
          + `・往上這條路上有：\n${ancestry(lastRightClicked).join('\n')}`,
          null, 120000,
        );
      }
      return false;
    }
    if (msg.type === 'POSTSYNC_HOTKEY') {
      if (enabled && active) capture(active);
      return false;
    }
    if (msg.type === 'POSTSYNC_PROGRESS') {
      const span = statusEl && statusEl.querySelector('.postsync-status-text');
      if (span) span.textContent = `⏳ ${msg.text}`;
      return false;
    }
    // 診斷：讓程式自己交出證據，不用開主控台猜。
    // 「偵測到 0 則」之後的下一個問題一定是「那這頁到底長什麼樣」，
    // 所以順便把幾個候選錨點各數一遍，一次問完。
    if (msg.type === 'POSTSYNC_DIAG') {
      (async () => {
        refreshPosts();
        const probe = {};
        for (const [name, sel] of Object.entries(PROBES)) {
          try {
            probe[name] = document.querySelectorAll(sel).length;
          } catch (_) {
            probe[name] = -1; // 這個瀏覽器不支援這種選擇器
          }
        }
        // 量之前要先 hover：IG 的輪播箭頭沒有滑鼠移上去不會出現，
        // 不 hover 就量的話一定回報「找不到翻頁鈕」，等於白量一次
        let media = null;
        if (active) {
          hover(active);
          await sleep(250);
          media = mediaProbe(active);
        }
        sendResponse({
          platform: ad.id,
          label: ad.label,
          selector: ad.post,
          posts: posts.length,
          hasActive: !!active,
          preview: active ? EX.postText(ad, active).slice(0, 120) : '',
          enabled,
          path: location.pathname,
          probe,
          media,
          // 一則都認不出來時，唯一有用的是「這一頁實際長什麼樣」
          sample: posts.length ? null : domSample(),
        });
      })();
      return true; // 非同步回覆
    }
    return false;
  });

  // 「圖片沒收完」猜不出來，因為可能死在四個地方：圖根本不在 DOM、
  // 尺寸被過濾掉、被當成頭像、或翻頁鈕根本找不到。把四件事一次量出來。
  function mediaProbe(root) {
    const imgs = [...root.querySelectorAll('img')].slice(0, 16).map((i) => {
      const r = i.getBoundingClientRect();
      const alt = (i.getAttribute('alt') || '').replace(/\s+/g, ' ').slice(0, 16);
      const flags = [];
      if (i.closest('header')) flags.push('header');
      if (!i.complete) flags.push('載入中');
      return `  ${Math.round(r.width)}×${Math.round(r.height)}`
        + ` nat ${i.naturalWidth}×${i.naturalHeight}`
        + (flags.length ? ` [${flags.join(' ')}]` : '')
        + (alt ? ` alt="${alt}"` : ' 無 alt');
    });

    const btns = [...root.querySelectorAll('button, [role="button"]')].map((b) => {
      const r = b.getBoundingClientRect();
      const l = (b.getAttribute('aria-label') || b.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 20);
      return l ? `  「${l}」${Math.round(r.width)}×${Math.round(r.height)}` : '';
    }).filter(Boolean).slice(0, 16);

    return {
      taken: EX.images(ad, root).length,
      hasNext: !!nextButton(root),
      imgs,
      btns,
    };
  }

  // 平台改版時要換的錨點候選。數一遍就知道這一頁的結構長什麼樣，
  // 不用叫使用者開 DevTools 貼一堆東西回來。
  // 基本候選（臉書系）＋ 各平台自己的。共用一份的話，
  // 在 LinkedIn 上就是量了七個必定是 0 的東西，等於白量。
  const PROBES = {
    'role=article': '[role="article"]',
    'role=feed': '[role="feed"]',
    'aria-posinset': '[aria-posinset]',
    'data-pagelet=Feed*': '[data-pagelet^="Feed"]',
    'article 標籤': 'article',
    'data-ad-preview': '[data-ad-preview]',
    'aria-describedby': '[aria-describedby][aria-labelledby]',
    ...(ad.probes || {}),
  };

  // 候選全落空時，唯一有用的東西是「這一頁實際長什麼樣」。
  // 從主要內容區的中央往上爬，那條路徑就是該拿什麼當錨點的答案——
  // 不需要我先猜對選擇器。
  function domSample() {
    const main = document.querySelector('main') || document.body;
    const r = main.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const out = [];
    // 取三個高度，避開剛好落在空白或分隔線的情況
    for (const frac of [0.35, 0.55, 0.75]) {
      const y = Math.round(Math.max(80, Math.min(window.innerHeight - 80,
        window.innerHeight * frac)));
      const el = document.elementFromPoint(x, y);
      if (!el || (panelHas && panelHas(el))) continue;
      out.push(`y=${y}　${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) || '（無文字）'}`);
      out.push(...ancestry(el, 8));
      out.push('');
    }
    return out.length ? out : ['（畫面中央取不到元素）'];
  }

  // 取樣時要跳過自己畫的東西，不然量到的是我們自己的 UI
  const OWN_UI = ['.postsync-toast', '.postsync-btn'];

  function panelHas(el) {
    return !!(el.closest && el.closest(OWN_UI.join(', ')));
  }

  // ── Toast ─────────────────────────────────────────

  let statusEl = null;

  function toast(msg, url, autoHideMs, working) {
    if (statusEl) statusEl.remove();
    const el = document.createElement('div');
    el.className = 'postsync-toast postsync-status';
    statusEl = el;

    const span = document.createElement('span');
    span.className = 'postsync-status-text';
    span.textContent = msg;
    el.appendChild(span);

    // 進行中掛一條不定量進度條：不知道還要多久，但看得出它還活著
    if (working) {
      el.classList.add('postsync-busy');
      const bar = document.createElement('div');
      bar.className = 'postsync-progress';
      bar.appendChild(document.createElement('i'));
      el.appendChild(bar);
    }

    if (url) {
      const a = document.createElement('a');
      a.className = 'postsync-link';
      a.textContent = '開啟 Doc ↗';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      el.appendChild(a);
    }

    let timer = null;
    const close = () => {
      clearTimeout(timer);
      el.remove();
      if (statusEl === el) statusEl = null;
    };

    if (autoHideMs > 0) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'postsync-close';
      x.textContent = '✕';
      x.addEventListener('click', close);
      el.appendChild(x);
      // 點卡片上任何一處也能收掉，不用瞄準右上角那個小叉叉
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('a, button')) return; // 連結與按鈕維持原本行為
        close();
      });
      // 滑鼠停在卡片上就不倒數，離開才重新計時——來得及點「開啟 Doc」
      const arm = () => { timer = setTimeout(close, autoHideMs); };
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', arm);
      arm();
    }
    document.body.appendChild(el);
  }

  // 同一篇滑過兩次都想收是很正常的行為，所以不是擋掉，是問一聲
  function dupToast(data, prev) {
    if (statusEl) statusEl.remove();
    const el = document.createElement('div');
    el.className = 'postsync-toast postsync-status';
    statusEl = el;

    const span = document.createElement('span');
    span.className = 'postsync-status-text';
    span.textContent = `這篇已經收過了（${prev && prev.when ? prev.when : '先前'}）`;
    el.appendChild(span);

    if (prev && prev.docUrl) {
      const a = document.createElement('a');
      a.className = 'postsync-link';
      a.textContent = `開啟已收的那份：${prev.docName || 'Doc'} ↗`;
      a.href = prev.docUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      el.appendChild(a);
    }

    const row = document.createElement('div');
    row.className = 'postsync-actions';

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'postsync-mini postsync-mini-primary';
    again.textContent = '仍要再收一次';
    again.addEventListener('click', () => {
      el.remove();
      statusEl = null;
      send(data, true);
    });

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'postsync-mini';
    skip.textContent = '算了';
    skip.addEventListener('click', () => {
      el.remove();
      statusEl = null;
    });

    row.appendChild(again);
    row.appendChild(skip);
    el.appendChild(row);
    document.body.appendChild(el);
    setTimeout(() => {
      if (statusEl === el) { el.remove(); statusEl = null; }
    }, 20000);
  }
})();
