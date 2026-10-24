#!/usr/bin/env python3
"""Index MUA2 effect IGZ files (strings only) and extract preview textures."""
import sys, os, glob, json, re, collections
import igb_import
from igb_blender.igz_format.igz_reader import IGZReader
from PIL import Image

ROOT = '/home/raillen/Documentos/decomp-games/_work'
OUT = '/home/raillen/Documentos/decomp-games/mua2-viewer/assets/vfx'
TEX_INDEX = json.load(open(f'{ROOT}/texture_index.json'))

# basename.tga -> texture info (prefer actor/effect materials over UI)
by_base = {}
for k, v in TEX_INDEX.items():
    base = os.path.basename(v['name'].replace('\\', '/')).lower()
    if not base:
        continue
    prev = by_base.get(base)
    score = 0
    if 'materials/effects' in v['name'].lower(): score += 2
    if 'materials/actors' in v['name'].lower(): score += 2
    if prev is None or score > prev[0]:
        by_base[base] = (score, v)

os.makedirs(OUT, exist_ok=True)

def dxt1(data, w, h):
    import struct, numpy as np
    out = np.zeros((h, w, 3), np.uint8); off = 0
    def rgb(c):
        return [((c >> 11) & 31) * 255 // 31, ((c >> 5) & 63) * 255 // 63, (c & 31) * 255 // 31]
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            c0, c1, bits = struct.unpack_from('<HHI', data, off); off += 8
            a, b = rgb(c0), rgb(c1)
            cols = [a, b, [(2 * a[i] + b[i]) // 3 for i in range(3)], [(a[i] + 2 * b[i]) // 3 for i in range(3)]]
            for y in range(4):
                for x in range(4):
                    if by + y < h and bx + x < w:
                        out[by + y, bx + x] = cols[(bits >> (2 * (y * 4 + x))) & 3]
    return out

def dxt5(data, w, h):
    import struct, numpy as np
    out = np.zeros((h, w, 4), np.uint8); off = 0
    def rgb(c):
        return [((c >> 11) & 31) * 255 // 31, ((c >> 5) & 63) * 255 // 63, (c & 31) * 255 // 31]
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            a0, a1 = struct.unpack_from('<BB', data, off)
            abits = int.from_bytes(data[off+2:off+8], 'little'); off += 8
            c0, c1, bits = struct.unpack_from('<HHI', data, off); off += 8
            al = [a0, a1] + ([((7-i)*a0+i*a1)//7 for i in range(1,7)] if a0 > a1 else [((5-i)*a0+i*a1)//5 for i in range(1,5)] + [0,255])
            a, b = rgb(c0), rgb(c1)
            cols = [a, b, [(2*a[i]+b[i])//3 for i in range(3)], [(a[i]+2*b[i])//3 for i in range(3)]]
            for y in range(4):
                for x in range(4):
                    if by+y < h and bx+x < w:
                        out[by+y,bx+x,:3] = cols[(bits >> (2*(y*4+x))) & 3]
                        out[by+y,bx+x,3] = al[(abits >> (3*(y*4+x))) & 7]
    return out

def preview(info, path):
    ext = '.png'
    if os.path.exists(path):
        return
    raw = open(info['file'], 'rb').read()
    data = raw[info['data_off']:]
    w, h, fmt = info['width'], info['height'], info['format']
    if fmt == 'DXT1':
        img = Image.fromarray(dxt1(data, w, h), 'RGB')
    elif fmt == 'DXT5':
        img = Image.fromarray(dxt5(data, w, h), 'RGBA')
    else:
        return
    img.thumbnail((256, 256), Image.LANCZOS)
    img.save(path)

rows = []
files = glob.glob(f'{ROOT}/igz_effects/**/*.igz', recursive=True)
for i, p in enumerate(files):
    try:
        r = IGZReader(p); r.read()
        strings = r.fixups.tstr
        texs = [s for s in strings if s.lower().endswith(('.tga', '.dds'))]
        if not texs:
            continue
        rel = os.path.relpath(p, f'{ROOT}/igz_effects')
        name = os.path.splitext(os.path.basename(rel))[0]
        # choose a preview texture: prefer non-normal, non-lut, first
        picked = None
        for t in texs:
            base = os.path.basename(t.replace('\\', '/')).lower()
            if base.startswith(('lut_', 'textures/luts')) or base.endswith(('_n.tga', '_n.dds')):
                continue
            if base in by_base:
                picked = by_base[base][1]; break
        row = {'name': name, 'path': rel, 'textures': [os.path.basename(t.replace('\\', '/')) for t in texs[:8]]}
        if picked:
            png = f'{OUT}/{name}.png'
            try:
                preview(picked, png)
                row['preview'] = os.path.basename(png)
                row['preview_file'] = picked['file']
            except Exception:
                pass
        rows.append(row)
    except Exception:
        pass
    if (i+1) % 1000 == 0:
        print(i+1, len(files), len(rows), file=sys.stderr)

# sort: actor effects first, then map effects, then others
def rank(row):
    p = row['path'].lower()
    if p.startswith('actor'): return 0
    if p.startswith('map'): return 1
    if p.startswith('fx'): return 2
    return 3
rows.sort(key=lambda r: (rank(r), r['name']))
json.dump({'effects': rows}, open(f'{OUT}/effects.json', 'w'), indent=1)
print("wrote", len(rows), "effects", file=sys.stderr)
