#!/usr/bin/env python3
"""用 headless Chrome 跑抽取層測試，回傳正確的 exit code。

    python3 tools/run_tests.py

`tests/run.html` 用瀏覽器直接打開也可以看，但那要靠人去看綠不綠。
這一支讓「全綠才算過」變成一個可以自動化的判斷，而且不會因為某個
預覽環境把檔案轉成 data: URL 就靜靜地什麼都沒跑（真的發生過，
畫面停在「執行中…」，看起來像測試很慢）。
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "tests" / "run.html"

CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "chromium", "chromium-browser",
]

def chrome() -> str:
    for c in CANDIDATES:
        if Path(c).exists() or shutil.which(c):
            return c
    raise SystemExit(
        "❌ 找不到 Chrome。要嘛裝一個，要嘛直接用瀏覽器打開 tests/run.html 自己看。"
    )

def main() -> None:
    if not PAGE.exists():
        raise SystemExit(f"❌ 找不到 {PAGE}")

    # 刻意不給 --user-data-dir：指定一個全新的暫存 profile 會讓 headless
    # 卡在首次啟動的初始化，而且不會報錯。用預設 profile 反而穩。
    try:
        out = subprocess.run(
            [chrome(), "--headless", "--disable-gpu",
             "--virtual-time-budget=4000", "--dump-dom", PAGE.as_uri()],
            capture_output=True, text=True, timeout=90,
        ).stdout
    except subprocess.TimeoutExpired:
        raise SystemExit(
            "❌ Chrome 沒有在 90 秒內回應。可能有殘留的 headless 行程佔著：\n"
            '   pkill -f "Google Chrome.*headless"\n'
            "   還是不行就直接用瀏覽器打開 tests/run.html 看。"
        )

    # 逐項印出來，不是只給一個總數——紅的時候要看得出是哪一條
    for m in re.finditer(r'class="(pass|fail)">([^<]+)<', out):
        if m.group(1) == "fail":
            print(f"  {m.group(2)}")

    summary = re.search(r'id="summary"[^>]*>([^<]+)<', out)
    if not summary:
        raise SystemExit("❌ 頁面沒跑起來（抓不到 summary）。用瀏覽器打開看看是什麼錯。")

    text = summary.group(1).strip()
    print(text)
    if text.startswith("✅"):
        return
    if "執行中" in text:
        raise SystemExit("❌ 測試沒跑完就結束了——把 --virtual-time-budget 調大再試。")
    sys.exit(1)

if __name__ == "__main__":
    main()
