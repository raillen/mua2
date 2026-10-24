#!/usr/bin/env python3
"""Validate actor correspondence and patch only JOINTS_0 bytes; default: verify.

python3 mua2-viewer/tools/repair_skinning.py --write
python3 mua2-viewer/tools/repair_skinning.py
"""
import argparse
import json
import os
from pathlib import Path
import struct
import tempfile

import numpy as np
from mua2_glb import IGZReader, IGZDataAllocator, walk_character, remap_joints
from mua2_skeleton import parse_skeleton

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / 'mua2-viewer/assets/models'


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_glb(data: bytes) -> tuple[dict, int, int]:
    require(len(data) >= 28, 'Truncated GLB')
    magic, version, length = struct.unpack_from('<III', data)
    require((magic, version, length) == (0x46546C67, 2, len(data)), 'Invalid GLB header')
    size, kind = struct.unpack_from('<II', data, 12)
    require(kind == 0x4E4F534A and size % 4 == 0 and 20 + size + 8 <= len(data), 'Invalid JSON chunk')
    doc = json.loads(data[20:20 + size])
    bin_size, kind = struct.unpack_from('<II', data, 20 + size)
    start = 28 + size
    require(kind == 0x004E4942 and bin_size % 4 == 0 and start + bin_size == len(data), 'Invalid BIN chunk')
    require(len(doc['buffers']) == 1 and 'uri' not in doc['buffers'][0], 'Expected one embedded buffer')
    require(0 <= bin_size - doc['buffers'][0]['byteLength'] <= 3, 'BIN length mismatch')
    return doc, start, doc['buffers'][0]['byteLength']


