# SPDX-License-Identifier: GPL-3.0-or-later
# Spline layout/math adapted from HavokLib, Copyright (C) 2016-2023 Lukas Cone.
# Cross-checked against soulstruct-havok (MIT). See hkx_PROVENANCE.md.
"""Decode MUA2 transform splines, including shared-boundary multi-block clips."""
from __future__ import annotations

import math
import struct
from bisect import bisect_right
from dataclasses import dataclass
from typing import overload

from hkx_packfile import AnimationClipRaw


def get_block_index_and_frame(frame: float, max_frames_per_block: int, num_blocks: int) -> tuple[int, float]:
    """Map global animation frame to (block_index, frame_in_block) per Havok block partitioning."""
    if max_frames_per_block < 2 or num_blocks < 1:
        raise ValueError("Invalid block frame count")
    if not math.isfinite(frame) or not 0 <= frame <= num_blocks * (max_frames_per_block - 1):
        raise ValueError(f"Frame {frame} outside block domain")
    frames_per_block = max_frames_per_block - 1
    block_index = min(int(frame // frames_per_block), num_blocks - 1)
    frame_in_block = float(frame - block_index * frames_per_block)
    return block_index, frame_in_block


def find_knot_span(degree: int, value: float, control_point_count: int, knots: list[int]) -> int:
    if not math.isfinite(value) or not knots[degree] <= value <= knots[control_point_count]:
        raise ValueError(f"Frame {value} outside spline domain")
    return min(bisect_right(knots, value) - 1, control_point_count - 1)


def _basis(span: int, degree: int, frame: float, knots: list[int]) -> list[float]:
    weights = [1.0] + [0.0] * degree
    for i in range(1, degree + 1):
        for j in range(i - 1, -1, -1):
            low, high = knots[span - j], knots[span + i - j]
            if high == low:
                raise ValueError("Degenerate knot span")
            term = weights[j] * (frame - low) / (high - low)
            weights[j + 1] += weights[j] - term
            weights[j] = term
    return weights


def get_single_point_float(span: int, degree: int, frame: float, knots: list[int], points: list[float]) -> float:
    return sum(points[span - i] * w for i, w in enumerate(_basis(span, degree, frame, knots)))


def get_single_point_quaternion(span: int, degree: int, frame: float, knots: list[int], points: list[list[float]]) -> list[float]:
    weights = _basis(span, degree, frame, knots)
    return [sum(points[span - i][axis] * w for i, w in enumerate(weights)) for axis in range(4)]


def normalize_quaternion(q: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in q))
    if not math.isfinite(norm) or norm < 1e-8:
        raise ValueError(f"Invalid quaternion norm: {norm}")
    return [v / norm for v in q]


@dataclass
class Curve:
    degree: int
    knots: list[int]
    points: list[list[float]]

    def value(self, frame: float) -> list[float]:
        frame_f = float(frame)
        if not self.knots:
            return self.points[0].copy()
        span = find_knot_span(self.degree, frame_f, len(self.points), self.knots)
        weights = _basis(span, self.degree, frame_f, self.knots)
        return [sum(self.points[span - i][a] * w for i, w in enumerate(weights))
                for a in range(len(self.points[0]))]


@dataclass
class MultiBlockCurve:
    curves: list[Curve]
    max_frames_per_block: int
    num_frames: int

    @property
    def knots(self) -> list[int]:
        """Exporter dynamic marker, not a combined B-spline knot vector."""
        for curve in self.curves:
            if curve.knots:
                return curve.knots
        if any(curve.points != self.curves[0].points for curve in self.curves[1:]):
            return [0, self.num_frames - 1]
        return []

    def value(self, frame: float) -> list[float]:
        frame_f = float(frame)
        if not math.isfinite(frame_f) or not (0.0 <= frame_f <= self.num_frames - 1):
            raise ValueError(f"Frame {frame} outside spline domain")
        block_idx, local_frame = get_block_index_and_frame(frame_f, self.max_frames_per_block, len(self.curves))
        return self.curves[block_idx].value(local_frame)


@dataclass
class TransformTrack:
    position: Curve | MultiBlockCurve
    rotation: Curve | MultiBlockCurve
    scale: Curve | MultiBlockCurve

    def sample(self, frame: float) -> tuple[list[float], list[float], list[float]]:
        frame_f = float(frame)
        return (
            self.position.value(frame_f),
            normalize_quaternion(self.rotation.value(frame_f)),
            self.scale.value(frame_f),
        )


class SplineDecompressor:
    def __init__(self, clip: AnimationClipRaw) -> None:
        # ponytail: zero float tracks only; add float decoding when such clips appear.
        if clip.num_blocks < 1 or clip.num_frames < 1 or clip.max_frames_per_block < 2:
            raise ValueError("Invalid block/frame count")
        frames_per_block = clip.max_frames_per_block - 1
        expected_blocks = max(1, (clip.num_frames - 2) // frames_per_block + 1)
        if clip.num_blocks != expected_blocks:
            raise ValueError("Block count does not match frame count")
        if clip.num_tracks <= 0 or clip.mask_quant_size != 4 * clip.num_tracks:
            raise ValueError("Invalid transform mask size or unsupported float tracks")
        if len(clip.block_offsets) != clip.num_blocks or len(clip.float_block_offsets) != clip.num_blocks:
            raise ValueError("Block offsets count mismatch")
        self.clip = clip
        self.data = clip.data
        self.control_quaternion_norm_error = 0.0
        self.blocks: list[list[TransformTrack]] = []
        if clip.block_offsets[0] != 0:
            raise ValueError("First block must start at zero")

        block_curves: list[list[tuple[Curve, Curve, Curve]]] = []
        for b in range(clip.num_blocks):
            start = clip.block_offsets[b]
            self.end = start + clip.float_block_offsets[b]
            if not (0 <= start <= self.end <= len(self.data)) or (self.end - start) < clip.mask_quant_size:
                raise ValueError("Invalid transform block bounds")
            if start % 16 or (b + 1 < clip.num_blocks and
                              (self.end + 15) // 16 * 16 != clip.block_offsets[b + 1]):
                raise ValueError("Invalid transform block alignment or overlap")
            self.offset = start
            masks = [tuple(self.take(4)) for _ in range(clip.num_tracks)]
            self.align(4)
            b_curves: list[tuple[Curve, Curve, Curve]] = []
            for quant, pos, rot, scale in masks:
                position = self.vector(quant & 3, pos, 0.0)
                rotation = self.rotation((quant >> 2) & 15, rot)
                self.align(4)
                scaling = self.vector((quant >> 6) & 3, scale, 1.0)
                b_curves.append((position, rotation, scaling))
            if self.offset != self.end:
                raise ValueError(f"{clip.name} block {b}: consumed {self.offset}, expected {self.end}")
            local_num_frames = (
                clip.max_frames_per_block
                if b < clip.num_blocks - 1
                else clip.num_frames - b * frames_per_block
            )
            for pos_c, rot_c, scl_c in b_curves:
                for cv in (pos_c, rot_c, scl_c):
                    if cv.knots and (cv.knots[cv.degree] != 0 or cv.knots[len(cv.points)] != local_num_frames - 1):
                        raise ValueError("Spline domain does not match block frame count")
            block_curves.append(b_curves)
            self.blocks.append([TransformTrack(p, r, s) for p, r, s in b_curves])

        if clip.num_blocks == 1:
            self.tracks = self.blocks[0]
        else:
            self.tracks = []
            for t in range(clip.num_tracks):
                pos_curve = MultiBlockCurve(
                    [block_curves[b][t][0] for b in range(clip.num_blocks)],
                    clip.max_frames_per_block,
                    clip.num_frames,
                )
                rot_curve = MultiBlockCurve(
                    [block_curves[b][t][1] for b in range(clip.num_blocks)],
                    clip.max_frames_per_block,
                    clip.num_frames,
                )
                scl_curve = MultiBlockCurve(
                    [block_curves[b][t][2] for b in range(clip.num_blocks)],
                    clip.max_frames_per_block,
                    clip.num_frames,
                )
                self.tracks.append(TransformTrack(pos_curve, rot_curve, scl_curve))

    @overload
    def sample(self, frame: float, track_idx: int) -> tuple[list[float], list[float], list[float]]: ...

    @overload
    def sample(self, frame: float, track_idx: None = None) -> list[tuple[list[float], list[float], list[float]]]: ...

    def sample(
        self, frame: float, track_idx: int | None = None
    ) -> tuple[list[float], list[float], list[float]] | list[tuple[list[float], list[float], list[float]]]:
        if track_idx is not None:
            return self.tracks[track_idx].sample(frame)
        return [track.sample(frame) for track in self.tracks]

    def take(self, size: int) -> bytes:
        if size < 0 or self.offset + size > self.end:
            raise ValueError(f"Truncated spline payload at {self.offset}")
        result = self.data[self.offset:self.offset + size]
        self.offset += size
        return result

    def align(self, alignment: int) -> None:
        self.take((-self.offset) % alignment)

    def real(self) -> float:
        value = float(struct.unpack('<f', self.take(4))[0])
        if not math.isfinite(value):
            raise ValueError("Non-finite spline value")
        return value

    def header(self) -> tuple[int, int, list[int]]:
        last, degree = struct.unpack('<HB', self.take(3))
        count = last + 1
        if degree > 4 or count <= degree:
            raise ValueError(f"Invalid spline degree/count: {degree}/{count}")
        knots = list(self.take(count + degree + 1))
        if knots != sorted(knots) or knots[degree] >= knots[count]:
            raise ValueError("Invalid spline knots")
        return count, degree, knots

    def vector(self, quant: int, mask: int, default: float) -> Curve:
        if mask & 0x88 or any(mask & (1 << a) and mask & (16 << a) for a in range(3)):
            raise ValueError(f"Unsupported vector mask: {mask:#x}")
        if quant not in (0, 1):
            raise ValueError(f"Unsupported scalar quantization: {quant}")
        dynamic = bool(mask & 0x70)
        count, degree, knots = self.header() if dynamic else (1, 0, [])
        if dynamic:
            self.align(4)
        bounds: dict[int, tuple[float, float]] = {}
        constant = [default] * 3
        for a in range(3):
            if mask & (16 << a):
                low, high = self.real(), self.real()
                if low > high:
                    raise ValueError("Reversed quantization bounds")
                bounds[a] = (low, high)
            elif mask & (1 << a):
                constant[a] = self.real()
        points = []
        for _ in range(count):
            point = constant.copy()
            for a, (low, high) in bounds.items():
                raw = int.from_bytes(self.take(quant + 1), 'little')
                point[a] = low + (high - low) * raw / (255 if quant == 0 else 65535)
            points.append(point)
        if dynamic:
            self.align(4)
        return Curve(degree, knots, points)

    def quaternion40(self) -> list[float]:
        raw = int.from_bytes(self.take(5), 'little')
        if raw >> 39:
            raise ValueError("Reserved ThreeComp40 bit is set")
        step = math.sqrt(2.0) / 4094.0
        q = [(((raw >> shift) & 4095) - 2047) * step for shift in (0, 12, 24)]
        squared = 1.0 - sum(v * v for v in q)
        if squared < -1e-6:
            raise ValueError("Invalid ThreeComp40 components")
        implicit = math.sqrt(max(0.0, squared)) * (-1 if raw & (1 << 38) else 1)
        q.insert((raw >> 36) & 3, implicit)
        self.control_quaternion_norm_error = max(
            self.control_quaternion_norm_error, abs(math.sqrt(sum(v * v for v in q)) - 1.0))
        return q

    def rotation(self, quant: int, mask: int) -> Curve:
        if quant != 1:
            raise ValueError(f"Unsupported rotation quantization: {quant}")
        if mask & 0xF0:
            count, degree, knots = self.header()
            return Curve(degree, knots, [self.quaternion40() for _ in range(count)])
        return Curve(0, [], [self.quaternion40() if mask & 15 else [0.0, 0.0, 0.0, 1.0]])
