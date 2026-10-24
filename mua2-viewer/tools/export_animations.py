#!/usr/bin/env python3
"""Export authentic Havok 6.1 animations from .hkx files to JSON for Three.js viewer."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

REPO_ROOT = SCRIPT_DIR.parents[1] if len(SCRIPT_DIR.parents) >= 2 else SCRIPT_DIR.parent
VIEWER_DIR = REPO_ROOT / 'mua2-viewer' if (REPO_ROOT / 'mua2-viewer').exists() else SCRIPT_DIR.parent

from hkx_packfile import Packfile, extract_animation_clips
from hkx_spline import SplineDecompressor, normalize_quaternion


def is_excluded_bone(name: str) -> bool:
    """Filter out Havok root motion coordinates and 3ds Max/Havok dummy nub bones."""
    lower = name.lower()
    return lower == 'motion' or lower.endswith('nub')


def extract_glb_skeleton(glb_path: Path | str) -> tuple[set[str], dict[str, list[float]]]:
    """Extract valid joint names and local bind translations from a GLB model."""
    glb_p = Path(glb_path)
    if not glb_p.exists():
        return set(), {}

    with open(glb_p, 'rb') as f:
        magic, version, _ = struct.unpack('<3I', f.read(12))
        if magic != 0x46546C67 or version != 2:
            return set(), {}
        chunk_len, chunk_type = struct.unpack('<2I', f.read(8))
        if chunk_type != 0x4E4F534A:
            return set(), {}
        gltf = json.loads(f.read(chunk_len))

    nodes = gltf.get('nodes', [])
    joints = set()
    bind_translations = {}

    for skin in gltf.get('skins', []):
        for j in skin.get('joints', []):
            if j < len(nodes):
                bname = nodes[j].get('name', '')
                if bname and not is_excluded_bone(bname):
                    joints.add(bname)
                    joints.add(bname.replace(' ', '_'))
                    joints.add(bname.replace('_', ' '))
                    trans = nodes[j].get('translation', [0.0, 0.0, 0.0])
                    bind_translations[bname] = trans
                    bind_translations[bname.replace(' ', '_')] = trans
                    bind_translations[bname.replace('_', ' ')] = trans

    return joints, bind_translations


def export_character_animations(
    hkx_paths: list[Path | str],
    out_path: Path | str,
    glb_path: Path | str | list[Path | str] | None = None,
    character_name: str | None = None
) -> dict:
    """Export animation clips from HKX files to authentic Havok JSON."""
    if not hkx_paths:
        raise ValueError("No HKX source paths provided")

    # Strictly check that all source files exist
    for p in hkx_paths:
        path = Path(p)
        if not path.is_file():
            raise FileNotFoundError(f"Missing source HKX: {path}")

    # Gather valid bones and bind translations across provided GLB(s)
    valid_bones: set[str] | None = None
    bind_translations: dict[str, list[float]] = {}

    if glb_path is not None:
        valid_bones = set()
        glbs = [glb_path] if isinstance(glb_path, (str, Path)) else glb_path
        for gp in glbs:
            joints, binds = extract_glb_skeleton(gp)
            valid_bones.update(joints)
            bind_translations.update(binds)
        if not valid_bones:
            valid_bones = None

    all_clips = []
    seen_names = set()
    sources_meta = []
    rejected_clips = []

    for p in hkx_paths:
        path = Path(p)
        raw_bytes = path.read_bytes()
        file_sha256 = hashlib.sha256(raw_bytes).hexdigest()

        pk = Packfile(path)
        clips = extract_animation_clips(pk)
        if not clips:
            raise ValueError(f"No animation clips found in {path}")

        sources_meta.append({
            "file": path.name,
            "sha256": file_sha256,
            "clip_count": len(clips)
        })

        for clip in clips:
            raw_name = clip.name
            clip_name = raw_name
            suffix = 2
            while clip_name in seen_names:
                clip_name = f"{raw_name}_{suffix}"
                suffix += 1
            seen_names.add(clip_name)

            decomp = SplineDecompressor(clip)
            N = clip.num_frames
            dur = clip.duration

            if N <= 1 or dur <= 0:
                times = [0.0]
            else:
                times = [round((i / (N - 1)) * dur, 5) for i in range(N)]

            tracks_out = []
            for tr_idx, tr in enumerate(decomp.tracks):
                bname = clip.track_names[tr_idx] if tr_idx < len(clip.track_names) else f"track_{tr_idx}"

                # Strict exclusion of root Motion and Max/Havok Nub effectors
                if is_excluded_bone(bname):
                    continue

                # Filter against valid skeleton bones if GLB was provided
                if valid_bones is not None:
                    if (bname not in valid_bones and
                        bname.replace('_', ' ') not in valid_bones and
                        bname.replace(' ', '_') not in valid_bones):
                        continue

                is_rot_dyn = bool(tr.rotation.knots)
                is_pos_dyn = bool(tr.position.knots)
                is_scl_dyn = bool(tr.scale.knots)

                track_entry: dict = {"bone": bname}

                # Rotations: store 1-key constant if static, otherwise full authentic trajectory
                if is_rot_dyn:
                    quats = []
                    for f in range(N):
                        q = normalize_quaternion(tr.rotation.value(f))
                        quats.extend([round(v, 4) for v in q])
                    track_entry["quaternions"] = quats
                else:
                    q = normalize_quaternion(tr.rotation.value(0))
                    track_entry["quaternions"] = [round(v, 4) for v in q]
                    track_entry["rotTimes"] = [0.0]

                # Positions: include dynamic or static differing from bind (or root Bip01)
                bind_pos = bind_translations.get(bname, [0.0, 0.0, 0.0])
                if is_pos_dyn:
                    pos = []
                    for f in range(N):
                        p_val = tr.position.value(f)
                        pos.extend([round(v, 4) for v in p_val])
                    track_entry["positions"] = pos
                else:
                    p0 = tr.position.value(0)
                    diff = max(abs(p0[i] - bind_pos[i]) for i in range(3))
                    if bname == 'Bip01' or diff > 1e-3:
                        track_entry["positions"] = [round(v, 4) for v in p0]
                        track_entry["posTimes"] = [0.0]

                # Scales: include only if dynamic or non-unit
                if is_scl_dyn:
                    scls = []
                    for f in range(N):
                        s_val = tr.scale.value(f)
                        scls.extend([round(v, 4) for v in s_val])
                    track_entry["scales"] = scls
                else:
                    s0 = tr.scale.value(0)
                    if max(abs(s0[i] - 1.0) for i in range(3)) > 1e-3:
                        track_entry["scales"] = [round(v, 4) for v in s0]
                        track_entry["sclTimes"] = [0.0]

                tracks_out.append(track_entry)

            if tracks_out:
                all_clips.append({
                    "name": clip_name,
                    "duration": round(dur, 5),
                    "times": times,
                    "tracks": tracks_out,
                })
            else:
                rejected_clips.append({
                    "source": path.name,
                    "clip": clip.name,
                    "reason": "zero compatible tracks after filtering"
                })

    if not all_clips:
        raise ValueError(f"Zero playable clips produced for {out_path}")

    cname = character_name or Path(out_path).stem
    result = {
        "format": "mua2-authentic-havok-v1",
        "character": cname,
        "provenance": {
            "exporter": "tools/export_animations.py",
            "sources": sources_meta,
            "sampling": "authentic spline decompression; normalized quaternions; 4-decimal precision",
            "optimizations": "safe 1-key constant track compression for static channels; Motion and *Nub excluded",
            "rejected_clip_count": len(rejected_clips),
        },
        "clip_count": len(all_clips),
        "clips": all_clips,
    }

    out_p = Path(out_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    temp_p = out_p.with_suffix('.tmp')
    temp_p.write_text(json.dumps(result, separators=(',', ':')))
    temp_p.replace(out_p)

    return result


def get_base_character(name: str) -> str:
    """Normalize model ID into character family for grouping compatible costumes."""
    if name.startswith('luciavonbardas'):
        return 'luciavonbardas'
    m = re.match(r'^(.*?)(?:_alt.*|_pro.*|_anti.*|_flame.*|$)', name)
    return m.group(1) if m else name


def batch_export(
    sources_json_path: Path | str,
    hkx_dir: Path | str,
    models_dir: Path | str,
    out_dir: Path | str
) -> dict:
    """Batch export all catalog models with canonical sharing and explicit index manifest."""
    sources_path = Path(sources_json_path)
    if not sources_path.is_file():
        raise FileNotFoundError(f"Missing sources file: {sources_path}")

    sources_map: dict[str, list[str]] = json.loads(sources_path.read_text())
    hkx_p = Path(hkx_dir)
    models_p = Path(models_dir)
    out_p = Path(out_dir)
    out_p.mkdir(parents=True, exist_ok=True)

    if len(sources_map) != 184:
        raise ValueError(f"Expected 184 models in animation sources, found {len(sources_map)}")

    # Verify all referenced HKX files exist upfront
    unique_hkx = {f for files in sources_map.values() for f in files}
    missing_hkx = [f for f in unique_hkx if not (hkx_p / f).is_file()]
    if missing_hkx:
        raise FileNotFoundError(f"Missing {len(missing_hkx)} HKX source files: {missing_hkx[:5]}")

    # Group mapped models by identical source HKX tuple and character family
    canonical_groups = defaultdict(list)
    for model_id, files in sources_map.items():
        if not files:
            continue
        family = get_base_character(model_id)
        group_key = (tuple(files), family)
        canonical_groups[group_key].append(model_id)

    manifest: dict[str, str | None] = {}
    # All 51 empty models are explicitly null
    for model_id, files in sources_map.items():
        if not files:
            manifest[model_id] = None

    report: dict = {
        "total_catalog_models": len(sources_map),
        "mapped_models": sum(bool(v) for v in sources_map.values()),
        "empty_models": sum(not v for v in sources_map.values()),
        "canonical_exports_count": len(canonical_groups),
        "exports": [],
        "failures": [],
        "total_bytes": 0,
    }

    total_groups = len(canonical_groups)
    print(f"Beginning serial batch export for {total_groups} canonical groups...", flush=True)

    for idx, ((files, family), members) in enumerate(canonical_groups.items(), 1):
        # Choose canonical name: prefer base character name if present in group, else first member
        canonical_name = family if family in members else members[0]
        json_filename = f"{canonical_name}.json"
        target_json = out_p / json_filename

        # Collect union of GLB model paths for compatible joints
        member_glbs = [models_p / f"{m}.glb" for m in members if (models_p / f"{m}.glb").is_file()]

        try:
            hkx_file_paths = [hkx_p / f for f in files]
            export_result = export_character_animations(
                hkx_file_paths,
                target_json,
                glb_path=member_glbs,
                character_name=canonical_name
            )

            file_size = target_json.stat().st_size
            report["total_bytes"] += file_size
            report["exports"].append({
                "canonical_file": json_filename,
                "character": canonical_name,
                "shared_models": members,
                "clip_count": export_result["clip_count"],
                "bytes": file_size
            })

            # Map all group members to this canonical JSON file
            for m in members:
                manifest[m] = json_filename

            print(f"[{idx}/{total_groups}] Exported {json_filename} ({export_result['clip_count']} clips, {file_size / 1024 / 1024:.2f} MB) -> shared by {members}", flush=True)
        except Exception as e:
            report["failures"].append({
                "canonical": canonical_name,
                "members": members,
                "error": str(e)
            })
            print(f"[{idx}/{total_groups}] ERROR exporting {canonical_name}: {e}", file=sys.stderr, flush=True)

    # Sort manifest keys for deterministic output
    sorted_manifest = {k: manifest[k] for k in sorted(manifest.keys())}
    manifest_p = out_p / 'index.json'
    manifest_p.write_text(json.dumps(sorted_manifest, indent=2))

    report_p = out_p / 'export_report.json'
    report_p.write_text(json.dumps(report, indent=2))

    coverage_count = sum(v is not None for v in manifest.values())
    total_mb = report["total_bytes"] / 1024 / 1024
    print(f"\nBatch export completed.", flush=True)
    print(f"Coverage: {coverage_count}/{len(sources_map)} models mapped ({total_groups} canonical JSON files)", flush=True)
    print(f"Total asset size: {total_mb:.2f} MB", flush=True)
    print(f"Failures: {len(report['failures'])}", flush=True)

    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('hkx', nargs='*', type=Path, help="Input .hkx animation packfiles")
    parser.add_argument('--out', type=Path, default=None, help="Output JSON path")
    parser.add_argument('--glb', nargs='*', type=Path, default=None, help="Reference GLB(s) to filter bones")
    parser.add_argument('--batch', action='store_true', help="Batch export all 184 models")
    parser.add_argument('--sources', type=Path, default=VIEWER_DIR / 'tools/animation_sources.json')
    parser.add_argument('--hkx-dir', type=Path, default=REPO_ROOT / '_work/igz_anims')
    parser.add_argument('--model-dir', type=Path, default=VIEWER_DIR / 'assets/models')
    parser.add_argument('--out-dir', type=Path, default=VIEWER_DIR / 'assets/animations')
    args = parser.parse_args()

    if args.batch:
        report = batch_export(args.sources, args.hkx_dir, args.model_dir, args.out_dir)
        if report["failures"]:
            sys.exit(1)
    else:
        if not args.hkx or not args.out:
            parser.error("Single character export requires HKX inputs and --out path")
        glbs = args.glb if args.glb else None
        if glbs and len(glbs) == 1:
            glbs = glbs[0]
        export_character_animations(args.hkx, args.out, glb_path=glbs)


if __name__ == '__main__':
    main()
