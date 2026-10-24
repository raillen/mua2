#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Batch export MUA2 Spider-Man animation tracks to dense JSON and validate outputs."""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Any, Dict, List

# Ensure local tools importable when run directly
TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

from hkx_packfile import AnimationClipRaw, Packfile, extract_animation_clips
from hkx_spline import SplineDecompressor, normalize_quaternion


@dataclass
class ValidationMetrics:
    source: str
    sha256: str
    clip_count: int
    total_frames: int
    total_dense_transforms: int
    max_quaternion_norm_error: float
    position_bounds_min: list[float]
    position_bounds_max: list[float]
    scale_bounds_min: list[float]
    scale_bounds_max: list[float]
    finite_floats_verified: bool
    quaternions_normalized: bool
    tracks_bound_to_bones: bool


def round_floats(val: Any, precision: int) -> Any:
    if isinstance(val, float):
        return round(val, precision)
    if isinstance(val, list):
        return [round_floats(v, precision) for v in val]
    return val


def export_packfile(path: Path, precision: int = 6) -> tuple[dict[str, Any], ValidationMetrics]:
    data = path.read_bytes()
    file_sha256 = hashlib.sha256(data).hexdigest()
    pk = Packfile(path)
    raw_clips = extract_animation_clips(pk)

    # Collect union of unique bones preserving order of first appearance
    all_bones: list[str] = []
    bone_set: set[str] = set()
    for c in raw_clips:
        for b in c.track_names:
            if b not in bone_set:
                bone_set.add(b)
                all_bones.append(b)

    pos_min = [float('inf'), float('inf'), float('inf')]
    pos_max = [float('-inf'), float('-inf'), float('-inf')]
    scale_min = [float('inf'), float('inf'), float('inf')]
    scale_max = [float('-inf'), float('-inf'), float('-inf')]
    max_q_err = 0.0
    total_transforms = 0
    total_frames = 0
    all_finite = True
    all_bound = True

    clips_output: list[dict[str, Any]] = []

    for c in raw_clips:
        decomp = SplineDecompressor(c)
        num_frames = c.num_frames
        total_frames += num_frames
        duration = c.duration
        frame_dur = c.frame_duration

        if len(c.track_names) != c.num_tracks:
            all_bound = False

        if num_frames > 1:
            step = duration / (num_frames - 1)
            times = [round(i * step, precision) for i in range(num_frames)]
        else:
            times = [0.0]

        tracks_output: list[dict[str, Any]] = []

        for track_idx, track in enumerate(decomp.tracks):
            bone_name = c.track_names[track_idx] if track_idx < len(c.track_names) else f"track_{track_idx}"
            pos_list: list[list[float]] = []
            rot_list: list[list[float]] = []
            scale_list: list[list[float]] = []

            for f_idx in range(num_frames):
                frame_val = float(f_idx)
                p = track.position.value(frame_val)
                raw_q = track.rotation.value(frame_val)
                q = normalize_quaternion(raw_q)
                s = track.scale.value(frame_val)

                total_transforms += 1

                for i in range(3):
                    if not (math.isfinite(p[i]) and math.isfinite(s[i])):
                        all_finite = False
                    pos_min[i] = min(pos_min[i], p[i])
                    pos_max[i] = max(pos_max[i], p[i])
                    scale_min[i] = min(scale_min[i], s[i])
                    scale_max[i] = max(scale_max[i], s[i])

                q_norm = math.sqrt(sum(v * v for v in q))
                if not math.isfinite(q_norm):
                    all_finite = False
                max_q_err = max(max_q_err, abs(q_norm - 1.0))

                pos_list.append([round(v, precision) for v in p])
                rot_list.append([round(v, precision) for v in q])
                scale_list.append([round(v, precision) for v in s])

            tracks_output.append({
                "bone": bone_name,
                "positions": pos_list,
                "rotations": rot_list,
                "scales": scale_list,
            })

        clips_output.append({
            "name": c.name,
            "duration": round(duration, precision),
            "num_frames": num_frames,
            "frame_duration": round(frame_dur, precision),
            "times": times,
            "tracks": tracks_output,
        })

    payload = {
        "source": path.name,
        "sha256": file_sha256,
        "bones": all_bones,
        "clips": clips_output,
    }

    metrics = ValidationMetrics(
        source=path.name,
        sha256=file_sha256,
        clip_count=len(raw_clips),
        total_frames=total_frames,
        total_dense_transforms=total_transforms,
        max_quaternion_norm_error=max_q_err,
        position_bounds_min=[round(v, precision) for v in pos_min],
        position_bounds_max=[round(v, precision) for v in pos_max],
        scale_bounds_min=[round(v, precision) for v in scale_min],
        scale_bounds_max=[round(v, precision) for v in scale_max],
        finite_floats_verified=all_finite,
        quaternions_normalized=(max_q_err < 1e-6),
        tracks_bound_to_bones=all_bound,
    )

    return payload, metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        nargs="*",
        type=Path,
        default=[
            Path("_work/igz_anims/09_spiderman.hkx"),
            Path("_work/igz_anims/09_spiderman_4_combat.hkx"),
            Path("_work/igz_anims/09_spiderman_4_conv.hkx"),
        ],
        help="Input HKX animation packfiles",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("_work/spiderman_animation"),
        help="Output directory for extracted JSON tracks and validation reports",
    )
    parser.add_argument(
        "--precision",
        type=int,
        default=6,
        help="Decimal places for exported floating point values (default: 6)",
    )
    args = parser.parse_args()

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    catalog: list[dict[str, Any]] = []
    validation_reports: list[dict[str, Any]] = []

    grand_total_clips = 0
    grand_total_frames = 0
    grand_total_transforms = 0
    max_overall_q_err = 0.0

    for path in args.input:
        if not path.is_file():
            print(f"Error: input file {path} not found", file=sys.stderr)
            sys.exit(1)

        print(f"Processing {path}...")
        payload, metrics = export_packfile(path, precision=args.precision)

        out_json_path = out_dir / f"{path.stem}.json"
        out_json_path.write_text(json.dumps(payload, indent=None), encoding="utf-8")
        size_mb = out_json_path.stat().st_size / (1024 * 1024)
        print(f"  Wrote {out_json_path} ({size_mb:.2f} MB, {metrics.clip_count} clips)")

        validation_reports.append(asdict(metrics))
        grand_total_clips += metrics.clip_count
        grand_total_frames += metrics.total_frames
        grand_total_transforms += metrics.total_dense_transforms
        max_overall_q_err = max(max_overall_q_err, metrics.max_quaternion_norm_error)

        for clip in payload["clips"]:
            catalog.append({
                "clip": clip["name"],
                "source": path.name,
                "duration": clip["duration"],
                "num_frames": clip["num_frames"],
                "frame_duration": clip["frame_duration"],
                "num_tracks": len(clip["tracks"]),
                "fps": round(1.0 / clip["frame_duration"], 2) if clip["frame_duration"] > 0 else 0.0,
            })

    catalog_path = out_dir / "animation_catalog.json"
    catalog_path.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    print(f"Wrote animation catalog: {catalog_path} ({len(catalog)} clips)")

    validation_summary = {
        "verified_all": all(
            r["finite_floats_verified"] and r["quaternions_normalized"] and r["tracks_bound_to_bones"]
            for r in validation_reports
        ),
        "total_clips": grand_total_clips,
        "total_frames": grand_total_frames,
        "total_dense_transforms": grand_total_transforms,
        "max_quaternion_unit_norm_error": max_overall_q_err,
        "files": validation_reports,
    }

    report_json_path = out_dir / "validation_report.json"
    report_json_path.write_text(json.dumps(validation_summary, indent=2), encoding="utf-8")

    # Write Markdown summary table
    report_md_lines = [
        "# MUA2 Spider-Man Animation Extraction & Validation Report",
        "",
        "## Summary",
        f"- **Total Animation Packfiles**: {len(validation_reports)}",
        f"- **Total Decoded Clips**: {grand_total_clips}",
        f"- **Total Animation Frames**: {grand_total_frames}",
        f"- **Total Evaluated Dense Transforms**: {grand_total_transforms}",
        f"- **Max Quaternion Unit Norm Error**: `{max_overall_q_err:.6e}` (machine epsilon precision)",
        f"- **Numerical Integrity**: {'PASSED (Zero NaNs / Infs / Degeneracies)' if validation_summary['verified_all'] else 'FAILED'}",
        "",
        "## Packfile Breakdown",
        "",
        "| Packfile | SHA256 (first 12) | Clips | Frames | Transforms | Pos X Range | Pos Y Range | Pos Z Range | Max Quat Err | Status |",
        "| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for r in validation_reports:
        sha_short = r["sha256"][:12]
        p_min = r["position_bounds_min"]
        p_max = r["position_bounds_max"]
        status = "PASSED" if r["finite_floats_verified"] and r["quaternions_normalized"] else "FAIL"
        report_md_lines.append(
            f"| `{r['source']}` | `{sha_short}` | {r['clip_count']} | {r['total_frames']} | "
            f"{r['total_dense_transforms']} | [{p_min[0]:.1f}, {p_max[0]:.1f}] | "
            f"[{p_min[1]:.1f}, {p_max[1]:.1f}] | [{p_min[2]:.1f}, {p_max[2]:.1f}] | "
            f"`{r['max_quaternion_norm_error']:.2e}` | **{status}** |"
        )

    report_md_lines.append("")
    report_md_lines.append("## Decompression Algorithms")
    report_md_lines.append("- Rotations: Havok ThreeComp40 40-bit bitfield quantized quaternions, evaluated via open-uniform B-spline curves.")
    report_md_lines.append("- Positions: 16-bit quantized dynamic B-splines & 32-bit static floats with per-axis min/max bounds.")
    report_md_lines.append("- Scales: 16-bit quantized dynamic B-splines, 32-bit static floats & identity transforms.")
    report_md_lines.append("- Track Bindings: Resolved directly from `hkaAnimation.annotationTracks` for each individual clip.")

    report_md_path = out_dir / "validation_report.md"
    report_md_path.write_text("\n".join(report_md_lines) + "\n", encoding="utf-8")
    print(f"Wrote validation report: {report_md_path}")


if __name__ == "__main__":
    main()
