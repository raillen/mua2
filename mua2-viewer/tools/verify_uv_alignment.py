#!/usr/bin/env python3
"""Find the UV offset that best aligns a mesh's UV islands with the texture art."""
import sys, os, json
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import maximum_filter, minimum_filter

sys.path.insert(0, os.environ.get('IGB_PKG', '/tmp/opencode/igb_pkg'))
sys.path.insert(0, '/tmp/opencode')
from igb_blender.igz_format.igz_reader import IGZReader
from igb_blender.igz_format.igz_geometry import IGZDataAllocator, _get_attr_list
from mua2_glb import dxt1, dxt5

WORK = os.environ.get('MUA2_WORK', '/home/raillen/Documentos/decomp-games/_work')
IDX = json.load(open(f'{WORK}/texture_index.json'))


def tf(n):
    for k, v in IDX.items():
        if v['file'].endswith('/' + n):
            return v


def geom(actor, gi):
    r = IGZReader(f'{WORK}/igz_actors/{actor}.igz'); r.read()
    al = IGZDataAllocator(r)
    ga = [a for a in _get_attr_list(r, r.get_objects_by_type('igGeometry')[gi])
          if a.type_name == 'igGeometryAttr'][0]
    vb = ga.get_ref(0x18); ib = ga.get_ref(0x20)
    base = al.get_data_offset(vb); stride = vb.get_ref(0x30).read_u32(0x10)
    nv = vb.read_u32(0x10)
    V = np.frombuffer(r.data, dtype='<f4', count=nv * stride // 4,
                      offset=base).reshape(nv, stride // 4)
    ibase = al.get_data_offset(ib); ni = ib.read_u32(0x10)
    I = np.frombuffer(r.data, dtype='<u2', count=ni, offset=ibase).reshape(-1, 3)
    return V[:, 6:8], I


def art_mask(info):
    raw = open(info['file'], 'rb').read()[info['data_off']:]
    W, H = info['width'], info['height']
    img = np.array(Image.fromarray(dxt1(raw, W, H) if info['format'] == 'DXT1'
                                   else dxt5(raw, W, H), 'RGB')).astype(np.int16)
    painted = (maximum_filter(img.max(2), 3) - minimum_filter(img.min(2), 3)) > 10
    return painted, W, H


def island_mask(uv, I, W, H):
    m = Image.new('L', (W, H), 0); dr = ImageDraw.Draw(m)
    for t in I:
        pts = [(float(uv[i, 0]) * W, float(uv[i, 1]) * H) for i in t]
        if max(p[0] for p in pts) < 0 or min(p[0] for p in pts) > W: continue
        if max(p[1] for p in pts) < 0 or min(p[1] for p in pts) > H: continue
        dr.polygon(pts, fill=255)
    return np.array(m) > 0


def best_offset(actor, gi, texname, rng_tex=192, step=8):
    uv, I = geom(actor, gi)
    painted, W, H = art_mask(tf(texname))
    isl = island_mask(uv, I, W, H)
    best = (-1, 0, 0)
    for dy in range(-rng_tex, rng_tex + 1, step):
        for dx in range(-rng_tex, rng_tex + 1, step):
            shifted = np.roll(np.roll(isl, dy, axis=0), dx, axis=1)
            inter = (shifted & painted).sum()
            score = inter / max(isl.sum(), 1)
            if score > best[0]:
                best = (score, dx, dy)
    return best, (W, H)


if __name__ == '__main__':
    actor = sys.argv[1]; gi = int(sys.argv[2]); tex = sys.argv[3]
    (score, dx, dy), (W, H) = best_offset(actor, gi, tex)
    print(f'{actor} geom{gi} {tex}: best overlap {score:.3f} at offset dx={dx} dy={dy} texels '
          f'(= du {dx/W:+.4f}, dv {dy/H:+.4f} in UV)')
