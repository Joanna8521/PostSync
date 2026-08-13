// Post Sync — 抽取層測試
//
// 釘住的是「壞了不會有任何畫面告訴你」的那幾件事：
//   ・留言被當成內文收進去（臉書的留言也是 role="article"）
//   ・頭像被當成內容圖片
//   ・permalink 帶著追蹤參數 → 同一篇每次指紋都不同 → 去重整個失效
//   ・平台改版讓內文容器落空 → 安靜地收到空的
//
// 用法：直接用瀏覽器打開 tests/run.html。

const out = document.getElementById('out');
let pass = 0;
let fail = 0;

function group(name) {
  const d = document.createElement('div');
  d.className = 'head';
  d.textContent = name;
  out.appendChild(d);
}

function check(desc, ok, got) {
  const d = document.createElement('div');
  d.className = ok ? 'pass' : 'fail';
  d.textContent = `${ok ? '✅' : '❌'} ${desc}`;
  out.appendChild(d);
  if (!ok) {
    const p = document.createElement('pre');
    p.textContent = `實際拿到：\n${typeof got === 'string' ? got : JSON.stringify(got, null, 2)}`;
    out.appendChild(p);
    fail++;
  } else {
    pass++;
  }
}

const EX = self.POST_SYNC_EXTRACT;
const byId = (id) => self.POST_SYNC.ADAPTERS.find((a) => a.id === id);

// ── Facebook ────────────────────────────────────────
{
  group('Facebook：一則貼文，裡面巢了兩則留言');
  const ad = byId('facebook');
  const scope = document.getElementById('fb');
  const posts = EX.outermost(ad, scope);

  check('只認出 1 則貼文（兩則留言不算）', posts.length === 1, `${posts.length} 則`);

  const post = posts[0];
  const text = EX.postText(ad, post);

  check('收到內文', text.includes('定價這件事') && text.includes('客戶買的從來不是成本'), text);
  check('沒有把留言收進來', !text.includes('推爆這篇') && !text.includes('完全同意'), text);
  check('沒有把「讚／留言／分享」收進來',
    !/(^|\n)(讚|留言|分享)(\n|$)/.test(text), text);

  const author = EX.firstText(ad, post, ad.author);
  check('作者是貼文者，不是留言者', author === '林小美', author);

  const perma = EX.permalink(ad, post, 'https://www.facebook.com');
  check('permalink 指向這則貼文', perma.includes('/permalink/998877'), perma);
  check('permalink 洗掉 __cft__（不洗的話同一篇每次指紋都不一樣）',
    !perma.includes('__cft__'), perma);
  check('permalink 洗掉 fbclid', !perma.includes('fbclid'), perma);
  check('permalink 保留有意義的參數', perma.includes('story=1'), perma);

  const imgs = EX.images(ad, post);
  check('只收內容圖，不收 40px 頭像',
    imgs.length === 1 && imgs[0].includes('photo_big'), imgs);
  check('不收留言者的圖（就算它夠大）',
    !imgs.some((u) => u.includes('commenter')), imgs);
}

// ── 臉書現在的動態牆結構 ────────────────────────────
{
  group('臉書動態牆：貼文是 div[aria-labelledby]，留言才是 role="article"');
  const ad = byId('facebook');
  const feed = document.getElementById('fbfeed');
  const posts = EX.outermost(ad, feed);

  check('認出 2 則貼文', posts.length === 2, `${posts.length} 則`);
  check('整個動態牆沒有被當成一則超大貼文',
    !posts.some((p) => p.getAttribute('aria-labelledby') === 'feedlbl'),
    posts.map((p) => p.getAttribute('aria-labelledby')));
  check('留言沒有被當成一則貼文',
    !posts.some((p) => p.matches('[role="article"]')),
    posts.map((p) => p.tagName + (p.getAttribute('role') || '')));

  const first = posts[0];
  const d = EX.extract(ad, first);

  // 真實踩到過：鎖到留言區塊，於是作者變成留言者、內文混進留言
  check('作者是貼文者（aria-labelledby 指到的那個），不是留言者',
    d.author === '王小明', d.author);
  check('作者不是用猜的', d.authorGuessed === false, d.authorGuessed);
  check('內文是貼文本體', d.text.includes('開會前先把想問的問題寫下來'), d.text);
  check('內文沒有混進留言', !d.text.includes('這個我也試過，真的有用'), d.text);
  check('內文沒有把作者名收進去', !d.text.includes('王小明'), d.text);
  check('內文沒有把時間戳收進去', !d.text.includes('18小時'), d.text);
  // 「查看更多」按下去之後標籤會變成「顯示較少」，還留在內文容器裡
  check('內文沒有「顯示較少」這種按鈕字', !d.text.includes('顯示較少'), d.text);
  check('內文沒有「查看翻譯」這種按鈕字', !d.text.includes('查看翻譯'), d.text);
  check('permalink 是這則貼文的',
    d.permalink.includes('pfbid024AAA'), d.permalink);

  const { topicOf } = self.POST_SYNC_NAME;
  check('檔名主題是內文，不是作者名',
    topicOf(d).includes('開會前先把'), topicOf(d));
}

