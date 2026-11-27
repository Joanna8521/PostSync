const I = self.POST_SYNC_I18N;
const btn = document.getElementById('connect');
const msg = document.getElementById('msg');

I.fill();

btn.addEventListener('click', () => {
  msg.textContent = I.t('connWaiting');
  msg.className = 'msg';
  chrome.runtime.sendMessage({ type: 'POSTSYNC_CONNECT' }, (res) => {
    if (chrome.runtime.lastError) {
      msg.textContent = `❌ ${chrome.runtime.lastError.message}`;
      msg.className = 'msg err';
      return;
    }
    if (res && res.ok) {
      // 這一句含 **粗體**，所以走 setText 而不是 textContent。
      I.setText(msg, I.t('obStep1Done'));
      msg.className = 'msg ok';
      btn.textContent = I.t('btnReconnect');
    } else {
      msg.textContent = `❌ ${(res && res.error) || I.t('connFailedRetry')}`;
      msg.className = 'msg err';
    }
  });
});
