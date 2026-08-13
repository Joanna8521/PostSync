// =====================================================
// Post Sync — 預設值
//
// popup 顯示的預設、background 實際寫入時的 fallback，必須是同一份。
// 兩邊各寫一份的話，畫面上顯示 A、實際寫進 B，而且不會有任何錯誤訊息。
// =====================================================

(function () {
  'use strict';

  self.POST_SYNC_DEFAULTS = {
    // 線上站台。注意 focus4ai.com 是官網、沒有 API，popup 會擋掉那個網址。
    f4Base: 'https://app.focus4ai.com',
    // 收件匣底下的子資料夾：搬移、標籤、刪除的動線跟一般筆記共用，
    // 但跟手動匯入的資料分開放。
    f4Folder: '00_inbox/post-sync',
  };
})();
