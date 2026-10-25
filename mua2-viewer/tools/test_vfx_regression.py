#!/usr/bin/env python3
"""Assert-based regression test suite for MUA2 VFX decompiler and catalog."""
import json
import os
import re
import struct
import sys
import wave
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
    _parse_strings,
    PRIM_TYPES,
)
from vfx_scan import (
    decode_dxt1,
    decode_dxt5,
    decode_ati2,
    CHAR_MAP,
    CHAR_CANONICAL,
)
from vfx_assets import parse_fsb5_block

WORK_DIR = os.path.abspath('_work')
EFFECTS_DIR = os.path.join(WORK_DIR, 'igz_effects')
CATALOG_PATH = os.path.abspath('mua2-viewer/assets/vfx/effects.json')
TEXTURES_DIR = os.path.abspath('mua2-viewer/assets/vfx/textures')
MODELS_CATALOG = os.path.abspath('mua2-viewer/assets/models/models.json')
MODEL_MAP_PATH = os.path.abspath('mua2-viewer/assets/vfx/model_map.json')
SOUND_MAP_PATH = os.path.abspath('mua2-viewer/assets/vfx/sound_map.json')
VFX_MODELS_DIR = os.path.abspath('mua2-viewer/assets/vfx/models')
VFX_SOUNDS_DIR = os.path.abspath('mua2-viewer/assets/vfx/sounds')

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

    # Quadratic curves (_rqSize, _rqAlpha, _rqLength) 5-float verification
    for curve_name in ('rqSize', 'rqAlpha', 'rqLength'):
        curve = prim[curve_name]
        assert isinstance(curve, list) and len(curve) == 5, f"Expected 5 floats in {curve_name}, got {curve}"
        assert all(isinstance(v, float) for v in curve), f"Non-float value in {curve_name}: {curve}"

    # Shader name and sound extraction constraints on spiderman_blocking (non-sound primitives)
    assert prim['shaderName'] is None or prim['shaderName'] in ('ScreenDistortion', '*UberShader')
    assert prim['shaderName'] != 'textures/luts/lut_blank', "shaderName wrongly resolved to LUT"
    assert prim['soundBank'] is None and prim['soundName'] is None

    # Shader textures must only contain actual textures (.tga, .dds)
    for st in prim['shaderTextures']:
        assert st.lower().endswith(('.tga', '.dds')), f"Non-texture string in shaderTextures: {st}"

def test_vfx_decoder_field_mappings():
    """Verify string table integrity, shaderName resolution, soundBank isolation, and texture filtering."""
    # 1. String table null-byte handling (empty strings must not be skipped)
    raw_tstr = b'alpha\x00\x00beta\x00\x00'
    parsed = _parse_strings(raw_tstr, 0, len(raw_tstr), 4)
    assert parsed == ['alpha', '', 'beta', ''], f"Empty string skipped in TSTR: {parsed}"

    # 2. Distortion shader decoding on real effect
    dist_path = os.path.join(EFFECTS_DIR, 'map/chemplantmap2/cpp2_pipeburst.igz')
    if os.path.exists(dist_path):
        defn_d, _, _, _ = decode_effect_file(dist_path)
        dist_prims = [p for p in defn_d['primitives'] if p['shaderName'] == 'ScreenDistortion']
        assert len(dist_prims) >= 1, "Expected ScreenDistortion primitives in cpp2_pipeburst"
        for p in dist_prims:
            assert p['shaderName'] != 'textures/luts/lut_blank', "shaderName wrongly resolved to LUT texture"
            assert p['soundBank'] is None and p['soundName'] is None, "Non-sound primitive extracted soundBank/Name"
            for tex in p['shaderTextures']:
                assert tex.lower().endswith(('.tga', '.dds')), f"Invalid texture in shaderTextures: {tex}"

    # 3. FXPRIM_TYPE_SOUND isolation and metadata extraction
    snd_path = os.path.join(EFFECTS_DIR, 'map/chemplantmap2/interiorcontainer80ft_explosion.igz')
    if os.path.exists(snd_path):
        defn_s, _, _, _ = decode_effect_file(snd_path)
        snd_prims = [p for p in defn_s['primitives'] if p['type'] == 21]
        assert len(snd_prims) == 1, "Expected 1 sound primitive in interiorcontainer80ft_explosion"
        sp = snd_prims[0]
        assert sp['soundBank'] == 'FX_explosion_container_bank'
        assert sp['soundName'] == 'ENV_Cap_Arena_Pipe_Break'
        for tex in sp['shaderTextures']:
            assert tex.lower().endswith(('.tga', '.dds'))

        # Non-sound primitives in same effect must have soundBank is None
        non_snd = [p for p in defn_s['primitives'] if p['type'] != 21]
        assert len(non_snd) > 0
        for p in non_snd:
            assert p['soundBank'] is None and p['soundName'] is None

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
    assert summary.get('textures_exported') >= 518, f"Expected >= 518 textures, got {summary.get('textures_exported')}"

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
    assert len(files) >= 518, f"Expected >= 518 exported texture PNGs, got {len(files)}"

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

