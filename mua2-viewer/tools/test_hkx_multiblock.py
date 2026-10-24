#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for Havok 6.1 multi-block spline decompression and frame sampling."""
from __future__ import annotations

import math
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

REPO_ROOT = SCRIPT_DIR.parents[1]
WORK_ANIMS = REPO_ROOT / "_work/igz_anims"

from hkx_packfile import Packfile, extract_animation_clips
from hkx_spline import (
    SplineDecompressor,
    get_block_index_and_frame,
    normalize_quaternion,
)


def test_get_block_index_and_frame() -> None:
    """Validate Havok block index and frame mapping against soulstruct-havok / HavokLib formula."""
    # 256 max frames per block -> 255 frames per block
    assert get_block_index_and_frame(0.0, 256, 2) == (0, 0.0)
    assert get_block_index_and_frame(254.0, 256, 2) == (0, 254.0)
    assert get_block_index_and_frame(255.0, 256, 2) == (1, 0.0)
    assert get_block_index_and_frame(256.0, 256, 2) == (1, 1.0)
    assert get_block_index_and_frame(509.0, 256, 3) == (1, 254.0)
    assert get_block_index_and_frame(510.0, 256, 3) == (2, 0.0)

    # Final block boundary clamping
    assert get_block_index_and_frame(510.0, 256, 2) == (1, 255.0)

    # Domain validation
    try:
        get_block_index_and_frame(-0.1, 256, 2)
        assert False, "Expected ValueError on negative frame"
    except ValueError:
        pass

    try:
        get_block_index_and_frame(510.1, 256, 2)
        assert False, "Expected ValueError on frame beyond block domain"
    except ValueError:
        pass

    print("PASS: get_block_index_and_frame mapping and boundaries")


def test_single_block_regression() -> None:
    """Verify single-block clips preserve .tracks interface and support .sample()."""
    spiderman_hkx = WORK_ANIMS / "09_spiderman.hkx"
    assert spiderman_hkx.exists(), f"Missing {spiderman_hkx}"

    pk = Packfile(spiderman_hkx)
    clips = extract_animation_clips(pk)
    assert len(clips) >= 17

    for clip in clips:
        assert clip.num_blocks == 1
        decomp = SplineDecompressor(clip)
        assert len(decomp.tracks) == clip.num_tracks
        assert len(decomp.blocks) == 1
        assert decomp.control_quaternion_norm_error < 1e-6

        # Check track .value() interface
        for track in decomp.tracks:
            q0 = normalize_quaternion(track.rotation.value(0.0))
            q_end = normalize_quaternion(track.rotation.value(float(clip.num_frames - 1)))
            assert len(q0) == 4 and len(q_end) == 4

        # Check .sample() API
        all_samples_0 = decomp.sample(0)
        assert len(all_samples_0) == clip.num_tracks
        for t_idx, track in enumerate(decomp.tracks):
            pos, rot, scl = track.sample(0)
            assert pos == all_samples_0[t_idx][0]
            assert rot == all_samples_0[t_idx][1]
            assert scl == all_samples_0[t_idx][2]
            assert abs(math.sqrt(sum(v * v for v in rot)) - 1.0) < 1e-6

    print("PASS: Single-block regression and sampling API (09_spiderman.hkx)")


