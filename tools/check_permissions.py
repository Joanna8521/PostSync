#!/usr/bin/env python3
"""檢查 manifest 宣告的權限，真的涵蓋程式會去打的網址。

    python3 tools/check_permissions.py

為什麼要有這一支：match pattern 寫錯不會有任何錯誤訊息。Chrome 只是
安靜地不注入 content script、或安靜地擋掉 background 的 fetch，
而症狀是「這個平台沒反應」「圖片收不到」——看起來完全像別的問題。

這裡自己實作一遍 Chrome 的比對規則，然後拿真實的網址形狀去對。
"""

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))

# ── Chrome 的 match pattern 規則 ──────────────────────

def parse(pattern: str):
    if pattern == "<all_urls>":
        return ("*", "*", "/*")
    m = re.match(r"^(\*|https?|file|ftp)://([^/]*)(/.*)$", pattern)
    if not m:
        raise ValueError(f"不是合法的 match pattern：{pattern}")
    scheme, host, path = m.groups()
    if host != "*" and host.startswith("*") and not host.startswith("*."):
        raise ValueError(f"host 的萬用字元只能是 *. 開頭：{pattern}")
    return scheme, host, path

def matches(pattern: str, url: str) -> bool:
    scheme, host, path = parse(pattern)
    u = urlparse(url)
    if scheme != "*" and u.scheme != scheme:
        return False
    if host == "*":
        pass
    elif host.startswith("*."):
        base = host[2:]
        if u.hostname != base and not (u.hostname or "").endswith("." + base):
            return False
    elif u.hostname != host:
        return False
    rx = "^" + ".*".join(re.escape(p) for p in path.split("*")) + "$"
    return re.match(rx, u.path or "/") is not None

# ── 程式實際會碰到的網址形狀 ──────────────────────────
# 每一條都是真的出現過的，不是想像出來的

CONTENT = [
    ("臉書首頁動態牆", "https://www.facebook.com/"),
    ("臉書單篇貼文", "https://www.facebook.com/demo.user/posts/pfbid0EXAMPLE1234"),
    ("臉書相片頁", "https://www.facebook.com/photo/?fbid=10163452844983042&set=a.14"),
    ("臉書社團", "https://web.facebook.com/groups/123456789/"),
    ("臉書行動版", "https://m.facebook.com/story.php?story_fbid=1&id=2"),
    ("Threads 新網域", "https://www.threads.com/@joan/post/DABC123"),
    ("Threads 舊網域", "https://www.threads.net/@joan"),
    ("X 推文", "https://x.com/joan/status/1234567890"),
    ("Twitter 舊網域", "https://twitter.com/joan/status/1234567890"),
    ("IG 貼文", "https://www.instagram.com/p/DABC123/"),
    ("IG Reel", "https://www.instagram.com/reel/DABC123/"),
    ("LinkedIn 動態", "https://www.linkedin.com/feed/"),
]

# background 會 fetch 的：圖片來源與 API
BACKGROUND = [
    ("臉書圖床", "https://scontent-tpe1-1.xx.fbcdn.net/v/t39.30808-6/x.jpg"),
    ("IG 圖床（fbcdn）", "https://instagram.ftpe8-2.fna.fbcdn.net/v/t51/x.jpg"),
    ("IG 圖床（cdninstagram）", "https://scontent.cdninstagram.com/v/t51/x.jpg"),
    ("X 圖床", "https://pbs.twimg.com/media/Fxxxxx.jpg"),
    ("LinkedIn 圖床", "https://media.licdn.com/dms/image/v2/D5622AQ/x.jpg"),
    ("Drive API", "https://www.googleapis.com/drive/v3/files"),
    ("Drive 上傳", "https://www.googleapis.com/upload/drive/v3/files"),
    ("Docs API", "https://docs.googleapis.com/v1/documents/abc123:batchUpdate"),
    ("Drive 圖片直連", "https://drive.google.com/uc"),
]

# 使用者自己填的站台走 optional_host_permissions，安裝時不索取，
# 在 popup 按儲存的當下才跟使用者要
OPTIONAL = [
    ("Focus4ai 線上站台", "https://app.focus4ai.com/api/doc"),
    ("Focus4ai 本機自架", "http://localhost:8000/api/doc"),
]

def main() -> None:
    host_perms = MANIFEST.get("host_permissions", [])
    opt_perms = MANIFEST.get("optional_host_permissions", [])
    cs_matches = [m for c in MANIFEST.get("content_scripts", []) for m in c.get("matches", [])]

    bad = 0

    print("=== match pattern 語法 ===")
    for p in host_perms + opt_perms + cs_matches:
        try:
            parse(p)
        except ValueError as e:
            print(f"  ❌ {e}")
            bad += 1
    print(f"  {len(set(host_perms + opt_perms + cs_matches))} 條，語法{'有問題' if bad else '全部合法'}")

    def check(title, cases, patterns, note=""):
        nonlocal bad
        print(f"\n=== {title} ==={note}")
        for label, url in cases:
            hit = next((p for p in patterns if matches(p, url)), None)
            if hit:
                print(f"  ✅ {label:22} ← {hit}")
            else:
                print(f"  ❌ {label:22} 沒有任何 pattern 涵蓋：{url}")
                bad += 1

    check("content script 注入（決定哪些平台有浮動按鈕）", CONTENT, cs_matches)
    check("background fetch（圖片與 API）", BACKGROUND, host_perms)
    check("使用者自填的站台", OPTIONAL, opt_perms,
          "　※ 安裝時不索取，儲存設定當下才要")

    # 反向檢查：宣告了卻沒有任何程式會用到的權限，是多要的
    print("\n=== 有沒有多要權限 ===")
    all_urls = [u for _, u in CONTENT + BACKGROUND]
    for p in host_perms:
        if not any(matches(p, u) for u in all_urls):
            print(f"  ⚠️  {p} 沒有對應到任何已知用途（多要的權限會拖慢商店審查）")
    for p in cs_matches:
        if not any(matches(p, u) for _, u in CONTENT):
            print(f"  ⚠️  content_scripts 的 {p} 沒有對應到任何已知網址形狀")
    print("  （沒有輸出＝每一條都有用途）")

    print()
    if bad:
        print(f"❌ {bad} 項沒過")
        sys.exit(1)
    print("✅ 全部通過")

if __name__ == "__main__":
    main()
