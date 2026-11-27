// =====================================================
// Post Sync — 把 _locales 的字填進 HTML
//
// 這支檔案跟 popup.js 共用同一條姿態：**沒有一處 innerHTML**。
//
// 那條姿態在做多語言的時候會立刻被挑戰，因為提示文字中間夾著 <b>：
//
//   社群貼文多半是公開內容，預設<b>不</b>標記，這樣才進得了檢索。
//
// 最省事的做法是把那一整段（含標籤）放進 messages.json，然後 innerHTML
// 吐出來。messages.json 是打包進擴充的程式碼、不是使用者輸入，所以那樣
// 其實不會有漏洞。但它會讓「這支檔案沒有 innerHTML」這句話不再是真的，
// 而下一個人讀到的時候就沒有理由相信別處也沒有。一條守得住的規矩值得
// 多寫二十行。
//
// 所以訊息裡允許 **粗體**，用 createElement ＋ textContent 組出來。
// 標記只有這一種，故意的：能表達的東西越少，能出錯的地方越少。
// =====================================================

(function (root) {
  'use strict';

  function t(key, subs) {
    // chrome.i18n 在測試環境不存在，那時回 key 本身，畫面上會很明顯。
    if (!root.chrome || !root.chrome.i18n) return key;
    return root.chrome.i18n.getMessage(key, subs) || key;
  }

  // 「文字 **粗的** 文字」→ [文字節點, <b>, 文字節點]
  // 換行 → <br>，因為原本的提示文字就是用 <br> 斷行的。
  //
  // 奇數段是粗體：split 之後索引 1、3、5… 一定落在 ** 之間。
  // 訊息裡沒有 ** 的話 split 回一個元素，整段就是純文字，也對。
  function nodes(text) {
    const out = [];
    String(text).split('**').forEach(function (chunk, i) {
      if (i % 2) {
        const b = document.createElement('b');
        b.textContent = chunk;
        out.push(b);
        return;
      }
      // 粗體外面的部分才看換行。粗體裡面要斷行的需求還沒出現過，
      // 出現了再說，不要先長一個沒人用的功能。
      chunk.split('\n').forEach(function (line, j) {
        if (j) out.push(document.createElement('br'));
        if (line) out.push(document.createTextNode(line));
      });
    });
    return out;
  }

  function setText(el, text) {
    el.textContent = '';
    nodes(text).forEach(function (n) { el.appendChild(n); });
  }

  // 把 root 底下所有標了 data-i18n 的元素填好。
  //
  //   data-i18n="key"             元素內容（可含 **粗體**）
  //   data-i18n-placeholder="key" placeholder
  //   data-i18n-title="key"       title（滑鼠停留的提示）
  //   data-i18n-label="key"       aria-label
  //
  // 找不到訊息的時候 t() 回 key 本身。那在畫面上看起來很蠢，而這正是要的：
  // 漏翻一條要看得見，不能靜靜地留白。
  function fill(scope) {
    const where = scope || document;
    where.querySelectorAll('[data-i18n]').forEach(function (el) {
      setText(el, t(el.getAttribute('data-i18n')));
    });
    const attrs = [
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-title', 'title'],
      ['data-i18n-label', 'aria-label'],
    ];
    attrs.forEach(function (pair) {
      where.querySelectorAll('[' + pair[0] + ']').forEach(function (el) {
        el.setAttribute(pair[1], t(el.getAttribute(pair[0])));
      });
    });
    // <html lang> 跟著走。螢幕閱讀器靠它選發音，CJK 的字形也靠它挑。
    const tag = t('htmlLang');
    if (tag && tag !== 'htmlLang') document.documentElement.setAttribute('lang', tag);
  }

  root.POST_SYNC_I18N = { t: t, fill: fill, nodes: nodes, setText: setText };
}(self));
