const btn = document.getElementById('connect');
const msg = document.getElementById('msg');

btn.addEventListener('click', () => {
  msg.textContent = '等待 Google 授權視窗…';
  msg.className = 'msg';
  chrome.runtime.sendMessage({ type: 'POSTSYNC_CONNECT' }, (res) => {
    if (chrome.runtime.lastError) {
      msg.textContent = `❌ ${chrome.runtime.lastError.message}`;
      msg.className = 'msg err';
      return;
    }
    if (res && res.ok) {
      msg.textContent = '✅ 已連接。收進來的東西只會寫進你自己的 Google Drive。';
      msg.className = 'msg ok';
      btn.textContent = '重新連接';
    } else {
      msg.textContent = `❌ ${(res && res.error) || '連接失敗，請再試一次'}`;
      msg.className = 'msg err';
    }
  });
});
