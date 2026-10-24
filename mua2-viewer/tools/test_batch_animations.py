#!/usr/bin/env python3
"""Verification test suite for batch exported Havok animations and manifest routing."""
import json
from pathlib import Path
import re
import sys

REPO_ROOT = Path(__file__).resolve().parents[2]
VIEWER_DIR = REPO_ROOT / 'mua2-viewer'
ANIM_DIR = VIEWER_DIR / 'assets/animations'


def test_manifest_coverage():
    sources_path = VIEWER_DIR / 'tools/animation_sources.json'
    manifest_path = ANIM_DIR / 'index.json'

    assert sources_path.is_file(), f"Missing {sources_path}"
    assert manifest_path.is_file(), f"Missing {manifest_path}"

    sources = json.loads(sources_path.read_text())
    manifest = json.loads(manifest_path.read_text())

    assert len(manifest) == 184, f"Expected 184 entries in index.json, got {len(manifest)}"
    assert set(manifest.keys()) == set(sources.keys()), "Manifest keys mismatch with animation_sources.json"

    empty_sources = {k for k, v in sources.items() if not v}
    mapped_sources = {k for k, v in sources.items() if bool(v)}

    assert len(empty_sources) == 51, f"Expected 51 empty models, got {len(empty_sources)}"
    assert len(mapped_sources) == 133, f"Expected 133 mapped models, got {len(mapped_sources)}"

    # Check null mapping for empty models
    for k in empty_sources:
        assert manifest[k] is None, f"Empty model {k} must map to null in index.json"

    # Check valid canonical JSON for mapped models
    canonical_files = set()
    for k in mapped_sources:
        target = manifest[k]
        assert target is not None, f"Mapped model {k} must have non-null target in index.json"
        assert target.endswith('.json'), f"Target {target} must be .json file"
        target_path = ANIM_DIR / target
        assert target_path.is_file(), f"Canonical animation file {target} missing for model {k}"
        canonical_files.add(target)

    assert len(canonical_files) == 95, f"Expected 95 canonical export files, got {len(canonical_files)}"
    print(f"PASS: 184 manifest entries verified (133 mapped to 95 canonical files, 51 null)")


def test_canonical_json_structure():
    manifest_path = ANIM_DIR / 'index.json'
    manifest = json.loads(manifest_path.read_text())
    canonical_files = sorted({v for v in manifest.values() if v is not None})

    for cfile in canonical_files:
        cpath = ANIM_DIR / cfile
        data = json.loads(cpath.read_text())

        assert data.get('format') == 'mua2-authentic-havok-v1', f"Invalid format in {cfile}"
        assert 'character' in data, f"Missing character in {cfile}"
        assert 'provenance' in data, f"Missing provenance in {cfile}"
        assert 'clips' in data and isinstance(data['clips'], list), f"Missing clips list in {cfile}"
        assert data.get('clip_count') == len(data['clips']), f"Clip count mismatch in {cfile}"
        assert len(data['clips']) > 0, f"Zero clips in {cfile}"

        # Check first and last clips for track validity
        for clip in (data['clips'][0], data['clips'][-1]):
            assert clip.get('name'), f"Clip missing name in {cfile}"
            dur = clip.get('duration')
            assert isinstance(dur, (int, float)) and dur > 0, f"Invalid duration in {cfile}:{clip.get('name')}"
            times = clip.get('times', [])
            assert len(times) > 0, f"Missing times array in {cfile}:{clip.get('name')}"

            tracks = clip.get('tracks', [])
            assert len(tracks) > 0, f"No tracks in {cfile}:{clip.get('name')}"

            for tr in tracks:
                bname = tr.get('bone', '')
                assert bname, f"Empty bone name in {cfile}:{clip.get('name')}"
                lower = bname.lower()
                assert lower != 'motion' and not lower.endswith('nub'), f"Excluded bone {bname} found in {cfile}"

                # Validate quaternion array vs rotTimes
                if 'quaternions' in tr:
                    r_times = tr.get('rotTimes') or tr.get('times') or times
                    assert len(tr['quaternions']) == len(r_times) * 4, f"Quat count mismatch in {cfile}:{bname}"

                # Validate position array vs posTimes
                if 'positions' in tr:
                    p_times = tr.get('posTimes') or tr.get('times') or times
                    assert len(tr['positions']) == len(p_times) * 3, f"Pos count mismatch in {cfile}:{bname}"

                # Validate scale array vs sclTimes
                if 'scales' in tr:
                    s_times = tr.get('sclTimes') or tr.get('times') or times
                    assert len(tr['scales']) == len(s_times) * 3, f"Scale count mismatch in {cfile}:{bname}"

    print(f"PASS: All 95 canonical export files structurally valid with authentic tracks")


def test_animations_js_routing():
    anim_js = (VIEWER_DIR / 'src/animations.js').read_text()

    # Verify elimination of split('_')[0] fallback
    assert "split('_')[0]" not in anim_js, "Unsafe split('_')[0] fallback still present in animations.js"
    assert "split('_')" not in anim_js, "Unsafe split('_') present in animations.js"

    # Verify explicit manifest routing
    assert "index.json" in anim_js, "Missing index.json fetch in animations.js"
    assert "getManifest" in anim_js, "Missing getManifest helper in animations.js"

    # Verify constant track support
    assert "rotTimes" in anim_js, "Missing rotTimes support in animations.js"
    assert "posTimes" in anim_js, "Missing posTimes support in animations.js"

    print("PASS: animations.js strict manifest routing and no invalid fallbacks")


if __name__ == '__main__':
    test_manifest_coverage()
    test_canonical_json_structure()
    test_animations_js_routing()
    print("ALL BATCH ANIMATION TESTS PASSED.")
