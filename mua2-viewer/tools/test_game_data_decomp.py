#!/usr/bin/env python3
"""Regression test suite for authentic MUA2 game data decompilation."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / 'mua2-viewer/assets/data'
WORK_DIR = ROOT / '_work/extracted'


def sha256_file(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def test_manifest_provenance() -> None:
    manifest_path = DATA_DIR / 'manifest.json'
    assert manifest_path.is_file(), f'Manifest missing at {manifest_path}'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    assert manifest['format'] == 'mua2-gamedata-v1'

    for source_name, source_info in manifest['sources'].items():
        bin_path = WORK_DIR / source_name
        assert bin_path.is_file(), f'Source archive {source_name} missing'
        actual_hash = sha256_file(bin_path)
        assert actual_hash == source_info['sha256'], f'Hash mismatch on {source_name}'
        assert bin_path.stat().st_size == source_info['bytes'], f'Size mismatch on {source_name}'

    for file_name, file_info in manifest['files'].items():
        exported_path = DATA_DIR / file_name
        assert exported_path.is_file(), f'Exported catalog {file_name} missing'
        actual_hash = sha256_file(exported_path)
        assert actual_hash == file_info['sha256'], f'Hash mismatch on {file_name}'
        assert exported_path.stat().st_size == file_info['bytes'], f'Size mismatch on {file_name}'


def test_conversations_decomp() -> None:
    conv_path = DATA_DIR / 'conversations.json'
    data = json.loads(conv_path.read_text(encoding='utf-8'))
    assert data['archive'] == 'conversations.bin'
    records = {r['sourcePath']: r for r in data['records']}
    assert len(records) == 318, f'Expected 318 conversations, got {len(records)}'

    # Check civil war choice for Spider-Man
    spidey_convo = records.get('civilwarchoice/choiceprospiderman.xmlb')
    assert spidey_convo is not None, 'choiceprospiderman.xmlb missing'
    tree = spidey_convo['tree']
    assert tree['tag'] == 'conversation'

    # Verify line text and body anim preservation
    lines = []
    def collect(node: dict) -> None:
        if node['tag'] in ('line', 'response'):
            lines.append(dict(node['attributes']))
        for child in node['children']:
            collect(child)
    collect(tree)

    spidey_turns = [l for l in lines if 'SpiderMan' in (l.get('linecamtarget', ''), l.get('respcamtarget', ''))]
    assert any('conv_expos_03' == l.get('linebodyanim') for l in spidey_turns), 'Line body anim missing'
    assert any('prison orange' in l.get('text', '') for l in spidey_turns), 'Dialogue line text corrupted'


def test_dialogs_and_subtitles() -> None:
    diag_path = DATA_DIR / 'dialogs.json'
    data_d = json.loads(diag_path.read_text(encoding='utf-8'))
    assert len(data_d['records']) == 7
    heli_fury = next((r for r in data_d['records'] if 'fury_1.xmlb' in r['sourcePath']), None)
    assert heli_fury is not None
    dialog_node = heli_fury['tree']['children'][0]
    attrs = dict(dialog_node['attributes'])
    assert 'Colonel Nick Fury' in attrs.get('text', '')

    sub_path = DATA_DIR / 'subtitles.json'
    data_s = json.loads(sub_path.read_text(encoding='utf-8'))
    assert len(data_s['records']) == 19
    sample_sub = data_s['records'][0]['tree']
    assert sample_sub['tag'] == 'SubTitles'
    assert len(sample_sub['children']) > 0
    item_attrs = dict(sample_sub['children'][0]['attributes'])
    assert '!BADFILE:' in item_attrs.get('text', ''), 'Authentic !BADFILE token must not be synthesized'


def test_data_rpg_catalogs() -> None:
    data_path = DATA_DIR / 'data.json'
    data_raw = json.loads(data_path.read_text(encoding='utf-8'))
    assert len(data_raw['records']) == 490

    # charinfo.xmlb check
    charinfo_rec = next((r for r in data_raw['records'] if r['sourcePath'] == 'charinfo.xmlb'), None)
    assert charinfo_rec is not None
    heroes_in_charinfo = [dict(c['attributes'])['name'] for c in charinfo_rec['tree']['children']]
    assert 'SpiderMan' in heroes_in_charinfo
    assert 'Wolverine' in heroes_in_charinfo
    assert len(heroes_in_charinfo) == 30

    # Spider-Man stats record check
    spidey_stats = next((r for r in data_raw['records'] if r['sourcePath'] == 'stats/heroes/spiderman.xmlb'), None)
    assert spidey_stats is not None
    s_attrs = dict(spidey_stats['tree']['children'][0]['attributes'])
    assert s_attrs['skin'] == '0901', 'Leading zeros must be preserved'
    assert s_attrs['skin_01_name'] == 'Classic'
    assert s_attrs['characteranims'] == '09_spiderman'
    assert s_attrs['powerstyle'] == 'ps_spiderman'
    assert s_attrs['strength'] == '7'

    # Talents check
    spidey_talents = next((r for r in data_raw['records'] if r['sourcePath'] == 'talents/spiderman.xmlb'), None)
    assert spidey_talents is not None
    t_names = [dict(c['attributes']).get('descname') for c in spidey_talents['tree']['children']]
    assert 'Web Barrage' in t_names
    assert 'Web Mace' in t_names

    # Team bonus check
    team_rec = next((r for r in data_raw['records'] if r['sourcePath'] == 'team_bonus.xmlb'), None)
    assert team_rec is not None
    assert len(team_rec['tree']['children']) == 30


def test_packages_chrb_and_pkgb() -> None:
    pkg_path = DATA_DIR / 'packages.json'
    data_p = json.loads(pkg_path.read_text(encoding='utf-8'))
    assert len(data_p['records']) == 965
    spidey_pkg = next((r for r in data_p['records'] if 'characters/spiderman_0901.pkgb' in r['sourcePath']), None)
    assert spidey_pkg is not None
    assert spidey_pkg['tree']['tag'] == 'packagedef'


def test_rpg_index() -> None:
    index_path = DATA_DIR / 'rpg_index.json'
    index = json.loads(index_path.read_text(encoding='utf-8'))
    assert index['catalog'] == 'data.json'
    assert len(index['heroes']) == 32
    assert len(index['talents']) == 352

    # Verify that indexed offsets match actual nodes in data.json
    data_path = DATA_DIR / 'data.json'
    data_records = {r['sourcePath']: r for r in json.loads(data_path.read_text(encoding='utf-8'))['records']}

    for entry in index['heroes'][:10]:
        rec = data_records[entry['sourcePath']]
        tree = rec['tree']
        stats_node = tree['children'][0]
        assert stats_node['offset'] == entry['offset']
        assert stats_node['attributes'] == entry['attributes']


def run_all_tests() -> None:
    test_manifest_provenance()
    print('  PASS: test_manifest_provenance')
    test_conversations_decomp()
    print('  PASS: test_conversations_decomp')
    test_dialogs_and_subtitles()
    print('  PASS: test_dialogs_and_subtitles')
    test_data_rpg_catalogs()
    print('  PASS: test_data_rpg_catalogs')
    test_packages_chrb_and_pkgb()
    print('  PASS: test_packages_chrb_and_pkgb')
    test_rpg_index()
    print('  PASS: test_rpg_index')
    print('\nAll game data decompilation tests passed successfully!')


if __name__ == '__main__':
    run_all_tests()
