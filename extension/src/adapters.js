// =====================================================
// Post Sync — 平台轉接器
//
// 一個平台一組錨點。臉書那類 class name 是亂數（x1i10hfl 每次發版都會變），
// 拿來當選擇器等於保證下次改版就壞，所以這裡一律只認結構性錨點：
// role、data-testid、href 樣式、標題階層。
//
// 每個 adapter 的欄位：
//   id / label   識別字與顯示名
//   hosts        比對 location.hostname
//   post         貼文容器（巢狀命中由 content.js 取最外層）
//   text         內文容器（可省略，省略就讀整個 post）
//   author       作者
//   permalink    這則貼文自己的網址（通常掛在時間戳上）
//   time         時間文字
//   more         「查看更多」按鈕的文字樣式
//   exclude      額外要排除的區塊（互動列、留言框…）
// =====================================================

// 介面上的按鈕字，各平台幾乎一樣，一律不算內文。
// 特別注意展開／收合這一組：「查看更多」按下去之後標籤會變成「顯示較少」
// 留在 DOM 裡，所以「展開全文」這個動作反而讓它更容易混進內文。
const ACTION_WORDS = new RegExp(`^(${[
  // 互動列
  '讚', '說讚', '大心', '哈', '嗚', '怒', '留言', '分享', '轉發', '回覆', '檢視',
  '追蹤', '已追蹤', '追蹤中', '加入', '傳送',
  'Like', 'Comment', 'Share', 'Reply', 'Repost', 'Retweet', 'View', 'Follow', 'Send',
  // 展開／收合
  '查看更多', '顯示更多', '見更多', '更多', '顯示較少', '較少', '收合', '隱藏',
  '全部顯示', '查看全部', '查看更多留言', '查看先前的留言',
  'See more', 'See less', 'Show more', 'Show less', 'View more', 'View all',
  // 翻譯
  '翻譯', '查看翻譯', '已翻譯', '顯示原文', '查看原文',
  'Translate', 'See translation', 'See original',
  // 其他殼字
  '所有心情', '最相關', '最新', '已編輯', '贊助', '已贊助', 'Sponsored', 'Edited',
].join('|')})$`, 'i');

// 絕對不能按的按鈕。程式會去按「查看更多」把全文展開，而選單鈕、檢舉、
// 追蹤這些東西的標籤常常也含有「更多」——IG 的「⋯」按鈕裡有一個
// <title>更多選項</title>，SVG 的 title 會被算進 textContent，
// 於是「展開全文」變成幫使用者按下檢舉選單。
// 這種誤按是會造成真實後果的（取消追蹤、檢舉別人），寧可少展開也不能按錯。
const MENU_DENY = /選項|選單|options?|menu|檢舉|report|封鎖|block|取消追蹤|unfollow|追蹤|follow|分享|share|設定|settings|傳送|send|複製|copy|刪除|delete|編輯|edit|收藏|save/i;