// ── 右鍵定位 ────────────────────────────────────────
{
  group('右鍵：點在哪裡都要收到「整篇」，不是留言');
  const ad = byId('facebook');
  const scope = document.getElementById('fb');
  const post = EX.outermost(ad, scope)[0];

  // 右鍵點在內文上
  const bodySpan = post.querySelector('div[dir="auto"] span');
  check('點內文 → 拿到整篇', EX.outermostOf(ad, bodySpan) === post, '拿到別的東西');

  // 右鍵點在留言的文字上：closest() 會回那則留言，必須往上找到最外層
  const commentSpan = [...post.querySelectorAll('[role="article"] span')]
    .find((s) => s.textContent.includes('推爆這篇'));
  check('點留言 → 還是拿到整篇（不是那則留言）',
    EX.outermostOf(ad, commentSpan) === post,
    EX.outermostOf(ad, commentSpan) === commentSpan.closest('[role="article"]')
      ? '拿到留言本身' : '拿到別的東西');

  // 右鍵點在貼文外面（例如頁面背景）
  check('點在貼文外面 → 回 null，由程式提示使用者',
    EX.outermostOf(ad, document.body) === null, EX.outermostOf(ad, document.body));
}

// ── X ───────────────────────────────────────────────
{
  group('X：一則推文');
  const ad = byId('x');
  const post = EX.outermost(ad, document.getElementById('x'))[0];

  const text = EX.postText(ad, post);
  check('收到推文內容', text.includes('寫程式最難的不是寫'), text);
  check('沒有把 Reply／Repost／Like 收進來',
    !/(^|\n)(Reply|Repost|Like)(\n|$)/.test(text), text);

  const perma = EX.permalink(ad, post, 'https://x.com');
  check('permalink 指向 /status/', perma.includes('/status/1234567890'), perma);
  check('permalink 洗掉 s／t 追蹤參數',
    !perma.includes('s=20') && !perma.includes('t=abc'), perma);
}

// ── 平台改版 ────────────────────────────────────────
{
  group('平台改版：內文容器的 selector 整組落空');
  const ad = byId('x');
  const post = EX.outermost(ad, document.getElementById('xbroken'))[0];
  const text = EX.postText(ad, post);

  // 這一條是整支擴充最重要的防線：selector 死掉時要退回整則掃描，
  // 而不是安靜地收一份空的進 Drive。
  check('退回整則掃描，不會空手而回',
    text.includes('改版之後內文容器換了名字'), text);
}