def accessor(data: bytes, doc: dict, start: int, bin_size: int, index: int,
             component: int, kind: str, count: int) -> tuple[np.ndarray, int, int]:
    acc = doc['accessors'][index]
    require(acc['componentType'] == component and acc['type'] == kind and acc['count'] == count,
            f'Accessor {index}: layout/count mismatch')
    require('sparse' not in acc and not acc.get('normalized'), f'Accessor {index}: unsupported encoding')
    view = doc['bufferViews'][acc['bufferView']]
    require(view.get('buffer', 0) == 0 and 'byteStride' not in view, 'Expected packed embedded accessor')
    dtype = {5123: '<u2', 5125: '<u4', 5126: '<f4'}[component]
    width = {'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'SCALAR': 1, 'MAT4': 16}[kind]
    size = count * width * np.dtype(dtype).itemsize
    relative = acc.get('byteOffset', 0)
    offset = view.get('byteOffset', 0) + relative
    require(relative >= 0 and relative + size <= view['byteLength'] and
            offset >= 0 and offset + size <= bin_size, f'Accessor {index}: out of bounds')
    return np.frombuffer(data, dtype=dtype, count=count * width, offset=start + offset).reshape(count, width), start + offset, size


def load_source(source: Path) -> tuple[list, list, list]:
    reader = IGZReader(str(source))
    reader.read()
    parts = walk_character(reader, IGZDataAllocator(reader))
    bones, _, matrices = parse_skeleton(reader)
    require(bool(parts) and bool(bones), f'{source}: missing geometry/skeleton')
    return parts, bones, matrices


def repair(data: bytes, source: Path, verify: bool = False) -> tuple[bytes, int, int]:
    doc, start, bin_size = read_glb(data)
    parts, bones, matrices = load_source(source)
    require(len(parts) == len(doc['meshes']), 'Source/GLB mesh count mismatch')
    require(len(doc.get('skins', [])) == 1, 'Expected exactly one skin')
    skin = doc['skins'][0]
    require([doc['nodes'][j]['name'] for j in skin['joints']] == [b['name'] for b in bones],
            'Skeleton joint order/name mismatch')
    ibm, _, _ = accessor(data, doc, start, bin_size, skin['inverseBindMatrices'], 5126, 'MAT4', len(bones))
    identity = np.eye(4, dtype='<f4').ravel()
    expected_ibm = np.array([matrices[b['blend']] if 0 <= b['blend'] < len(matrices) else identity for b in bones], dtype='<f4')
    require(np.array_equal(ibm, expected_ibm), 'Inverse bind matrices mismatch')
    patches = []
    changed = 0
    vertices = 0
    for mi, ((geom, _, palette), mesh) in enumerate(zip(parts, doc['meshes'])):
        require(len(mesh['primitives']) == 1, f'Mesh {mi}: expected one primitive')
        prim = mesh['primitives'][0]
        require(prim.get('mode', 4) == 4, 'Expected triangle primitive')
        attrs = prim['attributes']
        count = len(geom.positions)
        pos, _, _ = accessor(data, doc, start, bin_size, attrs['POSITION'], 5126, 'VEC3', count)
        indices, _, _ = accessor(data, doc, start, bin_size, prim['indices'], 5125, 'SCALAR', len(geom.indices))
        require(np.array_equal(pos, np.array(geom.positions, dtype='<f4')), f'Mesh {mi}: position mismatch')
        require(np.array_equal(indices.ravel(), geom.indices), f'Mesh {mi}: triangle mismatch')
        joints, offset, size = accessor(data, doc, start, bin_size, attrs['JOINTS_0'], 5123, 'VEC4', count)
        weights, _, _ = accessor(data, doc, start, bin_size, attrs['WEIGHTS_0'], 5126, 'VEC4', count)
        source_weights = np.array(geom.blend_weights, dtype='<f4')
        require(source_weights.shape == weights.shape, f'Mesh {mi}: weight count mismatch')
        # Existing exports kept raw weights; newer exports normalize each row.
        sums = source_weights.sum(axis=1, keepdims=True)
        normalized = source_weights / np.where(sums > 1e-6, sums, 1.0)
        require(np.array_equal(weights, source_weights) or np.array_equal(weights, normalized),
                f'Mesh {mi}: weight mismatch')
        expected = remap_joints(geom.blend_indices, geom.blend_weights, palette, bones)
        require(expected.shape == joints.shape, f'Mesh {mi}: joint count mismatch')
        raw = np.array(geom.blend_indices, dtype='<u2')
        mapped = np.array_equal(joints, expected)
        require(mapped or (not verify and np.array_equal(joints, raw)),
                f'Mesh {mi}: JOINTS_0 is neither source-local nor correctly remapped')
        require(np.all(expected < len(bones)), f'Mesh {mi}: joint outside skin')
        # Refuse aliases: a joint write must not mutate another accessor/image.
        joint_view = doc['accessors'][attrs['JOINTS_0']]['bufferView']
        for ai, acc in enumerate(doc['accessors']):
            require(ai == attrs['JOINTS_0'] or acc.get('bufferView') != joint_view, 'Aliased joint accessor')
        for vi, view in enumerate(doc['bufferViews']):
            lo = start + view.get('byteOffset', 0)
            hi = lo + view['byteLength']
            require(vi == joint_view or hi <= offset or lo >= offset + size, 'Overlapping joint buffer view')
        require(all(image.get('bufferView') != joint_view for image in doc.get('images', [])), 'Joint/image alias')
        patches.append((offset, expected.tobytes()))
        changed += not mapped
        vertices += count
    output = bytearray(data)
    end = 0
    for offset, blob in sorted(patches):
        require(offset >= end, 'Overlapping joint patches')
        require(output[end:offset] == data[end:offset], 'Non-joint bytes changed')
        output[offset:offset + len(blob)] = blob
        end = offset + len(blob)
    require(output[end:] == data[end:] and len(output) == len(data), 'Non-joint bytes changed')
    return bytes(output), changed, vertices


def atomic_write(path: Path, original: bytes, output: bytes) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, path.stat().st_mode & 0o777)
        require(path.read_bytes() == original, f'{path}: changed during repair; refusing overwrite')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='apply repair after preflight')
    parser.add_argument('--verify', action='store_true', help='assert that all models are already repaired')
    parser.add_argument('--work', type=Path, default=Path(os.environ.get('MUA2_WORK', ROOT / '_work')))
    args = parser.parse_args()
    models = json.loads((MODELS / 'models.json').read_text())['models']
    paths = [MODELS / Path(m['file'].split('?')[0]).name for m in models]
    require(len(paths) == len(set(paths)), 'Duplicate model paths')
    require(set(paths) == set(MODELS.glob('*.glb')), 'Manifest does not cover every GLB')
    sources = [args.work / 'igz_actors' / (Path(m['source']).stem + '.igz') for m in models]
    # Validate the whole set before writing anything. No model ID filtering.
    changed = vertices = 0
    for path, source in zip(paths, sources):
        try:
            _, count, verts = repair(path.read_bytes(), source, verify=args.verify)
        except (ValueError, KeyError, OSError, struct.error) as error:
            raise ValueError(f'{path.name}: {error}') from error
        changed += count
        vertices += verts
    print(f'Preflight: {len(paths)} models, {vertices} vertices, {changed} meshes need repair', flush=True)
    if args.write:
        written = 0
        for path, source in zip(paths, sources):
            original = path.read_bytes()
            output, count, _ = repair(original, source)
            if count:
                repair(output, source, verify=True)
                atomic_write(path, original, output)
                written += 1
        print(f'Repair complete: {written} files updated; only JOINTS_0 accessor bytes replaced')
    elif args.verify:
        print('Verified: every JOINTS_0 in all 184 models matches expected remapped palette and skeleton bones')


if __name__ == '__main__':
    main()
