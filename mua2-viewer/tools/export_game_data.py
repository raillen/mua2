#!/usr/bin/env python3
"""Export lossless XMLB trees and offset-based indices; never run game scripts."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from collections.abc import Iterator
from typing import Any

from xmlb_decode import decode_xmlb

ROOT = Path(__file__).resolve().parents[2]
ARCHIVES = ('conversations', 'dialogs', 'subtitles', 'data', 'packages')


def sha256_file(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def walk(tree: dict[str, Any]) -> Iterator[dict[str, Any]]:
    yield tree
    for child in tree['children']:
        yield from walk(child)


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'),
                               allow_nan=False) + '\n', encoding='utf-8')


def export_all(archives: Path, output: Path, extractor: Path) -> dict[str, Any]:
    if output.exists() or output.is_symlink():
        raise ValueError(f'Output already exists: {output}')
    # Preflight before extracting or writing; an incomplete run publishes nothing.
    for name in ARCHIVES:
        if not (archives / f'{name}.bin').is_file():
            raise FileNotFoundError(archives / f'{name}.bin')
    if not extractor.is_file():
        raise FileNotFoundError(extractor)
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        'format': 'mua2-gamedata-v1', 'sources': {}, 'files': {},
        'limitations': [
            'Static XMLB trees only; no runtime evaluation, interpolation or reference resolution.',
            'Child and attribute order, duplicates, offsets and all string values are preserved.',
            'Camera targets are not asserted to be speakers; branches are not a playback sequence.',
            'Source !BADREF and !BADFILE markers are retained, not repaired.',
            'data.bin catalog covers XMLB only, not its text .mua/.muc scripts or IGX files.',
        ],
    }
    # Stage beside output so directory publication is a same-filesystem rename.
    with tempfile.TemporaryDirectory(prefix='.gamedata-', dir=output.parent) as staging:
        staged = Path(staging) / 'catalogs'
        staged.mkdir()
        index: dict[str, list[dict[str, Any]]] = {'heroes': [], 'talents': []}
        for name in ARCHIVES:
            archive = archives / f'{name}.bin'
            archive_hash = sha256_file(archive)
            with tempfile.TemporaryDirectory(prefix='mua2-xmlb-') as extracted:
                source = Path(extracted)
                subprocess.run([str(extractor.resolve()), str(archive.resolve()), str(source)],
                               check=True, capture_output=True, text=True, timeout=120)
                records = []
                for path in sorted(source.rglob('*')):
                    if path.is_symlink():
                        raise ValueError(f'Unexpected extracted symlink: {path}')
                    if not path.is_file() or path.suffix.lower() not in ('.xmlb', '.pkgb', '.chrb', '.navb', '.engb', '.boyb'):
                        continue
                    relative = path.relative_to(source).as_posix()
                    raw = path.read_bytes()
                    tree = decode_xmlb(raw)
                    records.append({'sourcePath': relative, 'sourceSha256': hashlib.sha256(raw).hexdigest(),
                                    'bytes': len(raw), 'tree': tree})
                    if name == 'data':
                        group = ('heroes' if relative.startswith('stats/heroes/') else
                                 'talents' if relative.startswith('talents/') else None)
                        if group:
                            tag = 'stats' if group == 'heroes' else 'talent'
                            for node in walk(tree):
                                if node['tag'] == tag:
                                    index[group].append({'sourcePath': relative, 'offset': node['offset'],
                                                         'attributes': node['attributes']})
                if not records:
                    raise ValueError(f'No XMLB records in {archive}')
                if sha256_file(archive) != archive_hash:
                    raise ValueError(f'Archive changed during export: {archive}')
                filename = f'{name}.json'
                write_json(staged / filename, {'archive': archive.name, 'records': records})
                manifest['sources'][archive.name] = {'sha256': archive_hash, 'bytes': archive.stat().st_size}
                manifest['files'][filename] = {'entries': len(records)}
        write_json(staged / 'rpg_index.json', {'catalog': 'data.json', **index})
        manifest['files']['rpg_index.json'] = {key: len(value) for key, value in index.items()}
        for filename, info in manifest['files'].items():
            path = staged / filename
            info.update({'bytes': path.stat().st_size, 'sha256': sha256_file(path)})
        write_json(staged / 'manifest.json', manifest)
        if output.exists() or output.is_symlink():
            raise ValueError(f'Output appeared during export: {output}')
        staged.rename(output)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archives', type=Path, default=ROOT / '_work/extracted')
    parser.add_argument('--output', type=Path, default=ROOT / 'mua2-viewer/assets/data')
    parser.add_argument('--extractor', type=Path, default=Path(__file__).with_name('mua2bin'))
    args = parser.parse_args()
    manifest = export_all(args.archives, args.output, args.extractor)
    for filename, info in manifest['files'].items():
        print(f'{filename}: {info}')


if __name__ == '__main__':
    main()
