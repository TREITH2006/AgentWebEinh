import os, struct, zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icons")
BG = (79, 70, 229)      # indigo
FG = (255, 255, 255)

def make_icon(size):
    px = [[BG for _ in range(size)] for _ in range(size)]
    # inset border
    b = max(1, size // 16)
    for y in range(size):
        for x in range(size):
            if x < b or y < b or x >= size - b or y >= size - b:
                px[y][x] = FG
    # stylized "A": two diagonal legs + crossbar
    cx = size / 2.0
    top = int(size * 0.22)
    bot = int(size * 0.80)
    half = size * 0.26
    thick = max(1, int(size * 0.09))
    for y in range(top, bot + 1):
        t = (y - top) / max(1, (bot - top))
        spread = t * half
        for d in range(thick):
            lx = int(round(cx - spread)) - d
            rx = int(round(cx + spread)) + d
            if 0 <= lx < size:
                px[y][lx] = FG
            if 0 <= rx < size:
                px[y][rx] = FG
    bar_top = int(size * 0.56)
    bar_bot = min(bot, bar_top + thick)
    for y in range(bar_top, bar_bot + 1):
        t = (y - top) / max(1, (bot - top))
        spread = t * half
        for x in range(int(cx - spread), int(cx + spread) + 1):
            if 0 <= x < size:
                px[y][x] = FG
    return px

def write_png(path, px):
    size = len(px)
    raw = b"".join(b"\x00" + b"".join(struct.pack("BBB", *p) for p in row) for row in px)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)

os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 128):
    p = os.path.join(OUT, f"icon{s}.png")
    write_png(p, make_icon(s))
    print("wrote", p)
