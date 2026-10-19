"""生成托盘/窗口用的简单图标（无第三方依赖，手写 PNG 编码）。"""
import struct, zlib, os

S = 64          # 画布尺寸
R = 14          # 圆角半径
BG = (22, 119, 255)
FG = (255, 255, 255)


def inside_round_rect(x, y, w, h, r):
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x > w - r - 1 and y < r:
        return (x - (w - r - 1)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y > h - r - 1:
        return (x - r) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    if x > w - r - 1 and y > h - r - 1:
        return (x - (w - r - 1)) ** 2 + (y - (h - r - 1)) ** 2 <= r * r
    return True


def inside_round_rect_f(px, py, x0, y0, x1, y1, r):
    """浮点版圆角矩形（带 1px 反走样）"""
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
    return max(0.0, min(1.0, r - d + 0.5)) if (px < x0 + r or px > x1 - r) and (py < y0 + r or py > y1 - r) else (
        1.0 if x0 - 0.5 <= px <= x1 + 0.5 and y0 - 0.5 <= py <= y1 + 0.5 else 0.0
    )


rows = []
for y in range(S):
    row = bytearray([0])
    for x in range(S):
        a_bg = 1.0 if inside_round_rect(x, y, S, S, R) else 0.0
        # 对话气泡：白色圆角矩形（x 14..50, y 18..42, r 8）
        a_bub = inside_round_rect_f(x + 0.5, y + 0.5, 14, 18, 50, 42, 8)
        # 气泡尾巴
        a_tail = 0.0
        if 20 <= x <= 32 and 42 <= y <= 50:
            t = (y - 42) / 8.0
            left = 20
            right = 32 - 14 * t
            if left <= x + 0.5 <= right:
                a_tail = 1.0
        a_fg = max(a_bub, a_tail)
        r_c = int(round(BG[0] * (1 - a_fg) + FG[0] * a_fg))
        g_c = int(round(BG[1] * (1 - a_fg) + FG[1] * a_fg))
        b_c = int(round(BG[2] * (1 - a_fg) + FG[2] * a_fg))
        row += bytes([r_c, g_c, b_c, int(round(255 * a_bg))])
    rows.append(bytes(row))

raw = b"".join(rows)


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources")
os.makedirs(out_dir, exist_ok=True)
with open(os.path.join(out_dir, "tray.png"), "wb") as f:
    f.write(png)
print("wrote", os.path.join(out_dir, "tray.png"), len(png), "bytes")
