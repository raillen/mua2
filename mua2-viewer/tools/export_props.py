#!/usr/bin/env python3
"""Export only the initial, source-backed MUA2 props scope (no scene assets)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import tempfile
from typing import Any

import mua2_glb
from mua2_skeleton import parse_skeleton

ROOT = Path(__file__).resolve().parents[2]
SCOPE = ('weapons', 'common', 'pickups', 'bolton')
CATEGORIES = {
    'weapons': ('Armas', '#d58b58'),
    'common': ('Objetos comuns', '#7ca6ba'),
    'pickups': ('Coletáveis', '#c7b564'),
    'bolton': ('Acessórios', '#ae8cbb'),
}
UNSUPPORTED = [
    'Game shaders are not reproduced; GLB materials are a diffuse/normal PBR approximation.',
    'Specular, cubemap/reflection, masks and additional texture units are not exported.',
    'Shader parameters, material/vertex colors, blend states, emissive effects and procedural effects are not reproduced.',
    'Transform sequences and animation are not exported; this is static geometry.',
]


def sha256_file(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    """Publish a catalog only after its complete JSON has reached the same directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def texture_source(path: Path, work: Path) -> str:
    # Do not publish machine-specific absolute paths in the catalog.
    return path.resolve().relative_to(work.resolve()).as_posix()


def inspect_source(source: Path, work: Path) -> tuple[dict[str, Any], list[tuple[Any, Any, Any]]]:
    reader = mua2_glb.IGZReader(str(source))
    reader.read()
    parts = mua2_glb.walk_character(reader, mua2_glb.IGZDataAllocator(reader))
    if not parts:
        raise ValueError('no geometry found')
    bones, _, _ = parse_skeleton(reader)
    if bones:
        raise ValueError(f'skeleton present ({len(bones)} bones); static props export refuses skin loss')

    bindings = []
    unresolved = []
    for attr in reader.get_objects_by_type('igTextureBindAttr2'):
        unit = struct.unpack_from('<Q', attr.raw_data, 0x10)[0] & 0xffff
        texture = attr.get_ref(0x18)
        handle = struct.unpack_from('<Q', texture.raw_data, 0x48)[0] if texture else None
        info = mua2_glb.find_texture(handle) if handle is not None else None
        binding = {'unit': unit, 'handle': f'{handle:016x}' if handle is not None else None,
                   'resolved': info is not None}
        if info:
            binding['source'] = texture_source(Path(info['file']), work)
        bindings.append(binding)
        if unit == 0 and not info:
            unresolved.append(binding)
    if unresolved:
        raise ValueError('unresolved diffuse binding: ' + json.dumps(unresolved, sort_keys=True))

    used = {}
    limitations = []
    missing_diffuse = [i for i, (_, tex, _) in enumerate(parts) if 0 not in tex]
    if missing_diffuse:
        limitations.append({'code': 'source_material_without_diffuse', 'parts': missing_diffuse,
                            'detail': 'No diffuse binding supplied for these parts. Source geometry retained; material colors/effects are not reconstructed, not a missing-texture substitute.'})
    for part_index, (_, tex, _) in enumerate(parts):
        for unit, kind in ((0, 'd'), (1, 'n')):
            if unit not in tex:
                continue
            info = tex[unit]
            if mua2_glb.decode_texture(info, kind, invert_green=True) is None:
                if unit == 0:
                    raise ValueError(f'unsupported diffuse format {info["format"]!r} in part {part_index}')
                limitations.append({'code': 'unsupported_normal_format', 'part': part_index,
                                    'format': info['format']})
                continue
            key = (info['file'], kind)
            if key not in used:
                path = Path(info['file'])
                used[key] = {'source': texture_source(path, work), 'sha256': sha256_file(path),
                             'kind': 'diffuse' if unit == 0 else 'normal', 'unit': unit,
                             'format': info['format'], 'parts': []}
            used[key]['parts'].append(part_index)
    ignored = sorted({b['unit'] for b in bindings} - {0, 1})
    if ignored:
        limitations.append({'code': 'unsupported_texture_units', 'units': ignored})
    return {'source_bones': len(bones), 'source_geometry_objects': len(reader.get_objects_by_type('igGeometry')),
            'source_attribute_types': sorted({o.type_name for o in reader.objects.values() if o.type_name.endswith('Attr')}),
            'texture_bindings': bindings, 'texture_sources': list(used.values()),
            'limitations': limitations}, parts


