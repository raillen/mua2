#!/usr/bin/env python3
"""Regression test suite for authentic MUA2 props decompilation and GLB structure."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import struct
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(os.environ.get('MUA2_WORK', ROOT / '_work'))
VIEWER = ROOT / 'mua2-viewer'
PROPS_DIR = VIEWER / 'assets/props'
PROPS_JSON = PROPS_DIR / 'props.json'


def sha256_file(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def parse_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    data = path.read_bytes()
    assert len(data) >= 20, f'GLB too small: {len(data)} bytes'
    magic, version, total_length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546C67, f'Invalid GLB magic: {hex(magic)}'
    assert version == 2, f'Unsupported glTF version: {version}'
    assert total_length == len(data), f'GLB length header mismatch: {total_length} vs {len(data)}'

    offset = 12
    json_bytes = b''
    bin_bytes = b''
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        chunk_data = data[offset + 8 : offset + 8 + chunk_len]
        if chunk_type == 0x4E4F534A:  # JSON
            json_bytes = chunk_data
        elif chunk_type == 0x004E4942:  # BIN
            bin_bytes = chunk_data
        offset += 8 + chunk_len
        if offset % 4:
            offset += 4 - (offset % 4)

    assert json_bytes, 'Missing JSON chunk in GLB'
    gltf = json.loads(json_bytes.decode('utf-8'))
    return gltf, bin_bytes


def test_catalog_structure() -> None:
    assert PROPS_JSON.is_file(), f'Catalog missing at {PROPS_JSON}'
    catalog = json.loads(PROPS_JSON.read_text(encoding='utf-8'))
    assert catalog.get('format') == 'mua2-props-v1'
    assert catalog['scope']['source_count'] == 76
    assert set(catalog['scope']['categories']) == {'weapons', 'common', 'pickups', 'bolton'}
    assert catalog['export']['skeleton'] is False
    assert catalog['export']['normalize'] is True

    models = catalog.get('models', [])
    skipped = catalog.get('skipped', [])
    assert len(models) == 71, f'Expected 71 exported models, got {len(models)}'
    assert len(skipped) == 5, f'Expected 5 skipped models, got {len(skipped)}'
    assert len(models) + len(skipped) == 76

    expected_skipped_ids = {
        'common/genericspotlightswinging150f_invisible',
        'common/genericspotlightswinging_invisible',
        'common/lightspinner01',
        'weapons/titaniummanforcering',
        'weapons/titaniummanproj',
    }
    actual_skipped_ids = {s['id'] for s in skipped}
    assert actual_skipped_ids == expected_skipped_ids, f'Skipped mismatch: {actual_skipped_ids ^ expected_skipped_ids}'

    for s in skipped:
        assert s['reason'] == 'no geometry found', f'Unexpected skip reason for {s["id"]}: {s["reason"]}'
        source_rel = s['source'].removeprefix('models/')
        source_path = WORK / 'igz' / source_rel
        assert source_path.is_file(), f'Source missing for skipped {s["id"]}: {source_path}'
        assert sha256_file(source_path) == s['source_sha256']

    print('PASS: Catalog top-level schema and 76 source totals verified (71 exported, 5 skipped).')


def test_all_exported_glbs() -> None:
    catalog = json.loads(PROPS_JSON.read_text(encoding='utf-8'))
    models = catalog['models']

    for m in models:
        glb_path = VIEWER / m['file']
        assert glb_path.is_file(), f'GLB missing for {m["id"]} at {glb_path}'
        assert sha256_file(glb_path) == m['sha256'], f'SHA256 mismatch for GLB {m["id"]}'

        source_rel = m['source'].removeprefix('models/')
        source_path = WORK / 'igz' / source_rel
        assert source_path.is_file(), f'Source missing for {m["id"]} at {source_path}'
        assert sha256_file(source_path) == m['source_sha256'], f'Source SHA256 mismatch for {m["id"]}'

        gltf, bin_bytes = parse_glb(glb_path)
        accessors = gltf.get('accessors', [])
        buffer_views = gltf.get('bufferViews', [])
        meshes = gltf.get('meshes', [])
        images = gltf.get('images', [])

        assert len(images) == m['textures'], f'Image count mismatch for {m["id"]}: {len(images)} vs {m["textures"]}'
        assert 'skins' not in gltf, f'Prop {m["id"]} unexpectedly contains skeleton skinning'

        total_verts = 0
        total_tris = 0
        total_prims = 0

        for mesh in meshes:
            for prim in mesh.get('primitives', []):
                total_prims += 1
                attrs = prim.get('attributes', {})
                assert 'POSITION' in attrs, f'Primitive in {m["id"]} missing POSITION attribute'
                pos_acc = accessors[attrs['POSITION']]
                pos_bv = buffer_views[pos_acc['bufferView']]
                pos_offset = pos_bv.get('byteOffset', 0) + pos_acc.get('byteOffset', 0)
                pos_count = pos_acc['count']
                total_verts += pos_count

                pos_arr = np.frombuffer(
                    bin_bytes, dtype=np.float32, count=pos_count * 3, offset=pos_offset
                ).reshape(-1, 3)

                # Verify all positions are finite numbers
                assert np.all(np.isfinite(pos_arr)), f'Non-finite positions detected in {m["id"]}'

                # Verify bounds
                calc_min = pos_arr.min(axis=0).tolist()
                calc_max = pos_arr.max(axis=0).tolist()
                assert 'min' in pos_acc and 'max' in pos_acc, f'Missing min/max in accessor for {m["id"]}'
                for c in range(3):
                    assert math.isclose(calc_min[c], pos_acc['min'][c], rel_tol=1e-5, abs_tol=1e-6)
                    assert math.isclose(calc_max[c], pos_acc['max'][c], rel_tol=1e-5, abs_tol=1e-6)
                    assert pos_acc['min'][c] <= pos_acc['max'][c]

                # Verify indices
                assert 'indices' in prim, f'Primitive in {m["id"]} missing indices'
                idx_acc = accessors[prim['indices']]
                idx_bv = buffer_views[idx_acc['bufferView']]
                idx_offset = idx_bv.get('byteOffset', 0) + idx_acc.get('byteOffset', 0)
                idx_count = idx_acc['count']
                assert idx_count % 3 == 0, f'Indices count {idx_count} not divisible by 3 in {m["id"]}'
                total_tris += idx_count // 3

                comp_type = idx_acc['componentType']
                idx_dtype = np.uint16 if comp_type == 5123 else np.uint32
                idx_arr = np.frombuffer(
                    bin_bytes, dtype=idx_dtype, count=idx_count, offset=idx_offset
                )
                assert idx_arr.min() >= 0
                assert idx_arr.max() < pos_count, f'Index out of range in {m["id"]}: max {idx_arr.max()} >= {pos_count}'

                # Verify normals and uvs if present
                if 'NORMAL' in attrs:
                    nrm_acc = accessors[attrs['NORMAL']]
                    nrm_bv = buffer_views[nrm_acc['bufferView']]
                    nrm_offset = nrm_bv.get('byteOffset', 0) + nrm_acc.get('byteOffset', 0)
                    nrm_arr = np.frombuffer(
                        bin_bytes, dtype=np.float32, count=nrm_acc['count'] * 3, offset=nrm_offset
                    )
                    assert np.all(np.isfinite(nrm_arr)), f'Non-finite normals in {m["id"]}'

                if 'TEXCOORD_0' in attrs:
                    uv_acc = accessors[attrs['TEXCOORD_0']]
                    uv_bv = buffer_views[uv_acc['bufferView']]
                    uv_offset = uv_bv.get('byteOffset', 0) + uv_acc.get('byteOffset', 0)
                    uv_arr = np.frombuffer(
                        bin_bytes, dtype=np.float32, count=uv_acc['count'] * 2, offset=uv_offset
                    )
                    assert np.all(np.isfinite(uv_arr)), f'Non-finite UVs in {m["id"]}'

        assert total_verts == m['verts'], f'Vertex count mismatch for {m["id"]}: {total_verts} vs {m["verts"]}'
        assert total_tris == m['tris'], f'Triangle count mismatch for {m["id"]}: {total_tris} vs {m["tris"]}'
        assert total_prims == m['parts'], f'Primitive count mismatch for {m["id"]}: {total_prims} vs {m["parts"]}'

    print(f'PASS: All {len(models)} GLB files structurally verified (positions, indices, bounds, finite numbers, counts).')


def test_independent_nested_verification() -> None:
    """Verify nested props independently from source IGZ geometry structures."""
    import sys
    sys.path.insert(0, str(VIEWER / 'tools'))
    import igb_import
    from igb_blender.igz_format.igz_reader import IGZReader
    from igb_blender.igz_format.igz_geometry import IGZDataAllocator
    import mua2_glb

    # 1. Goblin glider: 3 parts, 2491 vertices
    glider_igz = WORK / 'igz/weapons/goblin_glider.igz'
    assert glider_igz.is_file(), f'Missing {glider_igz}'
    reader_g = IGZReader(str(glider_igz))
    reader_g.read()
    alloc_g = IGZDataAllocator(reader_g)
    glider_parts = mua2_glb.walk_character(reader_g, alloc_g)
    assert len(glider_parts) == 3, f'Expected 3 parts for goblin_glider, got {len(glider_parts)}'
    glider_verts = sum(len(g.positions) for g, _, _ in glider_parts)
    assert glider_verts == 2491, f'Expected 2491 vertices for goblin_glider, got {glider_verts}'

    # Also verify GLB on disk matches
    glider_glb = VIEWER / 'assets/props/weapons/goblin_glider.glb'
    gltf_g, _ = parse_glb(glider_glb)
    assert len(gltf_g['meshes']) == 3
    acc_map_g = gltf_g['accessors']
    glb_glider_verts = sum(acc_map_g[m['primitives'][0]['attributes']['POSITION']]['count'] for m in gltf_g['meshes'])
    assert glb_glider_verts == 2491

    # 2. Tech 01: 3 parts, 305 vertices
    tech_igz = WORK / 'igz/pickups/tech_01.igz'
    assert tech_igz.is_file(), f'Missing {tech_igz}'
    reader_t = IGZReader(str(tech_igz))
    reader_t.read()
    alloc_t = IGZDataAllocator(reader_t)
    tech_parts = mua2_glb.walk_character(reader_t, alloc_t)
    assert len(tech_parts) == 3, f'Expected 3 parts for tech_01, got {len(tech_parts)}'
    tech_verts = sum(len(g.positions) for g, _, _ in tech_parts)
    assert tech_verts == 305, f'Expected 305 vertices for tech_01, got {tech_verts}'

    # Also verify GLB on disk matches
    tech_glb = VIEWER / 'assets/props/pickups/tech_01.glb'
    gltf_t, _ = parse_glb(tech_glb)
    assert len(gltf_t['meshes']) == 3
    acc_map_t = gltf_t['accessors']
    glb_tech_verts = sum(acc_map_t[m['primitives'][0]['attributes']['POSITION']]['count'] for m in gltf_t['meshes'])
    assert glb_tech_verts == 305

    print('PASS: Independent source-level verification passed for nested models (goblin_glider 3 parts 2491 verts, tech_01 3 parts 305 verts).')


def main() -> None:
    test_catalog_structure()
    test_all_exported_glbs()
    test_independent_nested_verification()
    print('\nALL PROPS REGRESSION TESTS PASSED.')


if __name__ == '__main__':
    main()
