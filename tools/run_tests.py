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

# ── 原始碼掃描：不可見字元 ────────────────────────────
# 為什麼要有這一支：controlled character 直接寫成位元組（而不是 \x00 這種
# 跳脫形式）在 JS 裡照樣能跑，所以測試會全綠。但那會讓整個檔被當成 binary，
# 於是 `grep` 對它**完全靜音**——不是報錯，是回傳空的。
#
# 這件事真的發生過：查一個功能在不在檔案裡，grep 回空的，就以為程式碼被
# 刪了，回頭重做了一遍。看不見的東西不會有人發現，只能用掃描釘死。

INVISIBLE = re.compile(
    "[\x00-\x08\x0b-\x1f\x7f"          # 控制字元
    "\u00ad\u034f\u200b-\u200f"         # 軟連字號、組合用字元、方向控制
    "\u2060-\u2064\u206a-\u206f\ufeff]"  # 連接符、格式字元、BOM
)

def scan_sources() -> int:
    bad = 0
    for f in sorted((ROOT / "extension").rglob("*.js")) + sorted((ROOT / "tests").rglob("*.js")):
        text = f.read_text(encoding="utf-8")
        for n, line in enumerate(text.split("\n"), 1):
            for m in INVISIBLE.finditer(line):
                bad += 1
                print(f"  ❌ {f.relative_to(ROOT)}:{n} 有字面上的不可見字元 "
                      f"U+{ord(m.group()):04X}（要寫成跳脫形式，例如 \\x00）")
    print("  ✅ 原始碼沒有字面上的不可見字元" if not bad else f"  {bad} 處")
    return bad

# ── 多語言：三份 messages.json 與用到的 key ─────────────
# 為什麼要有這一段：i18n 壞掉的方式全部是安靜的。
#
#   ・三份 messages.json 分岔 → 某一個語言下某一條顯示成 key 本身，
#     而那只有在剛好有人用那個語言打開那一頁的時候才看得到；
#   ・程式裡 getMessage('abc') 但目錄裡沒有 abc → 同上；
#   ・目錄裡有一條但沒人用 → 翻譯三遍的白工，而且會一直留著；
#   ・替換位置（$1、$2）三語不一致 → 某個語言下數字跑掉或消失。
#
# 全部都不會報錯，所以只能掃。

MSG_KEY_CALLS = re.compile(r"""(?:\bT|\btr|\bt|getMessage)\(\s*['"]([A-Za-z0-9_]+)['"]""")
MSG_KEY_ATTRS = re.compile(r"""data-i18n(?:-[a-z]+)?=["']([A-Za-z0-9_]+)["']""")
MSG_KEY_MANIFEST = re.compile(r"__MSG_([A-Za-z0-9_]+)__")


