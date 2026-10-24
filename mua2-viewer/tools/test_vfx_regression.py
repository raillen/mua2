#!/usr/bin/env python3
"""Assert-based regression test suite for MUA2 VFX decompiler and catalog."""
import json
import os
import re
import struct
import sys
import numpy as np
from PIL import Image

# Ensure tools directory is in sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from vfx_decode import (
    decode_nibbles,
    parse_igz_v6,
    decode_effect_data,
    decode_effect_file,
    PRIM_TYPES,
)
from vfx_scan import (
    decode_dxt1,
    decode_dxt5,
    decode_ati2,
    CHAR_MAP,
    CHAR_CANONICAL,
)

WORK_DIR = os.path.abspath('_work')
EFFECTS_DIR = os.path.join(WORK_DIR, 'igz_effects')
CATALOG_PATH = os.path.abspath('mua2-viewer/assets/vfx/effects.json')
TEXTURES_DIR = os.path.abspath('mua2-viewer/assets/vfx/textures')
MODELS_CATALOG = os.path.abspath('mua2-viewer/assets/models/models.json')

def test_nibble_stream_decoder():
    """Verify Alchemy variable-length delta-nibble stream unpacking."""
    # 1 nibble (no continuation): 0x1 -> val=1. add_one=True -> (1+1)*4 = 8
    # Byte 0x01: low nibble 1 (stop), high nibble 0 (val 0, stop -> (0+1)*4 = 4)
    data = bytes([0x01])
    res = decode_nibbles(data, 0, 2, add_one=True)
    assert len(res) == 2, f"Expected 2 decoded offsets, got {len(res)}"
    assert res[0] == 8, f"Expected 8, got {res[0]}"
    assert res[1] == 12, f"Expected 12, got {res[1]}"

    # Continuation test: low nibble 0x9 (val 1, continue), high nibble 0x2 (val 2 << 3 = 16, stop)
    # Total val = 17. add_one=True -> (17+1)*4 = 72
    data_cont = bytes([0x29])
    res_cont = decode_nibbles(data_cont, 0, 1, add_one=True)
    assert len(res_cont) == 1
    assert res_cont[0] == 72, f"Expected 72, got {res_cont[0]}"

def test_igz_v6_header_and_blocks():
    """Verify Alchemy v6 IGZ header and fixup table extraction on ground truth."""
    sample = os.path.join(EFFECTS_DIR, 'char/spiderman/spiderman_blocking.igz')
    assert os.path.exists(sample), f"Missing ground truth sample: {sample}"

    with open(sample, 'rb') as f:
        data = f.read()

    parsed = parse_igz_v6(data)
    assert parsed is not None, "Failed to parse valid v6 IGZ file"
    assert parsed['version'] == 6, f"Expected IGZ v6, got {parsed['version']}"
    assert parsed['platform'] == 2, f"Expected platform 2 (x64), got {parsed['platform']}"
    assert len(parsed['chunks']) >= 2, f"Expected >= 2 chunks, got {len(parsed['chunks'])}"

    assert 'CFxTemplate' in parsed['tmet'], "Missing CFxTemplate in TMET"
    assert 'CFxPrimitiveTemplate' in parsed['tmet'], "Missing CFxPrimitiveTemplate in TMET"
    assert len(parsed['mtsz']) >= len(parsed['tmet']), "MTSZ count mismatch with TMET"
    assert len(parsed['rvtb']) > 0, "RVTB object fixups table is empty"
    assert len(parsed['rofs']) > 0, "ROFS reference fixups table is empty"
    assert len(parsed['rstt']) > 0, "RSTT string fixups table is empty"

