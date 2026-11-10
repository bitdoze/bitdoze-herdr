#!/usr/bin/env python3
"""Minimal PNG crop/fill tool (8-bit RGB/RGBA/Gray, non-interlaced).

Used to crop `herdr-app shot` frames into package preview.png files and
to blank out regions that must not ship. No dependencies beyond stdlib.

  pngtool.py in.png out.png --crop x y w h [--fill x y w h RRGGBB ...] [--half]
"""
import zlib, struct, sys


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    pos, w, h, bd, ct, inter, idat = 8, 0, 0, 0, 0, 0, b""
    while pos < len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos+8]); pos += 8
        chunk = data[pos:pos+ln]; pos += ln + 4
        if typ == b"IHDR":
            w, h, bd, ct, _c, _f, inter = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
    assert bd == 8 and inter == 0, f"unsupported png bd={bd} inter={inter}"
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    raw = zlib.decompress(idat)
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:
            for i in range(ch, stride): line[i] = (line[i] + line[i-ch]) & 255
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i-ch] if i >= ch else 0
                b = prev[i]
                c = prev[i-ch] if i >= ch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y*stride:(y+1)*stride] = line
        prev = line
    return w, h, ch, out


def write_png(path, w, h, ch, px):
    ct = {1: 0, 2: 4, 3: 2, 4: 6}[ch]
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0)
    rows = bytearray()
    stride = w * ch
    for y in range(h):
        rows.append(0)
        rows += px[y*stride:(y+1)*stride]
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b""))
    open(path, "wb").write(png)


def crop(w, h, ch, px, x, y, cw, chh):
    x = max(0, x); y = max(0, y)
    cw = min(cw, w - x); chh = min(chh, h - y)
    out = bytearray(cw * chh * ch)
    for r in range(chh):
        s = ((y + r) * w + x) * ch
        out[r*cw*ch:(r+1)*cw*ch] = px[s:s + cw*ch]
    return cw, chh, out


def half(w, h, ch, px):
    """2x box downscale (retina shots -> logical pixels)."""
    ow, oh = w // 2, h // 2
    out = bytearray(ow * oh * ch)
    for y in range(oh):
        for x in range(ow):
            s = x * ch
            for c in range(ch):
                a = px[(y*2*w + x*2)*ch + c] + px[(y*2*w + x*2+1)*ch + c] \
                    + px[((y*2+1)*w + x*2)*ch + c] + px[((y*2+1)*w + x*2+1)*ch + c]
                out[y*ow*ch + s + c] = (a + 2) // 4
    return ow, oh, out


def fill(w, ch, px, x, y, cw, chh, rgb):
    h = len(px) // (w * ch)
    for r in range(max(0, y), min(y + chh, h)):
        for c in range(max(0, x), min(x + cw, w)):
            i = (r * w + c) * ch
            px[i:i + 3] = bytes(rgb[:3])
            if ch in (2, 4):
                px[i + ch - 1] = 255


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    args = sys.argv[3:]
    w, h, ch, px = read_png(src)
    ops = []
    i = 0
    cw = chh = cx = cy = None
    while i < len(args):
        a = args[i]
        if a == "--crop":
            cx, cy, cw, chh = map(int, args[i+1:i+5]); i += 5
        elif a == "--fill":
            x, y, fw, fh = map(int, args[i+1:i+5]); col = bytes.fromhex(args[i+5]); i += 6
            ops.append(("fill", x, y, fw, fh, col))
        elif a == "--half":
            ops.append(("half",)); i += 1
        else:
            i += 1
    if cw is not None:
        w, h, px = crop(w, h, ch, px, cx, cy, cw, chh)
    for op in ops:
        if op[0] == "half":
            w, h, px = half(w, h, ch, px)
        else:
            _, x, y, fw, fh, col = op
            fill(w, ch, px, x, y, fw, fh, col)
    write_png(dst, w, h, ch, px)
    print(f"{dst}: {w}x{h} ch={ch}")
