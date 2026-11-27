#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""從 tools/messages.py 產生 extension/_locales/*/messages.json。

    python3 tools/build_messages.py          # 寫檔
    python3 tools/build_messages.py --check   # 只比對，不一致就非零離開

--check 是 run_tests.py 用的。手改 messages.json 不會靜靜地生效，會紅。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from messages import MESSAGES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LOCALES = ROOT / "extension" / "_locales"

# (資料夾, 在 MESSAGES 每一條裡的索引, 要不要寫 description)
TARGETS = [("zh_TW", 2, True), ("en", 3, False), ("ja", 4, False)]


def build(index, with_desc):
    out = {}
    for key, desc, *langs in MESSAGES:
        entry = {"message": langs[index - 2]}
        if with_desc and desc:
            entry["description"] = desc
        out[key] = entry
    return out


def text(index, with_desc):
    # ensure_ascii=False 才看得到中文與日文；不然 diff 全是 \uXXXX，
    # 審不了。indent=2、尾巴一個換行，跟 repo 其他 JSON 一致。
    return json.dumps(build(index, with_desc), ensure_ascii=False, indent=2) + "\n"


def main(argv):
    check = "--check" in argv
    bad = 0
    for folder, index, with_desc in TARGETS:
        path = LOCALES / folder / "messages.json"
        want = text(index, with_desc)
        if check:
            have = path.read_text(encoding="utf-8") if path.exists() else ""
            if have != want:
                bad += 1
                if not path.exists():
                    print(f"  ❌ {path.relative_to(ROOT)} 不存在")
                else:
                    print(f"  ❌ {path.relative_to(ROOT)} 跟 tools/messages.py 不一致"
                          f"（跑 python3 tools/build_messages.py 重新產生）")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(want, encoding="utf-8")
            print(f"  ✅ {path.relative_to(ROOT)}　{len(MESSAGES)} 條")
    if check:
        print("  ✅ 三份 messages.json 都跟目錄一致" if not bad else f"  {bad} 份不一致")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