def test_cfx_primitive_decompilation():
    """Verify CFxTemplate and CFxPrimitiveTemplate fields and parameter offsets."""
    sample = os.path.join(EFFECTS_DIR, 'char/spiderman/spiderman_blocking.igz')
    defn, status, unsupported, textures = decode_effect_file(sample)

    assert status == 'decoded', f"Expected status 'decoded', got {status}"
    assert unsupported == [], f"Unexpected unsupported features: {unsupported}"
    assert isinstance(textures, list) and len(textures) > 0, "Expected textures in spiderman_blocking"

    assert 'templates' in defn and len(defn['templates']) == 1, "Expected 1 CFxTemplate"
    tmpl = defn['templates'][0]
    assert isinstance(tmpl['fileName'], str)
    assert isinstance(tmpl['loopTime'], float) and tmpl['loopTime'] >= 0.0
    assert tmpl['persistLoop'] in (0, 1)

    assert 'primitives' in defn and len(defn['primitives']) >= 1, "Expected >= 1 primitive"
    prim = defn['primitives'][0]
    assert prim['type'] in PRIM_TYPES, f"Unknown primitive type: {prim['type']}"
    assert prim['typeName'] == PRIM_TYPES[prim['type']]
    assert isinstance(prim['delay'], float) and prim['delay'] >= 0.0
    assert isinstance(prim['life'], float) and prim['life'] >= 0.0
    assert isinstance(prim['radius'], float)
    assert isinstance(prim['height'], float)
    assert len(prim['scrollVelocity']) == 3
    assert all(isinstance(v, float) for v in prim['scrollVelocity'])

    # Flags and colors must be hex strings 0x...
    for k in ('primitive', 'primitive2', 'spawn'):
        assert re.match(r'^0x[0-9a-f]{8}$', prim['flags'][k]), f"Malformed flag {k}: {prim['flags'][k]}"
    for k in ('start1', 'mid1', 'end1', 'start2', 'mid2', 'end2'):
        assert re.match(r'^0x[0-9a-f]{8}$', prim['colors'][k]), f"Malformed color {k}: {prim['colors'][k]}"

    assert isinstance(prim['blendMode'], int)

def test_partial_vfx_handling():
    """Verify correct classification of partial effects lacking CFxTemplate or primitives."""
    # 1. Effect with only CFxPrimitiveTemplate (explosion_pipes.igz)
    pipes = os.path.join(EFFECTS_DIR, 'map/chemplantmap2/explosion_pipes.igz')
    if os.path.exists(pipes):
        defn, status, unsupported, texs = decode_effect_file(pipes)
        assert status == 'partial', f"Expected 'partial' for explosion_pipes, got {status}"
        assert len(defn['templates']) == 0, "explosion_pipes should have 0 templates"
        assert len(defn['primitives']) == 13, f"explosion_pipes expected 13 primitives, got {len(defn['primitives'])}"

    # 2. Effect with only CFxTemplate and 0 primitives (captainamerica_emptyeffect.igz)
    empty = os.path.join(EFFECTS_DIR, 'char/captainamerica/captainamerica_emptyeffect.igz')
    if os.path.exists(empty):
        defn, status, unsupported, texs = decode_effect_file(empty)
        assert status == 'partial', f"Expected 'partial' for captainamerica_emptyeffect, got {status}"
        assert len(defn['templates']) == 1, "captainamerica_emptyeffect should have 1 template"
        assert len(defn['primitives']) == 0, "captainamerica_emptyeffect should have 0 primitives"

def test_vectorized_texture_codecs():
    """Verify vectorized DXT1, DXT5, and ATI2 decompressor bounds and shapes."""
    # DXT1: 8 bytes per 4x4 block -> RGB (4, 4, 3)
    raw_dxt1 = struct.pack('<HHI', 0xF800, 0x001F, 0xAA55AA55)
    img_dxt1 = decode_dxt1(raw_dxt1, 4, 4)
    assert img_dxt1.shape == (4, 4, 3), f"DXT1 shape mismatch: {img_dxt1.shape}"
    assert img_dxt1.dtype == np.uint8
    assert 0 <= img_dxt1.min() and img_dxt1.max() <= 255

    # DXT5: 16 bytes per 4x4 block -> RGBA (4, 4, 4)
    raw_dxt5 = struct.pack('<BB6sHHI', 255, 0, b'\x00' * 6, 0xF800, 0x001F, 0xAA55AA55)
    img_dxt5 = decode_dxt5(raw_dxt5, 4, 4)
    assert img_dxt5.shape == (4, 4, 4), f"DXT5 shape mismatch: {img_dxt5.shape}"
    assert img_dxt5.dtype == np.uint8
    assert 0 <= img_dxt5.min() and img_dxt5.max() <= 255

    # ATI2: 16 bytes per 4x4 block -> RGB (4, 4, 3)
    raw_ati2 = struct.pack('<BB6sBB6s', 255, 0, b'\x00' * 6, 255, 0, b'\x00' * 6)
    img_ati2 = decode_ati2(raw_ati2, 4, 4)
    assert img_ati2.shape == (4, 4, 3), f"ATI2 shape mismatch: {img_ati2.shape}"
    assert img_ati2.dtype == np.uint8
    assert (img_ati2[:, :, 2] == 255).all(), "ATI2 Blue channel should be normalized to 255"

