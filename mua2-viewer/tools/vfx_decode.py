#!/usr/bin/env python3
"""MUA2 VFX IGZ decoder: parses Alchemy v6 CFxTemplate and CFxPrimitiveTemplate structures."""
import os
import struct

IGZ_MAGIC = 0x49475A01
V6_INNER_HDR_SIZE = 28  # 0x1C

TAG_MAP = {
    0: 'TMET', 1: 'TSTR', 2: 'EXNM', 4: 'RSTT',
    5: 'RVTB', 6: 'ROFS', 7: 'REXT', 8: 'ROOT',
    9: 'ONAM', 11: 'EXID', 12: 'RHND', 13: 'MTSZ',
    14: 'NSPC', 16: 'RPID',
}

PRIM_TYPES = {
    0: 'FXPRIM_TYPE_NONE',
    1: 'FXPRIM_TYPE_EMPTY',
    2: 'FXPRIM_TYPE_PARTICLE_CLOUD',
    3: 'FXPRIM_TYPE_SPRITE',
    4: 'FXPRIM_TYPE_FLARE',
    5: 'FXPRIM_TYPE_WEATHERFX',
    6: 'FXPRIM_TYPE_ORIENTED_SPRITE',
    7: 'FXPRIM_TYPE_SPARK',
    8: 'FXPRIM_TYPE_LINE',
    9: 'FXPRIM_TYPE_LIGHTNING',
    10: 'FXPRIM_TYPE_CYLINDER',
    11: 'FXPRIM_TYPE_MODEL',
    12: 'FXPRIM_TYPE_HAVOKMODEL',
    13: 'FXPRIM_TYPE_HAVOKFORCE',
    14: 'FXPRIM_TYPE_ENTITY',
    15: 'FXPRIM_TYPE_LIGHT',
    16: 'FXPRIM_TYPE_SCREENFLASH',
    17: 'FXPRIM_TYPE_CAMERA_SHAKE',
    18: 'FXPRIM_TYPE_TRAIL',
    19: 'FXPRIM_TYPE_BEZIER',
    20: 'FXPRIM_TYPE_TEXT',
    21: 'FXPRIM_TYPE_SOUND',
    22: 'FXPRIM_TYPE_HAVOK_SPRITE',
    23: 'FXPRIM_TYPE_HDR',
    24: 'FXPRIM_TYPE_SCREEN_SPRITE',
    25: 'FXPRIM_TYPE_PARENT_RENDER',
    26: 'FXPRIM_TYPE_POST_PROCESS',
}

def decode_nibbles(data, offset, count, add_one=True):
    """Decode Alchemy delta-nibble stream into offset list."""
    res = []
    p = offset
    val = 0
    shift = 0
    data_len = len(data)
    while len(res) < count and p < data_len:
        b = data[p]
        p += 1
        for i in range(2):
            n = (b >> (i * 4)) & 0xF
            val |= ((n & 7) << shift)
            shift += 3
            if not (n & 8):
                last = res[-1] if res else 0
                res.append(last + (val + 1) * 4 if add_one else last + val * 4)
                if len(res) >= count:
                    break
                val = 0
                shift = 0
    return res

def _parse_strings(data, start, end, count):
    """Parse counted, null-terminated ASCII strings, preserving empty entries."""
    res = []
    p = start
    for _ in range(count):
        if p >= end:
            break
        try:
            np = data.index(0, p, end)
        except ValueError:
            np = end
        res.append(data[p:np].decode('ascii', errors='replace'))
        p = np + 1
    return res

