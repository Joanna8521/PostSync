// 用真的瀏覽器渲染 popup 與 onboarding，三種語言各跑一次，確認每個
// data-i18n 都填到字、沒有一處留白、沒有一處顯示成 key 本身。
//
//     node tools/check_i18n_render.js
//
// 這一支**不在** tools/run_tests.py 裡面，因為它要 Playwright，而那不是
// 這個 repo 的依賴。run_tests.py 擋的是靜態的部分：三份 messages.json
// 一致、用到的 key 都在、沒有多的 key、替換位置三語一致。那四條能擋掉
// 絕大多數會出的錯。
//
// 這一支補的是「fill() 真的跑了」這件事——第一次寫的時候 popup.js 還沒
// 呼叫 fill()，靜態檢查全綠，而 popup 整面是空白的。有 Playwright 的話
// 值得偶爾跑一次，尤其是動過 HTML 之後。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Relative to this file, never an absolute path. The first version had
// '/home/user/postsync/extension' hardcoded, which is the machine it was
// written on. It passed locally because that path existed there, and CI
// failed on the first run with ENOENT on a path that is not in the
// repository at all.
const EXT = path.join(__dirname, '..', 'extension');

(async () => {
  const browser = await chromium.launch();
  let bad = 0;
  for (const loc of ['zh_TW', 'en', 'ja']) {
    const msgs = JSON.parse(fs.readFileSync(
      path.join(EXT, '_locales', loc, 'messages.json'), 'utf8'));
    for (const page of ['popup.html', 'onboarding.html']) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      // chrome.i18n 的替身，照 Chrome 的行為做 $1 替換
      await p.addInitScript(({ m }) => {
        window.chrome = {
          i18n: {
            getMessage: (k, subs) => {
              const e = m[k];
              if (!e) return '';
              let s = e.message;
              const a = subs == null ? [] : (Array.isArray(subs) ? subs : [subs]);
              a.forEach((v, i) => { s = s.split('$' + (i + 1)).join(String(v)); });
              return s;
            },
          },
          runtime: { getManifest: () => ({ version: '1.5.0' }), sendMessage: () => {},
                     lastError: null },
          storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}) } },
          tabs: { query: () => {} },
        };
      }, { m: msgs });
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto('file://' + path.join(EXT, page));
      await p.waitForTimeout(150);

      const report = await p.evaluate(() => {
        const out = { empty: [], keyish: [], lang: document.documentElement.lang, n: 0 };
        document.querySelectorAll('[data-i18n]').forEach((el) => {
          out.n++;
          const k = el.getAttribute('data-i18n');
          const txt = (el.textContent || '').trim();
          if (!txt) out.empty.push(k);
          else if (txt === k) out.keyish.push(k);
        });
        document.querySelectorAll('[data-i18n-placeholder],[data-i18n-title]').forEach((el) => {
          out.n++;
          const k = el.getAttribute('data-i18n-placeholder') || el.getAttribute('data-i18n-title');
          const v = el.getAttribute('placeholder') || el.getAttribute('title') || '';
          if (!v) out.empty.push(k + '(attr)');
          else if (v === k) out.keyish.push(k + '(attr)');
        });
        return out;
      });
      const ok = !report.empty.length && !report.keyish.length && !errs.length;
      if (!ok) bad++;
      console.log(`  ${ok ? '✅' : '❌'} ${loc.padEnd(6)} ${page.padEnd(18)}`
        + `填了 ${report.n} 處　lang=${report.lang}`
        + (report.empty.length ? `　留白：${report.empty.join(',')}` : '')
        + (report.keyish.length ? `　顯示成 key：${report.keyish.join(',')}` : '')
        + (errs.length ? `　JS 錯誤：${errs.join(' | ')}` : ''));
      await ctx.close();
    }
  }
  await browser.close();
  console.log(bad ? `\n  ❌ ${bad} 項不對` : '\n  ✅ 六種組合都填滿，沒有一處留白或顯示成 key');
  process.exit(bad ? 1 : 0);
})();
