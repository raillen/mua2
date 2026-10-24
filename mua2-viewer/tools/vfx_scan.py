#!/usr/bin/env python3
"""Scan all MUA2 VFX IGZ files, decompile templates, export preview textures, and build effects catalog."""
import glob
import json
import os
import struct
import sys
import time
import numpy as np
from PIL import Image

# Import our robust tag-based v6 decoder
from vfx_decode import decode_effect_data, PRIM_TYPES

WORK_ROOT = os.path.abspath('_work')
EFFECTS_DIR = os.path.join(WORK_ROOT, 'igz_effects')
TEX_INDEX_PATH = os.path.join(WORK_ROOT, 'texture_index.json')
MODELS_CATALOG = os.path.abspath('mua2-viewer/assets/models/models.json')
OUT_DIR = os.path.abspath('mua2-viewer/assets/vfx')
OUT_TEX_DIR = os.path.join(OUT_DIR, 'textures')
OUT_CATALOG = os.path.join(OUT_DIR, 'effects.json')

CHAR_MAP = {
    'abomb': ['a_bomb_anti_1'],
    'bishop': ['bishop_pro_2'],
    'blackpanther': ['blackpanther', 'blackpanther_pro_1', 'blackpanther_alt_1'],
    'blackpantherhero': ['blackpanther', 'blackpanther_pro_1', 'blackpanther_alt_1'],
    'bphero': ['blackpanther', 'blackpanther_pro_1', 'blackpanther_alt_1'],
    'blackwidow': ['blackwidow_pro_1'],
    'bullseye': ['bullseye_pro_1'],
    'cable': ['cable', 'cable_alt', 'cable_anti_1'],
    'cablehero': ['cable', 'cable_alt', 'cable_anti_1'],
    'captainamerica': ['captainamerica', 'captainamerica_alt'],
    'carnage': ['carnage_anti_1', 'carnage_alt_1'],
    'colossus': ['colossus'],
    'coonspawn': [],
    'dagger': ['dagger_anti_1'],
    'daredevil': ['daredevil', 'daredevil_alt', 'daredevil_baton', 'daredevil_anti_1'],
    'deadpool': ['deadpool', 'deadpool_alt'],
    'diamondback': ['diamondback_pro_1'],
    'electro': ['electro_anti_1'],
    'equinox': ['equinox_anti_1'],
    'firestar': ['firestar_anti_1'],
    'fury': ['nickfury', 'nickfury_nanite_anti_1', 'nickfury_anti_1'],
    'gambit': ['gambit', 'gambit_alt', 'fxt_playingcardfront', 'gambit_pro_staff'],
    'goliath': ['goliath'],
    'greengoblin': ['greengoblin', 'greengoblin_alt'],
    'grenade': [],
    'grimreaper': ['grimreaper_pro_1'],
    'havok': ['havok_pro_1'],
    'hawk': [],
    'herc': ['hercules'],
    'hulk': ['hulk', 'hulk_alt'],
    'humantorch': ['humantorch', 'humantorch_alt', 'humantorch_flame'],
    'iceman': ['iceman', 'iceman_alt'],
    'inmate': ['nanite_inmate_anti_1', 'superhumaninmateheavy_anti_2', 'superhumaninmate_basic_anti_2', 'escapedprisonerheavy1_anti_1'],
    'invisiblewoman': ['invisiblewoman', 'invisiblewoman_alt'],
    'ironfist': ['ironfist_anti_1', 'ironfist_alt_1'],
    'ironman': ['ironman', 'ironman_alt', 'ironman_pro_1'],
    'jackolantern': ['jackolantern_pro_1'],
    'jeangrey': ['jeangrey', 'jeangrey_alt'],
    'juggernaut': ['juggernaut_pro_1', 'juggernaut_alt_2'],
    'justice': ['justice_pro_1'],
    'krang': [],
    'ladydeathstrike': ['ladydeathstrike_pro_1'],
    'latverian_android_claw': ['latverianrobot_pro_1'],
    'latverian_cyborg': ['latveriancyborg_blade_pro_1', 'latveriancyborg_rocket_pro_1', 'latveriancyborg_shocker_pro_1'],
    'lukecage': ['lukecage', 'lukecage_alt', 'lukecage_2'],
    'lukecageminiboss': ['lukecage', 'lukecage_alt', 'lukecage_2'],
    'magneto': ['magneto', 'magneto_alt'],
    'minion': [],
    'moltenman': ['moltenman_anti_1'],
    'moonstone': ['moonstone_pro_1'],
    'mrfantastic': ['mrfantastic', 'mrfantastic_alt', 'mrfantastic_pro_2', 'mrfantastic_pro_2_2'],
    'msmarvel': ['msmarvel', 'msmarvel_alt'],
    'multipleman': ['multipleman_anti_1', 'multipleman_anti_1b'],
    'nanite': [],
    'naniteexp': [],
    'nanitenickfury': ['nickfury_nanite_anti_1'],
    'nickfury': ['nickfury', 'nickfury_nanite_anti_1', 'nickfury_anti_1'],
    'nickfuryhero': ['nickfury', 'nickfury_nanite_anti_1', 'nickfury_anti_1'],
    'patriot': ['patriot_anti_1'],
    'penance': ['penance_pro_1', 'penance_alt_1'],
    'prodigy': ['prodigy_pro_1'],
    'psylocke': ['psylocke', 'psylocke_alt'],
    'robotbomber': [],
    'robotlarge': [],
    'scorcher': ['scorcher_anti_1'],
    'shared': [],
    'sharedfusion': [],
    'shehulk': ['shehulk'],
    'shield': ['shieldandroid_heavy_pro', 'shieldmedium_pro_1', 'shieldmedium_pro_1_2', 'shieldandroid_pro_1'],
    'shocker': ['shocker_anti_1'],
    'songbird': ['songbird_pro_2', 'songbird_alt_1'],
    'spiderman': ['spiderman', 'spiderman_alt', 'spiderman_alt_3', 'fxt_webbing02'],
    'spidwm': ['spiderwoman_pro_1', 'spiderwoman_pro_2'],
    'storm': ['storm', 'storm_alt'],
    'thing': ['thething', 'thething_alt'],
    'thor': ['thor', 'thor_alt'],
    'tinkerer': ['tinkerer_anti_2', 'tinkererwalker_01', 'tinkerer_anti_head_1'],
    'tinkerertankbot': ['tinkererwalker_01', 'tinkererwalker_01_2'],
    'titaniumman': ['titaniumman_pro_1'],
    'vanbardos': ['luciavonbardas_pro_1', 'luciavonbardas_cyborg_pro_1'],
    'venom': ['venom', 'venom_alt', 'venom_pro_tongue'],
    'warbird': ['msmarvel', 'msmarvel_alt'],
    'warmachine': ['warmachine_pro_1'],
    'whirlwind': ['whirlwind_pro_2'],
    'wizard': ['wizard_anti_2'],
    'wolverine': ['wolverine', 'wolverine_alt', 'wolverine_anti_2'],
    'wonderman': ['wonderman_pro_2'],
}

