#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""逐字走過 JS，分出「字串字面」與「註解」與「regex 字面」。

### 為什麼不能用 regex 做這件事

這個 repo 的註解幾乎全是中文，而要找的正是「寫死在字串裡的中文」。
用 regex 一掃，註解全部命中，掃描就廢了。反過來只掃註解外的引號也不行：
註解裡本來就常常引用字串。

### 為什麼要認 regex 字面

第一版沒認，然後 naming.js 這一行把它整個弄壞：

    .replace(/[\\/\\\\:*?"<>|\\r\\n]/g, ' ')

那個 regex 裡有一個 `"`。狀態機把它當成字串開頭，一路吞到下一個 `"`，
於是那之後的東西全部判錯 —— 而它不會報錯，只會給出一份看起來正常的
結果。一個會安靜脫隊的掃描器當閘門最糟。

所以：`/` 要判斷是 regex 開頭還是除號。判準是前一個有意義的字元 ——
識別字、數字、`)`、`]`、`}` 之後的 `/` 是除號，其餘位置是 regex 開頭。

### 走完還在字串裡就報錯

脫隊了就要有人知道。`scan` 走到檔尾如果還在字串狀態，丟 ValueError，
不回傳半套結果。閘門壞掉要壞得大聲。
"""
import re
import sys
from pathlib import Path

# 中日韓文字、全形標點、全形英數
CJK = re.compile(r"[　-〿㐀-䶿一-鿿＀-￯]")

# `/` 之前出現這些就是除號，不是 regex 開頭
_DIV_BEFORE = re.compile(r"[\w$)\]}]")


class Desync(ValueError):
    """走完還在字串或區塊註解裡：這份掃描結果不可信，不要用。"""


def scan(src, path="<str>"):
    """回傳 [(行號, 引號種類, 內容)]，只有字串字面。"""
    out = []
    i, n, line = 0, len(src), 1
    prev = ""  # 上一個有意義的字元，判斷 `/` 用

    def is_regex_start():
        return not _DIV_BEFORE.match(prev) if prev else True

    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
        elif c in " \t\r":
            i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            start = line
            i += 2
            closed = False
            while i + 1 < n:
                if src[i] == "*" and src[i + 1] == "/":
                    i += 2
                    closed = True
                    break
                if src[i] == "\n":
                    line += 1
                i += 1
            if not closed:
                raise Desync(f"{path}:{start} 區塊註解沒有收尾")
        elif c == "/" and is_regex_start():
            # regex 字面。裡面的引號跟 `/` 都不算，character class 裡的
            # `/` 也不收尾（JS 其實允許，但照規矩跳過最穩）。
            start = line
            i += 1
            in_class = False
            closed = False
            while i < n:
                ch = src[i]
                if ch == "\\":
                    i += 2
                    continue
                if ch == "\n":
                    raise Desync(f"{path}:{start} regex 字面跨行")
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    i += 1
                    closed = True
                    break
                i += 1
            if not closed:
                raise Desync(f"{path}:{start} regex 字面沒有收尾")
            prev = "/"
        elif c in "'\"`":
            q, start, buf = c, line, []
            i += 1
            closed = False
            while i < n:
                if src[i] == "\\":
                    buf.append(src[i:i + 2])
                    i += 2
                    continue
                if src[i] == q:
                    i += 1
                    closed = True
                    break
                if src[i] == "\n":
                    if q != "`":
                        raise Desync(f"{path}:{start} 字串跨行（只有樣板字串可以）")
                    line += 1
                buf.append(src[i])
                i += 1
            if not closed:
                raise Desync(f"{path}:{start} 字串沒有收尾")
            out.append((start, q, "".join(buf)))
            prev = q
        else:
            prev = c
            i += 1
    return out


def cjk_strings(path):
    """那個檔裡含中日韓文字的字串字面。"""
    src = Path(path).read_text(encoding="utf-8")
    return [(ln, s) for ln, _q, s in scan(src, str(path)) if CJK.search(s)]


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "extension")
    total = 0
    for p in sorted(root.rglob("*.js")):
        hits = cjk_strings(p)
        if hits:
            print(f"\n── {p}　{len(hits)} 個")
            total += len(hits)
            for ln, s in hits:
                print(f"  {ln:4d}  {s.replace(chr(10), '⏎')[:76]}")
    print(f"\n合計 {total} 個含中文的字串字面")
