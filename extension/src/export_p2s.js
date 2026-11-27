// Post Sync → persona-to-skill 匯入檔
//
// 第三個目的地，而它跟前兩個不一樣的地方就是它存在的理由：
// **不需要伺服器、不需要驗證、每個瀏覽器行為一樣。**
//
// Drive 那條走 chrome.identity.getAuthToken，那是 Chrome 專屬的
// （background.js 自己的註解就寫了）。Focus4ai 那條要一個站台跟一組設定。
// 這條只產一個 JSON 檔讓人下載，所以非 Chrome 的使用者也走得通，而且
// 完全不碰 Google。
//
// 另一端是 persona-to-skill（github.com/Joanna8521/persona-to-skill）的匯入
// 契約。那個專案不自己抓社群平台，理由不是技術而是取得權：X、Instagram、
// LinkedIn 的 robots.txt 本來就擋，而一支會繞過那個的工具，本身就是它被
// 檢舉的理由。所以它定義一個形狀，誰產得出來都能餵它。
//
// Post Sync 剛好就是它文件裡說的那條路：使用者自己按、跑在自己的憑證下、
// 沒有自動收集。責任留在操作的人身上，那是它該在的地方。
//
// 本檔只放純函式，沒有 chrome.* 呼叫，所以 tests/run.js 跑得到。

(function (root) {
  'use strict';

  // 契約版本。對面會讀這個欄位決定怎麼解，所以改形狀要跟著進版。
  const CONTRACT = 'persona-to-skill/import/v1';

  // 看不見但會改變「顯示」的字元。對面會在進門時清一次，這邊先清是因為
  // 匯出檔本身可能被人打開看，而一個會把顯示顛倒的檔案不該從這裡出去。
  // 雙向覆寫（U+202A 到 U+202E、U+2066 到 U+2069）是最該清的那組：它讓
  // 文字的位元組跟螢幕上看到的不一樣。
  // 碼位用組出來的方式寫，不要把字元本身放進原始碼：那樣沒辦法審閱，
  // 而且 tools/run_tests.py 的原始碼掃描會擋（它擋得對）。
  const INVISIBLE_CODEPOINTS = [
    [0x202A, 0x202E], // 雙向覆寫：讓位元組跟螢幕上看到的不一樣，最該清的一組
    [0x2066, 0x2069], // 同上，isolate 系列
    [0x200B, 0x200B], // 零寬空白
    [0x200E, 0x200F], // 左右標記
    [0xFEFF, 0xFEFF], // BOM
    [0x2060, 0x2060]  // word joiner
  ];
  const INVISIBLE = new RegExp(
    '[' + INVISIBLE_CODEPOINTS.map(function (r) {
      const a = '\\u' + r[0].toString(16).padStart(4, '0');
      const b = '\\u' + r[1].toString(16).padStart(4, '0');
      return r[0] === r[1] ? a : a + '-' + b;
    }).join('') + ']', 'g');

  // 跟 extract.js、naming.js 同一個做法：回傳代碼，翻譯函式由呼叫端注入。
  let tr = (key) => key;
  function setTranslator(fn) { tr = (typeof fn === 'function') ? fn : ((key) => key); }

  function scrub(s) {
    return String(s == null ? '' : s).replace(INVISIBLE, '');
  }

  // 把 capturedAt（毫秒）變成對面讀得懂的 ISO 字串。拿不到就留空，
  // 不要用「現在」補，那會把收錄時間寫成匯出時間。
  function isoOrEmpty(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }

  // 一則擷取 → 一筆匯入記錄。
  //
  // authorGuessed 這個欄位是白賺的：它在作者從頁面上抓不到、只能從貼文
  // 第一行推的時候為真。對面有一個「這些字是誰寫的」的軸（authorship），
  // 而猜來的作者就是那個軸上的 unknown。所以這裡原樣帶過去，不要在這邊
  // 就自己決定它是 self_written。
  function toRecord(p) {
    const text = scrub(p && p.text);
    if (!text.trim()) return null;
    return {
      text: text,
      author: scrub(p.author),
      author_guessed: !!p.authorGuessed,
      platform: scrub(p.platform || p.platformLabel),
      url: scrub(p.permalink || p.pageUrl),
      retrieved_at: isoOrEmpty(p.capturedAt),
      published: scrub(p.timeText),
      // 引用轉推裡夾的是別人的話。對面會保留並標記，跟逐字稿保留訪問者
      // 的發言同一個道理：問句決定了答案的意思。
      embedded_other_party: scrub(p.quotedText),
      // 圖片不進匯入檔。對面做的是文字方法論重建，而且它明文拒絕產出
      // 肖像類的東西，所以只留張數讓人知道原文還有圖。
      image_count: Array.isArray(p.images) ? p.images.length : 0,
      kind: 'text'
    };
  }

  // 整份匯出檔。
  //
  // 不寫 tier（T0 到 T3），也不寫 subject。兩個都不是這邊知道的事：
  // 分級取決於出版形式，對象取決於使用者要重建誰，而這裡只是一堆貼文。
  // 猜了會讓對面的閘門收到一個看起來有根據的錯誤值。
  // version 是位置參數、不是 { version } 這種選項物件：欄位名打錯的話
  // 不會壞、不會報錯，只會讓 exported_by 靜靜地少掉版本號，而那是沒有人
  // 會發現的那種錯（寫這支的時候就先犯了一次，呼叫端傳的是 meta.tool）。
  function buildFile(captures, version) {
    const records = [];
    let skipped = 0;
    (captures || []).forEach(function (p) {
      const r = toRecord(p);
      if (r) records.push(r); else skipped += 1;
    });
    return {
      contract: CONTRACT,
      exported_at: new Date().toISOString(),
      exported_by: 'post-sync' + (version ? ' ' + scrub(version) : ''),
      // 這一句寫進匯出檔，所以它跟著介面語言：讀這個檔的是按下匯出的人。
      // 本檔不碰 chrome.*（檔頭那句話要是真的），所以翻譯函式注入進來，
      // 沒注入就用英文——這一句的讀者至少看得懂英文比看得懂代碼好。
      note: tr('p2sNote'),
      records: records,
      skipped_empty: skipped
    };
  }

  function fileName(d) {
    const t = (d instanceof Date ? d : new Date());
    const p = function (n) { return String(n).padStart(2, '0'); };
    return 'post-sync-p2s-' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate())
         + '-' + p(t.getHours()) + p(t.getMinutes()) + '.json';
  }

  root.PostSyncExportP2S = {
    CONTRACT: CONTRACT,
    setTranslator: setTranslator,
    scrub: scrub,
    isoOrEmpty: isoOrEmpty,
    toRecord: toRecord,
    buildFile: buildFile,
    fileName: fileName
  };
}(typeof self !== 'undefined' ? self : this));
