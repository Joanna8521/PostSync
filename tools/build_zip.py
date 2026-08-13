#!/usr/bin/env python3
"""把 extension/ 打包成可以直接載入的 zip。

    python3 tools/build_zip.py
"""

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"

def main() -> None:
    version = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    out = ROOT / f"post-sync-v{version}.zip"
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(SRC.rglob("*")):
            if f.is_file() and f.name != ".DS_Store":
                z.write(f, Path("post-sync-extension") / f.relative_to(SRC))
    print(f"{out.name}（{out.stat().st_size / 1024:.1f} KB）")

if __name__ == "__main__":
    main()