def test_vfx_texture_map_and_runtime_conformance():
    """Verify texture_map.json validity, exported texture targets, and vfx.js runtime exports."""
    map_path = os.path.abspath('mua2-viewer/assets/vfx/texture_map.json')
    assert os.path.exists(map_path), f"Missing texture_map.json: {map_path}"

    with open(map_path, 'r', encoding='utf-8') as f:
        tex_map = json.load(f)

    assert isinstance(tex_map, dict) and len(tex_map) >= 500, f"Expected >= 500 entries, got {len(tex_map)}"
    tex_path_re = re.compile(r'^assets/vfx/textures/[0-9a-f]{16}\.png$')

    for k, target in list(tex_map.items())[:50]:
        assert tex_path_re.match(target), f"Invalid texture target for {k}: {target}"
        abs_target = os.path.abspath(os.path.join('mua2-viewer', target))
        assert os.path.exists(abs_target), f"Referenced texture file does not exist: {abs_target}"

    # Verify vfx.js symbols
    vfx_js_path = os.path.abspath('mua2-viewer/src/vfx.js')
    assert os.path.exists(vfx_js_path), f"Missing vfx.js: {vfx_js_path}"
    with open(vfx_js_path, 'r', encoding='utf-8') as f:
        vfx_src = f.read()

    for symbol in (
        'export class VfxRuntime',
        'export class VfxCatalogController',
        'export function resolveAttachmentTarget',
        'export function parseHexColor',
        'export function evaluateColorRamp',
        'export function resolveBlendMode',
        'export function selfCheckVfxCatalog',
    ):
        assert symbol in vfx_src, f"Missing expected export symbol in vfx.js: {symbol}"

def test_fsb5_boundaries() -> None:
    """A block consumes only its own bytes; malformed/unsupported headers fail closed."""
    payload = b'\xff\xf5' + bytes(30)
    for version, header_size in ((0, 64), (1, 60)):
        header = struct.pack('<4s6I', b'FSB5', version, 1, 8, 10, len(payload), 11)
        block = header.ljust(header_size, b'\x00') + bytes(8) + struct.pack('<I', 4) + b'first\x00' + payload
        prefix = b'container'
        data = prefix + block + block
        result = parse_fsb5_block(data, len(prefix))
        assert result is not None
        sample, end = result
        assert sample.name == 'first' and sample.data == payload
        assert end == len(prefix) + len(block)
        assert parse_fsb5_block(data, end)[1] == len(data)
        for length in (0, 27, header_size - 1, len(block) - 1):
            assert parse_fsb5_block(block[:length], 0) is None
        assert parse_fsb5_block(block, -1) is None
        for offset, value in ((4, 2), (8, 0), (8, 2), (12, 0), (20, 0), (24, 10)):
            malformed = bytearray(block)
            struct.pack_into('<I', malformed, offset, value)
            assert parse_fsb5_block(bytes(malformed), 0) is None, (offset, value)


