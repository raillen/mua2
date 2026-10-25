#!/usr/bin/env python3
"""Decode Raven XMLB v1 without executing scripts or coercing string values.

Layout reference: tools-vendor/igb-blender/mapmaker/xmlb.py. Attribute pairs
and child order remain lists so duplicate names cannot silently disappear.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[2]


def decode_xmlb(data: bytes) -> dict:
    if len(data) < 24 or len(data) > 64 * 1024 * 1024:
        raise ValueError('Invalid XMLB size (24 bytes to 64 MiB required)')
    if struct.unpack_from('<II', data) != (0x11B1, 1):
        raise ValueError('Expected Raven XMLB magic 0x11B1, version 1')
    visited: set[int] = set()
    records: list[tuple[int, int]] = []
    strings: dict[int, str] = {}

    def string(offset: int) -> str:
        if not 8 <= offset < len(data):
            raise ValueError(f'String offset outside file: {offset}')
        if offset not in strings:
            end = data.find(b'\0', offset)
            if end < 0:
                raise ValueError(f'Unterminated string at {offset}')
            strings[offset] = data[offset:end].decode('cp1252')
        return strings[offset]

    def element(offset: int, depth: int) -> tuple[dict, int]:
        if depth > 128:
            raise ValueError('XMLB nesting exceeds 128 levels')
        if offset in visited:
            raise ValueError(f'Cyclic or shared element at {offset}')
        if offset < 8 or offset + 16 > len(data):
            raise ValueError(f'Element offset outside file: {offset}')
        visited.add(offset)
        name, sibling, child, count = struct.unpack_from('<IiiI', data, offset)
        end = offset + 16 + count * 8
        if end > len(data):
            raise ValueError(f'Attribute table outside file at {offset}')
        records.append((offset, end))
        attributes = []
        for pos in range(offset + 16, end, 8):
            key, value = struct.unpack_from('<II', data, pos)
            attributes.append([string(key), string(value)])
        node = {'offset': offset, 'tag': string(name), 'attributes': attributes, 'children': []}
        while child != -1:
            item, child = element(child, depth + 1)
            node['children'].append(item)
        return node, sibling

    root, sibling = element(8, 0)
    if sibling != -1:
        raise ValueError('Unexpected root sibling')
    records.sort()
    for previous, current in zip(records, records[1:]):
        if previous[1] > current[0]:
            raise ValueError('Overlapping element records')
    # XMLB v1 stores its string table after all element/attribute records.
    if min(strings) < records[-1][1]:
        raise ValueError('String table overlaps element records')
    return root


def export_directory(source: Path, output: Path, archive: Path | None = None) -> dict:
    if not source.is_dir():
        raise ValueError(f'Extracted source directory missing: {source}')
    if output.exists():
        raise ValueError(f'Output already exists: {output}')
    paths = sorted(p for p in source.rglob('*')
                   if p.suffix.lower() in ('.xmlb', '.pkgb', '.navb', '.engb', '.chrb', '.boyb'))
    if not paths:
        raise ValueError(f'No XMLB files found in {source}')
    manifest = {'format': 'mua2-xmlb-v1', 'files': [], 'limitations': [
        'Static serialized data only; scripts, conditions and runtime events are not executed.',
        'Values retain source spelling and remain strings; references are not inferred.',
    ]}
    if archive is not None:
        manifest['archive'] = {'name': archive.name,
                               'sha256': hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()}
    # Decode everything before creating output, so malformed inputs leave no partial export.
    decoded = []
    for path in paths:
        if path.is_symlink() or not path.resolve().is_relative_to(source.resolve()):
            raise ValueError(f'Source symlink not permitted: {path}')
        data = path.read_bytes()
        relative = path.relative_to(source).as_posix()
        tree = decode_xmlb(data)
        target = relative + '.json'
        decoded.append((target, tree))
        manifest['files'].append({'sourcePath': relative, 'sourceSha256': hashlib.sha256(data).hexdigest(),
                                  'bytes': len(data), 'output': target, 'rootTag': tree['tag']})
    output.mkdir(parents=True)
    for target, tree in decoded:
        destination = output / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(tree, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='directory already extracted by mua2bin')
    parser.add_argument('output', type=Path, help='new output directory (never overwritten)')
    parser.add_argument('--archive', type=Path, help='original archive to hash for provenance')
    args = parser.parse_args()
    manifest = export_directory(args.source, args.output, args.archive)
    print(f"Decoded {len(manifest['files'])} files into {args.output}")


if __name__ == '__main__':
    main()
