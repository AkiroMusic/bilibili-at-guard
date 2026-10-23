# Builds icons/icon{16,48,128}.png from assets/icon-source.png.
# Uses PIL when available (LANCZOS); falls back to a pure-stdlib
# PNG decoder + box-filter resize.
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'assets', 'icon-source.png')
SIZES = (128, 48, 16)


def generate_with_pil():
    from PIL import Image
    img = Image.open(SRC).convert('RGBA')
    for size in SIZES:
        out = os.path.join(ROOT, 'icons', f'icon{size}.png')
        img.resize((size, size), Image.LANCZOS).save(out)
        print(f'{out}: PIL/LANCZOS')


def load_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos = 8
    width = height = bitd = ctype = interlace = None
    idat = bytearray()
    palette = trns = None
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if tag == b'IHDR':
            width, height, bitd, ctype, _c, _f, interlace = struct.unpack('>IIBBBBB', body)
        elif tag == b'IDAT':
            idat += body
        elif tag == b'PLTE':
            palette = body
        elif tag == b'tRNS':
            trns = body
        elif tag == b'IEND':
            break
    assert bitd == 8 and interlace == 0, f'unsupported PNG: depth={bitd} interlace={interlace}'
    raw = zlib.decompress(bytes(idat))
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    stride = width * channels
    out = bytearray(height * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    rgba = bytearray(width * height * 4)
    if ctype == 6:
        return width, height, out
    if ctype == 2:
        for i in range(width * height):
            rgba[i * 4:i * 4 + 3] = out[i * 3:i * 3 + 3]
            rgba[i * 4 + 3] = 255
    elif ctype == 3:
        for i in range(width * height):
            idx = out[i]
            rgba[i * 4:i * 4 + 3] = palette[idx * 3:idx * 3 + 3]
            rgba[i * 4 + 3] = trns[idx] if (trns and idx < len(trns)) else 255
    elif ctype == 0:
        for i in range(width * height):
            g = out[i]
            rgba[i * 4:i * 4 + 4] = bytes((g, g, g, 255))
    return width, height, rgba


def save_png(path, w, h, rgba):
    def chunk(tag, d):
        return struct.pack('>I', len(d)) + tag + d + struct.pack('>I', zlib.crc32(tag + d) & 0xFFFFFFFF)

    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * w * 4:(y + 1) * w * 4]
    data = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
        + chunk(b'IEND', b'')
    )
    open(path, 'wb').write(data)


def box_resize(w, h, rgba, tw, th):
    out = bytearray(tw * th * 4)
    for ty in range(th):
        y0 = int(ty * h / th)
        y1 = max(int((ty + 1) * h / th), y0 + 1)
        for tx in range(tw):
            x0 = int(tx * w / tw)
            x1 = max(int((tx + 1) * w / tw), x0 + 1)
            r = g = b = a = n = 0
            for y in range(y0, y1):
                base = y * w * 4
                for x in range(x0, x1):
                    i = base + x * 4
                    pa = rgba[i + 3]
                    r += rgba[i] * pa
                    g += rgba[i + 1] * pa
                    b += rgba[i + 2] * pa
                    a += pa
                    n += 1
            j = (ty * tw + tx) * 4
            if a and n:
                out[j] = r // a
                out[j + 1] = g // a
                out[j + 2] = b // a
                out[j + 3] = a // n
    return out


def generate_pure():
    w, h, rgba = load_png(SRC)
    for size in SIZES:
        out = os.path.join(ROOT, 'icons', f'icon{size}.png')
        save_png(out, size, size, box_resize(w, h, rgba, size, size))
        print(f'{out}: pure/box')


def main():
    try:
        generate_with_pil()
    except ImportError:
        generate_pure()


if __name__ == '__main__':
    main()
