"""Havok 6.1.0-r1 64-bit LE packfile parser for MUA2 animation files.

Parses section headers (__classnames__, __types__, __data__), fixups,
embedded type reflection (hkClass), and extracts hkaAnimationContainer
clips, durations, frame counts, and bone track binding names.
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import struct
from typing import Any, Dict, List, Optional


@dataclass
class AnimationClipRaw:
    name: str
    duration: float
    num_frames: int
    num_tracks: int
    num_blocks: int
    max_frames_per_block: int
    mask_quant_size: int
    block_duration: float
    frame_duration: float
    track_names: List[str]
    block_offsets: List[int]
    float_block_offsets: List[int]
    data: bytes


class Packfile:
    """Havok 6.1.0-r1 64-bit LE packfile reader."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self._validate_header()
        self.sections: List[Dict[str, Any]] = []
        self.pointers: Dict[int, int] = {}
        self.objects: Dict[int, str] = {}
        self.classes: Dict[str, Dict[str, Any]] = {}
        self._parse_sections()
        self._parse_classes()

    def _validate_header(self) -> None:
        if len(self.data) < 0x40:
            raise ValueError(f"File too small for Havok packfile: {len(self.data)} bytes")
        magic0, magic1 = struct.unpack_from('<2I', self.data, 0)
        if magic0 != 0x57E0E057 or magic1 != 0x10C0C010:
            raise ValueError(f"Invalid Havok packfile magic: {magic0:#x}, {magic1:#x}")
        version = struct.unpack_from('<I', self.data, 12)[0]
        ptr_size, is_le = self.data[16], self.data[17]
        if version != 6 or ptr_size != 8 or is_le != 1:
            raise ValueError(f"Unsupported Havok configuration: v{version}, ptr={ptr_size}, le={is_le}")

    def _parse_sections(self) -> None:
        section_count = struct.unpack_from('<I', self.data, 20)[0]
        for i in range(section_count):
            p = 0x40 + i * 48
            end = self.data.index(0, p)
            name = self.data[p:end].decode('ascii')
            start, local, glob, virt, exports, imports, end_off = struct.unpack_from('<7I', self.data, p + 20)
            self.sections.append({
                'name': name,
                'start': start,
                'local': local,
                'glob': glob,
                'virt': virt,
                'exports': exports,
                'imports': imports,
                'end': end_off,
            })

        for s in self.sections:
            base = s['start']
            # Local fixups (child pointers): offset -> offset in same section
            for p in range(base + s['local'], base + s['glob'] - 7, 8):
                src, dst = struct.unpack_from('<2I', self.data, p)
                if src == 0xFFFFFFFF:
                    break
                self.pointers[base + src] = base + dst

            # Global fixups (item pointers): offset in this section -> target section + offset
            for p in range(base + s['glob'], base + s['virt'] - 11, 12):
                src, sec_idx, dst = struct.unpack_from('<3I', self.data, p)
                if src == 0xFFFFFFFF:
                    break
                if sec_idx < len(self.sections):
                    self.pointers[base + src] = self.sections[sec_idx]['start'] + dst

            # Virtual fixups (item specs): offset in this section -> class name
            for p in range(base + s['virt'], base + s['exports'] - 11, 12):
                src, sec_idx, dst = struct.unpack_from('<3I', self.data, p)
                if src == 0xFFFFFFFF:
                    break
                if sec_idx < len(self.sections):
                    name_p = self.sections[sec_idx]['start'] + dst
                    end_idx = self.data.index(0, name_p)
                    self.objects[base + src] = self.data[name_p:end_idx].decode('ascii')

    def _parse_classes(self) -> None:
        for p, kind in self.objects.items():
            if kind != 'hkClass':
                continue
            name_p = self.pointer(p)
            name = self.string(name_p)
            members = []
            m_ptr = self.pointer(p + 40)
            count = struct.unpack_from('<I', self.data, p + 48)[0]
            if m_ptr and count > 0:
                for j in range(count):
                    q = m_ptr + j * 40
                    m_name = self.string(self.pointer(q))
                    c_addr = self.pointer(q + 8)
                    typ, sub, size, flags, offset = struct.unpack_from('<BBHHH', self.data, q + 24)
                    members.append({
                        'name': m_name,
                        'type': typ,
                        'subtype': sub,
                        'size': size,
                        'flags': flags,
                        'offset': offset,
                        'class_address': c_addr,
                    })
            parent_p = self.pointer(p + 8)
            self.classes[name] = {
                'address': p,
                'size': struct.unpack_from('<I', self.data, p + 16)[0],
                'parent_address': parent_p,
                'members': members,
            }

        addr_to_name = {c['address']: n for n, c in self.classes.items()}
        for c in self.classes.values():
            c['parent'] = addr_to_name.get(c.pop('parent_address'))
            for m in c['members']:
                m['class'] = addr_to_name.get(m.pop('class_address'))

    def pointer(self, addr: Optional[int]) -> Optional[int]:
        if addr is None:
            return None
        return self.pointers.get(addr)

    def string(self, addr: Optional[int]) -> Optional[str]:
        if addr is None or addr < 0 or addr >= len(self.data):
            return None
        end = self.data.find(b'\x00', addr)
        if end == -1:
            return None
        return self.data[addr:end].decode('latin1', errors='replace')

    def unpack(self, fmt: str, addr: int) -> tuple[Any, ...]:
        return struct.unpack_from('<' + fmt, self.data, addr)


