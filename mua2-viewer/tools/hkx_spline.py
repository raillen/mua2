# SPDX-License-Identifier: GPL-3.0-or-later
# Spline layout/math adapted from HavokLib, Copyright (C) 2016-2023 Lukas Cone.
# Cross-checked against soulstruct-havok (MIT). See hkx_PROVENANCE.md.
"""Decode the single-block spline format observed in MUA2 Spider-Man HKX files."""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
import math
import struct

from hkx_packfile import AnimationClipRaw


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
        if not self.knots:
            return self.points[0].copy()
        span = find_knot_span(self.degree, frame, len(self.points), self.knots)
        weights = _basis(span, self.degree, frame, self.knots)
        return [sum(self.points[span - i][a] * w for i, w in enumerate(weights))
                for a in range(len(self.points[0]))]


@dataclass
class TransformTrack:
    position: Curve
    rotation: Curve
    scale: Curve


class SplineDecompressor:
    def __init__(self, clip: AnimationClipRaw):
        # ponytail: only observed one-block, zero-float-track payloads; add block dispatch before accepting others.
        if clip.num_blocks != 1 or clip.block_offsets != [0] or clip.num_frames > clip.max_frames_per_block:
            raise ValueError("Only single-block clips are supported")
        if clip.num_tracks <= 0 or clip.mask_quant_size != 4 * clip.num_tracks:
            raise ValueError("Invalid transform mask size or unsupported float tracks")
        if len(clip.float_block_offsets) != 1:
            raise ValueError("Missing transform block end")
        self.data = clip.data
        self.end = clip.float_block_offsets[0]
        if not clip.mask_quant_size <= self.end <= len(self.data):
            raise ValueError("Invalid transform block bounds")
        self.offset = 0
        masks = [tuple(self.take(4)) for _ in range(clip.num_tracks)]
        self.align(4)
        self.tracks: list[TransformTrack] = []
        self.control_quaternion_norm_error = 0.0
        for quant, pos, rot, scale in masks:
            position = self.vector(quant & 3, pos, 0.0)
            rotation = self.rotation((quant >> 2) & 15, rot)
            self.align(4)
            scaling = self.vector((quant >> 6) & 3, scale, 1.0)
            self.tracks.append(TransformTrack(position, rotation, scaling))
        if self.offset != self.end:
            raise ValueError(f"{clip.name}: consumed {self.offset}, expected {self.end}")
        for track in self.tracks:
            for curve in (track.position, track.rotation, track.scale):
                if curve.knots and (curve.knots[curve.degree] != 0 or curve.knots[len(curve.points)] != clip.num_frames - 1):
                    raise ValueError("Spline domain does not match original frame count")

    def take(self, size: int) -> bytes:
        if size < 0 or self.offset + size > self.end:
            raise ValueError(f"Truncated spline payload at {self.offset}")
        result = self.data[self.offset:self.offset + size]
        self.offset += size
        return result

    def align(self, alignment: int) -> None:
        self.take((-self.offset) % alignment)

    def real(self) -> float:
        value = struct.unpack('<f', self.take(4))[0]
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
