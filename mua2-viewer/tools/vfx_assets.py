#!/usr/bin/env python3
"""Batch exporter for MUA2 VFX meshes and FSB5 audio.

Exports:
- Effect GLB meshes to mua2-viewer/assets/vfx/models/
- Original FSB5 MPEG Layer II payloads (.mp3 retained for provenance) and
  decoded PCM16 WAV distribution files to mua2-viewer/assets/vfx/sounds/<bank>/
- Runtime mapping contracts:
  - mua2-viewer/assets/vfx/model_map.json
  - mua2-viewer/assets/vfx/sound_map.json
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Add script directory to sys.path for mua2_glb import
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from mua2_glb import export_glb  # type: ignore
from vfx_decode import CATALOG_FILENAME, load_effects_catalog


@dataclass
class FSB5Sample:
    """Represents a single parsed FSB5 audio sample."""
    name: str
    data: bytes
    mode: int
    version: int
    frequency: int
    channels: int
    sample_count: int


def parse_fsb5_block(data: bytes, pos: int) -> Optional[Tuple[FSB5Sample, int]]:
    """Parse one FSB5 block starting at data[pos].

    Returns (sample, next_pos) on success, or None on failure.
    """
    if pos < 0 or pos + 28 > len(data):
        return None
    magic, ver, num_samples, sh_size, nt_size, data_size, mode = struct.unpack(
        "<4sIIIIII", data[pos : pos + 28]
    )
    if magic != b"FSB5":
        return None

    # This extractor handles one named MPEG stream per block, not multi-sample banks.
    if mode != 11 or ver not in (0, 1) or num_samples != 1 or sh_size < 8 or data_size == 0:
        return None

    # Header size: version 1 is 60 bytes, version 0 is 64 bytes.
    candidate_header_sizes = [60 if ver == 1 else 64]
    sample_info: Optional[FSB5Sample] = None
    consumed_length = 0

    for h_size in candidate_header_sizes:
        nt_start = pos + h_size + sh_size
        nt_end = nt_start + nt_size
        if nt_end > len(data):
            continue

        nt = data[nt_start:nt_end]
        if len(nt) < 4:
            continue

        # First 4 bytes in name table is offset of sample name
        offset = struct.unpack("<I", nt[:4])[0]
        if 0 <= offset < len(nt):
            raw_name = nt[offset:].split(b"\x00")[0]
            if raw_name and all(32 <= b <= 126 for b in raw_name):
                name = raw_name.decode("ascii", errors="ignore").strip()
                data_start = nt_end
                data_end = data_start + data_size
                if data_end <= len(data):
                    audio_data = data[data_start:data_end]

                    # Parse frequency and channels from sample header (8 bytes)
                    sh = data[pos + h_size : pos + h_size + sh_size]
                    raw_sh = struct.unpack("<Q", sh[:8])[0] if len(sh) >= 8 else 0
                    freq_idx = (raw_sh >> 1) & 0xF
                    channels = ((raw_sh >> 5) & 0x1) + 1
                    freq_table = {
                        1: 8000, 2: 11000, 3: 11025, 4: 16000,
                        5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000
                    }
                    freq = freq_table.get(freq_idx, 32000)
                    samples_num = (raw_sh >> 34) & 0x3FFFFFFF

                    sample_info = FSB5Sample(
                        name=name,
                        data=audio_data,
                        mode=mode,
                        version=ver,
                        frequency=freq,
                        channels=channels,
                        sample_count=samples_num,
                    )
                    consumed_length = h_size + sh_size + nt_size + data_size
                    break

    if sample_info is None:
        return None

    return sample_info, pos + consumed_length


def extract_fsb5_samples(pak_path: str) -> List[FSB5Sample]:
    """Extract all individual FSB5 samples from a .pak file without concatenating."""
    with open(pak_path, "rb") as f:
        data = f.read()

    samples: List[FSB5Sample] = []
    pos = 0
    while True:
        idx = data.find(b"FSB5", pos)
        if idx == -1:
            break
        res = parse_fsb5_block(data, idx)
        if res:
            sample, next_pos = res
            samples.append(sample)
            pos = max(idx + 4, next_pos)
        else:
            pos = idx + 4
    return samples


def decode_fsb_sample_to_wav(
    mp3_path: Path,
    wav_path: Path,
    data: bytes,
    sample_count: int = 1152,
) -> None:
    """Decode raw FSB5 MPEG Layer II payload to PCM16 WAV using ffmpeg.

    If standard file decoding fails (e.g. single-frame stream), falls back to
    piping duplicated frames with sample trimming to satisfy ffmpeg's probe.
    """
    cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-y",
        "-i", str(mp3_path),
        "-c:a", "pcm_s16le",
        str(wav_path),
    ]
    res = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True)
    if res.returncode == 0 and wav_path.exists() and wav_path.stat().st_size > 0:
        return

    # Fallback for single-frame MPEG streams
    trim_samples = sample_count if sample_count > 0 else 1152
    pipe_cmd = [
        "ffmpeg", "-nostdin", "-v", "error", "-y",
        "-f", "mp3", "-i", "pipe:0",
        "-af", f"atrim=end_sample={trim_samples}",
        "-c:a", "pcm_s16le",
        str(wav_path),
    ]
    res2 = subprocess.run(pipe_cmd, input=data * 2, capture_output=True)
    if res2.returncode != 0 or not wav_path.exists() or wav_path.stat().st_size == 0:
        err = res2.stderr.decode("utf-8", errors="ignore") or res.stderr.decode("utf-8", errors="ignore")
        raise RuntimeError(f"Failed to decode {mp3_path} to {wav_path}: {err}")


def normalize_ref(ref: str) -> str:
    """Normalize model or sound reference path."""
    clean = ref.replace("\\", "/").strip().lower()
    while clean.startswith("./"):
        clean = clean[2:]
    return clean


def build_vfx_assets(
    work_dir: str = "_work",
    viewer_dir: str = "mua2-viewer",
    normalize_scale: bool = False,
    force_models: bool = False,
    force_decode: bool = False,
    verbose: bool = True,
) -> Dict[str, Any]:
    """Execute batch extraction of VFX models and FSB5 sounds and build runtime maps."""
    t_start = time.time()
    work_path = Path(work_dir).resolve()
    viewer_path = Path(viewer_dir).resolve()

    effects_json_path = viewer_path / "assets" / "vfx" / CATALOG_FILENAME
    models_json_path = viewer_path / "assets" / "models" / "models.json"
    vfx_models_dir = viewer_path / "assets" / "vfx" / "models"
    vfx_sounds_dir = viewer_path / "assets" / "vfx" / "sounds"
    model_map_path = viewer_path / "assets" / "vfx" / "model_map.json"
    sound_map_path = viewer_path / "assets" / "vfx" / "sound_map.json"

    vfx_models_dir.mkdir(parents=True, exist_ok=True)
    vfx_sounds_dir.mkdir(parents=True, exist_ok=True)

    # 1. Load VFX effects catalog
    if not effects_json_path.exists():
        raise FileNotFoundError(f"Effects catalog not found: {effects_json_path}")
    effects_data = load_effects_catalog(effects_json_path)

    # Gather modelRef, soundBank, soundName from effects catalog
    catalog_model_refs: Set[str] = set()
    catalog_sound_pairs: Set[Tuple[str, Optional[str]]] = set()
    for eff in effects_data.get("effects", []):
        for prim in eff.get("definition", {}).get("primitives", []):
            m = prim.get("modelRef")
            if m:
                catalog_model_refs.add(m)
            sb = prim.get("soundBank")
            sn = prim.get("soundName")
            if sb:
                catalog_sound_pairs.add((sb, sn))

    # 2. Load character model catalog for character modelRef resolution
    char_models_map: Dict[str, str] = {}
    if models_json_path.exists():
        with open(models_json_path, "r", encoding="utf-8") as f:
            models_meta = json.load(f)
            for cm in models_meta.get("models", []):
                src = cm.get("source", "")
                actor_id = src.replace("actors/", "").strip().lower()
                clean_file = cm.get("file", "").split("?")[0].strip()
                if actor_id and clean_file:
                    char_models_map[actor_id] = clean_file
                    char_models_map[f"{actor_id}.igb"] = clean_file
                    char_models_map[f"{actor_id}.igz"] = clean_file
                    char_models_map[f"actors/{actor_id}"] = clean_file
                    char_models_map[f"actors/{actor_id}.igb"] = clean_file
                    char_models_map[f"actors/{actor_id}.igz"] = clean_file
                cid = cm.get("id", "").strip().lower()
                if cid and clean_file:
                    char_models_map[cid] = clean_file
                    char_models_map[f"{cid}.igb"] = clean_file
                    char_models_map[f"{cid}.igz"] = clean_file

    # 3. Export VFX Meshes (GLB)
    igz_effects_dir = work_path / "igz" / "effects"
    exported_glbs: Dict[str, str] = {}  # relative igz path -> web asset path
    effect_igz_files = sorted(igz_effects_dir.glob("**/*.igz"))

    for igz_file in effect_igz_files:
        rel_to_effects = igz_file.relative_to(igz_effects_dir)
        glb_rel_path = f"assets/vfx/models/effects/{rel_to_effects.with_suffix('.glb').as_posix()}"
        out_glb = viewer_path / glb_rel_path
        out_glb.parent.mkdir(parents=True, exist_ok=True)

        name = igz_file.stem
        # Export GLB without skeleton, optionally unnormalized to preserve original source scale
        if force_models or not out_glb.exists() or out_glb.stat().st_size == 0:
            export_glb(
                actor_path=str(igz_file),
                out_path=str(out_glb),
                name=name,
                skeleton=False,
                normalize=normalize_scale,
            )
        rel_igz_clean = f"effects/{rel_to_effects.with_suffix('.igz').as_posix()}"
        exported_glbs[rel_igz_clean] = glb_rel_path

    # Build model_map.json contract
    model_map: Dict[str, str] = {}
    mapped_models_count = 0
    unmapped_models: List[str] = []

    # Map character models
    for k, v in char_models_map.items():
        model_map[normalize_ref(k)] = v

    # Map exported effect models
    for rel_igz, asset_path in exported_glbs.items():
        clean_base = rel_igz[:-4]  # remove .igz
        model_map[clean_base] = asset_path
        model_map[f"{clean_base}.igb"] = asset_path
        model_map[f"{clean_base}.igz"] = asset_path
        model_map[f"models/{clean_base}"] = asset_path
        model_map[f"models/{clean_base}.igb"] = asset_path
        model_map[f"models/{clean_base}.igz"] = asset_path

    # Check resolution for all catalog modelRefs
    for m in sorted(catalog_model_refs):
        norm = normalize_ref(m)
        if norm in model_map:
            mapped_models_count += 1
            continue
        # Also check without 'models/'
        alt = norm[7:] if norm.startswith("models/") else f"models/{norm}"
        if alt in model_map:
            model_map[norm] = model_map[alt]
            mapped_models_count += 1
            continue
        # Check stem in character models
        stem = Path(norm).stem
        if stem in char_models_map:
            model_map[norm] = char_models_map[stem]
            mapped_models_count += 1
            continue
        unmapped_models.append(m)

    with open(model_map_path, "w", encoding="utf-8") as f:
        json.dump(model_map, f, indent=2, sort_keys=True)

    # 4. Extract Sound Banks (FSB5 MPEG mode 11) and decode to PCM16 WAV
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found in PATH; required to decode MPEG Layer II audio to WAV")

    pak_dir = work_path / "extracted" / "sounds"
    pak_files = {p.stem.lower(): p for p in pak_dir.glob("*.pak")}

    # Determine which banks are required for VFX
    required_banks: Set[str] = set()
    for sb, _ in catalog_sound_pairs:
        clean_sb = sb.lower().strip()
        if clean_sb in pak_files:
            required_banks.add(clean_sb)
        elif f"{clean_sb}_bank" in pak_files:
            required_banks.add(f"{clean_sb}_bank")
        elif clean_sb.endswith("_bank") and clean_sb[:-5] in pak_files:
            required_banks.add(clean_sb[:-5])

    sound_map: Dict[str, Dict[str, str]] = {}
    total_sounds_extracted = 0
    missing_banks: Set[str] = set()
    decode_tasks: List[Tuple[Path, Path, bytes, int]] = []

    for sb, _ in catalog_sound_pairs:
        clean_sb = sb.lower().strip()
        matched_pak = (
            pak_files.get(clean_sb)
            or pak_files.get(f"{clean_sb}_bank")
            or (pak_files.get(clean_sb[:-5]) if clean_sb.endswith("_bank") else None)
        )
        if not matched_pak:
            missing_banks.add(sb)

    # Extract all samples for required VFX banks
    for bank_stem in sorted(required_banks):
        pak_path = pak_files[bank_stem]
        samples = extract_fsb5_samples(str(pak_path))
        if not samples:
            continue

        bank_out_dir = vfx_sounds_dir / bank_stem
        bank_out_dir.mkdir(parents=True, exist_ok=True)

        bank_dict: Dict[str, str] = {}
        for s in samples:
            out_mp3_name = f"{s.name}.mp3"
            out_wav_name = f"{s.name}.wav"
            out_mp3_path = bank_out_dir / out_mp3_name
            out_wav_path = bank_out_dir / out_wav_name

            with open(out_mp3_path, "wb") as f:
                f.write(s.data)
            total_sounds_extracted += 1

            if force_decode or not out_wav_path.exists() or out_wav_path.stat().st_size == 0:
                decode_tasks.append((out_mp3_path, out_wav_path, s.data, s.sample_count))

            web_path = f"assets/vfx/sounds/{bank_stem}/{out_wav_name}"
            s_norm = s.name.lower().strip()
            bank_dict[s_norm] = web_path

            # Subsample variation mapping: e.g. "foo_01" -> also alias "foo" if not mapped
            base_alias = re.sub(r"_(0?1)$", "", s_norm)
            if base_alias != s_norm and base_alias not in bank_dict:
                bank_dict[base_alias] = web_path

        # If bank has a single sound, set as default
        if len(samples) == 1:
            bank_dict["default"] = f"assets/vfx/sounds/{bank_stem}/{samples[0].name}.wav"

        sound_map[bank_stem] = bank_dict
        if bank_stem.endswith("_bank"):
            sound_map[bank_stem[:-5]] = bank_dict

    # Decode audio to WAV in parallel
    if decode_tasks:
        workers = min(32, os.cpu_count() or 4)
        if verbose:
            print(f"Decoding {len(decode_tasks)} audio files to WAV ({workers} workers)...")
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [
                executor.submit(decode_fsb_sample_to_wav, mp3_p, wav_p, raw_data, s_cnt)
                for mp3_p, wav_p, raw_data, s_cnt in decode_tasks
            ]
            for f in futures:
                f.result()

    with open(sound_map_path, "w", encoding="utf-8") as f:
        json.dump(sound_map, f, indent=2, sort_keys=True)

    elapsed = round(time.time() - t_start, 2)
    summary = {
        "status": "success",
        "elapsed_seconds": elapsed,
        "effects_catalog": {
            "total_model_refs": len(catalog_model_refs),
            "mapped_model_refs": mapped_models_count,
            "unmapped_model_refs": len(unmapped_models),
            "total_sound_pairs": len(catalog_sound_pairs),
        },
        "models": {
            "effect_igz_scanned": len(effect_igz_files),
            "glbs_exported": len(exported_glbs),
            "model_map_entries": len(model_map),
            "output_dir": str(vfx_models_dir.relative_to(viewer_path)),
        },
        "sounds": {
            "required_vfx_banks": len(required_banks),
            "missing_sound_banks": len(missing_banks),
            "samples_extracted": total_sounds_extracted,
            "samples_decoded_wav": total_sounds_extracted,
            "sound_map_banks": len(sound_map),
            "output_dir": str(vfx_sounds_dir.relative_to(viewer_path)),
        },
    }

    if verbose:
        print(f"=== VFX Assets Export Summary ({elapsed}s) ===")
        print(f"Models: {len(exported_glbs)} effect GLBs exported to {vfx_models_dir}")
        print(f"Model Map: {len(model_map)} entries (resolved {mapped_models_count}/{len(catalog_model_refs)} effect refs)")
        print(f"Sounds: {total_sounds_extracted} MP3s extracted, {len(decode_tasks)} decoded ({total_sounds_extracted} total WAVs) across {len(required_banks)} banks")
        print(f"Sound Map: {len(sound_map)} bank mappings generated")
        print(f"Contracts written:\n  {model_map_path}\n  {sound_map_path}")

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Export VFX meshes and FSB5 sounds for MUA2.")
    parser.add_argument("--work-dir", default="_work", help="Path to _work directory")
    parser.add_argument("--viewer-dir", default="mua2-viewer", help="Path to mua2-viewer directory")
    parser.add_argument("--normalize", action="store_true", default=False, help="Normalize model bounds to [-1, 1]")
    parser.add_argument("--force-models", action="store_true", default=False, help="Force re-export of GLB models")
    parser.add_argument("--force-decode", action="store_true", default=False, help="Force re-decoding of all audio files to WAV")
    args = parser.parse_args()

    build_vfx_assets(
        work_dir=args.work_dir,
        viewer_dir=args.viewer_dir,
        normalize_scale=args.normalize,
        force_models=args.force_models,
        force_decode=args.force_decode,
        verbose=True,
    )


if __name__ == "__main__":
    main()