def export_props(work: Path, output: Path) -> dict[str, Any]:
    sources = sorted(path for category in SCOPE for path in (work / 'igz' / category).rglob('*.igz'))
    for category in SCOPE:
        if not (work / 'igz' / category).is_dir():
            raise FileNotFoundError(work / 'igz' / category)
    output.mkdir(parents=True, exist_ok=True)
    catalog: dict[str, Any] = {
        'format': 'mua2-props-v1',
        'scope': {'categories': list(SCOPE), 'source_root': 'models', 'source_count': len(sources),
                  'excludes': 'All other models categories / scene assets'},
        'export': {'skeleton': False, 'normalize': True, 'max_texture': 0, 'use_spec': False,
                   'invert_green': True, 'unsupported_shader_effects': UNSUPPORTED},
        'texture_index_sha256': sha256_file(Path(mua2_glb.TEX_INDEX_PATH)),
        'exporter_sha256': sha256_file(Path(mua2_glb.__file__)),
        'models': [], 'skipped': [],
    }
    for source in sources:
        relative = source.relative_to(work / 'igz')
        identifier = relative.with_suffix('').as_posix()
        category = relative.parts[0]
        base = {'id': identifier, 'source': f'models/{relative.as_posix()}',
                'source_sha256': sha256_file(source), 'source_bytes': source.stat().st_size}
        temporary = None
        try:
            audit, _ = inspect_source(source, work)
            target = output / relative.with_suffix('.glb')
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f'.{target.stem}.', suffix='.glb', dir=target.parent)
            os.close(fd)
            info = mua2_glb.export_glb(str(source), temporary, identifier, skeleton=False, normalize=True)
            if info['textures'] != len(audit['texture_sources']):
                raise ValueError(f'texture count mismatch: exported {info["textures"]}, audited {len(audit["texture_sources"])}')
            with open(temporary, 'rb') as stream:
                os.fsync(stream.fileno())
            digest = sha256_file(Path(temporary))
            os.replace(temporary, target)
            name = re.sub(r'[_-]+', ' ', source.stem).strip().title()
            catalog['models'].append({**base, 'name': name, 'category': category,
                                      'costume': CATEGORIES[category][0], 'accent': CATEGORIES[category][1],
                                      'file': f'assets/props/{relative.with_suffix(".glb").as_posix()}',
                                      **{key: info[key] for key in ('parts', 'verts', 'tris', 'textures', 'size')},
                                      'sha256': digest, **audit})
            print(f'OK {identifier}: {info["parts"]} parts, {info["verts"]} verts, {info["textures"]} textures', flush=True)
        except (OSError, ValueError, KeyError, RuntimeError, struct.error) as error:
            catalog['skipped'].append({**base, 'reason': str(error), 'error_type': type(error).__name__})
            print(f'SKIP {identifier}: {error}', flush=True)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    atomic_json(output / 'props.json', catalog)
    return catalog


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, default=Path(os.environ.get('MUA2_WORK', ROOT / '_work')))
    parser.add_argument('--output', type=Path, default=ROOT / 'mua2-viewer/assets/props')
    args = parser.parse_args()
    result = export_props(args.work, args.output)
    print(f'{len(result["models"])} exported; {len(result["skipped"])} skipped; {args.output / "props.json"}')


if __name__ == '__main__':
    main()