// ── 檔名 ────────────────────────────────────────────
{
  group('檔名主題：Drive 上那一整排檔名靠它');
  const { topicOf } = self.POST_SYNC_NAME;

  const fb = EX.extract(byId('facebook'), EX.outermost(byId('facebook'), document.getElementById('fb'))[0]);
  check('用內文當主題，不是作者也不是「已贊助」',
    topicOf(fb).includes('定價這件事'), topicOf(fb));

  check('作者名不會變成主題',
    topicOf({ text: '王小明陳\n這是真正的內文段落', author: '王小明陳' }) === '這是真正的內文段落',
    topicOf({ text: '王小明陳\n這是真正的內文段落', author: '王小明陳' }));

  check('時間戳不會變成主題',
    topicOf({ text: '3 小時前\n真正想收的是這一句' }) === '真正想收的是這一句',
    topicOf({ text: '3 小時前\n真正想收的是這一句' }));

  check('「XXX 分享了一則貼文」不會變成主題',
    topicOf({ text: '林小美分享了一則貼文\n真正的內容在這裡' }) === '真正的內容在這裡',
    topicOf({ text: '林小美分享了一則貼文\n真正的內容在這裡' }));

  check('檔名不含斜線（會被當成 Drive 路徑）',
    !topicOf({ text: 'A/B 測試怎麼做才對' }).includes('/'),
    topicOf({ text: 'A/B 測試怎麼做才對' }));

  check('完全沒有可用文字時給得出名字，不是空字串',
    topicOf({ text: '' }) === '未命名貼文', topicOf({ text: '' }));

  check('長內文截短到 36 字以內',
    topicOf({ text: '這'.repeat(200) }).length <= 36,
    topicOf({ text: '這'.repeat(200) }).length);

  // 真的踩過的那一種：作者名沒包在 h2/h3 的連結裡 → 作者抓成空 →
  // 內文第一行（其實是作者名）遞補成主題 → 檔名變「20260813_陳小美_Facebook」
  group('作者選擇器落空時，作者名不可以變成檔名');
  const fbAd = byId('facebook');
  const noAuthorPost = EX.outermost(fbAd, document.getElementById('fbnoauthor'))[0];
  const d = EX.extract(fbAd, noAuthorPost);

  check('偵測得出「作者是猜的」', d.authorGuessed === true, d.authorGuessed);
  check('作者退回貼文開頭那一行', d.author === '陳小美', d.author);
  check('主題是內文，不是作者名',
    topicOf(d).includes('工具升級'), `topic=${topicOf(d)}`);
  check('主題不會變成作者名',
    !topicOf(d).includes('陳小美'), topicOf(d));
}

// ── 作者名清洗 ──────────────────────────────────────
{
  group('作者名：把身分標籤與動作按鈕的字洗掉');
  const { cleanAuthor } = EX;

  // 名字是編的，但這幾種「作者名黏著什麼」的格式都是真的從臉書上遇過的
  check('洗掉「已驗證帳號」',
    cleanAuthor('王大文 已驗證帳號') === '王大文', cleanAuthor('王大文 已驗證帳號'));
  check('洗掉「已驗證帳號 · 追蹤・分享對象：所有人」',
    cleanAuthor('林志豪 已驗證帳號 · 追蹤・分享對象：所有人') === '林志豪',
    cleanAuthor('林志豪 已驗證帳號 · 追蹤・分享對象：所有人'));
  check('作者欄不會變成一整段內文',
    cleanAuthor('林志豪・這是一段夠長的內文，長到不可能是名字，用來確認作者欄不會把整段文章吃進去。') === '林志豪',
    cleanAuthor('林志豪・這是一段夠長的內文，長到不可能是名字，用來確認作者欄不會把整段文章吃進去。'));
  check('時間戳不會被當成作者',
    cleanAuthor('・5小時') === '', cleanAuthor('・5小時'));
  check('臉書的反爬混淆字元洗得掉',
    cleanAuthor('王大文͏ 已驗證帳號') === '王大文',
    JSON.stringify(cleanAuthor('王大文͏ 已驗證帳號')));
}

// ── 檔名 ────────────────────────────────────────────
{
  group('檔名：日期_主題_發文者');
  const { docStem, authorName } = self.POST_SYNC_NAME;

  const p = { text: '這是貼文的內容第一行\n第二行', author: '林志豪' };
  check('尾巴是發文者，不是平台',
    docStem(p, '20260813') === '20260813_這是貼文的內容第一行_林志豪',
    docStem(p, '20260813'));
  check('沒有作者時給得出名字，不是空的或兩條底線',
    authorName({}) === '未署名' && !docStem({ text: 'abcd' }, '20260813').includes('__'),
    docStem({ text: 'abcd' }, '20260813'));
  check('作者名裡的斜線不會變成 Drive 路徑',
    !docStem({ text: '內容內容', author: 'a/b' }, '20260813').includes('/'),
    docStem({ text: '內容內容', author: 'a/b' }, '20260813'));
}

