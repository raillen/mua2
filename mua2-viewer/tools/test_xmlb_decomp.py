#!/usr/bin/env python3
"""Regression suite for XMLB decoding."""
from __future__ import annotations

import struct
import tempfile
from pathlib import Path

from xmlb_decode import decode_xmlb, export_directory

ROOT = Path(__file__).resolve().parents[2]


def build_minimal_xmlb() -> bytes:
    data = bytearray(struct.pack('<II', 0x11B1, 1))
    # Element: name=offset, next=-1, child=-1, count=1
    name_pos = 8 + 16 + 8
    key_pos = name_pos + len('hero') + 1
    val_pos = key_pos + len('id') + 1
    data.extend(struct.pack('<IiiI', name_pos, -1, -1, 1))
    data.extend(struct.pack('<II', key_pos, val_pos))
    data.extend(b'hero\0' + b'id\0' + b'0901\0')
    return bytes(data)


def test_xmlb_magic_and_size_bounds():
    try:
        decode_xmlb(b'short')
        assert False, 'Must reject short data'
    except ValueError:
        pass
    bad_magic = struct.pack('<II', 0x1234, 1) + b'\0' * 20
    try:
        decode_xmlb(bad_magic)
        assert False, 'Must reject invalid magic'
    except ValueError:
        pass
    bad_version = struct.pack('<II', 0x11B1, 2) + b'\0' * 20
    try:
        decode_xmlb(bad_version)
        assert False, 'Must reject invalid version'
    except ValueError:
        pass


def test_xmlb_minimal_decode():
    raw = build_minimal_xmlb()
    tree = decode_xmlb(raw)
    assert tree['tag'] == 'hero'
    assert tree['attributes'] == [['id', '0901']], 'Strings must not be coerced to numbers'
    assert tree['children'] == []


def test_xmlb_cycle_and_offset_bounds():
    # Construct a cycle: root child points to itself (offset 8)
    data = bytearray(struct.pack('<II', 0x11B1, 1))
    name_pos = 8 + 16
    data.extend(struct.pack('<IiiI', name_pos, -1, 8, 0))
    data.extend(b'root\0')
    try:
        decode_xmlb(bytes(data))
        assert False, 'Must reject cycle'
    except ValueError:
        pass


def test_xmlb_authentic_data_bin_files():
    data_dir = Path('/tmp/opencode/all_data_bin')
    if not data_dir.is_dir():
        return
    # Check charinfo.xmlb
    charinfo_path = data_dir / 'charinfo.xmlb'
    if charinfo_path.is_file():
        tree = decode_xmlb(charinfo_path.read_bytes())
        assert tree['tag'] == 'herolist'
        hero_names = [attr[1] for c in tree['children'] for attr in c['attributes'] if attr[0] == 'name']
        assert 'SpiderMan' in hero_names
        assert 'Wolverine' in hero_names

    # Check spiderman.xmlb
    spidey_path = data_dir / 'stats/heroes/spiderman.xmlb'
    if spidey_path.is_file():
        tree = decode_xmlb(spidey_path.read_bytes())
        assert tree['tag'] == 'characters'
        stats = tree['children'][0]
        attr_map = dict(stats['attributes'])
        assert attr_map['skin'] == '0901', 'Leading zeros must be preserved'
        assert attr_map['characteranims'] == '09_spiderman'
        assert attr_map['powerstyle'] == 'ps_spiderman'


def test_xmlb_export_directory_manifest():
    with tempfile.TemporaryDirectory() as tmp_src, tempfile.TemporaryDirectory() as tmp_out:
        src = Path(tmp_src)
        out = Path(tmp_out) / 'decompiled'
        (src / 'sub').mkdir()
        (src / 'sub/sample.xmlb').write_bytes(build_minimal_xmlb())
        manifest = export_directory(src, out)
        assert manifest['format'] == 'mua2-xmlb-v1'
        assert len(manifest['files']) == 1
        assert manifest['files'][0]['sourcePath'] == 'sub/sample.xmlb'
        assert (out / 'sub/sample.xmlb.json').is_file()


def run_all_tests():
    test_xmlb_magic_and_size_bounds()
    print('  PASS: test_xmlb_magic_and_size_bounds')
    test_xmlb_minimal_decode()
    print('  PASS: test_xmlb_minimal_decode')
    test_xmlb_cycle_and_offset_bounds()
    print('  PASS: test_xmlb_cycle_and_offset_bounds')
    test_xmlb_authentic_data_bin_files()
    print('  PASS: test_xmlb_authentic_data_bin_files')
    test_xmlb_export_directory_manifest()
    print('  PASS: test_xmlb_export_directory_manifest')
    print('\nAll XMLB decompilation tests passed successfully!')


if __name__ == '__main__':
    run_all_tests()
