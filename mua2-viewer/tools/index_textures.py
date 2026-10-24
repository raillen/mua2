#!/usr/bin/env python3
"""Index MUA2 texture IGZ files: hash -> file, dimensions, format, data offset."""
import sys, os, json, struct, glob
import igb_import
from igb_blender.igz_format.igz_reader import IGZReader

ROOTS = [
    '/home/raillen/Documentos/decomp-games/_work/igz_materials/actors',
    '/home/raillen/Documentos/decomp-games/_work/igz_textures',
    '/home/raillen/Documentos/decomp-games/_work/igz_materials/effects',
    '/home/raillen/Documentos/decomp-games/_work/igz_materials/levels',
]
OUT = '/home/raillen/Documentos/decomp-games/_work/texture_index.json'

FMT = {0x883C45B2: ('DXT1', 8), 0xB718471E: ('DXT5', 16), 0x05ECD805: ('ATI2', 16),
       0x26D53F6E: ('BGRA8', 4), 0xD7B93585: ('BGRA8', 4)}

def mip_size(w, h, block_bytes, mips):
    """Exact size of the mip chain, using the file's real mip count.

    The mip count comes from igImage2 (+0x1A). Computing the chain down to
    1x1 instead adds extra trailing levels, which shifts data_off early by a
    whole number of DXT blocks and slides the decoded image sideways.
    """
    total = 0
    for i in range(max(1, mips)):
        ww, hh = max(1, w >> i), max(1, h >> i)
        total += max(1, (ww + 3) // 4) * max(1, (hh + 3) // 4) * block_bytes
    return total

def main():
    index = {}
    files = []
    for root in ROOTS:
        files.extend(glob.glob(root + '/**/*.igz', recursive=True))
    print("files", len(files), file=sys.stderr)
    for i, p in enumerate(files):
        try:
            r = IGZReader(p); r.read()
            imgs = r.get_objects_by_type('igImage2')
            if not imgs:
                continue
            o = imgs[0]
            raw = o.raw_data
            w, h, depth, mips = struct.unpack_from('<4H', raw, 0x18)
            if not (0 < w <= 8192 and 0 < h <= 8192):
                continue
            # name string index at +0x10
            name_idx = struct.unpack_from('<Q', raw, 0x10)[0]
            name = r.fixups.tstr[name_idx] if name_idx < len(r.fixups.tstr) else ''
            # format: look at exnm hashes
            fmt = None
            for a, b in r.fixups.exnm:
                for cand in (a, b):
                    if cand in FMT:
                        fmt = FMT[cand][0]; block = FMT[cand][1]; break
                if fmt: break
            if not fmt:
                continue
            # hash from igHandleList referenced at +0x50 (64-bit) or +0x30
            hash_val = 0
            hl = r.get_objects_by_type('igHandleList')
            if hl:
                hraw = hl[0].raw_data
                # memory ref at +0x18? count at +0x10, capacity +0x14, size +0x18, ptr +0x20
                size = struct.unpack_from('<I', hraw, 0x18)[0] & 0xFFFFFF
                ptr = struct.unpack_from('<Q', hraw, 0x20)[0]
                goff = r._get_global_offset(ptr)
                if 0 < size <= 64 and 0 <= goff < len(r.data) - 8:
                    hash_val = struct.unpack_from('<Q', r.data, goff)[0]
            if not hash_val:
                continue
            data_size = mip_size(w, h, block, mips)
            fsize = os.path.getsize(p)
            data_off = fsize - data_size
            if data_off < 0:
                continue
            key = f'{hash_val:016x}'
            index[key] = {
                'file': p, 'name': name, 'width': w, 'height': h,
                'mips': mips, 'format': fmt, 'data_off': data_off,
                'data_size': data_size, 'file_size': fsize,
            }
        except Exception as e:
            if i % 500 == 0:
                print("skip", p, type(e).__name__, e, file=sys.stderr)
        if (i + 1) % 500 == 0:
            print(f"  {i+1}/{len(files)} indexed={len(index)}", file=sys.stderr)
    json.dump(index, open(OUT, 'w'), indent=1)
    print("wrote", OUT, len(index), file=sys.stderr)

if __name__ == '__main__':
    main()
