#!/usr/bin/env python3
"""Run with python3 mua2-viewer/tools/test_skinning_regression.py (needs source IGZs)."""
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from mua2_glb import extract_bms_indices, remap_joints
from repair_skinning import ROOT, MODELS, accessor, load_source, read_glb, repair


def rejects(call) -> None:
    try:
        call()
    except ValueError:
        return
    raise AssertionError('Expected fail-closed ValueError')


def main() -> None:
    bones = [{'blend': -1}, {'blend': 10}, {'blend': 20}]
    weights = [[0.5, 0.5, 0, 0]]
    assert np.array_equal(remap_joints([[0, 1, 999, -1]], weights, [20, 10], bones), [[2, 1, 0, 0]])
    rejects(lambda: remap_joints([[2, 1, 0, 0]], weights, [20, 10], bones))
    rejects(lambda: remap_joints([[-1, 1, 0, 0]], weights, [20, 10], bones))
    rejects(lambda: remap_joints([[0, 1, 0, 0]], weights, [999, 10], bones))
    rejects(lambda: remap_joints([[0, 1, 0, 0]], [], [20, 10], bones))
    rejects(lambda: extract_bms_indices(None, SimpleNamespace(
        global_offset=0, references={}, get_ref=lambda _: None)))
    truncated = SimpleNamespace(global_offset=0, type_name='igIntList',
                                read_u32=lambda _: 2, get_raw_ref=lambda _: 0)
    rejects(lambda: extract_bms_indices(SimpleNamespace(get_data_at=lambda *_: b'1234'),
        SimpleNamespace(global_offset=0, get_ref=lambda _: truncated)))

    source = ROOT / '_work/igz_actors/0901.igz'
    parts, bones, _ = load_source(source)
    assert len(parts) == 3
    geom, _, palette = parts[1]
    assert len(geom.positions) == 2282 and len(palette) == 50
    expected = remap_joints(geom.blend_indices, geom.blend_weights, palette, bones)
    data = (MODELS / 'spiderman.glb').read_bytes()
    doc, start, size = read_glb(data)
    joint_index = doc['meshes'][1]['primitives'][0]['attributes']['JOINTS_0']
    output, offset, _ = accessor(data, doc, start, size, joint_index, 5123, 'VEC4', len(expected))
    # Independent source palette + skeleton lookup, checked against actual GLB bytes.
    blend_to_joint = {bone['blend']: i for i, bone in enumerate(bones) if bone['blend'] >= 0}
    names, old_names = set(), set()
    for local, weights, joints in zip(geom.blend_indices, geom.blend_weights, output):
        for index, weight, joint in zip(local, weights, joints):
            if weight > 0:
                assert joint == blend_to_joint[palette[index]]
                names.add(bones[joint]['name'])
                old_names.add(bones[index]['name'])
    assert {'Bip01 L Thigh', 'Bip01 R Thigh', 'Bip01 L Calf', 'Bip01 R Calf'} <= names
    facial = ('brow', 'jaw', 'cheek', 'sneer', 'lip', 'eye')
    assert not any(word in name.lower() for name in names for word in facial)
    assert any(word in name.lower() for name in old_names for word in facial)
    assert np.array_equal(output, expected)
    assert repair(data, source, verify=True) == (data, 0, 3831)  # idempotent
    corrupt = bytearray(data)
    corrupt[offset:offset + 2] = b'\xff\xff'
    rejects(lambda: repair(bytes(corrupt), source))
    print('PASS: fail-closed inputs, actual Spider-Man source/output, thigh/calf not facial, idempotence, corrupt GLB refusal')


if __name__ == '__main__':
    main()