def test_effects_catalog_schema_and_integrity():
    """Verify effects.json schema compliance, totals, model associations, and thumb paths."""
    assert os.path.exists(CATALOG_PATH), f"Missing catalog file: {CATALOG_PATH}"
    with open(CATALOG_PATH, 'r', encoding='utf-8') as f:
        catalog = json.load(f)

    assert catalog.get('format') == 'mua2_vfx_catalog_v1', f"Invalid format: {catalog.get('format')}"
    summary = catalog.get('summary', {})
    assert summary.get('total') == 5333, f"Expected 5,333 total effects, got {summary.get('total')}"
    assert summary.get('decoded') == 5235, f"Expected 5,235 decoded, got {summary.get('decoded')}"
    assert summary.get('partial') == 98, f"Expected 98 partial, got {summary.get('partial')}"
    assert summary.get('error') == 0, f"Expected 0 errors, got {summary.get('error')}"
    assert summary.get('textures_exported') == 518, f"Expected 518 textures, got {summary.get('textures_exported')}"

    effects = catalog.get('effects', [])
    assert len(effects) == 5333, f"Effects array length mismatch: {len(effects)}"

    # Load known model IDs
    with open(MODELS_CATALOG, 'r', encoding='utf-8') as f:
        models_data = json.load(f)
    known_model_ids = {m['id'] for m in models_data.get('models', [])}

    thumb_re = re.compile(r'^assets/vfx/[\w./-]+$')
    valid_categories = {'base', 'char', 'common', 'flares', 'map', 'menu', 'renderfx', 'test'}

    for idx, e in enumerate(effects):
        eid = e.get('id')
        assert eid and isinstance(eid, str), f"Effect #{idx} invalid id: {eid}"
        assert not eid.startswith('/') and not eid.endswith('.igz'), f"Invalid id format: {eid}"

        path = e.get('path')
        assert path and path.endswith('.igz'), f"Effect #{idx} invalid path: {path}"

        cat = e.get('category')
        assert cat in valid_categories, f"Effect #{idx} unexpected category: {cat}"

        char = e.get('character')
        if cat == 'char':
            assert char and isinstance(char, str), f"Effect #{idx} in char category missing character"
        else:
            assert char is None, f"Effect #{idx} outside char category has character: {char}"

        model_ids = e.get('modelIds')
        assert isinstance(model_ids, list), f"Effect #{idx} modelIds is not a list"
        for mid in model_ids:
            assert mid in known_model_ids, f"Effect #{idx} references unknown modelId: {mid}"

        assert isinstance(e.get('textures'), list), f"Effect #{idx} textures not a list"

        thumb = e.get('thumb')
        if thumb is not None:
            assert thumb_re.match(thumb) and '..' not in thumb, f"Effect #{idx} thumb violates pattern: {thumb}"
            abs_thumb = os.path.abspath(os.path.join('mua2-viewer', thumb))
            assert os.path.exists(abs_thumb), f"Effect #{idx} thumb file not found: {abs_thumb}"

        status = e.get('status')
        assert status in ('decoded', 'partial', 'metadata-only', 'error'), f"Effect #{idx} invalid status: {status}"

        unsupported = e.get('unsupported')
        assert isinstance(unsupported, list), f"Effect #{idx} unsupported not a list"

def test_exported_textures():
    """Verify all 518 textures exist, use unique 16-hex hashes, and are valid PNG images."""
    assert os.path.exists(TEXTURES_DIR), f"Missing textures directory: {TEXTURES_DIR}"
    files = os.listdir(TEXTURES_DIR)
    assert len(files) == 518, f"Expected 518 exported texture PNGs, got {len(files)}"

    hex_re = re.compile(r'^[0-9a-f]{16}\.png$')
    for fname in files:
        assert hex_re.match(fname), f"Texture file does not use 16-hex handle hash: {fname}"

    # Sample check 10 PNGs to verify image validity and dimensions
    sample_files = sorted(files)[:10]
    for sf in sample_files:
        full_p = os.path.join(TEXTURES_DIR, sf)
        with Image.open(full_p) as img:
            w, h = img.size
            assert w <= 256 and h <= 256, f"Thumbnail {sf} exceeds 256x256 max bounds: {w}x{h}"
            assert img.format == 'PNG', f"Texture {sf} format is not PNG: {img.format}"

def run_all_tests():
    """Execute all regression tests and report elapsed time."""
    print("Running MUA2 VFX regression test suite...", file=sys.stderr)
    tests = [
        test_nibble_stream_decoder,
        test_igz_v6_header_and_blocks,
        test_cfx_primitive_decompilation,
        test_partial_vfx_handling,
        test_vectorized_texture_codecs,
        test_effects_catalog_schema_and_integrity,
        test_exported_textures,
    ]
    for t in tests:
        t()
        print(f"  PASS: {t.__name__}", file=sys.stderr)
    print(f"\nAll {len(tests)} MUA2 VFX regression tests passed successfully!", file=sys.stderr)

if __name__ == '__main__':
    run_all_tests()
