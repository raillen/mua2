#!/usr/bin/env python3
"""Export a MUA2 PC actor IGZ (Alchemy 6) to glTF 2.0 GLB with textures.

Scene layout (verified on actors.bin files):
  igGroup -> igAttrSet (material + 3 texture binds) -> igBlendMatrixSelect -> igGeometry -> igGeometryAttr
Texture bind units: 0=diffuse, 1=normal, 2=specular, 3=cubemap, 4=mask.
"""
import sys, os, json, struct, math, io, argparse
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, label

sys.path.insert(0, '/tmp/opencode/igb_pkg')
from igb_blender.igz_format.igz_reader import IGZReader
from igb_blender.igz_format.igz_geometry import (IGZDataAllocator, extract_igz_geometry,
                                                 _get_attr_list, _get_child_list)
from mua2_skeleton import parse_skeleton, bone_local_transforms

TEX_INDEX = json.load(open('/home/raillen/Documentos/decomp-games/_work/texture_index.json'))


def find_texture(h):
    return TEX_INDEX.get(f'{h:016x}')


# ---------- DXT decoders ----------

def rgb565(c):
    return np.array([((c >> 11) & 31) * 255 // 31,
                     ((c >> 5) & 63) * 255 // 63,
                     (c & 31) * 255 // 31], dtype=np.uint8)


def dxt1(data, w, h, four_color=True):
    """DXT1 decode. MUA2 diffuses are opaque, encoded 4-color even when
    c0<=c1, so four_color=True (no cutout) matches the game. Standard
    1-bit alpha path kept for effect textures that need it."""
    out = np.zeros((h, w, 3), np.uint8)
    off = 0
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            c0, c1, bits = struct.unpack_from('<HHI', data, off); off += 8
            a, b = rgb565(c0), rgb565(c1)
            if four_color or c0 > c1:
                cols = [a, b, (2 * a.astype(int) + b) // 3, (a + 2 * b.astype(int)) // 3]
            else:
                cols = [a, b, (a.astype(int) + b) // 2, np.zeros(3, np.uint8)]
            for y in range(4):
                for x in range(4):
                    if by + y < h and bx + x < w:
                        out[by + y, bx + x] = cols[(bits >> (2 * (y * 4 + x))) & 3]
    return out


def dxt5(data, w, h):
    out = np.zeros((h, w, 4), np.uint8)
    off = 0
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            a0, a1 = struct.unpack_from('<BB', data, off)
            abits = int.from_bytes(data[off + 2:off + 8], 'little'); off += 8
            c0, c1, bits = struct.unpack_from('<HHI', data, off); off += 8
            alphas = [a0, a1]
            if a0 > a1:
                alphas += [((7 - i) * a0 + i * a1) // 7 for i in range(1, 7)]
            else:
                alphas += [((5 - i) * a0 + i * a1) // 5 for i in range(1, 5)] + [0, 255]
            a, b = rgb565(c0), rgb565(c1)
            cols = [a, b, (2 * a.astype(int) + b) // 3, (a + 2 * b.astype(int)) // 3]
            for y in range(4):
                for x in range(4):
                    if by + y < h and bx + x < w:
                        out[by + y, bx + x, :3] = cols[(bits >> (2 * (y * 4 + x))) & 3]
                        out[by + y, bx + x, 3] = alphas[(abits >> (3 * (y * 4 + x))) & 7]
    return out


def ati2(data, w, h, invert_g=False):
    out = np.zeros((h, w, 4), np.uint8)
    off = 0
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            chans = []
            for ch in range(2):
                a0, a1 = struct.unpack_from('<BB', data, off)
                abits = int.from_bytes(data[off + 2:off + 8], 'little'); off += 8
                al = [a0, a1]
                if a0 > a1:
                    al += [((7 - i) * a0 + i * a1) // 7 for i in range(1, 7)]
                else:
                    al += [((5 - i) * a0 + i * a1) // 5 for i in range(1, 5)] + [0, 255]
                vals = np.array([al[(abits >> (3 * (y * 4 + x))) & 7]
                                 for y in range(4) for x in range(4)], np.uint8).reshape(4, 4)
                chans.append(vals)
            r, g = chans
            for y in range(4):
                for x in range(4):
                    if by + y < h and bx + x < w:
                        R = r[y, x] / 255.0
                        G = g[y, x] / 255.0
                        if invert_g:
                            G = 1.0 - G
                        B = max(0.0, 1.0 - R * R - G * G) ** 0.5
                        out[by + y, bx + x] = [r[y, x], int(G * 255), int(B * 255), 255]
    return out


# Atlas background is a flat grey ~[90,89,90]. Detect by distance to it,
# not by a broad brightness window (which eats real grey costume parts).
BG_COLOR = np.array([90, 89, 90], dtype=np.int16)


def inpaint_background(img):
    """Fill the atlas background connected to the image border with the nearest painted color.

    RGBA-aware: transparent texels (DXT1 1-bit alpha) keep alpha 0 but get
    their RGB filled from the nearest opaque texel to avoid black fringes.
    """
    has_alpha = img.mode == 'RGBA'
    alpha = np.array(img.getchannel('A')) if has_alpha else None
    a = np.array(img.convert('RGB')).astype(np.int16)
    mx = a.max(2); mn = a.min(2)
    dist = np.sqrt(((a - BG_COLOR) ** 2).sum(2))
    opaque = (alpha > 128) if has_alpha else np.ones(a.shape[:2], bool)
    # DXT spreads the flat background over ~[82..92]; catch it all, but
    # require low saturation so real costume colors survive.
    mask = (dist < 30) & ((mx - mn) < 16) & opaque
    # Fill ALL background (interior gaps between UV islands too): at
    # minification the grey padding bleeds over painted texels via
    # mipmaps, producing the grey patches seen in renders.
    painted = opaque & ~mask
    if mask.any() and painted.any():
        ind = distance_transform_edt(~painted, return_distances=False, return_indices=True)
        out = a.copy()
        out[mask] = a[ind[0][mask], ind[1][mask]]
        a = out
    if has_alpha:
        # Fill RGB of transparent texels from nearest opaque texel (keep alpha 0)
        trans = ~opaque
        if trans.any() and opaque.any():
            ind = distance_transform_edt(~opaque, return_distances=False, return_indices=True)
            a[trans] = a[ind[0][trans], ind[1][trans]]
        out_img = np.dstack([a.astype(np.uint8), alpha])
        return Image.fromarray(out_img, 'RGBA')
    return Image.fromarray(a.astype(np.uint8), 'RGB')


def decode_texture(info, kind, invert_green=True):
    """Decode a texture IGZ to PIL Image.

    invert_green: MUA2 normal maps are DirectX-style (Y-); glTF/three.js
    expects OpenGL-style (Y+), so the green channel is flipped at bake
    time. Applies to ATI2/BC5 and DXT5 normals.
    UVs are used as-is (no V-flip): the renders show correct part-to-UV
    mapping (mask eyes on face, emblem on chest), so a flip would break it.
    """
    raw = open(info['file'], 'rb').read()
    data = raw[info['data_off']:]
    w, h, fmt = info['width'], info['height'], info['format']
    if kind == 'd':
        if fmt == 'DXT1':
            return inpaint_background(Image.fromarray(dxt1(data, w, h, four_color=True), 'RGB'))
        if fmt == 'DXT5':
            img = Image.fromarray(dxt5(data, w, h), 'RGBA')
            # Only inpaint when there is no real transparency
            a = np.array(img.getchannel('A'))
            if (a < 128).mean() < 0.01:
                return inpaint_background(img.convert('RGB'))
            return img
        if fmt == 'BGRA8':
            arr = np.frombuffer(data[:w * h * 4], np.uint8).reshape(h, w, 4)[:, :, [2, 1, 0, 3]]
            return Image.fromarray(arr, 'RGBA')
    if kind == 'n':
        if fmt == 'ATI2':
            return Image.fromarray(ati2(data, w, h, invert_g=invert_green), 'RGBA')
        if fmt == 'DXT5':
            arr = np.array(Image.fromarray(dxt5(data, w, h), 'RGBA'))
            if invert_green:
                arr[..., 1] = 255 - arr[..., 1]
            return Image.fromarray(arr, 'RGBA')
    if kind == 's':
        if fmt == 'DXT1':
            return Image.fromarray(dxt1(data, w, h, four_color=True), 'RGB')
        if fmt == 'DXT5':
            return Image.fromarray(dxt5(data, w, h), 'RGBA')
    return None


# ---------- Scene walking ----------

def texture_binds(reader, attrset):
    """Return {unit: texture_info} for an igAttrSet."""
    out = {}
    for a in _get_attr_list(reader, attrset):
        if a.type_name != 'igTextureBindAttr2':
            continue
        unit = struct.unpack_from('<Q', a.raw_data, 0x10)[0] & 0xffff
        ta = a.get_ref(0x18)
        if ta is None:
            continue
        h = struct.unpack_from('<Q', ta.raw_data, 0x48)[0]
        info = find_texture(h)
        if info:
            out[unit] = info
    return out


def geom_from_node(reader, alloc, node):
    attrs = _get_attr_list(reader, node)
    ga = next((a for a in attrs if a.type_name == 'igGeometryAttr'), None)
    if ga is None:
        return None
    return extract_igz_geometry(reader, ga, alloc)


def walk_character(reader, alloc):
    """Return list of (geometry, texture_info_by_unit)."""
    results = []
    seen = set()

    def add_geom(geom_node, tex):
        if geom_node.global_offset in seen:
            return
        g = geom_from_node(reader, alloc, geom_node)
        if g and g.positions and g.indices:
            seen.add(geom_node.global_offset)
            results.append((g, tex))

    def collect_from_attrset(attrset, tex):
        for child in _get_child_list(reader, attrset):
            if child.type_name == 'igGeometry':
                add_geom(child, tex)
            elif child.type_name == 'igBlendMatrixSelect':
                for geom_node in _get_child_list(reader, child):
                    if geom_node.type_name == 'igGeometry':
                        add_geom(geom_node, tex)

    groups = reader.get_objects_by_type('igGroup')
    if groups:
        for attrset in _get_child_list(reader, groups[0]):
            if attrset.type_name != 'igAttrSet':
                continue
            collect_from_attrset(attrset, texture_binds(reader, attrset))
    # Fallback for actors without igGroup (props, enemies, heads):
    # walk every igAttrSet directly.
    if not results:
        for attrset in reader.get_objects_by_type('igAttrSet'):
            collect_from_attrset(attrset, texture_binds(reader, attrset))
    return results


# ---------- glTF building ----------

class Buffer:
    def __init__(self):
        self.data = bytearray()
        self.views = []

    def add(self, blob, target=None):
        while len(self.data) % 4:
            self.data.append(0)
        off = len(self.data)
        self.data += blob
        bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(blob)}
        if target is not None:
            bv['target'] = target
        self.views.append(bv)
        return len(self.views) - 1, off


def png_bytes(img):
    bio = io.BytesIO()
    img.save(bio, format='PNG')
    return bio.getvalue()


def export_glb(actor_path, out_path, name, invert_green=True, use_spec=False, max_texture=0,
               skeleton=True):
    reader = IGZReader(actor_path); reader.read()
    alloc = IGZDataAllocator(reader)
    parts = walk_character(reader, alloc)
    if not parts:
        raise SystemExit('no geometry found')

    # --- skeleton (optional) ---
    bones, ibms, ibm_flat = ([], [], [])
    if skeleton:
        try:
            bones, ibms, ibm_flat = parse_skeleton(reader)
        except Exception as e:
            print(f'  skeleton parse failed: {e}', file=sys.stderr)
            bones, ibms, ibm_flat = [], [], []

    # Vertices stay in the original (Z-up) space; a root node carries the
    # Y-up + centre + scale transform so the rig and the mesh stay aligned.
    all_pos = []
    for g, tex in parts:
        all_pos.extend(g.positions)
    all_pos = np.array(all_pos, np.float32)
    yup = np.stack([all_pos[:, 0], all_pos[:, 2], -all_pos[:, 1]], axis=1)
    lo, hi = yup.min(0), yup.max(0)
    scale = 2.0 / max(hi - lo)
    # final = T * R * S * p  =>  T = -s * c   (c = centre of the rotated bounds)
    centre = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], np.float64)
    root_translation = -scale * centre
    # rotation Z-up -> Y-up  (RotX(-90): (x,y,z) -> (x,z,-y))
    root_rotation = np.array([-0.7071067811865476, 0.0, 0.0, 0.7071067811865476], np.float64)

    buf = Buffer()
    accessors = []
    meshes = []
    materials = []
    textures = []
    images = []
    samplers = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    mat_cache = {}
    tex_alpha = {}

    def add_accessor(array, comp_type, type_str, count, target, minmax=False):
        blob = array.tobytes()
        bv, _ = buf.add(blob, target)
        acc = {'bufferView': bv, 'componentType': comp_type, 'count': count, 'type': type_str}
        if minmax:
            acc['min'] = array.min(0).tolist()
            acc['max'] = array.max(0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    def add_image(img):
        if max_texture and max(img.size) > max_texture:
            img = img.copy()
            img.thumbnail((max_texture, max_texture), Image.LANCZOS)
        blob = png_bytes(img)
        bv, _ = buf.add(blob)
        images.append({'bufferView': bv, 'mimeType': 'image/png'})
        return len(images) - 1

    def get_texture(info, kind):
        key = (info['file'], kind)
        if key in mat_cache:
            return mat_cache[key]
        img = decode_texture(info, kind, invert_green=invert_green)
        if img is None:
            return None
        has_alpha = img.mode == 'RGBA' and (np.array(img.getchannel('A')) < 128).any()
        ii = add_image(img)
        textures.append({'source': ii, 'sampler': 0})
        mat_cache[key] = len(textures) - 1
        if has_alpha:
            tex_alpha[len(textures) - 1] = True
        return mat_cache[key]

    for gi, (g, tex) in enumerate(parts):
        pos = np.array(g.positions, np.float32)
        if g.normals:
            nrm = np.array(g.normals, np.float32)
            ln = np.linalg.norm(nrm, axis=1, keepdims=True)
            nrm = nrm / np.maximum(ln, 1e-8)
        else:
            nrm = np.zeros_like(pos)
        uv = np.array(g.uvs, np.float32) if g.uvs else np.zeros((len(pos), 2), np.float32)
        idx = np.array(g.indices, np.uint32)

        a_pos = add_accessor(pos, 5126, 'VEC3', len(pos), 34962, True)
        a_nrm = add_accessor(nrm, 5126, 'VEC3', len(nrm), 34962)
        a_uv = add_accessor(uv, 5126, 'VEC2', len(uv), 34962)
        a_idx = add_accessor(idx, 5125, 'SCALAR', len(idx), 34963)
        attrs = {'POSITION': a_pos, 'NORMAL': a_nrm, 'TEXCOORD_0': a_uv}

        # skinning
        if bones and g.blend_indices and g.blend_weights:
            joints = np.array(g.blend_indices, np.uint16)
            weights = np.array(g.blend_weights, np.float32)
            attrs['JOINTS_0'] = add_accessor(joints, 5123, 'VEC4', len(joints), 34962)
            attrs['WEIGHTS_0'] = add_accessor(weights, 5126, 'VEC4', len(weights), 34962)

        mat = {'name': f'{name}_{gi}', 'pbrMetallicRoughness': {
            'metallicFactor': 0.0, 'roughnessFactor': 0.75}}
        tex_d = get_texture(tex[0], 'd') if 0 in tex else None
        tex_n = get_texture(tex[1], 'n') if 1 in tex else None
        if tex_d is not None:
            mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': tex_d}
            if tex_alpha.get(tex_d):
                mat['alphaMode'] = 'MASK'
                mat['alphaCutoff'] = 0.5
        if tex_n is not None:
            mat['normalTexture'] = {'index': tex_n}
        if use_spec and 2 in tex:
            tex_s = get_texture(tex[2], 's')
            if tex_s is not None:
                mat['pbrMetallicRoughness']['metallicRoughnessTexture'] = {'index': tex_s}
                mat['pbrMetallicRoughness']['metallicFactor'] = 1.0
        mat['doubleSided'] = True
        materials.append(mat)
        meshes.append({'name': f'{name}_{gi}', 'primitives': [{
            'attributes': attrs, 'indices': a_idx, 'material': len(materials) - 1}]})

    # ---- node graph: root transform -> skeleton joints + mesh nodes ----
    nodes = []
    skin = None
    if bones:
        trs = bone_local_transforms(bones, ibms)
        root_node = {'name': f'{name}_root', 'children': []}
        nodes.append(root_node)
        root_idx = 0
        joint_nodes = []
        for i, b in enumerate(bones):
            t, q, s = trs[i]
            node = {
                'name': b['name'],
                'translation': [float(x) for x in t],
                'rotation': [float(x) for x in q],
                'scale': [float(x) for x in s],
            }
            nodes.append(node)
            joint_nodes.append(len(nodes) - 1)
        # hierarchy
        for i, b in enumerate(bones):
            if 0 <= b['parent'] < len(bones):
                nodes[joint_nodes[b['parent']]].setdefault('children', []).append(joint_nodes[i])
            else:
                root_node['children'].append(joint_nodes[i])
        # mesh nodes as children of the root node
        for i, m in enumerate(meshes):
            nodes.append({'name': m['name'], 'mesh': i, 'skin': 0})
            root_node['children'].append(len(nodes) - 1)
        # skin: inverseBindMatrices must be ordered by JOINT index, while the
        # file stores them indexed by each bone's blendMatrixIndex.
        ibm_rows = []
        for b in bones:
            blend = b['blend']
            if 0 <= blend < len(ibm_flat):
                ibm_rows.append(ibm_flat[blend])
            else:
                ibm_rows.append(np.array([1, 0, 0, 0, 0, 1, 0, 0,
                                          0, 0, 1, 0, 0, 0, 0, 1], np.float32))
        ibm = np.array(ibm_rows, np.float32)
        a_ibm = add_accessor(ibm, 5126, 'MAT4', len(ibm), None)
        skin = {'joints': joint_nodes, 'skeleton': joint_nodes[0]}
        if a_ibm is not None:
            skin['inverseBindMatrices'] = a_ibm
    else:
        for i, m in enumerate(meshes):
            nodes.append({'name': m['name'], 'mesh': i})
        root_idx = None

    # the root node carries the Z-up -> Y-up + centre + scale transform
    if bones:
        nodes[0]['translation'] = [float(x) for x in root_translation]
        nodes[0]['rotation'] = [float(x) for x in root_rotation]
        nodes[0]['scale'] = [float(scale)] * 3
        scene_nodes = [0]
    else:
        # no rig: bake the transform into the vertices (as before)
        for i, m in enumerate(meshes):
            pr = m['primitives'][0]
            acc = accessors[pr['attributes']['POSITION']]
            bv = buf.views[acc['bufferView']]
            arr = np.frombuffer(buf.data, np.float32, count=acc['count'] * 3,
                                offset=bv['byteOffset']).reshape(-1, 3)
            arr = np.stack([arr[:, 0], arr[:, 2], -arr[:, 1]], 1)
            arr = (arr - np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2],
                                  np.float32)) * scale
            buf.data[bv['byteOffset']:bv['byteOffset'] + arr.nbytes] = arr.tobytes()
        scene_nodes = list(range(len(meshes)))

    gltf = {
        'asset': {'version': '2.0', 'generator': 'MUA2 Alchemy IGZ extractor'},
        'scene': 0,
        'scenes': [{'nodes': scene_nodes}],
        'nodes': nodes,
        'meshes': meshes,
        'materials': materials,
        'textures': textures,
        'images': images,
        'samplers': samplers,
        'accessors': accessors,
        'bufferViews': buf.views,
        'buffers': [{'byteLength': len(buf.data)}],
    }
    if skin is not None:
        gltf['skins'] = [skin]

    json_bytes = json.dumps(gltf, separators=(',', ':')).encode()
    while len(json_bytes) % 4:
        json_bytes += b' '
    bin_bytes = bytes(buf.data)
    while len(bin_bytes) % 4:
        bin_bytes += b'\0'
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    with open(out_path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A)); f.write(json_bytes)
        f.write(struct.pack('<II', len(bin_bytes), 0x004E4942)); f.write(bin_bytes)
    return {'name': name, 'actor': os.path.basename(actor_path), 'parts': len(parts),
            'verts': sum(len(g.positions) for g, _ in parts),
            'tris': sum(len(g.indices) // 3 for g, _ in parts),
            'textures': len(images), 'size': total}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('actor')
    ap.add_argument('out')
    ap.add_argument('name')
    ap.add_argument('--invert-green', dest='invert_green', action='store_true')
    ap.add_argument('--no-invert-green', dest='invert_green', action='store_false')
    ap.set_defaults(invert_green=True)
    ap.add_argument('--spec', action='store_true')
    ap.add_argument('--max-texture', type=int, default=0)
    args = ap.parse_args()
    info = export_glb(args.actor, args.out, args.name, args.invert_green, args.spec, args.max_texture)
    print(json.dumps(info, indent=1))
