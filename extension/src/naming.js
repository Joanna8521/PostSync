// =====================================================
// Post Sync — 命名
//
// 決定 Drive 上的檔名與知識庫的檔名。錯了不會有任何錯誤訊息，
// 只會在三個月後翻資料夾的時候發現一整排「已贊助_Facebook」。
//
// 純函式，不碰 DOM 也不碰 chrome.*，所以 service worker 用 importScripts
// 載得動，測試頁也載得動。
// =====================================================

(function () {
  'use strict';

  // 跟 extract.js 同一個理由：檔頭寫了「不碰 chrome.*」，那句話要是真的。
  // 檔名裡的「未命名貼文」「未署名」是介面文字，所以它回傳代碼，翻譯函式
  // 由 background.js 注入一次。沒注入就原樣回傳代碼。
  let tr = (key) => key;
  function setTranslator(fn) { tr = (typeof fn === 'function') ? fn : ((key) => key); }

  // 貼文開頭常常是殼字，不是內容：贊助標記、「XXX 分享了一則貼文」、追蹤鈕
  // 這兩份比對的是頁面上的字，不是介面的字，所以三種語言要同時認得，
  // 不是跟著介面切換。詳見 adapters.js 裡 ACTION_WORDS 上面那段。
  const NOISE_LINE = /^(已贊助|贊助|Sponsored|追蹤中|Following|·|＋?追蹤|推薦貼文|Suggested for you|查看更多|顯示更多|See more|広告|スポンサー|フォロー中|おすすめ|もっと見る|さらに表示)$|(分享了|發佈了|新增了|更新了|shared a|posted|シェアしました|投稿しました|更新しました)/;

  // 「3 小時」「8月13日」「2 天」「Aug 13」「3時間」「2日」這類時間戳也不是主題。
  //
  // 這一條**要收尾**。原本只比對開頭，而那在只有中文單位的時候還撐得住，
  // 加上日文就撐不住了：日文的「2日」要認，於是裸的「日」進了單位表，
  // 然後「30日までに申し込んでください」整句被當成時間戳。同理「今」一進去
  // 「今天想談談定價」就陣亡——而那是中文貼文最常見的開頭之一。
  //
  // 臉書的時間戳是**整行**，不是一行的開頭，所以收尾才是對的形狀。
  // 尾巴允許「前／ago／前に」跟分隔符，那些是真的會跟在時間戳後面的東西。
  //
  // 長的單位要排在短的前面（分鐘 在 分 之前），不然 分 先命中就剩一個 鐘。
  const TIME_LINE = /^(\d+\s*(分鐘|小時|時間|週間|か月|ヶ月|天|週|年|分|日|時|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?|[mhdwy])(\s*(前|ago|前に))?|[A-Z][a-z]{2}\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日|昨天|剛剛|Just now|昨日|たった今)[\s·・•]*$/;

  function sanitizeName(s) {
    return String(s || '')
      .replace(/[\/\\:*?"<>|\r\n]/g, ' ') // 檔名不能有的字元
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 36);
  }

  // 主題＝內文裡第一行真的有內容的字。
  // 作者名與時間戳會混在抽出來的文字裡（DOM 上分不乾淨），這裡要排掉，
  // 不然檔名會變成「林曉美_Facebook」，整個資料夾看起來都一樣。
  function topicOf(p) {
    const author = String((p && p.author) || '').trim();
    const timeText = String((p && p.timeText) || '').trim();
    const line = String((p && p.text) || '')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length >= 4
        && s !== author
        && s !== timeText
        && !NOISE_LINE.test(s)
        && !TIME_LINE.test(s));
    return sanitizeName(line || (p && p.text) || '') || tr('noTopic');
  }

  // 檔名尾巴放發文者，不是平台——平台在資料夾裡一看就知道，
  // 而「這篇是誰寫的」才是之後翻資料夾時真正在找的東西。
  function authorName(p) {
    return sanitizeName((p && p.author) || '').slice(0, 20) || tr('noAuthor');
  }

  // 檔名的主體。Drive 的 Doc 名稱與知識庫的 .md 檔名共用同一份，
  // 兩邊各拼一份的話遲早會分岔，而分岔了也不會有人發現。
  function docStem(p, ymd) {
    return `${ymd}_${topicOf(p)}_${authorName(p)}`;
  }

  self.POST_SYNC_NAME = {
    setTranslator,
    sanitizeName, topicOf, authorName, docStem, NOISE_LINE, TIME_LINE,
  };
})();
