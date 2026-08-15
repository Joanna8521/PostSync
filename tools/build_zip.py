#!/usr/bin/env python3
"""把 extension/ 打包成可以直接載入的 zip。

    python3 tools/build_zip.py

順便把「這一包是哪一版」烙進 manifest 的 version_name：version 欄位
每次發布都一樣，使用者回報問題時無從得知他跑的是哪一包。內容雜湊
不需要 git，內容不一樣戳記就不一樣。popup 標題與「檢查目前分頁」
的第一行都會顯示它。
"""

import hashlib
import json
import shutil
import tempfile
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"

def main() -> None:
    version = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    out = ROOT / f"post-sync-v{version}.zip"

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / "post-sync-extension"
        shutil.copytree(SRC, stage, ignore=shutil.ignore_patterns(".DS_Store"))

        h = hashlib.sha256()
        for f in sorted(stage.rglob("*")):
            if f.is_file() and f.name != "manifest.json":
                h.update(f.relative_to(stage).as_posix().encode())
                h.update(f.read_bytes())
        build = h.hexdigest()[:8]

        mf = stage / "manifest.json"
        m = json.loads(mf.read_text(encoding="utf-8"))
        m["version_name"] = f"{version}+{build} ({date.today().isoformat()})"
        mf.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        if out.exists():
            out.unlink()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(stage.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(stage.parent))

    print(f"{out.name}（{out.stat().st_size / 1024:.1f} KB）　build {build}")

if __name__ == "__main__":
    main()