def extract_animation_clips(packfile: Packfile) -> List[AnimationClipRaw]:
    """Extract all hkaSplineCompressedAnimation clips and their metadata."""
    # Find hkaAnimationContainer
    container_addr = None
    for addr, cls in packfile.objects.items():
        if cls == 'hkaAnimationContainer':
            container_addr = addr
            break
    if container_addr is None:
        raise ValueError(f"No hkaAnimationContainer found in {packfile.path}")

    # Read animations array from container (+16 in hkaAnimationContainer)
    anim_arr = packfile.pointer(container_addr + 16)
    anim_count = packfile.unpack('i', container_addr + 16 + 8)[0]
    if not anim_arr or anim_count <= 0:
        return []

    # Read skeleton animTable for clip names (+24 in hkaSkeleton)
    skel_addr = None
    for addr, cls in packfile.objects.items():
        if cls == 'hkaSkeleton':
            skel_addr = addr
            break
    clip_names = []
    if skel_addr:
        bones_ptr = packfile.pointer(skel_addr + 24)
        bones_count = packfile.unpack('i', skel_addr + 24 + 8)[0]
        if bones_ptr:
            for i in range(bones_count):
                bp = packfile.pointer(bones_ptr + i * 8)
                clip_names.append(packfile.string(packfile.pointer(bp)) if bp else f"clip_{i:02d}")

    clips: List[AnimationClipRaw] = []
    for anim_idx in range(anim_count):
        ap = packfile.pointer(anim_arr + anim_idx * 8)
        if not ap:
            continue
        clip_name = clip_names[anim_idx] if anim_idx < len(clip_names) else f"anim_{anim_idx:02d}"

        duration = packfile.unpack('f', ap + 20)[0]
        num_tracks = packfile.unpack('i', ap + 24)[0]
        num_frames = packfile.unpack('i', ap + 56)[0]
        num_blocks = packfile.unpack('i', ap + 60)[0]
        max_frames_per_block = packfile.unpack('i', ap + 64)[0]
        mask_quant_size = packfile.unpack('i', ap + 68)[0]
        block_duration = packfile.unpack('f', ap + 72)[0]
        frame_duration = packfile.unpack('f', ap + 80)[0]

        # Annotation tracks (per-track bone binding names) at +40
        annot_ptr = packfile.pointer(ap + 40)
        annot_count = packfile.unpack('i', ap + 48)[0]
        track_names = []
        if annot_ptr and annot_count > 0:
            for j in range(annot_count):
                at_obj = packfile.pointer(annot_ptr + j * 8)
                track_names.append(packfile.string(packfile.pointer(at_obj)) if at_obj else f"track_{j}")

        # Block offsets (+88)
        bo_ptr = packfile.pointer(ap + 88)
        bo_count = packfile.unpack('i', ap + 88 + 8)[0]
        block_offsets = [packfile.unpack('I', bo_ptr + j * 4)[0] for j in range(bo_count)] if bo_ptr else [0]

        # Float block offsets (+104)
        fbo_ptr = packfile.pointer(ap + 104)
        fbo_count = packfile.unpack('i', ap + 104 + 8)[0]
        float_block_offsets = [packfile.unpack('I', fbo_ptr + j * 4)[0] for j in range(fbo_count)] if fbo_ptr else []

        # Raw compressed payload (+152)
        raw_ptr = packfile.pointer(ap + 152)
        raw_len = packfile.unpack('i', ap + 152 + 8)[0]
        raw_data = packfile.data[raw_ptr:raw_ptr + raw_len] if raw_ptr else b''

        clips.append(AnimationClipRaw(
            name=clip_name,
            duration=duration,
            num_frames=num_frames,
            num_tracks=num_tracks,
            num_blocks=num_blocks,
            max_frames_per_block=max_frames_per_block,
            mask_quant_size=mask_quant_size,
            block_duration=block_duration,
            frame_duration=frame_duration,
            track_names=track_names,
            block_offsets=block_offsets,
            float_block_offsets=float_block_offsets,
            data=raw_data,
        ))

    return clips
