#!/usr/bin/env python3
"""產生 Post Sync 的擴充圖示（墨綠圓角底 + 黃色書籤 + 閃電缺口）。

只用標準函式庫，不需要 Pillow。以 4x4 超取樣做邊緣平滑，
所以 16px 的小圖也不會有鋸齒。

顏色刻意跟 Mesh Sync（靛藍 #4F46E5）分開：兩支擴充會並排在
同一條工具列上，16px 下唯一分得出來的線索就是顏色。

用法：python3 tools/make_icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"

BG = (13, 106, 90)       # #0D6A5A 墨綠
MARK = (253, 224, 71)    # #FDE047 亮黃
SS = 4                   # 每邊超取樣倍數

# 書籤外框，座標為 0..1 的單位正方形
BOOKMARK = [
    (0.285, 0.130),
    (0.715, 0.130),
    (0.715, 0.890),
    (0.500, 0.690),
    (0.285, 0.890),
]

# 挖在書籤上的閃電缺口（挖掉＝露出底色，一眼看得出是「收藏＋同步」）
BOLT = [
    (0.560, 0.230),
    (0.395, 0.480),
    (0.492, 0.480),
    (0.442, 0.680),
    (0.610, 0.420),
    (0.512, 0.420),
]

def in_polygon(x, y, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xt = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
            if x < xt:
                inside = not inside
    return inside

def in_rounded_rect(x, y, r):
    """x, y 為 0..1；r 是圓角半徑（同樣是 0..1 的比例）。"""
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r

def render(size):
    radius = 0.22
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r_acc = g_acc = b_acc = a_acc = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    if not in_rounded_rect(x, y, radius):
                        continue
                    on_mark = in_polygon(x, y, BOOKMARK) and not in_polygon(x, y, BOLT)
                    color = MARK if on_mark else BG
                    r_acc += color[0]
                    g_acc += color[1]
                    b_acc += color[2]
                    a_acc += 255
            n = SS * SS
            if a_acc == 0:
                row += bytes((0, 0, 0, 0))
            else:
                covered = a_acc // 255
                row += bytes((r_acc // covered, g_acc // covered, b_acc // covered, a_acc // n))
        rows.append(bytes(row))
    return rows

def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    return len(png)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        path = OUT / f"icon{size}.png"
        n = write_png(path, size, render(size))
        print(f"{path.name}: {size}x{size}, {n} bytes")

if __name__ == "__main__":
    main()