def check_i18n() -> int:
    sys.path.insert(0, str(ROOT / "tools"))
    import build_messages  # noqa: PLC0415
    from messages import MESSAGES  # noqa: PLC0415

    bad = 0

    # ① 三份檔要跟目錄一致
    bad += build_messages.main(["--check"])

    declared = {m[0] for m in MESSAGES}

    # ② 程式裡用到的 key 都要在目錄裡
    used = set()
    for f in sorted((ROOT / "extension").rglob("*.js")):
        if "_locales" in f.parts:
            continue
        src = f.read_text(encoding="utf-8")
        used |= set(MSG_KEY_CALLS.findall(src))
    for f in sorted((ROOT / "extension").glob("*.html")):
        used |= set(MSG_KEY_ATTRS.findall(f.read_text(encoding="utf-8")))
    used |= set(MSG_KEY_MANIFEST.findall(
        (ROOT / "extension" / "manifest.json").read_text(encoding="utf-8")))

    # t() 跟 tr() 的名字太短，會誤抓到別的同名函式。只回報真的不在目錄裡、
    # 而且長得像訊息 key 的（駝峰、至少兩個字）。誤抓的那些會落在這裡，
    # 所以寧可少報也不要每次都紅——這一條擋的是「打錯 key」，不是命名風格。
    missing = sorted(k for k in used - declared
                     if len(k) > 3 and re.search(r"[a-z][A-Z]", k))
    if missing:
        bad += 1
        print(f"  ❌ 程式裡用了目錄沒有的 key：{', '.join(missing)}")

    # ③ 目錄裡有但沒人用
    orphan = sorted(declared - used)
    if orphan:
        bad += 1
        print(f"  ❌ 目錄裡有但沒有人用的 key：{', '.join(orphan)}")

    # ④ 替換位置三語要一致
    for key, _desc, *langs in MESSAGES:
        slots = [set(re.findall(r"\$\d", s)) for s in langs]
        if slots[0] != slots[1] or slots[0] != slots[2]:
            bad += 1
            print(f"  ❌ {key} 的替換位置三語不一致：{[sorted(s) for s in slots]}")

    # ⑤ 幾句話在三種語言下都必須講到的東西。
    #    p2sNote 是寫進 persona-to-skill 匯入檔的那一句，它的工作就是講明
    #    tier 與 subject 要人自己填。某個語言漏講，那個語言的使用者就不知道。
    must = {"p2sNote": ["tier", "subject"]}
    by_key = {m[0]: m for m in MESSAGES}
    for key, words in must.items():
        if key not in by_key:
            bad += 1
            print(f"  ❌ 目錄裡找不到 {key}")
            continue
        for lang_name, s in zip(("繁中", "英", "日"), by_key[key][2:]):
            miss = [w for w in words if w not in s]
            if miss:
                bad += 1
                print(f"  ❌ {key} 的{lang_name}版沒有講到：{', '.join(miss)}")

    if not bad:
        print(f"  ✅ {len(MESSAGES)} 條訊息，三種語言齊備，沒有缺的也沒有多的")
    return bad


# ── README：三種語言都要在，而且互相連得到 ──────────
# 這一條擋的是「以後多加一種語言，忘了補某一份的切換列」。那種漏不會壞掉
# 任何東西，只會讓某個語言的讀者找不到別的語言——而寫的人看不到，因為他
# 看的是自己剛改的那一份。

READMES = {
    "README.md": "繁體中文",
    "README.en.md": "English",
    "README.ja.md": "日本語",
}


def check_readmes() -> int:
    bad = 0
    for name, label in READMES.items():
        path = ROOT / name
        if not path.exists():
            bad += 1
            print(f"  ❌ 少了 {name}")
            continue
        first = path.read_text(encoding="utf-8").split("\n", 1)[0]
        # 自己那一份要是粗體（表示「你正在看這一份」），不是連結
        if f"**{label}**" not in first:
            bad += 1
            print(f"  ❌ {name} 的切換列沒有把自己標成粗體（應該有 **{label}**）")
        # 另外兩份要是連得到的連結
        for other, other_label in READMES.items():
            if other == name:
                continue
            link = f"[{other_label}]({other})"
            if link not in first:
                bad += 1
                print(f"  ❌ {name} 的切換列少了 {link}")
            elif not (ROOT / other).exists():
                bad += 1
                print(f"  ❌ {name} 連到不存在的 {other}")
    if not bad:
        print(f"  ✅ {len(READMES)} 份 README 都在，切換列互相連得到")
    return bad


def chrome() -> str:
    for c in CANDIDATES:
        if Path(c).exists() or shutil.which(c):
            return c
    raise SystemExit(
        "❌ 找不到 Chrome。要嘛裝一個，要嘛直接用瀏覽器打開 tests/run.html 自己看。"
    )

def main() -> None:
    print("=== 原始碼掃描 ===")
    if scan_sources():
        sys.exit(1)

    print("=== 多語言 ===")
    if check_i18n() + check_readmes():
        sys.exit(1)

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