CHAR_CANONICAL = {
    'bphero': 'blackpanther',
    'blackpantherhero': 'blackpanther',
    'cablehero': 'cable',
    'fury': 'nickfury',
    'nickfuryhero': 'nickfury',
    'nanitenickfury': 'nickfury',
    'herc': 'hercules',
    'spidwm': 'spiderwoman',
    'thing': 'thething',
    'vanbardos': 'luciavonbardas',
    'warbird': 'msmarvel',
    'lukecageminiboss': 'lukecage',
}

def decode_dxt1(data, w, h):
    """Vectorized DXT1 decompressor returning RGB numpy array."""
    bw, bh = (w + 3) // 4, (h + 3) // 4
    nb = bw * bh
    raw = np.frombuffer(data[:nb * 8], dtype=np.uint8).reshape((nb, 8))
    c0 = raw[:, 0].astype(np.uint16) | (raw[:, 1].astype(np.uint16) << 8)
    c1 = raw[:, 2].astype(np.uint16) | (raw[:, 3].astype(np.uint16) << 8)
    bits = (raw[:, 4].astype(np.uint32) | (raw[:, 5].astype(np.uint32) << 8) |
            (raw[:, 6].astype(np.uint32) << 16) | (raw[:, 7].astype(np.uint32) << 24))

    r0 = (((c0 >> 11) & 31) * 255 // 31).astype(np.uint8)
    g0 = (((c0 >> 5) & 63) * 255 // 63).astype(np.uint8)
    b0 = ((c0 & 31) * 255 // 31).astype(np.uint8)

    r1 = (((c1 >> 11) & 31) * 255 // 31).astype(np.uint8)
    g1 = (((c1 >> 5) & 63) * 255 // 63).astype(np.uint8)
    b1 = ((c1 & 31) * 255 // 31).astype(np.uint8)

    col = np.zeros((nb, 4, 3), dtype=np.uint8)
    col[:, 0, 0] = r0; col[:, 0, 1] = g0; col[:, 0, 2] = b0
    col[:, 1, 0] = r1; col[:, 1, 1] = g1; col[:, 1, 2] = b1
    col[:, 2, :] = ((2 * col[:, 0, :].astype(np.uint16) + col[:, 1, :].astype(np.uint16)) // 3).astype(np.uint8)
    col[:, 3, :] = ((col[:, 0, :].astype(np.uint16) + 2 * col[:, 1, :].astype(np.uint16)) // 3).astype(np.uint8)

    b_idx = np.arange(nb)[:, None]
    block_indices = np.zeros((nb, 16), dtype=np.uint8)
    for i in range(16):
        block_indices[:, i] = (bits >> (2 * i)) & 3

    pixels = col[b_idx, block_indices]
    img = pixels.reshape((bh, bw, 4, 4, 3)).transpose((0, 2, 1, 3, 4)).reshape((bh * 4, bw * 4, 3))
    return img[:h, :w]

def decode_dxt5(data, w, h):
    """Vectorized DXT5 decompressor returning RGBA numpy array."""
    bw, bh = (w + 3) // 4, (h + 3) // 4
    nb = bw * bh
    raw = np.frombuffer(data[:nb * 16], dtype=np.uint8).reshape((nb, 16))
    a0 = raw[:, 0].astype(np.int32)
    a1 = raw[:, 1].astype(np.int32)
    abits = (raw[:, 2].astype(np.uint64) | (raw[:, 3].astype(np.uint64) << 8) |
             (raw[:, 4].astype(np.uint64) << 16) | (raw[:, 5].astype(np.uint64) << 24) |
             (raw[:, 6].astype(np.uint64) << 32) | (raw[:, 7].astype(np.uint64) << 40))

    c0 = raw[:, 8].astype(np.uint16) | (raw[:, 9].astype(np.uint16) << 8)
    c1 = raw[:, 10].astype(np.uint16) | (raw[:, 11].astype(np.uint16) << 8)
    cbits = (raw[:, 12].astype(np.uint32) | (raw[:, 13].astype(np.uint32) << 8) |
             (raw[:, 14].astype(np.uint32) << 16) | (raw[:, 15].astype(np.uint32) << 24))

    r0 = (((c0 >> 11) & 31) * 255 // 31).astype(np.uint8)
    g0 = (((c0 >> 5) & 63) * 255 // 63).astype(np.uint8)
    b0 = ((c0 & 31) * 255 // 31).astype(np.uint8)

    r1 = (((c1 >> 11) & 31) * 255 // 31).astype(np.uint8)
    g1 = (((c1 >> 5) & 63) * 255 // 63).astype(np.uint8)
    b1 = ((c1 & 31) * 255 // 31).astype(np.uint8)

    col = np.zeros((nb, 4, 3), dtype=np.uint8)
    col[:, 0, 0] = r0; col[:, 0, 1] = g0; col[:, 0, 2] = b0
    col[:, 1, 0] = r1; col[:, 1, 1] = g1; col[:, 1, 2] = b1
    col[:, 2, :] = ((2 * col[:, 0, :].astype(np.uint16) + col[:, 1, :].astype(np.uint16)) // 3).astype(np.uint8)
    col[:, 3, :] = ((col[:, 0, :].astype(np.uint16) + 2 * col[:, 1, :].astype(np.uint16)) // 3).astype(np.uint8)

    alphas = np.zeros((nb, 8), dtype=np.uint8)
    alphas[:, 0] = a0.astype(np.uint8)
    alphas[:, 1] = a1.astype(np.uint8)
    mask = a0 > a1
    for i in range(1, 7):
        alphas[mask, i + 1] = (((7 - i) * a0[mask] + i * a1[mask]) // 7).astype(np.uint8)
    not_mask = ~mask
    for i in range(1, 5):
        alphas[not_mask, i + 1] = (((5 - i) * a0[not_mask] + i * a1[not_mask]) // 5).astype(np.uint8)
    alphas[not_mask, 6] = 0
    alphas[not_mask, 7] = 255

    b_idx = np.arange(nb)[:, None]
    c_indices = np.zeros((nb, 16), dtype=np.uint8)
    a_indices = np.zeros((nb, 16), dtype=np.uint8)
    for i in range(16):
        c_indices[:, i] = (cbits >> (2 * i)) & 3
        a_indices[:, i] = ((abits >> np.uint64(3 * i)) & np.uint64(7)).astype(np.uint8)

    pix_rgb = col[b_idx, c_indices]
    pix_a = alphas[b_idx, a_indices, None]
    pixels = np.concatenate([pix_rgb, pix_a], axis=2)
    img = pixels.reshape((bh, bw, 4, 4, 4)).transpose((0, 2, 1, 3, 4)).reshape((bh * 4, bw * 4, 4))
    return img[:h, :w]

def decode_ati2(data, w, h):
    """Vectorized ATI2 / BC5 decompressor returning RGB normal map array."""
    bw, bh = (w + 3) // 4, (h + 3) // 4
    nb = bw * bh
    raw = np.frombuffer(data[:nb * 16], dtype=np.uint8).reshape((nb, 16))

    def decode_channel(chan_8b):
        v0 = chan_8b[:, 0].astype(np.int32)
        v1 = chan_8b[:, 1].astype(np.int32)
        bits = (chan_8b[:, 2].astype(np.uint64) | (chan_8b[:, 3].astype(np.uint64) << 8) |
                (chan_8b[:, 4].astype(np.uint64) << 16) | (chan_8b[:, 5].astype(np.uint64) << 24) |
                (chan_8b[:, 6].astype(np.uint64) << 32) | (chan_8b[:, 7].astype(np.uint64) << 40))
        vals = np.zeros((nb, 8), dtype=np.uint8)
        vals[:, 0] = v0.astype(np.uint8)
        vals[:, 1] = v1.astype(np.uint8)
        m = v0 > v1
        for i in range(1, 7):
            vals[m, i + 1] = (((7 - i) * v0[m] + i * v1[m]) // 7).astype(np.uint8)
        nm = ~m
        for i in range(1, 5):
            vals[nm, i + 1] = (((5 - i) * v0[nm] + i * v1[nm]) // 5).astype(np.uint8)
        vals[nm, 6] = 0
        vals[nm, 7] = 255
        indices = np.zeros((nb, 16), dtype=np.uint8)
        for i in range(16):
            indices[:, i] = ((bits >> np.uint64(3 * i)) & np.uint64(7)).astype(np.uint8)
        b_idx = np.arange(nb)[:, None]
        return vals[b_idx, indices]

    r_ch = decode_channel(raw[:, :8])
    g_ch = decode_channel(raw[:, 8:])
    b_ch = np.full((nb, 16), 255, dtype=np.uint8)
    pix = np.stack([r_ch, g_ch, b_ch], axis=2)
    img = pix.reshape((bh, bw, 4, 4, 3)).transpose((0, 2, 1, 3, 4)).reshape((bh * 4, bw * 4, 3))
    return img[:h, :w]

def export_texture_png(tex_info, out_png_path):
    """Decompress texture and save thumbnail PNG preserving hash identity."""
    if os.path.exists(out_png_path):
        return True
    src_file = tex_info.get('file')
    if not src_file or not os.path.exists(src_file):
        return False
    data_off = tex_info.get('data_off', 0)
    fmt = tex_info.get('format')
    w, h = tex_info.get('width', 0), tex_info.get('height', 0)
    if w <= 0 or h <= 0:
        return False

    with open(src_file, 'rb') as f:
        f.seek(data_off)
        raw_data = f.read()

    try:
        if fmt == 'DXT1':
            arr = decode_dxt1(raw_data, w, h)
            img = Image.fromarray(arr)
        elif fmt == 'DXT5':
            arr = decode_dxt5(raw_data, w, h)
            img = Image.fromarray(arr)
        elif fmt == 'ATI2':
            arr = decode_ati2(raw_data, w, h)
            img = Image.fromarray(arr)
        else:
            return False

        img.thumbnail((256, 256), Image.LANCZOS)
        os.makedirs(os.path.dirname(out_png_path), exist_ok=True)
        img.save(out_png_path, optimize=True)
        return True
    except Exception:
        return False

def scan_all_effects():
    """Scan all 5,333 effect IGZ files, decompile definitions, export textures, and save catalog."""
    t0 = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(OUT_TEX_DIR, exist_ok=True)

    # 1. Load texture index and build lookup dictionaries
    with open(TEX_INDEX_PATH) as f:
        tex_index = json.load(f)

    by_path = {}
    by_base = {}
    for k, v in tex_index.items():
        v['key'] = k
        clean = v['name'].replace('\\', '/').lower().strip()
        by_path[clean] = v
        if 'data/' in clean:
            by_path[clean.split('data/', 1)[1]] = v
        base = os.path.basename(clean)
        if base not in by_base:
            by_base[base] = []
        by_base[base].append(v)

    # 2. Collect effect files
    files = sorted(glob.glob(os.path.join(EFFECTS_DIR, '**/*.igz'), recursive=True))
    total_files = len(files)
    print(f'Scanning {total_files} effects from {EFFECTS_DIR}...', file=sys.stderr)

    exported_textures = set()
    category_counts = {}
    character_counts = {}
    status_counts = {'decoded': 0, 'partial': 0, 'metadata-only': 0, 'error': 0}
    effects = []

    for i, file_path in enumerate(files):
        rel_path = os.path.relpath(file_path, EFFECTS_DIR).replace('\\', '/')
        effect_id = os.path.splitext(rel_path)[0]
        effect_name = os.path.splitext(os.path.basename(rel_path))[0]
        parts = rel_path.split('/')
        category = parts[0] if parts else 'other'
        category_counts[category] = category_counts.get(category, 0) + 1

        character = None
        model_ids = []
        if category == 'char' and len(parts) > 1:
            raw_char = parts[1]
            character = CHAR_CANONICAL.get(raw_char, raw_char)
            model_ids = list(CHAR_MAP.get(raw_char, []))
            character_counts[character] = character_counts.get(character, 0) + 1

        try:
            with open(file_path, 'rb') as f:
                raw_bytes = f.read()
            defn, status, unsupported, raw_textures = decode_effect_data(raw_bytes, filepath=file_path)
        except Exception as exc:
            defn = None
            status = 'error'
            unsupported = [str(exc)]
            raw_textures = []

        status_counts[status] = status_counts.get(status, 0) + 1

        # Pick primary preview texture (prefer non-LUT, non-normal, material/actor/effect texture)
        thumb_path = None
        picked_tex_info = None
        for t in raw_textures:
            t_low = t.replace('\\', '/').lower().strip()
            t_base = os.path.basename(t_low)
            if t_base.startswith(('lut_', 'textures/luts')) or t_base.endswith(('_n.tga', '_n.dds')):
                continue
            entry = by_path.get(t_low) or (by_base.get(t_base)[0] if t_base in by_base else None)
            if entry:
                picked_tex_info = entry
                break

        # If none found, fallback to any valid texture
        if not picked_tex_info:
            for t in raw_textures:
                t_low = t.replace('\\', '/').lower().strip()
                t_base = os.path.basename(t_low)
                entry = by_path.get(t_low) or (by_base.get(t_base)[0] if t_base in by_base else None)
                if entry:
                    picked_tex_info = entry
                    break

        if picked_tex_info:
            tex_key = picked_tex_info['key']
            png_dest = os.path.join(OUT_TEX_DIR, f'{tex_key}.png')
            if export_texture_png(picked_tex_info, png_dest):
                exported_textures.add(tex_key)
                thumb_path = f'assets/vfx/textures/{tex_key}.png'

        effect_entry = {
            'id': effect_id,
            'path': rel_path,
            'name': effect_name,
            'category': category,
            'character': character,
            'modelIds': model_ids,
            'textures': raw_textures,
            'thumb': thumb_path,
            'definition': defn,
            'status': status,
            'unsupported': unsupported,
        }
        effects.append(effect_entry)

        if (i + 1) % 500 == 0 or (i + 1) == total_files:
            print(f'Progress: {i + 1}/{total_files} effects processed ({status_counts["decoded"]} decoded, {len(exported_textures)} textures exported)...', file=sys.stderr)

    # 3. Sort effects predictably: character effects first, then map, then others
    def sort_key(row):
        cat = row['category']
        priority = 0 if cat == 'char' else (1 if cat == 'map' else (2 if cat == 'flares' else 3))
        return (priority, row['character'] or '', row['name'])

    effects.sort(key=sort_key)

    catalog = {
        'format': 'mua2_vfx_catalog_v1',
        'summary': {
            'total': len(effects),
            'decoded': status_counts['decoded'],
            'partial': status_counts['partial'],
            'metadata_only': status_counts['metadata-only'],
            'error': status_counts['error'],
            'textures_exported': len(exported_textures),
            'categories': category_counts,
            'characters': character_counts,
        },
        'effects': effects,
    }

    # Atomic write to avoid partial writes
    tmp_out = OUT_CATALOG + '.tmp'
    with open(tmp_out, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, indent=1)
    os.replace(tmp_out, OUT_CATALOG)

    elapsed = time.time() - t0
    print(f'Successfully generated {OUT_CATALOG} in {elapsed:.2f}s!', file=sys.stderr)
    print(f'Summary: {catalog["summary"]}', file=sys.stderr)

if __name__ == '__main__':
    scan_all_effects()