def parse_igz_v6(data):
    """Parse raw bytes of an IGZ v6 file into fixup tables and chunk geometry."""
    if len(data) < 16:
        return None
    magic, ver, plat = struct.unpack_from('<3I', data, 0)
    if magic != IGZ_MAGIC:
        return None

    pos = 16
    chunks = []
    data_len = len(data)
    while pos + 16 <= data_len:
        off, size, align, ident = struct.unpack_from('<4I', data, pos)
        if off == 0:
            break
        chunks.append((off, size, align, ident))
        pos += 16

    if not chunks:
        return None

    sec0_off = chunks[0][0]
    if sec0_off + 20 > data_len:
        return None

    inner_magic, _, _, _, num_blocks = struct.unpack_from('<5I', data, sec0_off)
    if inner_magic != IGZ_MAGIC:
        return None

    pos = sec0_off + V6_INNER_HDR_SIZE
    blocks = {}
    for _ in range(num_blocks):
        if pos + 24 > data_len:
            break
        tag, u1, u2, count, total_sz, hdr_sz = struct.unpack_from('<6I', data, pos)
        name = TAG_MAP.get(tag, f'UNK_{tag}')
        blocks[name] = (count, pos + hdr_sz, pos + total_sz)
        pos += total_sz

    tstr = _parse_strings(data, blocks['TSTR'][1], blocks['TSTR'][2], blocks['TSTR'][0]) if 'TSTR' in blocks else []
    tmet = _parse_strings(data, blocks['TMET'][1], blocks['TMET'][2], blocks['TMET'][0]) if 'TMET' in blocks else []
    mtsz = []
    if 'MTSZ' in blocks:
        start, count = blocks['MTSZ'][1], blocks['MTSZ'][0]
        mtsz = [struct.unpack_from('<I', data, start + i * 4)[0] for i in range(count)]

    def get_global_offset(enc):
        if enc <= 0x7FFFFFF:
            return chunks[1][0] + enc
        idx = (enc >> 0x1B) + 1
        return chunks[idx][0] + (enc & 0x7FFFFFF) if idx < len(chunks) else enc

    rvtb = [get_global_offset(o) for o in decode_nibbles(data, blocks['RVTB'][1], blocks['RVTB'][0])] if 'RVTB' in blocks else []
    rofs = [get_global_offset(o) for o in decode_nibbles(data, blocks['ROFS'][1], blocks['ROFS'][0])] if 'ROFS' in blocks else []
    rstt = [get_global_offset(o) for o in decode_nibbles(data, blocks['RSTT'][1], blocks['RSTT'][0])] if 'RSTT' in blocks else []

    return {
        'version': ver,
        'platform': plat,
        'chunks': chunks,
        'tstr': tstr,
        'tmet': tmet,
        'mtsz': mtsz,
        'rvtb': rvtb,
        'rofs': rofs,
        'rstt': rstt,
        'get_global_offset': get_global_offset,
    }