// ── LinkedIn ────────────────────────────────────────
{
  group('LinkedIn：貼文是 role="listitem"，但側欄也是');
  const ad = byId('linkedin');
  const scope = document.getElementById('li');
  const posts = EX.outermost(ad, scope);

  check('只認出 1 則貼文（側欄的 listitem 不算）', posts.length === 1, `${posts.length} 則`);

  const d = EX.extract(ad, posts[0]);
  check('內文抓得到', d.text.includes('招募這件事'), d.text);
  check('沒有把「讚／留言」收進來',
    !/(^|\n)(讚|留言)(\n|$)/.test(d.text), d.text);
  check('作者是王大明', d.author === '王大明', d.author);
  check('permalink 由 data-id 的 urn 組出來',
    d.permalink === 'https://www.linkedin.com/feed/update/urn:li:activity:7654321/',
    d.permalink);
  check('時間抓得到', d.timeText === '3 天', d.timeText);
}

// ── Instagram ───────────────────────────────────────
{
  group('IG：貼文容器沒有任何語意屬性，只能從永久連結往上爬');
  const ad = byId('instagram');
  const scope = document.getElementById('ig');

  check('主錨點 article 在這種頁面上是落空的',
    scope.querySelectorAll('article').length === 0, '竟然有 article');

  const posts = EX.outermost(ad, scope);
  check('種子法還是認得出 1 則', posts.length === 1, `${posts.length} 則`);

  const d = EX.extract(ad, posts[0]);
  // 原本這裡只檢查「有沒有 time 和 img」——外框也有，所以一直是假通過。
  // 要釘的是「抓到的確實在 #ig 裡面」，而且沒有把別則的東西一起吞進來。
  check('抓到的是 IG 那一則，沒有爬到外框去',
    scope.contains(posts[0]) && posts[0] !== scope
      && !posts[0].querySelector('[role="article"]'),
    posts[0] === scope ? '抓到整個 #ig' : '爬出 #ig 了');
  check('容器裡同時有圖與時間', 
    !!(posts[0].querySelector('time') && posts[0].querySelector('img')), '缺 time 或 img');
  check('內文抓得到', d.text.includes('光線剛好'), d.text);
  check('permalink 是 /p/ 那條', d.permalink.includes('/p/DABC123'), d.permalink);
  check('大頭貼不算內容圖', !d.images.some((u) => u.includes('av.jpg')), d.images);
  check('貼文照片有收到', d.images.some((u) => u.includes('p1.jpg')), d.images);
}

// ── 圖片 ────────────────────────────────────────────
{
  group('圖片：頭像不收，輪播裡還沒翻到的要收');
  const ad = byId('instagram');

  // 這一組要控制 naturalWidth，用程式組比寫在 HTML 裡好控制
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:600px';
  host.innerHTML = `
    <article>
      <header><img alt="示範帳號 的大頭貼照" src="https://x/av1.jpg" style="width:150px;height:150px"></header>
      <img alt="示範帳號 的大頭貼照" src="https://x/av2.jpg" style="width:150px;height:150px">
      <img alt="貼文第一張" src="https://x/p1.jpg" style="width:400px;height:400px">
      <img alt="輪播第二張" src="https://x/p2.jpg" style="display:none">
      <img alt="愛心圖示" src="https://x/icon.jpg" style="width:24px;height:24px">
    </article>`;
  document.body.appendChild(host);

  // 還沒翻到的那張：版面寬高是 0，但 natural 尺寸是真的
  const hidden = host.querySelector('img[alt="輪播第二張"]');
  Object.defineProperty(hidden, 'naturalWidth', { value: 1080 });
  Object.defineProperty(hidden, 'naturalHeight', { value: 1080 });

  const post = EX.outermost(ad, host)[0];
  const imgs = EX.images(ad, post);

  check('header 裡的大頭貼不收', !imgs.some((u) => u.includes('av1')), imgs);
  check('header 外面的大頭貼也不收（靠 alt 認）',
    !imgs.some((u) => u.includes('av2')), imgs);
  check('收得到正常的貼文圖', imgs.some((u) => u.includes('p1')), imgs);
  check('收得到輪播裡還沒翻到的那張（版面 0×0 但 natural 是 1080）',
    imgs.some((u) => u.includes('p2')), imgs);
  check('24px 的小圖示不收', !imgs.some((u) => u.includes('icon')), imgs);

  host.remove();
}

// ── 結果 ────────────────────────────────────────────
const sum = document.getElementById('summary');
sum.textContent = fail === 0
  ? `✅ 全部通過（${pass} 項）`
  : `❌ ${fail} 項失敗 / ${pass} 項通過`;
sum.className = fail === 0 ? 'pass' : 'fail';
