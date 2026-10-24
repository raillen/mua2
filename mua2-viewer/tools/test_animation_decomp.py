#!/usr/bin/env python3
"""Regression test suite for Havok HKX animation decompilation and viewer binding."""
import json
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parents[2]
VIEWER_DIR = REPO_ROOT / 'mua2-viewer'
sys.path.insert(0, str(VIEWER_DIR / 'tools'))

from hkx_packfile import Packfile, extract_animation_clips
from hkx_spline import SplineDecompressor, normalize_quaternion


def test_hkx_decompilation():
    hkx_path = REPO_ROOT / '_work/igz_anims/09_spiderman.hkx'
    assert hkx_path.exists(), f"Missing {hkx_path}"

    pk = Packfile(hkx_path)
    assert len(pk.sections) == 3
    assert pk.sections[0]['name'] == '__classnames__'
    assert pk.sections[1]['name'] == '__types__'
    assert pk.sections[2]['name'] == '__data__'

    clips = extract_animation_clips(pk)
    assert len(clips) == 17, f"Expected 17 clips in base HKX, got {len(clips)}"

    for c in clips:
        decomp = SplineDecompressor(c)
        assert len(decomp.tracks) == c.num_tracks
        assert decomp.control_quaternion_norm_error < 1e-6
        # Test evaluation at boundary frames
        for tr in decomp.tracks:
            q0 = normalize_quaternion(tr.rotation.value(0.0))
            q1 = normalize_quaternion(tr.rotation.value(float(c.num_frames - 1)))
            assert len(q0) == 4 and len(q1) == 4

    print("PASS: Havok 6.1 packfile extraction and spline decompression")


def test_exported_json():
    json_path = VIEWER_DIR / 'assets/animations/spiderman.json'
    assert json_path.exists(), f"Missing {json_path}"

    data = json.loads(json_path.read_text())
    assert data.get('format') == 'mua2-authentic-havok-v1'
    assert data.get('character') == 'spiderman'
    assert data.get('clip_count', 0) >= 17

    clip_names = {c['name'] for c in data['clips']}
    for expected in ('idle', 'walk', 'run', 'menu_idle', 'menu_action'):
        assert expected in clip_names, f"Expected clip {expected} in export"

    idle = next(c for c in data['clips'] if c['name'] == 'idle')
    assert len(idle['times']) == idle.get('num_frames', len(idle['times']))
    assert len(idle['tracks']) > 50

    print(f"PASS: Authentic animation JSON verified ({len(clip_names)} clips)")


def test_no_procedural_code():
    anim_js = (VIEWER_DIR / 'src/animations.js').read_text()
    banned = [
        'createIdleClip',
        'createWalkClip',
        'createCombatClip',
        'createAttackClip',
        'createHeroicClip',
        'Math.sin',
        'Math.cos',
        'qRot',
    ]
    for symbol in banned:
        assert symbol not in anim_js, f"Banned procedural symbol '{symbol}' found in animations.js"

    print("PASS: Zero procedural animation generators in viewer code")


if __name__ == '__main__':
    test_hkx_decompilation()
    test_exported_json()
    test_no_procedural_code()
    print("ALL TESTS PASSED.")
