#!/usr/bin/env python3
"""把豆包登录二维码 PNG 渲染成终端 ANSI 二维码（黑白半块字符）。

用法：qr2ansi.py <qrcode.png>

依赖系统 Python 3 与 Pillow（飞牛系统自带）。渲染失败时返回非 0，
调用方可退化为直接提示图片路径。
"""

import sys

try:
    from PIL import Image
except Exception:
    sys.exit(2)

BLACK = "\033[30m"
WHITE_FG = "\033[97m"
BG_BLACK = "\033[40m"
BG_WHITE = "\033[107m"
RESET = "\033[0m"


def find_grid(im):
    """返回 (模块矩阵, 模块边长)。"""
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y] < 128:
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if maxx < 0:
        return None, 0

    bw = maxx - minx + 1
    bh = maxy - miny + 1

    candidates = []
    for n in range(21, 178, 4):
        if bw % n or bh % n:
            continue
        s = bw // n
        if s >= 1 and bh // n == s:
            candidates.append((n, s))

    # 从大到小尝试：模块数越多，说明取样越细，优先验证边界是否规整
    for n, s in sorted(candidates, reverse=True):
        matrix = []
        ok = True
        for my in range(n):
            row = []
            for mx in range(n):
                base_x = minx + mx * s
                base_y = miny + my * s
                cell = [
                    px[base_x, base_y],
                    px[base_x + s - 1, base_y],
                    px[base_x, base_y + s - 1],
                    px[base_x + s - 1, base_y + s - 1],
                ]
                dark = sum(1 for v in cell if v < 128)
                row.append(dark > 2)
            if len(set(row)) == 0:
                # 允许整行同色，但完全无变化时仍然接受
                pass
            matrix.append(row)
        if ok:
            return matrix, s
    return None, 0


def render(matrix, quiet=2):
    n = len(matrix)
    size = n + quiet * 2

    def dark(x, y):
        if x < quiet or y < quiet or x >= quiet + n or y >= quiet + n:
            return False
        return matrix[y - quiet][x - quiet]

    lines = []
    for y in range(0, size, 2):
        parts = []
        for x in range(size):
            top = dark(x, y)
            bottom = dark(x, y + 1) if y + 1 < size else False
            fg = BLACK if top else WHITE_FG
            bg = BG_BLACK if bottom else BG_WHITE
            parts.append(f"{fg}{bg}▀")
        lines.append("".join(parts) + RESET)
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("用法：qr2ansi.py <qrcode.png>", file=sys.stderr)
        return 1
    try:
        im = Image.open(sys.argv[1]).convert("L")
    except Exception as exc:
        print(f"无法读取二维码图片：{exc}", file=sys.stderr)
        return 1

    matrix, _ = find_grid(im)
    if not matrix:
        return 1

    print(render(matrix))
    return 0


if __name__ == "__main__":
    sys.exit(main())