def decode_effect_data(data, filepath=''):
    """Decode an effect file into contract-compliant definition and metadata."""
    parsed = parse_igz_v6(data)
    if not parsed:
        return None, 'error', ['invalid_igz_or_corrupt_header'], []

    tstr = parsed['tstr']
    tmet = parsed['tmet']
    mtsz = parsed['mtsz']
    rvtb = parsed['rvtb']
    rofs = parsed['rofs']
    rstt = parsed['rstt']
    get_g = parsed['get_global_offset']
    data_len = len(data)

    # Collect all texture-like strings declared in TSTR
    all_textures = []
    seen_tex = set()
    for s in tstr:
        norm = s.replace('\\', '/').strip()
        if norm.lower().endswith(('.tga', '.dds')) and norm not in seen_tex:
            seen_tex.add(norm)
            all_textures.append(norm)

    # Map global objects
    objs = {}
    for g in rvtb:
        if g + 4 > data_len:
            continue
        t_idx = struct.unpack_from('<I', data, g)[0]
        if t_idx < len(tmet):
            t_name = tmet[t_idx]
            t_sz = mtsz[t_idx] if t_idx < len(mtsz) else 0
            objs[g] = {'type': t_name, 'size': t_sz, 'g': g, 'rofs': {}, 'rstt': {}}

    for r in rofs:
        for g, obj in objs.items():
            if g <= r < g + obj['size']:
                target_enc = struct.unpack_from('<I', data, r)[0]
                target_g = get_g(target_enc) if target_enc != 0 else 0
                obj['rofs'][r - g] = target_g
                break

    for r in rstt:
        for g, obj in objs.items():
            if g <= r < g + obj['size']:
                s_idx = struct.unpack_from('<I', data, r)[0]
                if s_idx < len(tstr):
                    obj['rstt'][r - g] = tstr[s_idx]
                break

    templates = [o for o in objs.values() if o['type'] == 'CFxTemplate']
    primitives = [o for o in objs.values() if o['type'] == 'CFxPrimitiveTemplate']

    if not templates and not primitives:
        # ponytail: metadata-only status preserves all strings without inventing mock primitive trees
        return {'strings': tstr}, 'metadata-only', [], all_textures

    unsupported = []
    decoded_templates = []
    for t in templates:
        g = t['g']
        lt, rlt, pl, pid = struct.unpack_from('<ffii', data, g + 32)
        fn = t['rstt'].get(16, '')
        first_prim = t['rofs'].get(24, 0)
        decoded_templates.append({
            'fileName': fn,
            'loopTime': round(lt, 4),
            'randLoopTime': round(rlt, 4),
            'persistLoop': pl,
            'poolID': pid,
            'firstPrimitiveOffset': first_prim,
        })

    decoded_prims = []
    for p in primitives:
        g = p['g']
        if g + 1028 > data_len:
            unsupported.append(f'truncated_primitive_at_0x{g:X}')
            continue

        ptype = struct.unpack_from('<i', data, g + 920)[0]
        type_name = PRIM_TYPES.get(ptype)
        if type_name is None:
            type_name = f'FXPRIM_TYPE_UNKNOWN_{ptype}'
            unsupported.append(f'unknown_primitive_type_{ptype}')

        delay, count, life, drag, grav, r1, r2, h, drag2, grav2, p_travel, p_spawn, sv1, sv2, sv3 = struct.unpack_from(
            '<15f', data, g + 752
        )
        rq_size = [round(x, 4) for x in struct.unpack_from('<5f', data, g + 16)]
        rq_alpha = [round(x, 4) for x in struct.unpack_from('<5f', data, g + 48)]
        rq_length = [round(x, 4) for x in struct.unpack_from('<5f', data, g + 80)]
        shake_speed, shake_scale = struct.unpack_from('<2f', data, g + 1016)
        shake_type = struct.unpack_from('<i', data, g + 1024)[0]
        shader_name = p['rstt'].get(1064) or None
        f1, f2, sf = struct.unpack_from('<3I', data, g + 936)
        c_start1, c_mid1, c_end1, c_start2, c_mid2, c_end2 = struct.unpack_from('<6I', data, g + 984)
        bmode = struct.unpack_from('<i', data, g + 1008)[0]

        lut = p['rstt'].get(1136)
        shader_texs = [
            p['rstt'][off].replace('\\', '/')
            for off in (1168, 1176, 1184, 1192, 1200, 1208)
            if off in p['rstt'] and p['rstt'][off].lower().endswith(('.tga', '.dds'))
        ]
        other_texs = [
            s.replace('\\', '/')
            for off, s in p['rstt'].items()
            if off not in (1136, 1168, 1176, 1184, 1192, 1200, 1208)
            and s.lower().endswith(('.tga', '.dds'))
        ]
        model_ref = None
        for off, s in p['rstt'].items():
            if s.lower().endswith(('.igb', '.igz')):
                model_ref = s.replace('\\', '/')
                break

        sound_bank = None
        sound_name = None
        if ptype == 21:  # FXPRIM_TYPE_SOUND
            sb = p['rstt'].get(1184)
            sn = p['rstt'].get(1192)
            sound_bank = sb.replace('\\', '/') if sb else None
            sound_name = sn.replace('\\', '/') if sn else None

        # --- tail slots (offsets 872..1128) ---------------------------------
        # The first decoder pass stopped at the shake struct (+1028) and dropped
        # everything after it. These offsets are object/string references that
        # the engine used to chain effects and to drive mesh/havok behaviour;
        # they are emitted only when the file actually carries them so the
        # schema stays identical for primitives that have none.
        #   +872  ROFS -> CFxParentRender (render parent)
        #   +952  RSTT -> spawned sub-effect (primary)
        #   +960  RSTT -> spawned sub-effect (secondary: impact/trail)
        #   +1032 RSTT -> effect set / combat bank name
        #   +1040 ROFS -> CFxMeshPrimitiveAnimationDataList
        #   +1072..+1112 RSTT -> distortion/decal/mask texture slots
        #   +1120 ROFS -> CHavokRigidBodyInfo
        #   +1128 ROFS -> CHavokForceInfo
        child_effects = []
        for off in (952, 960):
            ref = p['rstt'].get(off)
            if ref and ref.strip():
                ref = ref.replace('\\', '/')
                if ref not in child_effects:
                    child_effects.append(ref)
        effect_set = (p['rstt'].get(1032) or '').replace('\\', '/').strip() or None
        mask_textures = [
            p['rstt'][off].replace('\\', '/')
            for off in (1072, 1080, 1088, 1096, 1104, 1112)
            if p['rstt'].get(off) and p['rstt'][off].lower().endswith(('.tga', '.dds'))
        ]
        havok = {}
        if p['rofs'].get(1120):
            havok['rigidBodyOffset'] = p['rofs'][1120]
        if p['rofs'].get(1128):
            havok['forceOffset'] = p['rofs'][1128]

        tail = {}
        if p['rofs'].get(872):
            tail['parentRenderOffset'] = p['rofs'][872]
        if child_effects:
            tail['childEffects'] = child_effects
        if effect_set:
            tail['effectSet'] = effect_set
        if p['rofs'].get(1040):
            tail['animationDataOffset'] = p['rofs'][1040]
        if mask_textures:
            tail['maskTextures'] = mask_textures
        if havok:
            tail['havok'] = havok

        for tex in mask_textures:
            if tex not in seen_tex:
                seen_tex.add(tex)
                all_textures.append(tex)

        # Also add any primitive textures to all_textures
        for tex in shader_texs + other_texs:
            if tex not in seen_tex:
                seen_tex.add(tex)
                all_textures.append(tex)

        decoded_prims.append({
            'type': ptype,
            'typeName': type_name,
            'delay': round(delay, 4),
            'count': round(count, 4),
            'life': round(life, 4),
            'drag': round(drag, 4),
            'gravity': round(grav, 4),
            'radius': round(r1, 4),
            'radius2': round(r2, 4),
            'height': round(h, 4),
            'drag2': round(drag2, 4),
            'gravity2': round(grav2, 4),
            'particleTravelTime': round(p_travel, 4),
            'particleSpawnTime': round(p_spawn, 4),
            'scrollVelocity': [round(sv1, 4), round(sv2, 4), round(sv3, 4)],
            'flags': {
                'primitive': f'0x{f1:08x}',
                'primitive2': f'0x{f2:08x}',
                'spawn': f'0x{sf:08x}',
            },
            'colors': {
                'start1': f'0x{c_start1:08x}', 'mid1': f'0x{c_mid1:08x}', 'end1': f'0x{c_end1:08x}',
                'start2': f'0x{c_start2:08x}', 'mid2': f'0x{c_mid2:08x}', 'end2': f'0x{c_end2:08x}',
            },
            'rqSize': rq_size,
            'rqAlpha': rq_alpha,
            'rqLength': rq_length,
            'shakeSpeed': round(shake_speed, 4),
            'shakeScale': round(shake_scale, 4),
            'shakeType': shake_type,
            'shaderName': shader_name,
            'soundBank': sound_bank,
            'soundName': sound_name,
            'blendMode': bmode,
            'lut': lut,
            'shaderTextures': shader_texs,
            'otherTextures': other_texs,
            'modelRef': model_ref,
            'nextPrimitiveOffset': p['rofs'].get(928, 0),
            **tail,
        })

    definition = {
        'templates': decoded_templates,
        'primitives': decoded_prims,
    }

    status = 'decoded' if decoded_templates and decoded_prims else 'partial'
    return definition, status, unsupported, all_textures

def decode_effect_file(path):
    """Convenience helper reading filepath and decoding."""
    with open(path, 'rb') as f:
        return decode_effect_data(f.read(), filepath=path)

if __name__ == '__main__':
    import sys
    target = sys.argv[1] if len(sys.argv) > 1 else '_work/igz_effects/char/spiderman/spiderman_blocking.igz'
    defn, stat, unsup, texs = decode_effect_file(target)
    print(f'File: {target}')
    print(f'Status: {stat}, Unsupported: {unsup}')
    print(f'Textures ({len(texs)}): {texs}')
    if defn and 'templates' in defn:
        print(f'Templates: {len(defn["templates"])}, Primitives: {len(defn["primitives"])}')