def test_multiblock_character_clips() -> None:
    """Validate all 8 authentic multi-block character clips."""
    expected_multiblocks = {
        ("10_thor_4_combat.hkx", "fusion_create_tornado_loop"): (2, 286),
        ("110_goliath.hkx", "idle"): (2, 351),
        ("110_goliath_4_combat.hkx", "power_18"): (2, 362),
        ("115_yellowjacket.hkx", "idle"): (2, 351),
        ("158_nanitenickfury.hkx", "power_26"): (2, 330),
        ("158_nanitenickfury.hkx", "power_28"): (2, 301),
        ("160_cablehero.hkx", "menu_action"): (2, 281),
        ("venom_tongue.hkx", "power_20"): (3, 551),
    }

    found = 0
    frames_per_block = 255

    for (file_name, clip_name), (exp_blocks, exp_frames) in expected_multiblocks.items():
        hkx_path = WORK_ANIMS / file_name
        assert hkx_path.exists(), f"Missing {hkx_path}"

        pk = Packfile(hkx_path)
        clips = extract_animation_clips(pk)
        clip = next((c for c in clips if c.name == clip_name), None)
        assert clip is not None, f"Clip {clip_name} not found in {file_name}"

        assert clip.num_blocks == exp_blocks
        assert clip.num_frames == exp_frames
        found += 1

        decomp = SplineDecompressor(clip)
        assert len(decomp.tracks) == clip.num_tracks
        assert len(decomp.blocks) == exp_blocks
        assert decomp.control_quaternion_norm_error < 1e-6

        # 1. Boundary frame evaluation via .tracks and .sample()
        test_frames = [0, 254, 255, 256, clip.num_frames - 1]
        for f in test_frames:
            sampled_all = decomp.sample(f)
            assert len(sampled_all) == clip.num_tracks
            for t_idx, track in enumerate(decomp.tracks):
                pos = track.position.value(f)
                rot_raw = track.rotation.value(f)
                rot = normalize_quaternion(rot_raw)
                scl = track.scale.value(f)

                t_pos, t_rot, t_scl = track.sample(f)
                assert pos == t_pos == sampled_all[t_idx][0]
                assert rot == t_rot == sampled_all[t_idx][1]
                assert scl == t_scl == sampled_all[t_idx][2]

                assert len(pos) == 3 and all(math.isfinite(v) for v in pos)
                assert len(scl) == 3 and all(math.isfinite(v) for v in scl)
                assert len(rot) == 4 and all(math.isfinite(v) for v in rot)
                assert abs(math.sqrt(sum(v * v for v in rot)) - 1.0) < 1e-6

        # 2. Shared-boundary continuity across adjacent blocks
        for b in range(clip.num_blocks - 1):
            for t in range(clip.num_tracks):
                p0 = decomp.blocks[b][t].position.value(frames_per_block)
                p1 = decomp.blocks[b + 1][t].position.value(0.0)
                pos_err = max(abs(p0[i] - p1[i]) for i in range(3))
                assert pos_err < 0.003, f"{clip.name} block {b}->{b+1} track {t} pos delta {pos_err} >= 0.003"

                r0 = normalize_quaternion(decomp.blocks[b][t].rotation.value(frames_per_block))
                r1 = normalize_quaternion(decomp.blocks[b + 1][t].rotation.value(0.0))
                rot_err = min(
                    max(abs(r0[i] - r1[i]) for i in range(4)),
                    max(abs(r0[i] + r1[i]) for i in range(4)),
                )
                assert rot_err < 0.003, f"{clip.name} block {b}->{b+1} track {t} rot delta {rot_err} >= 0.003"

                s0 = decomp.blocks[b][t].scale.value(frames_per_block)
                s1 = decomp.blocks[b + 1][t].scale.value(0.0)
                scale_err = max(abs(s0[i] - s1[i]) for i in range(3))
                assert scale_err < 0.002, f"{clip.name} block {b}->{b+1} track {t} scale delta {scale_err} >= 0.002"

        # 3. Out-of-bounds frame rejection
        try:
            decomp.sample(-1)
            assert False, "Expected ValueError on negative frame"
        except ValueError:
            pass

        try:
            decomp.sample(clip.num_frames)
            assert False, "Expected ValueError on frame >= num_frames"
        except ValueError:
            pass

    assert found == len(expected_multiblocks)
    print(f"PASS: Verified all {found} authentic character multi-block clips")


def test_all_numbered_character_hkx_files() -> None:
    """Validate all numbered character HKX packfiles parse and sample without errors."""
    char_files = sorted(WORK_ANIMS.glob("[0-9]*_*.hkx"))
    assert len(char_files) >= 200, f"Expected >= 200 character HKX files, found {len(char_files)}"

    total_clips = 0
    multi_clips = 0

    for hkx_path in char_files:
        pk = Packfile(hkx_path)
        clips = extract_animation_clips(pk)
        for clip in clips:
            total_clips += 1
            if clip.num_blocks > 1:
                multi_clips += 1
            decomp = SplineDecompressor(clip)
            assert len(decomp.tracks) == clip.num_tracks
            assert decomp.control_quaternion_norm_error < 1e-6

            # Evaluate boundary frames
            for f in (0, clip.num_frames - 1):
                sample = decomp.sample(f)
                assert len(sample) == clip.num_tracks

    print(f"PASS: All {total_clips} character clips ({multi_clips} multi-block) across {len(char_files)} files verified")


if __name__ == "__main__":
    test_get_block_index_and_frame()
    test_single_block_regression()
    test_multiblock_character_clips()
    test_all_numbered_character_hkx_files()
    print("ALL MULTI-BLOCK TESTS PASSED.")
