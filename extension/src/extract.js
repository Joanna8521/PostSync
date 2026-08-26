// =====================================================
// Post Sync — 抽取層
//
// 從 content.js 抽出來的原因只有一個：這是整支擴充最會壞的地方。
// 臉書一改版就可能整組錨點落空，而「抓到半篇」不會有任何錯誤訊息，
// 要三個月後翻到那篇才發現。抽成純函式才測得到（tests/run.html）。
//
// 這一層完全不碰 chrome.*、不碰網路，只吃 DOM、吐資料。
// =====================================================

(function () {
  'use strict';

  const NS = self.POST_SYNC;

  // 從裡面往外找貼文。
  //
  // IG 的貼文容器沒有任何可以當錨點的東西：沒有 role、沒有 data-testid、
  // 沒有 aria-*，class 全是無意義的 .html-div。硬挑一個 div 當錨點，
  // 下次改版就死，而且死的時候看起來像別的問題。
  //
  // 但「這則貼文的永久連結」一定存在（否則使用者也點不進去），
  // 所以改成：以它為種子往上爬，停在第一個「同時包含圖片與時間」的祖先。
  // 這是照語意找，不是照長相找。
  function fromAnchor(ad, root) {
    const cfg = ad.postAnchor;
    const found = [];
    for (const seed of (root || document).querySelectorAll(cfg.seed)) {
      let cur = seed.parentElement;
      for (let up = 0; cur && up < (cfg.maxUp || 12); up++) {
        const ok = (cfg.needs || []).every((sel) => cur.querySelector(sel))
          && cur.getBoundingClientRect().height >= (cfg.minHeight || 0);
        if (ok) break;
        cur = cur.parentElement;
      }
      if (cur && cur !== document.body && !found.includes(cur)) found.push(cur);
    }
    return found;
  }

  // 留言在臉書也是 role="article"，巢狀命中要濾掉，只留最外層那一層。
  // postTest 是第二道關卡：選擇器不得不放寬（臉書的貼文沒有專屬標記）時，
  // 用它把「長得像但不是貼文」的候選擋掉，否則整個動態牆會被當成一則。
  function keep(ad, list) {
    let all = list;
    if (ad.postTest) {
      all = all.filter((el) => {
        try {
          return ad.postTest(el);
        } catch (_) {
          return false; // 判定式自己炸了不能讓整頁都認不出貼文
        }
      });
    }
    return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  }

  // 兩條路都跑，然後合併。
  //
  // 種子法不能只在「一則都找不到」時才跑：臉書的動態牆上，貼文容器可能
  // 一個語意屬性都沒有（內文容器往上到 role="main" 之間全是無意義的
  // .html-div），而屬性選擇器仍然會在頁面**別處**命中幾個不是貼文的東西。
  // 那時數量不是 0，種子法就永遠不啟動，使用者看到的是
  // 「偵測到 4 則、卻一則都鎖定不了」。
  //
  // 也不能「取數量多的那一條」——頁面上帶文字的貼文可能只有三則，
  // 而假命中有四個，種子法照樣輸。數量根本不是判準。
  //
  // 合併時唯一要處理的是重疊：屬性那條命中的東西如果**包著**種子法找到的
  // 貼文，那它是外層容器而不是一則，丟掉。剩下的交給呼叫端按「在不在畫面上」
  // 去挑——假命中通常根本不在視窗裡，自然就落選了。
  function mergePosts(bySeed, byAttr) {
    const out = [...bySeed];
    for (const el of byAttr) {
      if (out.includes(el)) continue;
      if (bySeed.some((s) => el.contains(s))) continue;
      out.push(el);
    }
    return out;
  }

  function outermost(ad, root) {
    const byAttr = keep(ad, [...(root || document).querySelectorAll(ad.post)]);
    if (!ad.postAnchor) return byAttr;
    const bySeed = keep(ad, fromAnchor(ad, root));
    outermost.lastCounts = { seed: bySeed.length, attr: byAttr.length };
    return mergePosts(bySeed, byAttr);
  }

  // 從某個元素往上找「它屬於哪一則貼文」。要的是**最外層**那一個：
  // 右鍵點在留言上時，closest() 會回那則留言（臉書的留言也是 role="article"），
  // 而使用者想收的一定是整篇。
  function outermostOf(ad, el) {
    let found = null;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.matches && cur.matches(ad.post)) found = cur;
      cur = cur.parentElement;
    }
    return found;
  }

  // 這個節點是屬於 root 這一則，還是屬於巢在裡面的留言？
  function ownedBy(ad, node, root) {
    const p = node.parentElement;
    if (!p) return false;
    const owner = p.closest(ad.post);
    return !owner || owner === root;
  }

  const BASE_EXCLUDE = '[contenteditable="true"], textarea, input, script, style, svg,'
    + ' .postsync-btn, .postsync-toast, [role="menu"], [role="menuitem"],'
    + ' [role="tablist"], [role="progressbar"], [aria-hidden="true"]';

  // 臉書拿不可見字元交錯在時間戳裡做反爬（U+034F 組合用字元是主力）。
  // 不清掉的話 Doc 裡會出現「o\u034FS\u034Fr\u034Fp\u034Fn\u034F…」這種東西。
  const INVISIBLE = /[\u00AD\u034F\u200B-\u200F\u2060-\u2064\u206A-\u206F\uFEFF]/g;

  function clean(s) {
    return String(s).replace(INVISIBLE, '').replace(/\u00A0/g, ' ').trim();
  }

  // 看不見的東西就不該被收。臉書把混淆用的字元藏在 display:none / font-size:0
  // 的元素裡，只讓某幾個字露出來、再用 CSS 排出正確順序——照單全收就是一堆亂碼。
  // getComputedStyle 不便宜，所以一次抽取共用一份快取。
  function hiddenChecker() {
    const cache = new Map();
    return function hidden(el) {
      if (!el || el === document.body) return false;
      if (cache.has(el)) return cache.get(el);
      let v = false;
      try {
        const cs = getComputedStyle(el);
        v = cs.display === 'none'
          || cs.visibility === 'hidden'
          || cs.opacity === '0'
          || parseFloat(cs.fontSize) === 0;
      } catch (_) { v = false; }
      // 父層藏了，子層再怎麼設定也看不見
      if (!v) v = hidden(el.parentElement);
      cache.set(el, v);
      return v;
    };
  }

  function readable(ad, root, owner) {
    const EXCLUDE = ad.exclude ? `${BASE_EXCLUDE}, ${ad.exclude}` : BASE_EXCLUDE;
    const isHidden = hiddenChecker();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest(EXCLUDE)) return NodeFilter.FILTER_REJECT;
        if (!ownedBy(ad, node, owner)) return NodeFilter.FILTER_REJECT; // 留言
        if (isHidden(p)) return NodeFilter.FILTER_REJECT;               // 反爬用的隱藏字
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = clean(n.nodeValue);
      if (!t) continue;
      if (NS.ACTION_WORDS.test(t)) continue; // 讚／留言／分享 那一列
      out.push(t);
    }
    return out;
  }

  function postText(ad, root) {
    // 平台有指定內文容器就優先用它，抓到的雜訊少很多
    let lines = [];
    if (ad.text) {
      const holders = [...root.querySelectorAll(ad.text)]
        .filter((h) => ownedBy(ad, h, root));
      for (const h of holders) lines.push(...readable(ad, h, root));
    }
    // 沒指定、或指定的容器落空（平台改版）→ 退回整則掃描，不要空手而回。
    // 判準要用「字數」不是「行數」：分享的貼文只有一行內文是正常的，
    // 用行數判會把它打回整則掃描，於是留言數、按讚數、「查看1則回覆」全跑進來。
    if (lines.join('').trim().length < 8) lines = readable(ad, root, root);

    let text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // 連 TreeWalker 都掃不出東西時的最後一道：直接拿 innerText
    if (text.length < 15) {
      text = (root.innerText || '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !NS.ACTION_WORDS.test(s))
        .join('\n')
        .trim();
    }
    return text;
  }

  function firstText(ad, root, sel) {
    if (!sel) return '';
    for (const el of root.querySelectorAll(sel)) {
      if (!ownedBy(ad, el, root)) continue;
      // 走 readable 而不是 textContent：要跳過藏起來的反爬字元
      const t = clean(readable(ad, el, root).join(' ').replace(/\s+/g, ' '));
      if (t) return t.slice(0, 80);
    }
    return '';
  }

  // 時間戳看起來像時間才收。臉書對時間做了反爬混淆，硬收就會拿到
  // 「oSrpnseodt0844 37u07cc9fh7mfm18cm03」這種東西塞進檔名與 Doc 標頭。
  // 收不到時間不痛不癢，收到一串亂碼才是真的髒。
  const TIME_LIKE = /(\d+\s*(分鐘|分|小時|時|天|週|周|月|年|min|mins|h|hr|hrs|d|w|y))|(\d{1,2}\s*月\s*\d{1,2}\s*日)|(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(昨天|前天|剛剛|Just now|Yesterday)|([A-Z][a-z]{2}\s+\d{1,2})/;

  function timeText(ad, root) {
    const raw = firstText(ad, root, ad.time);
    if (!raw || raw.length > 24) return '';
    return TIME_LIKE.test(raw) ? raw : '';
  }

  // 作者名旁邊常常黏著身分與動作按鈕的字：
  //   「王小明 已驗證帳號 · 追蹤・分享對象：所有人」
  // 這些不是名字的一部分，留著就會一路變成 Doc 的標頭與檔名。
  const NAME_NOISE = /(已驗證帳號|已驗證|Verified|追蹤中|追蹤|Following|Follow|粉絲專頁|Page|贊助|Sponsored|分享對象[：:][^・·•]*|Shared with[^・·•]*)/g;

  function cleanAuthor(s) {
    const parts = clean(s).split(/[・·•|｜]/);
    for (const raw of parts) {
      const v = raw.replace(NAME_NOISE, '').replace(/\s+/g, ' ').trim();
      if (!v) continue;
      if (TIME_LIKE.test(v)) continue;      // 時間不是名字
      if (v.length > 40) continue;          // 混淆字串、整段內文都很長
      return v.slice(0, 60);
    }
    return '';
  }

  // 追蹤參數要丟掉，不然同一篇每次收進來的網址都不一樣，去重會整個失效
  const JUNK_PARAMS = ['__tn__', 'ref', 'refid', 'comment_id', 'fbclid', 'rdid', 's', 't', 'igsh', 'img_index'];

  function permalink(ad, root, origin) {
    if (!ad.permalink) return ad.id === 'linkedin' ? NS.linkedinPermalink(root) : '';
    for (const a of root.querySelectorAll(ad.permalink)) {
      if (!ownedBy(ad, a, root)) continue;
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#')) continue;
      try {
        const u = new URL(href, origin || location.origin);
        JUNK_PARAMS.forEach((k) => u.searchParams.delete(k));
        [...u.searchParams.keys()]
          .filter((k) => k.startsWith('__cft__'))
          .forEach((k) => u.searchParams.delete(k));
        return u.toString();
      } catch (_) { /* 組不起來就換下一個 */ }
    }
    // 選擇器落空時的最後一招：LinkedIn 把貼文 id 放在 urn 屬性上
    if (ad.id === 'linkedin') return NS.linkedinPermalink(root);
    return '';
  }

  // 頭像的 alt 各平台都會寫（無障礙文字），比尺寸可靠：
  // IG 的大頭貼 natural 尺寸是 150x150，光看尺寸擋不掉。
  const AVATAR_ALT = /profile picture|大頭貼|大头像|个人资料照片|プロフィール写真|avatar/i;

  // 一張圖收不收，理由是什麼。診斷與實際過濾走**同一個函式**——
  // 各寫一份的話，診斷會告訴你「這張有收」而實際上沒有，
  // 那種不一致比沒有診斷更糟。
  function imageVerdict(ad, img, root) {
    if (!ownedBy(ad, img, root)) return '留言區的圖';
    if (AVATAR_ALT.test(img.getAttribute('alt') || '')) return '頭像（alt）';
    if (img.closest('header')) return '頭像（在 header 裡）';

    const r = img.getBoundingClientRect();
    const laidOut = r.width > 0 && r.height > 0;
    // 輪播裡還沒捲到的那幾張，版面寬高是 0，但 natural 尺寸是真的。
    // 只看 rect 的話會把它們整批丟掉。反過來說，有版面而且很小的
    // （40px 頭像、18px reaction icon）就是真的小，不能拿 natural 放行。
    const w = laidOut ? r.width : (img.naturalWidth || 0);
    const h = laidOut ? r.height : (img.naturalHeight || 0);
    if (w < 120 || h < 120) return `太小（${Math.round(w)}×${Math.round(h)}）`;

    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!/^https?:\/\//.test(src)) return '不是 http(s) 網址';
    return '';  // 空字串＝要收
  }

  function images(ad, root, cap = 20) {
    const out = [];
    for (const img of root.querySelectorAll('img')) {
      if (imageVerdict(ad, img, root)) continue;
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!out.includes(src)) out.push(src);
      if (out.length >= cap) break;
    }
    return out;
  }

  // 「多圖貼文只收到 N 張」有兩種完全不同的原因，而使用者看到的症狀一樣：
  //   一、DOM 裡本來就只有 N 個 <img>（臉書的相簿型貼文最多只鋪 5 張縮圖，
  //       其餘藏在「+7」後面，根本沒有節點）
  //   二、有節點但被我們濾掉了（太小、被當成頭像）
  // 不分開報的話，會往錯的方向修——加捲動觸發載入對第一種完全沒用。
  function imageReport(ad, root) {
    const imgs = [...root.querySelectorAll('img')];
    const rows = imgs.slice(0, 16).map((img) => {
      const r = img.getBoundingClientRect();
      const why = imageVerdict(ad, img, root) || '✅ 收';
      const alt = (img.getAttribute('alt') || '').replace(/\s+/g, ' ').slice(0, 14);
      return `  ${Math.round(r.width)}×${Math.round(r.height)}`
        + ` nat ${img.naturalWidth}×${img.naturalHeight}`
        + (img.complete ? '' : ' [載入中]')
        + (alt ? ` alt="${alt}"` : '')
        + ` → ${why}`;
    });
    // 相簿型貼文的線索：每張縮圖是一個 /photo 連結，而「+7」那種疊圖
    // 代表後面還有幾張根本不在 DOM 裡
    const photoLinks = root.querySelectorAll('a[href*="/photo"]').length;
    const moreOverlay = [...root.querySelectorAll('span, div')]
      .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
      .find((t) => /^\+\s?\d+$/.test(t)) || '';
    return {
      total: imgs.length,
      taken: images(ad, root).length,
      photoLinks,
      moreOverlay,
      rows,
    };
  }

  function extract(ad, root) {
    const text = postText(ad, root);

    // 作者有三層：平台的語意標記（最準）→ 選擇器 → 猜。每一層都要洗過，
    // 不然「王小明 已驗證帳號・<一串混淆字元>」會原樣變成檔名。
    let author = '';
    if (ad.authorFrom) {
      try { author = cleanAuthor(ad.authorFrom(root) || ''); } catch (_) { author = ''; }
    }
    const bySelector = author ? '' : cleanAuthor(firstText(ad, root, ad.author));
    if (!author) author = bySelector;
    const guessed = !author;

    // 都落空時，「整則」的第一行幾乎一定是作者名（各平台都是這個版面）。
    // 注意這裡要掃整則、不能用上面的 text——text 可能已經被限縮在內文容器裡，
    // 那樣拿到的會是內文第一句，把貼文的第一句話當成作者，比抓不到還糟。
    if (!author) {
      const first = cleanAuthor(readable(ad, root, root)[0] || '');
      if (first && first.length <= 40) author = first;
    }

    // permalink 抓不到時**不要**退回 location.href。在動態牆上那就是
    // 「https://www.facebook.com/」——寫進 Doc 是個沒有用的連結，
    // 而且會讓去重把不同貼文都算成同一篇。寧可留空，交給上層講清楚。
    const link = permalink(ad, root);

    return {
      platform: ad.id,
      platformLabel: ad.label,
      text,
      author,
      timeText: timeText(ad, root),
      permalink: link,
      images: images(ad, root),
      authorGuessed: guessed,
      pageUrl: location.href,
      capturedAt: Date.now(),
    };
  }

  self.POST_SYNC_EXTRACT = {
    outermost, outermostOf, ownedBy, readable, clean, cleanAuthor,
    postText, firstText, timeText, permalink, images, imageReport, extract,
  };
})();
