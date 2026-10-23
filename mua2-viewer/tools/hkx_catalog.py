#!/usr/bin/env python3
"""Catalog the Havok .hkx animation clips shipped in anims.bin.

The MUA2 PC port stores character animation as Havok 6.1 X-Motion files
(.hkx). Each file is a Havok "binary" class-serialization stream:

    header | ff + u32 len + __classnames__ | ff + u32 len + __types__
           | ff + u32 len + __data__

This tool reports, per clip, the Havok version, the classes it carries and
which character it belongs to (the numeric prefix of the file name is the
character's index in the game's actor table).

The keyframe data itself is Havok's *spline compressed* animation
(HK_SPLINE_COMPRESSED_ANIMATION) — a proprietary bit-packed format that
needs a Havok decoder; this tool only catalogues it.
"""
import os, sys, glob, json, struct, re
from collections import defaultdict


def parse_hkx(path):
    d = open(path, 'rb').read()
    info = {'file': os.path.basename(path), 'size': len(d)}
    # Havok version string sits right after the fixed header
    m = re.search(rb'Havok-[\d.]+(-r\d+)?\x00', d[:0x200])
    info['havok'] = m.group(0).rstrip(b'\x00').decode() if m else '?'
    # sections: 0xFF marker + u32 length
    sections = {}
    p = d.find(b'__classnames__')
    while p != -1:
        end = d.find(b'\x00', p)
        name = d[p:end].decode()
        q = end
        while q < len(d) and d[q] != 0xFF:
            q += 1
        if q + 5 > len(d):
            break
        ln = struct.unpack_from('<I', d, q + 1)[0]
        sections[name] = (q + 5, ln)
        p = d.find(b'__', q + 5)
    info['sections'] = {k: v[1] for k, v in sections.items()}
    if '__classnames__' in sections:
        off, ln = sections['__classnames__']
        blob = d[off:off + ln]
        names = [x.decode('latin1') for x in blob.split(b'\x00') if x]
        info['classes'] = names
    return info


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else 'igz_anims'
    out_json = sys.argv[2] if len(sys.argv) > 2 else 'animation_catalog.json'
    groups = defaultdict(list)
    for p in sorted(glob.glob(os.path.join(root, '*.hkx'))):
        try:
            info = parse_hkx(p)
        except Exception as e:
            info = {'file': os.path.basename(p), 'size': os.path.getsize(p),
                    'error': str(e), 'classes': []}
        base = info['file'][:-4]
        m = re.match(r'^(\d+)_(.*)$', base)
        char = m.group(2) if m else base
        info['character'] = char
        info['index'] = int(m.group(1)) if m else -1
        groups[char].append(info)
    catalog = []
    for char, clips in sorted(groups.items(), key=lambda kv: kv[1][0]['index']):
        catalog.append({
            'character': char,
            'index': clips[0]['index'],
            'clips': [{'file': c['file'], 'size': c['size'],
                       'havok': c.get('havok'),
                       'has_spline': 'hkaSplineCompressedAnimation' in c.get('classes', []),
                       'has_skeleton': 'hkaSkeleton' in c.get('classes', [])}
                      for c in clips],
        })
    json.dump({'clips': catalog}, open(out_json, 'w'), indent=1)
    total = sum(len(c['clips']) for c in catalog)
    print(f'{total} clips in {len(catalog)} groups -> {out_json}')
    for c in catalog:
        print(f"  [{c['index']:>3}] {c['character']:<28} {len(c['clips'])} clip(s)"
              f"  {sum(x['size'] for x in c['clips'])/1e6:.1f} MB")


if __name__ == '__main__':
    main()