self.POST_SYNC = {
  ACTION_WORDS,
  MENU_DENY,

  ADAPTERS: [
    {
      id: 'facebook',
      label: 'Facebook',
      hosts: /(^|\.)facebook\.com$/,
      // 臉書現在的動態牆貼文是 div[aria-labelledby]，**沒有** role="article"
      // （role="article" 只剩部分版面與留言在用），所以兩種都要收。
      // 留言巢在貼文裡，由 outermost() 濾掉。
      post: '[role="article"], div[aria-labelledby]',
      // aria-labelledby 臉書用得很浮濫，光靠它會把整個動態牆當成一則貼文。
      // 一則貼文的判準是「裡面有內文容器，而且沒有包著另一則」。
      //
      // 第二個條件的 `:scope` 不能省。querySelector 的選擇器是拿整份文件去比對、
      // 再篩出 scope 底下的結果，所以少了 :scope 的話，el 自己就會充當那個
      // `div[aria-labelledby]` 祖先，於是每一則貼文都把自己否決掉——
      // 症狀是整個動態牆一則都認不出來，只剩留言被當成貼文。
      postTest: (el) => el.matches('[role="article"]')
        || (!!el.querySelector('[data-ad-preview="message"]')
          && !el.querySelector(':scope div[aria-labelledby] [data-ad-preview="message"]')),
      // 內文容器認得出來的話，抓到的雜訊少非常多
      text: '[data-ad-preview="message"]',
      // aria-labelledby 指向的就是「這一則是誰發的」——這是它的語意本身，
      // 比猜 h2/h3 底下哪個連結是作者可靠得多。
      // 只取第一個 id。臉書會在 aria-labelledby 串上一長列東西——
      // 「已驗證帳號」「追蹤」「分享對象：所有人」甚至整篇內文都在裡面，
      // 全接的話作者欄會變成一整段文章。第一個才是發文者。
      authorFrom: (el) => {
        const ids = el.getAttribute('aria-labelledby');
        if (!ids) return '';
        const first = ids.trim().split(/\s+/)[0];
        const n = first && document.getElementById(first);
        return n ? (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      },
      author: 'h2 a[role="link"], h3 a[role="link"], h4 a[role="link"], h2 strong, h3 strong, span > h2 a, span > h3 a',
      permalink: 'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="/share/p/"], a[href*="/share/v/"], a[href*="/videos/"], a[href*="/photo/"], a[href*="/photos/"], a[href*="/reel/"]',
      time: 'a[href*="/posts/"] span, a[href*="permalink"] span, abbr',
      more: /^(查看更多|顯示更多|見更多|…\s*更多|全文|See more|Voir plus)$/i,
      exclude: '[role="toolbar"], form, [aria-label*="留言"], [aria-label*="Comment"], [data-visualcompletion="ignore"]',
    },
    {
      id: 'threads',
      label: 'Threads',
      hosts: /(^|\.)threads\.(net|com)$/,
      post: '[data-pressable-container="true"], article',
      text: null,
      author: 'a[href^="/@"]',
      permalink: 'a[href*="/post/"]',
      time: 'time',
      more: /^(更多|More|顯示更多|Show more)$/i,
      exclude: '[role="toolbar"], form',
    },
    {
      id: 'x',
      label: 'X',
      hosts: /(^|\.)(x\.com|twitter\.com)$/,
      post: 'article[data-testid="tweet"]',
      text: '[data-testid="tweetText"]',
      author: '[data-testid="User-Name"] a[role="link"], [data-testid="User-Name"]',
      permalink: 'a[href*="/status/"]',
      time: 'time',
      more: /^(Show more|顯示更多)$/i,
      exclude: '[role="group"], [data-testid="card.wrapper"]',
    },
    {
      id: 'instagram',
      label: 'Instagram',
      hosts: /(^|\.)instagram\.com$/,
      post: 'article',
      text: 'h1, ul li span[dir="auto"]',
      author: 'a[href^="/"][role="link"] span, header a',
      permalink: 'a[href*="/p/"], a[href*="/reel/"]',
      time: 'time',
      more: /^(更多|more|較多|展開)$/i,
      // 輪播貼文一次只把當下那張放進 DOM，不按「下一張」就只收得到第一張
      next: /^(下一張|下一個|下一頁|Next|Go forward)$/i,
      exclude: '[role="button"][tabindex], section > div > button',
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      hosts: /(^|\.)linkedin\.com$/,
      // LinkedIn 現在的動態牆是 role="list"[data-testid="mainFeed"]，
      // 一則貼文是 role="listitem"，內文在 span[data-testid^="expandable-text"]。
      // 舊版的 .feed-shared-update-v2 與 data-urn 已經沒有了，但留著——
      // 單篇永久連結頁與舊版面可能還在用。
      post: '[role="listitem"], .feed-shared-update-v2,'
        + ' [data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]',
      // role="listitem" 到處都有（通知、側欄、搜尋結果），
      // 所以要再確認「裡面真的有貼文的內容」才算數。
      postTest: (el) => !el.matches('[role="listitem"]')
        || !!el.querySelector('[data-testid^="expandable-text"], .update-components-text,'
          + ' .update-components-actor, .feed-shared-inline-show-more-text'),
      // 平台改版時要數的候選。這一組跟臉書那組完全不同，
      // 共用一份的話等於在 LinkedIn 上量了七個必定是 0 的東西。
      probes: {
        'role=listitem': '[role="listitem"]',
        'data-testid=mainFeed': '[data-testid="mainFeed"]',
        'expandable-text': '[data-testid^="expandable-text"]',
        'data-urn（舊版）': '[data-urn]',
        '.feed-shared-update-v2（舊版）': '.feed-shared-update-v2',
        '.update-components-actor': '.update-components-actor',
      },
      text: '[data-testid^="expandable-text"], .update-components-text,'
        + ' .feed-shared-inline-show-more-text',
      author: '[data-testid^="actor-name"], .update-components-actor__title,'
        + ' .update-components-actor__name, .update-components-actor a[href*="/in/"]',
      permalink: 'a[href*="/feed/update/"], a[href*="/posts/"]',
      time: '.update-components-actor__sub-description, time',
      more: /^(…\s*more|…more|顯示更多|see more|展開)$/i,
      exclude: '.social-details-social-counts, .feed-shared-social-action-bar, .comments-comment-item',
    },
  ],

  // 找出這個網域用哪一組。認不出來就回 null，content.js 會整個不啟動。
  adapterFor(hostname) {
    return self.POST_SYNC.ADAPTERS.find((a) => a.hosts.test(hostname)) || null;
  },

  // LinkedIn 常常沒有現成的 permalink 連結，用 activity urn 組。
  // urn 可能掛在自己身上、子孫、或外層容器上，三個地方都找一次。
  linkedinPermalink(el) {
    const pick = (n) => n && (n.getAttribute('data-urn') || n.getAttribute('data-id'));
    let urn = pick(el)
      || pick(el.querySelector('[data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]'))
      || pick(el.closest('[data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]'));
    if (!urn || !urn.startsWith('urn:li:activity')) return '';
    return `https://www.linkedin.com/feed/update/${urn}/`;
  },
};