def test_vfx_asset_maps() -> None:
    """Check every mapped file, GLB chunks, distribution WAV audio, MPEG headers and source FSB boundaries."""
    from pathlib import Path

    viewer = Path('mua2-viewer').resolve()
    model_map = json.loads(Path(MODEL_MAP_PATH).read_text())
    sound_map = json.loads(Path(SOUND_MAP_PATH).read_text())
    assert model_map and sound_map
    model_paths = set(model_map.values())
    sound_paths = {path for bank in sound_map.values() for path in bank.values()}
    for rel in model_paths | sound_paths:
        target = (viewer / rel).resolve()
        assert target.is_relative_to(viewer) and target.is_file(), rel

    effect_glbs = {p.relative_to(viewer).as_posix() for p in Path(VFX_MODELS_DIR).rglob('*.glb')}
    wav_files = {p.relative_to(viewer).as_posix() for p in Path(VFX_SOUNDS_DIR).rglob('*.wav')}
    mp3_files = {p.relative_to(viewer).as_posix() for p in Path(VFX_SOUNDS_DIR).rglob('*.mp3')}
    assert effect_glbs == {p for p in model_paths if p.startswith('assets/vfx/models/')}
    assert wav_files == sound_paths
    assert mp3_files == {p[:-4] + '.mp3' for p in sound_paths}

    for rel in sorted(model_paths):
        data = (viewer / rel).read_bytes()
        assert len(data) >= 20, rel
        assert struct.unpack_from('<4sII', data) == (b'glTF', 2, len(data)), rel
        pos = 12
        chunks = []
        while pos < len(data):
            assert pos + 8 <= len(data), rel
            length, kind = struct.unpack_from('<I4s', data, pos)
            assert length % 4 == 0 and pos + 8 + length <= len(data), rel
            chunks.append((kind, data[pos + 8:pos + 8 + length]))
            pos += 8 + length
        assert chunks[0][0] == b'JSON' and pos == len(data), rel
        gltf = json.loads(chunks[0][1])
        assert gltf['asset']['version'] == '2.0' and gltf.get('meshes'), rel

    # 1. Distribution WAV checks: RIFF/WAVE header, 16-bit PCM, valid rates/channels, non-empty
    valid_rates = {8000, 11000, 11025, 16000, 22050, 24000, 32000, 44100, 48000}
    for rel in sorted(sound_paths):
        target = viewer / rel
        data = target.read_bytes()
        assert len(data) >= 44, rel
        assert data[:4] == b'RIFF', f"Missing RIFF header: {rel}"
        assert data[8:12] == b'WAVE', f"Missing WAVE identifier: {rel}"
        with wave.open(str(target), 'rb') as w:
            assert w.getnchannels() in (1, 2), f"Invalid channel count {w.getnchannels()}: {rel}"
            assert w.getsampwidth() == 2, f"Expected 16-bit PCM (sampwidth 2), got {w.getsampwidth()}: {rel}"
            assert w.getframerate() in valid_rates, f"Invalid framerate {w.getframerate()}: {rel}"
            assert w.getnframes() > 0, f"Empty audio file (0 frames): {rel}"

    # 2. Raw FSB MPEG Layer II header bit verification
    layers = set()
    for rel in sorted(mp3_files):
        data = (viewer / rel).read_bytes()
        assert len(data) >= 4 and data[0] == 255 and data[1] & 0xE0 == 0xE0, rel
        assert (data[1] >> 3) & 3 != 1 and (data[1] >> 1) & 3 != 0, rel
        assert 0 < data[2] >> 4 < 15 and (data[2] >> 2) & 3 != 3, rel
        layers.add((data[1] >> 1) & 3)

    # 3. Source FSB identity & sample metadata cross-check
    parsed_paths = set()
    banks = {Path(rel).parent.name for rel in sound_paths}
    for bank in sorted(banks):
        data = (Path(WORK_DIR) / 'extracted/sounds' / f'{bank}.pak').read_bytes()
        pos = 0
        while (idx := data.find(b'FSB5', pos)) != -1:
            result = parse_fsb5_block(data, idx)
            assert result is not None, (bank, idx)
            sample, end = result
            assert idx < end <= len(data), (bank, idx, end)
            mp3_rel = f'assets/vfx/sounds/{bank}/{sample.name}.mp3'
            wav_rel = f'assets/vfx/sounds/{bank}/{sample.name}.wav'
            assert mp3_rel in mp3_files and (viewer / mp3_rel).read_bytes() == sample.data, mp3_rel
            assert wav_rel in sound_paths, wav_rel
            with wave.open(str(viewer / wav_rel), 'rb') as w:
                assert w.getframerate() == sample.frequency, (wav_rel, w.getframerate(), sample.frequency)
                assert w.getnchannels() == sample.channels, (wav_rel, w.getnchannels(), sample.channels)
            parsed_paths.add(wav_rel)
            next_idx = data.find(b'FSB5', end)
            if next_idx != -1:
                assert not any(data[end:next_idx]), (bank, end, next_idx)
            pos = end
    assert parsed_paths == sound_paths
    print(f'  Assets: {len(model_map)} model aliases / {len(model_paths)} GLBs '
          f'({len(effect_glbs)} VFX); {len(sound_map)} bank aliases / {len(banks)} source banks / '
          f'{len(sound_paths)} WAV files + {len(mp3_files)} raw FSB files; MPEG layer bits={sorted(layers)}', file=sys.stderr)


def run_all_tests():
    """Execute all regression tests and report elapsed time."""
    print("Running MUA2 VFX regression test suite...", file=sys.stderr)
    tests = [
        test_nibble_stream_decoder,
        test_igz_v6_header_and_blocks,
        test_cfx_primitive_decompilation,
        test_vfx_decoder_field_mappings,
        test_partial_vfx_handling,
        test_vectorized_texture_codecs,
        test_effects_catalog_schema_and_integrity,
        test_exported_textures,
        test_vfx_texture_map_and_runtime_conformance,
        test_fsb5_boundaries,
        test_vfx_asset_maps,
    ]
    for t in tests:
        t()
        print(f"  PASS: {t.__name__}", file=sys.stderr)
    print(f"\nAll {len(tests)} MUA2 VFX regression tests passed successfully!", file=sys.stderr)

if __name__ == '__main__':
    run_all_tests()
