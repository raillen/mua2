#!/usr/bin/env python3
"""Export authentic Havok 6.1 animations from .hkx files to JSON for Three.js viewer."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

# Ensure local tools directory is in sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from hkx_packfile import Packfile, extract_animation_clips
from hkx_spline import SplineDecompressor, normalize_quaternion


def export_character_animations(hkx_paths: list[Path | str], out_path: Path | str, glb_path: Path | str | None = None) -> dict:
    valid_bones = None
    if glb_path:
        glb_p = Path(glb_path)
        if glb_p.exists():
            import struct
            with open(glb_p, 'rb') as f:
                f.seek(12)
                chunk_len, chunk_type = struct.unpack('<2I', f.read(8))
                gltf = json.loads(f.read(chunk_len))
            skin = gltf['skins'][0]
            valid_bones = set(gltf['nodes'][j].get('name', '') for j in skin['joints'])
            # Add normalized variants
            valid_bones.update(b.replace(' ', '_') for b in list(valid_bones))
            valid_bones.update(b.replace('_', ' ') for b in list(valid_bones))

    all_clips = []
    seen_names = set()

    for p in hkx_paths:
        path = Path(p)
        if not path.exists():
            print(f"Warning: HKX file not found: {path}", file=sys.stderr)
            continue

        hk = Packfile(path)
        clips = extract_animation_clips(hk)
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
                # If glb_path was given, filter out tracks that don't belong to the character skeleton
                if valid_bones and bname not in valid_bones and bname.replace('_', ' ') not in valid_bones and bname.replace(' ', '_') not in valid_bones:
                    continue

                is_pos_dyn = bool(tr.position.knots)
                is_rot_dyn = bool(tr.rotation.knots)

                # Rotations
                quats = []
                for f in range(N):
                    q = normalize_quaternion(tr.rotation.value(f))
                    quats.extend([round(v, 4) for v in q])

                track_entry = {
                    "bone": bname,
                    "quaternions": quats,
                }

                # Positions: only include if dynamic or if root bone (Bip01)
                if is_pos_dyn or bname in ('Bip01', 'Motion'):
                    pos = []
                    for f in range(N):
                        p_val = tr.position.value(f)
                        pos.extend([round(v, 4) for v in p_val])
                    track_entry["positions"] = pos

                tracks_out.append(track_entry)

            all_clips.append({
                "name": clip_name,
                "duration": round(dur, 5),
                "times": times,
                "tracks": tracks_out,
            })

    result = {
        "format": "mua2-authentic-havok-v1",
        "character": Path(out_path).stem,
        "clip_count": len(all_clips),
        "clips": all_clips,
    }

    out_p = Path(out_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text(json.dumps(result, separators=(',', ':')))
    print(f"Exported {len(all_clips)} clips to {out_p} ({out_p.stat().st_size / 1024:.1f} KB)")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('hkx', nargs='+', type=Path, help="Input .hkx animation packfiles")
    parser.add_argument('--out', type=Path, required=True, help="Output JSON path")
    parser.add_argument('--glb', type=Path, default=None, help="Optional reference GLB to filter bones")
    args = parser.parse_args()

    export_character_animations(args.hkx, args.out, args.glb)


if __name__ == '__main__':
    main()
